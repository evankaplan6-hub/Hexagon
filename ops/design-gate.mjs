#!/usr/bin/env node
// The design gate (2026-11-17). A change to the floor's screens (ops/design-gate.json "ui") may merge only
// with a design review on record for those exact changes. The record is design-reviews/<fingerprint>.md,
// where the fingerprint is a hash of the branch's screen diff, so any later screen edit needs a new review.
// The /design-gate skill runs the review and then `record`; the merge guard hook (~/.claude/hooks/design-gate-guard.sh,
// for Claude Code and Codex) runs `guard`, and CI runs `check`. Zero dependencies, as the repo is.
//
// usage:
//   node ops/design-gate.mjs status [--base origin/main] [--head HEAD]
//   node ops/design-gate.mjs check  [--base origin/main] [--head HEAD]          exit 1 when a review is missing
//   node ops/design-gate.mjs record --verdict pass|pass-with-fixes --checks a,b,c --notes FILE
//                                   [--phone-audit DIR]... [--tool NAME] [--base origin/main]
//   node ops/design-gate.mjs guard  --args "<what followed gh pr merge>"        exit 2 to block (merge guard)
// --dir DIR runs any of them in another checkout. Settings come from the base branch's ops/design-gate.json
// when it has one, so a branch can't loosen its own gate.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// ui: the screen files. protect: the gate's own files; a change to them also needs a review on record, so a pull
// request can't loosen the gate for the ones after it (the design checks and phone audit apply to ui files only).
// phoneAuditSet: the audits a record needs, as "WIDTH SCHEME TAPMIN" (each a folder of tools/phone-audit.mjs).
const DEFAULTS = { ui: ["public/"], ignore: [], protect: ["ops/design-gate.json", "ops/design-gate.mjs", ".github/workflows/test.yml"],
  checks: [], phoneAudit: false, phoneAuditSet: [] };
const VERDICTS = ["pass", "pass-with-fixes"];

export function git(dir, args, opts = {}) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"], ...opts });
}
// Network steps (gh, git fetch) get a time limit and never wait on a password or passphrase prompt, so the merge
// guard answers well inside its hook's 60 s and blocks, rather than timing out and letting the merge run.
const netMs = () => +(process.env.DESIGN_GATE_TIMEOUT_MS || 15000);
const netEnv = () => ({ ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1",
  GIT_SSH_COMMAND: process.env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes -o ConnectTimeout=10" });
const firstLine = (e) => (e.code === "ETIMEDOUT" || e.signal) ? `no answer in ${netMs() / 1000} s`
  : String(e.stderr || e.message).trim().split("\n")[0];
const tryGit = (dir, args) => { try { return git(dir, args); } catch { return null; } };

export function loadConfig(dir, base) {
  const fromBase = base && tryGit(dir, ["show", `${base}:ops/design-gate.json`]);
  const text = fromBase ?? (existsSync(join(dir, "ops/design-gate.json")) ? readFileSync(join(dir, "ops/design-gate.json"), "utf8") : null);
  return { ...DEFAULTS, ...(text ? JSON.parse(text) : {}) };
}

// Root-relative, so a run from a subfolder sees the same files.
export const pathspec = (cfg) => ["--", ...cfg.ui.map((p) => `:(top)${p}`), ...cfg.ignore.map((p) => `:(top,exclude)${p}`)];
const gatedSpec = (cfg) => [...pathspec(cfg), ...(cfg.protect || []).map((p) => `:(top)${p}`)];
const isUi = (cfg, f) => cfg.ui.some((u) => f === u || f.startsWith(u.endsWith("/") ? u : u + "/"))
  && !cfg.ignore.some((x) => f === x || f.startsWith(x.endsWith("/") ? x : x + "/"));

// The fingerprint's diff ignores every git setting of whoever computes it (a Mac, a Codex worktree, the CI runner):
// no user or system config, plumbing diff-tree, and each output option pinned.
const PINNED_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0", GIT_CONFIG_PARAMETERS: "",
  GIT_DIFF_OPTS: "" };
// Full context, so the patch holds both whole files: the fingerprint below picks its own context per change. --text:
// binary files as text, so neither zlib nor .gitattributes changes the bytes. The -c settings are the repo's own
// .git/config ones that could still change the output.
const PINNED_DIFF = ["-c", "core.quotePath=true", "-c", "diff.suppressBlankEmpty=false", "-c", "diff.interHunkContext=0",
  "diff-tree", "-r", "-p", "--unified=100000000", "--text", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv",
  "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers", "--no-indent-heuristic", "-O/dev/null"];

/** How many times the lines `blk` appear in a row in `lines` (stops at 2). */
function occurrences(lines, blk) {
  if (!blk.length) return 0;
  const hay = "\n" + lines.join("\n") + "\n", needle = "\n" + blk.join("\n") + "\n";
  const first = hay.indexOf(needle);
  return first < 0 ? 0 : hay.indexOf(needle, first + 1) < 0 ? 1 : 2;
}

/** The branch's own screen changes as text: each run of changed lines with the fewest lines around it (one or more)
 *  that appear only once in the file before and after the change, without line numbers or blob ids. So merging
 *  main into the branch, or a rebase, keeps the review when the branch's own change is the same, while any edit to
 *  the changed lines, or moving them anywhere else in the file, needs a new one. */
export function screenPatch(dir, mb, head, cfg) {
  const raw = git(dir, [...PINNED_DIFF, mb, head, ...gatedSpec(cfg)], { env: { ...process.env, ...PINNED_ENV } });
  const out = [];
  for (const chunk of raw.split(/^(?=diff --git )/m)) {
    if (!chunk) continue;
    const lines = chunk.split("\n");
    if (lines.at(-1) === "") lines.pop();
    let k = 0;
    for (; k < lines.length && !lines[k].startsWith("@@"); k++) if (!lines[k].startsWith("index ")) out.push(lines[k]);
    const body = [];  // { t: " " | "-" | "+", s }
    for (; k < lines.length; k++) {
      const l = lines[k];
      if (l.startsWith("@@")) continue;
      if (l.startsWith("\\")) { if (body.length) body[body.length - 1].s += "\n" + l; continue; }
      body.push({ t: l === "" ? " " : l[0], s: l.slice(1) });
    }
    const side = (b, drop) => b.filter((x) => x.t !== drop).map((x) => x.s);
    const before = side(body, "+"), after = side(body, "-");
    for (let r = 0; r < body.length;) {
      if (body[r].t === " ") { r++; continue; }
      let e = r;
      while (e < body.length && body[e].t !== " ") e++;
      for (let n = 1; ; n++) {
        const blk = body.slice(Math.max(0, r - n), e + n);
        const edges = r - n <= 0 && e + n >= body.length;
        if (edges || (occurrences(before, side(blk, "+")) <= 1 && occurrences(after, side(blk, "-")) <= 1)) {
          out.push(`@@ ${n}`, ...blk.map((x) => x.t + x.s));
          break;
        }
      }
      r = e;
    }
  }
  return out.join("\n");
}

/** The screen files a branch changes, and the hash of exactly those changes. */
export function diffOf(dir, base, head, cfg) {
  const mb = git(dir, ["merge-base", base, head]).trim();
  // -z: a name with spaces, quotes or non-ASCII letters comes back as it is, not quoted
  const files = git(dir, ["diff-tree", "-r", "-z", "--name-only", "--no-renames", mb, head, ...gatedSpec(cfg)], { env: { ...process.env, ...PINNED_ENV } })
    .split("\0").filter(Boolean);
  const fingerprint = createHash("sha256").update(screenPatch(dir, mb, head, cfg)).digest("hex");
  return { mergeBase: mb, files, uiFiles: files.filter((f) => isUi(cfg, f)), fingerprint };
}

export const recordPath = (fp, n = 1) => `design-reviews/${fp.slice(0, 16)}${n > 1 ? `-${n}` : ""}.md`;
const has = (dir, rev, path) => tryGit(dir, ["cat-file", "-e", `${rev}:${path}`]) != null;
/** The record names for a fingerprint that rev has: <fp16>.md, then <fp16>-2.md and on (a change landed, reverted and
 *  landed again needs a review each time). */
function recordsAt(dir, rev, fp) {
  const out = [];
  for (let n = 1; n < 100 && has(dir, rev, recordPath(fp, n)); n++) out.push(recordPath(fp, n));
  return out;
}

export function parseRecord(text) {
  const field = (name) => (text.match(new RegExp(`^${name}: (.*)$`, "m")) || [])[1]?.trim() ?? null;
  return { fingerprint: field("Fingerprint"), verdict: field("Verdict"),
    checks: (field("Checks") || "").split(",").map((s) => s.trim()).filter(Boolean) };
}

/** ok: no screen change, or a review on record for exactly this screen diff. */
export function check(dir, base, head) {
  const cfg = loadConfig(dir, base);
  const d = diffOf(dir, base, head, cfg);
  if (!d.files.length) return { ok: true, ...d, reason: "no screen files changed" };
  const old = recordsAt(dir, d.mergeBase, d.fingerprint);
  const path = recordsAt(dir, head, d.fingerprint).find((p) => !old.includes(p)) ?? recordPath(d.fingerprint, old.length + 1);
  const text = tryGit(dir, ["show", `${head}:${path}`]);
  if (text == null) return { ok: false, ...d, path, reason: old.length
    ? `${old.join(", ")} belongs to an earlier pull request already on ${base}; this one needs its own review (${path})`
    : `no design review on record for these screen changes (${path})` };
  const r = parseRecord(text);
  if (r.fingerprint !== d.fingerprint) return { ok: false, ...d, path, reason: `${path} is for different screen changes` };
  if (!VERDICTS.includes(r.verdict)) return { ok: false, ...d, path, reason: `${path} says "${r.verdict}", not a pass` };
  const missing = d.uiFiles.length ? cfg.checks.filter((c) => !r.checks.includes(c)) : [];
  if (missing.length) return { ok: false, ...d, path, reason: `${path} is missing checks: ${missing.join(", ")}` };
  return { ok: true, ...d, path, reason: `design review on record (${path})` };
}

/** Splits a shell argument string the way sh would for plain words and simple quotes. It stops at an unquoted
 *  ; & | or newline, where the shell would end the command. */
export function splitArgs(s) {
  const out = []; let cur = ""; let q = null; let has = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (q) { if (c === q) q = null; else if (c === "\\" && q === '"' && i + 1 < s.length) cur += s[++i]; else cur += c; continue; }
    if (c === "'" || c === '"') { q = c; has = true; continue; }
    if (c === "\\" && i + 1 < s.length) { cur += s[++i]; has = true; continue; }
    if (/[;&|\n]/.test(c)) break;
    if (/\s/.test(c)) { if (has || cur) out.push(cur); cur = ""; has = false; continue; }
    cur += c;
  }
  if (has || cur) out.push(cur);
  return out;
}

// gh pr merge flags that take a value (gh 2.x).
const VALUE_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email",
  "--match-head-commit", "-R", "--repo"]);

/** OWNER/REPO from the forms gh takes: OWNER/REPO, HOST/OWNER/REPO, a github.com URL, with or without .git. */
export function normalizeRepo(r) {
  if (!r) return null;
  const s = r.trim().replace(/^(https?:\/\/|ssh:\/\/git@|git@)/, "").replace(/^(www\.)?github\.com[/:]/, "")
    .replace(/\/+$/, "").replace(/\.git$/, "");
  const parts = s.split("/");
  return parts.length >= 2 ? parts.slice(-2).join("/") : s;
}

/** What `gh pr merge <args>` would do: the PR selector, the --repo, and the flags the gate cares about. */
export function parseMerge(args) {
  let selector = null, repo = null, admin = false, auto = false, disableAuto = false, matchHead = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    // on/off flags, also as --auto=true (gh takes =value; anything but false, 0 or f is on)
    const onoff = a.match(/^--(admin|auto|disable-auto)(?:=(.*))?$/);
    if (onoff) {
      const on = onoff[2] == null || !/^(false|0|f)$/i.test(onoff[2]);
      if (onoff[1] === "admin") admin = on; else if (onoff[1] === "auto") auto = on; else disableAuto = on;
      continue;
    }
    const eq = a.match(/^(-R|--repo|--match-head-commit)=(.*)$/);
    if (eq) { if (eq[1] === "--match-head-commit") matchHead = eq[2]; else repo = eq[2]; continue; }
    if (/^-R./.test(a)) { repo = a.slice(2); continue; }
    if (a === "-R" || a === "--repo") { repo = args[++i] ?? null; continue; }
    if (a === "--match-head-commit") { matchHead = args[++i] ?? null; continue; }
    if (a.startsWith("-")) { if (VALUE_FLAGS.has(a)) i++; continue; }
    if (selector == null) selector = a;
  }
  return { selector, repo: normalizeRepo(repo), admin, auto, disableAuto, matchHead };
}

/** The merge guard: block a merge of a screen change with no review on record for the exact head it merges, and
 *  any --admin or --auto merge. */
export function guard(dir, argString, gh = "gh") {
  const m = parseMerge(splitArgs(argString));
  if (m.disableAuto) return { block: false, reason: "turns off auto-merge only" };
  if (m.admin) return { block: true, reason: "--admin skips the repo's required checks, including the design gate. Merge without --admin." };
  if (m.auto) return { block: true, reason: "--auto would let GitHub merge later pushes that nobody checked. Merge when the branch is final, without --auto." };
  const view = ["pr", "view", ...(m.selector ? [m.selector] : []), ...(m.repo ? ["--repo", m.repo] : []),
    "--json", "number,headRefOid,baseRefName,url"];
  let pr;
  try { pr = JSON.parse(execFileSync(gh, view, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: netMs(), env: netEnv() })); }
  catch (e) { return { block: true, reason: `couldn't look up the pull request (${firstLine(e)}), so the design gate can't check it; try again` }; }
  try { git(dir, ["fetch", "-q", "origin", `+refs/heads/${pr.baseRefName}:refs/remotes/origin/${pr.baseRefName}`, `+refs/pull/${pr.number}/head:refs/design-gate/pr-${pr.number}`], { timeout: netMs(), env: netEnv() }); }
  catch (e) { return { block: true, reason: `couldn't fetch pull request ${pr.number} (${firstLine(e)}); try again` }; }
  const head = git(dir, ["rev-parse", `refs/design-gate/pr-${pr.number}`]).trim();
  if (head !== pr.headRefOid) return { block: true, reason: `pull request ${pr.number} moved while checking; try again` };
  if (m.matchHead && m.matchHead !== head) return { block: true, pr, reason: `--match-head-commit ${m.matchHead} is not pull request ${pr.number}'s head (${head})` };
  const r = check(dir, `origin/${pr.baseRefName}`, head);
  if (!r.ok) return { block: true, pr, ...r };
  // A reviewed screen change merges only the commit that was checked, never a push that lands meanwhile.
  if (r.files.length && !m.matchHead) return { block: true, pr, ...r, files: [],
    reason: `the review is on record; pin the merge to the commit it checked: add --match-head-commit ${head}` };
  return { block: false, pr, ...r };
}

// A route that didn't load, or whose page the audit couldn't read, measured nothing: the audit has to run again.
const BROKEN = /^(STATUS|EVAL|NOSHEET|SHEET-NOT-OPEN|NO-FRAME)\b/;

/** One line per phone audit folder. Each must be of the screens as committed now (render.sh writes the commit it
 *  served into the folder), every route must have loaded, and together they must cover cfg.phoneAuditSet. */
function auditSummary(dir, dirs, cfg) {
  const seen = new Set();
  const lines = dirs.map((d) => {
    const file = join(d, "audit.json");
    if (!existsSync(file)) throw new Error(`no audit.json in ${d}; run the phone audit first`);
    const commit = existsSync(join(d, "commit")) ? readFileSync(join(d, "commit"), "utf8").trim() : null;
    if (!commit || !/^[0-9a-f]{40}$/.test(commit)) throw new Error(`${d} doesn't say which commit it audited; run the design gate's render.sh, which writes it`);
    if (tryGit(dir, ["diff", "--quiet", commit, "HEAD", ...pathspec(cfg)]) == null)
      throw new Error(`${d} audited ${commit.slice(0, 12)}, whose screens differ from HEAD's; run the phone audit again`);
    const a = JSON.parse(readFileSync(file, "utf8"));
    const broken = a.results.filter((r) => (r.flags || []).some((f) => BROKEN.test(f)));
    if (!a.results.length || broken.length)
      throw new Error(`${d}: ${a.results.length ? `${broken.map((r) => `${r.route} (${r.flags.filter((f) => BROKEN.test(f)).join(" ")})`).join(", ")} didn't load or couldn't be read` : "no routes"}; fix it and run the phone audit again`);
    seen.add(`${a.width} ${a.scheme} ${a.tapMin ?? 44}`);
    const flagged = a.results.filter((r) => r.flags && r.flags.length);
    return `- ${a.width}px ${a.scheme}, ${a.tapMin ?? 44}px taps: ${a.results.length} routes, ${flagged.length} flagged`
      + (flagged.length ? ` (${flagged.map((r) => `${r.route} ${r.flags.join(" ")}`).join("; ")})` : "");
  });
  const missing = (cfg.phoneAuditSet || []).filter((x) => !seen.has(x));
  if (missing.length) throw new Error(`--phone-audit is missing these audits (width, scheme, tap size): ${missing.join("; ")}`);
  return lines;
}

export function record(dir, opts) {
  const base = opts.base || "origin/main";
  const cfg = loadConfig(dir, base);
  if (!VERDICTS.includes(opts.verdict)) throw new Error(`--verdict must be ${VERDICTS.join(" or ")}; a failing review is fixed, not recorded`);
  const checks = (opts.checks || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!opts.notes || !existsSync(opts.notes)) throw new Error("--notes FILE is required: what each check found and what was fixed");
  if (git(dir, ["status", "--porcelain", ...gatedSpec(cfg)]).trim()) throw new Error("commit the screen changes first: the review covers committed changes only");
  const d = diffOf(dir, base, "HEAD", cfg);
  if (!d.files.length) throw new Error("no screen files changed on this branch; nothing to review");
  const ui = d.uiFiles.length > 0;
  const missing = ui ? cfg.checks.filter((c) => !checks.includes(c)) : [];
  if (missing.length) throw new Error(`--checks is missing ${missing.join(", ")} (this repo's ops/design-gate.json asks for them)`);
  const audits = cfg.phoneAudit && ui ? auditSummary(dir, opts.phoneAudit || [], cfg) : [];
  if (cfg.phoneAudit && ui && !audits.length) throw new Error("--phone-audit DIR is required (an output folder of tools/phone-audit.mjs, run after the last screen commit)");
  const old = recordsAt(dir, d.mergeBase, d.fingerprint);
  const path = recordsAt(dir, "HEAD", d.fingerprint).find((p) => !old.includes(p)) ?? recordPath(d.fingerprint, old.length + 1);
  const body = [
    "# Design review", "",
    `Fingerprint: ${d.fingerprint}`,
    `Verdict: ${opts.verdict}`,
    `Checks: ${checks.join(", ") || "none (only the gate's own files changed)"}`,
    `Tool: ${opts.tool || "unknown"}`,
    `Reviewed: ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `Files: ${d.files.join(", ")}`, "",
    ...(audits.length ? ["## Phone audit", "", ...audits, ""] : []),
    "## Notes", "", readFileSync(opts.notes, "utf8").trim(), "",
  ].join("\n");
  mkdirSync(join(dir, "design-reviews"), { recursive: true });
  writeFileSync(join(dir, path), body);
  return { path, ...d };
}

function main(argv) {
  const [cmd, ...rest] = argv;
  const opts = { phoneAudit: [] };
  for (let i = 0; i < rest.length; i++) {
    if (!rest[i].startsWith("--")) continue;
    const eq = rest[i].indexOf("=");
    const k = rest[i].slice(2, eq < 0 ? undefined : eq), v = eq < 0 ? rest[++i] : rest[i].slice(eq + 1);
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "phoneAudit") opts.phoneAudit.push(v); else opts[key] = v;
  }
  let dir = opts.dir || process.cwd();
  try { dir = git(dir, ["rev-parse", "--show-toplevel"]).trim(); } catch { /* not a checkout: the command says so below */ }
  const base = opts.base || "origin/main", head = opts.head || "HEAD";
  // status and record run the base branch's own script when it differs from this one, so a branch that changes how
  // the fingerprint is made writes and shows the record the merge guard and CI will look for
  if ((cmd === "status" || cmd === "record") && !process.env.DESIGN_GATE_BASE_SCRIPT) {
    const src = tryGit(dir, ["show", `${base}:ops/design-gate.mjs`]);
    if (src && src !== readFileSync(fileURLToPath(import.meta.url), "utf8")) {
      const tmp = mkdtempSync(join(tmpdir(), "design-gate."));
      try {
        writeFileSync(join(tmp, "design-gate.mjs"), src);
        const r = spawnSync(process.execPath, [join(tmp, "design-gate.mjs"), ...argv, "--dir", dir], { stdio: "inherit", env: { ...process.env, DESIGN_GATE_BASE_SCRIPT: "1" } });
        process.exit(r.status ?? 1);
      } finally { rmSync(tmp, { recursive: true, force: true }); }
    }
  }
  try {
    if (cmd === "status" || cmd === "check") {
      const r = check(dir, base, head);
      const gateFiles = r.files.filter((f) => !r.uiFiles.includes(f));
      console.log(r.files.length ? [
        r.uiFiles.length ? `Screen files changed:\n${r.uiFiles.map((f) => "  " + f).join("\n")}` : "No screen files changed.",
        ...(gateFiles.length ? [`The gate's own files changed (a review on record, without the design checks):\n${gateFiles.map((f) => "  " + f).join("\n")}`] : []),
        `Fingerprint: ${r.fingerprint}`, `Review file: ${r.path}`].join("\n") : "No screen files changed.");
      console.log((r.ok ? "ok  " : "MISSING  ") + r.reason);
      if (cmd === "check" && !r.ok) { console.log("Run the design gate (/design-gate) on this branch, then commit the review file it writes."); process.exit(1); }
    } else if (cmd === "record") {
      const r = record(dir, { ...opts, base });
      console.log(`Wrote ${r.path} for ${r.files.length} screen file(s). Commit it on this branch.`);
    } else if (cmd === "guard") {
      const r = guard(dir, opts.args || "");
      if (r.block) {
        process.stderr.write(`Merge blocked by the design gate: ${r.reason}\n`
          + (r.files?.length ? `Screen files changed: ${r.files.join(", ")}\nRun /design-gate on the branch, commit the review file it writes, push, then merge.\n` : ""));
        process.exit(2);
      }
    } else {
      console.error("usage: node ops/design-gate.mjs status|check|record|guard (see the top of this file)");
      process.exit(2);
    }
  } catch (e) {
    console.error(`design-gate: ${e.message}`);
    process.exit(cmd === "guard" ? 2 : 1);
  }
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("design-gate.mjs")) main(process.argv.slice(2));

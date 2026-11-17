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
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DEFAULTS = { ui: ["public/"], ignore: [], checks: [], phoneAudit: false };
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

// The fingerprint's diff ignores every git setting of whoever computes it (a Mac, a Codex worktree, the CI runner):
// no user or system config, plumbing diff-tree, and each output option pinned.
const PINNED_ENV = { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0" };
const PINNED_DIFF = ["-c", "core.quotePath=true", "diff-tree", "-r", "-p", "-U0", "--binary", "--full-index", "--no-renames",
  "--no-ext-diff", "--no-textconv", "--no-color", "--src-prefix=a/", "--dst-prefix=b/", "--diff-algorithm=myers",
  "--no-indent-heuristic", "-O/dev/null"];

/** The branch's own screen changes as text: which lines each file loses and gains, without where the hunks sit or
 *  which blobs the base had. So merging main into the branch, or a rebase, keeps the review when the branch's own
 *  change is the same; any edit to the changed lines needs a new one. */
export function screenPatch(dir, mb, head, cfg) {
  const raw = git(dir, [...PINNED_DIFF, mb, head, ...pathspec(cfg)], { env: { ...process.env, ...PINNED_ENV } });
  return raw.split("\n").filter((l) => !l.startsWith("index "))
    .map((l) => l.startsWith("@@") ? l.replace(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@.*$/, (_, a, b) => `@@ -${a ?? 1} +${b ?? 1} @@`) : l)
    .join("\n");
}

/** The screen files a branch changes, and the hash of exactly those changes. */
export function diffOf(dir, base, head, cfg) {
  const mb = git(dir, ["merge-base", base, head]).trim();
  const files = git(dir, ["diff", "--name-only", "--no-renames", mb, head, ...pathspec(cfg)], { env: { ...process.env, ...PINNED_ENV } })
    .split("\n").filter(Boolean);
  const fingerprint = createHash("sha256").update(screenPatch(dir, mb, head, cfg)).digest("hex");
  return { mergeBase: mb, files, fingerprint };
}

export const recordPath = (fp) => `design-reviews/${fp.slice(0, 16)}.md`;

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
  const path = recordPath(d.fingerprint);
  const text = tryGit(dir, ["show", `${head}:${path}`]);
  if (text == null) return { ok: false, ...d, path, reason: `no design review on record for these screen changes (${path})` };
  const r = parseRecord(text);
  if (r.fingerprint !== d.fingerprint) return { ok: false, ...d, path, reason: `${path} is for different screen changes` };
  if (!VERDICTS.includes(r.verdict)) return { ok: false, ...d, path, reason: `${path} says "${r.verdict}", not a pass` };
  const missing = cfg.checks.filter((c) => !r.checks.includes(c));
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
    if (a === "--admin") { admin = true; continue; }
    if (a === "--auto") { auto = true; continue; }
    if (a === "--disable-auto") { disableAuto = true; continue; }
    const eq = a.match(/^(-R|--repo|--match-head-commit)=(.*)$/);
    if (eq) { if (eq[1] === "--match-head-commit") matchHead = eq[2]; else repo = eq[2]; continue; }
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

function auditSummary(dirs, since) {
  return dirs.map((d) => {
    const file = join(d, "audit.json");
    if (!existsSync(file)) throw new Error(`no audit.json in ${d}; run tools/phone-audit.mjs first`);
    if (statSync(file).mtimeMs / 1000 < since) throw new Error(`${file} is older than the last screen commit; run the phone audit again`);
    const a = JSON.parse(readFileSync(file, "utf8"));
    const flagged = a.results.filter((r) => r.flags && r.flags.length);
    return `- ${a.width}px ${a.scheme}: ${a.results.length} routes, ${flagged.length} flagged`
      + (flagged.length ? ` (${flagged.map((r) => `${r.route} ${r.flags.join(" ")}`).join("; ")})` : "");
  });
}

export function record(dir, opts) {
  const base = opts.base || "origin/main";
  const cfg = loadConfig(dir, base);
  if (!VERDICTS.includes(opts.verdict)) throw new Error(`--verdict must be ${VERDICTS.join(" or ")}; a failing review is fixed, not recorded`);
  const checks = (opts.checks || "").split(",").map((s) => s.trim()).filter(Boolean);
  const missing = cfg.checks.filter((c) => !checks.includes(c));
  if (missing.length) throw new Error(`--checks is missing ${missing.join(", ")} (this repo's ops/design-gate.json asks for them)`);
  if (!opts.notes || !existsSync(opts.notes)) throw new Error("--notes FILE is required: what each check found and what was fixed");
  if (git(dir, ["status", "--porcelain", ...pathspec(cfg)]).trim()) throw new Error("commit the screen changes first: the review covers committed changes only");
  const d = diffOf(dir, base, "HEAD", cfg);
  if (!d.files.length) throw new Error("no screen files changed on this branch; nothing to review");
  const lastScreenCommit = +git(dir, ["log", "-1", "--format=%ct", "HEAD", ...pathspec(cfg)]).trim();
  const audits = cfg.phoneAudit ? auditSummary(opts.phoneAudit || [], lastScreenCommit) : [];
  if (cfg.phoneAudit && !audits.length) throw new Error("--phone-audit DIR is required (an output folder of tools/phone-audit.mjs, run after the last screen commit)");
  const path = recordPath(d.fingerprint);
  const body = [
    "# Design review", "",
    `Fingerprint: ${d.fingerprint}`,
    `Verdict: ${opts.verdict}`,
    `Checks: ${checks.join(", ")}`,
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
    const k = rest[i].replace(/^--/, "");
    if (!rest[i].startsWith("--")) continue;
    const key = k.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (key === "phoneAudit") opts.phoneAudit.push(rest[++i]); else opts[key] = rest[++i];
  }
  let dir = opts.dir || process.cwd();
  try { dir = git(dir, ["rev-parse", "--show-toplevel"]).trim(); } catch { /* not a checkout: the command says so below */ }
  const base = opts.base || "origin/main", head = opts.head || "HEAD";
  try {
    if (cmd === "status" || cmd === "check") {
      const r = check(dir, base, head);
      console.log(r.files.length ? `Screen files changed:\n${r.files.map((f) => "  " + f).join("\n")}\nFingerprint: ${r.fingerprint}\nReview file: ${recordPath(r.fingerprint)}` : "No screen files changed.");
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

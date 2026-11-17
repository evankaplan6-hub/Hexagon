// Self-test for ops/design-gate.mjs on throwaway repos: a bare "GitHub" remote, a clone, and a fake `gh`.
// Nothing here touches this checkout or the network. Run: node ops/design-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, diffOf, guard, loadConfig, normalizeRepo, parseMerge, record, recordPath, splitArgs } from "./design-gate.mjs";

const SCRIPT = new URL("./design-gate.mjs", import.meta.url).pathname;
const CONFIG = { ui: ["public/"], ignore: ["public/vendor/"], checks: ["impeccable-audit", "blind-read", "phone-audit"], phoneAudit: true };

function sh(dir, cmd, args) { return execFileSync(cmd, args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }); }
const g = (dir, ...a) => sh(dir, "git", a);

/** A bare origin with main holding the gate settings and one screen file, and a clone on a feature branch. */
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "design-gate-"));
  const origin = join(root, "origin.git"), work = join(root, "work");
  g(root, "init", "-q", "--bare", "-b", "main", origin);
  g(root, "clone", "-q", origin, work);
  for (const [k, v] of [["user.name", "t"], ["user.email", "t@example.invalid"], ["commit.gpgsign", "false"]]) g(work, "config", k, v);
  g(work, "checkout", "-q", "-b", "main");
  mkdirSync(join(work, "public/vendor"), { recursive: true }); mkdirSync(join(work, "ops"), { recursive: true }); mkdirSync(join(work, "src"), { recursive: true });
  writeFileSync(join(work, "public/desk.css"), "body { color: black; }\n");
  writeFileSync(join(work, "public/vendor/chart.js"), "// vendored\n");
  writeFileSync(join(work, "src/engine.js"), "export const x = 1;\n");
  writeFileSync(join(work, "ops/design-gate.json"), JSON.stringify(CONFIG));
  g(work, "add", "-A"); g(work, "commit", "-q", "-m", "base"); g(work, "push", "-q", "origin", "main");
  g(work, "checkout", "-q", "-b", "feature");
  return { root, origin, work, done: () => rmSync(root, { recursive: true, force: true }) };
}
function commit(work, file, text, msg = "change") { writeFileSync(join(work, file), text); g(work, "add", "-A"); g(work, "commit", "-q", "-m", msg); }
/** A phone audit folder as render.sh leaves it: audit.json, and the commit it audited (the work clone's HEAD). */
function phoneAudit(root, flags = [], { width = 375, scheme = "light", tapMin = 44, commit = true } = {}) {
  const d = join(root, `audit-${Math.random().toString(36).slice(2)}`); mkdirSync(d);
  writeFileSync(join(d, "audit.json"), JSON.stringify({ width, scheme, tapMin, results: [{ route: "/#today", flags }] }));
  if (commit) writeFileSync(join(d, "commit"), g(join(root, "work"), "rev-parse", "HEAD"));
  return d;
}
function notes(root) { const f = join(root, "notes.md"); writeFileSync(f, "impeccable audit: pass. blind read: reads as a trading floor."); return f; }
const ALL = "impeccable-audit,blind-read,phone-audit";

test("a branch with no screen changes passes", () => {
  const f = fixture();
  try { commit(f.work, "src/engine.js", "export const x = 2;\n"); assert.equal(check(f.work, "origin/main", "HEAD").ok, true); }
  finally { f.done(); }
});

test("vendored files don't count as screen changes", () => {
  const f = fixture();
  try { commit(f.work, "public/vendor/chart.js", "// v2\n"); assert.equal(check(f.work, "origin/main", "HEAD").ok, true); }
  finally { f.done(); }
});

test("a screen change with no review is missing, and record + commit makes it pass", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const before = check(f.work, "origin/main", "HEAD");
    assert.equal(before.ok, false); assert.deepEqual(before.files, ["public/desk.css"]);
    const r = record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)], tool: "test" });
    assert.equal(r.path, recordPath(before.fingerprint));
    // written but not committed: still missing at HEAD
    assert.equal(check(f.work, "origin/main", "HEAD").ok, false);
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "design review");
    const after = check(f.work, "origin/main", "HEAD");
    assert.equal(after.ok, true, after.reason);
    const text = readFileSync(join(f.work, r.path), "utf8");
    assert.match(text, /^Verdict: pass$/m); assert.match(text, /375px light, 44px taps: 1 routes, 0 flagged/);
  } finally { f.done(); }
});

test("a screen edit after the review needs a new review", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "design review");
    commit(f.work, "public/desk.css", "body { color: #222; }\n");
    const r = check(f.work, "origin/main", "HEAD");
    assert.equal(r.ok, false); assert.match(r.reason, /no design review on record/);
    // a non-screen commit after the review leaves it valid
    const f2 = fixture();
    try {
      commit(f2.work, "public/desk.css", "a{}\n");
      record(f2.work, { verdict: "pass", checks: ALL, notes: notes(f2.root), phoneAudit: [phoneAudit(f2.root)] });
      g(f2.work, "add", "-A"); g(f2.work, "commit", "-q", "-m", "review");
      commit(f2.work, "src/engine.js", "export const x = 3;\n");
      assert.equal(check(f2.work, "origin/main", "HEAD").ok, true);
    } finally { f2.done(); }
  } finally { f.done(); }
});

test("record refuses a fail verdict, missing checks, uncommitted screen edits, and a stale phone audit", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const n = notes(f.root), pa = phoneAudit(f.root);
    assert.throws(() => record(f.work, { verdict: "fail", checks: ALL, notes: n, phoneAudit: [pa] }), /verdict/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: "impeccable-audit", notes: n, phoneAudit: [pa] }), /missing blind-read, phone-audit/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [] }), /phone-audit DIR is required/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n }), /phone-audit DIR is required/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root, [], { commit: false })] }), /doesn't say which commit/);
    for (const flag of ["EVAL", "NO-FRAME", "STATUS 0", "NOSHEET", "SHEET-NOT-OPEN"])
      assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root, [flag])] }), /didn't load/, flag);
    commit(f.work, "public/desk.css", "body { color: #222; }\n");
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [pa] }), /screens differ from HEAD/);
    commit(f.work, "src/engine.js", "export const x = 2;\n");  // a later commit that isn't a screen file keeps the audit good
    record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root)] });
    writeFileSync(join(f.work, "public/desk.css"), "body { color: red; }\n");
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [pa] }), /commit the screen changes first/);
  } finally { f.done(); }
});

test("a hand-written or edited record doesn't pass", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const fp = check(f.work, "origin/main", "HEAD").fingerprint;
    mkdirSync(join(f.work, "design-reviews"));
    commit(f.work, recordPath(fp), `Fingerprint: ${fp}\nVerdict: fail\nChecks: ${ALL}\n`);
    assert.match(check(f.work, "origin/main", "HEAD").reason, /not a pass/);
    commit(f.work, recordPath(fp), `Fingerprint: ${fp}\nVerdict: pass\nChecks: impeccable-audit\n`);
    assert.match(check(f.work, "origin/main", "HEAD").reason, /missing checks: blind-read, phone-audit/);
    commit(f.work, recordPath(fp), `Fingerprint: ${"0".repeat(64)}\nVerdict: pass\nChecks: ${ALL}\n`);
    assert.match(check(f.work, "origin/main", "HEAD").reason, /different screen changes/);
  } finally { f.done(); }
});

test("a branch can't loosen its own gate: settings come from main", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "ops/design-gate.json"), JSON.stringify({ ...CONFIG, ui: ["nothing/"] }));
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, false);
  } finally { f.done(); }
});

test("merge arguments are read the way gh reads them", () => {
  assert.deepEqual(splitArgs(`12 --merge --subject "a b" -b 'c d' --delete-branch`), ["12", "--merge", "--subject", "a b", "-b", "c d", "--delete-branch"]);
  assert.deepEqual(splitArgs(`5 --merge && echo 'done'`), ["5", "--merge"]);
  assert.deepEqual(splitArgs(`5 --merge\ncd /x`), ["5", "--merge"]);
  const base = { auto: false, disableAuto: false, matchHead: null };
  assert.deepEqual(parseMerge(splitArgs(`--merge -t "x y" 42`)), { ...base, selector: "42", repo: null, admin: false });
  assert.deepEqual(parseMerge(splitArgs(`7 --repo=o/r --admin`)), { ...base, selector: "7", repo: "o/r", admin: true });
  assert.deepEqual(parseMerge(splitArgs(`-R o/r --squash`)), { ...base, selector: null, repo: "o/r", admin: false });
  assert.deepEqual(parseMerge(splitArgs(`5 --auto --match-head-commit abc`)), { ...base, selector: "5", repo: null, admin: false, auto: true, matchHead: "abc" });
  assert.equal(parseMerge(splitArgs(`5 --auto=true`)).auto, true);
  assert.equal(parseMerge(splitArgs(`5 --admin=1`)).admin, true);
  assert.equal(parseMerge(splitArgs(`5 --admin=false`)).admin, false);
  assert.equal(parseMerge(splitArgs(`5 -Ro/r`)).repo, "o/r");
  for (const r of ["o/r", "github.com/o/r", "https://github.com/o/r", "https://github.com/o/r.git/", "git@github.com:o/r.git"]) assert.equal(normalizeRepo(r), "o/r", r);
});

test("the fingerprint doesn't depend on anyone's git settings", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\nh1 { margin: 0; }\n");
    const cfg = loadConfig(f.work, "origin/main");
    const plain = diffOf(f.work, "origin/main", "HEAD", cfg).fingerprint;
    const gc = join(f.root, "gitconfig");
    writeFileSync(gc, "[diff]\n\tnoprefix = true\n\tcontext = 9\n\talgorithm = histogram\n\tmnemonicPrefix = true\n[core]\n\tquotePath = false\n");
    for (const [k, v] of [["diff.noprefix", "true"], ["diff.context", "1"], ["diff.relative", "true"], ["diff.orderFile", gc], ["diff.indentHeuristic", "false"]]) g(f.work, "config", k, v);
    const saved = process.env.GIT_CONFIG_GLOBAL; process.env.GIT_CONFIG_GLOBAL = gc;
    try { assert.equal(diffOf(f.work, "origin/main", "HEAD", cfg).fingerprint, plain); }
    finally { if (saved == null) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = saved; }
  } finally { f.done(); }
});

test("merging main into a reviewed branch keeps the review, even when main changed the same screen file", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "public/desk.css"), Array.from({ length: 12 }, (_, i) => `.r${i} { top: ${i}px; }`).join("\n") + "\n");
    g(f.work, "checkout", "-q", "main"); g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "long css"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "--ff-only", "main");
    const lines = readFileSync(join(f.work, "public/desk.css"), "utf8").split("\n");
    lines[0] = ".r0 { top: 100px; }"; commit(f.work, "public/desk.css", lines.join("\n"));
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
    // main adds lines above and changes another line of the same file
    g(f.work, "checkout", "-q", "main");
    const m = readFileSync(join(f.work, "public/desk.css"), "utf8").split("\n");
    m[10] = ".r10 { top: 999px; }"; m.splice(5, 0, ".new { top: 0; }"); commit(f.work, "public/desk.css", m.join("\n"), "main edit");
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature");
    g(f.work, "merge", "-q", "--no-edit", "origin/main");
    const after = check(f.work, "origin/main", "HEAD");
    assert.equal(after.ok, true, after.reason);
    // but editing the changed line again needs a new review
    const e = readFileSync(join(f.work, "public/desk.css"), "utf8").replace(".r0 { top: 100px; }", ".r0 { top: 101px; }");
    commit(f.work, "public/desk.css", e);
    assert.equal(check(f.work, "origin/main", "HEAD").ok, false);
  } finally { f.done(); }
});

test("moving a reviewed line elsewhere in its file needs a new review", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", ".a { top: 0; }\n@media (max-width: 400px) {\n  .tiny { top: 1px; }\n}\n.b { top: 2px; }\n");
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--ff-only", "feature"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "-b", "f2");
    commit(f.work, "public/desk.css", ".a { top: 0; }\n@media (max-width: 400px) {\n  .tiny { top: 1px; }\n  .nav { display: none; }\n}\n.b { top: 2px; }\n");
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
    commit(f.work, "public/desk.css", "  .nav { display: none; }\n.a { top: 0; }\n@media (max-width: 400px) {\n  .tiny { top: 1px; }\n}\n.b { top: 2px; }\n");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, false);
  } finally { f.done(); }
});

test("moving a reviewed line to the same neighbours elsewhere in the file needs a new review", () => {
  const f = fixture();
  try {
    const block = (name, extra) => `.${name} {\n  color: red;\n${extra}}\n`;
    commit(f.work, "public/desk.css", block("one", "") + block("two", ""));
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--ff-only", "feature"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "-b", "f2");
    commit(f.work, "public/desk.css", block("one", "  display: none;\n") + block("two", ""));
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
    commit(f.work, "public/desk.css", block("one", "") + block("two", "  display: none;\n"));
    assert.equal(check(f.work, "origin/main", "HEAD").ok, false);
  } finally { f.done(); }
});

test("main deleting lines between two reviewed changes keeps the review", () => {
  const f = fixture();
  try {
    const css = (a, b, mid) => `.a { top: ${a}; }\n${mid.map((m) => `.m${m} { top: 0; }\n`).join("")}.b { top: ${b}; }\n`;
    commit(f.work, "public/desk.css", css(0, 0, [1, 2, 3, 4, 5, 6]));
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--ff-only", "feature"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "-b", "f2");
    commit(f.work, "public/desk.css", css(1, 1, [1, 2, 3, 4, 5, 6]));
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    // main drops two lines between (more than two lines from each change), so git's own hunks would join into one
    g(f.work, "checkout", "-q", "main"); g(f.work, "checkout", "-q", "-b", "trim"); commit(f.work, "public/desk.css", css(0, 0, [1, 2, 5, 6]));
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--ff-only", "trim"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "f2"); g(f.work, "merge", "-q", "-m", "merge main", "main");
    assert.equal(g(f.work, "show", "HEAD:public/desk.css"), css(1, 1, [1, 2, 5, 6]));
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
  } finally { f.done(); }
});

test("a screen file with a space or non-ASCII letters in its name is a screen file", () => {
  const f = fixture();
  try {
    commit(f.work, "public/café menu.css", "a { color: red; }\n");
    const r = check(f.work, "origin/main", "HEAD");
    assert.deepEqual(r.uiFiles, ["public/café menu.css"]); assert.equal(r.ok, false);
    assert.throws(() => record(f.work, { verdict: "pass", checks: "", notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] }), /missing/);
  } finally { f.done(); }
});

test("record needs every phone audit the repo lists", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main");
    commit(f.work, "ops/design-gate.json", JSON.stringify({ ...CONFIG, phoneAuditSet: ["375 light 44", "440 dark 44", "440 light 24"] }));
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const n = notes(f.root);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root)] }), /missing these audits.*440 dark 44; 440 light 24/);
    const all = [phoneAudit(f.root), phoneAudit(f.root, [], { width: 440, scheme: "dark" }), phoneAudit(f.root, ["TAP 3"], { width: 440, tapMin: 24 })];
    assert.match(readFileSync(join(f.work, record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: all }).path), "utf8"), /440px light, 24px taps: 1 routes, 1 flagged/);
  } finally { f.done(); }
});

test("status and record run main's own script when the branch's differs", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main");
    commit(f.work, "ops/design-gate.mjs", readFileSync(SCRIPT, "utf8") + '\nconsole.error("ran the base script");\n');
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    commit(f.work, "ops/design-gate.mjs", readFileSync(SCRIPT, "utf8"));
    const r = execFileSync(process.execPath, [SCRIPT, "status", "--base=origin/main"], { cwd: f.work, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    assert.match(r, /The gate's own files changed/);
    const both = spawnSync(process.execPath, [SCRIPT, "status"], { cwd: f.work, encoding: "utf8" });
    assert.match(both.stderr, /ran the base script/);
  } finally { f.done(); }
});

test("bytes that aren't valid UTF-8 still change the fingerprint", () => {
  const f = fixture();
  try {
    const put = (byte) => { writeFileSync(join(f.work, "public/x.bin"), Buffer.from([0x61, byte, 0x0a])); g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "b"); };
    put(0x80); const a = diffOf(f.work, "origin/main", "HEAD", loadConfig(f.work)).fingerprint;
    put(0x81); const b = diffOf(f.work, "origin/main", "HEAD", loadConfig(f.work)).fingerprint;
    assert.notEqual(a, b);
  } finally { f.done(); }
});

test("the caller's pathspec settings don't hide screen files", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    for (const v of ["GIT_LITERAL_PATHSPECS", "GIT_NOGLOB_PATHSPECS", "GIT_ICASE_PATHSPECS"]) {
      process.env[v] = "1";
      try { assert.deepEqual(check(f.work, "origin/main", "HEAD").uiFiles, ["public/desk.css"], v); } finally { delete process.env[v]; }
    }
  } finally { f.done(); }
});

test("a change landed, reverted with its record and landed again needs a new review", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--no-ff", "-m", "merge A", "feature");
    g(f.work, "revert", "--no-edit", "-m", "1", "HEAD"); const revert = g(f.work, "rev-parse", "HEAD").trim();
    g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "-b", "reland"); g(f.work, "revert", "--no-edit", revert);
    const r = check(f.work, "origin/main", "HEAD");
    assert.equal(r.ok, false); assert.match(r.reason, /earlier pull request/);
    assert.equal(record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] }).path, recordPath(r.fingerprint, 2));
  } finally { f.done(); }
});

test("record needs every listed route in each audit of the set", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main");
    mkdirSync(join(f.work, "tools"), { recursive: true });
    writeFileSync(join(f.work, "tools/urls.txt"), "# routes\n/#today\n/#today   sheet=desk\n");
    commit(f.work, "ops/design-gate.json", JSON.stringify({ ...CONFIG, phoneAuditSet: ["375 light 44"], phoneAuditUrls: "tools/urls.txt" }));
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const n = notes(f.root);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root)] }), /didn't cover \/#today sheet=desk/);
    const extra = phoneAudit(f.root);
    const j = JSON.parse(readFileSync(join(extra, "audit.json"), "utf8")); j.results = [{ route: "/#today sheet=desk", flags: [] }];
    writeFileSync(join(extra, "audit.json"), JSON.stringify(j));
    record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [phoneAudit(f.root), extra] });
  } finally { f.done(); }
});

test("record refuses an audit of a commit this checkout doesn't have, or with no results", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const n = notes(f.root), pa = phoneAudit(f.root);
    writeFileSync(join(pa, "commit"), "1".repeat(40));
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [pa] }), /isn't in this checkout/);
    const bad = phoneAudit(f.root); writeFileSync(join(bad, "audit.json"), "{}");
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [bad] }), /has no results/);
    const r = spawnSync(process.execPath, [SCRIPT, "record", "--verdict", "pass", "--phone-audit"], { cwd: f.work, encoding: "utf8" });
    assert.equal(r.status, 2); assert.match(r.stderr, /--phone-audit needs a value/);
  } finally { f.done(); }
});

test("a review already on main can't be reused by a later pull request", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n.debug {\n  display: none;\n}\n");
    record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--no-ff", "-m", "merge A", "feature"); g(f.work, "push", "-q", "origin", "main");
    // B reverts A's lines: the same patch reversed is a different fingerprint, so make B re-add exactly A's change
    g(f.work, "checkout", "-q", "-b", "undo"); commit(f.work, "public/desk.css", "body { color: black; }\n");
    g(f.work, "checkout", "-q", "main"); g(f.work, "merge", "-q", "--ff-only", "undo"); g(f.work, "push", "-q", "origin", "main");
    g(f.work, "checkout", "-q", "-b", "b");
    commit(f.work, "public/desk.css", "body { color: #111; }\n.debug {\n  display: none;\n}\n");
    const r = check(f.work, "origin/main", "HEAD");
    assert.equal(r.ok, false); assert.match(r.reason, /earlier pull request/);
    // its own review gets its own record name, so landing the same change again isn't stuck
    const rec = record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    assert.equal(rec.path, recordPath(r.fingerprint, 2));
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review again");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
  } finally { f.done(); }
});

test("a change to the gate's own files needs a review on record, without the design checks", () => {
  const f = fixture();
  try {
    commit(f.work, "ops/design-gate.json", JSON.stringify({ ...CONFIG, ignore: ["public/"] }));
    const r = check(f.work, "origin/main", "HEAD");
    assert.equal(r.ok, false); assert.deepEqual(r.files, ["ops/design-gate.json"]);
    record(f.work, { verdict: "pass", checks: "", notes: notes(f.root) });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review of the gate change");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
  } finally { f.done(); }
});

test("the fingerprint ignores compression, GIT_DIFF_OPTS and git -c settings, binary files included", () => {
  const f = fixture();
  try {
    writeFileSync(join(f.work, "public/icon.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 255, 0, 10, 13]));
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const cfg = loadConfig(f.work, "origin/main");
    const plain = diffOf(f.work, "origin/main", "HEAD", cfg).fingerprint;
    g(f.work, "config", "core.compression", "0");
    const saved = { ...process.env };
    process.env.GIT_DIFF_OPTS = "-u3"; process.env.GIT_CONFIG_PARAMETERS = "'diff.context'='5'";
    try { assert.equal(diffOf(f.work, "origin/main", "HEAD", cfg).fingerprint, plain); }
    finally { for (const k of ["GIT_DIFF_OPTS", "GIT_CONFIG_PARAMETERS"]) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
  } finally { f.done(); }
});

test("the command line works from a subfolder", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    assert.throws(() => sh(join(f.work, "ops"), "node", [SCRIPT, "check"]), (e) => e.status === 1 && /MISSING/.test(e.stdout) && /public\/desk\.css/.test(e.stdout));
  } finally { f.done(); }
});

/** A fake gh that answers `gh pr view` for one PR whose head is pushed as refs/pull/N/head. */
function fakeGh(f, number) {
  const head = g(f.work, "rev-parse", "HEAD").trim();
  g(f.work, "push", "-q", "origin", `HEAD:refs/pull/${number}/head`);
  const bin = join(f.root, "gh");
  writeFileSync(bin, `#!/bin/sh\nif [ "$1 $2" = "pr view" ]; then echo '${JSON.stringify({ number, headRefOid: head, baseRefName: "main", url: "x" })}'; exit 0; fi\nexit 1\n`);
  chmodSync(bin, 0o755);
  return bin;
}

test("guard blocks an unreviewed screen PR and --admin, and lets a reviewed one through", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    let gh = fakeGh(f, 5);
    const blocked = guard(f.work, "5 --merge", gh);
    assert.equal(blocked.block, true); assert.match(blocked.reason, /no design review on record/);
    assert.equal(guard(f.work, "5 --merge --admin", gh).block, true);
    record(f.work, { verdict: "pass-with-fixes", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] });
    g(f.work, "add", "-A"); g(f.work, "commit", "-q", "-m", "review");
    gh = fakeGh(f, 5);
    const head = g(f.work, "rev-parse", "HEAD").trim();
    // reviewed, but the merge must be pinned to the commit the gate checked
    const unpinned = guard(f.work, "5 --merge --delete-branch", gh);
    assert.equal(unpinned.block, true); assert.match(unpinned.reason, new RegExp(`--match-head-commit ${head}`));
    assert.equal(guard(f.work, `5 --merge --match-head-commit ${"1".repeat(40)}`, gh).block, true);
    const ok = guard(f.work, `5 --merge --delete-branch --match-head-commit ${head}`, gh);
    assert.equal(ok.block, false, ok.reason);
    assert.equal(guard(f.work, `5 --auto --merge --match-head-commit ${head}`, gh).block, true);
  } finally { f.done(); }
});

test("guard lets --disable-auto through, blocks --auto, and lets a no-screen PR merge unpinned", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const gh = fakeGh(f, 7);
    assert.equal(guard(f.work, "7 --disable-auto", gh).block, false);
    const auto = guard(f.work, "7 --auto --merge", gh);
    assert.equal(auto.block, true); assert.match(auto.reason, /--auto/);
    const f2 = fixture();
    try { commit(f2.work, "src/engine.js", "export const x = 9;\n"); assert.equal(guard(f2.work, "8 --merge", fakeGh(f2, 8)).block, false); }
    finally { f2.done(); }
  } finally { f.done(); }
});

test("guard blocks when gh doesn't answer in time", () => {
  const f = fixture();
  const saved = process.env.DESIGN_GATE_TIMEOUT_MS;
  try {
    const bin = join(f.root, "gh-slow"); writeFileSync(bin, "#!/bin/sh\nsleep 5\n"); chmodSync(bin, 0o755);
    process.env.DESIGN_GATE_TIMEOUT_MS = "500";
    const t = process.hrtime.bigint();
    const r = guard(f.work, "9 --merge", bin);
    assert.equal(r.block, true); assert.match(r.reason, /no answer in 0.5 s/);
    assert.ok(Number(process.hrtime.bigint() - t) / 1e9 < 4);
  } finally { if (saved == null) delete process.env.DESIGN_GATE_TIMEOUT_MS; else process.env.DESIGN_GATE_TIMEOUT_MS = saved; f.done(); }
});

test("guard fails closed when gh can't answer", () => {
  const f = fixture();
  try {
    const bin = join(f.root, "gh-broken"); writeFileSync(bin, "#!/bin/sh\necho 'no network' >&2\nexit 1\n"); chmodSync(bin, 0o755);
    const r = guard(f.work, "9 --merge", bin);
    assert.equal(r.block, true); assert.match(r.reason, /couldn't look up the pull request/);
  } finally { f.done(); }
});

test("the command line: check exits 1 when missing, guard exits 2 to block", () => {
  const f = fixture();
  try {
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    assert.throws(() => sh(f.work, "node", [SCRIPT, "check"]), (e) => e.status === 1 && /MISSING/.test(e.stdout));
    const out = sh(f.work, "node", [SCRIPT, "status"]);
    assert.match(out, /public\/desk\.css/);
  } finally { f.done(); }
});

/** A phone audit folder in the other shape a repo's tool may write: audit.json a plain list of { url, flags } rows,
 *  with the width, scheme and tap size in meta.json (render.sh writes it next to the commit). */
function listAudit(root, rows, meta = { width: 375, scheme: "light", tapMin: 44 }) {
  const d = join(root, `audit-${Math.random().toString(36).slice(2)}`); mkdirSync(d);
  writeFileSync(join(d, "audit.json"), JSON.stringify(rows));
  if (meta) writeFileSync(join(d, "meta.json"), JSON.stringify(meta));
  writeFileSync(join(d, "commit"), g(join(root, "work"), "rev-parse", "HEAD"));
  return d;
}

test("a phone audit written as a list of rows counts, with its width and scheme from meta.json", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main");
    mkdirSync(join(f.work, "docs"), { recursive: true });
    writeFileSync(join(f.work, "docs/urls.txt"), "/\n/t/GME\n");
    commit(f.work, "ops/design-gate.json", JSON.stringify({ ...CONFIG, phoneAuditSet: ["440 dark 44"], phoneAuditUrls: "docs/urls.txt",
      phoneAuditBroken: "^(STATUS|EVAL|EMPTY)\\b" }));
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    const n = notes(f.root), ok = [{ url: "/", flags: [] }, { url: "/t/GME", flags: ["LAZY", "CUT 2"] }];
    const meta = { width: 440, scheme: "dark", tapMin: 44 };
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [listAudit(f.root, ok, null)] }), /no meta.json/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [listAudit(f.root, [{ url: "/" }], meta)] }), /rows without flags/);
    // this repo's broken flags, not another tool's: EMPTY is broken here, and NOSHEET would mean nothing
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n,
      phoneAudit: [listAudit(f.root, [{ url: "/", flags: ["EMPTY"] }, ok[1]], meta)] }), /\/ \(EMPTY\) didn't load/);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [listAudit(f.root, [ok[0]], meta)] }), /didn't cover \/t\/GME/);
    const r = record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [listAudit(f.root, ok, meta)] });
    assert.match(readFileSync(join(f.work, r.path), "utf8"), /440px dark, 44px taps: 2 routes, 1 flagged \(\/t\/GME LAZY CUT 2\)/);
  } finally { f.done(); }
});

test("with no settings the gate covers only its own files", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main"); commit(f.work, "ops/design-gate.json", "{}");
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    assert.equal(check(f.work, "origin/main", "HEAD").ok, true);
    commit(f.work, "ops/design-gate.mjs", "// changed\n");
    const r = check(f.work, "origin/main", "HEAD");
    assert.equal(r.ok, false); assert.deepEqual(r.files, ["ops/design-gate.mjs"]); assert.deepEqual(r.uiFiles, []);
  } finally { f.done(); }
});

test("a branch can't drop a route from its own coverage: the routes file comes from main", () => {
  const f = fixture();
  try {
    g(f.work, "checkout", "-q", "main");
    mkdirSync(join(f.work, "tools"), { recursive: true });
    writeFileSync(join(f.work, "tools/urls.txt"), "/#today\n/#crypto\n");
    commit(f.work, "ops/design-gate.json", JSON.stringify({ ...CONFIG, phoneAuditSet: ["375 light 44"], phoneAuditUrls: "tools/urls.txt" }));
    g(f.work, "push", "-q", "origin", "main"); g(f.work, "checkout", "-q", "feature"); g(f.work, "merge", "-q", "main");
    writeFileSync(join(f.work, "tools/urls.txt"), "/#today\n");
    commit(f.work, "public/desk.css", "body { color: #111; }\n");
    // phoneAudit() covers /#today only: main's list also asks for /#crypto
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: notes(f.root), phoneAudit: [phoneAudit(f.root)] }), /didn't cover \/#crypto, listed in tools\/urls.txt on origin\/main\. .*in a pull request of its own first/);
  } finally { f.done(); }
});

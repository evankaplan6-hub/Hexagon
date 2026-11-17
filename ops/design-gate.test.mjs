// Self-test for ops/design-gate.mjs on throwaway repos: a bare "GitHub" remote, a clone, and a fake `gh`.
// Nothing here touches this checkout or the network. Run: node ops/design-gate.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, guard, parseMerge, record, recordPath, splitArgs } from "./design-gate.mjs";

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
function phoneAudit(root, flagged = false) {
  const d = join(root, `audit-${Math.random().toString(36).slice(2)}`); mkdirSync(d);
  writeFileSync(join(d, "audit.json"), JSON.stringify({ width: 375, scheme: "light", results: [{ route: "/#today", flags: flagged ? ["CUT 1"] : [] }] }));
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
    assert.match(text, /^Verdict: pass$/m); assert.match(text, /375px light: 1 routes, 0 flagged/);
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
    const old = phoneAudit(f.root); utimesSync(join(old, "audit.json"), 1, 1);
    assert.throws(() => record(f.work, { verdict: "pass", checks: ALL, notes: n, phoneAudit: [old] }), /older than the last screen commit/);
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
  assert.deepEqual(parseMerge(splitArgs(`--merge -t "x y" 42`)), { selector: "42", repo: null, admin: false });
  assert.deepEqual(parseMerge(splitArgs(`7 --repo=o/r --admin`)), { selector: "7", repo: "o/r", admin: true });
  assert.deepEqual(parseMerge(splitArgs(`-R o/r --squash`)), { selector: null, repo: "o/r", admin: false });
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
    const ok = guard(f.work, "5 --merge --delete-branch", gh);
    assert.equal(ok.block, false, ok.reason);
  } finally { f.done(); }
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

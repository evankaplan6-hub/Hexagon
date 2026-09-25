'use strict';
// Copy the Fly box's closed days down to the Mac, and -- only with --trim -- delete old tick tapes
// and probe files from the box once the Mac copy is proven byte-identical.
//
// Why this exists: /data on hexagon-desk is a 1GB volume and the tick tape is about 90-130MB per
// Eastern day since sports joined the crawl (2026-09-19), so the box fills in about a week. A full disk does not just stop the tape; the journal
// (the append-only truth) and state.json stop writing with it. Nothing on the box reads an old
// tape -- only tools/replay.js and tools/history-scan.js do, run by hand -- so the tapes can live
// on the Mac instead. The box keeps its own last-resort brake (src/recorder.js, TAPE_MIN_FREE_MB)
// for when this has stopped running; that one deletes without a copy, which is why this should run.
//
//   node tools/fly-pull.js                     copy every closed day into data/fly/archive
//   node tools/fly-pull.js --trim              ...then delete box tapes and probes older than the newest 3 ET days
//   node tools/fly-pull.js --trim --dry-run    print what it would copy and delete; change nothing
//   flags: --app hexagon-desk   --dest data/fly/archive   --keep 3
//
// What it copies: the prediction-market desk's dated files in /data itself (ticks, journal, whales,
// probes), and since 2026-09-25 the stocks, crypto and options desk's journals in /data/desk
// (src/desk/engine.js), into archive/desk/. A file is named by its path under /data, so the desk's
// are "desk/journal-YYYY-MM-DD.jsonl" and go through the same plan, copy and checks as the others.
//
// The rules, all decided in planPull (pure, tested in tools/disk-test.js):
//   - a file is copied only once its Eastern day is over (today's files are still being written);
//   - a copy lands under a temp name and is renamed into place only after its sha256 matches the
//     box's; a local file that differs and is NOT just an older, shorter copy is never overwritten;
//   - a delete needs a ticks-*.jsonl or probes-*.jsonl in /data itself, outside the --keep window,
//     AND a local copy whose sha256 equals the box's sha256 from this same run. Journals (the
//     desk's too), whales and state.json are never deleted, and neither is anything of today's;
//   - a copy that fails blocks the delete of its own file only; a listing it cannot vouch for, or a
//     box that did not say its own date, means no deletes at all this run. The trim can wait a day.
//
// Probes joined the tapes on 2026-09-24: nothing on the box reads an old probes-*.jsonl (only
// tools/replay.js and tools/history-scan.js do, on the Mac), and at 5-8 MB a day, never trimmed,
// they had grown to about 50 MB of the box's 1 GB and took more of its free space every day, toward
// the floor where the brake starts deleting tapes that never reached the Mac.
//
// data/fly/ itself is a frozen snapshot that the maker baselines point at; this writes only to
// the archive folder under it and refuses a --dest of data/fly, however it is spelled.
//
// The archive is the MAIN checkout's data/fly/archive even when this runs from a linked git
// worktree (.claude/worktrees/*): a worktree's ignored data/ is deleted with the worktree, so a
// copy there is no reason to delete the box's. --trim into a worktree is refused outright.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { ET_DAY } = require('../src/recorder');

// what is copied, by its path under /data: the dated files in /data, and the desk's journals in /data/desk
const DATED = /^(ticks|journal|whales|probes|desk\/journal)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
// what --trim may delete from the box once the Mac has it: the tapes and the probe files in /data itself
const TRIMMED = /^(ticks|probes)-(\d{4}-\d{2}-\d{2})\.jsonl$/;
// a download that fails is tried this many times in all, each from an empty temp file: on 2026-09-23
// an awake Mac lost the connection 80 MB into a 123 MB tape, and the next try would have been hours away
const GET_TRIES = 3;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const MB = 1024 * 1024;
const mb = (b) => (b / MB).toFixed(1);
const BOX_DIR = '/data';
const USAGE = 'usage: node tools/fly-pull.js [--trim] [--dry-run] [--keep 3] [--app hexagon-desk] [--dest data/fly/archive]';
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
// the name column of the per-file lines: the longest name, desk/journal-YYYY-MM-DD.jsonl, and a space
const COL = 30;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// '2026-09-14' + n days, as a date string. Pure calendar arithmetic on UTC midnight, so no DST.
function addDays(day, n) {
  const [y, m, d] = day.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- the decision, with no I/O
// boxFiles:   [{ name, size, sha256 }] from the box (sha256 is null for today's files: not hashed).
//             `name` is the path under /data: 'ticks-2026-09-14.jsonl', 'desk/journal-2026-09-14.jsonl'
// localFiles: [{ name, size, sha256, notPrefix? }] from --dest, named the same way. `notPrefix` is set
//             by the caller once it has downloaded the box file and found the local copy is not its start.
// Returns:
//   copy             [{ name, size, sha256, reason: 'missing' | 'partial' }]
//   have             names already archived with a matching sha256
//   conflicts        [{ name, why }] local copies that differ and must not be overwritten
//   errors           [{ name, why }] box entries this run cannot vouch for (no hash, bad size)
//   open             names whose Eastern day is not over, left alone
//   delete           [{ name, size, sha256 }] safe to delete now: archived, verified, old enough
//   deleteAfterCopy  [{ name, size, sha256 }] safe once its copy verifies (what a dry run shows)
//   keptOnBox        closed tick tapes and probe files inside the keep window
//   cutoff           the oldest Eastern day whose tape stays on the box
function planPull(boxFiles, localFiles, { todayET, keep = 3, trim = false } = {}) {
  if (!DAY.test(String(todayET))) throw new Error(`todayET must be YYYY-MM-DD, got ${todayET}`);
  if (!Number.isInteger(keep) || keep < 1) throw new Error(`keep must be a whole number of days, at least 1 (today), got ${keep}`);
  const local = new Map((localFiles || []).map((f) => [f.name, f]));
  // keep=3 on the 14th keeps the 14th, 13th and 12th: today counts as one
  const cutoff = addDays(todayET, -(keep - 1));
  const plan = { copy: [], have: [], conflicts: [], errors: [], open: [], delete: [], deleteAfterCopy: [], keptOnBox: [], cutoff, todayET, keep, trim: !!trim };
  const seen = new Set();
  for (const f of [...(boxFiles || [])].filter(Boolean).sort(byName)) {
    const m = DATED.exec(f.name);
    if (!m || seen.has(f.name)) continue;   // state.json, fillcheck.jsonl, lost+found: not ours to move
    seen.add(f.name);
    const [, kind, day] = m;
    // today's files are still growing; a future-dated one means a clock is wrong -- touch neither
    if (day >= todayET) { plan.open.push(f.name); continue; }
    if (!HEX64.test(String(f.sha256)) || !Number.isInteger(f.size) || f.size < 0) {
      plan.errors.push({ name: f.name, why: 'the box gave no usable size and sha256 for it' });
      continue;
    }
    const entry = { name: f.name, size: f.size, sha256: f.sha256 };
    const l = local.get(f.name);
    let state;
    if (!l) { plan.copy.push({ ...entry, reason: 'missing' }); state = 'copy'; }
    else if (l.sha256 === f.sha256 && l.size === f.size && !l.notPrefix) { plan.have.push(f.name); state = 'have'; }
    // shorter and not yet shown to be a stranger: most likely a copy taken before the day ended.
    // The caller downloads the full file and checks the prefix before replacing anything.
    else if (Number.isInteger(l.size) && l.size < f.size && !l.notPrefix) { plan.copy.push({ ...entry, reason: 'partial' }); state = 'copy'; }
    else {
      plan.conflicts.push({ name: f.name, why: l.notPrefix ? 'the Mac copy differs and is not just an older, shorter copy of the box file' : 'the Mac copy differs and is not shorter than the box file' });
      state = 'conflict';
    }
    if ((kind !== 'ticks' && kind !== 'probes') || !TRIMMED.test(f.name)) continue;   // journals (the desk's too), whales: never deleted
    if (day >= cutoff) { plan.keptOnBox.push(f.name); continue; }
    if (!trim) continue;
    if (state === 'have') plan.delete.push(entry);
    else if (state === 'copy') plan.deleteAfterCopy.push(entry);
    // a conflict is never deleted: the box copy may be the only good one
  }
  return plan;
}

// ---------------------------------------------------------------- listing a directory
// Runs on BOTH sides. On the box it is shipped as source through `node -e` (see boxCall), so it
// must be self-contained: its own requires, no closures. Read-only: readdir, stat, read, statfs.
// Sizes come from the bytes actually hashed, so size and sha256 always describe the same bytes.
// Files dated today or later are listed but not hashed -- they are still being written, and
// hashing 60MB the desk is appending to would buy nothing but CPU taken from the maker.
//
// "Today" is the EARLIER of the caller's `todayET` and this side's own Eastern date, and the own
// date comes back as `today`. On the box that matters: the box is the one writing today's tape,
// so a Mac clock running a few minutes fast across Eastern midnight must not turn the tape still
// being written into a closed day. (The same formatter options as src/recorder.js's ET_DAY; it
// cannot be required from here, the source travels alone. `nowMs` is for the tests' fake box.)
//
// It lists `dir` and then its desk/ folder, naming a file there by its path under `dir`
// ('desk/journal-2026-09-14.jsonl'): /data/desk on the box, archive/desk on the Mac. Only journals
// are taken from desk/ (its state.json is tools/desk-check.js --box's to copy, into
// data/fly/desk-now), and a desk/ that is not there yet, because the desk has written nothing,
// lists as empty.
function listDir({ dir, todayET, only, nowMs }) {
  const fs = require('fs'), path = require('path'), crypto = require('crypto');
  // [a folder under `dir`, the names in it that are ours]
  const AREAS = [['', /^(ticks|journal|whales|probes)-(\d{4}-\d{2}-\d{2})\.jsonl$/], ['desk', /^(journal)-(\d{4}-\d{2}-\d{2})\.jsonl$/]];
  const own = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(nowMs == null ? Date.now() : nowMs));
  const today = todayET && todayET < own ? todayET : own;
  const want = only ? new Set(only) : null;
  const buf = Buffer.alloc(1 << 20);
  const files = [];
  for (const [sub, RE] of AREAS) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, sub)).sort(); } catch (e) { if (e.code !== 'ENOENT') throw e; }
    for (const base of names) {
      const m = RE.exec(base);
      const name = sub ? `${sub}/${base}` : base;
      if (!m || (want && !want.has(name))) continue;
      const full = path.join(dir, name);
      const st = fs.statSync(full);
      if (!st.isFile()) continue;
      if (m[2] >= today) { files.push({ name, size: st.size, sha256: null }); continue; }
      const h = crypto.createHash('sha256');
      let size = 0;
      const fd = fs.openSync(full, 'r');
      try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0; size += n) h.update(buf.subarray(0, n)); }
      finally { fs.closeSync(fd); }
      files.push({ name, size, sha256: h.digest('hex') });
    }
  }
  let freeBytes = null, totalBytes = null;
  try { const s = fs.statfsSync(dir); freeBytes = s.bavail * s.bsize; totalBytes = s.blocks * s.bsize; } catch { /* not every filesystem says */ }
  return { machine: process.env.FLY_MACHINE_ID || null, today: own, freeBytes, totalBytes, files };
}

function boxFree({ dir }) {
  const s = require('fs').statfsSync(dir);
  return { freeBytes: s.bavail * s.bsize };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const buf = Buffer.alloc(1 << 20);
  const fd = fs.openSync(file, 'r');
  try { for (let n; (n = fs.readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest('hex');
}

// Is `short` byte-for-byte the start of `long`? This is what separates "an older copy taken
// before the day ended" (safe to replace with the finished file) from "a different file with the
// same name" (keep it, and say so).
function isBytePrefix(short, long) {
  const a = fs.statSync(short).size, b = fs.statSync(long).size;
  if (a > b) return false;
  const ba = Buffer.alloc(1 << 20), bb = Buffer.alloc(1 << 20);
  const fa = fs.openSync(short, 'r'), fb = fs.openSync(long, 'r');
  try {
    for (let off = 0; off < a;) {
      const want = Math.min(ba.length, a - off);
      const na = fs.readSync(fa, ba, 0, want, off), nb = fs.readSync(fb, bb, 0, want, off);
      if (na !== want || nb !== want || ba.compare(bb, 0, want, 0, want) !== 0) return false;
      off += want;
    }
    return true;
  } finally { fs.closeSync(fa); fs.closeSync(fb); }
}

// ---------------------------------------------------------------- where the archive may live
// The main checkout that `dir` belongs to. In a linked git worktree .git is a FILE naming
// <main>/.git/worktrees/<name>, and that folder's `commondir` points back at <main>/.git. Read
// straight off the disk rather than asking `git`, which launchd's bare PATH may not run. A folder
// with no .git at all (a plain copy) is its own home.
function mainCheckout(dir) {
  const dotgit = path.join(dir, '.git');
  let st;
  try { st = fs.statSync(dotgit); } catch { return dir; }
  if (st.isDirectory()) return dir;
  const m = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(dotgit, 'utf8'));
  if (!m) throw new Error(`${dotgit} is a file that names no gitdir`);
  const gitdir = path.resolve(dir, m[1]);
  let main;
  try { main = path.dirname(path.resolve(gitdir, fs.readFileSync(path.join(gitdir, 'commondir'), 'utf8').trim())); }
  catch { throw new Error(`${dir} is a linked git checkout and its main checkout could not be found`); }
  if (!fs.statSync(path.join(main, '.git')).isDirectory()) throw new Error(`${main} does not look like the main checkout of ${dir}`);
  return main;
}

// The linked worktree `p` sits inside, or null. Followed through symlinks from the nearest folder
// that exists, then up to the first .git: a directory means a main checkout (fine), a file means
// a linked worktree. The .claude/worktrees path is checked by name too, in case its .git is gone.
function linkedWorktreeOf(p) {
  let dir = path.resolve(p);
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
  try { dir = fs.realpathSync.native(dir); } catch { return null; }
  const named = /^(.*[\\/]\.claude[\\/]worktrees[\\/][^\\/]+)(?:[\\/]|$)/i.exec(dir);
  if (named) return named[1];
  for (;;) {
    let st = null;
    try { st = fs.lstatSync(path.join(dir, '.git')); } catch { /* no .git at this level */ }
    if (st) return st.isDirectory() ? null : dir;
    const up = path.dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
}

const sameFile = (a, b) => {
  try { const x = fs.statSync(a), y = fs.statSync(b); return x.dev === y.dev && x.ino === y.ino; } catch { return false; }
};

// Is `dest` the frozen data/fly snapshot of any of `roots`? By name without regard to case (this
// Mac's disk ignores case, so data/FLY is data/fly), and by inode, so a symlink or a differently
// spelled path to the same folder is caught too.
function isFrozenSnapshot(dest, roots) {
  const d = path.resolve(dest);
  if (path.basename(d).toLowerCase() === 'fly' && path.basename(path.dirname(d)).toLowerCase() === 'data') return true;
  return roots.some((root) => sameFile(d, path.join(root, 'data', 'fly')) ||
    (path.basename(d).toLowerCase() === 'fly' && sameFile(path.dirname(d), path.join(root, 'data'))));
}

// ---------------------------------------------------------------- talking to the box
function findFly() {
  if (process.env.FLY_BIN) return [process.env.FLY_BIN];
  const home = path.join(process.env.HOME || '', '.fly', 'bin', 'fly');
  return [fs.existsSync(home) ? home : 'fly'];
}

// `fly` is a command array ([binary, ...leading args]) so the tests can put a fake in its place.
function runFly(fly, args, timeoutMs) {
  try {
    return execFileSync(fly[0], [...fly.slice(1), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs, maxBuffer: 16 * MB });
  } catch (e) {
    const why = String(e.stderr || e.message || e).trim().split('\n').filter(Boolean).pop() || 'failed';
    const timedOut = e.code === 'ETIMEDOUT' || e.signal === 'SIGTERM';
    throw new Error(`fly ${args[0]} ${args[1]}: ${timedOut ? `timed out after ${Math.round(timeoutMs / 1000)}s` : why}`);
  }
}

// A plain blocking wait between download tries; the whole run is synchronous already.
const sleepMs = (ms) => { if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };

const pin = (app, machine) => ['-a', app, ...(machine ? ['--machine', machine] : [])];

// Run a self-contained function on the box with `node -e` and read back its JSON. The source
// travels as base64 because `fly ssh console -C` re-splits the command line into words and eats
// the quotes inside it; base64 has no character a shell word cares about. `nice` so the desk
// keeps the box's one shared CPU while the hashing runs.
function boxCall(fly, app, machine, fn, arg, timeoutMs) {
  const src = `console.log(JSON.stringify((${fn.toString()})(${JSON.stringify(arg)})))`;
  const b64 = Buffer.from(src).toString('base64');
  const out = runFly(fly, ['ssh', 'console', '-q', ...pin(app, machine), '-C', `nice -n 19 node -e "eval(Buffer.from('${b64}','base64').toString())"`], timeoutMs);
  const line = out.split('\n').map((s) => s.trim()).filter((s) => s.startsWith('{')).pop();
  if (!line) throw new Error('the box printed nothing readable');
  return JSON.parse(line);
}

// ---------------------------------------------------------------- the run
function parseArgs(argv) {
  const o = { app: 'hexagon-desk', dest: null, keep: 3, trim: false, dryRun: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i], v;
    const eq = a.indexOf('=');
    if (a.startsWith('--') && eq > 0) { v = a.slice(eq + 1); a = a.slice(0, eq); }
    const val = () => { if (v !== undefined) return v; if (i + 1 >= argv.length) throw new Error(`${a} needs a value`); return argv[++i]; };
    // an on/off flag is on by being there: `--trim=false` would otherwise mean trim, the one
    // flag that deletes, so a value on one is a usage error rather than a guess
    if ((a === '--trim' || a === '--dry-run' || a === '--help') && v !== undefined) throw new Error(`${a} takes no value (got ${a}=${v}); leave it out to turn it off`);
    if (a === '--trim') o.trim = true;
    else if (a === '--dry-run') o.dryRun = true;
    else if (a === '--app') o.app = val();
    else if (a === '--dest') o.dest = val();
    else if (a === '--keep') { const s = val(); o.keep = /^\d+$/.test(s) ? Number(s) : NaN; }
    else if (a === '--help' || a === '-h') o.help = true;
    else throw new Error(`unknown flag ${a}`);
  }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(o.app)) throw new Error(`--app does not look like a Fly app name: ${o.app}`);
  if (!Number.isInteger(o.keep) || o.keep < 1) throw new Error('--keep must be a whole number of days, at least 1 (today counts as one)');
  if (o.dest === '') throw new Error('--dest needs a folder');
  return o;
}

// Everything main does, with the clock and the fly binary passed in, returning the exit code
// instead of exiting -- tools/disk-test.js drives it against a fake fly with a fixed date.
// `root` is the checkout this file sits in; the tests point it at a made-up one.
function run(argv, { now = () => new Date(), fly = findFly(), cwd = process.cwd(), out = console.log, err = console.error, root = path.join(__dirname, '..'), pause = sleepMs, retryPauseMs = 30000 } = {}) {
  let opts;
  try { opts = parseArgs(argv); } catch (e) { err(`fly-pull: ${e.message}\n${USAGE}`); return 2; }
  if (opts.help) { out(USAGE); return 0; }

  let home;
  try { home = mainCheckout(root); } catch (e) {
    if (!opts.dest) { err(`fly-pull: ${e.message}, so there is no safe default archive folder; pass --dest`); return 2; }
    home = root;
  }
  const dest = opts.dest ? path.resolve(cwd, opts.dest) : path.join(home, 'data', 'fly', 'archive');
  if (isFrozenSnapshot(dest, [home, root])) {
    err('fly-pull: refusing --dest data/fly: that folder is a frozen snapshot the maker baselines point at. Use data/fly/archive.');
    return 2;
  }
  const worktree = linkedWorktreeOf(dest);
  if (opts.trim && worktree) {
    err(`fly-pull: refusing --trim into ${dest}: that is inside the git worktree ${worktree}, and a worktree's data/ is deleted along with it. ` +
      "A box tape is deleted only once its copy is somewhere that lasts: leave out --dest to use the main checkout's data/fly/archive.");
    return 2;
  }
  const shown = path.relative(cwd, dest) || '.';
  const macToday = ET_DAY.format(now());
  let todayET = macToday;
  const problems = [];
  const problem = (msg) => { problems.push(msg); out(`  PROBLEM  ${msg}`); };

  // A dry run changes nothing on either side -- not even the log. Every other run leaves one line
  // in pull.log, failures included, so a job that has quietly stopped working is visible there.
  const finish = (line) => {
    const code = problems.length ? 1 : 0;
    (code ? err : out)(`${code ? 'fly-pull: ' : ''}${line}`);
    if (!opts.dryRun) {
      try {
        fs.mkdirSync(dest, { recursive: true });
        fs.appendFileSync(path.join(dest, 'pull.log'), `${new Date(now()).toISOString().slice(0, 19)}Z ${code ? 'PROBLEM' : 'ok'} ${opts.app} ${line}\n`);
      } catch (e) { err(`fly-pull: could not write pull.log: ${e.message}`); return 1; }
    }
    return code;
  };

  // 1. what the box has
  let box;
  try {
    box = boxCall(fly, opts.app, null, listDir, { dir: BOX_DIR, todayET: macToday }, 10 * 60000);
    if (!box || !Array.isArray(box.files)) throw new Error('the listing had no file list');
  } catch (e) {
    problems.push(e.message);
    return finish(`FAILED: could not list the box: ${e.message}; nothing was ${opts.dryRun ? 'changed' : 'copied or deleted'}`);
  }
  const machine = /^[0-9a-f]{8,32}$/.test(String(box.machine)) ? box.machine : null;
  const freeBefore = Number.isFinite(box.freeBytes) ? box.freeBytes : null;
  // Whose "today"? The box writes today's files, so its own clock counts as much as this Mac's:
  // go by the EARLIER of the two (the box already hashed by that rule), which leaves alone any
  // file either clock still calls today's. The later would be the unsafe choice -- a Mac running
  // fast past Eastern midnight would close the tape the box is still appending to.
  const boxToday = DAY.test(String(box.today)) ? box.today : null;
  if (boxToday && boxToday < todayET) todayET = boxToday;
  out(`fly-pull  ${opts.app}${machine ? ` (machine ${machine})` : ''} · today is ${todayET} ET · keep ${plural(opts.keep, 'day')} of tape on the box${opts.trim ? '' : ' · copy only'}${opts.dryRun ? ' · DRY RUN' : ''}`);
  if (freeBefore != null) out(`box ${BOX_DIR}: ${mb(freeBefore)} MB free of ${mb(box.totalBytes)} MB`);
  if (!boxToday) problem("the listing did not say the box's own date, so nothing will be deleted this run");
  else if (boxToday !== macToday) out(`  note: the box's clock says ${boxToday} ET and this Mac's says ${macToday}; going by the earlier, ${todayET}`);

  // 2. what the Mac already has -- hashing only names the box still has, so a year of archive is
  // not re-read every morning
  const boxNames = box.files.map((f) => f && f.name).filter((n) => typeof n === 'string');
  const readLocal = () => listDir({ dir: dest, todayET, only: boxNames, nowMs: new Date(now()).getTime() }).files;
  let local, plan;
  try {
    local = readLocal();
    plan = planPull(box.files, local, { todayET, keep: opts.keep, trim: opts.trim });
  } catch (e) {
    problems.push(e.message);
    return finish(`FAILED: ${e.message}; nothing was ${opts.dryRun ? 'changed' : 'copied or deleted'}`);
  }
  for (const x of plan.errors) problem(`${x.name}: ${x.why}`);
  for (const x of plan.conflicts) problem(`${x.name}: ${x.why}; left as it is, and not deleted from the box`);

  if (opts.dryRun) {
    out(`would copy ${plural(plan.copy.length, 'file')} / ${mb(plan.copy.reduce((a, f) => a + f.size, 0))} MB into ${shown}`);
    for (const f of plan.copy) out(`  ${f.name.padEnd(COL)} ${mb(f.size).padStart(7)} MB  ${f.reason === 'partial' ? 'the Mac copy is shorter: replaced only if it is the start of this one' : 'not on the Mac yet'}`);
    if (plan.have.length) out(`already on the Mac and identical: ${plural(plan.have.length, 'file')}`);
    if (plan.open.length) out(`still being written today, left alone: ${plan.open.join(', ')}`);
    if (opts.trim) {
      const del = [...plan.delete, ...plan.deleteAfterCopy].sort(byName);
      out(`would delete ${plural(del.length, 'tape or probe file')} / ${mb(del.reduce((a, f) => a + f.size, 0))} MB from the box${plan.deleteAfterCopy.length ? ', each only after its copy verifies' : ''}`);
      for (const f of del) out(`  ${f.name.padEnd(COL)} ${mb(f.size).padStart(7)} MB`);
      out(`kept on the box: tapes and probes from ${plan.cutoff} on${plan.keptOnBox.length ? ` (${plan.keptOnBox.join(', ')})` : ''}, today's files, and every journal and whales file`);
    }
    return finish(problems.length ? `dry run found ${plural(problems.length, 'problem')}; nothing was changed` : 'dry run: nothing was changed');
  }

  // 3. copy: download under a temp name, check the sha256, check the prefix if replacing, rename.
  // A copy that fails blocks only its own file's delete (2026-09-24). It used to stop every delete in
  // the run, so one dropped download of the newest tape kept older tapes the Mac already had on the
  // box: ticks-09-19 and 09-20 stayed there from 09-22 to a hand run on 09-23, box free fell to
  // 410.9 MB. Safe because a failed name is kept out of the re-plan below, and the delete loop
  // re-hashes every Mac copy against the box's sha256 before any rm anyway.
  let copied = 0, copiedBytes = 0, prepFailed = false;
  const notPrefix = new Set(), failedCopy = new Set();
  if (plan.copy.length) {
    try {
      // every folder a copy lands in (the archive, and archive/desk for the desk's journals), and in
      // each the temp files a killed run left behind; nothing else in them is shaped like this
      for (const dir of new Set(plan.copy.map((f) => path.dirname(path.join(dest, f.name))))) {
        fs.mkdirSync(dir, { recursive: true });
        for (const n of fs.readdirSync(dir)) {
          if (/^\.(ticks|journal|whales|probes)-\d{4}-\d{2}-\d{2}\.jsonl\.\d+\.part$/.test(n)) { try { fs.unlinkSync(path.join(dir, n)); } catch { /* next run */ } }
        }
      }
    } catch (e) { prepFailed = true; problem(`could not prepare ${shown}: ${e.message}`); }
  }
  for (const f of prepFailed ? [] : plan.copy) {
    const final = path.join(dest, f.name);
    // beside the file it becomes, so the rename below stays inside one folder
    const tmp = path.join(path.dirname(final), `.${path.basename(final)}.${process.pid}.part`);
    try {
      // each try starts from nothing: fly refuses to overwrite, and a half-written temp file is
      // just removed rather than resumed (a byte-offset resume over `fly ssh console` would trust
      // its stdout to be byte-clean, which nothing promises)
      for (let attempt = 1; ; attempt++) {
        try { fs.unlinkSync(tmp); } catch { /* not there: good */ }
        try {
          runFly(fly, ['ssh', 'sftp', 'get', '-q', ...pin(opts.app, machine), `${BOX_DIR}/${f.name}`, tmp], 30 * 60000);
          const got = sha256File(tmp);
          if (got !== f.sha256) throw new Error(`the download's sha256 does not match the box's (${got.slice(0, 12)}… vs ${f.sha256.slice(0, 12)}…)`);
          break;
        } catch (e) {
          if (attempt >= GET_TRIES) throw e;
          out(`  retry    ${f.name.padEnd(COL)} try ${attempt} of ${GET_TRIES} failed (${e.message}); trying again`);
          pause(retryPauseMs);
        }
      }
      if (f.reason === 'partial' && !isBytePrefix(final, tmp)) {
        fs.unlinkSync(tmp);
        notPrefix.add(f.name);
        problem(`${f.name}: the Mac copy differs and is not just an older, shorter copy of the box file; left as it is, and not deleted from the box`);
        continue;
      }
      fs.renameSync(tmp, final);
      copied++; copiedBytes += f.size;
      out(`  copied   ${f.name.padEnd(COL)} ${mb(f.size).padStart(7)} MB  sha256 matches the box`);
    } catch (e) {
      try { fs.unlinkSync(tmp); } catch { /* never got that far */ }
      failedCopy.add(f.name);
      problem(`${f.name}: copy failed after ${GET_TRIES} tries: ${e.message}; not deleted from the box`);
    }
  }

  // 4. trim. Only when the listing itself can be trusted (a known conflict or a failed copy blocks
  // just its own file), and re-planned against hashes read fresh off the Mac's disk -- not against
  // what the copy loop believes it wrote.
  let deleted = 0, deletedBytes = 0, freeAfter = freeBefore;
  if (opts.trim && (prepFailed || plan.errors.length || !boxToday)) {
    out('not deleting anything from the box this run: something before verification failed');
  } else if (opts.trim && plan.delete.length + plan.deleteAfterCopy.length && !machine) {
    // the app has one machine today; if that ever changes, an unpinned rm could land on a machine
    // whose files were never hashed
    problem('not deleting anything from the box: the listing did not say which machine it came from');
  } else if (opts.trim) {
    let plan2 = null;
    try {
      const fresh = readLocal().map((f) => (notPrefix.has(f.name) ? { ...f, notPrefix: true } : f));
      plan2 = planPull(box.files, fresh, { todayET, keep: opts.keep, trim: true });
    } catch (e) { problem(`could not re-read ${shown} before trimming, so nothing was deleted: ${e.message}`); }
    for (const f of plan2 ? plan2.delete.filter((x) => !failedCopy.has(x.name)) : []) {
      // belt and braces on the one irreversible step: the exact name shape, the window, the hash
      const tm = TRIMMED.exec(f.name);
      if (!tm || tm[2] >= plan2.cutoff) { problem(`${f.name}: refused to delete, not an old tape or probe file`); continue; }
      let localSha = null;
      try { localSha = sha256File(path.join(dest, f.name)); } catch { /* reported below */ }
      if (localSha !== f.sha256) { problem(`${f.name}: not deleted, the Mac copy does not match the box's sha256`); continue; }
      try {
        runFly(fly, ['ssh', 'console', '-q', ...pin(opts.app, machine), '-C', `rm -- ${BOX_DIR}/${f.name}`], 2 * 60000);
        deleted++; deletedBytes += f.size;
        out(`  deleted  ${f.name.padEnd(COL)} ${mb(f.size).padStart(7)} MB  from the box (the Mac copy is identical)`);
      } catch (e) { problem(`${f.name}: delete on the box failed: ${e.message}`); }
    }
    if (deleted) {
      try { freeAfter = boxCall(fly, opts.app, machine, boxFree, { dir: BOX_DIR }, 2 * 60000).freeBytes; }
      catch (e) { freeAfter = null; out(`  (could not re-read the box's free space: ${e.message})`); }
    }
  }
  const free = (b) => (Number.isFinite(b) ? `${mb(b)} MB` : '?');
  return finish(`copied ${plural(copied, 'file')} / ${mb(copiedBytes)} MB` +
    (opts.trim ? ` · deleted ${deleted} / ${mb(deletedBytes)} MB from the box` : ' · copy only, nothing deleted') +
    ` · box free ${free(freeBefore)} before, ${free(freeAfter)} after` +
    (problems.length ? ` · ${plural(problems.length, 'problem')}, see above` : ''));
}

module.exports = { planPull, listDir, isBytePrefix, sha256File, parseArgs, addDays, mainCheckout, linkedWorktreeOf, isFrozenSnapshot, run };

if (require.main === module) process.exitCode = run(process.argv.slice(2));

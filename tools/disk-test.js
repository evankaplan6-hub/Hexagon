'use strict';
// Assertions for keeping the Fly box's disk from filling -- no network, no wall clock.
//
// Two halves. tools/fly-pull.js is the normal route: the Mac copies closed days down and deletes a
// box tape only once its copy is proven identical. src/recorder.js's brake is the last resort:
// below TAPE_MIN_FREE_MB it deletes the oldest tapes itself, copied or not. What has to hold:
// nothing but an old tick tape is ever deleted, never today's, never without a verified copy
// (pull) or a real shortage (brake), and a dry run touches nothing on either side.
//
// The pull is driven end to end against a fake `fly` (a local script that plays the box out of a
// temp folder), because the delete path is exactly the part that must never be tried on the box.
//
//   node tools/disk-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const pull = require('./fly-pull');
const { planPull, listDir, isBytePrefix, parseArgs, addDays, mainCheckout, linkedWorktreeOf, isFrozenSnapshot, run } = pull;
const { planTapeTrim, makeDiskBrake, makeRecorder, ET_DAY } = require('../src/recorder');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const MB = 1024 * 1024;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const H = (c) => c.repeat(64);   // a well-formed, fake sha256
const names = (xs) => xs.map((x) => (typeof x === 'string' ? x : x.name));
const TODAY = '2026-09-14';
// 12:00 in New York on the 14th, when the Eastern and UTC dates agree
const NOW = Date.UTC(2026, 8, 14, 16, 0, 0);
// 22:00 in New York on the 14th: UTC is already the 15th, and "today" must still be the 14th
const EVENING = Date.UTC(2026, 8, 15, 2, 0, 0);

// ================================================================ planPull
group('planPull: closed days are copied, today is left alone');
{
  const box = [
    { name: 'ticks-2026-09-13.jsonl', size: 100, sha256: H('a') },
    { name: 'journal-2026-09-13.jsonl', size: 10, sha256: H('b') },
    { name: 'ticks-2026-09-14.jsonl', size: 50, sha256: null },
    { name: 'journal-2026-09-14.jsonl', size: 5, sha256: null },
    { name: 'ticks-2026-09-15.jsonl', size: 1, sha256: H('f') },   // a clock is wrong somewhere
    { name: 'state.json', size: 900, sha256: H('c') },
    { name: 'fillcheck.jsonl', size: 9, sha256: H('d') },
  ];
  const p = planPull(box, [], { todayET: TODAY, keep: 3, trim: true });
  ok('both closed files are copied', JSON.stringify(names(p.copy)) === JSON.stringify(['journal-2026-09-13.jsonl', 'ticks-2026-09-13.jsonl']), names(p.copy));
  ok('...because they are missing on the Mac', p.copy.every((f) => f.reason === 'missing'));
  ok("today's files are open, not copied", p.open.includes('ticks-2026-09-14.jsonl') && p.open.includes('journal-2026-09-14.jsonl'), p.open);
  ok('a future-dated file is open too, never copied or deleted', p.open.includes('ticks-2026-09-15.jsonl') && !names([...p.delete, ...p.deleteAfterCopy]).includes('ticks-2026-09-15.jsonl'));
  ok('state.json and fillcheck.jsonl are not ours to move', ![...names(p.copy), ...p.open].some((n) => n === 'state.json' || n === 'fillcheck.jsonl'));
  ok('a missing hash on an OPEN file is not an error', p.errors.length === 0, p.errors);
}

group('planPull: the keep window (today counts as one day)');
{
  const days = ['2026-09-09', '2026-09-10', '2026-09-11', '2026-09-12', '2026-09-13'];
  const box = [...days.map((d, i) => ({ name: `ticks-${d}.jsonl`, size: 1000 + i, sha256: H(String(i)) })), { name: `ticks-${TODAY}.jsonl`, size: 7, sha256: null }];
  const local = box.filter((f) => f.sha256).map((f) => ({ ...f }));   // everything already archived, identical
  const p3 = planPull(box, local, { todayET: TODAY, keep: 3, trim: true });
  ok('keep 3 on the 14th keeps the 12th, 13th and 14th', p3.cutoff === '2026-09-12', p3.cutoff);
  ok('...and deletes the 9th, 10th and 11th', JSON.stringify(names(p3.delete)) === JSON.stringify(['ticks-2026-09-09.jsonl', 'ticks-2026-09-10.jsonl', 'ticks-2026-09-11.jsonl']), names(p3.delete));
  ok('the 12th and 13th are kept on the box', JSON.stringify(p3.keptOnBox) === JSON.stringify(['ticks-2026-09-12.jsonl', 'ticks-2026-09-13.jsonl']), p3.keptOnBox);
  ok('nothing to copy: all identical', p3.copy.length === 0 && p3.have.length === 5, { copy: p3.copy.length, have: p3.have.length });
  const p1 = planPull(box, local, { todayET: TODAY, keep: 1, trim: true });
  ok('keep 1 deletes yesterday too', names(p1.delete).includes('ticks-2026-09-13.jsonl') && p1.delete.length === 5, names(p1.delete));
  ok("...but never today's tape", !names(p1.delete).includes(`ticks-${TODAY}.jsonl`) && p1.open.includes(`ticks-${TODAY}.jsonl`));
  const p9 = planPull(box, local, { todayET: TODAY, keep: 9, trim: true });
  ok('a keep window wider than the box deletes nothing', p9.delete.length === 0 && p9.keptOnBox.length === 5, p9.delete);
  const noTrim = planPull(box, local, { todayET: TODAY, keep: 3, trim: false });
  ok('without --trim nothing is ever marked for deletion', noTrim.delete.length === 0 && noTrim.deleteAfterCopy.length === 0);
  ok('the window crosses a month boundary', addDays('2026-10-01', -2) === '2026-09-29' && addDays('2026-03-09', -1) === '2026-03-08', addDays('2026-10-01', -2));
  let threw = 0;
  for (const keep of [0, -1, 1.5, NaN]) { try { planPull(box, local, { todayET: TODAY, keep }); } catch { threw++; } }
  ok('keep below one day, or fractional, is refused', threw === 4, threw);
  let threwDay = false;
  try { planPull(box, local, { todayET: '9/14/2026', keep: 3 }); } catch { threwDay = true; }
  ok('a malformed today is refused', threwDay);
}

group('planPull: a hash mismatch never deletes');
{
  const box = [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: H('a') }];
  const same = planPull(box, [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: H('b') }], { todayET: TODAY, keep: 3, trim: true });
  ok('same size, different hash: a conflict', same.conflicts.length === 1 && same.copy.length === 0, same.conflicts);
  ok('...not deleted, not even after a copy', same.delete.length === 0 && same.deleteAfterCopy.length === 0);
  const bigger = planPull(box, [{ name: 'ticks-2026-09-10.jsonl', size: 2000, sha256: H('b') }], { todayET: TODAY, keep: 3, trim: true });
  ok('a Mac copy LARGER than the box is a conflict, never overwritten', bigger.conflicts.length === 1 && bigger.copy.length === 0 && bigger.delete.length === 0);
  const shorter = planPull(box, [{ name: 'ticks-2026-09-10.jsonl', size: 400, sha256: H('b') }], { todayET: TODAY, keep: 3, trim: true });
  ok('a shorter Mac copy is re-copied as a possible partial', shorter.copy.length === 1 && shorter.copy[0].reason === 'partial', shorter.copy);
  ok('...and deleted only after that copy verifies, never now', shorter.delete.length === 0 && names(shorter.deleteAfterCopy)[0] === 'ticks-2026-09-10.jsonl');
  const noHash = planPull([{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: null }], [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: null }], { todayET: TODAY, keep: 3, trim: true });
  ok('a closed box file with no hash is an error: not copied, not deleted', noHash.errors.length === 1 && noHash.copy.length === 0 && noHash.delete.length === 0 && noHash.have.length === 0, noHash);
  const badHash = planPull([{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: 'abc' }], [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: 'abc' }], { todayET: TODAY, keep: 3, trim: true });
  ok('a malformed hash that happens to match is still no licence to delete', badHash.errors.length === 1 && badHash.delete.length === 0, badHash);
}

group('planPull: a Mac copy that is not a prefix is never overwritten or deleted');
{
  const box = [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: H('a') }, { name: 'ticks-2026-09-11.jsonl', size: 1000, sha256: H('c') }];
  const local = [{ name: 'ticks-2026-09-10.jsonl', size: 400, sha256: H('b'), notPrefix: true }, { name: 'ticks-2026-09-11.jsonl', size: 1000, sha256: H('c') }];
  const p = planPull(box, local, { todayET: TODAY, keep: 3, trim: true });
  ok('the stranger is a conflict', names(p.conflicts).includes('ticks-2026-09-10.jsonl'), p.conflicts);
  ok('...not copied over', !names(p.copy).includes('ticks-2026-09-10.jsonl'), names(p.copy));
  ok('...and not deleted from the box', !names([...p.delete, ...p.deleteAfterCopy]).includes('ticks-2026-09-10.jsonl'));
  ok('its good neighbour is still deleted', JSON.stringify(names(p.delete)) === JSON.stringify(['ticks-2026-09-11.jsonl']), names(p.delete));
  const lie = planPull(box, [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: H('a'), notPrefix: true }], { todayET: TODAY, keep: 3, trim: true });
  ok('a file flagged not-a-prefix never counts as archived, whatever its hash says', lie.have.length === 0 && lie.delete.length === 0, lie);
}

group('planPull: journals, whales and probes are copied but never deleted');
{
  const kinds = ['journal', 'whales', 'probes'];
  const box = kinds.map((k, i) => ({ name: `${k}-2026-09-01.jsonl`, size: 10, sha256: H(String(i)) }));
  const archived = planPull(box, box.map((f) => ({ ...f })), { todayET: TODAY, keep: 1, trim: true });
  ok('archived and weeks old, still not deleted', archived.delete.length === 0 && archived.deleteAfterCopy.length === 0 && archived.have.length === 3, archived);
  const fresh = planPull(box, [], { todayET: TODAY, keep: 1, trim: true });
  ok('...and copied when missing', fresh.copy.length === 3 && fresh.deleteAfterCopy.length === 0);
  const odd = ['ticks-2026-09-01.jsonl.bak', 'ticks-2026-9-1.jsonl', 'xticks-2026-09-01.jsonl', '../ticks-2026-09-01.jsonl', 'ticks-2026-09-01.jsonl/'];
  const oddPlan = planPull(odd.map((name) => ({ name, size: 1, sha256: H('e') })), odd.map((name) => ({ name, size: 1, sha256: H('e') })), { todayET: TODAY, keep: 1, trim: true });
  ok('names that are not exactly ticks-YYYY-MM-DD.jsonl are ignored outright', oddPlan.copy.length + oddPlan.have.length + oddPlan.delete.length + oddPlan.open.length === 0, oddPlan);
}

group('planPull: a dry run is just the plan -- pure, repeatable, inputs untouched');
{
  const box = [{ name: 'ticks-2026-09-10.jsonl', size: 1000, sha256: H('a') }, { name: 'journal-2026-09-10.jsonl', size: 10, sha256: H('b') }];
  const local = [{ name: 'journal-2026-09-10.jsonl', size: 10, sha256: H('b') }];
  const before = JSON.stringify([box, local]);
  const a = planPull(box, local, { todayET: TODAY, keep: 3, trim: true });
  const b = planPull(box, local, { todayET: TODAY, keep: 3, trim: true });
  ok('the same inputs give the same plan', JSON.stringify(a) === JSON.stringify(b));
  ok('the inputs are not mutated', JSON.stringify([box, local]) === before);
  ok('what a dry run would delete is the copy-then-delete list', names(a.deleteAfterCopy)[0] === 'ticks-2026-09-10.jsonl' && a.delete.length === 0);
}

// ================================================================ listing and prefix, on real files
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-disk-test-'));
process.on('exit', () => { try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* best effort */ } });

group('listDir: sizes and hashes of closed days, today listed but not hashed');
{
  const dir = path.join(tmpRoot, 'list');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, 'ticks-2026-09-13.jsonl'), 'yesterday\n');
  fs.writeFileSync(path.join(dir, 'ticks-2026-09-14.jsonl'), 'today\n');
  fs.writeFileSync(path.join(dir, 'state.json'), '{}');
  fs.writeFileSync(path.join(dir, 'journal-2026-09-12.jsonl'), '');
  fs.mkdirSync(path.join(dir, 'whales-2026-09-12.jsonl'));   // a directory with a dated name
  const r = listDir({ dir, todayET: TODAY, nowMs: NOW });
  const by = Object.fromEntries(r.files.map((f) => [f.name, f]));
  ok('a closed tape carries its real sha256 and size', by['ticks-2026-09-13.jsonl'].sha256 === sha('yesterday\n') && by['ticks-2026-09-13.jsonl'].size === 10, by['ticks-2026-09-13.jsonl']);
  ok("today's tape is listed with no hash", by['ticks-2026-09-14.jsonl'] && by['ticks-2026-09-14.jsonl'].sha256 === null);
  ok('an empty closed file hashes as empty', by['journal-2026-09-12.jsonl'].sha256 === sha(''));
  ok('state.json and directories are skipped', !by['state.json'] && !by['whales-2026-09-12.jsonl'], Object.keys(by));
  ok('free space is reported', Number.isFinite(r.freeBytes) && r.freeBytes > 0, r.freeBytes);
  ok('`only` limits what gets read', listDir({ dir, todayET: TODAY, nowMs: NOW, only: ['journal-2026-09-12.jsonl'] }).files.length === 1);
  ok('a folder that does not exist yet lists as empty', listDir({ dir: path.join(tmpRoot, 'nope'), todayET: TODAY, nowMs: NOW }).files.length === 0);
  // the function is shipped to the box as source text: it must survive that on its own
  const shipped = eval(`(${listDir.toString()})`);
  ok('listDir runs from its own source text, with no closure', shipped({ dir, todayET: TODAY, nowMs: NOW }).files.length === r.files.length);
  ok("it reports its own Eastern date", r.today === TODAY && listDir({ dir, todayET: TODAY, nowMs: EVENING }).today === TODAY, r.today);
  // a caller whose clock is past Eastern midnight while this side's is not: this side's today wins
  const ahead = Object.fromEntries(listDir({ dir, todayET: '2026-09-15', nowMs: Date.UTC(2026, 8, 15, 3, 57) }).files.map((f) => [f.name, f]));
  ok("a caller's clock running ahead does not get today's tape hashed as a closed day", ahead['ticks-2026-09-14.jsonl'].sha256 === null && ahead['ticks-2026-09-13.jsonl'].sha256 === sha('yesterday\n'), ahead);
  const behind = Object.fromEntries(listDir({ dir, todayET: '2026-09-13', nowMs: NOW }).files.map((f) => [f.name, f]));
  ok("...and a caller's clock running behind is heeded too: the earlier today wins", behind['ticks-2026-09-13.jsonl'].sha256 === null, behind);
}

group('isBytePrefix');
{
  const f = (n, s) => { const p = path.join(tmpRoot, n); fs.writeFileSync(p, s); return p; };
  const full = f('full', 'a'.repeat(3 * MB) + 'tail');
  ok('an older, shorter copy is a prefix', isBytePrefix(f('part', 'a'.repeat(2 * MB)), full));
  ok('the file itself is a prefix of itself', isBytePrefix(full, full));
  ok('one differing byte past the first chunk is not', !isBytePrefix(f('bad', 'a'.repeat(MB + 5) + 'b'), full));
  ok('longer is never a prefix', !isBytePrefix(f('long', 'a'.repeat(3 * MB) + 'tail!'), full));
  ok('an empty file is a prefix of anything', isBytePrefix(f('empty', ''), full));
}

group('parseArgs');
{
  const d = parseArgs([]);
  ok('defaults: hexagon-desk, keep 3, copy only, for real', d.app === 'hexagon-desk' && d.keep === 3 && !d.trim && !d.dryRun && d.dest === null, d);
  const o = parseArgs(['--trim', '--dry-run', '--keep', '5', '--app=other-app', '--dest', 'x/y']);
  ok('flags in both spellings', o.trim && o.dryRun && o.keep === 5 && o.app === 'other-app' && o.dest === 'x/y', o);
  let bad = 0;
  for (const argv of [['--keep', '0'], ['--keep', '2.5'], ['--keep', 'three'], ['--frobnicate'], ['--app', 'Bad App;rm'], ['--keep']]) { try { parseArgs(argv); } catch { bad++; } }
  ok('bad keep, unknown flags, odd app names and missing values are refused', bad === 6, bad);
  let valued = 0;
  for (const a of ['--trim=false', '--trim=0', '--trim=', '--dry-run=false', '--help=1']) { try { parseArgs([a]); } catch (e) { if (/takes no value/.test(e.message)) valued++; } }
  ok('an on/off flag given a value is refused: --trim=false must never mean trim', valued === 5, valued);
}

// ================================================================ the whole run, against a fake fly
// The fake plays `fly ssh console` and `fly ssh sftp get` out of a local folder standing in for
// /data, logs every call, and refuses anything it does not recognise -- so an unexpected command
// shape fails the test instead of slipping through.
const FAKE = `'use strict';
// exits by returning, never process.exit: on macOS a pipe write is async and exit would cut it off
const fs = require('fs'), path = require('path');
const box = process.env.FAKE_BOX, calls = process.env.FAKE_CALLS;
const note = (o) => fs.appendFileSync(calls, JSON.stringify(o) + '\\n');
const a = process.argv.slice(2);
const flag = (f) => { const i = a.indexOf(f); return i < 0 ? null : a[i + 1]; };
const app = flag('-a'), machine = flag('--machine');
const refuse = (code, msg) => { console.error(msg); return code; };
function main() {
  if (a[0] === 'ssh' && a[1] === 'console') {
    const cmd = flag('-C') || '';
    const m = /^nice -n 19 node -e "eval\\(Buffer\\.from\\('([A-Za-z0-9+/=]+)','base64'\\)\\.toString\\(\\)\\)"$/.exec(cmd);
    if (m) {
      let src = Buffer.from(m[1], 'base64').toString();
      if (!src.includes('{"dir":"/data"')) return refuse(4, 'fake fly: not aimed at /data');
      if (process.env.FAKE_NO_TODAY) src = src.replace('today: own,', '');
      note({ op: /freeBytes: s\\.bavail/.test(src) && !/readdirSync/.test(src) ? 'free' : 'list', app, machine });
      if (process.env.FAKE_FAIL_LIST) return refuse(1, 'Error: ssh: tunnel unavailable');
      if (process.env.FAKE_NO_MACHINE) delete process.env.FLY_MACHINE_ID; else process.env.FLY_MACHINE_ID = 'abcdef1234';
      // the box's own clock is FAKE_BOX_NOW, never this process's wall clock
      eval(src.replace('{"dir":"/data"', '{"nowMs":' + Number(process.env.FAKE_BOX_NOW) + ',"dir":' + JSON.stringify(box)));
      return 0;
    }
    const rm = /^rm -- \\/data\\/([^\\s/]+)$/.exec(cmd);
    if (rm) { note({ op: 'rm', name: rm[1], app, machine, cmd }); fs.unlinkSync(path.join(box, rm[1])); return 0; }
    return refuse(3, 'fake fly: refused console command ' + cmd);
  }
  if (a[0] === 'ssh' && a[1] === 'sftp' && a[2] === 'get') {
    const [remote, local] = a.filter((x, i) => i > 2 && !x.startsWith('-') && x !== app && x !== machine);
    const name = remote.replace(/^\\/data\\//, '');
    note({ op: 'get', name, app, machine });
    if (fs.existsSync(local)) return refuse(1, 'Error: file ' + local + ' is already there.');
    if (process.env.FAKE_FAIL_GET === name) return refuse(1, 'Error: get: connection reset');
    const bytes = fs.readFileSync(path.join(box, name));
    fs.writeFileSync(local, process.env.FAKE_CORRUPT_GET === name ? Buffer.concat([bytes, Buffer.from('x')]) : bytes);
    return 0;
  }
  return refuse(3, 'fake fly: refused ' + a.join(' '));
}
process.exitCode = main();
`;
const fakeFly = path.join(tmpRoot, 'fake-fly.js');
fs.writeFileSync(fakeFly, FAKE);

function scene(label) {
  const root = path.join(tmpRoot, label);
  const box = path.join(root, 'box'), dest = path.join(root, 'mac', 'archive');
  fs.mkdirSync(box, { recursive: true });
  const put = (name, body) => fs.writeFileSync(path.join(box, name), body);
  for (const d of ['10', '11', '12', '13']) put(`ticks-2026-09-${d}.jsonl`, `tape of the ${d}th\n`.repeat(50));
  put(`ticks-${TODAY}.jsonl`, 'still being written\n');
  for (const d of ['10', '13']) put(`journal-2026-09-${d}.jsonl`, `journal ${d}\n`);
  put(`journal-${TODAY}.jsonl`, 'journal today\n');
  put('whales-2026-09-13.jsonl', 'whale\n');
  put('state.json', '{"cash":1}');
  const calls = path.join(root, 'calls.jsonl');
  const lines = [];
  // `macNow` is this Mac's clock; the fake box's clock is the same unless env.FAKE_BOX_NOW says otherwise
  const go = (argv, env = {}, macNow = NOW, extra = {}) => {
    const keys = ['FAKE_BOX', 'FAKE_CALLS', 'FAKE_FAIL_LIST', 'FAKE_FAIL_GET', 'FAKE_CORRUPT_GET', 'FAKE_NO_MACHINE', 'FAKE_BOX_NOW', 'FAKE_NO_TODAY'];
    const saved = Object.fromEntries(keys.map((k) => [k, process.env[k]]));
    Object.assign(process.env, { FAKE_BOX: box, FAKE_CALLS: calls, FAKE_BOX_NOW: String(macNow) }, env);
    const args = extra.noDest ? argv : [...argv, '--dest', dest];
    try { fs.rmSync(calls, { force: true }); lines.length = 0; return run(args, { now: () => new Date(macNow), fly: [process.execPath, fakeFly], cwd: root, root, out: (s) => lines.push(s), err: (s) => lines.push(s), ...extra.opts }); }
    finally { for (const k of keys) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; } }
  };
  const log = () => (fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const onBox = () => fs.readdirSync(box).sort();
  const onMac = () => (fs.existsSync(dest) ? fs.readdirSync(dest).sort() : null);
  return { root, box, dest, put, go, log, onBox, onMac, lines };
}

group('run --trim --dry-run: prints the plan, changes nothing on either side');
{
  const s = scene('dry');
  const boxBefore = s.onBox();
  const code = s.go(['--trim', '--dry-run']);
  const text = s.lines.join('\n');
  ok('exits 0', code === 0, { code, text });
  ok('the only call to the box is the listing', JSON.stringify(s.log().map((c) => c.op)) === '["list"]', s.log());
  ok('the box is untouched', JSON.stringify(s.onBox()) === JSON.stringify(boxBefore), s.onBox());
  ok('the Mac is untouched: no archive folder, no pull.log', s.onMac() === null, s.onMac());
  ok('it says what it would copy', /would copy 7 files/.test(text), text);
  ok('it says what it would delete: the 10th and 11th', /would delete 2 tick tapes/.test(text) && /ticks-2026-09-10\.jsonl/.test(text) && /ticks-2026-09-11\.jsonl/.test(text), text);
  ok("it names what stays: from the 12th on, today's tape and the journals", /kept on the box: tapes from 2026-09-12 on/.test(text), text);
}

group('run --trim: copies closed days, verifies, deletes only old tapes');
{
  const s = scene('real');
  const code = s.go(['--trim']);
  const text = s.lines.join('\n');
  const calls = s.log();
  ok('exits 0', code === 0, { code, text });
  const mac = s.onMac();
  ok('every closed day is on the Mac', ['ticks-2026-09-10.jsonl', 'ticks-2026-09-11.jsonl', 'ticks-2026-09-12.jsonl', 'ticks-2026-09-13.jsonl', 'journal-2026-09-10.jsonl', 'journal-2026-09-13.jsonl', 'whales-2026-09-13.jsonl'].every((n) => mac.includes(n)), mac);
  ok("today's files and state.json are not copied", !mac.includes(`ticks-${TODAY}.jsonl`) && !mac.includes(`journal-${TODAY}.jsonl`) && !mac.includes('state.json'), mac);
  ok('no temp file is left behind', !mac.some((n) => n.endsWith('.part')), mac);
  ok('the copies are byte-identical', fs.readFileSync(path.join(s.dest, 'ticks-2026-09-12.jsonl'), 'utf8') === 'tape of the 12th\n'.repeat(50));
  const rms = calls.filter((c) => c.op === 'rm');
  ok('exactly the 10th and 11th are deleted from the box', JSON.stringify(rms.map((c) => c.name)) === '["ticks-2026-09-10.jsonl","ticks-2026-09-11.jsonl"]', rms);
  ok('each delete is a single rm -- /data/<exact name>', rms.every((c) => c.cmd === `rm -- /data/${c.name}`), rms);
  ok('every download and delete is pinned to the machine that was listed', calls.filter((c) => c.op !== 'list').every((c) => c.machine === 'abcdef1234' && c.app === 'hexagon-desk'), calls);
  ok('no delete happens before every copy has landed', calls.findIndex((c) => c.op === 'rm') > calls.map((c) => c.op).lastIndexOf('get'), calls.map((c) => c.op));
  const box = s.onBox();
  ok("the box keeps the 12th, 13th, today's tape, every journal, whales and state.json", JSON.stringify(box) === JSON.stringify(['journal-2026-09-10.jsonl', 'journal-2026-09-13.jsonl', `journal-${TODAY}.jsonl`, 'state.json', 'ticks-2026-09-12.jsonl', 'ticks-2026-09-13.jsonl', `ticks-${TODAY}.jsonl`, 'whales-2026-09-13.jsonl']), box);
  ok('free space is re-read after deleting', calls.some((c) => c.op === 'free'));
  const plog = fs.readFileSync(path.join(s.dest, 'pull.log'), 'utf8').trim().split('\n');
  ok('pull.log gets one line', plog.length === 1 && /^2026-09-14T16:00:00Z ok hexagon-desk copied 7 files/.test(plog[0]) && /deleted 2 \//.test(plog[0]), plog);

  const again = s.go(['--trim']);
  ok('a second run the same day has nothing to do', again === 0 && s.log().every((c) => c.op === 'list'), s.log());
  ok('...and adds its own line to pull.log', fs.readFileSync(path.join(s.dest, 'pull.log'), 'utf8').trim().split('\n').length === 2);
}

group('run --trim: a download whose hash does not match stops every delete');
{
  const s = scene('corrupt');
  const code = s.go(['--trim'], { FAKE_CORRUPT_GET: 'ticks-2026-09-12.jsonl' });
  const text = s.lines.join('\n');
  ok('exits non-zero', code === 1, { code, text });
  ok('no rm reaches the box, not even for tapes that copied fine', !s.log().some((c) => c.op === 'rm'), s.log());
  ok('the bad download is not kept', !s.onMac().includes('ticks-2026-09-12.jsonl') && !s.onMac().some((n) => n.endsWith('.part')), s.onMac());
  ok('the box still has every tape', ['10', '11', '12', '13'].every((d) => s.onBox().includes(`ticks-2026-09-${d}.jsonl`)));
  ok('it says so, and pull.log records a PROBLEM', /sha256 does not match/.test(text) && /PROBLEM/.test(fs.readFileSync(path.join(s.dest, 'pull.log'), 'utf8')), text);
}

group('run --trim: a failed download stops every delete');
{
  const s = scene('getfail');
  const code = s.go(['--trim'], { FAKE_FAIL_GET: 'journal-2026-09-10.jsonl' });
  ok('exits non-zero', code === 1);
  ok('no rm reaches the box', !s.log().some((c) => c.op === 'rm'), s.log());
  ok('the box still has every tape', ['10', '11', '12', '13'].every((d) => s.onBox().includes(`ticks-2026-09-${d}.jsonl`)));
}

group('run --trim: a listing that does not name its machine copies, but never deletes');
{
  const s = scene('nomachine');
  const code = s.go(['--trim'], { FAKE_NO_MACHINE: '1' });
  ok('exits non-zero', code === 1, s.lines);
  ok('the closed days still reach the Mac', s.onMac().includes('ticks-2026-09-10.jsonl') && s.onMac().includes('journal-2026-09-13.jsonl'), s.onMac());
  ok('no rm reaches the box', !s.log().some((c) => c.op === 'rm'), s.log());
  ok('it says why', /did not say which machine/.test(s.lines.join('\n')), s.lines);
}

group('run --trim: the box cannot be listed');
{
  const s = scene('nolist');
  const code = s.go(['--trim'], { FAKE_FAIL_LIST: '1' });
  ok('exits non-zero', code === 1);
  ok('nothing is downloaded or deleted', s.log().every((c) => c.op === 'list'), s.log());
  ok('pull.log records the failure', /PROBLEM .*could not list the box/.test(fs.readFileSync(path.join(s.dest, 'pull.log'), 'utf8')));
  const dry = scene('nolist-dry');
  ok('a dry run that cannot list exits non-zero and still writes nothing', dry.go(['--trim', '--dry-run'], { FAKE_FAIL_LIST: '1' }) === 1 && dry.onMac() === null);
}

group('run --trim: Mac copies that differ from the box');
{
  const s = scene('mixed');
  fs.mkdirSync(s.dest, { recursive: true });
  // the 10th: a stranger with the same name, shorter than the box file
  fs.writeFileSync(path.join(s.dest, 'ticks-2026-09-10.jsonl'), 'something else entirely\n');
  // the 11th: an honest older copy, taken before the day ended
  fs.writeFileSync(path.join(s.dest, 'ticks-2026-09-11.jsonl'), 'tape of the 11th\n'.repeat(20));
  const code = s.go(['--trim']);
  const text = s.lines.join('\n');
  ok('exits non-zero: someone should look at the 10th', code === 1, { code, text });
  ok('the stranger on the Mac is left exactly as it was', fs.readFileSync(path.join(s.dest, 'ticks-2026-09-10.jsonl'), 'utf8') === 'something else entirely\n');
  ok('...and the box keeps its 10th', s.onBox().includes('ticks-2026-09-10.jsonl'), s.onBox());
  ok('the older partial copy is replaced with the finished file', fs.readFileSync(path.join(s.dest, 'ticks-2026-09-11.jsonl'), 'utf8') === 'tape of the 11th\n'.repeat(50));
  ok('...and only then deleted from the box', JSON.stringify(s.log().filter((c) => c.op === 'rm').map((c) => c.name)) === '["ticks-2026-09-11.jsonl"]', s.log());
  ok('it explains the conflict', /ticks-2026-09-10\.jsonl: the Mac copy differs and is not just an older, shorter copy/.test(text), text);
}

group('run: guards');
{
  const s = scene('guards');
  const lines = [];
  const code = run(['--dest', path.join(s.root, 'data', 'fly')], { now: () => new Date(NOW), fly: [process.execPath, fakeFly], cwd: s.root, root: s.root, out: (x) => lines.push(x), err: (x) => lines.push(x) });
  ok('--dest data/fly is refused: the frozen snapshot is never written to', code === 2 && /frozen snapshot/.test(lines.join('\n')), lines);
  ok('...before the box is even listed', !fs.existsSync(path.join(s.root, 'calls.jsonl')));
  const code2 = run(['--keep', '0'], { now: () => new Date(NOW), fly: [process.execPath, fakeFly], cwd: s.root, root: s.root, out: () => {}, err: () => {} });
  ok('--keep 0 is a usage error', code2 === 2, code2);
  const copyOnly = s.go([]);
  ok('without --trim a real run copies and never deletes', copyOnly === 0 && !s.log().some((c) => c.op === 'rm') && s.onBox().length === 10, { copyOnly, box: s.onBox() });
}


group("run: today is the Eastern date, and the earlier of the Mac's and the box's");
{
  // 22:00 ET on the 14th: the UTC date is already the 15th, but the tape being written is the 14th's
  ok("at 22:00 ET the recorder's formatter still says the 14th", ET_DAY.format(new Date(EVENING)) === TODAY && new Date(EVENING).toISOString().slice(0, 10) === '2026-09-15');
  const s = scene('evening');
  const code = s.go(['--trim', '--keep', '1'], {}, EVENING);
  const text = s.lines.join('\n');
  ok('exits 0', code === 0, { code, text });
  ok("the evening's own tape and journal are not copied: that day is not over", !s.onMac().includes(`ticks-${TODAY}.jsonl`) && !s.onMac().includes(`journal-${TODAY}.jsonl`), s.onMac());
  ok('...and the tape is not deleted from the box', s.onBox().includes(`ticks-${TODAY}.jsonl`), s.onBox());
  ok('with --keep 1 every closed tape before it goes', JSON.stringify(s.log().filter((c) => c.op === 'rm').map((c) => c.name)) === JSON.stringify(['10', '11', '12', '13'].map((d) => `ticks-2026-09-${d}.jsonl`)), s.log());

  // this Mac's clock a few minutes fast across Eastern midnight: it says the 15th, while the box,
  // still appending to the 14th's tape, says the 14th
  const k = scene('skew');
  const MAC = Date.UTC(2026, 8, 15, 4, 3), BOX = Date.UTC(2026, 8, 15, 3, 57);
  ok('the two clocks straddle Eastern midnight', ET_DAY.format(new Date(MAC)) === '2026-09-15' && ET_DAY.format(new Date(BOX)) === TODAY);
  const kc = k.go(['--trim', '--keep', '1'], { FAKE_BOX_NOW: String(BOX) }, MAC);
  const kt = k.lines.join('\n');
  ok('exits 0, and says the clocks disagree', kc === 0 && /the box's clock says 2026-09-14 ET and this Mac's says 2026-09-15/.test(kt), { kc, kt });
  ok("the tape the box is still writing is not copied as a closed day", !k.onMac().includes(`ticks-${TODAY}.jsonl`), k.onMac());
  ok('...and not deleted, even with --keep 1', k.onBox().includes(`ticks-${TODAY}.jsonl`) && !k.log().some((c) => c.op === 'rm' && c.name === `ticks-${TODAY}.jsonl`), k.log());
  ok('the closed days before it are still pulled and trimmed', k.onMac().includes('ticks-2026-09-13.jsonl') && !k.onBox().includes('ticks-2026-09-13.jsonl'), { mac: k.onMac(), box: k.onBox() });

  const n = scene('notoday');
  const nc = n.go(['--trim'], { FAKE_NO_TODAY: '1' });
  ok("a listing that does not give the box's own date copies, but deletes nothing", nc === 1 && n.onMac().includes('ticks-2026-09-10.jsonl') && !n.log().some((c) => c.op === 'rm'), { nc, lines: n.lines, log: n.log() });
}

group('run: the archive belongs to the main checkout, never a git worktree');
{
  // a made-up repo: main/.git is a folder; main/.claude/worktrees/wt1 and elsewhere/wt2 are linked
  // worktrees, whose .git is a file pointing into main/.git/worktrees/<name>
  const main = path.join(tmpRoot, 'repo', 'main');
  const wt1 = path.join(main, '.claude', 'worktrees', 'wt1');
  const wt2 = path.join(tmpRoot, 'repo', 'elsewhere', 'wt2');
  for (const [wt, name] of [[wt1, 'wt1'], [wt2, 'wt2']]) {
    const gd = path.join(main, '.git', 'worktrees', name);
    fs.mkdirSync(gd, { recursive: true });
    fs.writeFileSync(path.join(gd, 'commondir'), '../..\n');
    fs.mkdirSync(wt, { recursive: true });
    fs.writeFileSync(path.join(wt, '.git'), `gitdir: ${gd}\n`);
  }
  const plain = path.join(tmpRoot, 'repo', 'plain');
  fs.mkdirSync(plain, { recursive: true });
  ok('mainCheckout: a worktree resolves to its main checkout', mainCheckout(wt1) === main && mainCheckout(wt2) === main, [mainCheckout(wt1), mainCheckout(wt2)]);
  ok('mainCheckout: the main checkout, and a folder with no .git, are their own', mainCheckout(main) === main && mainCheckout(plain) === plain);
  const broken = path.join(tmpRoot, 'repo', 'broken');
  fs.mkdirSync(broken, { recursive: true });
  fs.writeFileSync(path.join(broken, '.git'), 'gitdir: /nowhere/at/all\n');
  let threw = false;
  try { mainCheckout(broken); } catch { threw = true; }
  ok('mainCheckout: a worktree whose main checkout cannot be found is an error, not a guess', threw);
  ok('linkedWorktreeOf: the main checkout is not a worktree', linkedWorktreeOf(path.join(main, 'data', 'fly', 'archive')) === null);
  ok('linkedWorktreeOf: inside .claude/worktrees, even before data/ exists', linkedWorktreeOf(path.join(wt1, 'data', 'fly', 'archive')) === fs.realpathSync.native(wt1), linkedWorktreeOf(path.join(wt1, 'data', 'fly', 'archive')));
  ok('linkedWorktreeOf: any worktree, by its .git file', linkedWorktreeOf(path.join(wt2, 'data', 'fly', 'archive')) === fs.realpathSync.native(wt2), linkedWorktreeOf(path.join(wt2, 'data')));
  fs.mkdirSync(path.join(wt2, 'data'), { recursive: true });
  const link = path.join(tmpRoot, 'repo', 'link-into-wt2');
  fs.symlinkSync(path.join(wt2, 'data'), link);
  ok('linkedWorktreeOf: through a symlink too', linkedWorktreeOf(path.join(link, 'fly', 'archive')) === fs.realpathSync.native(wt2));
  ok('linkedWorktreeOf: an ordinary folder is not one', linkedWorktreeOf(plain) === null);

  const s = scene('fromworktree');
  const code = s.go(['--trim'], {}, NOW, { noDest: true, opts: { root: wt1, cwd: wt1 } });
  const archive = path.join(main, 'data', 'fly', 'archive');
  ok('run from a worktree with no --dest: exits 0', code === 0, s.lines);
  ok("...the copies land in the MAIN checkout's data/fly/archive", fs.existsSync(path.join(archive, 'ticks-2026-09-10.jsonl')) && fs.existsSync(path.join(archive, 'pull.log')), fs.existsSync(archive) && fs.readdirSync(archive));
  ok("...and nothing in the worktree's own data/", !fs.existsSync(path.join(wt1, 'data')));
  ok('...so its trim rests on a copy that outlives the worktree', s.log().filter((c) => c.op === 'rm').length === 2, s.log());

  for (const [i, [label, dest]] of [['a worktree', path.join(wt1, 'data', 'fly', 'archive')], ['a symlink into a worktree', path.join(link, 'fly', 'archive')]].entries()) {
    const t = scene(`intoworktree-${i}`);
    const c = t.go(['--trim', '--dest', dest], {}, NOW, { noDest: true });
    ok(`--trim with --dest inside ${label} is refused before the box is touched`, c === 2 && t.log().length === 0 && /inside the git worktree/.test(t.lines.join('\n')), { c, lines: t.lines });
    const dry = t.go(['--trim', '--dry-run', '--dest', dest], {}, NOW, { noDest: true });
    ok(`...a dry run of it too, since the real run would refuse`, dry === 2 && t.log().length === 0, dry);
  }
  const copyOnly = scene('copytoworktree');
  const cc = copyOnly.go(['--dest', path.join(wt2, 'data', 'fly', 'archive2')], {}, NOW, { noDest: true });
  ok('copy-only into a worktree is allowed: the box keeps every tape', cc === 0 && !copyOnly.log().some((c) => c.op === 'rm') && copyOnly.onBox().length === 10, { cc, lines: copyOnly.lines });
}

group('run: the frozen data/fly snapshot, however it is spelled');
{
  const s = scene('frozen');
  const snap = path.join(s.root, 'data', 'fly');
  fs.mkdirSync(snap, { recursive: true });
  fs.writeFileSync(path.join(snap, 'ticks-2026-09-12.jsonl'), 'tape of the 12th\n'.repeat(10));   // a prefix of the box file
  fs.symlinkSync(snap, path.join(s.root, 'snap-link'));
  for (const dest of ['data/fly', 'data/FLY', 'DATA/Fly/', './data/fly/../fly', 'snap-link']) {
    const c = s.go(['--dest', dest], {}, NOW, { noDest: true });
    ok(`--dest ${dest} is refused before the box is touched`, c === 2 && s.log().length === 0 && /frozen snapshot/.test(s.lines.join('\n')), { c, lines: s.lines });
  }
  ok('the frozen file is exactly as it was, and nothing was added beside it', fs.readFileSync(path.join(snap, 'ticks-2026-09-12.jsonl'), 'utf8') === 'tape of the 12th\n'.repeat(10) && fs.readdirSync(snap).length === 1, fs.readdirSync(snap));
  ok('isFrozenSnapshot: the archive under it is fine', !isFrozenSnapshot(path.join(snap, 'archive'), [s.root]) && !isFrozenSnapshot(path.join(s.root, 'mac', 'archive'), [s.root]));
  ok('isFrozenSnapshot: by inode, a folder of any name that IS data/fly', isFrozenSnapshot(path.join(s.root, 'snap-link'), [s.root]));
  const t = scene('trimfalse');
  ok('--trim=false is a usage error, and never reaches the box', t.go(['--trim=false']) === 2 && t.log().length === 0 && t.onBox().length === 10, t.lines);
}

// ================================================================ the recorder's brake
group('planTapeTrim: oldest first, never today, only as much as needed');
{
  const files = [
    { name: 'ticks-2026-09-12.jsonl', size: 60 * MB },
    { name: 'ticks-2026-09-10.jsonl', size: 30 * MB },
    { name: `ticks-${TODAY}.jsonl`, size: 500 * MB },
    { name: 'ticks-2026-09-11.jsonl', size: 40 * MB },
    { name: 'ticks-2026-09-15.jsonl', size: 500 * MB },
    { name: 'journal-2026-09-01.jsonl', size: 900 * MB },
    { name: 'whales-2026-09-01.jsonl', size: 900 * MB },
    { name: 'state.json', size: 900 * MB },
    { name: 'ticks-2026-09-01.jsonl.bak', size: 900 * MB },
  ];
  const plan = (free) => planTapeTrim(files, { today: TODAY, freeBytes: free * MB, minFreeBytes: 200 * MB });
  ok('above the floor: nothing', plan(250).length === 0 && plan(200).length === 0);
  ok('10MB short: only the oldest tape goes', JSON.stringify(plan(190)) === '["ticks-2026-09-10.jsonl"]', plan(190));
  ok('50MB short: the oldest two, and it stops once they cover it', JSON.stringify(plan(150)) === '["ticks-2026-09-10.jsonl","ticks-2026-09-11.jsonl"]', plan(150));
  const all = plan(0);
  ok('out of space: every old tape, oldest first', JSON.stringify(all) === '["ticks-2026-09-10.jsonl","ticks-2026-09-11.jsonl","ticks-2026-09-12.jsonl"]', all);
  ok("...but never today's, a future-dated one, a journal, whales, state.json or a .bak", !all.some((n) => n.includes(TODAY) || n.includes('09-15') || !/^ticks-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)), all);
  ok('no files, no plan', planTapeTrim([], { today: TODAY, freeBytes: 0, minFreeBytes: 1 }).length === 0);
}

// A disk that frees exactly what is deleted. bsize 1 keeps the arithmetic exact.
//   goneUnder: tapes the pull's own rm removes a moment before the brake's unlink (ENOENT, and
//              their space comes back)
//   heldOpen:  tapes something still has open (the pull's sftp get): unlinked, space not back yet
//   afterReaddir: run once the brake has listed the folder, to change the disk under it
function fakeDisk(sizes, freeMb) {
  const d = { files: { ...sizes }, free: freeMb * MB, statfs: 0, readdir: 0, unlinked: [], appended: [], failStatfs: false, failUnlink: null, goneUnder: new Set(), heldOpen: new Set(), afterReaddir: null };
  d.io = {
    statfsSync: () => { d.statfs++; if (d.failStatfs) throw new Error('ENOSYS'); return { bavail: d.free, bsize: 1 }; },
    readdirSync: () => { d.readdir++; const names = Object.keys(d.files); if (d.afterReaddir) d.afterReaddir(); return names; },
    statSync: (p) => ({ size: d.files[path.basename(p)] }),
    unlinkSync: (p) => {
      const n = path.basename(p);
      if (d.failUnlink) { const e = new Error(d.failUnlink); e.code = d.failUnlink; throw e; }
      if (d.goneUnder.has(n)) { const e = new Error('ENOENT'); e.code = 'ENOENT'; d.free += d.files[n]; delete d.files[n]; throw e; }
      if (!d.heldOpen.has(n)) d.free += d.files[n];
      delete d.files[n]; d.unlinked.push(n);
    },
    mkdirSync: () => {},
    appendFileSync: (p, text) => { d.appended.push({ file: p, text }); },
  };
  return d;
}
const fakeE = () => { const logs = []; return { logs, log: (agent, kind, pnl, text) => logs.push({ agent, kind, pnl, text }) }; };
const cfg = { dataDir: '/fake/data', tapeMinFreeMb: 200 };
const HOUR = 3600000;

group('the brake: cheap on the hot path');
{
  const d = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB }, 500);
  const brake = makeDiskBrake(cfg, d.io);
  const E = fakeE();
  brake(E, NOW);
  ok('the first write checks free space at once', d.statfs === 1, d.statfs);
  ok('with room to spare it does not even list the folder', d.readdir === 0 && d.unlinked.length === 0 && E.logs.length === 0);
  for (let i = 1; i <= 100; i++) brake(E, NOW + i * 30000);   // 50 minutes of cycles
  ok('no further look inside the hour, however many cycles run', d.statfs === 1, d.statfs);
  brake(E, NOW + HOUR);
  ok('one more look once the hour is up', d.statfs === 2, d.statfs);
}

group('the brake: below the floor, oldest tapes go one at a time until it is back above');
{
  const d = fakeDisk({
    'ticks-2026-09-11.jsonl': 40 * MB, 'ticks-2026-09-10.jsonl': 30 * MB, 'ticks-2026-09-12.jsonl': 60 * MB,
    [`ticks-${TODAY}.jsonl`]: 20 * MB, 'journal-2026-09-10.jsonl': 1 * MB, 'state.json': 1 * MB,
    'whales-2026-09-10.jsonl': 1 * MB, 'ticks-2026-09-09.jsonl.bak': 100 * MB,
  }, 150);
  const E = fakeE();
  makeDiskBrake(cfg, d.io)(E, NOW);
  ok('deletes the 10th, then the 11th, and stops at 220MB free', JSON.stringify(d.unlinked) === '["ticks-2026-09-10.jsonl","ticks-2026-09-11.jsonl"]' && d.free === 220 * MB, { unlinked: d.unlinked, free: d.free / MB });
  ok("today's tape, the 12th, the journal, whales, state.json and the .bak all survive", [`ticks-${TODAY}.jsonl`, 'ticks-2026-09-12.jsonl', 'journal-2026-09-10.jsonl', 'whales-2026-09-10.jsonl', 'state.json', 'ticks-2026-09-09.jsonl.bak'].every((n) => n in d.files), Object.keys(d.files));
  ok('one log line per deletion, from TESS as OPS', E.logs.length === 2 && E.logs.every((l) => l.agent === 'TESS' && l.kind === 'OPS' && l.pnl === null), E.logs);
  ok('each names the file and says plainly it may not be on the Mac', E.logs[0].text.includes('ticks-2026-09-10.jsonl') && E.logs.every((l) => /may not have been copied to the Mac yet/.test(l.text) && l.text.includes('tools/fly-pull.js')), E.logs.map((l) => l.text));
  ok('the floor reads "disk low" (the first clause)', E.logs.every((l) => l.text.split('·')[0].trim() === 'disk low'), E.logs[0].text);
}

group("the brake: nothing old left -- today's tape and the journals still stand");
{
  const d = fakeDisk({ [`ticks-${TODAY}.jsonl`]: 500 * MB, 'journal-2026-09-01.jsonl': 5 * MB }, 10);
  const E = fakeE();
  makeDiskBrake(cfg, d.io)(E, NOW);
  ok('deletes nothing', d.unlinked.length === 0, d.unlinked);
  ok('and says the disk is still low, once', E.logs.length === 1 && /no old tick tape is left/.test(E.logs[0].text), E.logs);
}

group('the brake: never throws into the cycle');
{
  const d = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB }, 10);
  d.failStatfs = true;
  const E = fakeE();
  const brake = makeDiskBrake(cfg, d.io);
  let threw = false;
  try { brake(E, NOW); brake(E, NOW + 2000); brake(E, NOW + 4000); } catch { threw = true; }
  ok('a statfs that throws is skipped quietly', !threw && E.logs.length === 0 && d.unlinked.length === 0, { threw, logs: E.logs });
  ok('...and not retried every cycle', d.statfs === 1, d.statfs);

  const d2 = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB, 'ticks-2026-09-11.jsonl': 30 * MB }, 10);
  d2.failUnlink = 'EACCES';
  const E2 = fakeE();
  let threw2 = false;
  try { makeDiskBrake(cfg, d2.io)(E2, NOW); } catch { threw2 = true; }
  ok('an unlink that fails does not throw', !threw2);
  ok('...and is said once', E2.logs.length === 1 && /could not trim/.test(E2.logs[0].text), E2.logs);


  const d4 = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB }, 1);
  const off = makeDiskBrake({ ...cfg, tapeMinFreeMb: 0 }, d4.io);
  off(fakeE(), NOW);
  ok('TAPE_MIN_FREE_MB=0 turns it off: not even a statfs', d4.statfs === 0 && d4.unlinked.length === 0);
  const noStatfs = makeDiskBrake(cfg, { ...d4.io, statfsSync: undefined });
  let threw4 = false;
  try { noStatfs(fakeE(), NOW); } catch { threw4 = true; }
  ok('a Node with no statfs: the brake is simply off', !threw4 && d4.unlinked.length === 0);
}

group('the brake: never deletes more than one measurement says it needs');
{
  // the Mac pulls oldest-first, the brake trims oldest-first: they meet on the same tapes
  const a = fakeDisk({ 'ticks-2026-09-10.jsonl': 60 * MB, 'ticks-2026-09-11.jsonl': 300 * MB }, 150);
  a.goneUnder.add('ticks-2026-09-10.jsonl');   // the pull's rm lands between the listing and the unlink
  makeDiskBrake(cfg, a.io)(fakeE(), NOW);
  ok("the pull's rm freed the 10th under it: the 11th, maybe not yet copied, is left alone", a.unlinked.length === 0 && 'ticks-2026-09-11.jsonl' in a.files && a.free === 210 * MB, { unlinked: a.unlinked, free: a.free / MB });

  const b = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB, 'ticks-2026-09-11.jsonl': 40 * MB, 'ticks-2026-09-12.jsonl': 60 * MB }, 150);
  b.goneUnder.add('ticks-2026-09-10.jsonl');
  makeDiskBrake(cfg, b.io)(fakeE(), NOW);
  ok('...but when that was not enough, the next oldest still goes, and no more', JSON.stringify(b.unlinked) === '["ticks-2026-09-11.jsonl"]' && 'ticks-2026-09-12.jsonl' in b.files, b.unlinked);

  const c = fakeDisk({ 'ticks-2026-09-09.jsonl': 50 * MB, 'ticks-2026-09-10.jsonl': 30 * MB }, 150);
  c.afterReaddir = () => { c.free += 100 * MB; };   // the pull deleted a big tape while the brake was listing
  makeDiskBrake(cfg, c.io)(fakeE(), NOW);
  ok('space freed while it was listing is counted before the first delete', c.unlinked.length === 0, c.unlinked);

  const h = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB, 'ticks-2026-09-11.jsonl': 40 * MB, 'ticks-2026-09-12.jsonl': 60 * MB }, 190);
  h.heldOpen.add('ticks-2026-09-10.jsonl');   // the pull's sftp get is still streaming it
  const E = fakeE();
  const brake = makeDiskBrake(cfg, h.io);
  brake(E, NOW);
  ok('a deleted tape still held open frees nothing yet: the brake stops at what it planned', JSON.stringify(h.unlinked) === '["ticks-2026-09-10.jsonl"]' && 'ticks-2026-09-11.jsonl' in h.files && 'ticks-2026-09-12.jsonl' in h.files, h.unlinked);
  ok('...and says the disk is still low, with tapes left, and when it looks again', E.logs.length === 2 && /still under the 200 MB floor · 2 old tick tapes left; looking again in an hour/.test(E.logs[1].text), E.logs.map((l) => l.text));
  h.free += 30 * MB;   // the copy finished and closed the file
  brake(E, NOW + HOUR);
  ok('an hour on, the space is back and nothing more is deleted', h.unlinked.length === 1 && E.logs.length === 2, { unlinked: h.unlinked, logs: E.logs.length });
}

group("the brake: today is the Eastern date, even when UTC has moved on");
{
  // 22:00 ET on the 14th, UTC the 15th. A UTC today would make the evening's tape an old one.
  const d = fakeDisk({ [`ticks-${TODAY}.jsonl`]: 500 * MB, 'ticks-2026-09-13.jsonl': 30 * MB }, 0);
  makeDiskBrake(cfg, d.io)(fakeE(), EVENING);
  ok("at 22:00 ET the 14th's tape is today's: never deleted", `ticks-${TODAY}.jsonl` in d.files && JSON.stringify(d.unlinked) === '["ticks-2026-09-13.jsonl"]', d.unlinked);
}

group('the recorder: the brake is wired in, ahead of the empty-cycle return');
{
  const rcfg = { record: true, dataDir: '/fake/data', tapeMinFreeMb: 200 };
  const d = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB, [`ticks-${TODAY}.jsonl`]: 1 * MB }, 190);
  const rec = makeRecorder(rcfg, { io: d.io, clock: () => EVENING });
  const E = { ...fakeE(), cycle: 1, pairs: [] };
  rec(E);
  ok('a cycle with nothing to write still checks the disk', d.statfs >= 1, d.statfs);
  ok('...and trims the old tape when it is low', JSON.stringify(d.unlinked) === '["ticks-2026-09-10.jsonl"]', d.unlinked);
  ok('...writing nothing', d.appended.length === 0, d.appended);
  const checks = d.statfs;
  E.pairs = [{ id: 'p1', label: 'A vs B', kind: 'game', series: 'X', inPlay: false, q: { pmBid: 0.5, pmAsk: 0.52, pmVol: 10, ksBid: 0.49, ksAsk: 0.53, ksVol: 5, t: EVENING } }];
  rec(E);
  ok('the next cycle writes its line without looking at the disk again', d.appended.length === 1 && d.statfs === checks, { appended: d.appended.length, statfs: d.statfs });
  ok("...into the Eastern day's tape: at 22:00 ET that is the 14th, not UTC's 15th", d.appended[0] && d.appended[0].file === path.join('/fake/data', `ticks-${TODAY}.jsonl`), d.appended[0] && d.appended[0].file);
  const off = fakeDisk({ 'ticks-2026-09-10.jsonl': 30 * MB }, 0);
  makeRecorder({ ...rcfg, record: false }, { io: off.io, clock: () => NOW })({ ...fakeE(), pairs: [] });
  ok('RECORD=0: no recorder, no brake', off.statfs === 0 && off.unlinked.length === 0);
}

group('config: the brake is on by default only on a Fly machine');
{
  const { execFileSync } = require('child_process');
  // a clean environment each time, so neither this shell's TAPE_MIN_FREE_MB nor FLY_MACHINE_ID leaks in
  const knob = (env) => Number(execFileSync(process.execPath, ['-e', "process.stdout.write(String(require('./src/config').tapeMinFreeMb))"], { cwd: path.join(__dirname, '..'), env, encoding: 'utf8' }));
  ok('on a Fly machine: 200 MB', knob({ FLY_MACHINE_ID: 'abcdef1234' }) === 200);
  ok("on the Mac: off, because its tapes exist nowhere else", knob({}) === 0);
  ok('TAPE_MIN_FREE_MB wins either way', knob({ TAPE_MIN_FREE_MB: '50' }) === 50 && knob({ FLY_MACHINE_ID: 'abcdef1234', TAPE_MIN_FREE_MB: '0' }) === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

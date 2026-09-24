'use strict';
// The desk's lifecycle in the journal (START, STOP, CRASH, and the engine's WATCHDOG): what counts as
// a restart with a reason, what does not, and that no reader of the journal is thrown by the new
// lines. No network, no clock; the disk only in a temp folder.
//
//   node tools/restarts-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { restarts, render, lastDays, main } = require('./restarts');
const { crashRecord, LIFECYCLE } = require('../src/journal');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
// Eastern noon on the 23rd and 24th of September 2026 is 16:00Z
const at = (d, hh, mm = 0) => `2026-09-${d}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00.000Z`;

group('a restart with a reason is not a problem; one without is');
{
  const ev = [
    { t: at(23, 14), kind: 'START', sha: 'aaaaaaa1' },            // the first on record: counted as neither
    { t: at(23, 15), kind: 'STOP', signal: 'SIGTERM' },           // a deploy
    { t: at(23, 15, 1), kind: 'START', sha: 'bbbbbbb2' },
    { t: at(23, 17), kind: 'WATCHDOG', restarting: true },        // a stall, the engine exits
    { t: at(23, 17, 1), kind: 'START', sha: 'bbbbbbb2' },
    { t: at(23, 18), kind: 'CRASH', ev: 'uncaughtException', stack: 'TypeError: x is undefined\n    at step (engine.js:1:1)' },
    { t: at(23, 18, 1), kind: 'START', sha: 'bbbbbbb2' },
    { t: at(23, 19), kind: 'OPEN', id: 'a' },                     // not a lifecycle line: skipped over
    { t: at(23, 20), kind: 'START', sha: 'bbbbbbb2' },            // nothing since the last START: an OOM kill
  ];
  const d = restarts(ev).get('2026-09-23');
  ok('five starts, one deploy, one watchdog, one crash', d.starts === 5 && d.stops === 1 && d.watchdogs === 1 && d.crashes.length === 1, d);
  ok('exactly one unexplained restart, the one after a START', d.unexplained.length === 1 && d.unexplained[0].t === at(23, 20) && /START at 2026-09-23T18:01:00Z/.test(d.unexplained[0].after), d.unexplained);
  ok('the first START on record is not called unexplained', d.first === 1);
  const r = render(restarts(ev), ['2026-09-23']);
  ok('the line names the count, and the problem line names the time and the build', /unexplained restarts \(likely OOM\/kill\): 1/.test(r.text) && /PROBLEM  2026-09-23T20:00:00Z START \(bbbbbbb\)/.test(r.text), r.text);
  ok('a crash prints its first stack line', /CRASH    2026-09-23T18:00:00Z uncaughtException: TypeError: x is undefined$/m.test(r.text), r.text);
  ok('the crash and the unexplained restart are both flagged', r.flagged === 2, r.flagged);
}

group('the reason can be in the day before, and the order is by time, not by file');
{
  const ev = [
    { t: at(24, 13), kind: 'START', sha: 'c' },                   // the morning after an evening deploy
    { t: at(23, 23), kind: 'STOP', signal: 'SIGTERM' },           // 19:00 ET on the 23rd
    { t: at(23, 1), kind: 'START', sha: 'b' },                    // 21:00 ET on the 22nd
  ];
  const days = restarts(ev);
  ok("the 24th's START is explained by the 23rd's STOP", days.get('2026-09-24').unexplained.length === 0 && days.get('2026-09-24').starts === 1, [...days]);
  ok('an event is filed under its Eastern day, not its UTC one', days.has('2026-09-22') && days.get('2026-09-22').starts === 1, [...days.keys()]);
  const two = restarts([{ t: at(21, 16), kind: 'START' }, { t: at(22, 16), kind: 'OPEN' }, { t: at(24, 16), kind: 'START' }]);
  ok('...and a START two quiet days after the last one is still unexplained', two.get('2026-09-24').unexplained.length === 1, [...two]);
}

group("a live-mode WATCHDOG does not restart the desk, so it explains nothing");
{
  const d = restarts([{ t: at(23, 14), kind: 'START' }, { t: at(23, 15), kind: 'WATCHDOG', restarting: false }, { t: at(23, 16), kind: 'START' }]).get('2026-09-23');
  ok('the START after it is unexplained', d.unexplained.length === 1 && d.watchdogs === 1, d);
  const old = restarts([{ t: at(23, 14), kind: 'START' }, { t: at(23, 15), kind: 'WATCHDOG' }, { t: at(23, 16), kind: 'START' }]).get('2026-09-23');
  ok('a WATCHDOG line from before the restarting field existed still explains its restart', old.unexplained.length === 0, old);
}

group('days with nothing, and the window');
{
  const r = render(restarts([]), ['2026-09-23', '2026-09-24']);
  ok('a quiet day prints zeros and flags nothing', r.flagged === 0 && /restarts 2026-09-24: 0 START · 0 STOP \(deploys\) · 0 WATCHDOG · 0 CRASH · unexplained restarts \(likely OOM\/kill\): 0/.test(r.text), r.text);
  ok('yesterday and today', JSON.stringify(lastDays('2026-09-24', 2)) === '["2026-09-23","2026-09-24"]');
  ok('across a month and a year', JSON.stringify(lastDays('2027-01-01', 3)) === '["2026-12-30","2026-12-31","2027-01-01"]', lastDays('2027-01-01', 3));
  ok('...and across the DST change', JSON.stringify(lastDays('2026-11-02', 2)) === '["2026-11-01","2026-11-02"]');
}

group('crashRecord: which handler, and the start of the stack');
{
  const e = new Error('boom');
  const r = crashRecord('unhandledRejection', e);
  ok('the handler and the message', r.ev === 'unhandledRejection' && r.stack.startsWith('Error: boom'), r);
  ok('never more than 800 characters', crashRecord('x', { stack: 'y'.repeat(5000) }).stack.length === 800);
  ok('a rejection with a plain value, or nothing at all, still makes a line', crashRecord('x', 'just a string').stack === 'just a string' && crashRecord('x', undefined).stack === 'undefined');
  ok('the lifecycle kinds', JSON.stringify(LIFECYCLE) === '["START","STOP","WATCHDOG","CRASH"]');
}

group('server.js writes them (it cannot be required without starting a desk, so its source is pinned)');
{
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const engineAt = src.indexOf('const engine = new Engine(cfg);');
  const startAt = src.indexOf("lifecycle('START', { sha: cfg.buildSha || null");
  ok('START once, right after the engine exists and before the server listens', engineAt > 0 && startAt > engineAt && startAt < src.indexOf('server.listen(') && src.split("lifecycle('START'").length === 2, [engineAt, startAt]);
  ok('STOP in the signal handler, before the save', /process\.on\(sig, \(\) => \{ lifecycle\('STOP', \{ signal: sig \}\); engine\.save\(\);/.test(src));
  ok('CRASH in the last-resort handlers, before the save and the exit', /process\.on\(ev, \(e\) => \{[^\n]*lifecycle\('CRASH', crashRecord\(ev, e\)\); try \{ engine\.save\(\);[^\n]*process\.exit\(1\)/.test(src));
  ok('CRASH when the engine fails to start', /engine\.start\(\)\.catch\(\(e\) => \{[^\n]*lifecycle\('CRASH', crashRecord\('engine\.start', e\)\);[^\n]*process\.exit\(1\)/.test(src));
  ok('a failed journal write never stops an exit', /const lifecycle = \(kind, payload\) => \{ try \{ engine\.journal\(engine, kind, payload\); \} catch/.test(src));
}

group('every journal reader passes the new lines by');
{
  const life = [
    { t: at(23, 14), cycle: 0, mode: 'paper', kind: 'START', sha: 'abc', pid: 1 },
    { t: at(23, 15), cycle: 9, mode: 'paper', kind: 'STOP', signal: 'SIGTERM' },
    // a stack can quote anything, journal kinds included
    { t: at(23, 16), cycle: 9, mode: 'paper', kind: 'CRASH', ev: 'uncaughtException', stack: 'Error: bad "kind":"MAKER_FILL" "kind":"OPEN" qty px' },
  ];
  const trades = [
    { t: at(23, 14, 30), kind: 'OPEN', id: 'a', group: 'g', qty: 10, entry: 0.4, cost: 4.1, fee: 0.1, cash: 995.9, strategy: 'converge' },
    { t: at(23, 15, 30), kind: 'MAKER_FILL', ticker: 'M', side: 'buy', qty: 5, px: 0.3, inv: 5 },
  ];
  const { rebuild } = require('./ledger-check');
  const a = rebuild(trades, 1000), b = rebuild([...trades, ...life], 1000);
  ok('ledger-check rebuilds the same books, with no drift', JSON.stringify([a.taker.cash, a.taker.events, a.taker.drifts, a.maker.cash, a.maker.fills]) === JSON.stringify([b.taker.cash, b.taker.events, b.taker.drifts, b.maker.cash, b.maker.fills]) && b.taker.drifts.length === 0, [a.taker, b.taker]);
  const { journalFills } = require('./fillcheck');
  const lines = (xs) => xs.map((x) => JSON.stringify(x));
  ok('fillcheck counts the same fills', journalFills(lines([...trades, ...life])).fills === 1);
  const { makeVolume } = require('../src/volume');
  const v = makeVolume();
  for (const e of life) v.note(e.kind, e, Date.parse(e.t));
  ok('the volume bars see no trade in them', v.entries(Date.parse(at(23, 17))).length === 0);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-restarts-test-'));
  fs.writeFileSync(path.join(tmp, 'journal-2026-09-23.jsonl'), lines([...life, ...trades]).join('\n') + '\n');
  const v2 = makeVolume();
  ok('...nor when the bars are rebuilt from the file', v2.load(tmp, Date.parse(at(23, 17))) === 2);
  // the tool itself, end to end on that folder, with a fixed clock
  const out = [];
  const code = main(['node', 'restarts.js', tmp], { now: () => new Date(at(23, 20)), log: (s) => out.push(s) });
  ok('the tool reads the folder: a crash is flagged, exit 1', code === 1 && /restarts 2026-09-23: 1 START · 1 STOP \(deploys\) · 0 WATCHDOG · 1 CRASH/.test(out.join('\n')) && /journals through 2026-09-23T16:00Z/.test(out.join('\n')), out);
  const none = [];
  ok('no journal at all is a problem, not a clean bill', main(['node', 'restarts.js', path.join(tmp, 'nope')], { log: (s) => none.push(s) }) === 1 && /no journal events found/.test(none.join('')), none);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

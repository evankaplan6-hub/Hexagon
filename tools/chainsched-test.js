'use strict';
// Assertions for src/chainsched.js: the chain recorder's schedule on the box.
//
//   node tools/chainsched-test.js
const { nextRun, prune, start, summary, instant, wall, STATUS } = require('../src/chainsched');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(name, JSON.stringify(got) === JSON.stringify(want), got);
const group = (n) => console.log(`\n${n}`);
const et = (s) => { const [d, t] = s.split(' '); const [y, m, dd] = d.split('-').map(Number); const [hh, mm] = t.split(':').map(Number); return instant(y, m, dd, hh, mm); };
const show = (r) => (r ? `${r.day} ${String(r.hh).padStart(2, '0')}:${String(r.mm).padStart(2, '0')}` : null);

group('the Eastern clock');
eq('an Eastern instant reads back as the same wall time (EDT)', (({ y, m, d, hh, mm }) => [y, m, d, hh, mm])(wall(et('2026-09-23 16:25'))), [2026, 9, 23, 16, 25]);
eq('and in winter (EST)', (({ y, m, d, hh, mm }) => [y, m, d, hh, mm])(wall(et('2026-12-15 09:45'))), [2026, 12, 15, 9, 45]);
eq('16:25 EDT is 20:25 UTC', new Date(et('2026-09-23 16:25')).toISOString(), '2026-09-23T20:25:00.000Z');
eq('16:25 EST is 21:25 UTC', new Date(et('2026-12-15 16:25')).toISOString(), '2026-12-15T21:25:00.000Z');

group('the next slot');
eq('a weekday morning waits for 09:45', show(nextRun(et('2026-09-23 06:00'))), '2026-09-23 09:45');   // Wednesday
eq('exactly on a slot is not that slot', show(nextRun(et('2026-09-23 09:45'))), '2026-09-23 16:25');
eq('mid-afternoon waits for the close snapshot', show(nextRun(et('2026-09-23 12:00'))), '2026-09-23 16:25');
eq('after the close, the evening one', show(nextRun(et('2026-09-23 16:26'))), '2026-09-23 20:00');
eq('late evening rolls to the next morning', show(nextRun(et('2026-09-23 23:30'))), '2026-09-24 09:45');
eq('Friday night skips the weekend', show(nextRun(et('2026-09-25 21:00'))), '2026-09-28 09:45');
eq('Saturday skips to Monday', show(nextRun(et('2026-09-26 12:00'))), '2026-09-28 09:45');
eq('Sunday too', show(nextRun(et('2026-09-27 12:00'))), '2026-09-28 09:45');
eq('the UTC date being tomorrow at 22:00 ET does not lose a day', show(nextRun(et('2026-09-23 22:00'))), '2026-09-24 09:45');
eq('across the DST switch (Nov 1 2026) the slot stays 09:45 Eastern', new Date(nextRun(et('2026-10-30 21:00')).at).toISOString(), '2026-11-02T14:45:00.000Z');
ok('the slot is always in the future', [et('2026-09-23 06:00'), et('2026-09-25 21:00'), et('2026-12-31 23:59')].every((t) => nextRun(t).at > t));

group('pruning the box copy');
const days = ['chains-2026-09-01.jsonl', 'chains-2026-09-02.jsonl', 'chains-2026-09-03.jsonl', 'chains-2026-09-04.jsonl', '.seen.json', 'notes.txt'];
eq('keeps the newest N tapes and touches nothing else', prune(days, 2), ['chains-2026-09-01.jsonl', 'chains-2026-09-02.jsonl']);
eq('fewer tapes than N drops none', prune(days, 10), []);
eq('unsorted input still drops the oldest', prune(['chains-2026-09-03.jsonl', 'chains-2026-09-01.jsonl', 'chains-2026-09-02.jsonl'], 2), ['chains-2026-09-01.jsonl']);
eq('keepDays 0 turns pruning off', prune(days, 0), []);
eq('a file that only looks like a tape is left alone', prune(['chains-2026-09-01.jsonl.bak', 'chains-2026-09-02.jsonl', 'chains-2026-09-03.jsonl'], 1), ['chains-2026-09-02.jsonl']);

group('the timer');
{
  const logs = [], timers = [], unlinked = [];
  let clock = et('2026-09-23 16:00');
  const written = {};
  const fakeFs = { readdirSync: () => ['chains-2026-09-08.jsonl', 'chains-2026-09-22.jsonl', 'chains-2026-09-23.jsonl', '.seen.json'], unlinkSync: (p) => unlinked.push(p), mkdirSync: () => {}, writeFileSync: (p, t) => { written[p] = JSON.parse(t); } };
  let runs = 0;
  const s = start({ dataDir: '/tmp/x', keepDays: 2, log: (m) => logs.push(m), now: () => clock, setTimer: (fn, ms) => timers.push({ fn, ms }), run: async () => { runs++; return 'SPY QQQ IWM DIA TLT GLD · 83 lines, 19072 contracts, 1845 KB → /tmp/x/chains/chains-2026-09-23.jsonl'; }, fs: fakeFs });
  ok('the first timer is armed for 16:25 today', timers.length === 1 && timers[0].ms === 25 * 60000, timers[0] && timers[0].ms);
  ok('the log says when', /2026-09-23 16:25 ET/.test(logs[0]), logs[0]);
  eq('the status file says what is next before anything has run', written[`/tmp/x/chains/${STATUS}`], { last: null, next: { at: et('2026-09-23 16:25'), label: '2026-09-23 16:25 ET' } });
  clock = et('2026-09-23 16:25') + 1000;
  (async () => {
    await timers[0].fn();
    eq('the slot ran the recorder once', runs, 1);
    ok('the recorder\'s last lines are logged', logs.some((l) => /83 lines/.test(l)), logs);
    eq('then the oldest tape beyond keepDays went', unlinked, ['/tmp/x/chains/chains-2026-09-08.jsonl']);
    ok('and the next timer is armed for 20:00', timers.length === 2 && Math.round(timers[1].ms / 60000) === 3 * 60 + 35 - 0, timers[1] && timers[1].ms);
    const st = written[`/tmp/x/chains/${STATUS}`];
    ok('the status file now says what the run did and what is next', st.last && st.last.result === '83 lines, 19,072 contracts' && st.last.wrote === true && st.next.label === '2026-09-23 20:00 ET', st);
    ok('a failing recorder is logged, not thrown, and the timer still re-arms', await (async () => {
      const t2 = [], l2 = [];
      start({ dataDir: '/tmp/y', log: (m) => l2.push(m), now: () => clock, setTimer: (fn, ms) => t2.push({ fn, ms }), run: async () => { throw new Error('cboe down'); }, fs: { readdirSync: () => { throw new Error('no dir'); }, unlinkSync: () => {}, mkdirSync: () => { throw new Error('ro'); }, writeFileSync: () => {} } });
      await t2[0].fn();
      return t2.length === 2 && l2.some((l) => /snapshot failed: cboe down/.test(l));
    })());
    group('the summary line');
    eq('a write', summary('2026-09-23T17:19Z SPY QQQ | SPY QQQ IWM DIA TLT GLD · 83 lines, 19072 contracts, 1845 KB → /data/chains/x.jsonl (new file)'), '83 lines, 19,072 contracts');
    eq('nothing new', summary('2026-09-23T13:45Z ... |   nothing new to record |   skipped: SPY (unchanged since ...)'), 'nothing new: the chains had not changed');
    eq('a failure keeps its reason', summary('snapshot failed: cboe down'), 'snapshot failed: cboe down');
    eq('a refused spawn keeps its reason', summary('could not start the recorder: ENOENT'), 'could not start the recorder: ENOENT');
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

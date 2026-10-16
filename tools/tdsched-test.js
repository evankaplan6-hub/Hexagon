'use strict';
// Assertions for src/tdsched.js: the anytime-touchdown tape on a timer inside the desk.
//
//   node tools/tdsched-test.js
const path = require('path');
const { start, EVERY_MIN, FIRST_SEC } = require('../src/tdsched');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

(async () => {
  group('the timer');
  const timers = [], logs = [], calls = [];
  let answer = { ok: true, recorded: 0, line: 'ok td-tape: 300 open, 0 games, 0 lines written' };
  const s = start({
    dataDir: '/data', log: (l) => logs.push(l), setTimer: (fn, ms) => timers.push({ fn, ms }),
    record: async (opts) => { calls.push(opts); if (answer instanceof Error) throw answer; return answer; },
  });
  ok('it records into DATA_DIR/td', s.dir === path.join('/data', 'td'), s.dir);
  ok('one timer, a minute after boot', timers.length === 1 && timers[0].ms === FIRST_SEC * 1000, timers.map((t) => t.ms));
  ok('nothing runs until the timer fires', calls.length === 0);
  await timers[0].fn();
  ok('a run reads into that folder', calls.length === 1 && calls[0].dir === s.dir, calls);
  ok('the next is armed only after it finished, 15 minutes on', timers.length === 2 && timers[1].ms === EVERY_MIN * 60e3, timers.map((t) => t.ms));
  ok('a quiet run (nothing written) stays out of the box log', !logs.some((l) => /300 open/.test(l)), logs);
  answer = { ok: true, recorded: 23, line: 'ok td-tape: 300 open, 1 game, 23 lines written' };
  await timers[1].fn();
  ok('a run that wrote lines is logged', logs.some((l) => /23 lines written/.test(l)), logs);
  answer = { ok: false, recorded: 0, line: 'PROBLEM td-tape: Kalshi: timed out' };
  await timers[2].fn();
  ok('a PROBLEM run is logged', logs.some((l) => /PROBLEM td-tape/.test(l)), logs);
  answer = new Error('boom');
  await timers[3].fn();
  ok('a throw is caught and logged, and the timer keeps going', logs.some((l) => /run failed: boom/.test(l)) && timers.length === 5, logs);
  ok('every run counted', s.status.runs === 4, s.status);

  group('the real record() is what it calls by default');
  const td = require('./td-tape');
  ok('tools/td-tape.js exports record()', typeof td.record === 'function');

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

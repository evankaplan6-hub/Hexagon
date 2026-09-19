'use strict';
// Assertions for the stall watchdog (src/watchdog.js and the engine's watchdogCheck / makerRound).
//
// On 2026-09-19 the taker cycle and the maker's requote loop stopped in the same second and the
// desk sat frozen for over an hour, looking exactly like a quiet market. The watchdog has to do
// three things and must never do a fourth: notice a loop that finishes no rounds, say what was in
// flight, and ask for a restart -- but never restart a healthy desk, a laptop that was asleep, or
// a live account with an order possibly in flight.
//
//   node tools/watchdog-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { stalledLoops, wasSuspended } = require('../src/watchdog');
const { Engine } = require('../src/engine');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const dirs = [];
function engine(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-watchdog-'));
  dirs.push(dataDir);
  const cfg = { ...base, mode: 'paper', demo: false, dataDir, record: false, makerEnabled: false, watchdogSec: 300, ...over };
  const E = new Engine(cfg);
  E.logged = []; E.journalled = []; E.exits = [];
  E.log = (agent, kind, pnl, text) => { E.logged.push(text); };
  E.journal = (_e, type, data) => { E.journalled.push({ type, data }); };
  E.exit = (code) => { E.exits.push(code); };
  return E;
}

const T0 = 1_000_000_000_000;
const MIN = 60000;

function pure() {
  group('a loop with no finished round inside the limit is stalled');
  const limitMs = 300000;
  ok('two fresh loops: nothing stalled', stalledLoops({ now: T0, limitMs, beats: { taker: T0 - 10000, maker: T0 - 2000 } }).length === 0);
  ok('exactly at the limit is not yet a stall', stalledLoops({ now: T0, limitMs, beats: { taker: T0 - limitMs, maker: T0 } }).length === 0);
  const one = stalledLoops({ now: T0, limitMs, beats: { taker: T0 - limitMs - 1, maker: T0 - 1000 } });
  ok('one past the limit is', one.length === 1 && one[0].loop === 'taker' && one[0].idleMs === limitMs + 1, one);
  const both = stalledLoops({ now: T0, limitMs, beats: { taker: T0 - 400000, maker: T0 - 900000 } });
  ok('both stalled: both named, longest silence first', both.map((s) => s.loop).join() === 'maker,taker', both);
  ok('a limit of zero is off', stalledLoops({ now: T0, limitMs: 0, beats: { taker: 0, maker: 0 } }).length === 0);

  group('a process that was asleep is not a stalled desk');
  ok('a check on time is not a wake-up', !wasSuspended({ now: T0 + 15000, last: T0, everyMs: 15000 }));
  ok('a check a little late is not either', !wasSuspended({ now: T0 + 40000, last: T0, everyMs: 15000 }));
  ok('a check an hour late is', wasSuspended({ now: T0 + 60 * MIN, last: T0, everyMs: 15000 }));
  ok('the first check has nothing to compare to', !wasSuspended({ now: T0, last: undefined, everyMs: 15000 }));
}

async function wiring() {
  group('the engine restarts a stalled desk, says why, and leaves a healthy one alone');
  let E = engine();
  E.wdLast = T0; E.beat.taker = T0 - 10000; E.beat.maker = T0 - 2000;
  ok('healthy: nothing reported', E.watchdogCheck(T0) === null);
  ok('...no exit, no journal line', E.exits.length === 0 && E.journalled.length === 0);

  E = engine();
  E.wdLast = T0 + 5 * MIN; E.beat.taker = T0 - 20 * MIN; E.beat.maker = T0 + 5 * MIN - 1000;
  E.stepping = true;
  const s = E.watchdogCheck(T0 + 5 * MIN + 15000);
  ok('a taker with no finished round is reported', s && s.length === 1 && s[0].loop === 'taker', s);
  ok('...the desk asks to be restarted, once, with a failing exit code', E.exits.length === 1 && E.exits[0] === 1, E.exits);
  const j = E.journalled.find((x) => x.type === 'WATCHDOG');
  ok('...the journal names the stalled loop and that its round is still open', j && j.data.stalled[0].loop === 'taker' && j.data.taking === true && j.data.making === false, j);
  ok('...and records that it is restarting', j && j.data.restarting === true, j);
  ok('...the log says WATCHDOG and the silence', E.logged.some((t) => /WATCHDOG/.test(t) && /taker 1515s/.test(t)), E.logged);
  const saved = JSON.parse(fs.readFileSync(path.join(E.cfg.dataDir, 'state.json'), 'utf8'));
  ok('...and the ledger is saved first', saved && saved.version === 1, saved && saved.version);

  E = engine();
  E.wdLast = T0; E.beat.taker = T0; E.beat.maker = T0 - 20 * MIN;
  const m = E.watchdogCheck(T0 + 15000);
  ok('a maker alone stalled restarts the desk too', m && m[0].loop === 'maker' && E.exits.length === 1, m);

  group('...and never when it should not');
  E = engine({ watchdogSec: 0 });
  E.wdLast = T0; E.beat.taker = 0; E.beat.maker = 0;
  ok('WATCHDOG_SEC=0 turns it off', E.watchdogCheck(T0 + 15000) === null && E.exits.length === 0);

  E = engine();
  E.wdLast = T0; E.beat.taker = T0 - 20 * MIN; E.beat.maker = T0 - 20 * MIN;
  ok('a wake from sleep is not a stall', E.watchdogCheck(T0 + 60 * MIN) === null && E.exits.length === 0);
  ok('...and every loop gets a fresh start', E.beat.taker === T0 + 60 * MIN && E.beat.maker === T0 + 60 * MIN);
  ok('...so the next check on time finds nothing', E.watchdogCheck(T0 + 60 * MIN + 15000) === null && E.exits.length === 0);

  E = engine();
  E.cfg.mode = 'live'; E.wdLast = T0; E.beat.taker = T0 - 20 * MIN; E.beat.maker = T0;
  const l = E.watchdogCheck(T0 + 15000);
  ok('live mode reports the stall', l && l[0].loop === 'taker' && E.journalled.some((x) => x.type === 'WATCHDOG' && x.data.restarting === false));
  ok('...but does not exit', E.exits.length === 0, E.exits);
  ok('...and does not save over a ledger with an order possibly in flight', !fs.existsSync(path.join(E.cfg.dataDir, 'state.json')));
  E.wdLast = T0 + 15000;
  E.watchdogCheck(T0 + 30000);
  ok('...and does not repeat itself every fifteen seconds', E.journalled.filter((x) => x.type === 'WATCHDOG').length === 1, E.journalled.length);

  group('each loop leaves its beat, even when its round fails');
  E = engine();
  E.beat.taker = 0;
  E.refreshQuotes = async () => { throw new Error('network gone'); };
  await E.step();
  ok('a taker cycle that throws still beats', E.beat.taker > 0 && E.stepping === false, E.beat);

  E = engine();
  E.beat.maker = 0;
  E.maker = { step: async () => {}, blockedOnScan: () => false };
  await E.makerRound();
  ok('a maker round beats', E.beat.maker > 0 && E.makerRunning === false, E.beat);

  E = engine();
  E.beat.maker = 0;
  E.maker = { step: async () => { throw new Error('bad book'); }, blockedOnScan: () => false };
  await E.makerRound();
  ok('a maker round that throws still beats, and says so', E.beat.maker > 0 && E.logged.some((t) => /maker cycle error: bad book/.test(t)), { beat: E.beat, log: E.logged });

  E = engine();
  let release, started = 0;
  E.maker = { step: () => { started++; return new Promise((r) => { release = r; }); }, blockedOnScan: () => false };
  E.beat.maker = 0;
  const first = E.makerRound();
  await E.makerRound();
  ok('a round never starts on top of an unfinished one', started === 1, started);
  ok('...and an unfinished round leaves no beat', E.beat.maker === 0, E.beat);
  release(); await first;
  ok('...until it finishes', E.beat.maker > 0);
}

pure();
wiring()
  .catch((e) => { fail++; console.log(`  FAIL  threw: ${e.stack}`); })
  .finally(() => {
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* best effort */ } }
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

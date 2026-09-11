'use strict';
// Assertions for src/engine.js -- the file that owns the cash, the open positions, and the exit.
//
// Every defect below is reachable only in LIVE mode, which is why none of them ever showed up:
// PaperBroker.sell always reports filled === qty and does no I/O, so it can neither partial-fill
// nor be interleaved with itself. A real Kalshi IOC order does both. These run against the real
// Engine with a stubbed broker, a temp data directory, and no network.
//
//   node tools/engine-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine } = require('../src/engine');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Defensive: a regression here means the file is never written at all, and a suite that CRASHES
// instead of reporting a failure is useless as a regression detector.
const readState = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch { return null; } };

const dirs = [];
function engine(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-engine-'));
  dirs.push(dataDir);
  const cfg = { ...base, mode: 'paper', demo: false, dataDir, record: false, makerEnabled: false, ...over };
  const E = new Engine(cfg);
  E.log = () => {};
  E.journal = (_e, type, data) => { (E.journalled = E.journalled || []).push({ type, data }); };
  return E;
}
const position = (over = {}) => ({
  id: 'p1', group: 'g1', pairId: 'pair1', label: 'test pair', venue: 'KS', ref: 'KXTEST-A',
  side: 'yes', qty: 100, entry: 0.60, mark: 0.62, cost: 60.90, fee: 0.90,
  openedAt: Date.now() - 60000, strategy: 'converge', ...over,
});

(async () => {
  group('the operator kill switch survives a restart');
  {
    // The latch stops new risk. It used to live only on the instance, and save() serialises only
    // `this.state` -- so a flatten followed by any restart (fly deploy, --restart=always, a crash)
    // re-armed the desk with nobody having called /api/resume. The maker's halt always persisted,
    // so one operator action left the two desks in opposite states.
    const E = engine();
    E.broker = { sell: async ({ qty, px }) => ({ filled: qty, avg: px, fee: 0, proceeds: qty * px }) };
    E.state.positions = [position()];
    await E.flattenAll('test');
    ok('flatten latches the halt', !!E.operatorHalt, E.operatorHalt);
    const saved = readState(E.cfg.dataDir);
    ok('and writes it through immediately', !!(saved && saved.operatorHalt), saved && saved.operatorHalt);

    const restarted = new Engine({ ...base, mode: 'paper', dataDir: E.cfg.dataDir, record: false, makerEnabled: false });
    ok('a fresh process still finds the desk halted', !!restarted.operatorHalt, restarted.operatorHalt);
    ok('...with the same reason', restarted.operatorHalt === E.operatorHalt, restarted.operatorHalt);

    restarted.maker = { resume: () => {} };
    restarted.log = () => {}; restarted.journal = () => {};
    restarted.resume();
    restarted.save();
    const afterResume = new Engine({ ...base, mode: 'paper', dataDir: E.cfg.dataDir, record: false, makerEnabled: false });
    ok('and resume clears it across a restart too', afterResume.operatorHalt === null, afterResume.operatorHalt);
  }

  group('a partial exit fill is not a close');
  {
    // 30 of 100 sold. The old code spliced the whole position out, credited the 30 lots' proceeds,
    // and booked P&L against the full 100-lot cost -- stranding 70 real contracts with no local
    // record at all: unmarked, uncounted, invisible to the drawdown rail, and past the orphan
    // retry because the position object was gone.
    const E = engine();
    E.broker = { sell: async ({ px }) => ({ filled: 30, avg: px, fee: 0.28, proceeds: 18.32 }) };
    const pos = position();
    E.state.positions = [pos];
    const cash0 = E.state.cash;
    await E.close(pos, 0.62, 'test exit');

    ok('the position is still on the book', E.state.positions.length === 1, E.state.positions.length);
    ok('reduced to what is genuinely still held', pos.qty === 70, pos.qty);
    ok('with its cost basis cut pro-rata', Math.abs(pos.cost - 42.63) < 0.02, pos.cost);
    ok('and flagged stuck so RIGO keeps trying', pos.orphan === true, pos.orphan);
    ok('cash moved by the partial proceeds only', Math.abs(E.state.cash - (cash0 + 18.32)) < 0.005, E.state.cash);
    // the number that used to be catastrophically wrong: -42.35 booked against a full-size cost
    ok('realised P&L is measured against the SOLD slice', Math.abs(E.state.stats.realized - 0.05) < 0.02, E.state.stats.realized);
    ok('nothing was written to the closed book', E.state.closed.length === 0, E.state.closed.length);
    ok('and the journal says partial, not close', (E.journalled || []).some((j) => j.type === 'CLOSE_PARTIAL'), (E.journalled || []).map((j) => j.type));
    ok('...recording what is left', (E.journalled || [])[0].data.remaining === 70, (E.journalled || [])[0].data);
  }

  group('a full fill still closes normally');
  {
    const E = engine();
    E.broker = { sell: async ({ qty, px }) => ({ filled: qty, avg: px, fee: 0.90, proceeds: r(qty * px - 0.90) }) };
    const r = (x) => Math.round(x * 100) / 100;
    const pos = position();
    E.state.positions = [pos];
    await E.close(pos, 0.62, 'test exit');
    ok('the position leaves the book', E.state.positions.length === 0, E.state.positions.length);
    ok('and lands in the closed book once', E.state.closed.length === 1, E.state.closed.length);
    ok('journalled as CLOSE', (E.journalled || []).some((j) => j.type === 'CLOSE'), (E.journalled || []).map((j) => j.type));
  }

  group('one close per position, however many callers arrive');
  {
    // `pos.exitSeq++` and the broker round trip both run before the ownership check, so two
    // entrants each minted a DIFFERENT idempotency key -- which is precisely what defeats the
    // exchange's own de-duplication -- and sent two real sells for the same contracts.
    const E = engine();
    const sells = [];
    E.broker = { sell: async (req) => { sells.push(req.key); await sleep(40); return { filled: req.qty, avg: req.px, fee: 0.9, proceeds: 60.0 }; } };
    const pos = position();
    E.state.positions = [pos];
    await Promise.all([E.close(pos, 0.62, 'a'), E.close(pos, 0.62, 'b')]);
    ok('exactly one sell reached the broker', sells.length === 1, sells);
    ok('so exitSeq advanced once', pos.exitSeq === 1, pos.exitSeq);
    ok('and the book closed once', E.state.closed.length === 1, E.state.closed.length);

    // two concurrent flattens are the same race through a different door
    const E2 = engine();
    const sells2 = [];
    E2.broker = { sell: async (req) => { sells2.push(req.key); await sleep(40); return { filled: req.qty, avg: req.px, fee: 0.9, proceeds: 60.0 }; } };
    E2.maker = { flatten: async () => ({ markets: 0, contracts: 0 }) };
    E2.state.positions = [position()];
    await Promise.all([E2.flattenAll('a'), E2.flattenAll('b')]);
    ok('two concurrent flattens send one sell', sells2.length === 1, sells2);
    ok('and leave the book empty, not short', E2.state.positions.length === 0, E2.state.positions.length);
  }

  group('a close is still retryable after it finishes');
  {
    // the in-flight guard must not latch: a genuinely stuck position is retried every cycle
    const E = engine();
    let n = 0;
    E.broker = { sell: async ({ qty, px }) => { n++; return n === 1 ? { filled: 0, reason: 'no fill' } : { filled: qty, avg: px, fee: 0, proceeds: qty * px }; } };
    const pos = position();
    E.state.positions = [pos];
    await E.close(pos, 0.62, 'first try');
    ok('an unfilled exit flags the position stuck', pos.orphan === true, pos.orphan);
    ok('and leaves it on the book', E.state.positions.length === 1);
    await E.close(pos, 0.62, 'retry');
    ok('the retry is not blocked by the guard', E.state.positions.length === 0, E.state.positions.length);
    ok('and both attempts were counted', pos.exitSeq === 2, pos.exitSeq);
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

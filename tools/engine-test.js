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
const { KETT, RIGO } = require('../src/agents');
const decide = require('../src/decide');
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
// A pair KETT has watched long enough to have an opinion about (decide.gapUnseen), whose gap was
// narrow to begin with so the standing-gap veto does not fire either. Convergence entries need
// both before they are allowed, so any test that drives KETT through one has to supply it.
const watched = (mins = 40) => Array.from({ length: mins + 1 }, (_, i) => ({
  t: Date.now() - (mins - i) * 60000,
  pmMid: 0.50,
  ksMid: i < 5 ? 0.505 : 0.60,   // opened from nothing: exactly the setup the book exists for
}));

const position = (over = {}) => ({
  id: 'p1', group: 'g1', pairId: 'pair1', label: 'test pair', venue: 'KS', ref: 'KXTEST-A',
  side: 'yes', qty: 100, entry: 0.60, mark: 0.62, cost: 60.90, fee: 0.90,
  openedAt: Date.now() - 60000, strategy: 'converge', ...over,
});

(async () => {
  group('a log line can say which positions it is about');
  {
    const E = engine(), log = Engine.prototype.log;
    const quiet = console.log; console.log = () => {};
    log.call(E, 'RIGO', 'RESEARCH', null, 'the gap has not moved', [{ id: 'p1', g: 'g1', label: 'test pair' }]);
    log.call(E, 'RIGO', 'RESEARCH', null, 'nothing named', []);
    log.call(E, 'HOLT', 'SCAN', null, 'as before');
    console.log = quiet;
    ok('the positions ride on the entry', JSON.stringify(E.state.log[2].refs) === JSON.stringify([{ id: 'p1', g: 'g1', label: 'test pair' }]), E.state.log[2]);
    ok('an empty or missing list adds nothing, so every other entry is unchanged', !('refs' in E.state.log[1]) && !('refs' in E.state.log[0]), E.state.log.slice(0, 2));
  }

  group('locked arbs have a settlement scorecard separate from liquidation marks');
  {
    const E = engine();
    E.state.positions = [
      position({ id: 'arb-ks', group: 'locked', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20, cost: 6.20, mark: 0.10, pairId: 'same' }),
      position({ id: 'arb-pm', group: 'locked', strategy: 'arb', venue: 'PM', side: 'no', qty: 20, cost: 12.80, mark: 0.30, pairId: 'same' }),
    ];
    E.state.arbGroups.locked = { pairId: 'same', qty: 20, expectedPayout: 20, status: 'filled' };
    const g = E.arbScorecard()[0];
    const p = E.pnlScorecard();
    ok('a complementary equal-quantity PM/KS pair is valid', g.integrity === 'valid', g);
    ok('settlement P&L uses its $1-per-pair payout', Math.abs(g.lockedPnl - 1) < 0.001, g);
    ok('liquidation P&L remains separate and conservative', Math.abs(g.liquidationPnl + 11) < 0.001, g);
    ok('the API scorecard exposes both totals', p.arbLocked === 1 && p.arbLiquidation === -11, p);
  }

  group('arb integrity failures never claim a locked payout');
  {
    const E = engine();
    E.state.positions = [
      position({ id: 'bad-ks', group: 'bad', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20, cost: 6, pairId: 'same' }),
      position({ id: 'bad-pm', group: 'bad', strategy: 'arb', venue: 'PM', side: 'no', qty: 19, cost: 12, pairId: 'same' }),
    ];
    const g = E.arbScorecard()[0];
    ok('unequal legs raise a quantity mismatch', g.integrity === 'quantity_mismatch', g);
    ok('a broken pair has no locked settlement P&L', g.lockedPnl === null && E.pnlScorecard().integrityAlerts === 1, g);
  }

  group('the dashboard fill feed includes cross-venue entries and closes');
  {
    const E = engine();
    E.state.positions = [position({ id: 'open', openedAt: 300 })];
    E.state.closed = [position({ id: 'done', openedAt: 100, exitAt: 200, exit: 0.50, exitPnl: -10.90, pnl: -10.90, reason: 'stop' })];
    const fills = E.snapshot().takerFills;
    ok('an open position contributes its entry fill', fills.some((f) => f.id === 'open:open' && f.action === 'Opened' && f.px === 0.60), fills);
    ok('a closed position contributes both entry and close fills', fills.some((f) => f.id === 'done:open') && fills.some((f) => f.id === 'done:close' && f.action === 'Closed' && f.pnl === -10.90), fills);
    ok('the combined feed is newest first', fills.map((f) => f.at).join(',') === '300,200,100', fills.map((f) => f.at));
  }

  group('arb intent validation journals the durable group record');
  {
    const E = engine();
    const signal = { pair: { id: 'pair-a', label: 'paired event' } };
    E.createArbGroup(signal, 'intent-a', [{ venue: 'KS', side: 'yes' }, { venue: 'PM', side: 'no' }], ['ks-ref', 'pm-ref'], 10);
    ok('the intended payout is persisted', E.state.arbGroups['intent-a'].expectedPayout === 10, E.state.arbGroups);
    ok('intent and validation are journalled', (E.journalled || []).some((j) => j.type === 'ARB_INTENT') && (E.journalled || []).some((j) => j.type === 'ARB_VALIDATED'), E.journalled);
  }

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

  group("a gain lock's partial sale keeps the runner rather than flagging it stuck");
  {
    // RIGO asks for half on purpose (decide.gainLockIntent) and the broker fills exactly that.
    // Measured against the position's size this read as a stuck exit, and the orphan branch sold
    // the other half at mark on the next cycle -- the runner the feature exists to keep.
    const E = engine();
    E.broker = { sell: async ({ qty, px }) => ({ filled: qty, avg: px, fee: 0.45, proceeds: Math.round((qty * px - 0.45) * 100) / 100 }) };
    const pos = position();
    E.state.positions = [pos];
    await E.close(pos, 0.66, 'gain lock: sold 50, retained 50 runner', false, 50);
    ok('half is still held', E.state.positions.length === 1 && pos.qty === 50, pos.qty);
    ok('and it is NOT flagged stuck', !pos.orphan, pos.orphan);
    ok('the journal says the partial was intended', (E.journalled || []).some((j) => j.type === 'CLOSE_PARTIAL' && j.data.stuck === false), (E.journalled || []).map((j) => j.data));
    // ...while a fill short of what was asked is still stuck, exactly as before
    E.broker = { sell: async ({ px }) => ({ filled: 10, avg: px, fee: 0.09, proceeds: 6.51 }) };
    await E.close(pos, 0.66, 'test exit', false, 25);
    ok('a fill short of the request is stuck', pos.orphan === true && pos.qty === 40, pos);
  }

  group('no sale into a market that is not taking orders');
  {
    // Kalshi halted the cancelled Davis Cup match ("inactive") before settling it at a fair
    // price. The paper broker fills whatever it is asked, so a sell would have booked a sale no
    // exchange could have made. The position waits for settlement instead, and says why.
    const E = engine();
    let asked = 0;
    E.broker = { sell: async ({ qty, px }) => { asked++; return { filled: qty, avg: px, fee: 0, proceeds: qty * px }; } };
    const ks = position({ id: 'k', group: 'gk', ref: 'KXHALTED', strategy: 'arb' });
    const pmPos = position({ id: 'p', group: 'gp', venue: 'PM', pmId: 'm9', tokenIndex: 0, ref: 'tok0', strategy: 'arb' });
    E.state.positions = [ks, pmPos];
    E.quotes.ks.set('KXHALTED', { ticker: 'KXHALTED', status: 'inactive', yesBid: 0.66, yesAsk: 0.70 });
    E.quotes.pm.set('m9', { id: 'm9', closed: true, bestBid: 0.4, bestAsk: 0.5 });
    const r1 = await E.close(ks, 0.30, 'operator: sell');
    const r2 = await E.close(pmPos, 0.40, 'operator: sell');
    ok('the broker is never asked', asked === 0, asked);
    ok('both positions stay on the book, unflagged', E.state.positions.length === 2 && !ks.orphan && !pmPos.orphan, E.state.positions.map((p) => [p.id, p.orphan]));
    ok('and the caller is told why', r1 && /inactive/.test(r1.why) && r2 && /closed/.test(r2.why), [r1, r2]);
    const sold = await E.sellGroup('gk', 'test');
    ok('sellGroup reports the halt rather than a retry', sold.ok === false && sold.remaining === 1 && /inactive/.test(sold.error), sold);
    // a market that IS taking orders, and a settlement, still go through
    E.quotes.ks.set('KXHALTED', { ticker: 'KXHALTED', status: 'active', yesBid: 0.66, yesAsk: 0.70 });
    E.book = async () => ({ asks: [{ price: 0.70, size: 1000 }], yesBid: 0.30, yesAsk: 0.34 });
    await E.close(ks, 0.30, 'operator: sell');
    ok('an active market sells', asked === 1 && !E.state.positions.some((p) => p.id === 'k'), asked);
    E.quotes.pm.set('m9', { id: 'm9', closed: true, bestBid: 0.4, bestAsk: 0.5 });
    await E.close(pmPos, 0.5, 'resolved 50-50', true);
    ok('a settlement never goes to the broker, halted or not', asked === 1 && E.state.positions.length === 0, E.state.positions.length);
  }

  group('a paper sale walks the bids that are actually there');
  {
    // The paper broker filled any size at the mark: unlimited depth at the bid. A sale now walks
    // the other side's asks (this side's bids, mirrored) down to the slip limit, like a buy walks
    // up to its limit, and what does not fill is a stuck partial, retried -- not a full exit at a
    // price nobody was bidding for that many.
    const E = engine();                                   // the real paper broker
    const pos = position({ id: 'w', group: 'gw', ref: 'KXDEEP', qty: 100, entry: 0.20, mark: 0.28, cost: 20.50 });
    E.state.positions = [pos];
    E.quotes.ks.set('KXDEEP', { ticker: 'KXDEEP', status: 'active', yesBid: 0.28, yesAsk: 0.30 });
    // NO asks at 72c and 75c are YES bids at 28c (50 of them) and 25c (500)
    E.book = async (venue, pair, side) => ({ asks: side === 'no' ? [{ price: 0.72, size: 50 }, { price: 0.75, size: 500 }] : [], yesBid: 0.28, yesAsk: 0.30 });
    await E.close(pos, 0.28, 'test exit');
    ok('only the 50 bid at 28c fills inside a 1c slip', pos.qty === 50 && pos.orphan === true, [pos.qty, pos.orphan]);
    const part = (E.journalled || []).find((j) => j.type === 'CLOSE_PARTIAL');
    ok('at the bid, for what was bid', part && Math.abs(part.data.exit - 0.28) < 1e-9 && part.data.sold === 50, part && part.data);
    // the 28c bids are gone; at a 26c mark the 25c level is inside the limit
    E.book = async () => ({ asks: [{ price: 0.75, size: 500 }], yesBid: 0.25, yesAsk: 0.30 });
    await E.close(pos, 0.26, 'retry');
    ok('the rest goes at 25c once the limit reaches it', E.state.positions.length === 0 && Math.abs(E.state.closed[0].exit - 0.25) < 1e-9, E.state.closed[0]);
    // no bids inside the limit at all: nothing sells, the leg is stuck, nothing is booked
    const E3 = engine();
    const p3 = position({ id: 'y', group: 'gy', ref: 'KXTHIN' });
    E3.state.positions = [p3];
    E3.quotes.ks.set('KXTHIN', { ticker: 'KXTHIN', status: 'active', yesBid: 0.50, yesAsk: 0.70 });
    E3.book = async () => ({ asks: [{ price: 0.60, size: 400 }], yesBid: 0.40, yesAsk: 0.70 });   // a 40c bid against a 62c mark
    await E3.close(p3, 0.62, 'test exit');
    ok('no bid inside the limit: stuck, unsold, unbooked', E3.state.positions.length === 1 && p3.orphan === true && E3.state.closed.length === 0 && E3.state.cash === 10000, [p3.orphan, E3.state.cash]);
    // a market the desk has no listing for is sold at the mark in full, as before
    const E2 = engine();
    const p2 = position({ id: 'x', group: 'gx', ref: 'KXNOLIST' });
    E2.state.positions = [p2];
    await E2.close(p2, 0.62, 'test exit');
    ok('no listing, no ladder: filled at the mark in full', E2.state.positions.length === 0 && E2.state.closed[0].exit === 0.62, E2.state.closed);
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

  group('partial exit P&L stays with the group on final close');
  {
    // The group is only scored once its last leg closes. Previously the partial slice was real
    // money in stats.realized but absent from state.closed, so this +2c arb appeared as a loss.
    const E = engine();
    const logs = [];
    E.log = (...args) => logs.push(args);
    let n = 0;
    E.broker = { sell: async ({ qty, px }) => {
      n++;
      if (n === 1) return { filled: 30, avg: px, fee: 0.28, proceeds: 18.32 };
      if (n === 2) return { filled: qty, avg: px, fee: 0, proceeds: 43.00 };
      return { filled: qty, avg: px, fee: 0, proceeds: 60.50 };
    } };
    const first = position({ id: 'a', group: 'arb-partial', strategy: 'arb' });
    const second = position({ id: 'b', group: 'arb-partial', strategy: 'arb' });
    E.state.positions = [first, second];
    await E.close(first, 0.62, 'partial');
    await E.close(first, 0.62, 'final');
    await E.close(second, 0.62, 'final');

    ok('the first closed leg carries its earlier partial P&L', Math.abs(E.state.closed.find((p) => p.id === 'a').pnl - 0.42) < 0.001, E.state.closed);
    ok('the group is scored from all realised slices', E.state.stats.wins === 1 && E.state.stats.losses === 0, E.state.stats);
    ok('the global realised total agrees with the group net', Math.abs(E.state.stats.realized - 0.02) < 0.001, E.state.stats.realized);
    ok('the arb narration reports the complete positive net', logs.some((x) => String(x[3]).includes('arb pair net +$0.02')), logs);
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

  group('an unknown exit waits for reconciliation instead of retrying');
  {
    const E = engine();
    let calls = 0;
    const intent = { action: 'sell', ref: 'KXTEST-A', side: 'yes', qty: 100, clientOrderId: 'unknown-exit' };
    E.broker = { sell: async () => {
      calls++;
      E.state.pendingOrders = [intent]; // the live broker writes this before its POST
      const err = new Error('request response lost');
      err.code = 'KALSHI_ORDER_UNKNOWN'; err.ambiguousOrder = true;
      err.clientOrderId = intent.clientOrderId; err.intent = intent;
      throw err;
    } };
    const pos = position();
    E.state.positions = [pos];
    await E.close(pos, 0.62, 'first try');
    await E.close(pos, 0.62, 'must not retry');
    ok('only the original sell reaches the broker', calls === 1, calls);
    ok('the position is not tagged for RIGO auto-retry', !pos.orphan && pos.pendingExit && pos.pendingExit.clientOrderId === intent.clientOrderId, pos);
    ok('the desk is held out of live entries', E.liveReady === false, E.liveReady);
    ok('the pending marker is synchronously durable', readState(E.cfg.dataDir).positions[0].pendingExit.clientOrderId === intent.clientOrderId, readState(E.cfg.dataDir));
    ok('the uncertainty is journalled explicitly', (E.journalled || []).some((j) => j.type === 'EXIT_UNKNOWN'), E.journalled);
  }

  group('a flatten that lands during KETT book fetch sends no buy');
  {
    const E = engine();
    E.halt = null;
    const pair = { id: 'race-pair', label: 'race pair', pm: { id: 'pm-race' }, ks: { ticker: 'KXRACE' }, q: {} };
    E.signals = [{ pair, type: 'arb', edge: 0.10, gap: 0.10, legs: [{ venue: 'KS', side: 'yes', px: 0.50 }] }];
    let bookStarted, releaseBook;
    const started = new Promise((resolve) => { bookStarted = resolve; });
    E.book = async () => {
      bookStarted();
      return new Promise((resolve) => { releaseBook = resolve; });
    };
    let buys = 0;
    E.broker = { buy: async () => { buys++; return { filled: 10, avg: 0.50, fee: 0, cost: 5 }; } };
    const run = KETT(E);
    await started;
    await E.flattenAll('KETT book race');
    releaseBook({ asks: [{ price: 0.50, size: 100 }], yesBid: 0.49, yesAsk: 0.50 });
    await run;
    ok('the direct operator halt check prevents the pending buy', buys === 0, buys);
    ok('the book remains empty', E.state.positions.length === 0, E.state.positions);
  }

  group('a fill already in flight at flatten is accounted and unwound');
  {
    const E = engine();
    E.halt = null;
    const pair = { id: 'inflight-pair', label: 'inflight pair', pm: { id: 'pm-inflight', tokenId: 'pm-yes', tokenIndex: 0 }, ks: { ticker: 'KXINFLIGHT' }, q: { ksBid: 0.49, ksAsk: 0.50 } };
    E.quotes.pm.set('pm-inflight', { tokenIds: ['pm-yes', 'pm-no'] });
    E.signals = [{ pair, type: 'arb', edge: 0.10, gap: 0.10, legs: [{ venue: 'KS', side: 'yes', px: 0.50 }, { venue: 'PM', side: 'no', px: 0.50 }] }];
    // both legs at 40c: a real arb on the live books, which KETT now re-checks before the first leg
    E.book = async () => ({ asks: [{ price: 0.40, size: 100 }], yesBid: 0.39, yesAsk: 0.40 });
    let releaseBuy, buys = 0, sells = 0;
    const buyStarted = new Promise((resolve) => {
      E.broker = {
        buy: async () => { buys++; resolve(); return new Promise((done) => { releaseBuy = done; }); },
        sell: async ({ qty, px }) => { sells++; return { filled: qty, avg: px, fee: 0, proceeds: qty * px }; },
      };
    });
    const run = KETT(E);
    await buyStarted;
    await E.flattenAll('KETT order race');
    releaseBuy({ filled: 10, avg: 0.50, fee: 0, cost: 5 });
    await run;
    ok('only the buy submitted before flatten reached the broker', buys === 1, buys);
    ok('that known fill is unwound rather than left untracked', sells === 1 && E.state.positions.length === 0, { sells, positions: E.state.positions });
  }

  group('an unknown KETT entry is not unwound or retried');
  {
    const E = engine();
    E.cfg.mode = 'live'; E.liveReady = true; E.halt = null;
    const pair = { id: 'unknown-pair', label: 'unknown pair', pm: { id: 'pm-unknown' }, ks: { ticker: 'KXUNKNOWN' }, q: { pmVol: 1000, ksVol: 1000 } };
    E.history.set('unknown-pair', watched());
    E.signals = [{ pair, type: 'converge', edge: 0.10, gap: 0.10, legs: [{ venue: 'KS', side: 'yes', px: 0.50 }] }];
    E.book = async (venue) => venue === 'PM'
      ? ({ asks: [{ price: 0.80, size: 100 }], yesBid: 0.79, yesAsk: 0.80 })
      : ({ asks: [{ price: 0.50, size: 100 }], yesBid: 0.49, yesAsk: 0.50 });
    let buys = 0, sells = 0;
    const intent = { action: 'buy', ref: 'KXUNKNOWN', side: 'yes', qty: 10, clientOrderId: 'unknown-entry' };
    E.broker = {
      buy: async () => {
        buys++; E.state.pendingOrders = [intent];
        const err = new Error('request response lost');
        err.code = 'KALSHI_ORDER_UNKNOWN'; err.ambiguousOrder = true;
        err.clientOrderId = intent.clientOrderId; err.intent = intent;
        throw err;
      },
      sell: async () => { sells++; return { filled: 0 }; },
    };
    await KETT(E);
    await KETT(E);
    ok('the unknown order is submitted once only', buys === 1, buys);
    ok('no unknown entry is automatically unwound', sells === 0, sells);
    ok('the live desk remains blocked pending reconciliation', E.liveReady === false, E.liveReady);
    ok('the uncertainty is journalled and saved with the broker intent', (E.journalled || []).some((j) => j.type === 'ENTRY_UNKNOWN') && readState(E.cfg.dataDir).pendingOrders[0].clientOrderId === intent.clientOrderId, { journal: E.journalled, saved: readState(E.cfg.dataDir) });
  }

  group('a held arb whose two venues price the outcome far apart is not counted as locked');
  {
    // The live 2026-09-12 case: Kalshi's Everton (EPL) against Polymarket's Everton de Viña del
    // Mar. Perfect shape -- one YES, one NO, one per venue, equal size -- and two different games.
    const legs = (pmOver = {}) => [
      position({ id: 'k', group: 'g', strategy: 'arb', venue: 'KS', ref: 'KXEPL-EVE', side: 'yes', qty: 224, cost: 63.58, mark: 0.26, pairId: 'pr' }),
      position({ id: 'p', group: 'g', strategy: 'arb', venue: 'PM', pmId: 'pmx', tokenIndex: 0, side: 'no', qty: 224, cost: 134.40, mark: 0.19, pairId: 'pr', ...pmOver }),
    ];
    const setup = (ksQ, pmQ, pmOver) => {
      const E = engine();
      E.state.positions = legs(pmOver);
      E.state.arbGroups.g = { pairId: 'pr', qty: 224, expectedPayout: 224, status: 'filled' };
      if (ksQ) E.quotes.ks.set('KXEPL-EVE', ksQ);
      if (pmQ) E.quotes.pm.set('pmx', pmQ);
      return E;
    };

    const bad = setup({ yesBid: 0.02, yesAsk: 0.03 }, { bestBid: 0.99, bestAsk: 1.0 });
    const g = bad.arbScorecard()[0], p = bad.pnlScorecard();
    ok('two venues ~97c apart flag the group', g.integrity === 'venues_disagree', g);
    ok('it reports how far apart', Math.abs(g.venueGap - 0.97) < 0.001, g.venueGap);
    ok('it is not counted as locked profit', g.lockedPnl === null && p.arbLocked === 0, { g, arbLocked: p.arbLocked });
    ok('it raises an integrity alert', p.integrityAlerts === 1, p.integrityAlerts);
    // 224 x (0.26 + 0.19) = 100.80 against 197.98 of cost: it enters the settlement total at -97.18,
    // not at zero.
    ok('the settlement total counts it at liquidation, not at zero', Math.abs(p.totalAtSettlement - (-97.18)) < 0.001 && Math.abs(p.arbUnvouched - (-97.18)) < 0.001, p);

    const good = setup({ yesBid: 0.60, yesAsk: 0.62 }, { bestBid: 0.60, bestAsk: 0.61 });
    const gg = good.arbScorecard()[0];
    ok('venues that agree stay valid and locked', gg.integrity === 'valid' && Math.abs(gg.lockedPnl - 26.02) < 0.001, gg);

    // The design this scorecard exists for: a price that lags or leaves the book is not a loss.
    const blind = setup({ yesBid: 0.02, yesAsk: 0.03 }, null);
    ok('with one market unquoted the check is skipped, not failed', blind.arbScorecard()[0].integrity === 'valid', blind.arbScorecard()[0]);

    // tokenIndex 1: the pair's outcome is Polymarket's SECOND token, so the book must be inverted
    // before comparing. Kalshi 80c YES and Polymarket token-0 at 19/20c are the SAME price.
    const flipped = setup({ yesBid: 0.80, yesAsk: 0.81 }, { bestBid: 0.19, bestAsk: 0.20 }, { tokenIndex: 1 });
    ok('a second-token Polymarket leg is compared in the pair\'s terms', flipped.arbScorecard()[0].integrity === 'valid', flipped.arbScorecard()[0]);
  }

  group('a position whose pair is gone is marked from its own market, not frozen');
  {
    const E = engine();
    E.quotes.ks.set('KA', { yesBid: 0.40, yesAsk: 0.43 });
    E.quotes.pm.set('P0', { bestBid: 0.30, bestAsk: 0.32 });
    E.quotes.pm.set('PNOBOOK', { bestBid: null, bestAsk: null, prices: [0.96, 0.04] });
    E.quotes.ks.set('KCROSSED', { yesBid: 0.50, yesAsk: 0.40 });
    const vm = (o) => E.venueMark(position(o));
    ok('Kalshi YES sells at the bid', vm({ venue: 'KS', ref: 'KA', side: 'yes' }) === 0.40, vm({ venue: 'KS', ref: 'KA', side: 'yes' }));
    ok('Kalshi NO sells at 1 - ask', vm({ venue: 'KS', ref: 'KA', side: 'no' }) === 0.57, vm({ venue: 'KS', ref: 'KA', side: 'no' }));
    ok('Polymarket YES sells at the bid', vm({ venue: 'PM', pmId: 'P0', tokenIndex: 0, side: 'yes' }) === 0.30);
    ok('Polymarket NO sells at 1 - ask', vm({ venue: 'PM', pmId: 'P0', tokenIndex: 0, side: 'no' }) === 0.68);
    ok('a second-token leg inverts the book', vm({ venue: 'PM', pmId: 'P0', tokenIndex: 1, side: 'yes' }) === 0.68);
    ok('a market with no book falls back to its last price', vm({ venue: 'PM', pmId: 'PNOBOOK', tokenIndex: 0, side: 'no' }) === 0.04, vm({ venue: 'PM', pmId: 'PNOBOOK', tokenIndex: 0, side: 'no' }));
    ok('an unquoted market gives no mark rather than a wrong one', vm({ venue: 'KS', ref: 'NOPE', side: 'yes' }) === null);
    ok('a crossed book gives no mark rather than a wrong one', vm({ venue: 'KS', ref: 'KCROSSED', side: 'yes' }) === null);

    // Through RIGO itself: no pair on the board, the market is still quoted.
    const R = engine();
    R.pairs = [];
    R.quotes.ks.set('KXTEST-A', { yesBid: 0.10, yesAsk: 0.12 });
    R.state.positions = [position({ mark: 0.62 })];
    await RIGO(R);
    ok('RIGO re-marks a pairless position from its own venue', R.state.positions[0] && R.state.positions[0].mark === 0.10, R.state.positions[0]);

    const F = engine();
    F.pairs = [];
    F.quotes.ks.set('OTHER', { yesBid: 0.10, yesAsk: 0.12 });   // held market not quoted at all
    F.resolution = async () => null;                              // and not resolved
    F.state.positions = [position({ mark: 0.62 })];
    await RIGO(F);
    ok('with nothing to read it keeps the last mark instead of inventing one', F.state.positions[0].mark === 0.62, F.state.positions[0]);
  }

  group('a decided Kalshi market is left for resolution, not re-pinned');
  {
    // Kalshi says 'finalized' (or 'determined') for a decided market, never 'closed'. Re-pinning it
    // kept it in the quote map, and resolution() only runs for markets missing from the map -- so
    // the tied Tottenham v Everton leg could never settle.
    const ksv = require('../src/venues/kalshi');
    const real = ksv.fetchMarket;
    try {
      const E = engine();
      E.state.positions = [position({ id: 'done', ref: 'KXDONE', mark: 0.27 })];
      ksv.fetchMarket = async () => ({ ticker: 'KXDONE', status: 'finalized', result: 'no', yesBid: 0, yesAsk: 1 });
      await E.pinPositions();
      ok('a finalized market with a result is not pinned', !E.quotes.ks.has('KXDONE'));
      const r = await E.resolution(E.state.positions[0]);
      ok('so resolution() sees it and settles it', r && r.resolved === true && r.yesPx === 0, r);

      const O = engine();
      O.state.positions = [position({ id: 'live', ref: 'KXOPEN' })];
      ksv.fetchMarket = async () => ({ ticker: 'KXOPEN', status: 'active', result: '', yesBid: 0.4, yesAsk: 0.42 });
      await O.pinPositions();
      ok('an open market is still pinned', O.quotes.ks.has('KXOPEN'));
    } finally { ksv.fetchMarket = real; }
  }

  group('settlement is a price, not a winner');
  {
    const ksv = require('../src/venues/kalshi');
    const pmv = require('../src/venues/polymarket');
    const realK = ksv.fetchMarket, realP = pmv.fetchMarket;
    try {
      const K = engine();
      K.state.positions = [position({ id: 'k1', ref: 'KXSV' })];
      ksv.fetchMarket = async () => ({ ticker: 'KXSV', status: 'determined', result: '', settlementValue: 0.35 });
      const rk = await K.resolution(K.state.positions[0]);
      ok('a determined Kalshi market with no yes/no result settles at its settlement value', rk && rk.yesPx === 0.35, rk);
      ksv.fetchMarket = async () => ({ ticker: 'KXSV', status: 'closed', result: '', settlementValue: null });
      const K2 = engine();
      K2.state.positions = [position({ id: 'k2', ref: 'KXSV' })];
      ok('a closed, undecided Kalshi market does not settle', (await K2.resolution(K2.state.positions[0])) === null);

      // Polymarket resolves an ambiguous question 50-50. The old code read that as "NO won".
      const pmPos = (over) => position({ venue: 'PM', ref: 'tok0', pmId: 'm1', tokenIndex: 0, qty: 100, cost: 40, entry: 0.40, mark: 0.40, ...over });
      pmv.fetchMarket = async () => ({ id: 'm1', closed: true, resolved: true, prices: [0.5, 0.5], tokenIds: ['tok0', 'tok1'] });
      const P = engine();
      P.state.positions = [pmPos({ id: 'pmy', side: 'yes' }), pmPos({ id: 'pmn', side: 'no', group: 'g2' })];
      const rp = await P.resolution(P.state.positions[0]);
      ok('a 50-50 Polymarket resolution is a price of 0.5', rp && rp.yesPx === 0.5, rp);
      P.resolutionChecks.clear();   // the direct call above used this minute's check
      await RIGO(P);
      const cy = P.state.closed.find((c) => c.id === 'pmy'), cn = P.state.closed.find((c) => c.id === 'pmn');
      ok('RIGO settles the YES leg at 50c, not $0', cy && cy.exit === 0.5 && /50-50/.test(cy.reason), cy);
      ok('...and the NO leg at 50c, not $1', cn && cn.exit === 0.5, cn);
      pmv.fetchMarket = async () => ({ id: 'm1', closed: true, resolved: true, prices: [0.73, 0.27], tokenIds: ['tok0', 'tok1'] });
      const Q = engine();
      Q.state.positions = [pmPos({ id: 'odd' })];
      ok('a resolved price that is not 0, 0.5 or 1 is left for a person', (await Q.resolution(Q.state.positions[0])) === null);
      pmv.fetchMarket = async () => ({ id: 'm1', closed: true, resolved: true, prices: [0, 1], tokenIds: ['tok0', 'tok1'] });
      const T = engine();
      T.state.positions = [pmPos({ id: 't1', tokenIndex: 1 })];
      ok('the pair\'s YES is read from its own token index', (await T.resolution(T.state.positions[0])).yesPx === 1);

      // A market still in the listing is asked once its Kalshi close has passed.
      const L = engine();
      L.state.positions = [position({ id: 'l1', ref: 'KXLIST' })];
      L.quotes.ks.set('KXLIST', { ticker: 'KXLIST', status: 'active', closeTime: new Date(Date.now() - 60000).toISOString(), yesBid: 0.5, yesAsk: 0.52 });
      ksv.fetchMarket = async () => ({ ticker: 'KXLIST', status: 'finalized', result: 'yes' });
      const rl = await L.resolution(L.state.positions[0]);
      ok('a listed market past its close is checked for resolution', rl && rl.yesPx === 1, rl);
      const A = engine();
      A.state.positions = [position({ id: 'a1', ref: 'KXLIVE' })];
      A.quotes.ks.set('KXLIVE', { ticker: 'KXLIVE', status: 'active', closeTime: new Date(Date.now() + 3600000).toISOString() });
      ok('a listed, active market before its close is not polled', (await A.resolution(A.state.positions[0])) === null);
    } finally { ksv.fetchMarket = realK; pmv.fetchMarket = realP; }
  }

  group('an arb whose first venue has settled is half settled, not broken');
  {
    const E = engine();
    E.state.positions = [position({ id: 'hs-pm', group: 'hs', strategy: 'arb', venue: 'PM', side: 'no', qty: 20, cost: 12.0, mark: 0.99, pairId: 'same' })];
    E.state.closed = [{ ...position({ id: 'hs-ks', group: 'hs', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20, cost: 7.0, pairId: 'same' }), exit: 0, reason: 'resolved NO', pnl: -7 }];
    E.state.arbGroups.hs = { pairId: 'same', qty: 20, expectedPayout: 20, status: 'filled' };
    const g = E.arbScorecard()[0];
    ok('integrity is half_settled', g.integrity === 'half_settled', g);
    ok('the open leg is valued at the complement of what the settled leg paid', g.settlementValue === 20 && Math.abs(g.lockedPnl - 8) < 0.001, g);
    ok('and it raises no integrity alert', E.pnlScorecard().integrityAlerts === 0, E.pnlScorecard());
    const U = engine();
    U.state.positions = [position({ id: 'u-pm', group: 'u', strategy: 'arb', venue: 'PM', side: 'no', qty: 20, cost: 12.0 })];
    U.state.closed = [{ ...position({ id: 'u-ks', group: 'u', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20 }), exit: 0.1, reason: 'unwound: second leg failed', pnl: -1 }];
    ok('a leg closed by an unwind is still an orphan', U.arbScorecard()[0].integrity === 'orphan_leg', U.arbScorecard()[0]);

    // The postponement shape. Kalshi resolves a game "not started within 48 hours" of its scheduled
    // time TO A FAIR PRICE, while Polymarket keeps its market open until the game is actually
    // played. So the Kalshi leg settles at 55c and the Polymarket leg is still a coin flip -- the
    // complement rule would book (1 - 0.55) x 20 as a tidy locked profit on an unhedged position.
    const M = engine();
    M.state.positions = [position({ id: 'm-pm', group: 'm', strategy: 'arb', venue: 'PM', side: 'no', qty: 20, cost: 12.0, mark: 0.5, pairId: 'same' })];
    M.state.closed = [{ ...position({ id: 'm-ks', group: 'm', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20, cost: 7.0, pairId: 'same' }), exit: 0.55, reason: 'resolved at a fair price', pnl: 4 }];
    M.state.arbGroups.m = { pairId: 'same', qty: 20, expectedPayout: 20, status: 'filled' };
    const mg = M.arbScorecard()[0];
    ok('a leg settled at a MID price is not half_settled', mg.integrity === 'settled_midprice', mg);
    ok('...so the group is not vouched for at all', mg.settlementValue === null && mg.lockedPnl === null, mg);
    ok('...and it raises an integrity alert', M.pnlScorecard().integrityAlerts === 1, M.pnlScorecard());
    // What it is demonstrably worth is what it would sell for, which is the Everton rule already
    // in pnlScorecard: an unvouched group enters the settlement total at its liquidation P&L.
    ok('...and enters the totals at liquidation value, not a phantom hedge',
      Math.abs(M.pnlScorecard().arbUnvouched - mg.liquidationPnl) < 0.001, { unvouched: M.pnlScorecard().arbUnvouched, liq: mg.liquidationPnl });
    // The boundary: a leg that settled at 0 or 1 DID answer the outcome, and still vouches.
    for (const exit of [0, 1]) {
      const T = engine();
      T.state.positions = [position({ id: 't-pm', group: 't', strategy: 'arb', venue: 'PM', side: 'no', qty: 20, cost: 12.0, mark: 0.99, pairId: 'same' })];
      T.state.closed = [{ ...position({ id: 't-ks', group: 't', strategy: 'arb', venue: 'KS', side: 'yes', qty: 20, cost: 7.0, pairId: 'same' }), exit, reason: 'resolved', pnl: 0 }];
      T.state.arbGroups.t = { pairId: 'same', qty: 20, expectedPayout: 20, status: 'filled' };
      ok(`a leg settled at ${exit} is still half_settled`, T.arbScorecard()[0].integrity === 'half_settled', T.arbScorecard()[0]);
    }
  }

  group('quotes carry the Polymarket fee rate and positions carry their market\'s close');
  {
    const E = engine();
    E.quotes.pm.set('m1', { id: 'm1', bestBid: 0.40, bestAsk: 0.41, vol24: 1000, feeRate: 0.04, tokenIds: ['t0', 't1'], at: Date.now() });
    E.quotes.ks.set('KX-1', { ticker: 'KX-1', yesBid: 0.45, yesAsk: 0.46, vol24: 1000, at: Date.now() });
    const pair = { id: 'p', label: 'x', pm: { id: 'm1', tokenIndex: 0, tokenId: 't0' }, ks: { ticker: 'KX-1' }, closesAt: 1788900000000, settlesAt: 1788900360000 };
    const q = E.quote(pair);
    ok('the quote is stamped with its market\'s rate', q && q.pmFeeRate === 0.04, q);
    E.quotes.pm.get('m1').feeRate = null;
    ok('a market that does not publish one gets the fallback', E.quote(pair).pmFeeRate === base.pmFeeFallback);
    pair.q = q;
    const pos = E.open({ type: 'converge', pair }, { venue: 'PM', side: 'yes' }, { filled: 10, avg: 0.41, fee: 0.1, cost: 4.2 }, 'grp', 'n');
    ok('a Polymarket position records the rate it was priced at', pos.feeRate === 0.04, pos);
    ok('...and its market\'s close and settlement times', pos.closesAt === 1788900000000 && pos.settlesAt === 1788900360000, pos);
  }

  group('operator sell closes every open leg of one group, and only that group');
  {
    const E = engine();
    E.quotes.ks.set('KA', { yesBid: 0.30, yesAsk: 0.32 });
    E.book = async () => ({ asks: [{ price: 0.70, size: 1000 }], yesBid: 0.30, yesAsk: 0.32 });   // 1000 bid at 30c
    E.state.positions = [
      position({ id: 'a1', group: 'ga', venue: 'KS', ref: 'KA', side: 'yes', qty: 10, cost: 2.7, strategy: 'arb' }),
      position({ id: 'b1', group: 'gb', venue: 'KS', ref: 'KA', side: 'yes', qty: 5, cost: 1.5, strategy: 'arb' }),
    ];
    const r = await E.sellGroup('ga');
    ok('reports the group sold', r.ok && r.sold === 1 && r.remaining === 0, r);
    ok('the other group is untouched', E.state.positions.length === 1 && E.state.positions[0].group === 'gb', E.state.positions);
    const c = E.state.closed.find((x) => x.id === 'a1');
    ok('it sold at its own venue bid', c && c.exit === 0.30, c);
    const none = await E.sellGroup('nope');
    ok('an unknown group is refused, not an error', none.ok === false && /nothing open/.test(none.error), none);
  }

  group('research answers are read even when wrapped in prose');
  {
    const { parseAnswer } = require('../src/research');
    const a = parseAnswer('Here you go:\n```json\n{"action":"Hold","sentence":"It settles at $0 either way.","confidence":"high"}\n```');
    ok('the verdict is pulled out of a fence', a.action === 'hold' && a.sentence === 'It settles at $0 either way.' && a.confidence === 'high', a);
    const c = parseAnswer('{"action":"double down","sentence":"x"}');
    ok('an action outside sell/hold/hedge is dropped, not shown', c.action === null && c.sentence === 'x', c);
    const b = parseAnswer('no json here at all');
    ok('unreadable text becomes a readable fallback, not a throw', b.action === null && /no json/.test(b.sentence), b);
  }

  group('the desk says which commit it is running');
  {
    // On 2026-09-20 a deploy reported success and there was no way to confirm from outside WHICH
    // commit the box ended up on: nothing exposed a build, and the dashboard's "Up 248h" is the
    // ACCOUNT's age, which survives every restart.
    const fresh = engine();
    ok('an unstamped build reports no sha rather than inventing one', fresh.snapshot().build.sha === null, fresh.snapshot().build);
    ok('and still reports when this process booted', Number.isFinite(fresh.snapshot().build.bootedAt), fresh.snapshot().build);
    // The property that matters: a ledger ten days old must still report a boot from moments ago.
    // That difference is the entire reason this field exists -- "Up 248h" through a fresh restart
    // is what made the 2026-09-20 deploy unverifiable from the dashboard.
    const aged = engine();
    aged.state.startedAt = Date.now() - 10 * 86400000;
    const snap = aged.snapshot();
    ok('a ten-day-old account still reports a boot from seconds ago',
      snap.now - snap.build.bootedAt < 60000 && snap.now - snap.startedAt > 9 * 86400000,
      { accountAgeDays: (snap.now - snap.startedAt) / 86400000, bootAgeMs: snap.now - snap.build.bootedAt });

    const stamped = engine({ buildSha: '3ebaa5d927f7743a387e92351066a2e326f60aaa' });
    ok('a stamped build reports its commit', stamped.snapshot().build.sha === '3ebaa5d927f7743a387e92351066a2e326f60aaa', stamped.snapshot().build);

    // The stamp is worthless if the pipeline stops passing it, and neither half is exercised by
    // any other test: the Dockerfile declares the ARG, the deploy supplies it.
    const root = path.join(__dirname, '..');
    const dockerfile = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8');
    ok('the Dockerfile takes GIT_SHA as a build arg', /^ARG GIT_SHA/m.test(dockerfile));
    ok('and puts it in the image environment', /^ENV GIT_SHA=\$GIT_SHA/m.test(dockerfile));
    const wf = fs.readFileSync(path.join(root, '.github', 'workflows', 'test.yml'), 'utf8');
    ok('the deploy passes the commit it is deploying', /flyctl deploy .*--build-arg GIT_SHA=/.test(wf),
      (wf.match(/flyctl deploy.*/) || [])[0]);
  }

  group('the journal names the pair, not just the trade');
  {
    // Without this the journals cannot answer "did the desk re-enter the same pair?" -- the week
    // of 2026-09-10 had to be reconstructed from labels, which cannot distinguish two pairs that
    // share one. `pairId` is what the cooldown is actually keyed on, so it is what gets recorded.
    const E = engine();
    E.state.positions = [position({ pairId: 'pairX', entryGap: 0.039 })];
    await E.close(E.state.positions[0], 0.60, 'max hold 240m reached, gap still 4.0c');
    const close = E.journalled.find((j) => j.type === 'CLOSE');
    ok('a close records the pair it was on', close.data.pairId === 'pairX', close.data);
  }

  group('the re-entry cooldown survives a restart');
  {
    // Until 2026-09-19 this Map lived only in memory, so every deploy and every watchdog restart
    // re-armed each pair the desk had just closed. Six of that week's twenty-four re-entries
    // inside the window happened that way and lost $151 between them.
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-cooldown-'));
    dirs.push(dataDir);
    const cfg = { ...base, mode: 'paper', demo: false, dataDir, record: false, makerEnabled: false };
    const E = new Engine(cfg);
    E.log = () => {}; E.journal = () => {};
    E.state.positions = [position({ pairId: 'pairX' })];
    await E.close(E.state.positions[0], 0.60, 'max hold 240m reached, gap still 4.0c');
    ok('closing sets the bar', E.cooldown.get('pairX') > 0, [...E.cooldown]);
    E.save();
    ok('and the bar is written to the ledger', readState(dataDir).cooldown.pairX > 0, readState(dataDir).cooldown);

    const back = new Engine(cfg);
    back.log = () => {}; back.journal = () => {};
    ok('a restart comes back still holding it', back.cooldown.get('pairX') > 0, [...back.cooldown]);
    ok('so KETT would still refuse the pair',
      Date.now() - back.cooldown.get('pairX') < cfg.reentryCooldownMs);

    // ...but a bar older than the window is dead weight, not a permanent ban.
    const stale = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    stale.cooldown = { pairX: Date.now() - cfg.reentryCooldownMs - 1000, pairY: Date.now() };
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(stale));
    const aged = new Engine(cfg);
    aged.log = () => {}; aged.journal = () => {};
    ok('an expired bar is dropped on the way in', !aged.cooldown.has('pairX'), [...aged.cooldown]);
    ok('a live one beside it is kept', aged.cooldown.get('pairY') > 0, [...aged.cooldown]);
    aged.save();
    ok('and the expired bar does not come back on the next save',
      !('pairX' in readState(dataDir).cooldown), readState(dataDir).cooldown);

    // A ledger written before this shipped has no cooldown key at all.
    const older = JSON.parse(fs.readFileSync(path.join(dataDir, 'state.json'), 'utf8'));
    delete older.cooldown;
    fs.writeFileSync(path.join(dataDir, 'state.json'), JSON.stringify(older));
    const legacy = new Engine(cfg);
    ok('an older ledger without the key still starts', legacy.cooldown.size === 0, [...legacy.cooldown]);
  }

  group('the once-per-interval timers do not pile up');
  {
    const E = engine();
    const now = Date.now();
    E.timers = { 'exit-book-longgone': now - 2 * 86400000, 'pin-current': now - 30000 };
    ok('a name asked about again inside its interval is still not due', E.due('pin-current', 60) === false);
    ok('a name untouched for a day is dropped; one in use is kept', !('exit-book-longgone' in E.timers) && 'pin-current' in E.timers, Object.keys(E.timers));
    E.timers['exit-book-another'] = now - 2 * 86400000;
    E.due('pin-current', 60);
    ok('the sweep itself runs once an hour, not on every question', 'exit-book-another' in E.timers, Object.keys(E.timers));
  }

  group('the Polymarket listing is re-read every PM_LIST_EVERY_SEC, and a pair is only as fresh as its CLOB price');
  {
    const pmv = require('../src/venues/polymarket'), ksv = require('../src/venues/kalshi');
    const saved = { fu: pmv.fetchUniverse, fp: pmv.fetchPrices, fa: ksv.fetchAll, ft: ksv.fetchMarketsByTickers };
    let lists = 0, listFails = false, clob = new Map(), clobFails = false;
    pmv.fetchUniverse = async () => {
      lists++;
      if (listFails) throw new Error('gamma down');
      return [{ id: 'm1', tokenIds: ['t0', 't1'], bestBid: 0.40, bestAsk: 0.42, vol24: 1000 }];
    };
    pmv.fetchPrices = async () => { if (clobFails) throw new Error('clob down'); return clob; };
    ksv.fetchAll = async () => [{ ticker: 'KXA', yesBid: 0.4, yesAsk: 0.42, vol24: 10 }];
    ksv.fetchMarketsByTickers = async () => [];
    try {
      const E = engine({ pmListEverySec: 120 });
      await E.refreshQuotes();
      const first = E.quotes.pm.get('m1'), listedAt = first.at;
      ok('the first cycle reads the listing', lists === 1 && first && E.lastQuoteAt > 0, lists);
      E.quotes.pm.set('pinned', { id: 'pinned' });            // what pinPositions / any.inject add
      await E.refreshQuotes();
      ok('the next cycle inside the interval does not', lists === 1, lists);
      ok('...and rebuilds the map from the same listed objects, dropping last cycle\'s additions',
        E.quotes.pm.get('m1') === first && !E.quotes.pm.has('pinned'), [...E.quotes.pm.keys()]);
      ok('a reused listing keeps the time it was fetched', E.quotes.pm.get('m1').at === listedAt);
      const before = E.lastQuoteAt; await sleep(5); await E.refreshQuotes();
      ok('a reused listing is not a failure: the desk-wide data age still advances', E.lastQuoteAt > before);

      E.pairs = [{ id: 'pA', pm: { id: 'm1', tokenId: 't1', tokenIndex: 1 }, ks: { ticker: 'KXA' } }];
      clob = new Map([['t1', { bid: 0.57, ask: 0.59 }]]);
      await sleep(5); await E.refreshPairPrices();
      const m = E.quotes.pm.get('m1');
      ok('a CLOB price on token 1 is written back in token-0 terms', Math.abs(m.bestBid - 0.41) < 1e-9 && Math.abs(m.bestAsk - 0.43) < 1e-9, m);
      ok('...and stamps the market with when that price arrived', m.at > listedAt, m.at - listedAt);
      const stamped = m.at;
      clob = new Map();
      await sleep(5); await E.refreshPairPrices();
      ok('a token the CLOB did not answer for keeps its old stamp', m.at === stamped);
      clobFails = true;
      await E.refreshPairPrices();
      ok('a failed CLOB call moves no stamp either', m.at === stamped);
      clobFails = false;

      E.pmList.at -= 121 * 1000;
      listFails = true;
      const kept = E.quotes.pm, lastBefore = E.lastQuoteAt;
      await E.refreshQuotes();
      ok('a due listing is read; a failed one leaves the map alone and does not advance the data age',
        lists === 2 && E.quotes.pm === kept && E.lastQuoteAt === lastBefore, { lists });
      await E.refreshQuotes();
      ok('...and is tried again on the very next cycle', lists === 3, lists);
      listFails = false;
      await E.refreshQuotes();
      ok('a successful re-read replaces the listing with new objects stamped now',
        lists === 4 && E.quotes.pm.get('m1') !== first && E.quotes.pm.get('m1').at >= E.pmList.at, lists);

      const every = engine({ pmListEverySec: 0 });
      lists = 0;
      await every.refreshQuotes(); await every.refreshQuotes();
      ok('PM_LIST_EVERY_SEC=0 reads it every cycle, as before', lists === 2, lists);
    } finally {
      pmv.fetchUniverse = saved.fu; pmv.fetchPrices = saved.fp; ksv.fetchAll = saved.fa; ksv.fetchMarketsByTickers = saved.ft;
    }
  }

  group('the Kalshi fast listing is re-read every KS_LIST_EVERY_SEC; the markets priced from it are repriced by ticker every cycle');
  {
    const pmv = require('../src/venues/polymarket'), ksv = require('../src/venues/kalshi');
    const saved = { fu: pmv.fetchUniverse, fp: pmv.fetchPrices, fa: ksv.fetchAll, ft: ksv.fetchMarketsByTickers };
    let lists = 0, asked = [], answer = [], tickFails = false;
    pmv.fetchUniverse = async () => [];
    pmv.fetchPrices = async () => new Map();
    ksv.fetchAll = async () => {
      lists++;
      return ['KXA', 'KXB', 'KXC', 'KXIDLE'].map((ticker) => ({ ticker, status: 'active', yesBid: 0.40, yesAsk: 0.42, vol24: 10 }));
    };
    ksv.fetchMarketsByTickers = async (tickers) => { asked.push([...tickers].sort()); if (tickFails) throw new Error('kalshi down'); return answer; };
    try {
      const E = engine({ ksListEverySec: 120 });
      await E.refreshQuotes();
      const a = E.quotes.ks.get('KXA'), listedAt = a.at;
      await E.refreshQuotes();
      ok('the listing is read once inside the interval', lists === 1, lists);
      ok('...and the map is rebuilt from the same objects', E.quotes.ks.get('KXA') === a && E.quotes.ks.size === 4, E.quotes.ks.size);

      E.pairs = [
        { id: 'p1', pm: { id: 'x' }, ks: { ticker: 'KXA' } },
        { id: 'p2', pm: { id: 'y' }, ks: { ticker: 'KXB' } },
        { id: 'p3', pm: { id: 'z' }, ks: { ticker: 'KXANY' } },   // an any-market pair: not in this listing
      ];
      E.state.positions = [{ id: 'l1', venue: 'KS', ref: 'KXC' }, { id: 'l2', venue: 'PM', pmId: 'x' }];
      answer = [
        { ticker: 'KXA', status: 'active', yesBid: 0.55, yesAsk: 0.57, vol24: 99 },
        { ticker: 'KXB', status: 'determined', yesBid: 1, yesAsk: 1, vol24: 0 },
        { ticker: 'KXC', status: 'active', yesBid: 0.2, yesAsk: 0.21, vol24: 5 },
      ];
      await sleep(5); await E.refreshPairPrices();
      ok('it asks for the fast pairs and the open Kalshi legs, and nothing else', JSON.stringify(asked[0]) === JSON.stringify(['KXA', 'KXB', 'KXC']), asked);
      ok('a repriced market takes the new price and volume, stamped now',
        a.yesBid === 0.55 && a.yesAsk === 0.57 && a.vol24 === 99 && a.at > listedAt, a);
      ok('...and so does an open leg with no pair', E.quotes.ks.get('KXC').yesBid === 0.2);
      ok('a market no longer active leaves the map at once, and the listing with it',
        !E.quotes.ks.has('KXB') && !E.ksList.tickers.has('KXB') && !E.ksList.markets.some((m) => m.ticker === 'KXB'));
      ok('a listed market nobody prices is left alone', E.quotes.ks.get('KXIDLE').at === listedAt);
      await E.refreshQuotes();
      ok('...and stays gone when the map is rebuilt from the listing', !E.quotes.ks.has('KXB') && E.quotes.ks.has('KXA'));

      const stamped = a.at;
      answer = [];
      await sleep(5); await E.refreshPairPrices();
      ok('a ticker the call did not answer for keeps its old stamp', a.at === stamped);
      tickFails = true;
      await E.refreshPairPrices();
      ok('a failed call moves no stamp and removes nothing', a.at === stamped && E.quotes.ks.has('KXA'));
      tickFails = false;

      E.pairs = [{ id: 'p3', pm: { id: 'z' }, ks: { ticker: 'KXANY' } }];
      E.state.positions = [];
      asked = [];
      await E.refreshPairPrices();
      ok('with nothing from this listing to price, no call is made', asked.length === 0, asked);

      E.ksList.at -= 121 * 1000;
      await E.refreshQuotes();
      ok('a due listing is read again, with fresh objects', lists === 2 && E.quotes.ks.get('KXA') !== a && E.quotes.ks.has('KXB'), lists);
      const every = engine({ ksListEverySec: 0 });
      lists = 0;
      await every.refreshQuotes(); await every.refreshQuotes();
      ok('KS_LIST_EVERY_SEC=0 reads it every cycle, as before', lists === 2, lists);
    } finally {
      pmv.fetchUniverse = saved.fu; pmv.fetchPrices = saved.fp; ksv.fetchAll = saved.fa; ksv.fetchMarketsByTickers = saved.ft;
    }
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  group('the settlement snipe goes through KETT as a one-leg Kalshi buy');
  {
    const E = engine({ snipe: true, snipeMaxQty: 100 });
    E.halt = null;   // TESS has not run; the existing KETT cases clear this the same way
    const now = Date.now();
    const pair = { id: 'pm9:0|KXNFLGAME-T-MIN', label: 'NFL test · Vikings', kind: 'game', series: 'KXNFLGAME', inPlay: true, startsAt: now - 3 * 3600000,
      pm: { id: 'pm9', tokenIndex: 0 }, ks: { ticker: 'KXNFLGAME-T-MIN' },
      q: { pmBid: 0.99, pmAsk: 1, ksBid: 0.82, ksAsk: 0.86, pmMid: 0.995, ksMid: 0.84, pmVol: 1e6, ksVol: 1e6, pmFeeRate: 0.05, t: now, pmAt: now, ksAt: now, ksBidSize: 200, ksAskSize: 300 } };
    E.pairs = [pair];
    const s = decide.snipeSignal(pair, E.cfg, now);
    E.signals = [s];
    E.book = async () => ({ asks: [{ price: 0.86, size: 40 }, { price: 0.87, size: 500 }], yesBid: 0.82, yesAsk: 0.86 });
    await KETT(E);
    const pos = E.state.positions[0];
    ok('a YES position opens on Kalshi, strategy snipe, capped at SNIPE_MAX_QTY', pos && pos.venue === 'KS' && pos.side === 'yes' && pos.strategy === 'snipe' && pos.qty === 100, pos);
    ok('filled up the ask ladder: 40 at 86c and 60 at 87c', pos && Math.abs(pos.entry - (40 * 0.86 + 60 * 0.87) / 100) < 1e-6, pos && pos.entry);
    ok('the journal names the strategy', (E.journalled || []).some((j) => j.type === 'OPEN' && j.data.strategy === 'snipe'));
    // the live book has moved to par since the listing: no trade
    const E2 = engine({ snipe: true });
    E2.halt = null;
    E2.pairs = [pair]; E2.signals = [decide.snipeSignal(pair, E2.cfg, now)];
    E2.book = async () => ({ asks: [{ price: 0.99, size: 500 }], yesBid: 0.98, yesAsk: 0.99 });
    await KETT(E2);
    ok('a live book already at 99c: nothing bought', E2.state.positions.length === 0 && E2.state.cash === 10000, E2.state.positions);
    // Polymarket then closes the market: HOLT-style, the pair is kept and quote() keeps its Kalshi side live
    const E3 = engine({ snipe: true });
    E3.quotes.ks.set('KXNFLGAME-T-MIN', { ticker: 'KXNFLGAME-T-MIN', status: 'active', yesBid: 0.85, yesAsk: 0.88, yesBidSize: 10, yesAskSize: 70, vol24: 1, at: now + 15000 });
    const kept = decide.keepClosedGamePairs(new Map([[pair.id, pair]]), [], E3.cfg, now + 15000)[0];
    const q = E3.quote(kept);
    ok('the kept pair quotes: Polymarket\'s last 99/100, Kalshi\'s new 85/88, with Kalshi\'s own time and sizes', q && q.pmBid === 0.99 && q.pmAsk === 1 && q.ksBid === 0.85 && q.ksAsk === 0.88 && q.ksAt === now + 15000 && q.ksAskSize === 70 && q.pmAt === now, q);
    ok('...and it still says snipe', (decide.snipeSignal({ ...kept, q }, E3.cfg, now + 15000) || {}).type === 'snipe');
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

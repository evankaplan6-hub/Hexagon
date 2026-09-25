'use strict';
// The stocks, crypto and options desk (src/desk/): the market calendar, the feed parsers, paper fills,
// both books' rules, and whole rounds of the engine on a fake market -- a crypto and SPY rebalance,
// and one options trend day from the 12:30 test to the last exit. No network, no clock.
const fs = require('fs');
const os = require('os');
const path = require('path');
const clock = require('../src/desk/clock');
const F = require('../src/desk/feeds');
const broker = require('../src/desk/broker');
const B = require('../src/desk/books');
const { Desk } = require('../src/desk/engine');
const { upDay, deskConfig, fakeMarket } = require('./desk-fixture');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), got);
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

// ------------------------------------------------------------------ the calendar
{
  const t = Date.parse('2026-09-25T20:11:36Z');       // a Friday, 4:11 PM Eastern (EDT)
  eq('an instant reads as its Eastern date and minute', clock.et(t), { day: '2026-09-25', min: 16 * 60 + 11, sec: 36, wd: 5 });
  eq('an Eastern wall time in summer is UTC-4', new Date(clock.etToUtc('2026-09-25T09:31:00')).toISOString(), '2026-09-25T13:31:00.000Z');
  eq('and in winter UTC-5', new Date(clock.etToUtc('2026-12-01T09:30:00')).toISOString(), '2026-12-01T14:30:00.000Z');
  eq('a space instead of a T is read the same', clock.etToUtc('2026-09-25 09:31:00'), clock.etToUtc('2026-09-25T09:31:00'));
  eq('an hour that does not exist (spring forward) is null', clock.etToUtc('2027-03-14T02:30:00'), null);
  eq('garbage is null', clock.etToUtc('yesterday'), null);
  ok('a weekday trades', clock.isTradingDay('2026-09-25'));
  ok('a Saturday does not', !clock.isTradingDay('2026-09-26'));
  ok('Thanksgiving does not', !clock.isTradingDay('2026-11-26'));
  eq('the day after Thanksgiving closes at 1 PM', clock.session('2026-11-27'), { open: 570, close: 780, early: true });
  eq('a normal day closes at 4', clock.session('2026-09-24'), { open: 570, close: 960, early: false });
  ok('open at 10 AM on a Friday', clock.isOpen(clock.etToUtc('2026-09-25T10:00:00')));
  ok('closed at 9:29', !clock.isOpen(clock.etToUtc('2026-09-25T09:29:00')));
  ok('closed at 4:00 exactly', !clock.isOpen(clock.etToUtc('2026-09-25T16:00:00')));
  ok('closed on a Saturday afternoon', !clock.isOpen(clock.etToUtc('2026-09-26T12:00:00')));
  eq('the trading day before a Monday is the Friday', clock.prevTradingDay('2026-09-28'), '2026-09-25');
  eq('the trading day before the Tuesday after Labor Day skips the holiday', clock.prevTradingDay('2026-09-08'), '2026-09-04');
  eq('after Friday\'s close the next open is Monday 9:30', new Date(clock.nextOpen(t).at).toISOString(), '2026-09-28T13:30:00.000Z');
  eq('the next open said in words, from a Friday evening', clock.describe(t), 'opens Mon 9:30 AM ET');
  eq('before the bell on a trading day', clock.describe(clock.etToUtc('2026-09-24T08:00:00')), 'opens today 9:30 AM ET');
  eq('during the session', clock.describe(clock.etToUtc('2026-09-24T11:00:00')), 'open until 4:00 PM ET');
  ok('the calendar covers 2027', clock.calendarCovers('2027-06-01'));
  ok('and says so past its last year', !clock.calendarCovers('2028-01-03'));
}

// ------------------------------------------------------------------ the feeds
{
  const tk = F.parseCoinbaseTicker({ ask: '83944.32', bid: '83944.31', volume: '7195.7', price: '83944.32', time: '2026-09-25T20:08:00.233Z' });
  eq('a Coinbase ticker', tk, { bid: 83944.31, ask: 83944.32, last: 83944.32, at: Date.parse('2026-09-25T20:08:00.233Z'), vol24: 7195.7 });
  eq('a crossed book is not a price', F.parseCoinbaseTicker({ bid: '10', ask: '9' }), null);
  eq('an error body is not a price', F.parseCoinbaseTicker({ message: 'NotFound' }), null);
  const now = Date.parse('2026-09-25T20:00:00Z'), d0 = Date.parse('2026-09-25T00:00:00Z') / 1000;
  const cs = F.parseCoinbaseCandles([[d0, 1, 3, 2, 2.5, 10], [d0 - 86400, 1, 3, 2, 2.2, 9], [d0 - 2 * 86400, 1, 3, 2, 2.1, 8]], now);
  eq('candles come back oldest first, and today\'s forming candle is left out', cs.map((c) => [c.day, c.c]), [['2026-09-23', 2.1], ['2026-09-24', 2.2]]);
  const book = F.parseCoinbaseBook({ bids: [['100', '0.5', 3], ['99', '2', 1]], asks: [['101', '0.25', 1], ['bad', '1', 1]] });
  eq('a level-2 book, bad rows dropped', book, { bids: [{ price: 100, size: 0.5 }, { price: 99, size: 2 }], asks: [{ price: 101, size: 0.25 }] });

  const q = F.parseCboeQuote({ timestamp: '2026-09-25 20:05:28', data: { symbol: 'SPY', current_price: 772.08, bid: 772.08, ask: 772.1, bid_size: 240, ask_size: 400, open: 768.79, high: 772.22, low: 766.29, prev_day_close: 767.18, volume: 26249321, last_trade_time: '2026-09-25T15:50:26' } });
  eq('the quote is FROM its last trade, an Eastern time', new Date(q.at).toISOString(), '2026-09-25T19:50:26.000Z');
  eq('the file time is UTC', new Date(q.fileAt).toISOString(), '2026-09-25T20:05:28.000Z');
  eq('bid, ask and the previous close', [q.bid, q.ask, q.prevClose, q.last], [772.08, 772.1, 767.18, 772.08]);
  eq('a quote with no price is null', F.parseCboeQuote({ data: { symbol: 'SPY' } }), null);

  const bar = (dt, c, v = 1000) => ({ datetime: dt, price: { open: c, high: c + 0.1, low: c - 0.1, close: c }, volume: { stock_volume: v } });
  const intra = F.parseCboeIntraday({ data: [bar('2026-09-25T09:31:00', 100), bar('2026-09-25T09:32:00', 101)] });
  eq('Cboe labels a minute bar by its END: 09:31 is the first bar of the day', intra.bars.map((b) => b.m), [571, 572]);
  eq('and the day it belongs to', intra.day, '2026-09-25');

  // five-minute bars: labelled by their start, and only once all five minutes are in
  const ones = [];
  for (let m = 571; m <= 582; m++) ones.push({ m, o: m, h: m + 0.5, l: m - 0.5, c: m + 0.25, v: 10 });
  const fives = F.fiveMinute(ones);
  eq('09:31..09:35 make the 9:30 bar, 09:36..09:40 the 9:35 bar; 09:41-09:42 are not a bar yet', fives.map((b) => b.m), [570, 575]);
  eq('the 9:30 bar: first open, highest high, lowest low, last close, summed volume', fives[0], { m: 570, o: 571, h: 575.5, l: 570.5, c: 575.25, v: 50 });
  eq('a bar with a minute missing is not a bar', F.fiveMinute(ones.filter((b) => b.m !== 573)).map((b) => b.m), [575]);
  const vw = F.vwapSeries([{ h: 11, l: 9, c: 10, v: 100 }, { h: 21, l: 19, c: 20, v: 300 }]);
  eq('VWAP weights the typical price by volume', vw, [10, 17.5]);

  const daily = [];
  for (let i = 0; i < 20; i++) daily.push({ day: `2026-08-${String(i + 1).padStart(2, '0')}`, o: 100, h: 103, l: 97, c: 100 });
  near('ATR14: the mean of the last 14 true ranges', F.atr14(daily, '2026-09-01').atr, 6);
  eq('as of the last bar before the day', F.atr14(daily, '2026-08-20').asof, '2026-08-19');
  eq('fewer than 15 bars: no ATR', F.atr14(daily.slice(0, 14), '2026-09-01'), null);
  const gap = daily.map((b, i) => (i === 19 ? { ...b, h: 115, l: 110, c: 112 } : b));
  near('a gap counts from the previous close', F.atr14(gap, '2026-09-01').atr, (13 * 6 + 15) / 14);
  near('realised vol of alternating +-1%: the stdev, annualised', F.realizedVol([100, 101, 100, 101, 100], 4, 252), Math.sqrt((4 * Math.log(1.01) ** 2) / 3) * Math.sqrt(252), 1e-9);
  eq('realised vol needs n+1 closes', F.realizedVol([100, 101], 4, 252), null);

  const chain = F.parseCboeExpiry({ timestamp: '2026-09-25 17:00:00', data: { current_price: 703.7, last_trade_time: '2026-09-25T12:45:00', options: [
    { option: 'SPY260925C00705000', bid: 0.09, ask: 0.1, bid_size: 50, ask_size: 60, high: 0.4 },
    { option: 'SPY260925C00704000', bid: 0.2, ask: 0.21 },
    { option: 'SPY260925P00702000', bid: 0.3, ask: 0.31 },
    { option: 'SPY260926C00705000', bid: 1, ask: 1.1 },
  ] } }, '2026-09-25');
  eq('one expiry, calls and puts, calls by strike', [chain.calls.map((c) => c.strike), chain.puts.map((c) => c.strike)], [[704, 705], [702]]);
  eq('a row keeps its size and its day high', [chain.calls[1].askSz, chain.calls[1].high], [60, 0.4]);
}

// ------------------------------------------------------------------ paper fills
{
  const fees = { cryptoBps: 40, stockBps: 0, optionPerContract: 0.03 };
  const book = { bids: [{ price: 100, size: 1 }, { price: 99, size: 5 }], asks: [{ price: 101, size: 1 }, { price: 102, size: 5 }] };
  const b = broker.fill({ kind: 'crypto', side: 'buy', qty: 2 }, { bid: 100, ask: 101, book }, fees);
  eq('a crypto buy walks the asks: one at 101, one at 102', [b.qty, b.avg, b.notional], [2, 101.5, 203]);
  near('plus 0.40% of the notional', b.fee, 0.81, 0.001);
  near('cash out is notional plus fee', b.cash, -203.81, 0.001);
  const s = broker.fill({ kind: 'crypto', side: 'sell', qty: 1.5 }, { bid: 100, ask: 101, book }, fees);
  eq('a crypto sale walks the bids down', [s.qty, s.avg, s.notional], [1.5, 99.666667, 149.5]);
  const capped = broker.fill({ kind: 'crypto', side: 'buy', qty: 10, cash: 150 }, { bid: 100, ask: 101, book }, fees);
  ok('a buy never spends more than the cash, fee included', capped.qty > 0 && -capped.cash <= 150, capped);
  ok('and spends most of it', -capped.cash > 149, capped);
  const st = broker.fill({ kind: 'stock', side: 'buy', qty: 3.3336 }, { bid: 700, ask: 700.02 }, fees);
  eq('a stock buy fills at the ask in fractional shares, no commission', [st.qty, st.avg, st.fee], [3.333, 700.02, 0]);
  const op = broker.fill({ kind: 'option', side: 'buy', qty: 5 }, { bid: 0.09, ask: 0.1, askSz: 2 }, fees);
  eq('an option buy: capped at the size shown, 100 shares a contract, $0.03 a contract', [op.qty, op.notional, op.fee, op.cash], [2, 20, 0.06, -20.06]);
  eq('no ask is no fill', broker.fill({ kind: 'option', side: 'buy', qty: 1 }, { bid: 0, ask: null }, fees).qty, 0);
  eq('nothing to trade', broker.fill({ kind: 'stock', side: 'buy', qty: 0.0001 }, { bid: 1, ask: 1 }, fees).reason, 'nothing to trade');
  eq('not enough cash for one contract', broker.fill({ kind: 'option', side: 'buy', qty: 1, cash: 5 }, { bid: 0.1, ask: 0.1 }, fees).reason, 'not enough cash');
}

// ------------------------------------------------------------------ the rules
{
  const alt = (n, a, start = 100) => { const c = [start]; for (let i = 0; i < n; i++) c.push(c[c.length - 1] * Math.exp(i % 2 ? -a : a)); return c; };
  const v = B.volTargetWeight(alt(30, 0.03), { target: 0.4, lookback: 30, perYear: 365 });
  const sd = Math.sqrt((30 * 0.03 * 0.03 - 30 * (0 ** 2)) / 29) * Math.sqrt(365);
  near('volatility: alternating 3% moves', v.vol, sd, 1e-9);
  near('weight is target / vol', v.w, 0.4 / sd, 1e-9);
  eq('a calm market is held in full, never more', B.volTargetWeight(alt(30, 0.001), { target: 0.4, lookback: 30, perYear: 365 }).w, 1);
  eq('not enough closes: no weight', B.volTargetWeight(alt(10, 0.01), { target: 0.4, lookback: 30, perYear: 365 }), null);
  ok('the first target always trades', B.needsRebalance(0.7, null, 0.1));
  ok('a 5-point move does not', !B.needsRebalance(0.75, 0.7, 0.1));
  ok('a 10-point move does', B.needsRebalance(0.8, 0.7, 0.1));
  ok('back to full size does, however small', B.needsRebalance(1, 0.97, 0.1));
  ok('full to full does not', !B.needsRebalance(1, 1, 0.1));
}

// the 12:30 test and the trigger, on a made-up up day: a steady climb from 700 (tools/desk-fixture.js)
{
  const bars = F.fiveMinute(upDay()), vw = F.vwapSeries(bars);
  eq('9:30 to 12:25 is 36 five-minute bars', bars.length, 36);
  const r = B.trendTest(bars, vw, 6);
  eq('a steady climb of 3.6 points on a 6-point ATR passes', [r.status, r.dir], ['pass', 'up']);
  near('0.6 ATR', r.moveAtr, 0.6, 0.01);
  eq('half an ATR is the bar: 7.3 fails', B.trendTest(bars, vw, 7.3).status, 'fail');
  ok('and says why', /needs 0.5/.test(B.trendTest(bars, vw, 7.3).why));
  eq('no ATR: no verdict', B.trendTest(bars, vw, null).status, 'none');
  eq('before the 12:25 bar is in: wait', B.trendTest(bars.slice(0, 30), vw, 6).status, 'wait');
  const holed = bars.filter((b) => b.m !== 600);
  eq('a bar missing: no verdict', B.trendTest(holed, F.vwapSeries(holed), 6).status, 'none');
  // gave back more than half of the move by 12:30
  const back = F.fiveMinute(upDay({ drops: { 700: 706, 740: 702.5 } })), bvw = F.vwapSeries(back);
  const rb = B.trendTest(back, bvw, 3);
  eq('a spike that gave most of it back fails', rb.status, 'fail');
  ok('on the giveback', /gave back/.test(rb.why), rb.why);

  // the trigger: the 12:30 bar closes at a new high above VWAP
  const more = F.fiveMinute(upDay({ to: 12 * 60 + 35 })), mvw = F.vwapSeries(more);
  const t0 = B.trendTest(more, mvw, 6);
  const s = B.scanEntry(more, mvw, 'up', t0.idx, t0.ext);
  eq('the next bar closing at a new high triggers', s.hit && s.hit.m, 750);
  // a bar that pokes a new high but closes under the old one does not, and its high becomes the bar to beat
  const flat = more.map((b) => ({ ...b }));
  flat[36] = { ...flat[36], h: t0.ext + 1, c: t0.ext - 0.05 };
  const s2 = B.scanEntry(flat, F.vwapSeries(flat), 'up', t0.idx, t0.ext);
  eq('a close under the old high is not a trigger', s2.hit, null);
  near('but its high raises the extreme', s2.ext, t0.ext + 1, 1e-9);
  const late = [...more.slice(0, 36), ...[885, 890].map((m) => ({ m, o: 710, h: 711, l: 709, c: 710.5, v: 1000 }))];
  eq('nothing after the 2:40 bar (it closes 2:45) triggers', B.scanEntry(late, F.vwapSeries(late), 'up', 35, t0.ext).hit, null);
  ok('a close back under VWAP is the trend stop', B.vwapBreak({ c: 99 }, 100, 'up') && !B.vwapBreak({ c: 101 }, 100, 'up') && B.vwapBreak({ c: 101 }, 100, 'down'));

  const calls = [704, 705, 706, 707, 708].map((k, i) => ({ strike: k, ask: [0.4, 0.3, 0.1, 0.05, 0.02][i], bid: 0 }));
  eq('the first strike 1-2 points out; over $0.25, one further', B.pickContract(calls, 703.7, 'up').row.strike, 706);
  eq('$0.10 or so buys two', B.pickContract(calls, 703.7, 'up').qty, 2);
  eq('within 1-2 points and in the band: that one', B.pickContract([{ strike: 705, ask: 0.15 }], 703.7, 'up').row.strike, 705);
  eq('over $0.12: one contract', B.pickContract([{ strike: 705, ask: 0.15 }], 703.7, 'up').qty, 1);
  ok('under $0.07: skipped', /outside/.test(B.pickContract([{ strike: 705, ask: 0.05 }], 703.7, 'up').why));
  ok('too dear, and the next strike out is past 3 points: skipped', !!B.pickContract([{ strike: 705, ask: 0.5 }, { strike: 707, ask: 0.1 }], 703.7, 'up').why);
  eq('puts count down from spot', B.pickContract([{ strike: 702, ask: 0.2 }, { strike: 701, ask: 0.1 }], 703.7, 'down').row.strike, 702);
  const lot = { target: 0.2, high0: 0.15 };
  ok('a target hit: the bid reached it', B.targetHit(lot, { bid: 0.21, high: 0.15 }));
  ok('a target hit: it printed there since the lot was bought', B.targetHit(lot, { bid: 0.12, high: 0.22 }));
  ok('not hit: the day high was above the target before the lot was bought', !B.targetHit({ target: 0.2, high0: 0.4 }, { bid: 0.12, high: 0.4 }));
}

// ------------------------------------------------------------------ the engine, on a fake market
async function engineTests() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
  const cfg = deskConfig(dir);
  let T = clock.etToUtc('2026-09-23T12:31:00');        // a Wednesday
  const { W, feeds, setMinutes, call } = fakeMarket(() => T);
  setMinutes(12 * 60 + 30);
  const desk = new Desk(cfg, { feeds, now: () => T, legacy: () => ({ note: 'winding down: 3 held', lastCycleAt: T }) });
  desk.quiet = true;

  // round 1: 12:31. Crypto rebalances to its targets, SPY buys, the options book passes its 12:30 test.
  await desk.step();
  const b = desk.state.books;
  const btc = b.crypto.sleeves['BTC-USD'];
  near('each coin gets a third of the crypto book', btc.initial, 3000, 0.001);
  near('BTC is bought to a 0.70 weight of its slot', btc.qty * 84000 / 3000, 0.4 / (Math.sqrt(30 * 0.03 * 0.03 / 29) * Math.sqrt(365)), 0.01);
  near('and remembers the target it traded to', btc.target, 0.4 / (Math.sqrt(30 * 0.03 * 0.03 / 29) * Math.sqrt(365)), 1e-9);
  ok('the benchmark starts at that trade', btc.benchPx > 83999 && btc.benchPx < 84001, btc.benchPx);
  eq('checked for today (UTC)', btc.checkDay, '2026-09-23');
  const spy = b.stocks.sleeves.SPY;
  ok('SPY is bought: calm, so the full slot', spy.qty > 14 && spy.cash < 20, spy);
  eq('the options book is armed after the 12:30 test', b.options.day.status, 'armed');
  eq('on an up day', b.options.day.dir, 'up');
  const journal = fs.readFileSync(path.join(dir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq('every fill is journaled', journal.filter((j) => j.kind === 'FILL').length, 4);
  ok('with the 12:30 verdict', journal.some((j) => j.kind === 'OPTIONS_DAY' && j.status === 'pass'));
  const eq1 = desk.equity();
  ok('the desk is worth what it paid, less spreads and fees', eq1 < 20000 && eq1 > 19900, eq1);

  // round 2, same day: nothing re-trades (the target has not moved, the day is checked)
  const fills1 = desk.state.fills.length;
  T += 10000; await desk.step();
  eq('a second round trades nothing', desk.state.fills.length, fills1);

  // round 3: 12:36. The 12:30 bar closed at a new high above VWAP: buy the 705 call at 0.10, two of them.
  T = clock.etToUtc('2026-09-23T12:36:00');
  setMinutes(12 * 60 + 35);
  W.chain = { expiry: '2026-09-23', spot: 703.7, calls: [call(704, 0.3, 0.31, 0.5), call(705, 0.09, 0.1, 0.15), call(706, 0.04, 0.05, 0.1)], puts: [] };
  await desk.step();
  const lots = b.options.lots;
  eq('two contracts bought at the trigger', lots.map((l) => [l.strike, l.role, l.target]), [[705, 'first', 0.2], [705, 'runner', 0.3]]);
  near('cash: $20 of premium and 6 cents of fees', b.options.cash, 979.94, 0.001);

  // round 4: 12:41. The 705 call is bid 0.21: the first contract's 2x target (0.20) fills. The runner stays.
  T = clock.etToUtc('2026-09-23T12:41:00');
  setMinutes(12 * 60 + 40);
  W.chain = { ...W.chain, calls: [call(704, 0.5, 0.51, 0.6), call(705, 0.21, 0.22, 0.22), call(706, 0.08, 0.09, 0.1)] };
  await desk.step();
  eq('the first contract sold at its target', b.options.lots.map((l) => l.role), ['runner']);
  near('made $9.94 on it', b.options.realized, 9.94, 0.001);
  eq('the first exit hit its target: a re-entry is allowed', b.options.day.firstExitHit, true);

  // round 5: 12:46. SPY falls through VWAP on the 12:40 bar: the runner goes at the bid, 0.05.
  T = clock.etToUtc('2026-09-23T12:46:00');
  setMinutes(12 * 60 + 45, { 761: 701.5, 762: 701.2, 763: 701, 764: 700.9, 765: 700.8 });
  W.chain = { ...W.chain, calls: [call(704, 0.1, 0.11, 0.6), call(705, 0.05, 0.06, 0.22), call(706, 0.01, 0.02, 0.1)] };
  await desk.step();
  eq('flat after the VWAP break', b.options.lots.length, 0);
  near('realised: +9.94 on the first, -5.06 on the runner', b.options.realized, 4.88, 0.001);
  near('cash reconciles to the penny', b.options.cash, 1004.88, 0.001);
  eq('one trade on the scorecard', b.options.trades.map((t) => [t.strike, t.qty, t.pnl, t.open]), [[705, 2, 4.88, 0]]);

  // SPY is never bought off the tape once it has stopped: the 3:59 price at 4:30 is not a fill
  {
    const late = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    const T0 = T;
    T = clock.etToUtc('2026-09-23T16:30:00');
    const keep = W.quote;
    W.quote = { ...keep, at: clock.etToUtc('2026-09-23T15:59:40') };
    const d3 = new Desk({ ...cfg, dataDir: late }, { feeds, now: () => T });
    d3.quiet = true;
    await d3.step();
    eq('after the close, the SPY book waits for the next session', d3.state.books.stocks.sleeves.SPY.qty, 0);
    ok('while crypto, which never closes, still trades', d3.state.books.crypto.sleeves['BTC-USD'].qty > 0);
    W.quote = keep; T = T0;
    fs.rmSync(late, { recursive: true, force: true });
  }

  // the snapshot the page reads
  const snap = desk.snapshot();
  eq('seven desks on the floor', snap.agents.map((a) => a.key), ['BRAM', 'KETT', 'RIGO', 'TESS', 'HOLT', 'ILSA', 'PRED']);
  eq('three books', snap.books.map((x) => x.key), ['crypto', 'stocks', 'options']);
  ok('the prediction-market desk sits at the seventh', snap.agents[6].note === 'winding down: 3 held');
  ok('each book carries its benchmark', snap.books[0].bench > 0 && snap.books[1].bench > 0 && snap.books[2].bench === null, snap.books.map((x) => x.bench));
  ok('paper, always', snap.mode === 'paper');
  near('the headline is every book together', snap.equity, snap.books.reduce((a, x) => a + x.equity, 0), 0.02);

  // a restart reads the same ledger back
  desk.save();
  const again = new Desk(cfg, { feeds, now: () => T });
  again.quiet = true;
  eq('a restart reads the same books back', JSON.stringify(again.state.books), JSON.stringify(desk.state.books));
  fs.writeFileSync(path.join(dir, 'desk', 'state.json'), '{"version":1,"books":');
  let threw = null;
  try { new Desk(cfg, { feeds, now: () => T }); } catch (e) { threw = e.message; }
  ok('a corrupt ledger refuses to start rather than being overwritten', /unreadable/.test(threw || ''), threw);

  // the loss limit: no new buying, selling still allowed
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
  const d2 = new Desk({ ...cfg, dataDir: fresh }, { feeds, now: () => T });
  d2.quiet = true;
  d2.state.dayKey = '2026-09-23'; d2.state.dayStart = 40000;
  await d2.step();
  ok('past the daily loss limit, TESS halts buying', /past the 5% limit/.test(d2.halt || ''), d2.halt);
  eq('and nothing is bought', d2.state.fills.length, 0);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
}

engineTests().then(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log(`  FAIL  engine tests threw: ${e.stack}`); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

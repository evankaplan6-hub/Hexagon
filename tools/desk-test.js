'use strict';
// The stocks, crypto and options desk (src/desk/): the market calendar, the feed parsers, paper fills,
// every book's rules, and whole rounds of the engine on a fake market -- a crypto and SPY rebalance,
// one options trend day from the 12:30 test to the last exit, a morning of scalps and a morning dip. No
// network, no clock.
const fs = require('fs');
const os = require('os');
const path = require('path');
const clock = require('../src/desk/clock');
const F = require('../src/desk/feeds');
const broker = require('../src/desk/broker');
const B = require('../src/desk/books');
const { Desk, logLevel, ROUTINE_KEEP } = require('../src/desk/engine');
const DAYX = '2026-09-23';
const { upDay, deskConfig, fakeMarket, playScalpMorning, playDipMorning, at: atDay } = require('./desk-fixture');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), got);
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;

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
  eq("a bar's minute on a date is an instant: 12:35 in summer", new Date(clock.atMin('2026-09-23', 755)).toISOString(), '2026-09-23T16:35:00.000Z');
  eq('and 9:30 in winter', new Date(clock.atMin('2026-12-01', 570)).toISOString(), '2026-12-01T14:30:00.000Z');
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
  // Saturday's file: prev_day_close has turned into Friday's own close, and price_change still holds Friday's move
  const sat = F.parseCboeQuote({ timestamp: '2026-09-26 16:23:01', data: { symbol: 'SPY', current_price: 771.35, close: 771.35, prev_day_close: 771.35, price_change: 4.17, bid: 772, ask: 772.04, open: 768.79, last_trade_time: '2026-09-25T16:00:00' } });
  eq("after the close, the previous close is the price less the session's change, not the close it rolled over to", sat.prevClose, 767.18);
  const live = F.parseCboeQuote({ timestamp: '2026-09-25 20:05:28', data: { symbol: 'SPY', current_price: 772.08, prev_day_close: 767.18, price_change: 4.9, last_trade_time: '2026-09-25T15:50:26' } });
  eq('in the session the two agree', live.prevClose, 767.18);

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

// ------------------------------------------------------------------ the runner book's rules
{
  const R = B.RUNNER;
  const stats = {
    'QNT-USD': { open: 250, high: 300, last: 298, volume: 1e5 },        // +19%, 0.7% off its high, $29.8M: a runner
    'WLD-USD': { open: 0.5, high: 0.6, last: 0.55, volume: 1e8 },       // +10% but 8% off its high: fading
    'NEAR-USD': { open: 5, high: 5.3, last: 5.25, volume: 1e7 },        // +5%: not enough
    'SKR-USD': { open: 1, high: 1.3, last: 1.29, volume: 1e6 },         // +29% on $1.3M: too thin
    'PUMP-USD': { open: 1, high: 2, last: 2, volume: 1e8 },             // Robinhood does not sell it
    'QNT-EUR': { open: 1, high: 2, last: 2, volume: 1e8 },              // not a dollar pair
  };
  const rows = B.runnerScan(stats, { 'QNT-USD': 295 });
  eq('the scan keeps coins Robinhood sells with $2M traded, strongest first', rows.map((r) => r.id), ['QNT-USD', 'WLD-USD', 'NEAR-USD']);
  eq('a coin up 8%+, near its high and above the last scan is a runner; the others say why not', rows.map((r) => r.why),
    [null, '8.3% off its high: fading', 'needs 8%']);
  eq('with no scan before, climbing waits for the next', B.runnerScan(stats, null)[0].why, 'first look: climbing is checked at the next scan');
  eq('a runner no higher than at the last scan is not climbing', B.runnerScan(stats, { 'QNT-USD': 298 })[0].why, 'not climbing since the last scan');
  const lot = { entry: 100, peak: 130, openedAt: 0 };
  eq('held while under 10% off its best', B.runnerExit(lot, 117.1, 3600000), null);
  eq('out at 10% off its best since bought', B.runnerExit(lot, 117, 3600000), 'fell 10% from its best since bought');
  eq('out after 48 hours not above what it cost', B.runnerExit({ entry: 100, peak: 105, openedAt: 0 }, 99, 48 * 3600000), '48 hours and not above what it cost');
  eq('...but a coin above its cost at 48 hours rides on', B.runnerExit({ entry: 100, peak: 105, openedAt: 0 }, 101, 48 * 3600000), null);
  eq('the rule: four at once, a 10% trail, a 12-hour wait after a sale, every 3 minutes', [R.slots, R.trail, R.coolHours, R.everySec], [4, 0.1, 12, 180]);
  const st = F.parseCoinbaseStats({ 'QNT-USD': { stats_24hour: { open: '250', high: '300', low: '240', last: '298', volume: '100000' } }, 'X-USD': { stats_24hour: { open: '0', last: '1' } }, 'Y-USD': {} });
  eq("Coinbase's 24-hour figures parse to numbers, and a coin with no open or last is left out", st, { 'QNT-USD': { open: 250, high: 300, low: 240, last: 298, volume: 100000 } });
  const pr = F.parseCoinbaseProducts([{ id: 'DOGE-USD', status: 'online', base_increment: '0.1' }, { id: 'OLD-USD', status: 'delisted', base_increment: '1' },
    { id: 'HALT-USD', status: 'online', trading_disabled: true, base_increment: '1' }, { id: 'CXL-USD', status: 'online', cancel_only: true, base_increment: '1' }]);
  eq('the product list gives each tradable coin its step, and leaves out the delisted, halted and cancel-only', pr, { 'DOGE-USD': 0.1 });
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
  // DOGE is sold in tenths of a coin: a fill in millionths is one no exchange gives
  const dogeBook = { bids: [{ price: 0.0944, size: 1e6 }], asks: [{ price: 0.0945, size: 1e6 }] };
  eq('a coin with a coarser step fills in that step', broker.fill({ kind: 'crypto', side: 'buy', qty: 12345.678, step: 0.1 }, { bid: 0.0944, ask: 0.0945, book: dogeBook }, fees).qty, 12345.6);
  eq('a quantity that is many steps is floored to the right step (not one low)', broker.fill({ kind: 'crypto', side: 'buy', qty: 9899431.2, step: 0.1 }, { bid: 0.0944, ask: 0.0945, book: { bids: [], asks: [{ price: 0.0945, size: 1e9 }] } }, fees).qty, 9899431.2);
  const dogeCap = broker.fill({ kind: 'crypto', side: 'buy', qty: 1e5, cash: 1000, step: 0.1 }, { bid: 0.0944, ask: 0.0945, book: dogeBook }, fees);
  ok('and a buy capped by its cash still does', -dogeCap.cash <= 1000 && Math.abs(dogeCap.qty * 10 - Math.round(dogeCap.qty * 10)) < 1e-6 && -dogeCap.cash > 999, dogeCap);
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

// the 12:30 test and the trigger, on a made-up up day: a steady climb from 700 (tools/desk-fixture.js), in
// one-minute bars labelled by the minute they close, as Cboe's are and as the options book reads them since
// 2026-09-29. Every number here is the stack's checker's on the same minutes (trend_day_check.py run_day):
// 0.60 ATR at the 12:30 close, 0.49 on a 7.3 ATR, the spike 0.90 ATR with 60% given back, the trigger on the
// minute that closes 12:31 at 703.62. (On five-minute bars, trend_day_check.py --bar 5, the same days gave the
// same verdicts and a trigger at 12:35, 703.70: what these tests said until then.)
{
  const bars = upDay(), vw = F.vwapSeries(bars);
  eq('9:30 to 12:30 is 180 one-minute bars, the first closing 9:31', [bars.length, bars[0].m, bars[179].m], [180, 571, 750]);
  const r = B.trendTest(bars, vw, 6);
  eq('a steady climb of 3.6 points on a 6-point ATR passes', [r.status, r.dir], ['pass', 'up']);
  near('0.6 ATR', r.moveAtr, 0.6, 0.01);
  near('on the close of the minute that ends at 12:30', r.c1230, 703.6, 1e-9);
  eq('half an ATR is the bar: 7.3 fails', B.trendTest(bars, vw, 7.3).status, 'fail');
  ok('and says why', /moved 0.49 ATR, needs 0.5/.test(B.trendTest(bars, vw, 7.3).why), B.trendTest(bars, vw, 7.3).why);
  eq('no ATR: no verdict', B.trendTest(bars, vw, null).status, 'none');
  eq('before the 12:30 minute is in: wait', B.trendTest(bars.slice(0, 179), vw, 6).status, 'wait');
  const holed = bars.filter((b) => b.m !== 600);
  const rh = B.trendTest(holed, F.vwapSeries(holed), 6);
  eq('a minute missing: no verdict', [rh.status, rh.why], ['none', '1 one-minute bar missing before 12:30']);
  const noOpen = bars.slice(1);
  eq('without the 9:31 minute there is no open: no verdict', B.trendTest(noOpen, F.vwapSeries(noOpen), 6).status, 'none');
  const no1230 = upDay({ to: 12 * 60 + 32 }).filter((b) => b.m !== 750);
  eq('the 12:30 minute missing while later ones are in: no verdict, not a wait', B.trendTest(no1230, F.vwapSeries(no1230), 6), { status: 'none', why: 'the minute that closes at 12:30 is missing' });
  // gave back more than half of the move by 12:30
  const back = upDay({ drops: { 700: 706, 740: 702.5 } }), bvw = F.vwapSeries(back);
  const rb = B.trendTest(back, bvw, 3);
  eq('a spike that gave most of it back fails', rb.status, 'fail');
  ok('on the giveback', /gave back 60%/.test(rb.why), rb.why);

  // the trigger: the next minute, the one that closes at 12:31, closes at a new high above VWAP
  const more = upDay({ to: 12 * 60 + 35 }), mvw = F.vwapSeries(more);
  const t0 = B.trendTest(more, mvw, 6);
  const s = B.scanEntry(more, mvw, 'up', t0.idx, t0.ext);
  eq('the next minute closing at a new high triggers: the one that closes 12:31, at 703.62', s.hit && [s.hit.m, +s.hit.c.toFixed(2)], [751, 703.62]);
  // a minute that pokes a new high but closes under the old one does not, and its high becomes the extreme to beat
  const flat = more.map((b) => ({ ...b }));
  flat[180] = { ...flat[180], h: t0.ext + 1, c: t0.ext - 0.05 };
  const s2 = B.scanEntry(flat, F.vwapSeries(flat), 'up', t0.idx, t0.ext);
  eq('a close under the old high is not a trigger', s2.hit, null);
  near('but its high raises the extreme', s2.ext, t0.ext + 1, 1e-9);
  const lateAt = (m) => { const bs = [...more.slice(0, 180), { m, o: 710, h: 711, l: 709, c: 710.5, v: 1000 }]; return B.scanEntry(bs, F.vwapSeries(bs), 'up', 179, t0.ext).hit; };
  eq('the minute that closes at 2:45 (the checker\'s 14:44 bar) is the last that can trigger', [lateAt(885) && lateAt(885).m, lateAt(886)], [885, null]);
  ok('a close back under VWAP is the trend stop', B.vwapBreak({ c: 99 }, 100, 'up') && !B.vwapBreak({ c: 101 }, 100, 'up') && B.vwapBreak({ c: 101 }, 100, 'down'));
  eq('the 3:15 clock is the minute that closes at 3:15 (the checker\'s 15:14 bar)', B.ZERO.clock, 15 * 60 + 15);

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

  // the option chain against the bar the rule acted on (2026-09-26)
  const bar = clock.etToUtc('2026-09-23T12:35:00');
  eq("a chain from the bar's close is in step", B.chainSync(bar, bar, 120), { ok: true, skewSec: 0, why: '' });
  eq('so is one from a minute and a half after it: the desk reads the bars once a minute', B.chainSync(bar + 90000, bar, 120).ok, true);
  eq('the limit is two minutes either side, inclusive', [B.chainSync(bar - 120000, bar, 120).ok, B.chainSync(bar + 120000, bar, 120).ok], [true, true]);
  const old = B.chainSync(bar - 185000, bar, 120);
  eq('a chain from before the bar closed is out of step', [old.ok, old.skewSec], [false, -185]);
  ok('and says which way and by how much', /out of step/.test(old.why) && /185s older/.test(old.why) && /limit 120s/.test(old.why), old.why);
  eq('so is one well ahead of the bars', [B.chainSync(bar + 300000, bar, 120).ok, B.chainSync(bar + 300000, bar, 120).skewSec], [false, 300]);
  eq('a chain with no time of its own never is', B.chainSync(null, bar, 120), { ok: false, skewSec: null, why: 'the option chain carries no time of its own' });
}

// the scalp book's rules (2026-09-29), on the same climbing morning
{
  const bars = F.fiveMinute(upDay({ to: 10 * 60 + 5 })), vw = F.vwapSeries(bars);
  eq('9:30 to 10:00 is seven five-minute bars', bars.map((b) => b.m), [570, 575, 580, 585, 590, 595, 600]);
  const hit = B.scalpTrigger(bars, vw, 6);
  eq('the 10:00 bar closing over the opening range (and VWAP) buys a call', hit && [hit.dir, hit.m, +hit.level.toFixed(2), +hit.c.toFixed(2)], ['up', 600, 700.61, 700.7]);
  eq('nothing closing before 10:05 triggers, however high', B.scalpTrigger(bars, vw, 5), null);
  const holed = bars.filter((b) => b.m !== 580);
  eq('a bar missing from the 30 minutes before: no range, no trigger', B.scalpTrigger(holed, F.vwapSeries(holed), 5), null);
  const flat = (m, c) => ({ m, o: c, h: c + 0.05, l: c - 0.05, c, v: 1000 });
  const down = [570, 575, 580, 585, 590, 595].map((m) => flat(m, 700)).concat([{ m: 600, o: 700, h: 700, l: 699.5, c: 699.6, v: 1000 }]);
  const dh = B.scalpTrigger(down, F.vwapSeries(down), 6);
  eq('a close under the 30 minutes\' low, and under VWAP, buys a put', dh && [dh.dir, dh.level], ['down', 699.95]);
  const inside = down.slice(0, 6).concat([flat(600, 700.02)]);
  eq('a close inside the range is nothing', B.scalpTrigger(inside, F.vwapSeries(inside), 6), null);
  const lateAt = (m) => { const bs = [30, 25, 20, 15, 10, 5].map((k) => flat(m - k, 700)).concat([flat(m, 701)]); return B.scalpTrigger(bs, F.vwapSeries(bs), 6); };
  eq('the 2:25 bar (it closes 2:30) is the last that can', [!!lateAt(14 * 60 + 25), lateAt(14 * 60 + 30)], [true, null]);

  const day = { entries: 0, lossRun: 0, pauseUntil: null };
  eq('a fresh day may trade', B.scalpGate(day, '2026-09-23', 600), '');
  ok('not a fifth trade', /4 trades today/.test(B.scalpGate({ ...day, entries: 4 }, '2026-09-23', 600)));
  ok('not after two losses in a row', /2 losses in a row/.test(B.scalpGate({ ...day, lossRun: 2 }, '2026-09-23', 600)));
  ok('one loss pauses it 15 minutes', /pausing after a loss until 10:30/.test(B.scalpGate({ ...day, lossRun: 1, pauseUntil: 630 }, '2026-09-23', 620)));
  eq('and the bar that closes when the pause ends may', B.scalpGate({ ...day, lossRun: 1, pauseUntil: 630 }, '2026-09-23', 625), '');
  const fed = (m) => B.scalpGate(day, '2026-10-28', m);
  eq('on a Fed day, nothing closing 1:30 to 2:00; before and after, yes', [fed(13 * 60 + 20), !!fed(13 * 60 + 25), !!fed(13 * 60 + 55), fed(14 * 60)], ['', true, true, '']);

  const c = (strike, delta, bid, ask) => ({ strike, delta, bid, ask });
  const chain = [c(700, 0.62, 1.9, 2), c(701, 0.52, 1.3, 1.4), c(702, 0.44, 0.99, 1), c(703, 0.33, 0.6, 0.61), c(704, 0.2, 0.24, 0.25)];
  eq('the contract nearest 0.40 delta', B.pickScalp(chain, 'up', 600).row.strike, 702);
  eq('over $1.50 it is passed over for the next nearest', B.pickScalp(chain.map((r) => (r.strike === 702 ? { ...r, ask: 1.6 } : r)), 'up', 600).row.strike, 703);
  eq("puts' deltas are negative, and count the same", B.pickScalp([c(698, -0.38, 0.8, 0.81), c(697, -0.27, 0.5, 0.51)], 'down', 600).row.strike, 698);
  ok('nothing outside 0.25-0.60', /no call with a delta of 0.25 to 0.60/.test(B.pickScalp([c(700, 0.7, 2, 2.01), c(705, 0.1, 0.05, 0.06)], 'up', 600).why));
  ok('no delta in the chain: nothing', !!B.pickScalp([{ strike: 702, bid: 1, ask: 1.01 }], 'up', 600).why);
  eq('an $0.18 ask is enough before 2 PM', B.pickScalp([c(705, 0.26, 0.17, 0.18)], 'up', 13 * 60 + 50).row.strike, 705);
  ok('and not from 2 PM on: $0.20 then', /asks \$0\.20 to \$1\.50/.test(B.pickScalp([c(705, 0.26, 0.17, 0.18)], 'up', 13 * 60 + 55).why));
  ok('nothing with no bid to sell into', !!B.pickScalp([c(702, 0.4, 0, 1)], 'up', 600).why);

  const lot = { dir: 'up', level: 700.61, barM: 600, entry: 1, target: 1.5, high0: 1.2 };
  const bar = (m, cl) => ({ m, c: cl });
  eq('bid at the target: sold there', B.scalpExit(lot, [bar(605, 700.8)], bar(605, 700.8), { bid: 1.5, high: 1.2 }).kind, 'target');
  eq('printed there since it was bought: sold there too', B.scalpExit(lot, [bar(605, 700.8)], bar(605, 700.8), { bid: 1.3, high: 1.55 }).kind, 'target');
  eq('a close back under the range it broke: the stop', B.scalpExit(lot, [bar(605, 700.5)], bar(605, 700.5), { bid: 0.9, high: 1.2 }).kind, 'stop');
  eq('ten minutes in, down but above the range: held', B.scalpExit(lot, [bar(610, 700.7)], bar(610, 700.7), { bid: 0.95, high: 1.2 }), null);
  eq('fifteen minutes in and bid no more than it cost: the time stop', B.scalpExit(lot, [bar(615, 700.7)], bar(615, 700.7), { bid: 1, high: 1.2 }).kind, 'time');
  eq('fifteen minutes in and bid above it: held', B.scalpExit(lot, [bar(615, 700.9)], bar(615, 700.9), { bid: 1.05, high: 1.2 }), null);
  eq('thirty minutes in, whatever the bid: out', B.scalpExit(lot, [bar(630, 701)], bar(630, 701), { bid: 1.3, high: 1.4 }).kind, 'hold');
  eq('the 3:15 clock', B.scalpExit({ ...lot, barM: 900 }, [bar(910, 701)], bar(910, 701), { bid: 1.3, high: 1.4 }).kind, 'clock');
  eq('a put stops on a close back over its level', B.scalpExit({ ...lot, dir: 'down', level: 699.95 }, [bar(605, 700)], bar(605, 700), { bid: 0.9, high: 1.2 }).kind, 'stop');
  eq('the target comes first: a resting limit fills before a bar closes', B.scalpExit(lot, [bar(605, 700.5)], bar(605, 700.5), { bid: 1.5, high: 1.5 }).kind, 'target');
}

// the dip book's rules (2026-09-29): Evan's morning dip under VWAP, on the fixture's dipping morning, in
// one-minute bars labelled by the minute they close, as Cboe's are
{
  const path = { 598: 698, 611: 700.2, 616: 701.5, 621: 701 };
  const bars = upDay({ to: 10 * 60 + 25, drops: path }), vw = F.vwapSeries(bars);
  const at = (m) => bars.findIndex((b) => b.m === m);
  eq('10:04 turns up too, but nothing triggers before 10:05', B.dipTrigger(bars, vw, at(604), 6), null);
  const hit = B.dipTrigger(bars, vw, at(605), 6);
  ok('the 10:05 minute closes over the one before, under the open and VWAP, 6 minutes off the low: a dip buy', hit && hit.m === 605 && hit.c < 700 && hit.c < hit.vwap, hit);
  eq('two points under a 700 open on a 6-point ATR is a 0.33-ATR dip, and the stop is 0.6 under the low', hit && [+hit.low.toFixed(2), +hit.dip.toFixed(3), +hit.stop.toFixed(2)], [697.99, 0.335, 697.39]);
  eq('a shallower dip (under 0.25 ATR) is nothing', B.dipTrigger(bars, vw, at(605), 9), null);
  eq('a minute back over VWAP is not a dip buy', B.dipTrigger(bars, vw, at(612), 6), null);
  // a 700 open, half an hour at 700.5, then 699.5 with one minute's low at 697.5, and 10:20 closing over
  // the minute before it (still under the open and VWAP)
  const dipAt = (lowM) => {
    const bs = [];
    for (let m = 571; m <= 620; m++) {
      const px = m <= 600 ? 700.5 : 699.5;
      bs.push({ m, o: m === 571 ? 700 : px, h: px + 0.1, l: m === lowM ? 697.5 : px - 0.1, c: m === 620 ? 699.65 : px, v: 1000 });
    }
    return B.dipTrigger(bs, F.vwapSeries(bs), bs.length - 1, 6);
  };
  ok('a low made 20 minutes before (10:00) is the dip it buys', !!dipAt(600));
  eq('one made 21 minutes before (9:59) is not', dipAt(599), null);
  const noOpen = bars.slice(1);
  eq('without the 9:31 minute there is no open to measure from: nothing', B.dipTrigger(noOpen, F.vwapSeries(noOpen), noOpen.findIndex((b) => b.m === 605), 6), null);
  const gap = bars.filter((b) => b.m !== 604);
  eq('the minute before the trigger missing: nothing', B.dipTrigger(gap, F.vwapSeries(gap), gap.findIndex((b) => b.m === 605), 6), null);

  const c = (strike, bid, ask) => ({ strike, bid, ask });
  eq('the call 2-3 points out, $0.20-$0.45', B.pickDip([c(700, 0.6, 0.62), c(701, 0.28, 0.3), c(702, 0.1, 0.12)], 698.14).row.strike, 701);
  ok('too dear: nothing', /asks \$0\.50, outside \$0\.20-\$0\.45/.test(B.pickDip([c(701, 0.48, 0.5)], 698.14).why));
  ok('too cheap: nothing', !!B.pickDip([c(701, 0.13, 0.15)], 698.14).why);

  const lot = { role: 'first', stop: 697.39, spy: 698.14, entry: 0.3, peak: 0.3, reclaimM: null };
  const b = (m, cl, v) => ({ m, c: cl, vw: v });
  eq('under VWAP and over the stop: held', B.dipExit(lot, [b(606, 698.16, 699.6)], b(606, 698.16, 699.6), null).exit, null);
  eq('a close back above VWAP sells the first call, with no chain read needed to say so', B.dipExit(lot, [b(611, 700.2, 699.7)], b(611, 700.2, 699.7), null), { exit: { kind: 'reclaim', bar: b(611, 700.2, 699.7) }, reclaimM: 611 });
  const run = { ...lot, role: 'runner' };
  eq('the runner stays, and remembers the minute of the reclaim', B.dipExit(run, [b(611, 700.2, 699.7)], b(611, 700.2, 699.7), { bid: 0.55 }), { exit: null, reclaimM: 611 });
  eq('a close under the morning low less 0.1 ATR: both go', [B.dipExit(lot, [b(610, 697.2, 699.6)], b(610, 697.2, 699.6), null).exit.kind, B.dipExit(run, [b(610, 697.2, 699.6)], b(610, 697.2, 699.6), null).exit.kind], ['stop', 'stop']);
  eq('no reclaim by 12:30: both go', B.dipExit(run, [b(750, 698.9, 699.3)], b(750, 698.9, 699.3), null).exit.kind, 'late');
  const rode = { ...run, reclaimM: 611 };
  eq('after the reclaim, the runner goes on a close back under where SPY was bought', B.dipExit(rode, [b(640, 698.1, 699.5)], b(640, 698.1, 699.5), null).exit.kind, 'fade');
  eq('it rides a dip that stays over that price, under VWAP or not', B.dipExit(rode, [b(640, 699, 699.5)], b(640, 699, 699.5), null).exit, null);
  eq('doubled to 0.95, and bid 0.60 (under 0.625, halfway back): out', B.dipExit({ ...rode, peak: 0.95 }, [b(621, 701, 700)], b(621, 701, 700), { bid: 0.6 }).exit.kind, 'trail');
  eq('a bid read that doubles it counts at once: bid 0.95, never above 0.55 before, held', B.dipExit({ ...rode, peak: 0.55 }, [b(616, 701.5, 700)], b(616, 701.5, 700), { bid: 0.95 }).exit, null);
  eq('doubled, and bid 0.70: held', B.dipExit({ ...rode, peak: 0.95 }, [b(621, 701.3, 700)], b(621, 701.3, 700), { bid: 0.7 }).exit, null);
  eq('never doubled (best 0.55), bid 0.40: no trail yet', B.dipExit({ ...rode, peak: 0.55 }, [b(621, 700.5, 700)], b(621, 700.5, 700), { bid: 0.4 }).exit, null);
  eq('no bid read, no trail', B.dipExit({ ...rode, peak: 0.95 }, [b(621, 701, 700)], b(621, 701, 700), null).exit, null);
  eq('3:15', B.dipExit(rode, [b(915, 702, 700)], b(915, 702, 700), null).exit.kind, 'clock');
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
  eq("and pays the book's fee to buy in, as any buyer would", btc.benchFeeBps, 40);
  eq('checked for today (UTC)', btc.checkDay, '2026-09-23');
  const spy = b.stocks.sleeves.SPY;
  ok('SPY is bought: calm, so the full slot', spy.qty > 14 && spy.cash < 20, spy);
  eq('SPY holding pays no fee to buy in, as the book pays none', spy.benchFeeBps, 0);
  {
    // holding: the whole slot bought at the trade's mid, the fee coming out of it, marked at the bid
    const want = Object.entries(b.crypto.sleeves).reduce((a, [id, sl]) => a + sl.initial * desk.coinBid(id) / (sl.benchPx * 1.004), 0);
    near('crypto holding is the slot less its fee to buy in, marked at the bid', desk.benchValue('crypto'), Math.round(want * 100) / 100, 0.006);
    near('its fee: 0.40% of what $9,000 bought', desk.benchFee('crypto'), 35.86, 0.001);
    eq('SPY holding paid nothing to buy in', desk.benchFee('stocks'), 0);
  }
  eq('the options book is armed after the 12:30 test', b.options.day.status, 'armed');
  eq('on an up day', b.options.day.dir, 'up');
  const journal = fs.readFileSync(path.join(dir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  eq('every fill is journaled', journal.filter((j) => j.kind === 'FILL').length, 4);
  ok('with the 12:30 verdict', journal.some((j) => j.kind === 'OPTIONS_DAY' && j.status === 'pass'));
  const eq1 = desk.equity();
  ok('the desk is worth what it paid, less spreads and fees', eq1 < 23000 && eq1 > 22900, eq1);

  // round 2, same day: nothing re-trades (the target has not moved, the day is checked)
  const fills1 = desk.state.fills.length;
  T += 10000; await desk.step();
  eq('a second round trades nothing', desk.state.fills.length, fills1);

  // The options book on one-minute bars (since 2026-09-29): each round ten seconds after the minute it acts
  // on closed, as the stack's checks run (a second later each time, so that rounds a minute apart are more
  // than the minute the desk waits between reads of the minute bars), and each chain carrying that minute's
  // close as its own time.
  const min = (hhmm) => clock.etToUtc(`2026-09-23T${hhmm}:00`);
  let k = 0;
  const after = (hhmm) => min(hhmm) + 10000 + 1000 * k++;
  let reads = 0;
  const expiry = feeds.expiry;
  feeds.expiry = async (...a) => { reads++; return expiry(...a); };

  // round 3: 12:32. The minute that closed at 12:31 made a new high above VWAP: buy the 705 call at 0.10, two of them.
  T = after('12:32');
  setMinutes(12 * 60 + 31);
  W.chain = { expiry: '2026-09-23', spot: 703.62, at: min('12:31'), calls: [call(704, 0.3, 0.31, 0.5), call(705, 0.09, 0.1, 0.15), call(706, 0.04, 0.05, 0.1)], puts: [] };
  await desk.step();
  const lots = b.options.lots;
  eq('two contracts bought at the trigger', lots.map((l) => [l.strike, l.role, l.target]), [[705, 'first', 0.2], [705, 'runner', 0.3]]);
  near('cash: $20 of premium and 6 cents of fees', b.options.cash, 979.94, 0.001);
  eq('each contract names its role, and its target (the page writes the price it sells at)', desk.snapshot().books[2].rows.map((r) => [r.label, r.target]), [['first contract', 0.2], ['runner', 0.3]]);
  ok('the floor names the minute that triggered', desk.state.log.some((l) => /^options: new high at 12:31, SPY 703\.62 · buy 2 705 call at \$0\.10/.test(l.text)), desk.state.log.map((l) => l.text));

  // round 4: 12:33. The next minute is in, and the chain is read for it: the 705 call is bid 0.21, so the
  // first contract's 2x target (0.20) fills. The runner stays.
  T = after('12:33');
  setMinutes(12 * 60 + 32);
  W.chain = { ...W.chain, spot: 703.64, at: min('12:32'), calls: [call(704, 0.5, 0.51, 0.6), call(705, 0.21, 0.22, 0.22), call(706, 0.08, 0.09, 0.1)] };
  reads = 0;
  await desk.step();
  eq('a minute later the chain is read for the targets', reads, 1);
  eq('the first contract sold at its target', b.options.lots.map((l) => l.role), ['runner']);
  near('made $9.94 on it', b.options.realized, 9.94, 0.001);
  eq('the first exit hit its target: a re-entry is allowed', b.options.day.firstExitHit, true);

  // round 5: 12:41. Still climbing, over VWAP: the runner is held.
  T = after('12:41');
  setMinutes(12 * 60 + 40);
  W.chain = { ...W.chain, spot: 703.8, at: min('12:40'), calls: [call(704, 0.4, 0.41, 0.6), call(705, 0.15, 0.16, 0.22), call(706, 0.06, 0.07, 0.1)] };
  await desk.step();
  eq('12:40 closes over VWAP: the runner rides', b.options.lots.map((l) => l.role), ['runner']);

  // round 6: 12:42. The minute that closed at 12:41 fell through VWAP: the runner goes at the bid, 0.05.
  T = after('12:42');
  setMinutes(12 * 60 + 41, { 761: 701.5 });
  W.chain = { ...W.chain, spot: 701.5, at: min('12:41'), calls: [call(704, 0.1, 0.11, 0.6), call(705, 0.05, 0.06, 0.22), call(706, 0.01, 0.02, 0.1)] };
  await desk.step();
  eq('flat after a one-minute close through VWAP', b.options.lots.length, 0);
  near('realised: +9.94 on the first, -5.06 on the runner', b.options.realized, 4.88, 0.001);
  near('cash reconciles to the penny', b.options.cash, 1004.88, 0.001);
  eq('one trade on the scorecard', b.options.trades.map((t) => [t.strike, t.qty, t.pnl, t.open]), [[705, 2, 4.88, 0]]);
  ok('the floor names the minute that broke VWAP', desk.state.log.some((l) => /SPY closed below VWAP at 12:41 \(701\.50 vs 70\d\.\d\d\)/.test(l.text)), desk.state.log.map((l) => l.text));
  {
    const js = fs.readFileSync(path.join(dir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const opt = js.filter((j) => j.kind === 'FILL' && j.book === 'options');
    eq("every option fill journals the minute's close, the chain's time and the gap between them", opt.map((j) => [j.side, j.barAt, j.chainAt, j.skewSec]), [
      ['buy', '2026-09-23T16:31:00.000Z', '2026-09-23T16:31:00.000Z', 0],
      ['sell', '2026-09-23T16:32:00.000Z', '2026-09-23T16:32:00.000Z', 0],
      ['sell', '2026-09-23T16:41:00.000Z', '2026-09-23T16:41:00.000Z', 0],
    ]);
  }

  // round 7: 12:51. SPY is back over the high it made before the trade ended (703.81, the 12:40 minute's)
  // on the minute that closed 12:50: a fresh one-minute trigger, and the first exit hit its target, so
  // the one re-entry, one contract.
  T = after('12:50');
  setMinutes(12 * 60 + 49, { 761: 701.5 });
  await desk.step();
  eq('SPY under the old high: no re-entry yet', [b.options.lots.length, b.options.day.entries], [0, 1]);
  T = after('12:51');
  setMinutes(12 * 60 + 50, { 761: 701.5, 770: 704 });
  W.chain = { ...W.chain, spot: 704, at: min('12:50'), calls: [call(705, 0.09, 0.1, 0.12), call(706, 0.04, 0.05, 0.06)] };
  await desk.step();
  eq('the re-entry: one 705 call, on the minute that closed 12:50', [b.options.lots.map((l) => [l.strike, l.role, l.qty]), b.options.day.entries, b.options.day.entryBarM], [[[705, 'runner', 1]], 2, 770]);
  ok('said as the one re-entry', desk.state.log.some((l) => /^options: new high at 12:50, SPY 704\.00 · buy 1 705 call at \$0\.10 \(the one re-entry\)/.test(l.text)), desk.state.log.map((l) => l.text));
  eq('the page gets the newest minute the book read, labelled by its close, and the 9:30 open', [desk.snapshot().options.spy.m, desk.snapshot().options.spy.c, desk.snapshot().options.spy.open], [770, 704, 700]);
  feeds.expiry = expiry;

  // An option is not bought off a chain out of step with the bars (2026-09-26). The trigger is the minute
  // that closed at 12:31; a chain whose prices are from 12:26 would sell the call at its price before the new high.
  {
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let T2 = clock.etToUtc('2026-09-23T12:31:00');
    const M2 = fakeMarket(() => T2);
    M2.setMinutes(12 * 60 + 30);
    const d5 = new Desk(deskConfig(sdir), { feeds: M2.feeds, now: () => T2 });
    d5.quiet = true;
    await d5.step();
    T2 = after('12:32');
    M2.setMinutes(12 * 60 + 31);
    M2.W.chain = { expiry: '2026-09-23', spot: 703.62, at: min('12:26'), calls: [M2.call(705, 0.09, 0.1, 0.15)], puts: [] };
    await d5.step();
    eq('nothing is bought off a chain five minutes older than the trigger bar', d5.state.books.options.lots.length, 0);
    const js = fs.readFileSync(path.join(sdir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const skip = js.find((j) => j.kind === 'OPTIONS_SKIP');
    eq('the skip is journaled with both times', skip && [skip.bar, skip.barAt, skip.chainAt, skip.skewSec], ['12:31', '2026-09-23T16:31:00.000Z', '2026-09-23T16:26:00.000Z', -300]);
    eq('and no option fill', js.filter((j) => j.kind === 'FILL' && j.book === 'options').length, 0);
    ok('the floor says why', d5.state.log.some((l) => l.kind === 'PASS' && /not taken/.test(l.text) && /300s older/.test(l.text)), d5.state.log.map((l) => l.text));
    eq('the book stays armed for a later trigger', d5.state.books.options.day.status, 'armed');
    eq('and this one is spent: the scan has moved past its minute', d5.state.books.options.day.scanIdx, d5.mkt.spy.intra.bars.length - 1);
    fs.rmSync(sdir, { recursive: true, force: true });
  }

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
  eq('six books', snap.books.map((x) => x.key), ['crypto', 'stocks', 'options', 'scalps', 'dips', 'runners']);
  ok('the prediction-market desk sits at the seventh', snap.agents[6].note === 'winding down: 3 held');
  ok('each book carries its benchmark', snap.books[0].bench > 0 && snap.books[1].bench > 0 && snap.books.slice(2).every((x) => x.bench === null), snap.books.map((x) => x.bench));
  eq('and what that holding paid to buy in (the option books and the runners are never "held")', snap.books.map((x) => x.benchFee), [35.86, 0, null, null, null, null]);
  ok('paper, always', snap.mode === 'paper');
  near('the headline is every book together', snap.equity, snap.books.reduce((a, x) => a + x.equity, 0), 0.02);
  eq('the frame says when the last round finished', snap.beat, T);
  ok("and each log line's level, for the page's filters", snap.log.length && snap.log.every((e) => ['trade', 'info', 'warn', 'quiet'].includes(e.level)), snap.log.map((e) => e.level));

  // A day of routine rounds (thirteen an hour) used to push the desk's trades and decisions out of the ring
  // and the frame; now they make way only for each other.
  {
    const fillsLogged = desk.state.log.filter((e) => e.kind === 'FILL').length;
    const signals = desk.state.log.filter((e) => e.kind === 'SIGNAL').length;
    for (let i = 0; i < 500; i++) desk.log(['HOLT', 'TESS', 'RIGO'][i % 3], ['SCAN', 'OPS', 'RESEARCH'][i % 3], null, ['3/3 coins live from Coinbase', 'all clear · crypto prices fresh', 'marked BTC, ETH, SOL'][i % 3]);
    eq('a day of routine rounds keeps only the newest of them', desk.state.log.filter((e) => logLevel(e) === 'quiet').length, ROUTINE_KEEP);
    ok('and every fill the desk made is still in the ring', fillsLogged >= 7 && desk.state.log.filter((e) => e.kind === 'FILL').length === fillsLogged, fillsLogged);
    eq('every signal too', desk.state.log.filter((e) => e.kind === 'SIGNAL').length, signals);
    eq('and in the frame the page reads', desk.snapshot().log.filter((e) => e.level === 'trade').length, fillsLogged);
    eq('a warning is not routine', logLevel({ agent: 'HOLT', kind: 'OPS', text: 'SPY quote did not load' }), 'warn');
    eq("TESS's all clear is", logLevel({ agent: 'TESS', kind: 'OPS', text: 'all clear · crypto prices fresh' }), 'quiet');
    eq("the options book's verdict is a decision", logLevel({ agent: 'BRAM', kind: 'PASS', text: 'options: not a trend day (moved 0.41 ATR, needs 0.50) · no trade today' }), 'info');
  }

  // a restart reads the same ledger back
  desk.save();
  const again = new Desk(cfg, { feeds, now: () => T });
  again.quiet = true;
  eq('a restart reads the same books back', JSON.stringify(again.state.books), JSON.stringify(desk.state.books));
  fs.writeFileSync(path.join(dir, 'desk', 'state.json'), '{"version":1,"books":');
  let threw = null;
  try { new Desk(cfg, { feeds, now: () => T }); } catch (e) { threw = e.message; }
  ok('a corrupt ledger refuses to start rather than being overwritten', /unreadable/.test(threw || ''), threw);

  // A ledger from before holding paid its fee (2026-09-26): on loading, each sleeve that has bought in gets
  // the fee at the rate the book pays now, and the holding values its history recorded from the minute
  // every sleeve had bought in are put on the same footing, once.
  {
    const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    const d4 = new Desk({ ...cfg, dataDir: oldDir }, { feeds, now: () => T });
    d4.quiet = true;
    await d4.step();
    const s = JSON.parse(JSON.stringify(d4.state));
    const from = Math.max(...Object.values(s.books.crypto.sleeves).map((sl) => sl.benchAt));
    for (const bk of [s.books.crypto, s.books.stocks]) for (const sl of Object.values(bk.sleeves)) delete sl.benchFeeBps;
    s.history = [
      { t: from - 60000, e: 20000, c: 9000, s: 10000, o: 1000, bc: 9000, bs: 10000 },   // before: the book's own value
      { t: from, e: 19950, c: 8990, s: 9960, o: 1000, bc: 9036, bs: 9990 },
      { t: from + 60000, e: 19960, c: 8995, s: 9965, o: 1000, bc: 9036.14, bs: 9995 },
    ];
    fs.writeFileSync(path.join(oldDir, 'desk', 'state.json'), JSON.stringify(s));
    const d5 = new Desk({ ...cfg, dataDir: oldDir }, { feeds, now: () => T });
    eq('an older ledger gets the fee its holding would have paid', Object.values(d5.state.books.crypto.sleeves).map((sl) => sl.benchFeeBps), [40, 40, 40]);
    eq("holding before every coin had bought in is the book's own value, left alone", d5.state.history[0].bc, 9000);
    eq('holding from then on is the slot less its fee', d5.state.history.slice(1).map((p) => p.bc), [9000, 9000.14]);
    eq("SPY's recorded holding is left alone: it pays no fee", d5.state.history.map((p) => p.bs), [10000, 9990, 9995]);
    d5.save();
    const d6 = new Desk({ ...cfg, dataDir: oldDir }, { feeds, now: () => T });
    eq('and only once: loading it again changes nothing', d6.state.history.map((p) => p.bc), [9000, 9000, 9000.14]);
    fs.rmSync(oldDir, { recursive: true, force: true });
  }

  // A morning of scalps (2026-09-29): tools/desk-fixture.js playScalpMorning, round by round.
  {
    const sdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let TS = atDay('10:06');
    const M = fakeMarket(() => TS);
    const ds = new Desk(deskConfig(sdir), { feeds: M.feeds, now: () => TS });
    ds.quiet = true;
    const x = ds.state.books.scalps;
    const rounds = [];
    const real = ds.step.bind(ds);
    ds.step = async () => { await real(); rounds.push({ lots: x.lots.map((l) => [l.strike, l.entry, l.target, l.level, l.barM]), cash: x.cash, realized: x.realized, entries: x.day && x.day.entries, exitBarM: x.day && x.day.exitBarM }); };
    await playScalpMorning(ds, M, (t) => { TS = t; });
    eq('10:06: the opening-range break buys the 701 call, 1.5x target, stop at the range it broke', rounds[0].lots, [[701, 1, 1.5, 700.61, 600]]);
    eq('$100 of premium and a 3-cent fee', rounds[0].cash, 899.97);
    eq('10:11: another break while it is held adds nothing', [rounds[1].lots.length, rounds[1].entries], [1, 1]);
    eq('10:16: the 1.50 target fills, and the new break buys the 702 at 0.91', rounds[2].lots, [[702, 0.91, 1.365, 700.81, 610]]);
    eq('banked $49.94 on the first', rounds[2].realized, 49.94);
    eq('a new scalp starts its exit scan at its own entry bar, not at the last trade\'s last handled bar', rounds[2].exitBarM, null);
    eq('10:21: SPY closes back under 700.81, and the 702 goes at the bid', rounds[3].lots, []);
    eq('realised: +49.94, then -21.06', x.realized, 28.88);
    eq('cash reconciles to the penny', x.cash, 1028.88);
    eq('the loss starts the 15-minute pause from the 10:20 close', [x.day.lossRun, x.day.pauseUntil], [1, 635]);
    eq('two trades on its scorecard, newest first', x.trades.map((t) => [t.strike, t.dir, t.pnl, t.open]), [[702, 'up', -21.06, 0], [701, 'up', 49.94, 0]]);
    const js = fs.readFileSync(path.join(sdir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const sf = js.filter((j) => j.kind === 'FILL' && j.book === 'scalps');
    eq('every scalp fill is journaled, with its reason', sf.map((j) => [j.side, j.px, j.why.split(' (')[0]]), [
      ['buy', 1, 'break above the last 30 minutes at 10:05'], ['sell', 1.5, '1.5x target hit'],
      ['buy', 0.91, 'break above the last 30 minutes at 10:15'], ['sell', 0.7, 'SPY closed back under 700.81 at 10:20']]);
    const b1 = sf[0];
    eq("a buy journals what the stack's §8 asks: SPY, the level, the delta, the quote", [b1.dir, b1.spy, b1.level, b1.delta, b1.bid, b1.ask, b1.bidSz, b1.askSz, b1.skewSec], ['up', 700.7, 700.61, 0.45, 0.99, 1, 100, 100, 0]);
    eq('the options book, waiting for 12:30, traded nothing', ds.state.books.options.lots.length + ds.state.books.options.trades.length, 0);
    const snap = ds.snapshot();
    eq('the page gets the scalp day', [snap.scalps.enabled, snap.scalps.day.entries, snap.scalps.day.lossRun, snap.scalps.day.pauseUntil], [true, 2, 1, 635]);
    ok('and the range the next bar has to break', snap.scalps.range && snap.scalps.range.hi > snap.scalps.range.lo, snap.scalps.range);
    near('the desk counts the scalp book in its worth', snap.equity, snap.books.reduce((a, b2) => a + b2.equity, 0), 0.02);
    eq('its decisions are decisions, not routine', logLevel({ agent: 'BRAM', kind: 'PASS', text: 'scalps: SPY broke above 700.81 at 10:15 · not taken: pausing after a loss until 10:35' }), 'info');
    // a second loss in a row ends the day
    ds.scalpClosed(x.day, { pnl: -5 });
    eq('two losses in a row: done for today', [x.day.status, x.day.why], ['done', '2 losses in a row']);
    fs.rmSync(sdir, { recursive: true, force: true });
  }

  // The options book with no chain in hand when the VWAP break comes (a restart, then Cboe failing): the
  // contracts are held and sold when the chain loads, not written off as unbid.
  {
    const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let TO = atDay('12:31');
    const M = fakeMarket(() => TO), { W } = M;
    const od = new Desk(deskConfig(odir), { feeds: M.feeds, now: () => TO });
    od.quiet = true;
    TO = atDay('12:31'); M.setMinutes(12 * 60 + 30); await od.step();
    TO = atDay('12:32') + 10000; M.setMinutes(12 * 60 + 31);
    W.chain = { expiry: DAYX, spot: 703.62, at: atDay('12:31'), calls: [M.call(704, 0.3, 0.31, 0.5), M.call(705, 0.09, 0.1, 0.15), M.call(706, 0.04, 0.05, 0.1)], puts: [] };
    await od.step();
    const ox = od.state.books.options, held = ox.lots.length;
    TO = atDay('12:42') + 12000; M.setMinutes(12 * 60 + 41, { 761: 701.5 });
    const chain = { ...W.chain, spot: 701.5, at: atDay('12:41'), calls: [M.call(704, 0.1, 0.11, 0.6), M.call(705, 0.05, 0.06, 0.22), M.call(706, 0.01, 0.02, 0.1)] };
    od.mkt.chain = null; W.chain = null;
    await od.step();
    eq('no chain on the minute SPY closes through VWAP: both contracts are still held, none written off', [held, ox.lots.length, ox.realized], [2, 2, 0]);
    TO += 61000; W.chain = chain;
    await od.step();
    eq('the next round, with the chain back, sells them at the bid', [ox.lots.length, ox.trades[0].open], [0, 0]);
    ok('at a real price, not a write-off', ox.realized > -20, ox.realized);
    fs.rmSync(odir, { recursive: true, force: true });
  }

  // An expired option settles against SPY's close on its expiry day, not whatever SPY is when the desk next runs.
  {
    const sdir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let TX = clock.etToUtc('2026-09-24T11:00:00');
    const M = fakeMarket(() => TX);
    const dx = new Desk(deskConfig(sdir2), { feeds: M.feeds, now: () => TX });
    dx.quiet = true;
    const ox = dx.state.books.options;
    const lot = { id: 1, trade: 'T1', qty: 2, cost: 20, strike: 705, right: 'C', osi: 'SPY260923C00705000', expiry: DAYX, entry: 0.1, role: 'first', openedAt: 0 };
    ox.lots.push(lot);
    dx.mkt.spy.quote = { last: 712 };
    dx.settleLot('options', lot);
    eq('without that day\'s close the lot waits', ox.lots.length, 1);
    dx.mkt.spy.daily = [{ day: DAYX, c: 700 }];
    dx.settleLot('options', lot);
    eq('with it, a 705 call that expired out of the money is worth nothing though SPY is 712 now', [ox.lots.length, ox.realized, ox.cash], [0, -20, 1000]);
    fs.rmSync(sdir2, { recursive: true, force: true });
  }

  // A read that brings two new minute bars must not drop a dip trigger on the first.
  {
    const ddir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let TD = atDay('10:06');
    const M = fakeMarket(() => TD);
    const dd = new Desk(deskConfig(ddir), { feeds: M.feeds, now: () => TD });
    dd.quiet = true;
    const hhmm = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
    const calls = [M.call(700, 0.64, 0.66, 1.5), M.call(701, 0.28, 0.3, 1), M.call(702, 0.1, 0.12, 0.6)];
    // 10:04 alone, then 10:05 and 10:06 in one read: the trigger is on 10:05
    TD = atDay('10:05') + 5000; M.setMinutes(10 * 60 + 4, { 598: 698, 611: 700.2, 616: 701.5, 621: 701 }); M.W.chain = { expiry: DAYX, spot: 698.12, at: atDay('10:04'), calls, puts: [] };
    await dd.step();
    TD = atDay('10:07') + 5000; M.setMinutes(10 * 60 + 6, { 598: 698, 606: 697.9, 611: 700.2, 616: 701.5, 621: 701 }); M.W.chain = { expiry: DAYX, spot: 698.16, at: atDay('10:06'), calls, puts: [] };
    await dd.step();
    eq('two bars in one read: the dip bought on the first', dd.state.books.dips.lots.map((l) => l.strike), [701, 701]);
    fs.rmSync(ddir, { recursive: true, force: true });
  }

  // A morning dip (2026-09-29): tools/desk-fixture.js playDipMorning, round by round, on one-minute bars.
  {
    const pdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let TP = atDay('10:05');
    const M = fakeMarket(() => TP);
    const dp = new Desk(deskConfig(pdir), { feeds: M.feeds, now: () => TP });
    dp.quiet = true;
    const x = dp.state.books.dips;
    const rounds = [];
    const real = dp.step.bind(dp);
    let reads = 0;
    const expiry = M.feeds.expiry;
    M.feeds.expiry = async (...a) => { reads++; return expiry(...a); };
    dp.step = async () => { const r0 = reads; await real(); rounds.push({ lots: x.lots.map((l) => [l.strike, l.role, l.entry, l.stop, l.spy, l.reclaimM, l.peak]), cash: x.cash, realized: x.realized, reads: reads - r0 }); };
    await playDipMorning(dp, M, (t) => { TP = t; });
    eq('10:04: turning, but before 10:05: nothing bought', rounds[0].lots, []);
    eq('10:05: two 701 calls at 0.30, stop 697.39, bought with SPY at 698.14', rounds[1].lots, [[701, 'first', 0.3, 697.39, 698.14, null, 0.3], [701, 'runner', 0.3, 697.39, 698.14, null, 0.3]]);
    eq('$60 of premium and 6 cents of fees', rounds[1].cash, 939.94);
    eq('10:10: SPY still under VWAP: held, and the 6 MB chain is not read', [rounds[2].lots.length, rounds[2].reads], [2, 0]);
    eq('10:11: SPY back over VWAP: the first sells at 0.55, and the runner rides from that minute', rounds[3].lots, [[701, 'runner', 0.3, 697.39, 698.14, 611, 0.55]]);
    eq('banked $24.94 on it', rounds[3].realized, 24.94);
    eq("10:16: five minutes on, the runner's bid is read: 0.95, more than double, held", [rounds[4].lots.map((l) => l[6]), rounds[4].reads], [[0.95], 1]);
    eq('10:21: bid 0.60, under halfway back to its cost: out', rounds[5].lots, []);
    eq('realised: +24.94 and +29.94', x.realized, 54.88);
    eq('cash reconciles to the penny', x.cash, 1054.88);
    eq('one trade, two calls, closed', x.trades.map((t) => [t.strike, t.qty, t.pnl, t.open]), [[701, 2, 54.88, 0]]);
    const js = fs.readFileSync(path.join(pdir, 'desk', 'journal-2026-09-23.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const df = js.filter((j) => j.kind === 'FILL' && j.book === 'dips');
    eq('every dip fill is journaled with its reason', df.map((j) => [j.side, j.qty, j.px, j.why.split(' (')[0]]), [
      ['buy', 2, 0.3, 'dip buy: SPY turned up off 697.99 at 10:05'], ['sell', 1, 0.55, 'SPY closed back above VWAP at 10:11'], ['sell', 1, 0.6, 'gave back half its gain from $0.95']]);
    eq('a buy journals the dip it bought: SPY, the open, the low, the dip in ATRs, the stop', [df[0].spy, df[0].open, df[0].low, df[0].dipAtr, df[0].stop], [698.14, 700, 697.99, 0.335, 697.39]);
    eq('and each fill the minute it acted on against the chain: in step', df.map((j) => j.skewSec), [0, 0, 0]);
    eq('the scalp book passed on its breakout (no delta in this chain)', dp.state.books.scalps.lots.length + dp.state.books.scalps.trades.length, 0);
    const snap = dp.snapshot();
    eq('the page gets the dip day and where SPY stands against the dip', [snap.dips.enabled, snap.dips.day.entries, snap.dips.spy.open, snap.dips.spy.need, snap.dips.spy.m], [true, 1, 700, 698.5, 621]);
    eq("its decisions are decisions, not routine", logLevel({ agent: 'BRAM', kind: 'PASS', text: 'dips: noon, done for today · no dip to buy by noon' }), 'info');
    // a losing trade ends the day
    dp.dipClosed(x.day, { pnl: -12 });
    eq('a loss: done for today', [x.day.status, x.day.why], ['done', 'a trade lost $12.00']);
    fs.rmSync(pdir, { recursive: true, force: true });
  }

  // A ledger from before the scalp and dip books (2026-09-29) and the runner book (2026-09-30) gets them as
  // cash, and the desk's recorded value and today's starting mark go up by that cash, so the P&L they show
  // does not move. Once.
  {
    const odir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    const d7 = new Desk({ ...cfg, dataDir: odir }, { feeds, now: () => T });
    d7.quiet = true;
    await d7.step();
    const s = JSON.parse(JSON.stringify(d7.state));
    delete s.books.scalps; delete s.books.dips; delete s.books.runners;
    s.history = [{ t: T - 120000, e: 20000, c: 9000, s: 10000, o: 1000, bc: 9000, bs: 10000 }, { t: T - 60000, e: 19990, c: 8995, s: 9995, o: 1000, bc: 9000, bs: 10000 }];
    s.dayStart = 19990;
    fs.writeFileSync(path.join(odir, 'desk', 'state.json'), JSON.stringify(s));
    const d8 = new Desk({ ...cfg, dataDir: odir }, { feeds, now: () => T });
    eq('each arrives as $1,000 of cash', ['scalps', 'dips', 'runners'].map((k) => [d8.state.books[k].cash, d8.state.books[k].initial, d8.state.books[k].lots.length]), [[1000, 1000, 0], [1000, 1000, 0], [1000, 1000, 0]]);
    eq("the desk's recorded value carries them from the start", d8.state.history.map((p) => p.e), [23000, 22990]);
    eq('and so does the start of the day', d8.state.dayStart, 22990);
    eq('the P&L the chart draws is what it was', d8.state.history.map((p) => p.e - d8.initial()), [0, -10]);
    eq('their starts are journaled when the desk starts', Object.entries(d8.state.added).map(([k, a]) => [k, a.cash, a.journaled]), [['scalps', 1000, false], ['dips', 1000, false], ['runners', 1000, false]]);
    d8.save();
    const d9 = new Desk({ ...cfg, dataDir: odir }, { feeds, now: () => T });
    eq('only once', d9.state.history.map((p) => p.e), [23000, 22990]);
    fs.rmSync(odir, { recursive: true, force: true });
  }

  // XRP and DOGE joined a crypto book already holding BTC, ETH and SOL (2026-09-30). A three-coin ledger
  // gets each new coin as a slot of cash the size of the others, and the book's value and holding's in the
  // history, and the start of the day, go up by that cash: the P&L they show does not move. Nothing the book
  // already holds is sold; the new coins buy in on the next round with fresh prices. Once.
  {
    const cdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    const c1 = new Desk({ ...cfg, dataDir: cdir }, { feeds, now: () => T });
    c1.quiet = true;
    await c1.step();
    const s = JSON.parse(JSON.stringify(c1.state));
    const held = Object.fromEntries(Object.entries(s.books.crypto.sleeves).map(([id, sl]) => [id, [sl.qty, sl.cash, sl.target]]));
    s.history = [{ t: T - 120000, e: 23000, c: 9000, s: 10000, o: 1000, x: 1000, dp: 1000, rn: 1000, bc: 9000, bs: 10000 }, { t: T - 60000, e: 22990, c: 8990, s: 10000, o: 1000, x: 1000, dp: 1000, rn: 1000, bc: 8995, bs: 10000 }];
    s.dayStart = 22990;
    fs.writeFileSync(path.join(cdir, 'desk', 'state.json'), JSON.stringify(s));
    // the market grows the two coins: DOGE near a dime, sold in tenths
    const quietDaily = (px) => W.daily['BTC-USD'].map((d) => ({ ...d, o: d.o * px / 84000, h: d.h * px / 84000, l: d.l * px / 84000, c: d.c * px / 84000 }));
    W.ticks['XRP-USD'] = { bid: 1.4919, ask: 1.4921, last: 1.492, at: T }; W.ticks['DOGE-USD'] = { bid: 0.09447, ask: 0.09451, last: 0.0945, at: T };
    W.daily['XRP-USD'] = quietDaily(1.492); W.daily['DOGE-USD'] = quietDaily(0.0945);
    for (const id of ['XRP-USD', 'DOGE-USD']) W.books[id] = { bids: [{ price: W.ticks[id].bid, size: 1e7 }], asks: [{ price: W.ticks[id].ask, size: 1e7 }] };
    const five = { ...cfg, dataDir: cdir, desk: { ...cfg.desk, coins: [...cfg.desk.coins, 'XRP-USD', 'DOGE-USD'] } };
    const c2 = new Desk(five, { feeds, now: () => T });
    c2.quiet = true;
    const cb = c2.state.books.crypto;
    eq('each new coin gets a slot the size of the three it joins, in cash', ['XRP-USD', 'DOGE-USD'].map((id) => [cb.sleeves[id].initial, cb.sleeves[id].cash, cb.sleeves[id].qty]), [[3000, 3000, 0], [3000, 3000, 0]]);
    eq('the book grows by that cash', cb.initial, 15000);
    eq('nothing it holds is touched', Object.fromEntries(['BTC-USD', 'ETH-USD', 'SOL-USD'].map((id) => [id, [cb.sleeves[id].qty, cb.sleeves[id].cash, cb.sleeves[id].target]])), held);
    eq("the book's and holding's recorded values carry the new cash from the start", c2.state.history.map((p) => [p.e, p.c, p.bc]), [[29000, 15000, 15000], [28990, 14990, 14995]]);
    eq('and so does the start of the day', c2.state.dayStart, 28990);
    eq('the P&L the chart draws is what it was', c2.state.history.map((p) => [r2(p.e - c2.initial()), r2(p.c - cb.initial), r2(p.bc - cb.initial)]), [[0, 0, 0], [-10, -10, -5]]);
    eq('HOLT reads all five coins', Object.keys(c2.mkt.coins), ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD']);
    eq('their arrival is journaled when the desk starts', Object.entries(c2.state.addedCoins).map(([id, a]) => [id, a.cash, a.journaled]), [['XRP-USD', 3000, false], ['DOGE-USD', 3000, false]]);
    await c2.step();
    const want = 0.4 / (Math.sqrt(30 * 0.03 * 0.03 / 29) * Math.sqrt(365));
    near('XRP buys in to its target that round', cb.sleeves['XRP-USD'].qty * 1.492 / 3000, want, 0.01);
    near('and DOGE', cb.sleeves['DOGE-USD'].qty * 0.0945 / 3000, want, 0.01);
    ok('DOGE in tenths, as Coinbase sells it', Math.abs(cb.sleeves['DOGE-USD'].qty * 10 - Math.round(cb.sleeves['DOGE-USD'].qty * 10)) < 1e-6, cb.sleeves['DOGE-USD'].qty);
    eq('the three it joined are not traded again today', c2.state.fills.filter((f) => f.book === 'crypto').map((f) => f.sym).sort(), ['BTC-USD', 'DOGE-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD']);
    const snap = c2.snapshot();
    ok("the book's line names the five and the share each has", /^Holds BTC, ETH, SOL, XRP, DOGE, a fifth each,/.test(snap.books[0].rule), snap.books[0].rule);
    eq('its markets on the floor are the five', snap.books[0].rows.map((r) => [r.name, r.label]), [['BTC', 'Bitcoin'], ['ETH', 'Ether'], ['SOL', 'Solana'], ['XRP', 'XRP'], ['DOGE', 'Dogecoin']]);
    // the daily check replays the journal from each slot's own starting cash: the new slots need nothing more
    const dc = require('./desk-check');
    const ev = dc.readDesk(path.join(cdir, 'desk'));
    eq('and the journal rebuilds the five-coin ledger to the penny', dc.compare(dc.rebuild(ev.events, c2.state), c2.state), []);
    c2.save();
    const c3 = new Desk(five, { feeds, now: () => T });
    eq('only once', [c3.state.books.crypto.initial, c3.state.history.slice(0, 2).map((p) => p.e)], [15000, [29000, 28990]]);
    for (const id of ['XRP-USD', 'DOGE-USD']) { delete W.ticks[id]; delete W.daily[id]; delete W.books[id]; }
    fs.rmSync(cdir, { recursive: true, force: true });
  }
  // A book with some slots bought in and one not yet is held against holding the bought ones and the other's cash
  {
    const pd = new Desk({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-')) }, { feeds, now: () => T });
    pd.quiet = true;
    eq('a book none of whose slots has bought in has no holding', [pd.benchValue('crypto'), pd.benchFee('crypto')], [null, null]);
    await pd.step();
    const sol = pd.state.books.crypto.sleeves['SOL-USD'];
    const both = pd.benchValue('crypto'), fee = pd.benchFee('crypto');
    const solHeld = r2(sol.initial * pd.coinBid('SOL-USD') / (sol.benchPx * 1.004));
    Object.assign(sol, { benchPx: null, benchAt: null });
    near('a slot not bought in yet counts as its cash', pd.benchValue('crypto'), r2(both - solHeld + sol.initial), 0.011);
    near('and has paid no fee to buy in', pd.benchFee('crypto'), r2(fee * 2 / 3), 0.011);
  }

  // The runner book, round by round: a first scan only looks, the next buys the runners still climbing (a
  // quarter of the book each, Robinhood's 0.95%, in the coin's own step), the trail sells one 10% off its
  // best, and a coin sold waits 12 hours. The journal rebuilds the book to the penny.
  {
    const rdir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    let t = T;
    const rd = new Desk({ ...cfg, dataDir: rdir }, { feeds, now: () => t });
    rd.quiet = true;
    const saved = { stats: W.stats, books: { ...W.books } };
    const run = (id, open, last, high, volume) => ({ [id]: { open, high: high ?? last, low: open, last, volume } });
    W.stats = { ...run('QNT-USD', 250, 298, 300, 1e5), ...run('NEAR-USD', 5, 5.25, 5.3, 1e7), ...run('ENA-USD', 0.2, 0.23, 0.231, 1e8) };
    const setBook = (id, px) => { W.books[id] = { bids: [{ price: px - px * 0.001, size: 1e9 }], asks: [{ price: px + px * 0.001, size: 1e9 }] }; };
    setBook('QNT-USD', 298); setBook('ENA-USD', 0.23);
    W.products['ENA-USD'] = 0.1;
    const rb = rd.state.books.runners;
    await rd.runnerBook();
    eq('the first scan only looks: climbing needs a scan before it', [rb.lots.length, rb.scan.top.map((r) => r.status)], [0, ['first look: climbing is checked at the next scan', 'first look: climbing is checked at the next scan', 'needs 8%']]);
    t += 60000; W.stats['QNT-USD'].last = 299;
    await rd.runnerBook();
    eq('a minute on, the book does not scan again', rb.scans, 1);
    t += 120000; W.stats['QNT-USD'].last = 299; W.stats['ENA-USD'].last = 0.2305;
    await rd.runnerBook();
    eq('three minutes on, both runners still climbing are bought, strongest first', rb.lots.map((l) => l.sym), ['QNT-USD', 'ENA-USD']);
    const [qnt, ena] = rb.lots;
    ok('each for a quarter of the book, the fee inside it, to the coin\'s step', qnt.cost <= 250 && qnt.cost > 249.69 && ena.cost <= 250 && ena.cost > 248.5, rb.lots.map((l) => l.cost));
    near("at Robinhood's 0.95%", ena.cost - ena.qty * ena.entry, ena.qty * ena.entry * 0.0095, 0.011);
    ok('in the step Coinbase sells the coin in (QNT in thousandths)', Math.abs(qnt.qty * 1000 - Math.round(qnt.qty * 1000)) < 1e-6, qnt.qty);
    eq('its best so far is the scan price it was bought at', [ena.peak, qnt.peak], [0.2305, 299]);
    const jr = fs.readFileSync(path.join(rdir, 'desk', `journal-${clock.et(t).day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((j) => j.kind === 'FILL' && j.book === 'runners');
    eq('each buy is journaled with the run it bought: the move, how far off the high, the dollars traded', [jr[1].sym, jr[1].move, jr[1].volUsd], ['ENA-USD', 0.1525, 23050000]);
    ok('and said on the floor as a signal', rd.state.log.some((l) => l.agent === 'BRAM' && l.kind === 'SIGNAL' && /^runners: ENA is running: up 15\.3% in 24 hours/.test(l.text)));
    // QNT climbs to 330, then falls back: 297 is exactly 10% under its best, and it goes
    t += 180000; W.stats['QNT-USD'].last = 330; W.stats['QNT-USD'].high = 330;
    await rd.runnerBook();
    eq('a new high raises its best', qnt.peak, 330);
    near('and marks the book at the scan', rd.bookValue('runners'), r2(rb.cash + ena.qty * 0.2305 + qnt.qty * 330), 0.011);
    t += 180000; W.stats['QNT-USD'].last = 297; setBook('QNT-USD', 297);
    await rd.runnerBook();
    eq('10% under its best, it is sold', rb.lots.map((l) => l.sym), ['ENA-USD']);
    const qt = rb.trades.find((x) => x.sym === 'QNT-USD');
    eq('the trade is closed with why', [qt.open, qt.why], [false, 'fell 10% from its best since bought']);
    near('its P&L is what the sale brought less what it cost', qt.pnl, rb.realized, 0.001);
    ok('a coin sold waits 12 hours', rb.cool['QNT-USD'] === t);
    t += 180000; W.stats['QNT-USD'].last = 320; W.stats['QNT-USD'].high = 320;
    await rd.runnerBook();
    eq('...even when it runs again', [rb.lots.map((l) => l.sym), rb.scan.top.find((r) => r.id === 'QNT-USD').status], [['ENA-USD'], 'sold in the last 12 hours']);
    // the daily check replays the book from its journal
    const dc = require('./desk-check');
    const ev = dc.readDesk(path.join(rdir, 'desk'));
    eq('the journal rebuilds the runner book to the penny', dc.compare(dc.rebuild(ev.events, rd.state), rd.state), []);
    const snap = rd.snapshot(), rbk = snap.books.find((x) => x.key === 'runners');
    eq('the floor gets the book, its coin, where it goes out, and the scan', [rbk.rows.map((r) => [r.name, r.stop]), snap.runners.n, snap.runners.slots],
      [[['ENA', r6(0.2305 * 0.9)]], 3, 4]);
    // past the day's loss limit it buys nothing, and says so
    t += 180000; W.stats['NEAR-USD'] = run('NEAR-USD', 5, 5.6, 5.61, 1e7)['NEAR-USD']; rd.halt = 'down 6% today';
    await rd.runnerBook();
    t += 180000; W.stats['NEAR-USD'].last = 5.605;
    await rd.runnerBook();
    ok('halted, a runner is not bought', !rb.lots.some((l) => l.sym === 'NEAR-USD') && rd.state.log.some((l) => /^runners: NEAR is running.*not buying: down 6% today/.test(l.text)), rb.lots.map((l) => l.sym));
    // Coinbase's product list failing (only buying needs it) or a held coin dropping out of the figures must
    // not stop the book from selling what it holds
    rd.halt = null; rb.lots.length = 0; rb.cool = {};
    rb.lots.push({ id: 90, trade: 'R90', sym: 'ENA-USD', qty: 1000, cost: 230, entry: 0.23, peak: 0.2305, mark: 0.2305, openedAt: t });
    rd.mkt.runners.steps = null; rd.mkt.runners.stepsAt = 0; rd.mkt.runners.failAt = 0;
    const realProducts = feeds.coinProducts;
    feeds.coinProducts = async () => { throw new Error('503'); };
    t += 180000; W.stats['ENA-USD'].last = 0.2; setBook('ENA-USD', 0.2);
    await rd.runnerBook();
    eq('with the product list down, a coin 10% off its best is still sold', rb.lots.length, 0);
    feeds.coinProducts = realProducts;
    rb.lots.push({ id: 91, trade: 'R91', sym: 'ENA-USD', qty: 1000, cost: 230, entry: 0.23, peak: 0.2305, mark: 0.2305, openedAt: t - 49 * 3600000 });
    delete W.stats['ENA-USD']; setBook('ENA-USD', 0.2);
    t += 180000;
    await rd.runnerBook();
    eq('a coin gone from the 24-hour figures is sold once it has been held 48 hours', rb.lots.length, 0);
    // Switched off (DESK_RUNNERS=0, the default since 2026-10-08): the next scan sells what it holds, at once and
    // whatever its trail says, and buys nothing; flat, the round stops calling it and the daily check says it is off
    W.stats['ENA-USD'] = run('ENA-USD', 0.2, 0.23, 0.231, 1e8)['ENA-USD']; setBook('ENA-USD', 0.23);
    rb.lots.push({ id: 92, trade: 'R92', sym: 'ENA-USD', qty: 1000, cost: 230, entry: 0.23, peak: 0.23, mark: 0.23, openedAt: t });
    rb.trades.unshift({ id: 'R92', sym: 'ENA-USD', qty: 1000, entry: 0.23, cost: 230, openedAt: t, open: true, pnl: 0 });
    W.stats['NEAR-USD'] = run('NEAR-USD', 5, 5.6, 5.61, 1e7)['NEAR-USD']; setBook('NEAR-USD', 5.6); W.products['NEAR-USD'] = 0.1;
    rd.D = { ...rd.D, runners: false };
    t += 180000; W.stats['NEAR-USD'].last = 5.605;
    await rd.bram();
    eq('off, a coin still well inside its trail is sold at the next scan', [rb.lots.length, rb.trades[0].why], [0, 'the book is switched off']);
    ok('and nothing is bought, however hard a coin runs', !rb.trades.some((x) => x.sym === 'NEAR-USD'), rb.trades.map((x) => x.sym));
    eq('the book is marked off in the state', rb.off, true);
    const scans = rb.scans;
    t += 180000;
    await rd.bram();
    eq('flat and off, it scans no more', rb.scans, scans);
    eq('the daily check says it is off, not stopped', [dc.health(rd.state, t + 3600000).problems.filter((x) => /runners/.test(x)), dc.health(rd.state, t + 3600000).lines.filter((x) => /runners/.test(x))],
      [[], ['runners: switched off, holding nothing']]);
    eq('the journal still rebuilds the book to the penny', dc.compare(dc.rebuild(dc.readDesk(path.join(rdir, 'desk')).events, rd.state), rd.state), []);
    eq('the floor says switched off', rd.snapshot().runners.enabled, false);
    // the options and scalp books off (the default since 2026-10-08): marked off in the state, and on a trading
    // afternoon the daily check says so instead of calling a missing 12:30 verdict or a book not watching a problem
    rd.D = { ...rd.D, options: false, scalps: false, dips: false };
    t += 60000;
    await rd.bram();
    eq('off books are marked off', [rd.state.books.options.off, rd.state.books.scalps.off, rd.state.books.dips.off], [true, true, true]);
    const thu = clock.atMin('2026-10-08', 13 * 60 + 30), st = { ...rd.state, startedAt: 0 };
    const hh = dc.health(st, thu);
    eq('the daily check: switched off, not a problem', [hh.problems.filter((x) => /^(options|scalps|dips)/.test(x)), hh.lines.filter((x) => /^(options|scalps|dips)/.test(x))],
      [[], ['options: switched off', 'scalps: switched off', 'dips: switched off']]);
    eq('the floor says switched off', [rd.snapshot().options.enabled, rd.snapshot().scalps.enabled], [false, false]);
    rd.D = { ...rd.D, runners: true, options: true, scalps: true, dips: true };
    W.stats = saved.stats; W.books = saved.books; delete W.products['ENA-USD']; delete W.products['NEAR-USD'];
    fs.rmSync(rdir, { recursive: true, force: true });
  }

  // the loss limit: no new buying, selling still allowed
  const fresh = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
  const d2 = new Desk({ ...cfg, dataDir: fresh }, { feeds, now: () => T });
  d2.quiet = true;
  d2.state.dayKey = '2026-09-23'; d2.state.dayStart = 40000;
  await d2.step();
  ok('past the daily loss limit, TESS halts buying', /past the 5% limit/.test(d2.halt || ''), d2.halt);
  eq('and nothing is bought', d2.state.fills.length, 0);

  // The desk's own watchdog. A round that never returns holds the loop for good, and the process stays up
  // looking like a quiet market: past WATCHDOG_SEC with no finished round the desk says so, saves, and asks
  // server.js to end the process. Never a healthy desk, a laptop that slept, or a live-mode process.
  {
    const wdDir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-'));
    const stalls = [];
    let now = T;
    const w = new Desk({ ...cfg, dataDir: wdDir, watchdogSec: 300 }, { feeds, now: () => now, onStall: (x) => stalls.push(x) });
    w.quiet = true;
    w.wdLast = now; w.beat = now - 10000;
    eq('a desk whose last round finished ten seconds ago is left alone', w.watchdogCheck(now), null);
    w.wdLast = now; w.beat = now - 301000; w.stepping = true;
    now += 15000;
    const st = w.watchdogCheck(now);
    ok('one with no round finished for five minutes is reported', st && st[0].loop === 'desk' && st[0].idleMs === 316000, st);
    eq('...and asks, once, for the process to end', stalls.length, 1);
    const wj = fs.readFileSync(path.join(wdDir, 'desk', `journal-${clock.et(now).day}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l)).find((x) => x.kind === 'WATCHDOG');
    ok('...its journal says a round is still open and that it is restarting', wj && wj.stepping === true && wj.restarting === true, wj);
    ok('...its log says so, as a warning', /^WATCHDOG: no round finished in 316s/.test(w.state.log[0].text) && logLevel(w.state.log[0]) === 'warn', w.state.log[0]);
    ok('...and its ledger is saved first', fs.existsSync(path.join(wdDir, 'desk', 'state.json')));
    w.wdLast = now; w.beat = now - 20 * 60000;
    eq('a wake from sleep (the check an hour late) is not a stall', w.watchdogCheck(now + 3600000), null);
    ok('...and the loop gets a fresh start', w.beat === now + 3600000 && stalls.length === 1, w.beat);
    const live = new Desk({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-')), watchdogSec: 300, mode: 'live' }, { feeds, now: () => now, onStall: (x) => stalls.push(x) });
    live.quiet = true;
    live.wdLast = now; live.beat = now - 20 * 60000;
    ok('in live mode (the other desk may have an order in flight) the stall is reported', live.watchdogCheck(now + 15000) && /live mode, not restarting/.test(live.state.log[0].text), live.state.log[0]);
    eq('...but the process is not ended', stalls.length, 1);
    const off = new Desk({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-')), watchdogSec: 0 }, { feeds, now: () => now, onStall: (x) => stalls.push(x) });
    off.wdLast = now; off.beat = 0;
    eq('WATCHDOG_SEC=0 turns it off', off.watchdogCheck(now + 15000), null);
    fs.rmSync(wdDir, { recursive: true, force: true });
  }

  // The P&L history: every minute of the last day, and the days before thinned to about 1,500 points. It
  // was thinned alike the whole way, and at the 30,000 minutes it keeps the last hour would have been three.
  {
    const hd = new Desk({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'desk-test-')) }, { feeds, now: () => T });
    const t0 = T - 30000 * 60000, pt = (i) => ({ t: t0 + i * 60000, e: 20000 + i / 100, c: 9000, s: 10000, o: 1000, bc: 9000, bs: 10000 });
    hd.state.history = Array.from({ length: 30000 }, (_, i) => pt(i));
    const H = hd.pnlHistory(), end = hd.state.history[29999].t;
    const recent = H.points.filter((p) => p.t > end - 864e5), older = H.points.filter((p) => p.t <= end - 864e5);
    eq('every minute of the last day is sent', recent.length, 1440);
    ok('the days before are thinned to about 1,500 points', older.length > 1400 && older.length <= 1500, older.length);
    eq('the history says how far apart those are', H.step, 60 * Math.ceil(28560 / 1500));
    eq('and where every minute begins', H.recentFrom, recent[0].t);
    ok('it starts at the first minute and ends at the last', H.points[0].t === t0 && H.points[H.points.length - 1].t === end);
    ok('in time order', H.points.every((p, i) => !i || p.t > H.points[i - 1].t));
    hd.state.history = Array.from({ length: 100 }, (_, i) => pt(i));
    const S2 = hd.pnlHistory();
    ok('a history shorter than a day is sent whole', S2.points.length === 100 && S2.step === 60 && S2.recentFrom === t0, [S2.points.length, S2.step]);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(fresh, { recursive: true, force: true });
}

// ------------------------------------------------------------------ audit 2026-10-07
async function auditTests() {
  const { DAY: D0, at: atT } = require('./desk-fixture');
  const mkDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-audit-desk-'));
  const settles = (dir) => { try { return fs.readFileSync(path.join(dir, 'desk', `journal-${D0}.jsonl`), 'utf8').split('\n').filter((l) => /"SETTLE"/.test(l)).map((l) => JSON.parse(l)); } catch { return []; } };

  // a sub-cent coin's average price was rounded to 6 decimals: BONK at 3.70e-6 came back as 4e-6
  {
    const f = broker.fill({ kind: 'crypto', side: 'buy', qty: 1e9, step: 1 }, { bid: 3.69e-6, ask: 3.70e-6 }, { cryptoBps: 40 });
    ok('a sub-cent coin keeps its price to 8 significant digits, not 6 decimals', f.avg > 0 && Math.abs(f.avg - 3.70e-6) < 1e-12, f);
    const g = broker.fill({ kind: 'crypto', side: 'buy', qty: 100 }, { bid: 99.6, ask: 99.666667 }, { cryptoBps: 40 });
    ok('...and an ordinary price is unchanged', g.avg === 99.666667, g);
  }

  // an option that expired today settled on whatever quote the desk held, however old
  {
    const dir = mkDir();
    let T = atT('10:06');
    const M = fakeMarket(() => T);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    M.setMinutes(10 * 60 + 5);
    M.W.chain = { expiry: D0, spot: 700.7, at: atT('10:05'), calls: [M.call(700, 1.5, 1.51, 1.6, 0.58), M.call(701, 0.99, 1, 1.2, 0.45), M.call(702, 0.6, 0.61, 0.7, 0.33)], puts: [] };
    await desk.step();
    const lot = desk.state.books.scalps.lots[0];
    ok('a scalp lot is held to settle', !!lot);
    lot.strike = 700.5;                                    // 0.60 in the money on the after-hours quote, worthless on the close
    const dead = async () => { throw new Error('Cboe down'); };
    const alive = { ...M.feeds };
    Object.assign(M.feeds, { quote: dead, intraday: dead, expiry: dead, daily: dead });
    T = atT('16:21'); await desk.step();
    ok('Cboe down since 10:05: the lot waits for the close, not settles on a six-hour-old quote', desk.state.books.scalps.lots.length === 1 && !settles(dir).length, settles(dir));
    // Cboe is back: the day's bars run to the 16:00 bar (700.20) while the quote has moved on after hours (701.10)
    Object.assign(M.feeds, alive);
    const bars = M.W.intra.bars.slice();
    bars.push({ day: D0, m: 960, t: atT('16:00'), o: 700.2, h: 700.3, l: 700.1, c: 700.2, v: 1 });
    M.W.intra = { day: D0, bars };
    M.W.quote = { ...M.W.quote, last: 701.1, bid: 701.09, ask: 701.11, at: T - 60000 };
    T += 60000; await desk.step();
    const sl = settles(dir);
    ok('with the 16:00 bar in hand it settles on the close (700.20), not the after-hours quote', sl.length === 1 && sl[0].spy === 700.2 && sl[0].value === 0, sl);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // one coin's dead ticker used to freeze the whole crypto book
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const orig = M.feeds.ticker;
    M.feeds.ticker = async (id) => { if (id === 'SOL-USD') throw new Error('HTTP 404 from api.exchange.coinbase.com'); return orig(id); };
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    for (let i = 0; i < 3; i++) { await desk.step(); T += 10000; }
    const sl = desk.state.books.crypto.sleeves;
    ok('SOL\'s ticker is down: BTC and ETH still rebalance', sl['BTC-USD'].qty > 0 && sl['ETH-USD'].qty > 0, [sl['BTC-USD'].qty, sl['ETH-USD'].qty]);
    ok('...and SOL, with no price, stays out', sl['SOL-USD'].qty === 0 && sl['SOL-USD'].checkDay == null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // holding's start price must not be set by a first check TESS blocked; and a halt is said once
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    desk.state.dayKey = clock.et(T).day; desk.state.dayStart = desk.equity() / 0.9;     // 10% down on the day at the first look
    await desk.step();
    const btc = desk.state.books.crypto.sleeves['BTC-USD'];
    ok('halted at the first check: nothing bought', !!desk.halt && btc.qty === 0, [desk.halt, btc.qty]);
    ok('...so holding\'s start price is not set from a price the book never paid', !(btc.benchPx > 0), btc.benchPx);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a halt that goes on is one log line: the text carries the live percentage, so it used to log at every move
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();                                    // crypto and SPY bought
    desk.state.dayStart = desk.equity() / 0.9;            // 10% down on the day from here
    for (let i = 0; i < 20; i++) {
      T += 10000;
      const wob = 1 + 0.05 * Math.sin(i * 1.3);           // BTC wobbles, and the figure in the text with it
      M.W.ticks['BTC-USD'] = { bid: 84000 * wob, ask: 84000 * wob + 0.01, last: 84000 * wob, at: T };
      for (const id of ['ETH-USD', 'SOL-USD']) M.W.ticks[id].at = T;
      await desk.step();
    }
    const lines = desk.state.log.filter((l) => l.kind === 'HALT').length;
    ok('twenty rounds of one halt, the price moving: one HALT line', !!desk.halt && lines === 1, lines);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a fill's bookmarks reach the disk with it: the entry bar the exit scan starts after
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();
    T = atT('12:32') + 10000; M.setMinutes(12 * 60 + 31);
    M.W.chain = { expiry: D0, spot: 703.62, at: atT('12:31'), calls: [M.call(704, 0.3, 0.31, 0.5), M.call(705, 0.09, 0.1, 0.15), M.call(706, 0.04, 0.05, 0.1)], puts: [] };
    await desk.step();
    const mem = desk.state.books.options.day;
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'desk', 'state.json'), 'utf8')).books.options;
    ok('the options book bought on the 12:31 bar', onDisk.lots.length > 0 && mem.entryBarM === 12 * 60 + 31, [onDisk.lots.length, mem.entryBarM]);
    ok('...and the saved state already carries that entry bar: a hard kill must not lose which bar the exits start after', onDisk.day && onDisk.day.entryBarM === 12 * 60 + 31, onDisk.day);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- audit 2026-10-07, the rules pass
  // the daily-loss halt holds for the rest of the Eastern day
  {
    const dir = mkDir();
    let T = atT('11:00');
    const M = fakeMarket(() => T);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();
    const eq0 = desk.equity();
    desk.state.books.options.cash -= eq0 * 0.055; desk.tess();
    ok('down 5.5% today: no new buying', /past the 5% limit/.test(desk.halt || ''), desk.halt);
    desk.state.books.options.cash += eq0 * 0.01; desk.tess();
    ok('back to -4.5% the same day: still halted, as "until tomorrow" says', !!desk.halt && /until tomorrow/.test(desk.halt), desk.halt);
    ok('...and the latch is in the saved state, so a restart keeps it', desk.state.haltDay === clock.et(T).day && !!desk.state.haltWhy);
    T += 86400000; desk.tess();
    ok('the next Eastern day it lifts, with its line', desk.halt === null && desk.state.log.some((l) => l.text === 'new day: buying allowed again'), [desk.halt, desk.state.log.slice(0, 2).map((l) => l.text)]);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a scalp's time exit with no bid on the contract must not throw
  {
    const dir = mkDir();
    let T = atT('10:06');
    const M = fakeMarket(() => T);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    M.setMinutes(10 * 60 + 5);
    M.W.chain = { expiry: D0, spot: 700.7, at: atT('10:05'), calls: [M.call(700, 1.5, 1.51, 1.6, 0.58), M.call(701, 0.99, 1, 1.2, 0.45), M.call(702, 0.6, 0.61, 0.7, 0.33)], puts: [] };
    await desk.step();
    ok('a scalp is held', desk.state.books.scalps.lots.length === 1);
    T = atT('10:21'); M.setMinutes(10 * 60 + 20);
    M.W.chain = { expiry: D0, spot: 700.8, at: atT('10:20'), calls: [M.call(700, 1.4, 1.41, 1.6, 0.55), M.call(701, null, 1.06, 1.2, 0.44), M.call(702, 0.7, 0.71, 0.95, 0.35)], puts: [] };
    await desk.step();
    ok('fifteen minutes in, the contract has no bid: the round does not fail', !desk.state.log.some((l) => /desk round failed/.test(l.text)), desk.state.log.slice(0, 3).map((l) => l.text));
    ok('...and the time exit sells it, saying why', desk.state.books.scalps.lots.length === 0 && desk.state.fills.some((f) => f.book === 'scalps' && f.side === 'sell' && /no bid/.test(f.why || '')), desk.state.fills.slice(0, 2));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // the dip runner is not faded on a bar before the reclaim
  {
    const lot = { role: 'runner', stop: 697.5, spy: 698.14, entry: 0.3, reclaimM: 611 };     // handed over by the sibling that sold on the 10:11 reclaim
    const bar = (m, c) => ({ m, c, vw: 699 });
    const fresh = [bar(610, 698.0), bar(611, 700.2)];
    const r = B.dipExit(lot, fresh, fresh[1], null);
    ok('a close under its buy price at 10:10, before the 10:11 reclaim, is not a fade', r.exit === null, r.exit);
    const after = B.dipExit(lot, [bar(612, 698.0)], bar(612, 698.0), null);
    ok('the same close after the reclaim is', after.exit && after.exit.kind === 'fade' && after.exit.bar.m === 612, after.exit);
  }

  // the options book takes a trigger one bar late, when a single read brought two bars
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();
    T = atT('12:33') + 10000; M.setMinutes(12 * 60 + 32);                 // the 12:32 round never ran: this read has the 12:31 trigger AND the 12:32 bar
    M.W.chain = { expiry: D0, spot: 703.62, at: atT('12:31'), calls: [M.call(704, 0.3, 0.31, 0.5), M.call(705, 0.09, 0.1, 0.15), M.call(706, 0.04, 0.05, 0.1)], puts: [] };
    await desk.step();
    const o = desk.state.books.options;
    ok('the 12:31 trigger is bought although the 12:32 bar is already in', o.lots.length > 0 && o.day.entryBarM === 12 * 60 + 31, { lots: o.lots.length, entry: o.day.entryBarM, log: desk.state.log.slice(0, 2).map((l) => l.text) });
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // the two hand-kept lists say when they have run out
  {
    ok('the runner list no longer holds coins Coinbase has no USD market for', !['CASHCAT', 'CC', 'GRAM', 'MEW', 'MNT', 'LIT'].some((c) => B.RUNNER_COINS.has(c)) && B.RUNNER_COINS.has('BONK'));
    ok('...and says when Robinhood\'s list was read', /^\d{4}-\d{2}-\d{2}$/.test(B.RUNNER_COINS_AS_OF) && B.RUNNER_COINS_STALE_DAYS > 0 && B.FED_LAST === '2026-12-09');
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();
    ok('the runner scan names the list entries with no Coinbase figures', desk.state.log.some((l) => /have no Coinbase USD figures and cannot run/.test(l.text)));
    T = clock.etToUtc('2026-12-01T12:00:00'); desk.tess();
    const said = desk.state.log.map((l) => l.text);
    ok('on 2026-12-01 TESS says the Fed days run out on 12-09 and the runner list is over 60 days old', said.some((t) => /Fed days.*end 2026-12-09/.test(t)) && said.some((t) => /runner coin list.*2026-09-30/.test(t)), said.slice(0, 4));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- audit 2026-10-07, follow-ups
  // a failed Cboe fetch is not retried every round
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    await desk.step();
    let calls = 0;
    M.feeds.quote = async () => { calls++; throw new Error('HTTP 403 from cdn.cboe.com'); };
    desk.mkt.spy.quoteAt = 0;                                    // due now
    for (let i = 0; i < 12; i++) { T += 10000; await desk.step(); }
    ok('two minutes of a failing quote feed: a handful of tries (10 s, 20 s, 40 s apart), not one a round', calls >= 3 && calls <= 5, calls);
    // it is back: the next try goes through, and the count of failures starts over
    M.feeds.quote = async () => M.W.quote;
    T += 130000; await desk.step();
    ok('...and a try that works clears the wait', !desk.mkt.spy.fail.quote && desk.mkt.spy.quoteAt === T, desk.mkt.spy.fail);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a target is what the book was traded to: an order that did not fill does not move it
  {
    const dir = mkDir();
    let T = atT('12:31');
    const M = fakeMarket(() => T); M.setMinutes(12 * 60 + 30);
    const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T }); desk.quiet = true;
    desk.kett = async () => null;                                // every order is refused (no depth, not enough cash)
    await desk.step();
    const btc = desk.state.books.crypto.sleeves['BTC-USD'], spy = desk.state.books.stocks.sleeves.SPY;
    ok('the buys did not fill: the sleeves still hold nothing and claim no target', btc.qty === 0 && btc.target == null && spy.target == null, [btc.qty, btc.target, spy.target]);
    ok('...but today\'s check is done, so it is not retried every round', btc.checkDay != null && spy.checkDay != null);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // a failed save reaches the log, where the floor and the daily check see it
  {
    const dir = mkDir();
    const desk = new Desk(deskConfig(dir), { feeds: fakeMarket(() => atT('12:31')).feeds, now: () => atT('12:31') }); desk.quiet = true;
    const file = path.join(dir, 'a-file'); fs.writeFileSync(file, 'x');
    desk.dir = path.join(file, 'desk');                          // a directory under a file: mkdir fails
    const err = console.error; console.error = () => {};
    try { desk.save(); desk.save(); } finally { console.error = err; }
    const lines = desk.state.log.filter((l) => /state save failed/.test(l.text));
    ok('a save that fails says so once, not on every try', lines.length === 1, lines.map((l) => l.text));
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

engineTests().then(auditTests).then(() => {
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.log(`  FAIL  engine tests threw: ${e.stack}`); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

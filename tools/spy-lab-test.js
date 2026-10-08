'use strict';
// The SPY lab: minutes labelled as Cboe labels them, the option model, and both books' days run through
// the books' own code.
const { sessions, bs, quote, chain, dayVol, impliedVol, scalpDay, dipDay, optionsDay, run } = require('./spy-lab');
const books = require('../src/desk/books');
const clock = require('../src/desk/clock');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

// ---- the sessions: Massive stamps a minute by its start, the books read it by its end
{
  const t930 = clock.etToUtc('2025-03-03T09:30:00'), t929 = clock.etToUtc('2025-03-03T09:29:00'), t1559 = clock.etToUtc('2025-03-03T15:59:00');
  const s = sessions([[t929, 1, 1, 1, 1, 1], [t930, 10, 11, 9, 10.5, 100], [t1559, 20, 21, 19, 20.5, 5]]);
  eq('one session', s.map((x) => x.day), ['2025-03-03']);
  eq('9:30-9:31 is the 9:31 bar; 9:29 is not the session; 3:59 is the 4:00 bar', s[0].bars.map((b) => b.m), [9 * 60 + 31, 16 * 60]);
  eq("the session's daily bar: first open, high, low, last close", [s[0].daily.o, s[0].daily.h, s[0].daily.l, s[0].daily.c], [10, 21, 9, 20.5]);
}
function eq(name, got, want) { ok(name, JSON.stringify(got) === JSON.stringify(want), got); }

// ---- the option model
{
  const c = bs(500, 500, 195, 0.15, 'C'), p = bs(500, 500, 195, 0.15, 'P');
  near('put-call parity with no rate: C - P = S - K', c.px - p.px, 0, 1e-9);
  ok('at the money, a call delta near 0.5', Math.abs(c.delta - 0.5) < 0.01, c.delta);
  near('a put delta is the call delta less one', p.delta, c.delta - 1, 1e-12);
  near('at the bell a call is worth what it is in the money', bs(505, 500, 0.0001, 0.15, 'C').px, 5, 1e-6);
  const q = quote(500, 503, 12 * 60, 0.15, 'C');
  ok('under $1 the model quotes a cent either side', q.mid < 1 && Math.abs(q.ask - q.bid - 0.02) < 1e-9, q);
  const deep = quote(500, 490, 10 * 60, 0.15, 'C');
  near('over $1, two cents either side', deep.ask - deep.bid, 0.04, 1e-9);
  ok('a worthless strike still asks a cent', quote(500, 560, 15 * 60 + 50, 0.10, 'C').ask === 0.01);
  eq('a dollar grid fifteen strikes each side', chain(500.4, 600, 0.15, 'P').map((r) => r.strike).filter((k, i, a) => i === 0 || i === a.length - 1), [485, 515]);
  // volatility: 20 returns of +1%, -1% alternating, annualised, times the multiplier
  const dailies = Array.from({ length: 22 }, (_, i) => ({ c: 100 * (i % 2 ? 1.01 : 1) }));
  const v = dayVol(dailies, 21, 1.0);
  ok('realised volatility of a 1% zigzag is about 16% a year', v > 0.15 && v < 0.17, v);
  near('times --iv', dayVol(dailies, 21, 1.5), v * 1.5, 1e-12);
  ok('never under 2%', dayVol(Array.from({ length: 22 }, () => ({ c: 100 })), 21, 1) === 0.02);
  // the volatility a real ask implies: a quote made at 11% gives 11% back
  const q11 = quote(500, 502, 11 * 60, 0.11, 'C');
  near('impliedVol recovers the volatility that priced an ask', impliedVol(500, 502, 11 * 60, 'C', q11.ask), 0.11, 0.004);
  ok('and says null for an ask no volatility reaches', impliedVol(500, 502, 11 * 60, 'C', 50) === null);
}

// ---- a day of minutes from a price path, one price per minute from 9:31
const DAY = '2025-03-03';
const minutes = (prices, vol = 1000) => prices.map((c, i) => ({ m: 9 * 60 + 31 + i, o: i ? prices[i - 1] : c, h: Math.max(c, i ? prices[i - 1] : c), l: Math.min(c, i ? prices[i - 1] : c), c, v: vol }));
const flatTo = (px, until) => Array(until - (9 * 60 + 31) + 1).fill(px);   // flat through the minute `until` closes

// ---- scalps: flat to 10:05, a break up in the 10:05-10:10 bar, then a run
{
  const path = flatTo(500, 10 * 60 + 5).concat([500.5, 501, 501.5, 502, 502.5]);   // the 10:05 bar closes 502.5, over the range
  const up = path.concat(Array.from({ length: 40 }, (_, i) => 502.5 + 0.2 * (i + 1)));
  const t = scalpDay(DAY, minutes(up), 0.15);
  ok('one scalp, a call, on the 10:05 bar (it closes 10:10)', t.length >= 1 && t[0].dir === 'up' && t[0].m === 10 * 60 + 10, t[0]);
  const want = books.pickScalp(chain(502.5, 10 * 60 + 10, 0.15, 'C'), 'up', 10 * 60 + 5).row;
  ok("bought what books.pickScalp picks from the model's grid, at its ask", t[0] && t[0].strike === want.strike && t[0].entry === want.ask, [t[0], want]);
  ok('SPY kept running: out at the 1.5x target', t[0] && t[0].kind === 'target', t[0]);
  near('the target pays 1.5x less the fee both ways', t[0] && t[0].pnl, (Math.round(want.ask * 1.5 * 1e4) / 1e4 - want.ask) * 100 - 0.06, 1e-9);
  // back inside the range on the next bar: the stop
  const back = path.concat(Array(5).fill(499.8)).concat(Array(300).fill(499.8));
  const s = scalpDay(DAY, minutes(back), 0.15);
  ok('back inside the range it broke: out on the stop, at the bid', s[0] && s[0].kind === 'stop' && s[0].pnl < 0, s[0]);
  ok('SPY its way is negative for a stop', s[0] && s[0].spy < 0, s[0]);
}

// ---- dips: down from the open, a turn up under VWAP after 10:05, then back above VWAP
{
  // 500 to 10:00, falling to 497 by 10:04, a turn up at 10:06, then a climb past VWAP
  const path = flatTo(500, 10 * 60).concat([499, 498, 497.5, 497, 497.2, 497.6]);
  const up = path.concat(Array.from({ length: 60 }, (_, i) => 497.6 + 0.08 * (i + 1))).concat(Array(240).fill(502.4));
  const bars = minutes(up);
  const atr = 4;   // the dip, 3 points, is 0.75 ATR
  const t = dipDay(DAY, bars, atr, 0.09);   // at 15% every call 2-3 points out asks over $0.45, and the book rightly buys none
  ok('one dip trade', t.length === 1, t);
  ok('bought on the 10:06 turn', t[0] && t[0].m === 10 * 60 + 6, t[0]);
  const want = books.pickDip(chain(497.6, 10 * 60 + 6, 0.09, 'C'), 497.6).row;
  ok("the call books.pickDip picks, 2-3 points out", t[0] && want && t[0].strike === want.strike, [t[0], want]);
  ok('the first call sells on the reclaim of VWAP', t[0] && /^reclaim/.test(t[0].exits[0]), t[0] && t[0].exits);
  ok('both calls closed by the end of the day', t[0] && t[0].exits.length === 2, t[0] && t[0].exits);
  // no ATR, no trades
  eq('without an ATR the book does not trade', dipDay(DAY, bars, null, 0.09), []);
  eq('nor when every call 2-3 points out asks over $0.45', dipDay(DAY, bars, atr, 0.15), []);
  // a day that never dips enough
  eq('a dip under 0.25 ATR is not one', dipDay(DAY, bars, 20, 0.09), []);
}

// ---- options: a trend day up, a new high after 12:30, then a run past both targets
{
  // 500 at the open, a steady climb to 503 by 12:30 (0.75 ATR at ATR 4), a new high at 12:31, then on up
  const n1230 = 12 * 60 + 30 - (9 * 60 + 31) + 1;
  const climb = Array.from({ length: n1230 }, (_, i) => 500 + 3 * (i + 1) / n1230);
  const path = climb.concat([503.05]).concat(Array.from({ length: 160 }, (_, i) => 503.05 + 0.03 * (i + 1)));
  const o = optionsDay(DAY, minutes(path), 4, 0.08);
  ok('the 12:30 test passes up', o.verdict === 'pass up', o.verdict);
  ok('one trade, bought on the 12:31 new high', o.trades.length >= 1 && o.trades[0].m === 12 * 60 + 31, o.trades[0]);
  const want = books.pickContract(chain(503.05, 12 * 60 + 31, 0.08, 'C'), 503.05, 'up');
  ok('the strike and size books.pickContract gives', o.trades[0] && want.row && o.trades[0].strike === want.row.strike && o.trades[0].qty === want.qty, [o.trades[0], want]);
  ok('a run this long fills a target', o.trades[0] && o.trades[0].exits.some((x) => /^target/.test(x)), o.trades[0] && o.trades[0].exits);
  // the same morning, flat into 12:30: not a trend day, no trade
  const flat = optionsDay(DAY, minutes(flatTo(500, 12 * 60 + 30).concat(Array(160).fill(500))), 4, 0.06);
  eq('a flat morning fails the test and trades nothing', [flat.verdict, flat.trades.length], ['fail', 0]);
}

// ---- run(): a 1 PM close is skipped, and so is a day without 20 sessions behind it
{
  const rows = [];
  const add = (day, n, px) => { const t0 = clock.etToUtc(`${day}T09:30:00`); for (let i = 0; i < n; i++) rows.push([t0 + i * 60000, px, px, px, px, 1000]); };
  const days = [];
  for (let d = new Date(Date.UTC(2025, 0, 2)); days.length < 25; d = new Date(+d + 86400000)) { const s = d.toISOString().slice(0, 10); if (clock.isTradingDay(s)) days.push(s); }
  days.forEach((d, i) => add(d, i === 23 ? 210 : 390, 500 + (i % 2)));
  const r = run(sessions(rows));
  eq('22nd session on: 4 days with 20 returns behind them, the 1 PM one skipped', r.days, 3);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

'use strict';
// The three books' rules. Pure: bars, quotes and the book's own state in, a decision out. No clock,
// no network, no ledger -- src/desk/engine.js does all of that and asks these what to do.
//
// ---------------------------------------------------------------- crypto and stocks: volatility targeting
// Hold the market, and hold less of it when it has been swinging hard: the weight is
// min(1, target / realised volatility). Never borrowed, never short.
//
// Why this rule and not a cleverer one. The ETF lab (tools/stock-lab.js, README "Stocks and ETFs")
// tried twelve strategies on 23 ETFs and nothing beat holding SPY out of sample; volatility targeting
// was the one thing that improved anything (maximum drawdown 34% -> 19%, a better Sharpe in 4 of 6
// settings, for 2.6 points of return a year). The crypto lab (tools/crypto-lab.js), the same fixed
// rules on every coin from Coinbase's daily candles and scored from 2022, put trend-following all over
// the place from one coin to the next (a 50-day filter made SOL +31% a year and cost LTC 39%), while
// volatility targeting at 40% a year beat holding on all four coins tried -- BTC 15.2% vs 13.6% a
// year, ETH 5.4% vs -6.4%, SOL 10.6% vs -7.7%, LTC 1.7% vs -13.9% -- with smaller drawdowns, at 0.40% a
// side, and still at 0.80%. It is not magic: from 2024, in bitcoin's strong run, holding BTC did
// better (28.7% vs 25.8%). So both books run the one rule that survived both labs, with its settings.
//
// A book only trades when its target has moved 10 points (a weight of 0.72 becoming 0.83) since the
// last target it traded to, or when it goes back to full size -- exactly the lab's rule, so drift
// from prices moving never triggers a trade on its own.

// The weight to hold, or null when there are not enough closes to say.
function volTargetWeight(closes, { target, lookback, perYear }) {
  if (!Array.isArray(closes) || closes.length < lookback + 1) return null;
  const c = closes.slice(-(lookback + 1)), r = [];
  for (let i = 1; i < c.length; i++) {
    if (!(c[i] > 0 && c[i - 1] > 0)) return null;
    r.push(Math.log(c[i] / c[i - 1]));
  }
  const m = r.reduce((a, x) => a + x, 0) / r.length;
  const vol = Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(perYear);
  if (!(vol > 0)) return null;
  return { w: Math.min(1, target / vol), vol };
}
// Trade to a new target? `last` is the target last traded to (null: never traded).
function needsRebalance(want, last, band) {
  if (!Number.isFinite(want)) return false;
  if (!Number.isFinite(last)) return true;
  if (Math.abs(want - last) >= band - 1e-12) return true;
  return want === 1 && last !== 1;
}

// ---------------------------------------------------------------- options: SPY same-day, trend days only
// Evan's own afternoon pattern written down as rules in the investment stack
// (~/Downloads/stack: strategies/2026-09-23-spy-0dte-afternoon-paper-test.md, and the detector
// strategies/scripts/trend_day_check.py, run_day). Ported line for line; where the two differ, the
// checker's code is what this follows, because it is what the stack's backtest ran.
//
//   12:30 test  SPY at least 0.5 ATR14 from the 9:30 open; the 12:25 bar's close on the trend side of
//               session VWAP; and that close has given back less than half of the move from the open
//               to the day's extreme. All three, or no trade today.
//   entry       12:30 to 2:45: the first five-minute close at a new high of the day (a new low on a
//               down day) that is also on the trend side of VWAP.
//   contract    the first strike 1 to 2 points beyond SPY; if its ask is over $0.25, one strike further;
//               never more than 3 points out; the ask must be $0.07 to $0.25. Two contracts at $0.12 or
//               less, one above.
//   exits       the first of two contracts at 2x its price, the other (or the only one) at 3x; no
//               premium stop. Everything out on a five-minute close back through VWAP, and at 3:15.
//   re-entry    once, only after the first trade's first exit hit its target, on a fresh new-high (or
//               new-low) close before 2:45, one contract.
//   no trade    on a 1 PM close: SPY's same-day options stop trading at 1 PM.
// Bars here are five-minute bars labelled by their START (src/desk/feeds.js fiveMinute): the "12:25
// bar" covers 12:25 to 12:30. Minutes are minutes since midnight Eastern.
const ZERO = {
  trendAtr: 0.5,
  open: 9 * 60 + 30,
  check: 12 * 60 + 25,          // the bar whose close is the 12:30 price
  lastEntry: 14 * 60 + 40,      // the last bar that can trigger an entry (it closes at 2:45)
  clock: 15 * 60 + 10,          // the bar whose close is 3:15: everything goes then
  premiumMin: 0.07, premiumMax: 0.25, twoAt: 0.12,
  nearMin: 1, nearMax: 2, farMax: 3,
  firstTarget: 2, runnerTarget: 3,
};

// The 12:30 verdict. `bars` are the day's five-minute bars (oldest first), `vwap` the series from
// vwapSeries(bars), `atr` a number or null.
//   { status: 'wait' }                       the 12:25 bar is not in yet
//   { status: 'none', why }                  no verdict: a bar missing, no ATR
//   { status: 'fail' | 'pass', dir, ... }    the verdict, with every number it was made from
function trendTest(bars, vwap, atr, R = ZERO) {
  const i = bars.findIndex((b) => b.m === R.check);
  if (i < 0) return { status: 'wait' };
  // every bar from 9:30 through 12:25: without the 9:30 bar the open is wrong, and a missing bar
  // skews VWAP and can hide a new high
  const want = (R.check - R.open) / 5 + 1;
  const have = bars.slice(0, i + 1).filter((b) => b.m >= R.open && b.m <= R.check);
  if (bars[0].m !== R.open || have.length !== want) return { status: 'none', why: `${want - have.length} five-minute bar${want - have.length === 1 ? '' : 's'} missing before 12:30` };
  if (!(atr > 0)) return { status: 'none', why: 'no ATR14 from the daily bars' };
  const o = bars[0].o, c = bars[i].c, move = c - o, dir = move > 0 ? 'up' : 'down';
  const hi = Math.max(...bars.slice(0, i + 1).map((b) => b.h)), lo = Math.min(...bars.slice(0, i + 1).map((b) => b.l));
  const ext = dir === 'up' ? hi : lo;
  const retr = ext === o ? 1 : dir === 'up' ? (ext - c) / (ext - o) : (c - ext) / (o - ext);
  const sideOk = dir === 'up' ? c > vwap[i] : c < vwap[i];
  const big = Math.abs(move) >= R.trendAtr * atr;
  const pass = big && sideOk && retr < 0.5;
  const why = pass ? '' : !big ? `moved ${(Math.abs(move) / atr).toFixed(2)} ATR, needs ${R.trendAtr}`
    : !sideOk ? `12:30 close is on the wrong side of VWAP` : `gave back ${Math.round(retr * 100)}% of the move`;
  return {
    status: pass ? 'pass' : 'fail', dir, open: o, c1230: c, move, atr, moveAtr: Math.abs(move) / atr,
    vwap: vwap[i], retr, sideOk, idx: i, ext, why,
  };
}

// The first bar after `from` (an index) that triggers, scanning no further than R.lastEntry. `ext` is
// the running extreme to beat -- the day's high (low) through bar `from`. Exactly the checker's loop:
// a bar is tested against the extreme BEFORE its own high (low) raises it.
// -> { idx, m, c, vwap } or null, plus the extreme carried forward so a later scan can resume.
function scanEntry(bars, vwap, dir, from, ext, R = ZERO) {
  let run = ext;
  for (let j = from + 1; j < bars.length; j++) {
    const b = bars[j];
    if (b.m > R.lastEntry) break;
    if (dir === 'up') {
      if (b.c > run && b.c > vwap[j]) return { hit: { idx: j, m: b.m, c: b.c, vwap: vwap[j] }, ext: run, scanned: j };
      run = Math.max(run, b.h);
    } else {
      if (b.c < run && b.c < vwap[j]) return { hit: { idx: j, m: b.m, c: b.c, vwap: vwap[j] }, ext: run, scanned: j };
      run = Math.min(run, b.l);
    }
  }
  return { hit: null, ext: run, scanned: bars.length - 1 };
}

// A five-minute close back through VWAP: the trend stop.
const vwapBreak = (bar, vw, dir) => (dir === 'up' ? bar.c < vw : bar.c > vw);

// Which contract, and how many. `rows` are the day's calls (dir up) or puts (dir down), any order.
// -> { row, qty, dist } or { why }
function pickContract(rows, spot, dir, R = ZERO) {
  if (!(spot > 0)) return { why: 'no SPY price' };
  const out = (rows || [])
    .map((r) => ({ r, dist: dir === 'up' ? r.strike - spot : spot - r.strike }))
    .filter((x) => x.dist >= R.nearMin - 1e-9 && x.dist <= R.farMax + 1e-9)
    .sort((a, b) => a.dist - b.dist);
  const first = out.find((x) => x.dist <= R.nearMax + 1e-9);
  if (!first) return { why: `no strike ${R.nearMin}-${R.nearMax} points out` };
  let pick = first;
  if (!(first.r.ask <= R.premiumMax)) {
    const next = out[out.indexOf(first) + 1];
    if (!next) return { why: `${first.r.strike} costs ${fmt(first.r.ask)}, nothing further out within ${R.farMax} points` };
    pick = next;
  }
  const ask = pick.r.ask;
  if (!(ask >= R.premiumMin && ask <= R.premiumMax)) return { why: `${pick.r.strike} ${dir === 'up' ? 'call' : 'put'} asks ${fmt(ask)}, outside ${fmt(R.premiumMin)}-${fmt(R.premiumMax)}` };
  return { row: pick.r, qty: ask <= R.twoAt + 1e-9 ? 2 : 1, dist: pick.dist };
}
const fmt = (x) => (Number.isFinite(x) ? `$${x.toFixed(2)}` : 'no ask');

// Did a resting limit sell at `target` fill since the lot was bought? Yes if the bid now reaches it,
// or if the contract has printed at or above it since: its day high has risen past the target from
// where it stood when the lot was bought. The chain is read every five minutes, not streamed, so the
// high is what catches a spike between reads.
function targetHit(lot, row) {
  if (!row) return false;
  if (row.bid >= lot.target - 1e-9) return true;
  return Number.isFinite(row.high) && Number.isFinite(lot.high0) && row.high > lot.high0 + 1e-9 && row.high >= lot.target - 1e-9;
}

module.exports = { volTargetWeight, needsRebalance, trendTest, scanEntry, vwapBreak, pickContract, targetHit, ZERO };

'use strict';
// The five books' rules. Pure: bars, quotes and the book's own state in, a decision out. No clock,
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
  const why = pass ? '' : !big ? `moved ${(Math.abs(move) / atr).toFixed(2)} ATR, needs ${R.trendAtr.toFixed(2)}`
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

// Is the option chain from the moment the rule acted on? The rule reads SPY's five-minute bars from
// Cboe's delayed chart file and fills at Cboe's delayed option chain: two files on the same ~15-minute
// delay, and nothing ties one to the other. A chain from before a breakout sells the call at its price
// before the breakout, which would flatter every entry. `chainAt` is the chain's own time (SPY's last
// trade in it), `barAt` the instant the bar the rule acted on closed. Both are market time, so the
// delay cancels.
// `maxSec` is DESK_CHAIN_SKEW_SEC.
// -> { ok, skewSec (the chain's time less the bar's close, in seconds; null without both), why }
function chainSync(chainAt, barAt, maxSec) {
  if (!Number.isFinite(chainAt)) return { ok: false, skewSec: null, why: 'the option chain carries no time of its own' };
  if (!Number.isFinite(barAt)) return { ok: false, skewSec: null, why: 'no bar close to match the option chain to' };
  const skewSec = Math.round((chainAt - barAt) / 1000);
  if (Math.abs(skewSec) <= maxSec) return { ok: true, skewSec, why: '' };
  return { ok: false, skewSec, why: `the option chain is out of step with the bars: its prices are ${Math.abs(skewSec)}s ${skewSec < 0 ? 'older' : 'newer'} than the bar's close (limit ${maxSec}s)` };
}

// ---------------------------------------------------------------- scalps: SPY same-day, held for minutes
// Evan asked for it on 2026-09-29 ("start paper trading 0DTE option scalps"). The investment stack has a
// method for a 0DTE scalp but no trigger for one: options §5, "Choosing a contract, getting out, and
// sizing" (~/Downloads/stack/.agents/skills/investment-research-stack/references/options/5-choosing.md).
// This book is that method with the plainest breakout trigger, and it is tested on nothing yet. The
// stack's evidence (§6) finds no long-0DTE rule that survives costs; the book is here to measure one
// every trading day, and §7's bar for trusting a rule is 50 journaled trades whose expectancy's 95%
// lower bound is above zero.
//
//   when      five-minute bars closing 10:05 to 2:30 (§3: nothing before 9:45, singles 10:00-14:30);
//             never on a 1 PM close, nor in the 30 minutes before a 2 PM Fed decision (§1)
//   trigger   a close above the high of the six bars before it (the last 30 minutes; at 10:05 that is
//             the opening range) and above VWAP buys a call; below their low and below VWAP, a put
//   contract  delta 0.25 to 0.60 (§4.1), the one nearest 0.40; ask at least $0.15, $0.20 from 2 PM (§4.3),
//             at most $1.50, a $150 contract on the book's $1,000. One contract, one position, no adds (§7)
//   exits     a resting limit at 1.5x (§6.1); SPY back inside the range it broke, on a five-minute close
//             (§6.2: the stop is on SPY, not the premium); from 15 minutes in, out on any bar it is not
//             bid above what it cost (§6.3: the time stop at half a 30-minute hold); out at 30 minutes
//             whatever it is bid; everything at 3:15 (§6.4)
//   the day   at most four trades; done after two losses in a row; 15 minutes' pause after a loss (§8)
const SCALP = {
  firstBar: 10 * 60,            // the first bar that can trigger: it closes at 10:05, after the 30-minute opening range
  lastBar: 14 * 60 + 25,        // the last closes at 2:30
  pmBar: 13 * 60 + 55,          // a bar closing at 2:00 or later needs the higher premium floor
  range: 6,                     // the bars before the trigger whose range it breaks: 30 minutes
  deltaMin: 0.25, deltaMax: 0.60, deltaAim: 0.40,
  premiumMin: 0.15, premiumPm: 0.20, premiumMax: 1.50,
  target: 1.5, timeStop: 15, hold: 30,
  clock: 15 * 60 + 10,          // the bar whose close is 3:15
  maxTrades: 4, maxLossRun: 2, pause: 15,
  fedBefore: 30,
};
// The Fed's 2 PM decisions left in 2026, from the stack's §1 list. Add 2027's when the stack has them.
const FED = { '2026-10-28': 14 * 60, '2026-12-09': 14 * 60 };
const hm = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')}`;

// Does the bar at index `i` trigger? `bars` are five-minute bars labelled by their start, `vwap` the
// series from vwapSeries(bars). The six bars before it must all be there: a gap hides the range.
// -> { dir, level (the high or low it broke), idx, m, c, vwap } or null
function scalpTrigger(bars, vwap, i, R = SCALP) {
  const b = bars[i];
  if (!b || b.m < R.firstBar || b.m > R.lastBar || i < R.range) return null;
  const prior = bars.slice(i - R.range, i);
  if (prior.some((p, k) => p.m !== b.m - (R.range - k) * 5)) return null;
  const hi = Math.max(...prior.map((p) => p.h)), lo = Math.min(...prior.map((p) => p.l));
  if (b.c > hi && b.c > vwap[i]) return { dir: 'up', level: hi, idx: i, m: b.m, c: b.c, vwap: vwap[i] };
  if (b.c < lo && b.c < vwap[i]) return { dir: 'down', level: lo, idx: i, m: b.m, c: b.c, vwap: vwap[i] };
  return null;
}

// May the book take a trigger on the bar starting at minute `m` of `day`? `d` is its day so far:
// { entries, lossRun, pauseUntil (a minute of the day) }. -> '' when it may, else why not.
function scalpGate(d, day, m, R = SCALP) {
  const close = m + 5;
  if (d.entries >= R.maxTrades) return `${R.maxTrades} trades today, the most it takes`;
  if (d.lossRun >= R.maxLossRun) return `${R.maxLossRun} losses in a row`;
  if (d.pauseUntil != null && close < d.pauseUntil) return `pausing after a loss until ${hm(d.pauseUntil)}`;
  const fed = FED[day];
  if (fed != null && close >= fed - R.fedBefore && close <= fed) return `the ${R.fedBefore} minutes before the Fed's ${hm(fed)} decision`;
  return '';
}

// Which contract. `rows` are the day's calls (dir up) or puts (dir down), each with Cboe's delta;
// `m` the trigger bar's start. -> { row } or { why }
function pickScalp(rows, dir, m, R = SCALP) {
  const side = dir === 'up' ? 'call' : 'put';
  const floor = m >= R.pmBar ? R.premiumPm : R.premiumMin;
  const band = (rows || []).filter((r) => Number.isFinite(r.delta) && Math.abs(r.delta) >= R.deltaMin - 1e-9 && Math.abs(r.delta) <= R.deltaMax + 1e-9);
  if (!band.length) return { why: `no ${side} with a delta of ${R.deltaMin.toFixed(2)} to ${R.deltaMax.toFixed(2)}` };
  const priced = band.filter((r) => r.bid > 0 && r.ask >= floor - 1e-9 && r.ask <= R.premiumMax + 1e-9);
  if (!priced.length) return { why: `no ${side} with a delta of ${R.deltaMin.toFixed(2)} to ${R.deltaMax.toFixed(2)} asks ${fmt(floor)} to ${fmt(R.premiumMax)}` };
  priced.sort((a, b) => Math.abs(Math.abs(a.delta) - R.deltaAim) - Math.abs(Math.abs(b.delta) - R.deltaAim) || a.ask - b.ask);
  return { row: priced[0] };
}

// Should the lot go now? `lot` carries { dir, level, barM (the trigger bar's start), entry, target, high0 };
// `fresh` the bars finished since the last check, `last` the newest bar, `row` the contract's line in the
// chain just read. The first that applies:
//   target  a resting limit at 1.5x filled (targetHit)          -> sold at the target
//   stop    a five-minute close back inside the range it broke   -> at the bid
//   clock   the 3:15 bar
//   hold    30 minutes since the trigger bar closed
//   time    15 minutes or more in, not bid above what it cost
// -> { kind, bar } or null
function scalpExit(lot, fresh, last, row, R = SCALP) {
  if (targetHit(lot, row)) return { kind: 'target', bar: last };
  const brk = (fresh || []).find((b) => (lot.dir === 'up' ? b.c < lot.level : b.c > lot.level));
  if (brk) return { kind: 'stop', bar: brk };
  if (last.m >= R.clock) return { kind: 'clock', bar: last };
  const held = last.m - lot.barM;
  if (held >= R.hold) return { kind: 'hold', bar: last };
  if (held >= R.timeStop && !(row && row.bid > lot.entry)) return { kind: 'time', bar: last };
  return null;
}

// ---------------------------------------------------------------- dips: Evan's own morning trade, on paper
// A pattern Evan traded by hand in late September 2026 and asked to have run on paper (2026-09-29): calls
// bought between 10 and noon while SPY was down on the day and under VWAP near its morning low, 2-3
// points out for about $0.20-$0.40, sold as SPY got back above VWAP (the 25th and the 28th were the
// examples). Two examples prove nothing, so this book runs the pattern every day to see whether it
// holds. On that week's SPY minute bars the trigger below fired on the 23rd, 25th and 28th, and SPY got
// back above VWAP after all three.
//
//   when      five-minute bars closing 10:05 to 12:00; never on a 1 PM close
//   the dip   the day's low so far at least 0.25 ATR14 under the 9:30 open, made in the last 20 minutes
//             (the trigger bar or the three before it)
//   the turn  the bar closes above the high of the bar before it, still under the open and under VWAP
//   contract  a call 2 to 3 points out, asking $0.20 to $0.45, the nearer strike if both are; two of them
//   exits     both: a five-minute close under the morning low less 0.10 ATR14 (the dip was not the low),
//             or no close back above VWAP by 12:30. The first: at the bid on the first close above VWAP.
//             The runner, from then: a close back under the price SPY was bought at; once its bid has
//             doubled, when it gives back half its gain from the best bid seen; 3:15
//   the day   at most two trades, calls only, and done for the day after a trade that loses
const DIP = {
  open: 9 * 60 + 30,
  firstBar: 10 * 60, lastBar: 11 * 60 + 55,
  dipAtr: 0.25, lowWithin: 3, stopAtr: 0.10,
  nearMin: 2, nearMax: 3, premiumMin: 0.20, premiumMax: 0.45, qty: 2,
  reclaimBy: 12 * 60 + 25,      // the bar whose close is 12:30
  trailAt: 2, giveBack: 0.5,
  clock: 15 * 60 + 10,
  maxTrades: 2,
};

// Does the bar at index `i` trigger? `atr` is ATR14 from the daily bars. The day's first bar must be the
// 9:30 bar (it is the open) and the bar before the trigger must be the one right before it.
// -> { idx, m, c, vwap, open, low, dip (in ATRs), stop } or null
function dipTrigger(bars, vwap, i, atr, R = DIP) {
  const b = bars[i], p = bars[i - 1];
  if (!b || !p || !(atr > 0) || b.m < R.firstBar || b.m > R.lastBar || bars[0].m !== R.open || p.m !== b.m - 5) return null;
  const open = bars[0].o;
  let low = Infinity, at = -1;
  for (let k = 0; k <= i; k++) if (bars[k].l <= low) { low = bars[k].l; at = k; }
  if (open - low < R.dipAtr * atr - 1e-9 || i - at > R.lowWithin) return null;
  if (!(b.c > p.h && b.c < open && b.c < vwap[i])) return null;
  return { idx: i, m: b.m, c: b.c, vwap: vwap[i], open, low, dip: (open - low) / atr, stop: low - R.stopAtr * atr };
}

// Which call. `rows` are the day's calls. -> { row, dist } or { why }
function pickDip(rows, spot, R = DIP) {
  if (!(spot > 0)) return { why: 'no SPY price' };
  const near = (rows || []).map((r) => ({ r, dist: r.strike - spot })).filter((x) => x.dist >= R.nearMin - 1e-9 && x.dist <= R.nearMax + 1e-9);
  if (!near.length) return { why: `no call ${R.nearMin}-${R.nearMax} points out` };
  const ok = near.filter((x) => x.r.bid > 0 && x.r.ask >= R.premiumMin - 1e-9 && x.r.ask <= R.premiumMax + 1e-9).sort((a, b) => a.dist - b.dist);
  if (!ok.length) return { why: `the ${near.map((x) => x.r.strike).join(' and ')} call${near.length === 1 ? '' : 's'} ask${near.length === 1 ? 's' : ''} ${near.map((x) => fmt(x.r.ask)).join(' and ')}, outside ${fmt(R.premiumMin)}-${fmt(R.premiumMax)}` };
  return { row: ok[0].r, dist: ok[0].dist };
}

// Should this lot go now? `lot` carries { role ('first' or 'runner'), stop, spy (SPY when bought), entry,
// peak (the best bid seen, this read's included), reclaimM (the bar SPY closed back above VWAP on, or
// null) }; `fresh` the bars finished since the last check, each with its `vw`; `last` the newest bar;
// `row` the contract's line in the chain just read.
// -> { exit: { kind, bar } | null, reclaimM } where kind is one of
//   stop     a close under the morning low less 0.10 ATR          late   no reclaim by 12:30
//   reclaim  the first close back above VWAP (the first contract)  fade   the runner: a close under its SPY price
//   trail    the runner, doubled, gave back half its gain           clock  3:15
function dipExit(lot, fresh, last, row, R = DIP) {
  let reclaimM = lot.reclaimM ?? null;
  for (const b of fresh || []) {
    if (b.c < lot.stop) return { exit: { kind: 'stop', bar: b }, reclaimM };
    if (reclaimM == null) {
      if (b.c > b.vw) { reclaimM = b.m; if (lot.role !== 'runner') return { exit: { kind: 'reclaim', bar: b }, reclaimM }; }
    } else if (lot.role === 'runner' && b.c < lot.spy) return { exit: { kind: 'fade', bar: b }, reclaimM };
  }
  if (last.m >= R.clock) return { exit: { kind: 'clock', bar: last }, reclaimM };
  if (reclaimM == null && last.m >= R.reclaimBy) return { exit: { kind: 'late', bar: last }, reclaimM };
  if (reclaimM != null && lot.role === 'runner' && row && lot.peak >= R.trailAt * lot.entry - 1e-9
    && row.bid <= lot.entry + (lot.peak - lot.entry) * R.giveBack + 1e-9) return { exit: { kind: 'trail', bar: last }, reclaimM };
  return { exit: null, reclaimM };
}

module.exports = {
  volTargetWeight, needsRebalance, trendTest, scanEntry, vwapBreak, pickContract, targetHit, chainSync, ZERO,
  scalpTrigger, scalpGate, pickScalp, scalpExit, SCALP, FED,
  dipTrigger, pickDip, dipExit, DIP,
};

'use strict';
// Assertions for the stock/ETF lab (tools/stock-lab.js) and its fetcher's parser: when a trade
// happens, what it costs, the arithmetic of every metric, and that neither a strategy nor the
// parameter pick can see the future. Synthetic bars only: no network, no clock.
//
//   node tools/stock-lab-test.js
const lab = require('./stock-lab');
const fetcher = require('./stock-fetch');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// weekdays from 2020-01-01
function days(n, start = '2020-01-01') {
  const out = [];
  for (let t = Date.parse(start); out.length < n; t += 86400000) {
    const wd = new Date(t).getUTCDay();
    if (wd !== 0 && wd !== 6) out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
// bars from parallel open/close arrays (no dividends unless ac given)
const bars = (dates, o, c, ac) => dates.map((d, i) => ({ d, o: o[i], c: c[i], ac: ac ? ac[i] : c[i] }));
const fixed = (w) => ({ params: [{}], decide: () => w });

// ---------------------------------------------------------------- alignment
{
  const ds = days(6);
  const raw = {
    SPY: bars(ds, [10, 10, 10, 10, 10, 10], [10, 10, 10, 10, 10, 10]),
    TLT: bars([ds[2], ds[4], ds[5]], [20, 21, 22], [20, 21, 22], [10, 10.5, 11]),   // lists day 2, misses day 3
  };
  const D = lab.align(raw);
  ok('calendar is SPY\'s days', D.dates.length === 6 && D.dates[0] === ds[0]);
  ok('before listing a symbol has no price', Number.isNaN(D.syms.TLT.c[0]) && Number.isNaN(D.syms.TLT.c[1]), D.syms.TLT.c);
  ok('close is the dividend-adjusted close', D.syms.TLT.c[2] === 10, D.syms.TLT.c);
  ok('open is scaled by the same day\'s adjustment factor', near(D.syms.TLT.o[4], 21 * (10.5 / 21)), D.syms.TLT.o);
  ok('a missing day after listing is carried flat at the last close', D.syms.TLT.c[3] === 10 && D.syms.TLT.o[3] === 10, D.syms.TLT);
  ok('first listed day is recorded', D.syms.TLT.first === 2);
}
{
  const json = { chart: { result: [{ meta: { symbol: 'SPY', currency: 'USD', gmtoffset: -14400 },
    timestamp: [1726234200, 1726493400, 1726579800],
    indicators: { quote: [{ open: [560, 562, null], high: [563, 564, 565], low: [559, 560, 561], close: [562.0, null, 563], volume: [1e7, 2e7, 3e7] }], adjclose: [{ adjclose: [555, null, 556] }] } }], error: null } };
  const p = fetcher.parseChart(json);
  ok('parser: a day with no close is dropped', p.bars.length === 2, p.bars);
  ok('parser: date is the exchange-local day', p.bars[0].d === '2024-09-13', p.bars[0]);
  ok('parser: keeps adjusted close and a missing open as null', p.bars[0].ac === 555 && p.bars[1].o === null, p.bars);
  let threw = false;
  try { fetcher.parseChart({ chart: { result: null, error: { code: 'Not Found', description: 'No data found' } } }); } catch (e) { threw = /Not Found/.test(e.message); }
  ok('parser: a Yahoo error is an error, not an empty file', threw);
  const cb = fetcher.parseCboe('DATE,PUT\n03/04/1991,153.5\n01/12/2001,400\n01/03/2007,923.6\n01/04/2007,925.1\n01/05/2007,\n01/08/2007,926\n');
  ok('Cboe parser: only the unbroken run after the last long gap, blank closes dropped', cb.length === 3 && cb[0].d === '2007-01-03' && cb[2].d === '2007-01-08' && cb[0].ac === 923.6 && cb[0].o === null, cb);
  const vx = fetcher.parseCboe('DATE,OPEN,HIGH,LOW,CLOSE\n01/02/1990,17.24,17.3,17.1,17.2\n');
  ok('Cboe parser: reads the CLOSE column when there is one', vx.length === 1 && vx[0].c === 17.2 && vx[0].o === 17.24, vx);
  ok('universe: 23 ETFs and three Cboe indexes, fixed up front', fetcher.ETFS.length === 23 && fetcher.INDEXES.join() === '^BXM,^PUT,^VIX' && lab.ETFS.join() === fetcher.ETFS.join());
}

// ---------------------------------------------------------------- no look-ahead in the engine
{
  // day 2 closes at 100; day 3 opens at 110 and closes at 121. A signal on day 2's close buys at 110.
  const ds = days(4);
  const D = lab.align({ SPY: bars(ds, [100, 100, 100, 110], [100, 100, 100, 121]) });
  const buyOn2 = { decide: ({ j }) => (j >= 2 ? { SPY: 1 } : null) };
  const sim = lab.simulate(D, buyOn2, {}, { from: 0, to: 3, bps: 0 });
  ok('a signal on day t is not filled on day t', sim.equity[2] === 1, sim.equity);
  ok('it fills at day t+1\'s OPEN, not day t\'s close: 121/110', near(sim.equity[3], 121 / 110), sim.equity);
  ok('one order', sim.orders === 1 && sim.signals.length === 1 && sim.signals[0].j === 2, sim);
  const late = lab.simulate(D, { decide: ({ j }) => (j === 3 ? { SPY: 1 } : null) }, {}, { from: 0, to: 3, bps: 0 });
  ok('a signal on the last day of the window never trades', late.orders === 0 && late.equity[3] === 1, late);
}
{
  // A strategy that asks for a symbol before it lists stays in cash and gets it the day it can.
  const ds = days(5);
  const D = lab.align({ SPY: bars(ds, [1, 1, 1, 1, 1], [1, 1, 1, 1, 1]), NEW: bars(ds.slice(3), [50, 50], [50, 55]) });
  const sim = lab.simulate(D, fixed({ NEW: 1 }), {}, { from: 0, to: 4, bps: 0 });
  ok('weights in an unlisted symbol stay cash', sim.equity[2] === 1, sim.equity);
  ok('...and are filled once it lists', sim.orders === 1 && near(sim.equity[4], 55 / 50), sim);
}

// ---------------------------------------------------------------- costs
{
  const ds = days(6);
  const D = lab.align({ SPY: bars(ds, Array(6).fill(100), Array(6).fill(100)) });
  const inOut = { decide: ({ j }) => (j === 0 ? { SPY: 1 } : j === 2 ? {} : null) };
  const sim = lab.simulate(D, inOut, {}, { from: 0, to: 5, bps: 5 });
  ok('round trip on flat prices costs 5bp each side: 1 - 0.0010', near(sim.equity[5], 0.999), sim.equity);
  ok('two orders, cost paid 0.0010', sim.orders === 2 && near(sim.costPaid, 0.001), sim);
  const buy = lab.simulate(D, fixed({ SPY: 1 }), {}, { from: 0, to: 5, bps: 5 });
  ok('buy and hold pays one side only', buy.orders === 1 && near(buy.equity[5], 0.9995), buy.equity);
  const half = lab.simulate(D, fixed({ SPY: 0.5 }), {}, { from: 0, to: 5, bps: 10 });
  ok('cost is on the notional traded, not the account: half in at 10bp = 0.0005', near(half.equity[5], 0.9995), half.equity);
  const same = lab.simulate(D, { decide: () => ({ SPY: 1 }) }, {}, { from: 0, to: 5, bps: 5 });
  ok('asking for the same weights again does not trade again', same.orders === 1, same.orders);
  const zero = lab.simulate(D, inOut, {}, { from: 0, to: 5, bps: 0 });
  ok('at 0bp a flat round trip is free', zero.equity[5] === 1, zero.equity);
}
{
  // idle cash earns SHY only when asked
  const ds = days(3);
  const D = lab.align({ SPY: bars(ds, [1, 1, 1], [1, 1, 1]), SHY: bars(ds, [100, 100, 101], [100, 101, 102.01]) });
  const idle = { decide: () => ({}) };
  ok('cash earns nothing by default', lab.simulate(D, idle, {}, { from: 0, to: 2 }).equity[2] === 1);
  ok('--cash SHY grows idle cash by SHY\'s close-to-close return', near(lab.simulate(D, idle, {}, { from: 0, to: 2, cash: 'SHY' }).equity[2], 1.0201));
}

// ---------------------------------------------------------------- metrics on hand-computable series
{
  const up = Array.from({ length: 253 }, (_, i) => 2 ** (i / 252));
  ok('CAGR: doubling over 252 trading days is 100%', near(lab.stats(up).cagr, 1, 1e-9), lab.stats(up).cagr);
  const two = Array.from({ length: 505 }, (_, i) => 2 ** (i / 504));
  ok('CAGR: doubling over two years is sqrt(2) - 1', near(lab.stats(two).cagr, Math.SQRT2 - 1, 1e-9), lab.stats(two).cagr);
  const dd = lab.stats([1, 1.2, 0.9, 1.5, 0.75, 1.4]);
  ok('max drawdown is the worst fall from a peak: 1.5 → 0.75 is 50%', near(dd.maxDD, 0.5), dd.maxDD);
  const s = lab.stats([1, 1.02, 1.02, 1.0404, 1.0404]);
  // returns .02, 0, .02, 0: mean .01, sample sd sqrt(4 * .0001 / 3)
  const sd = Math.sqrt(0.0004 / 3);
  ok('Sharpe = mean / sample sd x sqrt(252), zero risk-free', near(s.sharpe, (0.01 / sd) * Math.sqrt(252), 1e-6), s.sharpe);
  ok('volatility = sample sd x sqrt(252)', near(s.vol, sd * Math.sqrt(252), 1e-9), s.vol);
  ok('a flat line has zero Sharpe, zero drawdown', lab.stats([1, 1, 1]).sharpe === 0 && lab.stats([1, 1, 1]).maxDD === 0);
}
{
  const ds = days(30);
  const c = Array.from({ length: 30 }, (_, i) => 100 + i);
  const D = lab.align({ SPY: bars(ds, c, c) });
  ok('sma of the last 5 closes', near(lab.sma(D, 'SPY', 10, 5), 108));
  ok('sma before enough history is NaN', Number.isNaN(lab.sma(D, 'SPY', 3, 5)));
  ok('N-day return', near(lab.ret(D, 'SPY', 20, 10), 120 / 110 - 1));
  ok('RSI of a straight rise is 100', lab.rsi(D, 'SPY', 10, 2) === 100);
  ok('new month is read from today and yesterday only', lab.newMonth(D, D.dates.findIndex((d) => d === '2020-02-03')) && !lab.newMonth(D, 1));
}

// ---------------------------------------------------------------- strategies never see tomorrow
// Random-walk prices for the whole universe; then scramble every price after day K. Every signal on
// or before K must come out identical, for every strategy and every parameter setting.
function synthetic(n, seed, scrambleAfter = Infinity) {
  const ds = days(n, '2015-01-01');
  const raw = {};
  const all = [...lab.ETFS, '^BXM', '^PUT', '^VIX'];
  all.forEach((sym, si) => {
    let px = 50 + si;
    const o = [], c = [];
    const start = si % 5 === 4 ? 300 : 0;         // some symbols list late
    for (let i = 0; i < n; i++) {
      const u = lab.rand(seed * 1000 + si, i) - 0.5, v = lab.rand(seed * 1000 + si + 500, i) - 0.5;
      const k = i > scrambleAfter ? 3 : 1;
      const open = px * (1 + 0.01 * v * k);
      px = sym === '^VIX' ? Math.max(9, 10 + 40 * lab.rand(seed + (i > scrambleAfter ? 77 : 0), i)) : open * (1 + 0.02 * u * k + 0.0003);
      o.push(sym === '^VIX' ? px : open); c.push(px);
    }
    raw[sym] = bars(ds.slice(start), o.slice(start), c.slice(start));
  });
  return lab.align(raw);
}
{
  // K runs over every month turn and a day either side, so a monthly strategy that peeks a day
  // ahead is caught as surely as a daily one
  const N = 600, FROM_ = 270;
  const A = synthetic(N, 3);
  const Ks = [];
  for (let k = FROM_ + 1; k < N - 5; k++) if (lab.newMonth(A, k)) Ks.push(k - 1, k, k + 1);
  const Bs = Ks.map((K) => synthetic(N, 3, K));
  ok('the scramble really changes prices after K and not before', Bs.every((B, i) => A.syms.SPY.c[Ks[i] + 2] !== B.syms.SPY.c[Ks[i] + 2] && A.syms.SPY.c[Ks[i]] === B.syms.SPY.c[Ks[i]]));
  for (const [name, s] of Object.entries(lab.STRATEGIES)) {
    let same = true, any = 0;
    for (const p of s.params) {
      const a = lab.simulate(A, s, p, { from: FROM_, to: N - 1 }).signals;
      any += a.length;
      Bs.forEach((B, i) => {
        const b = lab.simulate(B, s, p, { from: FROM_, to: N - 1 }).signals.filter((x) => x.j <= Ks[i]);
        if (JSON.stringify(a.filter((x) => x.j <= Ks[i])) !== JSON.stringify(b)) same = false;
      });
    }
    ok(`${name}: prices after day K never change a signal on or before K (${Ks.length} K's)`, same);
    ok(`${name}: it does decide something on synthetic data`, any > 0, any);
  }
}

// ---------------------------------------------------------------- walk-forward
{
  // SPY rises in the first 60% and falls after; TLT does the opposite. Tuned on the older part, the
  // pick is SPY, even though TLT wins the newer part.
  const n = 101, ds = days(n);
  const spy = [], tlt = [];
  for (let i = 0; i < n; i++) { spy.push(i <= 60 ? 100 * 1.01 ** i : 100 * 1.01 ** 60 * 0.98 ** (i - 60)); tlt.push(i <= 60 ? 100 * 0.995 ** i : 100 * 0.995 ** 60 * 1.02 ** (i - 60)); }
  const D = lab.align({ SPY: bars(ds, spy, spy), TLT: bars(ds, tlt, tlt) });
  const pickOne = { params: [{ s: 'TLT' }, { s: 'SPY' }], decide: ({ p }) => ({ [p.s]: 1 }) };
  const wf = lab.walkForward(D, pickOne, { from: 0, to: n - 1, pick: 'cagr' });
  ok('dev is the older 60% of the window', wf.cut === 60, wf.cut);
  ok('the pick is what won on the older part, not the newer', wf.pick.s === 'SPY', wf.pick);
  ok('...although the other setting wins the newer part', lab.run(D, pickOne, { s: 'TLT' }, { from: 60, to: 100 }).cagr > lab.run(D, pickOne, { s: 'SPY' }, { from: 60, to: 100 }).cagr);

  // rewrite everything after the cut so that TLT would have won everywhere: same pick
  const spy2 = spy.map((x, i) => (i <= 60 ? x : 1)), tlt2 = tlt.map((x, i) => (i <= 60 ? x : 1e6));
  const D2 = lab.align({ SPY: bars(ds, spy2, spy2), TLT: bars(ds, tlt2, tlt2) });
  const wf2 = lab.walkForward(D2, pickOne, { from: 0, to: n - 1, pick: 'cagr' });
  ok('changing test-period data cannot change the pick or its dev score', wf2.pick.s === 'SPY' && JSON.stringify(wf2.dev) === JSON.stringify(wf.dev), wf2);

  // folds: each slice is tuned only on what came before it
  const fs = lab.folds(D, pickOne, { from: 0, to: 100, k: 4, pick: 'cagr' });
  ok('folds: k-1 slices, back to back', fs.length === 3 && fs[0].from === 25 && fs[0].to === 50 && fs[2].to === 100, fs.map((f) => [f.from, f.to]));
  ok('folds: the slice after the turn is still tuned on the rise (SPY)', fs[2].p.s === 'SPY', fs[2].p);
  const fs2 = lab.folds(D2, pickOne, { from: 0, to: 100, k: 4, pick: 'cagr' });
  ok('folds: tuning windows before the cut ignore data after it', fs2[0].p.s === fs[0].p.s && fs2[1].p.s === fs[1].p.s);
}

// ---------------------------------------------------------------- a strategy checks out
{
  // 250 days rising then 60 falling: a 100-day trend filter is in, then gets out, and trades next open
  const n = 320, ds = days(n);
  const c = Array.from({ length: n }, (_, i) => (i < 250 ? 100 + i : 349 - 3 * (i - 249)));
  const D = lab.align({ SPY: bars(ds, c, c) });
  const s = lab.STRATEGIES.trendSma, p = { sma: 100, band: 0, check: 'day' };
  const sim = lab.simulate(D, s, p, { from: 120, to: n - 1, bps: 0 });
  const exit = sim.signals.find((x) => Object.keys(x.w).length === 0);
  ok('trend filter: in at the start, out once price drops under the average', sim.signals[0].j === 120 && exit && D.syms.SPY.c[exit.j] < lab.sma(D, 'SPY', exit.j, 100) && D.syms.SPY.c[exit.j - 1] >= lab.sma(D, 'SPY', exit.j - 1, 100), sim.signals);
  ok('trend filter: flat after the exit fill', sim.equity[sim.equity.length - 1] === sim.equity[exit.j + 1 - 120]);
  const counts = Object.entries(lab.STRATEGIES).filter(([, x]) => !x.control).reduce((a, [, x]) => a + x.params.length, 0);
  ok('the grids stay small: under 100 settings in all', counts < 100, counts);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

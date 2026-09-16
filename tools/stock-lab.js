'use strict';
// Stock/ETF lab: the strategy lab's method (tools/lab.js) on daily ETF bars instead of settled
// prediction markets. RESEARCH ONLY: nothing here talks to a broker, reads a key, or places an order.
//
//   node tools/stock-fetch.js                   # once: data/stocks/bars/*.json
//   node tools/stock-lab.js                     # every strategy, tuned on the older 60%, scored on the newer 40%
//   node tools/stock-lab.js --detail rotation   # every parameter setting of one strategy, both halves
//   node tools/stock-lab.js --bps 10 --cash SHY --pick cagr --from 2003-01-02 --json out.json
//
// The question is the same as the prediction-market lab's: not "which strategy made the most in a
// backtest" but "which strategy, tuned on older years, still beats simply owning SPY on years it
// never saw, after costs". So the calendar is cut in two by date: each strategy's parameters are
// picked on the older DEV_SHARE and the table reports the newer rest. A few expanding folds
// (tune on everything before a slice, score on the slice) show whether one split was just lucky.
//
// THE FILL MODEL, and what it gets wrong:
//   - A strategy decides on a day's CLOSE and trades at the NEXT day's OPEN. Nothing trades on the
//     price it just used to decide.
//   - Every order pays BPS basis points of what it trades (spread plus slippage), each side. US
//     brokers charge no commission on ETFs, so that is the whole cost here. Taxes are ignored, and a
//     strategy that turns over monthly would pay short-term rates on its gains in a taxable account.
//   - Prices are Yahoo's dividend-adjusted closes, and the open is scaled by the same day's factor,
//     so holding an ETF earns its dividends. Cash earns nothing unless --cash SHY, which grows idle
//     cash by SHY's daily total return (no cost to move in or out of it).
//   - The engine rebalances only when a strategy asks for a DIFFERENT set of weights; weights left
//     alone drift with prices. No leverage, no shorting: weights are 0..1 and sum to at most 1.
//   - Sharpe here uses a zero risk-free rate for every row, so it is comparable across rows but
//     flatters everything in years when T-bills paid 5%.
//   - Before an ETF existed it cannot be held; a rotation only ranks what was listed at the time.
//     The universe itself was chosen in 2026, but it is broad index ETFs, not today's winners
//     (see tools/stock-fetch.js).
const fs = require('fs');
const path = require('path');

const TD = 252;                   // trading days a year
const M = 21;                     // trading days a month
const DEV_SHARE = 0.6;
const BPS = 5;                    // per side, per order
const FROM = '2003-01-02';        // TLT, IEF, SHY and LQD list mid-2002; the ETF universe is mostly there by now
const FOLDS = 5;

const ETFS = ['SPY', 'QQQ', 'IWM', 'DIA', 'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB',
  'TLT', 'IEF', 'SHY', 'LQD', 'HYG', 'GLD', 'SLV', 'EFA', 'EEM', 'VNQ'];
const ASSET_CLASSES = ['SPY', 'EFA', 'EEM', 'IEF', 'TLT', 'LQD', 'HYG', 'GLD', 'VNQ'];

// ------------------------------------------------------------------ data
// raw: { SYM: [{ d, o, c, ac }, ...] } → aligned on the calendar symbol's trading days.
// Each symbol gets adjusted o[] and c[] (NaN before it listed); a day it is missing after listing
// is carried at the last close, so it neither moves nor trades at a made-up open.
function align(raw, calSym = 'SPY') {
  if (!raw[calSym]) throw new Error(`calendar symbol ${calSym} missing`);
  const dates = raw[calSym].map((b) => b.d);
  const idx = new Map(dates.map((d, i) => [d, i]));
  const syms = {};
  for (const [sym, bars] of Object.entries(raw)) {
    const o = new Array(dates.length).fill(NaN), c = new Array(dates.length).fill(NaN);
    for (const b of bars) {
      const i = idx.get(b.d);
      if (i === undefined || !(b.c > 0)) continue;
      const ac = b.ac > 0 ? b.ac : b.c, f = ac / b.c;
      c[i] = ac;
      o[i] = b.o > 0 ? b.o * f : ac;
    }
    let first = c.findIndex((x) => x > 0);
    if (first < 0) continue;
    for (let i = first + 1; i < dates.length; i++) if (!(c[i] > 0)) { c[i] = c[i - 1]; o[i] = c[i - 1]; }
    syms[sym] = { o, c, first };
  }
  return { dates, syms };
}

function loadBars(dir = 'data/stocks/bars') {
  const raw = {};
  for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    raw[j.symbol] = j.bars;
  }
  return raw;
}

// ------------------------------------------------------------------ indicators (read day j and before only)
const has = (D, s, j) => !!D.syms[s] && D.syms[s].c[j] > 0;
const ret = (D, s, j, n) => (j - n >= 0 && has(D, s, j) && has(D, s, j - n) ? D.syms[s].c[j] / D.syms[s].c[j - n] - 1 : NaN);
function sma(D, s, j, n) {
  if (j - n + 1 < 0 || !has(D, s, j - n + 1)) return NaN;
  let a = 0; for (let k = j - n + 1; k <= j; k++) a += D.syms[s].c[k];
  return a / n;
}
// Cutler's RSI: plain averages of the last n up and down moves (no smoothing that reaches back forever)
function rsi(D, s, j, n) {
  if (j - n < 0 || !has(D, s, j - n)) return NaN;
  let up = 0, dn = 0;
  for (let k = j - n + 1; k <= j; k++) { const d = D.syms[s].c[k] - D.syms[s].c[k - 1]; if (d > 0) up += d; else dn -= d; }
  return up + dn === 0 ? 50 : (100 * up) / (up + dn);
}
function realVol(D, s, j, n) {
  if (j - n < 0 || !has(D, s, j - n)) return NaN;
  const r = []; for (let k = j - n + 1; k <= j; k++) r.push(Math.log(D.syms[s].c[k] / D.syms[s].c[k - 1]));
  const m = r.reduce((a, x) => a + x, 0) / n;
  return Math.sqrt(r.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1)) * Math.sqrt(TD);
}
// the first trading day of a month, known from today's date and yesterday's -- never tomorrow's
const newMonth = (D, j) => j > 0 && D.dates[j].slice(0, 7) !== D.dates[j - 1].slice(0, 7);
// monthly strategies act on their first day and then at each month turn
const monthly = (ctx) => { if (ctx.state.started && !newMonth(ctx.D, ctx.j)) return false; ctx.state.started = true; return true; };
function rand(seed, j) {                    // deterministic uniform in [0,1) from (seed, day)
  let h = Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(j + 1, 0xc2b2ae35);
  h ^= h >>> 16; h = Math.imul(h, 0x7feb352d); h ^= h >>> 15; h = Math.imul(h, 0x846ca68b); h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
const grid = (spec) => Object.entries(spec).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const seeds = (n) => Array.from({ length: n }, (_, i) => ({ seed: i + 1 }));

// ------------------------------------------------------------------ engine
// Runs one strategy from the close of day `from` to the close of day `to`, starting with 1.0 in cash.
// strat.decide(ctx) → a weights object ({ SPY: 1 }, {} for all cash) or null for "no change".
// ctx = { D, j, p, state }: the strategy may read any price at or before day j.
function sameWeights(a, b) {
  if (!a || !b) return false;
  const ks = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of ks) if (Math.abs((a[k] || 0) - (b[k] || 0)) > 1e-9) return false;
  return true;
}
function simulate(D, strat, p, { from, to, bps = BPS, cash = null } = {}) {
  const units = {}, state = {}, equity = [], signals = [];
  let cashBal = 1, pending = null, last = null, orders = 0, costPaid = 0, investedSum = 0;
  for (let j = from; j <= to; j++) {
    if (j > from) {
      if (cash && has(D, cash, j) && has(D, cash, j - 1)) cashBal *= D.syms[cash].c[j] / D.syms[cash].c[j - 1];
      if (pending) {                                   // the open of the day after the signal
        let eq = cashBal;
        for (const [s, u] of Object.entries(units)) eq += u * D.syms[s].o[j];
        const target = {};
        for (const [s, w] of Object.entries(pending)) {
          if (has(D, s, j) && D.syms[s].o[j] > 0) target[s] = w;
          else last = null;                            // not listed yet: stays cash, and the same ask is retried
        }
        for (const s of new Set([...Object.keys(units), ...Object.keys(target)])) {
          const px = D.syms[s].o[j], cur = (units[s] || 0) * px, want = (target[s] || 0) * eq, delta = want - cur;
          if (Math.abs(delta) <= 1e-9 * Math.max(eq, 1e-12)) continue;
          const cost = (Math.abs(delta) * bps) / 1e4;
          orders++; costPaid += cost;
          cashBal -= delta + cost;
          if (want > 0) units[s] = want / px; else delete units[s];
        }
        pending = null;
      }
    }
    let inv = 0;
    for (const [s, u] of Object.entries(units)) inv += u * D.syms[s].c[j];
    equity.push(cashBal + inv);
    investedSum += inv / (cashBal + inv);
    if (j < to) {
      const w = strat.decide({ D, j, p, state });
      if (w && !sameWeights(w, last)) {
        const sum = Object.values(w).reduce((a, x) => a + Math.max(0, x), 0);
        const norm = {};
        for (const [s, x] of Object.entries(w)) if (x > 0) norm[s] = sum > 1 ? x / sum : x;
        last = w; pending = norm; signals.push({ j, w: norm });
      }
    }
  }
  return { equity, orders, costPaid, signals, invested: investedSum / equity.length };
}

// ------------------------------------------------------------------ scoring
function stats(equity) {
  const n = equity.length - 1;
  if (n < 1) return { cagr: 0, maxDD: 0, vol: 0, sharpe: 0, days: 0 };
  const r = [];
  for (let i = 1; i <= n; i++) r.push(equity[i] / equity[i - 1] - 1);
  const mean = r.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  let peak = equity[0], maxDD = 0;
  for (const e of equity) { if (e > peak) peak = e; maxDD = Math.max(maxDD, 1 - e / peak); }
  return {
    cagr: equity[n] > 0 ? (equity[n] / equity[0]) ** (TD / n) - 1 : -1,
    maxDD,
    vol: sd * Math.sqrt(TD),
    sharpe: sd > 0 ? (mean / sd) * Math.sqrt(TD) : 0,
    days: n,
  };
}
function run(D, strat, p, opts) {
  const sim = simulate(D, strat, p, opts);
  return { ...stats(sim.equity), orders: sim.orders, costPaid: sim.costPaid, invested: sim.invested };
}

// Pick parameters on [from, cut] only. Nothing after `cut` is simulated, so nothing after it can
// choose. `pick` is the dev metric maximised: 'sharpe' (default) or 'cagr'.
function walkForward(D, strat, { from, to, share = DEV_SHARE, pick = 'sharpe', bps = BPS, cash = null }) {
  const cut = from + Math.floor((to - from) * share);
  let best = null;
  const devRows = strat.params.map((p) => ({ p, dev: run(D, strat, p, { from, to: cut, bps, cash }) }));
  for (const r of devRows) if (!best || r.dev[pick] > best.dev[pick]) best = r;
  return { cut, pick: best.p, dev: best.dev, devRows };
}

// Expanding folds: slice k is scored with parameters picked on everything before it.
function folds(D, strat, { from, to, k = FOLDS, pick = 'sharpe', bps = BPS, cash = null }) {
  const edge = (i) => from + Math.round(((to - from) * i) / k);
  const out = [];
  for (let i = 1; i < k; i++) {
    const wf = walkForward(D, strat, { from, to: edge(i), share: 1, pick, bps, cash });
    out.push({ from: edge(i), to: edge(i + 1), p: wf.pick, test: run(D, strat, wf.pick, { from: edge(i), to: edge(i + 1), bps, cash }) });
  }
  return out;
}

// ------------------------------------------------------------------ strategies
const SPY1 = { SPY: 1 };
const STRATEGIES = {
  buyHold: {
    plain: 'buy SPY once and hold it (the benchmark)',
    params: [{}],
    decide: () => SPY1,
  },
  trendSma: {
    plain: 'hold SPY while it closes above its moving average, else cash',
    params: grid({ sma: [100, 200], band: [0, 0.02], check: ['day', 'month'] }),
    decide(ctx) {
      const { D, j, p, state } = ctx;
      if (p.check === 'month' && !monthly(ctx)) return null;
      const s = sma(D, 'SPY', j, p.sma), px = D.syms.SPY.c[j];
      if (!(s > 0)) return null;
      if (state.in === undefined) state.in = px > s * (1 + p.band);
      else if (!state.in && px > s * (1 + p.band)) state.in = true;
      else if (state.in && px < s * (1 - p.band)) state.in = false;
      return state.in ? SPY1 : {};
    },
  },
  tsmomSpy: {
    plain: 'time-series momentum: hold SPY if its last N months were up, else cash (monthly)',
    params: grid({ months: [3, 6, 9, 12] }),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      const r = ret(ctx.D, 'SPY', ctx.j, ctx.p.months * M);
      return Number.isNaN(r) ? null : r > 0 ? SPY1 : {};
    },
  },
  tsmomMulti: {
    plain: `the same across ${ASSET_CLASSES.length} asset classes: an equal slot each, filled only if that asset was up (monthly)`,
    params: grid({ months: [3, 6, 12] }),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      const { D, j, p } = ctx;
      const listed = ASSET_CLASSES.filter((s) => has(D, s, j - p.months * M));
      if (!listed.length) return null;
      const w = {};
      for (const s of listed) if (ret(D, s, j, p.months * M) > 0) w[s] = 1 / listed.length;
      return w;
    },
  },
  rotation: {
    plain: `cross-sectional momentum: hold the top N of the ${ETFS.length} ETFs by N-month return (monthly)`,
    params: grid({ top: [1, 2, 3, 5], months: [3, 6, 12] }),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      const { D, j, p } = ctx;
      const ranked = ETFS.map((s) => [s, ret(D, s, j, p.months * M)]).filter(([, r]) => !Number.isNaN(r)).sort((a, b) => b[1] - a[1]);
      if (ranked.length < p.top) return null;
      const w = {};
      for (const [s] of ranked.slice(0, p.top)) w[s] = 1 / p.top;
      return w;
    },
  },
  dualMomentum: {
    plain: 'dual momentum: SPY (or EFA if stronger) when it beat SHY over N months, else bonds if they are up, else cash',
    params: grid({ months: [6, 12], bond: ['IEF', 'TLT'], intl: [false, true] }),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      const { D, j, p } = ctx, n = p.months * M;
      let risky = 'SPY', r = ret(D, 'SPY', j, n);
      if (Number.isNaN(r)) return null;
      if (p.intl && ret(D, 'EFA', j, n) > r) { risky = 'EFA'; r = ret(D, 'EFA', j, n); }
      const bill = ret(D, 'SHY', j, n);
      if (r > (Number.isNaN(bill) ? 0 : bill)) return { [risky]: 1 };
      return ret(D, p.bond, j, n) > 0 ? { [p.bond]: 1 } : {};
    },
  },
  rsi2: {
    plain: 'short-term mean reversion: buy SPY when 2-day RSI is very low, sell on a bounce or after 5 days',
    params: grid({ below: [5, 10, 25], trend: [true, false], exit: ['sma5', 'days5'] }),
    decide({ D, j, p, state }) {
      const px = D.syms.SPY.c[j];
      if (state.in) {
        const out = p.exit === 'sma5' ? px > sma(D, 'SPY', j, 5) : j - state.at >= 5;
        if (out) { state.in = false; return {}; }
        return null;
      }
      if (p.trend && !(px > sma(D, 'SPY', j, 200))) return null;
      if (rsi(D, 'SPY', j, 2) < p.below) { state.in = true; state.at = j; return SPY1; }
      return null;
    },
  },
  dropBuy: {
    plain: 'buy SPY after N down closes in a row, hold a fixed number of days',
    params: grid({ down: [3, 4], hold: [3, 5, 10] }),
    decide({ D, j, p, state }) {
      if (state.in) { if (j - state.at >= p.hold) { state.in = false; return {}; } return null; }
      if (j - p.down < 0 || !has(D, 'SPY', j - p.down)) return null;
      for (let k = j - p.down + 1; k <= j; k++) if (!(D.syms.SPY.c[k] < D.syms.SPY.c[k - 1])) return null;
      state.in = true; state.at = j;
      return SPY1;
    },
  },
  volTarget: {
    plain: 'volatility targeting: hold less SPY when it has been swinging hard (no leverage)',
    params: grid({ target: [0.10, 0.15, 0.20], lookback: [20, 60] }),
    decide({ D, j, p, state }) {
      const v = realVol(D, 'SPY', j, p.lookback);
      if (!(v > 0)) return null;
      const w = Math.min(1, p.target / v);
      if (state.w !== undefined && Math.abs(w - state.w) < 0.1 && !(w === 1 && state.w !== 1)) return null;
      state.w = w;
      return { SPY: w };
    },
  },
  vixFilter: {
    plain: 'hold SPY only while VIX closes below a level, else cash',
    needs: ['^VIX'],
    params: grid({ below: [20, 25, 30, 40] }),
    decide({ D, j, p }) {
      if (!has(D, '^VIX', j)) return null;
      return D.syms['^VIX'].c[j] < p.below ? SPY1 : {};
    },
  },
  buyWrite: {
    plain: 'Cboe BXM index: own the S&P 500, sell a one-month at-the-money call each month',
    needs: ['^BXM'],
    params: [{}],
    decide: () => ({ '^BXM': 1 }),
  },
  putWrite: {
    plain: 'Cboe PUT index: hold T-bills, sell a one-month at-the-money S&P put each month',
    needs: ['^PUT'],
    params: [{}],
    decide: () => ({ '^PUT': 1 }),
  },
  randomTiming: {
    plain: 'control: each month a weighted coin (70% in) decides SPY or cash',
    control: true,
    params: seeds(25),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      return rand(ctx.p.seed, ctx.j) < 0.7 ? SPY1 : {};
    },
  },
  randomRotation: {
    plain: 'control: each month hold 3 ETFs drawn at random from those listed',
    control: true,
    params: seeds(25),
    decide(ctx) {
      if (!monthly(ctx)) return null;
      const { D, j, p } = ctx;
      const pool = ETFS.filter((s) => has(D, s, j));
      const w = {};
      for (let k = 0; k < 3 && pool.length; k++) w[pool.splice(Math.floor(rand(p.seed * 131 + k, j) * pool.length), 1)[0]] = 1 / 3;
      return w;
    },
  },
};

const label = (p) => Object.entries(p).map(([k, v]) => `${k}=${v}`).join(' ') || '-';
const median = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

module.exports = { align, simulate, stats, run, walkForward, folds, STRATEGIES, ETFS, ASSET_CLASSES, sma, rsi, ret, realVol, newMonth, rand, BPS, DEV_SHARE, TD, M };

// ------------------------------------------------------------------ go
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const bps = parseFloat(flag('bps', BPS));
  const cash = flag('cash', null);
  const pick = flag('pick', 'sharpe');
  const dir = flag('dir', 'data/stocks/bars');
  if (!fs.existsSync(dir)) { console.error(`no ${dir}: run node tools/stock-fetch.js first`); process.exit(1); }
  const D = align(loadBars(dir));
  const from = D.dates.findIndex((d) => d >= flag('from', FROM)), to = D.dates.length - 1;
  const cut = from + Math.floor((to - from) * DEV_SHARE);
  const opts = { from, to, bps, cash, pick };
  const pct = (x, w = 6) => `${(x * 100).toFixed(1)}%`.padStart(w);
  const pp = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`;
  const since = (s) => D.syms[s] ? D.dates[D.syms[s].first] : null;

  const want = [...ETFS, '^BXM', '^PUT', '^VIX'];
  const missing = want.filter((s) => !D.syms[s]);
  console.log(`${Object.keys(D.syms).length} symbols, ${D.dates.length} SPY trading days ${D.dates[0]} → ${D.dates[to]}`);
  console.log(`listed late: ${want.filter((s) => D.syms[s] && since(s) > D.dates[from]).map((s) => `${s} ${since(s)}`).join(', ') || 'none'}`);
  if (missing.length) console.log(`\x1b[33mnot available: ${missing.join(' ')} -- strategies that need them are skipped\x1b[0m`);
  console.log(`tune ${D.dates[from]} → ${D.dates[cut]} · test ${D.dates[cut]} → ${D.dates[to]} · ${bps}bp a side, no commission · idle cash ${cash ? `earns ${cash}` : 'earns 0'} · picked on dev ${pick}`);

  const only = flag('detail');
  if (only) {
    const s = STRATEGIES[only];
    if (!s) { console.error(`unknown strategy ${only}: ${Object.keys(STRATEGIES).join(', ')}`); process.exit(1); }
    const spyDev = run(D, STRATEGIES.buyHold, {}, { from, to: cut, bps, cash }), spyTest = run(D, STRATEGIES.buyHold, {}, { from: cut, to, bps, cash });
    console.log(`\n${only}: ${s.plain}\nSPY buy-and-hold: dev CAGR ${pct(spyDev.cagr)} Sharpe ${spyDev.sharpe.toFixed(2)} · test CAGR ${pct(spyTest.cagr)} Sharpe ${spyTest.sharpe.toFixed(2)}\n`);
    console.log(`${'params'.padEnd(34)} ${'dev CAGR'.padStart(8)} ${'dev Shp'.padStart(7)} │ ${'test CAGR'.padStart(9)} ${'maxDD'.padStart(6)} ${'Sharpe'.padStart(6)} ${'orders'.padStart(6)}`);
    for (const p of s.params) {
      const d = run(D, s, p, { from, to: cut, bps, cash }), t = run(D, s, p, { from: cut, to, bps, cash });
      console.log(`${label(p).padEnd(34)} ${pct(d.cagr, 8)} ${d.sharpe.toFixed(2).padStart(7)} │ ${pct(t.cagr, 9)} ${pct(t.maxDD)} ${t.sharpe.toFixed(2).padStart(6)} ${String(t.orders).padStart(6)}`);
    }
    process.exit(0);
  }

  const spy = { dev: run(D, STRATEGIES.buyHold, {}, { from, to: cut, bps, cash }), test: run(D, STRATEGIES.buyHold, {}, { from: cut, to, bps, cash }) };
  const rows = [];
  let tried = 0;
  for (const [name, s] of Object.entries(STRATEGIES)) {
    if ((s.needs || []).some((x) => !D.syms[x])) { rows.push({ name, skipped: `needs ${s.needs.join(' ')}` }); continue; }
    // an index that starts late (PUT is daily from 2007) is compared with SPY over the years it exists
    const sFrom = Math.max(from, ...(s.needs || []).map((x) => D.syms[x].first));
    const spyDev = sFrom === from ? spy.dev : run(D, STRATEGIES.buyHold, {}, { from: sFrom, to: cut, bps, cash });
    const both = s.params.map((p) => ({ p, dev: run(D, s, p, { from: sFrom, to: cut, bps, cash }), test: run(D, s, p, { from: cut, to, bps, cash }) }));
    const beatCagr = both.filter((r) => r.dev.cagr > spyDev.cagr && r.test.cagr > spy.test.cagr).length;
    const beatSharpe = both.filter((r) => r.dev.sharpe > spyDev.sharpe && r.test.sharpe > spy.test.sharpe).length;
    if (s.control) {
      const med = (k) => median(both.map((r) => r.test[k]));
      rows.push({ name, s, control: true, label: `median of ${s.params.length} seeds`, test: { cagr: med('cagr'), maxDD: med('maxDD'), vol: med('vol'), sharpe: med('sharpe'), orders: Math.round(med('orders')), invested: med('invested') }, n: s.params.length, beatCagr, beatSharpe });
      continue;
    }
    tried += s.params.length;
    const wf = walkForward(D, s, { ...opts, from: sFrom, share: (cut - sFrom) / (to - sFrom) });
    const test = both.find((r) => r.p === wf.pick).test;
    rows.push({ name, s, sFrom, label: s.params.length > 1 ? label(wf.pick) : sFrom > from ? `(none; dev from ${D.dates[sFrom].slice(0, 4)})` : '(no parameters)', dev: wf.dev, test, n: s.params.length, beatCagr, beatSharpe });
  }

  const head = `${'strategy'.padEnd(15)} ${'picked on the older years'.padEnd(33)} ${'CAGR'.padStart(6)} ${'vs SPY'.padStart(6)} ${'maxDD'.padStart(6)} ${'vol'.padStart(6)} ${'Sharpe'.padStart(6)} ${'orders'.padStart(6)} ${'in mkt'.padStart(6)}  beat SPY both halves: CAGR / Sharpe`;
  console.log(`\nTEST WINDOW ${D.dates[cut]} → ${D.dates[to]}, each strategy with the settings it chose on ${D.dates[from]} → ${D.dates[cut]}`);
  console.log(head);
  const line = (r) => `${r.name.padEnd(15)} ${r.label.padEnd(33)} ${pct(r.test.cagr)} ${pp(r.test.cagr - spy.test.cagr).padStart(6)} ${pct(-r.test.maxDD)} ${pct(r.test.vol)} ${r.test.sharpe.toFixed(2).padStart(6)} ${String(r.test.orders).padStart(6)} ${pct(r.test.invested)}  ${String(r.beatCagr).padStart(2)}/${r.n} · ${r.beatSharpe}/${r.n}`;
  for (const r of rows.filter((x) => !x.skipped).sort((a, b) => b.test.cagr - a.test.cagr)) console.log(line(r));
  for (const r of rows.filter((x) => x.skipped)) console.log(`${r.name.padEnd(15)} not run: ${r.skipped}`);
  console.log(`\n${tried} parameter settings tried across ${rows.filter((r) => !r.skipped && !r.control).length} strategies (controls not counted). "vs SPY" is CAGR minus SPY's, in points.`);
  console.log(`SPY buy-and-hold on the older years: CAGR ${pct(spy.dev.cagr)}, Sharpe ${spy.dev.sharpe.toFixed(2)}, max drawdown ${pct(-spy.dev.maxDD)}.`);

  // expanding folds
  const edges = Array.from({ length: FOLDS + 1 }, (_, i) => from + Math.round(((to - from) * i) / FOLDS));
  console.log(`\nEXPANDING FOLDS: tuned on everything before each slice, CAGR minus SPY's on the slice (points)`);
  const fh = Array.from({ length: FOLDS - 1 }, (_, i) => `${D.dates[edges[i + 1]].slice(0, 4)}-${D.dates[edges[i + 2]].slice(2, 4)}`);
  console.log(`${'strategy'.padEnd(15)} ${fh.map((x) => x.padStart(8)).join('')}  folds ahead · SPY CAGR per fold: ${edges.slice(1, -1).map((e, i) => pct(run(D, STRATEGIES.buyHold, {}, { from: e, to: edges[i + 2], bps, cash }).cagr, 0)).join(' ')}`);
  for (const r of rows.filter((x) => !x.skipped)) {
    let diffs;
    if (r.control) {
      diffs = edges.slice(1, -1).map((e, i) => {
        const spyF = run(D, STRATEGIES.buyHold, {}, { from: e, to: edges[i + 2], bps, cash }).cagr;
        return median(r.s.params.map((p) => run(D, r.s, p, { from: e, to: edges[i + 2], bps, cash }).cagr)) - spyF;
      });
    } else {
      diffs = folds(D, r.s, { from, to, k: FOLDS, pick, bps, cash }).map((f) => (f.from < r.sFrom ? NaN : f.test.cagr - run(D, STRATEGIES.buyHold, {}, { from: f.from, to: f.to, bps, cash }).cagr));
    }
    const live = diffs.filter((x) => !Number.isNaN(x));
    console.log(`${r.name.padEnd(15)} ${diffs.map((x) => (Number.isNaN(x) ? 'n/a' : pp(x)).padStart(8)).join('')}  ${live.filter((x) => x > 0).length}/${live.length}`);
  }
  if (flag('json')) fs.writeFileSync(flag('json'), JSON.stringify(rows.map(({ s, ...r }) => r), null, 1));
}

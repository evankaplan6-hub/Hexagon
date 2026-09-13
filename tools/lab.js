'use strict';
// Strategy lab: many different strategies, one scoring engine, SETTLED Kalshi markets.
//
//   node tools/lab-fetch.js                    # once: data/lab/markets.jsonl
//   node tools/lab.js                          # every strategy, tuned on the older markets, scored on the newer
//   node tools/lab.js --detail momentum        # every parameter set of one strategy, both halves
//   node tools/lab.js --by category            # the holdout split by category (or series)
//
// The question is not "which strategy made the most in backtest" -- with enough knobs something
// always does. It is "which strategy, tuned on one set of markets, still makes money on markets it
// never saw". So the markets are split by when they closed: parameters are chosen on the older
// DEV_SHARE and the table reports the newer rest.
//
// THE FILL MODEL, and what it gets wrong:
//   - A strategy decides on an hourly bar's closing bid/ask and trades on the NEXT bar's: one hour
//     of latency, deliberately, so nothing trades on the price it just saw move.
//   - It is a taker: it buys at the ask and sells at the bid, and pays Kalshi's taker fee each
//     time, ceil(0.07 x multiplier x contracts x P x (1-P)) on a SIZE-contract order. A position
//     held to resolution is paid 100c or 0c with no exit fee.
//   - The next bar must have traded at least SIZE contracts and be at most two hours later, so a
//     quote nobody was trading against is not a fill. Depth is still unknown: SIZE is small on
//     purpose, and nothing here says the same edge survives at a thousand contracts.
//   - Every entry, whatever the strategy, needs a book no wider than MAX_SPREAD and MIN_TRAIL_VOL
//     contracts traded in the day before. Both are read from the past, never from how busy the
//     market turned out to be -- see tools/lab-fetch.js for what picking on that did.
//   - Strategies never see `result` or the actual close time. A can-close-early market closes
//     when its answer is known, so "hours to close" is computed from the SCHEDULED expiration.
//   - Markets were chosen by lifetime volume, which is known only afterwards. That favours
//     markets that ended up busy; it is the same for every strategy, so compare rows, not levels.
const fs = require('fs');

const SIZE = 10;                 // contracts per trade
const MAX_SPREAD = 4;            // cents: no strategy opens into a book wider than this
const MIN_TRAIL_VOL = 50;        // contracts traded in the 24h up to the decision, or no entry
const DEV_SHARE = 0.6;           // older share of markets, by close time, used to pick parameters
const MIN_DEV_TRADES = 30;       // a parameter set must trade this often in dev to be pickable

// ------------------------------------------------------------------ pricing
// Kalshi taker fee on an order of `qty` contracts at `px` cents, returned per contract in cents.
function feeCents(px, mult = 1, qty = SIZE) {
  if (!(px > 0 && px < 100) || !(mult > 0)) return 0;
  const p = px / 100;
  const dollars = Math.ceil(0.07 * mult * qty * p * (1 - p) * 100 - 1e-9) / 100;
  return (dollars * 100) / qty;
}
const mid = (bar) => (bar[1] + bar[2]) / 2;
const trailVol = (bars, i) => {                 // contracts traded in the 24h up to and including bar i
  let v = 0;
  for (let k = i; k >= 0 && bars[i][0] - bars[k][0] < 86400; k--) v += bars[k][3];
  return v;
};
const buyPx = (bar, side) => (side === 'yes' ? bar[2] : 100 - bar[1]);   // pay the ask
const sellPx = (bar, side) => (side === 'yes' ? bar[1] : 100 - bar[2]);  // hit the bid

// When the market was SCHEDULED to end, as knowable in advance. A market that cannot close early
// closes at close_time; one that can is only known to expire by its expected expiration.
function schedTs(m) {
  if (!m.earlyClose) return m.closeTs;
  return m.expectTs || null;
}

// ------------------------------------------------------------------ engine
// Runs one strategy over one market. `strat.decide(ctx)` returns 'yes' or 'no' to open, 'exit' to
// close, or nothing. ctx.m is the market WITHOUT result or actual close time.
function runMarket(m, strat, params) {
  const { result, closeTs, ...pub } = m;
  const sched = schedTs(m);
  const bars = m.bars, trades = [], state = {};
  let pos = null;
  for (let i = 0; i < bars.length - 1; i++) {
    const hoursLeft = sched ? (sched - bars[i][0]) / 3600 : null;
    const act = strat.decide({ m: pub, bars, i, pos, p: params, state, hoursLeft });
    if (!act) continue;
    const nb = bars[i + 1];
    if (nb[0] - bars[i][0] > 7200 || nb[3] < SIZE) continue;       // stale or untraded next hour
    if (!pos && (act === 'yes' || act === 'no')) {
      if (bars[i][2] - bars[i][1] > MAX_SPREAD || trailVol(bars, i) < MIN_TRAIL_VOL) continue;
      const px = buyPx(nb, act);
      if (!(px > 0 && px < 100)) continue;
      pos = { side: act, px, fee: feeCents(px, m.feeMult), t: nb[0] };
    } else if (pos && act === 'exit') {
      const px = sellPx(nb, pos.side), exitFee = feeCents(px, m.feeMult);
      trades.push(trade(m, pos, px, exitFee, nb[0], false));
      pos = null;
    }
  }
  if (pos) trades.push(trade(m, pos, result === pos.side ? 100 : 0, 0, closeTs, true));
  return trades;
}
const trade = (m, pos, exitPx, exitFee, exitT, settled) => ({
  ticker: m.ticker, event: m.event, series: m.series, category: m.category, closeTs: m.closeTs,
  side: pos.side, entry: pos.px, exit: exitPx, fees: pos.fee + exitFee, pnl: exitPx - pos.px - pos.fee - exitFee,
  hours: (exitT - pos.t) / 3600, settled,
});

// ------------------------------------------------------------------ strategies
const back = (bars, i, hours) => {             // index of the last bar at least `hours` before bar i
  const want = bars[i][0] - hours * 3600;
  for (let k = i - 1; k >= 0; k--) if (bars[k][0] <= want) return bars[i][0] - bars[k][0] <= (hours + 2) * 3600 ? k : -1;
  return -1;
};
const heldFor = (ctx) => (ctx.bars[ctx.i][0] - ctx.pos.t) / 3600;
const grid = (spec) => Object.entries(spec).reduce((acc, [k, vs]) => acc.flatMap((a) => vs.map((v) => ({ ...a, [k]: v }))), [{}]);
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

const STRATEGIES = {
  favorite: {
    plain: 'buy the side priced as a heavy favorite, hold to the end',
    params: grid({ minPx: [70, 80, 85, 90, 95], maxHoursLeft: [Infinity, 168, 48, 12] }),
    decide({ bars, i, pos, p, hoursLeft }) {
      if (pos) return null;
      if (p.maxHoursLeft !== Infinity && !(hoursLeft != null && hoursLeft >= 0 && hoursLeft <= p.maxHoursLeft)) return null;
      const b = bars[i];
      if (b[2] >= p.minPx && b[2] <= 97) return 'yes';
      if (100 - b[1] >= p.minPx && 100 - b[1] <= 97) return 'no';
      return null;
    },
  },
  longshot: {
    plain: 'buy the cheap side (the underdog), hold to the end',
    params: grid({ maxPx: [5, 10, 20, 30], maxHoursLeft: [Infinity, 168, 48] }),
    decide({ bars, i, pos, p, hoursLeft }) {
      if (pos) return null;
      if (p.maxHoursLeft !== Infinity && !(hoursLeft != null && hoursLeft >= 0 && hoursLeft <= p.maxHoursLeft)) return null;
      const b = bars[i];
      if (b[2] >= 3 && b[2] <= p.maxPx) return 'yes';
      if (100 - b[1] >= 3 && 100 - b[1] <= p.maxPx) return 'no';
      return null;
    },
  },
  momentum: {
    plain: 'price jumped: buy in the direction it moved, sell after a while',
    params: grid({ lookback: [1, 6, 24, 72], move: [5, 10, 15], hold: [6, 24, 72, Infinity] }),
    decide: (ctx) => moveSignal(ctx, +1),
  },
  reversion: {
    plain: 'price jumped: bet it snaps back, sell after a while',
    params: grid({ lookback: [1, 6, 24, 72], move: [5, 10, 15], hold: [6, 24, 72, Infinity] }),
    decide: (ctx) => moveSignal(ctx, -1),
  },
  volumeSpike: {
    plain: 'unusually heavy trading moved the price: follow (or fade) it',
    params: grid({ mult: [5, 10], move: [3, 6], hold: [6, 24, Infinity], dir: [1, -1] }),
    decide(ctx) {
      const { bars, i, pos, p } = ctx;
      if (pos) return p.hold !== Infinity && heldFor(ctx) >= p.hold ? 'exit' : null;
      const k = back(bars, i, 24);
      if (k < 0 || i < 1) return null;
      let vol = 0; for (let j = k; j < i; j++) vol += bars[j][3];
      const avg = vol / Math.max(1, i - k);
      if (!(bars[i][3] >= p.mult * Math.max(avg, SIZE))) return null;
      const d = mid(bars[i]) - mid(bars[i - 1]);
      if (Math.abs(d) < p.move || mid(bars[i]) < 10 || mid(bars[i]) > 90) return null;
      return (d > 0) === (p.dir > 0) ? 'yes' : 'no';
    },
  },
  tightFavorite: {
    plain: 'buy the favorite only when the spread is one cent, hold to the end',
    params: grid({ minPx: [60, 70, 80, 90], maxSpread: [1, 2] }),
    decide({ bars, i, pos, p }) {
      if (pos) return null;
      const b = bars[i];
      if (b[2] - b[1] > p.maxSpread) return null;
      if (b[2] >= p.minPx && b[2] <= 97) return 'yes';
      if (100 - b[1] >= p.minPx && 100 - b[1] <= 97) return 'no';
      return null;
    },
  },
  random: {
    plain: 'control: a coin flip on a random hour, hold to the end',
    params: [{}],
    decide({ m, bars, i, pos, state }) {
      if (pos) return null;
      if (state.at === undefined) { const h = hash(m.ticker); state.at = h % Math.max(1, bars.length - 1); state.side = (h >> 20) & 1 ? 'yes' : 'no'; }
      return i === state.at ? state.side : null;
    },
  },
};

function moveSignal(ctx, sign) {
  const { bars, i, pos, p } = ctx;
  if (pos) return p.hold !== Infinity && heldFor(ctx) >= p.hold ? 'exit' : null;
  const k = back(bars, i, p.lookback);
  if (k < 0) return null;
  const now = mid(bars[i]), d = now - mid(bars[k]);
  if (Math.abs(d) < p.move || now < 10 || now > 90) return null;
  return (d > 0) === (sign > 0) ? 'yes' : 'no';
}

// ------------------------------------------------------------------ scoring
function score(trades) {
  const n = trades.length;
  const pnl = trades.reduce((a, t) => a + t.pnl, 0);
  const cost = trades.reduce((a, t) => a + t.entry, 0);
  const byEvent = new Map();
  for (const t of trades) byEvent.set(t.event, (byEvent.get(t.event) || 0) + t.pnl);
  const ev = [...byEvent.values()], e = ev.length;
  const mean = e ? ev.reduce((a, x) => a + x, 0) / e : 0;
  const sd = e > 1 ? Math.sqrt(ev.reduce((a, x) => a + (x - mean) ** 2, 0) / (e - 1)) : 0;
  return {
    n, events: e,
    win: n ? trades.filter((t) => t.pnl > 0).length / n : 0,
    perContract: n ? pnl / n : 0,                   // cents per contract per trade
    dollars: (pnl * SIZE) / 100,                    // at SIZE contracts a trade
    roi: cost ? pnl / cost : 0,                     // profit per dollar put in
    t: sd > 0 ? mean / (sd / Math.sqrt(e)) : 0,     // clustered by event: events move together
  };
}

// Is the sample fair? At one pseudo-random tight-book hour per market, does a contract priced at
// P resolve YES about P of the time? A real exchange is close to calibrated; a sample picked on
// hindsight is not, and every strategy scored on it inherits the lie.
const BUCKETS = [[3, 10], [10, 30], [30, 50], [50, 70], [70, 90], [90, 97]];
function calibration(markets) {
  const agg = BUCKETS.map(([lo, hi]) => ({ lo, hi, n: 0, price: 0, yes: 0 }));
  for (const m of markets) {
    const tight = m.bars.filter((b) => b[2] - b[1] <= 3);
    if (!tight.length) continue;
    const b = tight[hash(m.ticker) % tight.length], x = mid(b);
    const a = agg.find((g) => x >= g.lo && x < g.hi);
    if (!a) continue;
    a.n++; a.price += x; if (m.result === 'yes') a.yes++;
  }
  return agg.map((a) => ({ ...a, price: a.n ? a.price / a.n : 0, won: a.n ? (100 * a.yes) / a.n : 0 }));
}

function runAll(markets, strat, params) {
  const out = [];
  for (const m of markets) for (const t of runMarket(m, strat, params)) out.push(t);
  return out;
}

const label = (p) => Object.entries(p).map(([k, v]) => `${k}=${v === Infinity ? '∞' : v}`).join(' ') || '-';

module.exports = { feeCents, runMarket, score, calibration, STRATEGIES, schedTs, SIZE, MAX_SPREAD, MIN_TRAIL_VOL };

// ------------------------------------------------------------------ go
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const file = flag('file', 'data/lab/markets.jsonl');
  const markets = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.closeTs - b.closeTs);
  const cut = Math.floor(markets.length * DEV_SHARE);
  const dev = markets.slice(0, cut), hold = markets.slice(cut);
  const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
  const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(0)}`;
  const c = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}c`;
  console.log(`${markets.length} settled markets, ${markets.reduce((a, m) => a + m.bars.length, 0)} hourly bars`);
  console.log(`tune on ${dev.length} closing ${day(dev[0].closeTs)} → ${day(dev[dev.length - 1].closeTs)} · test on ${hold.length} closing → ${day(hold[hold.length - 1].closeTs)} · ${SIZE} contracts a trade, taker, one hour late`);
  const cal = calibration(markets);
  console.log(`sample check, priced → won: ${cal.map((a) => `${a.price.toFixed(0)}c→${a.won.toFixed(0)}% (${a.n})`).join('  ')}`);
  const off = cal.filter((a) => a.n >= 50 && Math.abs(a.won - a.price) > 10);
  if (off.length) console.log(`\x1b[31mWARNING: ${off.length} price bucket(s) resolve more than 10 points away from their price -- the sample looks biased\x1b[0m`);
  console.log('');

  const only = flag('detail');
  if (only) {
    const s = STRATEGIES[only];
    if (!s) { console.error(`unknown strategy ${only}: ${Object.keys(STRATEGIES).join(', ')}`); process.exit(1); }
    console.log(`${only}: ${s.plain}\n${'params'.padEnd(40)} ${'dev trades'.padStart(10)} ${'dev ¢/ct'.padStart(9)} ${'test trades'.padStart(11)} ${'test ¢/ct'.padStart(9)} ${'test $'.padStart(7)} ${'t'.padStart(5)}`);
    for (const p of s.params) {
      const d = score(runAll(dev, s, p)), h = score(runAll(hold, s, p));
      console.log(`${label(p).padEnd(40)} ${String(d.n).padStart(10)} ${c(d.perContract).padStart(9)} ${String(h.n).padStart(11)} ${c(h.perContract).padStart(9)} ${money(h.dollars).padStart(7)} ${h.t.toFixed(1).padStart(5)}`);
    }
    process.exit(0);
  }

  const rows = [];
  for (const [name, s] of Object.entries(STRATEGIES)) {
    let best = null;
    for (const p of s.params) {
      const d = score(runAll(dev, s, p));
      if (s.params.length > 1 && d.n < MIN_DEV_TRADES) continue;
      if (!best || d.dollars > best.dev.dollars) best = { p, dev: d };
    }
    if (!best) { rows.push({ name, plain: s.plain, none: true }); continue; }
    const trades = runAll(hold, s, best.p);
    rows.push({ name, plain: s.plain, p: best.p, dev: best.dev, test: score(trades), trades });
  }
  rows.sort((a, b) => (b.test ? b.test.dollars : -Infinity) - (a.test ? a.test.dollars : -Infinity));

  console.log(`${'strategy'.padEnd(14)} ${'picked on the older markets'.padEnd(34)} ${'tune $'.padStart(7)} │ ${'trades'.padStart(6)} ${'win'.padStart(4)} ${'¢/contract'.padStart(10)} ${'return'.padStart(7)} ${'profit'.padStart(7)} ${'t'.padStart(5)}`);
  for (const r of rows) {
    if (r.none) { console.log(`${r.name.padEnd(14)} never traded ${MIN_DEV_TRADES}+ times`); continue; }
    const h = r.test;
    console.log(`${r.name.padEnd(14)} ${label(r.p).padEnd(34)} ${money(r.dev.dollars).padStart(7)} │ ${String(h.n).padStart(6)} ${(h.win * 100).toFixed(0).padStart(3)}% ${c(h.perContract).padStart(10)} ${((h.roi * 100).toFixed(1) + '%').padStart(7)} ${money(h.dollars).padStart(7)} ${h.t.toFixed(1).padStart(5)}`);
  }
  console.log(`\nt: profit per event over its standard error, events counted once. |t| under 2 is indistinguishable from luck.`);

  const by = flag('by');
  if (by) {
    for (const r of rows.filter((x) => !x.none)) {
      const groups = new Map();
      for (const t of r.trades) { const k = t[by] || '(none)'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(t); }
      console.log(`\n${r.name} (${label(r.p)}) on the test markets, by ${by}`);
      for (const [k, ts] of [...groups.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
        const s = score(ts);
        console.log(`  ${String(k).slice(0, 24).padEnd(24)} ${String(s.n).padStart(5)} trades ${c(s.perContract).padStart(9)} ${money(s.dollars).padStart(7)}  t ${s.t.toFixed(1)}`);
      }
    }
  }
  if (flag('json')) fs.writeFileSync(flag('json'), JSON.stringify(rows.map(({ trades, ...r }) => r), null, 1));
}

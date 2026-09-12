'use strict';
// Which markets should the maker quote? Three rankings, scored walk-forward on Kalshi's own tape.
//
//   node tools/maker-rank.js data/fly/rank-listing.json data/fly/rank-trades.jsonl
//   node tools/maker-rank.js data/fly/rank-listing.json data/fly/rank-trades.jsonl --queue depth --top 24
//
// The live rule (makerdesk.refreshUniverse) ranks on how fast the queue at the touch clears:
// contracts already resting there, divided by this market's contracts per day. The rework plan's
// worry is that a queue which clears fast is a level that gets swept, and a sweep through a
// resting quote is a run-over -- the fill that has cost this desk its money. So three rankings
// are scored against each other here, each choosing `--top` markets from the same pool:
//
//   clear     today's rule: trades/day >= makerMinTradesPerDay, queue clears inside
//             makerMaxClearDays, fastest first
//   tpd       trades per day, busiest first (the rule before clear-time, README's +$454 / +$259)
//   pnl       the market's own replayed P&L net of run-over over the ranking window, best first
//
// WALK-FORWARD. Each fold ranks on `--rank` days of tape and scores on the `--score` days that
// follow, and only the score window counts. A ranking is allowed to know nothing about the
// window it is scored on; the pnl ranking in particular would look wonderful in sample and that
// number is printed only to show the gap.
//
// WHAT THIS INHERITS FROM tools/maker-replay.js, and one thing of its own:
//   - The book is reconstructed from prints and there is no queue unless `--queue` says so.
//     `--queue depth` uses each market's top-of-book size from the listing, the way the README's
//     backtest fed every market its own measured depth. That depth is TODAY's, applied to every
//     fold, because nothing records what it was.
//   - The pool is every market open TODAY in the maker's series that is inside the mid band, one
//     tick or wider and a week from close. Markets that have since closed are not in it, so a
//     fold from July is scored on the markets that survived to September. That flatters every
//     ranking equally and none of them relative to the others, which is the comparison made here.
const fs = require('fs');
const base = require('../src/config');
const { touchFrom, replayMarket } = require('./maker-replay');

const args = process.argv.slice(2);
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--')));
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const listingFile = files.find((f) => /\.json$/.test(f)), tradesFile = files.find((f) => /\.jsonl$/.test(f));
if (!listingFile || !tradesFile) { console.error('usage: node tools/maker-rank.js <listing.json> <trades.jsonl> [--top 24] [--rank 21] [--score 14] [--queue 0|depth|N]'); process.exit(1); }

const TOP = parseInt(flag('top', base.makerMarkets), 10);
const RANK_DAYS = parseFloat(flag('rank', 21)), SCORE_DAYS = parseFloat(flag('score', 14));
const queueMode = flag('queue', '0');
const DAY = 86400000;
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '-');

// ---------------------------------------------------------------- inputs
const listing = new Map(JSON.parse(fs.readFileSync(listingFile, 'utf8')).map((r) => [r.ticker, r]));
const byTicker = new Map();
for (const l of fs.readFileSync(tradesFile, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  let t; try { t = JSON.parse(l); } catch { continue; }
  t._t = Date.parse(t.created_time);
  if (!Number.isFinite(t._t) || !listing.has(t.ticker)) continue;
  if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
  byTicker.get(t.ticker).push(t);
}
for (const v of byTicker.values()) v.sort((a, b) => a._t - b._t);
let tapeStart = Infinity, tapeEnd = -Infinity, prints = 0;
for (const v of byTicker.values()) { prints += v.length; if (v[0]._t < tapeStart) tapeStart = v[0]._t; if (v[v.length - 1]._t > tapeEnd) tapeEnd = v[v.length - 1]._t; }

const queueFor = (ticker) => (queueMode === 'depth' ? (listing.get(ticker).depth || 0) : parseFloat(queueMode) || 0);

// ---------------------------------------------------------------- features at a point in time
// What the desk could have known at `at`, from the tape before it. tpd and contracts/day are
// measured over the ranking window, as marketStats measures them over the last 100 prints; the
// mid is the reconstructed touch, so the band filter applies as it would have then.
function featuresAt(ticker, trades, from, at, cfg) {
  const win = trades.filter((t) => t._t >= from && t._t < at);
  let book = { bid: null, ask: null };
  for (const t of trades) { if (t._t >= at) break; book = touchFrom(book, t); }
  const days = (at - from) / DAY;
  const tpd = win.length / days;
  const cpd = win.reduce((a, t) => a + (parseFloat(t.count_fp) || 0), 0) / days;
  const depth = listing.get(ticker).depth || 0;
  const mid = book.bid != null && book.ask != null ? (book.bid + book.ask) / 2 : null;
  const inBand = mid != null && mid >= cfg.makerMinMid && mid <= cfg.makerMaxMid;
  return { tpd, cpd, depth, clear: depth / Math.max(1, cpd), mid, inBand, prints: win.length };
}

// ---------------------------------------------------------------- go
const cfg = { ...base, makerMaxRunOver: 1, makerSoftCap: 1 };   // the ranking question, with Phase 1's two switched-off items off here too
const folds = [];
for (let at = tapeStart + RANK_DAYS * DAY; at + SCORE_DAYS * DAY <= tapeEnd + 1; at += SCORE_DAYS * DAY) folds.push(at);
console.log(`${byTicker.size} markets with prints, ${prints} prints, ${new Date(tapeStart).toISOString().slice(0, 10)} → ${new Date(tapeEnd).toISOString().slice(0, 10)}`);
console.log(`${folds.length} folds: rank on ${RANK_DAYS}d, score on the next ${SCORE_DAYS}d · top ${TOP} · queue ${queueMode} · participation ${cfg.makerParticipation}, cap ${cfg.makerCap}`);
console.log(`\x1b[2mbook reconstructed from prints; pool is today's open markets; read the rankings against each other, not the level\x1b[0m`);

const RANKINGS = {
  clear: (f) => f.tpd >= cfg.makerMinTradesPerDay && f.clear <= cfg.makerMaxClearDays ? -f.clear : null,
  tpd: (f) => f.tpd >= cfg.makerMinTradesPerDay ? f.tpd : null,
  pnl: (f) => f.tpd >= cfg.makerMinTradesPerDay ? f.pnlIn : null,
};
const grand = {};
for (const name of Object.keys(RANKINGS)) grand[name] = { total: 0, realized: 0, roCost: 0, roQty: 0, qty: 0, pos: 0, n: 0, inSample: 0 };
grand.pool = { total: 0, realized: 0, roCost: 0, roQty: 0, qty: 0, pos: 0, n: 0, inSample: 0 };

for (const at of folds) {
  const from = at - RANK_DAYS * DAY, until = at + SCORE_DAYS * DAY;
  // features and the in-sample replay for every market in the pool at `at`
  const feats = new Map();
  for (const [ticker, trades] of byTicker) {
    const f = featuresAt(ticker, trades, from, at, cfg);
    if (!f.inBand || f.prints < 10) continue;
    const r = replayMarket(trades, cfg, { since: from, until: at, queue: queueFor(ticker) });
    f.pnlIn = r.total;
    feats.set(ticker, f);
  }
  // the out-of-sample replay, once per market, shared by every ranking
  const scored = new Map();
  const scoreOf = (ticker) => {
    if (!scored.has(ticker)) scored.set(ticker, replayMarket(byTicker.get(ticker), cfg, { since: at, until, queue: queueFor(ticker) }));
    return scored.get(ticker);
  };
  const line = (label, picks, inSample) => {
    const rs = picks.map(scoreOf);
    const total = rs.reduce((a, r) => a + r.total, 0), realized = rs.reduce((a, r) => a + r.realized, 0);
    const roCost = rs.reduce((a, r) => a + r.roCost, 0), roQty = rs.reduce((a, r) => a + r.roQty, 0), qty = rs.reduce((a, r) => a + r.qty, 0);
    const pos = rs.filter((r) => r.total > 0).length;
    const g = grand[label];
    g.total += total; g.realized += realized; g.roCost += roCost; g.roQty += roQty; g.qty += qty; g.pos += pos; g.n += rs.length; g.inSample += inSample;
    console.log(`  ${label.padEnd(6)} ${String(picks.length).padStart(3)} mkts  in-sample ${money(inSample).padStart(9)}   out ${money(total).padStart(9)}  realized ${money(realized).padStart(9)}  run-over ${money(-roCost).padStart(9)} (${pct(roQty, qty).padStart(4)} of ${String(qty).padStart(6)} contracts)  ${pos}/${rs.length} positive`);
  };
  console.log(`\nfold: rank ${new Date(from).toISOString().slice(0, 10)} → ${new Date(at).toISOString().slice(0, 10)}, score → ${new Date(until).toISOString().slice(0, 10)} · ${feats.size} in the pool`);
  for (const [name, key] of Object.entries(RANKINGS)) {
    const ranked = [...feats.entries()].map(([t, f]) => [t, key(f), f]).filter((x) => x[1] != null).sort((a, b) => b[1] - a[1]).slice(0, TOP);
    line(name, ranked.map((x) => x[0]), ranked.reduce((a, x) => a + x[2].pnlIn, 0));
  }
  line('pool', [...feats.keys()], [...feats.values()].reduce((a, f) => a + f.pnlIn, 0));
}

console.log(`\nall folds`);
for (const [label, g] of Object.entries(grand)) {
  console.log(`  ${label.padEnd(6)} ${String(g.n).padStart(3)} picks  in-sample ${money(g.inSample).padStart(9)}   out ${money(g.total).padStart(9)}  realized ${money(g.realized).padStart(9)}  run-over ${money(-g.roCost).padStart(9)} (${pct(g.roQty, g.qty).padStart(4)} of ${String(g.qty).padStart(6)} contracts)  ${g.pos}/${g.n} positive  ${g.n ? money(g.total / g.n) : ''} per pick`);
}

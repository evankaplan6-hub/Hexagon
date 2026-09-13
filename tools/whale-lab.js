'use strict';
// Whale lab: would copying Polymarket's best sports bettors have made money?
//
//   node tools/whale-fetch.js                 # once: data/lab/whales/
//   node tools/whale-lab.js                   # the answer
//   node tools/whale-lab.js --minUsd 50000 --slip 0.02 --fee 0.01 --top 25
//
// A BET is exactly what whale watch announces on the floor (src/whales.betsFrom): the fill that
// takes one wallet's net buying on one outcome past --minUsd within six hours. A COPY is $100 on
// the same outcome at the whale's fill price plus --slip (the price moves before you see it:
// whale watch reads each wallet about every 75 seconds, and a big buyer is moving the price
// themselves), plus a --fee on what you pay, held to settlement.
//
// WHAT CAN FOOL THIS, and what the lab does about each:
//   - Picking wallets on the profit that is being tested. Today's leaderboard ranks wallets by the
//     bets they just won, so scoring those wallets on those bets is circular. The honest rows pick
//     wallets on the FIRST half of the window and score only the SECOND. The leaderboard row is
//     printed anyway, labelled, because it is what whale watch follows and what paid trackers show.
//   - Bets placed after the game started. A whale buying at 97c in the ninth inning is not a call
//     anyone could copy in time. Pre-game bets are the headline; in-play is shown separately.
//   - Hedges. A wallet that crossed the bar on both sides of a market is managing a book. Dropped.
//   - One game, many bets. Twenty wallets piling onto one favourite is one outcome, not twenty, so
//     t is computed with each EVENT counted once.
//   - The pool is sports leaderboards by profit AND by volume, so it holds losers too -- but only
//     wallets still active enough to rank. That flatters every row equally; compare rows.
//   - Busy wallets (bots making thousands of fills a day) cannot be paged back through the whole
//     window. Their bets count only from where their history begins.
const fs = require('fs');
const path = require('path');
const { betsFrom } = require('../src/whales');

const STAKE = 100;
const WINDOW_SEC = 6 * 3600;

// What one outcome paid at settlement, or null if it has not settled. A voided or split market
// pays its final price (e.g. 0.5) rather than being called a win or a loss.
function payout(market, outcomeIndex) {
  if (!market || !market.resolved || !Array.isArray(market.prices)) return null;
  const p = market.prices[outcomeIndex];
  return Number.isFinite(p) && p >= 0 && p <= 1 ? p : null;
}

// Polymarket writes gameStartTime as "2026-09-11 19:00:00+00", which Date.parse does not read.
function startTs(market) {
  if (!market || !market.gameStart) return null;
  const s = String(market.gameStart).replace(' ', 'T').replace(/\+00$/, 'Z');
  const t = Date.parse(s);
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
}

function phase(bet, market) {
  const g = startTs(market);
  if (g == null) return 'no start time';
  return bet.ts < g ? 'pre-game' : 'in-play';
}

// Dollars made copying one bet with a $STAKE, or null where no copy was possible (the price
// after slippage is already at a dollar).
function copyPnl(bet, pay, { slip = 0.01, fee = 0.01, stake = STAKE } = {}) {
  const entry = bet.price + slip;
  if (pay == null || !(entry > 0) || entry >= 0.995) return null;
  const shares = stake / (entry * (1 + fee));
  return shares * pay - stake;
}

// rows: [{ pnl, event, won, price }]
function summarize(rows) {
  const n = rows.length;
  if (!n) return { n: 0, events: 0, win: 0, roi: 0, dollars: 0, price: 0, t: 0 };
  const byEvent = new Map();
  for (const r of rows) byEvent.set(r.event, (byEvent.get(r.event) || 0) + r.pnl);
  const ev = [...byEvent.values()];
  const mean = ev.reduce((a, x) => a + x, 0) / ev.length;
  const sd = Math.sqrt(ev.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, ev.length - 1));
  const dollars = rows.reduce((a, r) => a + r.pnl, 0);
  return {
    n, events: ev.length,
    win: rows.filter((r) => r.won).length / n,
    roi: dollars / (n * STAKE),
    dollars,
    price: rows.reduce((a, r) => a + r.price, 0) / n,
    t: ev.length > 1 && sd > 0 ? mean / (sd / Math.sqrt(ev.length)) : 0,
  };
}

// Wallets ranked on their own bets in one span, at their own price with no costs: a measure of
// how good their calls were, not of what copying them would pay.
function rankWallets(bets, { minBets = 10 } = {}) {
  const by = new Map();
  for (const b of bets) {
    const s = by.get(b.wallet) || { wallet: b.wallet, n: 0, pnl: 0 };
    s.n++; s.pnl += STAKE * (b.pay - b.price) / b.price;
    by.set(b.wallet, s);
  }
  return [...by.values()].filter((s) => s.n >= minBets).map((s) => ({ ...s, roi: s.pnl / (s.n * STAKE) })).sort((a, b) => b.roi - a.roi);
}

function load(dir) {
  const read = (f) => JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
  const meta = read('meta.json'), pool = read('pool.json'), conds = read('conditions.json'), markets = read('markets.json');
  const wallets = [];
  for (const line of fs.readFileSync(path.join(dir, 'fills.jsonl'), 'utf8').split('\n')) {
    if (!line) continue;
    const w = JSON.parse(line);
    if (w.error) continue;
    wallets.push(w);
  }
  return { meta, pool, conds, markets, wallets };
}

// Every wallet's bets at each threshold, with the market's settlement attached.
function allBets(data, thresholds) {
  const { conds, markets, meta } = data;
  const out = new Map(thresholds.map((t) => [t, []]));
  for (const w of data.wallets) {
    const fills = w.f.map(([ts, side, ci, o, price, size, usd]) => ({
      wallet: w.w, ts, side: side < 0 ? 'SELL' : 'BUY', conditionId: conds[ci].cid, outcomeIndex: o,
      outcome: conds[ci].outcomes[o] || '', price, size, usd, title: conds[ci].title, eventSlug: conds[ci].event,
    }));
    // A bet needs six hours of history behind it to be summed correctly: from the window start for
    // a wallet paged back fully, from where its history begins for one that was cut short.
    const from = (w.truncated ? w.oldestTs : meta.startTs) + WINDOW_SEC;
    for (const t of thresholds) {
      for (const b of betsFrom(fills, { minUsd: t, windowSec: WINDOW_SEC })) {
        if (b.ts < from) continue;
        const m = markets[b.conditionId];
        out.get(t).push({ ...b, pay: payout(m, b.outcomeIndex), phase: phase(b, m), sport: m && m.sport });
      }
    }
  }
  return out;
}

module.exports = { payout, startTs, phase, copyPnl, summarize, rankWallets, STAKE };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const DIR = flag('dir', 'data/lab/whales');
  const MIN_USD = parseFloat(flag('minUsd', 10000));
  const SLIP = parseFloat(flag('slip', 0.01));
  const FEE = parseFloat(flag('fee', 0.01));
  const TOP = parseInt(flag('top', 25), 10);
  const MIN_BETS = parseInt(flag('minBets', 10), 10);

  const data = load(DIR);
  const { meta, pool } = data;
  const mid = Math.floor((meta.startTs + meta.endTs) / 2);
  const day = (ts) => new Date(ts * 1000).toISOString().slice(5, 10);
  const thresholds = [...new Set([MIN_USD, 10000, 50000, 100000])].sort((a, b) => a - b);
  const bets = allBets(data, thresholds);

  const usable = (b) => b.pay != null && !b.hedged;
  const row = (b, slip = SLIP) => { const pnl = copyPnl(b, b.pay, { slip, fee: FEE }); return pnl == null ? null : { pnl, event: b.eventSlug || b.conditionId, won: b.pay > b.price + slip, price: b.price }; };
  const score = (list, slip) => summarize(list.map((b) => row(b, slip)).filter(Boolean));
  const $ = (x) => `${x >= 0 ? '+' : '−'}$${Math.abs(Math.round(x)).toLocaleString()}`;
  const pct = (x) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const line = (label, s) => console.log(`${label.padEnd(52)} ${String(s.n).padStart(6)} ${String(s.events).padStart(6)} ${((s.win * 100).toFixed(0) + '%').padStart(5)} ${(Math.round(s.price * 100) + 'c').padStart(5)} ${pct(s.roi).padStart(8)} ${$(s.dollars).padStart(9)} ${s.t.toFixed(1).padStart(5)}`);
  const head = () => console.log(`${''.padEnd(52)} ${'bets'.padStart(6)} ${'games'.padStart(6)} ${'win'.padStart(5)} ${'price'.padStart(5)} ${'return'.padStart(8)} ${'profit'.padStart(9)} ${'t'.padStart(5)}`);

  const main = bets.get(MIN_USD);
  const A = main.filter((b) => b.ts < mid && usable(b) && b.phase === 'pre-game');
  const B = main.filter((b) => b.ts >= mid && usable(b) && b.phase === 'pre-game');
  const truncated = data.wallets.filter((w) => w.truncated).length;
  const settledShare = main.filter((b) => b.pay != null).length / Math.max(1, main.length);

  console.log(`${pool.length} sports wallets · ${data.wallets.reduce((a, w) => a + w.f.length, 0).toLocaleString()} fills ${day(meta.startTs)} → ${day(meta.endTs)} · ${truncated} too busy to page back fully`);
  console.log(`${main.length} bets of $${(MIN_USD / 1000).toFixed(0)}K+ · ${(settledShare * 100).toFixed(0)}% settled · ${main.filter((b) => b.hedged).length} hedged both sides (dropped)`);
  console.log(`pick on ${day(meta.startTs)} → ${day(mid)} (${A.length} pre-game bets) · test on ${day(mid)} → ${day(meta.endTs)} (${B.length})`);
  console.log(`copy: $${STAKE} a bet at the whale's price + ${Math.round(SLIP * 100)}c, ${(FEE * 100).toFixed(1)}% fee, held to settlement\n`);

  // the market's own honesty: do the whales' prices already say what happens?
  const all = main.filter(usable);
  const edge = all.reduce((a, b) => a + (b.pay - b.price), 0) / Math.max(1, all.length);
  console.log(`before any cost, the average bet paid ${(edge * 100).toFixed(1)}c per share over its price (${all.length} bets)\n`);

  const monthTop = new Set(pool.filter((p) => p.lists.some((l) => { const m = l.match(/^MONTH\/PNL#(\d+)$/); return m && +m[1] <= TOP; })).map((p) => p.wallet));
  // Top and bottom never share a wallet: with fewer than 2 x TOP rankable wallets, they split the list.
  const ranked = rankWallets(A, { minBets: MIN_BETS });
  const k = Math.min(TOP, Math.floor(ranked.length / 2));
  const best = new Set(ranked.slice(0, k).map((r) => r.wallet));
  const worst = new Set(ranked.slice(ranked.length - k).map((r) => r.wallet));

  console.log(`${ranked.length} wallets made ${MIN_BETS}+ pre-game bets in the first half, so they can be ranked on it`);
  console.log(`TEST HALF, pre-game bets only`);
  head();
  line('every wallet in the pool', score(B));
  line(`top ${best.size} picked on the first half (${MIN_BETS}+ bets)`, score(B.filter((b) => best.has(b.wallet))));
  line(`bottom ${worst.size} picked the same way`, score(B.filter((b) => worst.has(b.wallet))));
  line(`today's top ${TOP} by month profit  ← LOOK-AHEAD`, score(B.filter((b) => monthTop.has(b.wallet))));
  console.log(`\nthe same top ${best.size}, scored on the half they were picked on  ← IN-SAMPLE, for contrast`);
  line('', score(A.filter((b) => best.has(b.wallet))));

  console.log(`\nwhen the bet was placed (test half, every wallet)`);
  for (const ph of ['pre-game', 'in-play', 'no start time']) {
    line(ph, score(main.filter((b) => b.ts >= mid && usable(b) && b.phase === ph)));
  }

  console.log(`\nprice moved before you copied (top ${best.size} picked on the first half, test half)`);
  for (const s of [0, 0.01, 0.02, 0.03]) line(`+${Math.round(s * 100)}c`, score(B.filter((b) => best.has(b.wallet)), s));

  console.log(`\nbet size (test half, pre-game, every wallet · top picked on the first half)`);
  for (const t of thresholds) {
    const list = bets.get(t);
    const a = list.filter((b) => b.ts < mid && usable(b) && b.phase === 'pre-game');
    const b2 = list.filter((b) => b.ts >= mid && usable(b) && b.phase === 'pre-game');
    const rk = rankWallets(a, { minBets: MIN_BETS });
    const top = new Set(rk.slice(0, Math.min(TOP, Math.floor(rk.length / 2))).map((r) => r.wallet));
    line(`$${(t / 1000).toFixed(0)}K+ · every wallet`, score(b2));
    line(`$${(t / 1000).toFixed(0)}K+ · top picked`, score(b2.filter((b) => top.has(b.wallet))));
  }
  console.log(`\nt: profit per game over its standard error, each game counted once. |t| under 2 is indistinguishable from luck.`);
}

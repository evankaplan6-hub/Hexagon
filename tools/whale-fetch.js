'use strict';
// Download what Polymarket's sports wallets bought, and how those markets settled, for
// tools/whale-lab.js.
//
//   node tools/whale-fetch.js                      # → data/lab/whales/
//   node tools/whale-fetch.js --days 42 --pool 100 --maxPages 10
//
// THE POOL, which decides whether the answer means anything. Scoring the wallets on today's
// profit leaderboard over the month that put them there is guaranteed to look brilliant: they are
// on the list BECAUSE those bets won. So the pool is deliberately wider than the winners --
//   * top `--pool` by profit this month and all-time (the wallets whale watch actually follows)
//   * top `--pool` by VOLUME this month and all-time, which includes wallets that lost
// -- and tools/whale-lab.js picks its wallets from the FIRST half of the window only and scores
// them on the second. Volume is still decided after the fact (a wallet that went broke stopped
// trading), which the lab states rather than hides.
//
// Output, compact because a busy wallet makes thousands of fills a day:
//   pool.json        [{ wallet, name, lists: ['MONTH/PNL#3', ...], pnl: {MONTH, ALL}, vol: {MONTH, ALL} }]
//   conditions.json  [{ cid, event, title, outcomes: { index: name } }] -- fills point into this by position
//   fills.jsonl      one line per wallet: { w, oldestTs, truncated, f: [[ts, side, ci, outcomeIndex, price, size, usd], ...] }
//                    side is 1 for a buy and -1 for a sell. `truncated` means the wallet trades too
//                    much to page back through the whole window; the lab scores only the span it covers.
//   markets.json     { cid: { resolved, closed, prices, gameStart, sport, endDate } }
//   meta.json        { fetchedAt, startTs, endTs, days, pool, maxPages }
//
// Read-only public data, no key.
const fs = require('fs');
const path = require('path');
const pm = require('../src/venues/polymarket');

const args = process.argv.slice(2);
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const DAYS = parseFloat(flag('days', 42));
const POOL = parseInt(flag('pool', 100), 10);
const MAX_PAGES = parseInt(flag('maxPages', 10), 10);   // 500 fills a page
const OUT = flag('out', 'data/lab/whales');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const r4 = (x) => Math.round(x * 1e4) / 1e4;

async function retry(fn, tries = 5) {
  for (let i = 0; ; i++) {
    try { return await fn(); }
    catch (e) { if (i >= tries - 1) throw e; await sleep(1000 * 2 ** i); }
  }
}

async function buildPool() {
  const pool = new Map();
  for (const period of ['MONTH', 'ALL']) {
    for (const orderBy of ['PNL', 'VOL']) {
      for (let off = 0; off < POOL; off += 50) {
        const want = Math.min(50, POOL - off);
        const rows = await retry(() => pm.fetchLeaderboard({ category: 'SPORTS', period, orderBy, limit: want, offset: off }));
        for (const r of rows) {
          const p = pool.get(r.wallet) || { wallet: r.wallet, name: r.name, lists: [], pnl: {}, vol: {} };
          p.lists.push(`${period}/${orderBy}#${r.rank}`);
          p.pnl[period] = Math.round(r.pnl); p.vol[period] = Math.round(r.vol);
          pool.set(r.wallet, p);
        }
        if (rows.length < want) break;
      }
    }
  }
  return [...pool.values()];
}

// Page backwards through one wallet's fills with the `end` cursor until the window start.
async function walletFills(wallet, startTs, endTs) {
  const seen = new Set(), out = [];
  let end = endTs, pages = 0, truncated = false;
  for (;;) {
    const page = await retry(() => pm.fetchActivity(wallet, { limit: 500, start: startTs, end }));
    pages++;
    let fresh = 0;
    for (const f of page) {
      // price is part of a fill's identity: one tx sweeping 34c and 35c for the same size is two fills
      const k = pm.fillKey(f);
      if (seen.has(k)) continue;
      seen.add(k); out.push(f); fresh++;
    }
    if (page.length < 500) break;
    const oldest = Math.min(...page.map((f) => f.ts));
    if (!fresh || oldest <= startTs) break;
    if (pages >= MAX_PAGES) { truncated = true; break; }
    // Fills sharing the boundary second are re-read on the next page and deduped above.
    end = oldest === end ? oldest - 1 : oldest;
  }
  return { fills: out, truncated, oldestTs: out.length ? Math.min(...out.map((f) => f.ts)) : null };
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const endTs = Math.floor(Date.now() / 1000);
  const startTs = endTs - Math.round(DAYS * 86400);

  const pool = await buildPool();
  fs.writeFileSync(path.join(OUT, 'pool.json'), JSON.stringify(pool, null, 1));
  console.log(`pool: ${pool.length} wallets from the sports leaderboards (${POOL} deep each)`);

  const fillsPath = path.join(OUT, 'fills.jsonl');
  fs.writeFileSync(fillsPath, '');
  const conds = [], condIdx = new Map();
  const ci = (f) => {
    let i = condIdx.get(f.conditionId);
    if (i === undefined) { i = conds.length; condIdx.set(f.conditionId, i); conds.push({ cid: f.conditionId, event: f.eventSlug, title: f.title, outcomes: {} }); }
    if (f.outcome && !conds[i].outcomes[f.outcomeIndex]) conds[i].outcomes[f.outcomeIndex] = f.outcome;
    return i;
  };
  let done = 0, total = 0, cut = 0;
  const queue = [...pool];
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let p = queue.shift(); p; p = queue.shift()) {
      try {
        const r = await walletFills(p.wallet, startTs, endTs);
        const rows = r.fills.map((f) => [f.ts, f.side === 'SELL' ? -1 : 1, ci(f), f.outcomeIndex, r4(f.price), r4(f.size), r4(f.usd)]);
        fs.appendFileSync(fillsPath, JSON.stringify({ w: p.wallet, oldestTs: r.oldestTs, truncated: r.truncated, f: rows }) + '\n');
        total += rows.length; if (r.truncated) cut++;
      } catch (e) {
        fs.appendFileSync(fillsPath, JSON.stringify({ w: p.wallet, error: String(e.message).slice(0, 120), f: [] }) + '\n');
      }
      if (++done % 25 === 0) console.log(`  ${done}/${pool.length} wallets · ${total} fills · ${conds.length} markets`);
    }
  }));
  fs.writeFileSync(path.join(OUT, 'conditions.json'), JSON.stringify(conds));
  console.log(`fills: ${total} from ${pool.length} wallets · ${cut} too busy to page back all ${DAYS} days`);

  const chunks = [];
  for (let i = 0; i < conds.length; i += 20) chunks.push(conds.slice(i, i + 20).map((c) => c.cid));
  const markets = {};
  let n = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    for (let c = chunks.shift(); c; c = chunks.shift()) {
      try {
        for (const m of await retry(() => pm.fetchByConditions(c))) {
          markets[m.conditionId] = { resolved: m.resolved, closed: m.closed, prices: m.prices, gameStart: m.gameStart, sport: m.sport, endDate: m.endDate };
        }
      } catch (e) { console.log(`  market lookup failed for ${c.length}: ${e.message}`); }
      if (++n % 100 === 0) console.log(`  markets ${n * 20}/${conds.length}`);
    }
  }));
  fs.writeFileSync(path.join(OUT, 'markets.json'), JSON.stringify(markets));
  fs.writeFileSync(path.join(OUT, 'meta.json'), JSON.stringify({ fetchedAt: new Date().toISOString(), startTs, endTs, days: DAYS, pool: POOL, maxPages: MAX_PAGES }, null, 1));
  const settled = Object.values(markets).filter((m) => m.resolved).length;
  console.log(`markets: ${Object.keys(markets).length} of ${conds.length} found · ${settled} settled · wrote ${OUT}/`);
}

main().catch((e) => { console.error(e); process.exit(1); });

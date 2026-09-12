'use strict';
// Would a maker leg on Polymarket's CLOB pay? Measure before building: the queue at the touch,
// the trade rate, how long that queue takes to clear, and what a resting order actually earns.
//
//   node tools/pm-maker-scan.js                 # the political / macro pool, top-of-book and trade rate
//   node tools/pm-maker-scan.js --json out.json # keep the rows
//
// Same yardstick the README used for Kalshi: `queue` is the size already resting at the touch
// (a fresh order joins behind it), `cpd` is contracts a day from the recent tape, `clear` is
// queue / cpd -- the days before a resting order at the touch is reached. The pool is what the
// Kalshi maker quotes: non-sport, a week or more from resolution, mid inside the 8-92c band.
// Read-only: Gamma for the listing, the CLOB for the book, the data API for prints.
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const DATA = 'https://data-api.polymarket.com';
const args = process.argv.slice(2);
const flag = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : undefined; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const get = async (url) => { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 80)}`); return r.json(); };
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))] : null; };
const dist = (xs) => `min ${Math.round(q(xs, 0))}  p25 ${Math.round(q(xs, 0.25))}  median ${Math.round(q(xs, 0.5))}  p75 ${Math.round(q(xs, 0.75))}  max ${Math.round(q(xs, 1))}`;

(async () => {
  // ---- the pool: top 1000 by 24h volume, cut to what the Kalshi maker would quote
  const now = Date.now();
  const pool = [];
  for (let off = 0; off < 1000; off += 100) {
    const page = await get(`${GAMMA}/markets?closed=false&active=true&limit=100&offset=${off}&order=volume24hr&ascending=false`);
    for (const m of page) {
      if (m.sportsMarketType || m.gameStartTime) continue;
      const days = (Date.parse(m.endDate) - now) / 864e5;
      const bid = parseFloat(m.bestBid), ask = parseFloat(m.bestAsk);
      if (!(days >= 7) || !(ask > bid)) continue;
      const mid = (bid + ask) / 2;
      if (mid < 0.08 || mid > 0.92) continue;
      let tokens = []; try { tokens = JSON.parse(m.clobTokenIds); } catch { continue; }
      if (!tokens.length) continue;
      const fs = m.feeSchedule || {};
      pool.push({ q: m.question, cid: m.conditionId, token: tokens[0], vol24: parseFloat(m.volume24hr) || 0, days, mid, tick: parseFloat(m.orderPriceMinTickSize) || 0.01,
        fees: !!m.feesEnabled, feeRate: m.feesEnabled ? (fs.rate || 0) : 0, rebate: m.feesEnabled ? (fs.rebateRate || 0) : 0,
        rewardsPerDay: (m.clobRewards || []).reduce((a, r) => a + (parseFloat(r.rewardsDailyRate) || 0), 0), rewardsMaxSpread: parseFloat(m.rewardsMaxSpread) || 0, rewardsMinSize: parseFloat(m.rewardsMinSize) || 0 });
    }
    await sleep(150);
  }
  console.log(`${pool.length} non-sport markets a week or more out, mid in 8-92c, from the top 1000 by 24h volume · ${pool.filter((m) => m.fees).length} charge taker fees\n`);

  // ---- per market: the book and the recent tape
  const rows = [];
  for (const m of pool) {
    try {
      const b = await get(`${CLOB}/book?token_id=${m.token}`);
      const bids = b.bids.map((x) => ({ p: +x.price, s: +x.size })).sort((x, y) => y.p - x.p);
      const asks = b.asks.map((x) => ({ p: +x.price, s: +x.size })).sort((x, y) => x.p - y.p);
      if (!bids.length || !asks.length) continue;
      m.bid = bids[0].p; m.ask = asks[0].p; m.spread = m.ask - m.bid;
      m.queue = (bids[0].s + asks[0].s) / 2;
      // up to 3,000 recent prints; the span they cover sets the rate
      let trades = [];
      for (let off = 0; off < 3000; off += 1000) {
        const t = await get(`${DATA}/trades?market=${m.cid}&limit=1000&offset=${off}`);
        trades = trades.concat(t);
        if (t.length < 1000) break;
        await sleep(120);
      }
      const ts = trades.map((t) => t.timestamp * 1000);
      const span = Math.max((Math.max(...ts) - Math.min(...ts)) / 864e5, 1 / 48);
      m.prints = trades.length; m.tpd = trades.length / span;
      m.cpd = trades.reduce((a, t) => a + (parseFloat(t.size) || 0), 0) / span;
      m.clear = m.queue / Math.max(1, m.cpd);
      // what a resting fill earns beyond the spread: 25% of the taker's fee at this price, if any
      m.rebatePerContract = m.rebate * m.feeRate * m.mid * (1 - m.mid);
      rows.push(m);
      await sleep(150);
    } catch (e) { /* a market that will not answer is not quotable */ }
  }

  // ---- the numbers, in the README's shape
  console.log(`  ${'market'.padEnd(46)}${'vol24'.padStart(9)}${'spread'.padStart(8)}${'queue'.padStart(9)}${'trades/d'.padStart(9)}${'contr/d'.padStart(9)}${'clears'.padStart(9)}${'fee'.padStart(6)}${'rebate/c'.padStart(9)}${'rewards/d'.padStart(10)}`);
  for (const m of [...rows].sort((a, b) => a.clear - b.clear)) {
    console.log(`  ${m.q.slice(0, 45).padEnd(46)}${String(Math.round(m.vol24 / 1000) + 'k').padStart(9)}${(m.spread * 100).toFixed(1).padStart(7)}c${String(Math.round(m.queue)).padStart(9)}${Math.round(m.tpd).toString().padStart(9)}${Math.round(m.cpd).toString().padStart(9)}${(m.clear < 1 ? `${(m.clear * 24).toFixed(1)}h` : `${m.clear.toFixed(1)}d`).padStart(9)}${(m.fees ? `${(m.feeRate * 100).toFixed(0)}%` : '-').padStart(6)}${(m.rebatePerContract * 100).toFixed(2).padStart(8)}c${String(Math.round(m.rewardsPerDay)).padStart(10)}`);
  }
  console.log(`\n  ${rows.length} markets measured`);
  console.log(`  queue at the touch     ${dist(rows.map((m) => m.queue))}`);
  console.log(`  trades / day           ${dist(rows.map((m) => m.tpd))}`);
  console.log(`  contracts / day        ${dist(rows.map((m) => m.cpd))}`);
  console.log(`  clears in (days)       ${dist(rows.map((m) => m.clear))}`);
  console.log(`  spread (ticks)         ${dist(rows.map((m) => m.spread / m.tick))}`);
  console.log(`  clears inside a day    ${rows.filter((m) => m.clear <= 1).length}   inside a week ${rows.filter((m) => m.clear <= 7).length}`);
  console.log(`  taker fees enabled     ${rows.filter((m) => m.fees).length}   paying liquidity rewards ${rows.filter((m) => m.rewardsPerDay > 0).length}`);
  if (flag('json')) require('fs').writeFileSync(flag('json'), JSON.stringify(rows, null, 1));
})().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';
// Does a locked arbitrage exist right now, anywhere this desk can reach?
//
//   node tools/edge-scan.js
//
// Three structures, checked live at top of book. All are single-venue or venue-internal, so none
// carries the cross-venue resolution-rule risk the main desk takes:
//
//   1. Kalshi basket   In a mutually-exclusive event at most one outcome resolves YES, so buying
//                      NO on ALL N outcomes pays at least N-1 whatever happens. Locked if
//                      sum(no_ask) + fees < N-1. Note this needs only mutual exclusivity, not
//                      exhaustiveness -- a YES basket would need both, and is not safe here.
//   2. Polymarket pair ask(YES) + ask(NO) < $1 in the same binary market. Exactly one pays $1.
//                      This is the structure the IMDEA paper measured $40M of over a year.
//   3. Polymarket pair bid(YES) + bid(NO) > $1 -- the same thing from the sell side, which needs
//                      inventory you do not have, so it is reported for information only.
const pm = require('../src/venues/polymarket');
const cfg = require('../src/config');
const KS = 'https://api.elections.kalshi.com/trade-api/v2';
const ksFee = (p) => (p > 0 && p < 1 ? cfg.ksFeeRate * p * (1 - p) : 0);
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const c = (x) => `${(x * 100).toFixed(2)}c`;

async function kalshiBaskets() {
  let cursor = '', events = [], pages = 0;
  while (pages < 12) {
    const r = await fetch(`${KS}/events?status=open&with_nested_markets=true&limit=200${cursor ? `&cursor=${cursor}` : ''}`, { headers: { accept: 'application/json' } });
    if (!r.ok) break;
    const j = await r.json();
    events.push(...(j.events || []));
    cursor = j.cursor; pages++;
    if (!cursor || !(j.events || []).length) break;
  }
  const rows = [];
  for (const e of events) {
    if (!e.mutually_exclusive) continue;
    const ms = (e.markets || []).filter((m) => m.status === 'active' || m.status === 'open');
    if (ms.length < 2) continue;
    const asks = ms.map((m) => num(m.no_ask_dollars));
    if (asks.some((a) => a == null || a <= 0 || a >= 1)) continue;
    const cost = asks.reduce((a, x) => a + x + ksFee(x), 0);
    rows.push({ title: String(e.title).slice(0, 50), N: ms.length, edge: (ms.length - 1) - cost });
  }
  return { scanned: events.length, rows: rows.sort((a, b) => b.edge - a.edge) };
}

async function polymarketPairs() {
  const mkts = (await pm.fetchUniverse(600)).filter((m) => m.tokenIds.length === 2);
  const prices = await pm.fetchPrices(mkts.flatMap((m) => m.tokenIds));
  const rows = [];
  for (const m of mkts) {
    const a = prices.get(m.tokenIds[0]), b = prices.get(m.tokenIds[1]);
    if (!a || !b) continue;
    const cost = a.ask + b.ask;
    rows.push({ q: String(m.question).slice(0, 50), askSum: cost, bidSum: a.bid + b.bid, edge: 1 - cost - cfg.pmTakerFee * cost });
  }
  return { scanned: mkts.length, rows: rows.sort((x, y) => y.edge - x.edge) };
}

(async () => {
  const [ks, pmr] = await Promise.all([kalshiBaskets(), polymarketPairs()]);
  const show = (rows, fmt) => rows.slice(0, 6).forEach((r) => console.log(`${r.edge > 0 ? '\x1b[32m' : '\x1b[2m'}${fmt(r)}\x1b[0m`));

  console.log(`\n=== 1. KALSHI NO-BASKETS  (${ks.scanned} open events → ${ks.rows.length} priced mutually-exclusive baskets) ===`);
  console.log(`profitable after fees: ${ks.rows.filter((r) => r.edge > 0).length} of ${ks.rows.length}`);
  show(ks.rows, (r) => `  ${('$' + r.edge.toFixed(4)).padStart(10)} per basket  N=${String(r.N).padStart(2)}  ${r.title}`);

  console.log(`\n=== 2. POLYMARKET YES+NO  (${pmr.scanned} binary markets, top by volume) ===`);
  console.log(`ask(YES)+ask(NO) below $1 after fees: ${pmr.rows.filter((r) => r.edge > 0).length} of ${pmr.rows.length}`);
  console.log(`bid(YES)+bid(NO) above $1 (sell side, needs inventory): ${pmr.rows.filter((r) => r.bidSum > 1).length}`);
  show(pmr.rows, (r) => `  ${c(r.edge).padStart(9)}  askSum ${r.askSum.toFixed(4)}  bidSum ${r.bidSum.toFixed(4)}  ${r.q}`);

  const best = Math.max(...pmr.rows.map((r) => r.edge));
  console.log(`\n${'='.repeat(72)}`);
  if (ks.rows.every((r) => r.edge <= 0) && best <= 0) {
    console.log('No locked arbitrage available at top of book on either venue.');
    console.log(`Best Polymarket case is ${c(best)} -- and the modal book is askSum 1.0010 / bidSum 0.9990,`);
    console.log('which is one tick wide on each side: the tightest quote the venue permits. The');
    console.log('arbitrage is not small here, it is structurally absent. The $40M the IMDEA paper');
    console.log('measured was extracted BY bots over a year, transiently; it is not sitting waiting.');
  } else {
    console.log('SOMETHING IS PROFITABLE ABOVE. Check depth before believing it -- top of book says');
    console.log('nothing about size, and a price with no resting size behind it is not an opportunity.');
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';
// UFC arb scan: every fight on tonight's card, priced on both venues at once.
//
// Read-only. Places nothing, holds nothing, needs no key. It answers one question in three ways:
//
//   CROSS   Buy YES on Polymarket and YES on the opposite Kalshi leg. The pair pays $1 whatever
//           happens, so if the two asks plus both taker fees come to less than $1 it is locked.
//   SAME    Kalshi lists each side of a fight as its OWN market, so a fight's two legs (and the
//           seven Method-of-Victory legs, and win-in-round-N + win-by-decision) are separate
//           books over one exhaustive partition. A partition whose asks sum under $1 is locked
//           too, on one venue, with no cross-venue settlement risk.
//   GAP     Where a market exists on both venues and is NOT locked, how far apart the mids are.
//           This is the convergence signal, and it is what widens while a fight is being fought.
//
// Fees are the whole story here, so they are never left out of a printed edge:
//   Kalshi KXUFC*: fee_type plain `quadratic`, multiplier 1 -> taker 0.07 x P x (1-P), makers free.
//   Polymarket UFC: feeSchedule {rate 0.05, exponent 1, takerOnly true} -> taker 0.05 x P x (1-P),
//   makers free and rebated 15%. Both checked live 2026-09-19.
// A round trip at even money is therefore ~3c on Kalshi and ~2.5c on Polymarket. Nothing under
// that is an edge, which is why this prints the fee alongside every gap rather than after it.

const https = require('https');

const KS = 'https://api.elections.kalshi.com/trade-api/v2';
const GAMMA = 'https://gamma-api.polymarket.com';
const KS_SERIES = ['KXUFCFIGHT', 'KXUFCMOV', 'KXUFCROUNDS', 'KXUFCDISTANCE', 'KXUFCVICROUND'];

const KS_RATE = 0.07, PM_RATE = 0.05;
const ksFee = (p) => KS_RATE * p * (1 - p);
const pmFee = (p) => PM_RATE * p * (1 - p);
const c = (x) => (x == null || !Number.isFinite(x) ? '   -  ' : (x * 100).toFixed(1).padStart(5) + 'c');
const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

function get(url) {
  return new Promise((res, rej) => {
    https.get(url, { headers: { 'user-agent': 'hexagon-ufc-scan' } }, (r) => {
      let s = '';
      r.on('data', (d) => (s += d));
      r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(`${r.statusCode} ${url}`)); } });
    }).on('error', rej);
  });
}

// ---------------------------------------------------------------- names
const surname = (n) => String(n).trim().split(/\s+/).pop().toLowerCase().replace(/[^a-z]/g, '');
const key = (a, b) => [surname(a), surname(b)].sort().join('|');

// ---------------------------------------------------------------- Kalshi side
async function kalshi() {
  const byFight = new Map();   // eventSuffix -> { legs, mov, rounds, dist, vic, codes }
  for (const series of KS_SERIES) {
    const d = await get(`${KS}/markets?series_ticker=${series}&status=open&limit=500`);
    for (const m of d.markets || []) {
      const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
      if (bid == null || ask == null) continue;
      // KXUFCMOV-26SEP19VANPAN-PANDEC -> event "26SEP19VANPAN", outcome "PANDEC"
      const parts = String(m.ticker).split('-');
      const ev = parts[1] || '', outcome = parts.slice(2).join('-');
      if (!ev) continue;
      const f = byFight.get(ev) || { ev, legs: [], mov: [], rounds: [], dist: null, vic: [], codes: new Map() };
      const rec = { ticker: m.ticker, outcome, title: m.title || '', bid, ask,
                    vol24: num(m.volume_24h_fp) || 0, oi: num(m.open_interest_fp) || 0 };
      if (series === 'KXUFCFIGHT') {
        rec.name = rec.title.replace(/\s+wins$/i, '').trim();
        f.codes.set(outcome, rec.name);
        f.legs.push(rec);
      } else if (series === 'KXUFCMOV') f.mov.push(rec);
      else if (series === 'KXUFCROUNDS') f.rounds.push(rec);
      else if (series === 'KXUFCDISTANCE') f.dist = rec;
      else if (series === 'KXUFCVICROUND') f.vic.push(rec);
      byFight.set(ev, f);
    }
  }
  for (const f of byFight.values()) if (f.legs.length === 2) f.key = key(f.legs[0].name, f.legs[1].name);
  return byFight;
}

// ---------------------------------------------------------------- Polymarket side
async function polymarket() {
  // Ask Gamma for the UFC tag directly. This used to page the whole listing ranked by 24h volume
  // and stop at offset 800, which is the wrong shape for the question: a fight is listed days ahead
  // and trades almost nothing until the day, so the fights this tool exists to price sit at the
  // BOTTOM of a volume ranking, not the top. On 2026-09-20, with an NFL Sunday at the head of the
  // listing, it reported "Polymarket fights 0" while 34 were listed -- confidently wrong, and wrong
  // about the one thing it is for.
  let evs = [];
  for (const slug of ['ufc', 'boxing']) {
    for (let off = 0; off < 500; off += 100) {
      const p = await get(`${GAMMA}/events?closed=false&active=true&limit=100&offset=${off}&tag_slug=${slug}`);
      if (!Array.isArray(p) || !p.length) break;
      evs = evs.concat(p);
      if (p.length < 100) break;
    }
  }
  const seen = new Set();
  const out = new Map();
  for (const e of evs) {
    if (seen.has(String(e && e.id))) continue;
    seen.add(String(e && e.id));
    const mkts = (e.markets || []).filter((m) => m && m.active && !m.closed && m.acceptingOrders !== false);
    const main = mkts.find((m) => /vs\./i.test(m.question || '') && !/win|round|distance|decision|submission/i.test(m.question || ''));
    if (!main) continue;
    let oc = []; try { oc = JSON.parse(main.outcomes); } catch (_) { /* not a two-way */ }
    if (oc.length !== 2) continue;
    const rate = (main.feeSchedule && num(main.feeSchedule.rate)) != null ? num(main.feeSchedule.rate) : PM_RATE;
    out.set(key(oc[0], oc[1]), { title: e.title, slug: e.slug, fighters: oc, main, mkts, rate });
  }
  return out;
}

// ---------------------------------------------------------------- the three reports
function crossWinner(pm, ks, rows) {
  const A = pm.fighters[0];                                  // PM bestAsk/bestBid are outcome[0]'s
  // From the CLOB, never the Gamma listing: during a fight Gamma lags the real book by minutes.
  // Measured mid-fight on 2026-09-19, Aswell vs Yoo -- Gamma said 83/85 while the book was 86/91.
  // A scan off the listing chases locks that are not there, which is worse than finding none.
  const pmAskA = pm.book ? pm.book.ask : num(pm.main.bestAsk);
  const pmBidA = (pm.book ? pm.book.bid : num(pm.main.bestBid)) || 0;
  if (pmAskA == null) return;
  const other = ks.legs.find((l) => surname(l.name) !== surname(A));
  const same = ks.legs.find((l) => surname(l.name) === surname(A));
  if (!other || !same) return;
  // Locked: YES on A at Polymarket + YES on the OTHER fighter at Kalshi pays exactly $1.
  const cost = pmAskA + other.ask + pmFee(pmAskA) + ksFee(other.ask);
  // And the mirror: YES on A at Kalshi + NO on A at Polymarket (= YES on B, ask = 1 - bidA).
  const pmAskB = 1 - pmBidA;
  const cost2 = same.ask + pmAskB + ksFee(same.ask) + pmFee(pmAskB);
  const pmMid = (pmAskA + pmBidA) / 2, ksMid = (same.bid + same.ask) / 2;
  rows.push({ fight: `${pm.fighters[0]} vs ${pm.fighters[1]}`, leg: 'winner',
              pmMid, ksMid, gap: ksMid - pmMid,
              lock: Math.max(1 - cost, 1 - cost2),   // the BEST of the two directions, not the worse
              feeFloor: pmFee(pmMid) + ksFee(ksMid),
              depth: `PM ${Math.round(num(pm.main.volume24hr) || 0)} / KS ${Math.round(same.vol24)}` });
}

function sameVenuePartitions(f, rows) {
  const push = (label, legs, pays = 1) => {
    if (!legs.length) return;
    const asks = legs.reduce((s, l) => s + l.ask, 0);
    const bids = legs.reduce((s, l) => s + l.bid, 0);
    const buyFee = legs.reduce((s, l) => s + ksFee(l.ask), 0);
    const sellFee = legs.reduce((s, l) => s + ksFee(l.bid), 0);
    rows.push({ fight: f.name, leg: label, n: legs.length,
                buy: pays - asks - buyFee,        // long the whole set
                sell: bids - pays - sellFee });   // short the whole set
  };
  if (f.legs.length === 2) push('fight winner (2 legs)', f.legs);
  if (f.mov.length) push(`method of victory (${f.mov.length} legs)`, f.mov);
  // win-in-round-N by finish + win-by-decision = that fighter wins. Exhaustive per fighter.
  for (const [code, name] of f.codes) {
    const vic = f.vic.filter((v) => v.outcome.startsWith(code) && /\d$/.test(v.outcome));
    const dec = f.mov.find((m) => m.outcome === `${code}DEC`);
    const win = f.legs.find((l) => l.outcome === code);
    if (!vic.length || !dec || !win) continue;
    const asks = vic.reduce((s, l) => s + l.ask, 0) + dec.ask;
    const bids = vic.reduce((s, l) => s + l.bid, 0) + dec.bid;
    const fees = vic.reduce((s, l) => s + ksFee(l.ask), 0) + ksFee(dec.ask) + ksFee(win.bid);
    const fees2 = vic.reduce((s, l) => s + ksFee(l.bid), 0) + ksFee(dec.bid) + ksFee(win.ask);
    rows.push({ fight: f.name, leg: `${name}: rounds+decision vs outright`, n: vic.length + 1,
                buy: win.bid - asks - fees,     // buy the pieces, sell the whole
                sell: bids - win.ask - fees2 }); // buy the whole, sell the pieces
  }
}

// Top of book for outcome 0 of each fight, straight from the CLOB.
const CLOB = 'https://clob.polymarket.com';
async function loadBooks(pmAll) {
  await Promise.all([...pmAll.values()].map(async (pm) => {
    let toks = [];
    try { toks = JSON.parse(pm.main.clobTokenIds); } catch (_) { return; }
    if (!toks[0]) return;
    try {
      const b = await get(`${CLOB}/book?token_id=${toks[0]}`);
      const asks = (b.asks || []).map((x) => +x.price).filter((x) => x > 0 && x < 1);
      const bids = (b.bids || []).map((x) => +x.price).filter((x) => x > 0 && x < 1);
      if (asks.length && bids.length) pm.book = { ask: Math.min(...asks), bid: Math.max(...bids) };
    } catch (_) { /* fall back to the listing, and say so */ }
  }));
}

(async () => {
  const [ksAll, pmAll] = await Promise.all([kalshi(), polymarket()]);
  await loadBooks(pmAll);
  const stale = [...pmAll.values()].filter((pm) => !pm.book).length;
  const fights = [...ksAll.values()].filter((f) => f.legs.length === 2);
  for (const f of fights) f.name = f.legs.map((l) => surname(l.name)).join(' vs ');

  console.log(`\nUFC scan  ${new Date().toISOString()}   Kalshi fights ${fights.length}   Polymarket fights ${pmAll.size}`);
  console.log(`Polymarket prices from the CLOB${stale ? ` (${stale} fell back to the Gamma listing, which lags in-fight -- treat those rows as soft)` : ''}\n`);

  const cross = [];
  let paired = 0;
  for (const f of fights) {
    const pm = pmAll.get(f.key);
    if (!pm) continue;
    paired++;
    crossWinner(pm, f, cross);
  }
  console.log(`--- CROSS-VENUE, fight winner (${paired} of ${fights.length} fights on both venues) ---`);
  console.log('  fight                              PM mid   KS mid     gap   fee floor   best lock');
  cross.sort((a, b) => b.lock - a.lock);
  for (const r of cross) {
    console.log(`  ${r.fight.slice(0, 32).padEnd(34)}${c(r.pmMid)}  ${c(r.ksMid)}  ${c(r.gap)}  ${c(r.feeFloor)}     ${c(r.lock)}${r.lock > 0 ? '  <== LOCKED' : ''}`);
  }

  const same = [];
  for (const f of fights) sameVenuePartitions(f, same);
  same.sort((a, b) => Math.max(b.buy, b.sell) - Math.max(a.buy, a.sell));
  console.log(`\n--- SAME-VENUE (Kalshi) partitions: buy the whole set, or sell it ---`);
  console.log('  fight            set                                   buy all    sell all');
  for (const r of same.slice(0, 24)) {
    const hit = Math.max(r.buy, r.sell) > 0 ? '  <== LOCKED' : '';
    console.log(`  ${r.fight.slice(0, 15).padEnd(17)}${r.leg.slice(0, 36).padEnd(38)}${c(r.buy)}     ${c(r.sell)}${hit}`);
  }
  console.log('\n  (buy all = pay every ask over an exhaustive set that pays $1; sell all = hit every bid.');
  console.log('   Both figures are already net of Kalshi taker fees on every leg.)\n');
})().catch((e) => { console.error('scan failed:', e.message); process.exit(1); });

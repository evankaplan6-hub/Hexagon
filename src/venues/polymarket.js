'use strict';
// Polymarket: Gamma API for market listings/resolution, CLOB API for order books. Public, no auth.
const http = require('../http');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const arr = (s) => { try { return Array.isArray(s) ? s : JSON.parse(s || '[]'); } catch { return []; } };

// ---------------------------------------------------------------- taker fees
// Polymarket charges takers, and this desk modelled it as zero for its whole life. Measured on
// 2026-09-15 across the open universe and confirmed against docs.polymarket.com/trading/fees:
//
//     fee = shares x feeRate x p x (1 - p)          (USDC, rounded to 5 decimals; makers pay nothing)
//
// The rate is per category -- crypto 0.07, sports games 0.05 (futures 0.03), economics, culture and
// weather 0.05, politics, finance, mentions and tech 0.04 -- and geopolitics is `feesEnabled: false`.
// The Fed pair this desk already traded (market 2252244) is `economics_fees` at 0.05: 1.25c a share
// at 50c, charged on the way in and again on the way out. Every Gamma market row carries its own
// `feeSchedule`, so the rate is read per market rather than assumed per category.
//
// The schedule also has an `exponent`. At 1 it is the formula above. p(1-p) is at most 0.25, so a
// higher exponent can only make the real fee SMALLER; pricing it as exponent 1 is the conservative
// upper bound, and that is what this does.
//
// Returns the rate, or null when the market does not say (the caller applies cfg.pmFeeFallback,
// which defaults to the highest category rate so that "unknown" never under-charges).
function feeRateOf(m) {
  if (m.feesEnabled === false) return 0;
  const rate = num(m.feeSchedule && m.feeSchedule.rate);
  return rate != null && rate >= 0 ? rate : null;
}
// Per share, for signal math. Symmetric around 50c, zero at the tails.
function feePerShare(price, rate) {
  if (!(price > 0 && price < 1) || !(rate > 0)) return 0;
  return rate * price * (1 - price);
}
// For an order: what the venue would actually charge, at its own 5-decimal rounding.
function fee(qty, price, rate) {
  if (!(qty > 0)) return 0;
  return Math.round(qty * feePerShare(price, rate) * 1e5) / 1e5;
}

function normalize(m) {
  const outcomes = arr(m.outcomes);
  const tokenIds = arr(m.clobTokenIds);
  if (outcomes.length < 2 || tokenIds.length < 2) return null;
  const ev = (m.events && m.events[0]) || {};
  return {
    venue: 'PM',
    id: String(m.id),
    conditionId: m.conditionId || null,   // what the public trade feed keys on (src/whales.js)
    question: m.question,
    slug: m.slug,
    outcomes,
    tokenIds,
    prices: arr(m.outcomePrices).map(num),
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    spread: num(m.spread),
    last: num(m.lastTradePrice),
    vol24: num(m.volume24hr) || 0,
    liquidity: num(m.liquidityNum ?? m.liquidity) || 0,
    endDate: m.endDate || null,
    gameStart: m.gameStartTime || null,
    sport: m.sportsMarketType || null,
    feeRate: feeRateOf(m),               // null = the market does not say; see feeRateOf
    feeType: m.feeType || null,
    eventTitle: ev.title || m.question,
    closed: !!m.closed,
    accepting: m.acceptingOrders !== false,
    resolved: m.umaResolutionStatus === 'resolved',
    url: `https://polymarket.com/event/${ev.slug || m.slug}`,
  };
}

// Top-N open markets by 24h volume, paginated 100 at a time.
async function fetchUniverse(limit = 300) {
  const reqs = [];
  for (let off = 0; off < limit; off += 100) {
    reqs.push(http.getJSON(`${GAMMA}/markets?closed=false&active=true&limit=100&offset=${off}&order=volume24hr&ascending=false`));
  }
  const pages = await Promise.all(reqs);
  const out = [];
  for (const page of pages) {
    if (!Array.isArray(page)) continue;
    for (const raw of page) {
      const m = normalize(raw);
      if (m && m.accepting && !m.closed && m.bestBid != null && m.bestAsk != null && m.bestAsk > m.bestBid) out.push(m);
    }
  }
  return out;
}

async function fetchMarket(id) {
  const raw = await http.getJSON(`${GAMMA}/markets/${id}`);
  const m = normalize(raw);
  return m && { ...m, closed: !!raw.closed, resolved: raw.umaResolutionStatus === 'resolved' };
}

// Order book for one outcome token. Returns bids (best first) and asks (best first).
async function fetchBook(tokenId) {
  const b = await http.getJSON(`${CLOB}/book?token_id=${tokenId}`);
  const lv = (a) => (a || []).map((x) => ({ price: +x.price, size: +x.size })).filter((x) => x.size > 0 && x.price > 0 && x.price < 1);
  return {
    bids: lv(b.bids).sort((x, y) => y.price - x.price),
    asks: lv(b.asks).sort((x, y) => x.price - y.price),
  };
}

// Live top-of-book for many tokens in one call. Returns Map(tokenId -> {bid, ask}).
// The CLOB reports "BUY" as the best resting bid and "SELL" as the best resting ask.
async function fetchPrices(tokenIds) {
  const out = new Map();
  for (let i = 0; i < tokenIds.length; i += 100) {
    const chunk = tokenIds.slice(i, i + 100);
    const body = chunk.flatMap((t) => [{ token_id: t, side: 'BUY' }, { token_id: t, side: 'SELL' }]);
    const ctl = new AbortController();
    const held = { abort: () => ctl.abort(), what: `${CLOB}/prices` };
    try {
      // the deadline is kept whether or not fetch honours the abort (src/http.js deadline)
      const r = await http.deadline(fetch(`${CLOB}/prices`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }), 15000, held);
      if (!r.ok) throw new Error(`HTTP ${r.status} ${CLOB}/prices`);
      const j = await http.deadline(r.json(), 15000, held);
      http.stats.ok++;
      for (const [tok, v] of Object.entries(j || {})) {
        const bid = num(v.BUY), ask = num(v.SELL);
        if (bid != null && ask != null && ask > bid) out.set(tok, { bid, ask });
      }
    } catch (e) { http.noteError(e); throw e; }
  }
  return out;
}

// ---------------------------------------------------------------- the public trade feed
// Every Polymarket fill is on-chain, and the data API serves it per wallet with no key. This is
// all a "whale tracker" is: the sports leaderboard, and what the wallets on it just bought.
const DATA = 'https://data-api.polymarket.com';

// One leaderboard page. category SPORTS|OVERALL|..., period DAY|WEEK|MONTH|ALL, orderBy PNL|VOL.
// The API serves at most 50 rows a call.
async function fetchLeaderboard({ category = 'SPORTS', period = 'MONTH', orderBy = 'PNL', limit = 50, offset = 0 } = {}) {
  const rows = await http.getJSON(`${DATA}/v1/leaderboard?category=${category}&timePeriod=${period}&orderBy=${orderBy}&limit=${Math.min(50, limit)}&offset=${offset}`);
  return (Array.isArray(rows) ? rows : []).map((r) => ({
    wallet: String(r.proxyWallet || '').toLowerCase(), name: r.userName || '', rank: +r.rank || null,
    pnl: num(r.pnl) || 0, vol: num(r.vol) || 0,
  })).filter((r) => r.wallet);
}

// One page of a wallet's fills, newest first (`start`/`end` are unix seconds), with what the feed
// actually sent: `rows` and the oldest row's `oldestTs`. A pager has to decide on those, not on the
// fills. normalizeFill drops a row the feed has not indexed yet, and those sit on the newest page of
// exactly the busiest wallets, so a full page of 500 comes back as 497 fills; reading that as the
// last page stored Flaznorp's newest fourteen minutes as its whole history, marked complete.
async function fetchActivityPage(wallet, { limit = 100, offset = 0, start, end } = {}) {
  let url = `${DATA}/activity?user=${wallet}&type=TRADE&limit=${limit}&offset=${offset}`;
  if (start) url += `&start=${start}`;
  if (end) url += `&end=${end}`;
  const got = await http.getJSON(url);
  const rows = Array.isArray(got) ? got : [];
  const ts = rows.map((r) => (r ? +r.timestamp : NaN)).filter(Number.isFinite);
  return { fills: rows.map(normalizeFill).filter(Boolean), rows: rows.length, oldestTs: ts.length ? Math.min(...ts) : null };
}

async function fetchActivity(wallet, opts) {
  return (await fetchActivityPage(wallet, opts)).fills;
}

// Which outcome a fill bought, or null when the feed does not know yet. Every Polymarket market is
// a two-outcome condition (a many-way event is split into one Yes/No market per runner), so the
// index is 0 or 1: 671,512 of the lab's 671,513 cached fills say so. The odd one said 999, a second
// before the fetch ended, and the live feed does the same with a fill it has only just indexed:
// /activity first serves it with outcomeIndex 999 and an empty eventSlug, and by the next read of
// that wallet (~75s) the same transactionHash with the real index. `+x` alone would also turn a
// missing index (null, "") into outcome 0, a real side.
function outcomeIndex(x) {
  const i = typeof x === 'number' ? x : typeof x === 'string' && x.trim() !== '' ? Number(x) : NaN;
  return i === 0 || i === 1 ? i : null;
}

// A fill whose outcome is not known yet is dropped rather than guessed. Keeping it made a second
// bet under a key of its own (announced twice, and "bet both sides" when the wallet's real side had
// crossed the bar as well), and the lab cannot settle an outcome 999. Recovering the index from the outcome's
// name would need the market's outcome list, which the feed does not carry, and the half-indexed
// row is missing its eventSlug as well. Dropping it costs one visit: the corrected copy arrives on
// the next read of that wallet and counts then, whole.
function normalizeFill(t) {
  const price = num(t.price), size = num(t.size), oi = outcomeIndex(t.outcomeIndex);
  if (!t.conditionId || price == null || size == null || oi == null) return null;
  return {
    wallet: String(t.proxyWallet || '').toLowerCase(), name: t.name || t.pseudonym || '',
    tx: t.transactionHash || '', ts: +t.timestamp, side: t.side === 'SELL' ? 'SELL' : 'BUY',
    conditionId: t.conditionId, outcomeIndex: oi, outcome: t.outcome || '',
    price, size, usd: num(t.usdcSize) ?? price * size,
    title: t.title || '', slug: t.slug || '', eventSlug: t.eventSlug || '',
  };
}

// Everything a fill row can be told apart by -- NOT a unique id. The feed serves one row per matched
// order, so one tx can hold rows that differ only in size (a sweep through 34c and 35c) or only in
// price, and rows identical in every field: VeryLucky888's tx 0x707acca1e1f7… is three rows of 5,000
// shares at 48c, and /trades and /positions (15,000 shares, $7,200) agree those are three real fills.
// 12 top-volume wallets had 7 such repeats in their newest 500 fills on 2026-09-14. So a key seen
// twice in one read is two fills; only a key served again by an overlapping page is a re-read, and
// tools/whale-fetch.js counts it per page rather than once. Price is in the key because the key
// whale-fetch used before, without it, merged 8 of the latest 500 rows of one busy wallet
// (ferrariChampions2026, 2026-09-14: $2,069 of fills).
const fillKey = (f) => `${f.wallet}|${f.tx}|${f.ts}|${f.conditionId}|${f.outcomeIndex}|${f.side}|${f.size}|${f.price}`;

// Markets by condition id, open or settled. Settled ones carry outcomePrices of "1"/"0".
async function fetchByConditions(ids) {
  const out = [];
  for (let i = 0; i < ids.length; i += 20) {
    const q = ids.slice(i, i + 20).map((id) => `condition_ids=${id}`).join('&');
    for (const closed of ['true', 'false']) {
      const page = await http.getJSON(`${GAMMA}/markets?${q}&closed=${closed}&limit=100`);
      for (const raw of Array.isArray(page) ? page : []) {
        const m = normalize(raw);
        if (m) out.push({ ...m, resolved: raw.umaResolutionStatus === 'resolved' });
      }
    }
  }
  return out;
}

module.exports = { fetchUniverse, fetchMarket, fetchBook, fetchPrices, fetchLeaderboard, fetchActivity, fetchActivityPage, fetchByConditions, normalizeFill, outcomeIndex, fillKey, normalize, feeRateOf, feePerShare, fee };

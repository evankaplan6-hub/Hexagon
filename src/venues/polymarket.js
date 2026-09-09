'use strict';
// Polymarket: Gamma API for market listings/resolution, CLOB API for order books. Public, no auth.
const http = require('../http');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const arr = (s) => { try { return Array.isArray(s) ? s : JSON.parse(s || '[]'); } catch { return []; } };

function normalize(m) {
  const outcomes = arr(m.outcomes);
  const tokenIds = arr(m.clobTokenIds);
  if (outcomes.length < 2 || tokenIds.length < 2) return null;
  const ev = (m.events && m.events[0]) || {};
  return {
    venue: 'PM',
    id: String(m.id),
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
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const r = await fetch(`${CLOB}/prices`, { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(body), signal: ctl.signal });
      if (!r.ok) throw new Error(`HTTP ${r.status} ${CLOB}/prices`);
      const j = await r.json();
      http.stats.ok++;
      for (const [tok, v] of Object.entries(j || {})) {
        const bid = num(v.BUY), ask = num(v.SELL);
        if (bid != null && ask != null && ask > bid) out.set(tok, { bid, ask });
      }
    } catch (e) { http.noteError(e); throw e; }
    finally { clearTimeout(timer); }
  }
  return out;
}

module.exports = { fetchUniverse, fetchMarket, fetchBook, fetchPrices };

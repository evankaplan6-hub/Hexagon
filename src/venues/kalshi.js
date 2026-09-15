'use strict';
// Kalshi public market data (no auth). Live order placement lives in broker.js.
const http = require('../http');
const BASE = 'https://api.elections.kalshi.com/trade-api/v2';

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const r3 = (x) => Math.round(x * 1000) / 1000;

function normalize(m) {
  return {
    venue: 'KS',
    ticker: m.ticker,
    eventTicker: m.event_ticker,
    title: m.title,
    subTitle: m.yes_sub_title || String(m.title || '').replace(/ wins$/, ''),
    yesBid: num(m.yes_bid_dollars),
    yesAsk: num(m.yes_ask_dollars),
    last: num(m.last_price_dollars),
    vol24: num(m.volume_24h_fp) || 0,
    oi: num(m.open_interest_fp) || 0,
    closeTime: m.close_time || null,
    // When the answer is expected, which is not the close: a scheduled print closes minutes before
    // it (the Fed at 17:59Z, expected 18:05Z), and a can-close-early market's close_time is a
    // backstop months out (SENATEIA-26 closes 2027-11-03, expected 2027-01-04).
    expectedExpiration: m.expected_expiration_time || null,
    latestExpiration: m.latest_expiration_time || null,
    canCloseEarly: !!m.can_close_early,
    status: m.status,
    result: m.result || '',
    settlementValue: num(m.settlement_value_dollars),
    marketType: m.market_type || null,
    url: `https://kalshi.com/markets/${String(m.ticker || '').split('-')[0].toLowerCase()}`,
  };
}

// Follows the cursor. One page used to be the whole answer, and ten open series are bigger than a
// page (KXNCAAFSPREAD had 1,828 open markets on 2026-09-14): the rest of such a series was simply
// never seen, and a held position in it looked like a market that had left the listing.
const SERIES_PAGES = 10;
async function fetchSeries(series) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < SERIES_PAGES; page++) {
    const d = await http.getJSON(`${BASE}/markets?series_ticker=${series}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const m of d.markets || []) out.push(m);
    cursor = d.cursor || '';
    if (!cursor || !(d.markets || []).length) break;
  }
  return out.map(normalize).filter((m) => m.yesBid != null && m.yesAsk != null && m.yesAsk >= m.yesBid);
}

// All configured series in parallel; tolerates partial failure.
async function fetchAll(seriesList) {
  const res = await Promise.allSettled(seriesList.map(fetchSeries));
  const out = [];
  let failed = 0;
  for (const r of res) (r.status === 'fulfilled' ? out.push(...r.value) : failed++);
  if (failed === seriesList.length) throw new Error('all Kalshi series requests failed');
  return out;
}

// Many markets by ticker in one call per chunk. `GET /markets?tickers=A,B,...` answered 200 tickers
// in 111ms on 2026-09-14 and refused 500 (HTTP 414, the URL is too long), so chunks of 100. This is
// how the any-market pairs are repriced every cycle without listing whole series. Returns the
// normalized markets that came back, every status included -- the caller decides what a closed or
// decided market means for it.
async function fetchMarketsByTickers(tickers, { chunk = 200 } = {}) {
  const out = [];
  for (let i = 0; i < tickers.length; i += chunk) {
    const part = tickers.slice(i, i + chunk);
    const d = await http.getJSON(`${BASE}/markets?tickers=${part.map(encodeURIComponent).join(',')}&limit=${part.length}`);
    for (const m of d.markets || []) out.push(normalize(m));
  }
  return out;
}

async function fetchMarket(ticker) {
  const d = await http.getJSON(`${BASE}/markets/${ticker}`);
  return d.market ? normalize(d.market) : null;
}

// Kalshi books list resting YES bids and resting NO bids. A YES taker buys from NO bids at 1 - p.
async function fetchBook(ticker) {
  const d = await http.getJSON(`${BASE}/markets/${ticker}/orderbook?depth=20`);
  const ob = d.orderbook_fp || d.orderbook || {};
  const lv = (a, scale) => (a || []).map(([p, s]) => ({ price: +p * scale, size: +s })).filter((x) => x.size > 0);
  const yes = lv(ob.yes_dollars, 1), no = lv(ob.no_dollars, 1);
  const asc = (a, b) => a.price - b.price, desc = (a, b) => b.price - a.price;
  return {
    yesBids: yes.slice().sort(desc),
    yesAsks: no.map((l) => ({ price: r3(1 - l.price), size: l.size })).sort(asc),
    noBids: no.slice().sort(desc),
    noAsks: yes.map((l) => ({ price: r3(1 - l.price), size: l.size })).sort(asc),
  };
}

// Per-series taker fee multiplier. Kalshi's published taker fee is
//   ceil(0.07 * multiplier * contracts * P * (1 - P))
// and `multiplier` is NOT 1 everywhere: MLB game markets carry 0.5 (half price), and fourteen
// series -- mostly Politics, Elections and Crypto -- carry 0, i.e. no taker fee at all. Charging
// a flat 0.07 everywhere overstated MLB's round trip by roughly 1.6c per contract, which made the
// desk decline MLB trades that were cheaper than it believed. Fetched once per series and cached;
// an unknown series falls back to 1, the conservative direction.
const feeMult = new Map();
// A failed lookup is NOT cached. It used to store 1 on any error, so one refused call at startup
// billed that series at full rate until the next restart; now the call is billed at full rate (the
// safe direction) and the next load tries again.
async function loadFeeMultipliers(seriesList) {
  for (const s of seriesList) {
    if (feeMult.has(s)) continue;
    try {
      const d = await http.getJSON(`${BASE}/series/${s}`);
      const m = d.series && d.series.fee_multiplier;
      if (m != null && Number.isFinite(+m)) feeMult.set(s, +m);
    } catch { /* not cached: see above */ }
  }
  return feeMult;
}

// Every series at once. `GET /series` with no parameters returns all of them in one response --
// 14,060 on 2026-09-14, about 17 MB, under two seconds -- each with its fee_type, fee_multiplier and
// category, so the per-series loop above is only the fallback. It ignores limit and cursor.
const seriesInfo = new Map();   // series ticker -> { feeMultiplier, feeType, category, title }
async function loadSeriesIndex({ timeout = 60000 } = {}) {
  const d = await http.getJSON(`${BASE}/series`, { timeout });
  const list = Array.isArray(d && d.series) ? d.series : [];
  if (!list.length) throw new Error('Kalshi /series came back empty');
  for (const x of list) {
    if (!x || !x.ticker) continue;
    const m = x.fee_multiplier != null && Number.isFinite(+x.fee_multiplier) ? +x.fee_multiplier : null;
    if (m != null) feeMult.set(x.ticker, m);
    seriesInfo.set(x.ticker, { feeMultiplier: m, feeType: x.fee_type || null, category: x.category || null, title: x.title || null });
  }
  return list.length;
}

// The series a ticker belongs to. Not simply the text before the first hyphen: 151 series tickers
// contain one (KXNFLWINS-ANY, SENATEPARTY-FL), so a market in KXNFLWINS-ANY was looked up as
// KXNFLWINS and billed at that series' multiplier. Longest known prefix wins; an unknown ticker falls
// back to its first segment.
function seriesFor(ref) {
  const parts = String(ref).split('-');
  for (let n = parts.length; n >= 1; n--) {
    const cand = parts.slice(0, n).join('-');
    if (feeMult.has(cand) || seriesInfo.has(cand)) return cand;
  }
  return parts[0];
}
// `ref` is a ticker or a bare series; anything unseen bills at full rate.
const multFor = (ref) => feeMult.get(seriesFor(ref)) ?? 1;

// Kalshi taker fee schedule: ceil(rate * multiplier * contracts * P * (1 - P)), in dollars.
function fee(qty, price, rate = 0.07, ref) {
  if (!(price > 0 && price < 1) || qty <= 0) return 0;
  return Math.ceil(rate * (ref === undefined ? 1 : multFor(ref)) * qty * price * (1 - price) * 100) / 100;
}

// Marginal per-contract fee, for signal math only. `fee` ceils to the cent for the whole
// ORDER, so calling it with qty=1 overstates the true marginal cost by up to a full cent
// (at P=0.5 it reports 2.00c against a real 1.75c). Use `fee` to charge an order,
// `feePerContract` to decide whether an order is worth placing.
function feePerContract(price, rate = 0.07, ref) {
  if (!(price > 0 && price < 1)) return 0;
  return rate * (ref === undefined ? 1 : multFor(ref)) * price * (1 - price);
}

module.exports = { fetchSeries, fetchAll, fetchMarket, fetchMarketsByTickers, fetchBook, fee, feePerContract, loadFeeMultipliers, loadSeriesIndex, seriesInfo, seriesFor, multFor, normalize, BASE };

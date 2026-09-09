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
    status: m.status,
    result: m.result || '',
    url: `https://kalshi.com/markets/${String(m.ticker || '').split('-')[0].toLowerCase()}`,
  };
}

async function fetchSeries(series) {
  const d = await http.getJSON(`${BASE}/markets?series_ticker=${series}&status=open&limit=1000`);
  return (d.markets || []).map(normalize).filter((m) => m.yesBid != null && m.yesAsk != null && m.yesAsk >= m.yesBid);
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
async function loadFeeMultipliers(seriesList) {
  for (const s of seriesList) {
    if (feeMult.has(s)) continue;
    try {
      const d = await http.getJSON(`${BASE}/series/${s}`);
      const m = d.series && d.series.fee_multiplier;
      feeMult.set(s, Number.isFinite(+m) ? +m : 1);
    } catch { feeMult.set(s, 1); }
  }
  return feeMult;
}
// `ref` is a ticker or a bare series; anything unseen bills at full rate.
const multFor = (ref) => feeMult.get(String(ref).split('-')[0]) ?? 1;

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

module.exports = { fetchSeries, fetchAll, fetchMarket, fetchBook, fee, feePerContract, loadFeeMultipliers, multFor, BASE };

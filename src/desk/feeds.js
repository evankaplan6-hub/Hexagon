'use strict';
// Market data for the stocks, crypto and options desk. Free, public, no key and no account.
//
//   Crypto   Coinbase Exchange's public REST API: live bid/ask, the order book, daily candles.
//   Stocks   Cboe's delayed quotes (cdn.cboe.com): SPY's quote, its one-minute bars for the day, and
//            daily bars back to 2004. About 15 minutes behind the market.
//   Options  Cboe's delayed option chain, the same feed src/venues/cboe.js records for the chain tape.
//
// READ-ONLY. Nothing here can place an order; there is no order path anywhere in src/desk/. The
// desk trades a paper ledger at these prices and nothing else.
//
// THE DELAY. A stock or option price here is the market as it was ~15 minutes ago, and the desk
// trades it as exactly that: the price it decides on is the price it fills at, so the paper result is
// honest, just 15 minutes late. Nothing reads a delayed price against a live one.
//
// The parsers are pure (a response in, rows out) so tools/desk-test.js checks them with no network.
// Every one returns null or [] for a response it does not understand, never a guess.
const { etToUtc, et } = require('./clock');
const { parseOsi } = require('../venues/cboe');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const COINBASE = 'https://api.exchange.coinbase.com';
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes';

const fin = (x) => { const v = typeof x === 'string' ? Number(x) : x; return Number.isFinite(v) ? v : null; };

// ------------------------------------------------------------------ Coinbase
function parseCoinbaseTicker(j) {
  if (!j || typeof j !== 'object') return null;
  const bid = fin(j.bid), ask = fin(j.ask), last = fin(j.price);
  if (!(bid > 0) || !(ask > 0) || ask < bid) return null;
  const at = Date.parse(j.time);
  return { bid, ask, last: last > 0 ? last : (bid + ask) / 2, at: Number.isFinite(at) ? at : null, vol24: fin(j.volume) };
}
// Level-2 book: [[price, size, orders], ...] each side, best first.
function parseCoinbaseBook(j) {
  if (!j || !Array.isArray(j.bids) || !Array.isArray(j.asks)) return null;
  const side = (rows) => rows.map((r) => ({ price: fin(r[0]), size: fin(r[1]) })).filter((l) => l.price > 0 && l.size > 0);
  return { bids: side(j.bids), asks: side(j.asks) };
}
// Daily candles, [time, low, high, open, close, volume] newest first -> oldest first, UTC days, and
// only days that have ENDED by `now`: Coinbase includes today's candle while it is still forming.
function parseCoinbaseCandles(j, now = Date.now()) {
  if (!Array.isArray(j)) return [];
  const out = [];
  for (const r of j) {
    if (!Array.isArray(r) || r.length < 6) continue;
    const t = fin(r[0]) * 1000, l = fin(r[1]), h = fin(r[2]), o = fin(r[3]), c = fin(r[4]), v = fin(r[5]);
    if (!(t > 0) || !(c > 0) || t + 86400000 > now) continue;
    out.push({ day: new Date(t).toISOString().slice(0, 10), t, o, h, l, c, v });
  }
  return out.sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ Cboe
// Cboe's `timestamp` is the file's own UTC time; `last_trade_time` and every bar time are Eastern
// wall-clock times with no offset.
function parseCboeQuote(j) {
  const d = j && j.data;
  if (!d || typeof d !== 'object') return null;
  const bid = fin(d.bid), ask = fin(d.ask), last = fin(d.current_price);
  if (!(last > 0)) return null;
  const fileAt = Date.parse(String(j.timestamp || '').replace(' ', 'T') + 'Z');
  return {
    sym: d.symbol || j.symbol || null,
    bid: bid > 0 ? bid : null, ask: ask > 0 ? ask : null, bidSz: fin(d.bid_size), askSz: fin(d.ask_size),
    // The close before the quote's session. prev_day_close turns into the session's own close some time
    // after the bell (Saturday 26 September's file: 771.35 for both, and the page said SPY moved 0.00% on
    // a day it rose 0.54%); price_change keeps the session's move, so the price less its change is that
    // close, in the session and after it. prev_day_close only when there is no change to go by.
    last, open: fin(d.open), high: fin(d.high), low: fin(d.low), volume: fin(d.volume),
    prevClose: fin(d.price_change) != null ? Math.round((last - fin(d.price_change)) * 1e4) / 1e4 : fin(d.prev_day_close),
    // the moment the price is FROM, which is what the desk's clock runs on for stocks
    at: etToUtc(d.last_trade_time),
    fileAt: Number.isFinite(fileAt) ? fileAt : null,
  };
}
// The day's one-minute bars. Cboe labels a bar by the minute it ENDS: the first bar of a session is
// 09:31 and covers 9:30 to 9:31 (tools/desk-test.js pins this). `m` is that end minute, in minutes
// since midnight Eastern; `t` is its instant.
function parseCboeIntraday(j) {
  const rows = j && Array.isArray(j.data) ? j.data : null;
  if (!rows || !rows.length) return { day: null, bars: [] };
  const bars = [];
  for (const r of rows) {
    const t = etToUtc(r && r.datetime);
    const p = r && r.price, v = r && r.volume;
    if (t == null || !p) continue;
    const o = fin(p.open), h = fin(p.high), l = fin(p.low), c = fin(p.close);
    if (!(o > 0 && h > 0 && l > 0 && c > 0)) continue;
    const e = et(t);
    bars.push({ day: e.day, m: e.min, t, o, h, l, c, v: fin(v && v.stock_volume) || 0 });
  }
  if (!bars.length) return { day: null, bars: [] };
  // one session per file; if a file ever straddles two, keep the newest day's
  const day = bars[bars.length - 1].day;
  return { day, bars: bars.filter((b) => b.day === day).sort((a, b) => a.t - b.t) };
}
function parseCboeDaily(j) {
  const rows = j && Array.isArray(j.data) ? j.data : [];
  const out = [];
  for (const r of rows) {
    const o = fin(r.open), h = fin(r.high), l = fin(r.low), c = fin(r.close);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date)) || !(c > 0 && h > 0 && l > 0)) continue;
    out.push({ day: r.date, o, h, l, c, v: fin(r.volume) });
  }
  return out.sort((a, b) => (a.day < b.day ? -1 : a.day > b.day ? 1 : 0));
}
// One expiry of an option chain, both sides, sorted by strike. The whole SPY chain is ~6 MB and
// 13,000 contracts; the options book reads one day of it.
function parseCboeExpiry(j, expiry) {
  const d = j && j.data;
  if (!d || !Array.isArray(d.options)) return null;
  const calls = [], puts = [];
  for (const o of d.options) {
    const id = parseOsi(o && o.option);
    if (!id || id.expiry !== expiry) continue;
    const row = {
      osi: o.option, strike: id.strike, right: id.right,
      bid: fin(o.bid), ask: fin(o.ask), bidSz: fin(o.bid_size), askSz: fin(o.ask_size),
      last: fin(o.last_trade_price), high: fin(o.high), low: fin(o.low), volume: fin(o.volume), delta: fin(o.delta),
    };
    (id.right === 'C' ? calls : puts).push(row);
  }
  calls.sort((a, b) => a.strike - b.strike); puts.sort((a, b) => a.strike - b.strike);
  const fileAt = Date.parse(String(j.timestamp || '').replace(' ', 'T') + 'Z');
  return { expiry, spot: fin(d.current_price), at: etToUtc(d.last_trade_time), fileAt: Number.isFinite(fileAt) ? fileAt : null, calls, puts };
}

// ------------------------------------------------------------------ bar arithmetic (pure)
// One-minute bars (labelled by their END minute) -> five-minute bars labelled by their START, the way
// the stack's checker and most charts label them: the 12:25 bar covers 12:25 to 12:30. A five-minute
// bar is returned only once all five of its minutes are in: a bar still forming, or one with a minute
// missing, is not a bar a rule may read.
function fiveMinute(bars1) {
  const by = new Map();
  for (const b of bars1 || []) {
    const start = Math.floor((b.m - 1) / 5) * 5;
    let g = by.get(start);
    if (!g) by.set(start, (g = []));
    g.push(b);
  }
  const out = [];
  for (const [m, g] of [...by.entries()].sort((a, b) => a[0] - b[0])) {
    if (g.length !== 5) continue;
    g.sort((a, b) => a.m - b.m);
    out.push({ m, o: g[0].o, h: Math.max(...g.map((x) => x.h)), l: Math.min(...g.map((x) => x.l)), c: g[4].c, v: g.reduce((a, x) => a + (x.v || 0), 0) });
  }
  return out;
}
// Session VWAP after each bar: typical price (h+l+c)/3 weighted by volume, from the first bar.
function vwapSeries(bars) {
  let pv = 0, v = 0;
  return bars.map((b) => { const typ = (b.h + b.l + b.c) / 3; pv += typ * (b.v || 0); v += b.v || 0; return v > 0 ? pv / v : b.c; });
}
// ATR14 for `day`'s 12:30 test: the simple mean of the last 14 true ranges from real day bars
// strictly before `day`, as the stack's checker computes it. Needs 15 bars. `asof` is the last day
// used, so the caller can see a stale file (a missing session between it and `day`).
function atr14(daily, day) {
  const ds = (daily || []).filter((b) => b.day < day);
  if (ds.length < 15) return null;
  const trs = [];
  for (let i = 1; i < ds.length; i++) {
    const pc = ds[i - 1].c, { h, l } = ds[i];
    trs.push(Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc)));
  }
  const last = trs.slice(-14);
  return { atr: last.reduce((a, x) => a + x, 0) / 14, asof: ds[ds.length - 1].day };
}
// Annualised volatility of the last `n` daily log returns (sample stdev). null without n+1 closes.
function realizedVol(closes, n, perYear) {
  if (!Array.isArray(closes) || closes.length < n + 1) return null;
  const c = closes.slice(-(n + 1)), r = [];
  for (let i = 1; i < c.length; i++) { if (!(c[i] > 0 && c[i - 1] > 0)) return null; r.push(Math.log(c[i] / c[i - 1])); }
  const m = r.reduce((a, x) => a + x, 0) / n;
  const varc = r.reduce((a, x) => a + (x - m) ** 2, 0) / (n - 1);
  return Math.sqrt(varc) * Math.sqrt(perYear);
}

// ------------------------------------------------------------------ the network half
// `fetchImpl` is global fetch in production; the tests pass a fake. `connection: close` for the reason
// src/venues/cboe.js gives: these CDNs object to a long-lived socket, not to the request rate.
function makeFeeds({ fetchImpl = fetch, timeoutMs = 15000 } = {}) {
  const stats = { ok: 0, err: 0, lastError: null, bytes: 0 };
  async function getJSON(url) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { headers: { 'user-agent': UA, accept: 'application/json', connection: 'close' }, signal: ac.signal });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      const text = await r.text();
      stats.bytes += text.length;
      const j = JSON.parse(text);
      stats.ok++;
      return j;
    } catch (e) {
      stats.err++; stats.lastError = { at: Date.now(), msg: String(e && e.name === 'AbortError' ? `timed out: ${new URL(url).host}` : e.message).slice(0, 140) };
      throw e;
    } finally { clearTimeout(timer); }
  }
  const sym = (s) => encodeURIComponent(s);
  return {
    stats,
    async ticker(id) { return parseCoinbaseTicker(await getJSON(`${COINBASE}/products/${sym(id)}/ticker`)); },
    async book(id) { return parseCoinbaseBook(await getJSON(`${COINBASE}/products/${sym(id)}/book?level=2`)); },
    // the last ~300 finished UTC days (one call; plenty for a 30-day volatility)
    async cryptoDaily(id, now = Date.now()) { return parseCoinbaseCandles(await getJSON(`${COINBASE}/products/${sym(id)}/candles?granularity=86400`), now); },
    async quote(s) { return parseCboeQuote(await getJSON(`${CBOE}/quotes/${sym(s)}.json`)); },
    async intraday(s) { return parseCboeIntraday(await getJSON(`${CBOE}/charts/intraday/${sym(s)}.json`)); },
    async daily(s) { return parseCboeDaily(await getJSON(`${CBOE}/charts/historical/${sym(s)}.json`)); },
    async expiry(s, day) { return parseCboeExpiry(await getJSON(`${CBOE}/options/${sym(s)}.json`), day); },
  };
}

module.exports = {
  makeFeeds, parseCoinbaseTicker, parseCoinbaseBook, parseCoinbaseCandles,
  parseCboeQuote, parseCboeIntraday, parseCboeDaily, parseCboeExpiry,
  fiveMinute, vwapSeries, atr14, realizedVol,
};

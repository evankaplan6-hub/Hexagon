'use strict';
// Market data for the stocks, crypto and options desk. Free, public, no key and no account.
//
//   Crypto   Coinbase Exchange's public REST API: live bid/ask, the order book, daily candles, and
//            every coin's last 24 hours in one call (the runner book's scan).
//   Stocks   Yahoo's public chart feed (query1.finance.yahoo.com), since 2026-11-20: one call carries SPY's last
//            regular-session price with its own time and six months of daily bars. Undocumented and unofficial, as
//            Cboe's was; Evan chose it ("Yes, use Yahoo") when Cboe put its delayed feed behind a block on
//            2026-11-19 (a Cloudflare 403 for every client, a real browser too, after it rebuilt its site).
//   Cboe     the parsers for its delayed quotes, minute bars, daily bars and option chain stay for the labs and
//            the chain tape (src/venues/cboe.js); the engine no longer calls them.
//
// READ-ONLY. Nothing here can place an order; there is no order path anywhere in src/desk/. The
// desk trades a paper ledger at these prices and nothing else.
//
// THE DELAY. A stock price here is the last regular-session trade Yahoo had when it was asked, stamped
// with that trade's own time (regularMarketTime), and the desk asks every five minutes: so a price is up
// to about five minutes old, and says how old. The desk trades it as exactly that: the price it decides
// on is the price it fills at. Nothing reads an old price against a live one. (Cboe's was ~15 minutes late.)
//
// The parsers are pure (a response in, rows out) so tools/desk-test.js checks them with no network.
// Every one returns null or [] for a response it does not understand, never a guess.
const { etToUtc, et, session } = require('./clock');
const { parseOsi } = require('../venues/cboe');

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const COINBASE = 'https://api.exchange.coinbase.com';
const CBOE = 'https://cdn.cboe.com/api/global/delayed_quotes';
const YAHOO = 'https://query1.finance.yahoo.com/v8/finance/chart';
// Yahoo is asked under the project's own name. On 2026-11-19 it answered that name and refused the browser-like
// one above with a plain-text 429 "Too Many Requests", from the same Mac a minute apart.
const YAHOO_UA = 'the-hexagon/1.0';

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

// Every product's last 24 hours in one call (/products/stats): { 'QNT-USD': { open, high, low, last,
// volume } }, volume in the coin. The runner book's scan (src/desk/books.js RUNNER).
function parseCoinbaseStats(j) {
  if (!j || typeof j !== 'object' || Array.isArray(j)) return null;
  const out = {};
  for (const [id, x] of Object.entries(j)) {
    const d = x && x.stats_24hour;
    if (!d) continue;
    const row = { open: fin(d.open), high: fin(d.high), low: fin(d.low), last: fin(d.last), volume: fin(d.volume) };
    if (row.last > 0 && row.open > 0) out[id] = row;
  }
  return out;
}
// The products Coinbase trades now, and the step each is sold in: { 'DOGE-USD': 0.1, ... }. A product that
// is delisted, halted or cancel-only is left out, so it is never bought.
function parseCoinbaseProducts(j) {
  if (!Array.isArray(j)) return null;
  const out = {};
  for (const p of j) {
    if (!p || typeof p.id !== 'string' || p.status !== 'online' || p.trading_disabled || p.cancel_only || p.limit_only) continue;
    const step = fin(p.base_increment);
    out[p.id] = step > 0 ? step : 1e-8;
  }
  return out;
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
// ------------------------------------------------------------------ Yahoo
// Yahoo's chart JSON -> bars { d, o, h, l, c, ac, v }. Pure. It was tools/stock-fetch.js's (which reads it from
// here now, so there is one reader): o/h/l/c are split-adjusted, `ac` also folds in dividends. A day with no close
// is dropped, never guessed (the live day comes with a null close before its first print and out of hours), and a
// day that comes twice keeps its later row. An error body throws with Yahoo's own words.
function parseYahooChart(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) {
    const e = json && json.chart && json.chart.error;
    throw new Error(e ? `${e.code}: ${e.description}` : 'no chart result');
  }
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const adj = (r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || null;
  const off = (r.meta && r.meta.gmtoffset) || 0;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (!(c > 0)) continue;
    const d = new Date((ts[i] + off) * 1000).toISOString().slice(0, 10);
    const num = (a) => (a && a[i] > 0 ? a[i] : null);
    const bar = { d, o: num(q.open), h: num(q.high), l: num(q.low), c, ac: adj && adj[i] > 0 ? adj[i] : c, v: (q.volume && q.volume[i]) || 0 };
    if (bars.length && bars[bars.length - 1].d === d) bars[bars.length - 1] = bar;   // the live day can repeat
    else bars.push(bar);
  }
  return { symbol: r.meta && r.meta.symbol, currency: r.meta && r.meta.currency, bars };
}
// The daily bars the engine reads: finished sessions only, in its own shape. The chart's last row is the day still
// trading, its "close" the price of the moment: read as a close it would move the 20-session swing all day. A day
// counts once its session has closed (the clock's calendar, half days too). Split-adjusted closes: a split rescales
// every bar alike, so the returns the swing is measured on do not change. Pure.
//
// THE LAST DAY. For hours after a close Yahoo's row for that day has no close at all (seen 2026-11-19 at 8:53 PM:
// Nov 19's row null, the quote 715.87 stamped 4:00 PM). Left out, the next morning's swing would be measured a
// session short. The quote in the same answer IS that close once it is stamped at the bell, so it stands in.
function parseYahooDaily(json, now) {
  const e = et(now);
  const over = (day) => { if (day < e.day) return true; const s = session(day); return day === e.day && !!s && e.min >= s.close; };
  const out = parseYahooChart(json).bars.filter((b) => over(b.d)).map((b) => ({ day: b.d, o: b.o, h: b.h, l: b.l, c: b.c, v: b.v }));
  const m = json.chart.result[0].meta || {}, last = fin(m.regularMarketPrice), at = fin(m.regularMarketTime);
  if (last > 0 && at > 0) {
    const q = et(at * 1000), s = session(q.day);
    if (s && q.min >= s.close && over(q.day) && (!out.length || out[out.length - 1].day < q.day)) {
      out.push({ day: q.day, o: null, h: fin(m.regularMarketDayHigh), l: fin(m.regularMarketDayLow), c: last, v: fin(m.regularMarketVolume) });
    }
  }
  return out;
}
// SPY's quote from the same answer: the REGULAR session's last price and that trade's own time. Yahoo sends
// pre-market and after-hours prices in fields of their own (preMarketPrice, postMarketPrice); they are not read,
// so out of hours the price is the 4:00 close with the close's time, as Cboe's file was marked. The chart has no
// bid or ask: the book is marked, and filled, at the last trade (the engine and the broker already do that when a
// quote has no touch). The close before the quote's session is the price less its own change
// (regularMarketChangePercent), as Cboe's was read, because the bars can be a day short (see THE LAST DAY above);
// from the bars only when the answer has no change. chartPreviousClose is not it: that is the close before the
// whole range, months back. null for an answer without a price, a time, or the symbol asked for.
function parseYahooQuote(json, want) {
  const { bars } = parseYahooChart(json);
  const m = json.chart.result[0].meta || {};
  const last = fin(m.regularMarketPrice), at = fin(m.regularMarketTime);
  if (!(last > 0) || !(at > 0)) return null;
  if (want && String(m.symbol || '').toUpperCase() !== String(want).toUpperCase()) return null;
  const day = et(at * 1000).day, prev = bars.filter((b) => b.d < day).pop(), chg = fin(m.regularMarketChangePercent);
  const prevClose = chg != null && chg > -100 ? Math.round((last / (1 + chg / 100)) * 100) / 100 : prev ? prev.c : null;
  return {
    sym: m.symbol || null, bid: null, ask: null, bidSz: null, askSz: null,
    last, open: null, high: fin(m.regularMarketDayHigh), low: fin(m.regularMarketDayLow), volume: fin(m.regularMarketVolume),
    prevClose,
    // the moment the price is FROM, which is what the desk's clock runs on for stocks
    at: at * 1000, fileAt: null, src: 'yahoo',
  };
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
// most charts label them: the 12:25 bar covers 12:25 to 12:30. The scalp book reads these; the options
// and dip books read the minutes themselves (the options book since 2026-09-29, when the stack's checker
// moved to one-minute bars). A five-minute bar is returned only once all five of its minutes are in: a
// bar still forming, or one with a minute missing, is not a bar a rule may read.
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
  async function getJSON(url, ua = UA) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchImpl(url, { headers: { 'user-agent': ua, accept: 'application/json', connection: 'close' }, signal: ac.signal });
      if (r.status !== 200) throw new Error(`HTTP ${r.status} from ${new URL(url).host}`);
      const text = await r.text();
      stats.bytes += text.length;
      // a block page or a consent page can come with a 200: say what it was, not "Unexpected token <"
      let j;
      try { j = JSON.parse(text); } catch { throw new Error(`not JSON from ${new URL(url).host}`); }
      stats.ok++;
      return j;
    } catch (e) {
      stats.err++; stats.lastError = { at: Date.now(), msg: String(e && e.name === 'AbortError' ? `timed out: ${new URL(url).host}` : e.message).slice(0, 140) };
      throw e;
    } finally { clearTimeout(timer); }
  }
  const sym = (s) => encodeURIComponent(s);
  // One answer serves the quote and the daily bars: asked for in the same round, they are one request. Kept a
  // minute, so nothing is ever older than the engine's own pace allows.
  const charts = new Map();
  const yahooChart = (s, now = Date.now()) => {
    const hit = charts.get(s);
    if (hit && now - hit.at < 60000) return hit.p;
    const p = getJSON(`${YAHOO}/${sym(s)}?range=6mo&interval=1d&includePrePost=false`, YAHOO_UA);
    charts.set(s, { at: now, p });
    p.catch(() => { if (charts.get(s) && charts.get(s).p === p) charts.delete(s); });
    return p;
  };
  return {
    stats,
    async ticker(id) { return parseCoinbaseTicker(await getJSON(`${COINBASE}/products/${sym(id)}/ticker`)); },
    async book(id) { return parseCoinbaseBook(await getJSON(`${COINBASE}/products/${sym(id)}/book?level=2`)); },
    // the last ~300 finished UTC days (one call; plenty for a 30-day volatility)
    async cryptoDaily(id, now = Date.now()) { return parseCoinbaseCandles(await getJSON(`${COINBASE}/products/${sym(id)}/candles?granularity=86400`), now); },
    // every coin's last 24 hours in one call (about 100 KB), and the list of what trades and in what steps
    async coinStats() { return parseCoinbaseStats(await getJSON(`${COINBASE}/products/stats`)); },
    async coinProducts() { return parseCoinbaseProducts(await getJSON(`${COINBASE}/products`)); },
    // an answer with no price is a failure, not a quiet nothing: the engine then waits longer before asking again
    async quote(s, now = Date.now()) {
      const q = parseYahooQuote(await yahooChart(s, now), s);
      if (!q) throw new Error("no price in Yahoo's answer");
      return q;
    },
    async daily(s, now = Date.now()) {
      const bars = parseYahooDaily(await yahooChart(s, now), now);
      if (!bars.length) throw new Error("no daily bars in Yahoo's answer");
      return bars;
    },
    async intraday(s) { return parseCboeIntraday(await getJSON(`${CBOE}/charts/intraday/${sym(s)}.json`)); },
    async expiry(s, day) { return parseCboeExpiry(await getJSON(`${CBOE}/options/${sym(s)}.json`), day); },
  };
}

module.exports = {
  makeFeeds, parseCoinbaseTicker, parseCoinbaseBook, parseCoinbaseCandles, parseCoinbaseStats, parseCoinbaseProducts,
  parseCboeQuote, parseCboeIntraday, parseCboeDaily, parseCboeExpiry,
  parseYahooChart, parseYahooDaily, parseYahooQuote,
  fiveMinute, vwapSeries, atr14, realizedVol,
};

'use strict';
// ChartExchange (chartexchange.com): read-only market data behind an API key.
//
// READ-ONLY. There is no account balance behind this key, no order path, and nothing here can
// spend or trade. It is a data subscription: stock, crypto and forex quotes, daily bars, short
// volume, dark-pool prints, borrow fees, failures-to-deliver, Reddit mentions, an option-chain
// summary (max pain, put/call) and -- the one thing that matters to this repo -- DAILY BARS AND OPEN
// INTEREST FOR EVERY OPTION CONTRACT, INCLUDING EXPIRED ONES, back to 2021 on SPY. That is the
// history README.md's options section says nobody sells, and tools/option-history.js writes it
// down while the key lasts. The subscription is a 14-day Tier 3 trial to 2026-10-07 (.env says so),
// which is why everything here is a tool or an Ask-panel lookup and nothing in the trading loop
// depends on it: the desk trades prediction markets and must run exactly the same without this key.
// The trial also caps requests: after some hundreds of calls in a day (the number is not published;
// the cap landed on 2026-09-23 around the 800th) every call answers 406 "maximum number of requests
// in trial mode" until the subscription is paid for. The full option history is ~60,000 calls.
//
// THE KEY RIDES IN THE QUERY STRING, and that shapes two rules. First, the API's own paginated
// responses echo the request URL back as `next` and `previous` -- key included -- so nothing here
// follows `next`: pages are walked by number, and `next`/`previous` are never returned to a caller.
// Second, every error message is scrubbed before it leaves this file: a failed request's URL is
// exactly what a stack trace or a log line would print.
//
// SYMBOLS are region-prefixed: `US:SPY` for a stock, `BTC:USD` for a crypto pair, and an option is
// the underlying plus YYYYMMDD, C or P, and the strike with its trailing zeros dropped
// (`US:SPY20240419C500`, `US:TLT20240419P88.5`). Callers pass plain tickers and this file prefixes.
// The chain tape (src/venues/cboe.js) names contracts by OSI symbol, so a listed contract is also
// given its OSI name here, and the two histories join on it.
//
// WHAT THE DATA IS AND IS NOT. Stock quotes are delayed 30 minutes; crypto quotes are live. Bars
// are split-adjusted (XLK's 2:1 of 2025-12-05 is continuous) but NOT dividend-adjusted, and the
// dividend endpoint stops in mid-2021 for SPY, so this is not a total-return source and
// tools/stock-fetch.js keeps Yahoo for the ETF lab. Option bars carry a day only when the contract
// traded, so a quiet strike has gaps, and they carry no bid/ask and no greeks: the close of the
// last trade, not what it would have cost to deal. A rule that "sells the close" on these is
// selling at a print that may have been the bid, the ask, or neither.
const { ET_DAY } = require('../recorder');

const BASE = 'https://chartexchange.com/api/v1';
const KEY_ENV = 'CHARTEXCHANGE_API_KEY';
const UA = 'the-hexagon/1.0 (+read-only market data)';
const PAGE_SIZE = 500;                 // the API's own ceiling per page and per bars call
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function key(env = process.env) { return String(env[KEY_ENV] || '').trim(); }
function enabled(env = process.env) { return key(env).length > 0; }

// Any text that might carry the key -- an error, a URL, a `next` link -- goes through this. Both
// forms are covered: the query parameter by name, and the key's own value wherever it sits.
function scrub(text, apiKey = '') {
  let s = String(text == null ? '' : text).replace(/api_key=[^&\s"'<>]*/g, 'api_key=***');
  if (apiKey && apiKey.length >= 6) s = s.split(apiKey).join('***');
  return s;
}

// ---------------------------------------------------------------- symbols
const stockSym = (s) => { const t = String(s || '').trim().toUpperCase(); return t.includes(':') ? t : `US:${t}`; };
const cryptoSym = (s) => { const t = String(s || '').trim().toUpperCase().replace(/[-/]/, ':'); return t.includes(':') ? t : `${t}:USD`; };
// A strike in the API's spelling: trailing zeros dropped, never an exponent.
const strikeText = (k) => String(Math.round(k * 1000) / 1000);
const optionSym = ({ root, expiry, right, strike }) => `US:${String(root).toUpperCase()}${String(expiry).replace(/-/g, '')}${right}${strikeText(strike)}`;
// The chain tape's name for the same contract: root, YYMMDD, C/P, strike in thousandths padded to 8.
const osiSym = ({ root, expiry, right, strike }) => `${String(root).toUpperCase()}${String(expiry).replace(/-/g, '').slice(2)}${right}${String(Math.round(strike * 1000)).padStart(8, '0')}`;

// ---------------------------------------------------------------- pure parsers
// The API sends every number as a string ("767.93"). null for anything that is not a finite
// number, so a blank is a blank and not a zero; the same rule src/venues/cboe.js keeps.
const num = (x) => { if (x === null || x === undefined || x === '') return null; const n = Number(x); return Number.isFinite(n) ? n : null; };
// Bar timestamps are midnight in New York on the trading day (1764565200 is 2025-12-01 05:00Z,
// EST midnight), so the Eastern calendar day of the stamp IS the trading day. Formatting it in UTC
// would be right in winter and right in summer and wrong for nothing -- until a stamp is ever not
// midnight -- so the Eastern day is used deliberately, as everywhere else in this repo.
const barDay = (ts) => (Number.isFinite(ts) ? ET_DAY.format(new Date(ts * 1000)) : null);

// [{timestamp, open, high, low, close, volume}] → [{d, o, h, l, c, v}], sorted by day, one row per
// day (the last one wins, as in tools/stock-fetch.js: the live day can repeat), no row without a
// close. `extra` names further fields to carry (open_interest → oi for option bars).
function parseBars(rows, extra = {}) {
  const byDay = new Map();
  for (const r of Array.isArray(rows) ? rows : []) {
    const d = barDay(num(r && r.timestamp));
    const c = num(r && r.close);
    if (!d || !(c > 0)) continue;
    const bar = { d, o: num(r.open), h: num(r.high), l: num(r.low), c, v: num(r.volume) || 0 };
    for (const [from, to] of Object.entries(extra)) bar[to] = num(r[from]);
    byDay.set(d, bar);
  }
  return [...byDay.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
}
const parseOptionBars = (rows) => parseBars(rows, { open_interest: 'oi' });

// A row of /ref/options/contracts/ → { cx, osi, root, expiry, right, strike }; null if malformed.
function parseContract(r) {
  if (!r || typeof r.symbol !== 'string') return null;
  const root = String(r.underlying || '').replace(/^[A-Z]+:/, '');
  const expiry = String(r.expiration || '');
  const right = r.contract_type === 'P' ? 'P' : r.contract_type === 'C' ? 'C' : null;
  const strike = num(r.strike);
  if (!root || !DAY_RE.test(expiry) || !right || !(strike > 0)) return null;
  return { cx: r.symbol, osi: osiSym({ root, expiry, right, strike }), root, expiry, right, strike };
}

function parseQuote(r) {
  if (!r) return null;
  return { symbol: r.symbol || null, name: r.name || null, price: num(r.price), change: num(r.change), changePct: num(r.change_pct), asOf: r.as_of || null, exchange: r.exchange || null };
}
// Short volume: rt reported total, st short, lt long, fs off-exchange (FINRA's daily file).
function parseShortVolume(r) {
  if (!r || !DAY_RE.test(String(r.date || ''))) return null;
  const total = num(r.rt), short = num(r.st);
  return { d: r.date, total, short, long: num(r.lt), offExchange: num(r.fs), shortPct: total > 0 && short != null ? Math.round((short / total) * 1000) / 10 : null };
}
function parseDarkPoolSummary(r) {
  if (!r) return null;
  return {
    trades: num(r.total_count), volume: num(r.total_volume), premium: num(r.total_premium),
    atBidPct: num(r.bid_pct), atMidPct: num(r.mid_pct), atAskPct: num(r.ask_pct),
    bidVolume: num(r.bid_volume), midVolume: num(r.mid_volume), askVolume: num(r.ask_volume),
  };
}
function parseChainSummary(r) {
  if (!r) return null;
  return { underlying: r.underlying || null, expiration: r.expiration || null, maxPain: num(r.max_pain), callItm: num(r.call_itm), callOtm: num(r.call_otm), putItm: num(r.put_itm), putOtm: num(r.put_otm), putCallRatio: num(r.pc_ratio) };
}

// ---------------------------------------------------------------- the session
// `fetchImpl` is global fetch in production; the tests pass a fake so none of this touches the net.
// `pace` spaces calls apart -- the API publishes no rate limit, and a burst of a dozen was served
// without complaint, so this is politeness with a knob rather than a known ceiling.
function makeSession({ fetchImpl = fetch, apiKey = key(), pace = 250, retryMs = 2000, tries = 4, base = BASE } = {}) {
  if (!apiKey) throw new Error(`${KEY_ENV} is not set`);
  let lastAt = 0;
  const stats = { calls: 0, retries: 0 };

  async function get(pathname, params = {}) {
    const u = new URL(base + pathname);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, String(v));
    u.searchParams.set('api_key', apiKey);
    for (let i = 0; ; i++) {
      const wait = lastAt + pace - Date.now();
      if (wait > 0) await sleep(wait);
      lastAt = Date.now();
      stats.calls++;
      let status = 0;
      try {
        const r = await fetchImpl(u.toString(), { headers: { accept: 'application/json', 'user-agent': UA } });
        status = r.status;
        const text = await r.text();
        if (status === 200) {
          try { return JSON.parse(text); } catch { throw new Error('the response was not JSON'); }
        }
        // A 4xx other than 429 is a bad symbol, a bad parameter or a bad key, and asking again
        // does not change it; the API's own words are kept because they say which ("Invalid
        // symbol: ", "Invalid value: "). A 406 is the trial's request cap ("You have reached the
        // maximum number of requests in trial mode"): every call after it is refused too, so it
        // is flagged `quota` for callers to stop on rather than fail one item at a time.
        if (status >= 400 && status < 500 && status !== 429) {
          let why = '';
          try { const j = JSON.parse(text); why = Array.isArray(j) ? j.join('; ') : (j && (j.detail || j.error || j.message)) || ''; } catch { /* html or nothing */ }
          const quota = status === 406 || /maximum number of requests/i.test(why);
          throw Object.assign(new Error(`HTTP ${status}${why ? `: ${String(why).slice(0, 120)}` : ''}`), { status, final: true, ...(quota ? { quota: true } : {}) });
        }
        throw Object.assign(new Error(`HTTP ${status}`), { status });
      } catch (e) {
        if (e.final || i + 1 >= tries) throw Object.assign(new Error(scrub(e.message, apiKey)), { status: e.status || status || 0, ...(e.quota ? { quota: true } : {}) });
        stats.retries++;
        await sleep((status === 429 ? retryMs * 5 : retryMs) * (i + 1));   // a refusal gets a long breath
      }
    }
  }

  // Every page of a paginated endpoint, walked by page NUMBER. The API's `next` is never fetched
  // (it carries the key and comes back over plain http), and never returned.
  async function pages(pathname, params = {}, { pageSize = PAGE_SIZE, maxPages = 40 } = {}) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const j = await get(pathname, { ...params, page, page_size: pageSize });
      if (Array.isArray(j)) { out.push(...j); break; }             // some endpoints answer unpaged
      const results = (j && Array.isArray(j.results)) ? j.results : [];
      out.push(...results);
      if (!j || !j.next || !results.length) break;
    }
    return out;
  }

  // Bars from `start` (unix seconds) forward, in pages of 500 until the API sends a short page or
  // `until` (YYYY-MM-DD) is passed. Sorted, one row per day.
  async function barsFrom(pathname, symbol, { start, until = null, extra = {}, maxPages = 40 }) {
    let from = Math.max(0, Math.floor(start));
    const all = [];
    for (let i = 0; i < maxPages; i++) {
      const rows = await get(pathname, { symbol, agg_type: 'day', start: from, limit: PAGE_SIZE });
      const bars = parseBars(rows, extra);
      all.push(...bars);
      if (!Array.isArray(rows) || rows.length < PAGE_SIZE) break;
      const lastTs = num(rows[rows.length - 1].timestamp);
      if (!(lastTs > from)) break;
      from = lastTs + 1;
      if (until && bars.length && bars[bars.length - 1].d >= until) break;
    }
    // pages can overlap on the boundary day; the later fetch of a day wins, as in parseBars
    const m = new Map();
    for (const b of all) m.set(b.d, b);
    return [...m.values()].sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : 0));
  }

  // Some endpoints answer a bare array, others {count, next, previous, results}.
  const rowsOf = (j) => (Array.isArray(j) ? j : (j && Array.isArray(j.results)) ? j.results : []);

  return {
    get, pages, stats,
    quote: async (sym) => parseQuote((await get('/feed/stocks/quote/', { symbol: stockSym(sym) }))[0]),
    cryptoQuote: async (sym) => parseQuote((await get('/feed/crypto/quote/', { symbol: cryptoSym(sym) }))[0]),
    // Daily stock bars from a unix-seconds `start`; `until` stops paging once that day is in hand.
    bars: (sym, opts) => barsFrom('/data/stocks/bars/', stockSym(sym), opts),
    optionBars: (cxSymbol, opts) => barsFrom('/data/options/bars/', cxSymbol, { ...opts, extra: { open_interest: 'oi' } }),
    contracts: async (underlying, params = {}) => (await pages('/ref/options/contracts/', { underlying: stockSym(underlying), ...params })).map(parseContract).filter(Boolean),
    // Answers as a plain array, newest first, whatever page_size asks; cut here.
    shortVolume: async (sym, { limit = 10 } = {}) => rowsOf(await get('/data/stocks/short-volume/', { symbol: stockSym(sym), page_size: Math.max(1, Math.min(100, limit)) })).slice(0, Math.max(1, limit)).map(parseShortVolume).filter(Boolean),
    darkPoolSummary: async (sym, date) => parseDarkPoolSummary((await get('/data/dark-pool-prints/summary/', { symbol: stockSym(sym), date }))[0]),
    chainSummary: async (underlying, expiration) => parseChainSummary((await get('/data/options/chain-summary/', { underlying: stockSym(underlying), expiration }))[0]),
  };
}

// One shared session for the running desk (the Ask panel), built on first use; null without a key.
let shared;
function session(env = process.env) {
  if (shared === undefined) shared = enabled(env) ? makeSession({ apiKey: key(env) }) : null;
  return shared;
}

module.exports = {
  makeSession, session, enabled, key, scrub, KEY_ENV, BASE, PAGE_SIZE,
  stockSym, cryptoSym, optionSym, osiSym, strikeText, barDay,
  parseBars, parseOptionBars, parseContract, parseQuote, parseShortVolume, parseDarkPoolSummary, parseChainSummary,
};

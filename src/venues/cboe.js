'use strict';
// Cboe's free delayed option quotes, for the chain tape (tools/chain-record.js).
//
// READ-ONLY PUBLIC MARKET DATA. No account, no key, no order path -- the same standing as
// tools/stock-fetch.js, which already pulls the BXM, PUT and VIX histories from this same CDN.
//
// WHY THIS EXISTS. Historical option chains are not free anywhere. That is the hole the ETF lab
// (tools/stock-lab.js) had to work around by standing in Cboe's BXM and PUT indexes -- two canned
// strategies -- for the whole of options. Live chains ARE free. So the only way to ever own an
// options history worth testing against is to start writing one down, and a day nobody records is
// a day that cannot be bought back later.
//
// WHY CBOE AND NOT YAHOO. Yahoo's option endpoint was the obvious first try and it is a dead end
// from Node: it now demands a cookie-and-crumb handshake, and every request for one from Node --
// `fetch`, `node:https` and `node:http2` alike, with or without the cookie, with browser headers or
// none -- comes back 429 `Too Many Requests`, while curl from the same machine and IP at the same
// moment is served normally. That is a TLS-fingerprint block, not a rate limit, and Node cannot
// spoof its way past one without a native TLS library, which would mean a dependency. Cboe's feed
// needs no handshake at all, and is better data besides: it is the exchange rather than a scrape of
// it, every expiry arrives in ONE request instead of one call per expiry, and each contract carries
// bid and ask SIZE and the greeks, none of which Yahoo gives at all. The cost is that quotes are
// delayed ~15 minutes, which matters not at all for a tape meant to test daily rules.
//
// WHAT A ROW IS. Each `option` is an OSI symbol: root, then YYMMDD, then C or P, then the strike in
// thousandths, zero-padded to 8. `SPY261218C00690000` is a SPY call, 18 Dec 2026, strike 690. It is
// parsed from the RIGHT, because the root is not always plain letters -- an adjusted contract after
// a split or a special dividend carries a digit (`QQQ1`), and anchoring on letters silently drops
// exactly the contracts whose pricing is most unusual.
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const URL_FOR = (sym) => `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`;

// One row per contract on the tape, as an array rather than an object: a symbol writes thousands of
// these per snapshot and the key names would be most of the file. The order is FROZEN -- append
// only, never reorder -- and tools/chain-record.js writes it into each tape's header line so a file
// read years from now explains itself without this source.
const CHAIN_COLS = ['k', 'bid', 'bidSz', 'ask', 'askSz', 'last', 'iv', 'delta', 'gamma', 'vega', 'theta', 'rho', 'theo', 'oi', 'vol', 'lt'];

// A missing quote and a genuine zero are different states and must not collapse: an option bid of 0
// is real and ordinary in the wings, while "Cboe did not say" is not a price at all. null carries
// that distinction; anything that rounds them together destroys it permanently.
const num = (x) => (Number.isFinite(x) ? x : null);
const r4 = (x) => (Number.isFinite(x) ? Math.round(x * 10000) / 10000 : null);
const r6 = (x) => (Number.isFinite(x) ? Math.round(x * 1000000) / 1000000 : null);

// OSI symbol → { root, expiry: 'YYYY-MM-DD', right: 'C'|'P', strike }. Parsed from the right; null
// for anything that does not fit, so a malformed row is dropped rather than guessed at.
function parseOsi(sym) {
  const s = String(sym || '');
  const m = /^(.+?)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/.exec(s);
  if (!m) return null;
  const [, root, yy, mm, dd, right, strike] = m;
  const k = Number(strike) / 1000;
  if (!(k > 0)) return null;
  // Cboe's two-digit year: these are listed options, so the window is this century.
  return { root, expiry: `20${yy}-${mm}-${dd}`, right, strike: k };
}

// Calendar days between two YYYY-MM-DD dates. TRADING days would need a holiday calendar, so the
// tape stores calendar days and lets the reader decide.
//
// Both sides are DATES, never a timestamp. Measuring an expiry's midnight against the current
// instant makes an option expiring this afternoon come out at -1 day, because noon is already past
// midnight. Which calendar day "today" is depends on the timezone, and that is the caller's call:
// tools/chain-record.js passes the Eastern day, matching what it names the file.
function daysToExpiry(expiry, today) {
  if (!expiry || !today) return null;
  const e = Date.parse(`${expiry}T00:00:00Z`);
  const t = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(e) || !Number.isFinite(t)) return null;
  return Math.round((e - t) / 86400000);
}

// ------------------------------------------------------------------ pure: the response → tape rows
// Cboe's delayed-quote JSON for one underlying → its chain, split by expiry. Pure, so
// tools/chains-test.js checks it against a captured response with no network and no clock.
//
// `band` keeps only strikes within that fraction of spot (0.15 → 85%..115%); `maxDte` drops
// expiries further out than that many days from `today`. Both exist because one SPY response is
// 12,000 contracts and almost all of them are wings and LEAPs that no covered-call or put-write
// rule ever reads -- the filtering is what keeps a year of tape a sane size.
function parseChain(json, { band = 0, maxDte = 0, today = null } = {}) {
  const d = json && json.data;
  if (!d || !Array.isArray(d.options)) throw new Error('no option data in response');
  const spot = num(d.current_price);
  const banded = band > 0 && spot > 0;
  // Compared as a ratio with a tolerance, not against spot*(1±band): 100*(1+0.15) is
  // 114.99999999999999 in floating point, which silently drops the strike sitting exactly on the
  // edge -- and the edges of a round band are struck strikes, not wings.
  const EPS = 1e-9;
  const byExpiry = new Map();
  let seen = 0, kept = 0;
  for (const o of d.options) {
    seen++;
    const id = parseOsi(o && o.option);
    if (!id) continue;
    if (banded && Math.abs(id.strike / spot - 1) > band + EPS) continue;
    if (maxDte > 0 && today) {
      const dte = daysToExpiry(id.expiry, today);
      // An expiry already past is settled and teaches nothing; Cboe keeps the morning's for a while.
      if (dte == null || dte < 0 || dte > maxDte) continue;
    }
    let e = byExpiry.get(id.expiry);
    if (!e) byExpiry.set(id.expiry, (e = { calls: [], puts: [] }));
    (id.right === 'C' ? e.calls : e.puts).push([
      id.strike, num(o.bid), num(o.bid_size), num(o.ask), num(o.ask_size), num(o.last_trade_price),
      r4(o.iv), r4(o.delta), r6(o.gamma), r4(o.vega), r4(o.theta), r4(o.rho), r4(o.theo),
      num(o.open_interest), num(o.volume),
      // Cboe writes this with no timezone offset; it is stored exactly as given rather than
      // guessed into UTC, and is null on a contract that has never traded.
      o.last_trade_time || null,
    ]);
    kept++;
  }
  for (const e of byExpiry.values()) { e.calls.sort((a, b) => a[0] - b[0]); e.puts.sort((a, b) => a[0] - b[0]); }
  return {
    symbol: d.symbol || json.symbol || null,
    spot,
    // The underlying's own quote and depth, alongside the chain that was priced off it.
    spotBid: num(d.bid), spotAsk: num(d.ask), spotBidSz: num(d.bid_size), spotAskSz: num(d.ask_size),
    // Cboe's OWN timestamp for this file, not the moment this ran. The two differ by the feed's
    // delay and by however long since the last update, and a snapshot that cannot say how stale it
    // is cannot be replayed honestly.
    quoteAt: json.timestamp || null,
    byExpiry, seen, kept,
  };
}

// ------------------------------------------------------------------ the network half
// `fetchImpl` is global fetch in production; the tests pass a fake so none of this touches the net.
function makeSession({ fetchImpl = fetch, pace = 500, retryMs = 2000 } = {}) {
  let lastAt = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function chain(symbol, { band = 0, maxDte = 0, today = null, tries = 3 } = {}) {
    for (let i = 0; ; i++) {
      try {
        const wait = lastAt + pace - Date.now();
        if (wait > 0) await sleep(wait);
        lastAt = Date.now();
        // `connection: close` for the same reason tools/stock-fetch.js sends it: a long-lived
        // process holding one socket open is what these CDNs object to, not the request rate.
        const r = await fetchImpl(URL_FOR(symbol), { headers: { 'user-agent': UA, accept: 'application/json', connection: 'close' } });
        if (r.status !== 200) throw new Error(`HTTP ${r.status}`);
        return parseChain(await r.json(), { band, maxDte, today });
      } catch (e) {
        if (i + 1 >= tries) throw e;
        await sleep(retryMs * (i + 1));
      }
    }
  }
  return { chain };
}

module.exports = { makeSession, parseChain, parseOsi, daysToExpiry, CHAIN_COLS, URL_FOR, UA };

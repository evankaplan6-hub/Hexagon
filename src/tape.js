'use strict';
// Batched market data for the maker desk.
//
// The desk used to fetch one trades page and one orderbook per quoted market: 48 calls for 24
// markets, which is why it could only afford to requote every 30 seconds. A quote resting
// unattended for 30 seconds is the whole problem -- 69% of live fills were run over against 5% in
// the backtest, because the only fills a stale quote wins are the ones that have moved through it.
//
// Both endpoints turn out to batch:
//
//   /markets/trades?limit=1000        the exchange-wide tape. It runs at ~160 trades/second, so a
//                                     single call covers roughly six seconds across every market
//                                     at once, and the desk filters out the tickers it cares about.
//
//   /markets?tickers=A,B,C            returns yes_bid/yes_ask AND yes_bid_size/yes_ask_size for
//                                     exactly the markets named. Those sizes are the same numbers
//                                     a full orderbook call reports, to the hundredth, so one call
//                                     replaces every per-market book fetch.
//
// 48 calls per 30 seconds becomes 2 calls per 5 seconds.
const ks = require('./venues/kalshi');
const http = require('./http');

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };

async function getWithBackoff(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await http.getJSON(url); }
    catch (e) {
      if (!/429/.test(String(e.message)) || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (i + 1) * (i + 1)));
    }
  }
}

function makeTape() {
  let lastNewest = 0;      // newest trade timestamp we have already returned
  let gaps = 0;

  // Trades since the last call, for the tickers we care about, oldest first.
  //
  // The gap check matters: if the OLDEST trade in the response is newer than the newest we saw
  // last time, the exchange traded more than a page between polls and we silently lost fills.
  // Missing trades do not look like an error, they look like a quiet market, so it is counted.
  async function since(tickers) {
    const want = tickers instanceof Set ? tickers : new Set(tickers);
    const d = await getWithBackoff(`${ks.BASE}/markets/trades?limit=1000`);
    const all = (d.trades || [])
      .map((t) => ({ ...t, _t: Date.parse(t.created_time) }))
      .filter((t) => Number.isFinite(t._t))
      .sort((a, b) => a._t - b._t);
    if (!all.length) return { trades: [], gap: false };

    const gap = lastNewest > 0 && all[0]._t > lastNewest;
    if (gap) gaps++;
    const fresh = all.filter((t) => t._t > lastNewest && want.has(t.ticker));
    lastNewest = all[all.length - 1]._t;
    return { trades: fresh, gap, gaps, scanned: all.length };
  }

  // Top of book for exactly the markets asked for, in ONE call.
  //
  // The first version of this fetched a listing per series, which was fewer calls than per-market
  // orderbooks but still pulled 542 markets to read three of them. /markets accepts an explicit
  // `tickers` list, so the whole quoted book comes back in a single request with no waste.
  //
  // Shaped exactly like ks.fetchBook so the quoting code cannot tell the difference -- only the top
  // level is populated, which is all desiredQuotes and the queue model ever read.
  async function books(tickers) {
    const list = [...new Set(tickers)].filter(Boolean);
    const out = new Map();
    let failed = 0;
    // the URL is the only limit; chunk so a wide book cannot produce an over-long request
    for (let i = 0; i < list.length; i += 40) {
      const chunk = list.slice(i, i + 40);
      let d;
      try { d = await getWithBackoff(`${ks.BASE}/markets?tickers=${chunk.join(',')}&limit=1000`); }
      catch { failed += chunk.length; continue; }
      for (const m of (d.markets || [])) {
        const b = num(m.yes_bid_dollars), a = num(m.yes_ask_dollars);
        if (b == null || a == null || !(a > b)) continue;
        out.set(m.ticker, {
          yesBids: [{ price: b, size: num(m.yes_bid_size_fp) || 0 }],
          yesAsks: [{ price: a, size: num(m.yes_ask_size_fp) || 0 }],
          noBids: [], noAsks: [],
        });
      }
    }
    return { books: out, failed };
  }

  return { since, books, stats: () => ({ gaps }) };
}

module.exports = { makeTape };

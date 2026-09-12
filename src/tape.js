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
//
// And then, where a Kalshi key is present, the trades poll goes away almost entirely: the same
// prints arrive over the exchange's WebSocket trade channel as they happen (src/kalshi-ws.js), each
// numbered, so `since` reads its buffer instead of the REST page. The poll is kept as the fallback
// and runs whenever the socket cannot vouch for the whole interval since the last call -- it was
// down, it reconnected, it skipped a sequence number, its buffer overflowed -- and because the
// poll pages back to the last print already returned, the hole is filled rather than counted.
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

function makeTape({ maxPages = 5, stream = null } = {}) {
  let lastNewest = 0;      // newest trade timestamp we have already returned
  let gaps = 0, pages = 0, streamed = 0, polled = 0;

  // The socket can be attached after construction: the desk opens it lazily, on its first cycle,
  // so that constructing a desk never opens a network connection.
  function setStream(s) { stream = s; }

  // Trades since the last call, for the tickers we care about, oldest first.
  //
  // One page is 1000 prints, and a poll that falls more than a page behind used to lose the rest:
  // if the OLDEST trade on the page was newer than the newest we had already seen, everything in
  // between had traded unobserved. That was counted as a gap and left at that -- 145 times in the
  // first two days on the cloud box, each one a window in which a resting quote may have filled
  // and the ledger would never know. Missing trades do not look like an error, they look like a
  // quiet market, which is why they were counted; but a count is not a fix.
  //
  // The endpoint pages by `cursor`, so now the poll keeps reading older pages until one reaches
  // back to (or past) the last trade it already returned. The cap is the only case that still
  // counts as a gap: five pages is 5000 prints, about thirty seconds of the whole exchange at its
  // usual rate, and a poll that far behind has a bigger problem than pagination.
  async function since(tickers) {
    const want = tickers instanceof Set ? tickers : new Set(tickers);
    const byId = new Map();

    // The socket first. `healthy` means it was connected for the whole interval since the last
    // drain and every sequence number arrived: nothing to page for, and no request to make.
    // Unhealthy, its prints are still real -- they go into the same de-duplicated set the poll
    // fills, so a round that polls returns the union and never a print twice.
    if (stream) {
      const d = stream.drain();
      if (d.healthy) {
        streamed++;
        const fresh = [];
        let newest = lastNewest;
        for (const t of d.trades) {
          if (t._t <= lastNewest) continue;
          if (t._t > newest) newest = t._t;
          if (want.has(t.ticker)) fresh.push(t);
        }
        lastNewest = newest;
        fresh.sort((a, b) => a._t - b._t);
        return { trades: fresh, gap: false, gaps, scanned: d.trades.length, source: 'stream' };
      }
      for (const t of d.trades) if (!byId.has(t.trade_id)) byId.set(t.trade_id, t);
    }
    polled++;
    let cursor = '', oldest = Infinity, capped = false;
    for (let page = 0; page < maxPages; page++) {
      const d = await getWithBackoff(`${ks.BASE}/markets/trades?limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      pages++;
      const batch = (d.trades || [])
        .map((t) => ({ ...t, _t: Date.parse(t.created_time) }))
        .filter((t) => Number.isFinite(t._t));
      for (const t of batch) if (!byId.has(t.trade_id)) byId.set(t.trade_id, t);
      for (const t of batch) if (t._t < oldest) oldest = t._t;
      // reached overlap, an empty page, or the end of the tape: nothing older is missing
      if (!batch.length || lastNewest === 0 || oldest <= lastNewest || !d.cursor) break;
      cursor = d.cursor;
      capped = page === maxPages - 1;
    }
    const all = [...byId.values()].sort((a, b) => a._t - b._t);
    if (!all.length) return { trades: [], gap: false, gaps, scanned: 0, source: 'poll' };

    // the gap test is about what the POLL reached back to, so it reads the page, not the union
    const gap = capped && oldest > lastNewest;
    if (gap) gaps++;
    const fresh = all.filter((t) => t._t > lastNewest && want.has(t.ticker));
    lastNewest = Math.max(lastNewest, all[all.length - 1]._t);
    return { trades: fresh, gap, gaps, scanned: all.length, source: 'poll' };
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

  return { since, books, setStream, stats: () => ({ gaps, pages, streamed, polled }) };
}

module.exports = { makeTape };

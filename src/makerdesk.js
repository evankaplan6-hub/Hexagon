'use strict';
// The MAKER desk's loop and ledger. src/maker.js holds the pure decisions; this owns state,
// I/O and sequencing -- the same split as decide.js versus agents.js.
const ks = require('./venues/kalshi');
const http = require('./http');
const maker = require('./maker');
const { makeMakerTape } = require('./makertape');
const { makeTape } = require('./tape');
const { openTradeStream } = require('./kalshi-ws');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Kalshi rate-limits, and a throttled scan is worse than a slow one: the first live run silently
// fell back to whatever happened to load and quoted six dead markets at 10-14c. Back off and retry
// rather than letting a 429 choose the book for us.
async function getWithBackoff(url, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try { return await http.getJSON(url); }
    catch (e) {
      if (!/429/.test(String(e.message)) || i === tries - 1) throw e;
      await sleep(400 * (i + 1) * (i + 1));
    }
  }
}

// What a resting order is actually up against, measured rather than assumed.
//
// Two numbers, from ONE trades page. The depth used to cost a second call to
// /markets/{t}/orderbook per candidate -- but `yes_bid_size_fp` and `yes_ask_size_fp` come back
// with the per-series listing the scan already fetches, and they are the same numbers to the
// hundredth (checked against a full orderbook call: 42.96 and 1142.12, both exact). Halving the
// per-candidate cost is what lets the probe cover twice as many candidates, and how many markets
// qualify is the binding constraint on this desk -- not capital, and not compute.
//   tpd    -- observed trades per day, from the last 100 prints. `volume_24h` is a snapshot one
//             block trade can inflate; this is closer to the flow that pays us.
//   clear  -- days for the size ALREADY resting at the touch to trade through, at this market's own
//             contract rate. Joining the touch means joining the back of that queue, and in the
//             median market it is ~15,700 contracts deep. Scoring the backtest with each market's
//             real depth took it from +$2187 to +$210. It ranked the book for two days and was
//             scored out of it (see refreshUniverse); kept because the dashboard and the scan log
//             say what a quote is up against.
// Cached an hour: depth moves faster than the rate does, and the scan runs every fifteen minutes.
const statCache = new Map();
async function marketStats(ticker, depth) {
  const hit = statCache.get(ticker);
  if (hit && Date.now() - hit.at < 3600 * 1000) return hit.v;
  const v = { tpd: 0, clear: Infinity, queue: 0 };
  try {
    const d = await getWithBackoff(`${ks.BASE}/markets/trades?ticker=${ticker}&limit=100`);
    const tr = (d.trades || []).map((t) => ({ t: Date.parse(t.created_time), n: parseFloat(t.count_fp) || 0 })).filter((x) => Number.isFinite(x.t));
    if (tr.length >= 10) {
      const ts = tr.map((x) => x.t);
      // floor the span at half an hour so one burst cannot report a six-figure daily rate
      const span = Math.max((Math.max(...ts) - Math.min(...ts)) / 86400000, 1 / 48);
      v.tpd = tr.length / span;
      const cpd = tr.reduce((a, x) => a + x.n, 0) / span;
      v.queue = depth;
      v.clear = v.queue / Math.max(1, cpd);
    }
  } catch { /* unmeasurable is not tradeable: tpd 0 fails the filter */ }
  statCache.set(ticker, { v, at: Date.now() });
  return v;
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const c = (x) => `${(x * 100).toFixed(1)}c`;
const money = (x) => `$${Math.abs(x).toFixed(2)}`;

// the exchange-wide tape grouped by ticker, oldest first as it arrived
function bucket(trades) {
  const by = new Map();
  for (const t of trades || []) {
    if (!by.has(t.ticker)) by.set(t.ticker, []);
    by.get(t.ticker).push(t);
  }
  return by;
}

function makeMakerDesk(cfg) {
  const recordTape = makeMakerTape(cfg);
  let universe = [];         // tickers we are quoting
  let eligible = null;       // series that actually charge makers nothing
  let lastUniverseAt = 0;
  // The wide universe: the any-market crawl hands its Kalshi markets over as it finishes, and they
  // are filtered to quotable rows THERE AND THEN. The crawl is ~41,000 records and is released the
  // moment it has been matched; what is kept here is the couple of hundred rows that pass.
  let crawled = null, crawledAt = 0, crawlSeen = null;
  let refreshing = null;     // in-flight refresh, so the scan never runs twice or blocks the tick
  let blocked = false;       // did the last step wait on a scan? (the engine's slow-round warning asks)
  const tape = makeTape({ maxPages: cfg.makerTapePages });   // batched exchange-wide trades + per-series books
  let stream = null, streamTried = false, streamRetryAt = 0;

  // The trade socket, opened once, on the first cycle rather than at construction so that building
  // a desk never opens a connection. Kalshi signs the handshake, so without a key there is nothing
  // to open it with and the desk polls as before -- said in the log, because a silent fallback
  // looks exactly like the feature working. The key signs the handshake and nothing else.
  // An open that throws (an unreadable key file, a bad PEM) is retried a minute later rather than
  // written off for the life of the process; the socket's own reconnects handle everything after.
  function ensureStream(E) {
    if (streamTried || Date.now() < streamRetryAt) return;
    streamTried = true;
    if (!cfg.makerStream) { E.log('MAKR', 'OPS', null, `trade stream off (MAKER_STREAM=0) · polling the tape every ${cfg.makerEverySec}s`); return; }
    if (!cfg.kalshiKeyId || !cfg.kalshiKeyPath) { E.log('MAKR', 'OPS', null, `no Kalshi key configured, and the socket handshake has to be signed · polling the tape every ${cfg.makerEverySec}s`); return; }
    try {
      stream = openTradeStream({
        keyId: cfg.kalshiKeyId, keyPath: cfg.kalshiKeyPath, url: cfg.kalshiWsUrl,
        onEvent: (type, d) => {
          if (type === 'open') E.log('MAKR', 'OPS', null, d.reconnects ? `trade stream reconnected (${d.reconnects} so far) · this round polls back over the gap` : 'trade stream connected · prints arrive as they happen; the poll is the fallback');
          else if (type === 'close' && E.due('makr-stream-close', 120)) E.log('MAKR', 'OPS', null, `trade stream dropped (${d.reason}) · polling until it is back`);
          else if (type === 'auth') E.log('MAKR', 'OPS', null, `trade stream refused (HTTP ${d.status}): the key did not sign the handshake · polling, retry in 60s`);
          else if (type === 'gap' && E.due('makr-stream-gap', 300)) E.log('MAKR', 'OPS', null, `trade stream skipped seq ${d.expected} → ${d.got} · this round polls back over it`);
        },
      });
      tape.setStream(stream);
    } catch (e) {
      streamTried = false; streamRetryAt = Date.now() + 60000;
      E.log('MAKR', 'OPS', null, `trade stream not started (${String(e.message).slice(0, 80)}) · polling the tape every ${cfg.makerEverySec}s, retry in 60s`);
    }
  }

  // Called by the any-market scanner with the Kalshi side of its crawl (src/anymarket.js), which
  // runs every DISCOVER_EVERY_MIN. Filtering here rather than at the next scan is deliberate: the
  // crawl's own arrays are freed as soon as it returns, and holding a reference to them on a 512 MB
  // box is how a scanner becomes a memory leak.
  function noteCrawl(E, markets, feeTypeOf) {
    if (!cfg.makerWiden) return 0;
    try {
      crawled = maker.candidatesFrom(markets, feeTypeOf, cfg);
      // Which series the crawl SAW, quotable or not. The any-market crawl excludes Sports (the fast
      // path covers games), so a listed sports series is absent from it entirely rather than absent
      // on merit, and those few are still scanned by name below. A series the crawl saw and dropped
      // was judged on the same filters as everything else and is not re-scanned.
      crawlSeen = new Set();
      for (const m of markets || []) if (m && m.seriesTicker) crawlSeen.add(m.seriesTicker);
      crawledAt = Date.now();
      return crawled.length;
    } catch (e) {
      E.log('MAKR', 'OPS', null, `wide universe not built (${String(e.message).slice(0, 80)}) · falling back to the ${cfg.makerSeries.length}-series list`);
      crawled = null;
      return 0;
    }
  }

  // Pick the most liquid mid-priced markets from the fee-free series.
  async function refreshUniverse(E) {
    // The wide universe first, when the crawl is recent enough to price off. Older than two crawl
    // intervals means the scanner is off, stuck or failing, and a stale list of tickers is worse
    // than a fresh narrow one: prices move, and a market that has closed is not worth probing.
    const crawlAge = crawledAt ? Date.now() - crawledAt : Infinity;
    if (cfg.makerWiden && crawled && crawlAge < Math.max(2 * cfg.discoverEveryMin, 45) * 60000) {
      const missed = cfg.makerSeries.filter((x) => !(crawlSeen && crawlSeen.has(x)));
      const extra = missed.length ? await scanSeries(E, missed) : [];
      const rows = [...crawled, ...extra].sort((x, y) => (y.vol - x.vol) || (y.spread - x.spread));
      const known = rows.filter((r) => cfg.makerSeries.includes(r.series)).length;
      E.log('MAKR', 'SCAN', null, `wide universe: ${rows.length} quotable markets across ${new Set(rows.map((r) => r.series)).size} fee-free series (${known} from the ${cfg.makerSeries.length}-series list, ${rows.length - known} beyond it) · crawl ${Math.round(crawlAge / 60000)}m old${missed.length ? ` · ${missed.length} listed series scanned by name (${extra.length} quotable): the crawl skips ${missed.slice(0, 3).join(', ')}${missed.length > 3 ? '…' : ''}` : ''}`);
      await probeAndPick(E, rows);
      return;
    }
    if (!eligible) {
      eligible = await maker.eligibleSeries(cfg.makerSeries);
      const rejected = cfg.makerSeries.filter((s) => !eligible.includes(s));
      E.log('MAKR', 'OPS', null, `${eligible.length}/${cfg.makerSeries.length} candidate series charge makers nothing${rejected.length ? ` · excluded ${rejected.join(', ')}` : ''}`);
    }
    const rows = await scanSeries(E, eligible);
    await probeAndPick(E, rows);
  }

  // One listing call per series, filtered as it is read. The narrow path's whole scan, and the wide
  // path's top-up for series the crawl does not cover.
  async function scanSeries(E, seriesList) {
    const rows = [];
    const failed = [];
    for (const s of seriesList) {
      try {
        const d = await getWithBackoff(`${ks.BASE}/markets?series_ticker=${s}&status=open&limit=200`);
        for (const m of (d.markets || [])) {
          const b = parseFloat(m.yes_bid_dollars), a = parseFloat(m.yes_ask_dollars);
          const v = parseFloat(m.volume_24h_fp) || 0;
          if (!Number.isFinite(b) || !Number.isFinite(a) || !(a > b)) continue;
          const mid = (a + b) / 2;
          if (mid < cfg.makerMinMid || mid > cfg.makerMaxMid) continue;
          if (a - b < cfg.makerMinSpread - 1e-9) continue;
          if (v < cfg.makerMinVol24) continue;
          // Do not be carrying inventory when the market settles: that is a 0-or-1 coin flip, not
          // a spread. Cheap to check here -- close_time is already in the listing we just fetched.
          const days = maker.daysToEnd(m.ticker, m.close_time);
          if (!(days >= cfg.makerMinDaysToClose)) continue;
          // top-of-book depth, free with this listing -- see marketStats
          const depth = ((parseFloat(m.yes_bid_size_fp) || 0) + (parseFloat(m.yes_ask_size_fp) || 0)) / 2;
          rows.push({ ticker: m.ticker, series: s, vol: v, spread: a - b, days, depth,
            title: m.title || '', sub: m.yes_sub_title || '' });
        }
      } catch (e) { failed.push(s); }
      await sleep(150);                    // pace the scan; it runs once every 15 minutes
    }
    // A partial scan silently narrows the universe to whatever survived, so say so.
    if (failed.length) E.log('MAKR', 'OPS', null, `universe scan incomplete: ${failed.length}/${seriesList.length} series failed to load (${failed.slice(0, 3).join(', ')}) · quoting from the rest`);
    rows.sort((x, y) => (y.vol - x.vol) || (y.spread - x.spread));
    return rows;
  }

  // Rank by observed trade rate, busiest first. Not by spread (backwards: P&L correlates -0.33
  // with it, and ranking on it put six dead markets at 10-14c on the book), not by volume (a
  // snapshot one block trade inflates), and no longer by how fast the queue at the touch clears.
  // Clear-time was the rule from 2026-09-10 to 2026-09-12, chosen because the backtest's whole
  // surviving edge sat in markets whose queue cleared inside a day. Scored walk-forward on 66
  // days of tape (tools/maker-rank.js) it was the worst of three rankings in every setting and
  // carried the most run-over in every setting: a queue that clears fast is a level that gets
  // swept, and a sweep through a resting quote is the fill this desk loses money on. Trade rate
  // was best or tied everywhere, with a third of the run-over at real depth. The queue is still
  // measured and logged; it just no longer picks the book.
  //
  // The list it ranks is now the wide one, so the same rule chooses from about three times as many
  // markets: MAKER_MARKETS still caps the book at 24.
  async function probeAndPick(E, rows) {
    const probe = rows.slice(0, cfg.makerRateProbe);
    for (const r of probe) { Object.assign(r, await marketStats(r.ticker, r.depth)); await sleep(80); }
    const live = probe
      .filter((r) => r.tpd >= cfg.makerMinTradesPerDay)
      .sort((x, y) => y.tpd - x.tpd);
    universe = live.slice(0, cfg.makerMarkets);
    lastUniverseAt = Date.now();
    E.log('MAKR', 'SCAN', null, universe.length
      ? `quoting ${universe.length} of ${live.length} workable markets (${probe.length} probed, ${rows.length} passed the cheap filters) · ${universe.slice(0, 3).map((r) => `${r.ticker.split('-').slice(-2).join('-')} ${r.tpd.toFixed(0)}/day, queue ${Math.round(r.queue)} clears in ${r.clear < 1 ? `${(r.clear * 24).toFixed(1)}h` : `${r.clear.toFixed(1)}d`}`).join(' · ')}${universe.length > 3 ? '…' : ''}`
      : `no market meets the bar (spread >= ${c(cfg.makerMinSpread)}, >= ${cfg.makerMinTradesPerDay} trades/day)`);
  }

  function book(E) {
    const s = E.state.maker;
    if (!s.markets) s.markets = {};
    // Version 1 briefly marked finalized 0c/100c placeholder books at 50c. The settlement repair
    // corrected the ledger, but the already-sampled chart points before that repair are not
    // reconstructable market by market. Start the combined history at the repair boundary once,
    // while preserving every accurate point after it. Fresh ledgers set 0 and never move it.
    if (!Number.isFinite(s.historyValidFrom)) {
      const repaired = Object.values(s.markets).map((m) => Number(m.settledAt) || 0).filter(Boolean);
      s.historyValidFrom = repaired.length ? Math.max(...repaired) : 0;
    }
    return s;
  }

  async function step(E) {
    blocked = false;
    if (!cfg.makerEnabled) return;
    ensureStream(E);
    const S = book(E);

    // TESS's computed halt is refreshed on the taker cadence. An operator flatten is immediate,
    // so it must be read directly here and again after this function's awaits before we install a
    // fresh resting quote.
    const withdraw = (extra) => {
      for (const m of Object.values(S.markets)) m.quotes = { bid: null, ask: null };
      E.touch('MAKR', 'quotes withdrawn');
      // tell the tape: without this it would show the last quote resting straight through the halt
      recordTape(E, { markets: S.markets, gap: 'halt', ...extra });
    };
    if (E.operatorHalt || E.halt || S.halted) { withdraw(); return; }

    // Own drawdown rail. TESS watches the taker book and would never see this desk bleeding,
    // because the two ledgers are separate on purpose.
    //
    // Measured from the PEAK, not from the opening balance. Against a fixed starting reference the
    // rail loosens with every dollar earned: a book that runs to $10,500 and bleeds back to $9,050
    // has given up $1,450 -- 13.8% off its high -- while this reads 9.5% and never fires. The
    // better the desk does, the more it is allowed to lose before anything stops it, which is
    // backwards. The taker's rail already re-references daily (dayStartEquity); this one had no
    // moving reference at all. A high-water mark can only ever halt EARLIER than the old test.
    const { peak, dd } = maker.drawdownFrom(S.equity, S.peak, cfg.initialBalance);
    S.peak = peak;
    if (dd >= cfg.makerMaxDrawdownPct && !S.halted) {
      S.halted = `maker drawdown ${(dd * 100).toFixed(1)}% from a peak of ${money(S.peak)} hit the ${(cfg.makerMaxDrawdownPct * 100).toFixed(0)}% limit`;
      E.log('MAKR', 'OPS', null, `HALT · ${S.halted} · quotes withdrawn, inventory held and marked`);
      E.journal(E, 'MAKER_HALT', { reason: S.halted, equity: S.equity });
    }
    // A halt means stop QUOTING. Existing inventory is still marked; withdrawing quotes is the
    // maker equivalent of KETT standing down.
    if (E.operatorHalt || E.halt || S.halted) { withdraw(); return; }
    // The scan costs 38 series listings plus 40 trade-rate probes -- about 23 seconds, against a
    // 15-second tick. Awaiting it made the whole desk skip ticks every fifteen minutes, taker side
    // included. The first one has to block (there is nothing to quote yet); after that it runs in
    // the background off the previous universe, guarded so it can never overlap itself.
    const stale = Date.now() - lastUniverseAt > 15 * 60 * 1000;
    if (!universe.length) { blocked = true; await refreshUniverse(E); }
    else if (stale && !refreshing) {
      refreshing = refreshUniverse(E)
        .catch((e) => E.log('MAKR', 'OPS', null, `universe refresh failed (${String(e.message).slice(0, 80)}) · still quoting the previous ${universe.length}`))
        .finally(() => { refreshing = null; });
    }
    if (E.operatorHalt || E.halt || S.halted) { withdraw(); return; }

    // Anything we still hold stays in the loop even after it drops out of the universe. Otherwise
    // rotating the book strands inventory: no quotes, no fills, and a mark that freezes at whatever
    // the mid was the last time we looked. Pinned markets are quoted on the REDUCING side only, so
    // a name we no longer want to make gets worked off rather than added to.
    const pinned = Object.entries(S.markets)
      .filter(([t, m]) => m.inv !== 0 && !universe.some((u) => u.ticker === t))
      .map(([ticker, m]) => ({ ticker, series: m.series, reduceOnly: true }));
    if (pinned.length) E.touch('MAKR', `${pinned.length} pinned to work off`);

    // ---- ONE call for every market's trades, ONE per series for every market's book ----------
    // This is what makes a 5-second requote affordable. Per-market fetching cost 48 calls for 24
    // markets and forced a 30-second cycle; a quote left unattended that long is run over on 69%
    // of its fills, which was the entire live loss.
    const work = [...universe, ...pinned];
    const tickers = work.map((u) => u.ticker);
    let tapeRes, bookRes;
    try {
      [tapeRes, bookRes] = await Promise.all([tape.since(tickers), tape.books(tickers)]);
    } catch (e) {
      E.log('MAKR', 'OPS', null, `market data failed (${String(e.message).slice(0, 80)}) · quotes left as they are`);
      recordTape(E, { markets: S.markets, gap: 'data-failure' });
      return;
    }
    // the prints this round already consumed are not thrown away by a halt that landed during the await
    if (E.operatorHalt || E.halt || S.halted) { withdraw({ trades: bucket(tapeRes.trades) }); return; }
    if (tapeRes.gap && E.due('makr-gap', 300)) {
      E.log('MAKR', 'OPS', null, `tape gap: the exchange traded more than ${cfg.makerTapePages} pages between polls (${tapeRes.gaps} so far) · some fills were not seen`);
    }
    if (bookRes.failed && E.due('makr-bookfail', 300)) {
      E.log('MAKR', 'OPS', null, `${bookRes.failed} book(s) failed to load · those markets keep their last quote`);
    }
    // bucket the exchange-wide tape by ticker, oldest first
    const byTicker = bucket(tapeRes.trades);

    let filled = 0, netQty = 0, settled = 0, settledQty = 0, settledPnl = 0;
    for (const u of work) {
      const m = S.markets[u.ticker] || (S.markets[u.ticker] = { series: u.series, inv: 0, cost: 0, realized: 0, fills: 0, quotes: { bid: null, ask: null }, seen: [] });
      // A ticker like KXBALANCEPOWERCOMBO-27FEB-RR says nothing about what is being traded. Keep
      // the exchange's own words for it, and keep them on the ledger so a market that drops out of
      // the universe can still say what it was.
      if (u.title) { m.title = u.title; m.sub = u.sub || ''; }
      const lifecycle = bookRes.markets && bookRes.markets.get(u.ticker);
      const yesPx = lifecycle && (lifecycle.result === 'yes' ? 1 : lifecycle.result === 'no' ? 0
        : ((lifecycle.status === 'determined' || lifecycle.status === 'finalized') && Number.isFinite(lifecycle.settlementValue)
          ? lifecycle.settlementValue : null));
      if (m.inv && yesPx != null && yesPx >= 0 && yesPx <= 1) {
        const beforeInv = m.inv, beforeCost = m.cost || 0;
        const res = maker.settlePosition(m, yesPx);
        S.cash = r2(S.cash + res.cashDelta);
        S.realized = r2((S.realized || 0) + res.pnl);
        m.inv = res.inv; m.cost = res.cost; m.realized = res.realized;
        m.mid = yesPx; m.quotes = { bid: null, ask: null };
        m.settledPx = yesPx; m.settledAt = Date.now();
        settled++; settledQty += Math.abs(beforeInv); settledPnl = r2(settledPnl + res.pnl);
        E.journal(E, 'MAKER_SETTLE', {
          ticker: u.ticker, qty: beforeInv, cost: beforeCost, yesPx,
          cashDelta: res.cashDelta, pnl: res.pnl, cash: S.cash,
        });
        continue;
      }
      const trades = byTicker.get(u.ticker) || [];        // already oldest-first
      const bk = bookRes.books.get(u.ticker);
      if (!bk) continue;                                   // no book this round: leave the quote alone

      // 1) fill the quotes we were ALREADY resting, against trades that have since arrived
      const seen = new Set(m.seen);
      const { fills, queue } = maker.fillsFrom(trades, m.quotes, m.inv, cfg, seen, m.queue);
      m.queue = queue;                                     // what is still ahead of us, carried forward
      for (const f of fills) {
        // REALISED profit, which is the only number that is actually money. `cash` is not profit
        // and never was: it falls when we buy and rises when we sell, so a net-short book shows a
        // large positive cash balance that is simply proceeds from contracts we still owe. Calling
        // that "banked from spread" was wrong, and it read as +$51 of earnings on a book that had
        // earned nothing. Profit exists only where a fill CLOSES part of a position.
        //
        // The arithmetic itself is maker.applyFill, so it can be asserted without a network. See
        // the note there on why a cost BASIS cannot be moved by cash flow -- getting that wrong
        // overstated realised profit on every partial close, which is most of them.
        const res = maker.applyFill(m, f);
        if (res.pnl) S.realized = r2((S.realized || 0) + res.pnl);
        S.cash = r2(S.cash + res.cashDelta);
        m.inv = res.inv; m.cost = res.cost; m.realized = res.realized;
        m.tox = maker.toxWindow(m.tox, f);                 // the run-over gate's evidence
        m.fills++; S.fills = (S.fills || 0) + 1; filled++; netQty += f.qty;
        // remembered for the dashboard: "nothing is happening" and "something happened four
        // minutes ago" look identical unless the page can say which.
        // `pnl` is what THIS fill realised (zero when it opened or added to a position), so a
        // clicked trade on the dashboard can say whether it made or lost money on its own.
        // title/sub ride along so the page can name a market it no longer quotes, rather than print its ticker
        S.lastFill = { ticker: u.ticker, title: m.title || u.title || '', sub: m.sub || u.sub || '', side: f.side, qty: f.qty, px: f.px, pnl: res.pnl, at: Date.now() };
        (S.recent = S.recent || []).unshift(S.lastFill);
        if (S.recent.length > 14) S.recent.length = 14;   // the floor shows ten; the journal keeps them all
        seen.add(f.id);
        E.journal(E, 'MAKER_FILL', { ticker: u.ticker, side: f.side, qty: f.qty, px: f.px, tradePx: f.tradePx, runOver: f.runOver, inv: m.inv });
      }
      for (const t of trades) seen.add(t.trade_id);
      m.seen = [...seen].slice(-400);                       // bounded

      // 2) rest a fresh quote for the next cycle. No sleep here any more -- there is no per-market
      // request left to pace, so the whole book requotes in one pass.
      const q = maker.desiredQuotes(bk, m.inv, cfg);
      // A profitable maker inventory stops growing once its mark has made a meaningful gain.
      // Keep the reducing quote resting (so the position can still work down without crossing),
      // but withdraw the side that would add risk. This is the maker form of gain-lock.
      const markPnl = m.inv ? (m.inv * (q.mid ?? m.mid ?? 0.5) - (m.cost || 0)) : 0;
      m.gainPeak = Math.max(Number.isFinite(m.gainPeak) ? m.gainPeak : markPnl, markPnl);
      const gainTrigger = Math.abs(m.cost || 0) * (cfg.gainLockTriggerPct || 0);
      const gainFloor = m.gainPeak - Math.abs(m.cost || 0) * (cfg.gainLockGivebackPct || 0);
      const gainLocked = m.inv !== 0 && m.gainPeak >= gainTrigger && markPnl <= gainFloor;
      // The run-over gate: a market whose touch keeps getting swept is withdrawn from entirely,
      // inventory included, for the cooling period. Said once per market per trip, and journalled,
      // because a market that is quietly not being quoted looks exactly like a quiet market.
      const g = maker.toxicGate(m, cfg, Date.now());
      m.tox = g.tox; m.cooledUntil = g.cooledUntil;
      if (g.tripped) {
        E.log('MAKR', 'OPS', null, `${u.ticker} cooled ${cfg.makerToxCooldownMin}m: ${(g.rate * 100).toFixed(0)}% of ${cfg.makerToxByContracts ? 'the contracts in ' : ''}its last ${m.fills < 30 ? m.fills : 30} fills were run over (limit ${(cfg.makerMaxRunOver * 100).toFixed(0)}%) · quotes withdrawn, ${Math.abs(m.inv)} held`);
        E.journal(E, 'MAKER_COOL', { ticker: u.ticker, rate: r4(g.rate), inv: m.inv, until: new Date(g.cooledUntil).toISOString() });
      }
      // reduce-only: drop whichever side would grow the position
      const next = g.cooled ? { bid: null, ask: null }
        : u.reduceOnly ? { bid: m.inv < 0 ? q.bid : null, ask: m.inv > 0 ? q.ask : null }
        : gainLocked ? { bid: m.inv < 0 ? q.bid : null, ask: m.inv > 0 ? q.ask : null }
        : { bid: q.bid, ask: q.ask };
      // Queue position. Moving to a new price puts us at the back of whatever is resting there;
      // staying put keeps the position we have already worked down. A cancel-replace at the same
      // price would lose it, which is a reason not to churn quotes that are still at the touch.
      const depth = (side) => { const l = side === 'bid' ? bk.yesBids[0] : bk.yesAsks[0]; return l ? l.size : 0; };
      const prev = m.queue || { bid: 0, ask: 0 };
      m.queue = {
        bid: next.bid == null ? 0 : (next.bid === (m.quotes && m.quotes.bid) ? prev.bid : depth('bid')),
        ask: next.ask == null ? 0 : (next.ask === (m.quotes && m.quotes.ask) ? prev.ask : depth('ask')),
      };
      m.quotes = next;
      m.mid = q.mid ?? m.mid;
      m.spread = q.spread ?? null;
      m.why = g.cooled ? `cooled until ${new Date(g.cooledUntil).toISOString().slice(11, 16)}Z · run-over ${(g.rate * 100).toFixed(0)}%` : (q.why || null);
    }

    // mark inventory at the current mid
    let inv = 0, mtm = 0;
    for (const m of Object.values(S.markets)) { inv += Math.abs(m.inv); mtm += m.inv * (m.mid ?? 0.5); }
    S.equity = r2(S.cash + mtm);
    if (settled) E.log('MAKR', 'SETTLE', settledPnl, `settled ${settled} finalized market${settled === 1 ? '' : 's'}, ${Math.round(settledQty)} contracts · realised ${settledPnl >= 0 ? '+' : '-'}${money(settledPnl)} · equity ${money(S.equity)}`);

    // Equity history. The board could say what the desk is worth right now but never which way it
    // had been going, and for a market maker that is the whole question -- banked cash only ever
    // rises, so the shape of the mark against it is the actual P&L story. Sampled once a minute and
    // capped at 5,000 minute samples (about 3.5 days). The former twelve-hour cutoff made the 24h
    // button and "All" axis claim a range the combined chart did not actually possess.
    const nowMs = Date.now();
    S.hist = S.hist || [];
    const last = S.hist[S.hist.length - 1];
    if (!last || nowMs - last.t >= 60000) {
      S.hist.push({ t: nowMs, c: r2(S.realized || 0), m: r2(mtm), e: r2(S.equity - cfg.initialBalance) });
      if (S.hist.length > 5000) S.hist.splice(0, S.hist.length - 5000);
    }
    // the data this round already fetched, kept: see src/makertape.js
    recordTape(E, { books: bookRes.books, trades: byTicker, markets: S.markets, at: bookRes.at, missed: !!tapeRes.gap });
    E.touch('MAKR', filled ? `${filled} fills, ${Math.round(netQty)} contracts` : `${universe.length} quoted, ${Math.round(inv)} inv`);
    if (filled && E.due('makr-fill', 60)) {
      E.log('MAKR', 'FILL', r2(S.equity - cfg.initialBalance), `${filled} fill${filled > 1 ? 's' : ''} this cycle · ${Math.round(inv)} contracts held across ${Object.keys(S.markets).length} markets · equity ${money(S.equity)}`);
    }
    if (E.due('makr-log', 300)) {
      E.log('MAKR', 'RESEARCH', null, `book: ${Math.round(inv)} contracts, cash ${money(S.cash)}, marked ${money(S.equity)} from ${money(cfg.initialBalance)} · ${S.fills || 0} fills total`);
    }
    E.dirty = true;
  }

  // Flatten every market's inventory at the touch, paying the TAKER fee -- getting out means
  // crossing, and pretending otherwise is how the first backtest flattered itself. Called by
  // engine.flattenAll so one kill switch covers both desks.
  async function flatten(E, reason) {
    const S = book(E);
    let closed = 0, contracts = 0;
    for (const [ticker, m] of Object.entries(S.markets)) {
      m.quotes = { bid: null, ask: null };
      if (!m.inv) continue;
      let px = m.mid ?? 0.5;
      try {
        const bk = await ks.fetchBook(ticker);
        px = m.inv > 0 ? (bk.yesBids[0] ? bk.yesBids[0].price : px) : (bk.yesAsks[0] ? bk.yesAsks[0].price : px);
      } catch { /* fall back to the last mark */ }
      const fee = ks.fee(Math.abs(m.inv), px, cfg.ksFeeRate, ticker);
      // Flattening CLOSES a position, so it realises whatever that position made -- it used to move
      // cash and then zero `inv` and `cost` without booking a cent of it, which breaks the same
      // invariant maker.applyFill exists to hold: once flat, realised equals the change in cash.
      // A desk flattened at a profit reported no profit at all. The crossing fee is a realised cost
      // and comes off with it.
      const qty = Math.abs(m.inv);
      const res = maker.applyFill(m, { side: m.inv > 0 ? 'sell' : 'buy', qty, px });
      const pnl = r2(res.pnl - fee);
      m.realized = r2(res.realized - fee);                  // applyFill already folded in res.pnl
      S.realized = r2((S.realized || 0) + pnl);
      S.cash = r2(S.cash + res.cashDelta - fee);
      E.journal(E, 'MAKER_FLATTEN', { ticker, qty: m.inv, px, fee, pnl, reason });
      contracts += qty; closed++;
      m.inv = res.inv; m.cost = res.cost;
    }
    S.equity = r2(S.cash);
    S.halted = `flattened by operator (${reason})`;
    if (closed) E.log('MAKR', 'OPS', null, `flattened ${closed} market${closed > 1 ? 's' : ''}, ${Math.round(contracts)} contracts · cash ${money(S.cash)}`);
    return { markets: closed, contracts };
  }

  function resume(E) { const S = book(E); S.halted = null; }

  // What the dashboard gets. Deliberately NOT a spread of the raw ledger: each market carries a
  // 400-entry `seen` list for trade de-duplication, and streaming 26 of those to every connected
  // browser twice a second is a few hundred kilobytes a second of pure dedupe bookkeeping.
  function snapshot(E) {
    const S = E.state.maker || {};
    const meta = new Map(universe.map((u) => [u.ticker, u]));
    const markets = Object.entries(S.markets || {}).map(([ticker, m]) => {
      const u = meta.get(ticker);
      return {
        ticker, series: m.series, inv: m.inv, cost: m.cost, fills: m.fills, realized: m.realized || 0,
        title: m.title || '', sub: m.sub || '',
        mid: m.mid ?? null, spread: m.spread ?? null, why: m.why || null,
        bid: m.quotes ? m.quotes.bid : null, ask: m.quotes ? m.quotes.ask : null,
        qBid: m.queue ? Math.round(m.queue.bid) : null, qAsk: m.queue ? Math.round(m.queue.ask) : null,
        mark: r2((m.inv || 0) * (m.mid ?? 0.5)),
        quoting: !!u, tpd: u ? Math.round(u.tpd || 0) : null, clear: u ? u.clear : null,
      };
    }).sort((a, b) => (b.quoting - a.quoting) || (b.fills - a.fills) || Math.abs(b.inv) - Math.abs(a.inv));
    return {
      cash: S.cash, equity: S.equity, realized: S.realized || 0, fills: S.fills || 0, halted: S.halted || null,
      lastFill: S.lastFill || null,
      // a fill from before titles rode on fills is named from the ledger, which keeps every market's words
      recent: (S.recent || []).slice(0, 12).map((f) => (f.title || !(S.markets[f.ticker] || {}).title ? f
        : { ...f, title: S.markets[f.ticker].title, sub: S.markets[f.ticker].sub || '' })),
      lastScanAt: lastUniverseAt || null,
      hist: S.hist || [], historyValidFrom: S.historyValidFrom || 0,
      // where the tape is coming from, so "no fills" can be told apart from "not listening"
      feed: stream ? { mode: 'stream', ...stream.health(), ...tape.stats() } : { mode: 'poll', ...tape.stats() },
      initial: cfg.initialBalance, enabled: cfg.makerEnabled,
      quoting: universe.length, tracked: markets.length,
      inv: markets.reduce((a, m) => a + Math.abs(m.inv || 0), 0),
      mark: r2(markets.reduce((a, m) => a + m.mark, 0)),
      markets: markets.slice(0, 40),
    };
  }

  return { step, flatten, resume, snapshot, noteCrawl, blockedOnScan: () => blocked };
}

module.exports = { makeMakerDesk };

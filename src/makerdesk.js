'use strict';
// The MAKER desk's loop and ledger. src/maker.js holds the pure decisions; this owns state,
// I/O and sequencing -- the same split as decide.js versus agents.js.
const ks = require('./venues/kalshi');
const http = require('./http');
const maker = require('./maker');

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
//             real depth took it from +$2187 to +$210; splitting by this number put the entire
//             remaining edge in markets that clear inside a day.
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
  } catch { /* unmeasurable is not tradeable: tpd 0 and clear Infinity both fail the filter */ }
  statCache.set(ticker, { v, at: Date.now() });
  return v;
}

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const c = (x) => `${(x * 100).toFixed(1)}c`;
const money = (x) => `$${Math.abs(x).toFixed(2)}`;

function makeMakerDesk(cfg) {
  let universe = [];         // tickers we are quoting
  let eligible = null;       // series that actually charge makers nothing
  let lastUniverseAt = 0;
  let refreshing = null;     // in-flight refresh, so the scan never runs twice or blocks the tick

  // Pick the most liquid mid-priced markets from the fee-free series.
  async function refreshUniverse(E) {
    if (!eligible) {
      eligible = await maker.eligibleSeries(cfg.makerSeries);
      const rejected = cfg.makerSeries.filter((s) => !eligible.includes(s));
      E.log('MAKR', 'OPS', null, `${eligible.length}/${cfg.makerSeries.length} candidate series charge makers nothing${rejected.length ? ` · excluded ${rejected.join(', ')}` : ''}`);
    }
    const rows = [];
    const failed = [];
    for (const s of eligible) {
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
          const days = m.close_time ? (Date.parse(m.close_time) - Date.now()) / 86400000 : 0;
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
    if (failed.length) E.log('MAKR', 'OPS', null, `universe scan incomplete: ${failed.length}/${eligible.length} series failed to load (${failed.slice(0, 3).join(', ')}) · quoting from the rest`);
    // Rank by how fast the queue in front of us clears, not by spread and not by volume. Spread
    // was backwards in the first version -- P&L correlates -0.33 with it, and ranking on it put six
    // dead markets at 10-14c on the book with zero fills. Volume was better but still wrong: it is
    // a snapshot, and it says nothing about how many orders are already ahead of us at that price.
    // Scored with each market's real measured depth, this rule returns +$240 in development and
    // +$160 out of sample, against +$199 / +$109 for ranking on trade rate alone.
    rows.sort((x, y) => (y.vol - x.vol) || (y.spread - x.spread));
    const probe = rows.slice(0, cfg.makerRateProbe);
    for (const r of probe) { Object.assign(r, await marketStats(r.ticker, r.depth)); await sleep(80); }
    const live = probe
      .filter((r) => r.tpd >= cfg.makerMinTradesPerDay && r.clear <= cfg.makerMaxClearDays)
      .sort((x, y) => x.clear - y.clear);
    universe = live.slice(0, cfg.makerMarkets);
    lastUniverseAt = Date.now();
    E.log('MAKR', 'SCAN', null, universe.length
      ? `quoting ${universe.length} of ${live.length} workable markets (${probe.length} probed, ${rows.length} passed the cheap filters) · ${universe.slice(0, 3).map((r) => `${r.ticker.split('-').slice(-2).join('-')} ${r.tpd.toFixed(0)}/day, queue ${Math.round(r.queue)} clears in ${r.clear < 1 ? `${(r.clear * 24).toFixed(1)}h` : `${r.clear.toFixed(1)}d`}`).join(' · ')}${universe.length > 3 ? '…' : ''}`
      : `no market meets the bar (spread >= ${c(cfg.makerMinSpread)}, >= ${cfg.makerMinTradesPerDay} trades/day, queue clearing inside ${cfg.makerMaxClearDays}d)`);
  }

  function book(E) {
    const s = E.state.maker;
    if (!s.markets) s.markets = {};
    return s;
  }

  async function step(E) {
    if (!cfg.makerEnabled) return;
    const S = book(E);

    // Own drawdown rail. TESS watches the taker book and would never see this desk bleeding,
    // because the two ledgers are separate on purpose.
    const dd = (cfg.initialBalance - (S.equity ?? cfg.initialBalance)) / cfg.initialBalance;
    if (dd >= cfg.makerMaxDrawdownPct && !S.halted) {
      S.halted = `maker drawdown ${(dd * 100).toFixed(1)}% hit the ${(cfg.makerMaxDrawdownPct * 100).toFixed(0)}% limit`;
      E.log('MAKR', 'OPS', null, `HALT · ${S.halted} · quotes withdrawn, inventory held and marked`);
      E.journal(E, 'MAKER_HALT', { reason: S.halted, equity: S.equity });
    }
    // A halt means stop QUOTING. Existing inventory is still marked; withdrawing quotes is the
    // maker equivalent of KETT standing down.
    if (E.halt || S.halted) {
      for (const m of Object.values(S.markets)) m.quotes = { bid: null, ask: null };
      E.touch('MAKR', 'quotes withdrawn');
      return;
    }
    // The scan costs 38 series listings plus 40 trade-rate probes -- about 23 seconds, against a
    // 15-second tick. Awaiting it made the whole desk skip ticks every fifteen minutes, taker side
    // included. The first one has to block (there is nothing to quote yet); after that it runs in
    // the background off the previous universe, guarded so it can never overlap itself.
    const stale = Date.now() - lastUniverseAt > 15 * 60 * 1000;
    if (!universe.length) await refreshUniverse(E);
    else if (stale && !refreshing) {
      refreshing = refreshUniverse(E)
        .catch((e) => E.log('MAKR', 'OPS', null, `universe refresh failed (${String(e.message).slice(0, 80)}) · still quoting the previous ${universe.length}`))
        .finally(() => { refreshing = null; });
    }

    // Anything we still hold stays in the loop even after it drops out of the universe. Otherwise
    // rotating the book strands inventory: no quotes, no fills, and a mark that freezes at whatever
    // the mid was the last time we looked. Pinned markets are quoted on the REDUCING side only, so
    // a name we no longer want to make gets worked off rather than added to.
    const pinned = Object.entries(S.markets)
      .filter(([t, m]) => m.inv !== 0 && !universe.some((u) => u.ticker === t))
      .map(([ticker, m]) => ({ ticker, series: m.series, reduceOnly: true }));
    if (pinned.length) E.touch('MAKR', `${pinned.length} pinned to work off`);

    let filled = 0, netQty = 0;
    for (const u of [...universe, ...pinned]) {
      const m = S.markets[u.ticker] || (S.markets[u.ticker] = { series: u.series, inv: 0, cost: 0, realized: 0, fills: 0, quotes: { bid: null, ask: null }, seen: [] });
      // A ticker like KXBALANCEPOWERCOMBO-27FEB-RR says nothing about what is being traded. Keep
      // the exchange's own words for it, and keep them on the ledger so a market that drops out of
      // the universe can still say what it was.
      if (u.title) { m.title = u.title; m.sub = u.sub || ''; }
      let trades = [], bk = null;
      try {
        const d = await getWithBackoff(`${ks.BASE}/markets/trades?ticker=${u.ticker}&limit=200`);
        trades = (d.trades || []).slice().reverse();       // oldest first
        bk = await ks.fetchBook(u.ticker);
      } catch { continue; }

      // 1) fill the quotes we were ALREADY resting, against trades that have since arrived
      const seen = new Set(m.seen);
      const { fills, queue } = maker.fillsFrom(trades, m.quotes, m.inv, cfg, seen, m.queue);
      m.queue = queue;                                     // what is still ahead of us, carried forward
      for (const f of fills) {
        // REALISED profit, which is the only number that is actually money.
        //
        // `cash` is not profit and never was: it falls when we buy and rises when we sell, so a
        // net-short book shows a large positive cash balance that is simply proceeds from
        // contracts we still owe. Calling that "banked from spread" was wrong, and it read as
        // +$51 of earnings on a book that had earned nothing. Profit only exists when a fill
        // CLOSES part of a position, and it is the difference between what that slice was opened
        // at and what it was closed at.
        const dir = f.side === 'buy' ? 1 : -1;
        const closing = Math.min(Math.abs(m.inv), f.qty) * (Math.sign(m.inv) === -dir ? 1 : 0);
        if (closing > 0) {
          const avg = Math.abs(m.cost / m.inv);              // weighted average of the open side
          const pnl = m.inv > 0 ? (f.px - avg) * closing : (avg - f.px) * closing;
          m.realized = r2((m.realized || 0) + pnl);
          S.realized = r2((S.realized || 0) + pnl);
        }
        if (f.side === 'buy') { S.cash = r2(S.cash - f.qty * f.px); m.inv += f.qty; m.cost = r2(m.cost + f.qty * f.px); }
        else { S.cash = r2(S.cash + f.qty * f.px); m.inv -= f.qty; m.cost = r2(m.cost - f.qty * f.px); }
        if (m.inv === 0) m.cost = 0;                          // flat means no basis to carry
        m.fills++; S.fills = (S.fills || 0) + 1; filled++; netQty += f.qty;
        // remembered for the dashboard: "nothing is happening" and "something happened four
        // minutes ago" look identical unless the page can say which.
        S.lastFill = { ticker: u.ticker, side: f.side, qty: f.qty, px: f.px, at: Date.now() };
        (S.recent = S.recent || []).unshift(S.lastFill);
        if (S.recent.length > 14) S.recent.length = 14;   // the floor shows ten; the journal keeps them all
        seen.add(f.id);
        E.journal(E, 'MAKER_FILL', { ticker: u.ticker, side: f.side, qty: f.qty, px: f.px, tradePx: f.tradePx, runOver: f.runOver, inv: m.inv });
      }
      for (const t of trades) seen.add(t.trade_id);
      m.seen = [...seen].slice(-400);                       // bounded

      // 2) rest a fresh quote for the next cycle
      await sleep(80);                     // pace per-market polling too
      const q = maker.desiredQuotes(bk, m.inv, cfg);
      // reduce-only: drop whichever side would grow the position
      const next = u.reduceOnly
        ? { bid: m.inv < 0 ? q.bid : null, ask: m.inv > 0 ? q.ask : null }
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
      m.why = q.why || null;
    }

    // mark inventory at the current mid
    let inv = 0, mtm = 0;
    for (const m of Object.values(S.markets)) { inv += Math.abs(m.inv); mtm += m.inv * (m.mid ?? 0.5); }
    S.equity = r2(S.cash + mtm);

    // Equity history. The board could say what the desk is worth right now but never which way it
    // had been going, and for a market maker that is the whole question -- banked cash only ever
    // rises, so the shape of the mark against it is the actual P&L story. Sampled once a minute and
    // capped at twelve hours; older points are dropped rather than thinned, because a chart that
    // silently changes resolution partway along is worse than a short one.
    const nowMs = Date.now();
    S.hist = S.hist || [];
    const last = S.hist[S.hist.length - 1];
    if (!last || nowMs - last.t >= 60000) {
      S.hist.push({ t: nowMs, c: r2(S.realized || 0), m: r2(mtm), e: r2(S.equity - cfg.initialBalance) });
      const cutoff = nowMs - 12 * 3600 * 1000;
      while (S.hist.length && S.hist[0].t < cutoff) S.hist.shift();
      if (S.hist.length > 800) S.hist.splice(0, S.hist.length - 800);
    }
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
      S.cash = r2(S.cash + m.inv * px - fee);
      E.journal(E, 'MAKER_FLATTEN', { ticker, qty: m.inv, px, fee, reason });
      contracts += Math.abs(m.inv); closed++;
      m.inv = 0; m.cost = 0;
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
        ticker, series: m.series, inv: m.inv, cost: m.cost, fills: m.fills,
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
      lastFill: S.lastFill || null, recent: (S.recent || []).slice(0, 12), lastScanAt: lastUniverseAt || null,
      hist: S.hist || [],
      initial: cfg.initialBalance, enabled: cfg.makerEnabled,
      quoting: universe.length, tracked: markets.length,
      inv: markets.reduce((a, m) => a + Math.abs(m.inv || 0), 0),
      mark: r2(markets.reduce((a, m) => a + m.mark, 0)),
      markets: markets.slice(0, 40),
    };
  }

  return { step, flatten, resume, snapshot };
}

module.exports = { makeMakerDesk };

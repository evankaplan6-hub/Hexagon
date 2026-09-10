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

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const c = (x) => `${(x * 100).toFixed(1)}c`;
const money = (x) => `$${Math.abs(x).toFixed(2)}`;

function makeMakerDesk(cfg) {
  let universe = [];         // tickers we are quoting
  let eligible = null;       // series that actually charge makers nothing
  let lastUniverseAt = 0;

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
          rows.push({ ticker: m.ticker, series: s, vol: v, spread: a - b, title: m.title });
        }
      } catch (e) { failed.push(s); }
      await sleep(150);                    // pace the scan; it runs once every 15 minutes
    }
    // A partial scan silently narrows the universe to whatever survived, so say so.
    if (failed.length) E.log('MAKR', 'OPS', null, `universe scan incomplete: ${failed.length}/${eligible.length} series failed to load (${failed.slice(0, 3).join(', ')}) · quoting from the rest`);
    // Rank by ACTIVITY, not spread. This was backwards in the first version and it matters more
    // than any other choice here: over 34 backtested markets P&L correlates +0.82 with trade count
    // and -0.33 with median spread. Ranking by spread selects the dead markets, which is exactly
    // what it did on the first live run -- six markets quoted at 10-14c, zero fills.
    rows.sort((x, y) => (y.vol - x.vol) || (y.spread - x.spread));
    universe = rows.slice(0, cfg.makerMarkets);
    lastUniverseAt = Date.now();
    E.log('MAKR', 'SCAN', null, universe.length
      ? `quoting ${universe.length} markets · ${universe.slice(0, 3).map((r) => `${r.ticker.split('-').slice(-2).join('-')} ${c(r.spread)} $${Math.round(r.vol / 1000)}k`).join(', ')}${universe.length > 3 ? '…' : ''}`
      : `no market meets the bar (spread >= ${c(cfg.makerMinSpread)}, vol24 >= $${cfg.makerMinVol24}, mid ${cfg.makerMinMid}-${cfg.makerMaxMid})`);
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
    if (!universe.length || Date.now() - lastUniverseAt > 15 * 60 * 1000) await refreshUniverse(E);

    let filled = 0, netQty = 0;
    for (const u of universe) {
      const m = S.markets[u.ticker] || (S.markets[u.ticker] = { series: u.series, inv: 0, cost: 0, realized: 0, fills: 0, quotes: { bid: null, ask: null }, seen: [] });
      let trades = [], bk = null;
      try {
        const d = await getWithBackoff(`${ks.BASE}/markets/trades?ticker=${u.ticker}&limit=200`);
        trades = (d.trades || []).slice().reverse();       // oldest first
        bk = await ks.fetchBook(u.ticker);
      } catch { continue; }

      // 1) fill the quotes we were ALREADY resting, against trades that have since arrived
      const seen = new Set(m.seen);
      const fills = maker.fillsFrom(trades, m.quotes, m.inv, cfg, seen);
      for (const f of fills) {
        if (f.side === 'buy') { S.cash = r2(S.cash - f.qty * f.px); m.inv += f.qty; m.cost = r2(m.cost + f.qty * f.px); }
        else { S.cash = r2(S.cash + f.qty * f.px); m.inv -= f.qty; m.cost = r2(m.cost - f.qty * f.px); }
        m.fills++; S.fills = (S.fills || 0) + 1; filled++; netQty += f.qty;
        seen.add(f.id);
        E.journal(E, 'MAKER_FILL', { ticker: u.ticker, side: f.side, qty: f.qty, px: f.px, tradePx: f.tradePx, runOver: f.runOver, inv: m.inv });
      }
      for (const t of trades) seen.add(t.trade_id);
      m.seen = [...seen].slice(-400);                       // bounded

      // 2) rest a fresh quote for the next cycle
      await sleep(80);                     // pace per-market polling too
      const q = maker.desiredQuotes(bk, m.inv, cfg);
      m.quotes = { bid: q.bid, ask: q.ask };
      m.mid = q.mid ?? m.mid;
      m.spread = q.spread ?? null;
      m.why = q.why || null;
    }

    // mark inventory at the current mid
    let inv = 0, mtm = 0;
    for (const m of Object.values(S.markets)) { inv += Math.abs(m.inv); mtm += m.inv * (m.mid ?? 0.5); }
    S.equity = r2(S.cash + mtm);
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

  return { step, flatten, resume, snapshot: (E) => ({ ...(E.state.maker || {}), universe: universe.map((u) => u.ticker) }) };
}

module.exports = { makeMakerDesk };

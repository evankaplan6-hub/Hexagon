'use strict';
// Whale watch: what the best sports bettors on Polymarket just bought.
//
// Every Polymarket fill is public, and the data API serves it per wallet with no key, alongside a
// sports leaderboard. Paid "insider trackers" (sharpai.us's is the one this replaced) are this
// feed repackaged: a leaderboard wallet, the market, the side, the size.
//
// ADVISORY ONLY. Nothing here opens a position or feeds a signal. Whether copying these wallets
// makes money after the price has moved and the fee is paid is a question with an answer, and
// tools/whale-lab.js is where it gets asked, on bets that have already settled. Until that says
// yes, this desk narrates and records.
//
// The core (betsFrom) is pure and shared with the lab, so the notice the floor shows and the bet
// the backtest scores are the same event: the fill that took a wallet's recent buying on one
// outcome past `minUsd`.
const fs = require('fs');
const path = require('path');
const pm = require('./venues/polymarket');

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// Fills -> bets. A bet is the moment one wallet's BUYs on one outcome of one market, summed over
// the trailing `windowSec`, first reach `minUsd`. One bet per wallet/market/outcome: a wallet
// that keeps adding is still one call, priced where it became a big one -- which is the earliest
// a copier watching the feed could have known. Sells inside the window net against the buys, so
// a market maker cycling inventory does not read as conviction.
//
// `hedged` marks a bet whose wallet ALSO crossed the bar on another outcome of the same market.
// That is a trader managing a book, not taking a side, and copying both halves pays fees on
// nothing.
function betsFrom(fills, { minUsd = 10000, windowSec = 6 * 3600 } = {}) {
  const groups = new Map();
  for (const f of fills) {
    if (!f || !f.conditionId || !Number.isFinite(f.usd) || !Number.isFinite(f.ts)) continue;
    const key = `${f.wallet}|${f.conditionId}|${f.outcomeIndex}`;
    (groups.get(key) || groups.set(key, []).get(key)).push(f);
  }
  const bets = [];
  for (const [key, list] of groups) {
    list.sort((a, b) => a.ts - b.ts);
    let lo = 0, net = 0, bought = 0, shares = 0;
    for (let i = 0; i < list.length; i++) {
      const f = list[i];
      const signed = f.side === 'SELL' ? -f.usd : f.usd;
      net += signed;
      if (f.side === 'BUY') { bought += f.usd; shares += f.size; }
      while (list[lo].ts < f.ts - windowSec) {
        const o = list[lo++];
        net -= o.side === 'SELL' ? -o.usd : o.usd;
        if (o.side === 'BUY') { bought -= o.usd; shares -= o.size; }
      }
      if (f.side !== 'BUY' || net < minUsd) continue;
      bets.push({
        key, wallet: f.wallet, name: f.name, conditionId: f.conditionId, outcomeIndex: f.outcomeIndex, outcome: f.outcome,
        title: f.title, slug: f.slug, eventSlug: f.eventSlug,
        ts: f.ts, price: f.price, usd: Math.round(net), avg: shares > 0 ? bought / shares : f.price, tx: f.tx,
        hedged: false,
      });
      break;
    }
  }
  const sides = new Map();
  for (const b of bets) {
    const k = `${b.wallet}|${b.conditionId}`;
    sides.set(k, (sides.get(k) || 0) + 1);
  }
  for (const b of bets) b.hedged = sides.get(`${b.wallet}|${b.conditionId}`) > 1;
  return bets.sort((a, b) => a.ts - b.ts);
}

const usdShort = (x) => {
  const a = Math.abs(x);
  return `$${a >= 1e6 ? `${(a / 1e6).toFixed(1)}M` : a >= 1e3 ? `${Math.round(a / 1e3)}K` : Math.round(a)}`;
};
const cents = (p) => `${Math.round(p * 100)}c`;

// What the desk already knows about this market: the Kalshi price of the SAME outcome where HOLT
// has matched it (pair.pm.tokenIndex is the Polymarket outcome the pair's YES stands for), and
// whether the game had started when the bet was made. Only markets in the scanned universe.
function context(E, bet) {
  const m = [...E.quotes.pm.values()].find((x) => x.conditionId === bet.conditionId);
  if (!m) return {};
  const start = m.gameStart ? Date.parse(String(m.gameStart).replace(' ', 'T').replace(/\+00$/, 'Z')) : NaN;
  const out = { inPlay: Number.isFinite(start) ? bet.ts * 1000 >= start : null };
  const pair = E.pairs.find((p) => p.pm.id === m.id && p.q);
  if (pair) out.ks = { label: pair.label, px: bet.outcomeIndex === pair.pm.tokenIndex ? pair.q.ksMid : 1 - pair.q.ksMid };
  return out;
}

// "No" or "Over" says nothing on its own; those carry the market in the first clause.
const GENERIC = /^(yes|no|over|under)$/i;

// One sentence for the log, in the shape public/app.js turns into a bubble:
//   "<who> bought $54K on <outcome> at 55c · <market> · #6 in sports this month, +$827K · Kalshi 57c now"
//   "<who> bought $12K on No (Will Getafe CF win on 2026-09-13?) at 84c · #9 in sports this month, +$310K"
function describe(bet, w, ctx = {}) {
  const who = bet.name || (w && w.name) || `${bet.wallet.slice(0, 6)}…`;
  const outcome = bet.outcome || `outcome ${bet.outcomeIndex}`;
  const generic = GENERIC.test(outcome) && bet.title;
  let t = `${who} bought ${usdShort(bet.usd)} on ${generic ? `${outcome} (${bet.title})` : outcome} at ${cents(bet.price)}`;
  if (!generic && bet.title) t += ` · ${bet.title}`;
  if (w && w.rank) t += ` · #${w.rank} in sports this ${w.period.toLowerCase()}, ${w.pnl >= 0 ? '+' : '−'}${usdShort(w.pnl)}`;
  if (ctx.ks) t += ` · Kalshi ${cents(ctx.ks.px)} now`;   // now, not when the bet was made
  if (ctx.inPlay) t += ' · during the game';
  if (bet.hedged) t += ' · bet both sides, likely hedging';
  return t;
}

function makeWhaleWatch(cfg) {
  const wallets = new Map();        // wallet -> { name, rank, pnl, vol, period }
  const announced = new Map();      // bet key -> ts, so a restart does not repeat and a bet is said once
  const recent = [];                // newest first, for the snapshot
  let order = [], cursor = 0, boardAt = 0, running = false, lastError = '', polls = 0;

  async function loadBoard(E) {
    const rows = [];
    for (let off = 0; off < cfg.whaleTop; off += 50) {
      const page = await pm.fetchLeaderboard({ category: 'SPORTS', period: cfg.whalePeriod, orderBy: 'PNL', limit: Math.min(50, cfg.whaleTop - off), offset: off });
      rows.push(...page);
      if (page.length < 50) break;
    }
    const keep = rows.filter((r) => r.pnl > 0).slice(0, cfg.whaleTop);
    if (!keep.length) throw new Error('sports leaderboard came back empty');
    const first = !wallets.size;
    wallets.clear();
    for (const r of keep) wallets.set(r.wallet, { ...r, period: cfg.whalePeriod });
    order = [...wallets.keys()];
    cursor %= order.length;
    boardAt = Date.now();
    if (first) E.log('ILSA', 'SCAN', null, `whale watch on · following the top ${order.length} Polymarket sports wallets this ${cfg.whalePeriod.toLowerCase()} · bets of ${usdShort(cfg.whaleMinUsd)}+ get called out`);
  }

  function record(E, bet, w, ctx) {
    if (!cfg.record) return;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const line = JSON.stringify({ t: new Date().toISOString(), ...bet, rank: w ? w.rank : null, walletPnl: w ? Math.round(w.pnl) : null, kalshi: ctx.ks ? Math.round(ctx.ks.px * 1000) / 1000 : null, inPlay: ctx.inPlay ?? null });
      fs.appendFileSync(path.join(cfg.dataDir, `whales-${ET_DAY.format(new Date())}.jsonl`), line + '\n');
    } catch { /* the record is a convenience for later scoring; never take the desk down for it */ }
  }

  async function poll(E, wallet) {
    const now = Math.floor(Date.now() / 1000);
    const fills = await pm.fetchActivity(wallet, { limit: 500, start: now - cfg.whaleWindowMin * 60 });
    polls++;
    const w = wallets.get(wallet);
    for (const bet of betsFrom(fills, { minUsd: cfg.whaleMinUsd, windowSec: cfg.whaleWindowMin * 60 })) {
      if (announced.has(bet.key)) continue;
      announced.set(bet.key, bet.ts);
      // Old news is recorded as seen but not announced: on a restart the last six hours of bets
      // would otherwise all land on the floor at once.
      if (now - bet.ts > cfg.whaleFreshMin * 60) continue;
      const ctx = context(E, bet);
      const text = describe(bet, w, ctx);
      recent.unshift({ at: bet.ts * 1000, wallet: bet.wallet, name: bet.name || (w && w.name) || '', rank: w ? w.rank : null, outcome: bet.outcome, title: bet.title, usd: bet.usd, price: bet.price, kalshi: ctx.ks ? ctx.ks.px : null, inPlay: ctx.inPlay ?? null, hedged: bet.hedged, url: bet.eventSlug ? `https://polymarket.com/event/${bet.eventSlug}` : null });
      if (recent.length > 20) recent.length = 20;
      record(E, bet, w, ctx);
      E.log('ILSA', 'WHALE', null, text);
    }
  }

  async function step(E) {
    if (running) return;
    running = true;
    try {
      if (!wallets.size || Date.now() - boardAt > cfg.whaleBoardMin * 60000) await loadBoard(E);
      const batch = [];
      for (let i = 0; i < Math.min(cfg.whalePerPoll, order.length); i++) batch.push(order[(cursor + i) % order.length]);
      cursor = (cursor + batch.length) % Math.max(1, order.length);
      for (const wallet of batch) await poll(E, wallet);
      const cut = Math.floor(Date.now() / 1000) - 2 * cfg.whaleWindowMin * 60;
      for (const [k, ts] of announced) if (ts < cut) announced.delete(k);
      lastError = '';
    } catch (e) {
      lastError = String(e.message || e).slice(0, 140);
      if (E.due('whale-err', 600)) E.log('ILSA', 'OPS', null, `whale watch could not reach Polymarket's trade feed: ${lastError}`);
    } finally { running = false; }
  }

  function snapshot() {
    return { enabled: true, watching: wallets.size, period: cfg.whalePeriod, minUsd: cfg.whaleMinUsd, polls, boardAt, lastError, recent: recent.slice(0, 10) };
  }

  return { step, snapshot };
}

module.exports = { betsFrom, describe, makeWhaleWatch };

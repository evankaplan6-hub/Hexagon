'use strict';
// Whale watch: what Polymarket's best bettors just bought -- sports, politics, economics, crypto and
// the other leaderboards.
//
// Every Polymarket fill is public, and the data API serves it per wallet with no key, alongside a
// leaderboard per category. Paid "insider trackers" (sharpai.us's is the one this replaced) are this
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

const { ET_DAY } = require('./recorder');   // the Eastern day, one definition for every file that names one

// Fills -> bets. A bet is the moment one wallet's BUYs on one outcome of one market, summed over
// the trailing `windowSec`, first reach `minUsd`. One bet per wallet/market/outcome: a wallet
// that keeps adding is still one call, priced where it became a big one -- which is the earliest
// a copier watching the feed could have known. Sells inside the window net against the buys, so
// a market maker cycling inventory does not read as conviction.
//
// `hedged` marks a bet whose wallet ALSO crossed the bar on another outcome of the same market.
// That is a trader managing a book, not taking a side, and copying both halves pays fees on
// nothing.
//
// A fill under an outcome the feed has not indexed yet (999) is skipped here as well as in
// normalizeFill, because the lab's cache on disk was normalized before that check existed. Rows
// that are identical in every field all count: one read of /activity has no overlap to repeat a
// row, and the feed does serve separate real fills that look exactly alike (see pm.fillKey), so
// collapsing them would hide real buying -- three $4,800 fills in one tx would never reach $10K.
function betsFrom(fills, { minUsd = 10000, windowSec = 6 * 3600 } = {}) {
  const groups = new Map();
  for (const f of fills) {
    if (!f || !f.conditionId || !Number.isFinite(f.usd) || !Number.isFinite(f.ts)) continue;
    if (pm.outcomeIndex(f.outcomeIndex) == null) continue;
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
// `w.category` is the leaderboard the wallet ranks best on; a wallet from before the watch followed
// more than one board has none, and was on the sports board.
function describe(bet, w, ctx = {}) {
  const who = bet.name || (w && w.name) || `${bet.wallet.slice(0, 6)}…`;
  const outcome = bet.outcome || `outcome ${bet.outcomeIndex}`;
  const generic = GENERIC.test(outcome) && bet.title;
  let t = `${who} bought ${usdShort(bet.usd)} on ${generic ? `${outcome} (${bet.title})` : outcome} at ${cents(bet.price)}`;
  if (!generic && bet.title) t += ` · ${bet.title}`;
  if (w && w.rank) t += ` · #${w.rank} in ${String(w.category || 'sports').toLowerCase()} this ${w.period.toLowerCase()}, ${w.pnl >= 0 ? '+' : '−'}${usdShort(w.pnl)}`;
  if (ctx.ks) t += ` · Kalshi ${cents(ctx.ks.px)} now`;   // now, not when the bet was made
  if (ctx.inPlay) t += ' · during the game';
  if (bet.hedged) t += ' · bet both sides, likely hedging';
  return t;
}

// ---------------------------------------------------------------- the record
// Every called bet is a line in whales-YYYY-MM-DD.jsonl under dataDir, the ET day it was called.
const recordPath = (dir, day) => path.join(dir, `whales-${day}.jsonl`);

// The ET days whose files can hold a bet made since `fromMs`. A bet is called after it is made, so
// its line is in the file of that day or a later one, up to today's. Twelve-hour steps cannot jump
// a day, not even the 23-hour one in spring.
function recordDays(fromMs, nowMs) {
  const days = new Set();
  for (let ms = fromMs; ms < nowMs; ms += 12 * 3600e3) days.add(ET_DAY.format(new Date(ms)));
  days.add(ET_DAY.format(new Date(nowMs)));
  return [...days];
}

// The bets already called that were made at or after `fromTs` (unix seconds), one per key -- the
// first time it was said, since past restarts wrote repeats -- in the order they were called. A
// missing file is a quiet day. A torn or foreign line is skipped, and so is a record under an
// outcome the feed had not indexed yet: no bet can have that key any more.
function readRecord(dir, fromTs, nowMs) {
  const byKey = new Map();
  for (const day of recordDays(fromTs * 1000, nowMs)) {
    let text;
    try { text = fs.readFileSync(recordPath(dir, day), 'utf8'); } catch { continue; }
    for (const line of text.split('\n')) {
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (!r || typeof r.key !== 'string' || !Number.isFinite(r.ts) || r.ts < fromTs || pm.outcomeIndex(r.outcomeIndex) == null) continue;
      if (!byKey.has(r.key)) byKey.set(r.key, r);
    }
  }
  const said = (r) => { const t = Date.parse(r.t); return Number.isFinite(t) ? t : r.ts * 1000; };
  return [...byKey.values()].sort((a, b) => said(a) - said(b));
}

// One row of the snapshot's `recent`, from a bet in its recorded shape (the bet plus rank, kalshi
// and inPlay). A bet just called and one read back after a restart go through here, so the two
// cannot drift apart; a field an old or hand-edited line lacks comes out null, never undefined.
const orNull = (x) => (x === undefined ? null : x);
function panelEntry(r) {
  return {
    at: r.ts * 1000, wallet: r.wallet || '', name: r.name || '', rank: orNull(r.rank), board: r.board || 'SPORTS', outcome: r.outcome || '', title: r.title || '',
    usd: Number.isFinite(r.usd) ? r.usd : null, price: Number.isFinite(r.price) ? r.price : null,
    kalshi: orNull(r.kalshi), inPlay: orNull(r.inPlay), hedged: !!r.hedged,
    url: r.eventSlug ? `https://polymarket.com/event/${r.eventSlug}` : null,
  };
}

// The leaderboards Polymarket's data API accepts, checked 2026-09-14: GEOPOLITICS, ELECTIONS, SCIENCE
// and WORLD come back HTTP 400 "invalid category parameter", and each refused call counts toward
// TESS's API-error halt, so a typo in WHALE_CATEGORIES is dropped here rather than sent every 30 min.
const BOARDS = ['SPORTS', 'POLITICS', 'ECONOMICS', 'CRYPTO', 'CULTURE', 'TECH', 'FINANCE', 'WEATHER', 'MENTIONS', 'OVERALL'];

// Which boards to follow, how deep, and how big a bet has to be on each. Sports keeps the watch's
// original settings. The others are shallower and their bar lower, because their best wallets bet
// smaller: over one day the top 8 wallets on each board made 6 bets of $10K+ on economics, 3 on
// tech, 2 each on politics and finance, 1 on crypto -- and none on weather or mentions, which are
// left out by default. A config without WHALE_CATEGORIES (an older .env, a test) follows sports only.
function boardsFrom(cfg) {
  const want = (cfg.whaleCategories && cfg.whaleCategories.length ? cfg.whaleCategories : ['SPORTS']).map((c) => String(c).toUpperCase());
  const out = [], unknown = [];
  for (const c of want) {
    if (!BOARDS.includes(c)) { unknown.push(c); continue; }
    if (out.some((b) => b.category === c)) continue;
    const sports = c === 'SPORTS';
    out.push({ category: c, top: sports ? cfg.whaleTop : (cfg.whaleTopOther ?? cfg.whaleTop), minUsd: sports ? cfg.whaleMinUsd : (cfg.whaleMinUsdOther ?? cfg.whaleMinUsd) });
  }
  return { boards: out, unknown };
}

function makeWhaleWatch(cfg) {
  const wallets = new Map();        // wallet -> { name, rank, pnl, vol, period, category, minUsd, ranks: [{category, rank, pnl}] }
  const { boards, unknown } = boardsFrom(cfg);
  // bet key -> bet ts: a bet is said once. Kept for twice the window, and in memory only, so the
  // first step reads it back from the record (restore) or every restart would say the last twenty
  // minutes of bets again.
  const announced = new Map();
  const recent = [];                // newest first, for the snapshot
  let order = [], cursor = 0, boardAt = 0, running = false, lastError = '', polls = 0, restored = false;
  const keepSec = () => 2 * cfg.whaleWindowMin * 60;
  const remember = (entry) => { recent.unshift(entry); if (recent.length > 20) recent.length = 20; };

  // Every deploy is a restart, and before this each one called the bets of the last twenty minutes
  // again: 16 of the box's first 151 record lines were repeats, after v26, v27 and v28. So the watch
  // starts from what the record says it already called over the span `announced` keeps, and puts
  // the latest back in `recent` -- without logging them again, since the floor's log is saved with
  // the ledger and kept them through the restart. With RECORD=0 nothing new is written to read
  // back, so there a restart still repeats.
  function restore() {
    const nowMs = Date.now();
    const calls = readRecord(cfg.dataDir, Math.floor(nowMs / 1000) - keepSec(), nowMs);
    for (const r of calls) { announced.set(r.key, r.ts); remember(panelEntry(r)); }
  }

  // Every followed board, merged by wallet. The same wallets top several boards (one was #1 in
  // finance, #2 in politics and #5 in tech on 2026-09-14), so a wallet keeps all its ranks, is shown
  // by its best one, and has a bet called at the lowest bar of the boards it is on. One board that
  // fails or comes back empty costs that board, not the whole reload.
  async function loadBoard(E) {
    const next = new Map();
    const failed = [];
    const counts = [];
    for (const b of boards) {
      try {
        const rows = [];
        for (let off = 0; off < b.top; off += 50) {
          const page = await pm.fetchLeaderboard({ category: b.category, period: cfg.whalePeriod, orderBy: 'PNL', limit: Math.min(50, b.top - off), offset: off });
          rows.push(...page);
          if (page.length < 50) break;
        }
        const keep = rows.filter((r) => r.pnl > 0).slice(0, b.top);
        counts.push(`${keep.length} ${b.category.toLowerCase()}`);
        for (const r of keep) {
          const cur = next.get(r.wallet) || { ...r, ranks: [], minUsd: Infinity };
          cur.ranks.push({ category: b.category, rank: r.rank, pnl: r.pnl });
          cur.minUsd = Math.min(cur.minUsd, b.minUsd);
          if (!cur.name && r.name) cur.name = r.name;
          next.set(r.wallet, cur);
        }
      } catch (e) {
        failed.push(`${b.category.toLowerCase()} (${String(e.message).slice(0, 60)})`);
      }
    }
    if (!next.size) throw new Error(failed.length ? `every leaderboard failed: ${failed.join(', ')}` : 'every leaderboard came back empty');
    for (const w of next.values()) {
      const best = w.ranks.slice().sort((a, b) => (a.rank - b.rank) || (b.pnl - a.pnl))[0];
      Object.assign(w, { rank: best.rank, pnl: best.pnl, category: best.category, period: cfg.whalePeriod });
    }
    const first = !wallets.size;
    wallets.clear();
    for (const [k, v] of next) wallets.set(k, v);
    order = [...wallets.keys()];
    for (const w of [...held.keys()]) if (!wallets.has(w)) held.delete(w);   // off every board: forget its fills
    cursor %= order.length;
    boardAt = Date.now();
    if (first) {
      const bars = [...new Set(boards.map((b) => b.minUsd))].sort((a, b) => b - a).map(usdShort).join(' or ');
      E.log('ILSA', 'SCAN', null, `whale watch on · following ${order.length} top Polymarket wallets this ${cfg.whalePeriod.toLowerCase()} across ${counts.join(', ')} · bets of ${bars}+ get called out${unknown.length ? ` · ignored unknown boards ${unknown.join(', ')}` : ''}`);
    }
    if (failed.length && E.due('whale-board-fail', 1800)) E.log('ILSA', 'OPS', null, `whale watch could not load ${failed.join(', ')} · following the other boards`);
  }

  function record(rec) {
    if (!cfg.record) return;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      const nowMs = Date.now();
      fs.appendFileSync(recordPath(cfg.dataDir, ET_DAY.format(new Date(nowMs))), JSON.stringify({ t: new Date(nowMs).toISOString(), ...rec }) + '\n');
    } catch { /* the record is a convenience for later scoring; never take the desk down for it */ }
  }

  // Each wallet's fills over the window, kept between reads, so a read only has to cover what may
  // have changed since the last one. It used to re-read the whole six hours on every visit: ~1.5 MB
  // a minute, on a box pinned at its CPU cap, to learn about the last three and a half minutes.
  //
  // A re-read REPLACES the stretch it covers rather than being de-duplicated into it, because a
  // repeated row is not a repeat (see pm.fillKey: one tx can hold identical real fills), and it
  // reaches back WHALE_REREAD_MIN before the last read, because the feed is late: it first serves a
  // new fill half-indexed and the corrected copy a read later, and a fill can be indexed after its
  // own timestamp. A page that comes back full may not reach back that far, so it is taken alone,
  // exactly as every read was before; and a wallet read for the first time is read whole.
  const held = new Map();           // wallet -> { fills, at }
  const HELD_MAX = 5000;            // fills per wallet: the busiest top wallets trade a few thousand in six hours

  async function poll(E, wallet) {
    const now = Math.floor(Date.now() / 1000);
    const winStart = now - cfg.whaleWindowMin * 60;
    const prev = held.get(wallet);
    const from = prev && prev.at > winStart ? Math.max(winStart, prev.at - (cfg.whaleRereadMin ?? 20) * 60) : winStart;
    // one second early, so a fill stamped exactly `from` is read whether the feed's `start` is
    // inclusive or not; the split below is on `from` itself
    const page = await pm.fetchActivityPage(wallet, { limit: 500, start: from > winStart ? from - 1 : from });
    polls++;
    let fills;
    if (!prev || from === winStart || page.rows >= 500) fills = page.fills;
    else fills = prev.fills.filter((f) => f.ts >= winStart && f.ts < from).concat(page.fills.filter((f) => f.ts >= from));
    if (fills.length > HELD_MAX) fills = fills.sort((a, b) => a.ts - b.ts).slice(-HELD_MAX);
    held.set(wallet, { fills, at: now });
    const w = wallets.get(wallet);
    const bar = w && Number.isFinite(w.minUsd) ? w.minUsd : cfg.whaleMinUsd;
    for (const bet of betsFrom(fills, { minUsd: bar, windowSec: cfg.whaleWindowMin * 60 })) {
      if (announced.has(bet.key)) continue;
      announced.set(bet.key, bet.ts);
      // Old news is recorded as seen but not announced: on a restart the last six hours of bets
      // would otherwise all land on the floor at once.
      if (now - bet.ts > cfg.whaleFreshMin * 60) continue;
      const ctx = context(E, bet);
      const text = describe(bet, w, ctx);
      // recorded as the floor named it: the fill's name, else the leaderboard's
      const rec = { ...bet, name: bet.name || (w && w.name) || '', rank: w ? w.rank : null, board: w ? w.category : null, ranks: w ? w.ranks : null, walletPnl: w ? Math.round(w.pnl) : null, kalshi: ctx.ks ? Math.round(ctx.ks.px * 1000) / 1000 : null, inPlay: ctx.inPlay ?? null };
      remember(panelEntry(rec));
      record(rec);
      E.log('ILSA', 'WHALE', null, text);
    }
  }

  async function step(E) {
    if (running) return;
    running = true;
    try {
      if (!restored) {
        restored = true;
        try { restore(); } catch { /* an unreadable record means a restart may repeat itself, never a desk that stops */ }
      }
      if (!wallets.size || Date.now() - boardAt > cfg.whaleBoardMin * 60000) await loadBoard(E);
      const batch = [];
      for (let i = 0; i < Math.min(cfg.whalePerPoll, order.length); i++) batch.push(order[(cursor + i) % order.length]);
      cursor = (cursor + batch.length) % Math.max(1, order.length);
      for (const wallet of batch) await poll(E, wallet);
      const cut = Math.floor(Date.now() / 1000) - keepSec();
      for (const [k, ts] of announced) if (ts < cut) announced.delete(k);
      lastError = '';
    } catch (e) {
      lastError = String(e.message || e).slice(0, 140);
      if (E.due('whale-err', 600)) E.log('ILSA', 'OPS', null, `whale watch could not reach Polymarket's trade feed: ${lastError}`);
    } finally { running = false; }
  }

  function snapshot() {
    // a full rotation: every followed wallet read once, WHALE_PER_POLL at a time every WHALE_EVERY_SEC
    const rotationSec = Math.round(Math.ceil(order.length / Math.max(1, cfg.whalePerPoll)) * (cfg.whaleEverySec || 15));
    return { enabled: true, watching: wallets.size, period: cfg.whalePeriod, minUsd: cfg.whaleMinUsd, boards: boards.map((b) => ({ ...b })), rotationSec, polls, boardAt, lastError, recent: recent.slice(0, 10) };
  }

  return { step, snapshot };
}

module.exports = { betsFrom, describe, makeWhaleWatch, recordDays, readRecord, panelEntry, boardsFrom, BOARDS };

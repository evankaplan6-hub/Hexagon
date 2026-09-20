'use strict';
// In-play cross-venue scan: every live game on both venues at once, net of fees.
//
// Read-only. Places nothing, holds nothing, needs no key. It exists because of a result the desk
// cannot see for itself: it refuses to trade a game from two minutes before kickoff
// (decide.liveWindow), and every cross-venue edge on a game is IN-PLAY. Pre-game the two venues
// agree to the cent -- on Sunday 2026-09-20 all 28 NFL legs priced within 1c and not one was
// locked -- while the same day's tape held 226 net-of-fee-positive in-play observations across 147
// distinct windows, median 26 seconds, the longest 391.
//
// ONE ROW PER GAME, and the trade is two BUYS. Kalshi has no naked short: "selling" a team means
// buying the other one, so pricing both legs separately reports the same trade twice -- the first
// version of this scan did exactly that and double-counted every window. The real position is
//   buy YES on team X at one venue + buy YES on team Y at the other
// which pays $1 whichever team wins, so it is locked when the two asks plus both fees come to less
// than $1. Two directions exist (PM X + KS Y, or PM Y + KS X) and they are NOT the same number:
// Kalshi lists each side as its own book, so kAskY is not always 1 - kBidX. The better of the two
// is the game's edge.
//
// Fees are the whole story, so no edge is printed without them:
//   Kalshi KXNFLGAME: fee_type `quadratic_with_maker_fees`, multiplier 1 -> taker 0.07 x P x (1-P).
//   Polymarket NFL moneyline: feeSchedule {rate 0, takerOnly} -> taker FREE.
// So the floor is the Kalshi leg alone, and it PEAKS at even money (1.75c) and collapses toward
// certainty (0.07c at 99c). Both checked live 2026-09-20.
//
// !! SETTLEMENT CAVEAT, and the reason nothing here says "arb" !!
// The two venues' rules agree on a tie (both 50-50) and on a postponement under 48 hours (both
// resolve on the result). They do NOT agree beyond that: Kalshi resolves a game not started within
// 48 hours "to a fair price", while Polymarket keeps the market open until the game is completed,
// or pays 50-50 only if it is cancelled outright with no make-up. A pair held through a long
// postponement is therefore not hedged -- one leg settles at a discretionary price and the other
// waits for a game played days later. Game pairs come from the FAST path (src/matcher.js), which
// runs no rules check at all, so nothing else in the desk guards this.
//
// WHAT THIS MEASURED, 2026-09-20. The listing endpoints (Kalshi /markets, Polymarket CLOB /prices)
// showed in-play edges constantly -- 4c, 8c, once 15c. Not one of them survived contact with the
// order book. Priced from the books alone, every live game on the slate sat between -1.3c and
// -3.0c, stable across rounds: the fee floor, which is what an efficient market looks like. The
// gap is between an indicative top-of-book and the thing you would actually have to trade against,
// and it is widest exactly when the game is moving fastest. So a positive number from the price
// endpoints is not an opportunity, it is a measurement artifact -- and that is why a window here
// opens on the book's verdict and nothing else.
//
//   node tools/inplay-scan.js                 one snapshot of every live game
//   node tools/inplay-scan.js --series KXNFLGAME
//   node tools/inplay-scan.js --watch         poll until stopped, logging to DATA_DIR
//   node tools/inplay-scan.js --watch --every 30 --until 2026-09-21T04:30:00Z
const fs = require('fs');
const path = require('path');
const https = require('https');
const cfg = require('../src/config');
const ks = require('../src/venues/kalshi');
const pm = require('../src/venues/polymarket');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

const SERIES = arg('series', 'KXNFLGAME,KXMLBGAME,KXNBAGAME,KXNCAAFGAME').split(',').map((s) => s.trim()).filter(Boolean);
const EVERY_MS = Math.max(10, +arg('every', 60)) * 1000;
const UNTIL = Date.parse(arg('until', '')) || (Date.now() + 12 * 3600e3);
const KS_RATE = cfg.ksFeeRate ?? 0.07;

const ksFee = (p, ref) => ks.feePerContract(p, KS_RATE, ref);
const c = (x) => (x == null || !Number.isFinite(x) ? '   -  ' : (x * 100).toFixed(1).padStart(5) + 'c');
const et = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit' });
// A request with no timeout does not fail, it HANGS -- and a hung request inside the watch loop
// stops the whole scan without an error line, so the process stays alive and writes nothing. That
// happened twice on 2026-09-20 (once when the laptop slept, once on the box) and both times the
// symptom was a healthy-looking pid and two hours of missing data. The repo's own http layer times
// out at 15s; this helper has to as well.
const get = (u, ms = 15000) => new Promise((res, rej) => {
  const req = https.get(u, { headers: { 'user-agent': 'hexagon-inplay-scan' } }, (r) => {
    let s = ''; r.on('data', (d) => (s += d));
    r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(`${r.statusCode} ${u}`)); } });
  });
  req.on('error', rej);
  req.setTimeout(ms, () => { req.destroy(new Error(`timeout after ${ms}ms: ${u}`)); });
});

// Kalshi abbreviates an NFL side to its city; Polymarket names the nickname. src/matcher.js carries
// the same map for the desk's own pairing -- this tool matches by Kalshi ticker instead, so it only
// needs the reverse direction to find Polymarket's market.
const NICK = { 'Tampa Bay': 'Buccaneers', Cleveland: 'Browns', Houston: 'Texans', Cincinnati: 'Bengals', 'New Orleans': 'Saints', Baltimore: 'Ravens', 'New York J': 'Jets', 'Green Bay': 'Packers', Carolina: 'Panthers', Atlanta: 'Falcons', Minnesota: 'Vikings', Chicago: 'Bears', Pittsburgh: 'Steelers', 'New England': 'Patriots', Tennessee: 'Titans', Philadelphia: 'Eagles', 'Las Vegas': 'Raiders', 'Los Angeles C': 'Chargers', Jacksonville: 'Jaguars', Denver: 'Broncos', Washington: 'Commanders', Dallas: 'Cowboys', 'San Francisco': '49ers', Miami: 'Dolphins', Seattle: 'Seahawks', Arizona: 'Cardinals', 'Kansas City': 'Chiefs', Indianapolis: 'Colts', 'New York G': 'Giants', 'Los Angeles R': 'Rams' };
const TAGS = { KXNFLGAME: 'nfl', KXMLBGAME: 'mlb', KXNBAGAME: 'nba', KXNCAAFGAME: 'cfb' };

let tokenCache = { at: 0, rows: [] };
async function moneylines() {
  // refreshed every 20 minutes: Polymarket posts the late games' books through the day
  if (Date.now() - tokenCache.at < 1200000) return tokenCache.rows;
  const tags = [...new Set(SERIES.map((s) => TAGS[s]).filter(Boolean))];
  const rows = [];
  for (const tag of tags) {
    const evs = await get(`https://gamma-api.polymarket.com/events?closed=false&limit=200&order=volume24hr&ascending=false&tag_slug=${tag}`);
    for (const e of evs) for (const m of e.markets || []) {
      if ((m.sportsMarketType || '') !== 'moneyline') continue;
      try {
        const outcomes = JSON.parse(m.outcomes), tok = JSON.parse(m.clobTokenIds);
        if (outcomes.length === 2 && tok.length === 2) rows.push({ outcomes, tok, start: m.gameStartTime, rate: pm.feeRateOf(m) });
      } catch { /* a malformed listing row is not worth failing the scan over */ }
    }
  }
  tokenCache = { at: Date.now(), rows };
  return rows;
}

async function snapshot() {
  // BOTH venues in one Promise.all. Sequential reads manufacture an edge that was never there: on a
  // fast in-play move a few hundred ms of skew is worth cents, and the first version of this scan
  // printed three "locked" arbs that vanished the moment the two reads were made together.
  const [kAll, ml] = await Promise.all([ks.fetchAll(SERIES), moneylines()]);
  const events = {};
  for (const m of kAll) (events[m.eventTicker] = events[m.eventTicker] || []).push(m);

  const games = [];
  for (const [ticker, legs] of Object.entries(events)) {
    if (legs.length !== 2) continue;
    const names = legs.map((m) => NICK[m.subTitle] || m.subTitle);
    const p = ml.find((x) => names.every((n) => x.outcomes.some((o) => o === n || o.endsWith(` ${n}`))));
    if (!p) continue;
    const startMs = Date.parse(String(p.start || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
    games.push({ ticker, legs, names, p, live: Number.isFinite(startMs) && startMs < Date.now() });
  }
  if (!games.length) return { rows: [], games: 0 };

  const prices = await pm.fetchPrices(games.flatMap((g) => g.p.tok));
  const rows = [];
  for (const g of games) {
    const side = [0, 1].map((i) => {
      const leg = g.legs[i], name = g.names[i];
      const j = g.p.outcomes.findIndex((o) => o === name || o.endsWith(` ${name}`));
      const q = prices.get(g.p.tok[j]);
      return q ? { leg, name, tok: g.p.tok[j], kBid: leg.yesBid, kAsk: leg.yesAsk, pBid: q.bid, pAsk: q.ask } : null;
    });
    if (side.some((x) => !x)) continue;
    const [X, Y] = side;
    const ok = (v) => Number.isFinite(v) && v > 0 && v < 1;
    if (![X.kBid, X.kAsk, X.pBid, X.pAsk, Y.kBid, Y.kAsk, Y.pBid, Y.pAsk].every(ok)) continue;
    // Buy one team on Polymarket and the OTHER on Kalshi: $1 comes back whoever wins.
    const leg = (P, K) => {
      const cost = P.pAsk + K.kAsk;
      const fees = pm.feePerShare(P.pAsk, g.p.rate) + ksFee(K.kAsk, K.leg.ticker);
      return { edge: 1 - cost - fees, cost, fees, buyPm: P.name, buyKs: K.name };
    };
    const a = leg(X, Y), b = leg(Y, X);
    const best = a.edge >= b.edge ? a : b;
    // Keep what each side of the chosen trade would have to be bought at, so depth can be checked
    // against the SAME prices the edge was computed from.
    best.pmSide = best.buyPm === X.name ? X : Y;
    best.ksSide = best.buyKs === X.name ? X : Y;
    rows.push({ at: Date.now(), game: g.ticker, live: g.live,
      teams: `${X.name}/${Y.name}`,
      ks: `${c(X.kBid)}/${c(X.kAsk)}`, pm: `${c(X.pBid)}/${c(X.pAsk)}`,
      // mid-to-mid on the SAME team, the plain statement of how far apart the venues are
      gap: +(((X.kBid + X.kAsk) / 2) - ((X.pBid + X.pAsk) / 2)).toFixed(4),
      edge: +best.edge.toFixed(4), fees: +best.fees.toFixed(4), rate: g.p.rate,
      _best: best,
      buy: `PM ${best.buyPm} @${c(best.buyPm === X.name ? X.pAsk : Y.pAsk)} + KS ${best.buyKs} @${c(best.buyKs === X.name ? X.kAsk : Y.kAsk)}`,
      other: +Math.min(a.edge, b.edge).toFixed(4) });
  }
  // Depth, but only where it can matter, and taken from the SAME snapshot as the price. An edge
  // computed from two top-of-book asks says nothing about size, and on a fast in-play move the
  // touch is often a handful of contracts: 15.3c on 12 contracts is $1.84, not an opportunity.
  //
  // The first version of this asked fetchPrices for the price and then fetched the book, and read
  // zero size every single time -- not because the books were empty but because the market had
  // moved during the extra round trip, so nothing sat at the price the edge had assumed. Price and
  // size must come from one read. So the books ARE the second opinion: the edge is recomputed from
  // them, which both revalidates it and sizes it, and a window that closed in the meantime simply
  // reports no size.
  //
  // Then walk the two ladders together. An arb buys one contract on each venue, so each unit is
  // limited by the thinner side, and it stops paying at the depth where the two asks plus fees stop
  // coming to less than $1 -- which is the honest answer to "how much of this is actually there".
  for (const r of rows) {
    if (r.edge <= 0) { delete r._best; continue; }
    const b = r._best; delete r._best;
    try {
      const [pb, kb] = await Promise.all([pm.fetchBook(b.pmSide.tok), ks.fetchBook(b.ksSide.leg.ticker)]);
      const pmAsks = (pb.asks || []).slice().sort((x, y) => x.price - y.price);
      const ksAsks = (kb.yesAsks || []).slice().sort((x, y) => x.price - y.price);
      let qty = 0, dollars = 0, i = 0, j = 0;
      let pmLeft = pmAsks[0] ? pmAsks[0].size : 0, ksLeft = ksAsks[0] ? ksAsks[0].size : 0;
      while (i < pmAsks.length && j < ksAsks.length) {
        const take = Math.min(pmLeft, ksLeft);
        if (!(take > 0)) break;
        const pp = pmAsks[i].price, kp = ksAsks[j].price;
        const per = 1 - pp - kp - pm.feePerShare(pp, r.rate) - ksFee(kp, b.ksSide.leg.ticker);
        if (per <= 0) break;
        qty += take; dollars += take * per;
        pmLeft -= take; ksLeft -= take;
        if (pmLeft <= 0) { i++; pmLeft = pmAsks[i] ? pmAsks[i].size : 0; }
        if (ksLeft <= 0) { j++; ksLeft = ksAsks[j] ? ksAsks[j].size : 0; }
      }
      r.qty = Math.floor(qty);
      r.dollars = +dollars.toFixed(2);
      // what the books say the touch is worth, which may differ from the listing-derived `edge`
      r.confirmed = pmAsks[0] && ksAsks[0]
        ? +(1 - pmAsks[0].price - ksAsks[0].price - pm.feePerShare(pmAsks[0].price, r.rate) - ksFee(ksAsks[0].price, b.ksSide.leg.ticker)).toFixed(4)
        : null;
    } catch { r.qty = null; r.dollars = null; r.confirmed = null; }
  }
  return { rows, games: games.length };
}

function print(rows) {
  const live = rows.filter((r) => r.live);
  console.log(`${'game'.padEnd(22)} ${'teams'.padEnd(26)} ${'KS'.padEnd(14)} ${'PM'.padEnd(14)} ${'gap'.padEnd(7)}${'edge'.padEnd(7)}${'fees'.padEnd(7)}`);
  for (const r of rows.sort((a, b) => b.edge - a.edge)) {
    console.log(`${r.game.replace(/^KX|GAME-/g, '').padEnd(22)} ${r.teams.padEnd(26)} ${r.ks} ${r.pm} ${c(r.gap)}${c(r.edge)}${c(r.fees)} ${r.live ? 'LIVE' : 'pre '}${r.edge > 0 ? `  <== ${r.buy}  ${r.qty == null ? '(depth unknown)' : `${r.qty} lots, $${r.dollars}${r.confirmed != null ? `, book says ${c(r.confirmed)}` : ''}`}` : ''}`);
  }
  const hit = live.filter((r) => r.edge > 0);
  const gaps = live.map((r) => Math.abs(r.gap)).sort((a, b) => a - b);
  console.log(`\n${live.length} live games · ${hit.length} clear both venues' fees · median gap ${c(gaps[Math.floor(gaps.length / 2)])} · widest ${c(gaps[gaps.length - 1])}`);
  console.log(`${rows.length - live.length} pre-game · both are flat once priced off the books; the listing endpoints are what look otherwise`);
}

(async () => {
  if (!flag('watch')) {
    const { rows, games } = await snapshot();
    if (!games) return console.log('no game paired on both venues right now');
    print(rows);
    console.log('\nNOTE: a pair held through a postponement of more than 48h is NOT hedged — Kalshi settles');
    console.log('at "a fair price" and Polymarket waits for the rescheduled game. See the header.');
    return;
  }
  const out = path.join(cfg.dataDir, `inplay-${new Date().toISOString().slice(0, 10)}.jsonl`);
  console.log(`${et(Date.now())}  in-play scan · ${SERIES.join(',')} · every ${EVERY_MS / 1000}s until ${et(UNTIL)} · ${out}`);
  const open = new Map();   // ticker -> the edge window currently running, so its LENGTH is recorded
  let polls = 0, fails = 0, written = 0, lastOk = Date.now(), lastBeat = Date.now();
  while (Date.now() < UNTIL) {
    try {
      // Belt as well as braces: even with every request bounded, one call stalling near its own
      // limit could still outrun the poll interval and stack up. A poll that overruns is abandoned.
      const { rows } = await Promise.race([
        snapshot(),
        new Promise((_, rej) => setTimeout(() => rej(new Error(`poll exceeded ${Math.round(EVERY_MS * 0.9 / 1000)}s, abandoned`)), EVERY_MS * 0.9)),
      ]);
      polls++; lastOk = Date.now();
      for (const r of rows) {
        fs.appendFileSync(out, JSON.stringify(r) + '\n'); written++;
        if (!r.live) continue;
        const run = open.get(r.game);
        const live = r.confirmed != null ? r.confirmed : -1;   // no book, no claim
        if (live > 0 && !run) { open.set(r.game, { start: r.at, peak: live }); console.log(`${et(r.at)}  OPEN  ${c(r.edge)} listed / ${r.confirmed == null ? '?' : c(r.confirmed)} on the book · ${r.qty == null ? '?' : r.qty} lots worth $${r.dollars == null ? '?' : r.dollars} · ${r.game.replace(/^KX|GAME-/g, '')} · ${r.buy}`); }
        else if (live > 0) { run.peak = Math.max(run.peak, live); }
        else if (run) { console.log(`${et(r.at)}  SHUT  after ${Math.round((r.at - run.start) / 1000)}s, peak ${c(run.peak)} · ${r.game.replace(/^KX|GAME-/g, '')}`); open.delete(r.game); }
      }
    } catch (e) { fails++; console.log(`${et(Date.now())}  poll failed: ${String(e.message).slice(0, 90)}`); }
    // Say something even when nothing happens. A scan with no edges and a scan that died look
    // identical in a log that only speaks on edges, and that is exactly how two hours went missing.
    if (Date.now() - lastBeat >= 1800000) {
      lastBeat = Date.now();
      console.log(`${et(Date.now())}  still watching · ${polls} polls, ${fails} failed, ${written} rows · last good poll ${et(lastOk)}`);
    }
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  console.log(`${et(Date.now())}  done`);
})().catch((e) => { console.error(e.message); process.exit(1); });

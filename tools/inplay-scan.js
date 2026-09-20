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
const get = (u) => new Promise((res, rej) => https.get(u, { headers: { 'user-agent': 'hexagon-inplay-scan' } }, (r) => {
  let s = ''; r.on('data', (d) => (s += d));
  r.on('end', () => { try { res(JSON.parse(s)); } catch (e) { rej(new Error(`${r.statusCode} ${u}`)); } });
}).on('error', rej));

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
      return q ? { leg, name, kBid: leg.yesBid, kAsk: leg.yesAsk, pBid: q.bid, pAsk: q.ask } : null;
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
    rows.push({ at: Date.now(), game: g.ticker, live: g.live,
      teams: `${X.name}/${Y.name}`,
      ks: `${c(X.kBid)}/${c(X.kAsk)}`, pm: `${c(X.pBid)}/${c(X.pAsk)}`,
      // mid-to-mid on the SAME team, the plain statement of how far apart the venues are
      gap: +(((X.kBid + X.kAsk) / 2) - ((X.pBid + X.pAsk) / 2)).toFixed(4),
      edge: +best.edge.toFixed(4), fees: +best.fees.toFixed(4),
      buy: `PM ${best.buyPm} @${c(best.buyPm === X.name ? X.pAsk : Y.pAsk)} + KS ${best.buyKs} @${c(best.buyKs === X.name ? X.kAsk : Y.kAsk)}`,
      other: +Math.min(a.edge, b.edge).toFixed(4) });
  }
  return { rows, games: games.length };
}

function print(rows) {
  const live = rows.filter((r) => r.live);
  console.log(`${'game'.padEnd(22)} ${'teams'.padEnd(26)} ${'KS'.padEnd(14)} ${'PM'.padEnd(14)} ${'gap'.padEnd(7)}${'edge'.padEnd(7)}${'fees'.padEnd(7)}`);
  for (const r of rows.sort((a, b) => b.edge - a.edge)) {
    console.log(`${r.game.replace(/^KX|GAME-/g, '').padEnd(22)} ${r.teams.padEnd(26)} ${r.ks} ${r.pm} ${c(r.gap)}${c(r.edge)}${c(r.fees)} ${r.live ? 'LIVE' : 'pre '}${r.edge > 0 ? `  <== ${r.buy}` : ''}`);
  }
  const hit = live.filter((r) => r.edge > 0);
  const gaps = live.map((r) => Math.abs(r.gap)).sort((a, b) => a - b);
  console.log(`\n${live.length} live games · ${hit.length} clear both venues' fees · median gap ${c(gaps[Math.floor(gaps.length / 2)])} · widest ${c(gaps[gaps.length - 1])}`);
  console.log(`${rows.length - live.length} pre-game (reliably flat: the edge is in-play)`);
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
  while (Date.now() < UNTIL) {
    try {
      const { rows } = await snapshot();
      for (const r of rows) {
        fs.appendFileSync(out, JSON.stringify(r) + '\n');
        if (!r.live) continue;
        const run = open.get(r.game);
        if (r.edge > 0 && !run) { open.set(r.game, { start: r.at, peak: r.edge }); console.log(`${et(r.at)}  OPEN  ${c(r.edge)} net · ${r.game.replace(/^KX|GAME-/g, '')} · ${r.buy}`); }
        else if (r.edge > 0) { run.peak = Math.max(run.peak, r.edge); }
        else if (run) { console.log(`${et(r.at)}  SHUT  after ${Math.round((r.at - run.start) / 1000)}s, peak ${c(run.peak)} · ${r.game.replace(/^KX|GAME-/g, '')}`); open.delete(r.game); }
      }
    } catch (e) { console.log(`${et(Date.now())}  poll failed: ${String(e.message).slice(0, 90)}`); }
    await new Promise((r) => setTimeout(r, EVERY_MS));
  }
  console.log(`${et(Date.now())}  done`);
})().catch((e) => { console.error(e.message); process.exit(1); });

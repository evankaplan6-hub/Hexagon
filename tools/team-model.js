'use strict';
// A team model for the game bets: each team rated by its scores, not only its wins, walked forward a day at a
// time, so a game's rating knows only the games before it. Evan, 2026-10-16, after the pick lab found that no
// rule built from prices or results beat the favourite: "build a model". tools/pick-lab.js --model tests it
// against the market's price on every Kalshi game the scores can be matched to.
//
// The rating: a game's margin is home's rating less away's, plus home field (none at a neutral site), plus
// noise. Fitted by ridge regression on every earlier game, each weighted by how recent it is (half-life
// HALF days, so last season counts for a little at the start of this one), the margin capped (a 63-0 game says
// little more than a 35-0 one). A team with few games is held near average by the ridge. The chance of a win is
// the normal curve at the predicted margin over the league's spread of results (SIGMA, fitted on the train
// games). Pure: no I/O, no clock.

const LEAGUE = {
  // half-life of a game's weight (days), the ridge (games' worth of "average" every team starts with), the cap on
  // a margin, and the spread of a margin about its prediction: set from the 2024 and 2025 seasons, never 2026
  // (each the best of four on the 2025 season's own games, walked forward: NFL 66% of winners picked, college
  // 72% of FBS games, MLB 56%; sigma is that season's error in points or runs)
  nfl: { half: 90, ridge: 2, cap: 24, sigma: 12.9 },
  cfb: { half: 180, ridge: 3, cap: 28, sigma: 17 },
  mlb: { half: 250, ridge: 40, cap: 6, sigma: 4.5 },
};
const DAY = 86400e3;

// Ratings from `games` (each { t, home, away, hs, as, neutral }) before `asOf`. Coordinate descent on the weighted
// ridge: twenty passes settle it to a hundredth of a point for these league sizes.
function rate(games, asOf, p) {
  const r = new Map(), seen = new Map();
  const rows = [];
  for (const g of games) {
    if (!(g.t < asOf)) continue;
    const w = 0.5 ** ((asOf - g.t) / (p.half * DAY));
    if (w < 0.02) continue;
    const m = Math.max(-p.cap, Math.min(p.cap, g.hs - g.as));
    rows.push({ h: g.home, a: g.away, m, w, n: g.neutral ? 0 : 1 });
    for (const k of [g.home, g.away]) { r.set(k, 0); seen.set(k, (seen.get(k) || 0) + w); }
  }
  let hfa = 0;
  const byTeam = new Map();
  for (const x of rows) for (const k of [x.h, x.a]) { if (!byTeam.has(k)) byTeam.set(k, []); byTeam.get(k).push(x); }
  for (let pass = 0; pass < 20; pass++) {
    for (const [k, xs] of byTeam) {
      let num = 0, den = p.ridge;
      for (const x of xs) {
        const own = x.h === k ? 1 : -1, other = r.get(x.h === k ? x.a : x.h);
        // margin from k's side, less what the opponent and home field explain
        num += x.w * (own * x.m + other - own * hfa * x.n); den += x.w;
      }
      r.set(k, num / den);
    }
    let hn = 0, hd = 1e-3;
    for (const x of rows) if (x.n) { hn += x.w * (x.m - (r.get(x.h) - r.get(x.a))); hd += x.w; }
    hfa = hn / hd;
    // ratings are relative: centred on the teams' mean, so a team never seen is the average one
    const mean = [...r.values()].reduce((a, b) => a + b, 0) / Math.max(1, r.size);
    for (const [k, v] of r) r.set(k, v - mean);
  }
  return { r, hfa, seen };
}

// the normal curve, for the chance a margin of `mu` with spread `sigma` comes out above zero
function phi(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
const winProb = (mu, sigma) => phi(mu / sigma);

// The model's chance for `team` against `opp` in a game at `t`, with ratings rebuilt once a day (a cache by day).
function modeller(scores, league) {
  const p = LEAGUE[league], cache = new Map();
  return (team, opp, home, t, neutral = false) => {
    const day = Math.floor(t / DAY) * DAY;
    if (!cache.has(day)) cache.set(day, rate(scores, day, p));
    const R = cache.get(day);
    const rt = R.r.get(team) ?? 0, ro = R.r.get(opp) ?? 0;
    const mu = rt - ro + (neutral ? 0 : home === team ? R.hfa : home === opp ? -R.hfa : 0);
    return { p: winProb(mu, p.sigma), mu, games: Math.min(R.seen.get(team) || 0, R.seen.get(opp) || 0) };
  };
}

// ------------------------------------------------------------------ matching a Kalshi game to its score
// Kalshi's codes are the sources' for the NFL and MLB but for a few; a college team is matched by its name.
const ALIAS = {
  nfl: { LAR: 'LA', JAC: 'JAX', WSH: 'WAS' },
  mlb: { ARI: 'AZ', CHW: 'CWS', WAS: 'WSH', OAK: 'ATH', SDP: 'SD', SFG: 'SF', TBR: 'TB', KCR: 'KC' },
};
// "Ohio St." is "Ohio State", but "St. Francis (PA)" is not "State Francis"; accents go ("San José State")
const norm = (s) => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/(\w)\s+st\.?(?=\s|$)/g, '$1 state')
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();
// Kalshi's way of naming a college team, where it is not the source's (both sides go through it)
const CFB_ALIAS = new Map(Object.entries({
  'miami fl': 'miami', 'pitt': 'pittsburgh', 'umass': 'massachusetts', 'louisiana lafayette': 'louisiana', 'louisiana monroe': 'ul monroe',
  'app state': 'appalachian state', 'fiu': 'florida international', 'north carolina state': 'nc state', 'university at albany': 'ualbany',
  'central connecticut state': 'central connecticut', 'tennessee martin': 'ut martin', 'southeastern louisiana': 'se louisiana', 'liu': 'long island university',
}));
const cfbKey = (s) => { const n = norm(s); return CFB_ALIAS.get(n) || n; };
// `g` a pick-lab game (series, team, opp, kickTs, ticker, event); `byLeague` the scores by league; `names` Kalshi
// subtitles by ticker. Returns the score row and which side is home, or null.
function matchGame(g, byLeague, names) {
  const league = { KXNFLGAME: 'nfl', KXNCAAFGAME: 'cfb', KXMLBGAME: 'mlb' }[g.series];
  if (!league || !byLeague[league]) return null;
  let a, b, key;
  if (league === 'cfb') {
    // the other team's market is the event's other ticker (a code can hold a hyphen, KXNCAAFGAME-25AUG28M-OHWIS-M-OH,
    // so the opponent's code read off the ticker is not to be trusted)
    const other = (names.byEvent && names.byEvent.get(g.event) || []).find((t) => t !== g.ticker);
    a = cfbKey(names[g.ticker]); b = cfbKey(other && names[other]); key = cfbKey;
    if (!a || !b) return null;
  } else {
    const al = ALIAS[league] || {};
    a = al[g.team] || g.team; b = al[g.opp] || g.opp; key = (x) => x;
  }
  const kick = g.kickTs * 1000;      // pick-fetch keeps Kalshi's seconds; the scores are in milliseconds
  let best = null;
  for (const s of byLeague[league].near(kick)) {
    const h = key(s.home), w = key(s.away);
    if (!((h === a && w === b) || (h === b && w === a))) continue;
    const dt = Math.abs(s.t - kick);
    if (dt <= 14 * 3600e3 && (!best || dt < best.dt)) best = { s, dt, teamHome: h === a };
  }
  return best ? { league, score: best.s, teamHome: best.teamHome, teamKey: best.teamHome ? best.s.home : best.s.away, oppKey: best.teamHome ? best.s.away : best.s.home } : null;
}
// names.json's tickers by event, for finding a game's other team. An event is the ticker less its last part, but
// a team's code can hold a hyphen, and so can the event's ("KXNCAAFGAME-25AUG28M-OHWIS"), so each ticker is tried
// against the events the games name, cut at each hyphen from the right.
function withEvents(names, events) {
  const want = new Set(events), byEvent = new Map();
  for (const t of Object.keys(names)) {
    for (let i = t.lastIndexOf('-'); i > 0; i = t.lastIndexOf('-', i - 1)) {
      const e = t.slice(0, i);
      if (want.has(e)) { if (!byEvent.has(e)) byEvent.set(e, []); byEvent.get(e).push(t); break; }
    }
  }
  return Object.assign(Object.create(null), names, { byEvent });
}
// the scores of a league, findable by time (a day either side)
function indexScores(scores) {
  const byDay = new Map();
  for (const s of scores) { const d = Math.floor(s.t / DAY); if (!byDay.has(d)) byDay.set(d, []); byDay.get(d).push(s); }
  return { all: scores, near: (t) => { const d = Math.floor(t / DAY); return [...(byDay.get(d - 1) || []), ...(byDay.get(d) || []), ...(byDay.get(d + 1) || [])]; } };
}

module.exports = { LEAGUE, rate, winProb, phi, modeller, matchGame, indexScores, withEvents, norm, cfbKey, ALIAS };

'use strict';
// Can a rule pick winners better than "the favourite"? The bets book (README, "Every game") puts $100 on
// each game's favourite; Evan, 2026-10-16: "u should be trying to pick the winner not just a pick". This
// scores candidate pickers on every settled Kalshi game in the book's series (tools/pick-fetch.js),
// each bet $100 bought at the ask an hour before kickoff, net of Kalshi's taker fee, held to the final.
//
//   node tools/pick-lab.js                    # every league, train before --split, holdout after
//   node tools/pick-lab.js --split 2026-03-01 --series KXNFLGAME
//
// The pickers are chosen on the TRAIN games only. The holdout columns are read once: a rule that wins
// in train and not in holdout found noise. The two venues' disagreement is not here (Kalshi only; the
// live book already buys at the cheaper venue) and neither is any outside model: an Elo built from the
// same results is the one rating the desk can make from its own data.
const fs = require('fs');

const args = process.argv.slice(2);
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const FILE = flag('file', 'data/lab/picks/games.jsonl');
const SPLIT = Date.parse(flag('split', '2026-03-01')) / 1000;
const ONLY = flag('series', '');
const MODEL = args.includes('--model');
const USD = 100;

// the game's two sides at a bar: team at the YES ask, opponent at the NO ask (100 - YES bid)
const sides = (bar) => ({ team: { ask: bar[2] / 100, mid: (bar[1] + bar[2]) / 200 }, opp: { ask: (100 - bar[1]) / 100, mid: 1 - (bar[1] + bar[2]) / 200 } });
const barAt = (g, t) => { let b = null; for (const x of g.bars) if (x[0] <= t) b = x; return b; };

// $100 at `ask`, fee 0.07 x multiplier x p(1-p) a contract (Kalshi's taker fee before its cent rounding)
function bet(ask, won, feeMult) {
  const n = Math.floor(USD / ask);
  const fee = 0.07 * feeMult * n * ask * (1 - ask);
  return n * (won ? 1 : 0) - n * ask - fee;
}

// exhibition games are left out: starters sit, so neither the price nor a rating means what it does in season
// (NFL preseason in August, MLB spring training to late March, NBA preseason before about October 21)
function preseason(g) {
  const d = new Date((g.kickTs - 5 * 3600) * 1000), m = d.getUTCMonth() + 1, day = d.getUTCDate();
  if (g.series === 'KXNFLGAME') return m === 8 || (m === 9 && day < 3);
  if (g.series === 'KXMLBGAME') return m < 3 || (m === 3 && day < 25);
  if (g.series === 'KXNBAGAME') return m === 10 && day < 21;
  return false;
}

const loadGames = (file = FILE) => prepare(fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)));

// each game priced an hour before kickoff (and a day before, for the line's move); a game with no quoted
// book in the six hours before kickoff, or an exhibition game, is left out
function prepare(raw) {
  const games = [];
  for (const g of raw) {
    if (ONLY && g.series !== ONLY) continue;
    if (preseason(g)) continue;
    const now = barAt(g, g.kickTs - 3600), early = barAt(g, g.kickTs - 24 * 3600);
    if (!now || now[0] < g.kickTs - 6 * 3600) continue;       // no quoted book in the hours before kickoff
    games.push({ ...g, now: sides(now), early: early && early[0] >= g.kickTs - 30 * 3600 ? sides(early) : null, teamWon: g.result === 'yes' });
  }
  return games.sort((a, b) => a.kickTs - b.kickTs);
}

// Elo from the results alone, walked forward in time, so a game's rating knows only earlier games
function addElo(games, K) {
  const r = new Map(), get = (s, t) => r.get(`${s}:${t}`) ?? 1500;
  for (const g of games) {
    const a = get(g.series, g.team), b = get(g.series, g.opp);
    g.eloTeam = 1 / (1 + 10 ** ((b - a) / 400));
    const s = g.teamWon ? 1 : 0, d = K * (s - g.eloTeam);
    r.set(`${g.series}:${g.team}`, a + d); r.set(`${g.series}:${g.opp}`, b - d);
  }
}

// a picker returns 'team', 'opp' or null (no bet)
const fav = (g) => (g.now.team.mid >= g.now.opp.mid ? 'team' : 'opp');
const other = (s) => (s === 'team' ? 'opp' : 'team');
const PICKERS = {
  'favourite (today)': fav,
  'underdog': (g) => other(fav(g)),
  'favourite 50-60c': (g) => { const p = g.now[fav(g)].mid; return p < 0.6 ? fav(g) : null; },
  'favourite 60-70c': (g) => { const p = g.now[fav(g)].mid; return p >= 0.6 && p < 0.7 ? fav(g) : null; },
  'favourite 70-80c': (g) => { const p = g.now[fav(g)].mid; return p >= 0.7 && p < 0.8 ? fav(g) : null; },
  'favourite 80-90c': (g) => { const p = g.now[fav(g)].mid; return p >= 0.8 && p < 0.9 ? fav(g) : null; },
  'favourite 90c+': (g) => { const p = g.now[fav(g)].mid; return p >= 0.9 ? fav(g) : null; },
  'steam: side up 3c+ in the last day': (g) => { if (!g.early) return null; const d = g.now.team.mid - g.early.team.mid; return d >= 0.03 ? 'team' : d <= -0.03 ? 'opp' : null; },
  'fade: side down 3c+ in the last day': (g) => { if (!g.early) return null; const d = g.now.team.mid - g.early.team.mid; return d >= 0.03 ? 'opp' : d <= -0.03 ? 'team' : null; },
  'Elo says 5 pts likelier than price': (g) => { const e = g.eloTeam - g.now.team.mid; return e >= 0.05 ? 'team' : e <= -0.05 ? 'opp' : null; },
  'Elo says 10 pts likelier than price': (g) => { const e = g.eloTeam - g.now.team.mid; return e >= 0.10 ? 'team' : e <= -0.10 ? 'opp' : null; },
  'Elo favourite': (g) => (g.eloTeam >= 0.5 ? 'team' : 'opp'),
  // the same favourite, bought a day out (the book bet up to a day before until 2026-10-16): does waiting
  // for the late news pay? Only games with both bars, so the two rows are the same games
  // the team model (tools/team-model.js), on the games whose score it found; null on the rest, so these rows are
  // read against the favourite on the same games ('favourite, model's games')
  "favourite, model's games": (g) => (g.model ? fav(g) : null),
  'model favourite': (g) => (g.model ? (g.model.p >= 0.5 ? 'team' : 'opp') : null),
  'model 5 pts likelier than price': (g) => { if (!g.model) return null; const e = g.model.p - g.now.team.mid; return e >= 0.05 ? 'team' : e <= -0.05 ? 'opp' : null; },
  'model 10 pts likelier than price': (g) => { if (!g.model) return null; const e = g.model.p - g.now.team.mid; return e >= 0.10 ? 'team' : e <= -0.10 ? 'opp' : null; },
  'blend favourite (price and model)': (g) => (g.model && g.blend != null ? (g.blend >= 0.5 ? 'team' : 'opp') : null),
  'blend 3 pts likelier than price': (g) => { if (!g.model || g.blend == null) return null; const e = g.blend - g.now.team.mid; return e >= 0.03 ? 'team' : e <= -0.03 ? 'opp' : null; },
  'favourite, bought a day out': (g) => (g.early ? [g.early.team.mid >= 0.5 ? 'team' : 'opp', 'early'] : null),
  'favourite, bought an hour out (same games)': (g) => (g.early ? fav(g) : null),
};

function score(games, pick) {
  let n = 0, w = 0, pnl = 0, sq = 0;
  for (const g of games) {
    let s = pick(g), at = 'now';
    if (!s) continue;
    if (Array.isArray(s)) [s, at] = s;
    const won = s === 'team' ? g.teamWon : !g.teamWon;
    const p = bet(g[at][s].ask, won, g.feeMult);
    n++; if (won) w++; pnl += p; sq += p * p;
  }
  const mean = n ? pnl / n : 0, se = n > 1 ? Math.sqrt((sq / n - mean * mean) / (n - 1)) : 0;
  return { n, w, pnl, mean, se };
}

const fmt = (s) => (s.n ? `${String(s.n).padStart(5)} ${(100 * s.w / s.n).toFixed(0).padStart(3)}% ${(s.mean >= 0 ? '+' : '') + s.mean.toFixed(2).padStart(6)} ±${(2 * s.se).toFixed(2).padStart(5)}` : '    0      -         ');

// how often a side priced p actually won: the market's own calibration, the question under every picker
function calibration(games) {
  const bands = [[0, 0.1], [0.1, 0.2], [0.2, 0.3], [0.3, 0.4], [0.4, 0.5], [0.5, 0.6], [0.6, 0.7], [0.7, 0.8], [0.8, 0.9], [0.9, 1.01]];
  const L = ['  price      sides   won    priced at   gap'];
  for (const [lo, hi] of bands) {
    let n = 0, w = 0, p = 0;
    for (const g of games) for (const s of ['team', 'opp']) {
      const m = g.now[s].mid;
      if (m < lo || m >= hi) continue;
      n++; p += m; if (s === 'team' ? g.teamWon : !g.teamWon) w++;
    }
    if (n) L.push(`  ${(lo * 100).toFixed(0).padStart(2)}-${Math.min(hi * 100, 100).toFixed(0).padStart(3)}c  ${String(n).padStart(6)}  ${(100 * w / n).toFixed(1).padStart(5)}%   ${(100 * p / n).toFixed(1).padStart(5)}%   ${((100 * w / n) - (100 * p / n) >= 0 ? '+' : '')}${((100 * w / n) - (100 * p / n)).toFixed(1)}`);
  }
  return L.join('\n');
}

// The model's chance for each game's team side, where its score is found (tools/score-fetch.js first)
function addModel(games) {
  const TM = require('./team-model');
  const names = TM.withEvents(JSON.parse(fs.readFileSync('data/lab/picks/names.json', 'utf8')), games.map((g) => g.event));
  const scores = {}, models = {};
  for (const l of ['nfl', 'cfb', 'mlb']) { const s = JSON.parse(fs.readFileSync(`data/lab/scores/${l}.json`, 'utf8')); scores[l] = TM.indexScores(s); models[l] = TM.modeller(s, l); }
  for (const g of games) {
    const m = TM.matchGame(g, scores, names);
    if (!m) continue;
    // rated as of the start of the game's day, before it: the model never sees its result
    const out = models[m.league](m.teamKey, m.oppKey, m.score.home, m.score.t, m.score.neutral);
    g.model = { p: out.p, mu: out.mu, league: m.league };
  }
}
// How well a set of chances called the games: log loss (lower is better) and the Brier score.
const logit = (p) => Math.log(p / (1 - p)), sig = (x) => 1 / (1 + Math.exp(-x)), clip = (p) => Math.min(0.99, Math.max(0.01, p));
function lossOf(games, f) {
  let n = 0, ll = 0, br = 0;
  for (const g of games) { const p = f(g); if (p == null) continue; const y = g.teamWon ? 1 : 0, q = clip(p); n++; ll += -(y * Math.log(q) + (1 - y) * Math.log(1 - q)); br += (q - y) ** 2; }
  return { n, ll: n ? ll / n : NaN, br: n ? br / n : NaN };
}
// The blend: logit(p) = a·logit(price) + b·logit(model), a and b fitted on the train games by gradient descent on
// log loss. b near zero says the model adds nothing the price does not already have.
function fitBlend(games) {
  let a = 1, b = 0;
  const xs = games.filter((g) => g.model).map((g) => [logit(clip(g.now.team.mid)), logit(clip(g.model.p)), g.teamWon ? 1 : 0]);
  for (let it = 0; it < 4000; it++) {
    let ga = 0, gb = 0;
    for (const [u, v, y] of xs) { const e = sig(a * u + b * v) - y; ga += e * u; gb += e * v; }
    a -= 0.5 * ga / xs.length; b -= 0.5 * gb / xs.length;
  }
  return { a, b, n: xs.length };
}

if (require.main === module) {
  const all = loadGames();
  if (MODEL) addModel(all);
  const series = ONLY ? [ONLY] : [...new Set(all.map((g) => g.series))].sort();
  const K = { KXNFLGAME: 20, KXNCAAFGAME: 30, KXMLBGAME: 4, KXNBAGAME: 12 };
  for (const s of series) addElo(all.filter((g) => g.series === s), K[s] || 20);
  console.log(`${all.length} games with a quoted book an hour before kickoff · $${USD} a bet at the ask, net of Kalshi's taker fee · split ${new Date(SPLIT * 1000).toISOString().slice(0, 10)}`);
  console.log('a row: bets, won, mean $ a bet, ±2 standard errors. A rule is real only if its holdout mean clears zero by more than the ± and beats the favourite.\n');
  for (const s of [...series, 'ALL']) {
    const gs = s === 'ALL' ? all : all.filter((g) => g.series === s);
    const train = gs.filter((g) => g.kickTs < SPLIT), test = gs.filter((g) => g.kickTs >= SPLIT);
    console.log(`== ${s}: ${train.length} train games, ${test.length} holdout games`);
    if (MODEL && s !== 'KXNBAGAME') {
      const B = fitBlend(train);
      for (const g of gs) g.blend = g.model ? sig(B.a * logit(clip(g.now.team.mid)) + B.b * logit(clip(g.model.p))) : null;
      const row = (name, f) => { const t = lossOf(train.filter((g) => g.model), f), h = lossOf(test.filter((g) => g.model), f); return `  ${name.padEnd(30)} train ${String(t.n).padStart(5)} log loss ${t.ll.toFixed(4)} brier ${t.br.toFixed(4)}   holdout ${String(h.n).padStart(5)} log loss ${h.ll.toFixed(4)} brier ${h.br.toFixed(4)}`; };
      console.log(`  how well each called the games it could rate (lower is better); blend = ${B.a.toFixed(2)}·price + ${B.b.toFixed(2)}·model, fitted on train`);
      console.log(row('the price (Kalshi mid)', (g) => g.now.team.mid));
      console.log(row('the model', (g) => g.model.p));
      console.log(row('the blend', (g) => g.blend));
    }
    console.log(`  ${'picker'.padEnd(44)} ${'TRAIN  bets  won   mean   ±2se'.padEnd(29)}   HOLDOUT  bets  won   mean   ±2se`);
    for (const [name, pick] of Object.entries(PICKERS)) console.log(`  ${name.padEnd(44)} ${fmt(score(train, pick))}      ${fmt(score(test, pick))}`);
    console.log(`\n  calibration, every game (both sides):\n${calibration(gs)}\n`);
  }
}

module.exports = { bet, sides, barAt, score, calibration, addElo, prepare, preseason, PICKERS, fitBlend, lossOf };

'use strict';
// The team model: ratings from margins, home field, no game rated with its own result, the normal curve, the
// matching of a Kalshi game to its score (codes, college names, hyphenated codes), and the score sources' parsing.
const M = require('./team-model');
const { csv, nfl } = require('./score-fetch');
const { fitBlend, lossOf } = require('./pick-lab');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);
const DAY = 86400e3, T0 = Date.UTC(2025, 8, 1);
const P = { half: 1e6, ridge: 0.01, cap: 100, sigma: 10 };

// ---- ratings
{
  // A beats B by 10 at a neutral site, B beats C by 10, twice each: A is 20 better than C
  const g = (d, home, away, hs, as, neutral = true) => ({ t: T0 + d * DAY, home, away, hs, as, neutral });
  const games = [g(0, 'A', 'B', 20, 10), g(1, 'B', 'C', 20, 10), g(2, 'A', 'B', 20, 10), g(3, 'B', 'C', 20, 10)];
  const R = M.rate(games, T0 + 10 * DAY, P);
  near('A is 10 better than B', R.r.get('A') - R.r.get('B'), 10, 0.05);
  near('...and 20 better than C, a team it never played', R.r.get('A') - R.r.get('C'), 20, 0.1);
  near('ratings are centred on zero', R.r.get('A') + R.r.get('B') + R.r.get('C'), 0, 1e-9);
  // home field: equal teams, home wins every game by 3
  const H = M.rate([g(0, 'X', 'Y', 13, 10, false), g(1, 'Y', 'X', 13, 10, false), g(2, 'X', 'Y', 13, 10, false), g(3, 'Y', 'X', 13, 10, false)], T0 + 10 * DAY, P);
  near('home field is the home side\'s margin between equal teams', H.hfa, 3, 0.05);
  near('...and the two teams rate the same', H.r.get('X') - H.r.get('Y'), 0, 0.05);
  // a game on or after the day asked about is not in its ratings
  const before = M.rate(games, T0 + 2 * DAY, P);
  ok('a rating as of day 2 knows days 0 and 1 only', before.seen.get('A') > 0 && before.r.size === 3 && Math.abs(before.r.get('A') - before.r.get('B') - 10) < 0.1);
  const none = M.rate(games, T0, P);
  ok('...and as of day 0, nothing', none.r.size === 0);
  // a 70-point margin counts as the cap
  const capped = M.rate([g(0, 'A', 'B', 70, 0)], T0 + DAY, { ...P, cap: 28 });
  ok('a blowout counts as the cap', capped.r.get('A') - capped.r.get('B') <= 28 + 1e-6, capped.r.get('A') - capped.r.get('B'));
}

// ---- the chance of a win
{
  near('an even game is 50%', M.winProb(0, 13), 0.5, 1e-6);
  near('one sigma ahead is about 84%', M.winProb(13, 13), 0.8413, 1e-3);
  near('and the curve is symmetric', M.winProb(-6, 13) + M.winProb(6, 13), 1, 1e-6);
  // the modeller rates a game as of the start of its day: its own result is not in it
  const games = [{ t: T0, home: 'A', away: 'B', hs: 30, as: 0, neutral: true }, { t: T0 + 3 * DAY + 3600e3, home: 'A', away: 'B', hs: 0, as: 30, neutral: true }];
  const f = M.modeller(games, 'nfl');
  const second = f('A', 'B', 'A', games[1].t, true);
  ok('the second game is rated from the first only: A favoured despite losing it', second.p > 0.5, second);
}

// ---- matching a Kalshi game to its score
{
  const sc = (league, rows) => ({ [league]: M.indexScores(rows) });
  const kick = Date.UTC(2026, 9, 16, 0, 15);
  const nflRow = { league: 'nfl', t: kick, home: 'DEN', away: 'SEA', hs: 17, as: 14, neutral: false };
  const g = { series: 'KXNFLGAME', team: 'SEA', opp: 'DEN', kickTs: kick / 1000, ticker: 'KXNFLGAME-26OCT15SEADEN-SEA', event: 'KXNFLGAME-26OCT15SEADEN' };
  const m = M.matchGame(g, sc('nfl', [nflRow]), {});
  ok('an NFL game by its codes, the team the away side', m && m.score === nflRow && m.teamHome === false && m.teamKey === 'SEA', m);
  ok('Kalshi\'s LAR is nflverse\'s LA', !!M.matchGame({ ...g, team: 'LAR', opp: 'DEN' }, sc('nfl', [{ ...nflRow, away: 'LA' }]), {}));
  ok('a game more than 14 hours off is another game', M.matchGame({ ...g, kickTs: kick / 1000 + 20 * 3600 }, sc('nfl', [nflRow]), {}) === null);
  // college: by name, the other team found through the event (a code with a hyphen: M-OH)
  const ev = 'KXNCAAFGAME-25AUG28M-OHWIS';
  const names = M.withEvents({ [`${ev}-M-OH`]: 'Miami (OH)', [`${ev}-WIS`]: 'Wisconsin' }, [ev]);
  const cg = { series: 'KXNCAAFGAME', team: 'OH', opp: null, kickTs: Date.UTC(2025, 7, 29, 0) / 1000, ticker: `${ev}-M-OH`, event: ev };
  const cm = M.matchGame(cg, sc('cfb', [{ league: 'cfb', t: Date.UTC(2025, 7, 29, 0), home: 'Wisconsin', away: 'Miami (OH)', hs: 17, as: 0, neutral: false }]), names);
  ok('a college game by its names, a hyphenated code and all', cm && cm.teamKey === 'Miami (OH)' && cm.oppKey === 'Wisconsin', cm);
  ok('"Ohio St." is "Ohio State", "San José State" is "San Jose St.", "St. Francis (PA)" keeps its St.', M.cfbKey('Ohio St.') === M.cfbKey('Ohio State') && M.cfbKey('San José State') === M.cfbKey('San Jose St.') && M.cfbKey('St. Francis (PA)') === 'st francis pa');
  ok('"North Carolina St." is the source\'s "NC State", "Miami (FL)" its "Miami"', M.cfbKey('North Carolina St.') === M.cfbKey('NC State') && M.cfbKey('Miami (FL)') === M.cfbKey('Miami'));
}

// ---- the sources
{
  const rows = csv('a,b,c\n1,"x, y",3\r\n4,"say ""hi""",6\n');
  ok('a CSV field may hold a comma and a doubled quote', rows.length === 2 && rows[0].b === 'x, y' && rows[1].b === 'say "hi"', rows);
  const n = nfl(csv('season,game_type,gameday,gametime,away_team,away_score,home_team,home_score,location\n2025,REG,2025-10-12,13:00,SEA,20,DEN,17,Home\n2025,REG,2025-10-19,13:00,SEA,,DEN,,Home\n2025,PRE,2025-08-10,13:00,SEA,3,DEN,0,Home\n'));
  ok('nflverse: finished games only, preseason out', n.length === 1 && n[0].home === 'DEN' && n[0].as === 20, n);
  near('...its Eastern 1 PM kickoff in October is 17:00 UTC', n[0].t, Date.UTC(2025, 9, 12, 17), 0);
}

// ---- the blend and the loss
{
  const gs = Array.from({ length: 400 }, (_, i) => { const p = 0.3 + 0.4 * ((i * 37) % 100) / 100; return { now: { team: { mid: p } }, model: { p: 0.5 }, teamWon: ((i * 61) % 100) / 100 < p }; });
  const B = fitBlend(gs);
  ok('a model that says 50% every time gets no weight beside the price', Math.abs(B.b) < 1e-9 && B.a > 0.5, B);
  const L = lossOf(gs, (g) => g.now.team.mid), C = lossOf(gs, () => 0.5);
  ok('the true price loses less than a coin', L.ll < C.ll && Math.abs(C.ll - Math.log(2)) < 1e-9, [L.ll, C.ll]);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

'use strict';
// The pick lab: a $100 bet's arithmetic, which bar a game is priced at, exhibition games left out, the
// Elo walked forward so no game's rating knows its own result, and the opponent read off the ticker.
const { bet, prepare, preseason, addElo, score, PICKERS } = require('./pick-lab');
const { teams } = require('./pick-fetch');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

const KICK = Date.UTC(2026, 9, 11, 17) / 1000;   // a Sunday in October, 1 PM ET
const game = (over = {}) => ({ series: 'KXNFLGAME', event: 'E', ticker: 'KXNFLGAME-26OCT11AAABBB-AAA', team: 'AAA', opp: 'BBB', result: 'yes', kickTs: KICK, closeTs: KICK + 4 * 3600, feeMult: 1,
  bars: [[KICK - 24 * 3600, 50, 52, 1], [KICK - 2 * 3600, 60, 61, 1], [KICK - 3600, 64, 65, 1], [KICK - 1800, 90, 91, 1]], ...over });

// ---- a bet's arithmetic: whole contracts for $100 at the ask, Kalshi's 7% x p(1-p) fee
{
  near('a win at 50c: 200 contracts pay $200, cost $100, fee 0.07 x 200 x .25', bet(0.5, true, 1), 200 - 100 - 3.5);
  near('a loss at 50c loses the stake and the fee', bet(0.5, false, 1), -103.5);
  near('MLB pays half the fee', bet(0.5, false, 0.5), -101.75);
  near('at 65c, 153 contracts', bet(0.65, true, 1), 153 - 153 * 0.65 - 0.07 * 153 * 0.65 * 0.35);
}

// ---- the bar a game is priced at: the last one at least an hour before kickoff, never a later one
{
  const [g] = prepare([game()]);
  near('the team side is bought at the YES ask an hour out (65c), not the half-hour bar (91c)', g.now.team.ask, 0.65);
  near('the opponent is bought at the NO ask, 100 - the YES bid', g.now.opp.ask, 0.36);
  near('the day-before mid', g.early.team.mid, 0.51);
  ok('a game whose last quote is 6h+ before kickoff is left out', prepare([game({ bars: [[KICK - 8 * 3600, 50, 52, 1]] })]).length === 0);
  ok('a game with no day-before bar still prices, with no line move', prepare([game({ bars: [[KICK - 3600, 64, 65, 1]] })])[0].early === null);
}

// ---- exhibition games
{
  ok('an August NFL game is preseason', preseason(game({ kickTs: Date.UTC(2026, 7, 15, 23) / 1000 })));
  ok('an October NFL game is not', !preseason(game()));
  ok('MLB spring training (March 10) is out', preseason(game({ series: 'KXMLBGAME', kickTs: Date.UTC(2026, 2, 10, 17) / 1000 })));
  ok('MLB opening week (March 28) is in', !preseason(game({ series: 'KXMLBGAME', kickTs: Date.UTC(2026, 2, 28, 17) / 1000 })));
  ok('an NBA game on October 5 is preseason', preseason(game({ series: 'KXNBAGAME', kickTs: Date.UTC(2025, 9, 5, 23) / 1000 })));
  ok('college football has no preseason', !preseason(game({ series: 'KXNCAAFGAME', kickTs: Date.UTC(2025, 7, 30, 17) / 1000 })));
}

// ---- Elo: a game's rating comes from earlier games only
{
  const gs = [game({ kickTs: KICK }), game({ kickTs: KICK + 7 * 86400 }), game({ kickTs: KICK + 14 * 86400, result: 'no' })].map((g) => ({ ...g, teamWon: g.result === 'yes' }));
  addElo(gs, 20);
  near('the first game: both teams new, even', gs[0].eloTeam, 0.5);
  ok('after a win, the winner is rated likelier', gs[1].eloTeam > 0.5, gs[1].eloTeam);
  ok('the third game\'s rating does not know it was lost', gs[2].eloTeam > gs[1].eloTeam, [gs[1].eloTeam, gs[2].eloTeam]);
}

// ---- the pickers score from the bar they bet at
{
  const gs = prepare([game(), game({ result: 'no' })]);
  const s = score(gs, PICKERS['favourite (today)']);
  ok('the favourite is the side priced over half: two bets, one won', s.n === 2 && s.w === 1, s);
  near('their sum is one win and one loss at 65c', s.pnl, bet(0.65, true, 1) + bet(0.65, false, 1));
  ok('the 60-70c band takes a 64.5c favourite', score(gs, PICKERS['favourite 60-70c']).n === 2);
  ok('the 80-90c band does not', score(gs, PICKERS['favourite 80-90c']).n === 0);
  ok('steam: up 13.5c in a day is a bet on that side', PICKERS['steam: side up 3c+ in the last day'](gs[0]) === 'team');
}

// ---- the opponent, off the ticker
{
  const t = (ticker) => teams({ ticker });
  ok('NFL: KXNFLGAME-26OCT15SEADEN-SEA is SEA against DEN', JSON.stringify(t('KXNFLGAME-26OCT15SEADEN-SEA')) === '{"team":"SEA","opp":"DEN"}', t('KXNFLGAME-26OCT15SEADEN-SEA'));
  ok('the second team of the code', t('KXNFLGAME-26OCT15SEADEN-DEN').opp === 'SEA');
  ok('MLB carries a start time in the code: KXMLBGAME-26OCT151800TBCLE-TB', t('KXMLBGAME-26OCT151800TBCLE-TB').opp === 'CLE', t('KXMLBGAME-26OCT151800TBCLE-TB'));
  ok('college codes of uneven length: ILSTSIU-SIU', t('KXNCAAFGAME-26OCT17ILSTSIU-SIU').opp === 'ILST');
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

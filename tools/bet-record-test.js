'use strict';
// The game bets' record against their prices (tools/bet-record.js): which ledger lines are settled bets, the wins the
// prices expected and chance's exact spread, a game's Eastern day and week, and the report's lines. No network.
const T = require('./bet-record');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const bet = (id, label, side, p, pnl, at, o = {}) => ({ id, strategy: 'bet', pairId: `1:0|KXNFLGAME-26OCT18${id}-X`, label, side, venue: 'PM', entry: p, cost: 100, pnl, openedAt: at - 864e5, exitAt: at, ...o });
const state = { closed: [
  bet('A', 'NFL Vikings v Bears · Vikings', 'yes', 0.6, 60, Date.parse('2026-10-12T20:00:00Z')),
  bet('B', 'NBA Heat v Magic · Heat', 'no', 0.55, -100, Date.parse('2026-10-14T03:30:00Z')),           // 11:30 PM ET Tue 10-13
  bet('C', 'NCAAF Ohio State v Indiana · Ohio State', 'yes', 0.8, 25, Date.parse('2026-10-19T04:30:00Z')), // 12:30 AM ET Mon 10-19: Sunday's game
  bet('D', 'MLB Rays v Guardians · Rays', 'yes', 0.5, 98, Date.parse('2026-10-06T23:00:00Z')),
  { id: 'arb', strategy: 'arb', entry: 0.4, pnl: 5, exitAt: Date.parse('2026-10-12T20:00:00Z'), cost: 40 },
  { id: 'open', strategy: 'bet', entry: 0.6, pnl: 0, cost: 100 },                                         // never settled
] };

{
  const xs = T.settled(state);
  ok('a settled bet is a closed leg of the every-game book with an exit; an arb and an unsettled leg are not', xs.length === 4 && xs.every((x) => x.id !== 'arb' && x.id !== 'open'), xs.map((x) => x.id));
  ok('oldest first, each with its Kalshi ticker and league', xs.map((x) => x.id).join() === 'D,A,B,C' && xs[1].ticker === 'KXNFLGAME-26OCT18A-X' && xs[1].league === 'NFL');
  ok('a win is a bet that made money', xs.find((x) => x.id === 'B').won === false && xs.find((x) => x.id === 'A').won === true);
}
{
  const r = T.record(T.settled(state));
  ok('the wins the prices expected are their prices added up', r.bets === 4 && r.won === 3 && r.expected === 2.45, r);
  const v = 0.6 * 0.4 + 0.55 * 0.45 + 0.8 * 0.2 + 0.5 * 0.5;
  ok('chance\'s spread is exact: the square root of the sum of p(1-p)', Math.abs(r.sd - Math.sqrt(v)) < 0.006 && Math.abs(r.z - (3 - 2.45) / Math.sqrt(v)) < 0.006, r);
  ok('and the money', r.pnl === 83 && r.staked === 400, r);
  ok('under two sds is luck; past it, says which way', T.verdict({ bets: 9, z: -1.9 }) === 'within luck' && /short/.test(T.verdict({ bets: 9, z: -2.4 })) && /ahead/.test(T.verdict({ bets: 9, z: 2.1 })) && T.verdict({ bets: 0 }) === 'no bet settled');
}
{
  ok('a game ending after midnight Eastern is the evening before\'s', T.playedDay(Date.parse('2026-10-19T04:30:00Z')) === '2026-10-18' && T.playedDay(Date.parse('2026-10-14T03:30:00Z')) === '2026-10-13');
  ok('a week starts on the Monday', T.weekOf('2026-10-18') === '2026-10-12' && T.weekOf('2026-10-12') === '2026-10-12' && T.weekOf('2026-10-19') === '2026-10-19');
}
{
  // run on Monday morning 2026-10-19: last week is the week of Mon 10-12, and Sunday night's game is in it
  const R = T.report(state, Date.parse('2026-10-19T13:00:00Z'));
  ok('last week is the whole week before the one under way', R.weeks.lastWeek === '2026-10-12' && R.weeks.thisWeek === '2026-10-19');
  ok('...with the games played in it, Sunday night\'s too', R.lastWeek.bets === 3 && R.lastWeek.won === 2, R.lastWeek);
  ok('the first line is the whole record and its verdict', /^Game bets, settled: 3–1, the prices said 2\.5 \(\+0\.5, \d\.\d sd ahead\) · \+\$83\.00 · within luck$/.test(R.lines[0]), R.lines[0]);
  ok('a week by line and a league by line, College named so', R.lines.some((l) => /^ {2}2026-10-05 {2}1–0/.test(l)) && R.lines.some((l) => /^ {2}College /.test(l)), R.lines);
  ok('money with its thousands', /\+\$1,234\.50/.test(T.report({ closed: [bet('E', 'NFL A v B · A', 'yes', 0.5, 1234.5, Date.parse('2026-10-12T20:00:00Z'))] }, Date.parse('2026-10-19T13:00:00Z')).lines[0]));
  ok('nothing settled: says so', /^Game bets, settled: 0–0/.test(T.report({ closed: [] }).lines[0]) && T.report({ closed: [] }).lines[1].endsWith('no bet settled'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

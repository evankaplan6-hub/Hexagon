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

// ---- from the journals (audit 2026-10-17: the state's closed legs keep only the newest 2,000)
{
  const t = (iso) => iso;
  const lines = [
    { t: t('2026-10-12T19:00:00Z'), kind: 'OPEN', id: 'b1', strategy: 'bet', pairId: '1:0|KXNFLGAME-26OCT12MINCHI-MIN', label: 'NFL Vikings v Bears · Vikings', side: 'yes', venue: 'KS', qty: 150, entry: 0.6, fee: 0.35, cost: 90.35 },
    { t: t('2026-10-12T23:00:00Z'), kind: 'SETTLE', id: 'b1', strategy: 'bet', pairId: '1:0|KXNFLGAME-26OCT12MINCHI-MIN', label: 'NFL Vikings v Bears · Vikings', side: 'yes', venue: 'KS', qty: 150, entry: 0.6, exit: 1, pnl: 59.65, heldMs: 4 * 3600e3 },
    { t: t('2026-10-12T23:00:00Z'), kind: 'SETTLE', id: 'b1', strategy: 'bet', label: 'NFL Vikings v Bears · Vikings', side: 'yes', venue: 'KS', qty: 150, entry: 0.6, pnl: 59.65 },   // said twice
    { t: t('2026-10-13T03:30:00Z'), kind: 'SETTLE', id: 'b2', strategy: 'bet', pairId: '2:0|KXNBAGAME-26OCT12MIAORL-MIA', label: 'NBA Heat v Magic · Heat', side: 'no', venue: 'PM', qty: 180, entry: 0.55, pnl: -99 },
    { t: t('2026-10-12T23:00:00Z'), kind: 'SETTLE', id: 'a1', strategy: 'arb', label: 'Fed', entry: 0.4, pnl: 5 },
  ];
  const xs = T.settledFromJournal(lines);
  ok('each settled bet once, an arb not at all', xs.length === 2 && xs.map((x) => x.id).join() === 'b1,b2', xs.map((x) => x.id));
  ok('its cost from its OPEN line, or its size at its price when there is none', xs[0].cost === 90.35 && xs[1].cost === 99, xs.map((x) => x.cost));
  ok('when it was placed, from how long it was held', xs[0].opened === Date.parse('2026-10-12T19:00:00Z'), xs[0].opened);
  ok('a game ending 11:30 PM ET is that evening\'s, and the ticker comes from the pair', xs[1].day === '2026-10-12' && xs[1].ticker === 'KXNBAGAME-26OCT12MIAORL-MIA', xs[1]);
  ok('the report reads a list of bets as it reads a state', T.report(xs, Date.parse('2026-10-19T13:00:00Z')).all.bets === 2);
}

// ---- the flip list (audit 2026-10-17): last week only, named by the team bet on, and Kalshi unreached is counted
(async () => {
  const real = global.fetch;
  const asked = [];
  try {
    global.fetch = async (url) => { asked.push(url); throw new Error('offline'); };
    const bets = [
      { id: 'x', ticker: 'KXNFLGAME-26OCT12MINCHI-MIN', label: 'NFL Vikings v Bears · Vikings', side: 'no', p: 0.55, won: false, opened: 0, day: '2026-10-12' },
      { id: 'y', ticker: 'KXNFLGAME-26OCT19MINCHI-MIN', label: 'NFL Vikings v Bears · Vikings', side: 'no', p: 0.55, won: false, opened: 0, day: '2026-10-19' },   // this week: not asked about
    ];
    const r = await T.flips(bets, '2026-10-12');
    ok('Kalshi offline: the bet is counted as not checked, not passed over as "no flip"', r.unreached === 1 && r.flipped.length === 0, r);
    ok('...and only last week\'s bets are asked about', asked.length > 0 && asked.every((u) => u.includes('26OCT12')), asked.slice(0, 2));
    // reachable: a NO bet on Vikings is a bet on the Bears, named so, when its price an hour before was under 49.5c
    global.fetch = async (url) => ({ ok: true, status: 200, json: async () => (url.includes('/candlesticks')
      ? { candlesticks: [{ end_period_ts: Math.floor(Date.parse('2026-10-12T16:00:00Z') / 1000), yes_bid: { close_dollars: '0.6' }, yes_ask: { close_dollars: '0.62' } }] }
      : { market: { occurrence_datetime: '2026-10-12T20:00:00Z', close_time: '2026-10-12T23:00:00Z' } }) });
    const r2 = await T.flips(bets, '2026-10-12');
    ok('a flipped pick is named by the team bet on: the Bears', r2.unreached === 0 && r2.flipped.length === 1 && r2.flipped[0].name === 'Bears over Vikings' && r2.flipped[0].then === 0.39, r2);
  } finally { global.fetch = real; }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

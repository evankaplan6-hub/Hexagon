'use strict';
// The bets book's coverage count: which events the journal's bets name, each Kalshi game's day (by when it settled,
// not its ticker's date), and each played game BET, OVER THE CAP or MISSED. No network: run() is not called.
const T = require('./bet-coverage');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const mkt = (ticker, sub, o = {}) => ({ ticker, event_ticker: T.eventOf(ticker), market_type: 'binary', yes_sub_title: sub, status: 'finalized', result: 'no', ...o });
const pair = (event, a, b, o = {}) => [mkt(`${event}-${a[0]}`, a[1], o), mkt(`${event}-${b[0]}`, b[1], { ...o, result: o.result === 'no' ? 'yes' : o.result })];

// ---- the bets the journal names
{
  const lines = [
    { kind: 'OPEN', strategy: 'bet', t: '2026-10-17T15:00:07Z', pairId: '5348755:0|KXNCAAFGAME-26OCT17KUKSU-KU', label: 'NCAAF Kansas v Kansas State · Kansas', venue: 'PM', side: 'no', entry: 0.6 },
    { kind: 'OPEN', strategy: 'arb', pairId: '1:0|KXNCAAFGAME-26OCT17PSUMICH-PSU' },
    { kind: 'SETTLE', strategy: 'bet', pairId: '2:0|KXNCAAFGAME-26OCT17OSUIND-OSU' },
    { kind: 'OPEN', strategy: 'bet', pairId: 'no-kalshi-ticker' },
    null,
  ];
  const b = T.betEvents(lines);
  ok('an OPEN of strategy "bet" names its Kalshi event', b.has('KXNCAAFGAME-26OCT17KUKSU') && b.get('KXNCAAFGAME-26OCT17KUKSU').side === 'no', [...b.keys()]);
  ok('an arb, a SETTLE, a pairId with no Kalshi side and a torn line are not bets', b.size === 1, [...b.keys()]);
  ok('the event is the ticker less its side, hyphenated college codes and all', T.eventOf('KXNCAAFGAME-26OCT17MOHAKR-M-OH') === 'KXNCAAFGAME-26OCT17MOHAKR-M');
}

// ---- each game's day, by when Kalshi settled it
{
  const fri = pair('KXNCAAFGAME-26OCT16FLATEX', ['FLA', 'Florida'], ['TEX', 'Texas'], { occurrence_datetime: '2026-10-17T03:00:00Z', close_time: '2026-10-17T19:41:00Z' });
  const late = pair('KXNBAGAME-26OCT16DENLAL', ['DEN', 'Denver'], ['LAL', 'Los Angeles L'], { occurrence_datetime: '2026-10-17T05:30:00Z', close_time: '2026-10-17T05:03:21Z' });
  const open = pair('KXNFLGAME-26OCT18SEADEN', ['SEA', 'Seattle'], ['DEN', 'Denver'], { status: 'active', result: '', occurrence_datetime: '2026-10-18T20:05:00Z', close_time: '2026-10-21T00:00:00Z' });
  const g = Object.fromEntries(T.games([...fri, ...late, ...open]).map((x) => [x.event.split('-')[1], x]));
  ok('a Saturday game Kalshi dated Friday (PR #221) is Saturday\'s: it settled Saturday afternoon', g['26OCT16FLATEX'].day === '2026-10-17', g['26OCT16FLATEX']);
  ok('...and its start comes from the close (the occurrence is a placeholder 16h before it)', Math.abs(g['26OCT16FLATEX'].start - Date.parse('2026-10-17T16:11:00Z')) < 1, new Date(g['26OCT16FLATEX'].start).toISOString());
  ok('a game ending after midnight Eastern belongs to the evening it started', g['26OCT16DENLAL'].day === '2026-10-16', g['26OCT16DENLAL'].day);
  ok('...and a plausible occurrence gives its start (less three hours)', g['26OCT16DENLAL'].start === Date.parse('2026-10-17T02:30:00Z'), new Date(g['26OCT16DENLAL'].start).toISOString());
  ok('a game not settled has no day yet', g['26OCT18SEADEN'].done === false && g['26OCT18SEADEN'].day === null, g['26OCT18SEADEN']);
  ok('the name is both sides', g['26OCT16FLATEX'].name === 'Florida v Texas' && g['26OCT16FLATEX'].tickers.length === 2, g['26OCT16FLATEX']);
}

// ---- the day's report
{
  const day = '2026-10-17', at = (h) => ({ close_time: `2026-10-17T${h}:00:00Z`, occurrence_datetime: `2026-10-17T${h}:00:00Z` });
  const all = T.games([
    ...pair('KXNCAAFGAME-26OCT17KUKSU', ['KU', 'Kansas'], ['KSU', 'Kansas St.'], at('19')),
    ...pair('KXNCAAFGAME-26OCT17CITTXAM', ['CIT', 'The Citadel'], ['TXAM', 'Texas A&M'], at('20')),
    ...pair('KXNCAAFGAME-26OCT16FLATEX', ['FLA', 'Florida'], ['TEX', 'Texas'], { close_time: '2026-10-17T19:41:00Z', occurrence_datetime: '2026-10-17T03:00:00Z' }),
    ...pair('KXNCAAFGAME-26OCT17OSUIND', ['OSU', 'Ohio St.'], ['IND', 'Indiana'], { close_time: '2026-10-18T03:30:00Z', occurrence_datetime: '2026-10-18T03:30:00Z' }),
    ...pair('KXNFLGAME-26OCT18SEADEN', ['SEA', 'Seattle'], ['DEN', 'Denver'], { status: 'active', result: '', close_time: '2026-10-21T00:00:00Z' }),
    ...pair('KXNCAAFGAME-26OCT16CLMBPENN', ['CLMB', 'Columbia'], ['PENN', 'Penn'], { close_time: '2026-10-17T04:14:29Z', occurrence_datetime: '2026-10-17T03:00:00Z' }),
  ]);
  const bets = new Map([['KXNCAAFGAME-26OCT17KUKSU', {}], ['KXNCAAFGAME-26OCT17OSUIND', {}]]);
  const fav = new Map([['KXNCAAFGAME-26OCT17CITTXAM', 0.99], ['KXNCAAFGAME-26OCT16FLATEX', 0.62]]);
  const r = T.report(day, all, bets, fav, { cap: 0.9 });
  ok('Saturday: four games settled that day (the Friday-dated one included, Friday night\'s and Sunday\'s not)', r.played === 4, r);
  ok('two bet, one over the cap (99c), one missed', r.bet === 2 && r.over === 1 && r.missed.length === 1 && r.missed[0].event === 'KXNCAAFGAME-26OCT16FLATEX', r);
  ok('the head line counts them by league', /Kalshi settled 4 games in the book's series \(NCAAF 4\); bet 2, over the 90c cap 1, missed 1/.test(r.lines[0]), r.lines[0]);
  ok('the miss is named, with its price and the three reasons a person checks', /MISSED NCAAF Florida v Texas \(12:11 PM ET\): favourite 62c an hour before, under the cap/.test(r.lines[1]) && /did not list it, the matcher did not pair it until it had started .*, or a veto/.test(r.lines[1]), r.lines[1]);
  const noq = T.report(day, all, bets, new Map([['KXNCAAFGAME-26OCT17CITTXAM', 0.99]]), { cap: 0.9 });
  ok('no Kalshi quote an hour before: a miss, said so (not passed off as over the cap)', noq.missed.length === 1 && /no Kalshi quote an hour before/.test(noq.lines[1]), noq.lines);
  ok('exactly at the cap is under it: the book bets a 90c favourite', T.report(day, all, bets, new Map([['KXNCAAFGAME-26OCT17CITTXAM', 0.9], ['KXNCAAFGAME-26OCT16FLATEX', 0.6]]), { cap: 0.9 }).missed.length === 2);
  const none = T.report('2026-10-20', all, bets, fav);
  ok('a day with nothing settled says so', none.played === 0 && /settled no game/.test(none.lines[0]) && none.missed.length === 0, none.lines);
  const fri = T.report('2026-10-16', all, bets, fav);
  ok('Friday: Columbia v Penn, ending after midnight, is Friday\'s, and unbet with no quote it is a miss', fri.played === 1 && fri.missed.length === 1 && /Columbia v Penn/.test(fri.lines[1]), fri.lines);
}

// ---- which journals: a week and more before the day (10-18's NFL bets were journalled 10-12 to 10-14)
{
  const f = T.journalFiles(['2026-10-16', '2026-10-17', '2026-10-18']);
  ok('Monday\'s three days read the journals from nine days before the first to the day after the last', f[0] === '2026-10-07' && f[f.length - 1] === '2026-10-19' && f.length === 13, f);
  ok('so a bet made six days before its game is found', T.journalFiles(['2026-10-18']).includes('2026-10-12'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

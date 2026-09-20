'use strict';
// Assertions for src/matcher.js -- the decision that two markets are the SAME outcome.
//
// This is load-bearing for money in a way it was not before. Locked arbs now outrank convergence
// signals unconditionally (src/decide.js), and an arb is "locked" ONLY if both venues resolve the
// same way. Pair the wrong two markets and what the desk books as risk-free is a naked directional
// position that can lose $1/contract on both legs at once.
//
//   node tools/matcher-test.js
const { matchPairs, nameMatch, tickerDate, etDate, figures, figuresConflict } = require('../src/matcher');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

group('nameMatch: every Kalshi token must prefix a Polymarket token, in order');
{
  ok('abbreviated team names match', nameMatch('New York Y', 'New York Yankees'));
  ok('a full name matches itself', nameMatch('Chicago Cubs', 'Chicago Cubs'));
  ok('tokens may be skipped in the middle', nameMatch('Los Angeles D', 'Los Angeles Dodgers'));
  ok('order is required', !nameMatch('Yankees New', 'New York Yankees'));
  ok('a longer Kalshi name cannot match a shorter PM one', !nameMatch('New York Yankees East', 'New York'));

  // the case the guard exists for: two different clubs sharing a generic token
  ok('"Kansas City" must never match "Orlando City"', !nameMatch('Kansas City', 'Orlando City'));
  ok('...nor the reverse', !nameMatch('Orlando City', 'Kansas City'));

  ok('empty input never matches', !nameMatch('', 'New York Yankees') && !nameMatch('New York Yankees', ''));
  ok('null input never matches', !nameMatch(null, 'x') && !nameMatch('x', null));

  // "St." normalises to "state" so college names line up across venues
  ok('St. normalises to State', nameMatch('Appalachian State', 'Appalachian St. Mountaineers'));
  // accents are stripped, so the same club spelled either way still pairs
  ok('accents are folded', nameMatch('Atletico Madrid', 'Atlético Madrid'));
  // club suffixes are noise
  ok('FC/SC/CF are dropped', nameMatch('Seattle Sounders', 'Seattle Sounders FC'));
}

group('nameMatch: the surname fallback is for PEOPLE only');
{
  // Direction matters: the prefix rule walks KALSHI tokens against PM tokens, so an initialled
  // KALSHI name resolves without the fallback ('d' is a prefix of 'daniil').
  ok('an initialled Kalshi name matches via the prefix rule', nameMatch('D. Medvedev', 'Daniil Medvedev', false));
  // It is the other direction that needs the fallback: a full Kalshi name against an initialled
  // PM one, where no Kalshi token prefixes the PM first name.
  ok('a full name against an initialled PM name needs the fallback', nameMatch('Novak Djokovic', 'N. Djokovic', true));
  ok('...and gets it only when people=true', !nameMatch('Novak Djokovic', 'N. Djokovic', false));
  // a 3-letter surname is too weak to identify anyone
  ok('a very short surname does not fall back', !nameMatch('X. Ito', 'Yuma Ito', true));
  ok('different surnames never match', !nameMatch('D. Medvedev', 'Daniil Djokovic', true));
  // NOTE: two players sharing a surname WOULD collide here. That is a real limit of the fallback,
  // and the sport/date gates in matchPairs are what keep it from mattering.
  ok('same surname, different first name, still matches (documented limit)', nameMatch('A. Zverev', 'Mischa Zverev', true));
}

group('tickerDate reads the US/Eastern date out of a Kalshi ticker');
{
  ok('parses a game ticker', tickerDate('KXMLBGAME-26SEP081905COLNYY') === '2026-09-08', tickerDate('KXMLBGAME-26SEP081905COLNYY'));
  ok('parses a Fed ticker', tickerDate('KXFEDDECISION-26SEP-H0') === null || typeof tickerDate('KXFEDDECISION-26SEP-H0') === 'string');
  ok('an unknown month is rejected', tickerDate('KXMLBGAME-26XXX081905COLNYY') === null);
  ok('a malformed ticker is rejected', tickerDate('NOTATICKER') === null);
  ok('null is rejected', tickerDate(null) === null);
}

group('etDate puts an evening game on the right day');
{
  // The whole reason this is US/Eastern and not UTC: a 10pm ET game is already "tomorrow" in UTC,
  // and pairing it on the UTC date would look for Kalshi markets that do not exist on that day.
  ok('an evening ET game stays on its own day', etDate('2026-09-10T02:00:00Z') === '2026-09-09', etDate('2026-09-10T02:00:00Z'));
  ok('an afternoon game is straightforward', etDate('2026-09-09T19:05:00Z') === '2026-09-09', etDate('2026-09-09T19:05:00Z'));
  ok('a space-separated timestamp parses', etDate('2026-09-09 19:05:00+00') === '2026-09-09', etDate('2026-09-09 19:05:00+00'));
  ok('garbage is null, not a wrong date', etDate('not a date') === null);
}

// ---------------------------------------------------------------- matchPairs
const pm = (o) => ({ id: 'pm1', question: '', outcomes: [], tokenIds: ['t0', 't1'], bestBid: 0.49, bestAsk: 0.51, url: '', ...o });
const ks = (o) => ({ ticker: 'KXTEST-A', eventTicker: 'KXTEST', title: '', subTitle: '', yesBid: 0.49, yesAsk: 0.51, url: '', ...o });
const mlbEvent = (date, a, b, prices = {}) => [
  ks({ ticker: `KXMLBGAME-${date}HOU`, eventTicker: `KXMLBGAME-${date}`, subTitle: a, title: a, yesBid: prices.aBid ?? 0.49, yesAsk: prices.aAsk ?? 0.51 }),
  ks({ ticker: `KXMLBGAME-${date}PHI`, eventTicker: `KXMLBGAME-${date}`, subTitle: b, title: b, yesBid: prices.bBid ?? 0.49, yesAsk: prices.bAsk ?? 0.51 }),
];

group('matchPairs: Fed brackets pair by month and code');
{
  const ksList = [
    ks({ ticker: 'KXFEDDECISION-26SEP-H0', eventTicker: 'KXFEDDECISION-26SEP', title: 'no change', subTitle: 'Fed maintains rate' }),
    ks({ ticker: 'KXFEDDECISION-26SEP-C25', eventTicker: 'KXFEDDECISION-26SEP', title: 'cut 25', subTitle: 'Cut 25bps' }),
  ];
  const hold = matchPairs([pm({ question: 'Will there be no change in Fed interest rates after the September 2026 meeting?' })], ksList);
  ok('"no change" pairs to H0', hold.pairs.length === 1 && hold.pairs[0].ks.ticker === 'KXFEDDECISION-26SEP-H0', hold.pairs);
  ok('and is labelled as a Fed pair', hold.pairs[0].kind === 'fed', hold.pairs[0]);

  const cut = matchPairs([pm({ question: 'Will the Fed decrease interest rates by 25 bps after the September 2026 meeting?' })], ksList);
  ok('"decrease 25 bps" pairs to C25', cut.pairs.length === 1 && cut.pairs[0].ks.ticker === 'KXFEDDECISION-26SEP-C25', cut.pairs);

  const wrongMonth = matchPairs([pm({ question: 'Will there be no change in Fed interest rates after the October 2026 meeting?' })], ksList);
  ok('the wrong month pairs to nothing', wrongMonth.pairs.length === 0, wrongMonth.pairs);

  // Kalshi's brackets are "25bps" and ">25bps" -- the second EXCLUDES 25, and both appear verbatim
  // on the recorded tape. Polymarket's "25+ bps" INCLUDES 25, so it spans both and matches neither.
  // Pairing it to >25 would settle the two legs of a "locked" arb opposite ways at exactly 25bps,
  // which is the single most likely outcome of a Fed meeting.
  const hikeKs = [
    ks({ ticker: 'KXFEDDECISION-26SEP-H25', eventTicker: 'KXFEDDECISION-26SEP', title: 'hike 25', subTitle: 'Hike 25bps' }),
    ks({ ticker: 'KXFEDDECISION-26SEP-H26', eventTicker: 'KXFEDDECISION-26SEP', title: 'hike >25', subTitle: 'Hike >25bps' }),
  ];
  const exact = matchPairs([pm({ question: 'Will the Fed increase interest rates by 25 bps after the September 2026 meeting?' })], hikeKs);
  ok('an exact "25 bps" still pairs to the 25 bracket', exact.pairs.length === 1 && /H25$/.test(exact.pairs[0].ks.ticker), exact.pairs);

  const spanning = matchPairs([pm({ question: 'Will the Fed increase interest rates by 25+ bps after the September 2026 meeting?' })], hikeKs);
  ok('a spanning "25+ bps" pairs to NOTHING', spanning.pairs.length === 0, spanning.pairs);

  // "50+ bps" is the wording Polymarket lists, and its rules round any move UP to the nearest 25, so
  // it is every move over 25 -- exactly Kalshi's ">25bps". An EXACT "50 bps" is only part of that
  // bracket: a 75bp move is Yes on Kalshi and No on Polymarket.
  const fiftyPlus = matchPairs([pm({ question: 'Will the Fed increase interest rates by 50+ bps after the September 2026 meeting?' })], hikeKs);
  ok('"50+ bps" pairs to the >25 bracket', fiftyPlus.pairs.length === 1 && /H26$/.test(fiftyPlus.pairs[0].ks.ticker), fiftyPlus.pairs);
  const cutKs = [ks({ ticker: 'KXFEDDECISION-26SEP-C26', eventTicker: 'KXFEDDECISION-26SEP', title: 'cut >25', subTitle: 'Cut >25bps' })];
  const cutPlus = matchPairs([pm({ question: 'Will the Fed decrease interest rates by 50+ bps after the September 2026 meeting?' })], cutKs);
  ok('...and so does the cut side', cutPlus.pairs.length === 1 && /C26$/.test(cutPlus.pairs[0].ks.ticker), cutPlus.pairs);
  const fifty = matchPairs([pm({ question: 'Will the Fed increase interest rates by 50 bps after the September 2026 meeting?' })], hikeKs);
  ok('an exact "50 bps" pairs to NOTHING', fifty.pairs.length === 0, fifty.pairs);
  const seventyFive = matchPairs([pm({ question: 'Will the Fed increase interest rates by 75+ bps after the September 2026 meeting?' })], hikeKs);
  ok('neither does "75+ bps"', seventyFive.pairs.length === 0, seventyFive.pairs);
}

group('matchPairs: an empty Kalshi book is not a price');
{
  const q = 'Will there be no change in Fed interest rates after the September 2026 meeting?';
  const k = (o) => [ks({ ticker: 'KXFEDDECISION-26SEP-H0', eventTicker: 'KXFEDDECISION-26SEP', title: 'no change', subTitle: 'Fed maintains rate', ...o })];
  ok('bid 0 / ask 1 (a mid of exactly 50c) pairs to nothing', matchPairs([pm({ question: q })], k({ yesBid: 0, yesAsk: 1 })).pairs.length === 0);
  ok('a one-sided book (no bid) pairs to nothing', matchPairs([pm({ question: q })], k({ yesBid: 0, yesAsk: 0.52 })).pairs.length === 0);
  ok('a two-sided book still pairs', matchPairs([pm({ question: q })], k({})).pairs.length === 1);
  const timed = matchPairs([pm({ question: q })], k({ closeTime: '2026-09-16T17:59:00Z', expectedExpiration: '2026-09-16T18:05:00Z' })).pairs[0];
  ok('a pair carries its Kalshi close and expected settlement', timed && timed.closesAt === Date.parse('2026-09-16T17:59:00Z') && timed.settlesAt === Date.parse('2026-09-16T18:05:00Z'), timed);
  const noExp = matchPairs([pm({ question: q })], k({ closeTime: '2026-09-16T17:59:00Z' })).pairs[0];
  ok('settlesAt falls back to the close', noExp && noExp.settlesAt === noExp.closesAt, noExp);
  ok('no close time is null, not NaN', matchPairs([pm({ question: q })], k({})).pairs[0].closesAt === null);
}

group('matchPairs: moneylines pair on the same ET date and the same sport');
{
  const ksList = mlbEvent('26SEP08', 'Houston Astros', 'Philadelphia Phillies');
  const market = pm({ question: 'Astros vs. Phillies', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z' });
  const r = matchPairs([market], ksList);
  ok('a same-date moneyline pairs', r.pairs.length === 1, r.pairs);
  ok('to the FIRST-named outcome', /Astros/.test(r.pairs[0].label), r.pairs[0].label);
  ok('and is tagged with the league', /^MLB/.test(r.pairs[0].label), r.pairs[0].label);

  const offDate = matchPairs([pm({ ...market, gameStart: '2026-09-11T23:05:00Z' })], ksList);
  ok('a different date pairs nothing', offDate.pairs.length === 0, offDate.pairs);

  // "Seattle" is a Mariners team and a Sounders team. Sport classification is what separates them.
  const soccerKs = [
    ks({ ticker: 'KXMLSGAME-26SEP08SEA', eventTicker: 'KXMLSGAME-26SEP08', subTitle: 'Seattle Sounders', title: 'Seattle Sounders' }),
    ks({ ticker: 'KXMLSGAME-26SEP08POR', eventTicker: 'KXMLSGAME-26SEP08', subTitle: 'Portland Timbers', title: 'Portland Timbers' }),
  ];
  const baseball = pm({ question: 'Mariners vs. Astros', sport: 'moneyline', outcomes: ['Seattle Mariners', 'Houston Astros'], gameStart: '2026-09-08T23:05:00Z' });
  ok('an MLB market cannot pair to an MLS event', matchPairs([baseball], soccerKs).pairs.length === 0);
}

group('matchPairs: one Kalshi market can back only one pair');
{
  const ksList = mlbEvent('26SEP08', 'Houston Astros', 'Philadelphia Phillies');
  const twice = [
    pm({ id: 'pmA', question: 'Astros vs. Phillies', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z' }),
    pm({ id: 'pmB', question: 'Astros vs. Phillies', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z' }),
  ];
  const r = matchPairs(twice, ksList);
  ok('a duplicate PM listing does not double-pair the same ticker', r.pairs.length === 1, r.pairs.map((p) => p.id));
}

group('matchPairs: the price-agreement guard, and what it does NOT catch');
{
  const date = '26SEP08';
  const market = pm({ question: 'Astros vs. Phillies', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z', bestBid: 0.49, bestAsk: 0.51 });

  // 40c apart: whatever these two markets are, they are not the same outcome.
  const far = matchPairs([market], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies', { aBid: 0.89, aAsk: 0.91 }));
  ok('a 40c disagreement is rejected', far.pairs.length === 0, far.pairs);
  ok('and recorded as rejected, not dropped silently', far.rejected.length === 1, far.rejected);

  const near = matchPairs([market], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies', { aBid: 0.69, aAsk: 0.71 }));
  ok('a 20c disagreement is accepted', near.pairs.length === 1, near.pairs);

  // THE BLIND SPOT, asserted deliberately. The guard is a PRICE heuristic, not a check that the
  // two markets resolve alike. Two genuinely different outcomes that happen to price close
  // together sail straight through it -- and "priced similarly" is the normal case for related
  // markets, not the exception. This test documents the limit rather than pretending it is closed:
  // nothing in the matcher reads either venue's resolution rules, so a pair that clears this bar
  // is unverified, not verified.
  const bothNearHalf = matchPairs([market], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies', { aBid: 0.52, aAsk: 0.54 }));
  ok('two coin-flip markets pair on price agreement alone', bothNearHalf.pairs.length === 1, bothNearHalf.pairs);
  ok('...with no resolution-rule check anywhere in the result', bothNearHalf.pairs[0].resolutionChecked === undefined);

  // a market with no usable price is skipped rather than paired on a bogus comparison
  const noPrice = matchPairs([pm({ ...market, bestBid: NaN, bestAsk: NaN })], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies'));
  ok('a NaN-priced market is not paired', noPrice.pairs.length === 0, noPrice.pairs);
  // null is the one that used to get through: (null + null) / 2 is 0, and Number.isFinite(0) is
  // true, so a market with no price at all arrived as a confident mid of zero and paired with
  // anything Kalshi priced under 30c.
  const nullPrice = matchPairs([pm({ ...market, bestBid: null, bestAsk: null })], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies', { aBid: 0.01, aAsk: 0.02 }));
  ok('a null-priced market is not paired either', nullPrice.pairs.length === 0, nullPrice.pairs);
  const nullKs = matchPairs([market], [
    ks({ ticker: `KXMLBGAME-${date}HOU`, eventTicker: `KXMLBGAME-${date}`, subTitle: 'Houston Astros', title: 'Houston Astros', yesBid: null, yesAsk: null }),
    ks({ ticker: `KXMLBGAME-${date}PHI`, eventTicker: `KXMLBGAME-${date}`, subTitle: 'Philadelphia Phillies', title: 'Philadelphia Phillies' }),
  ]);
  ok('an unpriced KALSHI leg is not paired', nullKs.pairs.length === 0, nullKs.pairs);
}

group('figures: the numbers in a question, by kind');
{
  const f = figures('Will CPI be above 3.0% for September 2026?');
  ok('a percentage is a percentage', f.pct.has(3) && f.pct.size === 1, [...f.pct]);
  ok('a year is a year, not a bare number', f.years.has(2026) && f.nums.size === 0, { years: [...f.years], nums: [...f.nums] });
  ok('a month with no day is not a date', f.dates.size === 0, [...f.dates]);
  const g = figures('Fed cuts by 25bps or 50 basis points before Oct 1st, 2026; unemployment over 4.5?');
  ok('glued and spaced bps both count', g.bps.has(25) && g.bps.has(50), [...g.bps]);
  ok('an ordinal date parses', g.dates.has('10/1'), [...g.dates]);
  ok('a bare decimal is a number', g.nums.has(4.5), [...g.nums]);
  const h = figures('Will Bitcoin close above $1,500,000 or $2.5m on 2026-12-31?');
  ok('dollar amounts scale and lose their commas', h.money.has(1500000) && h.money.has(2500000), [...h.money]);
  ok('an ISO date yields a year and a day', h.years.has(2026) && h.dates.has('12/31'), { years: [...h.years], dates: [...h.dates] });
  // the names that carry digits
  const n = figures('76ers vs. 49ers, B53.5 bracket, 1st half');
  ok('a number glued to letters is a name, not a figure', n.nums.size === 0 && n.years.size === 0, { nums: [...n.nums], years: [...n.years] });
  ok('an empty question has no figures', Object.values(figures('')).every((s) => s.size === 0));
  ok('null is fine', Object.values(figures(null)).every((s) => s.size === 0));
}

group('figuresConflict: both sides speak and disagree');
{
  ok('a tenth of a percent is a different outcome', /pct/.test(figuresConflict('CPI above 3.0%?', 'CPI above 3.1%')), figuresConflict('CPI above 3.0%?', 'CPI above 3.1%'));
  ok('the same figure written differently agrees', figuresConflict('CPI above 3.0%?', 'CPI above 3 percent') === null);
  ok('a different deadline is a different outcome', /dates/.test(figuresConflict('by September 30?', 'before Sep 30')) === false && /dates/.test(figuresConflict('by September 30?', 'before October 1')), figuresConflict('by September 30?', 'before October 1'));
  ok('a different year is a different outcome', /years/.test(figuresConflict('Will X happen in 2026?', 'X in 2027')));
  ok('game 1 is not game 2', /nums/.test(figuresConflict('Astros vs. Phillies (Game 2)', 'Houston Astros at Philadelphia Phillies (Game 1)')));
  ok('one side silent is not a conflict', figuresConflict('Astros vs. Phillies', 'Houston at Philadelphia (Sep 8)') === null);
  ok('no figures anywhere is not a conflict', figuresConflict('Astros vs. Phillies', 'Houston Astros') === null);
  ok('a partial overlap is still a conflict', /bps/.test(figuresConflict('cut 25 bps', 'cut 25bps or 50bps')));
}

group('matchPairs: the figure guard');
{
  const date = '26SEP08';
  const market = pm({ question: 'Astros vs. Phillies (Game 2)', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z' });
  // a doubleheader: the same two teams, the same date, two Kalshi events -- the first one listed
  // is game 1, and without the guard the name-and-date match takes it
  const gameOne = mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies').map((k) => ({ ...k, title: `${k.title} (Game 1)` }));
  const r = matchPairs([market], gameOne);
  ok('game 2 does not pair to a game 1 listing', r.pairs.length === 0, r.pairs);
  ok('...and the rejection says why', r.rejected.length === 1 && r.rejected[0].why === 'figures' && /nums/.test(r.rejected[0].detail), r.rejected);
  const gameTwo = mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies').map((k) => ({ ...k, title: `${k.title} (Game 2)`, ticker: `${k.ticker}-G2`, eventTicker: `${k.eventTicker}-G2` }));
  ok('game 2 pairs to game 2', matchPairs([market], gameTwo).pairs.length === 1);
  // both games listed, game 1 first: the guard has to skip game 1 and go on to game 2, not reject
  // the first name match and leave the right row unpaired
  const both = matchPairs([market], [...gameOne, ...gameTwo]);
  ok('with both games listed, game 2 finds game 2', both.pairs.length === 1 && /G2$/.test(both.pairs[0].ks.ticker), both);
  ok('...and nothing is reported rejected', both.rejected.length === 0, both.rejected);
  const gameOnePm = pm({ ...market, id: 'pm2', question: 'Astros vs. Phillies (Game 1)' });
  const twoPm = matchPairs([market, gameOnePm], [...gameOne, ...gameTwo]);
  ok('two PM games, two Kalshi games: each pairs to its own', twoPm.pairs.length === 2 && twoPm.pairs.every((p) => (/Game 2/.test(p.pm.question)) === /G2$/.test(p.ks.ticker)), twoPm.pairs.map((p) => [p.pm.question, p.ks.ticker]));
  // the price guard's rejection is labelled too, so the log can count them apart
  const far = matchPairs([pm({ ...market, question: 'Astros vs. Phillies' })], mlbEvent(date, 'Houston Astros', 'Philadelphia Phillies', { aBid: 0.89, aAsk: 0.91 }));
  ok('a price rejection is labelled as one', far.rejected.length === 1 && far.rejected[0].why === 'price', far.rejected);
  // Fed brackets are matched by code, and Kalshi's label for a code is a RANGE, so the figures on
  // the two sides legitimately differ. The guard must not undo the bracket mapping.
  const hikeKs = [
    ks({ ticker: 'KXFEDDECISION-26SEP-H25', eventTicker: 'KXFEDDECISION-26SEP', title: 'Fed decision, September 2026', subTitle: 'Hike 25bps' }),
    ks({ ticker: 'KXFEDDECISION-26SEP-H26', eventTicker: 'KXFEDDECISION-26SEP', title: 'Fed decision, September 2026', subTitle: 'Hike >25bps' }),
  ];
  const fifty = matchPairs([pm({ question: 'Will the Fed increase interest rates by 50+ bps after the September 2026 meeting?' })], hikeKs);
  ok('a Fed pair is exempt: "50+ bps" still pairs to the >25 bracket', fifty.pairs.length === 1 && /H26$/.test(fifty.pairs[0].ks.ticker), fifty);
}

group('matchPairs: shape of what it returns');
{
  const ksList = mlbEvent('26SEP08', 'Houston Astros', 'Philadelphia Phillies');
  const r = matchPairs([pm({ question: 'Astros vs. Phillies', sport: 'moneyline', outcomes: ['Houston Astros', 'Philadelphia Phillies'], gameStart: '2026-09-08T23:05:00Z' })], ksList);
  const p = r.pairs[0];
  ok('id joins both venues', /^pm1:0\|KXMLBGAME/.test(p.id), p.id);
  ok('carries the series', p.series === 'KXMLBGAME', p.series);
  ok('carries a start time for games', Number.isFinite(p.startsAt), p.startsAt);
  ok('carries both venue references', !!p.pm.tokenId && !!p.ks.ticker, p);
  ok('an empty universe returns empty, not undefined', matchPairs([], []).pairs.length === 0);
}

group('matchPairs: a PM "Will X win" market must match BOTH clubs, not one shared name');
{
  // The live losing trade from 2026-09-12, rebuilt. Kalshi lists Tottenham v Everton (EPL). Two
  // Polymarket markets ask "Will ... Everton ... win" that day: the real one, and Chile's Everton
  // de Viña del Mar. "Everton" prefixes both, and the Chilean one used to pair first -- a "locked
  // arb" on two different football matches, and the real market left unpaired behind it.
  const eplEvent = [
    ks({ ticker: 'KXEPLGAME-26SEP12TOTEVE-TOT', eventTicker: 'KXEPLGAME-26SEP12TOTEVE', subTitle: 'Tottenham', title: 'Tottenham wins' }),
    ks({ ticker: 'KXEPLGAME-26SEP12TOTEVE-TIE', eventTicker: 'KXEPLGAME-26SEP12TOTEVE', subTitle: 'Tie', title: 'Tie' }),
    ks({ ticker: 'KXEPLGAME-26SEP12TOTEVE-EVE', eventTicker: 'KXEPLGAME-26SEP12TOTEVE', subTitle: 'Everton', title: 'Everton wins' }),
  ];
  const chile = pm({ id: 'chile', question: 'Will Everton de Viña del Mar win on 2026-09-12?', eventTitle: 'Universidad de Chile vs. Everton de Viña del Mar', outcomes: ['Yes', 'No'] });
  const real = pm({ id: 'real', question: 'Will Everton FC win on 2026-09-12?', eventTitle: 'Tottenham Hotspur FC vs. Everton FC', outcomes: ['Yes', 'No'] });

  const alone = matchPairs([chile], eplEvent);
  ok('the Chilean club does not pair with the EPL match', alone.pairs.length === 0, alone.pairs.map((p) => p.label));

  const both = matchPairs([chile, real], eplEvent);
  const eve = both.pairs.find((p) => p.ks.ticker === 'KXEPLGAME-26SEP12TOTEVE-EVE');
  ok('the real Everton FC market is no longer blocked behind it', !!eve && eve.pm.id === 'real', both.pairs.map((p) => `${p.label}<-${p.pm.id}`));

  const spurs = pm({ id: 'spurs', question: 'Will Tottenham Hotspur FC win on 2026-09-12?', eventTitle: 'Tottenham Hotspur FC vs. Everton FC', outcomes: ['Yes', 'No'] });
  const s = matchPairs([spurs], eplEvent).pairs;
  ok('the home side still pairs to its own leg', s.length === 1 && s[0].ks.ticker === 'KXEPLGAME-26SEP12TOTEVE-TOT', s.map((p) => p.ks.ticker));

  // One club right, opponent wrong: a different fixture involving a same-named club.
  const wrongOpp = pm({ id: 'x', question: 'Will Everton FC win on 2026-09-12?', eventTitle: 'Everton FC vs. Chelsea FC', outcomes: ['Yes', 'No'] });
  ok('a matching club with the wrong opponent is refused', matchPairs([wrongOpp], eplEvent).pairs.length === 0);

  // No "A vs. B" title to check the opponent against: refusing is the safe direction.
  const noTitle = pm({ id: 'y', question: 'Will Everton FC win on 2026-09-12?', eventTitle: 'Will Everton FC win on 2026-09-12?', outcomes: ['Yes', 'No'] });
  ok('a market with no two-sided event title is refused', matchPairs([noTitle], eplEvent).pairs.length === 0);

  // Both legs naming the SAME side must not count as two matches.
  const sameSide = pm({ id: 'z', question: 'Will Everton FC win on 2026-09-12?', eventTitle: 'Everton FC vs. Everton FC Women', outcomes: ['Yes', 'No'] });
  ok('the opponent must be the other side, not the same one twice', matchPairs([sameSide], eplEvent).pairs.length === 0);
}

group('matchPairs: an NFL game -- Kalshi says the city, Polymarket says the nickname');
{
  // Real labels from Sunday 2026-09-20. Before nflFull, every one of the 14 games on the slate
  // missed here with no reject logged: "minnesota" is not a prefix of "vikings".
  const nfl = (ev, a, b) => [
    ks({ ticker: `KXNFLGAME-${ev}-A`, eventTicker: `KXNFLGAME-${ev}`, subTitle: a, title: `${a} wins` }),
    ks({ ticker: `KXNFLGAME-${ev}-B`, eventTicker: `KXNFLGAME-${ev}`, subTitle: b, title: `${b} wins` }),
  ];
  const game = (q, outcomes, gameStart) => pm({ question: q, sport: 'moneyline', outcomes, gameStart });
  const r = matchPairs([game('Vikings vs. Bears', ['Vikings', 'Bears'], '2026-09-20 17:00:00+00')], nfl('26SEP20MINCHI', 'Minnesota', 'Chicago'));
  ok('a city-vs-nickname NFL game pairs', r.pairs.length === 1, r.pairs);
  ok('...to the first-named side, tagged NFL', r.pairs[0] && r.pairs[0].label === 'NFL Vikings v Bears · Vikings' && /-A$/.test(r.pairs[0].ks.ticker), r.pairs[0]);

  // the two New York and two Los Angeles teams: Kalshi's one-letter suffix picks the club
  const ny = matchPairs([game('Packers vs. Jets', ['Packers', 'Jets'], '2026-09-20 17:00:00+00'), game('Giants vs. Rams', ['Giants', 'Rams'], '2026-09-22 00:15:00+00')],
    [...nfl('26SEP20GBNYJ', 'Green Bay', 'New York J'), ...nfl('26SEP21NYGLAR', 'New York G', 'Los Angeles R')]);
  ok('"New York J" is the Jets and "New York G" the Giants', ny.pairs.length === 2 && ny.pairs.every((p) => /GBNYJ-A|NYGLAR-A/.test(p.ks.ticker)), ny.pairs.map((p) => `${p.label} -> ${p.ks.ticker}`));
  const wrongNy = matchPairs([game('Giants vs. Rams', ['Giants', 'Rams'], '2026-09-20 17:00:00+00')], nfl('26SEP20GBNYJ', 'Green Bay', 'New York J'));
  ok('the Giants do not pair with the Jets\' game', wrongNy.pairs.length === 0, wrongNy.pairs);

  // the expansion is NFL-only: an MLB "Giants" keeps its own city
  const mlbGiants = matchPairs([game('Giants vs. Cardinals', ['San Francisco Giants', 'St. Louis Cardinals'], '2026-09-20 17:00:00+00')], mlbEvent('26SEP20', 'San Francisco Giants', 'St. Louis Cardinals'));
  ok('an MLB Giants game still pairs as MLB', mlbGiants.pairs.length === 1 && /^MLB/.test(mlbGiants.pairs[0].label), mlbGiants.pairs);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

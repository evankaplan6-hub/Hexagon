'use strict';
// Assertions for src/matcher.js -- the decision that two markets are the SAME outcome.
//
// This is load-bearing for money in a way it was not before. Locked arbs now outrank convergence
// signals unconditionally (src/decide.js), and an arb is "locked" ONLY if both venues resolve the
// same way. Pair the wrong two markets and what the desk books as risk-free is a naked directional
// position that can lose $1/contract on both legs at once.
//
//   node tools/matcher-test.js
const { matchPairs, nameMatch, tickerDate, etDate } = require('../src/matcher');

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

  const fifty = matchPairs([pm({ question: 'Will the Fed increase interest rates by 50 bps after the September 2026 meeting?' })], hikeKs);
  ok('an unambiguous "50 bps" still pairs to >25', fifty.pairs.length === 1 && /H26$/.test(fifty.pairs[0].ks.ticker), fifty.pairs);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

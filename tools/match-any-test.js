'use strict';
// Assertions for src/match-any.js -- the same outcome on Polymarket and Kalshi, in any category.
//
// Every fixture is real venue text from the live listings on 2026-09-15: the pairs that are the same
// outcome, and the near-misses that looked like one while being a different person, party,
// deadline, threshold, statistic or question. Precision over recall: a wrong pair that clears the
// rules gate books a "locked arb" that is two unrelated bets. No network, no clock.
//
//   node tools/match-any-test.js
const m = require('../src/match-any');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

let seq = 0;
const K = (ticker, o) => ({ venue: 'KS', ticker, eventTicker: ticker.split('-').slice(0, -1).join('-') || ticker, seriesTicker: ticker.split('-')[0], category: 'Elections', yesBid: 0.4, yesAsk: 0.42, vol24: 100, oi: 100, rulesHash: `k${ticker}`, ...o });
const P = (o) => ({ venue: 'PM', id: `p${++seq}`, eventId: o.eventId || `e${seq}`, bestBid: 0.4, bestAsk: 0.41, vol24: 1000, tokenIds: ['y', 'n'], rulesHash: `p${seq}`, ...o });
const pairsOf = (pm, ks) => m.matchAny(pm, ks).candidates.map((c) => [c.pm.groupItemTitle || c.pm.question, c.ks.ticker]);
const has = (pm, ks, ticker) => m.matchAny(pm, ks).candidates.some((c) => c.ks.ticker === ticker);

group('the same outcome is paired');
{
  // party races: Polymarket names the candidate with a party tag, Kalshi the candidate alone
  const iowaK = [
    K('SENATEIA-26-R', { eventTicker: 'SENATEIA-26', eventTitle: 'Iowa Senate winner?', eventSubTitle: 'In 2026', title: 'Will Republicans win the Senate race in Iowa?', yesSubTitle: 'Ashley Hinson', strikeType: 'structured' }),
    K('SENATEIA-26-D', { eventTicker: 'SENATEIA-26', eventTitle: 'Iowa Senate winner?', eventSubTitle: 'In 2026', title: 'Will Democratics win the Senate race in Iowa?', yesSubTitle: 'Josh Turek', strikeType: 'structured' }),
  ];
  const iowaP = [
    P({ eventId: 'ia', eventTitle: 'Iowa Senate Election Winner', question: 'Will the Republicans win the Iowa Senate race in 2026?', groupItemTitle: 'Ashley Hinson (R)' }),
    P({ eventId: 'ia', eventTitle: 'Iowa Senate Election Winner', question: 'Will the Democrats win the Iowa Senate race in 2026?', groupItemTitle: 'Josh Turek (D)' }),
  ];
  const got = pairsOf(iowaP, iowaK);
  ok('each Iowa candidate pairs to their own party market', got.length === 2 && got.some(([l, t]) => /Hinson/.test(l) && t === 'SENATEIA-26-R') && got.some(([l, t]) => /Turek/.test(l) && t === 'SENATEIA-26-D'), got);
  const c = m.matchAny(iowaP, iowaK).candidates[0];
  ok('a candidate carries the id shape, how, category, series and a rules key', /^p\d+:0\|SENATEIA-26-[RD]$/.test(c.id) && c.how === 'names' && c.category === 'Elections' && c.series === 'SENATEIA' && c.rulesKey.includes(':'), c);
  ok('its label has no " · " and no ": "', !/ · |: /.test(c.label), c.label);

  // name forms: J.D. / JD, middle initials, transliteration
  const pres = [K('KXPRESPERSON-28-JVAN', { eventTicker: 'KXPRESPERSON-28', eventTitle: 'Who will win the next presidential election?', title: 'Who will win the next presidential election?', yesSubTitle: 'J.D. Vance' }),
    K('KXPRESPERSON-28-DTRU', { eventTicker: 'KXPRESPERSON-28', eventTitle: 'Who will win the next presidential election?', title: 'Who will win the next presidential election?', yesSubTitle: 'Donald J. Trump' })];
  const presP = [P({ eventId: 'pr', eventTitle: 'Presidential Election Winner 2028', question: 'Will JD Vance win the 2028 US Presidential Election?', groupItemTitle: 'JD Vance' }),
    P({ eventId: 'pr', eventTitle: 'Presidential Election Winner 2028', question: 'Will Donald Trump win the 2028 US Presidential Election?', groupItemTitle: 'Donald Trump' })];
  ok('"JD Vance" is "J.D. Vance" and "Donald Trump" is "Donald J. Trump"', pairsOf(presP, pres).length === 2, pairsOf(presP, pres));
  ok('"Iotova" and "Yotova" are one name, one letter apart', m.namesMatch('Iliana Iotova', 'Iliana Yotova') && !m.namesMatch('Iliana Iotova', 'Irina Yotova'));
  ok('a Cyrillic A in a name does not break it', m.namesMatch('Аndrey Gyurov', 'Andrey Gyurov'));
  ok('one-word names must match exactly', m.namesMatch('Drake', 'Drake') && !m.namesMatch('Drake', 'Drake Bell'));

  // balance of power, chambers in either order
  const combo = [K('KXBALANCEPOWERCOMBO-27FEB-DR', { eventTicker: 'KXBALANCEPOWERCOMBO-27FEB', eventTitle: '2026 Midterms: Congress Balance of Power?', title: 'Will House Control be Democratic AND Senate Control be Republican for Feb 2027?', yesSubTitle: 'D-House, R-Senate' }),
    K('KXBALANCEPOWERCOMBO-27FEB-RD', { eventTicker: 'KXBALANCEPOWERCOMBO-27FEB', eventTitle: '2026 Midterms: Congress Balance of Power?', title: 'Will House Control be Republican AND Senate Control be Democratic for Feb 2027?', yesSubTitle: 'R-House, D-Senate' })];
  const comboP = [P({ eventId: 'bp', eventTitle: 'Balance of Power: 2026 Midterms', question: '2026 Balance of Power: R Senate, D House', groupItemTitle: 'R Senate, D House' })];
  const cg = pairsOf(comboP, combo);
  ok('"R Senate, D House" pairs to D-House, R-Senate, not R-House, D-Senate', cg.length === 1 && cg[0][1] === 'KXBALANCEPOWERCOMBO-27FEB-DR', cg);

  // deadlines: "by September 30" is "Before Oct 1, 2026"
  const xiK = [K('KXXIUSA-26JUL07-OCT01', { eventTicker: 'KXXIUSA-26JUL07', category: 'Politics', eventTitle: 'Will Xi Jinping visit the US?', title: 'Will Xi Jinping visit the United States of America before Oct 1, 2026?', yesSubTitle: 'Before Oct 1, 2026' }),
    K('KXXIUSA-26JUL07-NOV01', { eventTicker: 'KXXIUSA-26JUL07', category: 'Politics', eventTitle: 'Will Xi Jinping visit the US?', title: 'Will Xi Jinping visit the United States of America before Nov 1, 2026?', yesSubTitle: 'Before Nov 1, 2026' })];
  const xiP = [P({ eventId: 'xi', eventTitle: 'Will Xi Jinping visit US by...?', question: 'Will Xi Jinping visit US by September 30?', groupItemTitle: 'September 30', endDate: '2026-10-01T03:59:00Z' }),
    P({ eventId: 'xi', eventTitle: 'Will Xi Jinping visit US by...?', question: 'Will Xi Jinping visit US by October 31?', groupItemTitle: 'October 31', endDate: '2026-11-01T03:59:00Z' })];
  const xg = pairsOf(xiP, xiK);
  ok('each deadline rung pairs to the Kalshi rung for the same last day', xg.length === 2 && xg.some(([l, t]) => l === 'September 30' && /OCT01$/.test(t)) && xg.some(([l, t]) => l === 'October 31' && /NOV01$/.test(t)), xg);
  ok('"before 2027" ends on Dec 31 2026, not 2027', m.pmDeadline('', 'Will the US confirm that aliens exist before 2027?') === '2026-12-31' && m.pmDeadline('December 31', 'Will the US confirm that aliens exist before 2027?') === '2026-12-31');
  ok('"Before 2028" is Dec 31 2027', m.ksDeadline('Before 2028') === '2027-12-31' && m.ksDeadline('Before Jan 1, 2027') === '2026-12-31');

  // thresholds on the statistic's own tick
  const cpiK = [K('KXCPIYOY-26SEP-T3.9', { eventTicker: 'KXCPIYOY-26SEP', category: 'Economics', eventTitle: 'Inflation in September 2026 (CPI YoY)', eventSubTitle: 'In Sep 2026', title: 'Will the rate of CPI inflation be above 3.9% for the year ending in September 2026?', yesSubTitle: 'Above 3.9%', strikeType: 'greater', floorStrike: 3.9, rulesPrimary: 'If the Consumer Price Index (CPI) increases by more than 3.9% in the twelve months ending September 2026, then the market resolves to Yes.' })];
  const cpiP = [P({ eventId: 'cpi', eventTitle: 'September Inflation US - Annual', question: 'Will annual inflation be 4.0% or more in September?', groupItemTitle: '≥4.0%',
    description: 'This market will resolve to the percentage change in the Consumer Price Index (CPI) over the 12-month period ending in September 2026 according to the monthly Bureau of Labor Statistics (BLS) report.' })];
  ok('"≥4.0%" is Kalshi\'s "Above 3.9%" on a one-decimal series', has(cpiP, cpiK, 'KXCPIYOY-26SEP-T3.9'), pairsOf(cpiP, cpiK));
  const tsyK = [K('KX10YRDIRLM-26SEP30L-T4.67', { eventTicker: 'KX10YRDIRLM-26SEP30L', category: 'Financials', eventTitle: 'How low will the 10Y Treasury yield go in September?', title: 'Will the 10Y U.S. Treasury yield be below 4.67% by Sep 30, 2026?', yesSubTitle: '4.66% or below', strikeType: 'less', capStrike: 4.67 })];
  const tsyP = [P({ eventId: 'ty', eventTitle: 'How low will 10-year Treasury yield get in September?', question: 'Will the 10-year Treasury yield dip below 4.67% in September?', groupItemTitle: 'Below 4.67%' })];
  ok('"dip below 4.67%" is Kalshi\'s T4.67 "4.66% or below"', has(tsyP, tsyK, 'KX10YRDIRLM-26SEP30L-T4.67'), pairsOf(tsyP, tsyK));
  const spaceK = [K('KXSPACEXCOUNT-26SEP-14', { eventTicker: 'KXSPACEXCOUNT-26SEP', category: 'Science and Technology', eventTitle: 'How many launches will SpaceX have in Sep 2026?', title: 'How many launches will SpaceX have in Sep 2026?', yesSubTitle: 'Above 14', strikeType: 'greater', floorStrike: 14, rulesPrimary: 'If SpaceX has more than 14 launches in September 2026, then the market resolves to Yes.' })];
  const spaceP = [P({ eventId: 'sx', eventTitle: 'How many SpaceX launches in September?', question: 'Will SpaceX have 15+ launches in September 2026?', groupItemTitle: '15+' })];
  ok('"15+" launches is Kalshi\'s "Above 14"', has(spaceP, spaceK, 'KXSPACEXCOUNT-26SEP-14'), pairsOf(spaceP, spaceK));
  ok('an exact PM bucket pairs with a Kalshi "Exactly"', m.sameInterval(m.pmInterval('3.5%'), m.ksInterval({ yesSubTitle: 'Exactly 3.5%', strikeType: 'custom' })) === 'same');
}

group('near-misses are rejected, with the reason');
{
  const why = (pm, ks) => m.matchAny(pm, ks).rejected.map((r) => r.why);
  // one tick apart: "dip below 4.67%" is <= 4.66, Kalshi T4.68 "4.67% or below" is <= 4.67
  const t468 = [K('KX10YRDIRLM-26SEP30L-T4.68', { eventTicker: 'KX10YRDIRLM-26SEP30L', category: 'Financials', eventTitle: 'How low will the 10Y Treasury yield go in September?', title: 'Will the 10Y U.S. Treasury yield be below 4.68% by Sep 30, 2026?', yesSubTitle: '4.67% or below', strikeType: 'less', capStrike: 4.68 })];
  const tsyP = [P({ eventId: 'ty2', eventTitle: 'How low will 10-year Treasury yield get in September?', question: 'Will the 10-year Treasury yield dip below 4.67% in September?', groupItemTitle: 'Below 4.67%' })];
  ok('a threshold one tick off is not a pair', !has(tsyP, t468, 'KX10YRDIRLM-26SEP30L-T4.68'));
  ok('...and is reported as a tick near-miss', why(tsyP, t468).includes('tick'), why(tsyP, t468));
  // "7+ hurricanes" is not "more than 7", whatever else the rules say "or above" about
  const hur = [K('KXHURCTOT-26DEC01-T7', { eventTicker: 'KXHURCTOT-26DEC01', category: 'Climate and Weather', eventTitle: 'How many Atlantic hurricanes in 2026?', title: 'Will there be more than 7  Atlantic hurricanes in 2026?', yesSubTitle: 'Above 7', strikeType: 'greater', floorStrike: 7,
    rulesPrimary: 'If the NOAA\'s National Hurricane Center records more than 7 hurricanes of hurricane category 1 or above between January 1, 2026 and December 01, 2026, then the market resolves to Yes.' })];
  const hurP = [P({ eventId: 'hu', eventTitle: 'How many hurricanes in the 2026 Atlantic season?', question: 'Will there be 7+ hurricanes during the Atlantic Hurricane Season in 2026?', groupItemTitle: '7+' })];
  ok('"7+" is not "more than 7" (the "or above" is about hurricane category)', !has(hurP, hur, 'KXHURCTOT-26DEC01-T7'), pairsOf(hurP, hur));
  // an exact bucket against a threshold on the same series
  const t34 = [K('KXCPIYOY-26SEP-T3.4', { eventTicker: 'KXCPIYOY-26SEP', category: 'Economics', eventTitle: 'Inflation in September 2026 (CPI YoY)', title: 'Will the rate of CPI inflation be above 3.4% for the year ending in September 2026?', yesSubTitle: 'Above 3.4%', strikeType: 'greater', floorStrike: 3.4 })];
  const exact = [P({ eventId: 'c2', eventTitle: 'September Inflation US - Annual', question: 'Will annual inflation be 3.5% in September?', groupItemTitle: '3.5%' })];
  ok('PM "3.5%" exactly is not Kalshi "Above 3.4%"', !has(exact, t34, 'KXCPIYOY-26SEP-T3.4'), pairsOf(exact, t34));
  // complements
  const u3 = [K('KXU3-26SEP-T3.8', { eventTicker: 'KXU3-26SEP', category: 'Economics', eventTitle: 'Unemployment rate in September 2026', title: 'Will the unemployment rate (U-3) be above 3.8% in September?', yesSubTitle: 'Above 3.8%', strikeType: 'greater', floorStrike: 3.8 })];
  const u3P = [P({ eventId: 'u3', eventTitle: 'September Unemployment Rate', question: 'Will the September 2026 unemployment rate be ≤3.8%?', groupItemTitle: '≤3.8%' })];
  ok('a complement ("≤3.8%" vs "Above 3.8%") is never paired as the same side', !has(u3P, u3, 'KXU3-26SEP-T3.8') && why(u3P, u3).includes('polarity'), why(u3P, u3));
  // nominations are not wins
  const nom = [K('KXOSCARNOMPIC-27-INV', { eventTicker: 'KXOSCARNOMPIC-27', category: 'Entertainment', eventTitle: '2027 Best Picture Oscar nominations?', title: '2027 Best Picture Oscar nominations?', yesSubTitle: 'The Invite' })];
  const win = [P({ eventId: 'os', eventTitle: 'Oscars 2027: Best Picture Winner', question: 'Will The Invite win Best Picture at the 99th Academy Awards?', groupItemTitle: 'The Invite' })];
  ok('an Oscar nomination is not an Oscar win', !has(win, nom, 'KXOSCARNOMPIC-27-INV'), pairsOf(win, nom));
  // ranks
  const fourth = [K('KXBRPRESIDENT4-BRPRES26-4-RSAN', { eventTicker: 'KXBRPRESIDENT4-BRPRES26-4', eventTitle: 'Who will finish 4th in the first round of the 2026 Brazilian presidential election?', title: 'Will Renan Santos finish 4th in the first round of the 2026 Brazilian presidential election?', yesSubTitle: 'Renan Santos' })];
  const most = [P({ eventId: 'br', eventTitle: 'Brazil Presidential Election: Most votes in first round', question: 'Will Renan Santos win the most votes in the first round of the 2026 Brazil presidential election?', groupItemTitle: 'Renan Santos' })];
  ok('finishing 4th is not winning the most votes', !has(most, fourth, 'KXBRPRESIDENT4-BRPRES26-4-RSAN'), pairsOf(most, fourth));
  ok('"third-place" and "3 place" are the same rank', m.eventGate('Will Rick Devens come in third-place on Big Brother season 28?', 'Will Rick Devens finish in 3 place in Big Brother Season 28?') === null);
  // a different party in a vote-share ladder with the same number
  const afd = [K('KXVOTEMV-26SEP20AFD-31', { eventTicker: 'KXVOTEMV-26SEP20AFD', eventTitle: '2026 Mecklenburg-Vorpommern election: AfD vote share', title: 'Will AfD receive at least 31% of valid second votes in the 2026 Mecklenburg-Vorpommern parliamentary election?', yesSubTitle: 'At least 31%', strikeType: 'greater_or_equal', floorStrike: 31 })];
  const spd = [P({ eventId: 'mv', eventTitle: 'Mecklenburg-Vorpommern election: vote share', question: 'Will SPD win at least 31% of all valid second votes?', groupItemTitle: '31%+' })];
  ok('SPD at 31% is not AfD at 31%', !has(spd, afd, 'KXVOTEMV-26SEP20AFD-31'), pairsOf(spd, afd));
  // one lab's model is not any model
  const hle = [K('KXLASTEXAM-26DEC31-T55', { eventTicker: 'KXLASTEXAM-26DEC31', category: 'Science and Technology', eventTitle: "Humanity's Last Exam top score in 2026", title: "Will any LLM score at least 55% on Humanity's Last Exam before Dec 31, 2026?", yesSubTitle: 'At least 55%', strikeType: 'greater_or_equal', floorStrike: 55 })];
  const oai = [P({ eventId: 'hl', eventTitle: "Highest OpenAI score on Humanity's Last Exam in 2026?", question: "Will the highest score achieved by an OpenAI model on Humanity's Last Exam in 2026 be 55% or higher?", groupItemTitle: '55%+' })];
  ok('the best OpenAI score is not the best score of any model', !has(oai, hle, 'KXLASTEXAM-26DEC31-T55'), pairsOf(oai, hle));
  // Supporting Actress is not Actress
  const supp = [K('KXOSCARSUPACTR-27-SAN', { eventTicker: 'KXOSCARSUPACTR-27', category: 'Entertainment', eventTitle: 'Oscar for Best Supporting Actress', title: 'Will Sandra Hüller win Best Supporting Actress at the Oscars?', yesSubTitle: 'Sandra Hüller' })];
  const actr = [P({ eventId: 'ac', eventTitle: 'Oscars 2027: Best Actress Winner', question: 'Will Sandra Hüller win Best Actress at the 99th Academy Awards?', groupItemTitle: 'Sandra Hüller' })];
  ok('Best Actress is not Best Supporting Actress', !has(actr, supp, 'KXOSCARSUPACTR-27-SAN'), pairsOf(actr, supp));
  // Xi out is not Xi visits Taiwan; Bank of Canada is not the Fed
  const tw = [K('KXXITAIWAN-28JAN01', { eventTicker: 'KXXITAIWAN', category: 'Politics', eventTitle: 'Will Xi Jinping visit Taiwan?', title: 'Will Xi Jinping visit Taiwan before Jan 1, 2028?', yesSubTitle: 'Before 2028' })];
  const out = [P({ eventId: 'xo', eventTitle: 'Xi Jinping out before 2027?', question: 'Xi Jinping out before 2027?' })];
  ok('"Xi out" is not "Xi visits Taiwan"', !has(out, tw, 'KXXITAIWAN-28JAN01'), pairsOf(out, tw));
  const fed = [K('FEDHIKE-26DEC31', { eventTicker: 'FEDHIKE', category: 'Economics', eventTitle: 'Next Fed rate hike?', title: 'Will the Federal Reserve hike rates by December 31, 2026?', yesSubTitle: 'Before 2027' })];
  const boc = [P({ eventId: 'bc', eventTitle: 'Bank of Canada Rate Hike in 2026?', question: 'Bank of Canada Rate Hike in 2026?' })];
  ok('a Bank of Canada hike is not a Fed hike', !has(boc, fed, 'FEDHIKE-26DEC31'), pairsOf(boc, fed));
  // PM "Other" never pairs; different years never pair
  const oth = [P({ eventId: 'ia', eventTitle: 'Iowa Senate Election Winner', question: 'Will another candidate win the Iowa Senate race?', groupItemTitle: 'Other' })];
  ok('a Polymarket "Other" bucket never pairs', m.matchAny(oth, [K('SENATEIA-26-R', { eventTicker: 'SENATEIA-26', eventTitle: 'Iowa Senate winner?', title: 'Will Republicans win the Senate race in Iowa?', yesSubTitle: 'Other' })]).candidates.length === 0);
  ok('different years in the titles reject the event pair', m.eventGate('Will Karen Bass win the 2026 Los Angeles mayoral election?', 'Who will win the 2030 Los Angeles Mayoral Election?').why === 'figures');
}

group('a fight: two named Polymarket outcomes against two Kalshi legs');
{
  // Real text from UFC 331, 2026-09-19. Polymarket lists the bout as ONE market whose outcomes are
  // the fighters; Kalshi lists it as TWO "X wins" markets. Before this shape was matched, the whole
  // card -- eight fights, live on both venues -- paired nothing at all.
  const vanpanK = [
    K('KXUFCFIGHT-26SEP19VANPAN-VAN', { eventTicker: 'KXUFCFIGHT-26SEP19VANPAN', category: 'Sports', seriesTicker: 'KXUFCFIGHT', eventTitle: '331: Van vs Pantoja', eventSubTitle: 'Van vs Pantoja', title: 'Joshua Van wins', yesSubTitle: 'Joshua Van', yesBid: 0.58, yesAsk: 0.59 }),
    K('KXUFCFIGHT-26SEP19VANPAN-PAN', { eventTicker: 'KXUFCFIGHT-26SEP19VANPAN', category: 'Sports', seriesTicker: 'KXUFCFIGHT', eventTitle: '331: Van vs Pantoja', eventSubTitle: 'Van vs Pantoja', title: 'Alexandre Pantoja wins', yesSubTitle: 'Alexandre Pantoja', yesBid: 0.41, yesAsk: 0.42 }),
  ];
  const vanpanP = [P({ eventId: 'ufc331vp', eventTitle: 'UFC 331: Alexandre Pantoja vs. Joshua Van (Flyweight, Main Card)',
    question: 'UFC 331: Alexandre Pantoja vs. Joshua Van (Flyweight, Main Card)', outcomes: ['Alexandre Pantoja', 'Joshua Van'], tokenIds: ['pan-tok', 'van-tok'] })];

  // Scoring is idf-weighted, so it only means anything against a corpus. Half of these are other
  // fights, on purpose: Kalshi had 250 open fight markets that night, so "UFC", "Flyweight" and
  // "Main Card" are ORDINARY words there, and the fighters' names are the rare ones that carry the
  // match. Score them against a corpus with no other fight in it and the reverse happens -- the
  // words Polymarket adds outweigh the names and the bout misses the 0.34 floor. That is a property
  // of the fixture, not of the matcher, and it is why the noise is shaped like the real listing.
  const noise = ['Fed decision in September', 'Who will win the Iowa Senate race', 'TIME Person of the Year',
    'Premier League: Arsenal vs Chelsea', 'Highest temperature in New York', 'Bitcoin above 100000 on Dec 31',
    'Oscar Best Picture winner', 'Government shutdown before October', 'NBA Finals champion', 'Next UK prime minister',
    'CPI year over year for August', 'Who will control the Senate',
    'UFC Flyweight Title holder on Dec 31, 2027', 'UFC Heavyweight Title holder on Dec 31, 2027',
    'UFC Main Card: Islam Makhachev wins', '331: Tuivasa vs Despaigne', '331: Vera vs Jourdain',
    'UFC Method of Victory: Sean Strickland', 'Will Conor McGregor compete in a UFC fight',
    'Boxing Welterweight Title holder'].map((t, i) =>
    K(`NOISE${i}-26-Y`, { eventTicker: `NOISE${i}-26`, eventTitle: t, eventSubTitle: '', title: t, yesSubTitle: 'Yes' }));

  const r = m.matchAny(vanpanP, vanpanK.concat(noise));
  ok('both sides of the fight are paired, not just one', r.candidates.length === 2, r.candidates.map((c) => c.ks.ticker));
  const pan = r.candidates.find((c) => c.ks.ticker.endsWith('-PAN'));
  const van = r.candidates.find((c) => c.ks.ticker.endsWith('-VAN'));
  ok('Pantoja\'s Kalshi leg takes the Pantoja token', pan && pan.tokenIndex === 0, pan && pan.tokenIndex);
  ok('Van\'s Kalshi leg takes the Van token, which no candidate could reach before', van && van.tokenIndex === 1, van && van.tokenIndex);
  ok('the id carries the token, so the two legs are distinct', pan && van && pan.id !== van.id && /:1\|/.test(van.id), [pan && pan.id, van && van.id]);
  ok('how says how it matched', r.candidates.every((c) => c.how === 'outcomes'), r.candidates.map((c) => c.how));
  ok('the category and series come off the Kalshi leg', pan.category === 'Sports' && pan.series === 'KXUFCFIGHT', [pan.category, pan.series]);
  ok('the weight class and card position are not read as missing entities', !r.rejected.some((x) => x.why === 'entity'), r.rejected);

  // the gates
  const otherCard = m.matchAny([P({ eventId: 'x', eventTitle: 'UFC 332: Alexandre Pantoja vs. Joshua Van', question: 'UFC 332: Alexandre Pantoja vs. Joshua Van', outcomes: ['Alexandre Pantoja', 'Joshua Van'], tokenIds: ['a', 'b'] })], vanpanK.concat(noise));
  ok('UFC 332 does not pair with the 331 event', otherCard.candidates.length === 0, otherCard.candidates.map((c) => c.ks.ticker));

  const oneFighter = m.matchAny([P({ eventId: 'y', eventTitle: 'UFC 331: Alexandre Pantoja vs. Joshua Van (Flyweight, Main Card)', question: 'UFC 331: Alexandre Pantoja vs. Joshua Van (Flyweight, Main Card)', outcomes: ['Alexandre Pantoja', 'Brandon Moreno'], tokenIds: ['a', 'b'] })], vanpanK.concat(noise));
  ok('a card where only one fighter matches is not the same bout', !oneFighter.candidates.some((c) => c.how === 'outcomes'), oneFighter.candidates.map((c) => [c.how, c.ks.ticker]));

  const yesNo = m.matchAny([P({ eventId: 'z', eventTitle: '331: Van vs Pantoja', question: 'Will Joshua Van win?', outcomes: ['Yes', 'No'], tokenIds: ['a', 'b'] })], vanpanK.concat(noise));
  ok('a plain Yes/No market still goes down the generic path', !yesNo.candidates.some((c) => c.how === 'outcomes'), yesNo.candidates.map((c) => c.how));

  // both tokens of one market must survive the de-duplication
  ok('two candidates share one Polymarket market id', pan.pm.id === van.pm.id, [pan.pm.id, van.pm.id]);
  ok('and neither was dropped as a duplicate', !r.rejected.some((x) => x.why === 'duplicate'), r.rejected);
}

group('one Polymarket market per Kalshi ticker, best first');
{
  const k = K('KXTIME-26-DT', { eventTicker: 'KXTIME-26', category: 'Entertainment', eventTitle: 'Time Person of the Year 2026', title: 'Will Donald Trump be Time Person of the Year in 2026?', yesSubTitle: 'Donald Trump' });
  const a = P({ eventId: 't1', eventTitle: 'TIME Person of the Year 2026', question: 'Will Donald Trump be TIME Person of the Year 2026?', groupItemTitle: 'Donald Trump' });
  const b = P({ eventId: 't2', eventTitle: 'Donald Trump TIME Person of the Year 2026?', question: 'Will Donald Trump be named TIME Person of the Year 2026?', groupItemTitle: 'Donald Trump' });
  const r = m.matchAny([a, b], [k]);
  ok('only one of two Polymarket markets claims the Kalshi ticker', r.candidates.length === 1, r.candidates.map((c) => c.pm.id));
  ok('the other is a named duplicate', r.rejected.some((x) => x.why === 'duplicate'), r.rejected);
}

group('fast enough for the whole universe');
{
  const ks = [], pm = [];
  for (let i = 0; i < 20000; i++) ks.push(K(`KXSYN${i % 4000}-26-M${i}`, { eventTicker: `KXSYN${i % 4000}-26`, eventTitle: `Synthetic event ${i % 4000} alpha${i % 97} beta${i % 89}`, title: `Will outcome ${i} happen in synthetic event ${i % 4000}?`, yesSubTitle: `Person${i} Name${i}` }));
  for (let i = 0; i < 8000; i++) pm.push(P({ eventId: `se${i % 1000}`, eventTitle: `Synthetic event ${i % 1000} alpha${i % 97} beta${i % 89}`, question: `Will Person${i} Name${i} win?`, groupItemTitle: `Person${i} Name${i}` }));
  const t = Date.now();
  const r = m.matchAny(pm, ks);
  const ms = Date.now() - t;
  ok(`8,000 Polymarket x 20,000 Kalshi markets match in under 10 seconds (${ms}ms)`, ms < 10000, ms);
  ok('and the stats say what was done', r.stats.pmEvents === 1000 && r.stats.ksEvents === 4000 && Number.isFinite(r.stats.ms), r.stats);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

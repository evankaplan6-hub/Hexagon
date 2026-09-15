'use strict';
// Assertions for src/rules.js -- whether two matched contracts resolve the same way.
//
// A pair only trades when its verdict is `same`. The fixtures below are the venues' own rules
// texts, excerpted from the live listings on 2026-09-15, for pairs whose rules were read side by
// side: the ones that resolve the same, and the look-alikes that do not while trading within a few
// cents of each other. No network, no clock: the Claude path runs against a stubbed `post`.
//
//   node tools/rules-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const rules = require('../src/rules');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const pair = (id, pm, ks) => ({ id, rulesKey: `${id}:pm:${(pm.description || '').length}|ks:${(ks.rulesPrimary || '').length}`, pm, ks });

const FIX = {
  iowa: pair('iowa',
    { eventTitle: 'Iowa Senate Election Winner', question: 'Will the Republicans win the Iowa Senate race in 2026?', groupItemTitle: 'Ashley Hinson (R)',
      description: 'This market will resolve according to the winner of the 2026 midterm Iowa U.S. Senate election, inclusive of any run-offs. A candidate shall be considered to represent a party in the event that he or she is the nominee of the party in question. The resolution source for this market is the Associated Press, Fox News, and NBC. This market will resolve once all three sources call the race for the same candidate.' },
    { ticker: 'SENATEIA-26-R', seriesTicker: 'SENATEIA', title: 'Will Republicans win the Senate race in Iowa?', yesSubTitle: 'Ashley Hinson',
      rulesPrimary: 'If a representative of the Republican party is sworn in as a Senator of Iowa for the term beginning in 2027, then the market resolves to Yes.',
      rulesSecondary: 'This market is eligible for accelerated determination after a consensus of media organizations project the winner.' }),
  control: pair('control',
    { eventTitle: 'Which party will win the Senate in 2026?', question: 'Will the Democratic Party control the Senate after the 2026 Midterm elections?', groupItemTitle: 'Democratic Party',
      description: 'This market will resolve according to the party that wins control of the United States Senate in the 2026 United States midterm election. A party wins control of the United States Senate if it wins a majority of the chamber’s voting seats. If no party wins a majority of voting seats, the party that wins control of the chamber is the party that wins half of the voting seats and holds the Vice Presidency.' },
    { ticker: 'CONTROLS-2026-D', seriesTicker: 'CONTROLS', title: 'Will Democrats win the U.S. Senate in 2026?', yesSubTitle: 'Democratic Party',
      rulesPrimary: 'If the Democratic Party has won control of the U.S. Senate in 2026, then the market resolves to Yes.',
      rulesSecondary: 'Otherwise, victory will be determined by the party identification of the President pro tempore of the Senate on February 1, 2027.' }),
  vance: pair('vance',
    { eventTitle: 'Republican Presidential Nominee 2028', question: 'Will J.D. Vance win the 2028 Republican presidential nomination?', groupItemTitle: 'J.D. Vance',
      description: 'This market will resolve to “Yes” if the named individual wins and accepts the 2028 nomination of the Republican Party for U.S. president. Any replacement of the Republican nominee before election day will not change the resolution of the market.' },
    { ticker: 'KXPRESNOMR-28-JDV', seriesTicker: 'KXPRESNOMR', title: 'Will J.D. Vance be the nominee for the Presidency for the Republican party?', yesSubTitle: 'J.D. Vance',
      rulesPrimary: 'If J.D. Vance wins and accepts the nomination for the Presidency for the Republican party in 2028, then the market resolves to Yes.', rulesSecondary: '' }),
  xi: pair('xi',
    { eventTitle: 'Will Xi Jinping visit US by...?', question: 'Will Xi Jinping visit US by September 30?', groupItemTitle: 'September 30',
      description: 'If Xi Jinping visits the United States between market creation and September 30, 2026, 11:59 PM ET, this market will resolve to "Yes". For the purpose of this market, a "visit" is defined as Xi Jinping physically entering the terrestrial or maritime territory of the United States.' },
    { ticker: 'KXXIUSA-26JUL07-OCT01', seriesTicker: 'KXXIUSA', title: 'Will Xi Jinping visit the United States of America before Oct 1, 2026?', yesSubTitle: 'Before Oct 1, 2026',
      rulesPrimary: 'If Xi Jinping has physically travelled to and been present within the geographic boundaries of the United States of America before Oct 1, 2026, then the market resolves to Yes.',
      rulesSecondary: 'The following do NOT constitute a visit: Flying over the area without landing.' }),
  cpi: pair('cpi',
    { eventTitle: 'September Inflation US - Annual', question: 'Will annual inflation be 3.5% in September?', groupItemTitle: '3.5%',
      description: 'This is a market about inflation over the 12-month period ending September 2026, before seasonal adjustment, as reported by the Bureau of Labor Statistics.' },
    { ticker: 'KXECONSTATCPIYOY-26SEP-T3.5', seriesTicker: 'KXECONSTATCPIYOY', title: 'CPI year-over-year in Sep 2026?', yesSubTitle: 'Exactly 3.5%',
      rulesPrimary: 'If the CPI year-over-year is exactly 3.5% in Sep 2026, then the market resolves to Yes.', rulesSecondary: '' }),
  netanyahu: pair('netanyahu',
    { eventTitle: 'Netanyahu out by...?', question: 'Netanyahu out by end of 2026?', groupItemTitle: 'December 31',
      description: 'This market will resolve to “Yes” if Benjamin Netanyahu ceases to be Prime Minister of Israel for any period of time between market creation and the specified date (ET). An announcement of Benjamin Netanyahu\'s resignation/removal before this market\'s end date will immediately resolve this market to "Yes", regardless of when the announced resignation/removal goes into effect.' },
    { ticker: 'KXLEADERSOUT-27JAN01-BNETISR', seriesTicker: 'KXLEADERSOUT', title: 'Will Benjamin Netanyahu leave Prime Minister of Israel before Jan 1, 2027?', yesSubTitle: 'Benjamin Netanyahu',
      rulesPrimary: 'If Benjamin Netanyahu has either officially announced their intention to leave as Prime Minister of Israel or has actually left Prime Minister of Israel before Jan 1, 2027, then the market resolves to Yes.',
      rulesSecondary: 'Temporary absences such as medical leave do NOT constitute leaving office. Death does NOT satisfy the Payout Criterion for this Contract.' }),
  hegseth: pair('hegseth',
    { eventTitle: 'Pete Hegseth out as Secretary of Defense by December 31?', question: 'Pete Hegseth out as Secretary of Defense by December 31?',
      description: 'This market will resolve to “Yes” if Pete Hegseth ceases to be U.S. Secretary of Defense for any period of time between market creation and the specified date (ET). An announcement of Pete Hegseth\'s resignation/removal before this market\'s end date will immediately resolve this market to "Yes", regardless of when the announced resignation/removal goes into effect.' },
    { ticker: 'KXTRUMPADMINLEAVE-26DEC31-PHEG', seriesTicker: 'KXTRUMPADMINLEAVE', title: 'Will Pete Hegseth leaves Secretary of Defense in before 2027?', yesSubTitle: 'Pete Hegseth',
      rulesPrimary: 'If Pete Hegseth leaves as Secretary of Defense before 2027, then the market resolves to Yes.',
      rulesSecondary: 'Pete Hegseth must have an actual departure date by vacating the role within the time period. If the person leaves the role due to death, all contracts on the person may resolve to the last fair price as determined in the sole discretion of the Exchange.' }),
  nyc: pair('nyc',
    { eventTitle: 'Highest temperature in NYC on September 15?', question: 'Will the highest temperature in New York City be between 72-73°F on September 15?', groupItemTitle: '72-73°F',
      description: 'This market will resolve to the temperature range that contains the highest temperature recorded by NOAA at the LaGuardia Airport Station in degrees Fahrenheit on 15 Sep \'26.', resolutionSource: 'https://www.weather.gov/wrh/timeseries?site=klga' },
    { ticker: 'KXHIGHNY-26SEP15-B72.5', seriesTicker: 'KXHIGHNY', title: 'Will the maximum temperature be 72-73° on Sep 15, 2026?', yesSubTitle: '72° to 73°',
      rulesPrimary: 'If the maximum temperature recorded at New York City (CLINYC) for Sep 15, 2026, is between 72-73° fahrenheit according to The Weather Company, then the market resolves to Yes.', rulesSecondary: '' }),
  btc: pair('btc',
    { eventTitle: 'Bitcoin above ___ on September 18?', question: 'Will the price of Bitcoin be above $78,000 on September 18?', groupItemTitle: '78,000',
      description: 'This market will resolve to "Yes" if the Binance 1 minute candle for BTC/USDT 12:00 in the ET timezone (noon) on the date specified in the title has a final "Close" price higher than the price specified in the title.' },
    { ticker: 'KXBTCD-26SEP1817-T77999.99', seriesTicker: 'KXBTCD', title: 'Bitcoin price on Sep 18, 2026?', yesSubTitle: '$78,000 or above',
      rulesPrimary: 'If the simple average of the sixty seconds of CF Benchmarks\' Bitcoin Real-Time Index (BRTI) before 5 PM EDT is above 77999.99 at 5 PM EDT on Sep 18, 2026, then the market resolves to Yes.', rulesSecondary: '' }),
  mcconnell: pair('mcconnell',
    { eventTitle: 'Mitch McConnell steps down from Senate before his term ends?', question: 'Mitch McConnell steps down from Senate before his term ends?',
      description: 'This market will resolve to “Yes” if Mitch McConnell formally announces an intention to step down or otherwise vacates his U.S. Senate seat before his current term is scheduled to end (January 3, 2027, 11:59 PM ET).' },
    { ticker: 'KXRETIREMM-26', seriesTicker: 'KXRETIREMM', title: 'Will Mitch McConnell resign his office early?', yesSubTitle: 'Before election day 2026',
      rulesPrimary: 'If Mitch McConnell has resigned, retired, or otherwise voluntarily stepped down from their Congressional office, or announced their intent to resign, retire, or otherwise voluntarily step down from their office prematurely, after Issuance and before Nov 3, 2026, then the market resolves to Yes.', rulesSecondary: '' }),
  // no family on either list, and nothing in the texts that disagrees
  unknown: pair('unknown',
    { eventTitle: 'Will the US confirm a new moon base by 2027?', question: 'Will the US confirm a new moon base by 2027?', description: 'Resolves Yes if NASA officially confirms a crewed lunar base by December 31, 2026, 11:59 PM ET.' },
    { ticker: 'KXMOONBASE-27', seriesTicker: 'KXMOONBASE', title: 'Will the US confirm a moon base before 2027?', yesSubTitle: 'Before 2027', rulesPrimary: 'If NASA confirms a crewed lunar base before Jan 1, 2027, then the market resolves to Yes.', rulesSecondary: '' }),
};

group('pairs whose rules were read and match are `same`');
for (const k of ['iowa', 'control', 'vance', 'xi', 'cpi']) {
  const v = rules.staticVerdict(FIX[k]);
  ok(`${k}: same, from the allowlist`, v.verdict === 'same' && v.source === 'allowlist', v);
}

group('look-alikes that resolve differently are `different`, with the reason');
{
  const cases = {
    netanyahu: /leaving office|death/, hegseth: /leaving office|death/, nyc: /weather/, btc: /crypto price/, mcconnell: /leaving office/,
  };
  for (const [k, re] of Object.entries(cases)) {
    const v = rules.staticVerdict(FIX[k]);
    ok(`${k}: different`, v.verdict === 'different' && re.test(v.reason), v);
  }
}

group('the rule features catch the traps on their own, without the denylist');
{
  const conflicts = (c) => rules.featureConflicts(rules.ruleFeatures(`${c.pm.description}\n${c.pm.resolutionSource || ''}`), rules.ruleFeatures(`${c.ks.rulesPrimary}\n${c.ks.rulesSecondary}`));
  ok('Netanyahu: death counts on Polymarket, not on Kalshi', conflicts(FIX.netanyahu).some((r) => /^death/.test(r)), conflicts(FIX.netanyahu));
  ok('Hegseth: announcement vs actual departure', conflicts(FIX.hegseth).some((r) => /announcement.*departure|departure.*announcement/.test(r)), conflicts(FIX.hegseth));
  ok('NYC temperature: LaGuardia (KLGA link) vs Central Park (CLINYC)', conflicts(FIX.nyc).some((r) => /weather stations/.test(r)), conflicts(FIX.nyc));
  ok('Bitcoin: Binance vs CF Benchmarks', conflicts(FIX.btc).some((r) => /price sources/.test(r)), conflicts(FIX.btc));
  ok('a verified pair has none', conflicts(FIX.iowa).length === 0 && conflicts(FIX.control).length === 0 && conflicts(FIX.xi).length === 0, [conflicts(FIX.iowa), conflicts(FIX.xi)]);
  // an unlisted family whose texts disagree is still `different`
  const hidden = { ...FIX.netanyahu, ks: { ...FIX.netanyahu.ks, ticker: 'KXNEWLEADER-27-X', seriesTicker: 'KXNEWLEADER' } };
  const v = rules.staticVerdict(hidden);
  ok('a family on neither list is `different` when its texts conflict', v.verdict === 'different' && v.source === 'features', v);
  ok('one side silent on a dimension is not a conflict', rules.featureConflicts(rules.ruleFeatures('Death does NOT satisfy the Payout Criterion.'), rules.ruleFeatures('Resolves Yes if she leaves.')).length === 0);
}

group('an allowlisted family still needs the right Polymarket template');
{
  const wrongPm = { ...FIX.control, pm: { ...FIX.control.pm, eventTitle: 'Who will be governor?', question: 'Will Jane Doe win?' } };
  ok('CONTROLS against a question about neither chamber is not `same`', rules.staticVerdict(wrongPm).verdict !== 'same', rules.staticVerdict(wrongPm));
  ok('a family on neither list with nothing to compare is `unclear`', rules.staticVerdict(FIX.unknown).verdict === 'unclear');
}

group('the Claude check: cached, budgeted, one call per pair of rules texts, never overriding a conflict');
(async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-rules-'));
  const cfg = { ...base, dataDir, rulesCheck: true, rulesModel: 'claude-opus-5', rulesEffort: 'medium', rulesDailyUsd: 1 };
  const T = 1788900000000;
  let calls = 0, reply = '{"verdict":"same","reasons":["both pay on NASA confirmation before the same instant"]}';
  let release;
  const post = async (body) => {
    calls++;
    ok('the request carries both full rules texts', /NASA officially confirms/.test(body.messages[0].content) && /before Jan 1, 2027/.test(body.messages[0].content));
    await new Promise((r) => { release = r; });
    return { content: [{ type: 'text', text: reply }], usage: { input_tokens: 1000, output_tokens: 200 } };
  };
  const judge = rules.makeRulesJudge(cfg, { post, now: () => T });
  ok('nothing cached for a fresh pair', judge.verdictFor(FIX.unknown) === null);
  ok('an unclear pair is sent', judge.request(FIX.unknown) === true);
  await new Promise((r) => setTimeout(r, 5));   // the call goes out on the next tick, off the cycle
  ok('...once: a second request while the first is out is not', judge.request(FIX.unknown) === false && calls === 1, calls);
  release();
  await new Promise((r) => setTimeout(r, 10));
  ok('the answer is cached', judge.verdictFor(FIX.unknown) && judge.verdictFor(FIX.unknown).verdict === 'same');
  const fv = rules.finalVerdict(FIX.unknown, judge);
  ok('finalVerdict takes a cached Claude answer for an unclear pair', fv.verdict === 'same' && fv.source === 'claude', fv);
  ok('a denylisted pair is never sent', judge.request(FIX.netanyahu) === false && calls === 1);
  ok('an allowlisted pair is never sent', judge.request(FIX.iowa) === false && calls === 1);
  ok('a Claude answer never moves a pair the static gate already decided', rules.finalVerdict(FIX.btc, judge).verdict === 'different');
  const snap = judge.snapshot();
  ok('the spend is metered from usage', snap.spentTodayUsd >= 0 && snap.cached === 1 && snap.asked === 1, snap);

  const again = rules.makeRulesJudge(cfg, { post: async () => { calls++; return {}; }, now: () => T });
  ok('a restart reads the cache instead of asking again', again.verdictFor(FIX.unknown) && again.verdictFor(FIX.unknown).verdict === 'same' && again.request(FIX.unknown) === false && calls === 1);
  const changed = { ...FIX.unknown, rulesKey: 'unknown:changed' };
  ok('a changed rules text is a new question', again.verdictFor(changed) === null);

  const broke = rules.makeRulesJudge({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-rules-')), rulesDailyUsd: 0.0001 }, { post: async () => { calls++; return {}; }, now: () => T });
  ok('a call the day\'s budget cannot cover is not made', broke.request(changed) === false);
  const off = rules.makeRulesJudge({ ...cfg, rulesCheck: false }, { post, now: () => T });
  ok('RULES_CHECK off asks nothing', off.request(changed) === false);

  reply = 'I think these look similar but I am not sure.';
  const odd = rules.makeRulesJudge({ ...cfg, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-rules-')) }, { post: async () => ({ content: [{ type: 'text', text: reply }], usage: {} }), now: () => T });
  odd.request(changed);
  await new Promise((r) => setTimeout(r, 10));
  ok('an unreadable reply is cached as unclear, never same', odd.verdictFor(changed) && odd.verdictFor(changed).verdict === 'unclear', odd.verdictFor(changed));
  ok('parseVerdict reads a fenced reply and rejects a made-up verdict', rules.parseVerdict('```json\n{"verdict":"different","reasons":["x"]}\n```').verdict === 'different' && rules.parseVerdict('{"verdict":"probably"}') === null);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

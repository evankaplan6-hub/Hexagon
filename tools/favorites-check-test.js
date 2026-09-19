'use strict';
// The favourites check: the fixed rule, the Sports exclusion, and the four-part verdict. No network.
//
//   node tools/favorites-check-test.js
const { RULE, verdict, nonSports } = require('./favorites-check');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

// One market, quoted 82/84c every hour for 60 hours ending at `closeTs`, resolving `result`.
const H = 3600, END = 1_800_000_000;
const mk = (ticker, over = {}) => ({
  ticker, event: `EV-${ticker}`, series: 'S', category: 'Politics', result: 'yes', closeTs: END, earlyClose: false, expectTs: END, vol: 9999, feeMult: 1,
  bars: Array.from({ length: 60 }, (_, k) => [END - (60 - k) * H, 82, 84, 500]), ...over,
});

group('the rule is the one written down before the older data was scored');
ok('70c to 90c, 48 hours, and nothing else', RULE.minPx === 70 && RULE.maxPx === 90 && RULE.maxHoursLeft === 48, RULE);

group('Sports never counts');
ok('a Sports market is dropped, an uncategorised one too', nonSports([mk('a'), mk('b', { category: 'Sports' }), mk('c', { category: '' })]).length === 1);

group('the verdict');
{
  const winners = Array.from({ length: 6 }, (_, i) => mk(`W${i}`, { closeTs: END + i }));
  const v = verdict(winners);
  ok('an 84c favourite that always wins trades, and pays about 16c minus fee', v.all.n >= 6 && v.all.perContract > 10 && v.all.perContract < 16, v.all);
  ok('...but six events is nowhere near enough to confirm', v.confirmed === false && v.checks[0][1] === false, v.checks.map((c) => [c[0], c[1]]));
  ok('...and it reports why, one line per criterion', v.checks.length === 4);
  const losers = verdict(Array.from({ length: 6 }, (_, i) => mk(`L${i}`, { result: 'no', closeTs: END + i })));
  ok('a favourite that always loses is a loss', losers.all.perContract < -80, losers.all.perContract);
  ok('nothing outside Sports means nothing traded, not a throw', verdict([mk('s', { category: 'Sports' })]).all.n === 0);
  ok('a price outside 70-90c is not a trade', verdict([mk('p', { bars: mk('p').bars.map(([t, , , v]) => [t, 94, 96, v]) })]).all.n === 0);
  ok('more than 48 hours from the end is not a trade', verdict([mk('f', { bars: mk('f').bars.slice(0, 5).map(([t, b, a, v]) => [t - 200 * H, b, a, v]), closeTs: END, expectTs: END })]).all.n === 0);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

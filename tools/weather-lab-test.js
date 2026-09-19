'use strict';
// The weather lab: the probability model, the fit, and that the strategy never sees the answer. No network.
//
//   node tools/weather-lab-test.js
const { probYes, cdf, fit, prepare, evaluate, PRESET, CRITERIA } = require('./weather-lab');
const { localToEpoch, eventDate, addDays } = require('./weather-fetch');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const near = (a, b, e = 1e-3) => Math.abs(a - b) < e;

group('the normal curve');
ok('cdf at zero is one half, and is symmetric', near(cdf(0), 0.5) && near(cdf(1.3) + cdf(-1.3), 1));
ok('cdf at 1.96 is 97.5%', near(cdf(1.96), 0.975));

group('a whole degree, the way Kalshi settles it');
{
  // forecast 80, sigma 2: "greater 80" means 81 or above, half a degree above the mean's whole degree
  const g = probYes({ strikeType: 'greater', floor: 80 }, 80, 2), l = probYes({ strikeType: 'less', cap: 81 }, 80, 2);
  ok('"greater 80" (81 or above) is a bit under a coin flip at mean 80', g < 0.5 && near(g, 1 - cdf(0.25)), g);
  ok('"less 81" (80 or below) is a bit over a coin flip', l > 0.5 && near(l, cdf(0.25)), l);
  ok('above 80 and 80-or-below cover everything', near(g + probYes({ strikeType: 'less', cap: 81 }, 80, 2), 1));
  const b = probYes({ strikeType: 'between', floor: 79, cap: 80 }, 79.5, 1.5);
  ok('a two-degree bucket around the mean has the mass of +-1 degree', near(b, cdf(1 / 1.5) - cdf(-1 / 1.5)), b);
  const all = [['less', null, 77], ['between', 77, 78], ['between', 79, 80], ['between', 81, 82], ['greater', 82, null]]
    .reduce((a, [t, f, c]) => a + probYes({ strikeType: t, floor: f, cap: c }, 79.7, 2.4), 0);
  ok('a full ladder of strikes adds to one', near(all, 1, 1e-6), all);
  ok('an unknown strike type is not priced', probYes({ strikeType: 'weird' }, 80, 2) === null);
}

group('the fit uses one error per city per day, whatever the strike count');
{
  const day = (d, actual, n) => Array.from({ length: n }, (_, i) => ({ series: 'X', day: d, actual, forecast: 70, ticker: `${d}${i}` }));
  const f = fit([...day('2026-01-01', 72, 7), ...day('2026-01-02', 68, 1), ...day('2026-01-03', 70, 3)]);
  ok('three days, not eleven markets', f.X.n === 3, f.X);
  ok('bias is the mean error and sigma its spread', near(f.X.bias, 0) && near(f.X.sigma, 2), f.X);
  ok('sigma has a floor, so a lucky quiet stretch cannot make the model certain', fit(day('2026-01-01', 70, 2)).X.sigma >= 1);
}

group('the strategy is never shown the answer, and only decides at the preset hour');
{
  const day = '2026-06-10', tz = 'America/New_York';
  const dts = localToEpoch(addDays(day, -1), PRESET.hour, tz);
  const bars = Array.from({ length: 24 }, (_, k) => [dts - 12 * 3600 + k * 3600, 40, 42, 400]);
  const m = { ticker: 'KXHIGHNY-26JUN10-T90', event: 'KXHIGHNY-26JUN10', series: 'KXHIGHNY', day, strikeType: 'greater', floor: 90, result: 'yes', actual: 99, forecast: 70, closeTs: dts + 86400, bars };
  const p = prepare([m], { KXHIGHNY: { bias: 0, sigma: 2 } }, PRESET.hour);
  ok('the answer is stripped before a strategy can read it', p.length === 1 && !('actual' in p[0]) && p[0].forecast === 70, Object.keys(p[0]));
  ok('a forecast of 70 makes "above 90" very unlikely, however the day ended', p[0].pModel < 0.001, p[0].pModel);
  ok('the decision hour is 22:00 local the day before', p[0].decisionTs === dts && new Date(dts * 1000).toISOString().slice(11, 13) === '02', new Date(dts * 1000).toISOString());
}

group('the calendar helpers');
ok('an event ticker carries its date', eventDate('KXHIGHNY-26JUL18') === '2026-07-18' && eventDate('KXHIGHNY-26SEP01') === '2026-09-01' && eventDate('nonsense') === null);
ok('local time honours daylight saving', localToEpoch('2026-07-01', 12, 'America/New_York') === Date.UTC(2026, 6, 1, 16) / 1000 && localToEpoch('2026-01-01', 12, 'America/New_York') === Date.UTC(2026, 0, 1, 17) / 1000);
ok('addDays crosses a month', addDays('2026-01-31', 1) === '2026-02-01' && addDays('2026-03-01', -1) === '2026-02-28');

group('the verdict');
ok('four criteria, preset written down in the file', evaluate.length >= 1 && CRITERIA.events === 200 && CRITERIA.cents === 1.0 && CRITERIA.t === 2 && PRESET.edge === 0.08 && PRESET.hour === 22);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

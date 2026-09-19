'use strict';
// Did Kalshi's daily-high-temperature markets price the weather worse than the public forecast?
//
//   node tools/weather-fetch.js                       # once: data/lab/weather/
//   node tools/weather-lab.js                         # the preset rule, scored on the later half
//   node tools/weather-lab.js --edge 0.05             # a different bar, for the robustness table only
//
// THE RULE IS FIXED HERE, BEFORE ANY TRADE WAS SCORED, and is not to be edited afterwards:
//   forecast   Open-Meteo's forecast for that day's high, as issued ONE DAY EARLIER (previous_day1).
//   model      the real high ~ Normal(forecast + city bias, city sigma), read as a whole degree the way
//              Kalshi settles. Bias and sigma are fitted per city on the EARLIER half of the dates
//              only; nothing from the later half touches them.
//   decision   22:00 local on the day before, from that hour's closing bid and ask.
//   trade      buy YES or NO when the model's probability beats the price by at least 8c AFTER the
//              taker fee; fill at the next hour's ask (tools/lab.js: one hour of latency, a 4c spread
//              limit, a volume floor, the fee); hold to resolution; 10 contracts; one trade a market.
//
// CONFIRMED means all four, on the LATER half of the dates alone:
//   1. at least 200 events traded (an event is one city on one day)
//   2. at least +1.0c a contract after fees
//   3. t of at least 2, profit clustered by event
//   4. positive in BOTH quarters of the later half
// Anything less is NOT CONFIRMED, and the honest reading is "no evidence of an edge".
const fs = require('fs');
const path = require('path');
const lab = require('./lab');
const { localToEpoch, addDays, CITIES } = require('./weather-fetch');

const PRESET = { edge: 0.08, hour: 22 };
const CRITERIA = { events: 200, cents: 1.0, t: 2 };

// ---------------------------------------------------------------- the model
const erf = (x) => {                                   // Abramowitz-Stegun 7.1.26, max error 1.5e-7
  const s = Math.sign(x); x = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * x);
  return s * (1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x));
};
const cdf = (x) => 0.5 * (1 + erf(x / Math.SQRT2));

// Kalshi settles on a WHOLE degree. "greater 86" is "87 or above", "less 79" is "78 or below", and
// "between 85 and 86" is 85 or 86 -- so each edge sits half a degree inside the stated strike.
function probYes(m, mu, sigma) {
  if (m.strikeType === 'greater') return 1 - cdf((m.floor + 0.5 - mu) / sigma);
  if (m.strikeType === 'less') return cdf((m.cap - 0.5 - mu) / sigma);
  if (m.strikeType === 'between') return cdf((m.cap + 0.5 - mu) / sigma) - cdf((m.floor - 0.5 - mu) / sigma);
  return null;
}

// One error per city per day (an event appears once however many strikes it has).
function fit(markets) {
  const errs = new Map();
  for (const m of markets) { const k = `${m.series}|${m.day}`; if (!errs.has(k)) errs.set(k, { series: m.series, e: m.actual - m.forecast }); }
  const by = new Map();
  for (const { series, e } of errs.values()) { if (!by.has(series)) by.set(series, []); by.get(series).push(e); }
  const out = {};
  for (const [s, es] of by) {
    const n = es.length, bias = es.reduce((a, x) => a + x, 0) / n;
    const sd = n > 1 ? Math.sqrt(es.reduce((a, x) => a + (x - bias) ** 2, 0) / (n - 1)) : 3;
    out[s] = { n, bias, sigma: Math.max(1.0, sd) };
  }
  return out;
}

// ---------------------------------------------------------------- trading through the lab's fill model
function strategy(edgeCents) {
  return {
    decide({ m, bars, i, pos }) {
      if (pos || bars[i][0] !== m.decisionTs) return null;
      const b = bars[i], p = m.pModel;
      const yes = p * 100 - b[2] - lab.feeCents(b[2], m.feeMult ?? 1);
      const noPx = 100 - b[1];
      const no = (1 - p) * 100 - noPx - lab.feeCents(noPx, m.feeMult ?? 1);
      if (Math.max(yes, no) < edgeCents) return null;
      return yes >= no ? 'yes' : 'no';
    },
  };
}

function prepare(markets, fitted, hour) {
  return markets.filter((m) => fitted[m.series]).map((m) => {
    const f = fitted[m.series];
    const { actual, forecast, ...rest } = m;           // the strategy is never shown the answer
    return { ...rest, forecast, category: 'Weather', earlyClose: false, expectTs: m.closeTs,
      pModel: probYes(m, forecast + f.bias, f.sigma), decisionTs: localToEpoch(addDays(m.day, -1), hour, CITIES[m.series].tz) };
  }).filter((m) => Number.isFinite(m.pModel));
}
const tradesOf = (markets, edge) => markets.flatMap((m) => lab.runMarket(m, strategy(edge * 100), {}));

// ---------------------------------------------------------------- the report
function evaluate(all, opts = {}) {
  const edge = opts.edge ?? PRESET.edge, hour = opts.hour ?? PRESET.hour;
  const days = [...new Set(all.map((m) => m.day))].sort();
  const cut = days[Math.floor(days.length / 2)];
  const fitSet = all.filter((m) => m.day < cut), testSet = all.filter((m) => m.day >= cut);
  const fitted = fit(fitSet);
  const testDays = [...new Set(testSet.map((m) => m.day))].sort();
  const q = testDays[Math.floor(testDays.length / 2)];
  const prepared = prepare(testSet, fitted, hour);
  const at = (rows) => lab.score(tradesOf(rows, edge));
  const whole = at(prepared);
  const quarters = [prepared.filter((m) => m.day < q), prepared.filter((m) => m.day >= q)].map(at);
  const checks = [
    [`at least ${CRITERIA.events} events`, whole.events >= CRITERIA.events, `${whole.events}`],
    [`at least +${CRITERIA.cents.toFixed(1)}c a contract`, whole.perContract >= CRITERIA.cents, `${whole.perContract.toFixed(2)}c`],
    [`t of at least ${CRITERIA.t}`, whole.t >= CRITERIA.t, `t ${whole.t.toFixed(1)}`],
    ['positive in both quarters', quarters.every((s) => s.perContract > 0), quarters.map((s) => `${s.perContract.toFixed(2)}c on ${s.events} events`).join(' / ')],
  ];
  return { edge, hour, cut, q, fitted, fitDays: fitSet.length, testMarkets: prepared.length, whole, quarters, checks, confirmed: checks.every((c) => c[1]), prepared };
}

// Is the model better informed than the price? Brier score at the decision hour on the same markets:
// lower is better, and the market is the yardstick.
function brier(prepared) {
  let n = 0, model = 0, market = 0;
  for (const m of prepared) {
    const bar = m.bars.find((b) => b[0] === m.decisionTs);
    if (!bar) continue;
    const y = m.result === 'yes' ? 1 : 0;
    model += (m.pModel - y) ** 2; market += ((bar[1] + bar[2]) / 200 - y) ** 2; n++;
  }
  return { n, model: n ? model / n : 0, market: n ? market / n : 0 };
}

module.exports = { PRESET, CRITERIA, probYes, fit, cdf, strategy, prepare, evaluate, brier };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const file = flag('file', 'data/lab/weather/markets.jsonl');
  if (!fs.existsSync(file)) { console.error(`no ${file} -- run node tools/weather-fetch.js first`); process.exit(1); }
  const all = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const c = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}c`;
  const r = evaluate(all, { edge: parseFloat(flag('edge', PRESET.edge)), hour: parseFloat(flag('hour', PRESET.hour)) });
  const days = [...new Set(all.map((m) => m.day))].sort();
  console.log(`${all.length} markets, ${new Set(all.map((m) => m.series)).size} cities, ${days[0]} -> ${days[days.length - 1]}`);
  console.log(`fitted on dates before ${r.cut} (${r.fitDays} markets); scored on ${r.cut} onward (${r.testMarkets} markets), split into quarters at ${r.q}`);
  console.log(`\nforecast error fitted on the earlier half (actual - forecast, degrees F):`);
  for (const [s, f] of Object.entries(r.fitted)) console.log(`  ${s.padEnd(11)} ${String(f.n).padStart(4)} days · bias ${f.bias >= 0 ? '+' : ''}${f.bias.toFixed(2)} · sigma ${f.sigma.toFixed(2)}`);
  const b = brier(r.prepared);
  console.log(`\nBrier score at the decision hour, later half, ${b.n} markets (lower is better): model ${b.model.toFixed(4)} · market ${b.market.toFixed(4)} ${b.model < b.market ? '(the model beats the price)' : '(the price beats the model)'}`);
  console.log(`\nrule: buy when the model beats the price by ${(r.edge * 100).toFixed(0)}c after the fee, decide ${r.hour}:00 local the day before, fill next hour, hold`);
  console.log(`  ${r.whole.n} trades on ${r.whole.events} events · win ${(r.whole.win * 100).toFixed(0)}% · ${c(r.whole.perContract)} a contract · $${r.whole.dollars.toFixed(0)} at 10 contracts a trade · t ${r.whole.t.toFixed(1)}`);
  for (const [name, pass, got] of r.checks) console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${got}`);
  console.log(`  ${r.confirmed ? 'CONFIRMED.' : 'NOT CONFIRMED.'}${r.edge === PRESET.edge && r.hour === PRESET.hour ? '' : '  (not the preset rule: robustness only, never a verdict)'}`);
  if (!args.includes('--no-sweep') && r.edge === PRESET.edge && r.hour === PRESET.hour) {
    console.log('\nrobustness, same later half (NOT verdicts; the preset above is the only one that counts):');
    for (const e of [0.03, 0.05, 0.12, 0.16]) { const x = evaluate(all, { edge: e }); console.log(`  edge ${(e * 100).toFixed(0).padStart(2)}c   ${String(x.whole.n).padStart(5)} trades ${String(x.whole.events).padStart(4)} events  ${c(x.whole.perContract).padStart(8)}  t ${x.whole.t.toFixed(1)}`); }
  }
}

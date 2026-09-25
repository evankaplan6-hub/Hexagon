'use strict';
// The crypto lab: next-open fills, the cost of a trade, the rebalance band, and the desk's own rule.
const { simulate, RULES, WARM } = require('./crypto-lab');
const books = require('../src/desk/books');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-9) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

const day = 86400000;
const series = (closes, opens) => closes.map((c, i) => ({ t: i * day, o: opens ? opens[i] : c, h: c, l: c, c, v: 1 }));
const flat = series(Array(WARM + 30).fill(100));

// holding a flat coin: one trade in, then nothing moves
const h = simulate(flat, RULES[0], { bps: 40 });
near('holding a flat coin grows by nothing but the one entry fee', h.growth, 1 - 0.004);
ok('and trades once', h.trades === 1, h.trades);

// a rule decided on day j's close is paid from day j+1's open: a gap overnight belongs to the OLD weight
{
  // 100 until the first decision, then 110 for good
  const up = (i) => (i > WARM ? 110 : 100);
  const closes = Array.from({ length: WARM + 4 }, (_, i) => up(i));
  const gapped = series(closes, closes.map((_, i) => up(i)));                    // the day after gaps up AT the open
  near('the gap into the first held day is not earned: the weight was still 0 at the open', simulate(gapped, { w: () => 1 }, { bps: 0 }).growth, 1);
  const drift = series(closes, closes.map((_, i) => (i === WARM + 1 ? 100 : up(i))));   // it opens flat and rises in the day
  near('a move from the open to the close is', simulate(drift, { w: () => 1 }, { bps: 0 }).growth, 1.1);
}

// the cost of a trade is bps of what is traded, each time
{
  let k = 0;
  const flip = { w: () => (k++ % 2 ? 0 : 1) };   // in, out, in, out...
  const r = simulate(flat.slice(0, WARM + 11), flip, { bps: 100, band: 0.1 });
  near('ten flips at 1% each on a flat coin cost 1% ten times', r.growth, Math.pow(0.99, 10), 1e-12);
  ok('ten trades', r.trades === 10, r.trades);
}

// the rebalance band: a 5-point wobble is not a trade, a return to full size is
{
  const ws = [0.7, 0.74, 0.66, 0.9, 1];
  let i = 0;
  const r = simulate(flat.slice(0, WARM + 6), { vol: true, w: () => ws[Math.min(i++, ws.length - 1)] }, { bps: 0 });
  ok('0.70 -> 0.74 -> 0.66 are one trade; 0.90 and 1 are two more', r.trades === 3, r.trades);
}

// the lab's volatility rule is the desk's own
{
  const closes = [100];
  for (let j = 1; j < 60; j++) closes.push(closes[j - 1] * Math.exp(j % 2 ? 0.03 : -0.03));
  const want = books.volTargetWeight(closes, { target: 0.4, lookback: 30, perYear: 365 }).w;
  near('volTarget 40% asks the desk\'s books.volTargetWeight', RULES.find((x) => x.name === 'volTarget 40%').w(closes, closes.length - 1), want);
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

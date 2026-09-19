'use strict';
// Does buying a 70-90c favourite outside Sports, inside 48 hours of the scheduled end, pay?
//
//   node tools/favorites-check.js data/lab/markets.jsonl data/lab/markets-hist.jsonl
//
// This is the one lead in the strategy lab (README, "The strategy lab"): found on the markets that
// closed 2026-07-15 -> 09-13 by looking AFTER the tournament table, so it was never evidence. The
// older markets, fetched with `tools/lab-fetch.js --historical`, never took part in finding it. That
// is what makes them a test and not a second look at the same data.
//
// THE RULE IS FIXED HERE, BEFORE THE OLDER DATA WAS SCORED, and is not to be edited afterwards:
//   category is not Sports · price of the side bought 70c to 90c · 48 hours or fewer to the scheduled
//   end · buy at the next hour's ask and hold to resolution · 10 contracts · Kalshi taker fee paid.
//   (tools/lab.js is the fill model: one hour of latency, spread and volume floors, fee per order.)
//
// CONFIRMED means all four, on the older markets alone:
//   1. at least 300 distinct events traded      (the lead rested on 239)
//   2. at least +1.0c a contract after fees
//   3. |t| of at least 2, profit clustered by event
//   4. positive in BOTH halves of the older markets, split by close time
// Anything less is NOT CONFIRMED, and the honest reading is "no evidence of an edge", not "close".
const fs = require('fs');
const lab = require('./lab');

const RULE = { minPx: 70, maxPx: 90, maxHoursLeft: 48 };
const CRITERIA = { events: 300, cents: 1.0, t: 2 };

const FAVOURITE = {
  decide({ bars, i, pos, p, hoursLeft }) {
    if (pos) return null;                                                   // hold to resolution
    if (!(hoursLeft != null && hoursLeft >= 0 && hoursLeft <= p.maxHoursLeft)) return null;
    const b = bars[i];
    if (b[2] >= p.minPx && b[2] <= p.maxPx) return 'yes';                   // pay the ask
    if (100 - b[1] >= p.minPx && 100 - b[1] <= p.maxPx) return 'no';
    return null;
  },
};

const trades = (markets, params) => markets.flatMap((m) => lab.runMarket(m, FAVOURITE, params));
const nonSports = (ms) => ms.filter((m) => m.category && m.category !== 'Sports');

function verdict(markets) {
  const ms = nonSports(markets).sort((a, b) => a.closeTs - b.closeTs);
  const all = lab.score(trades(ms, RULE));
  const mid = Math.floor(ms.length / 2);
  const halves = [ms.slice(0, mid), ms.slice(mid)].map((h) => lab.score(trades(h, RULE)));
  const checks = [
    [`at least ${CRITERIA.events} events`, all.events >= CRITERIA.events, `${all.events}`],
    [`at least +${CRITERIA.cents.toFixed(1)}c a contract`, all.perContract >= CRITERIA.cents, `${all.perContract.toFixed(2)}c`],
    [`|t| of at least ${CRITERIA.t}`, Math.abs(all.t) >= CRITERIA.t && all.t > 0, `t ${all.t.toFixed(1)}`],
    ['positive in both halves', halves.every((h) => h.perContract > 0), halves.map((h) => `${h.perContract.toFixed(2)}c on ${h.events} events`).join(' / ')],
  ];
  return { markets: ms.length, all, halves, checks, confirmed: checks.every((c) => c[1]) };
}

module.exports = { RULE, CRITERIA, FAVOURITE, verdict, nonSports };

if (require.main === module) {
  const files = process.argv.slice(2);
  if (!files.length) { console.error('usage: node tools/favorites-check.js <markets.jsonl> [more.jsonl]'); process.exit(1); }
  const c = (x) => `${x >= 0 ? '+' : ''}${x.toFixed(2)}c`;
  for (const f of files) {
    const markets = fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const v = verdict(markets);
    const day = (s) => new Date(s * 1000).toISOString().slice(0, 10);
    const span = markets.length ? `${day(Math.min(...markets.map((m) => m.closeTs)))} -> ${day(Math.max(...markets.map((m) => m.closeTs)))}` : 'empty';
    console.log(`\n${f}\n  ${markets.length} markets (${v.markets} outside Sports), closing ${span}`);
    const cal = lab.calibration(nonSports(markets)).find((a) => a.lo === 70);
    if (cal && cal.n) console.log(`  sample check: contracts priced ~${cal.price.toFixed(0)}c resolved YES ${cal.won.toFixed(0)}% of the time (${cal.n} markets)`);
    console.log(`  rule: non-Sports, ${RULE.minPx}-${RULE.maxPx}c, <=${RULE.maxHoursLeft}h to the scheduled end, hold to resolution`);
    console.log(`  ${v.all.n} trades on ${v.all.events} events · win ${(v.all.win * 100).toFixed(0)}% · ${c(v.all.perContract)} a contract · $${v.all.dollars.toFixed(0)} at 10 contracts a trade · t ${v.all.t.toFixed(1)}`);
    for (const [name, pass, got] of v.checks) console.log(`    ${pass ? 'PASS' : 'FAIL'}  ${name.padEnd(30)} ${got}`);
    console.log(`  ${v.confirmed ? 'CONFIRMED on this file.' : 'NOT CONFIRMED on this file.'}`);
  }
}

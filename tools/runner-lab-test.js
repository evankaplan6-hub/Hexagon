'use strict';
// The runner lab: the 24-hour figures rebuilt from hourly candles, the book's own rule, its fills and fees.
const { buildGrid, statsAt, simulate, HOUR } = require('./runner-lab');
const books = require('../src/desk/books');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

const T0 = Date.UTC(2025, 0, 1);
// one coin's candles from a list of closes, an hour apart; volume big enough to pass the $2M floor
const coin = (closes, { vol = 1e7, start = 0, highs } = {}) => closes.map((c, i) => [T0 + (start + i) * HOUR, c, highs ? highs[i] : c, c, c, vol]);
const flat = (n, px = 1) => Array(n).fill(px);

// ---- the 24-hour figures
{
  const closes = Array.from({ length: 30 }, (_, i) => 100 + i);
  const g = buildGrid({ 'AAA-USD': coin(closes, { vol: 2, highs: closes.map((c, i) => (i === 10 ? 999 : c)) }) });
  const s = statsAt(g, 29)['AAA-USD'];
  near('open is the close 24 hours before', s.open, 105);
  near('last is the close now', s.last, 129);
  near('high is the highest high of the last 24 hours (hour 10 is 19 back, inside)', s.high, 999);
  near('volume is the last 24 hours summed', s.volume, 48);
  ok('no figures before a coin has 24 hours behind it', !statsAt(g, 23)['AAA-USD'], statsAt(g, 23));
  ok('hour 9 is outside the window at hour 34', buildGrid({ X: coin(closes.concat(flat(5, 130)), { highs: closes.concat(flat(5, 130)).map((c, i) => (i === 9 ? 999 : c)) }) }) && statsAt(buildGrid({ X: coin(closes.concat(flat(5, 130)), { highs: closes.concat(flat(5, 130)).map((c, i) => (i === 9 ? 999 : c)) }) }), 34).X.high === 130);
}
// a missing hour keeps the last close, with no volume
{
  const rows = coin([10, 11, 12]);
  rows.splice(1, 1);
  const g = buildGrid({ B: rows });
  near('the gap hour carries the last close', g.coins.B.c[1], 10);
  near('and no volume', g.coins.B.v[1], 0);
}

// ---- the book: flat for 30 hours, then a 10% pop that keeps climbing
const pop = flat(30, 100).concat([104, 108, 110, 111, 112]);
{
  const g = buildGrid({ 'QNT-USD': coin(pop) });
  const r = simulate(g, { feeBps: 95, slipBps: 0 });
  // hour 32 (110): up 10% on 24h ago, at its high, above 108 -> a runner. Hour 31 (108) is up 8% too:
  // 108/100 = 1.08, at the high, above 104 -> bought there, the first hour it qualifies
  const lot = r.open.length === 1 && r.trades.length === 0;
  ok('one coin bought and still held', lot, r);
  // a quarter of $1,000, 0.95% of it in fees; marked at 112
  const qty = (250 - 250 * 0.0095 / 1.0095) / 108;
  near('a quarter of the book, at the close it qualified on, the fee taken out', r.end, 750 + qty * 112, 1e-6);
  near('fees are 0.95% of what was spent', r.fees, 250 * 0.0095 / 1.0095, 1e-9);
}
{
  // a coin RUNNER_COINS does not have is never bought
  const g = buildGrid({ 'NOTACOIN-USD': coin(pop) });
  ok('a coin Robinhood does not sell is not a runner', simulate(g).open.length === 0);
}
{
  // too little traded: $2M is the floor
  const g = buildGrid({ 'QNT-USD': coin(pop, { vol: 100 }) });
  ok('under $2M traded in 24 hours is not a runner', simulate(g).open.length === 0);
}

// ---- the trail: out on the first hourly close 10% under the best since bought
{
  const path = pop.concat([120, 115, 108.1, 107.9, 107]);   // best 120; 108 is the 10% line
  const g = buildGrid({ 'QNT-USD': coin(path) });
  const r = simulate(g, { feeBps: 0, slipBps: 0 });
  ok('sold once, on the trail', r.trades.length === 1 && /fell 10%/.test(r.trades[0].why), r.trades);
  ok('on the close that crossed the line (107.9), not the one above it', r.trades[0] && r.trades[0].closedAt === T0 + (path.indexOf(107.9) + 1) * HOUR, r.trades[0]);
  near('no fee, no slip: the trade made 107.9/108 - 1 of $250', r.trades[0] && r.trades[0].pnl, 250 * (107.9 / 108 - 1), 1e-9);
}

// ---- the stale exit: 48 hours not above what it cost
{
  const path = pop.slice(0, 32).concat(flat(60, 107));   // bought at 108, then sits at 107
  const r = simulate(buildGrid({ 'QNT-USD': coin(path) }), { feeBps: 0, slipBps: 0 });
  ok('out after 48 hours not above cost', r.trades.length === 1 && /48 hours/.test(r.trades[0].why), r.trades);
  ok('exactly 48 hours on', r.trades[0] && r.trades[0].closedAt - r.trades[0].openedAt === 48 * HOUR, r.trades[0]);
}

// ---- the cool-down: a coin sold waits 12 hours
{
  // pop, trail out, then pop again at once: the second pop inside 12 hours is not bought
  const again = (base) => [base * 1.04, base * 1.08, base * 1.1, base * 1.11];
  const path = pop.concat([97]).concat(flat(5, 97)).concat(flat(24, 97)).concat(again(97));
  const r = simulate(buildGrid({ 'QNT-USD': coin(path) }), { feeBps: 0, slipBps: 0 });
  const soldAt = r.trades[0] && r.trades[0].closedAt;
  ok('the coin sold once', r.trades.length === 1, r.trades);
  ok('and bought again only after its 12 hours', r.open.length === 1 && soldAt != null, r);
  const tight = pop.concat([97, 107, 108, 109, 110, 111]);   // climbs straight back, inside 12 hours
  const r2 = simulate(buildGrid({ 'QNT-USD': coin(tight) }), { feeBps: 0, slipBps: 0 });
  ok('inside 12 hours it is not', r2.trades.length === 1 && r2.open.length === 0, r2);
}

// ---- four slots
{
  const ids = ['QNT', 'ARB', 'SOL', 'ETH', 'BTC', 'DOGE'];
  const cs = Object.fromEntries(ids.map((id, i) => [`${id}-USD`, coin(flat(30, 100).concat([104, 108 + i, 110 + i, 111 + i]))]));
  const r = simulate(buildGrid(cs), { feeBps: 0, slipBps: 0 });
  ok('never more than four at once', r.open.length === 4, r.open);
  ok('the strongest moves first', ['DOGE-USD', 'BTC-USD', 'ETH-USD', 'SOL-USD'].every((id) => r.open.includes(id)), r.open);
  near('each a quarter of the book', r.end, 1000 * 0 + ['DOGE', 'BTC', 'ETH', 'SOL'].reduce((a, id) => {
    const i = ids.indexOf(id); return a + 250 / (108 + i) * (111 + i);
  }, 0), 1e-6);
}

// ---- the window: nothing outside from/to is traded
{
  const g = buildGrid({ 'QNT-USD': coin(pop) });
  const r = simulate(g, { to: T0 + 31 * HOUR });
  ok('a span that ends before the pop trades nothing', r.open.length === 0 && r.trades.length === 0, r);
}

// ---- it asks the book's own rule
ok("it runs books.RUNNER's settings by default", books.RUNNER.trail === 0.10 && books.RUNNER.slots === 4);

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

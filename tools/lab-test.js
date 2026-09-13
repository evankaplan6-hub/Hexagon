'use strict';
// Assertions for the strategy lab's scoring engine (tools/lab.js): what a trade pays, what it
// costs, and what a strategy is allowed to see.
//
//   node tools/lab-test.js
const lab = require('./lab');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (a, b) => Math.abs(a - b) < 1e-9;
const H = 3600;
// bars: [ts, bidCents, askCents, volume]
const market = (bars, over = {}) => ({
  ticker: 'T-1', event: 'T', series: 'T', category: 'Test', result: 'yes', feeMult: 1,
  openTs: 0, closeTs: bars[bars.length - 1][0] + H, earlyClose: false, expectTs: null, occurTs: null, vol: 1e6,
  bars, ...over,
});
const flat = (n, bid, ask, vol = 100) => Array.from({ length: n }, (_, i) => [i * H, bid, ask, vol]);
const always = (side) => ({ decide: ({ pos }) => (pos ? null : side) });

// ---------------------------------------------------------------- fees
{
  ok('fee at 50c on 10 contracts is ceil(17.5c) = 18c, 1.8c each', near(lab.feeCents(50, 1, 10), 1.8), lab.feeCents(50, 1, 10));
  ok('fee at 90c on 10 contracts is ceil(6.3c) = 7c, 0.7c each', near(lab.feeCents(90, 1, 10), 0.7), lab.feeCents(90, 1, 10));
  ok('a zero-multiplier series pays no fee', lab.feeCents(50, 0, 10) === 0);
  ok('half-multiplier series: ceil(8.75c) = 9c', near(lab.feeCents(50, 0.5, 10), 0.9), lab.feeCents(50, 0.5, 10));
  ok('no fee at the boundaries', lab.feeCents(0) === 0 && lab.feeCents(100) === 0);
}

// ---------------------------------------------------------------- fills and settlement
{
  const m = market(flat(5, 40, 42));
  const t = lab.runMarket(m, always('yes'), {});
  ok('one trade, held to the end', t.length === 1 && t[0].settled, t);
  ok('YES buys the NEXT bar\'s ask', t[0].entry === 42, t[0]);
  ok('YES settles at 100 when the result is yes', t[0].exit === 100);
  ok('pnl = 100 - ask - entry fee', near(t[0].pnl, 100 - 42 - lab.feeCents(42, 1)), t[0].pnl);

  const n = lab.runMarket(m, always('no'), {});
  ok('NO buys at 100 - bid', n[0].entry === 60, n[0]);
  ok('NO settles at 0 when the result is yes', n[0].exit === 0 && near(n[0].pnl, -60 - lab.feeCents(60, 1)), n[0]);
}
{
  // exit after one bar: sells at the next bar's bid, both fees paid
  const bars = [[0, 40, 42, 100], [H, 40, 42, 100], [2 * H, 50, 52, 100], [3 * H, 50, 52, 100]];
  const s = { decide: ({ pos, i }) => (!pos && i === 0 ? 'yes' : pos && i === 2 ? 'exit' : null) };
  const t = lab.runMarket(market(bars), s, {});
  ok('round trip: in at bar 1 ask, out at bar 3 bid', t.length === 1 && t[0].entry === 42 && t[0].exit === 50 && !t[0].settled, t);
  ok('round trip pays both fees', near(t[0].pnl, 50 - 42 - lab.feeCents(42, 1) - lab.feeCents(50, 1)), t[0]);
}
{
  const bars = [[0, 40, 42, 100], [H, 40, 42, 5], [2 * H, 40, 42, 100]];
  const t = lab.runMarket(market(bars), always('yes'), {});
  ok('no fill into an hour that traded fewer than SIZE contracts', t.length === 1 && t[0].entry === 42 && t[0].hours === (bars[2][0] + H - 2 * H) / H, t);
  const gap = [[0, 40, 42, 100], [5 * H, 40, 42, 100], [6 * H, 40, 42, 100]];
  const g = lab.runMarket(market(gap), { decide: ({ pos, i }) => (!pos && i === 0 ? 'yes' : null) }, {});
  ok('no fill across a gap of more than two hours', g.length === 0, g);
}

// ---------------------------------------------------------------- entry rails
{
  const wide = [[0, 30, 40, 100], [H, 30, 40, 100], [2 * H, 38, 40, 100], [3 * H, 38, 40, 100]];
  const t = lab.runMarket(market(wide), always('yes'), {});
  ok(`no entry into a book wider than ${lab.MAX_SPREAD}c: waits for the tight hour`, t.length === 1 && t[0].hours === 1, t);
  const thin = [[0, 40, 42, 10], [H, 40, 42, 10], [2 * H, 40, 42, 10], [3 * H, 40, 42, 100], [4 * H, 40, 42, 100]];
  const u = lab.runMarket(market(thin), always('yes'), {});
  ok(`no entry until ${lab.MIN_TRAIL_VOL}+ contracts traded in the day before`, u.length === 1 && u[0].hours === 1, u);
}

// ---------------------------------------------------------------- calibration
{
  const ms = [];
  for (let k = 0; k < 10; k++) ms.push(market(flat(3, 19, 21), { ticker: `C-${k}`, result: k < 2 ? 'yes' : 'no' }));
  const c = lab.calibration(ms).find((a) => a.lo === 10);
  ok('calibration: ten 20c markets, two won → priced 20, won 20%', c.n === 10 && c.price === 20 && c.won === 20, c);
}

// ---------------------------------------------------------------- what a strategy may see
{
  let sawResult = false, sawClose = false;
  const spy = { decide: ({ m }) => { if ('result' in m) sawResult = true; if ('closeTs' in m) sawClose = true; return null; } };
  lab.runMarket(market(flat(5, 40, 42)), spy, {});
  ok('a strategy never sees the result', !sawResult);
  ok('a strategy never sees the actual close time', !sawClose);

  const early = market(flat(5, 40, 42), { earlyClose: true, expectTs: 99 * H, closeTs: 6 * H });
  let left = null;
  lab.runMarket(early, { decide: ({ hoursLeft, i }) => { if (i === 0) left = hoursLeft; return null; } }, {});
  ok('a can-close-early market counts hours to its SCHEDULED end, not its real one', left === 99, left);
  ok('with no schedule, hours left is unknown', lab.schedTs({ earlyClose: true, expectTs: null, closeTs: 5 }) === null);
}

// ---------------------------------------------------------------- strategies do not peek
{
  // Two markets with identical bars and opposite results must trade identically.
  const bars = Array.from({ length: 200 }, (_, i) => [i * H, 20 + (i % 60), 22 + (i % 60), 500]);
  for (const [name, s] of Object.entries(lab.STRATEGIES)) {
    const same = s.params.every((p) => {
      const a = lab.runMarket(market(bars, { result: 'yes' }), s, p).map((t) => [t.side, t.entry, t.hours]);
      const b = lab.runMarket(market(bars, { result: 'no' }), s, p).map((t) => [t.side, t.entry, t.hours]);
      return JSON.stringify(a) === JSON.stringify(b);
    });
    ok(`${name}: same bars, opposite results, same trades`, same);
  }
}

// ---------------------------------------------------------------- scoring
{
  const t = (event, pnl, entry = 50) => ({ event, pnl, entry });
  const s = lab.score([t('A', 10), t('A', -4), t('B', 6)]);
  ok('score counts trades and events', s.n === 3 && s.events === 2, s);
  ok('cents per contract is the mean trade pnl', near(s.perContract, 4), s);
  ok('dollars assume SIZE contracts a trade', near(s.dollars, (12 * lab.SIZE) / 100), s);
  ok('return is pnl over money put in', near(s.roi, 12 / 150), s);
  ok('t clusters by event (A sums to 6, B to 6: no spread, t 0)', s.t === 0, s);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

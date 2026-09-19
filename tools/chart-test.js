'use strict';
// Pure arithmetic behind the browser P&L chart. Lift the exact functions from public/app.js so a
// dashboard refactor cannot quietly turn one ledger into two, shorten a selected range, stretch a
// flat day into a rollercoaster, or squeeze an old stretch of history into a few minutes.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, got === want, got);

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const line = (start) => {
  const i = src.indexOf(`\n  ${start}`);
  if (i < 0) throw new Error(`app.js no longer has "${start}"`);
  return src.slice(i + 1, src.indexOf('\n', i + 1));
};
const fn = (name) => {
  const i = src.indexOf(`\n  function ${name}(`);
  if (i < 0) throw new Error(`app.js no longer has function ${name}`);
  return src.slice(i + 1, src.indexOf('\n  }\n', i) + 4);
};
const lifted = [line('const r2 = '), fn('combinePnlHistory'), fn('windowPnlPoints'), fn('pnlPriceRange'), line('const SLOT_STEPS = '), line('const slotStep = '), fn('evenPnlPoints'), fn('pnlCandles')].join('\n');
const { combinePnlHistory, windowPnlPoints, pnlPriceRange, evenPnlPoints, pnlCandles } = new Function(
  `${lifted}\nreturn { combinePnlHistory, windowPnlPoints, pnlPriceRange, evenPnlPoints, pnlCandles };`)();

{
  const combined = combinePnlHistory(
    [{ t: 1, b: 95 }, { t: 3, b: 94 }],
    [{ t: 2, e: -2 }, { t: 4, e: -3 }], 100);
  eq('the two ledgers carry forward on their own clocks', JSON.stringify(combined), JSON.stringify([
    { t: 2, v: -7 }, { t: 3, v: -8 }, { t: 4, v: -9 },
  ]));
  eq('history before an accounting repair is excluded', JSON.stringify(combinePnlHistory(
    [{ t: 1, b: 95 }, { t: 4, b: 94 }], [{ t: 2, e: -2 }, { t: 4, e: -3 }], 100, 4)),
  JSON.stringify([{ t: 4, v: -9 }]));
  eq('the account ledger carries into the repair; only the maker history is cut', JSON.stringify(combinePnlHistory(
    [{ t: 1, b: 95 }], [{ t: 2, e: -2 }, { t: 5, e: -3 }], 100, 3)),
  JSON.stringify([{ t: 5, v: -8 }]));
  ok('one ledger is never mislabeled as all paper trades', combinePnlHistory([{ t: 1, b: 95 }], [], 100).length === 0);

  const windowed = windowPnlPoints([{ t: 1, v: -1 }, { t: 5, v: -2 }, { t: 9, v: -3 }], 10, 3);
  eq('a range begins with the step that was live at its cutoff', JSON.stringify(windowed), JSON.stringify([{ t: 5, v: -2 }, { t: 9, v: -3 }]));

  // the scale follows the data, but a flat day must look flat
  const flat = pnlPriceRange(-84.11, -83.89, -83.89);
  ok('a desk parked at -$84 is not stretched over the full height', flat.max - flat.min >= 1.6, flat);
  ok('the flat window is centred on the data', Math.abs((flat.min + flat.max) / 2 - -84) < 0.01, flat);
  const near = pnlPriceRange(0.5, 40, 40);
  ok('zero stays on the plot when the line starts close to it', near.min === 0 && near.max === 40, near);
  const far = pnlPriceRange(-966.65, -319.51, -319.51);
  ok('a line far from zero is not pulled down to it', far.min === -966.65 && far.max === -319.51, far);
  const under = pnlPriceRange(-40, -0.5, -0.5);
  ok('zero stays on the plot when the line ends close to it', under.max === 0 && under.min === -40, under);

  // the chart library spaces points by slot, not by time, so history goes onto an even clock
  const T = (sec) => sec * 1000;
  const even = evenPnlPoints([{ t: T(0), v: 0 }, { t: T(1), v: -1 }, { t: T(3600), v: -5 }, { t: T(3601), v: -6 }], 100);
  const secs = even.map((p) => p.t / 1000);
  ok('slots run from the first point to exactly the newest one', secs[0] === 0 && secs[secs.length - 1] === 3601, secs);
  ok('slots are whole seconds, strictly increasing', secs.every((x, i) => Number.isInteger(x) && (i === 0 || x > secs[i - 1])), secs);
  ok('there are never more slots than asked for (plus the two ends)', even.length <= 102, even.length);
  eq('a slot holds the value that was live at that moment: a step, not a slope', even.find((p) => p.t === T(60))?.v, -1);
  eq('the newest slot is the newest value', even[even.length - 1].v, -6);
  // an hour boundary in the middle of a long history is a slot, so the axis can say 08:00
  const day = evenPnlPoints([{ t: T(100), v: 1 }, { t: T(100 + 3.5 * 86400), v: 2 }], 900);
  ok('on a long history the round hours are slots', day.some((p) => p.t / 1000 === 12 * 3600 * 5) && day.length <= 902, day.length);
  const mids = day.slice(1, -1).map((p) => p.t / 1000);
  ok('every slot between the ends sits on the same round clock', mids.every((x) => x % 600 === 0) && new Set(mids.slice(1).map((x, i) => x - mids[i])).size === 1, mids.slice(0, 4));
  const gap = evenPnlPoints([{ t: T(0), v: 5 }, { t: T(600), v: 9 }], 60);
  ok('a gap in the ledger stays flat, then jumps where the next observation arrives',
    gap.filter((p) => p.t < T(600)).every((p) => p.v === 5) && gap[gap.length - 1].v === 9, gap);
  eq('two points in the same second make one slot', evenPnlPoints([{ t: 5100, v: 1 }, { t: 5900, v: 2 }]).length, 1);
  eq('a short history is not padded', evenPnlPoints([{ t: T(0), v: 1 }, { t: T(3), v: 2 }], 900).length, 4);

  // candles: what the ledger did inside each slot
  const led = [{ t: T(0), v: 0 }, { t: T(30), v: -4 }, { t: T(50), v: 3 }, { t: T(70), v: 1 }, { t: T(300), v: 1 }, { t: T(590), v: -2 }];
  const cs = pnlCandles(led, 10);   // 590s over at most 10 candles: 60s each
  const c0 = cs[0], c1 = cs[1], cl = cs[cs.length - 1];
  ok('the first candle opens on the first value', c0.o === 0, c0);
  ok('a candle reaches the highest and lowest value inside it', c0.h === 3 && c0.l === -4 && c0.c === 3, c0);
  ok('a candle opens where the last one closed', cs.every((c, i) => i === 0 || c.o === cs[i - 1].c), cs);
  ok('a slot with no news is flat, at the value carried in', cs.filter((c) => c.t >= T(120) && c.t < T(540)).every((c) => c.o === 1 && c.h === 1 && c.l === 1 && c.c === 1), cs);
  eq('the last candle closes on the newest value', cl.c, -2);
  ok('a wick includes the value the candle opened on', c1.h >= c1.o && c1.l <= c1.o, c1);
  ok('candle times are whole seconds on the round clock, strictly increasing',
    cs.every((c, i) => c.t % 1000 === 0 && (c.t / 1000) % 60 === 0 && (i === 0 || c.t > cs[i - 1].t)), cs.map((c) => c.t / 1000));
  ok('there are never more candles than asked for (plus the partial ends)', pnlCandles(led, 5).length <= 7, pnlCandles(led, 5).length);
  eq('the close is what a measure reads, so v is the close', cs.every((c) => c.v === c.c), true);
  eq('one point is not a chart', pnlCandles([{ t: T(0), v: 1 }]).length, 0);

  // the library reads times as UTC, so the page gives it local wall-clock time: slots must fall on the
  // LOCAL clock. New York in summer is 4h behind UTC; India is 5h30 ahead.
  for (const off of [-4 * 3600, 5.5 * 3600]) {
    const hist = [{ t: T(1000), v: 1 }, { t: T(1000 + 3.5 * 86400), v: 2 }];
    const ls = evenPnlPoints(hist, 900, off).slice(1, -1).map((p) => p.t / 1000 + off);
    ok(`line slots sit on the local clock (offset ${off / 3600}h)`, ls.every((x) => x % 600 === 0), ls.slice(0, 3));
    ok(`local midnight is a slot (offset ${off / 3600}h)`, ls.some((x) => x % 86400 === 0), ls.length);
    const cb = pnlCandles(hist, 60, off).map((c) => c.t / 1000 + off);
    ok(`candles start on the local clock (offset ${off / 3600}h)`, cb.every((x) => x % 3600 === 0), cb.slice(0, 3));
  }
  eq('no offset means the UTC clock, as before', evenPnlPoints([{ t: T(0), v: 1 }, { t: T(7200), v: 2 }], 4).slice(1, -1).every((p) => (p.t / 1000) % 1800 === 0), true);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

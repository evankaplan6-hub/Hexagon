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
const lifted = [line('const r2 = '), fn('combinePnlHistory'), fn('windowPnlPoints'), fn('pnlPriceRange'), line('const SLOT_STEPS = '), line('const slotStep = '), fn('evenPnlPoints'), fn('pnlCandles'), fn('pnlVolume'),
  line('const MOMENTUM = '), fn('pnlMacd'), fn('pnlMomentum'), fn('paperSwing'), fn('paperSkew')].join('\n');
const { combinePnlHistory, windowPnlPoints, pnlPriceRange, evenPnlPoints, pnlCandles, pnlVolume, MOMENTUM, pnlMacd, pnlMomentum, paperSwing, paperSkew } = new Function(
  `${lifted}\nreturn { combinePnlHistory, windowPnlPoints, pnlPriceRange, evenPnlPoints, pnlCandles, pnlVolume, MOMENTUM, pnlMacd, pnlMomentum, paperSwing, paperSkew };`)();

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

  // a fixed interval: the step is the one asked for, and a long history is cut to its newest slots
  const long = [];
  for (let m = 0; m <= 3 * 24 * 60; m += 7) long.push({ t: T(60 * m + 1234), v: Math.round(m / 7) });
  for (const [mins, off] of [[1, -4 * 3600], [5, 0], [15, 5.5 * 3600], [45, -4 * 3600]]) {
    const step = mins * 60;
    const cs = pnlCandles(long, 48, off, step);
    ok(`${mins}m candles: exactly ${mins} minutes apart, on the local clock, newest 48 only`,
      cs.length <= 49 && cs.length >= 47 && cs.every((c, i) => (c.t / 1000 + off) % step === 0 && (i === 0 || c.t / 1000 - cs[i - 1].t / 1000 === step)), cs.slice(0, 3).map((c) => c.t / 1000));
    ok(`${mins}m candles: the last one closes on the newest value`, cs[cs.length - 1].c === long[long.length - 1].v, cs[cs.length - 1]);
    ok(`${mins}m candles: the first one opens on what the history had reached`, cs[0].o === [...long].reverse().find((p) => p.t / 1000 < cs[0].t / 1000)?.v, cs[0]);
    const ls = evenPnlPoints(long, 120, off, step);
    ok(`${mins}m line: newest slots only, ${mins} minutes apart, ending on the newest point`,
      ls.length <= 121 && ls.slice(1, -1).every((p, i, a) => (p.t / 1000 + off) % step === 0 && (i === 0 || p.t / 1000 - a[i - 1].t / 1000 === step)) && ls[ls.length - 1].v === long[long.length - 1].v, ls.length);
  }
  eq('a fixed interval longer than the history is one whole history, not clipped', pnlCandles([{ t: T(10), v: 1 }, { t: T(200), v: 2 }], 48, 0, 2700).length, 1);
  eq('a fixed line interval on a short history keeps the first point', evenPnlPoints([{ t: T(10), v: 1 }, { t: T(200), v: 2 }], 120, 0, 60)[0].t, T(10));

  // volume: what the desk traded inside each slot
  const sl = [{ t: T(0) }, { t: T(300) }, { t: T(600) }];
  const bk = [[T(60), 3, 30], [T(240), 1, 10], [T(300), 2, 20], [T(590), 1, 5], [T(900), 4, 40]];
  eq('a slot owns from its start to the next one; the last owns everything after', JSON.stringify(pnlVolume(sl, bk)), JSON.stringify([40, 25, 40]));
  eq('the total is conserved: nothing dropped, nothing counted twice', pnlVolume(sl, bk).reduce((a, b) => a + b, 0), 105);
  eq('minutes before the first slot are not counted', JSON.stringify(pnlVolume(sl, [[T(-60), 1, 99], [T(0), 1, 1]])), JSON.stringify([1, 0, 0]));
  eq('no trades is zero bars, not NaN', JSON.stringify(pnlVolume(sl, [])), JSON.stringify([0, 0, 0]));
  eq('a single slot takes it all', JSON.stringify(pnlVolume([{ t: T(0) }], bk)), JSON.stringify([105]));
}

// ---- the indicator panes: momentum (MACD in slots) and the maker's P&L not yet banked
{
  const T = (sec) => sec * 1000;
  const close = (a, b, tol = 1e-9) => Math.abs(a - b) <= tol;
  // a plain textbook MACD to hold the real one to
  const ema = (xs, n) => { const a = 2 / (n + 1), o = []; xs.forEach((x, i) => o.push(i ? o[i - 1] + a * (x - o[i - 1]) : x)); return o; };
  const ref = (xs, f, sl, sg) => {
    const m = ema(xs, f).map((x, i) => x - ema(xs, sl)[i]), sig = ema(m.slice(sl - 1), sg);
    return xs.map((x, i) => (i < sl - 1 ? null : { m: m[i], s: i < sl + sg - 2 ? null : sig[i - sl + 1] }));
  };
  const { fast, slow, signal } = MOMENTUM;
  eq('momentum periods are the usual 12, 26, 9 slots', `${fast} ${slow} ${signal}`, '12 26 9');
  eq('MACD of nothing is nothing', pnlMacd([]).length, 0);
  eq('MACD of one value has no value yet', JSON.stringify(pnlMacd([5])), '[null]');
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const walk = []; for (let i = 0, v = -84; i < 300; i++) walk.push(v = Math.round((v + (rnd() - 0.5) * 3) * 100) / 100);
  const got = pnlMacd(walk, fast, slow, signal), want = ref(walk, fast, slow, signal);
  ok('MACD matches the textbook: fast average minus slow, and a signal on that', got.every((g, i) => (g == null) === (want[i] == null) && (g == null || (close(g.m, want[i].m) && (g.s == null) === (want[i].s == null) && (g.s == null || close(g.s, want[i].s))))), got.slice(30, 33));
  ok('the bars are the line less its signal', got.every((g) => g == null || g.s == null ? g == null || g.h == null : close(g.h, g.m - g.s)), got.slice(40, 42));
  eq(`no value until ${slow} slots have been seen`, got.findIndex((g) => g != null), slow - 1);
  eq(`no signal until ${signal} more`, got.findIndex((g) => g && g.s != null), slow + signal - 2);
  ok('a flat P&L has no momentum: exactly zero, not float noise', pnlMacd(Array(80).fill(-84.37)).every((g, i) => i < slow - 1 || (g.m === 0 && (g.s == null || (g.s === 0 && g.h === 0)))));
  const jump = [...Array(60).fill(10), ...Array(60).fill(40)], jm = pnlMacd(jump);
  ok('a jump in the ledger shows as a positive spike...', jm[62].m > 1 && jm[62].h > 0, jm[62]);
  ok('...that fades once the ledger is flat again', Math.abs(jm[119].m) < jm[62].m / 3, [jm[62].m, jm[119].m]);

  // momentum for the slots on show: warmed on the history before them, on the same clock
  const long = [];
  for (let m = 0; m <= 3 * 24 * 60; m += 3) long.push({ t: T(60 * m + 1234), v: Math.round((Math.sin(m / 97) * 400 + m / 30) * 100) / 100 });
  eq('no slots, no momentum', pnlMomentum(long, [], 60000, true).length, 0);
  eq('one slot is not a chart', JSON.stringify(pnlMomentum(long, [{ t: T(0), v: 1 }], 60000, true)), '[null]');
  ok('no history is blanks, not a crash', pnlMomentum([], [{ t: T(0), v: 1 }, { t: T(60), v: 2 }], 60000, true).every((x) => x == null));
  for (const off of [-4 * 3600, 5.5 * 3600]) {
    for (const mins of [0, 1, 5, 15, 45]) {
      // candles: the newest 120 of them, against MACD over every candle the history has at that step
      const cs = pnlCandles(long, 120, off, mins * 60), step = cs[1].t - cs[0].t;
      const all = pnlCandles(long, 1e6, off, step / 1000), full = pnlMacd(all.map((c) => c.c), fast, slow, signal).slice(all.length - cs.length);
      const mo = pnlMomentum(long, cs, step, true);
      ok(`${mins || 'auto'} candles (offset ${off / 3600}h): the same slots as the candles`, mo.length === cs.length && all[all.length - cs.length].t === cs[0].t, [mo.length, cs.length]);
      if (all.length - cs.length >= slow) {
        ok(`${mins || 'auto'} candles (offset ${off / 3600}h): warmed, so the range does not open on blanks`, mo.every((x) => x && x.s != null), mo.findIndex((x) => !x || x.s == null));
        ok(`${mins || 'auto'} candles (offset ${off / 3600}h): the same momentum a chart of the whole history would show`,
          mo.every((x, i) => close(x.m, full[i].m, 0.05) && close(x.s, full[i].s, 0.05)) && close(mo[mo.length - 1].m, full[full.length - 1].m, 1e-6), [mo[0].m, full[0].m]);
      } else {
        ok(`${mins || 'auto'} candles: the whole history on show opens on ${slow - 1} blanks`, mo.findIndex((x) => x) === slow - 1, mo.findIndex((x) => x));
      }
      // a line: the value live at each slot's moment, the lead-in stepped back from the first
      const ls = evenPnlPoints(long.slice(-400), mins ? 300 : 900, off, mins * 60);
      const lstep = (mins * 60 || ls[2].t / 1000 - ls[1].t / 1000) * 1000;
      const lm = pnlMomentum(long, ls, lstep, false);
      ok(`${mins || 'auto'} line (offset ${off / 3600}h): one value per slot, warmed on older history`, lm.length === ls.length && lm.every((x) => x && x.s != null), lm.findIndex((x) => !x || x.s == null));
    }
  }
  // the warm-up reads the history as a step: what was live just before each earlier slot ended
  const stepHist = [{ t: T(0), v: 0 }, { t: T(3000), v: 30 }, { t: T(6000), v: 30 }];
  const sc = pnlCandles(stepHist, 1e6, 0, 60).slice(-2), sm = pnlMomentum(stepHist, sc, 60000, true);
  const sref = pnlMacd(pnlCandles(stepHist, 1e6, 0, 60).map((c) => c.c)).slice(-2);
  ok('candle warm-up takes each earlier candle\'s close', sm.every((x, i) => close(x.m, sref[i].m, 1e-9)), [sm, sref]);
  ok('a flat ledger has no momentum on any interval', [60, 300, 900, 2700].every((st) => {
    const flat = [{ t: T(0), v: -84 }, { t: T(86400), v: -84 }];
    return pnlMomentum(flat, pnlCandles(flat, 120, 0, st), st * 1000, true).every((x) => !x || (x.m === 0 && (x.s == null || x.h === 0)));
  }));
  const fresh = [{ t: T(0), v: 0 }, { t: T(90), v: 0.4 }], fc = pnlCandles(fresh, 120, 0, 60);
  ok('a fresh two-point ledger is all blanks: too little to average', pnlMomentum(fresh, fc, fc[1].t - fc[0].t, true).every((x) => x == null), fc.length);

  // the maker's P&L not yet banked: e (the whole maker P&L) less c (realised), per slot
  const hist = [{ t: T(100), c: 1, m: 400, e: 1 }, { t: T(160), c: 1, m: 380, e: -19 }, { t: T(220), c: 6, m: 0, e: 6 }, { t: T(280), c: 6, m: -50, e: 9.5 }];
  const lslots = [{ t: T(60) }, { t: T(100) }, { t: T(200) }, { t: T(280) }];
  eq('before the first sample there is nothing to say; each slot takes what was live then',
    JSON.stringify(paperSwing(hist, lslots, false)), JSON.stringify([null, { p: 0 }, { p: -20 }, { p: 3.5 }]));
  ok('the marked value of the inventory (m) is not what is on paper: $400 held at cost is $0 unbanked', paperSwing(hist, [{ t: T(100) }], false)[0].p === 0);
  const cslots = [{ t: T(60) }, { t: T(120) }, { t: T(180) }, { t: T(240) }];
  eq('a candle takes the last sample before the next one starts; the last takes the newest',
    JSON.stringify(paperSwing(hist, cslots, true)), JSON.stringify([{ p: 0 }, { p: -20 }, { p: 0 }, { p: 3.5 }]));
  eq('samples before the accounting repair are left out', JSON.stringify(paperSwing(hist, lslots, false, T(200))), JSON.stringify([null, null, null, { p: 3.5 }]));
  eq('the samples may come in any order', JSON.stringify(paperSwing([...hist].reverse(), lslots, false)), JSON.stringify(paperSwing(hist, lslots, false)));
  ok('no history is all blanks', paperSwing(undefined, lslots, true).every((x) => x == null) && paperSwing([], lslots, false).every((x) => x == null));
  eq('no slots, nothing', paperSwing(hist, [], true).length, 0);
  eq('a broken sample is skipped, not drawn as NaN', JSON.stringify(paperSwing([{ t: T(100), c: 1, e: 1 }, { t: T(150), c: null, e: 5 }], [{ t: T(200) }], false)), JSON.stringify([{ p: 0 }]));
  ok('cents stay cents: no float dust', paperSwing([{ t: T(0), c: 0.1, e: 0.3 }], [{ t: T(0) }], false)[0].p === 0.2);
  // a ledger whose realised total carries an old error: the skew comes off every sample
  eq('a fixed ledger error is taken off, so nothing held reads as nothing on paper',
    JSON.stringify(paperSwing([{ t: T(0), c: -5.93, e: 1.2 }, { t: T(60), c: -5.93, e: 4.76 }], [{ t: T(0) }, { t: T(60) }], false, 0, 7.13)),
    JSON.stringify([{ p: 0 }, { p: 3.56 }]));
  // the skew from the live book: the box's own numbers on 2026-09-12 (cash 10069.37, realised -5.93,
  // cost -68.17, mark -84.89) leave $7.13 between cash and realised profit
  const box = { equity: 10069.37 - 84.89, initial: 10000, realized: -5.93, markets: [{ mark: -84.89, cost: -68.17 }] };
  eq('the skew is the P&L less realised, less mark minus cost', paperSkew(box), 7.13);
  eq('so the live paper P&L is the mark less the cost basis', paperSwing([{ t: T(0), c: box.realized, e: box.equity - box.initial }], [{ t: T(0) }], false, 0, paperSkew(box))[0].p, -16.72);
  eq('a clean ledger has no skew', paperSkew({ equity: 10012, initial: 10000, realized: 4, markets: [{ mark: 50, cost: 42 }, { mark: 0, cost: 0 }] }), 0);
  ok('a book that cannot say gives no skew, not NaN', [undefined, {}, { equity: 1, initial: 0, realized: 0 }, { equity: NaN, initial: 0, realized: 0, markets: [] }].every((m) => paperSkew(m) === 0));

  // a line in a shorter range: its first slot is off the round clock, so the averages are warmed on
  // the clock of the others, and every on-clock slot shows what 'All' shows at that moment
  for (const off of [-4 * 3600, 5.5 * 3600]) {
    for (const mins of [1, 5, 15, 45]) {
      const st = mins * 60, win = long.filter((p) => p.t >= long[long.length - 1].t - 6 * 36e5 - 37000);
      // (the whole history's own first slot is off the clock too: the reference leaves it out)
      const ls = evenPnlPoints(win, 300, off, st), all = evenPnlPoints(long, 1e6, off, st).slice(1);
      const lm = pnlMomentum(long, ls, st * 1000, false), am = pnlMacd(all.map((p) => p.v));
      const byT = new Map(all.map((p, i) => [p.t, am[i]]));
      const onClock = ls.map((p, i) => [p, lm[i]]).filter(([p], i) => i > 0 && i < ls.length - 1 && byT.has(p.t));
      ok(`${mins}m line (offset ${off / 3600}h): on-clock slots match the whole history`, onClock.length > 5 && onClock.every(([p, m]) => close(m.m, byT.get(p.t).m, 0.01)), onClock.length);
      ok(`${mins}m line (offset ${off / 3600}h): the off-clock first slot shows what the clock had reached`, ls[1].t - ls[0].t >= st * 1000 || (lm[0] && lm[0].s != null), lm[0]);
    }
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

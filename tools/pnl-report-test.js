'use strict';
// The P&L report: journal events in, realised money out. No network; the disk only in a temp folder.
//
//   node tools/pnl-report-test.js
const { summarize, render, load } = require('./pnl-report');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const T = (d) => `2026-09-${d}T12:00:00.000Z`;

group('convergence: pnl, winners, fees on both legs, and the mind kept apart from the rules');
{
  const ev = [
    { t: T('16'), kind: 'OPEN', id: 'a', fee: 1, strategy: 'converge' },
    { t: T('16'), kind: 'CLOSE', id: 'a', strategy: 'converge', pnl: -10, fee: 2, reason: 'max hold 240m reached, gap still 3.0c' },
    { t: T('16'), kind: 'OPEN', id: 'b', fee: 1, strategy: 'converge' },
    { t: T('17'), kind: 'CLOSE', id: 'b', strategy: 'converge', pnl: 4, fee: 1, reason: 'mind: gap gone' },
    { t: T('17'), kind: 'CLOSE', id: 'c', strategy: 'converge', pnl: -6, fee: 1, reason: 'stop: mark -6.0c vs entry' },
  ];
  const s = summarize(ev);
  ok('trades, winners and pnl add up', s.conv.n === 3 && s.conv.w === 1 && s.conv.pnl === -12, s.conv);
  ok('fees count the open and the close', s.conv.fees === 6, s.conv.fees);
  ok('the mind\'s exits are counted apart from the rules\'', s.conv.mind.n === 1 && s.conv.mind.pnl === 4 && s.conv.rules.n === 2 && s.conv.rules.pnl === -16, [s.conv.mind, s.conv.rules]);
  ok('exit reasons are bucketed with the numbers stripped', s.conv.byReason.has('max hold #m reached') && s.conv.byReason.has('mind') && s.conv.byReason.has('stop: mark -#c'), [...s.conv.byReason.keys()]);
  ok('each day gets its own row', s.days.get('2026-09-16').conv.n === 1 && s.days.get('2026-09-17').conv.n === 2);
}

group('arbs and the maker');
{
  const ev = [
    { t: T('16'), kind: 'OPEN', id: 'g1-PMy', group: 'g1', strategy: 'arb', fee: 0 },
    { t: T('16'), kind: 'CLOSE', id: 'g1-PMy', group: 'g1', strategy: 'arb', pnl: 4.87 },
    { t: T('16'), kind: 'ARB_UNWOUND', group: 'g1', pnl: 4.87 },
    { t: T('16'), kind: 'OPEN', id: 'g2-KSn', group: 'g2', strategy: 'arb', fee: 0 },
    { t: T('16'), kind: 'SETTLE', id: 'g2-KSn', group: 'g2', strategy: 'arb', pnl: -1.5 },
    { t: T('16'), kind: 'ARB_SETTLED', group: 'g2', pnl: -1.5 },
    // buy 10 @ .40 then sell 10 @ .45: a round trip worth 50c
    { t: T('16'), kind: 'MAKER_FILL', ticker: 'M1', side: 'buy', qty: 10, px: 0.40, tradePx: 0.40, runOver: false },
    { t: T('16'), kind: 'MAKER_FILL', ticker: 'M1', side: 'sell', qty: 10, px: 0.45, tradePx: 0.46, runOver: true },
    // opened and never closed: held, and must not count as profit
    { t: T('17'), kind: 'MAKER_FILL', ticker: 'M2', side: 'buy', qty: 5, px: 0.30, tradePx: 0.30, runOver: false },
    { t: T('17'), kind: 'MAKER_FILL', ticker: 'M3', side: 'sell', qty: 4, px: 0.50, tradePx: 0.50, runOver: false },
    { t: T('17'), kind: 'MAKER_SETTLE', ticker: 'M3', pnl: -2 },
  ];
  const s = summarize(ev);
  ok('arb pnl is the sum of its legs, and the group lines are not counted a second time', Math.abs(s.arb.pnl - 3.37) < 1e-9 && s.arb.n === 2, s.arb);
  ok('a round trip realises its spread, an open position realises nothing', Math.abs(s.mk.realized - 0.5) < 1e-9, s.mk.realized);
  ok('a settlement books its own pnl and is counted', s.mk.settles === 1 && s.mk.settlePnl === -2, s.mk);
  ok('run-over is a share of contracts, not of fills', s.mk.qty === 29 && s.mk.runQty === 10, s.mk);
  ok('what is still held is reported, and a settled market is not', s.held.length === 1 && s.held[0].ticker === 'M2' && s.held[0].inv === 5, s.held);
  // the maker crosses out what a configured event still holds the day before it (MAKER_FLATTEN)
  const x = summarize([...ev, { t: T('18'), kind: 'MAKER_FLATTEN', ticker: 'M2', qty: 5, px: 0.28, fee: 0.1, pnl: -0.2, reason: 'event 20h away' }]);
  ok('a crossed-out position is realised, net of its fee, and is no longer held', Math.abs(x.mk.realized - 0.3) < 1e-9 && x.mk.flattens === 1 && x.held.length === 0 && Math.abs(x.days.get('2026-09-18').maker - -0.2) < 1e-9, x.mk);
}

group('arbs from the legs: a group closed before ARB_UNWOUND/ARB_SETTLED existed (2026-09-12) still counts');
{
  const ev = [
    // 09-10: a two-leg Fed arb, no group line at all (mtvep3jzm9i closed like this, +$1.32)
    { t: T(10), kind: 'OPEN', id: 'old-PMy', group: 'old', strategy: 'arb', fee: 0.1 },
    { t: T(10), kind: 'OPEN', id: 'old-KSn', group: 'old', strategy: 'arb', fee: 0.1 },
    { t: T(10), kind: 'CLOSE', id: 'old-PMy', group: 'old', strategy: 'arb', pnl: 2.00 },
    { t: T(10), kind: 'CLOSE', id: 'old-KSn', group: 'old', strategy: 'arb', pnl: -0.68 },
    // 09-13: a partial close (no strategy, no group of its own), then the rest, then the group line
    { t: T(13), kind: 'OPEN', id: 'new-PMy', group: 'new', strategy: 'arb', fee: 0 },
    { t: T(13), kind: 'OPEN', id: 'new-KSn', group: 'new', strategy: 'arb', fee: 0 },
    { t: T(13), kind: 'CLOSE_PARTIAL', id: 'new-PMy', pnl: 1.00 },
    { t: T(14), kind: 'CLOSE', id: 'new-PMy', group: 'new', strategy: 'arb', pnl: 0.50 },
    { t: T(14), kind: 'SETTLE', id: 'new-KSn', group: 'new', strategy: 'arb', pnl: -3.00 },
    { t: T(14), kind: 'ARB_SETTLED', group: 'new', pnl: -1.50 },
    // a convergence partial must not be mistaken for an arb
    { t: T(14), kind: 'OPEN', id: 'c1', group: 'c', strategy: 'converge', fee: 0 },
    { t: T(14), kind: 'CLOSE_PARTIAL', id: 'c1', pnl: -9 },
  ];
  const s = summarize(ev);
  ok('two groups, every leg counted once: +1.32 - 1.50', s.arb.n === 2 && Math.abs(s.arb.pnl - -0.18) < 1e-9, s.arb);
  ok('the pre-09-12 group shows on its own day', Math.abs(s.days.get('2026-09-10').arb - 1.32) < 1e-9, [...s.days]);
  ok('the partial close lands on the day it happened, found through its OPEN', Math.abs(s.days.get('2026-09-13').arb - 1.00) < 1e-9 && Math.abs(s.days.get('2026-09-14').arb - -2.50) < 1e-9, [...s.days]);
  ok('a convergence partial is not an arb', !s.days.get('2026-09-14').conv.n && Math.abs(s.arb.pnl - -0.18) < 1e-9);
  ok('the report says groups', /2 groups with a leg closed or settled · -\$0\.18/.test(render(s, null)), render(s, null));
}

group('the desk lifecycle lines (START, STOP, CRASH, WATCHDOG) move no money');
{
  const base = [{ t: T(16), kind: 'CLOSE', id: 'a', strategy: 'converge', pnl: -5, fee: 1, reason: 'x' }];
  const withLife = [
    { t: T(16), kind: 'START', sha: 'abc1234' }, ...base,
    { t: T(16), kind: 'STOP', signal: 'SIGTERM' }, { t: T(16), kind: 'CRASH', ev: 'uncaughtException', stack: 'Error: x' },
    { t: T(16), kind: 'WATCHDOG', stalled: 'maker' },
  ];
  ok('the same report with and without them', render(summarize(base), null) === render(summarize(withLife), null));
}

group('the newest day says how far it goes');
{
  const s = summarize([
    { t: '2026-09-23T20:00:00.000Z', kind: 'CLOSE', id: 'a', strategy: 'converge', pnl: -5, fee: 1, reason: 'x' },
    { t: '2026-09-24T17:58:36.000Z', kind: 'MAKER_SETTLE', ticker: 'M', pnl: -5.51 },
  ]);
  const out = render(s, null);
  ok('the last row is labelled so far, through HH:MMZ', /2026-09-24 .*so far, through 17:58Z$/m.test(out), out);
  ok('...and only the last row', (out.match(/so far/g) || []).length === 1, out);
}

group('the printed report');
{
  const s = summarize([{ t: T('16'), kind: 'CLOSE', id: 'a', strategy: 'converge', pnl: -5, fee: 1, reason: 'x' }]);
  const plain = render(s, null);
  ok('says how to price the open inventory when no marks were fetched', /--marks/.test(plain), plain);
  ok('a mark is labelled as a mark, never as money', /a MARK, not money/.test(render(s, -3)) && /with marks/.test(render(s, -3)));
  ok('an empty journal still renders', typeof render(summarize([]), null) === 'string');
}

group('the settlement snipe has its own line and column');
{
  const ev = [
    { t: T(27), kind: 'OPEN', id: 's1-KSy', group: 's1', strategy: 'snipe', venue: 'KS', side: 'yes', qty: 100, entry: 0.86, fee: 0.85, cost: 86.85 },
    { t: T(27), kind: 'SETTLE', id: 's1-KSy', group: 's1', strategy: 'snipe', qty: 100, exit: 1, fee: 0, pnl: 13.15 },
    { t: T(28), kind: 'OPEN', id: 's2-KSn', group: 's2', strategy: 'snipe', venue: 'KS', side: 'no', qty: 50, entry: 0.89, fee: 0.35, cost: 44.85 },
    { t: T(28), kind: 'SETTLE', id: 's2-KSn', group: 's2', strategy: 'snipe', qty: 50, exit: 0, fee: 0, pnl: -44.85 },
  ];
  const s = summarize(ev);
  ok('two settled, one winner, the sum, both entry fees', s.snipe.n === 2 && s.snipe.w === 1 && Math.abs(s.snipe.pnl - -31.70) < 0.005 && Math.abs(s.snipe.fees - 1.20) < 0.005, s.snipe);
  ok('by day', Math.abs(s.days.get('2026-09-27').snipe - 13.15) < 0.005 && Math.abs(s.days.get('2026-09-28').snipe - -44.85) < 0.005, [...s.days]);
  const out = render(s, null);
  ok('the report prints it, in the total and the day table', /SETTLEMENT SNIPE/.test(out) && /2 settled or closed · 1 winners · realized -\$31\.70/.test(out) && /ALL-IN REALIZED -\$31\.70/.test(out) && /converge      arb    snipe/.test(out), out);
  ok('a snipe is not counted as convergence', s.conv.n === 0);
}

group('load: the archive first, box-now only for the days the archive lacks');
{
  const fs = require('fs'), os = require('os'), path = require('path');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-pnl-test-'));
  const archive = path.join(tmp, 'archive'), boxNow = path.join(tmp, 'box-now');
  fs.mkdirSync(archive); fs.mkdirSync(boxNow);
  const line = (t, pnl) => JSON.stringify({ t, kind: 'MAKER_SETTLE', ticker: 'M', pnl });
  // the archive's 09-23 is whole; box-now still has an older, shorter copy of it from an earlier run
  fs.writeFileSync(path.join(archive, 'journal-2026-09-23.jsonl'), `${line('2026-09-23T15:00:00.000Z', -1)}\n${line('2026-09-24T03:56:30.000Z', -2)}\n`);
  fs.writeFileSync(path.join(boxNow, 'journal-2026-09-23.jsonl'), `${line('2026-09-23T15:00:00.000Z', -1)}\n`);
  fs.writeFileSync(path.join(boxNow, 'journal-2026-09-24.jsonl'), `${line('2026-09-24T17:58:36.000Z', -100)}\n{"t":"2026-09-24T18:0`);
  const both = load([archive, boxNow]);
  ok("today's journal comes from box-now", both.some((e) => e.pnl === -100), both);
  ok('the archive wins a day both have: no shorter copy shadows it, and nothing twice', both.length === 3 && both.filter((e) => e.pnl === -1).length === 1, both);
  ok('a torn last line is skipped', both.every((e) => e.kind === 'MAKER_SETTLE'));
  const s = summarize(both);
  ok("the day's maker row is the whole day so far", Math.abs(s.days.get('2026-09-24').maker - -102) < 1e-9 && s.lastT === '2026-09-24T17:58:36.000Z', [...s.days]);
  ok('one folder still works on its own', load(archive).length === 2);
  ok('a missing box-now is not an error', load([archive, path.join(tmp, 'nope')]).length === 2);
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

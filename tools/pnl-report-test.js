'use strict';
// The P&L report: journal events in, realised money out. Pure, no network, no disk.
//
//   node tools/pnl-report-test.js
const { summarize, render } = require('./pnl-report');

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
    { t: T('16'), kind: 'ARB_UNWOUND', pnl: 4.87 },
    { t: T('16'), kind: 'ARB_SETTLED', pnl: -1.5 },
    // buy 10 @ .40 then sell 10 @ .45: a round trip worth 50c
    { t: T('16'), kind: 'MAKER_FILL', ticker: 'M1', side: 'buy', qty: 10, px: 0.40, tradePx: 0.40, runOver: false },
    { t: T('16'), kind: 'MAKER_FILL', ticker: 'M1', side: 'sell', qty: 10, px: 0.45, tradePx: 0.46, runOver: true },
    // opened and never closed: held, and must not count as profit
    { t: T('17'), kind: 'MAKER_FILL', ticker: 'M2', side: 'buy', qty: 5, px: 0.30, tradePx: 0.30, runOver: false },
    { t: T('17'), kind: 'MAKER_FILL', ticker: 'M3', side: 'sell', qty: 4, px: 0.50, tradePx: 0.50, runOver: false },
    { t: T('17'), kind: 'MAKER_SETTLE', ticker: 'M3', pnl: -2 },
  ];
  const s = summarize(ev);
  ok('arb pnl is the sum of unwinds and settles', Math.abs(s.arb.pnl - 3.37) < 1e-9 && s.arb.n === 2, s.arb);
  ok('a round trip realises its spread, an open position realises nothing', Math.abs(s.mk.realized - 0.5) < 1e-9, s.mk.realized);
  ok('a settlement books its own pnl and is counted', s.mk.settles === 1 && s.mk.settlePnl === -2, s.mk);
  ok('run-over is a share of contracts, not of fills', s.mk.qty === 29 && s.mk.runQty === 10, s.mk);
  ok('what is still held is reported, and a settled market is not', s.held.length === 1 && s.held[0].ticker === 'M2' && s.held[0].inv === 5, s.held);
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

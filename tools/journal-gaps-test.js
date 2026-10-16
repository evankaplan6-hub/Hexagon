'use strict';
// Assertions for tools/journal-gaps.js: the journal's known holes, and the lines restored beside it.
//
//   node tools/journal-gaps-test.js
const { GAPS, restoredEvents, withGaps } = require('./journal-gaps');
const { rebuild } = require('./ledger-check');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const r2 = (x) => Math.round(x * 100) / 100;
const sum = (xs, f) => r2(xs.reduce((a, x) => a + f(x), 0));

group('the restored taker lines are the state-journal difference, to the cent');
{
  const lines = restoredEvents().filter((e) => e.kind !== 'MAKER_GAP');
  const opens = lines.filter((e) => e.kind === 'OPEN'), settles = lines.filter((e) => e.kind === 'SETTLE');
  ok('3 OPENs and 9 SETTLEs', opens.length === 3 && settles.length === 9, [opens.length, settles.length]);
  ok('cash: +$383.24', sum(settles, (e) => e.proceeds) - sum(opens, (e) => e.cost) === 383.24, sum(settles, (e) => e.proceeds) - sum(opens, (e) => e.cost));
  ok('fees: $2.54, all on the OPENs', sum(opens, (e) => e.fee) === 2.54 && settles.every((e) => e.fee === 0), sum(opens, (e) => e.fee));
  ok('realised: -$198.39', sum(settles, (e) => e.pnl) === -198.39, sum(settles, (e) => e.pnl));
  const w1 = GAPS[0];
  ok("every restored line falls inside its window", lines.every((e) => e.t >= w1.from.slice(0, 19) && e.t < w1.to), lines.map((e) => e.t));
  ok('each says it is restored, and from which hole', lines.every((e) => e.restored === w1.id));
  ok('a SETTLE takes its fields from the leg\'s own OPEN', (() => {
    const s = restoredEvents([{ t: '2026-10-14T05:33:24.209Z', kind: 'OPEN', id: 'mv7oc60gl1n-KSn', group: 'G', qty: 158, venue: 'KS', side: 'no', strategy: 'bet', label: 'L' }]).find((e) => e.id === 'mv7oc60gl1n-KSn' && e.kind === 'SETTLE');
    return s.group === 'G' && s.venue === 'KS' && s.side === 'no' && s.label === 'L' && s.exit === 0 && s.proceeds === 0;
  })());
}

group('the maker');
{
  const m = restoredEvents().filter((e) => e.kind === 'MAKER_GAP');
  ok('one MAKER_GAP per window, a millisecond before the first line after it', m.length === 2 && m.every((e, i) => Date.parse(GAPS[i].to) - Date.parse(e.t) === 1), m.map((e) => e.t));
  ok('cash +$71.33 and 87 fills, once', sum(m, (e) => e.cash) === 71.33 && m.reduce((a, e) => a + e.fills, 0) === 87);
  const built = rebuild([
    { t: '2026-10-14T23:00:00Z', kind: 'MAKER_FILL', ticker: 'CONTROLS-2026-R', side: 'buy', qty: 10, px: 0.5, inv: 10 },
    { t: '2026-10-16T00:53:52.963Z', kind: 'MAKER_GAP', inv: { 'CONTROLS-2026-R': -68 }, cash: 5, fills: 3 },
    { t: '2026-10-16T00:53:52.964Z', kind: 'MAKER_FILL', ticker: 'CONTROLS-2026-R', side: 'sell', qty: 1, px: 0.5, inv: -59 },
  ], 1000);
  ok('ledger-check moves the inventory, the cash and the fill count', built.maker.markets.get('CONTROLS-2026-R').inv === -59 && built.maker.cash === 1000 - 5 + 5 + 0.5 && built.maker.fills === 5, built.maker);
  ok('and the next fill line agrees with the replay', built.maker.drifts.length === 0, built.maker.drifts);
}

group('withGaps');
{
  const before = [{ t: '2026-10-01T00:00:00Z', kind: 'OPEN', id: 'x', cost: 1 }];
  ok('a journal that ends before the holes is left as it was', withGaps(before).events === before && withGaps(before).restored.length === 0);
  ok('so is an empty one', withGaps([]).restored.length === 0);
  const mid = [{ t: '2026-10-15T12:00:00Z', kind: 'X' }];
  const r = withGaps(mid);
  ok('past the first hole only: its lines, not the second\'s', r.restored.length && r.restored.every((e) => e.restored === GAPS[0].id), [...new Set(r.restored.map((e) => e.restored))]);
  const after = withGaps([{ t: '2026-10-17T00:00:00Z', kind: 'X' }]);
  ok('past both: every line, in time order', after.restored.length === 14 && after.events.every((e, i, a) => !i || a[i - 1].t <= e.t), after.restored.length);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

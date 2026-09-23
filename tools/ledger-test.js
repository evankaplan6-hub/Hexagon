'use strict';
// Assertions for tools/ledger-check.js: the journal rebuilds the state exactly, and every way the
// two can disagree is named. A synthetic journal, no network, no clock.
//
//   node tools/ledger-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rebuild, compare, stateTime, readJournals, pruneBoxNow } = require('./ledger-check');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

// a small life: one arb that settles, one convergence bet closed in two pieces, one leg still open,
// and a maker that buys, sells some, settles one market and flattens another
const T = (i) => new Date(Date.UTC(2026, 8, 20, 12, i)).toISOString();
const EVENTS = [
  { t: T(1), kind: 'OPEN', id: 'g1-KSy', group: 'g1', qty: 100, entry: 0.40, fee: 1.00, cost: 41.00, cash: 9959.00 },
  { t: T(1), kind: 'OPEN', id: 'g1-PMn', group: 'g1', qty: 100, entry: 0.55, fee: 0.50, cost: 55.50, cash: 9903.50 },
  { t: T(2), kind: 'OPEN', id: 'g2-PMy', group: 'g2', qty: 50, entry: 0.30, fee: 0.25, cost: 15.25, cash: 9888.25 },
  { t: T(3), kind: 'OPEN', id: 'g3-KSy', group: 'g3', qty: 20, entry: 0.50, fee: 0.20, cost: 10.20, cash: 9878.05 },
  { t: T(4), kind: 'CLOSE_PARTIAL', id: 'g2-PMy', group: 'g2', sold: 20, remaining: 30, exit: 0.36, fee: 0.10, proceeds: 7.10, pnl: 1.00, cash: 9885.15 },
  { t: T(5), kind: 'CLOSE', id: 'g2-PMy', group: 'g2', qty: 30, exit: 0.28, fee: 0.10, proceeds: 8.30, pnl: -0.85, legPnl: 0.15, cash: 9893.45 },
  { t: T(6), kind: 'SETTLE', id: 'g1-KSy', group: 'g1', qty: 100, exit: 1, fee: 0, proceeds: 100, pnl: 59.00, legPnl: 59.00, cash: 9993.45 },
  { t: T(7), kind: 'SETTLE', id: 'g1-PMn', group: 'g1', qty: 100, exit: 0, fee: 0, proceeds: 0, pnl: -55.50, legPnl: -55.50, cash: 9993.45 },
  { t: T(1), kind: 'MAKER_FILL', ticker: 'A', side: 'buy', qty: 10, px: 0.40, inv: 10 },
  { t: T(2), kind: 'MAKER_FILL', ticker: 'A', side: 'sell', qty: 4, px: 0.42, inv: 6 },
  { t: T(3), kind: 'MAKER_FILL', ticker: 'B', side: 'sell', qty: 5, px: 0.70, inv: -5 },
  { t: T(4), kind: 'MAKER_SETTLE', ticker: 'B', qty: -5, cost: -3.5, yesPx: 1, cashDelta: -5, pnl: -1.5 },
  { t: T(5), kind: 'MAKER_FILL', ticker: 'C', side: 'buy', qty: 8, px: 0.25, inv: 8 },
  { t: T(6), kind: 'MAKER_FLATTEN', ticker: 'C', qty: 8, px: 0.30, fee: 0.02, pnl: 0.38 },
];
const STATE = () => ({
  initial: 10000, cash: 9993.45,
  positions: [{ id: 'g3-KSy', group: 'g3', qty: 20 }],
  stats: { fees: 2.15, realized: 3.65, groupsClosed: 2, wins: 2, losses: 0 },
  // cash: 10000 - 4 + 1.68 + 3.5 (short B) - 5 (settle B) - 2 + 2.4 - 0.02 = 9996.56
  maker: { cash: 9996.56, fills: 4, realized: -1.04, markets: { A: { inv: 6 }, B: { inv: 0 }, C: { inv: 0 } } },
});

group('a state that matches its journal has no problems');
{
  const built = rebuild(EVENTS, 10000);
  ok('taker cash chains through every line', built.taker.drifts.length === 0 && Math.abs(built.taker.cash - 9993.45) < 0.005, [built.taker.drifts, built.taker.cash]);
  ok('fees and realised add up', Math.abs(built.taker.fees - 2.15) < 0.005 && Math.abs(built.taker.realized - 3.65) < 0.005, [built.taker.fees, built.taker.realized]);
  ok('one leg is still open, at its size', built.taker.positions.size === 1 && built.taker.positions.get('g3-KSy').qty === 20, [...built.taker.positions]);
  ok('two groups closed, both winners (the arb +3.50, the bet +0.15)', built.taker.tally.closed === 2 && built.taker.tally.wins === 2 && built.taker.tally.losses === 0, built.taker.tally);
  ok('maker cash and inventory replay from the fills', Math.abs(built.maker.cash - 9996.56) < 0.005 && built.maker.markets.get('A').inv === 6 && built.maker.markets.get('B').inv === 0 && built.maker.markets.get('C').inv === 0, [built.maker.cash, [...built.maker.markets]]);
  ok('maker realised: +0.08 on A, -1.50 on B, +0.38 on C', Math.abs(built.maker.realized - -1.04) < 0.005, built.maker.realized);
  const c = compare(built, STATE());
  ok('no problems', c.problems.length === 0, c.problems);
  ok('and the maker realised figures agree', Math.abs(c.makerRealizedSkew) < 0.005, c.makerRealizedSkew);
}

group('every way the state can drift from the journal is named');
{
  const built = rebuild(EVENTS, 10000);
  const drift = (mutate) => { const s = STATE(); mutate(s); return compare(built, s).problems; };
  ok('cash off by a dollar', drift((s) => { s.cash -= 1; }).some((p) => /taker cash/.test(p)));
  ok('fees off', drift((s) => { s.stats.fees = 9; }).some((p) => /taker fees/.test(p)));
  ok('realised off', drift((s) => { s.stats.realized = 0; }).some((p) => /taker realised/.test(p)));
  ok('a leg the state forgot', drift((s) => { s.positions = []; }).some((p) => /open in the journal and not in the state/.test(p)));
  ok('a leg the journal never opened', drift((s) => { s.positions.push({ id: 'ghost', qty: 1 }); }).some((p) => /open in the state and not in the journal/.test(p)));
  ok('a leg at the wrong size', drift((s) => { s.positions[0].qty = 19; }).some((p) => /20 contracts in the journal, 19/.test(p)));
  ok('a wrong tally', drift((s) => { s.stats.wins = 1; s.stats.losses = 1; }).some((p) => /^groups:/.test(p)));
  ok('maker cash off', drift((s) => { s.maker.cash += 0.5; }).some((p) => /maker cash/.test(p)));
  ok('maker fills miscounted', drift((s) => { s.maker.fills = 3; }).some((p) => /maker fills/.test(p)));
  ok('maker inventory off in one market', drift((s) => { s.maker.markets.A.inv = 5; }).some((p) => /maker A: inventory 6 in the journal, 5/.test(p)));
  ok('inventory the journal cannot account for', drift((s) => { s.maker.markets.Z = { inv: 3 }; }).some((p) => /maker Z: 3 contracts in the state with no fill/.test(p)));
  ok('the maker realised gap is reported, not a problem', drift((s) => { s.maker.realized = -2.43; }).length === 0 && Math.abs(compare(built, Object.assign(STATE(), { maker: { ...STATE().maker, realized: -2.43 } })).makerRealizedSkew - -1.39) < 0.005);
}

group('a broken cash chain is pinned to the line it appeared on');
{
  const ev = EVENTS.map((e) => ({ ...e }));
  ev[4].cash = 9880.00;   // the partial close's line claims a cash the arithmetic does not give
  const built = rebuild(ev, 10000);
  ok('one drift, on that line, and the lines after it still agree', built.taker.drifts.length === 1 && /CLOSE_PARTIAL g2-PMy/.test(built.taker.drifts[0]), built.taker.drifts);
  // a desk whose cash went wrong for good disagrees on every later line, and says so on each
  const gone = EVENTS.map((e, i) => (i >= 4 && e.cash != null ? { ...e, cash: e.cash - 1 } : { ...e }));
  ok('a lasting error is reported on every line it touches', rebuild(gone, 10000).taker.drifts.length === 4, rebuild(gone, 10000).taker.drifts);
  ok('a fill whose inventory does not follow is a drift too', rebuild([{ t: T(1), kind: 'MAKER_FILL', ticker: 'A', side: 'buy', qty: 10, px: 0.4, inv: 11 }], 10000).maker.drifts.length === 1);
}

group('the journal is compared only as far as the state had got');
{
  // state.json is saved every ten seconds; a copy taken seconds before the journal's has not
  // absorbed the newest fills. The state's own counter and timestamps say where to cut.
  const s = STATE();
  s.maker.fills = 3; s.maker.markets.C = { inv: 0 };                      // the buy of C and its flatten are not in it yet
  s.maker.cash = 9996.18;                                                  // 10000 - 4 + 1.68 + 3.5 - 5
  s.log = [{ t: Date.parse(T(5)) + 500 }];                                 // saved just after the fifth minute
  const built = rebuild(EVENTS, 10000, { until: Date.parse(T(5)) + 500, makerFills: 3 });
  ok('the maker stops at the state\'s fill count', built.maker.fills === 3 && !built.maker.markets.has('C'), [built.maker.fills, [...built.maker.markets.keys()]]);
  ok('taker events after the state\'s moment are left out', built.taker.positions.size === 3, [...built.taker.positions.keys()]);
  s.positions = [{ id: 'g1-KSy', group: 'g1', qty: 100 }, { id: 'g1-PMn', group: 'g1', qty: 100 }, { id: 'g3-KSy', group: 'g3', qty: 20 }];
  s.cash = 9893.45; s.stats = { fees: 2.15, realized: 0.15, groupsClosed: 1, wins: 1, losses: 0 }; s.maker.realized = -1.42;
  ok('...and such a state has no problems', compare(built, s).problems.length === 0, compare(built, s).problems);
  ok('stateTime is the newest moment the state vouches for', stateTime({ log: [{ t: 5 }], balanceHistory: [{ t: 7 }], maker: { lastFill: { at: 9 }, hist: [{ t: 8 }] } }) === 9 && stateTime({}) === Infinity);
}

group('box-now holds only what the archive lacks');
{
  // the 2026-09-23 false alarm: a shorter copy of an archived day, left over from the day before,
  // shadowed the archive's complete copy because the later directory wins in readJournals
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ledger-'));
  const archive = path.join(root, 'archive'); const box = path.join(root, 'box-now');
  fs.mkdirSync(archive); fs.mkdirSync(box);
  const line = (i) => JSON.stringify({ t: T(i), kind: 'OPEN', id: `g${i}-KSy`, group: `g${i}`, qty: 1, entry: 0.5, fee: 0, cost: 0.5, cash: 10000 - 0.5 * i }) + '\n';
  fs.writeFileSync(path.join(archive, 'journal-2026-09-22.jsonl'), line(1) + line(2) + line(3));
  fs.writeFileSync(path.join(box, 'journal-2026-09-22.jsonl'), line(1) + line(2));           // yesterday's partial copy
  fs.writeFileSync(path.join(box, 'journal-2026-09-23.jsonl'), line(4));                     // today's, which the archive lacks
  fs.writeFileSync(path.join(box, 'state.json'), '{}');
  ok('the later directory shadows the earlier one, so the stale copy loses a line', readJournals([archive, box]).events.length === 3);
  const stale = pruneBoxNow(box, ['journal-2026-09-23.jsonl']);
  ok('the stale copy of the archived day is dropped, by name', stale.length === 1 && stale[0] === 'journal-2026-09-22.jsonl', stale);
  ok("today's journal and the state are left alone", fs.existsSync(path.join(box, 'journal-2026-09-23.jsonl')) && fs.existsSync(path.join(box, 'state.json')));
  ok('and the rebuild now sees every line', readJournals([archive, box]).events.length === 4);
  ok('a missing box-now folder is nothing to prune', pruneBoxNow(path.join(root, 'nope'), []).length === 0);
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

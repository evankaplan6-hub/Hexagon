'use strict';
// Assertions for tools/ledger-check.js: the journal rebuilds the state exactly, and every way the
// two can disagree is named. A synthetic journal, no network, no clock.
//
//   node tools/ledger-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { rebuild, compare, stateTime, readJournals, pruneBoxNow, firstBalance, checkVenues } = require('./ledger-check');

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

group('paper deposited mid-journal is cash, not a drift (2026-10-14: $10k added to the account)');
{
  // the same life with $10,000 deposited after the first arb opened: every later line's cash is $10k higher
  const at = 2;
  const ev = EVENTS.map((e, i) => (i >= at && e.cash != null ? { ...e, cash: Math.round((e.cash + 10000) * 100) / 100 } : e));
  ev.splice(at, 0, { t: T(1), kind: 'DEPOSIT', id: '2026-10-14', usd: 10000, initial: 20000, cash: 19903.50 });
  const S = { ...STATE(), initial: 20000, cash: 19993.45, deposits: { '2026-10-14': { usd: 10000 } } };
  ok('the account\'s first balance is its starting balance less what was deposited', firstBalance(S) === 10000, firstBalance(S));
  const built = rebuild(ev, firstBalance(S));
  ok('the cash chains across the deposit with no drift', built.taker.drifts.length === 0 && Math.abs(built.taker.cash - 19993.45) < 0.005, [built.taker.drifts, built.taker.cash]);
  ok('the deposit is not realised P&L', Math.abs(built.taker.realized - 3.65) < 0.005, built.taker.realized);
  ok('the maker still starts from the first balance', Math.abs(built.maker.cash - 9996.56) < 0.005, built.maker.cash);
  const c = compare(built, S);
  ok('and the state has no problems', c.problems.length === 0, c.problems);
  ok('a state with no deposits starts where it says', firstBalance(STATE()) === 10000);
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
  ok('...a deposit\'s own time included', stateTime({ log: [{ t: 5 }], deposits: { a: { usd: 1, at: 11 }, b: { usd: 1 } } }) === 11);
}

group('a state saved at boot, right after a deposit, has no false cash mismatch (audit 2026-10-15)');
{
  // applyDeposits journals DEPOSIT and saves before the new run logs a line or samples a balance, so
  // the state's newest log and balance times are the previous run's
  const t0 = Date.parse('2026-10-14T23:00:00Z'), t1 = Date.parse('2026-10-14T23:05:00Z');
  const S = { initial: 20000, cash: 20000, positions: [], closed: [], log: [{ t: t0 }], balanceHistory: [{ t: t0, b: 20000 }],
    stats: { wins: 0, losses: 0, realized: 0, fees: 0, groupsClosed: 0 }, maker: { cash: 10000, fills: 0, markets: {} },
    deposits: { '2026-10-14': { usd: 10000, at: t1 } } };
  const ev = [{ t: new Date(t1).toISOString(), kind: 'DEPOSIT', id: '2026-10-14', usd: 10000, initial: 20000, cash: 20000 }];
  ok('the state vouches for the deposit\'s moment', stateTime(S) === t1, new Date(stateTime(S)).toISOString());
  const built = rebuild(ev, firstBalance(S), { until: stateTime(S), makerFills: 0 });
  const c = compare(built, S);
  ok('...so the DEPOSIT line is replayed and the cash agrees', c.problems.length === 0, c.problems);
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

group('the venue check asks about each settlement once, and fails when it could not ask (audit 2026-10-20)');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-venues-'));
  const file = path.join(dir, 'venue-checked.json');
  const ev = [
    { kind: 'SETTLE', t: T(1), id: 'a-KSy', venue: 'KS', side: 'yes', exit: 1, pairId: 'pm1:0|KXT-A', label: 'game A' },
    { kind: 'SETTLE', t: T(2), id: 'b-PMy', venue: 'PM', side: 'yes', exit: 0, pairId: 'pm2:0|KXT-B', label: 'game B' },
    { kind: 'MAKER_SETTLE', t: T(3), ticker: 'KXM-1', yesPx: 1, qty: 10 },
  ];
  let calls = [];
  const venue = async (url) => {
    calls.push(url);
    if (url.includes('/markets/KXT-A')) return { market: { result: 'yes' } };
    if (url.includes('/markets/KXM-1')) return { market: { result: 'yes' } };
    if (url.includes('/markets/pm2')) return { id: 'pm2', closed: true, umaResolutionStatus: 'resolved', outcomePrices: '["0","1"]' };
    throw new Error('no such market');
  };
  const quiet = () => {};
  const one = await checkVenues(ev, quiet, { checked: file, fetchJson: venue, pause: 0 });
  ok('the first run asks the venues about all three and all agree', one.checked === 3 && one.agree === 3 && one.earlier === 0 && calls.length === 3 && one.failed.length === 0, one);
  calls = [];
  const two = await checkVenues([...ev, { kind: 'SETTLE', t: T(4), id: 'c-KSy', venue: 'KS', side: 'no', exit: 0, pairId: 'pm3:0|KXT-A', label: 'game A again' }], quiet, { checked: file, fetchJson: venue, pause: 0 });
  ok('the next run asks only about the new line: the three agreed before are not looked up again', two.checked === 4 && two.earlier === 3 && calls.length === 1 && calls[0].includes('KXT-A'), [two, calls]);
  calls = [];
  const again = await checkVenues(ev, quiet, { checked: file, fetchJson: venue, pause: 0, recheck: true });
  ok('--recheck asks about every line again', again.earlier === 0 && calls.length === 3, calls);
  let tries = 0;
  const down = async () => { tries++; throw new Error('timed out'); };
  const lines = [];
  const bad = await checkVenues([{ kind: 'SETTLE', t: T(9), id: 'z-KSy', venue: 'KS', side: 'yes', exit: 1, pairId: 'pm9:0|KXT-Z', label: 'game Z' }], (l) => lines.push(l), { checked: null, fetchJson: down, pause: 0 });
  ok('a venue that does not answer is tried twice, then the line has failed: a PROBLEM, not "could not be checked" and a pass', tries === 2 && bad.failed.length === 1 && lines.some((l) => /PROBLEM 1 settlement/.test(l)), [tries, bad, lines]);
  const wrong = await checkVenues([{ ...ev[0], exit: 0, t: T(10) }], quiet, { checked: file, fetchJson: venue, pause: 0 });
  ok('a line the venue disagrees with is not remembered as checked', wrong.differ.length === 1 && !JSON.parse(fs.readFileSync(file, 'utf8')).agreed.some((k) => k.includes(T(10))), wrong);
  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

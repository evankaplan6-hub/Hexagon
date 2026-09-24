'use strict';
// The fill check's replay (tools/fillcheck.js): the order a round is read in, the queue, restarts,
// the warm-up day, and what each missed fill is put down to. Synthetic tape rows; no files, no network.
//
//   node tools/fillcheck-test.js
const { makeFillCheck, journalFills, verdict } = require('./fillcheck');
const maker = require('../src/maker');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const cfg = { ...base, makerCap: 100, makerSoftCap: 1, makerParticipation: 0.10, makerMinSpread: 0.01, makerMinMid: 0.08, makerMaxMid: 0.92 };
const T0 = Date.parse('2026-09-22T15:00:00Z');
let n = 0;
const b = (t, bid, bs, ask, as, k = 'A') => ({ mk: 'b', t: T0 + t, k, b: bid, bs, a: ask, as });
// s: 'a' = the taker sold into the bids (a resting bid fills), 'b' = the taker lifted the offers
const p = (t, px, size, s, k = 'A', id = `p${++n}`) => ({ mk: 'p', t: T0 + t, k, id, p: px, n: size, s });
const q = (t, bid, ask, i = 0, k = 'A', extra = {}) => ({ mk: 'q', t: T0 + t, k, b: bid, a: ask, i, ...extra });
const g = (t, why) => ({ mk: 'g', t: T0 + t, why });
const run = (rows, cools) => { const c = makeFillCheck(cfg, maker, cools); for (const r of rows) c.feed(r); return c.result(); };

group('a round is read in the order the desk lived it');
{
  // round 1 ends with a bid at 44c behind 100; round 2's print arrives BEFORE round 2's quote line
  const r = run([b(0, 0.44, 100, 0.46, 100), q(1, 0.44, 0.46), b(2000, 0.44, 100, 0.46, 100), p(1500, 0.44, 500, 'a'), q(2001, 0.44, 0.46, 40)]);
  ok('a print fills against the quote from the round before: 100 ahead, a tenth of the other 400', r.tape.fills === 1 && r.tape.qty === 40, r.tape);
  const first = run([b(0, 0.44, 100, 0.46, 100), p(-500, 0.44, 500, 'a'), q(1, 0.44, 0.46)]);
  ok('a print in the round that FIRST posts a quote fills nothing: the quote was not there yet', first.tape.fills === 0 && first.always.fills === 0, first);
  // the book moves up in round 2; the always-on desk must not be quoting 45c until that round's prints are past
  const look = run([b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), b(2000, 0.45, 0, 0.47, 0), p(1500, 0.45, 100, 'a'), q(2001, 0.45, 0.47)]);
  ok('the always-on desk does not quote off a book before that round\'s prints: a 45c print misses its 44c bid', look.always.fills === 0 && look.tape.fills === 0, look.always);
  const dup = run([b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), p(1500, 0.44, 100, 'a', 'A', 'same'), p(1500, 0.44, 100, 'a', 'A', 'same')]);
  ok('a print written twice (a restart rewrites the newest page) is one print', dup.prints === 1 && dup.tape.qty === 10, dup.tape);
}

group('the queue');
{
  const stay = run([b(0, 0.44, 300, 0.46, 0), q(1, 0.44, 0.46), p(1000, 0.44, 200, 'a'), b(2000, 0.44, 900, 0.46, 0), q(2001, 0.44, 0.46, 0), p(3000, 0.44, 200, 'a')]);
  ok('staying at a price keeps the place: 300 ahead, 200 then 200 trade, a tenth of the last 100 is ours', stay.tape.fills === 1 && stay.tape.qty === 10, stay.tape);
  const move = run([b(0, 0.44, 300, 0.46, 0), q(1, 0.44, 0.46), b(2000, 0.45, 900, 0.47, 0), q(2001, 0.45, 0.47), p(3000, 0.45, 500, 'a')]);
  ok('moving to a new price joins the back of what is resting there', move.tape.fills === 0, move.tape);
  const own = run([b(0, 0.44, 300, 0.46, 0), q(1, 0.44, 0.46, 0, 'A', { qb: 20, qa: 0 }), p(1000, 0.44, 120, 'a')]);
  ok('the desk\'s own queue number on the line is used over the depth', own.tape.qty === 10 && own.exactQueue === true, own.tape);
}

group('a restart');
{
  const rows = [b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), g(60000, 'start'), b(60000, 0.44, 250, 0.46, 0), p(59000, 0.44, 100, 'a'), q(60001, 0.44, 0.46), p(61000, 0.44, 300, 'a')];
  const r = run(rows);
  ok('between the start line and the next quote line nothing of ours is resting', r.lost.restart.fills === 1 && r.lost.restart.qty === 10, r.lost);
  ok('...and the re-posted quote is at the back: 250 ahead, a tenth of the last 50', r.tape.fills === 1 && r.tape.qty === 5, r.tape);
  ok('the always-on desk never went down: it filled both', r.always.fills === 2 && r.marks.start === 1, r.always);
  // a market the restarted desk quotes for the first time is down until its first quote line too
  const fresh = run([g(0, 'start'), b(0, 0.44, 0, 0.46, 0, 'N'), b(2000, 0.44, 0, 0.46, 0, 'N'), p(1500, 0.44, 100, 'a', 'N'), q(2001, 0.44, 0.46, 0, 'N')]);
  ok('a market first seen after a start is "restart", not a rail, until it is quoted', fresh.lost.restart.fills === 1 && fresh.lost.entire.fills === 0, fresh.lost);
}

group('what a missed fill is put down to');
{
  const cools = new Map([['A', [[T0 + 5000, T0 + 9000]]]]);
  const r = run([
    b(0, 0.44, 0, 0.46, 0), q(1, null, null),               // both sides pulled
    b(4000, 0.44, 0, 0.46, 0),                               // (the next round: the always-on desk is up off the first book)
    p(6000, 0.44, 100, 'a'),                                 // ...inside the cooldown the journal names
    p(9500, 0.44, 100, 'a'),                                 // ...and after it: pulled for some other reason
    b(10000, 0.44, 0, 0.46, 0), q(10001, null, 0.46, 30),    // long 30, offered only
    p(11000, 0.44, 100, 'a'),                                // a bid would have grown the position
    b(12000, 0.44, 0, 0.46, 0, 'B'), q(12001, 0.43, 0.47, 0, 'B'), b(14000, 0.44, 0, 0.46, 0, 'B'),
    p(15000, 0.44, 100, 'a', 'B'),                           // quoted a cent behind the touch
    b(16000, 0.30, 0, 0.32, 0, 'C'), q(16001, 0.30, 0.32, 0, 'C', { qb: 5000, qa: 0 }), b(18000, 0.30, 0, 0.32, 0, 'C'),
    p(19000, 0.30, 100, 'a', 'C'),                           // at the touch, 5,000 ahead
  ], cools);
  ok('cooled, by the journal', r.lost.cooled.fills === 1, r.lost);
  ok('both sides pulled outside a cooldown is not called cooling', r.lost.entire.fills === 1, r.lost);
  ok('the growing side pulled while holding', r.lost.growing.fills === 1, r.lost);
  ok('quoted, but not at the always-on desk\'s price', r.lost.price.fills === 1, r.lost);
  ok('at the price, further back in the queue', r.lost.queue.fills === 1, r.lost);
  const v = verdict(r, { qty: 0, by: new Map() });
  ok('three of the five are rails, two are operations', v.rails === 30 && v.ops === 20, v);
}

group('a reduce-only quote replays clipped at flat, as the desk fills it');
{
  // short 30 with only a bid resting to work it off; three sell-side prints of 300 against it
  const rows = (ro) => [b(0, 0.40, 0, 0.42, 0), q(1, 0.40, null, -30, 'A', ro ? { ro: 1 } : {}), b(500, 0.40, 0, 0.42, 0),
    p(1000, 0.40, 300, 'a'), p(1200, 0.40, 300, 'a'), p(1400, 0.40, 300, 'a')];
  const clipped = run(rows(true));
  ok('a line with ro:1 fills the 30 still short and then nothing', clipped.tape.fills === 1 && clipped.tape.qty === 30, clipped.tape);
  const old = run(rows(false));
  ok('a line without it, every tape before 2026-09-24, replays as the desk then filled: through zero to long 60', old.tape.fills === 3 && old.tape.qty === 90, old.tape);
  // the always-on desk quotes both sides at short 30 and goes on buying what the clipped quote refuses
  ok('what the flag refused is put down to the rail that stopped it, not to the queue', clipped.lost.growing.fills === 2 && clipped.lost.growing.qty === 60 && clipped.lost.queue.fills === 0, clipped.lost);
}

group('the day before warms the replay up and is not counted');
{
  const c = makeFillCheck(cfg, maker);
  c.counting(false);
  for (const r of [b(-90000, 0.44, 300, 0.46, 0), q(-89999, 0.44, 0.46), p(-80000, 0.44, 300, 'a'), p(-70000, 0.44, 100, 'a')]) c.feed(r);
  c.counting(true);
  for (const r of [b(0, 0.44, 800, 0.46, 0), p(1000, 0.44, 100, 'a')]) c.feed(r);
  const r = c.result();
  ok('yesterday\'s fills are not today\'s', r.tape.fills === 1 && r.prints === 1, r.tape);
  ok('...but yesterday\'s quote is still resting, with the place it had earned', r.tape.qty === 10 && r.warmed === true, r.tape);
  ok('a replay with no day before says so', run([b(0, 0.44, 0, 0.46, 0)]).warmed === false);
}

group('a fill is marked against the mid minutes later');
{
  const M = 60000;
  // bought 10 at 44c; the mid is 45c at the fill, 48c five minutes on, 40c at half an hour, and the tape ends before two hours
  const r = run([b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), p(1000, 0.44, 100, 'a'), b(5 * M + 1000, 0.47, 0, 0.49, 0), b(30 * M + 1000, 0.39, 0, 0.41, 0)]);
  const t = r.marked.tape;
  ok('per contract, at each horizon: +4c, then -4c', Math.abs(t[5].perContract - 0.04) < 1e-9 && Math.abs(t[30].perContract + 0.04) < 1e-9 && t[5].qty === 10, t);
  ok('a horizon the tape does not reach is not marked', t[120].qty === 0 && t[120].perContract === null, t[120]);
  // the market is dropped after the fill and re-quoted three hours on: the 30-minute mark has no book near it
  const gap = run([b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), p(1000, 0.44, 100, 'a'), b(5 * M + 1000, 0.47, 0, 0.49, 0), b(180 * M, 0.30, 0, 0.32, 0)]);
  ok('a horizon that falls in a gap between book lines is not marked against the stale one', gap.marked.tape[5].qty === 10 && gap.marked.tape[30].qty === 0, gap.marked.tape);
  // sold 10 at 46c into a lift; the mid then falls to 40c: a good sale
  const sell = run([b(0, 0.44, 0, 0.46, 0), q(1, 0.44, 0.46), p(1000, 0.46, 100, 'b'), b(5 * M + 1000, 0.39, 0, 0.41, 0)]);
  ok('a sale is marked the other way round', Math.abs(sell.marked.tape[5].perContract - 0.06) < 1e-9, sell.marked.tape[5]);
  // a refused fill is marked under its reason
  const cools = new Map([['A', [[T0, T0 + 9000]]]]);
  const ref = run([b(0, 0.44, 0, 0.46, 0), q(1, null, null), b(4000, 0.44, 0, 0.46, 0), p(6000, 0.44, 100, 'a'), b(5 * M + 6000, 0.34, 0, 0.36, 0)], cools);
  ok('the fills the gate refused are marked under "cooled", and here it was right to', ref.marked.cooled && Math.abs(ref.marked.cooled[5].perContract + 0.09) < 1e-9 && !ref.marked.tape, ref.marked);
}

group('the journal side, and the verdict');
{
  const J = (t, kind, o) => JSON.stringify({ t: new Date(T0 + t).toISOString(), kind, ...o });
  const lines = [J(-60000, 'MAKER_FILL', { ticker: 'A', qty: 7 }), J(1000, 'MAKER_FILL', { ticker: 'A', qty: 10, runOver: true }), J(2000, 'MAKER_FILL', { ticker: 'B', qty: 5 }),
    J(3000, 'MAKER_COOL', { ticker: 'A', until: new Date(T0 + 9000).toISOString() }), J(4000, 'OPEN', { ticker: 'A', qty: 99 }), 'not json'];
  const jr = journalFills(lines, { from: T0, to: T0 + 10000 });
  ok('only MAKER_FILL lines inside the tape\'s own span are counted', jr.fills === 2 && jr.qty === 15 && jr.ro === 10 && jr.by.get('A').qty === 10, jr);
  ok('MAKER_COOL lines become windows per market', jr.cools.get('A')[0][0] === T0 + 3000 && jr.cools.get('A')[0][1] === T0 + 9000, [...jr.cools]);
  const res = (a, bq, warmed = true) => ({ warmed, exactQueue: false, tape: { qty: a + bq }, always: { qty: 100 }, lost: Object.fromEntries(['restart', 'cooled', 'entire', 'growing', 'side', 'price', 'queue'].map((k) => [k, { qty: 0 }])), byMarket: new Map([['A', { tape: { qty: a } }], ['B', { tape: { qty: bq } }]]) });
  ok('the same contracts market by market agree', verdict(res(10, 5), jr).agrees === true);
  ok('misses that cancel in the total are still misses: 15 against 15, and 67% apart', verdict(res(15, 0), jr).agrees === false && Math.abs(verdict(res(15, 0), jr).apart - 10 / 15) < 1e-9, verdict(res(15, 0), jr));
  ok('a replay on guessed queues is reported, not judged, warmed up or not', verdict(res(15, 0, false), jr).exact === false && verdict(res(15, 0, true), jr).exact === false);
  ok('...and one on the desk\'s own queue numbers is judged', verdict({ ...res(15, 0, false), exactQueue: true }, jr).exact === true);
  ok('within() re-cuts the same journal without re-reading it', jr.within(T0 + 1500, T0 + 10000).qty === 5 && jr.within(-Infinity, Infinity).qty === 22, jr.within(T0 + 1500, T0 + 10000));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

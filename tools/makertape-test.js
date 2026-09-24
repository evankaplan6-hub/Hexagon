'use strict';
// The maker's tape: what is written, when it is skipped, and that a bad disk never reaches the desk. No disk, no network.
//
//   node tools/makertape-test.js
const { makeMakerTape } = require('../src/makertape');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

// a fake disk that keeps what was appended, and can be told to fail
const disk = () => {
  const d = { files: {}, fail: false, appendFileSync(p, s) { if (d.fail) throw new Error('ENOSPC: no space left on device'); d.files[p] = (d.files[p] || '') + s; }, mkdirSync() {} };
  d.raw = () => Object.values(d.files).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  // every process opens its tape with one "start" line (asserted on its own below); the rest of the
  // suite reads what comes after it
  d.lines = () => d.raw().filter((l) => l.why !== 'start');
  return d;
};
const T0 = Date.parse('2026-09-19T15:00:00Z');
const cfg = (over = {}) => ({ record: true, makerRecord: true, dataDir: '/x', ...over });
const book = (bid, bs, ask, as) => ({ yesBids: [{ price: bid, size: bs }], yesAsks: [{ price: ask, size: as }] });
const print = (id, p, n, side, ms) => ({ trade_id: id, yes_price_dollars: String(p), count_fp: String(n), taker_book_side: side, _t: ms });
const E = () => { const logs = []; return { logs, log: (...a) => logs.push(a) }; };

group('a book line is written on change, not on every look');
{
  const io = disk(); let now = T0; const rec = makeMakerTape(cfg(), { io, clock: () => now });
  const e = E();
  rec(e, { books: new Map([['A', book(0.44, 120, 0.45, 300)]]) });
  now += 2000; rec(e, { books: new Map([['A', book(0.44, 120, 0.45, 300)]]) });
  now += 2000; rec(e, { books: new Map([['A', book(0.44, 90, 0.45, 300)]]) });
  const L = io.lines();
  ok('first look is written, an unchanged look is not, a size change is', L.length === 2 && L[0].bs === 120 && L[1].bs === 90, L);
  ok('the line names the market and carries both prices and both sizes', L[0].k === 'A' && L[0].b === 0.44 && L[0].a === 0.45 && L[0].as === 300 && L[0].mk === 'b', L[0]);
  now += 61000; rec(e, { books: new Map([['A', book(0.44, 90, 0.45, 300)]]) });
  const hb = io.lines().pop();
  ok('a flat market still leaves a heartbeat every minute, marked as one', hb.hb === 1 && hb.bs === 90, hb);
}

group('a new process says so, once, and a quote line says how much is ahead of it');
{
  const io = disk(); let now = T0; const rec = makeMakerTape(cfg(), { io, clock: () => now });
  rec(E(), { markets: { A: { quotes: { bid: 0.44, ask: null }, inv: 3, queue: { bid: 310.4, ask: 55 } } } });
  now += 2000; rec(E(), { markets: { A: { quotes: { bid: 0.44, ask: 0.45 }, inv: 3 } } });
  const L = io.raw();
  ok('the first line of a process is a start marker, and there is only one', L[0].mk === 'g' && L[0].why === 'start' && L.filter((l) => l.why === 'start').length === 1, L);
  ok('a quote line carries the queue ahead of each side, and none for a side with no quote', L[1].qb === 310 && L[1].qa === 0, L[1]);
  ok('a ledger with no queue yet reads as nothing ahead', L[2].qb === 0 && L[2].qa === 0, L[2]);
  const bad = disk(); bad.fail = true; const rec2 = makeMakerTape(cfg(), { io: bad, clock: () => T0 });
  rec2(E(), { markets: { A: { quotes: { bid: 0.44, ask: null }, inv: 0 } } });
  bad.fail = false;
  rec2(E(), { markets: { A: { quotes: { bid: 0.44, ask: null }, inv: 0 } } });
  ok('a start line lost to a failed write is written by the next one that works', bad.raw()[0].why === 'start' && bad.raw().filter((l) => l.why === 'start').length === 1, bad.raw());
}

group('prints');
{
  const io = disk(); const rec = makeMakerTape(cfg(), { io, clock: () => T0 });
  const t1 = print('t1', 0.45, 12, 'bid', T0 - 500);
  rec(E(), { trades: new Map([['A', [t1, print('t2', 0.44, 3, 'ask', T0 - 100)]]]) });
  rec(E(), { trades: new Map([['A', [t1]]]) });
  const L = io.lines();
  ok('each print once, with the exchange time, price, size and side', L.length === 2 && L[0].id === 't1' && L[0].t === T0 - 500 && L[0].p === 0.45 && L[0].n === 12 && L[0].s === 'b' && L[1].s === 'a', L);
  ok('a print returned by two polls is not written twice', L.filter((x) => x.id === 't1').length === 1);
  const io2 = disk(); const r2 = makeMakerTape(cfg(), { io: io2, clock: () => T0 });
  r2(E(), { trades: new Map([['A', [{ trade_id: 'bad', yes_price_dollars: 'x', count_fp: '1', taker_book_side: 'bid' }, { ...print('blk', 0.5, 900, 'bid', T0), is_block_trade: true }]]]) });
  ok('an unreadable print is skipped and a block trade is flagged', io2.lines().length === 1 && io2.lines()[0].blk === 1, io2.lines());
}

group('our own quote and inventory');
{
  const io = disk(); const rec = makeMakerTape(cfg(), { io, clock: () => T0 });
  const m = (bid, ask, inv) => ({ A: { quotes: { bid, ask }, inv } });
  rec(E(), { markets: m(0.44, 0.45, 0) }); rec(E(), { markets: m(0.44, 0.45, 0) }); rec(E(), { markets: m(0.44, null, -12) });
  const L = io.lines();
  ok('written when the quote or the inventory changes', L.length === 2 && L[1].a === null && L[1].i === -12, L);
  ok('a quote that is not reduce-only carries no flag', L.every((x) => !('ro' in x)), L);
  // 2026-09-24: maker.fillsFrom clips a reduce-only quote at flat, and the fill check replays the tape,
  // so the tape has to say which quotes were
  rec(E(), { markets: { A: { quotes: { bid: 0.44, ask: null, reduceOnly: true }, inv: -12 } } });
  rec(E(), { markets: { A: { quotes: { bid: 0.44, ask: null, reduceOnly: true }, inv: -12 } } });
  const R = io.lines();
  ok('the same quote and inventory, now reduce-only, is a new line, and says so with ro:1', R.length === 3 && R[2].ro === 1 && R[2].b === 0.44 && R[2].i === -12, R);
}

group('it can be turned off, and it can never hurt the desk');
{
  const io = disk(); makeMakerTape(cfg({ record: false }), { io })(E(), { books: new Map([['A', book(0.4, 1, 0.5, 1)]]) });
  const io2 = disk(); makeMakerTape(cfg({ makerRecord: false }), { io: io2 })(E(), { books: new Map([['A', book(0.4, 1, 0.5, 1)]]) });
  ok('RECORD=0 writes nothing', io.lines().length === 0);
  ok('RECORD_MAKER=0 writes nothing', io2.lines().length === 0);
  const bad = disk(); bad.fail = true; let now = T0; const rec = makeMakerTape(cfg(), { io: bad, clock: () => now }); const e = E();
  let threw = false;
  try { rec(e, { books: new Map([['A', book(0.4, 1, 0.5, 1)]]) }); now += 1000; rec(e, { books: new Map([['B', book(0.4, 1, 0.5, 1)]]) }); } catch { threw = true; }
  ok('a full disk does not throw into the desk', threw === false);
  ok('...and is reported once, not once per round', e.logs.filter((l) => /maker tape write failed/.test(l[3])).length === 1, e.logs);
  const nothing = makeMakerTape(cfg(), { io: disk() });
  let t2 = false; try { nothing(E(), {}); nothing(E(), { books: null, trades: null, markets: null }); } catch { t2 = true; }
  ok('an empty round is fine', t2 === false);
  ok('a one-sided book is skipped, not written as garbage', (() => { const d = disk(); makeMakerTape(cfg(), { io: d })(E(), { books: new Map([['A', { yesBids: [], yesAsks: [{ price: 0.5, size: 1 }] }]]) }); return d.lines().length === 0; })());
}

group('the file is the pair tape, named by Eastern day');
{
  const io = disk(); makeMakerTape(cfg(), { io, clock: () => Date.parse('2026-09-20T02:30:00Z') })(E(), { books: new Map([['A', book(0.4, 1, 0.5, 1)]]) });
  ok('20:30 Eastern on the 19th is still the 19th', Object.keys(io.files)[0].endsWith('ticks-2026-09-19.jsonl'), Object.keys(io.files));
}

group('a halt is a hole in the tape, not a quote resting through it');
{
  const io = disk(); let now = T0; const rec = makeMakerTape(cfg(), { io, clock: () => now }); const e = E();
  const quoted = { A: { quotes: { bid: 0.44, ask: 0.45 }, inv: 0 } }, withdrawn = { A: { quotes: { bid: null, ask: null }, inv: 0 } };
  rec(e, { books: new Map([['A', book(0.44, 120, 0.45, 300)]]), markets: quoted });
  now += 2000; rec(e, { markets: withdrawn, gap: 'halt' });
  now += 2000; rec(e, { markets: withdrawn, gap: 'halt' });
  let L = io.lines();
  ok('entering a halt writes one marker and a null quote for the withdrawn market', L.filter((x) => x.mk === 'g' && x.why === 'halt').length === 1 && L.some((x) => x.mk === 'q' && x.b === null && x.a === null), L);
  ok('...and a halt that lasts does not write a marker every round', L.filter((x) => x.mk === 'g').length === 1);
  now += 600000; rec(e, { books: new Map([['A', book(0.44, 120, 0.45, 300)]]), markets: quoted });
  L = io.lines();
  ok('the first round after says the desk is back, and after what', L.some((x) => x.mk === 'g' && x.why === 'resume' && x.after === 'halt'), L.filter((x) => x.mk === 'g'));
  ok('...rewrites the book even though it did not change', L.filter((x) => x.mk === 'b').length === 2, L.filter((x) => x.mk === 'b').length);
  ok('...and rewrites the quote it rejoined with, which the halt had cleared', L.filter((x) => x.mk === 'q').length === 3 && L.filter((x) => x.mk === 'q').pop().b === 0.44, L.filter((x) => x.mk === 'q'));
  const io2 = disk(); const r2 = makeMakerTape(cfg(), { io: io2, clock: () => T0 });
  r2(E(), { markets: withdrawn, gap: 'halt', trades: new Map([['A', [print('h1', 0.45, 5, 'bid', T0 - 200)]]]) });
  ok('prints read during a halt are still kept', io2.lines().some((x) => x.mk === 'p' && x.id === 'h1'), io2.lines());
  const io3 = disk(); makeMakerTape(cfg(), { io: io3, clock: () => T0 })(E(), { markets: withdrawn, gap: 'data-failure' });
  ok('a failed data round is marked as a hole too, by name', io3.lines().some((x) => x.mk === 'g' && x.why === 'data-failure'), io3.lines());
}

group('a poll that skipped prints says so');
{
  const io = disk(); makeMakerTape(cfg(), { io, clock: () => T0 })(E(), { missed: true });
  ok('a tape gap is a marker, not a quiet market', io.lines().length === 1 && io.lines()[0].mk === 'g' && io.lines()[0].why === 'tape-gap', io.lines());
}

group('a failed write does not mark anything as written');
{
  const io = disk(); let now = T0; const rec = makeMakerTape(cfg(), { io, clock: () => now }); const e = E();
  const round = () => ({ books: new Map([['A', book(0.44, 120, 0.45, 300)]]), trades: new Map([['A', [print('f1', 0.45, 5, 'bid', T0)]]]), markets: { A: { quotes: { bid: 0.44, ask: 0.45 }, inv: -12 } } });
  io.fail = true; rec(e, round());
  io.fail = false; now += 2000; rec(e, round());
  const L = io.lines();
  ok('the book, the print and the quote are all written by the next round that works', L.some((x) => x.mk === 'b') && L.some((x) => x.mk === 'p' && x.id === 'f1') && L.some((x) => x.mk === 'q' && x.i === -12), L);
  ok('...behind a marker saying a write was lost', L[0].mk === 'g' && L[0].why === 'write-failed', L[0]);
  now += 2000; rec(e, round());
  ok('...and once it has landed the marker is not repeated', io.lines().filter((x) => x.why === 'write-failed').length === 1);
}

group('a book line is stamped when the book arrived');
{
  const io = disk(); makeMakerTape(cfg(), { io, clock: () => T0 + 1500 })(E(), { books: new Map([['A', book(0.44, 1, 0.45, 1)]]), at: T0 + 200 });
  ok('the exchange answered at T0+200ms, the round finished at T0+1500ms: the line says 200', io.lines()[0].t === T0 + 200, io.lines()[0]);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

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
  d.lines = () => Object.values(d.files).join('').split('\n').filter(Boolean).map((l) => JSON.parse(l));
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

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

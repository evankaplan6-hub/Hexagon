'use strict';
// The weekly report (tools/week-report.js): Eastern weeks from Monday, each measured from the minute before
// it so the weeks add up to the whole run, the run measured from the starting cash, and the prediction desk's
// realised money folded into the same weeks. No network, no clock.
//
//   node tools/week-report-test.js
const W = require('./week-report');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const T = (iso) => Date.parse(iso);
const close = (a, b) => Math.abs(a - b) < 0.006;

group('mondayOf: the Monday that starts an Eastern date\'s week');
ok('a Thursday', W.mondayOf('2026-10-15') === '2026-10-12', W.mondayOf('2026-10-15'));
ok('a Monday is its own', W.mondayOf('2026-10-12') === '2026-10-12');
ok('a Sunday belongs to the week before', W.mondayOf('2026-10-18') === '2026-10-12', W.mondayOf('2026-10-18'));
ok('across a month', W.mondayOf('2026-10-01') === '2026-09-28', W.mondayOf('2026-10-01'));

group('deskWeeks: each week from the minute before it, so the weeks add up to the run');
{
  const p = (iso, c, bc, s, bs, e) => ({ t: T(iso), c, bc, s, bs, e });
  const start = { t: T('2026-09-25T21:30:00Z'), c: 1000, bc: 1000, s: 500, bs: 500, e: 1700 };
  const h = [
    start,
    p('2026-09-25T21:35:00Z', 996, 995, 500, 500, 1696),
    p('2026-09-28T03:00:00Z', 1010, 1020, 505, 505, 1715),   // Sunday 23:00 ET: still the first week
    p('2026-09-28T05:00:00Z', 1012, 1021, 505, 505, 1717),   // Monday 01:00 ET: the second
    p('2026-10-02T20:00:00Z', 980, 970, 510, 510, 1693),   // the off books made $3
  ];
  const ws = W.deskWeeks(h);
  ok('two Eastern weeks', ws.length === 2 && ws[0].week === '2026-09-21' && ws[1].week === '2026-09-28', ws.map((w) => w.week));
  ok('Sunday night in New York (already Monday in UTC) is the first week', ws[0].toT === T('2026-09-28T03:00:00Z'));
  ok('the first week runs from the starting cash', close(ws[0].crypto, 10) && close(ws[0].cryptoHold, 20) && close(ws[0].cryptoVs, -10), ws[0]);
  ok('the second from the first week\'s last minute', close(ws[1].crypto, -30) && close(ws[1].cryptoHold, -50) && close(ws[1].cryptoVs, 20), ws[1]);
  ok('a week\'s share is of its starting value', close(ws[1].cryptoPct * 1010, -30), ws[1].cryptoPct);
  const run = W.wholeRun(h);
  ok('the weeks add up to the run', close(ws[0].crypto + ws[1].crypto, run.crypto) && close(ws[0].desk + ws[1].desk, run.desk) && close(run.crypto, -20), run);
  ok('off books are the desk less crypto and SPY', close(ws[1].off, ws[1].desk - ws[1].crypto - ws[1].spy) && close(ws[1].off, 3), ws[1].off);
  ok('an empty history is no weeks and no run', W.deskWeeks([]).length === 0 && W.wholeRun([]) === null);
}

group('startPoint: the run counts the first day\'s fees, as desk-check does');
{
  const S = { startedAt: T('2026-09-25T21:30:00Z'), books: { crypto: { initial: 16666.65 }, stocks: { initial: 10000 }, options: { initial: 1000 }, scalps: { initial: 1000 } } };
  const sp = W.startPoint(S);
  ok('every book at its starting cash, holding too', sp.c === 16666.65 && sp.bc === 16666.65 && sp.s === 10000 && sp.bs === 10000 && sp.e === 28666.65, sp);
  ok('no books, no start point (the report then measures from the first minute)', W.startPoint({ books: {} }) === null);
}

group('deskTrades: fills and fees per Eastern week and book');
{
  const t = W.deskTrades([
    { t: '2026-10-12T14:00:00Z', kind: 'FILL', book: 'crypto', fee: 2.3 },
    { t: '2026-10-13T14:00:00Z', kind: 'FILL', book: 'stocks', fee: 0 },
    { t: '2026-10-12T03:00:00Z', kind: 'FILL', book: 'crypto', fee: 1 },   // Sunday 23:00 ET: the week before
    { t: '2026-10-12T15:00:00Z', kind: 'REBALANCE', book: 'crypto' },
  ]);
  const w = t.get('2026-10-12');
  ok('two fills that week, by book, fees added', w.fills === 2 && w.byBook.crypto === 1 && w.byBook.stocks === 1 && close(w.fees, 2.3), w);
  ok('Sunday night goes to the week before', t.get('2026-10-05').fills === 1);
}

group('pmWeeks + pmTotal: the prediction desk\'s realised money in the same weeks, and only those shown');
{
  const days = new Map([
    ['2026-09-15', { arb: 5, maker: -10, snipe: 0, bets: 0, conv: { pnl: -100 } }],
    ['2026-10-13', { arb: 1, maker: 2, snipe: 0, bets: -100, conv: { pnl: 0 } }],
    ['2026-10-14', { arb: 0.5, maker: 1, snipe: 3, bets: 50, conv: { pnl: 0 } }],
  ]);
  const pm = W.pmWeeks(days);
  const w = pm.get('2026-10-12');
  ok('days fold into their week, each book and the total', close(w.arb, 1.5) && close(w.maker, 3) && close(w.snipe, 3) && close(w.bets, -50) && close(w.total, -42.5), w);
  const tot = W.pmTotal(pm, [{ week: '2026-10-12' }]);
  ok('the total covers the weeks shown, not the desk\'s earlier ones', close(tot.total, -42.5) && close(tot.conv, 0), tot);
  ok('no week shown, no total', W.pmTotal(pm, [{ week: '2026-08-03' }]) === null);
}

group('the page: one file, nothing fetched, a name of its own, light and dark');
{
  const h = [{ t: T('2026-10-12T14:00:00Z'), c: 100, bc: 100, s: 50, bs: 50, e: 150 }, { t: T('2026-10-13T14:00:00Z'), c: 90, bc: 95, s: 51, bs: 51, e: 141 }];
  const data = { weeks: W.deskWeeks(h), whole: W.wholeRun(h), trades: new Map(), pm: new Map(), asOf: h[1].t };
  const html = W.renderHtml(data);
  ok('a title and the system font', /<title>The Weeks<\/title>/.test(html) && /-apple-system/.test(html));
  ok('no script, no link, no request', !/<script|<link|src=|https?:\/\//i.test(html));
  ok('dark mode by the device', /prefers-color-scheme:dark/.test(html));
  ok('the week and its gap to holding', /Week of Oct 12/.test(html) && /behind \$5\.00/.test(html), html.slice(0, 0));
  const text = W.renderText(data);
  ok('the text says it plainly', /behind holding by \$5\.00/.test(text) && /Since the start/.test(text), text);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

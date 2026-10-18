'use strict';
// Assertions for src/pmfloor.js: what the floor at / is sent about the prediction-market desk. Its books
// have to add up to the desk's own P&L, cent for cent, the way /pm's scorecard counts it; the log has to
// come out in the floor's words and levels, trades from the ledger rather than the log; and a box-sized
// desk has to fit in a frame the page is sent every two seconds. Real Engine, temp data dir, no network.
//
//   node tools/pmfloor-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Engine, betTally } = require('../src/engine');
const { pmFloor, pmLine, kindOf, gameOf } = require('../src/pmfloor');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const r2 = (x) => Math.round(x * 100) / 100;
const dirs = [];
const T = Date.parse('2026-09-29T21:00:00Z');

function engine(over = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-pmfloor-'));
  dirs.push(dataDir);
  const cfg = { ...base, mode: 'paper', demo: false, dataDir, record: false, makerEnabled: false, arbsEnabled: true, makerQuoting: true, snipe: true, convergeEnabled: false, maxArbGroups: 20, ...over };
  const E = new Engine(cfg);
  E.log = () => {};
  E.journal = () => {};
  return { E, cfg };
}
const leg = (over) => ({ id: 'x', group: 'g', pairId: 'pair', label: 'a pair', venue: 'KS', ref: 'KXA', side: 'yes', qty: 100, entry: 0.5, mark: 0.5, cost: 50, fee: 0, openedAt: T - 864e5, ...over });
// A desk like the box's: two arbs open (one settling sooner, one with no date on record), one closed arb,
// closed convergence legs, and a maker holding ten markets.
function boxLike(E, { markets = 10, closedExtra = 0 } = {}) {
  const s = E.state;
  s.initial = 10000;
  s.positions = [
    leg({ id: 'a1', group: 'ga', pairId: 'pa', label: 'Fed OCT 26 · Cut 25bps', venue: 'PM', side: 'yes', qty: 100, entry: 0.40, mark: 0.41, cost: 40.5, strategy: 'arb' }),
    leg({ id: 'a2', group: 'ga', pairId: 'pa', label: 'Fed OCT 26 · Cut 25bps', venue: 'KS', side: 'no', qty: 100, entry: 0.56, mark: 0.55, cost: 56.4, strategy: 'arb' }),
    leg({ id: 'b1', group: 'gb', pairId: 'pb', label: 'September Inflation US - Annual - 3.5%', venue: 'PM', side: 'yes', qty: 50, entry: 0.30, mark: 0.28, cost: 15.2, strategy: 'arb', settlesAt: T + 15 * 864e5 }),
    leg({ id: 'b2', group: 'gb', pairId: 'pb', label: 'September Inflation US - Annual - 3.5%', venue: 'KS', side: 'no', qty: 50, entry: 0.66, mark: 0.70, cost: 33.3, strategy: 'arb', settlesAt: T + 15 * 864e5 }),
  ];
  s.closed = [
    { ...leg({ id: 'c1', group: 'gc', strategy: 'arb', label: 'Presidential 2028 - Someone' }), exit: 1, exitAt: T - 3600e3, pnl: 12.5, reason: 'resolved YES' },
    { ...leg({ id: 'c2', group: 'gc', strategy: 'arb', side: 'no', label: 'Presidential 2028 - Someone' }), exit: 0, exitAt: T - 3600e3, pnl: -10.25, reason: 'resolved YES' },
    ...Array.from({ length: 5 }, (_, i) => ({ ...leg({ id: `v${i}`, group: `gv${i}`, strategy: 'converge' }), exit: 0.45, exitAt: T - 5 * 864e5 + i, pnl: i === 0 ? 4 : -20, reason: 'gap closed' })),
  ];
  const banked = r2(s.closed.reduce((a, c) => a + c.pnl, 0));
  s.stats.realized = r2(banked + closedExtra);
  // cash so that equity is initial + realized + the open legs' mark-to-market
  const cost = s.positions.reduce((a, p) => a + p.cost, 0);
  s.cash = r2(s.initial + s.stats.realized - cost);
  const mk = Array.from({ length: markets }, (_, i) => ({ ticker: `KXM-${i}`, title: `Market ${i}?`, sub: `Outcome ${i}`, inv: i % 2 ? -(i + 1) * 10 : (i + 1) * 10, cost: (i + 1) * 5, mark: (i + 1) * 5 + (i - 4), fills: i, quoting: i < 3 }));
  E.maker.snapshot = () => ({
    cash: 9400, equity: 9512.34, realized: -41.2, fills: 1234, halted: null, lastFill: { at: T - 60e3 }, initial: 10000, enabled: true, quoting: 3,
    inv: mk.reduce((a, m) => a + Math.abs(m.inv), 0), markets: mk,
    recent: [{ ticker: 'KXRAIN-4', title: 'Rain in Chicago in Sep 2026?', sub: 'Above 4 inches', side: 'buy', qty: 5, px: 0.17, pnl: -0.35, at: T - 30e3 },
      { ticker: 'KXRAIN-4', title: 'Rain in Chicago in Sep 2026?', sub: 'Above 4 inches', side: 'sell', qty: 5, px: 0.18, pnl: 0, at: T - 90e3 }],
  });
  E.beat = { taker: T - 5000, maker: T - 1000 };
  return s;
}

group('the books add up to the desk, the way /pm counts it');
{
  const { E, cfg } = engine(); boxLike(E);
  const F = pmFloor(E, cfg, T);
  const [arbs, maker, snipe, conv, bets] = F.books;
  ok('five books, every game last (2026-09-30)', F.books.map((b) => b.key).join() === 'arbs,maker,snipe,converge,bets', F.books.map((b) => b.key));
  ok('the total is the account plus the maker, as the floor has always said', F.pnl === r2(E.equity() - 10000 + (9512.34 - 10000)), [F.pnl, E.equity()]);
  ok('the books add up to the total, to the cent', r2(arbs.pnl + maker.pnl + snipe.pnl + conv.pnl + bets.pnl) === F.pnl, F.books.map((b) => b.pnl));
  ok('its paper is both accounts', F.initial === 20000, F.initial);
  const sc = E.pnlScorecard(E.arbScorecard(), E.maker.snapshot());
  ok('the arbs at settlement are /pm\'s locked figure plus what the closed arbs banked', arbs.atSettle === r2(2.25 + sc.arbLocked + sc.arbUnvouched), [arbs.atSettle, sc]);
  ok('an arb marked now is its banked part plus what its legs would fetch', arbs.pnl === r2(2.25 + sc.arbLiquidation), [arbs.pnl, sc.arbLiquidation]);
  ok('one closed arb is one, not its two legs', arbs.closed === 1, arbs.closed);
  ok('the slots: 2 of 20', arbs.rows.length === 2 && arbs.max === 20, [arbs.rows.length, arbs.max]);
  ok('the arb settling first comes first, and one with no date on record last', arbs.rows[0].id === 'gb' && arbs.rows[1].settlesAt === null, arbs.rows.map((r) => [r.id, r.settlesAt]));
  ok('a valid arb locks in what $1 a pair pays less what it cost', arbs.rows[0].locked === r2(50 - 48.5) && arbs.rows[0].pays === 50, arbs.rows[0]);
  ok('convergence: 1 of 5 made money, and it is off', conv.wins === 1 && conv.trades === 5 && conv.on === false, conv);
  ok('its rule says so', /Switched off on 2026-09-21 after losing on paper: 1 of 5 made money/.test(conv.rule), conv.rule);
  ok('the snipe never fired, and its rule says why', snipe.bought === 0 && snipe.pnl === 0 && /never fired/.test(snipe.rule), snipe);
  ok('the maker: its equity less its paper', maker.pnl === -487.66, maker);
  // 2026-10-16 audit: banked is the figure less what is open, so the card adds up even where the running total drifted
  ok('...and banked plus open is that figure, whatever the maker\'s running total says (-41.20 here)', maker.realized === r2(maker.pnl - maker.open) && r2(maker.realized + maker.open) === maker.pnl, [maker.realized, maker.open]);
  ok('the maker sends the six markets moving it most, of ten held', maker.rows.length === 6 && maker.markets === 10, maker.rows.length);
  ok('...biggest move first', maker.rows.every((r, i, a) => !i || Math.abs(a[i - 1].pnl) >= Math.abs(r.pnl)), maker.rows.map((r) => r.pnl));
  ok('the summary the PRED line reads is still there', /^trading in paper: 2 arbs, /.test(F.note) && F.lastCycleAt === T - 5000 && F.url === '/pm', [F.note, F.lastCycleAt]);
}

group('a trimmed ledger still adds up: the oldest closes were convergence\'s');
{
  const { E, cfg } = engine(); boxLike(E, { closedExtra: -50 });
  const F = pmFloor(E, cfg, T);
  const conv = F.books.find((b) => b.key === 'converge');
  ok('convergence takes the realised total the closed list no longer holds', conv.realized === r2(4 - 80 - 50), conv.realized);
  ok('and the books still add up', r2(F.books.reduce((a, b) => a + b.pnl, 0)) === F.pnl, [F.books.map((b) => b.pnl), F.pnl]);
}

group('trades come from the ledger, newest first');
{
  const { E, cfg } = engine(); boxLike(E);
  E.state.log = [
    { t: T - 1000, agent: 'KETT', kind: 'FILL', pnl: null, text: 'ARB Fed OCT 26 · bought both legs' },
    { t: T - 2000, agent: 'MAKR', kind: 'FILL', pnl: -911, text: '2 fills this cycle · 300 contracts held across 10 markets · equity $9512.34' },
    { t: T - 3000, agent: 'RIGO', kind: 'SETTLE', pnl: 12.5, text: 'Presidential 2028 · sold at 1' },
    { t: T - 4000, agent: 'MAKR', kind: 'SETTLE', pnl: 3.1, text: 'KXM-1 settled NO · +$3.10' },
  ];
  const F = pmFloor(E, cfg, T);
  ok('the log\'s fill and settle lines are left out, but a maker settlement is only in the log', F.log.length === 1 && F.log[0].agent === 'MAKR' && F.log[0].level === 'trade', F.log);
  ok('newest first', F.fills.every((f, i, a) => !i || a[i - 1].at >= f.at), F.fills.map((f) => f.at));
  const mk = F.fills.filter((f) => f.book === 'maker');
  ok('the maker\'s fills, named by their market and outcome', mk.length === 2 && mk[0].label === 'Rain in Chicago in Sep 2026 · Above 4 inches' && mk[0].action === 'bought' && mk[1].action === 'sold', mk);
  E.maker.snapshot = ((snap) => () => ({ ...snap(), recent: [{ ticker: 'KXR', title: 'Will **Marco Rubio** be the nominee?', sub: 'Marco Rubio', side: 'buy', qty: 1, px: 0.18, pnl: 0, at: T }] }))(E.maker.snapshot);
  ok('a Kalshi question loses its "Will", its bold and its question mark', pmFloor(E, cfg, T).fills[0].label === 'Marco Rubio be the nominee · Marco Rubio', pmFloor(E, cfg, T).fills[0].label);
  ok('a Polymarket label cut in the middle reads as one name', pmLine({ agent: 'ILSA', kind: 'RESEARCH', text: 'French Guiana vs. Sint Maarten -... - Both Teams to Score: PM −33.0c, KS −1.0c over 2m · gap 7.5c narrowing' }).text.startsWith('French Guiana vs. Sint Maarten… - Both Teams to Score: price moved −33¢'));
  ok('...and one cut after a word keeps its dash', pmLine({ agent: 'KETT', kind: 'PASS', text: 'Trump bans more news outlets from... - Before Oct 1, 2026: gap 2c' }).text === 'Passed on Trump bans more news outlets from… - Before Oct 1, 2026');
  ok('a snipe that declined says its cents in cents', pmLine({ agent: 'BRAM', kind: 'RESEARCH', text: 'MLB Phillies v Braves · Phillies: Polymarket has settled, no snipe: 1.0c net after the fee' }).text === 'MLB Phillies v Braves · Phillies: Polymarket has settled, no snipe: 1.0¢ net after the fee');
  ok('a maker fill that moved no money carries no amount', mk[0].pnl === -0.35 && mk[1].pnl === null, mk.map((f) => f.pnl));
  const settled = F.fills.filter((f) => f.action === 'settled');
  ok('a leg that closed on the resolution says settled, with what it made', settled.length === 2 && settled.some((f) => f.pnl === 12.5), settled);
  ok('an arb leg\'s opening, with its venue by name', F.fills.some((f) => f.id === 'a1:open' && f.venue === 'Polymarket' && f.action === 'bought' && f.book === 'arb'), F.fills.map((f) => f.id));
  ok('forty at most', pmFloor(E, cfg, T).fills.length <= 40);
}

group('the log in the floor\'s words and levels');
{
  const L = (agent, kind, text, pnl = null) => pmLine({ agent, kind, text, pnl });
  const clean = L('TESS', 'OPS', 'data age 0s, window is clean · 0/12 bets (book off), 20/20 arbs open · per-trade budget $184.49 · day −0.10% · 0 api errs/5m');
  ok('an all-clear round is routine, and says the day', clean.level === 'quiet' && clean.text === 'All clear: prices are fresh, the account −0.10% today', clean);
  ok('a halt needs a look', L('TESS', 'OPS', 'HALT · quotes stale 95s · no new risk until clear').level === 'warn');
  ok('a cycle error needs a look', L('TESS', 'OPS', 'cycle error: fetch failed').level === 'warn');
  const mv = L('ILSA', 'RESEARCH', 'MLB White Sox v Astros · White Sox: PM +1.0c, KS −3.0c over 2m · gap 0.0c narrowing · vol24 PM $606,312 / KS $3,264,610');
  ok('a price move is a sentence, and routine', mv.level === 'quiet' && mv.text === 'MLB White Sox v Astros · White Sox: price moved +1¢ on Polymarket, moved −3¢ on Kalshi' && mv.sub === 'venues 0¢ apart, narrowing', mv);
  ok('a price that did not move held', /price held on Polymarket/.test(L('ILSA', 'RESEARCH', 'X: PM +0.0c, KS +1.0c over 2m · gap 1.0c widening').text));
  const sn = L('BRAM', 'RESEARCH', 'MLB Phillies v Braves · Phillies: Polymarket has closed the market, YES won · Kalshi offers the winner at 99c (40 at the touch) · +0.3c net · watched, not bought (SNIPE=0)');
  ok('a game\'s label keeps its own " · " when the snipe\'s watch reports a close', sn.text === 'MLB Phillies v Braves · Phillies: Polymarket has closed the market, YES won' && sn.level === 'info', sn);
  ok('...and what Kalshi offered goes under it, in cents', /^Kalshi offers the winner at 99¢/.test(sn.sub), sn.sub);
  // 2026-09-30: the watch says the resolver's proposal (the snipe's moment) and which venue closed first
  const pr = L('BRAM', 'RESEARCH', "MLB White Sox v Astros · White Sox: Polymarket has proposed YES, 24s after its 99c reading · Kalshi offers the winner at 100c (0 at the touch) · -0.0c net");
  ok("the resolver's proposal is a line of its own, Kalshi's offer under it", pr.text === 'MLB White Sox v Astros · White Sox: Polymarket has proposed YES, 24s after its 99¢ reading' && pr.sub === 'Kalshi offers the winner at 100¢ (0 at the touch) · -0.0¢ net' && pr.level === 'info', pr);
  const cl = L('BRAM', 'RESEARCH', 'MLB Phillies v Braves · Phillies: Polymarket has closed the market, NO won, 67m after its 99c reading · Kalshi had closed its own 64m before and paid it out at 20:46Z: nothing left to buy');
  ok('a close with Kalshi long shut says so under it', cl.text === 'MLB Phillies v Braves · Phillies: Polymarket has closed the market, NO won, 67m after its 99¢ reading' && /^Kalshi had closed its own 64m before/.test(cl.sub), cl);
  ok('the widest gap is routine', L('BRAM', 'RESEARCH', 'venue gap 9.5c: Polymarket over Kalshi @ Next Google Gemini Pro Model released - September 30 · PM 0.12/0.14 · KS 0.02/0.05').level === 'quiet');
  const pass1 = L('KETT', 'PASS', '20/20 arbs open, passing on Fed DEC 26 · Cut 25bps');
  ok('a full book passing on the next market is routine: it says so every five minutes', pass1.level === 'quiet' && pass1.text === 'Passed on Fed DEC 26 · Cut 25bps', pass1);
  const pass3 = L('KETT', 'PASS', 'long-dated arb budget full at 6 arbs settling after 30 days, passing on Oscars 2027 Best Director Nominations - Beth de Araujo');
  ok('...and so is the long-dated budget, the reason under it', pass3.level === 'quiet' && pass3.text === 'Passed on Oscars 2027 Best Director Nominations - Beth de Araujo' && /^long-dated arb budget full at 6/.test(pass3.sub), pass3);
  const pass2 = L('KETT', 'PASS', 'Fed DEC 26: gap 3c but ILSA reads it widening');
  ok('...named by its market', pass2.text === 'Passed on Fed DEC 26' && pass2.sub === 'gap 3c but ILSA reads it widening', pass2);
  const book = L('MAKR', 'RESEARCH', 'book: 2309 contracts, cash $9383.57, marked $9087.30 from $10000.00 · 12243 fills total');
  ok('the maker\'s book line in words', book.level === 'quiet' && book.text === 'Maker holding 2,309 contracts, down $912.70 if closed now', book);
  ok('a maker market crossed out ahead of its event moved money', L('MAKR', 'OPS', 'KXSEN-IA: its event is tomorrow · crossed out 40 at 55c (-$1.20 after the taker fee)', -1.2).level === 'trade');
  ok('a maker stream drop needs a look', L('MAKR', 'OPS', 'trade stream dropped (1006) · polling until it is back').level === 'warn');
  ok('a maker stream connecting is routine', L('MAKR', 'OPS', 'trade stream connected · prints arrive as they happen').level === 'quiet');
  ok('broken arbs on the scorecard need a look', L('RIGO', 'RESEARCH', 'scorecard: 20 open · arb locked +$167.20 · liquidation −$769.03 · realized −$860.79 · 1 integrity alert').level === 'warn');
  const whale = L('ILSA', 'WHALE', 'someone bought $20K on Hurricanes at 54c · Panthers vs. Hurricanes');
  ok('a big bet is said in cents, and is routine: whale watch never trades', whale.text === 'Big bet: someone bought $20K on Hurricanes at 54¢' && whale.level === 'quiet', whale);
  ok('a newly matched pair is routine', L('HOLT', 'SCAN', '203 pairs live (123 elections) · +1 new: MLB Cubs v Padres · Cubs').level === 'quiet');
  ok('a HALT kind always needs a look', L('RIGO', 'HALT', 'x: exit response unknown · awaiting reconciliation').level === 'warn');
  ok('the positions kind: arb, snipe, and everything else is convergence', kindOf({ strategy: 'arb' }) === 'arb' && kindOf({ strategy: 'snipe' }) === 'snipe' && kindOf({ strategy: 'brain' }) === 'converge');
  ok('a game bet is its own book', kindOf({ strategy: 'bet' }) === 'bet');
}

group('a box-sized desk fits the frame');
{
  const { E, cfg } = engine(); boxLike(E, { markets: 420 });
  const s = E.state;
  // 20 arbs, the ring's 500 lines (mostly routine), 2,000 closed legs
  for (let g = 0; g < 20; g++) for (const [v, side] of [['PM', 'yes'], ['KS', 'no']]) s.positions.push(leg({ id: `z${g}${v}`, group: `gz${g}`, pairId: `pz${g}`, label: `A long market name that runs on for a while, number ${g}`, venue: v, side, qty: 150, cost: 70, strategy: 'arb', settlesAt: T + g * 864e5 }));
  s.closed = Array.from({ length: 2000 }, (_, i) => ({ ...leg({ id: `k${i}`, group: `gk${i >> 1}`, strategy: i < 1500 ? 'converge' : 'arb' }), exit: 1, exitAt: T - i * 6e4, pnl: 0.5, reason: 'resolved YES' }));
  s.stats.realized = 1000;
  s.cash = r2(s.initial + s.stats.realized - s.positions.reduce((a, p) => a + p.cost, 0));
  s.log = Array.from({ length: 500 }, (_, i) => (i % 10
    ? { t: T - i * 7000, agent: 'ILSA', kind: 'RESEARCH', pnl: null, text: `Some market ${i}: PM +1.0c, KS +0.0c over 2m · gap 0.5c narrowing · vol24 PM $1 / KS $2` }
    : { t: T - i * 7000, agent: 'KETT', kind: 'PASS', pnl: null, text: `Market ${i}: only 3 contracts inside limit, below 5-lot floor` }));
  const F = pmFloor(E, cfg, T);
  ok('thirty routine lines at most, and every other line', F.log.filter((e) => e.level === 'quiet').length === 30 && F.log.filter((e) => e.level === 'info').length === 50, [F.log.length]);
  ok('a hundred and twenty lines at most', F.log.length <= 120, F.log.length);
  ok('every open arb is sent (22 of them)', F.books[0].rows.length === 22, F.books[0].rows.length);
  const bytes = Buffer.byteLength(JSON.stringify(F));
  ok('the whole of it is under 60 KB before gzip', bytes < 60000, bytes);
  ok('the books still add up', r2(F.books.reduce((a, b) => a + b.pnl, 0)) === F.pnl, [F.books.map((b) => b.pnl), F.pnl]);
  // audit 2026-10-17: the game board rides in the same frame. A college Saturday at the board's caps (120 games still
  // to bet, finals in the last thirty hours, long names) keeps it, and the frame, inside a budget
  const { E: E2, cfg: cfg2 } = engine({ bets: true, betSeries: ['KXNCAAFGAME'] }); boxLike(E2, { markets: 420 });
  E2.pairs = Array.from({ length: 160 }, (_, i) => ({ id: `${5300000 + i}:0|KXNCAAFGAME-26OCT17TEAM${i}OPP${i}-TEAM${i}`, kind: 'game', series: 'KXNCAAFGAME',
    label: `NCAAF Central Connecticut State ${i} v Southeast Missouri State ${i} · Central Connecticut State ${i}`, startsAt: T + (i % 12) * 1800e3, q: { pmMid: 0.6, ksMid: 0.62 } }));
  E2.state.closed.push(...Array.from({ length: 140 }, (_, i) => ({ ...leg({ id: `fb${i}`, group: `gfb${i}`, pairId: `${5200000 + i}:0|KXNCAAFGAME-26OCT17X${i}-X${i}`, strategy: 'bet',
    label: `NCAAF Stephen F. Austin ${i} v Northwestern State ${i} · Stephen F. Austin ${i}`, side: i % 2 ? 'yes' : 'no', qty: 160, entry: 0.62, cost: 99.5 }), exit: i % 3 ? 1 : 0, exitAt: T - i * 600e3, pnl: i % 3 ? 60 : -99.5, reason: 'resolved' })));
  const G2 = pmFloor(E2, cfg2, T), board = Buffer.byteLength(JSON.stringify(G2.games)), all2 = Buffer.byteLength(JSON.stringify(G2));
  ok('at its caps the board is a hundred games still to bet and eighty finals', G2.games.upcoming.length === 100 && G2.games.finals.length === 80, [G2.games.upcoming.length, G2.games.finals.length]);
  ok('...under 45 KB before gzip, and the frame with it under 110 KB', board < 45000 && all2 < 110000, { board, all2 });
}

group('switched off and winding down');
{
  const { E, cfg } = engine({ arbsEnabled: false, makerQuoting: false, snipe: false }); boxLike(E);
  const F = pmFloor(E, cfg, T);
  ok('every book says it is off', F.books.every((b) => b.on === false), F.books.map((b) => [b.key, b.on]));
  ok('with things still open, it is winding down', F.trading === false && /^winding down/.test(F.note), F.note);
}

group('the floor\'s words (2026-10-10 audit): a bet names its pick, maker fills fold, a market is named not tickered');
{
  const { E, cfg } = engine({ bets: true }); const s = boxLike(E);
  // a game bet open on the other side, and one that settled
  s.positions.push(leg({ id: 'bt1', group: 'gbt1', pairId: 'pbt', label: 'NCAAF Texas A&M v Missouri · Texas A&M', venue: 'PM', side: 'no', qty: 124, entry: 0.80, mark: 0.79, cost: 99.8, strategy: 'bet' }));
  s.closed.push({ ...leg({ id: 'bt0', group: 'gbt0', pairId: 'pbt0', label: 'NFL Vikings v Bears · Vikings', venue: 'KS', side: 'yes', qty: 150, entry: 0.6, cost: 90, strategy: 'bet' }), exit: 1, exitAt: T - 7200e3, exitPnl: 60, pnl: 60, reason: 'resolved YES' });
  ok('a NO leg on the named side is a bet on the other team', JSON.stringify(gameOf(s.positions[s.positions.length - 1])) === JSON.stringify({ league: 'NCAAF', pick: 'Missouri', foe: 'Texas A&M' }));
  ok('a YES leg is a bet on the named team', JSON.stringify(gameOf(s.closed[s.closed.length - 1])) === JSON.stringify({ league: 'NFL', pick: 'Vikings', foe: 'Bears' }));
  ok('an arb leg, or a label that is not a game, has no pick', gameOf(s.positions[0]) === null && gameOf({ strategy: 'bet', label: 'Fed DEC 26 · Cut 25bps', side: 'yes' }) === null);
  // the maker: twelve partial fills at one price inside a minute, one at another, and a market whose question
  // starts with "the"
  const mk = [
    { ticker: 'GOVPARTYFL-26-R', title: 'Will the Republican party win the governorship in Florida?', sub: 'Republican', inv: 6, cost: 3, mark: 3, fills: 9, quoting: false },
    { ticker: 'KXPHI-26', title: 'Will the Philadelphia pro football team win at least 9 games this season?', sub: '9+ wins', inv: -23, cost: 9.89, mark: 12.53, fills: 4, quoting: true },
  ];
  const sizes = [2, 1, 10, 2, 9, 8, 6, 4, 6, 30, 7, 1];
  E.maker.snapshot = () => ({ cash: 9400, equity: 9512.34, realized: -41.2, fills: 1234, halted: null, lastFill: { at: T - 5e3 }, initial: 10000, enabled: true, quoting: 1, inv: 29, markets: mk,
    recent: [...sizes.map((q, i) => ({ ticker: 'GOVPARTYOH-26-D', title: 'Will the Democratic party win the governorship in Ohio?', sub: 'Amy Acton', side: 'sell', qty: q, px: 0.69, pnl: -0.1, at: T - 50e3 + i * 3e3 })),
      { ticker: 'GOVPARTYOH-26-D', title: 'Will the Democratic party win the governorship in Ohio?', sub: 'Amy Acton', side: 'sell', qty: 3, px: 0.70, pnl: 0, at: T - 5e3 }] });
  s.log = [
    { t: T - 1000, agent: 'MAKR', kind: 'OPS', pnl: null, text: 'GOVPARTYFL-26-R cooled 60m: 50% of its last 30 fills were run over (limit 40%) · quotes withdrawn, 6 held' },
    { t: T - 2000, agent: 'MAKR', kind: 'SETTLE', pnl: -0.44, text: 'settled 2 finalized markets, 39 contracts · realised -$0.44 · equity $9100.81' },
    { t: T - 3000, agent: 'MAKR', kind: 'OPS', pnl: null, text: 'KXSOMEWHERE-1 cooled 240m: 72% of the contracts in its last 30 fills were run over (limit 40%) · quotes withdrawn, 100 held' },
    { t: T - 4000, agent: 'MAKR', kind: 'OPS', pnl: -1.2, text: 'KXPHI-26: its event is tomorrow · crossed out 40 at 55c (-$1.20 after the taker fee)' },
  ];
  const F = pmFloor(E, cfg, T);
  const bets = F.books.find((b) => b.key === 'bets');
  ok('the every-game card\'s row carries the pick and the opponent', bets.rows.length === 1 && bets.rows[0].game && bets.rows[0].game.pick === 'Missouri' && bets.rows[0].game.foe === 'Texas A&M', bets.rows);
  // 2026-10-16 exam: two bets on one series' games read as one game bet twice: each row says when its game is
  s.positions.push(leg({ id: 'bt2', group: 'gbt2', pairId: 'p-sat', label: 'MLB Rays v Guardians · Rays', venue: 'KS', side: 'yes', qty: 181, entry: 0.54, mark: 0.52, cost: 99.3, strategy: 'bet' }),
    leg({ id: 'bt3', group: 'gbt3', pairId: 'p-fri', label: 'MLB Rays v Guardians · Rays', venue: 'KS', side: 'yes', qty: 192, entry: 0.51, mark: 0.51, cost: 99.6, strategy: 'bet' }));
  E.pairs = [{ id: 'p-sat', startsAt: T + 30 * 3600e3 }, { id: 'p-fri', startsAt: T + 6 * 3600e3 }];
  const B2 = pmFloor(E, cfg, T).books.find((b) => b.key === 'bets');
  ok('a bet row carries its game\'s start, soonest first, a game the listing dropped last', B2.rows.map((r) => r.id).join() === 'bt3,bt2,bt1' && B2.rows[0].startsAt === T + 6 * 3600e3 && B2.rows[2].startsAt === null, B2.rows.map((r) => [r.id, r.startsAt]));
  s.positions = s.positions.filter((p) => p.id !== 'bt2' && p.id !== 'bt3'); E.pairs = [];
  // the snipe's watch asks each round, so one game's line came twice in a row
  const seenLog = s.log;
  s.log = [1, 2].map((i) => ({ t: T - i * 300e3, agent: 'BRAM', kind: 'RESEARCH', pnl: null, text: 'NBA Heat v Magic · Heat: Polymarket has settled, no snipe: 0.0c net after the fee' }));
  const sn = pmFloor(E, cfg, T).books.find((b) => b.key === 'snipe');
  ok('the snipe card says a game\'s line once', sn.seen.length === 1, sn.seen);
  s.log = seenLog;
  const open = F.fills.find((f) => f.id === 'bt1:open'), done = F.fills.find((f) => f.id === 'bt0:close');
  ok('so does its fill, opening and settled', open && open.game.pick === 'Missouri' && done && done.action === 'settled' && done.pnl === 60 && done.game.pick === 'Vikings', [open, done]);
  ok('an arb\'s fill has none', F.fills.find((f) => f.id === 'a1:open').game === null);
  const mkf = F.fills.filter((f) => f.book === 'maker');
  ok('twelve fills at one price in one minute are one, with their count, and the other price its own', mkf.length === 2 && mkf.some((f) => f.qty === 86 && f.n === 12 && f.px === 0.69 && f.pnl === -1.2) && mkf.some((f) => f.qty === 3 && f.n === 1 && f.px === 0.7 && f.pnl === null), mkf);
  ok('the folded fill is keyed by its minute, so it stays the same row as more arrives', mkf.find((f) => f.n === 12).id === `mk:GOVPARTYOH-26-D:${Math.floor((T - 50e3) / 60000)}:sell:0.69`, mkf.map((f) => f.id));
  ok('and is dated by its last fill', mkf.find((f) => f.n === 12).at === T - 50e3 + 11 * 3e3);
  const maker = F.books.find((b) => b.key === 'maker');
  ok('a market whose question starts with "the" is capitalised', maker.rows.some((r) => r.title === 'The Philadelphia pro football team win at least 9 games this season'), maker.rows.map((r) => r.title));
  const cooled = F.log.find((e) => /quotes pulled for an hour/.test(e.text));
  ok('a cooled market is named, not tickered, and the line is in words', cooled && cooled.text === 'The Republican party win the governorship in Florida · Republican: quotes pulled for an hour' && cooled.sub === '50% of its last 30 fills were run over, the limit is 40% · 6 held' && cooled.level === 'info', cooled);
  const unknown = F.log.find((e) => /^KXSOMEWHERE-1/.test(e.text));
  ok('a ticker the snapshot does not know stays a ticker, with the hours spelt out', unknown && unknown.text === 'KXSOMEWHERE-1: quotes pulled for 4 hours' && unknown.sub === '72% of the contracts in its last 30 fills were run over, the limit is 40% · 100 held', unknown);
  ok('a crossed-out market is named too', F.log.some((e) => e.text === 'The Philadelphia pro football team win at least 9 games this season · 9+ wins: its event is tomorrow' && e.level === 'trade'), F.log.map((e) => e.text));
  ok('no maker line says "Maker:" under a tag that says Maker', F.log.every((e) => !/^Maker: /.test(e.text)) && F.log.some((e) => e.text === 'Settled 2 finalized markets, 39 contracts'), F.log.map((e) => e.text));
}

group('the game board (2026-10-17): the games still to bet, the finals, and the record against the prices');
{
  const { E, cfg } = engine({ bets: true, betSeries: ['KXNFLGAME', 'KXNCAAFGAME', 'KXNBAGAME', 'KXMLBGAME'], betMaxPx: 0.9, betAheadHours: 1, betUsd: 100 });
  const s = E.state;
  s.positions = [leg({ id: 'ob', group: 'gob', pairId: 'p-open', label: 'NCAAF Ohio State v Indiana · Ohio State', side: 'yes', entry: 0.8, cost: 99.7, strategy: 'bet' })];
  // T is 5 PM ET on Tuesday 2026-09-29. One final this afternoon (won), one that settled at 1:30 AM, a game from the
  // evening before (lost), and one five days ago (won)
  s.closed = [
    { ...leg({ id: 'w1', group: 'gw1', pairId: 'p-w1', label: 'NFL Vikings v Bears · Vikings', side: 'yes', qty: 150, entry: 0.6, cost: 90, strategy: 'bet' }), exit: 1, exitAt: T - 7200e3, pnl: 60, reason: 'resolved YES' },
    { ...leg({ id: 'l1', group: 'gl1', pairId: 'p-l1', label: 'NBA Heat v Magic · Heat', side: 'no', qty: 180, entry: 0.55, cost: 99, strategy: 'bet' }), exit: 0, exitAt: Date.parse('2026-09-29T05:30:00Z'), pnl: -99, reason: 'resolved YES' },
    { ...leg({ id: 'o1', group: 'go1', pairId: 'p-o1', label: 'MLB Rays v Guardians · Rays', side: 'yes', qty: 198, entry: 0.5, cost: 100, strategy: 'bet' }), exit: 1, exitAt: T - 5 * 864e5, pnl: 98, reason: 'resolved YES' },
    { ...leg({ id: 'ax', group: 'gax', strategy: 'arb', label: 'Fed OCT 26 · Cut 25bps' }), exit: 1, exitAt: T - 3600e3, pnl: 5, reason: 'resolved YES' },
  ];
  s.stats.bets = betTally(s.closed);   // as the engine keeps it (tallyBet at each settlement; backfilled from closed on load)
  const H = 3600e3, pair = (id, series, label, startsAt, q) => ({ id, kind: 'game', series, label, startsAt, q });
  E.pairs = [
    pair('u1', 'KXNFLGAME', 'NFL Seahawks v Broncos · Seahawks', T + 3 * H, { pmMid: 0.40, ksMid: 0.42 }),
    pair('u2', 'KXNFLGAME', 'NFL Seahawks v Broncos · Broncos', T + 3 * H, { pmMid: 0.60, ksMid: 0.58 }),   // the same game's other side
    pair('u3', 'KXNCAAFGAME', 'NCAAF Georgia v Auburn · Georgia', T + 5 * H, { pmMid: 0.93, ksMid: 0.95 }),  // over the cap
    pair('p-open', 'KXNCAAFGAME', 'NCAAF Ohio State v Indiana · Ohio State', T + 2 * H, { pmMid: 0.8, ksMid: 0.8 }),   // bet already
    pair('u5', 'KXEPLGAME', 'EPL Arsenal v Chelsea · Arsenal', T + 2 * H, { pmMid: 0.5, ksMid: 0.5 }),         // not a series the book bets
    pair('u6', 'KXNFLGAME', 'NFL Rams v Lions · Rams', T + 40 * H, { pmMid: 0.5, ksMid: 0.5 }),               // more than thirty hours out
    pair('u7', 'KXMLBGAME', 'MLB Cubs v Brewers · Cubs', T + H, null),                                        // no price yet
    pair('u8', 'KXNBAGAME', 'NBA Knicks v Nets · Knicks', T - 5 * H, { pmMid: 0.7, ksMid: 0.7 }),             // started five hours ago
    { id: 'fed', kind: 'fed', series: 'KXFEDDECISION', label: 'Fed OCT 26 · Cut 25bps', startsAt: T + H },
  ];
  const G = pmFloor(E, cfg, T).games;
  ok('the games still to bet: paired, in the book\'s series, from four hours ago to thirty hours on, each game once, soonest first',
    G.upcoming.map((u) => u.id).join() === 'u7,u1,u3', G.upcoming.map((u) => u.id));
  const u1 = G.upcoming.find((u) => u.id === 'u1');
  ok('the favourite as the bets read it: the two venues\' mids averaged, Broncos at 59c', u1.fav === 'b' && u1.px === 0.59 && u1.over === false && u1.league === 'NFL' && u1.a === 'Seahawks' && u1.b === 'Broncos', u1);
  ok('a favourite over the cap is marked so', G.upcoming.find((u) => u.id === 'u3').over === true);
  ok('a game with no price yet has no pick', G.upcoming.find((u) => u.id === 'u7').fav === null && G.upcoming.find((u) => u.id === 'u7').px === null);
  ok('the finals: the last thirty hours, newest first, by the team bet on, each keyed by its game\'s pair', G.finals.map((f) => f.id).join() === 'p-w1,p-l1'
    && G.finals[0].pick === 'Vikings' && G.finals[0].foe === 'Bears' && G.finals[1].pick === 'Magic' && G.finals[1].foe === 'Heat' && G.finals[1].pnl === -99, G.finals);
  ok('the record: every settled bet, the wins the prices expected (their prices added up), the money', G.record.bets === 3 && G.record.won === 2 && G.record.expected === 1.65 && G.record.pnl === 59 && G.record.staked === 289, G.record);
  ok('today\'s record is the games played today: one that settled at 1:30 AM was last night\'s', G.record.today.bets === 1 && G.record.today.won === 1 && G.record.today.pnl === 60, G.record.today);
  ok('and by league', G.record.leagues.NFL.won === 1 && G.record.leagues.NBA.bets === 1 && G.record.leagues.NBA.won === 0 && G.record.leagues.MLB.pnl === 98 && !G.record.leagues.Fed, G.record.leagues);
  ok('with the book\'s settings: on, an hour ahead, the cap, the stake, the leagues', G.on === true && G.aheadH === 1 && G.maxPx === 0.9 && G.stake === 100 && G.leaguesOn.join() === 'NFL,NCAAF,NBA,MLB', G);
  const off = pmFloor(E, { ...cfg, bets: false }, T).games;
  ok('switched off, the board says so and still lists the games', off.on === false && off.upcoming.length === 3);
  // audit 2026-10-17: the ledger keeps only its newest 2,000 closed legs; the record comes from the running tally
  const keep = s.closed;
  s.closed = s.closed.filter((c) => c.id !== 'o1');   // the oldest bet trimmed away
  const trimmed = pmFloor(E, cfg, T).games.record;
  ok('a bet trimmed from the closed legs stays in the record since the start, and its league', trimmed.bets === 3 && trimmed.won === 2 && trimmed.leagues.MLB && trimmed.leagues.MLB.pnl === 98, trimmed);
  s.closed = keep;
  ok('a bet carries its pair, so its tile and sheet follow the game from up next to the bet', pmFloor(E, cfg, T).books.find((b) => b.key === 'bets').rows[0].pairId === 'p-open' );
  E.pairs.push(pair('u9', 'KXNFLGAME', 'NFL Jets v Dolphins · Patriots', T + 2 * H, { pmMid: 0.6, ksMid: 0.6 }));
  ok('a label whose YES side names neither team gives no pick, not "not Patriots"', pmFloor(E, cfg, T).games.upcoming.find((u) => u.id === 'u9').fav === null);
  E.pairs.pop();
  // 1:30 AM ET Wednesday: a game that ended at 1:10 AM is Tuesday night's, and so is "today" until 4 AM
  const late = { ...leg({ id: 'n1', group: 'gn1', pairId: 'p-n1', label: 'NBA Suns v Jazz · Suns', side: 'yes', qty: 160, entry: 0.62, cost: 99, strategy: 'bet' }), exit: 0, exitAt: Date.parse('2026-09-30T05:10:00Z'), pnl: -99, reason: 'resolved NO' };
  s.closed.push(late);
  const night = pmFloor(E, cfg, Date.parse('2026-09-30T05:30:00Z')).games.record.today;
  ok('after midnight, today is still the evening before: the 1:10 AM final counts', night.bets === 2 && night.won === 1, night);
  s.closed.pop();
}

group('the engine keeps the bets\' tally as each settles, and backfills a ledger without one');
const tallyRun = (async () => {
  const { E } = engine({ bets: true });
  const s = E.state;
  ok('a new ledger starts with an empty tally', s.stats.bets && s.stats.bets.bets === 0);
  s.positions = [leg({ id: 'tb', group: 'gtb', pairId: 'p-tb', label: 'NFL Vikings v Bears · Vikings', venue: 'KS', side: 'yes', qty: 150, entry: 0.6, mark: 0.6, cost: 90, strategy: 'bet' })];
  s.cash = r2(s.cash - 90);
  await E.close(s.positions[0], 1, 'resolved YES', true);
  ok('a bet that settles is counted: won, its price expected, its stake and its money, by league', s.stats.bets.bets === 1 && s.stats.bets.won === 1 && s.stats.bets.expected === 0.6 && s.stats.bets.staked === 90 && s.stats.bets.pnl === 60 && s.stats.bets.leagues.NFL.won === 1, s.stats.bets);
  const back = betTally([{ strategy: 'bet', label: 'NBA Heat v Magic · Heat', entry: 0.55, cost: 99, pnl: -99 }, { strategy: 'arb', label: 'x', entry: 0.4, cost: 40, pnl: 5 }]);
  ok('the backfill counts the bets among the closed legs and nothing else', back.bets === 1 && back.won === 0 && back.leagues.NBA.pnl === -99, back);
})();

tallyRun.catch((e) => { fail++; console.log(`  FAIL  the tally run threw: ${e.stack || e.message}`); }).then(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});

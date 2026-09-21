'use strict';
// The maker's LOOP (src/makerdesk.js): what a round does to the ledger, in order. src/maker.js holds
// the pure decisions and tools/maker-test.js asserts them; this is the sequencing around them --
// what is withdrawn, what is settled, what is dropped, what is quoted one-sided -- which until
// 2026-09-21 could only be checked by running a desk against Kalshi and reading its journal.
// No network, no disk, no clock: everything the loop reaches for comes in through its `deps` seam.
//
//   node tools/makerdesk-test.js
const { makeMakerDesk, EMPTY_RETRY_MS, SCAN_EVERY_MS } = require('../src/makerdesk');
const ks = require('../src/venues/kalshi');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const r2 = (x) => Math.round(x * 100) / 100;

const T0 = Date.parse('2026-09-21T15:00:00Z');
// every tunable a test leans on is pinned here, so an env var on the machine cannot move a result
const cfg = (over = {}) => ({
  ...base, makerEnabled: true, makerStream: false, makerWiden: true, makerSeries: [], discoverEveryMin: 20,
  makerMarkets: 24, makerCap: 100, makerSoftCap: 0.5, makerParticipation: 0.10, makerMinSpread: 0.01,
  makerMinVol24: 5000, makerMinTradesPerDay: 10, makerMinDaysToClose: 7, makerRateProbe: 80,
  makerMinMid: 0.08, makerMaxMid: 0.92, makerEverySec: 2, makerTapePages: 5,
  makerMaxRunOver: 0.40, makerToxCooldownMin: 60, makerToxMinFills: 10, makerToxByContracts: false,
  makerMaxDrawdownPct: 0.10, gainLockTriggerPct: 0.10, gainLockGivebackPct: 0.35,
  initialBalance: 10000, ksFeeRate: 0.07, record: false, ...over,
});

// ---- the fakes --------------------------------------------------------------------------------
const book = (bid, bs, ask, as) => ({ yesBids: [{ price: bid, size: bs }], yesAsks: [{ price: ask, size: as }], noBids: [], noAsks: [] });
let printN = 0;
// a print as src/tape.js hands it over; `side` is the book side the TAKER hit, so 'ask' means someone
// sold into the bids (a resting bid at or above the price is filled) and 'bid' the reverse
const print = (ticker, p, n, side) => ({ ticker, trade_id: `p${++printN}`, yes_price_dollars: String(p), count_fp: String(n), taker_book_side: side, _t: T0 });
// a market as the any-market crawl lists it: quotable, fee-free, busy, months from closing
const listed = (ticker, over = {}) => ({ ticker, seriesTicker: 'KXTEST', yesBid: 0.44, yesAsk: 0.45, vol24: 9000, closeTime: '2027-03-01T00:00:00Z', yesBidSize: 100, yesAskSize: 100, title: `${ticker} title`, yesSubTitle: 'Yes', ...over });

// One desk with everything it touches faked. `at.now` is the clock; `tape.trades` is what the next
// round's poll returns (then emptied, as a real poll never returns a print twice).
function rig({ over = {}, markets = {}, crawl = [], state = {} } = {}) {
  const at = { now: T0 };
  const tape = {
    trades: [], bk: new Map(), mk: new Map(), asked: [], fresh: [], failed: 0, gap: false, broken: null,
    async since(tickers, opts = {}) {
      if (tape.broken) throw new Error(tape.broken);
      tape.asked.push([...tickers]); tape.fresh.push(!!opts.fresh);
      const want = new Set(tickers), out = tape.trades.filter((t) => want.has(t.ticker));
      tape.trades = [];
      return { trades: out, gap: tape.gap, gaps: 0 };
    },
    async books(tickers) {
      return { books: new Map([...tape.bk].filter(([k]) => tickers.includes(k))), markets: tape.mk, failed: tape.failed, at: at.now };
    },
    setStream() {}, stats: () => ({ gaps: 0, pages: 0, streamed: 0, polled: 0 }),
  };
  const calls = [];
  // the only call a wide-universe scan makes: each candidate's last 100 prints, here 20 in an hour
  const getJSON = async (url) => {
    calls.push(url);
    if (/\/markets\/trades\?ticker=/.test(url)) return { trades: Array.from({ length: 20 }, (_, i) => ({ created_time: new Date(T0 - i * 180000).toISOString(), count_fp: '10' })) };
    throw new Error(`unexpected call in a hermetic test: ${url}`);
  };
  const taped = [];
  const timers = {};
  const E = {
    state: { maker: { cash: 10000, equity: 10000, realized: 0, fills: 0, markets, ...state } },
    logs: [], journalled: [], touches: [], halt: false, operatorHalt: false, dirty: false,
    log: (agent, kind, pnl, text) => E.logs.push({ agent, kind, pnl, text }),
    journal: (_E, kind, payload) => E.journalled.push({ kind, ...payload }),
    touch: (agent, note) => E.touches.push(note),
    due: (name, sec) => { if (!timers[name] || at.now - timers[name] >= sec * 1000) { timers[name] = at.now; return true; } return false; },
  };
  const desk = makeMakerDesk(cfg(over), {
    tape, getJSON, clock: () => at.now, sleep: async () => {},
    recordTape: (_E, what) => taped.push(what),
    fetchBook: async (ticker) => { const b = tape.bk.get(ticker); if (!b) throw new Error('no book'); return b; },
  });
  desk.noteCrawl(E, crawl, () => 'quadratic');
  const round = async (ms = 2000) => { at.now += ms; await desk.step(E); };
  return { desk, E, S: E.state.maker, tape, at, calls, taped, round };
}
const held = (over = {}) => ({ series: 'KXTEST', inv: 0, cost: 0, realized: 0, fills: 0, quotes: { bid: null, ask: null }, seen: [], ...over });
const scans = (E) => E.logs.filter((l) => l.kind === 'SCAN' && /^(quoting|no market)/.test(l.text)).length;

(async () => {
  group('a restart is a cancel-and-repost: the first round withdraws the saved quotes');
  {
    // the ledger as a desk left it when it went down: a bid resting at 44c with nothing ahead of it
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXTEST-A': held({ quotes: { bid: 0.44, ask: 0.45 }, queue: { bid: 0, ask: 0 } }) } });
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.45, 100));
    const early = print('KXTEST-A', 0.44, 500, 'ask');
    r.tape.trades = [early];                       // 500 sold into the 44c bids while the desk was down
    await r.round();
    const m = r.S.markets['KXTEST-A'];
    ok('a print that arrives on the first round fills nothing: our bid was not resting', m.inv === 0 && r.S.cash === 10000 && !r.E.journalled.length, { inv: m.inv, cash: r.S.cash });
    ok('...and the quote is re-posted at the touch by the end of that round', m.quotes.bid === 0.44 && m.quotes.ask === 0.45, m.quotes);
    ok('...at the BACK of the queue: what it had worked down before the restart is gone', m.queue.bid === 100 && m.queue.ask === 100, m.queue);
    ok('the print is remembered, so a later poll returning it again cannot fill either', m.seen.includes(early.trade_id), m.seen);
    r.tape.trades = [print('KXTEST-A', 0.44, 500, 'ask')];
    await r.round();
    // 500 print, 100 ahead of us, a tenth of the rest: 40 bought at OUR 44c
    ok('the second round fills as usual: through the queue, then our share, at our price', m.inv === 40 && m.cost === 17.6 && r.S.cash === 9982.4 && r.S.fills === 1, { inv: m.inv, cost: m.cost, cash: r.S.cash });
    ok('...journalled as one MAKER_FILL with the inventory it left', r.E.journalled.length === 1 && r.E.journalled[0].kind === 'MAKER_FILL' && r.E.journalled[0].inv === 40 && r.E.journalled[0].runOver === false, r.E.journalled);
    ok('equity is cash plus the inventory at the mid', r.S.equity === r2(9982.4 + 40 * 0.445), r.S.equity);
    ok('the round hands the tape writer the books and prints it already fetched', r.taped.length === 2 && r.taped[1].books.has('KXTEST-A') && r.taped[1].trades.get('KXTEST-A').length === 1);
    ok('the tape is told the first poll has nothing to page back for, and the second that it has', r.tape.fresh.join() === 'true,false', r.tape.fresh);
    const snap = r.desk.snapshot(r.E).markets[0];
    ok('the dashboard row has the quote and the queue but not the dedupe list', snap.bid === 0.44 && snap.qBid === 0 && snap.quoting === true && !('seen' in snap), snap);
  }

  group('a saved quote whose book fails to load on the first round is still withdrawn');
  {
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXTEST-A': held({ quotes: { bid: 0.44, ask: 0.45 }, queue: { bid: 0, ask: 0 } }) } });
    await r.round();                                 // no book for it this round
    const m = r.S.markets['KXTEST-A'];
    ok('it does not go on resting in the ledger', m.quotes.bid === null && m.quotes.ask === null, m.quotes);
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.45, 100));
    r.tape.trades = [print('KXTEST-A', 0.44, 500, 'ask')];
    await r.round();
    ok('...so the next round\'s prints fill nothing against it', m.inv === 0 && r.S.cash === 10000 && m.quotes.bid === 0.44, { inv: m.inv, quotes: m.quotes });
  }

  group('an empty universe is retried every two minutes, not every round');
  {
    // nothing listed passes, and one market is still held from a universe that has rotated away
    const r = rig({ crawl: [], markets: { 'KXOLD-P': held({ series: 'KXOLD', inv: 30, cost: 12 }), 'KXOLD-S': held({ series: 'KXOLD', inv: -30, cost: -18 }) } });
    r.tape.bk.set('KXOLD-P', book(0.40, 50, 0.42, 50));
    r.tape.bk.set('KXOLD-S', book(0.60, 50, 0.62, 50));
    await r.round();
    ok('the first round scans, and says it waited on the scan', scans(r.E) === 1 && r.desk.blockedOnScan() === true, r.E.logs);
    for (let i = 0; i < 5; i++) await r.round();
    ok('five more rounds in the next ten seconds do not scan again', scans(r.E) === 1 && r.desk.blockedOnScan() === false, scans(r.E));
    const p = r.S.markets['KXOLD-P'], s = r.S.markets['KXOLD-S'];
    ok('...and the held markets are still worked in those rounds', r.tape.asked.length === 6 && r.tape.asked[5].includes('KXOLD-P') && r.tape.asked[5].includes('KXOLD-S'), r.tape.asked[5]);
    ok('a pinned long is offered and never bid: it can only get smaller', p.quotes.bid === null && p.quotes.ask === 0.42, p.quotes);
    ok('a pinned short is bid and never offered', s.quotes.bid === 0.60 && s.quotes.ask === null, s.quotes);
    r.tape.trades = [print('KXOLD-P', 0.42, 250, 'bid'), print('KXOLD-P', 0.40, 900, 'ask')];
    await r.round();
    // 250 lifted at 42c: 50 ahead, a tenth of 200 = 20 sold at 42c against a 40c basis
    ok('a pinned long sells into a lift, and a sweep of the bids adds nothing to it', p.inv === 10 && p.realized === 0.4 && r.S.realized === 0.4, { inv: p.inv, realized: p.realized });
    await r.round(EMPTY_RETRY_MS);
    ok('after EMPTY_RETRY_MS the scan runs again', scans(r.E) === 2 && r.desk.blockedOnScan() === true, scans(r.E));
    await r.round();
    ok('...once', scans(r.E) === 2);
  }

  group('a universe that has markets is re-picked in the background, every fifteen minutes');
  {
    const r = rig({ crawl: [listed('KXTEST-A'), listed('KXTEST-B')] });
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.45, 100)); r.tape.bk.set('KXTEST-B', book(0.30, 100, 0.32, 100));
    await r.round();
    ok('both listed markets are probed once and quoted', scans(r.E) === 1 && r.calls.length === 2 && r.desk.snapshot(r.E).quoting === 2, r.calls);
    await r.round(SCAN_EVERY_MS);
    ok('the re-scan does not block the round', r.desk.blockedOnScan() === false);
    await new Promise((res) => setImmediate(res));
    ok('...and the trade-rate probe is cached for an hour, so it costs no call', scans(r.E) === 2 && r.calls.length === 2, { scans: scans(r.E), calls: r.calls.length });
  }

  group('a finalized market settles at what the exchange paid');
  {
    const r = rig({ markets: {
      'KXDC-FAIR': held({ inv: 50, cost: 20, quotes: { bid: null, ask: 0.45 } }),   // a cancelled match: Kalshi pays a fair price
      'KXDC-YES': held({ inv: -40, cost: -16 }),                                      // short 40 at 40c, resolved YES
      'KXDC-NO': held({ inv: -40, cost: -16 }),                                       // short 40 at 40c, resolved NO
      'KXDC-WAIT': held({ inv: 10, cost: 5, mid: 0.5 }),                              // closed, not yet determined
    } });
    r.tape.mk.set('KXDC-FAIR', { status: 'finalized', result: '', settlementValue: 0.31 });
    r.tape.mk.set('KXDC-YES', { status: 'finalized', result: 'yes', settlementValue: 1 });
    r.tape.mk.set('KXDC-NO', { status: 'determined', result: 'no', settlementValue: 0 });
    r.tape.mk.set('KXDC-WAIT', { status: 'closed', result: '', settlementValue: null });
    await r.round();
    const M = r.S.markets;
    ok('a settlement value between 0 and 1 is paid as it stands: 50 x 31c against a $20 basis', M['KXDC-FAIR'].inv === 0 && M['KXDC-FAIR'].realized === -4.5 && M['KXDC-FAIR'].settledPx === 0.31, M['KXDC-FAIR']);
    ok('a short owes $1 a contract on YES and nothing on NO', M['KXDC-YES'].realized === -24 && M['KXDC-NO'].realized === 16, [M['KXDC-YES'].realized, M['KXDC-NO'].realized]);
    ok('cash moves by inventory times the settlement price: +15.50 -40 +0', r.S.cash === r2(10000 + 15.5 - 40), r.S.cash);
    ok('once every settled market is flat, realised equals the change in cash less the basis it retired', r.S.realized === r2(-4.5 - 24 + 16), r.S.realized);
    ok('the settled market stops quoting and is marked at its settlement, never at a 50c placeholder', M['KXDC-FAIR'].quotes.ask === null && M['KXDC-FAIR'].mid === 0.31, M['KXDC-FAIR']);
    ok('each is journalled with the quantity, basis and price that produced it', r.E.journalled.filter((j) => j.kind === 'MAKER_SETTLE').length === 3 && r.E.journalled[0].qty === 50 && r.E.journalled[0].cost === 20 && r.E.journalled[0].yesPx === 0.31, r.E.journalled);
    ok('a closed market with no result yet is held and keeps its last mark', M['KXDC-WAIT'].inv === 10 && M['KXDC-WAIT'].mid === 0.5 && M['KXDC-WAIT'].settledAt === undefined, M['KXDC-WAIT']);
    ok('said once, in one line', r.E.logs.filter((l) => l.kind === 'SETTLE').length === 1 && /settled 3 finalized markets, 130 contracts/.test(r.E.logs.find((l) => l.kind === 'SETTLE').text), r.E.logs);
    const before = r.S.cash;
    await r.round();
    ok('a settled market is not settled twice', r.S.cash === before && r.E.journalled.filter((j) => j.kind === 'MAKER_SETTLE').length === 3);
  }

  group('a market neither quoted nor held is dropped from the working set');
  {
    const ids = Array.from({ length: 400 }, (_, i) => `old${i}`);
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXGONE-Z': held({ quotes: { bid: 0.30, ask: 0.31 }, queue: { bid: 12, ask: 40 }, seen: ids, realized: 1.25, fills: 3 }) } });
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.45, 100)); r.tape.bk.set('KXGONE-Z', book(0.30, 10, 0.31, 10));
    r.tape.trades = [print('KXGONE-Z', 0.30, 500, 'ask')];
    await r.round(); await r.round();
    const z = r.S.markets['KXGONE-Z'];
    ok('it is not asked about', !r.tape.asked.some((a) => a.includes('KXGONE-Z')), r.tape.asked);
    ok('its last quote does not go on resting in the ledger, and nothing fills against it', z.quotes.bid === null && z.quotes.ask === null && z.inv === 0, z);
    ok('its 400 dedupe ids and its queue are let go', z.seen.length === 0 && !('queue' in z), { seen: z.seen.length, queue: z.queue });
    ok('what it made is kept', z.realized === 1.25 && z.fills === 3, z);
    ok('...and it is off the dashboard list, which carries quoted, held and recently filled markets only', !r.desk.snapshot(r.E).markets.some((m) => m.ticker === 'KXGONE-Z'));
  }

  group('the gain lock, per position (maker.gainLock through the loop)');
  {
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXTEST-A': held({ inv: 40, cost: 16 }) } });
    const m = r.S.markets['KXTEST-A'];
    r.tape.bk.set('KXTEST-A', book(0.59, 100, 0.61, 100));   // long 40 from 40c, marked at 60c: +$8
    await r.round();
    ok('a gain at its peak quotes both sides', m.gainPeak === 8 && m.gainSide === 1 && m.quotes.bid === 0.59 && m.quotes.ask === 0.61, m);
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.46, 100));   // marked at 45c: +$2, under the $2.40 floor (8 - 35% of 16)
    await r.round();
    ok('given back past the floor, the growing side is withdrawn and the reducing side stays', m.quotes.bid === null && m.quotes.ask === 0.46 && m.gainPeak === 8, m.quotes);
    m.inv = 0; m.cost = 0;                                     // the position closes...
    await r.round();
    ok('flat, the peak starts over and both sides are back', m.gainSide === 0 && m.gainPeak === 0 && m.quotes.bid === 0.44 && m.quotes.ask === 0.46, m);
    m.inv = 10; m.cost = 4.5;                                  // ...and a new one opens in the same market
    await r.round();
    ok('the next position is not locked by the last one\'s peak (49 of 128 markets were, 2026-09-21)', m.gainPeak === 0 && m.gainSide === 1 && m.quotes.bid === 0.44, { peak: m.gainPeak, quotes: m.quotes });
  }

  group('the run-over gate cools a market, and lets it back');
  {
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXTEST-A': held({ fills: 9, tox: Array(9).fill(5) }) } });   // nine fills, all run over
    const m = r.S.markets['KXTEST-A'];
    r.tape.bk.set('KXTEST-A', book(0.44, 0, 0.45, 0));
    await r.round();
    ok('nine fills is under the ten the gate needs: still quoted', m.quotes.bid === 0.44 && !m.cooledUntil, m);
    r.tape.trades = [print('KXTEST-A', 0.41, 100, 'ask')];   // sold through our 44c bid down to 41c
    r.tape.bk.set('KXTEST-A', book(0.40, 0, 0.42, 0));
    await r.round();
    const trippedAt = r.at.now;
    ok('the tenth is run over: bought 10 at 44c on a 41c print', m.inv === 10 && r.E.journalled.some((j) => j.kind === 'MAKER_FILL' && j.runOver === true && j.tradePx === 0.41), r.E.journalled);
    ok('the market is withdrawn from entirely, inventory and all, for the cooling period', m.quotes.bid === null && m.quotes.ask === null && m.cooledUntil === trippedAt + 60 * 60000, m);
    ok('the window starts over, so the same ten fills cannot re-trip it when it comes back', m.tox.length === 0, m.tox);
    ok('journalled and said once', r.E.journalled.filter((j) => j.kind === 'MAKER_COOL').length === 1 && r.E.logs.filter((l) => /cooled 60m/.test(l.text)).length === 1, r.E.logs);
    r.tape.trades = [print('KXTEST-A', 0.40, 500, 'ask'), print('KXTEST-A', 0.42, 500, 'bid')];
    await r.round();
    ok('prints during the cooldown fill nothing, and the board says why', m.inv === 10 && /^cooled until 16:00Z/.test(m.why) && r.E.logs.filter((l) => /cooled 60m/.test(l.text)).length === 1, { inv: m.inv, why: m.why });
    ok('the held inventory is still marked at the moving mid', Math.abs(m.mid - 0.41) < 1e-9 && r.S.equity === r2(r.S.cash + 10 * 0.41), { mid: m.mid, equity: r.S.equity });
    await r.round(60 * 60000);
    ok('after the hour it is quoted again', m.quotes.bid === 0.40 && m.quotes.ask === 0.42 && m.cooledUntil === 0, m);
  }

  group('halts and failures leave the ledger honest');
  {
    const r = rig({ crawl: [listed('KXTEST-A')], markets: { 'KXTEST-A': held({ inv: 20, cost: 8 }) } });
    const m = r.S.markets['KXTEST-A'];
    r.tape.bk.set('KXTEST-A', book(0.44, 100, 0.45, 100));
    await r.round();
    r.tape.broken = 'HTTP 503';
    await r.round();
    ok('a round with no market data leaves the quotes as they are and tells the tape it was blind', m.quotes.bid === 0.44 && r.taped[r.taped.length - 1].gap === 'data-failure' && r.E.logs.some((l) => /market data failed \(HTTP 503\)/.test(l.text)), r.taped[r.taped.length - 1]);
    r.tape.broken = null;
    r.E.operatorHalt = true;
    const asked = r.tape.asked.length;
    await r.round();
    ok('an operator halt withdraws every quote without asking the exchange anything', m.quotes.bid === null && m.quotes.ask === null && r.tape.asked.length === asked && r.taped[r.taped.length - 1].gap === 'halt', m.quotes);
    ok('...and holds the inventory', m.inv === 20);
    r.E.operatorHalt = false;
    const polls = r.tape.fresh.length;
    r.S.peak = 10000; r.S.equity = 8990;
    await r.round();
    ok('10.1% off the high-water mark halts the maker on its own rail', /drawdown 10\.1% from a peak of \$10000\.00/.test(r.S.halted || '') && r.E.journalled.some((j) => j.kind === 'MAKER_HALT') && m.quotes.bid === null, r.S.halted);
    r.desk.resume(r.E); r.S.equity = 10000;
    await r.round();
    await r.round();
    ok('the first poll after a halt has nothing to page back for either; the one after it does', r.tape.fresh.slice(polls).join() === 'true,false', r.tape.fresh.slice(polls));
    ok('resumed, it quotes again', r.S.halted === null && m.quotes.bid === 0.44 && m.quotes.ask === 0.45, m.quotes);
  }

  group('flatten crosses the spread, pays the taker fee, and books what the position made');
  {
    const r = rig({ markets: { 'KXTEST-L': held({ inv: 50, cost: 20, quotes: { bid: 0.49, ask: 0.51 } }), 'KXTEST-S': held({ inv: -20, cost: -12, mid: 0.55 }), 'KXTEST-F': held({ quotes: { bid: 0.2, ask: 0.21 } }) } });
    r.tape.bk.set('KXTEST-L', book(0.50, 500, 0.52, 500));   // the short has no book: it goes at its last mark
    const out = await r.desk.flatten(r.E, 'test');
    const feeL = ks.fee(50, 0.50, 0.07, 'KXTEST-L'), feeS = ks.fee(20, 0.55, 0.07, 'KXTEST-S');
    const M = r.S.markets;
    ok('both positions are closed and every quote is withdrawn', out.markets === 2 && out.contracts === 70 && M['KXTEST-L'].inv === 0 && M['KXTEST-S'].inv === 0 && M['KXTEST-F'].quotes.bid === null, out);
    ok('the long sells at the bid, not the mid, less the fee', M['KXTEST-L'].realized === r2(50 * 0.10 - feeL), M['KXTEST-L'].realized);
    ok('a book that cannot be read falls back to the last mark', M['KXTEST-S'].realized === r2(20 * 0.05 - feeS), M['KXTEST-S'].realized);
    ok('flat, realised equals the change in cash less the basis retired', r2(r.S.cash - 10000) === r2(50 * 0.50 - feeL - 20 * 0.55 - feeS) && r.S.realized === r2(M['KXTEST-L'].realized + M['KXTEST-S'].realized), { cash: r.S.cash, realized: r.S.realized });
    ok('the desk stays halted until a person resumes it', /flattened by operator \(test\)/.test(r.S.halted) && r.E.journalled.filter((j) => j.kind === 'MAKER_FLATTEN').length === 2, r.S.halted);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`  FAIL  the suite threw: ${e.stack}`); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });

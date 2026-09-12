'use strict';
// Assertions for the MAKER desk's pure core (src/maker.js): where it rests quotes, which trades
// fill them, and what a fill does to the money.
//
// This desk is the only code in the repo that has ever traded. The taker book has taken zero
// positions in its life; every fill on the journal -- all 94 of them -- is a MAKER_FILL. It ran
// untested. That ordering was backwards, and this file is the correction.
//
//   node tools/maker-test.js
const maker = require('../src/maker');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const cfg = (over = {}) => ({ ...base, ...over });
const book = (bid, ask, bidSize = 5000, askSize = 5000) => ({
  yesBids: bid == null ? [] : [{ price: bid, size: bidSize }],
  yesAsks: ask == null ? [] : [{ price: ask, size: askSize }],
});

// ---------------------------------------------------------------- desiredQuotes
group('desiredQuotes rests at the touch, or explains why it will not');
{
  const q = maker.desiredQuotes(book(0.44, 0.45), 0, cfg());
  ok('joins the touch on both sides', q.bid === 0.44 && q.ask === 0.45, q);
  ok('reports the spread and mid it used', q.spread !== undefined && Math.abs(q.mid - 0.445) < 1e-9, q);

  // Quoting INSIDE the touch hands the spread back; quoting outside never fills. There is nowhere
  // else to be, which is why inventory is managed by withdrawal rather than by skew.
  ok('a one-sided book is refused by name', maker.desiredQuotes(book(0.44, null), 0, cfg()).why === 'one-sided book');
  ok('an empty book is refused by name', maker.desiredQuotes(book(null, null), 0, cfg()).why === 'one-sided book');
  ok('a crossed book is refused', maker.desiredQuotes(book(0.50, 0.45), 0, cfg()).why === 'one-sided book');
  ok('a locked book (ask == bid) is refused', maker.desiredQuotes(book(0.45, 0.45), 0, cfg()).why === 'one-sided book');

  const tight = maker.desiredQuotes(book(0.440, 0.445), 0, cfg({ makerMinSpread: 0.01 }));
  ok('a sub-minimum spread is refused', tight.bid === null && /spread/.test(tight.why), tight);
  ok('...and says both numbers', /0\.5c/.test(tight.why) && /1\.0c/.test(tight.why), tight.why);

  // Inventory held into resolution is a coin flip, and the tails are where a one-tick spread is
  // worth least against the risk.
  ok('below makerMinMid is refused', maker.desiredQuotes(book(0.04, 0.05), 0, cfg()).why === 'price in the tails');
  ok('above makerMaxMid is refused', maker.desiredQuotes(book(0.95, 0.96), 0, cfg()).why === 'price in the tails');
}

group('a book we will not QUOTE is still a book we can MARK');
{
  // makerdesk carries the last mid forward (`m.mid = q.mid ?? m.mid`) and marks inventory with it.
  // A refusal that returns no mid therefore freezes the mark on a position the desk still holds --
  // and the tails are exactly where a position is on its way to resolving at 0 or 1.
  const tails = maker.desiredQuotes(book(0.95, 0.96), 0, cfg());
  ok('the tails refuse to quote', tails.bid === null && tails.ask === null, tails);
  ok('...but still report a mid to mark against', Math.abs(tails.mid - 0.955) < 1e-9, tails);

  const tight = maker.desiredQuotes(book(0.440, 0.445), 0, cfg({ makerMinSpread: 0.01 }));
  ok('a too-narrow spread refuses to quote', tight.bid === null, tight);
  ok('...but still reports a mid', Math.abs(tight.mid - 0.4425) < 1e-9, tight);
  ok('...and the spread it measured', Math.abs(tight.spread - 0.005) < 1e-9, tight);

  // a genuinely one-sided book has no two-sided mid, and inventing one would be worse
  ok('a one-sided book reports no mid', maker.desiredQuotes(book(0.44, null), 0, cfg()).mid === undefined);
}

group('the inventory cap withdraws a side rather than skewing price');
{
  const c = cfg({ makerCap: 100 });
  const atLongCap = maker.desiredQuotes(book(0.44, 0.45), 100, c);
  ok('long at the cap stops bidding', atLongCap.bid === null, atLongCap);
  ok('...but keeps offering, so it can get flat', atLongCap.ask === 0.45, atLongCap);

  const atShortCap = maker.desiredQuotes(book(0.44, 0.45), -100, c);
  ok('short at the cap stops offering', atShortCap.ask === null, atShortCap);
  ok('...but keeps bidding', atShortCap.bid === 0.44, atShortCap);

  const inside = maker.desiredQuotes(book(0.44, 0.45), 99, c);
  ok('one contract inside the cap still quotes both sides', inside.bid === 0.44 && inside.ask === 0.45, inside);
}

group('inventory in the tails is worked off, not stranded');
{
  // The refusal for `price in the tails` ran BEFORE makerdesk's reduce-only logic, and returned
  // null on both sides, so a market with inventory whose mid drifted out of band could never be
  // closed: the cloud desk sat short 38 at a 91c mid with both quotes withdrawn, marking a $10
  // loss it had no way out of. The reducing side must survive the refusal.
  const shortInTail = maker.desiredQuotes(book(0.93, 0.94), -38, cfg({ makerMaxMid: 0.92 }));
  ok('short 38 at a 93c mid keeps its bid', shortInTail.bid === 0.93, shortInTail);
  ok('...and does not offer, which would grow the short', shortInTail.ask === null, shortInTail);
  ok('...and says why', /tails/.test(shortInTail.why) && /reducing/.test(shortInTail.why), shortInTail.why);

  const longInTail = maker.desiredQuotes(book(0.04, 0.05), 25, cfg({ makerMinMid: 0.08 }));
  ok('long 25 at a 4.5c mid keeps its offer', longInTail.ask === 0.05, longInTail);
  ok('...and does not bid', longInTail.bid === null, longInTail);

  // no inventory, no reason to be in a tail at all -- unchanged
  const flatInTail = maker.desiredQuotes(book(0.93, 0.94), 0, cfg({ makerMaxMid: 0.92 }));
  ok('flat in the tails still quotes nothing', flatInTail.bid === null && flatInTail.ask === null, flatInTail);
  ok('...under the plain reason', flatInTail.why === 'price in the tails', flatInTail.why);

  // the mid is still reported, so the mark keeps moving while the position is worked off
  ok('the reducing quote still reports a mid', Math.abs(shortInTail.mid - 0.935) < 1e-9, shortInTail);
}

// ---------------------------------------------------------------- fillsFrom
const trade = (id, side, px, n, extra = {}) => ({ trade_id: id, taker_book_side: side, yes_price_dollars: String(px), count_fp: String(n), ...extra });
const QUOTES = { bid: 0.44, ask: 0.45 };
const noQueue = { bid: 0, ask: 0 };

group('fillsFrom maps taker side to our side correctly');
{
  const c = cfg({ makerParticipation: 0.10, makerCap: 100 });
  // taker_book_side 'bid' means the taker was bidding -- lifting our ask. We SELL.
  const sell = maker.fillsFrom([trade('t1', 'bid', 0.45, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('a taker on the bid lifts our ask, so we sell', sell.fills.length === 1 && sell.fills[0].side === 'sell', sell.fills);
  ok('at OUR price, not the trade price', sell.fills[0].px === 0.45, sell.fills[0]);

  const buy = maker.fillsFrom([trade('t2', 'ask', 0.44, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('a taker on the ask hits our bid, so we buy', buy.fills.length === 1 && buy.fills[0].side === 'buy', buy.fills);
  ok('at our bid', buy.fills[0].px === 0.44, buy.fills[0]);

  // no lookahead: a trade that does not reach our resting price cannot fill it
  const away = maker.fillsFrom([trade('t3', 'bid', 0.44, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('a trade below our ask does not fill our ask', away.fills.length === 0, away.fills);
}

group('the queue ahead of us fills first -- the correction that cut the backtest 90%');
{
  const c = cfg({ makerParticipation: 0.10, makerCap: 100 });
  // 1000 contracts resting ahead of us; a 1000-lot taker clears exactly them and never reaches us.
  const blocked = maker.fillsFrom([trade('q1', 'bid', 0.45, 1000)], QUOTES, 0, c, new Set(), { bid: 0, ask: 1000 });
  ok('a taker that only clears the queue does not fill us', blocked.fills.length === 0, blocked.fills);
  ok('but the queue it ate is gone', blocked.queue.ask === 0, blocked.queue);

  // ...and the NEXT taker, arriving against the now-empty queue, does reach us
  const through = maker.fillsFrom([trade('q2', 'bid', 0.45, 1000)], QUOTES, 0, c, new Set(), blocked.queue);
  ok('the next taker reaches us once the queue is clear', through.fills.length === 1, through.fills);
  ok('and we take our participation share of it', through.fills[0].qty === Math.floor(1000 * 0.10), through.fills[0]);

  // partial: 600 ahead, 1000-lot taker -> 400 left for the pool, we get 10% of that
  const partial = maker.fillsFrom([trade('q3', 'bid', 0.45, 1000)], QUOTES, 0, c, new Set(), { bid: 0, ask: 600 });
  ok('a partly-cleared queue leaves the remainder to the pool', partial.fills[0].qty === Math.floor(400 * 0.10), partial.fills[0]);
  ok('and reports the queue it has left', partial.queue.ask === 0, partial.queue);

  // the queue is consumed even when our own share rounds away to nothing
  const crumbs = maker.fillsFrom([trade('q4', 'bid', 0.45, 105)], QUOTES, 0, c, new Set(), { bid: 0, ask: 100 });
  ok('a sub-1-contract share is not a fill', crumbs.fills.length === 0, crumbs.fills);
  ok('...but the queue still moved', crumbs.queue.ask === 0, crumbs.queue);
}

group('trades are counted once, and block trades never');
{
  const c = cfg({ makerParticipation: 0.10, makerCap: 100 });
  // The tape deliberately OVERLAPS -- a 1000-print page covers ~6s and it is polled every 2s -- so
  // de-duplication is load-bearing, not hygiene. Without it every fill is counted about three times.
  const seen = new Set(['dup']);
  const r = maker.fillsFrom([trade('dup', 'bid', 0.45, 500)], QUOTES, 0, c, seen, noQueue);
  ok('a trade already seen is skipped', r.fills.length === 0, r.fills);

  const blk = maker.fillsFrom([trade('b1', 'bid', 0.45, 500, { is_block_trade: true })], QUOTES, 0, c, new Set(), noQueue);
  ok('a block trade never fills a resting quote', blk.fills.length === 0, blk.fills);

  // a trade id repeated WITHIN one batch must not fill twice either
  const twice = maker.fillsFrom([trade('same', 'bid', 0.45, 500), trade('same', 'bid', 0.45, 500)], QUOTES, 0, c, new Set(), noQueue);
  ok('a duplicate inside one batch fills once', twice.fills.length === 1, twice.fills);

  const junk = maker.fillsFrom([
    trade('j1', 'bid', 'not-a-price', 500),
    trade('j2', 'bid', 0.45, 0),
    trade('j3', 'bid', 0.45, -5),
  ], QUOTES, 0, c, new Set(), noQueue);
  ok('unparseable or non-positive trades are ignored', junk.fills.length === 0, junk.fills);
}

group('the position cap is enforced per fill, and adverse fills are flagged');
{
  const c = cfg({ makerParticipation: 1.0, makerCap: 100 });
  const atCap = maker.fillsFrom([trade('c1', 'bid', 0.45, 50)], QUOTES, -100, c, new Set(), noQueue);
  ok('already short the cap, a further sell is refused', atCap.fills.length === 0, atCap.fills);
  const atCapBuy = maker.fillsFrom([trade('c2', 'ask', 0.44, 50)], QUOTES, 100, c, new Set(), noQueue);
  ok('already long the cap, a further buy is refused', atCapBuy.fills.length === 0, atCapBuy.fills);
  const upTo = maker.fillsFrom([trade('c3', 'bid', 0.45, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('a fill that lands exactly ON the cap is allowed', upTo.fills.length === 1 && upTo.fills[0].qty === 100, upTo.fills);

  // runOver is the adverse-selection marker: the market traded THROUGH our stale quote, so we sold
  // below where it printed. 69% of live fills were run over against 5% in the backtest.
  const over = maker.fillsFrom([trade('r1', 'bid', 0.60, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('selling into a print above our ask is flagged run-over', over.fills[0].runOver === true, over.fills[0]);
  const clean = maker.fillsFrom([trade('r2', 'bid', 0.45, 100)], QUOTES, 0, c, new Set(), noQueue);
  ok('a print AT our ask is not run-over', clean.fills[0].runOver === false, clean.fills[0]);
}

// ---------------------------------------------------------------- applyFill
group('applyFill: once flat, realised MUST equal the change in cash');
{
  // This is the whole invariant. Cash is not profit -- it falls when we buy and rises when we sell,
  // so a short book shows positive cash that is only proceeds on contracts still owed. But when the
  // position returns to FLAT there is nothing owed, and the two numbers have to meet. Anywhere they
  // do not, the cost basis is lying.
  const roundTrip = (fills) => {
    let pos = { inv: 0, cost: 0, realized: 0 }, cash = 0;
    for (const f of fills) { const r = maker.applyFill(pos, f); cash = Math.round((cash + r.cashDelta) * 100) / 100; pos = { inv: r.inv, cost: r.cost, realized: r.realized }; }
    return { pos, cash };
  };
  const CASES = [
    ['a full close', [{ side: 'buy', qty: 10, px: 0.40 }, { side: 'sell', qty: 10, px: 0.50 }]],
    ['a PARTIAL close', [{ side: 'buy', qty: 20, px: 0.40 }, { side: 'sell', qty: 10, px: 0.50 }, { side: 'sell', qty: 10, px: 0.50 }]],
    ['a fill that flips long to short', [{ side: 'buy', qty: 10, px: 0.40 }, { side: 'sell', qty: 25, px: 0.50 }, { side: 'buy', qty: 15, px: 0.50 }]],
    ['a fill that flips short to long', [{ side: 'sell', qty: 10, px: 0.60 }, { side: 'buy', qty: 30, px: 0.50 }, { side: 'sell', qty: 20, px: 0.50 }]],
    ['ragged partials both ways', [{ side: 'buy', qty: 30, px: 0.30 }, { side: 'sell', qty: 7, px: 0.44 }, { side: 'buy', qty: 5, px: 0.31 }, { side: 'sell', qty: 28, px: 0.42 }]],
    ['plain spread capture, three times', [{ side: 'buy', qty: 10, px: 0.40 }, { side: 'sell', qty: 10, px: 0.41 }, { side: 'buy', qty: 10, px: 0.40 }, { side: 'sell', qty: 10, px: 0.41 }, { side: 'buy', qty: 10, px: 0.40 }, { side: 'sell', qty: 10, px: 0.41 }]],
  ];
  for (const [name, fills] of CASES) {
    const { pos, cash } = roundTrip(fills);
    ok(`${name} ends flat`, pos.inv === 0, pos);
    ok(`${name}: realised equals cash`, Math.abs(pos.realized - cash) < 0.005, { realized: pos.realized, cash });
  }
}

group('applyFill: the basis left behind is a real price');
{
  // The regression itself. Buy 20 @ 40c, sell 10 @ 50c: ten contracts are still held, and they were
  // bought at 40c. Moving `cost` by cash flow left $3.00 against them -- an implied average of 30c,
  // a price this position never traded at -- and every later close measured its profit from there.
  const a = maker.applyFill({ inv: 0, cost: 0, realized: 0 }, { side: 'buy', qty: 20, px: 0.40 });
  ok('opening 20 @ 40c costs $8.00', a.cost === 8, a);
  ok('and realises nothing', a.pnl === 0, a);

  const b = maker.applyFill(a, { side: 'sell', qty: 10, px: 0.50 });
  ok('closing half realises 10 x 10c = $1.00', Math.abs(b.pnl - 1) < 0.005, b);
  ok('and leaves the OTHER half at its own basis, $4.00', Math.abs(b.cost - 4) < 0.005, b);
  ok('so the implied average is still 40c, not 30c', Math.abs(Math.abs(b.cost / b.inv) - 0.40) < 1e-6, { avg: Math.abs(b.cost / b.inv) });

  // and the flip: the opening remainder enters at the price it actually traded at
  const c1 = maker.applyFill({ inv: 10, cost: 4, realized: 0 }, { side: 'sell', qty: 25, px: 0.50 });
  ok('a flip through zero leaves a short of 15', c1.inv === -15, c1);
  ok('...booked at the fill price, 50c', Math.abs(Math.abs(c1.cost / c1.inv) - 0.50) < 1e-6, { avg: Math.abs(c1.cost / c1.inv) });
  ok('...realising only the part that closed', Math.abs(c1.pnl - 1) < 0.005, c1);

  const flat = maker.applyFill({ inv: 10, cost: 4, realized: 0 }, { side: 'sell', qty: 10, px: 0.50 });
  ok('going flat carries no basis forward', flat.inv === 0 && flat.cost === 0, flat);
}

group('applyFill: same-direction fills never realise anything');
{
  const a = maker.applyFill({ inv: 10, cost: 4, realized: 0 }, { side: 'buy', qty: 10, px: 0.50 });
  ok('adding to a long realises nothing', a.pnl === 0, a);
  ok('and averages the basis', Math.abs(Math.abs(a.cost / a.inv) - 0.45) < 1e-6, { avg: Math.abs(a.cost / a.inv) });
  const s = maker.applyFill({ inv: -10, cost: -6, realized: 0 }, { side: 'sell', qty: 10, px: 0.50 });
  ok('adding to a short realises nothing', s.pnl === 0, s);
  ok('and averages the short basis', Math.abs(Math.abs(s.cost / s.inv) - 0.55) < 1e-6, { avg: Math.abs(s.cost / s.inv) });
  const f = maker.applyFill({ inv: 0, cost: 0, realized: 0 }, { side: 'sell', qty: 10, px: 0.50 });
  ok('opening from flat realises nothing', f.pnl === 0 && f.inv === -10, f);
}

group('the flatten path realises what it closes');
{
  // makerdesk.flatten() used to move cash and then zero `inv` and `cost` without booking a cent of
  // realised profit, so a desk flattened at a gain reported none. It now closes through applyFill
  // and takes the crossing fee off with it, which keeps the same invariant: from a standing start,
  // realised must equal total cash once the book is flat.
  const flat = (pos, cashSoFar, px, fee) => {
    const res = maker.applyFill(pos, { side: pos.inv > 0 ? 'sell' : 'buy', qty: Math.abs(pos.inv), px });
    return { inv: res.inv, cost: res.cost, realized: r2(res.realized - fee), cash: r2(cashSoFar + res.cashDelta - fee) };
  };
  const r2 = (x) => Math.round(x * 100) / 100;

  // bought 100 @ 40c (cash -$40), flattened at 50c with a $1.75 taker fee
  const long = flat({ inv: 100, cost: 40, realized: 0 }, -40, 0.50, 1.75);
  ok('flattening leaves the book flat', long.inv === 0 && long.cost === 0, long);
  ok('and realises the gain net of the crossing fee', Math.abs(long.realized - 8.25) < 0.005, long);
  ok('and realised still equals total cash', Math.abs(long.realized - long.cash) < 0.005, long);

  // sold 100 @ 60c (cash +$60), bought back at 50c
  const short = flat({ inv: -100, cost: -60, realized: 0 }, 60, 0.50, 1.75);
  ok('a short flattens to flat', short.inv === 0, short);
  ok('...realising the gain net of fee', Math.abs(short.realized - 8.25) < 0.005, short);
  ok('...and still agreeing with cash', Math.abs(short.realized - short.cash) < 0.005, short);

  // a LOSS must be booked too, not silently dropped
  const loss = flat({ inv: 100, cost: 60, realized: 0 }, -60, 0.50, 1.75);
  ok('a losing flatten books a loss', loss.realized < 0, loss);
  ok('...that agrees with cash', Math.abs(loss.realized - loss.cash) < 0.005, loss);
}

group('the run-over gate cools a market whose touch keeps getting swept');
{
  // 43% of live fills were run over -- the tape traded through the quote -- and that is where the
  // maker's money went. Latency was not the cause (2s requotes moved it from 69% to 59%), so the
  // gate names the markets that are worse than the book as a whole and stops resting there.
  const c = cfg({ makerMaxRunOver: 0.40, makerToxCooldownMin: 60, makerToxMinFills: 10 });
  const ro = { runOver: true }, clean = { runOver: false };
  const fillsOf = (...seq) => seq.reduce((tox, f) => maker.toxWindow(tox, f), []);

  let tox = fillsOf(...Array(9).fill(ro));
  let g = maker.toxicGate({ tox }, c, 1000);
  ok('nine run-over fills are too few to judge', g.cooled === false, g);
  tox = maker.toxWindow(tox, ro);
  g = maker.toxicGate({ tox }, c, 1000);
  ok('the tenth trips the gate', g.cooled === true && g.tripped === true, g);
  ok('...for the configured cooldown', g.cooledUntil === 1000 + 60 * 60000, g);
  ok('...and resets the window, so the same fills cannot trip it again', g.tox.length === 0, g);

  const cooled = { tox: g.tox, cooledUntil: g.cooledUntil };
  const during = maker.toxicGate(cooled, c, 1000 + 30 * 60000);
  ok('halfway through it is still cooled, and not re-tripped', during.cooled === true && during.tripped === false, during);
  const after = maker.toxicGate(cooled, c, 1000 + 60 * 60000);
  ok('quotes come back when the cooldown ends', after.cooled === false, after);

  tox = fillsOf(...Array(4).fill(ro), ...Array(6).fill(clean));
  g = maker.toxicGate({ tox }, c, 0);
  ok('a share AT the bar (4 of 10) does not trip', g.cooled === false && Math.abs(g.rate - 0.4) < 1e-9, g);
  ok('one more run-over does', maker.toxicGate({ tox: maker.toxWindow(tox, ro) }, c, 0).tripped === true);

  tox = fillsOf(...Array(30).fill(ro), ...Array(30).fill(clean));
  ok('the window forgets fills older than the last 30', tox.length === 30 && maker.toxicGate({ tox }, c, 0).rate === 0, tox);

  // the live book as a whole: 13 of 30 fills run over
  tox = fillsOf(...Array(13).fill(ro), ...Array(17).fill(clean));
  ok('the live book-wide share (43%) would have been cooled', maker.toxicGate({ tox }, c, 0).tripped === true);
  ok('a market with no fills is never cooled', maker.toxicGate({}, c, 0).cooled === false);
  ok('the gate can be switched off by raising the bar to 1', maker.toxicGate({ tox: fillsOf(...Array(30).fill(ro)) }, cfg({ makerMaxRunOver: 1 }), 0).cooled === false);
}

group('the drawdown rail measures from the peak, not from the opening balance');
{
  const I = 10000;
  const flat = maker.drawdownFrom(I, null, I);
  ok('a fresh book has no drawdown', flat.dd === 0 && flat.peak === I, flat);

  const up = maker.drawdownFrom(10500, I, I);
  ok('profit raises the high-water mark', up.peak === 10500, up);
  ok('...and is not itself a drawdown', up.dd === 0, up);

  // the case a from-inception rail cannot see: $1,450 given back off a $10,500 peak
  const gaveBack = maker.drawdownFrom(9050, 10500, I);
  ok('giving back profit IS a drawdown', Math.abs(gaveBack.dd - (10500 - 9050) / 10500) < 1e-9, gaveBack);
  ok('...and trips a 10% limit', gaveBack.dd >= 0.10, gaveBack.dd);
  ok('where the old from-inception test read under 10%', (I - 9050) / I < 0.10, (I - 9050) / I);

  // and on a desk that never profited the two tests agree exactly, so this only ever halts earlier
  const neverUp = maker.drawdownFrom(9050, I, I);
  ok('a never-profitable book measures the same either way', Math.abs(neverUp.dd - (I - 9050) / I) < 1e-9, neverUp);

  ok('the peak never ratchets down', maker.drawdownFrom(8000, 10500, I).peak === 10500);
  ok('a missing equity reads as no drawdown', maker.drawdownFrom(undefined, null, I).dd === 0);
}

group('applyFill: cash moves in the direction it should');
{
  const b = maker.applyFill({ inv: 0, cost: 0, realized: 0 }, { side: 'buy', qty: 10, px: 0.40 });
  ok('buying costs cash', b.cashDelta === -4, b);
  const s = maker.applyFill({ inv: 0, cost: 0, realized: 0 }, { side: 'sell', qty: 10, px: 0.40 });
  ok('selling raises cash', s.cashDelta === 4, s);
}

// ---------------------------------------------------------------- tape pagination
group('the tape poller pages back until it overlaps what it already returned');
{
  // src/tape.js since() read ONE page of 1000 exchange-wide prints per poll. When the exchange
  // traded more than a page between polls, the oldest print on the page was newer than the newest
  // already seen, and everything in between was lost -- counted as a gap (145 times in two days on
  // the cloud box) and then forgotten. Every one of those was a window in which a resting quote
  // could have filled unseen. The endpoint pages by cursor, so the poll now follows it.
  const http = require('../src/http');
  const { makeTape } = require('../src/tape');
  const T = (id, secs, ticker = 'A') => ({ trade_id: id, ticker, created_time: new Date(1000000000000 + secs * 1000).toISOString(), yes_price_dollars: '0.50', count_fp: '1', taker_book_side: 'bid' });
  // serve pages keyed by cursor; each page is newest-first, as the exchange returns them
  const serve = (pages) => {
    const calls = [];
    http.getJSON = async (url) => {
      calls.push(url);
      const m = url.match(/cursor=([^&]+)/);
      const key = m ? m[1] : 'first';
      const p = pages[key];
      if (!p) throw new Error(`no page for cursor ${key}`);
      return { trades: p.trades, cursor: p.next || '' };
    };
    return calls;
  };
  const real = http.getJSON;
  const run = async () => {
    // poll 1: prints at t=10..12, nothing seen yet -> one page, no cursor followed
    let tape = makeTape({ maxPages: 5 });
    let calls = serve({ first: { trades: [T('c', 12), T('b', 11), T('a', 10, 'Z')], next: 'p2' } });
    let r = await tape.since(['A']);
    ok('the first poll reads one page', calls.length === 1, calls);
    ok('...returns only the wanted tickers, oldest first', r.trades.map((t) => t.trade_id).join() === 'b,c', r.trades);
    ok('...and is not a gap', r.gap === false, r);

    // poll 2: the page reaches back past t=12 -> overlap, one request, only the new prints
    calls = serve({ first: { trades: [T('e', 14), T('d', 13), T('c', 12), T('b', 11)], next: 'p2' } });
    r = await tape.since(['A']);
    ok('an overlapping page needs no second request', calls.length === 1, calls);
    ok('...and returns only prints newer than the last poll', r.trades.map((t) => t.trade_id).join() === 'd,e', r.trades);
    ok('...with no gap', r.gap === false, r);

    // poll 3: the first page is ALL newer than t=14 -> follow the cursor; page 2 overlaps
    calls = serve({
      first: { trades: [T('h', 17), T('g', 16)], next: 'p2' },
      p2: { trades: [T('f', 15), T('e', 14), T('d', 13)], next: 'p3' },
      p3: { trades: [T('c', 12)], next: '' },
    });
    r = await tape.since(['A']);
    ok('a page with nothing already seen on it is followed by its cursor', calls.length === 2 && /cursor=p2/.test(calls[1]), calls);
    ok('...and stops at the first page that overlaps', !calls.some((u) => /cursor=p3/.test(u)), calls);
    ok('...returning both pages, oldest first', r.trades.map((t) => t.trade_id).join() === 'f,g,h', r.trades);
    ok('...which was not a gap: nothing was missed', r.gap === false && r.gaps === 0, r);

    // a print repeated across two pages is returned once
    calls = serve({
      first: { trades: [T('k', 20), T('j', 19)], next: 'p2' },
      p2: { trades: [T('j', 19), T('i', 18), T('h', 17)], next: '' },
    });
    r = await tape.since(['A']);
    ok('a print on two pages is returned once', r.trades.map((t) => t.trade_id).join() === 'i,j,k', r.trades);

    // the cap: five pages and still nothing already seen -> that IS a gap, and the only kind left
    const deep = { first: { trades: [T('z1', 100)], next: 'q1' } };
    for (let i = 1; i <= 6; i++) deep[`q${i}`] = { trades: [T(`z${i + 1}`, 100 - i)], next: `q${i + 1}` };
    calls = serve(deep);
    r = await tape.since(['A']);
    ok('the poll stops at maxPages', calls.length === 5, calls.length);
    ok('...and only then counts a gap', r.gap === true && r.gaps === 1, r);
    ok('...still returning everything it did read', r.trades.length === 5, r.trades.length);
    ok('stats() reports the gap and the pages read', tape.stats().gaps === 1 && tape.stats().pages === 11, tape.stats());

    // a non-overlapping page with no cursor is the end of the tape, not a gap
    tape = makeTape({ maxPages: 5 });
    serve({ first: { trades: [T('a', 10)], next: '' } });
    await tape.since(['A']);
    calls = serve({ first: { trades: [T('b', 11)], next: '' } });
    r = await tape.since(['A']);
    ok('no cursor means no older page to read, and no gap', calls.length === 1 && r.gap === false, r);

    // an empty tape is not a gap either
    serve({ first: { trades: [], next: '' } });
    r = await tape.since(['A']);
    ok('an empty page returns nothing and no gap', r.trades.length === 0 && r.gap === false, r);
  };
  const done = run().catch((e) => { fail++; console.log(`  FAIL  tape pagination threw: ${e.message}`); }).finally(() => { http.getJSON = real; });
  // the suite is otherwise synchronous; hold the summary until this group has run
  done.then(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });
}

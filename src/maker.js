'use strict';
// MAKER desk — the seventh seat.
//
// Everything else in this project TAKES liquidity: buy the ask, sell the bid, pay a taker fee both
// ways. That is roughly a 4c round trip, and seven days of measurement said the venues disagree by
// about half a cent. No amount of searching finds a 4c mispricing in a market quoted one tick wide.
//
// This desk does the opposite. It RESTS orders and is paid the spread instead of paying it, on the
// 13,774 of Kalshi's 13,951 series whose fee_type is plain `quadratic` and therefore charge makers
// nothing. Simulated over ~68 days of real trade tape across 34 such markets, with lookahead bias
// removed and queue position modelled, it returned +$2,187 on ~$1,350 of peak capital, positive in
// 27 of 34 markets and positive in every robustness configuration tried. The same code on game
// markets that DO charge makers returns +$94 against +$354 at zero fee -- the fee is ~73% of the
// profit, which is why series selection here is a hard filter and not a preference.
//
// What the simulation could not model, and what paper trading is for: our own size changing other
// people's behaviour, and Kalshi's real queue at our price level.
const ks = require('./venues/kalshi');
const http = require('./http');

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const c = (x) => `${(x * 100).toFixed(1)}c`;

// ---------------------------------------------------------------- quoting
// Where to rest, given the book and how much inventory we are already carrying.
// Joining the touch is the whole edge: quoting inside it gives the spread back, and quoting outside
// it never fills. Inventory is managed by WITHDRAWING a side rather than by skewing price -- at one
// tick of resolution there is nowhere to skew to.
function desiredQuotes(book, inv, cfg) {
  const bid = book.yesBids[0] ? book.yesBids[0].price : null;
  const ask = book.yesAsks[0] ? book.yesAsks[0].price : null;
  // A book we will not QUOTE is still a book we can MARK, and those are different questions.
  // Every refusal below used to return without a mid, and makerdesk carries the last one forward
  // (`m.mid = q.mid ?? m.mid`), so a market that drifted into the tails kept marking its inventory
  // at the last price it was quotable at -- and the tails are precisely where a position is on its
  // way to resolving at 0 or 1. Equity went stale on exactly the positions most likely to move.
  // Only a genuinely one-sided book has no two-sided mid to report.
  if (bid == null || ask == null || !(ask > bid)) return { bid: null, ask: null, why: 'one-sided book' };
  const spread = ask - bid;
  const mid = (bid + ask) / 2;
  // The tails are where a one-tick spread is worth least against the risk, so a market priced
  // there gets no NEW position. It used to get no quote at all, and that was the ordering bug:
  // this refusal ran before makerdesk's reduce-only logic ever saw the market, so inventory that
  // drifted into the tails could never be worked off -- the desk sat short 38 at a 91c mid with
  // both sides withdrawn, marking a $10 loss it had no way to close, and every market it had
  // rotated out of was in the same position once its price moved. A tail is precisely where a
  // position is on its way to resolving at 0 or 1, which is the coin flip this desk is not paid to
  // take. So the reducing side stays up: a short keeps bidding, a long keeps offering.
  //
  // A spread under the minimum is the same kind of refusal and gets the same rule. It used to return
  // nothing on either side, ahead of the tails, so a held market Kalshi prices in tenths of a cent
  // could never be worked off once its book narrowed: on 2026-09-24 seven held markets, 268
  // contracts, sat with no quote at all under "spread 0.Xc under 1.0c", CONTROLH-2026-R at +100 and
  // -D at -100 since 09-19. Both refusals now keep the reducing side and flag the quote reduce-only,
  // so fillsFrom stops it at flat rather than letting a sweep carry it through zero.
  const narrow = spread < cfg.makerMinSpread - 1e-9;
  if (narrow || mid < cfg.makerMinMid || mid > cfg.makerMaxMid) {
    const why = narrow ? `spread ${c(spread)} under ${c(cfg.makerMinSpread)}` : 'price in the tails';
    return { bid: inv < 0 ? bid : null, ask: inv > 0 ? ask : null, spread, mid, why: inv ? `${why} · reducing only` : why, ...(inv ? { reduceOnly: true } : {}) };
  }
  // Withdraw the GROWING side at a fraction of the cap, not at the cap. A quote resting at the
  // touch while already long half the cap is an invitation to the next sweep to fill the other
  // half, at our stale price; the reducing side stays up, so the position can only get smaller
  // from here. makerCap itself is still enforced in fillsFrom, on every fill.
  const soft = cfg.makerCap * (cfg.makerSoftCap ?? 1);
  return {
    bid: inv < soft ? bid : null,   // stop bidding once long the soft cap
    ask: inv > -soft ? ask : null,  // stop offering once short the soft cap
    spread, mid,
  };
}

// ---------------------------------------------------------------- the fair rail
// Polymarket's price for the same event is the one thing this desk knows that the flow hitting it
// on Kalshi may not, and on four days of tape (2026-09-19 → 09-22, tools/maker-slice.js --fair) it
// was the only signal that sorted the maker's fills: fills placed WITH Polymarket (bought under its
// mid, or sold over it) marked flat 30 minutes on, fills placed AGAINST it lost 0.3c to 0.8c a
// contract, and the sign held on every day at two hours. So a side that would trade against
// Polymarket is not rested: the bid stays only if it sits at least `margin` under the fair value,
// the ask only if it sits at least `margin` over it. The one exception is a market being worked
// off (reduce-only): its reducing side stays up regardless, or a rotated-out position could never
// close while the two venues disagreed. No fair value, no change.
function fairSide(q, fair, margin, reducing = null) {
  if (!Number.isFinite(fair)) return { bid: q.bid, ask: q.ask, against: null };
  const bidOk = q.bid == null || q.bid <= fair - margin + 1e-9 || reducing === 'bid';
  const askOk = q.ask == null || q.ask >= fair + margin - 1e-9 || reducing === 'ask';
  return { bid: bidOk ? q.bid : null, ask: askOk ? q.ask : null, against: bidOk && askOk ? null : !bidOk && !askOk ? 'both' : bidOk ? 'ask' : 'bid' };
}

// ---------------------------------------------------------------- fills
// NO LOOKAHEAD. `quotes` are what we were ALREADY resting before these trades arrived, and a fill
// happens at OUR price, not the trade's. So when the market gaps through a stale quote we sell low
// into it -- which is exactly the adverse selection that makes market making risky, and modelling
// it away was the single biggest error in the first version of the backtest.
//
// AND WE ARE NOT ALONE AT OUR PRICE. `queue` is the size that was already resting at each of our
// two price levels when we joined, and a taker fills through that before reaching us. Leaving it
// out was the SECOND biggest error: the median market the desk was quoting had 15,700 contracts
// ahead of it, and scoring the backtest with real depth cut it from +$2187 to +$210. A paper desk
// that fills instantly at a price where 15,700 orders sit in front of it is not paper trading, it
// is fiction. Returns the queue it has left so the caller can carry it to the next cycle.
//
// A quote flagged `reduceOnly` (a market being worked off, a gain lock, a book in the tails or under
// the minimum spread) exists to take the position to flat and no further. Quotes carry no size, so
// it used to be limited by the cap alone and one sweep filled it straight through zero: KXRT-PRI-90
// went from short 87 to long 99 at 25c in one round on 2026-09-24, and between the MAKER_WIDEN=0
// deploy (09-23 18:50Z) and 18:05Z the next day 3,010 of the 6,203 contracts traded on work-off
// markets opened new positions instead of closing old ones -- about $58 of loss, and 1,792 contracts
// still held where stopping at flat would have left 640. So each fill on a flagged quote is CLIPPED
// to what is still held (not skipped: a sweep bigger than the position still closes it), and the
// quote fills nothing once the position is flat. The flag rides on the quote itself, persisted in
// m.quotes, because the fair rail also leaves a normal market one-sided and that side is not capped.
function fillsFrom(trades, quotes, inv, cfg, seen, queue) {
  const toFlat = !!quotes.reduceOnly;
  const out = [];
  let position = inv;
  let qb = Math.max(0, (queue && queue.bid) || 0), qa = Math.max(0, (queue && queue.ask) || 0);
  for (const t of trades) {
    if (t.is_block_trade || seen.has(t.trade_id)) continue;
    const p = parseFloat(t.yes_price_dollars), n = parseFloat(t.count_fp) || 0;
    if (!Number.isFinite(p) || n <= 0) continue;
    if (t.taker_book_side === 'bid' && quotes.ask != null && quotes.ask <= p) {
      const eaten = Math.min(qa, n); qa -= eaten;          // they filled the orders ahead of us first
      let qty = Math.floor((n - eaten) * cfg.makerParticipation);
      if (toFlat) qty = Math.min(qty, Math.max(0, position));
      if (qty < 1) continue;
      if (position - qty < -cfg.makerCap) continue;
      position -= qty;
      seen.add(t.trade_id);   // the caller de-dupes ACROSS batches; this covers a repeat WITHIN one
      out.push({ side: 'sell', px: quotes.ask, qty, tradePx: p, runOver: quotes.ask < p, id: t.trade_id });
    } else if (t.taker_book_side === 'ask' && quotes.bid != null && quotes.bid >= p) {
      const eaten = Math.min(qb, n); qb -= eaten;
      let qty = Math.floor((n - eaten) * cfg.makerParticipation);
      if (toFlat) qty = Math.min(qty, Math.max(0, -position));
      if (qty < 1) continue;
      if (position + qty > cfg.makerCap) continue;
      position += qty;
      seen.add(t.trade_id);
      out.push({ side: 'buy', px: quotes.bid, qty, tradePx: p, runOver: quotes.bid > p, id: t.trade_id });
    }
  }
  return { fills: out, queue: { bid: qb, ask: qa } };
}

// ---------------------------------------------------------------- queue position
// Where a quote stands after a requote. Moving to a new price joins the back of whatever is resting
// there; staying put keeps the place already worked down; a side not quoted has no place. Pure, and
// shared: the desk (src/makerdesk.js) and the fill check that replays its tape (tools/fillcheck.js)
// must apply the same rule, or the replay measures a desk that does not exist.
function queueAfter(prevQuotes, prevQueue, next, book) {
  const depth = (side) => { const l = book && (side === 'bid' ? book.yesBids[0] : book.yesAsks[0]); return l ? l.size : 0; };
  const pq = prevQueue || { bid: 0, ask: 0 }, was = prevQuotes || {};
  return {
    bid: next.bid == null ? 0 : (next.bid === was.bid ? pq.bid : depth('bid')),
    ask: next.ask == null ? 0 : (next.ask === was.ask ? pq.ask : depth('ask')),
  };
}

// ---------------------------------------------------------------- accounting
// What one fill does to a position. Pure: takes the position and the fill, returns the position
// that results plus what was realised and what moved in cash. It lives here rather than inside
// makerdesk.js for the same reason decide.js lives apart from agents.js -- this is the arithmetic
// that decides whether the desk is making money, and it has to be assertable without a network.
//
// `cost` is a COST BASIS, not a running cash total, and the two only diverge on a PARTIAL close.
// Moving it by cash flow (`cost -= qty * px`) retires the closed slice at the price it was SOLD
// at rather than the price it was BOUGHT at, leaving a basis that belongs to no real position:
// buy 20 @ 40c then sell 10 @ 50c leaves cost at $3.00 against 10 contracts genuinely held at 40c,
// an implied average of 30c. Every later close then measures its profit from that wrong mark and
// the error compounds -- round-tripping 20 contracts for $2.00 of real cash reported $3.00.
//
// The invariant that catches it: once a market is flat again, total realised MUST equal the total
// change in cash. The old arithmetic satisfied that only when every close was a FULL one (buy 10,
// sell 10), which is the idealised pattern this desk was reasoned about in and not the one
// variable fill sizes produce.
function applyFill(pos, f) {
  const inv = pos.inv || 0, cost = pos.cost || 0;
  const dir = f.side === 'buy' ? 1 : -1;
  const sign = Math.sign(inv);                    // captured before inv moves
  const closing = sign === -dir ? Math.min(Math.abs(inv), f.qty) : 0;
  let basis = cost, pnl = 0;
  if (closing > 0) {
    const avg = Math.abs(cost / inv);             // weighted average of the open side
    pnl = inv > 0 ? (f.px - avg) * closing : (avg - f.px) * closing;
    basis = r2(basis - sign * closing * avg);     // the slice leaves at ITS OWN basis
  }
  const opening = f.qty - closing;                // the rest opens new position, at the fill price
  if (opening > 0) basis = r2(basis + dir * opening * f.px);
  const next = inv + dir * f.qty;
  return {
    inv: next,
    cost: next === 0 ? 0 : basis,                 // flat means no basis to carry
    realized: r2((pos.realized || 0) + pnl),
    pnl: r2(pnl),
    cashDelta: r2(dir === 1 ? -f.qty * f.px : f.qty * f.px),
  };
}

// ---------------------------------------------------------------- settlement
// A maker position is a YES inventory balance. At resolution, every long contract receives the
// YES settlement value and every short contract owes it. Cash therefore moves by `inv * yesPx`
// for either direction; subtracting the signed cost basis gives the realised P&L. This is not a
// synthetic closing trade and pays no taker fee.
//
// Keeping this arithmetic pure matters because a finalized Kalshi market publishes an empty
// 0c/100c book. Treating that placeholder as a 50c midpoint created a fictitious $365 gain on the
// 2026-09-16 Trump-mention book. Settlement must retire the inventory instead of marking that book.
function settlePosition(pos, yesPx) {
  const px = Number(yesPx), inv = Number(pos && pos.inv) || 0, cost = Number(pos && pos.cost) || 0;
  if (!Number.isFinite(px) || px < 0 || px > 1) throw new Error(`invalid maker settlement price ${yesPx}`);
  const cashDelta = r2(inv * px);
  const pnl = r2(cashDelta - cost);
  return {
    inv: 0,
    cost: 0,
    realized: r2((Number(pos && pos.realized) || 0) + pnl),
    cashDelta,
    pnl,
  };
}

// ---------------------------------------------------------------- the candidate universe
// Which markets this desk may quote, out of a list of Kalshi markets someone else already fetched.
//
// The desk's universe was a hand-written list of 39 series (MAKER_SERIES) listed one call each. That
// list, not the code, was the ceiling: Kalshi runs 13,929 series whose fee_type is plain `quadratic`
// and therefore charge makers nothing, and the desk looked at 0.3% of them. The any-market scanner
// already walks every open non-sports event every DISCOVER_EVERY_MIN -- 41,155 markets over 66 pages
// in about five seconds -- so the wide universe costs no call of its own; this filters that crawl.
//
// Measured on 2026-09-16, the same cheap filters over the crawl pass 123 markets across 73 series
// against 39 from the series list, and 37 of the 38 listed series are in it anyway. The bar that
// actually binds is liquidity, not the list: 29,729 of the rejects are under MAKER_MIN_VOL24 and
// 10,179 are priced outside the band. So this widens the pool the trade-rate probe chooses from by
// about three times; it does not change what the desk is looking for.
//
// Pure, so the filter is assertable without a network: `feeTypeOf` is series ticker -> fee_type
// string (ks.seriesInfo), and a market whose series is unknown is not tradeable rather than assumed
// free. Rows come back in the same shape refreshUniverse builds by hand, busiest first.
// Kalshi's event-day markets (KXTRUMPMENTION-26SEP16-AI, KXWORLDNEWSMENTION-26SEP15-EMMY) carry the
// day the event happens in the ticker, but their close_time and expected expiration sit weeks later
// and the market closes early when the event does. A close-time guard therefore lets them straight
// through. On the cloud box fourteen Trump-mention markets ended a day after their date holding
// +/-100 contracts each and lost $314 of the maker's $396. The date in the ticker is the honest
// clock; null when the ticker has none (year-end and month-only tickers like -26DEC31 or -27JAN-28
// are fine: far away, or no day).
//
// The day may be followed by anything: a hyphen (KXTRUMPMENTION-26SEP16-AI), the players
// (KXITFMATCH-26SEP21REJSIM-REJ) or the start time (KXMLBGAME-26SEP081905COLNYY). It used to have to
// be followed by a hyphen or the end, so every match and game ticker read as undated, fell back to a
// close_time weeks out, and was quoted hours before the event: the maker held tennis matches into
// play and through their settlement, -$421 of its first -$636 (KXITFMATCH and KXWTASETWINNER, 85-88%
// of contracts run over), for the same reason the Trump-mention markets lost $314 the week before.
const MONTHS = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
function tickerEventDays(ticker, now = Date.now()) {
  const m = /-(\d{2})(JAN|FEB|MAR|APR|MAY|JUN|JUL|AUG|SEP|OCT|NOV|DEC)(\d{2})/.exec(String(ticker || ''));
  if (!m || Number(m[3]) < 1 || Number(m[3]) > 31) return null;
  const end = Date.UTC(2000 + Number(m[1]), MONTHS[m[2]], Number(m[3]), 23, 59, 59);
  return (end - now) / 86400000;
}

// The event date a SERIES names, for markets whose tickers carry none. The midterms are the case:
// SENATETX-26-D, CONTROLS-2026-R and KXBALANCEPOWERCOMBO-27FEB-DR resolve on election night, but the
// ticker has no day and close_time (and expected_expiration_time) sits 130 to 405 days out, so the
// 7-day rail read them as far away and the desk would have quoted both sides, at the cap, into
// 2026-11-03. On 2026-09-24 those series held 1,964 of the book's 4,682 contracts (about $913 if every
// one went against the desk). Kalshi's event record has no date either, so the date is configured:
// `eventDates` is cfg.makerEventDates, [pattern, 'YYYY-MM-DD'] pairs, where a pattern ending in `*`
// is a series prefix. The day is read to its last second UTC, as tickerEventDays reads a ticker's.
// null when no pattern matches.
function eventDateDays(series, eventDates, now = Date.now()) {
  if (!series || !Array.isArray(eventDates)) return null;
  let best = null;
  for (const [p, date] of eventDates) {
    if (!(p.endsWith('*') ? series.startsWith(p.slice(0, -1)) : series === p)) continue;
    const end = Date.parse(`${date}T23:59:59Z`);
    if (!Number.isFinite(end)) continue;
    const d = (end - now) / 86400000;
    if (best == null || d < best) best = d;
  }
  return best;
}

// Days until this market can no longer be safely quoted: the earliest of its close time, the event
// date its ticker names and the event date configured for its series. NaN when none is known, which
// every caller treats as "refuse". `series` defaults to the ticker's first segment, which is the
// series for every market the event-date list names.
function daysToEnd(ticker, closeTime, now = Date.now(), eventDates = null, series = null) {
  const c = closeTime ? (Date.parse(closeTime) - now) / 86400000 : NaN;
  const dated = [tickerEventDays(ticker, now), eventDateDays(series || String(ticker || '').split('-')[0], eventDates, now)].filter((x) => x != null);
  const t = dated.length ? Math.min(...dated) : null;
  return t == null ? (Number.isFinite(c) ? c : 0) : Math.min(Number.isFinite(c) ? c : Infinity, t);
}

function candidatesFrom(markets, feeTypeOf, cfg, now = Date.now()) {
  const rows = [];
  for (const m of markets || []) {
    const series = m.seriesTicker || null;
    if (!series || feeTypeOf(series) !== 'quadratic') continue;   // unknown fee structure is not free
    const b = m.yesBid, a = m.yesAsk;
    if (!Number.isFinite(b) || !Number.isFinite(a) || !(a > b)) continue;
    const mid = (a + b) / 2;
    if (mid < cfg.makerMinMid || mid > cfg.makerMaxMid) continue;
    if (a - b < cfg.makerMinSpread - 1e-9) continue;
    if ((m.vol24 || 0) < cfg.makerMinVol24) continue;
    // Do not be holding inventory when the market settles: that is a 0-or-1 coin flip, not a spread.
    const days = daysToEnd(m.ticker, m.closeTime, now, cfg.makerEventDates, series);
    if (!(days >= cfg.makerMinDaysToClose)) continue;
    rows.push({
      ticker: m.ticker, series, vol: m.vol24 || 0, spread: a - b, days,
      // which event it belongs to and whether that event's markets exclude each other, for the event rail
      event: m.eventTicker || null, mx: m.mutuallyExclusive === true,
      depth: ((m.yesBidSize || 0) + (m.yesAskSize || 0)) / 2,
      title: m.title || '', sub: m.yesSubTitle || m.subTitle || '',
    });
  }
  rows.sort((x, y) => (y.vol - x.vol) || (y.spread - x.spread));
  return rows;
}

// ---------------------------------------------------------------- gain lock
// A profitable inventory stops growing once its mark has made a meaningful gain and then given
// part of it back: the growing side is withdrawn, the reducing side stays up (the maker form of
// decide.gainLockIntent). `peak` is the best mark P&L THIS position has seen, and it belongs to
// this position alone. It used to be carried across a flat book, so the peak of a trade that had
// already closed locked the next position in that market from its first contract: on 2026-09-21
// the box held 128 markets and 49 of them were quoting one side for exactly that reason. The peak
// starts over whenever the book is flat or the position has changed sides. Pure, like the rest of
// this file: returns the next peak and side and whether the lock is on; makerdesk assigns them.
function gainLock(m, markPnl, cfg) {
  const side = Math.sign(m.inv || 0);
  const fresh = side === 0 || side !== (m.gainSide || 0);
  const peak = fresh ? markPnl : Math.max(Number.isFinite(m.gainPeak) ? m.gainPeak : markPnl, markPnl);
  const cost = Math.abs(m.cost || 0);
  const trigger = cost * (cfg.gainLockTriggerPct || 0);
  const floor = peak - cost * (cfg.gainLockGivebackPct || 0);
  return { peak, side, locked: side !== 0 && peak >= trigger && markPnl <= floor };
}

// ---------------------------------------------------------------- one event, one bet
// The per-market cap does not see that long YES on one side of a two-way race and short YES on the
// other are the same bet. The fair rail makes it worse: Polymarket's price says the same thing about
// both legs, so both rest the side that agrees with it and both fill the same way. On 2026-09-24 the
// box held SENATETX-26 +100 D / -100 R (-$115.40 if R wins), CONTROLS-2026 -100 R / +61 D (-$101.41)
// and KXBALANCEPOWERCOMBO-27FEB DD +98 / DR -97 / RR +30 (-$135.23): each within the per-market cap,
// each a doubled position. So on an event whose markets exclude each other (Kalshi's
// `mutually_exclusive`), the settlement P&L of every held leg is summed for each way it can resolve --
// each listed market winning alone, and none of them -- and a side whose fill would push the worst of
// those past -`limit` dollars, and further than it already is, is not rested. The side that shrinks
// its own market's position always stays up. Events whose markets can pay together (thresholds,
// "nominated for") are left to the per-market cap: summing them this way would be wrong.
// `legs` is [{ ticker, inv, cost }] for the held markets of the event, this one included; a fill is
// probed at one contract, as the soft cap probes, rather than sized.
function eventWorst(legs) {
  let low = 0, cost = 0;
  for (const l of legs) { low = Math.min(low, l.inv || 0); cost += l.cost || 0; }
  return low - cost;
}
function eventSide(q, legs, ticker, limit) {
  const own = legs.find((l) => l.ticker === ticker) || { ticker, inv: 0, cost: 0 };
  const others = legs.filter((l) => l.ticker !== ticker);
  const before = eventWorst(legs);
  const deepens = (dir, px) => {
    const after = eventWorst([...others, { ticker, inv: (own.inv || 0) + dir, cost: (own.cost || 0) + dir * px }]);
    return after < -limit - 1e-9 && after < before - 1e-9;
  };
  const bidOk = q.bid == null || (own.inv || 0) < 0 || !deepens(1, q.bid);
  const askOk = q.ask == null || (own.inv || 0) > 0 || !deepens(-1, q.ask);
  return { bid: bidOk ? q.bid : null, ask: askOk ? q.ask : null, worst: r2(before), against: bidOk && askOk ? null : !bidOk && !askOk ? 'both' : bidOk ? 'ask' : 'bid' };
}

// ---------------------------------------------------------------- toxicity
// Run-over is adverse selection made visible: the tape traded through a resting quote, so we sold
// below the print or bought above it. It is where the maker's money went (43% of live fills, 59%
// of contracts, $55.57 against the tape in 2.25 days), and a faster requote only moved it from
// 69% to 59% -- some markets are simply ones whose touch gets swept. This measures that per
// market over its last TOX_WINDOW fills, and cools a market that passes cfg.makerMaxRunOver for
// cfg.makerToxCooldownMin minutes. Both pure: the window is a value, the gate returns the next
// state, and makerdesk assigns it -- the same split as applyFill.
//
// Each entry is the fill's size, positive when it was run over and negative when it was not, so one
// window answers both questions: the share of FILLS run over, and the share of CONTRACTS. They are
// not the same question. A sweep is one fill of several hundred contracts, and a fill-counted share
// barely sees it -- which is why the fill-counted gate replayed with nothing off run-over contracts.
// cfg.makerToxByContracts picks which share trips the gate. Windows saved before sizes were kept hold
// bare 1s and 0s: a 1 reads as one run-over contract and a 0 as one clean contract, so for them the
// contract share is the fill share, as it was when they were written.
const TOX_WINDOW = 30;
function toxWindow(tox, fill) {
  const q = Math.max(1, Math.abs(Number(fill.qty)) || 1);
  return [...(tox || []), fill.runOver ? q : -q].slice(-TOX_WINDOW);
}
function toxRate(tox, byContracts) {
  if (!tox.length) return 0;
  if (!byContracts) return tox.filter((x) => x > 0).length / tox.length;
  const size = (x) => (x === 0 ? 1 : Math.abs(x));      // an old window's clean 0 is one clean contract
  const all = tox.reduce((a, x) => a + size(x), 0);
  return tox.reduce((a, x) => a + (x > 0 ? x : 0), 0) / all;
}
function toxicGate(m, cfg, now) {
  const tox = m.tox || [];
  const n = tox.length;
  const rate = toxRate(tox, !!cfg.makerToxByContracts);
  if (m.cooledUntil && now < m.cooledUntil) return { cooled: true, tripped: false, rate, cooledUntil: m.cooledUntil, tox };
  // The window resets on a trip. Otherwise the same thirty fills re-trip the gate the moment the
  // cooldown ends, and a market could never earn its way back with clean fills.
  if (n >= cfg.makerToxMinFills && rate > cfg.makerMaxRunOver + 1e-9) {
    return { cooled: true, tripped: true, rate, cooledUntil: now + cfg.makerToxCooldownMin * 60000, tox: [] };
  }
  return { cooled: false, tripped: false, rate, cooledUntil: 0, tox };
}

// ---------------------------------------------------------------- risk
// Drawdown from the HIGH-WATER MARK, and the new mark. Pure, so the rail can be asserted.
//
// Measured against a fixed opening balance instead, the rail loosens with every dollar earned: a
// book that runs to $10,500 and bleeds back to $9,050 has given up $1,450 -- 13.8% off its high --
// while a from-inception test reads 9.5% and never fires. The better the desk does, the more it is
// allowed to lose before anything stops it. A high-water mark can only halt EARLIER than the old
// test, never later, and the two agree exactly on a desk that has never been in profit.
function drawdownFrom(equity, peak, initialBalance) {
  const eq = Number.isFinite(equity) ? equity : initialBalance;
  const hi = Math.max(Number.isFinite(peak) ? peak : initialBalance, eq);
  return { peak: hi, dd: hi > 0 ? (hi - eq) / hi : 0 };
}

// ---------------------------------------------------------------- universe
// Only plain-`quadratic` series: anything with maker fees hands most of the spread back. Cached,
// because fee_type does not change intraday.
// `getJSON` and `sleep` are makerdesk's own (its test seam); the defaults are what this always used.
async function eligibleSeries(candidates, { getJSON = http.getJSON, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const ok = [];
  for (const s of candidates) {
    try {
      const d = await getJSON(`${ks.BASE}/series/${s}`);
      const x = d.series || {};
      if (x.fee_type === 'quadratic') ok.push(s);
    } catch { /* leave it out: unknown fee structure is not tradeable */ }
    await sleep(120);  // this runs once per process; pace it
  }
  return ok;
}

module.exports = { tickerEventDays, eventDateDays, daysToEnd, desiredQuotes, eventWorst, eventSide, fairSide, queueAfter, fillsFrom, applyFill, settlePosition, gainLock, toxWindow, toxicGate, drawdownFrom, eligibleSeries, candidatesFrom };

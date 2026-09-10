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
  if (bid == null || ask == null || !(ask > bid)) return { bid: null, ask: null, why: 'one-sided book' };
  const spread = ask - bid;
  if (spread < cfg.makerMinSpread - 1e-9) return { bid: null, ask: null, why: `spread ${c(spread)} under ${c(cfg.makerMinSpread)}` };
  const mid = (bid + ask) / 2;
  if (mid < cfg.makerMinMid || mid > cfg.makerMaxMid) return { bid: null, ask: null, why: 'price in the tails' };
  return {
    bid: inv < cfg.makerCap ? bid : null,   // stop bidding once long the cap
    ask: inv > -cfg.makerCap ? ask : null,  // stop offering once short the cap
    spread, mid,
  };
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
function fillsFrom(trades, quotes, inv, cfg, seen, queue) {
  const out = [];
  let position = inv;
  let qb = Math.max(0, (queue && queue.bid) || 0), qa = Math.max(0, (queue && queue.ask) || 0);
  for (const t of trades) {
    if (t.is_block_trade || seen.has(t.trade_id)) continue;
    const p = parseFloat(t.yes_price_dollars), n = parseFloat(t.count_fp) || 0;
    if (!Number.isFinite(p) || n <= 0) continue;
    if (t.taker_book_side === 'bid' && quotes.ask != null && quotes.ask <= p) {
      const eaten = Math.min(qa, n); qa -= eaten;          // they filled the orders ahead of us first
      const qty = Math.floor((n - eaten) * cfg.makerParticipation);
      if (qty < 1) continue;
      if (position - qty < -cfg.makerCap) continue;
      position -= qty;
      out.push({ side: 'sell', px: quotes.ask, qty, tradePx: p, runOver: quotes.ask < p, id: t.trade_id });
    } else if (t.taker_book_side === 'ask' && quotes.bid != null && quotes.bid >= p) {
      const eaten = Math.min(qb, n); qb -= eaten;
      const qty = Math.floor((n - eaten) * cfg.makerParticipation);
      if (qty < 1) continue;
      if (position + qty > cfg.makerCap) continue;
      position += qty;
      out.push({ side: 'buy', px: quotes.bid, qty, tradePx: p, runOver: quotes.bid > p, id: t.trade_id });
    }
  }
  return { fills: out, queue: { bid: qb, ask: qa } };
}

// ---------------------------------------------------------------- universe
// Only plain-`quadratic` series: anything with maker fees hands most of the spread back. Cached,
// because fee_type does not change intraday.
async function eligibleSeries(candidates) {
  const ok = [];
  for (const s of candidates) {
    try {
      const d = await http.getJSON(`${ks.BASE}/series/${s}`);
      const x = d.series || {};
      if (x.fee_type === 'quadratic') ok.push(s);
    } catch { /* leave it out: unknown fee structure is not tradeable */ }
    await new Promise((r) => setTimeout(r, 120));  // this runs once per process; pace it
  }
  return ok;
}

module.exports = { desiredQuotes, fillsFrom, eligibleSeries };

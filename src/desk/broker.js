'use strict';
// Paper fills for the stocks, crypto and options desk. Pure: an order and the market in, a fill out.
//
// There is no live broker behind this and no code path to one. The desk's only way to "trade" is to
// write these fills into its own paper ledger (src/desk/engine.js).
//
// THE FILL MODEL, per asset:
//   crypto  walks Coinbase's real order book: a buy eats the asks from the best one up, a sale eats
//           the bids from the best one down, so a large order pays for its size. Then a fee on the
//           notional (DESK_CRYPTO_FEE_BPS, 40 = 0.40%, what a small account pays at the cheaper US
//           venues; Coinbase's own retail taker rate is higher, and the lab in README shows the book
//           still holds up at 0.80%).
//   stock   buys at the ask and sells at the bid, whole order, no commission (US brokers charge none
//           on ETFs). The desk trades a few thousand dollars of SPY against a top of book of hundreds of
//           shares, so its size is never the limit. DESK_STOCK_FEE_BPS exists for anyone who wants to
//           charge more.
//   option  buys at the ask and sells at the bid, capped at the size shown there, plus a per-contract
//           fee (DESK_OPTION_FEE, $0.03: the regulatory fees a commission-free broker passes on). One
//           contract is 100 shares, so a 0.12 option costs $12.
// A buy never spends more cash than the book has: the quantity shrinks until price plus fee fits.
const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const MULT = { crypto: 1, stock: 1, option: 100 };
// the smallest amount each can be bought in: a millionth of a coin, a thousandth of a share (the
// fractional shares every broker Evan uses sells), whole option contracts
const STEP = { crypto: 1e-6, stock: 1e-3, option: 1 };
const floorTo = (x, step) => Math.floor(x / step + 1e-9) * step;

// Walk levels (best first) for `qty`; { filled, cost } with cost the sum of price x size taken.
function walk(levels, qty) {
  let filled = 0, cost = 0;
  for (const l of levels || []) {
    if (filled >= qty - 1e-12) break;
    const take = Math.min(qty - filled, l.size);
    filled += take; cost += take * l.price;
  }
  return { filled, cost };
}

function feeFor(kind, qty, notional, fees) {
  if (kind === 'option') return r2(qty * (fees.optionPerContract || 0));
  const bps = kind === 'crypto' ? fees.cryptoBps : fees.stockBps;
  return r2(notional * (bps || 0) / 10000);
}

// order: { kind, side: 'buy'|'sell', qty, cash? (buys: the most this may spend, fee included) }
// market: { bid, ask, bidSz, askSz } and, for crypto, book: { bids, asks }
// -> { qty, avg, notional, fee, cash } where `cash` is the change to the book's cash (negative on a
//    buy), or { qty: 0, reason } when nothing can fill.
function fill(order, market, fees) {
  const { kind, side } = order;
  const mult = MULT[kind], step = STEP[kind];
  if (!mult) return { qty: 0, reason: `unknown asset kind ${kind}` };
  let want = floorTo(order.qty, step);
  if (!(want > 0)) return { qty: 0, reason: 'nothing to trade' };
  const buy = side === 'buy';
  const px = buy ? market.ask : market.bid;
  if (!(px > 0)) return { qty: 0, reason: buy ? 'no ask' : 'no bid' };
  if (kind === 'option') {
    const shown = buy ? market.askSz : market.bidSz;
    if (Number.isFinite(shown)) want = Math.min(want, Math.floor(shown));
    if (!(want > 0)) return { qty: 0, reason: 'no size at the touch' };
  }
  // price a quantity: the book for crypto when there is one, the touch otherwise
  const levels = kind === 'crypto' && market.book ? (buy ? market.book.asks : market.book.bids) : null;
  const price = (q) => {
    if (!levels || !levels.length) return { filled: q, notional: q * px * mult };
    const w = walk(levels, q);
    return { filled: floorTo(w.filled, step), notional: w.cost * mult };
  };
  let p = price(want);
  if (!(p.filled > 0)) return { qty: 0, reason: 'no depth in the book' };
  if (buy && Number.isFinite(order.cash)) {
    // shrink until price + fee fits the cash; a few passes converge because the fee is proportional
    for (let i = 0; i < 6 && p.notional + feeFor(kind, p.filled, p.notional, fees) > order.cash + 1e-9; i++) {
      const avg = p.notional / p.filled;
      const perUnit = avg * (1 + (kind === 'crypto' ? fees.cryptoBps : kind === 'stock' ? fees.stockBps : 0) / 10000) + (kind === 'option' ? fees.optionPerContract || 0 : 0);
      const q = floorTo(Math.max(0, order.cash - 0.01) / perUnit, step);
      if (!(q > 0)) return { qty: 0, reason: 'not enough cash' };
      p = price(Math.min(q, p.filled - step));
      if (!(p.filled > 0)) return { qty: 0, reason: 'not enough cash' };
    }
    if (p.notional + feeFor(kind, p.filled, p.notional, fees) > order.cash + 1e-9) return { qty: 0, reason: 'not enough cash' };
  }
  const qty = kind === 'option' ? Math.round(p.filled) : r6(p.filled);
  const notional = r2(p.notional);
  const fee = feeFor(kind, qty, notional, fees);
  return {
    qty, avg: r6(p.notional / p.filled / mult), notional, fee,
    cash: buy ? r2(-(notional + fee)) : r2(notional - fee),
  };
}

module.exports = { fill, walk, feeFor, MULT, STEP };

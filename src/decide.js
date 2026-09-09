'use strict';
// The decision core: pure functions from an explicit view to intents.
//
// Nothing here does I/O, reads a clock of its own, or mutates anything it is handed. Every
// function takes what it needs as an argument and RETURNS what it decided; applying that decision
// -- moving cash, opening or closing a position -- is the engine's job alone.
//
// Two reasons this is separated out. First, the desks used to communicate entirely through mutable
// fields on the engine, so nothing declared what it consumed or produced and the cycle order was
// load-bearing but enforced by nothing (the `inPlay` flag had to be stamped in HOLT because RIGO
// reads it and runs before BRAM -- set anywhere else it was silently undefined). Second, and the
// reason it happened now: tools/replay.js can only exist if the same functions that decide live
// can be handed a recorded tape and a synthetic clock instead of a network and a wall clock.
const ks = require('./venues/kalshi');

const r2 = (x) => Math.round(x * 100) / 100;

// Fair value leans on the venue with more volume: when two books disagree, the thin one is usually wrong.
function fairValue(q) {
  const wp = (q.pmVol || 0) + 100, wk = (q.ksVol || 0) + 100;
  return (q.pmMid * wp + q.ksMid * wk) / (wp + wk);
}

// What a convergence trade is actually worth, per contract, on venue `v` / `side`.
//   - in  at the ask (or 1-bid for NO), paying a taker fee
//   - out at the BID once the mid reaches fair (RIGO exits at markPrice, which is the bid side),
//     so the venue's spread is a cost too, not just half of it
//   - and a second taker fee on that exit
// On Kalshi at mid prices the fee alone is ~1.75c each way; ignoring the exit leg flattered every
// convergence signal by roughly spread/2 plus one full fee.
function convEdge(v, side, q, fair, cfg) {
  const bid = v === 'PM' ? q.pmBid : q.ksBid;
  const ask = v === 'PM' ? q.pmAsk : q.ksAsk;
  const spread = Math.max(0, ask - bid);
  const px = side === 'yes' ? ask : r2(1 - bid);
  const target = side === 'yes' ? fair : 1 - fair; // where the mid should land
  const exit = target - spread / 2;                // ...but we sell into the bid
  const feeIn = v === 'PM' ? cfg.pmTakerFee * px : ks.feePerContract(px, cfg.ksFeeRate);
  const feeOut = v === 'PM' ? cfg.pmTakerFee * exit : ks.feePerContract(exit, cfg.ksFeeRate);
  return { px, edge: exit - px - feeIn - feeOut };
}

// Everything one pair offers this cycle. Returns intents; pushes nothing anywhere.
//   fair    volume-weighted fair value
//   best    the best convergence candidate found REGARDLESS of the thresholds -- the tape needs
//           near-misses to answer "how close did we come?", not just "did we trade?"
//   signals arb candidates first (A then B), then the single best convergence, matching the order
//           the old inline code pushed them in; ties after sorting therefore resolve identically
function pairSignals(p, cfg) {
  const q = p.q;
  const out = { fair: null, best: null, signals: [] };
  const ksFeeYes = ks.feePerContract(q.ksAsk, cfg.ksFeeRate);
  const ksFeeNo = ks.feePerContract(1 - q.ksBid, cfg.ksFeeRate);
  const pmFee = cfg.pmTakerFee;
  // locked arbs: YES here + NO there must cost < $1 after fees
  const edgeA = 1 - (q.pmAsk + (1 - q.ksBid) + pmFee * q.pmAsk + ksFeeNo);
  const edgeB = 1 - (q.ksAsk + (1 - q.pmBid) + pmFee * (1 - q.pmBid) + ksFeeYes);
  if (edgeA >= cfg.minArbEdge) out.signals.push({ type: 'arb', pair: p, edge: edgeA, legs: [{ venue: 'PM', side: 'yes', px: q.pmAsk }, { venue: 'KS', side: 'no', px: r2(1 - q.ksBid) }] });
  if (edgeB >= cfg.minArbEdge) out.signals.push({ type: 'arb', pair: p, edge: edgeB, legs: [{ venue: 'KS', side: 'yes', px: q.ksAsk }, { venue: 'PM', side: 'no', px: r2(1 - q.pmBid) }] });

  const gap = q.ksMid - q.pmMid; // + => Kalshi rich, Polymarket cheap
  const fair = fairValue(q);
  out.fair = fair;
  // Price every candidate first and gate afterwards: picking the max then testing it is the same
  // signal as testing each and keeping the max, but it leaves `best` set on pairs that miss.
  let best = null;
  for (const v of ['PM', 'KS']) {
    const bid = v === 'PM' ? q.pmBid : q.ksBid, ask = v === 'PM' ? q.pmAsk : q.ksAsk;
    if (ask - bid > cfg.maxSpread + 1e-9) continue; // epsilon: 0.05 - 0.00 lands at 0.05000000000000004
    for (const side of ['yes', 'no']) {
      const { px, edge } = convEdge(v, side, q, fair, cfg);
      if (!best || edge > best.edge) best = { venue: v, side, px, edge };
    }
  }
  out.best = best;
  // minEdge, not minGap: fair value sits between the two venues, so the realisable edge is a
  // fraction of the gap. Testing it against minGap needed a 6-10c gap to clear a nominal 3c bar,
  // which is why the convergence book never opened a position.
  if (best && best.edge >= cfg.minEdge && fair > cfg.minMid && fair < cfg.maxMid && Math.abs(gap) >= cfg.minGap) {
    out.signals.push({ type: 'converge', pair: p, edge: best.edge, gap, fair, legs: [{ venue: best.venue, side: best.side, px: best.px }] });
  }
  return out;
}

// Every pair, gated and ranked. `now` is passed in rather than read, so a replay can lie about it.
function scan(pairs, cfg, now) {
  const signals = [];
  let widest = null, inPlayN = 0, staleN = 0;
  const fair = new Map(), best = new Map();
  for (const p of pairs) {
    const q = p.q;
    if (!q) continue;
    // Per-instrument staleness. A desk-wide clock keeps advancing as long as the venue calls
    // succeed, so one pair that quietly stopped repricing stayed tradeable while the dashboard
    // read "data age 0s". Quotes carry their own observation time; trust that. Checked BEFORE
    // in-play so the counts match what the desk reported before this was extracted.
    if (q.t && now - q.t > cfg.maxDataAgeSec * 1000) { staleN++; continue; }
    // games are untradeable from 2 minutes before start: listings lag live play by far more than
    // any gap is worth
    if (p.inPlay) { inPlayN++; continue; }
    const gap = q.ksMid - q.pmMid;
    if (!widest || Math.abs(gap) > Math.abs(widest.gap)) widest = { p, gap, q };
    const r = pairSignals(p, cfg);
    fair.set(p.id, r.fair); best.set(p.id, r.best);
    for (const s of r.signals) signals.push(s);
  }
  signals.sort((a, b) => b.edge - a.edge);
  return { signals, widest, inPlayN, staleN, fair, best };
}

// Should this position be closed, and why? Pure: the caller has already marked it.
// Order matters and is deliberate: the CLOCK-DRIVEN exits come first and do not require a quote.
// Nested behind a quote check (the old behaviour) a position whose pair stopped being rebuilt was
// never stopped out and never timed out -- it was carried to resolution unmanaged.
function exitIntent(pos, pair, cfg, now) {
  if (pos.strategy !== 'converge') return null;
  const q = pair && pair.q;
  const heldMin = (now - pos.openedAt) / 60000;
  const mark = pos.mark ?? pos.entry;
  const c = (x) => `${(x * 100).toFixed(1)}c`;
  if (heldMin >= cfg.maxHoldMin) {
    return { px: mark, reason: `max hold ${cfg.maxHoldMin}m reached${q ? `, gap still ${c(Math.abs(q.ksMid - q.pmMid))}` : ' (no live quote)'}` };
  }
  if (pair && pair.inPlay) return { px: mark, reason: 'event going live, flattening directional risk' };
  if (!q) return null; // held on the last mark; the time exits above stay armed
  const gap = Math.abs(q.ksMid - q.pmMid);
  const perContract = pos.mark - pos.entry;
  if (gap <= cfg.exitGap) return { px: pos.mark, reason: `gap closed to ${c(gap)}, held ${Math.round(heldMin)}m` };
  if (perContract <= -cfg.stopLoss) return { px: pos.mark, reason: `stop: mark ${c(perContract)} vs entry` };
  return null;
}

// Which halt, if any, applies. The operator's latched halt outranks every automatic check.
function riskState({ operatorHalt, age, drawdown, errs, mode, liveReady, cfg }) {
  if (operatorHalt) return operatorHalt;
  if (!Number.isFinite(age)) return 'no quotes yet';
  if (age > cfg.maxDataAgeSec) return `stale data (${Math.round(age)}s old)`;
  if (drawdown >= cfg.maxDailyDrawdownPct) return `daily drawdown ${(drawdown * 100).toFixed(1)}% hit the ${(cfg.maxDailyDrawdownPct * 100).toFixed(0)}% limit`;
  if (errs >= 25) return `${errs} API errors in 5m`;
  if (mode === 'live' && !liveReady) return 'live venue not authenticated';
  return null;
}

// Flow read for one pair: is the venue gap narrowing or widening?
function biasFor(history, cfg) {
  if (!history || history.length < 3) return null;
  const a = history[Math.max(0, history.length - 8)], b = history[history.length - 1];
  const gapThen = a.ksMid - a.pmMid, gapNow = b.ksMid - b.pmMid;
  const raw = (Math.abs(gapThen) - Math.abs(gapNow)) / Math.max(0.01, Math.abs(gapThen));
  const score = Math.max(-1, Math.min(1, raw)); // +1 converging, -1 diverging
  // Only meaningful if there was a gap to begin with. With the 0.01 floor in the denominator a
  // pair whose gap opened from ~0 to 2c scores -1 ("diverging") -- but a freshly opened gap is
  // exactly the convergence setup, so that veto threw away the only trades this book exists for.
  return { score, reliable: Math.abs(gapThen) >= cfg.minGap, pmDrift: b.pmMid - a.pmMid, ksDrift: b.ksMid - a.ksMid, gapNow, mins: Math.round((b.t - a.t) / 60000) };
}

// How many contracts, given a budget and the depth actually resting inside the limit.
function sizePlan(signal, { budget, sizeMult, books, cfg }) {
  const unitCost = signal.legs.reduce((a, l) => a + l.px, 0)
    + signal.legs.reduce((a, l) => a + (l.venue === 'KS' ? ks.fee(1, l.px, cfg.ksFeeRate) : cfg.pmTakerFee * l.px), 0);
  let qty = Math.floor((budget * sizeMult) / unitCost);
  for (let i = 0; i < signal.legs.length; i++) {
    const limit = signal.legs[i].px + 0.01;
    const depth = Math.floor((books[i].asks || []).filter((l) => l.price <= limit + 1e-9).reduce((a, l) => a + l.size, 0));
    qty = Math.min(qty, depth);
  }
  return { qty, unitCost };
}

module.exports = { fairValue, convEdge, pairSignals, scan, exitIntent, riskState, biasFor, sizePlan };

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
//
// The gate path is written to be AUDITABLE. Every rejection names itself and is counted, because
// on this strategy the interesting output is almost always "nothing traded, and here is exactly
// which rail stopped it" -- silent `continue`s made that unanswerable without a debugger.
const ks = require('./venues/kalshi');
const pm = require('./venues/polymarket');
const { MAX_VENUE_DISAGREE } = require('./matcher');

const r2 = (x) => Math.round(x * 100) / 100;

// The Polymarket taker fee rate a quote is priced at. The engine stamps each quote with its own
// market's rate (engine.quote); a quote that does not carry one -- an old tape, a hand-built view
// -- is priced at the fallback, which is the highest category rate. One definition, so the signal,
// the size and the fill can never disagree about what the Polymarket leg costs.
const pmRate = (q, cfg) => (q && Number.isFinite(q.pmFeeRate) ? q.pmFeeRate : cfg.pmFeeFallback);

// Fair value leans on the venue with more volume: when two books disagree, the thin one is usually wrong.
// A venue whose OWN spread is wider than maxSpread is excluded outright rather than merely
// downweighted: a 44c-wide, untraded quote is noise, not price discovery, and should not move fair
// value at all. Previously a wide venue was excluded only from being the tradable leg, but its mid
// still counted at full weight here -- manufacturing apparent edge on dead markets. Five of one
// week's thirteen convergence losses were Oscar "Best Picture Nomination" props hit by exactly
// this: a zero-volume, 44c-wide Polymarket quote drifting for minutes made the pair look like it
// had an 8c edge that was never really there.
function fairValue(q, cfg) {
  const pmWide = q.pmAsk - q.pmBid > cfg.maxSpread + 1e-9;
  const ksWide = q.ksAsk - q.ksBid > cfg.maxSpread + 1e-9;
  const wp = pmWide ? 0 : (q.pmVol || 0) + 100;
  const wk = ksWide ? 0 : (q.ksVol || 0) + 100;
  if (wp + wk === 0) return (q.pmMid + q.ksMid) / 2; // both too wide to trust either alone
  return (q.pmMid * wp + q.ksMid * wk) / (wp + wk);
}

// Is this quote something we can price at all? A book that is crossed (ask under bid), inverted,
// or carrying a non-finite level produces a NEGATIVE spread, and `convEdge` subtracts spread/2 --
// so a malformed book does not fail loudly, it manufactures edge and ranks first. Neither appears
// on the recorded tape (0 of 30,817 lines), which is the argument for the check being cheap and
// unconditional rather than the argument for leaving it out.
function quoteFault(q) {
  const lv = [q.pmBid, q.pmAsk, q.ksBid, q.ksAsk, q.pmMid, q.ksMid];
  if (!lv.every((x) => Number.isFinite(x))) return 'non-finite quote';
  if (lv.some((x) => x < 0 || x > 1)) return 'quote outside 0-1';
  if (q.pmAsk < q.pmBid || q.ksAsk < q.ksBid) return 'crossed book';
  return null;
}

// What a convergence trade is actually worth, per contract, on venue `v` / `side`.
//   - in  at the ask (or 1-bid for NO), paying a taker fee
//   - out at the BID once the mid reaches fair (RIGO exits at markPrice, which is the bid side),
//     so the venue's spread is a cost too, not just half of it
//   - and a second taker fee on that exit
// On Kalshi at mid prices the fee alone is ~1.75c each way; ignoring the exit leg flattered every
// convergence signal by roughly spread/2 plus one full fee.
function convEdge(v, side, q, fair, cfg, ref) {
  const bid = v === 'PM' ? q.pmBid : q.ksBid;
  const ask = v === 'PM' ? q.pmAsk : q.ksAsk;
  const spread = Math.max(0, ask - bid);
  const px = side === 'yes' ? ask : r2(1 - bid);
  const target = side === 'yes' ? fair : 1 - fair; // where the mid should land
  const exit = target - spread / 2;                // ...but we sell into the bid
  // `ref` is the Kalshi ticker: the taker multiplier is per-series, not global (MLB is 0.5,
  // fourteen series are 0). Omitting it bills at full rate, which is the safe direction.
  // Polymarket's fee is the same shape as Kalshi's, rate x p x (1-p), at the market's own rate
  // (0 on geopolitics, 0.03-0.07 elsewhere). It used to be a flat 0, which flattered every
  // Polymarket leg by up to 1.75c each way and made the "Polymarket legs are free" argument true
  // only on paper.
  const rate = pmRate(q, cfg);
  const feeIn = v === 'PM' ? pm.feePerShare(px, rate) : ks.feePerContract(px, cfg.ksFeeRate, ref);
  const feeOut = v === 'PM' ? pm.feePerShare(exit, rate) : ks.feePerContract(exit, cfg.ksFeeRate, ref);
  return { px, edge: exit - px - feeIn - feeOut };
}

// Rank order for signals of different KINDS. A locked arb is a fully hedged position that pays $1
// at resolution whatever happens; a convergence signal is an unhedged directional bet that the two
// venues will agree again before `maxHoldMin`. They are not the same asset, and sorting them into
// one list by `edge` alone let a marginal directional bet outrank a risk-free one -- on the golden
// fixture the top-ranked signal of all ten was a convergence trade on the pair with the thinnest,
// least trustworthy book.
//
// The two are also not independent: arb edge is `gap - (spreadPM + spreadKS)/2 - fees` while the
// convergence edge is at most `gap - spread - fees` on the leg being bought, so on the same pair
// the arb is nearly always the larger number as well as the safe one. Gridded over 158k synthetic
// books, the arb was available alongside a valid convergence candidate in 95,877 cells and was the
// bigger edge in all but 319 of them -- and in those the convergence trade won by at most 0.43c
// (median 0.16c), always off a lopsided spread. Half a cent is not worth an unhedged position, so
// class first, edge second, unconditionally.
const CLASS = { arb: 0, converge: 1 };
const rankSignals = (a, b) => (CLASS[a.type] - CLASS[b.type]) || (b.edge - a.edge);

// Everything one pair offers this cycle. Returns intents; pushes nothing anywhere.
//   fair    volume-weighted fair value
//   best    the best convergence candidate found REGARDLESS of the thresholds -- the tape needs
//           near-misses to answer "how close did we come?", not just "did we trade?". Computed
//           across BOTH venues even where the spread gate makes a venue ineligible to trade, so
//           that a wide-spread pair is distinguishable in the tape from one with no quote at all.
//   veto    the single binding gate that stopped the convergence candidate, or null if the
//           candidate cleared every gate -- which is not the same as "a convergence signal was
//           emitted", because an arb on the same pair outranks and replaces it
//   signals at most ONE intent: the best arb if one exists, otherwise the convergence candidate.
//           Emitting both on the same event stacked a hedged and an unhedged position on one
//           outcome, sized independently, each unaware of the other.
//
// `now` is optional: without it the time-to-close gate is skipped, so a caller that only wants the
// arithmetic (the golden fixture, a test) gets exactly the old behaviour.
function pairSignals(p, cfg, now) {
  const q = p.q;
  const out = { fair: null, best: null, veto: null, signals: [] };
  const fault = quoteFault(q);
  if (fault) { out.veto = fault; return out; }
  // Two books 30c+ apart are two different questions, not a trade (2026-09-24). The fast matcher has
  // always refused such a match (MAX_VENUE_DISAGREE), but the any-market scanner has no such check, and
  // on 2026-09-19 at 12:50Z the desk booked a $67.15 "locked arb" on 'Trump bans more news outlets...
  // Before Oct 1' at Polymarket 0.06/0.07 against Kalshi 0.75/0.85 -- flagged venues_disagree by the
  // scorecard the same second. The Spotify pair (US chart against Kalshi's worldwide one) showed a
  // 62c edge for 25 minutes the next night. Measured between the books, not the mids: one venue's
  // bid over the other's ask. A book 80c wide has a meaningless mid and cannot trip this, while
  // 0.75 bid against 0.07 offered can only mean the pair is wrong. (Not the matcher's mid test with
  // both spreads under maxSpread: the press-ban Kalshi book was 10c wide, so that test would have let
  // it through.) New entries only: a held position on the pair is marked, exited and settled exactly
  // as before. anymarket.afterPricing asks this same function, so such a pair is no longer sent to
  // the rules judge either -- the path that verified the press-ban pair a minute before it traded.
  if (Math.max(q.ksBid - q.pmAsk, q.pmBid - q.ksAsk) > MAX_VENUE_DISAGREE + 1e-9) {
    out.veto = 'venues disagree 30c+: likely different questions';
    return out;
  }

  const ref = p.ks && p.ks.ticker;
  const ksFeeYes = ks.feePerContract(q.ksAsk, cfg.ksFeeRate, ref);
  const ksFeeNo = ks.feePerContract(1 - q.ksBid, cfg.ksFeeRate, ref);
  const rate = pmRate(q, cfg);
  // locked arbs: YES here + NO there must cost < $1 after fees
  const edgeA = 1 - (q.pmAsk + (1 - q.ksBid) + pm.feePerShare(q.pmAsk, rate) + ksFeeNo);
  const edgeB = 1 - (q.ksAsk + (1 - q.pmBid) + pm.feePerShare(1 - q.pmBid, rate) + ksFeeYes);
  let arbs = [];
  if (edgeA >= cfg.minArbEdge) arbs.push({ type: 'arb', pair: p, edge: edgeA, legs: [{ venue: 'PM', side: 'yes', px: q.pmAsk }, { venue: 'KS', side: 'no', px: r2(1 - q.ksBid) }] });
  if (edgeB >= cfg.minArbEdge) arbs.push({ type: 'arb', pair: p, edge: edgeB, legs: [{ venue: 'KS', side: 'yes', px: q.ksAsk }, { venue: 'PM', side: 'no', px: r2(1 - q.pmBid) }] });
  // A locked arb pays its edge at SETTLEMENT, so the edge has to be worth the wait. Outside games the
  // wait is long: J.D. Vance for the 2028 nomination crossed 2.46c after fees on 2026-09-15 and settles
  // 785 days later, about 1.2% a year -- below cash. `arbReturn` annualises the edge on the money the
  // two legs tie up; an arb under ARB_MIN_APR is not taken, and says so.
  if (arbs.length && Number.isFinite(now) && Number.isFinite(p.settlesAt)) {
    const kept = arbs.filter((a) => arbReturn(a.edge, p.settlesAt, now) >= cfg.arbMinApr);
    if (!kept.length) out.arbVeto = 'arb return under hurdle';
    arbs = kept;
  }

  const gap = q.ksMid - q.pmMid; // + => Kalshi rich, Polymarket cheap
  const fair = fairValue(q, cfg);
  out.fair = fair;
  // Price every candidate first and gate afterwards: picking the max then testing it is the same
  // signal as testing each and keeping the max, but it leaves `best` set on pairs that miss.
  let best = null, tradable = null;
  for (const v of ['PM', 'KS']) {
    const bid = v === 'PM' ? q.pmBid : q.ksBid, ask = v === 'PM' ? q.pmAsk : q.ksAsk;
    // epsilon: 0.05 - 0.00 lands at 0.05000000000000004
    const wide = ask - bid > cfg.maxSpread + 1e-9; // do not CHASE into an illiquid book...
    for (const side of ['yes', 'no']) {
      const cand = { venue: v, side, ...convEdge(v, side, q, fair, cfg, ref) };
      if (!best || cand.edge > best.edge) best = cand;              // ...but still record it
      if (!wide && (!tradable || cand.edge > tradable.edge)) tradable = cand;
    }
  }
  out.best = best;

  // Gates in order, reporting the FIRST that binds. Structural properties of the pair come before
  // the economics, so that "edge" is what gets reported once everything else was fine -- which on
  // real tape is the answer essentially every time, and is the project's whole finding.
  //
  // minEdge, not minGap: fair value sits between the two venues, so the realisable edge is a
  // fraction of the gap. Testing it against minGap needed a 6-10c gap to clear a nominal 3c bar,
  // which is why the convergence book never opened a position.
  //
  // `venues too even` is structural too: fair value leans on the venue with more volume, and when
  // neither has more, fair sits in the middle of the gap and the realisable move is half of it --
  // the shape of the desk's largest taker loss. The edge itself is already measured from the entry
  // price to fair (convEdge), never from the gap; this gate is about whether fair means anything.
  const conv = (() => {
    // The book itself may be switched off (config.convergeEnabled). First, so the ledger says so on
    // every pair; the candidate above is still priced and recorded, which is what a tape is for.
    if (cfg.convergeEnabled === false) return { veto: 'convergence book off' };
    // A convergence trade is a bet on the next few hours. If the Kalshi market closes before max
    // hold would end it, the close guard (exitIntent) flattens it first -- the round trip is paid
    // for a position that was never given the time its edge assumes.
    if (Number.isFinite(now) && Number.isFinite(p.closesAt) && p.closesAt - now < (cfg.maxHoldMin + cfg.closeGuardMin) * 60000) return { veto: 'closes inside max hold' };
    if (!(fair > cfg.minMid && fair < cfg.maxMid)) return { veto: 'mid outside band' };
    if (Math.abs(gap) < cfg.minGap) return { veto: 'gap under minGap' };
    const thick = Math.max(q.pmVol || 0, q.ksVol || 0), thin = Math.min(q.pmVol || 0, q.ksVol || 0);
    // thin === 0 used to auto-pass here: `thick < ratio * 0` is never true, so a venue with no
    // reported 24h volume at all read as "infinitely thin," which this gate was written to treat
    // as maximally trustworthy on the other side. In practice zero volume means that market is not
    // trading, not that the other venue's price should be leaned on alone -- three of one week's
    // thirteen convergence losses (Huon Valley Mayoral, Core CPI, and one of two "The Drama"
    // entries, which was 0-vs-0 on both venues) cleared this gate for exactly that reason.
    if (thin === 0) return { veto: 'no volume on one venue' };
    if (thick < cfg.convMinVolRatio * thin) return { veto: 'venues too even' };
    if (!tradable) return { veto: 'spread over maxSpread' };
    if (tradable.edge < cfg.minEdge) return { veto: 'edge under minEdge' };
    return { signal: { type: 'converge', pair: p, edge: tradable.edge, gap, fair, legs: [{ venue: tradable.venue, side: tradable.side, px: tradable.px }] } };
  })();
  out.veto = conv.veto || null;

  // One intent per pair. An arb is strictly better than a convergence trade on the same event --
  // it is the same view with the risk removed -- so it wins outright when both are available.
  if (arbs.length) { arbs.sort(rankSignals); out.signals.push(arbs[0]); }
  else if (conv.signal) out.signals.push(conv.signal);
  return out;
}

// Annualised return of a locked arb: `edge` per $1 of payout, on the (1 - edge) the legs cost, over
// the days until the pair is expected to settle (floored at one day, so a game settling tonight is
// not an infinite return that sorts ahead of everything).
function arbReturn(edge, settlesAt, now) {
  const days = Math.max(1, (settlesAt - now) / 86400000);
  return (edge / Math.max(0.01, 1 - edge)) * (365 / days);
}

// Every pair, gated and ranked. `now` is passed in rather than read, so a replay can lie about it.
// `rejects` counts why pairs produced nothing, so "the desk took no trades" is always accompanied
// by which rail it died on rather than requiring a debugger to find out.
function scan(pairs, cfg, now) {
  const signals = [];
  let widest = null, inPlayN = 0, staleN = 0;
  const fair = new Map(), best = new Map(), veto = new Map();
  const rejects = new Map();
  const reject = (why) => rejects.set(why, (rejects.get(why) || 0) + 1);
  for (const p of pairs) {
    const q = p.q;
    if (!q) { reject('no quote'); continue; }
    // Per-instrument staleness. A desk-wide clock keeps advancing as long as the venue calls
    // succeed, so one pair that quietly stopped repricing stayed tradeable while the dashboard
    // read "data age 0s". Quotes carry their own observation time; trust that. Checked BEFORE
    // in-play so the counts match what the desk reported before this was extracted.
    if (q.t && now - q.t > cfg.maxDataAgeSec * 1000) { staleN++; reject('stale quote'); continue; }
    // untradeable once the event is live or its market is about to close (liveWindow): listings
    // lag live play and a scheduled print by far more than any gap is worth
    if (p.inPlay) { inPlayN++; reject('in-play'); continue; }
    const r = pairSignals(p, cfg, now);
    fair.set(p.id, r.fair); best.set(p.id, r.best);
    // A pair that could not be priced at all never becomes `widest`: a crossed or non-finite book
    // reports whatever garbage gap its mids imply, and `widest` is what the desk narrates.
    // Watch-only pairs are not candidates for `widest`, which is what BRAM narrates as the desk's
    // biggest opportunity: a pair whose rules are unverified is exactly where a look-alike with a
    // wide, meaningless gap sits (Serbia's next PM, 24c apart on 2026-09-15, rules unchecked).
    if (r.fair != null && !p.watchOnly) {
      const gap = q.ksMid - q.pmMid;
      if (!widest || Math.abs(gap) > Math.abs(widest.gap)) widest = { p, gap, q };
    }
    // Only a pair that produced NOTHING is a rejection. `veto` describes the convergence candidate
    // specifically, and an arb on the same pair outranks and replaces it -- counting that as a
    // rejection put a pair the desk actually traded into the ledger, and stamped a veto onto its
    // tape line. The ledger exists to answer "why did nothing trade"; a pair that traded is not
    // part of that answer.
    // A pair the rules gate has not verified is priced like any other -- the tape needs its
    // near-misses -- but it never emits a signal. Its resolution rules may differ from its
    // counterpart's, and a pair whose two contracts settle differently is not an arb at all.
    if (p.watchOnly) {
      const why = `rules ${p.watchOnly}`;
      veto.set(p.id, why); reject(why); continue;
    }
    // An arb that existed and was stopped by its lock-up is the more useful thing to report than
    // whatever gate stopped the convergence candidate on the same pair.
    const why = r.arbVeto && !r.signals.length ? r.arbVeto : r.veto;
    if (why && !r.signals.length) { veto.set(p.id, why); reject(why); }
    for (const s of r.signals) signals.push(s);
  }
  signals.sort(rankSignals);
  return { signals, widest, inPlayN, staleN, fair, best, veto, rejects };
}

// Is this pair live, or about to be decided? Either way it is untradeable, and a convergence
// position on it is flattened. Two rules, either of which is enough:
//   - a game from 2 minutes before its start (listings lag live play by far more than any gap);
//   - ANY pair from closeGuardMin before its Kalshi market closes. Scheduled prints close their
//     Kalshi market just before the number lands (the Fed at 17:59Z for an 18:00Z statement, CPI
//     at 12:25Z for 12:30Z) while Polymarket keeps trading through it.
// Close time never REPLACES the game rule: a Kalshi game market closes days after the game.
// Pure; stamped in HOLT because RIGO reads it before BRAM runs.
function liveWindow(pair, now, cfg) {
  if (pair.kind === 'game' && (!pair.startsAt || now >= pair.startsAt - 120000)) return true;
  return Number.isFinite(pair.closesAt) && now >= pair.closesAt - cfg.closeGuardMin * 60000;
}

// Should this position be closed, and why? Pure: the caller has already marked it.
// Order matters and is deliberate: the CLOCK-DRIVEN exits come first and do not require a quote.
// Nested behind a quote check (the old behaviour) a position whose pair stopped being rebuilt was
// never stopped out and never timed out -- it was carried to resolution unmanaged.
function exitIntent(pos, pair, cfg, now) {
  if (pos.strategy !== 'converge') return null;
  const q = pair && pair.q;
  const heldMin = (now - pos.openedAt) / 60000;
  // One mark for every branch. The price exits below used to read `pos.mark` directly while the
  // time exits read this fallback, so a position the caller had not marked yet exited at `px:
  // undefined` (booking a NaN) and could never stop out, because `undefined - entry` is NaN and
  // NaN fails every comparison silently.
  const mark = pos.mark ?? pos.entry;
  const c = (x) => `${(x * 100).toFixed(1)}c`;
  if (heldMin >= cfg.maxHoldMin) {
    return { px: mark, reason: `max hold ${cfg.maxHoldMin}m reached${q ? `, gap still ${c(Math.abs(q.ksMid - q.pmMid))}` : ' (no live quote)'}` };
  }
  // The position carries its market's close time from entry, so this fires even when the pair
  // itself is gone -- and the pair is exactly what disappears when a Kalshi market closes.
  if (Number.isFinite(pos.closesAt) && now >= pos.closesAt - cfg.closeGuardMin * 60000) {
    const mins = Math.max(0, Math.round((pos.closesAt - now) / 60000));
    return { px: mark, reason: `market closes in ${mins}m, flattening directional risk` };
  }
  if (pair && pair.inPlay) return { px: mark, reason: 'event going live, flattening directional risk' };
  if (!q) return null; // held on the last mark; the time exits above stay armed
  const gap = Math.abs(q.ksMid - q.pmMid);
  const perContract = mark - pos.entry;
  // A fixed 6c stop is meaningful on a 60c contract and almost useless on a 6c contract. Paper
  // mode therefore adds a proportional stop and uses whichever threshold is tighter. This is
  // deliberately not applied to live mode: changing funded-account exits needs explicit review.
  const pctStop = cfg.mode === 'paper' && cfg.paperStopLossPct > 0
    ? pos.entry * cfg.paperStopLossPct
    : Infinity;
  const stopAt = Math.min(cfg.stopLoss, pctStop);
  if (gap <= cfg.exitGap) return { px: mark, reason: `gap closed to ${c(gap)}, held ${Math.round(heldMin)}m` };
  if (perContract <= -stopAt) {
    const pct = pos.entry > 0 ? Math.abs(perContract / pos.entry) : 0;
    return { px: mark, reason: `stop: mark ${c(perContract)} vs entry (${(pct * 100).toFixed(1)}% loss, ${c(stopAt)} limit)` };
  }
  return null;
}

// After a meaningful gain, protect part of the best mark while leaving a runner open. The caller
// persists `gainPeak`/`gainLockDone`; this remains pure and paper-only so live exits are unchanged.
function gainLockIntent(pos, cfg) {
  if (!pos || pos.strategy !== 'converge' || cfg.mode !== 'paper' || pos.gainLockDone) return null;
  const entry = Number(pos.entry), mark = Number(pos.mark), peak = Number(pos.gainPeak);
  if (!(entry > 0) || !Number.isFinite(mark) || !Number.isFinite(peak)) return null;
  const trigger = entry * (1 + Math.max(0, cfg.gainLockTriggerPct || 0));
  if (peak < trigger) return null;
  const floor = peak - entry * Math.max(0, cfg.gainLockGivebackPct || 0);
  if (mark > floor) return null;
  const retain = Math.max(0.1, Math.min(0.9, cfg.gainLockRetainPct == null ? 0.5 : cfg.gainLockRetainPct));
  const qty = Math.max(1, Math.floor(pos.qty * (1 - retain)));
  if (qty >= pos.qty) return null;
  return { qty, floor, peak, reason: `gain lock: sold ${qty}, retained ${pos.qty - qty} runner` };
}

// Should a locked arb be unwound early? Both legs sold at their bids pay `bidSum` a pair now,
// against $1 a pair at resolution for free -- so the gain from unwinding is (bidSum - 1) x qty,
// LESS the taker fee the Kalshi leg pays on the way out. The old test, `bidSum > 1.005`, ignored
// that fee: on the cloud box it unwound three pairs for $1-3 that would have settled for $2-6.
// Pure, like exitIntent: returns what to do and why, or null.
function arbUnwind(legs, cfg) {
  if (legs.length !== 2 || !legs.every((l) => l.mark != null)) return null;
  const qty = Math.min(legs[0].qty, legs[1].qty);
  const bidSum = legs[0].mark + legs[1].mark;
  // The Polymarket leg pays its own market's taker fee on the way out too, at the rate recorded on
  // the position when it opened (older positions carry none and are billed at the fallback).
  const fee = legs.reduce((a, l) => a + (l.venue === 'KS' ? ks.fee(l.qty, l.mark, cfg.ksFeeRate, l.ref) : r2(pm.fee(l.qty, l.mark, Number.isFinite(l.feeRate) ? l.feeRate : cfg.pmFeeFallback))), 0);
  const gain = r2((bidSum - 1) * qty - fee);
  if (gain < cfg.arbUnwindMargin * qty) return null;
  return { gain, fee, bidSum, reason: `early unwind, bids sum ${bidSum.toFixed(3)}, +$${gain.toFixed(2)} over holding after $${fee.toFixed(2)} exit fee` };
}

// arbUnwind re-priced on the books a sale would actually walk, before anything is sold. arbUnwind
// sums the two marks for the whole quantity -- a listing bid with no depth behind it, and for a
// Polymarket leg whose pair has gone, Gamma's slow price. On 2026-09-23 it read "bids sum 1.030,
// +$1.38 over holding" on Oscars Best Picture Noms - The Debut (187 lots): the Kalshi leg sold, the
// Polymarket leg then failed 180 times in 45 minutes ("no bids inside limit") and finally went 5-7c
// lower, and the group made -$8.75 against +$1.52 held to settlement. The three unwinds since sales
// began walking the real book (#100, 2026-09-21) netted -$8.06 against holding.
//
// `ladders[i]` is leg i's exit ladder (engine.exitLadder): the OTHER side's asks, so an ask at a is
// a sale at 1-a. Each is walked only down to mark - slipLimit, exactly as PaperBroker.sell walks it.
// The quantity is what BOTH ladders can absorb, and each leg's fee is charged at its own average sale
// price. Returns null when a ladder is missing, when that quantity is under the 5-lot floor, or when
// the gain is under arbUnwindMargin a contract. `first` is the thinner leg, which RIGO sells first:
// if that sale fails, nothing else has been sold and the arb is still whole.
function arbUnwindLive(legs, ladders, cfg) {
  if (legs.length !== 2 || !legs.every((l) => l.mark != null)) return null;
  if (!Array.isArray(ladders) || ladders.length !== 2 || !ladders.every(Array.isArray)) return null;
  const want = Math.min(legs[0].qty, legs[1].qty);
  const inside = legs.map((l, i) => ladders[i].filter((a) => a.price <= 1 - (l.mark - cfg.slipLimit) + 1e-9));
  const depth = inside.map((lv) => Math.floor(lv.reduce((a, x) => a + x.size, 0)));
  const qty = Math.min(want, depth[0], depth[1]);
  if (!(qty >= 5)) return null;
  const px = inside.map((lv) => {
    let left = qty, cost = 0;
    for (const x of lv) { const take = Math.min(left, x.size); cost += take * x.price; left -= take; if (left <= 1e-9) break; }
    return 1 - cost / qty;
  });
  const fee = legs.reduce((a, l, i) => a + (l.venue === 'KS' ? ks.fee(qty, px[i], cfg.ksFeeRate, l.ref) : r2(pm.fee(qty, px[i], Number.isFinite(l.feeRate) ? l.feeRate : cfg.pmFeeFallback))), 0);
  const bidSum = px[0] + px[1];
  const gain = r2((bidSum - 1) * qty - fee);
  if (gain < cfg.arbUnwindMargin * qty) return null;
  const first = depth[0] !== depth[1] ? (depth[0] < depth[1] ? 0 : 1) : (legs[1].venue === 'PM' ? 1 : 0);
  return { qty, gain, fee, bidSum, first, reason: `early unwind of ${qty}${qty < want ? ` of ${want}` : ''}, live books sum ${bidSum.toFixed(3)}, +$${gain.toFixed(2)} over holding after $${fee.toFixed(2)} exit fee` };
}

// Which halt, if any, applies. The operator's latched halt outranks every automatic check.
function riskState({ operatorHalt, age, drawdown, errs, mode, liveReady, cfg }) {
  if (operatorHalt) return operatorHalt;
  if (!Number.isFinite(age)) return 'no quotes yet';
  if (age > cfg.maxDataAgeSec) return `stale data (${Math.round(age)}s old)`;
  if (drawdown >= cfg.maxDailyDrawdownPct) return `daily drawdown ${(drawdown * 100).toFixed(1)}% hit the ${(cfg.maxDailyDrawdownPct * 100).toFixed(0)}% limit`;
  if (errs >= cfg.maxApiErrors) return `${errs} API errors in 5m`;
  if (mode === 'live' && !liveReady) return 'live venue not authenticated';
  return null;
}

// Flow read for one pair: is the venue gap narrowing or widening?
function biasFor(history, cfg) {
  if (!history || history.length < 3) return null;
  const a = history[Math.max(0, history.length - cfg.biasLookback)], b = history[history.length - 1];
  const gapThen = a.ksMid - a.pmMid, gapNow = b.ksMid - b.pmMid;
  const raw = (Math.abs(gapThen) - Math.abs(gapNow)) / Math.max(0.01, Math.abs(gapThen));
  const score = Math.max(-1, Math.min(1, raw)); // +1 converging, -1 diverging
  // Only meaningful if there was a gap to begin with. With the 0.01 floor in the denominator a
  // pair whose gap opened from ~0 to 2c scores -1 ("diverging") -- but a freshly opened gap is
  // exactly the convergence setup, so that veto threw away the only trades this book exists for.
  const mins = Number.isFinite(b.t) && Number.isFinite(a.t) ? Math.round((b.t - a.t) / 60000) : null;
  return { score, reliable: Math.abs(gapThen) >= cfg.minGap, pmDrift: b.pmMid - a.pmMid, ksDrift: b.ksMid - a.ksMid, gapNow, mins };
}

// Has this gap been sitting still, wide, for a long time? Then it is not a mispricing waiting to
// close -- it is what the two venues simply think this market is worth, and the desk has no reason
// to expect it to move today.
//
// This is the gate the week of 2026-09-10 argued for. `biasFor` already vetoes a gap that is
// WIDENING, and sizes down one that is flat, but flat was the whole problem: of 67 convergence
// trades, 40 ran to max hold and 39 of those lost. The clearest case is Presidential 2028 - AOC,
// opened EIGHT times over three days on a gap that read 4.0c, 3.9c, 4.0c, 3.9c, 3.9c, 3.9c, 3.8c
// while the price moved 0.2c. Every one paid a ~1.8c round trip to rent a gap that never intended
// to close. `biasFor` scored it ~0 -- neither converging nor diverging -- so it passed every time.
//
// Deliberately NOT a bias threshold. A freshly opened gap scores -1 and is exactly the setup this
// book exists for (see biasFor's own note), so the test is not "which way is it moving" but "has
// it EVER been narrow in the window I can see". A gap that opened from nothing an hour ago has a
// narrow sample behind it and passes; one that has been 4c for the whole window does not.
//
// Answers only the question it is named for. "Not enough history to say" is a DIFFERENT question
// and belongs to `gapUnseen` below, which is what KETT actually acts on first.
// Returns the veto reason, or null.
function standingGap(history, cfg) {
  if (!history || history.length < 3) return null;
  const first = history[0], last = history[history.length - 1];
  if (!Number.isFinite(first.t) || !Number.isFinite(last.t)) return null;
  const mins = (last.t - first.t) / 60000;
  if (mins < cfg.standingGapMin) return null;                     // not enough seen yet
  let lo = Infinity, hi = -Infinity;
  for (const h of history) {
    const g = Math.abs(h.ksMid - h.pmMid);
    if (!Number.isFinite(g)) return null;                          // a torn sample: do not judge
    if (g < cfg.minGap) return null;                               // it HAS been narrow: tradeable
    if (g < lo) lo = g;
    if (g > hi) hi = g;
  }
  if (hi - lo > cfg.standingGapRange) return null;                 // it moves, even if it stays wide
  return `gap has stood at ${(lo * 100).toFixed(1)}c for ${Math.round(mins)}m without moving`;
}

// Have we watched this pair long enough to have any opinion about its gap? A convergence trade is
// a bet that a gap will MOVE, and that bet cannot be made off a book you have never seen move.
//
// This exists because of what the desk did on 2026-09-18 at 21:01Z. It restarted, `E.history` came
// back empty, and within the same minute it opened three convergence positions -- Wisconsin
// Governor, Maine Senate, Balance of Power -- on gaps it had never observed. They cost $56.39, the
// three largest convergence losses of that week, and RIGO's mind closed two of them with the
// verdict "gap unchanged at 4c through 220 of 240 min". The gap had been standing the whole time.
// The desk simply had no way to know, because the only evidence lived in a Map that a restart had
// just emptied.
//
// So the warm-up bar is not caution, it is the same veto as `standingGap` arriving in time to be
// worth something. Replayed over 2026-09-10..20 it takes the veto from 19 trades and $192.93 to 29
// trades and $319.02 -- $126 more -- and kills no additional winner. The cost is that the desk
// takes no convergence trade for the first `standingGapMin` after a restart, on a book whose every
// measured week has lost money; the arb book, which is hedged and does not care which way a gap
// moves, is untouched by this.
//
// Returns the veto reason, or null once the pair has been watched long enough to judge.
function gapUnseen(history, cfg) {
  if (!(cfg.standingGapMin > 0)) return null;                     // the bar is switched off
  const span = history && history.length >= 2
    && Number.isFinite(history[0].t) && Number.isFinite(history[history.length - 1].t)
    ? (history[history.length - 1].t - history[0].t) / 60000
    : 0;
  if (!history || history.length < 3 || span < cfg.standingGapMin) {
    return `pair watched for ${Math.round(span)}m of the ${cfg.standingGapMin}m needed to judge its gap`;
  }
  return null;
}

// Is there room in the book for this signal? Unhedged convergence positions and locked arbs are
// counted separately, and an arb counts once rather than once per leg: one limit over legs let six
// hedged Fed arbs fill a book whose limit was written for directional bets. Returns why not, or null.
//
// Long-dated arbs have a smaller budget of their own: money locked for months cannot be used for
// anything else, and a book of year-long arbs would be full for a year. `now` is optional; without
// it the long-dated budget is not checked.
function bookFull(positions, signal, cfg, now) {
  if (signal.type === 'arb') {
    const arbLegs = positions.filter((p) => p.strategy === 'arb');
    const groups = new Set(arbLegs.map((p) => p.group)).size;
    if (groups + 1 > cfg.maxArbGroups) return `arb book full at ${groups} arbs`;
    const longMs = cfg.longDays * 86400000;
    const settles = signal.pair && signal.pair.settlesAt;
    if (Number.isFinite(now) && Number.isFinite(settles) && settles - now > longMs) {
      const longGroups = new Set(arbLegs.filter((p) => Number.isFinite(p.settlesAt) && p.settlesAt - now > longMs).map((p) => p.group)).size;
      if (longGroups + 1 > cfg.maxLongArbGroups) return `long-dated arb budget full at ${longGroups} arbs settling after ${cfg.longDays} days`;
    }
    return null;
  }
  const open = positions.filter((p) => p.strategy !== 'arb').length;
  return open + signal.legs.length > cfg.maxOpenPositions ? `book full at ${open} positions` : null;
}

// How many contracts, given a budget and the depth actually resting inside the limit.
//
// `budget` is a CAP, not a target. ILSA's conviction multiplier used to be applied on top of it
// (`budget * 1.25`), which quietly took a position to 2.5% of equity against a `maxPositionPct`
// of 2% and a README that promises 2% -- a rail is not a rail if a sentiment read can lift it.
// The multiplier now scales WITHIN the cap and `capped` reports when that bound was the binding
// constraint, so sizing up is a preference that the risk limit still outranks.
function sizePlan(signal, { budget, sizeMult = 1, books, cfg }) {
  const ref = signal.pair && signal.pair.ks && signal.pair.ks.ticker;
  const rate = pmRate(signal.pair && signal.pair.q, cfg);
  const unitCost = signal.legs.reduce((a, l) => a + l.px, 0)
    + signal.legs.reduce((a, l) => a + (l.venue === 'KS' ? ks.fee(1, l.px, cfg.ksFeeRate, ref) : pm.feePerShare(l.px, rate)), 0);
  // A leg priced at 0 (or a book that reported one) makes unitCost 0 and `budget / 0` Infinity,
  // which floors to Infinity and sizes the whole account into one contract-less order.
  if (!(unitCost > 0)) return { qty: 0, unitCost, capped: false, reason: 'unit cost is not positive' };
  const wanted = budget * sizeMult;
  const spend = Math.min(wanted, budget);
  let qty = Math.floor(spend / unitCost);
  let limited = null;
  for (let i = 0; i < signal.legs.length; i++) {
    const limit = signal.legs[i].px + cfg.slipLimit;
    const depth = Math.floor((books[i].asks || []).filter((l) => l.price <= limit + 1e-9).reduce((a, l) => a + l.size, 0));
    if (depth < qty) { qty = depth; limited = signal.legs[i].venue; }
  }
  return { qty: Math.max(0, qty), unitCost, capped: wanted > budget, reason: limited ? `${limited} depth inside limit` : null };
}

// Persistence: a signal on a pair from the any-market scanner must be seen on `entryPersistCycles`
// consecutive cycles before it is acted on. A listing that lags its book produces a one-cycle
// "gap"; a real disagreement is still there a minute later. `counts` is the previous cycle's map
// (pairId -> consecutive cycles); returns the signals to act on and the map for next cycle. Games
// and Fed pairs keep their old behaviour, so replays of existing tapes do not change.
function persistFilter(signals, counts, cfg) {
  const next = new Map();
  const kept = [];
  for (const s of signals) {
    const id = s.pair.id;
    const n = (counts.get(id) || 0) + 1;
    next.set(id, n);
    if (s.pair.kind !== 'event' || n >= cfg.entryPersistCycles) kept.push(s);
  }
  return { kept, counts: next };
}

// Re-price a locked arb from the books actually fetched for its legs, before any money moves. The
// signal was priced from listing quotes, which lag. `books[i].asks` is the ask ladder for leg i's
// side, best first. Returns the live edge per contract, or null when a leg has no ask.
function arbEdgeLive(signal, books, cfg) {
  const ref = signal.pair && signal.pair.ks && signal.pair.ks.ticker;
  const rate = pmRate(signal.pair && signal.pair.q, cfg);
  let cost = 0;
  for (let i = 0; i < signal.legs.length; i++) {
    const top = books[i] && books[i].asks && books[i].asks[0];
    if (!top || !(top.price > 0 && top.price < 1)) return null;
    const l = signal.legs[i];
    cost += top.price + (l.venue === 'KS' ? ks.feePerContract(top.price, cfg.ksFeeRate, ref) : pm.feePerShare(top.price, rate));
  }
  return 1 - cost;
}

// ---------------------------------------------------------------- the settlement snipe
// Polymarket settles a game the moment it ends: its book goes to 99/100 on the winner (bids at 99c,
// nothing offered) and the market closes seconds later. On the 2026-09-19 → 09-22 tape Kalshi's book
// for the same game was still offering the winner 3c to 13c under par in ten of about 180 game pairs,
// on quotes a second or two old, for at least the 15-30 seconds the desk could still see the pair
// (tools/settle-lag.js). It is the one Kalshi-only edge the tape has shown, and the desk never took
// it: in-play pairs are excluded from every other rule, and the pair was dropped the cycle Polymarket
// closed. So: when Polymarket has settled, buy the winner on Kalshi at the ask -- if Kalshi already
// agrees on the winner (a 44c book on a "settled" game is a mismatched pair or a game still being
// played, not an edge; the wrong-game case was the Rays-Yankees doubleheader on 2026-09-22, where
// Polymarket's game-1 market paired with Kalshi's game 2), the Kalshi quote is fresh, and what is left
// after the fee clears the bar. Pure. Returns the signal, a { veto } when Polymarket reads settled and
// a gate said no, or null when there is nothing to say.
//
// A 99c/1.00 Polymarket reading is NOT a settlement, only a reason to ask (2026-09-24). On 2026-09-19
// NC State v Vanderbilt read 0.99/1 for 2m15s from 20:13Z with Kalshi at 94/96, then traded back to
// 86c and 4c; NC State lost (Kalshi finalized "no"), and this signal would have bought 100 at 96c.
// Temple did the same that day. So this signal only says "look": KETT buys only once Polymarket's own
// market record says closed or resolved (agents.js). Every snipe edge measured so far was seen while
// Polymarket was still open, so the edge after a real close has to be measured again; the first
// Sunday with the check (09-27) may show little or none.
function snipeEdge(px, ref, cfg) { return 1 - px - ks.feePerContract(px, cfg.ksFeeRate, ref); }
function snipeSignal(pair, cfg, now) {
  if (!cfg.snipe || !pair || pair.kind !== 'game' || !pair.inPlay || !pair.q) return null;
  const q = pair.q;
  const yesWon = q.pmBid >= cfg.snipePmBid - 1e-9 && q.pmAsk >= 0.999;
  const noWon = q.pmBid <= 0.001 && q.pmAsk <= 1 - cfg.snipePmBid + 1e-9;
  if (!yesWon && !noWon) return null;
  const pmAge = now - (q.pmAt || q.t || 0);
  if (!(pmAge <= cfg.snipeHoldSec * 1000)) return { veto: 'the settlement was seen too long ago' };
  if (!Number.isFinite(q.ksAt) || now - q.ksAt > cfg.snipeMaxKsAgeSec * 1000) return { veto: 'kalshi quote stale' };
  const side = yesWon ? 'yes' : 'no';
  const px = yesWon ? q.ksAsk : 1 - q.ksBid;      // buy the winner: YES at the ask, NO at one minus the YES bid
  const agree = yesWon ? q.ksBid : 1 - q.ksAsk;    // what Kalshi already pays for the winner
  if (!(agree >= cfg.snipeMinKsPrice)) return { veto: `kalshi bids ${(agree * 100).toFixed(0)}c for the winner: not the same game, or not over` };
  const edge = snipeEdge(px, pair.ks && pair.ks.ticker, cfg);
  if (!(edge >= cfg.snipeMinEdge)) return { veto: `${(edge * 100).toFixed(1)}c net after the fee` };
  const size = yesWon ? q.ksAskSize : q.ksBidSize;
  return { type: 'snipe', pair, legs: [{ venue: 'KS', side, px }], edge, size: Number.isFinite(size) ? size : null, won: side };
}
// HOLT rebuilds the pair list from the venues' listings every cycle, and Polymarket's listing drops a
// game the cycle it closes -- the cycle the snipe needs it. The in-play game pairs that just vanished
// are kept for snipeHoldSec, flagged pmGone with when they went; engine.quote keeps their Kalshi side
// live. Pure: prev is last cycle's pairs by id, pairs is this cycle's list.
function keepClosedGamePairs(prev, pairs, cfg, now) {
  if (!cfg.snipe) return [];
  const have = new Set(pairs.map((p) => p.id));
  const kept = [];
  for (const [id, p] of prev) {
    if (have.has(id) || !p || p.kind !== 'game' || !p.inPlay || !p.q) continue;
    const goneAt = p.pmGoneAt || now;
    if (now - goneAt > cfg.snipeHoldSec * 1000) continue;
    kept.push({ ...p, pmGone: true, pmGoneAt: goneAt });
  }
  return kept;
}

module.exports = { fairValue, quoteFault, snipeEdge, snipeSignal, keepClosedGamePairs, convEdge, pairSignals, scan, liveWindow, exitIntent, gainLockIntent, arbUnwind, arbUnwindLive, arbReturn, arbEdgeLive, riskState, biasFor, standingGap, gapUnseen, bookFull, persistFilter, sizePlan, rankSignals, pmRate };

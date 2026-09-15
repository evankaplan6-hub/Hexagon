'use strict';
// The six desks. Each gathers a view, asks src/decide.js what to do, and applies the answer.
// Every decision -- what is a signal, what exits, how big -- lives in decide.js as a pure
// function of explicit inputs, so the same logic can be replayed against a recorded tape
// (tools/replay.js) instead of a live network. The desks own I/O, logging and sequencing only;
// the engine remains the sole mutator of cash and positions.
//   HOLT  scanner    — discovers matched pairs across venues
//   ILSA  sentiment  — reads flow: drift and gap tendency per pair
//   TESS  ops        — health, budget, drawdown, halt switch
//   RIGO  settlement — marks, exits, resolutions, realizes P&L
//   BRAM  pricing    — fair value + signals (locked arbs, convergence gaps)
//   KETT  execution  — turns signals into fills within TESS's budget
const ks = require('./venues/kalshi');
const { matchPairs } = require('./matcher');
const http = require('./http');
const decide = require('./decide');
const minds = require('./minds');
const { fairValue, convEdge } = decide;

const r2 = (x) => Math.round(x * 100) / 100;
const c = (x) => `${(x * 100).toFixed(1)}c`; // dollars -> cents string
const money = (x) => `$${Math.abs(x).toFixed(2)}`;
const VEN = { PM: 'Polymarket', KS: 'Kalshi' };
const other = (v) => (v === 'PM' ? 'KS' : 'PM');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ambiguousOrder = (e) => !!(e && (e.ambiguousOrder || e.code === 'KALSHI_ORDER_UNKNOWN'));

// TESS updates E.halt once per cycle, but an operator flatten can arrive while KETT is awaiting a
// fresh book or exchange response. Consult the latched field directly at every await boundary.
function entryHalt(E) {
  if (E.operatorHalt) return E.operatorHalt;
  if (E.halt) return E.halt;
  if (E.cfg.mode === 'live' && !E.liveReady) return 'live venue not authenticated';
  return null;
}

function standDown(E) {
  const halt = entryHalt(E);
  if (halt) E.touch('KETT', 'standing down');
  return halt;
}

// ---------------------------------------------------------------- HOLT
function HOLT(E) {
  const prev = new Map(E.pairs.map((p) => [p.id, p]));
  const { pairs, rejected } = matchPairs([...E.quotes.pm.values()], [...E.quotes.ks.values()]);
  for (const p of pairs) if (prev.has(p.id)) p.q = prev.get(p.id).q; // keep last quote until repriced
  // A pair is untradeable once its event is live or its Kalshi market is about to close
  // (decide.liveWindow: games from 2 minutes before start, every pair from CLOSE_GUARD_MIN before
  // close). This has to be stamped here, not in BRAM: HOLT rebuilds `pairs` from scratch every
  // cycle and only carries `q` across, so a flag set later in the cycle is gone by the next one —
  // and RIGO, which reads it to flatten directional risk, runs BEFORE BRAM. Set there, it was
  // always undefined. It used to be games-only, so a Fed pair stayed tradeable up to the minute
  // Kalshi closed it ahead of the statement.
  const now = Date.now();
  for (const p of pairs) p.inPlay = decide.liveWindow(p, now, E.cfg);
  E.pairs = pairs;
  E.rejected = rejected;
  const added = pairs.filter((p) => !prev.has(p.id));
  const dropped = [...prev.keys()].filter((id) => !pairs.some((p) => p.id === id));
  const seriesN = new Set(pairs.map((p) => p.series)).size;
  E.touch('HOLT', `${pairs.length} pairs / ${seriesN} series`);
  if (added.length || dropped.length || E.due('holt-log', 600)) {
    let txt = `${pairs.length} pairs live across ${seriesN} series · ${E.quotes.pm.size} PM + ${E.quotes.ks.size} KS markets scanned`;
    if (added.length) txt += ` · +${added.length} new: ${added.slice(0, 2).map((p) => p.label).join(', ')}${added.length > 2 ? '…' : ''}`;
    if (dropped.length) txt += ` · −${dropped.length} closed`;
    if (rejected.length) {
      const figs = rejected.filter((r) => r.why === 'figures').length;
      txt += ` · ${rejected.length} rejected (${rejected.length - figs} on 30c+ disagreement, ${figs} on a mismatched figure)`;
    }
    E.log('HOLT', 'SCAN', null, txt);
  }
}

// ---------------------------------------------------------------- ILSA
// The first desk with a mind. The deterministic read below runs unconditionally and is what the
// desk falls back to; Claude's read is an OVERLAY on top of it, never a replacement, so a missing
// key or a timed-out turn costs nothing but the judgement.
//
// The call is fired, not awaited. `E.brain.advice` returns the last COMPLETED answer, which on a
// 15s cycle and a multi-second turn is typically one or two cycles old -- fine for a flow read,
// which is a claim about minutes, and the reason this desk went first.
function ILSA(E) {
  let top = null;
  for (const p of E.pairs) {
    const bias = decide.biasFor(E.history.get(p.id), E.cfg);
    if (!bias) continue;
    E.bias.set(p.id, bias);
    const move = Math.abs(bias.pmDrift) + Math.abs(bias.ksDrift);
    if (!top || move > top.move) top = { p, bias, move };
  }

  if (E.brain && E.brain.enabled()) {
    // No cadence check here on purpose. Whether a turn is worth buying is a question about the
    // BOARD, not about the clock, and it is answered by the view -- which returns null on a quiet
    // floor and a signature otherwise. src/brain.js owns the budget and the minimum gap.
    E.brain.refresh('ILSA', () => minds.ILSA.view(E));
    const answer = E.brain.advice('ILSA');
    if (answer) {
      const { reads, proposals, dropped } = minds.ILSA.apply(E, answer);
      // Attach the mind's read to the deterministic one rather than overwriting it. KETT reads
      // both and states which it acted on, so a bad turn is legible in the log afterwards.
      for (const [id, r] of reads) {
        const b = E.bias.get(id);
        if (b) b.llm = r; else E.bias.set(id, { score: 0, reliable: false, llm: r });
      }
      E.brainSignals = proposals;
      const note = String(answer.note || '').slice(0, 30);
      E.touch('ILSA', note || 'reading flow');
      if (answer.commentary && E.due('ilsa-mind', 90)) {
        E.log('ILSA', 'RESEARCH', null, `${String(answer.commentary).slice(0, 300)}${proposals.length ? ` · proposing ${proposals.length}` : ''}`);
      }
      // Say when a proposal was thrown away and why. A mind that keeps proposing into a rail is
      // either misreading the view or the view is lying to it, and neither shows up anywhere else.
      if (dropped.length && E.due('ilsa-dropped', 300)) {
        E.log('ILSA', 'PASS', null, `${dropped.length} proposal${dropped.length > 1 ? 's' : ''} dropped · ${dropped.map((d) => d.why).join(', ').slice(0, 160)}`);
      }
      for (const s of proposals) {
        if (E.due(`ilsa-prop-${s.pair.id}`, 600)) {
          E.log('ILSA', 'RESEARCH', null, `proposes ${s.legs[0].side.toUpperCase()} @ ${VEN[s.legs[0].venue]} ${s.pair.label} · edge ${c(s.edge)} · conviction ${(s.conviction * 100).toFixed(0)}% · ${s.thesis}`);
        }
      }
      return;
    }
  }
  E.brainSignals = [];

  E.touch('ILSA', top ? `${top.p.label} ${top.bias.score > 0 ? 'converging' : 'diverging'}` : 'reading flow');
  if (top && E.due('ilsa-log', 90)) {
    const { p, bias } = top;
    const q = p.q || {};
    const sgn = (x) => (x >= 0 ? '+' : '−') + c(Math.abs(x));
    E.log('ILSA', 'RESEARCH', null,
      `${p.label}: PM ${sgn(bias.pmDrift)}, KS ${sgn(bias.ksDrift)} over ${bias.mins}m · gap ${c(Math.abs(bias.gapNow))} ${bias.score > 0.1 ? 'narrowing' : bias.score < -0.1 ? 'widening' : 'steady'} · vol24 PM $${Math.round(q.pmVol || 0).toLocaleString()} / KS $${Math.round(q.ksVol || 0).toLocaleString()}`);
  }
}

// ---------------------------------------------------------------- TESS
function TESS(E) {
  const age = E.lastQuoteAt ? (Date.now() - E.lastQuoteAt) / 1000 : Infinity;
  const eq = E.equity();
  const dayKey = ET_DAY.format(new Date()); // Eastern, not UTC: a UTC rollover resets the
  // drawdown limit at 8pm ET, in the middle of the evening slate this desk mostly trades.
  if (E.state.dayKey !== dayKey) {
    E.state.dayKey = dayKey;
    E.state.dayStartEquity = eq;
    E.log('TESS', 'OPS', null, `new session day ${dayKey} · equity marked $${eq.toFixed(2)} · drawdown limit ${(E.cfg.maxDailyDrawdownPct * 100).toFixed(1)}%`);
  }
  const dd = (E.state.dayStartEquity - eq) / Math.max(1, E.state.dayStartEquity);
  const errs = http.recentErrors();
  const halt = decide.riskState({ operatorHalt: E.operatorHalt, age, drawdown: dd, errs, mode: E.cfg.mode, liveReady: E.liveReady, cfg: E.cfg });
  if (halt !== E.halt) {
    E.halt = halt;
    E.log('TESS', 'OPS', null, halt ? `HALT · ${halt} · no new risk until clear` : 'window is clean · trading re-enabled');
  }
  const budget = E.budget();
  E.touch('TESS', halt ? `HALT ${halt}` : `budget ${money(budget)}`);
  if (!halt && E.due('tess-log', 180)) {
    E.log('TESS', 'OPS', null, `data age ${Math.round(age)}s, window is clean · ${E.state.positions.filter((p) => p.strategy !== 'arb').length}/${E.cfg.maxOpenPositions} bets, ${new Set(E.state.positions.filter((p) => p.strategy === 'arb').map((p) => p.group)).size}/${E.cfg.maxArbGroups} arbs open · per-trade budget ${money(budget)} · day ${dd >= 0 ? '−' : '+'}${(Math.abs(dd) * 100).toFixed(2)}% · ${errs} api errs/5m`);
  }
}

// ---------------------------------------------------------------- RIGO
async function RIGO(E) {
  let marked = 0;
  for (const pos of [...E.state.positions]) {
    // resolution first (market vanished from the open listing)
    const res = await E.resolution(pos).catch(() => null);
    if (res && res.resolved) {
      // yesPx is the pair's YES settlement price: 1, 0, or 0.5 when a question resolves 50-50
      const px = Math.round((pos.side === 'yes' ? res.yesPx : 1 - res.yesPx) * 1000) / 1000;
      const how = res.yesPx === 1 ? 'YES' : res.yesPx === 0 ? 'NO' : res.yesPx === 0.5 ? '50-50' : `at ${res.yesPx}`;
      await E.close(pos, px, `resolved ${how}`, true);
      continue;
    }
    const pair = E.pairs.find((p) => p.id === pos.pairId);
    const q = pair && pair.q;
    if (q) { pos.mark = E.markPrice(pos, q); marked++; }
    // No pair any more: mark from the position's own market instead of freezing at the last
    // value (engine.legQuote says why). `typeof` because the golden/replay harnesses pass a
    // deliberately tiny engine-shaped object.
    else if (typeof E.venueMark === 'function') { const vm = E.venueMark(pos); if (vm != null) { pos.mark = vm; marked++; } }
    // A stuck leg -- one whose exit failed or went unfilled -- is naked directional risk sitting
    // in the book. Retry it every cycle at the current mark, ahead of any strategy logic, until
    // it clears. Nothing here waits for a signal or a threshold.
    if (pos.orphan) {
      await E.close(pos, q ? E.markPrice(pos, q) : (pos.mark ?? pos.entry), `retry flatten of stuck leg (attempt ${(pos.exitSeq || 0) + 1})`);
      continue;
    }
    const intent = decide.exitIntent(pos, pair, E.cfg, Date.now());
    if (intent) { await E.close(pos, intent.px, intent.reason); continue; }
    // no intent and no quote means we are holding blind: the clock-driven exits inside
    // exitIntent stay armed, but say so rather than going quiet
    if (pos.strategy === 'converge' && !q && E.due(`rigo-blind-${pos.id}`, 300)) {
      E.log('RIGO', 'OPS', null, `${pos.label}: no live quote, holding at last mark ${(pos.mark ?? pos.entry).toFixed(3)} \u00b7 time exits still armed`);
    }
  }
  // locked arbs: if both legs' bids sum past $1 by more than the exit fee, take the early exit
  const groups = new Map();
  for (const p of E.state.positions) if (p.strategy === 'arb') (groups.get(p.group) || groups.set(p.group, []).get(p.group)).push(p);
  for (const [, legs] of groups) {
    const u = decide.arbUnwind(legs, E.cfg);
    if (u) for (const l of legs) await E.close(l, l.mark, u.reason);
  }
  E.touch('RIGO', `${marked} marked · ${E.state.positions.length} open`);
  if (E.due('rigo-log', 300) && E.state.positions.length) {
    // Golden/replay harnesses pass a deliberately tiny engine-shaped object. Keep that pure
    // decision harness useful while the real Engine supplies the richer group scorecard.
    const pnl = typeof E.pnlScorecard === 'function' ? E.pnlScorecard() : (() => {
      const unreal = E.state.positions.reduce((a, p) => a + (p.qty * (p.mark ?? p.entry) - p.cost), 0);
      return { arbLocked: 0, totalLiquidation: unreal + E.state.stats.realized, realized: E.state.stats.realized, integrityAlerts: 0 };
    })();
    E.log('RIGO', 'RESEARCH', null, `scorecard: ${E.state.positions.length} open · arb locked ${pnl.arbLocked >= 0 ? '+' : '−'}${money(pnl.arbLocked)} · liquidation ${pnl.totalLiquidation >= 0 ? '+' : '−'}${money(pnl.totalLiquidation)} · realized ${pnl.realized >= 0 ? '+' : '−'}${money(pnl.realized)} · ${pnl.integrityAlerts} integrity alerts`);
  }
}

// ---------------------------------------------------------------- BRAM
function BRAM(E) {
  const { signals: sig, widest, inPlayN, staleN, fair, best, veto, rejects } = decide.scan(E.pairs, E.cfg, Date.now());
  // Stamp fair value, the best candidate and the binding gate back onto the pairs. The tick tape
  // reads all three, and `best` is deliberately set even where the thresholds were missed --
  // near-misses are what let the tape answer "how close did the desk ever come?" rather than only
  // "did it trade?", and `veto` says which rail stopped it when it did not.
  for (const p of E.pairs) {
    if (fair.has(p.id)) p.fair = fair.get(p.id);
    if (best.has(p.id)) p.best = best.get(p.id);
    p.veto = veto.get(p.id) || null;
  }
  E.signals = sig;
  E.touch('BRAM', widest ? `widest ${c(Math.abs(widest.gap))} ${widest.p.label}` : inPlayN ? `${inPlayN} pairs live or closing, none tradeable` : 'no pairs');
  if (staleN && E.due('bram-stale', 300)) E.log('BRAM', 'RESEARCH', null, `${staleN} pair${staleN > 1 ? 's' : ''} skipped on stale quotes (older than ${E.cfg.maxDataAgeSec}s) \u00b7 desk-wide data age is fine, these instruments individually are not`);
  // "Nothing traded" is this desk's normal output, so the useful thing to narrate is which rail
  // stopped each pair. Without this the only way to answer that was a debugger.
  if (rejects.size && E.due('bram-gates', 300)) {
    const ledger = [...rejects.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`).join(' \u00b7 ');
    E.log('BRAM', 'RESEARCH', null, `gate ledger over ${E.pairs.length} pairs \u00b7 ${ledger}`);
  }
  if (!widest && inPlayN && E.due('bram-inplay', 600)) E.log('BRAM', 'RESEARCH', null, `${inPlayN} matched pairs are all live or about to close right now · not pricing them`);
  if (widest) {
    const key = `${widest.p.id}:${Math.round(widest.gap * 100)}`;
    if (key !== E.lastGapKey && (Math.abs(widest.gap) >= 0.01 || E.due('bram-log', 240))) {
      E.lastGapKey = key;
      const { p, gap, q } = widest;
      const rich = gap > 0 ? 'Kalshi' : 'Polymarket', cheapV = gap > 0 ? 'Polymarket' : 'Kalshi';
      E.log('BRAM', 'RESEARCH', null,
        Math.abs(gap) >= 0.005
          ? `venue gap ${c(Math.abs(gap))}: ${rich} over ${cheapV} @ ${p.label} · PM ${q.pmBid.toFixed(2)}/${q.pmAsk.toFixed(2)} · KS ${q.ksBid.toFixed(2)}/${q.ksAsk.toFixed(2)}${sig.length ? ` · ${sig.length} signal${sig.length > 1 ? 's' : ''} above threshold` : Math.abs(gap) >= E.cfg.minGap ? ` · gap clears ${c(E.cfg.minGap)} but net edge is under ${c(E.cfg.minEdge)} after spread and round-trip fees` : ` · under ${c(E.cfg.minGap)} threshold`}${inPlayN ? ` · ${inPlayN} in-play excluded` : ''}`
          : `${E.pairs.length - inPlayN} pairs priced, venues within ${c(Math.abs(gap))} everywhere · nothing above the ${c(E.cfg.minGap)} threshold${inPlayN ? ` · ${inPlayN} in-play excluded` : ''}`);
    }
  }
}

// ------------------------------------------------------- mind proposals into the signal book
// ORDER HAZARD, and the reason this is its own exported step rather than a line inside ILSA:
// BRAM assigns `E.signals` wholesale every cycle (`E.signals = sig`). ILSA runs BEFORE BRAM, so a
// proposal written into the signal book by ILSA is thrown away a few lines later, silently, with
// nothing in the log to say a trade was ever proposed. It has to be merged after BRAM and before
// KETT, and the engine calls it exactly there.
//
// A proposal never displaces a deterministic signal on the same pair: KETT already refuses a
// second position per pair, and between a scanner signal and a mind's argument for the same
// event, the scanner's is the one with the arithmetic behind it.
function mergeBrainSignals(E) {
  const proposals = E.brainSignals || [];
  if (!proposals.length) return;
  const have = new Set(E.signals.map((s) => s.pair.id));
  const added = proposals.filter((s) => !have.has(s.pair.id));
  if (!added.length) return;
  E.signals = [...E.signals, ...added].sort(decide.rankSignals);
}

// ---------------------------------------------------------------- KETT
async function KETT(E) {
  if (standDown(E)) return;
  const live = E.cfg.mode === 'live';
  let considered = 0;
  for (const s of E.signals) {
    if (standDown(E)) return;
    if (considered >= 2) break; // pace: at most two new positions per cycle
    if (E.state.positions.some((p) => p.pairId === s.pair.id)) continue;
    if (Date.now() - (E.cooldown.get(s.pair.id) || 0) < E.cfg.reentryCooldownMs) continue; // no churn after an exit
    if (live && s.legs.some((l) => l.venue !== 'KS')) continue; // live mode trades Kalshi legs only
    const full = decide.bookFull(E.state.positions, s, E.cfg);
    // an arb book that is full does not stop a convergence trade further down the list, or the reverse
    if (full) { if (E.due(`kett-full-${s.type}`, 300)) E.log('KETT', 'PASS', null, `${full}, passing on ${s.pair.label}`); continue; }
    considered++;
    const budget = E.budget();
    if (budget < 5) { if (E.due('kett-cash', 300)) E.log('KETT', 'PASS', null, `budget ${money(budget)} below floor, standing down`); break; }

    // ILSA flow check for directional trades. `sizeMult` is a fraction OF the per-position cap,
    // not a multiplier on top of it: a locked arb is hedged and takes the full cap, a neutral
    // convergence read takes `baseSizeMult` of it, and a converging read earns its way back up to
    // the cap. That keeps "sized up" a real 25% more contracts without lifting maxPositionPct.
    let sizeMult = 1;
    if (s.type === 'converge') {
      const b = E.bias.get(s.pair.id);
      // ILSA's mind, where it has one, outranks the drift arithmetic -- the arithmetic measures
      // that the gap moved, the mind is the only thing that argues about WHY. Both directions of
      // that authority are real: a confident "diverging" kills the trade outright, and a
      // confident "converging" takes it to the full per-position cap.
      const mind = b && b.llm && b.llm.conviction >= 0.5 ? b.llm : null;
      if (mind && mind.stance === 'diverging') {
        if (E.due(`kett-flow-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: gap ${c(Math.abs(s.gap))} but ILSA reads it widening — ${mind.thesis}`);
        continue;
      }
      if (!mind && b && b.reliable && b.score <= -0.5) { if (E.due(`kett-flow-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: gap ${c(Math.abs(s.gap))} but ILSA reads it widening off an already-tradeable gap, pass`); continue; }
      if (mind) sizeMult = mind.stance === 'converging' ? 1 : E.cfg.baseSizeMult;
      else sizeMult = b && b.reliable && b.score >= 0.5 ? 1 : E.cfg.baseSizeMult;
    }

    // real books at size — and for directional trades, re-verify the gap from live books on BOTH venues
    let books;
    try { books = await Promise.all(s.legs.map((l) => E.book(l.venue, s.pair, l.side))); }
    catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: book fetch failed (${e.message.slice(0, 60)})`); continue; }
    if (standDown(E)) return;
    if (s.type === 'converge') {
      const leg = s.legs[0];
      let far;
      try { far = await E.book(other(leg.venue), s.pair, 'yes'); }
      catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: ${VEN[other(leg.venue)]} book fetch failed (${e.message.slice(0, 60)})`); continue; }
      if (standDown(E)) return;
      const near = books[0];
      if ([near.yesBid, near.yesAsk, far.yesBid, far.yesAsk].some((x) => x == null)) { E.log('KETT', 'PASS', null, `${s.pair.label}: one-sided book, no fill`); continue; }
      const q = s.pair.q;
      const nearMid = (near.yesBid + near.yesAsk) / 2, farMid = (far.yesBid + far.yesAsk) / 2;
      const isPM = leg.venue === 'PM';
      const liveQ = {
        pmVol: q.pmVol, ksVol: q.ksVol, pmFeeRate: q.pmFeeRate,
        pmMid: isPM ? nearMid : farMid, ksMid: isPM ? farMid : nearMid,
        pmBid: isPM ? near.yesBid : far.yesBid, pmAsk: isPM ? near.yesAsk : far.yesAsk,
        ksBid: isPM ? far.yesBid : near.yesBid, ksAsk: isPM ? far.yesAsk : near.yesAsk,
      };
      const fairLive = fairValue(liveQ);
      const { px: pxLive, edge: edgeLive } = convEdge(leg.venue, leg.side, liveQ, fairLive, E.cfg, s.pair.ks.ticker);
      // A mind-originated trade is held to `llmMinEdge` rather than `minEdge`. `minEdge` is the
      // scanner's opinion about which gaps are worth the trouble, and a desk that can argue for a
      // position is allowed to argue with that. `llmMinEdge` is a different kind of number: edge
      // is already net of both spreads and both fees, so its default of 0 is exact break-even.
      // There is no thesis that makes a negative-edge entry work -- it is arithmetic, not taste.
      const bar = s.origin ? E.cfg.llmMinEdge : E.cfg.minEdge;
      if (edgeLive < bar) {
        if (E.due(`kett-stale-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: ${s.origin ? `${s.origin} proposed on ${c(s.edge)}` : `listing showed ${c(s.edge)} edge`} but live books show ${c(edgeLive)}${s.origin ? ', under break-even' : ', listing was stale'}`);
        continue;
      }
      s.edge = edgeLive; s.fair = fairLive; s.gap = liveQ.ksMid - liveQ.pmMid; leg.px = pxLive;
    }
    const { qty, capped } = decide.sizePlan(s, { budget, sizeMult, books, cfg: E.cfg });
    // Say so when the risk limit -- not depth, not cash -- is what set the size. Silently clipping
    // a position back to the cap is how a rail stops being visible enough to argue with.
    if (capped && E.due(`kett-cap-${s.pair.id}`, 300)) E.log('KETT', 'OPS', null, `${s.pair.label}: sized to the ${(E.cfg.maxPositionPct * 100).toFixed(1)}% position cap, not to available depth`);
    if (qty < 5) { if (E.due(`kett-depth-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: only ${qty} contracts inside limit, below 5-lot floor`); continue; }

    // Resolve every leg's exchange reference up front. A Polymarket NO leg needs the OTHER
    // token, and if it cannot be resolved the whole signal must abort here -- not halfway
    // through, with one leg already filled against the wrong instrument.
    let refs;
    try { refs = s.legs.map((l) => E.legRef(s.pair, l)); }
    catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: ${String(e.message).slice(0, 90)}`); continue; }

    // execute legs; unwind on partial failure
    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    if (s.type === 'arb') {
      try { E.createArbGroup(s, group, s.legs, refs, qty); }
      catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: arb validation failed (${String(e.message).slice(0, 80)})`); continue; }
    }
    const fills = [];
    let failed = null;
    let uncertain = null;
    let spent = 0; // legs are only booked (and cash debited) once ALL of them fill
    for (let i = 0; i < s.legs.length; i++) {
      const l = s.legs[i];
      let f;
      // This check must be immediately adjacent to the money-moving call: flatten can land after
      // the book fetch but before the first (or a later arb leg) is submitted.
      if (entryHalt(E)) { failed = 'operator halt'; break; }
      // deterministic idempotency key: a retried request for THIS leg of THIS group dedupes at
      // the exchange instead of opening a second position
      try { f = await E.broker.buy({ venue: l.venue, ref: refs[i], side: l.side, qty, limit: l.px + E.cfg.slipLimit, book: books[i].asks, feeRate: s.pair.q && s.pair.q.pmFeeRate, key: `${group}-${l.venue}${l.side[0]}-in` }); }
      catch (e) {
        if (ambiguousOrder(e)) { uncertain = e; break; }
        f = { filled: 0, reason: e.message.slice(0, 80) };
      }
      if (uncertain) break;
      if (!f.filled || f.cost > E.state.cash - spent) { failed = f.reason || 'insufficient cash'; break; }
      spent += f.cost;
      fills.push({ leg: l, f });
      // An order already in flight cannot be un-sent. If flatten landed while awaiting its response,
      // account for the known fill below and unwind it, but never send the next leg.
      if (entryHalt(E)) { failed = 'operator halt'; break; }
    }
    if (uncertain) {
      // The broker persisted the uncertain intent before its POST. Known earlier legs are made
      // visible to the ledger, but nothing is unwound or retried: the unknown order might itself
      // have filled, and reconciliation must establish the exchange truth before another trade.
      for (const { leg, f } of fills) E.open(s, leg, f, group, `${s.type} leg; sibling order pending reconciliation`);
      E.liveReady = false;
      E.journal(E, 'ENTRY_UNKNOWN', { group, label: s.pair.label, strategy: s.type, clientOrderId: uncertain.clientOrderId || null, intent: uncertain.intent || null, knownLegs: fills.map(({ leg, f }) => ({ venue: leg.venue, side: leg.side, qty: f.filled, orderId: f.orderId || null })), reason: String(uncertain.message || 'order response unknown').slice(0, 120) });
      E.log('KETT', 'HALT', null, `${s.pair.label}: entry response unknown · awaiting reconciliation before any unwind or retry`);
      E.save();
      return;
    }
    if (failed) {
      for (const { leg, f } of fills) {
        const q = s.pair.q;
        const bid = leg.venue === 'PM' ? (leg.side === 'yes' ? q.pmBid : 1 - q.pmAsk) : (leg.side === 'yes' ? q.ksBid : 1 - q.ksAsk);
        const pos = E.open(s, leg, f, group, `${s.type} leg`);
        await E.close(pos, bid, 'unwound: second leg failed');
      }
      E.log('KETT', 'PASS', null, `${s.pair.label}: ${failed}${fills.length ? ', first leg unwound' : ''}`);
      if (s.type === 'arb') E.journal(E, 'ARB_UNWOUND', { group, label: s.pair.label, reason: failed, knownLegs: fills.length });
      continue;
    }
    for (const { leg, f } of fills) E.open(s, leg, f, group, s.type === 'arb' ? 'locked arb leg' : `gap ${c(Math.abs(s.gap))}`);
    if (s.type === 'arb') E.completeArbGroup(group);
    const totalCost = fills.reduce((a, x) => a + x.f.cost, 0);
    const q = s.pair.q;
    if (s.type === 'arb') {
      E.log('KETT', 'FILL', -totalCost, `${s.pair.label} · locked arb ${qty}x: ${fills.map(({ leg, f }) => `${leg.side.toUpperCase()} @ ${VEN[leg.venue]} ${f.avg.toFixed(3)}`).join(' + ')} · pays $1.00 at resolution, edge ${c(s.edge)}/contract`);
    } else {
      const leg = fills[0].leg, f = fills[0].f;
      const fairSide = leg.side === 'yes' ? s.fair : 1 - s.fair;
      // Name the desk that originated the trade and the argument it made. When a mind is
      // spending money, the reason has to be in the permanent record next to the fill, not
      // inferable from a research line logged some minutes earlier.
      E.log('KETT', 'FILL', -totalCost, `${s.pair.label} · buy ${qty} ${leg.side.toUpperCase()} @ ${VEN[leg.venue]} ${f.avg.toFixed(3)} · fair ${fairSide.toFixed(3)} on live books (${VEN[other(leg.venue)]} mid ${(leg.venue === 'PM' ? q.ksMid : q.pmMid).toFixed(3)}) · edge ${c(s.edge)} · fee ${money(f.fee)}${sizeMult > E.cfg.baseSizeMult ? ' · sized up on ILSA flow' : ''}${s.origin ? ` · ${s.origin}'s call: ${s.thesis}` : ''}`);
    }
  }
  E.touch('KETT', E.signals.length ? `${E.signals.length} signals` : 'no signals');
}

module.exports = { HOLT, ILSA, TESS, RIGO, BRAM, KETT, mergeBrainSignals };

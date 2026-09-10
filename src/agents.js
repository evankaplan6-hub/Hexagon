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
const { fairValue, convEdge } = decide;

const r2 = (x) => Math.round(x * 100) / 100;
const c = (x) => `${(x * 100).toFixed(1)}c`; // dollars -> cents string
const money = (x) => `$${Math.abs(x).toFixed(2)}`;
const VEN = { PM: 'Polymarket', KS: 'Kalshi' };
const other = (v) => (v === 'PM' ? 'KS' : 'PM');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// ---------------------------------------------------------------- HOLT
function HOLT(E) {
  const prev = new Map(E.pairs.map((p) => [p.id, p]));
  const { pairs, rejected } = matchPairs([...E.quotes.pm.values()], [...E.quotes.ks.values()]);
  for (const p of pairs) if (prev.has(p.id)) p.q = prev.get(p.id).q; // keep last quote until repriced
  // Games are untradeable from 2 minutes before start. This has to be stamped here, not in
  // BRAM: HOLT rebuilds `pairs` from scratch every cycle and only carries `q` across, so a
  // flag set later in the cycle is gone by the next one — and RIGO, which reads it to
  // flatten directional risk, runs BEFORE BRAM. Set there, it was always undefined.
  const now = Date.now();
  for (const p of pairs) p.inPlay = p.kind === 'game' && (!p.startsAt || now >= p.startsAt - 120000);
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
    if (rejected.length) txt += ` · ${rejected.length} rejected on 30c+ disagreement`;
    E.log('HOLT', 'SCAN', null, txt);
  }
}

// ---------------------------------------------------------------- ILSA
function ILSA(E) {
  let top = null;
  for (const p of E.pairs) {
    const bias = decide.biasFor(E.history.get(p.id), E.cfg);
    if (!bias) continue;
    E.bias.set(p.id, bias);
    const move = Math.abs(bias.pmDrift) + Math.abs(bias.ksDrift);
    if (!top || move > top.move) top = { p, bias, move };
  }
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
    E.log('TESS', 'OPS', null, `data age ${Math.round(age)}s, window is clean · ${E.state.positions.length}/${E.cfg.maxOpenPositions} open · per-trade budget ${money(budget)} · day ${dd >= 0 ? '−' : '+'}${(Math.abs(dd) * 100).toFixed(2)}% · ${errs} api errs/5m`);
  }
}

// ---------------------------------------------------------------- RIGO
async function RIGO(E) {
  let marked = 0;
  for (const pos of [...E.state.positions]) {
    // resolution first (market vanished from the open listing)
    const res = await E.resolution(pos).catch(() => null);
    if (res && res.resolved) {
      const px = (pos.side === 'yes') === res.yesWins ? 1 : 0;
      await E.close(pos, px, `resolved ${res.yesWins ? 'YES' : 'NO'}`, true);
      continue;
    }
    const pair = E.pairs.find((p) => p.id === pos.pairId);
    const q = pair && pair.q;
    if (q) { pos.mark = E.markPrice(pos, q); marked++; }
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
  // locked arbs: if both legs' bids ever sum past $1, take the free exit
  const groups = new Map();
  for (const p of E.state.positions) if (p.strategy === 'arb') (groups.get(p.group) || groups.set(p.group, []).get(p.group)).push(p);
  for (const [, legs] of groups) {
    if (legs.length !== 2 || !legs.every((l) => l.mark != null)) continue;
    const bidSum = legs[0].mark + legs[1].mark;
    if (bidSum > 1.005) for (const l of legs) await E.close(l, l.mark, `early unwind, bids sum ${bidSum.toFixed(3)}`);
  }
  E.touch('RIGO', `${marked} marked · ${E.state.positions.length} open`);
  if (E.due('rigo-log', 300) && E.state.positions.length) {
    const unreal = E.state.positions.reduce((a, p) => a + (p.qty * (p.mark ?? p.entry) - p.cost), 0);
    E.log('RIGO', 'RESEARCH', null, `scorecard: ${E.state.positions.length} open, unrealized ${unreal >= 0 ? '+' : '−'}${money(unreal)} · realized ${E.state.stats.realized >= 0 ? '+' : '−'}${money(E.state.stats.realized)} · fees paid ${money(E.state.stats.fees)}`);
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
  E.touch('BRAM', widest ? `widest ${c(Math.abs(widest.gap))} ${widest.p.label}` : inPlayN ? `${inPlayN} pairs in-play, none tradeable` : 'no pairs');
  if (staleN && E.due('bram-stale', 300)) E.log('BRAM', 'RESEARCH', null, `${staleN} pair${staleN > 1 ? 's' : ''} skipped on stale quotes (older than ${E.cfg.maxDataAgeSec}s) \u00b7 desk-wide data age is fine, these instruments individually are not`);
  // "Nothing traded" is this desk's normal output, so the useful thing to narrate is which rail
  // stopped each pair. Without this the only way to answer that was a debugger.
  if (rejects.size && E.due('bram-gates', 300)) {
    const ledger = [...rejects.entries()].sort((a, b) => b[1] - a[1]).map(([why, n]) => `${n} ${why}`).join(' \u00b7 ');
    E.log('BRAM', 'RESEARCH', null, `gate ledger over ${E.pairs.length} pairs \u00b7 ${ledger}`);
  }
  if (!widest && inPlayN && E.due('bram-inplay', 600)) E.log('BRAM', 'RESEARCH', null, `${inPlayN} matched pairs are all in-play right now · not pricing live games`);
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

// ---------------------------------------------------------------- KETT
async function KETT(E) {
  if (E.halt) { E.touch('KETT', 'standing down'); return; }
  const live = E.cfg.mode === 'live';
  let considered = 0;
  for (const s of E.signals) {
    if (considered >= 2) break; // pace: at most two new positions per cycle
    if (E.state.positions.some((p) => p.pairId === s.pair.id)) continue;
    if (Date.now() - (E.cooldown.get(s.pair.id) || 0) < 10 * 60 * 1000) continue; // no churn after an exit
    if (live && s.legs.some((l) => l.venue !== 'KS')) continue; // live mode trades Kalshi legs only
    if (E.state.positions.length + s.legs.length > E.cfg.maxOpenPositions) {
      if (E.due('kett-full', 300)) E.log('KETT', 'PASS', null, `book full at ${E.state.positions.length} positions, passing on ${s.pair.label}`);
      break;
    }
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
      if (b && b.reliable && b.score <= -0.5) { if (E.due(`kett-flow-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: gap ${c(Math.abs(s.gap))} but ILSA reads it widening off an already-tradeable gap, pass`); continue; }
      sizeMult = b && b.reliable && b.score >= 0.5 ? 1 : E.cfg.baseSizeMult;
    }

    // real books at size — and for directional trades, re-verify the gap from live books on BOTH venues
    let books;
    try { books = await Promise.all(s.legs.map((l) => E.book(l.venue, s.pair, l.side))); }
    catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: book fetch failed (${e.message.slice(0, 60)})`); continue; }
    if (s.type === 'converge') {
      const leg = s.legs[0];
      let far;
      try { far = await E.book(other(leg.venue), s.pair, 'yes'); }
      catch (e) { E.log('KETT', 'PASS', null, `${s.pair.label}: ${VEN[other(leg.venue)]} book fetch failed (${e.message.slice(0, 60)})`); continue; }
      const near = books[0];
      if ([near.yesBid, near.yesAsk, far.yesBid, far.yesAsk].some((x) => x == null)) { E.log('KETT', 'PASS', null, `${s.pair.label}: one-sided book, no fill`); continue; }
      const q = s.pair.q;
      const nearMid = (near.yesBid + near.yesAsk) / 2, farMid = (far.yesBid + far.yesAsk) / 2;
      const isPM = leg.venue === 'PM';
      const liveQ = {
        pmVol: q.pmVol, ksVol: q.ksVol,
        pmMid: isPM ? nearMid : farMid, ksMid: isPM ? farMid : nearMid,
        pmBid: isPM ? near.yesBid : far.yesBid, pmAsk: isPM ? near.yesAsk : far.yesAsk,
        ksBid: isPM ? far.yesBid : near.yesBid, ksAsk: isPM ? far.yesAsk : near.yesAsk,
      };
      const fairLive = fairValue(liveQ);
      const { px: pxLive, edge: edgeLive } = convEdge(leg.venue, leg.side, liveQ, fairLive, E.cfg, s.pair.ks.ticker);
      if (edgeLive < E.cfg.minEdge) {
        if (E.due(`kett-stale-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: listing showed ${c(s.edge)} edge but live books show ${c(edgeLive)}, listing was stale`);
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
    const fills = [];
    let failed = null;
    let spent = 0; // legs are only booked (and cash debited) once ALL of them fill
    for (let i = 0; i < s.legs.length; i++) {
      const l = s.legs[i];
      let f;
      // deterministic idempotency key: a retried request for THIS leg of THIS group dedupes at
      // the exchange instead of opening a second position
      try { f = await E.broker.buy({ venue: l.venue, ref: refs[i], side: l.side, qty, limit: l.px + E.cfg.slipLimit, book: books[i].asks, key: `${group}-${l.venue}${l.side[0]}-in` }); }
      catch (e) { f = { filled: 0, reason: e.message.slice(0, 80) }; }
      if (!f.filled || f.cost > E.state.cash - spent) { failed = f.reason || 'insufficient cash'; break; }
      spent += f.cost;
      fills.push({ leg: l, f });
    }
    if (failed) {
      for (const { leg, f } of fills) {
        const q = s.pair.q;
        const bid = leg.venue === 'PM' ? (leg.side === 'yes' ? q.pmBid : 1 - q.pmAsk) : (leg.side === 'yes' ? q.ksBid : 1 - q.ksAsk);
        const pos = E.open(s, leg, f, group, `${s.type} leg`);
        await E.close(pos, bid, 'unwound: second leg failed');
      }
      E.log('KETT', 'PASS', null, `${s.pair.label}: ${failed}${fills.length ? ', first leg unwound' : ''}`);
      continue;
    }
    for (const { leg, f } of fills) E.open(s, leg, f, group, s.type === 'arb' ? 'locked arb leg' : `gap ${c(Math.abs(s.gap))}`);
    const totalCost = fills.reduce((a, x) => a + x.f.cost, 0);
    const q = s.pair.q;
    if (s.type === 'arb') {
      E.log('KETT', 'FILL', -totalCost, `${s.pair.label} · locked arb ${qty}x: ${fills.map(({ leg, f }) => `${leg.side.toUpperCase()} @ ${VEN[leg.venue]} ${f.avg.toFixed(3)}`).join(' + ')} · pays $1.00 at resolution, edge ${c(s.edge)}/contract`);
    } else {
      const leg = fills[0].leg, f = fills[0].f;
      const fairSide = leg.side === 'yes' ? s.fair : 1 - s.fair;
      E.log('KETT', 'FILL', -totalCost, `${s.pair.label} · buy ${qty} ${leg.side.toUpperCase()} @ ${VEN[leg.venue]} ${f.avg.toFixed(3)} · fair ${fairSide.toFixed(3)} on live books (${VEN[other(leg.venue)]} mid ${(leg.venue === 'PM' ? q.ksMid : q.pmMid).toFixed(3)}) · edge ${c(s.edge)} · fee ${money(f.fee)}${sizeMult > E.cfg.baseSizeMult ? ' · sized up on ILSA flow' : ''}`);
    }
  }
  E.touch('KETT', E.signals.length ? `${E.signals.length} signals` : 'no signals');
}

module.exports = { HOLT, ILSA, TESS, RIGO, BRAM, KETT };

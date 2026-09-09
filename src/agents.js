'use strict';
// The six desks. Each is a plain function over the engine; the engine sequences them every cycle.
//   HOLT  scanner    — discovers matched pairs across venues
//   ILSA  sentiment  — reads flow: drift and gap tendency per pair
//   TESS  ops        — health, budget, drawdown, halt switch
//   RIGO  settlement — marks, exits, resolutions, realizes P&L
//   BRAM  pricing    — fair value + signals (locked arbs, convergence gaps)
//   KETT  execution  — turns signals into fills within TESS's budget
const ks = require('./venues/kalshi');
const { matchPairs } = require('./matcher');
const http = require('./http');

const r2 = (x) => Math.round(x * 100) / 100;
const c = (x) => `${(x * 100).toFixed(1)}c`; // dollars -> cents string
const money = (x) => `$${Math.abs(x).toFixed(2)}`;
const VEN = { PM: 'Polymarket', KS: 'Kalshi' };
const other = (v) => (v === 'PM' ? 'KS' : 'PM');
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

// Fair value leans on the venue with more volume: when two books disagree, the thin one is usually wrong.
function fairValue(q) {
  const wp = (q.pmVol || 0) + 100, wk = (q.ksVol || 0) + 100;
  return (q.pmMid * wp + q.ksMid * wk) / (wp + wk);
}

// What a convergence trade is actually worth, per contract, on venue `v` / `side`.
// The round trip costs more than the entry fee the old model charged:
//   - in  at the ask (or 1-bid for NO), paying a taker fee
//   - out at the BID once the mid reaches fair (RIGO exits at E.markPrice, which is the
//     bid side), so the venue's spread is a cost too, not just half of it
//   - and a second taker fee on that exit
// On Kalshi at mid prices the fee alone is ~1.75c each way; ignoring the exit leg was
// flattering every convergence signal by roughly spread/2 + one full fee.
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
    const h = E.history.get(p.id) || [];
    if (h.length < 3) continue;
    const a = h[Math.max(0, h.length - 8)], b = h[h.length - 1];
    const gapThen = a.ksMid - a.pmMid, gapNow = b.ksMid - b.pmMid;
    // +1 = venues converging, -1 = diverging
    const score = clamp((Math.abs(gapThen) - Math.abs(gapNow)) / Math.max(0.01, Math.abs(gapThen)), -1, 1);
    // The score is only meaningful if there was a gap to begin with. With the 0.01 floor in
    // the denominator, a pair whose gap opened from ~0 to 2c scores -1 ("diverging") — but a
    // freshly opened gap is exactly the convergence setup, so that veto was throwing away
    // the only trades this strategy exists to take. Trust "widening" only once the earlier
    // gap was itself tradeable.
    const reliable = Math.abs(gapThen) >= E.cfg.minGap;
    const bias = { score, reliable, pmDrift: b.pmMid - a.pmMid, ksDrift: b.ksMid - a.ksMid, gapNow, mins: Math.round((b.t - a.t) / 60000) };
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
  let halt = null;
  if (!Number.isFinite(age)) halt = 'no quotes yet';
  else if (age > E.cfg.maxDataAgeSec) halt = `stale data (${Math.round(age)}s old)`;
  else if (dd >= E.cfg.maxDailyDrawdownPct) halt = `daily drawdown ${(dd * 100).toFixed(1)}% hit the ${(E.cfg.maxDailyDrawdownPct * 100).toFixed(0)}% limit`;
  else if (errs >= 25) halt = `${errs} API errors in 5m`;
  else if (E.cfg.mode === 'live' && !E.liveReady) halt = 'live venue not authenticated';
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
    if (!q) continue;
    pos.mark = E.markPrice(pos, q);
    marked++;
    if (pos.strategy !== 'converge') continue;
    const gap = Math.abs(q.ksMid - q.pmMid);
    const perContract = pos.mark - pos.entry;
    const heldMin = (Date.now() - pos.openedAt) / 60000;
    if (pair.inPlay) await E.close(pos, pos.mark, `event going live, flattening directional risk (gap ${c(gap)})`);
    else if (gap <= E.cfg.exitGap) await E.close(pos, pos.mark, `gap closed to ${c(gap)}, held ${Math.round(heldMin)}m`);
    else if (perContract <= -E.cfg.stopLoss) await E.close(pos, pos.mark, `stop: mark ${c(perContract)} vs entry`);
    else if (heldMin >= E.cfg.maxHoldMin) await E.close(pos, pos.mark, `max hold ${E.cfg.maxHoldMin}m reached, gap still ${c(gap)}`);
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
  const sig = [];
  let widest = null;
  let inPlayN = 0;
  const pmFee = E.cfg.pmTakerFee;
  for (const p of E.pairs) {
    const q = p.q;
    if (!q) continue;
    // games are untradeable from 2 minutes before start (flagged in HOLT, which runs before
    // RIGO): listings lag live play by far more than any gap
    if (p.inPlay) { inPlayN++; continue; }
    const ksFeeYes = ks.fee(1, q.ksAsk, E.cfg.ksFeeRate);
    const ksFeeNo = ks.fee(1, 1 - q.ksBid, E.cfg.ksFeeRate);
    // locked arbs: YES here + NO there must cost < $1 after fees
    const edgeA = 1 - (q.pmAsk + (1 - q.ksBid) + pmFee * q.pmAsk + ksFeeNo);
    const edgeB = 1 - (q.ksAsk + (1 - q.pmBid) + pmFee * (1 - q.pmBid) + ksFeeYes);
    if (edgeA >= E.cfg.minArbEdge) sig.push({ type: 'arb', pair: p, edge: edgeA, legs: [{ venue: 'PM', side: 'yes', px: q.pmAsk }, { venue: 'KS', side: 'no', px: r2(1 - q.ksBid) }] });
    if (edgeB >= E.cfg.minArbEdge) sig.push({ type: 'arb', pair: p, edge: edgeB, legs: [{ venue: 'KS', side: 'yes', px: q.ksAsk }, { venue: 'PM', side: 'no', px: r2(1 - q.pmBid) }] });
    // convergence: when venues disagree by >= minGap, trade the venue that is off fair value, toward fair.
    // Candidates: YES or NO on either venue; keep the single best net-of-fee edge for the pair.
    const gap = q.ksMid - q.pmMid; // + => Kalshi rich, Polymarket cheap
    if (!widest || Math.abs(gap) > Math.abs(widest.gap)) widest = { p, gap, q };
    const fair = fairValue(q);
    p.fair = fair;
    if (fair > E.cfg.minMid && fair < E.cfg.maxMid && Math.abs(gap) >= E.cfg.minGap) {
      let best = null;
      for (const v of ['PM', 'KS']) {
        const bid = v === 'PM' ? q.pmBid : q.ksBid, ask = v === 'PM' ? q.pmAsk : q.ksAsk;
        if (ask - bid > E.cfg.maxSpread + 1e-9) continue; // epsilon: 0.05 - 0.00 lands at 0.05000000000000004
        for (const side of ['yes', 'no']) {
          const { px, edge } = convEdge(v, side, q, fair, E.cfg);
          // minEdge, not minGap: fair value sits between the two venues, so the realisable
          // edge is a fraction of the gap. Testing it against minGap needed a 6-10c gap to
          // clear a nominal 3c bar, which is why this book never opened a position.
          if (edge >= E.cfg.minEdge && (!best || edge > best.edge)) best = { type: 'converge', pair: p, edge, gap, fair, legs: [{ venue: v, side, px }] };
        }
      }
      if (best) sig.push(best);
    }
  }
  sig.sort((a, b) => b.edge - a.edge);
  E.signals = sig;
  E.touch('BRAM', widest ? `widest ${c(Math.abs(widest.gap))} ${widest.p.label}` : inPlayN ? `${inPlayN} pairs in-play, none tradeable` : 'no pairs');
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

    // ILSA flow check for directional trades
    let sizeMult = 1;
    if (s.type === 'converge') {
      const b = E.bias.get(s.pair.id);
      if (b && b.reliable && b.score <= -0.5) { if (E.due(`kett-flow-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: gap ${c(Math.abs(s.gap))} but ILSA reads it widening off an already-tradeable gap, pass`); continue; }
      if (b && b.reliable && b.score >= 0.5) sizeMult = 1.25;
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
      const { px: pxLive, edge: edgeLive } = convEdge(leg.venue, leg.side, liveQ, fairLive, E.cfg);
      if (edgeLive < E.cfg.minEdge) {
        if (E.due(`kett-stale-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: listing showed ${c(s.edge)} edge but live books show ${c(edgeLive)}, listing was stale`);
        continue;
      }
      s.edge = edgeLive; s.fair = fairLive; s.gap = liveQ.ksMid - liveQ.pmMid; leg.px = pxLive;
    }
    const unitCost = s.legs.reduce((a, l) => a + l.px, 0) + s.legs.reduce((a, l) => a + (l.venue === 'KS' ? ks.fee(1, l.px, E.cfg.ksFeeRate) : E.cfg.pmTakerFee * l.px), 0);
    let qty = Math.floor((budget * sizeMult) / unitCost);
    for (let i = 0; i < s.legs.length; i++) {
      const limit = s.legs[i].px + 0.01;
      const depth = Math.floor(books[i].asks.filter((l) => l.price <= limit + 1e-9).reduce((a, l) => a + l.size, 0));
      qty = Math.min(qty, depth);
    }
    if (qty < 5) { if (E.due(`kett-depth-${s.pair.id}`, 300)) E.log('KETT', 'PASS', null, `${s.pair.label}: only ${qty} contracts inside limit, below 5-lot floor`); continue; }

    // execute legs; unwind on partial failure
    const group = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}`;
    const fills = [];
    let failed = null;
    let spent = 0; // legs are only booked (and cash debited) once ALL of them fill
    for (let i = 0; i < s.legs.length; i++) {
      const l = s.legs[i];
      const ref = l.venue === 'KS' ? s.pair.ks.ticker : s.pair.pm.tokenId;
      let f;
      try { f = await E.broker.buy({ venue: l.venue, ref, side: l.side, qty, limit: l.px + 0.01, book: books[i].asks }); }
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
      E.log('KETT', 'FILL', -totalCost, `${s.pair.label} · buy ${qty} ${leg.side.toUpperCase()} @ ${VEN[leg.venue]} ${f.avg.toFixed(3)} · fair ${fairSide.toFixed(3)} on live books (${VEN[other(leg.venue)]} mid ${(leg.venue === 'PM' ? q.ksMid : q.pmMid).toFixed(3)}) · edge ${c(s.edge)} · fee ${money(f.fee)}${sizeMult > 1 ? ' · sized up on ILSA flow' : ''}`);
    }
  }
  E.touch('KETT', E.signals.length ? `${E.signals.length} signals` : 'no signals');
}

module.exports = { HOLT, ILSA, TESS, RIGO, BRAM, KETT };

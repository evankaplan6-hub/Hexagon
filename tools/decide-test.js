'use strict';
// Assertions for the decision core (src/decide.js). Zero dependencies, no network, no clock.
//
// tools/golden.js pins the OUTPUT of a refactor that is meant to change nothing. This pins the
// BEHAVIOUR of the gates themselves -- the cases that a real tape happens not to contain, which is
// exactly why they went unnoticed: over 30,817 recorded ticks there was not one crossed book, not
// one unmarked position and not one pair offering both an arb and a convergence trade. None of
// that means the desk handles them, only that it was never asked to.
//
//   node tools/decide-test.js
const d = require('../src/decide');
const ks = require('../src/venues/kalshi');
const pmv = require('../src/venues/polymarket');
// The fixtures below are built around a 0.5c edge bar. The shipped default is higher (2c, see
// config.js), so pin the bar here: these tests are about the mechanics, not the default.
const cfg = { ...require('../src/config'), minEdge: 0.005 };

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
// vols default to a 5:1 PM:KS split, so `fair` sits near Polymarket -- lopsided enough to clear
// the venues-too-even gate, and the reason a convergence edge is always a fraction of the gap.
const mk = (pmBid, pmAsk, ksBid, ksAsk, pmVol = 5e5, ksVol = 1e5) => ({
  id: 'x', label: 'fixture', ks: { ticker: 'KXTEST' },
  q: { pmBid, pmAsk, ksBid, ksAsk, pmMid: (pmBid + pmAsk) / 2, ksMid: (ksBid + ksAsk) / 2, pmVol, ksVol, t: 1 },
});

group('a locked arb replaces the convergence trade on the same pair');
{
  // 10c gap, tight books: buying PM YES at 0.41 and KS NO at 0.50 costs 0.91 and pays $1.
  const r = d.pairSignals(mk(0.40, 0.41, 0.50, 0.51), cfg);
  ok('exactly one signal', r.signals.length === 1, r.signals.map((s) => s.type));
  ok('and it is the arb', r.signals[0].type === 'arb', r.signals[0].type);
  // the convergence candidate was VALID -- it was outranked, not gated
  ok('veto stays null when only the arb outranked it', r.veto === null, r.veto);
}

group('convergence still fires on its own when no arb shadows it');
{
  // gap clears minGap but is too small for a locked arb to clear minArbEdge; Kalshi is the thick
  // venue here, so fair leans its way and the cheap Polymarket YES is the trade
  const r = d.pairSignals(mk(0.05, 0.06, 0.07, 0.11, 1e5, 5e5), cfg);
  ok('exactly one signal', r.signals.length === 1, r.signals.map((s) => s.type));
  ok('and it is the converge', r.signals[0].type === 'converge', r.signals[0].type);
}

group('arbs outrank convergence in the ranked list regardless of edge');
{
  const arb = { type: 'arb', edge: 0.001 }, conv = { type: 'converge', edge: 0.900 };
  ok('a 0.1c arb sorts above a 90c convergence', [conv, arb].sort(d.rankSignals)[0] === arb);
}

group('malformed books are rejected by name rather than priced');
{
  ok('crossed PM book', d.quoteFault(mk(0.50, 0.45, 0.50, 0.51).q) === 'crossed book');
  ok('crossed KS book', d.quoteFault(mk(0.50, 0.51, 0.55, 0.50).q) === 'crossed book');
  ok('non-finite level', d.quoteFault({ pmBid: NaN, pmAsk: 0.5, ksBid: 0.5, ksAsk: 0.5, pmMid: 0.5, ksMid: 0.5 }) === 'non-finite quote');
  ok('level outside 0-1', d.quoteFault({ pmBid: -0.1, pmAsk: 0.5, ksBid: 0.5, ksAsk: 0.5, pmMid: 0.5, ksMid: 0.5 }) === 'quote outside 0-1');
  ok('a clean book has no fault', d.quoteFault(mk(0.40, 0.41, 0.50, 0.51).q) === null);
  const r = d.pairSignals(mk(0.60, 0.45, 0.20, 0.21), cfg);
  ok('crossed book emits nothing', r.signals.length === 0, r.signals);
  ok('crossed book names its veto', r.veto === 'crossed book', r.veto);
  // why it matters: convEdge subtracts spread/2, so a negative spread ADDS edge and ranks first
  ok('a crossed book would otherwise manufacture edge', (0.60 - 0.45) / 2 > 0.05);
}

group('the binding gate is named, one per pair');
{
  for (const [p, want] of [
    [mk(0.005, 0.008, 0.01, 0.02), 'mid outside band'],
    [mk(0.50, 0.51, 0.50, 0.51), 'gap under minGap'],
    [mk(0.50, 0.51, 0.53, 0.54), 'edge under minEdge'],
    [mk(0.30, 0.45, 0.50, 0.65), 'spread over maxSpread'],
  ]) ok(`veto = ${want}`, d.pairSignals(p, cfg).veto === want, d.pairSignals(p, cfg).veto);
  // a wide spread makes a venue ineligible to TRADE without erasing the near-miss from the tape
  ok('best is still recorded when the spread gate binds', d.pairSignals(mk(0.30, 0.45, 0.50, 0.65), cfg).best !== null);
}

group('scan reports a counted rejection ledger');
{
  const NOW = 1e12;
  const fresh = (p) => ({ ...p, q: { ...p.q, t: NOW } });
  const s = d.scan([
    fresh(mk(0.50, 0.51, 0.50, 0.51)),
    { id: 'y', label: 'no quote', q: null },
    { ...fresh(mk(0.30, 0.31, 0.45, 0.46)), id: 'z', label: 'in-play', inPlay: true },
    { id: 'w', label: 'stale', q: { ...mk(0.30, 0.31, 0.45, 0.46).q, t: NOW - cfg.maxDataAgeSec * 1000 - 1 } },
  ], cfg, NOW);
  ok('every rejection is counted', s.rejects.get('no quote') === 1 && s.rejects.get('in-play') === 1
    && s.rejects.get('stale quote') === 1 && s.rejects.get('gap under minGap') === 1, [...s.rejects]);
  ok('staleN and inPlayN still agree with the ledger', s.staleN === 1 && s.inPlayN === 1, { staleN: s.staleN, inPlayN: s.inPlayN });
  ok('a pair that cannot be priced never becomes `widest`',
    d.scan([{ id: 'c', label: 'crossed', q: mk(0.90, 0.10, 0.50, 0.51).q }], cfg, 1).widest === null);

  // A pair that TRADED is not a rejection. The convergence candidate on an arb pair is usually
  // vetoed on its own terms, but the ledger answers "why did nothing trade" -- so counting a pair
  // the desk actually traded, and stamping a veto onto its tape line, is a false entry.
  // The fixture has to emit an arb AND have its convergence candidate vetoed, or the assertion
  // passes vacuously: on a pair where the convergence candidate is itself valid, `veto` is null
  // and the ledger stays empty whether or not the bug is present. Spreads of 15c do both jobs --
  // a fat locked arb, and a convergence candidate gated out on maxSpread.
  const arbPair = { ...fresh(mk(0.30, 0.45, 0.60, 0.75)), id: 'arb1' };
  const one = d.pairSignals(arbPair, cfg);
  ok('fixture emits an arb', one.signals.length === 1 && one.signals[0].type === 'arb', one.signals);
  ok('...while its convergence candidate IS vetoed', one.veto === 'spread over maxSpread', one.veto);
  const t = d.scan([arbPair], cfg, NOW);
  ok('a traded pair contributes nothing to the ledger', t.rejects.size === 0, [...t.rejects]);
  ok('and carries no veto onto the tape', t.veto.get('arb1') === undefined, t.veto.get('arb1'));
  ok('a genuinely rejected pair still does', d.scan([fresh(mk(0.50, 0.51, 0.50, 0.51))], cfg, NOW).rejects.size === 1);
}

group('conviction scales within the position cap, and still scales');
{
  // a zero-fee (geopolitics) Polymarket market, so the arithmetic below is the cap alone
  const zfp = mk(0.4, 0.41, 0.5, 0.51); zfp.q.pmFeeRate = 0;
  const sig = { pair: zfp, legs: [{ venue: 'PM', side: 'yes', px: 0.40 }] };
  const books = [{ asks: [{ price: 0.40, size: 1e6 }] }];
  // KETT passes a FRACTION of the cap: baseSizeMult when neutral, 1 when ILSA reads converging.
  const neutral = d.sizePlan(sig, { budget: 200, sizeMult: cfg.baseSizeMult, books, cfg });
  const conviction = d.sizePlan(sig, { budget: 200, sizeMult: 1, books, cfg });
  ok('a converging read really does buy more contracts', conviction.qty > neutral.qty, { neutral: neutral.qty, conviction: conviction.qty });
  ok('by the documented ~25%', Math.abs(conviction.qty / neutral.qty - 1 / cfg.baseSizeMult) < 0.01, conviction.qty / neutral.qty);
  ok('and conviction still lands exactly on the cap', conviction.qty === Math.floor(200 / 0.40), conviction.qty);
  ok('neither is flagged as capped', neutral.capped === false && conviction.capped === false);
  // defence in depth: a multiplier ABOVE 1 (the old `budget * 1.25`) still cannot breach the cap
  const over = d.sizePlan(sig, { budget: 200, sizeMult: 1.25, books, cfg });
  ok('a multiplier over 1 cannot spend past the cap', over.qty === conviction.qty, { over: over.qty, cap: conviction.qty });
  ok('and is reported as capped so it is not silent', over.capped === true);
  // the breach that used to be live: floor(200 * 1.25 / 0.40) = 625 contracts = $250 = 2.5% of a
  // $10k book, against MAX_POSITION_PCT of 2% and a README promising 2%
  ok('the breach it prevents was 25% over the rail', Math.floor(200 * 1.25 / 0.40) * 0.40 === 250);
  ok('depth still caps size below the budget',
    d.sizePlan(sig, { budget: 200, sizeMult: 1, books: [{ asks: [{ price: 0.40, size: 7 }] }], cfg }).qty === 7);
  const zero = d.sizePlan({ pair: sig.pair, legs: [{ venue: 'PM', side: 'yes', px: 0 }] }, { budget: 200, books: [{ asks: [] }], cfg });
  ok('a zero unit cost cannot size Infinity', zero.qty === 0 && Number.isFinite(zero.qty), zero);
  // on a 0.05 market the unit cost carries 0.05 x 0.40 x 0.60 = 1.2c of taker fee
  const feeP = mk(0.4, 0.41, 0.5, 0.51); feeP.q.pmFeeRate = 0.05;
  const withFee = d.sizePlan({ pair: feeP, legs: sig.legs }, { budget: 200, sizeMult: 1, books, cfg });
  ok('a Polymarket leg\'s unit cost includes its market\'s taker fee', Math.abs(withFee.unitCost - 0.412) < 1e-9 && withFee.qty === Math.floor(200 / 0.412), withFee);
}

group('exitIntent reads one mark in every branch');
{
  const q = mk(0.40, 0.41, 0.50, 0.51).q;
  const stop = d.exitIntent({ strategy: 'converge', entry: 0.60, mark: 0.48, openedAt: 0 }, { inPlay: false, q }, cfg, 60 * 60000);
  ok('a marked loser stops out', stop && /^stop:/.test(stop.reason), stop);
  ok('at a finite price', stop && Number.isFinite(stop.px), stop);
  // an UNMARKED position: the price exits used to read pos.mark directly, so `undefined - entry`
  // was NaN, NaN fails every comparison, and the stop could never fire
  const closed = d.exitIntent({ strategy: 'converge', entry: 0.60, openedAt: 0 }, { inPlay: false, q: mk(0.50, 0.51, 0.50, 0.51).q }, cfg, 60 * 60000);
  ok('an unmarked position books a real exit price', closed && closed.px === 0.60, closed);
  ok('never undefined', closed && Number.isFinite(closed.px), closed);
  ok('NaN really does defeat the stop comparison', !((undefined - 0.60) <= -cfg.stopLoss));
  ok('arb positions are left to resolution', d.exitIntent({ strategy: 'arb', entry: 0.4, mark: 0.1, openedAt: 0 }, { inPlay: false, q }, cfg, 1e12) === null);
}

group('paper convergence positions use the tighter percentage stop');
{
  // Keep the venue gap open so the convergence exit does not outrank the stop in these fixtures.
  const pair = { inPlay: false, q: mk(0.08, 0.09, 0.13, 0.14).q };
  const paper = { ...cfg, mode: 'paper', stopLoss: 0.06, paperStopLossPct: 0.20 };
  const live = { ...paper, mode: 'live' };
  const pos = { strategy: 'converge', entry: 0.10, mark: 0.079, openedAt: 0 };
  const stopped = d.exitIntent(pos, pair, paper, 60000);
  ok('a cheap paper contract stops at a 20% loss instead of waiting for 6c', stopped && /^stop:/.test(stopped.reason), stopped);
  ok('the journal reason names both the percentage loss and effective limit', /21\.0% loss, 2\.0c limit/.test(stopped.reason), stopped);
  ok('the same move does not change live-mode exits', d.exitIntent(pos, pair, live, 60000) === null);
  ok('a paper move inside the percentage limit stays open', d.exitIntent({ ...pos, mark: 0.081 }, pair, paper, 60000) === null);
  ok('locked arbs remain exempt from the proportional stop', d.exitIntent({ ...pos, strategy: 'arb' }, pair, paper, 60000) === null);
}

group('paper gain lock protects a peak and keeps a runner');
{
  const gc = { ...cfg, mode: 'paper', gainLockTriggerPct: 0.10, gainLockGivebackPct: 0.03, gainLockRetainPct: 0.50 };
  const pos = { strategy: 'converge', entry: 0.50, mark: 0.60, gainPeak: 0.60, gainLockDone: false, qty: 10 };
  ok('no lock while the peak holds', d.gainLockIntent(pos, gc) === null);
  const lock = d.gainLockIntent({ ...pos, mark: 0.56 }, gc);
  ok('retracement returns a partial close', lock && lock.qty === 5, lock);
  ok('a live-mode position is untouched', d.gainLockIntent({ ...pos, mark: 0.56 }, { ...gc, mode: 'live' }) === null);
}

group('riskState and biasFor take their numbers from config');
{
  const base = { operatorHalt: null, age: 1, drawdown: 0, errs: 0, mode: 'paper', liveReady: true, cfg };
  ok('clean state does not halt', d.riskState(base) === null);
  ok('the operator halt outranks everything', d.riskState({ ...base, operatorHalt: 'stopped', age: NaN }) === 'stopped');
  ok('the API-error rail is the configured one', d.riskState({ ...base, errs: cfg.maxApiErrors }) !== null);
  ok('and does not fire one under it', d.riskState({ ...base, errs: cfg.maxApiErrors - 1 }) === null);
  const h = [{ pmMid: 0.40, ksMid: 0.50, t: 0 }, { pmMid: 0.42, ksMid: 0.50, t: 1 }, { pmMid: 0.45, ksMid: 0.50, t: 60000 }];
  ok('a narrowing gap reads as converging', d.biasFor(h, cfg).score > 0, d.biasFor(h, cfg));
  ok('too little history reads as nothing', d.biasFor([h[0]], cfg) === null);
  ok('a history without timestamps does not report NaN minutes',
    d.biasFor(h.map(({ t, ...r }) => r), cfg).mins === null);
  // config bounds these, so no env value can index off the end of history and throw inside ILSA's
  // per-pair loop (which would abort the whole cycle: no exits, no trades, no tape line)
  ok('the lookback config is a usable integer', Number.isInteger(cfg.biasLookback) && cfg.biasLookback >= 2, cfg.biasLookback);
  ok('biasFor survives a history shorter than the lookback', d.biasFor(h, { ...cfg, biasLookback: 999 }) !== null);
  // http.js keeps at most 200 error timestamps, so a threshold above that could never fire
  ok('the API-error rail stays inside the buffer that feeds it', cfg.maxApiErrors <= 200, cfg.maxApiErrors);
}

group('a convergence trade needs a thick venue to lean on');
{
  // 4c gap, tight books, and the two venues carrying the same volume. Fair sits in the middle of
  // the gap, so the realisable move is half of it -- the shape of the desk's largest taker loss.
  const even = d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 5e5, 5e5), { ...cfg, minArbEdge: 1 });
  ok('even venues are vetoed by name', even.veto === 'venues too even', even.veto);
  ok('...and emit nothing', even.signals.length === 0, even.signals);
  ok('...but the near-miss is still priced for the tape', even.best && even.best.edge != null, even.best);
  const lopsided = d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 15e5, 5e5), { ...cfg, minArbEdge: 1 });
  ok('a 3:1 venue clears the gate', lopsided.veto !== 'venues too even', lopsided.veto);
  const nearly = d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 14e5, 5e5), { ...cfg, minArbEdge: 1 });
  ok('2.8:1 does not', nearly.veto === 'venues too even', nearly.veto);
  // structural gates come first: a pair with no gap is reported as that, not as too even
  const flat = d.pairSignals(mk(0.50, 0.51, 0.50, 0.51, 5e5, 5e5), cfg);
  ok('no gap is still reported as no gap', flat.veto === 'gap under minGap', flat.veto);
  ok('the ratio comes from config', d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 5e5, 5e5), { ...cfg, minArbEdge: 1, convMinVolRatio: 1 }).veto !== 'venues too even');
  // zero 24h volume on either venue is not "infinitely thin," it is no data at all. The ratio check
  // divides by `thin`, so a literal zero used to auto-pass regardless of how thin the OTHER side
  // was too -- real losses this week cleared this gate on 0-vs-44, 20-vs-0 and even 0-vs-0. Named
  // separately from `venues too even` so the gate ledger says which failure actually happened.
  const oneSideZero = d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 5e5, 0), { ...cfg, minArbEdge: 1 });
  ok('a venue with no reported volume is vetoed by name, not treated as infinitely thin',
    oneSideZero.veto === 'no volume on one venue', oneSideZero.veto);
  const bothSidesZero = d.pairSignals(mk(0.40, 0.41, 0.44, 0.45, 0, 0), { ...cfg, minArbEdge: 1 });
  ok('two venues both reporting zero volume is the same failure, not "even"',
    bothSidesZero.veto === 'no volume on one venue', bothSidesZero.veto);
}

group('fair value excludes a venue whose own spread is too wide to trust');
{
  // A tight, liquid Kalshi book straddled by a wide-open, untraded Polymarket one. Blending the
  // Polymarket mid in at full weight (the old behaviour) drags fair value toward a number no one
  // could actually trade into; excluding it should leave fair pinned to the tight venue.
  const wideVsTight = { pmBid: 0.04, pmAsk: 0.48, ksBid: 0.49, ksAsk: 0.50, pmMid: 0.26, ksMid: 0.495, pmVol: 0, ksVol: 5e5 };
  const fair = d.fairValue(wideVsTight, cfg);
  ok('a 44c-wide, untraded venue does not move fair value off the tight one',
    Math.abs(fair - wideVsTight.ksMid) < 0.005, fair);
  // both venues wide: nothing to lean on, so fall back to a plain average rather than divide by zero
  const bothWide = { pmBid: 0.10, pmAsk: 0.60, ksBid: 0.20, ksAsk: 0.70, pmMid: 0.35, ksMid: 0.45, pmVol: 0, ksVol: 0 };
  const fairBoth = d.fairValue(bothWide, cfg);
  ok('both venues wide falls back to a plain average, not NaN',
    Math.abs(fairBoth - (bothWide.pmMid + bothWide.ksMid) / 2) < 1e-9, fairBoth);
  // two venues inside maxSpread behave exactly as before: a plain volume-weighted blend
  const tight = { pmBid: 0.40, pmAsk: 0.41, ksBid: 0.44, ksAsk: 0.45, pmMid: 0.405, ksMid: 0.445, pmVol: 5e5, ksVol: 1e5 };
  const want = (0.405 * (5e5 + 100) + 0.445 * (1e5 + 100)) / (5e5 + 100 + 1e5 + 100);
  ok('two tight venues still blend by volume as before', Math.abs(d.fairValue(tight, cfg) - want) < 1e-9);
}

group('a locked arb is unwound only when the gain clears the exit fee');
{
  // 202 pairs, marks summing to 1.010: $2.02 over holding, before a $3.30 Kalshi exit fee
  // (ceil(0.07 x 202 x 0.36 x 0.64) = $3.26 -> $3.30 at the 0.37 mark below)
  // Polymarket legs here are on a zero-fee market; the Polymarket fee has its own assertion below
  const leg = (venue, mark, qty = 202) => ({ venue, mark, qty, ref: 'KXTEST', feeRate: venue === 'PM' ? 0 : undefined });
  const c = { ...cfg, ksFeeRate: 0.07, arbUnwindMargin: 0.005 };
  ok('the cloud box\'s three unwinds would not have happened', d.arbUnwind([leg('PM', 0.65), leg('KS', 0.36)], c) === null);
  // bids summing to 1.03: $6.06 over holding, $3.30 of fee, $2.76 net = 1.37c a contract > 0.5c
  const u = d.arbUnwind([leg('PM', 0.66), leg('KS', 0.37)], c);
  ok('a sum that clears the fee and the margin unwinds', !!u, u);
  ok('...netting the fee in the reason', u && /exit fee/.test(u.reason) && Math.abs(u.fee - 3.3) < 0.01, u);
  ok('...and stating the gain over holding', u && Math.abs(u.gain - 2.76) < 0.02, u);
  ok('the margin is per contract and from config', d.arbUnwind([leg('PM', 0.66), leg('KS', 0.37)], { ...c, arbUnwindMargin: 0.02 }) === null);
  ok('a pair on zero-fee Polymarket markets alone pays no exit fee', d.arbUnwind([leg('PM', 0.65), leg('PM', 0.36)], c) !== null);
  // the same Polymarket leg on a 0.05 market pays 0.05 x 202 x 0.66 x 0.34 = $2.27 on the way out,
  // which turns the $2.76 unwind above into $0.49 -- under the 0.5c x 202 = $1.01 margin
  const feeLeg = { ...leg('PM', 0.66), feeRate: 0.05 };
  ok('a Polymarket leg pays its market\'s exit fee too', d.arbUnwind([feeLeg, leg('KS', 0.37)], c) === null);
  ok('...and a leg with no recorded rate pays the fallback, never zero', d.arbUnwind([{ ...leg('PM', 0.66), feeRate: undefined }, leg('KS', 0.37)], c) === null);
  ok('an unmarked leg is never unwound', d.arbUnwind([leg('PM', 0.66), { venue: 'KS', mark: null, qty: 202 }], c) === null);
  ok('a lone leg is not a pair', d.arbUnwind([leg('PM', 0.9)], c) === null);
}

group('the Polymarket leg wins when both venues are similarly off fair');
{
  // Same gap either way: PM 0.40/0.41 against KS 0.48/0.49 with equal volume puts fair in the
  // middle. Buying YES on PM and NO on KS are both 4c from fair before fees; PM pays none. (The
  // even split is vetoed for trading, but `best` is priced regardless, which is what is tested.)
  // That holds on a ZERO-fee Polymarket market (geopolitics). On the rest, Polymarket charges too.
  const zq = () => { const p = mk(0.40, 0.41, 0.48, 0.49, 5e5, 5e5); p.q.pmFeeRate = 0; return p; };
  const r = d.pairSignals(zq(), { ...cfg, minArbEdge: 1 });
  ok('the best candidate is on Polymarket', r.best && r.best.venue === 'PM', r.best);
  const pm = d.convEdge('PM', 'yes', zq().q, 0.445, cfg, 'KXTEST');
  const ksn = d.convEdge('KS', 'no', zq().q, 0.445, cfg, 'KXTEST');
  ok('...by exactly the Kalshi fee, both ways', pm.edge > ksn.edge && Math.abs((pm.edge - ksn.edge) - (ks.feePerContract(0.52, 0.07, 'KXTEST') + ks.feePerContract(0.55, 0.07, 'KXTEST'))) < 1e-6, { pm: pm.edge, ks: ksn.edge });
  const fq = mk(0.40, 0.41, 0.48, 0.49, 5e5, 5e5).q; fq.pmFeeRate = 0.05;
  const pmFee = d.convEdge('PM', 'yes', fq, 0.445, cfg, 'KXTEST');
  // in at 0.41, out at fair minus half the spread
  const exit = 0.445 - 0.005;
  ok('a 0.05 Polymarket market costs exactly its fee in and out', Math.abs((pm.edge - pmFee.edge) - (pmv.feePerShare(0.41, 0.05) + pmv.feePerShare(exit, 0.05))) < 1e-9, { free: pm.edge, charged: pmFee.edge });
  const unknown = mk(0.40, 0.41, 0.48, 0.49, 5e5, 5e5).q;
  ok('a quote that does not carry a rate is priced at the fallback', Math.abs(d.convEdge('PM', 'yes', unknown, 0.445, cfg, 'KXTEST').edge - (pm.edge - pmv.feePerShare(0.41, cfg.pmFeeFallback) - pmv.feePerShare(exit, cfg.pmFeeFallback))) < 1e-9);
  ok('the fallback is never below the highest category rate', cfg.pmFeeFallback >= 0.07, cfg.pmFeeFallback);
}

group('a locked arb nets the Polymarket fee on its Polymarket leg');
{
  const base = mk(0.40, 0.41, 0.50, 0.51); base.q.pmFeeRate = 0;
  const charged = mk(0.40, 0.41, 0.50, 0.51); charged.q.pmFeeRate = 0.04;
  const a = d.pairSignals(base, cfg).signals[0], b = d.pairSignals(charged, cfg).signals[0];
  ok('both are arbs', a && b && a.type === 'arb' && b.type === 'arb', [a && a.type, b && b.type]);
  ok('the edge falls by exactly the fee on the Polymarket YES at its ask', a && b && Math.abs((a.edge - b.edge) - pmv.feePerShare(0.41, 0.04)) < 1e-9, a && b && { free: a.edge, charged: b.edge });
}

group('pairs stop trading before their Kalshi market closes, not only before a game');
{
  const NOW = 1788900000000;
  const H = 3600000;
  const game = { kind: 'game', startsAt: NOW + 10 * 60000, closesAt: NOW + 72 * H };
  ok('a game is tradeable 10 minutes before start', d.liveWindow(game, NOW, cfg) === false);
  ok('...and live from 2 minutes before', d.liveWindow({ ...game, startsAt: NOW + 60000 }, NOW, cfg) === true);
  ok('a game with no start time is live', d.liveWindow({ kind: 'game' }, NOW, cfg) === true);
  // the Fed: Kalshi closes 17:59Z for an 18:00Z statement
  const fed = { kind: 'fed', closesAt: NOW + 2 * H };
  ok('a Fed pair two hours from close is tradeable', d.liveWindow(fed, NOW, cfg) === false);
  ok(`...and not from ${cfg.closeGuardMin} minutes before close`, d.liveWindow({ ...fed, closesAt: NOW + (cfg.closeGuardMin - 1) * 60000 }, NOW, cfg) === true);
  ok('a pair with no close time and no start is never live on time alone', d.liveWindow({ kind: 'fed' }, NOW, cfg) === false);
  ok('close time is an extra rule for games, not a replacement', d.liveWindow({ ...game, closesAt: NOW + 5 * 60000 }, NOW, cfg) === true);

  // convergence is not opened on a market that closes inside max hold plus the guard
  const soon = { ...mk(0.05, 0.06, 0.07, 0.11, 1e5, 5e5), closesAt: NOW + (cfg.maxHoldMin + cfg.closeGuardMin - 1) * 60000 };
  soon.q.pmFeeRate = 0;
  const far = { ...soon, closesAt: NOW + (cfg.maxHoldMin + cfg.closeGuardMin + 1) * 60000 };
  ok('a market closing inside max hold is vetoed by name', d.pairSignals(soon, cfg, NOW).veto === 'closes inside max hold', d.pairSignals(soon, cfg, NOW).veto);
  ok('...and one closing after it is not', d.pairSignals(far, cfg, NOW).veto !== 'closes inside max hold', d.pairSignals(far, cfg, NOW).veto);
  ok('without a clock the gate is skipped', d.pairSignals(soon, cfg).veto !== 'closes inside max hold');
  const sc = d.scan([{ ...soon, q: { ...soon.q, t: NOW } }], cfg, NOW);
  ok('scan passes its clock through', sc.rejects.get('closes inside max hold') === 1, [...sc.rejects]);

  // a held convergence position is flattened at close minus the guard, even with no pair at all
  const pos = { strategy: 'converge', entry: 0.40, mark: 0.41, openedAt: NOW - 10 * 60000, closesAt: NOW + 30 * 60000 };
  const x = d.exitIntent(pos, undefined, cfg, NOW);
  ok('a position inside the close guard exits with its pair gone', x && /market closes in 30m/.test(x.reason) && x.px === 0.41, x);
  ok('...and not before the guard', d.exitIntent({ ...pos, closesAt: NOW + (cfg.closeGuardMin + 5) * 60000 }, undefined, cfg, NOW) === null);
  ok('a position with no close time keeps the old behaviour', d.exitIntent({ ...pos, closesAt: undefined }, undefined, cfg, NOW) === null);
  ok('arb legs are still left to settlement', d.exitIntent({ ...pos, strategy: 'arb' }, undefined, cfg, NOW) === null);
}

group('arbs and convergence bets have separate books, and an arb counts once');
{
  const c = { ...cfg, maxOpenPositions: 12, maxArbGroups: 12 };
  const arbLegs = (n) => Array.from({ length: n }, (_, i) => [
    { strategy: 'arb', group: `g${i}`, venue: 'PM' }, { strategy: 'arb', group: `g${i}`, venue: 'KS' }]).flat();
  const arb = { type: 'arb', legs: [{}, {}] }, conv = { type: 'converge', legs: [{}] };
  ok('six arbs (twelve legs) leave room for more arbs', d.bookFull(arbLegs(6), arb, c) === null);
  ok('...and for a convergence bet', d.bookFull(arbLegs(6), conv, c) === null);
  ok('the twelfth arb is allowed', d.bookFull(arbLegs(11), arb, c) === null);
  ok('the thirteenth is not, and says so', /arb book full at 12 arbs/.test(d.bookFull(arbLegs(12), arb, c)), d.bookFull(arbLegs(12), arb, c));
  const bets = Array.from({ length: 12 }, (_, i) => ({ strategy: 'converge', group: `c${i}` }));
  ok('twelve convergence bets fill their book', /book full at 12 positions/.test(d.bookFull(bets, conv, c)));
  ok('...but not the arb book', d.bookFull(bets, arb, c) === null);
}

group('a locked arb has to be worth the wait');
{
  const NOW = 1788900000000, DAY = 86400000;
  ok('a 1c arb settling tomorrow annualises far above any hurdle', d.arbReturn(0.01, NOW + DAY, NOW) > 3);
  // J.D. Vance for the 2028 nomination: 2.46c after fees, 785 days
  ok('the 2028 Vance arb annualises near 1.2%', Math.abs(d.arbReturn(0.0246, NOW + 785 * DAY, NOW) - 0.0116) < 0.001, d.arbReturn(0.0246, NOW + 785 * DAY, NOW));
  ok('a game settling within the day counts as one day, not an infinite return', d.arbReturn(0.01, NOW + 3600000, NOW) === d.arbReturn(0.01, NOW + DAY, NOW));
  const arbPair = (settlesAt) => { const p = mk(0.40, 0.41, 0.50, 0.51); p.q.pmFeeRate = 0; p.settlesAt = settlesAt; return p; };
  const soon = d.pairSignals(arbPair(NOW + 10 * DAY), cfg, NOW);
  ok('an arb settling in 10 days is taken', soon.signals.length === 1 && soon.signals[0].type === 'arb', soon.signals);
  const late = d.pairSignals(arbPair(NOW + 20000 * DAY), cfg, NOW);
  ok('the same edge settling decades out is not an arb signal', !late.signals.some((x) => x.type === 'arb'), late.signals);
  ok('...and says why', late.arbVeto === 'arb return under hurdle', late);
  const sc = d.scan([{ ...arbPair(NOW + 20000 * DAY), q: { ...arbPair(0).q, t: NOW } }], { ...cfg, maxSpread: 0 }, NOW);
  ok('the ledger reports the hurdle, not the convergence gate, when an arb existed', sc.rejects.get('arb return under hurdle') === 1, [...sc.rejects]);
  ok('without a settlement time the hurdle is not applied', d.pairSignals({ ...arbPair(NaN) }, cfg, NOW).signals[0].type === 'arb');
}

group('long-dated arbs have a budget of their own');
{
  const NOW = 1788900000000, DAY = 86400000;
  const c = { ...cfg, maxArbGroups: 12, maxLongArbGroups: 3, longDays: 30 };
  const legs = (n, days) => Array.from({ length: n }, (_, i) => [
    { strategy: 'arb', group: `L${days}-${i}`, settlesAt: NOW + days * DAY }, { strategy: 'arb', group: `L${days}-${i}`, settlesAt: NOW + days * DAY }]).flat();
  const sig = (days) => ({ type: 'arb', legs: [{}, {}], pair: { settlesAt: NOW + days * DAY } });
  ok('three long arbs held: a fourth long one is refused', /long-dated arb budget full at 3/.test(d.bookFull(legs(3, 200), sig(400), c, NOW)), d.bookFull(legs(3, 200), sig(400), c, NOW));
  ok('...but a short one is still taken', d.bookFull(legs(3, 200), sig(5), c, NOW) === null);
  ok('short arbs do not use the long budget', d.bookFull(legs(8, 5), sig(400), c, NOW) === null);
  ok('without a clock only the overall limit applies', d.bookFull(legs(3, 200), sig(400), c) === null);
}

group('rules-unverified pairs are priced but never traded');
{
  const NOW = 1e12;
  const p = { ...mk(0.40, 0.41, 0.50, 0.51), id: 'w', kind: 'event', watchOnly: 'unclear' };
  p.q = { ...p.q, pmFeeRate: 0, t: NOW };
  const s = d.scan([p], cfg, NOW);
  ok('no signal from a watch-only pair, even a fat arb', s.signals.length === 0, s.signals);
  ok('it is still priced for the tape', s.fair.has('w') && s.best.get('w') != null);
  ok('and its veto names the rules verdict', s.veto.get('w') === 'rules unverified' || s.veto.get('w') === 'rules unclear', s.veto.get('w'));
}

group('an any-market signal must persist before it is acted on');
{
  const c = { ...cfg, entryPersistCycles: 3 };
  const ev = { type: 'arb', pair: { id: 'e1', kind: 'event' } }, fed = { type: 'arb', pair: { id: 'f1', kind: 'fed' } };
  let counts = new Map();
  const r1 = d.persistFilter([ev, fed], counts, c); counts = r1.counts;
  ok('a Fed pair acts at once, as before', r1.kept.includes(fed));
  ok('an any-market pair does not act on its first cycle', !r1.kept.includes(ev));
  const r2 = d.persistFilter([ev], counts, c); counts = r2.counts;
  const r3 = d.persistFilter([ev], counts, c); counts = r3.counts;
  ok('it acts on the third consecutive cycle', !r2.kept.includes(ev) && r3.kept.includes(ev));
  const gap = d.persistFilter([], counts, c);
  const again = d.persistFilter([ev], gap.counts, c);
  ok('a cycle without the signal starts the count again', !again.kept.includes(ev) && again.counts.get('e1') === 1);
}

group('a locked arb is re-priced from the books fetched for it');
{
  const p = mk(0.40, 0.41, 0.50, 0.51); p.q.pmFeeRate = 0.04;
  const sig = { type: 'arb', pair: p, legs: [{ venue: 'PM', side: 'yes', px: 0.41 }, { venue: 'KS', side: 'no', px: 0.50 }] };
  const live = d.arbEdgeLive(sig, [{ asks: [{ price: 0.41, size: 100 }] }, { asks: [{ price: 0.50, size: 100 }] }], cfg);
  const want = 1 - (0.41 + pmv.feePerShare(0.41, 0.04) + 0.50 + ks.feePerContract(0.50, cfg.ksFeeRate, 'KXTEST'));
  ok('the live edge nets both fees at the live asks', Math.abs(live - want) < 1e-9, { live, want });
  ok('a leg whose book moved away kills the edge', d.arbEdgeLive(sig, [{ asks: [{ price: 0.52, size: 100 }] }, { asks: [{ price: 0.50, size: 100 }] }], cfg) < 0);
  ok('an empty side is null, not a price', d.arbEdgeLive(sig, [{ asks: [] }, { asks: [{ price: 0.50, size: 1 }] }], cfg) === null);
}

group('property: the arb is the better signal wherever both are available');
{
  let both = 0, convWon = 0, worst = 0;
  for (let pmBid = 0.05; pmBid <= 0.90; pmBid += 0.01)
    for (let sp = 0.01; sp <= 0.05; sp += 0.01)
      for (let gap = -0.20; gap <= 0.20; gap += 0.005)
        for (let sk = 0.01; sk <= 0.05; sk += 0.01) {
          const pmAsk = pmBid + sp, pmMid = pmBid + sp / 2, ksMid = pmMid + gap, ksBid = ksMid - sk / 2, ksAsk = ksMid + sk / 2;
          if (ksBid < 0.01 || ksAsk > 0.99) continue;
          const q = { pmBid, pmAsk, ksBid, ksAsk, pmMid, ksMid, pmVol: 5e5, ksVol: 4e5, t: 1 };
          if (d.quoteFault(q)) continue;
          // the venues-too-even gate is switched off for this grid: the property is about the
          // economics of the two signal kinds, and the README's numbers were measured at 5:4
          const r = d.pairSignals({ id: 'x', label: 'g', ks: { ticker: 'KXTEST' }, q }, { ...cfg, convMinVolRatio: 0 });
          const arb = r.signals.find((s) => s.type === 'arb');
          if (!arb || r.veto !== null) continue;
          both++;
          const fair = d.fairValue(q, cfg);
          let bc = null;
          for (const v of ['PM', 'KS']) for (const side of ['yes', 'no']) {
            const c = d.convEdge(v, side, q, fair, cfg, 'KXTEST');
            if (!bc || c.edge > bc.edge) bc = c;
          }
          if (bc.edge > arb.edge) { convWon++; worst = Math.max(worst, bc.edge - arb.edge); }
        }
  // Not a strict dominance: with a lopsided spread the convergence edge can be nominally larger.
  // It is never larger by enough to be worth an unhedged position, which is the claim that matters.
  ok('both are available on a meaningful share of the grid', both > 10000, both);
  ok('the arb is the bigger edge in the overwhelming majority', convWon / both < 0.01, `${convWon}/${both}`);
  ok('and never loses by more than half a cent', worst < 0.005, `${(worst * 100).toFixed(2)}c`);
  console.log(`  (arb available alongside a valid convergence candidate in ${both} cells; convergence nominally larger in ${convWon}, by at most ${(worst * 100).toFixed(2)}c)`);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

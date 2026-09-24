'use strict';
// Thin-market probe.
//
// The 7-day history scan (tools/history-scan.js) found three NCAAF pairs — Grambling St v TCU,
// Norfolk St v Virginia, Florida A&M v Miami — where Polymarket sat near 50c while Kalshi priced
// the same outcome at 1-2c, for 51 to 89 hours at a stretch. On paper that is a 20c+ per-contract
// edge. Nobody took it. A real 20c edge on a binary market is gone in seconds, so the likely
// explanation is that there was no book behind the Polymarket number.
//
// That could not be settled after the fact: neither venue publishes historical order books, only
// historical prices. So this settles it going forward. Whenever the venues disagree by more than
// PROBE_GAP, dump BOTH full ladders to disk alongside the quote. If the depth is real, the gap is
// a strategy — and a different one than this desk was built for. If the book is empty, the thread
// is closed for good.
//
// Deliberately read-only: it never signals, never sizes, never trades. It only writes down what
// the book looked like at the moment the gap was visible.
const fs = require('fs');
const path = require('path');
const pm = require('./venues/polymarket');
const ks = require('./venues/kalshi');

const r3 = (x) => Math.round(x * 1000) / 1000;
const r2 = (x) => Math.round(x * 100) / 100;
const c = (x) => `${(x * 100).toFixed(1)}c`;
// How long the probe may take nothing before it says so. One hour: long enough that a quiet
// stretch is not chatter, short enough that a miscalibrated threshold is caught the same session.
const DARK_SEC = 3600;
const { ET_DAY } = require('./recorder');   // the Eastern day, one definition for every file that names one

// Contracts and dollars resting within `within` of the touch. This is the number that decides it:
// a price with no size behind it is a display artifact, not an opportunity.
function depth(levels, within) {
  if (!levels || !levels.length) return { levels: 0, contracts: 0, notional: 0, touch: null };
  const touch = levels[0].price;
  let contracts = 0, notional = 0, n = 0;
  for (const l of levels) {
    if (Math.abs(l.price - touch) > within + 1e-9) break;
    contracts += l.size; notional += l.size * l.price; n++;
  }
  return { levels: n, contracts: Math.round(contracts), notional: r2(notional), touch: r3(touch) };
}
const ladder = (levels, n = 10) => (levels || []).slice(0, n).map((l) => [r3(l.price), Math.round(l.size)]);

function makeProbe(cfg) {
  if (!cfg.record) return async () => {};       // probes ride along with the tape; off together
  const last = new Map();                        // pairId -> { at, day, gap } of its last probe
  let warnedAt = 0;
  let firedAt = 0;                               // last time ANY probe was taken
  let startedAt = 0;                             // first cycle, so a fresh desk is not "dark for 1h"
  let widestSeen = 0;                            // widest pre-game gap in the current dark window
  let windowAt = 0;                              // when that window was last judged
  // Is this pair worth another probe? Once per ET day, and again the same day only if its gap has
  // MOVED by probeMoveGap since the last one -- the question is whether size sits behind a gap, and
  // a steady gap answers it once. Never sooner than probeEverySec. The old rule was only the
  // 600s cooldown: on 2026-09-23 that probed KXBOND-30-ATJ and KXPRESPERSON-28-AOCA 147 times each,
  // 5,206 probes and ~10,400 order-book fetches on a CPU-capped box, for ~150 pairs whose answer
  // had not changed since morning.
  const fresh = (p, now, day) => {
    const l = last.get(p.id);
    if (!l) return true;
    if (now - l.at < cfg.probeEverySec * 1000) return false;
    return l.day !== day || Math.abs(Math.abs(p.q.ksMid - p.q.pmMid) - l.gap) >= cfg.probeMoveGap - 1e-9;
  };
  return async (E) => {
    const now = Date.now();
    if (!startedAt) startedAt = now;
    const day = ET_DAY.format(new Date(now));
    for (const [id, l] of last) if (l.day !== day && now - l.at >= cfg.probeEverySec * 1000) last.delete(id);   // yesterday's are eligible anyway
    for (const p of E.pairs) {
      if (p.inPlay || p.watchOnly || !p.q) continue;
      const g = Math.abs(p.q.ksMid - p.q.pmMid);
      if (g > widestSeen) widestSeen = g;
    }
    const due = E.pairs
      // In-play games are excluded, and this is the whole point of the filter rather than a
      // detail. The first four probes ever taken all landed on live MLB games, where Kalshi's
      // LISTING quote lagged its own order book by 13-22c: the listing said 0.425 while the book
      // said 0.63/0.65, and both venues actually agreed. Those are not opportunities, they are
      // listing lag on markets the desk already refuses to trade -- and because probes are ranked
      // by gap size and capped per cycle, they crowded out the pre-game thin-market cases the
      // probe was built to catch. Measured on the tradeable book, listing and order book agree
      // to 0.00c median and 0.00c max, which is also why there is no Kalshi equivalent of
      // refreshPairPrices: it would spend an API call per pair per cycle correcting nothing.
      .filter((p) => !p.inPlay)
      // A watch-only pair cannot trade until its rules are verified, so the depth behind its gap
      // answers nothing: 3,005 of 2026-09-23's 5,206 probes were on pairs vetoed 'rules unclear'.
      .filter((p) => !p.watchOnly)
      .filter((p) => p.q && Math.abs(p.q.ksMid - p.q.pmMid) >= cfg.probeGap)
      .filter((p) => fresh(p, now, day))
      .sort((a, b) => Math.abs(b.q.ksMid - b.q.pmMid) - Math.abs(a.q.ksMid - a.q.pmMid))
      .slice(0, cfg.probesPerCycle);            // bound the extra API calls per cycle
    // A probe that never fires is indistinguishable from a probe that keeps finding nothing, and
    // the difference is the whole value of the instrument. PROBE_GAP sat at 10c against a
    // pre-game book whose widest recorded gap was 3c, so this probe took zero samples for its
    // entire life and reported that fact nowhere -- the same silent-failure shape as a gate that
    // rejects with a bare `continue`. Say when the instrument is dark, and say which number would
    // end it, so the next miscalibration is a log line rather than an archaeology exercise.
    if (!due.length) {
      // measured from the last probe, or from boot if there has never been one -- otherwise a desk
      // that started thirty seconds ago reports an hour of darkness. Only when nothing reached the
      // bar: since a steady pair is probed once a day (2026-09-24), a quiet hour with gaps OVER it
      // means they were already probed today, which is the instrument working, not dark.
      // Each quiet hour is judged on its own widest gap, so one wide pair in the morning cannot
      // silence the report for the rest of the day.
      if (now - Math.max(firedAt, startedAt, windowAt) > DARK_SEC * 1000) {
        if (widestSeen && widestSeen < cfg.probeGap && E.due('probe-dark', DARK_SEC)) {
          E.log('TESS', 'OPS', null, `probe has taken nothing in ${(DARK_SEC / 3600).toFixed(0)}h \u00b7 widest pre-game gap seen ${c(widestSeen)} against PROBE_GAP ${c(cfg.probeGap)} \u00b7 the threshold is above anything this book offers`);
        }
        widestSeen = 0; windowAt = now;
      }
      return;
    }
    firedAt = now; widestSeen = 0;

    const lines = [];
    for (const p of due) {
      last.set(p.id, { at: now, day, gap: Math.abs(p.q.ksMid - p.q.pmMid) });   // stamp before the await: a
      try {                                      // failing pair must not be retried every 15s
        const [pb, kb] = await Promise.all([pm.fetchBook(p.pm.tokenId), ks.fetchBook(p.ks.ticker)]);
        const q = p.q;
        lines.push(JSON.stringify({
          t: new Date(now).toISOString(), cycle: E.cycle, pair: p.id, label: p.label,
          kind: p.kind, series: p.series, inPlay: !!p.inPlay,
          gap: r3(q.ksMid - q.pmMid), pmMid: r3(q.pmMid), ksMid: r3(q.ksMid),
          pmVol: Math.round(q.pmVol || 0), ksVol: Math.round(q.ksVol || 0),
          // the verdict fields: size resting within 2c of the touch on each side
          pmBidDepth: depth(pb.bids, 0.02), pmAskDepth: depth(pb.asks, 0.02),
          ksYesBidDepth: depth(kb.yesBids, 0.02), ksYesAskDepth: depth(kb.yesAsks, 0.02),
          // raw ladders, top 10 a side, for anything the summary above misses
          pmBids: ladder(pb.bids), pmAsks: ladder(pb.asks),
          ksYesBids: ladder(kb.yesBids), ksYesAsks: ladder(kb.yesAsks),
        }));
      } catch (e) {
        lines.push(JSON.stringify({
          t: new Date(now).toISOString(), cycle: E.cycle, pair: p.id, label: p.label,
          gap: r3(p.q.ksMid - p.q.pmMid), error: String(e.message).slice(0, 120),
        }));
      }
    }
    if (!lines.length) return;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.appendFileSync(path.join(cfg.dataDir, `probes-${ET_DAY.format(new Date(now))}.jsonl`), lines.join('\n') + '\n');
    } catch (e) {
      if (now - warnedAt > 300000) { warnedAt = now; E.log('TESS', 'OPS', null, `probe write failed: ${String(e.message).slice(0, 120)}`); }
    }
  };
}

module.exports = { makeProbe, depth };

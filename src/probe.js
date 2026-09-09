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
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

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
  const last = new Map();                        // pairId -> last probe time
  let warnedAt = 0;
  return async (E) => {
    const now = Date.now();
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
      .filter((p) => p.q && Math.abs(p.q.ksMid - p.q.pmMid) >= cfg.probeGap)
      .filter((p) => now - (last.get(p.id) || 0) >= cfg.probeEverySec * 1000)
      .sort((a, b) => Math.abs(b.q.ksMid - b.q.pmMid) - Math.abs(a.q.ksMid - a.q.pmMid))
      .slice(0, cfg.probesPerCycle);            // bound the extra API calls per cycle
    if (!due.length) return;

    const lines = [];
    for (const p of due) {
      last.set(p.id, now);                       // stamp before the await: a failing pair must not
      try {                                      // be retried every 15s
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

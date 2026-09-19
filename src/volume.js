'use strict';
// The desk's own trading volume, by the minute, for the dashboard's chart.
//
// Volume here is what THIS desk traded: dollars filled (contracts x price) and contracts, summed
// per minute, across both the maker and the cross-venue legs. It is not the markets' volume. It
// answers "how busy was the desk when the P&L moved?", which a P&L line alone cannot.
//
// Every fill already passes through the journal, so the counter listens there (engine.js wraps the
// journal writer). A restart would lose the counter, so it is rebuilt from the journal files, which
// are the durable record. A settlement is a payout, not a trade, and is not counted.
const fs = require('fs');
const path = require('path');

const KEEP_MS = 8 * 864e5;   // the chart's longest view is All, and All is what the desk has kept
const MINUTE = 6e4;
const FILL = /"kind":"(MAKER_FILL|MAKER_FLATTEN|OPEN|CLOSE_PARTIAL|CLOSE)"/;

// journal kind -> [contracts, price] of the trade it records, or null when it is not one
function trade(kind, p) {
  switch (kind) {
    case 'MAKER_FILL': case 'MAKER_FLATTEN': return [p.qty, p.px];
    case 'OPEN': return [p.qty, p.entry];
    case 'CLOSE': return [p.qty, p.exit];            // an early unwind; a SETTLE is a payout, not a sale
    case 'CLOSE_PARTIAL': return [p.sold, p.exit];
    default: return null;
  }
}

function makeVolume() {
  const by = new Map();   // the minute's start, in ms -> [contracts, dollars]
  const prune = (now) => { for (const m of by.keys()) if (m < now - KEEP_MS) by.delete(m); };
  function add(at, qty, px) {
    qty = Math.abs(+qty); px = +px;
    if (!Number.isFinite(qty) || !Number.isFinite(px) || qty <= 0 || px <= 0 || !Number.isFinite(at)) return;
    const m = Math.floor(at / MINUTE) * MINUTE, cell = by.get(m) || [0, 0];
    cell[0] += qty; cell[1] += qty * px;
    by.set(m, cell);
  }
  return {
    // one journal entry as it is written
    note(kind, payload, at = Date.now()) {
      const t = trade(kind, payload || {});
      if (t) add(at, t[0], t[1]);
    },
    // Rebuild from the journal files under `dir`. Never throws: a chart without its history is a
    // smaller chart, not a reason to stop the desk. Returns how many trades it read.
    load(dir, now = Date.now()) {
      let n = 0;
      try {
        const files = fs.readdirSync(dir).filter((f) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort().slice(-10);
        for (const f of files) {
          for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
            if (!FILL.test(line)) continue;
            let d; try { d = JSON.parse(line); } catch { continue; }
            const at = Date.parse(d.t), t = trade(d.kind, d);
            if (t && at >= now - KEEP_MS) { add(at, t[0], t[1]); n++; }
          }
        }
      } catch { /* no journal yet */ }
      return n;
    },
    // oldest first: [minute, contracts, dollars]. Only minutes that traded; the page fills the gaps.
    entries(now = Date.now()) {
      prune(now);
      return [...by].sort((a, b) => a[0] - b[0]).map(([m, [q, d]]) => [m, q, Math.round(d * 100) / 100]);
    },
  };
}

module.exports = { makeVolume, trade, KEEP_MS };

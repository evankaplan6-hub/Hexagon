'use strict';
// Tick tape: one JSON line per priced pair per cycle, appended to DATA_DIR/ticks-YYYY-MM-DD.jsonl.
// E.history keeps 240 mids per pair in memory and dies with the process; this is the durable
// version, and the only record of whether a tradeable gap ever actually existed.
const fs = require('fs');
const path = require('path');

const r3 = (x) => Math.round(x * 1000) / 1000;
const r4 = (x) => Math.round(x * 10000) / 10000; // edges live at sub-cent scale; 3dp would floor them
// Eastern day, matching the session day TESS rolls the drawdown limit on: a UTC filename would
// split an evening slate across two files.
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

function makeRecorder(cfg) {
  if (!cfg.record) return () => {};
  let warnedAt = 0;
  return (E) => {
    const now = Date.now();
    const lines = [];
    for (const p of E.pairs) {
      const q = p.q;
      if (!q) continue;
      const row = {
        t: new Date(now).toISOString(),
        // The quote's OWN observation time. The engine carries a pair's last good quote forward
        // when it fails to reprice (engine.step: `p.q = this.quote(p) || p.q`), so qt < t marks a
        // carried-over line — without it a stale price is indistinguishable from a flat market.
        qt: Number.isFinite(q.t) && q.t > 0 ? new Date(q.t).toISOString() : null,
        cycle: E.cycle, pair: p.id, label: p.label, kind: p.kind, series: p.series, inPlay: !!p.inPlay,
        pmBid: r3(q.pmBid), pmAsk: r3(q.pmAsk), pmVol: Math.round(q.pmVol || 0),
        ksBid: r3(q.ksBid), ksAsk: r3(q.ksAsk), ksVol: Math.round(q.ksVol || 0),
      };
      // present only when BRAM priced this pair this cycle (it skips in-play pairs entirely)
      if (p.fair != null) row.fair = r4(p.fair);
      if (p.best) { row.edge = r4(p.best.edge); row.venue = p.best.venue; row.side = p.best.side; }
      lines.push(JSON.stringify(row));
    }
    if (!lines.length) return;
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      // append-only, one write per cycle; the filename is re-derived every time, so the file
      // rotates itself at Eastern midnight with no bookkeeping
      fs.appendFileSync(path.join(cfg.dataDir, `ticks-${ET_DAY.format(new Date(now))}.jsonl`), lines.join('\n') + '\n');
    } catch (e) {
      // the tape must never halt the desk; rate-limited so a bad disk cannot flood the log
      if (now - warnedAt > 300000) { warnedAt = now; E.log('TESS', 'OPS', null, `tick recorder write failed: ${String(e.message).slice(0, 120)}`); }
    }
  };
}

module.exports = { makeRecorder };

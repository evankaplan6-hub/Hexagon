'use strict';
// Append-only trade journal.
//
// state.json is a SNAPSHOT, and a lossy one: state.log is capped at 500 entries and state.closed
// at 2000, both trimmed oldest-first. For a trading system that is backwards — the oldest evidence
// is the first thing destroyed, and the ledger you would want in a dispute is the one already gone.
// This is the durable record: every position opened, closed, settled or orphaned, appended and
// never rewritten. state.json remains the fast working copy; this is the history.
const fs = require('fs');
const path = require('path');

const { ET_DAY } = require('./recorder');   // the Eastern day, one definition for every file that names one

function makeJournal(cfg) {
  let warnedAt = 0;
  return (E, kind, payload) => {
    const now = Date.now();
    const line = JSON.stringify({ t: new Date(now).toISOString(), cycle: E.cycle, mode: cfg.mode, kind, ...payload });
    try {
      fs.mkdirSync(cfg.dataDir, { recursive: true });
      fs.appendFileSync(path.join(cfg.dataDir, `journal-${ET_DAY.format(new Date(now))}.jsonl`), line + '\n');
    } catch (e) {
      // the journal must never take the desk down, but a silent failure defeats the point
      if (now - warnedAt > 300000) { warnedAt = now; E.log('TESS', 'OPS', null, `journal write failed: ${String(e.message).slice(0, 120)}`); }
    }
  };
}

module.exports = { makeJournal };

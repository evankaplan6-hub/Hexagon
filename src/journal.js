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

// The desk's own comings and goings, so a restart nobody asked for leaves a trace (2026-09-24).
// Before this a crash was one console line on the box, and fly logs keeps about 30 minutes of
// those: the daily check could only count WATCHDOG lines, and a desk that crashed and was brought
// back by Fly's restart policy read as a quiet day. server.js writes START once at boot, STOP when
// a signal (a deploy, a Ctrl-C) ends it, and CRASH from the last-resort handlers. A heap abort or
// the kernel's OOM kill runs no handler at all, so those show up only as a START with no STOP,
// WATCHDOG or CRASH before it: tools/restarts.js counts exactly that. None of them moves money,
// and every journal reader (ledger-check, pnl-report, fillcheck, volume) passes them by.
const LIFECYCLE = ['START', 'STOP', 'WATCHDOG', 'CRASH'];
// 800 characters is the message and the first several frames: enough to find the line, and short
// enough that a crash loop cannot fill /data with stack traces.
function crashRecord(ev, e) {
  return { ev, stack: String((e && e.stack) || e).slice(0, 800) };
}

module.exports = { makeJournal, crashRecord, LIFECYCLE };

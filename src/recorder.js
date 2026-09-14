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

// ---------------------------------------------------------------- the emergency brake
// The Fly box keeps all of this on a 1GB volume, and a busy Eastern day of tape is 35-62MB. The
// normal way old tapes leave the box is the Mac pulling them down and deleting them only once the
// copy is proven identical (tools/fly-pull.js, run daily by ops/com.hexagon.pull.plist). This is
// for when that has stopped -- the Mac asleep for a week, fly logged out. A full disk does not
// just stop the tape: the journal, the append-only truth, and state.json fail to write with it.
// Losing the oldest tape is the cheaper failure, so below `tapeMinFreeMb` the recorder gives up
// old tapes, oldest first, to keep everything else writing.
const TICKS_FILE = /^ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const BRAKE_EVERY_MS = 3600000;   // free space moves a few MB an hour; checking per cycle buys nothing
const MB = 1024 * 1024;
const mb = (b) => (b / MB).toFixed(1);

// Pure: which tick tapes to delete, oldest first, so free space climbs back to the floor. Only
// files that are exactly ticks-<date>.jsonl count, and only for days BEFORE `today` -- today's
// tape is the one being written, and a journal or state.json is never a candidate at any price.
// It stops as soon as the sizes it has picked would cover the shortfall, so a small dip costs one
// old tape, not all of them. The caller re-measures after each deletion rather than trusting the
// sizes (the filesystem can free less than a file's length), so this is a plan, not a promise.
//   files: [{ name, size }]   today: 'YYYY-MM-DD' (Eastern)
function planTapeTrim(files, { today, freeBytes, minFreeBytes }) {
  if (!(freeBytes < minFreeBytes)) return [];
  const old = [];
  for (const f of files || []) {
    const m = f && TICKS_FILE.exec(f.name);
    if (m && m[1] < today) old.push(f);
  }
  // the date is fixed-width, so name order is date order
  old.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out = [];
  let free = freeBytes;
  for (const f of old) {
    if (free >= minFreeBytes) break;
    out.push(f.name);
    free += Math.max(0, Number(f.size) || 0);
  }
  return out;
}

// The brake itself. The hot path is one number comparison: the maker's requote timing is
// sensitive, so there is no directory scan per cycle -- one statfs on the first write and then at
// most once an hour, and a readdir only when that statfs says the disk is actually low. `io` is
// the fs module in production and a fake in tools/disk-test.js.
function makeDiskBrake(cfg, io = fs) {
  const minFreeBytes = Math.max(0, Number(cfg.tapeMinFreeMb) || 0) * MB;
  // Off when the knob is 0, and off for good when this Node has no statfs (it arrived in 18.15):
  // there is nothing to retry.
  if (!(minFreeBytes > 0) || typeof io.statfsSync !== 'function') return () => {};
  let nextAt = -Infinity;   // so the first write checks at once: a restart onto a full disk is the likeliest time to need it
  const freeNow = () => { const s = io.statfsSync(cfg.dataDir); return Number(s.bavail) * Number(s.bsize); };
  return (E, now) => {
    if (now < nextAt) return;
    nextAt = now + BRAKE_EVERY_MS;
    let free;
    // statfs failing (a filesystem that will not say) is not worth a log line or a retry next
    // cycle; the next look is already an hour out
    try { free = freeNow(); } catch { return; }
    if (!Number.isFinite(free) || free >= minFreeBytes) return;
    try {
      const today = ET_DAY.format(new Date(now));
      const files = [];
      for (const name of io.readdirSync(cfg.dataDir)) {
        if (!TICKS_FILE.test(name)) continue;
        try { files.push({ name, size: io.statSync(path.join(cfg.dataDir, name)).size }); } catch { /* gone already */ }
      }
      // one file at a time, re-measuring in between, so it stops the moment the floor is met
      for (;;) {
        const [victim] = planTapeTrim(files, { today, freeBytes: free, minFreeBytes });
        if (!victim) break;
        const f = files.splice(files.findIndex((x) => x.name === victim), 1)[0];
        try { io.unlinkSync(path.join(cfg.dataDir, victim)); }
        catch (e) { if (e && e.code === 'ENOENT') continue; throw e; }   // deleted under us: fine, move on
        try { free = freeNow(); } catch { free += f.size; }
        E.log('TESS', 'OPS', null, `disk low · deleted old tick tape ${victim} (${mb(f.size)} MB), ${mb(free)} MB free now · it may not have been copied to the Mac yet; run node tools/fly-pull.js on the Mac to archive tapes before the box has to do this`);
      }
      if (free < minFreeBytes) E.log('TESS', 'OPS', null, `disk low · ${mb(free)} MB free, under the ${cfg.tapeMinFreeMb} MB floor, and no old tick tape is left to delete · journals and today's tape are never deleted`);
    } catch (e) {
      // the brake must never take the cycle down with it
      try { E.log('TESS', 'OPS', null, `disk low · could not trim old tick tapes: ${String(e && e.message).slice(0, 120)}`); } catch { /* nothing left to tell */ }
    }
  };
}

function makeRecorder(cfg) {
  if (!cfg.record) return () => {};
  let warnedAt = 0;
  const brake = makeDiskBrake(cfg);
  return (E) => {
    const now = Date.now();
    // before the early return below: a cycle with nothing to write still owns the old tapes on disk
    brake(E, now);
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
      // Which rail stopped this pair, when one did. `edge` says how close it came; this says what
      // it came up short against, so a tape line explains itself without re-running the gates.
      if (p.veto) row.veto = p.veto;
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

module.exports = { makeRecorder, makeDiskBrake, planTapeTrim, ET_DAY, TICKS_FILE };

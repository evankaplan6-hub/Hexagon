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
// The Fly box keeps all of this on a 1GB volume, and an Eastern day of tape is about 90-130MB
// since sports joined the crawl on 2026-09-19. The normal way old tapes leave the box is the Mac
// pulling them down and deleting them only once the copy is proven identical (tools/fly-pull.js,
// run hourly at :30 by ops/com.hexagon.pull.plist). This is for when that has stopped -- the Mac
// asleep for a week, fly logged out. A full disk does not just stop the tape: the journal, the append-only truth, and state.json fail to write with it.
// Losing the oldest tape is the cheaper failure, so below `tapeMinFreeMb` the recorder gives up
// old tapes, oldest first, to keep everything else writing. And when that is not enough -- no old
// tape left, or one still held open mid-copy -- it stops writing TODAY's tape (the pair lines and
// src/makertape.js's, which share the file) until free space is back above the floor. That case
// happened on 2026-10-15: every game of four leagues a day ahead (#198) put 435 game pairs on the
// tape, a line each per cycle, 808 of the day's 852 MB; the disk filled with no old tape left, and
// the journal lost lines. A day of tape lost is a study's gap; a journal line lost is the ledger's.
const tapeHold = { on: false, since: 0 };   // one per process: both tape writers read it
const HOLD_RECHECK_MS = 5 * 60000;          // while held, look this often whether the space came back
const TICKS_FILE = /^ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const BRAKE_EVERY_MS = 3600000;   // free space moves a few MB an hour; checking per cycle buys nothing
const MB = 1024 * 1024;
const mb = (b) => (b / MB).toFixed(1);

// Pure: which tick tapes to delete, oldest first, so free space climbs back to the floor. Only
// files that are exactly ticks-<date>.jsonl count, and only for days BEFORE `today` -- today's
// tape is the one being written, and a journal or state.json is never a candidate at any price.
// It stops as soon as the sizes it has picked would cover the shortfall, so a small dip costs one
// old tape, not all of them. The caller deletes at most this list and re-measures before each
// delete, so it can stop short of the list, never run past it.
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
  let holdCheckAt = -Infinity;
  const freeNow = () => { const s = io.statfsSync(cfg.dataDir); return Number(s.bavail) * Number(s.bsize); };
  const release = (E, free) => {
    if (!tapeHold.on) return;
    tapeHold.on = false;
    E.log('TESS', 'OPS', null, `disk ok again · ${mb(free)} MB free · writing today's tick tape again (it has a gap since ${new Date(tapeHold.since).toISOString().slice(11, 16)}Z)`);
  };
  return (E, now) => {
    // While today's tape is held, look every few minutes whether the space came back -- a look,
    // never a trim: trimming stays hourly, for the reason the pass below gives.
    if (tapeHold.on && now >= holdCheckAt && now < nextAt) {
      holdCheckAt = now + HOLD_RECHECK_MS;
      let f;
      try { f = freeNow(); } catch { return; }
      if (Number.isFinite(f) && f >= minFreeBytes) release(E, f);
      return;
    }
    if (now < nextAt) return;
    nextAt = now + BRAKE_EVERY_MS;
    let free;
    // statfs failing (a filesystem that will not say) is not worth a log line or a retry next
    // cycle; the next look is already an hour out
    try { free = freeNow(); } catch { return; }
    if (!Number.isFinite(free)) return;
    if (free >= minFreeBytes) { release(E, free); return; }
    try {
      // Eastern, like the filename the recorder writes: from 20:00 to midnight ET the UTC date is
      // already tomorrow, and a UTC "today" would make the evening's own tape look old
      const today = ET_DAY.format(new Date(now));
      const files = [];
      for (const name of io.readdirSync(cfg.dataDir)) {
        if (!TICKS_FILE.test(name)) continue;
        try { files.push({ name, size: io.statSync(path.join(cfg.dataDir, name)).size }); } catch { /* gone already */ }
      }
      const remeasure = () => { try { free = freeNow(); return true; } catch { return false; } };
      // One pass deletes at most what ONE measurement says is needed, going by file sizes. A
      // deleted file frees less than its length while something still holds it open -- the
      // Mac's `fly ssh sftp get` streaming that very tape, say -- and chasing that missing space
      // into ever newer tapes would throw away the ones the pull has not copied yet. Whatever this
      // pass could not free waits for the next look, an hour out; the floor is days of tape deep.
      const victims = planTapeTrim(files, { today, freeBytes: free, minFreeBytes });
      const size = new Map(files.map((f) => [f.name, f.size]));
      const gone = new Set();
      for (const victim of victims) {
        // measured again before every delete: the pull may have removed tapes since the listing
        remeasure();
        if (free >= minFreeBytes) break;
        try { io.unlinkSync(path.join(cfg.dataDir, victim)); }
        catch (e) {
          // deleted under us, most likely by the pull's own rm: its space is back, and the next
          // measurement counts it before anything else goes
          if (e && e.code === 'ENOENT') { gone.add(victim); continue; }
          throw e;
        }
        gone.add(victim);
        if (!remeasure()) free += size.get(victim);   // statfs would not say this time: go by the size
        E.log('TESS', 'OPS', null, `disk low · deleted old tick tape ${victim} (${mb(size.get(victim))} MB), ${mb(free)} MB free now · it may not have been copied to the Mac yet; run node tools/fly-pull.js on the Mac to archive tapes before the box has to do this`);
      }
      remeasure();
      if (free < minFreeBytes) {
        const left = planTapeTrim(files.filter((f) => !gone.has(f.name)), { today, freeBytes: 0, minFreeBytes: Infinity }).length;
        const wasOn = tapeHold.on;
        if (!wasOn) { tapeHold.on = true; tapeHold.since = now; }
        holdCheckAt = now + HOLD_RECHECK_MS;
        const held = wasOn ? 'today\'s tick tape still held' : 'today\'s tick tape held (not written) until there is room, so the journals keep theirs';
        E.log('TESS', 'OPS', null, left
          ? `disk low · ${mb(free)} MB free, still under the ${cfg.tapeMinFreeMb} MB floor · ${held} · ${left} old tick tape${left === 1 ? '' : 's'} left; trimming again in an hour (a tape still open elsewhere, mid-copy, frees its space only once closed)`
          : `disk low · ${mb(free)} MB free, under the ${cfg.tapeMinFreeMb} MB floor, and no old tick tape is left to delete · ${held} · journals and today's tape are never deleted`);
      } else release(E, free);
    } catch (e) {
      // the brake must never take the cycle down with it
      try { E.log('TESS', 'OPS', null, `disk low · could not trim old tick tapes: ${String(e && e.message).slice(0, 120)}`); } catch { /* nothing left to tell */ }
    }
  };
}

// Which pairs are written only on a change (plus the heartbeat): any-market pairs, and games that
// have not started. tools/replay.js carries exactly these forward between lines.
const onChange = (p) => p.kind === 'event' || (p.kind === 'game' && !p.inPlay);

// `io` and `clock` are the fs module and Date.now in production; tools/disk-test.js passes a fake
// disk and a fixed time to check the brake is really wired in, ahead of the empty-cycle return.
function makeRecorder(cfg, { io = fs, clock = Date.now } = {}) {
  if (!cfg.record) return () => {};
  let warnedAt = 0;
  const brake = makeDiskBrake(cfg, io);
  // Pairs from the any-market scanner (kind 'event') are written when something on the line changes
  // -- a price level, the veto, in-play -- and otherwise once every RECORD_HEARTBEAT_MIN. There can be
  // hundreds of them, most long-dated and quiet: a line per pair per cycle is ~2 MB a day each, and
  // the Fly box keeps three days of tape on a 1 GB volume. Games before kickoff are written the same
  // way since 2026-10-15: the league listings (#198) brought every game a day ahead, 435 pairs and
  // 808 MB in one day at a line per cycle. A game IN PLAY, and Fed pairs, keep a line every cycle
  // (the settlement studies read a live game's every quote), and tools/replay.js carries a quiet
  // line forward to the next one. `hb: true` marks a heartbeat line, so a flat market and a gap in
  // the tape stay distinguishable.
  const lastLine = new Map();   // pairId -> { key, at }
  const heartbeatMs = Math.max(1, Number(cfg.recordHeartbeatMin) || 15) * 60000;
  return (E) => {
    const now = clock();
    // before the early return below: a cycle with nothing to write still owns the old tapes on disk
    brake(E, now);
    if (tapeHold.on) return;   // the disk is under its floor: the journals come first
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
      // Polymarket closed this game and HOLT is keeping the pair (SNIPE_HOLD_SEC): the line's PM side is
      // its last quote, the KS side is live. And Kalshi's top-of-book sizes on games, for the same study.
      if (p.pmGone) row.pmGone = true;
      // The snipe's watch (agents.watchCloses): when Polymarket's market record first said its resolver
      // had proposed the result (the moment the snipe buys at), and when it closed, by its own clock. The
      // close comes after Kalshi has closed too, so a row rarely lives to carry it. (pmHaltedAt, "not
      // accepting orders", was dropped 2026-09-30: Polymarket says that only at the close.) On kept rows
      // qt is the frozen Polymarket side's time, so Kalshi's own quote time goes on the line too (ksQt).
      const w = E.pmCloses && E.pmCloses.get(p.id);
      if (w && w.proposedAt) row.pmProposedAt = new Date(w.proposedAt).toISOString();
      if (w && w.closedAt) row.pmClosedAt = new Date(w.closedAt).toISOString();
      if (p.pmGone && Number.isFinite(q.ksAt)) row.ksQt = new Date(q.ksAt).toISOString();
      if (p.kind === 'game') {
        if (Number.isFinite(q.ksBidSize)) row.ksBidSize = Math.round(q.ksBidSize);
        if (Number.isFinite(q.ksAskSize)) row.ksAskSize = Math.round(q.ksAskSize);
      }
      // The Polymarket taker rate this line was priced at, so tools/replay.js charges the same fee.
      if (Number.isFinite(q.pmFeeRate)) row.pmFee = q.pmFeeRate;
      // present only when BRAM priced this pair this cycle (it skips in-play pairs entirely)
      if (p.fair != null) row.fair = r4(p.fair);
      if (p.best) { row.edge = r4(p.best.edge); row.venue = p.best.venue; row.side = p.best.side; }
      // Which rail stopped this pair, when one did. `edge` says how close it came; this says what
      // it came up short against, so a tape line explains itself without re-running the gates.
      if (p.veto) row.veto = p.veto;
      if (onChange(p)) {
        // a quote that stopped refreshing is a change too, or a carried-forward line in replay
        // would look fresh when the desk itself had stopped trusting it
        const stale = Number.isFinite(q.t) && now - q.t > (Number(cfg.maxDataAgeSec) || 90) * 1000;
        const key = `${row.pmBid}|${row.pmAsk}|${row.ksBid}|${row.ksAsk}|${row.veto || ''}|${row.inPlay}|${stale}`;
        const prev = lastLine.get(p.id);
        if (prev && prev.key === key && now - prev.at < heartbeatMs) continue;
        if (prev && prev.key === key) row.hb = true;
        lastLine.set(p.id, { key, at: now });
        if (stale) row.stale = true;
      } else lastLine.delete(p.id);   // in play: every cycle, and the first quiet line after it is written fresh
      if (p.kind === 'event') {
        if (p.category) row.category = p.category;
        // what the desk's time and rules gates read, so replay applies the same ones
        if (Number.isFinite(p.closesAt)) row.closesAt = new Date(p.closesAt).toISOString();
        if (Number.isFinite(p.settlesAt)) row.settlesAt = new Date(p.settlesAt).toISOString();
        if (p.watchOnly) row.watch = p.watchOnly;
      }
      lines.push(JSON.stringify(row));
    }
    if (lastLine.size > 5000) for (const id of [...lastLine.keys()]) if (!E.pairs.some((p) => p.id === id)) lastLine.delete(id);
    if (!lines.length) return;
    try {
      io.mkdirSync(cfg.dataDir, { recursive: true });
      // append-only, one write per cycle; the filename is re-derived every time, so the file
      // rotates itself at Eastern midnight with no bookkeeping
      io.appendFileSync(path.join(cfg.dataDir, `ticks-${ET_DAY.format(new Date(now))}.jsonl`), lines.join('\n') + '\n');
    } catch (e) {
      // the tape must never halt the desk; rate-limited so a bad disk cannot flood the log
      if (now - warnedAt > 300000) { warnedAt = now; E.log('TESS', 'OPS', null, `tick recorder write failed: ${String(e.message).slice(0, 120)}`); }
    }
  };
}

module.exports = { makeRecorder, makeDiskBrake, planTapeTrim, onChange, tapeHold, ET_DAY, TICKS_FILE };

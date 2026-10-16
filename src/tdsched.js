'use strict';
// The anytime-touchdown tape on a timer inside the desk, so it records whether or not the Mac is awake.
//
// tools/td-tape.js --record ran only on the Mac, from launchd every 15 minutes (ops/install-td-tape.sh).
// On a Mac that sleeps on battery launchd does not fire, and two Thursdays running the night game went
// unrecorded: SEA at DEN on 2026-10-15 (kickoff 00:15Z on the 16th) had no line at all, the job silent
// from 18:23Z to 00:42Z. A board nobody recorded before kickoff cannot be recorded after it. The Fly box
// never sleeps, so the desk runs the same record() every 15 minutes into DATA_DIR/td. TD_TAPE=1 turns it
// on (fly.toml); off by default, since on the Mac the launchd job is the recorder.
//
// In the desk's own process, not a child like src/chainsched.js: a run is one paged read of Kalshi's
// open KXNFLTD listing (about 300 markets, one page) and a few KB appended, and going through src/http
// puts that read in the same polite per-host queue as the desk's own Kalshi calls. record() catches its
// own fetch and write failures and says so in td.log; anything else it throws is caught here and logged.
// One run at a time: the next is armed only once the last has finished.
//
// The tape on the box is the one of record from 2026-10-16. The hourly pull copies each finished
// Eastern day's td-YYYY-MM-DD.jsonl into data/fly/archive/td/ (tools/fly-pull.js), and the daily check
// runs --check against the box's folder. If the Mac's launchd job is still installed it keeps its own
// separate tape in data/td/: a spare, never merged into the box's.
const path = require('path');

const EVERY_MIN = 15;       // launchd's StartInterval on the Mac was 900 s; the same here
const FIRST_SEC = 60;       // the first run a minute after boot: past the desks' own startup reads

function start({ dataDir, everyMin = EVERY_MIN, firstSec = FIRST_SEC, log = console.log, setTimer = setTimeout, record = null } = {}) {
  const dir = path.join(dataDir, 'td');
  const run = record || ((opts) => require('../tools/td-tape').record(opts));
  const status = { runs: 0, last: null };
  const arm = (ms) => {
    setTimer(async () => {
      try {
        const r = await run({ dir });
        status.last = r && r.line;
        // only the runs that wrote something or went wrong reach the box's log; td.log has every run
        if (r && (!r.ok || r.recorded || r.gap)) log(`td-tape: ${r.line}`);
      } catch (e) {
        status.last = `run failed: ${e && e.message}`;
        log(`td-tape: ${status.last}`);
      }
      status.runs++;
      arm(everyMin * 60e3);
    }, ms);
  };
  arm(firstSec * 1000);
  log(`td-tape: recording Kalshi's anytime-touchdown boards into ${dir} every ${everyMin} min`);
  return { dir, status };
}

module.exports = { start, EVERY_MIN, FIRST_SEC };

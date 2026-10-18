'use strict';
// The odds tape on a timer inside the desk (tools/odds-tape.js --record), as the touchdown tape runs
// (src/tdsched.js): the Fly box never sleeps through a kickoff. ODDS_TAPE=1 turns it on (fly.toml), and it
// needs ODDS_API_KEY, a Fly secret Evan sets; without one each run says so in odds.log and reads nothing.
// A run that is not due (no NFL game kicking off within two hours, or a read made less than a step ago)
// makes one free /events call and writes an idle line. One run at a time: the next is armed once the last ends.
const path = require('path');

const EVERY_MIN = 10;       // the tape's own step: a read at most every ten minutes inside a game's window (eight until 2026-10-17)
const FIRST_SEC = 90;       // after the desks' own startup reads, and after the touchdown tape's first run

function start({ dataDir, everyMin = EVERY_MIN, firstSec = FIRST_SEC, log = console.log, setTimer = setTimeout, record = null } = {}) {
  const dir = path.join(dataDir, 'odds');
  const run = record || ((opts) => require('../tools/odds-tape').record(opts));
  const status = { runs: 0, last: null };
  const arm = (ms) => {
    setTimer(async () => {
      try {
        const r = await run({ dir });
        status.last = r && r.line;
        // only the reads and the failures reach the box's log; odds.log has every run
        if (r && (!r.ok || r.recorded)) log(`odds-tape: ${r.line}`);
      } catch (e) {
        status.last = `run failed: ${e && e.message}`;
        log(`odds-tape: ${status.last}`);
      }
      status.runs++;
      arm(everyMin * 60e3);
    }, ms);
  };
  arm(firstSec * 1000);
  log(`odds-tape: reading Pinnacle and Kalshi's NFL lines into ${dir} in the two hours before each kickoff, every ${everyMin} min`);
  return { dir, status };
}

module.exports = { start, EVERY_MIN, FIRST_SEC };

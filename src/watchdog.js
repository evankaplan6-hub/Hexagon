'use strict';
// The stall watchdog's decision: no I/O and no clock, the engine passes both in.
//
// 2026-09-19, 15:32:23Z: the box's taker cycle and the maker's requote loop both stopped, in the
// same second, and nothing brought them back. The process stayed up at 0% CPU, the whale feed and
// the any-market crawl kept logging, and the desk sat frozen for over an hour before anyone asked
// why it was not filling. Both loops carry a "never start a second round on top of the first"
// guard, so one round that never returns silences its loop for good -- and from outside a loop
// that is up but finishing nothing looks exactly like a quiet market.
//
// A loop's beat is the time its last round FINISHED (returned or threw). A loop with no finished
// round for `limitMs` is stalled, whether its round is stuck mid-await or its timer is gone.

// Loops with no finished round inside limitMs, oldest silence first.
function stalledLoops({ now, limitMs, beats }) {
  if (!(limitMs > 0)) return [];
  return Object.entries(beats)
    .map(([loop, at]) => ({ loop, idleMs: now - at }))
    .filter((s) => s.idleMs > limitMs)
    .sort((a, b) => b.idleMs - a.idleMs);
}

// True when the watchdog's own timer fired far later than it was set for: the process was
// suspended (a laptop lid, a paused VM) or the event loop was blocked. Every loop looks stalled
// after that and none is, so the engine gives them all a fresh start instead of exiting.
function wasSuspended({ now, last, everyMs }) {
  return last != null && now - last > 3 * everyMs;
}

module.exports = { stalledLoops, wasSuspended };

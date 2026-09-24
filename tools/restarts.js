'use strict';
// How often was the desk restarted, and did every restart have a reason? Step 4 of the daily check.
//
//   node tools/restarts.js                  yesterday and today (Eastern), from data/fly/archive plus
//                                           data/fly/box-now (the daily check's step 2 fills box-now)
//   node tools/restarts.js --days 7         the last seven Eastern days
//   node tools/restarts.js path/to/journals a different folder
//
// server.js journals START at boot, STOP on a signal (a deploy) and CRASH from its last-resort
// handlers; the engine journals WATCHDOG before it exits on a stall (src/journal.js). A START whose
// previous lifecycle line is none of STOP, WATCHDOG or CRASH is a restart nothing explains: a heap
// abort or an OOM kill at the machine's 512 MB, which run no handler, or a machine Fly moved. Before
// 2026-09-24 only WATCHDOG lines were counted, so a crash that Fly's restart policy quietly undid
// read as a clean day, and its stack trace was gone from fly logs within about 30 minutes.
//
// The previous line is looked for across every journal on hand, not just the day's own file: a
// desk that booted on Monday and was killed on Wednesday has its only earlier line two days back.
// A START with nothing at all before it (the first one on record) is not counted either way.
// Exit code 1 when a shown day has an unexplained restart or a crash, so the daily check flags it.
const path = require('path');
const { ET_DAY } = require('../src/recorder');
const { LIFECYCLE } = require('../src/journal');
const { load } = require('./pnl-report');

// Pure: journal events in (any order, any kinds), one row per Eastern day that has a lifecycle line.
function restarts(events) {
  const life = events.filter((e) => e && LIFECYCLE.includes(e.kind) && e.t).sort((a, b) => (a.t < b.t ? -1 : a.t > b.t ? 1 : 0));
  const days = new Map();
  const D = (k) => days.get(k) || days.set(k, { starts: 0, stops: 0, watchdogs: 0, crashes: [], unexplained: [], first: 0 }).get(k);
  let prev = null;
  for (const e of life) {
    const d = D(ET_DAY.format(new Date(e.t)));
    if (e.kind === 'START') {
      d.starts++;
      // a live-mode WATCHDOG only reports the stall and does not exit, so it explains nothing
      const why = prev && (prev.kind === 'STOP' || prev.kind === 'CRASH' || (prev.kind === 'WATCHDOG' && prev.restarting !== false));
      if (!prev) d.first++;
      else if (!why) d.unexplained.push({ t: e.t, sha: e.sha || null, after: `${prev.kind} at ${prev.t.slice(0, 19)}Z` });
    } else if (e.kind === 'STOP') d.stops++;
    else if (e.kind === 'WATCHDOG') d.watchdogs++;
    else if (e.kind === 'CRASH') d.crashes.push({ t: e.t, ev: e.ev || '?', first: String(e.stack || '').split('\n')[0].slice(0, 160) });
    prev = e;
  }
  return days;
}

function render(days, want) {
  const L = [];
  let flagged = 0;
  for (const k of want) {
    const d = days.get(k) || { starts: 0, stops: 0, watchdogs: 0, crashes: [], unexplained: [], first: 0 };
    L.push(`restarts ${k}: ${d.starts} START · ${d.stops} STOP (deploys) · ${d.watchdogs} WATCHDOG · ${d.crashes.length} CRASH · unexplained restarts (likely OOM/kill): ${d.unexplained.length}`);
    for (const c of d.crashes) L.push(`  CRASH    ${c.t.slice(0, 19)}Z ${c.ev}: ${c.first}`);
    for (const u of d.unexplained) L.push(`  PROBLEM  ${u.t.slice(0, 19)}Z START${u.sha ? ` (${u.sha.slice(0, 7)})` : ''} with no STOP, WATCHDOG or CRASH since the ${u.after}`);
    flagged += d.crashes.length + d.unexplained.length;
  }
  return { text: L.join('\n'), flagged };
}

// The last `n` Eastern days ending today, oldest first. Noon UTC steps a whole day in any zone.
function lastDays(todayET, n) {
  const [y, m, d] = todayET.split('-').map(Number);
  return Array.from({ length: n }, (_, i) => new Date(Date.UTC(y, m - 1, d - (n - 1 - i), 12)).toISOString().slice(0, 10));
}

function main(argv, { now = () => new Date(), log = console.log } = {}) {
  const args = argv.slice(2);
  const n = args.includes('--days') ? parseInt(args[args.indexOf('--days') + 1], 10) : 2;
  if (!(n >= 1)) { log('usage: node tools/restarts.js [--days 2] [journal folder]'); return 2; }
  const dirArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--days');
  const root = path.join(__dirname, '..');
  const events = load(dirArg || [path.join(root, 'data', 'fly', 'archive'), path.join(root, 'data', 'fly', 'box-now')]);
  const newest = events.reduce((a, e) => (e.t && e.t > a ? e.t : a), '');
  if (!newest) { log(`restarts: no journal events found${dirArg ? ` in ${dirArg}` : ' in data/fly/archive or data/fly/box-now'}, so nothing could be counted`); return 1; }
  const { text, flagged } = render(restarts(events), lastDays(ET_DAY.format(now()), n));
  log(text);
  // box-now is only as fresh as step 2's copy; say how far the journals go so a stale one shows
  log(`  (journals through ${newest.slice(0, 16)}Z)`);
  return flagged ? 1 : 0;
}

if (require.main === module) process.exitCode = main(process.argv);
module.exports = { restarts, render, lastDays, main };

'use strict';
// The chain recorder on a schedule inside the desk, for a box with no cron.
//
// tools/chain-record.js runs on the Mac from launchd (ops/install-chains.sh) at 16:25, 20:00 and
// 09:45 Eastern. The Fly box has no launchd and no cron, so its Stocks and Options tabs read an
// empty folder and said "no chains recorded yet" from the day they shipped. This runs the same
// tool on the same three times, weekdays only, as a child process: a crash in it, or the CPU it
// takes on a starved box, stays out of the desk's own loops. CHAINS=1 turns it on (fly.toml).
//
// The box's copy is a DISPLAY copy, not the archive. The volume is 1 GB and a day of chains is
// up to ~5 MB, so the box keeps only the last CHAINS_KEEP_DAYS days and drops the rest; the Mac's
// tape (never trimmed) is the one that must survive. The two tapes are recorded separately and
// are not merged: each has its own fetch times and its own .seen.json.
//
// nextRun and prune are pure (a clock and a file list in, a decision out) so tools/chainsched-test.js
// can pin them without a timezone-sensitive machine or a real folder.
const path = require('path');
const { spawn } = require('child_process');

const TZ = 'America/New_York';
const TIMES = [[9, 45], [16, 25], [20, 0]];   // Eastern, the same three the Mac's launchd job uses
const WEEKDAYS = new Set([1, 2, 3, 4, 5]);

const PARTS = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short',
});
// the Eastern wall clock at an instant
function wall(ms) {
  const p = {};
  for (const { type, value } of PARTS.formatToParts(new Date(ms))) p[type] = value;
  const dow = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday];
  return { y: +p.year, m: +p.month, d: +p.day, hh: +p.hour, mm: +p.minute, ss: +p.second, dow };
}
// The instant at which the Eastern wall clock reads y-m-d hh:mm. Guess it as UTC, read the
// Eastern offset at the guess, and correct once; the three times here are never near the 02:00
// DST switch, so one correction is exact.
function instant(y, m, d, hh, mm) {
  const guess = Date.UTC(y, m - 1, d, hh, mm);
  const w = wall(guess);
  const off = Date.UTC(w.y, w.m - 1, w.d, w.hh, w.mm, w.ss) - guess;
  return guess - off;
}

// The next weekday slot strictly after `now`, and the Eastern day it falls on.
function nextRun(now, { times = TIMES, weekdays = WEEKDAYS } = {}) {
  const w = wall(now);
  for (let back = 0; back < 10; back++) {
    // walk day by day from today; a Friday evening lands on Monday morning
    const day = new Date(Date.UTC(w.y, w.m - 1, w.d + back, 12));
    const dw = wall(day.getTime());
    if (!weekdays.has(dw.dow)) continue;
    for (const [hh, mm] of times) {
      const at = instant(dw.y, dw.m, dw.d, hh, mm);
      if (at > now) return { at, day: `${dw.y}-${String(dw.m).padStart(2, '0')}-${String(dw.d).padStart(2, '0')}`, hh, mm };
    }
  }
  return null;
}

// Which tape files to delete so only the newest `keepDays` days remain. Only chains-*.jsonl, and
// never fewer than `keepDays` files: the seen file and anything else in the folder is left alone.
function prune(files, keepDays) {
  if (!(keepDays > 0)) return [];
  const tapes = files.filter((f) => /^chains-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  return tapes.slice(0, Math.max(0, tapes.length - keepDays));
}

// Arm the timer. `run` is what a slot does (defaults to spawning the tool); injectable for tests.
function start({ dataDir, keepDays = 14, log = console.log, now = Date.now, setTimer = setTimeout, run = null, fs = require('fs') } = {}) {
  const dir = path.join(dataDir, 'chains');
  const tool = path.join(__dirname, '..', 'tools', 'chain-record.js');
  const record = run || (() => new Promise((resolve) => {
    const child = spawn(process.execPath, [tool], { env: { ...process.env, DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('error', (e) => resolve(`could not start the recorder: ${e.message}`));
    child.on('close', (code) => resolve(`${out.trim().split('\n').slice(-3).join(' | ')}${code ? ` (exit ${code})` : ''}`));
  }));
  const trim = () => {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const gone = prune(names, keepDays);
    for (const f of gone) { try { fs.unlinkSync(path.join(dir, f)); } catch { /* next run tries again */ } }
    return gone;
  };
  // What the schedule last did and will do next, on disk beside the tape (STATUS), so the
  // dashboard's tabs can say "last run 09:45 ET: nothing new · next 16:25 ET". Without it, a
  // day when Cboe's file never changed (2026-09-23: rebuilt at 03:55Z and not again by 13:00 ET)
  // looks exactly like a schedule that never fired, and the box's log buffer is 100 lines.
  const status = { last: null, next: null };
  const save = () => {
    try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(path.join(dir, STATUS), JSON.stringify(status)); }
    catch { /* the tape itself is what matters; the tabs just lose the line */ }
  };
  const arm = () => {
    const next = nextRun(now());
    if (!next) return;
    const label = `${next.day} ${String(next.hh).padStart(2, '0')}:${String(next.mm).padStart(2, '0')} ET`;
    log(`chains: next snapshot ${label}`);
    status.next = { at: next.at, label };
    save();
    // one timer at a time, and it is re-armed only after the run finishes: a run that outlives
    // its slot on a starved box must not stack a second one on top of it
    setTimer(async () => {
      const at = now();
      let result = '';
      try { result = await record(); log(`chains: ${result}`); }
      catch (e) { result = `snapshot failed: ${e && e.message}`; log(`chains: ${result}`); }
      const gone = trim();
      if (gone.length) log(`chains: dropped ${gone.length} old day${gone.length === 1 ? '' : 's'} (the box keeps ${keepDays}; the Mac keeps everything)`);
      // `stale`: every symbol's Cboe file still carried the stamp the previous run had seen.
      // Nothing was written, and the tabs say so in those words rather than "nothing new": on
      // 2026-09-24 a frozen feed was written as fresh chains and this line read "70 lines".
      const stale = STALE_RE.test(result);
      status.last = { at, result: summary(result), wrote: !stale && /\d+ lines/.test(result) && !/would be written/.test(result), ...(stale ? { stale } : {}), ...(/ PROBLEM chain-record:/.test(result) ? { problem: true } : {}) };
      arm();
    }, Math.min(next.at - now(), 2 ** 31 - 1));
  };
  arm();
  return { dir, nextRun: () => nextRun(now()), trim, status };
}

const STATUS = '.sched.json';
// tools/chain-record.js's verdict line when no symbol's file had been rebuilt since it was recorded
const STALE_RE = /; all (\d+) stale:/;
// The recorder's last lines, as one short phrase for the tabs: what it wrote, or why nothing.
// Its verdict line (the last one, "... ok|PROBLEM chain-record: what; note; note") says whether
// anything was wrong, and a PROBLEM's notes are carried through so the tab names it.
function summary(result) {
  const s = String(result || '');
  const v = / (ok|PROBLEM) chain-record: ([^|]*)/.exec(s);
  const notes = v && v[1] === 'PROBLEM' ? v[2].replace(/\s*\(exit \d+\)\s*$/, '').trim().split('; ').slice(1).join('; ') : '';
  const flag = v && v[1] === 'PROBLEM' ? ` · PROBLEM${notes ? `: ${notes}` : ''}` : '';
  const stale = STALE_RE.exec(s);
  if (stale) return `stale: none of the ${stale[1]} Cboe files had been rebuilt since the last run${v && v[1] === 'PROBLEM' ? ' · PROBLEM' : ''}`.slice(0, 160);
  const wrote = s.match(/(\d+) lines, (\d+) contracts/);
  if (wrote) return `${wrote[1]} lines, ${(+wrote[2]).toLocaleString()} contracts${flag}`.slice(0, 160);
  if (flag) return flag.slice(3, 163);
  if (/nothing new/.test(s)) return 'nothing new: the chains had not changed';
  if (/snapshot failed|could not start/.test(s)) return s.replace(/^.*?(snapshot failed|could not start)/, '$1').slice(0, 120);
  return s.split('|').pop().trim().slice(0, 120) || 'ran';
}

module.exports = { nextRun, prune, start, summary, instant, wall, TIMES, STATUS, STALE_RE };

'use strict';
// The lab on the floor (2026-10-17, the floor's Today view): what each tape the box records did last, and when
// the next one reads. Since the plan of 2026-10-17 a third of the Hexagon's work is collecting what cannot be
// fetched later and re-testing on fixed dates (README "The plan from here"), and the floor showed none of it.
//
// Each tape writes one line per run to its own log (tools/odds-tape.js, tools/td-tape.js, tools/chain-record.js):
//   2026-10-17T18:26:16.145Z idle odds-tape: no game within the window
// and the two NFL tapes keep the games they have seen listed, with kickoffs, in games.json. This reads the last
// line of each log and the next kickoff, under the desk's data folder (/data on the box), at most once a minute.
// Read-only, and nothing here can fail the frame: a missing file is a tape that has not run.
const fs = require('fs');
const path = require('path');

// `lead`: how long before a kickoff the tape reads (odds: two hours, touchdowns: three)
const TAPES = [
  { key: 'odds', name: 'Odds tape', what: 'Pinnacle and four US sportsbooks beside Kalshi in the two hours before each NFL kickoff: does Kalshi trail the sharp book by more than its fee?', dir: 'odds', log: 'odds.log', lead: 120 },
  { key: 'td', name: 'Touchdown tape', what: "Kalshi's anytime-touchdown boards in the three hours before each NFL kickoff, graded after for the hold", dir: 'td', log: 'td.log', lead: 180 },
  { key: 'chains', name: 'Option chains', what: "Six ETFs' option chains from Cboe after each close: the history the option labs will be re-run on in March", dir: 'chains', log: 'chains.log', lead: null },
];

// the last `bytes` of a file, without reading a year of log to get them
function tail(file, bytes = 4096) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, n = Math.min(size, bytes), buf = Buffer.alloc(n);
    fs.readSync(fd, buf, 0, n, size - n);
    return buf.toString('utf8');
  } catch { return ''; } finally { if (fd != null) try { fs.closeSync(fd); } catch { /* closed */ } }
}

// "2026-10-17T18:26:16.145Z idle odds-tape: no game within the window" → { at, state: 'idle', text: 'no game within the window' }
function lastRun(file) {
  const lines = tail(file).split('\n').map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^(\d{4}-\d\d-\d\dT[\d:.]+Z)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const state = /^problem$/i.test(m[2]) ? 'problem' : m[2].toLowerCase();
    return { at: Date.parse(m[1]), state, text: m[3].replace(/^[\w-]+:\s*/, '') };
  }
  return null;
}

// The next kickoff in a tape's games.json, after `now`: odds-tape writes an array ({ kickoff, home, away }),
// td-tape an object of events ({ game, kickoff }). Returns { at, game } or null.
function nextKickoff(file, now) {
  let g;
  try { g = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  // td-tape keeps a game by Kalshi's code ("HOUJAC"), which is no name to read: only odds-tape's teams are kept
  const rows = (Array.isArray(g) ? g : Object.values(g || {})).map((x) => ({ at: Date.parse(x && x.kickoff), game: x && x.home && x.away ? `${x.away} at ${x.home}` : null }))
    .filter((x) => Number.isFinite(x.at) && x.at > now).sort((a, b) => a.at - b.at);
  return rows[0] || null;
}

function read(dataDir, now) {
  return {
    tapes: TAPES.map((t) => {
      const run = lastRun(path.join(dataDir, t.dir, t.log));
      const k = t.lead ? nextKickoff(path.join(dataDir, t.dir, 'games.json'), now) : null;
      return { key: t.key, name: t.name, what: t.what, at: run ? run.at : null, state: run ? run.state : 'none', text: run ? run.text : '',
        kickoff: k ? k.at : null, game: k ? k.game : null, reads: k ? k.at - t.lead * 60e3 : null };
    }),
  };
}

// at most once a minute per folder: the frame goes out every two seconds to every open page
const cache = new Map();
function labStatus(dataDir, now = Date.now(), ttl = 60e3) {
  const c = cache.get(dataDir);
  if (c && now - c.t < ttl) return c.v;
  const v = read(dataDir, now);
  cache.set(dataDir, { t: now, v });
  return v;
}

module.exports = { labStatus, lastRun, nextKickoff, tail, TAPES };

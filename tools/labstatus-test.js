'use strict';
// The lab on the floor (src/labstatus.js): each tape's last run read off the end of its log, its next read from its
// games.json, a missing tape as one that has not run, and at most one read of the disk a minute. Temp folder, no network.
const fs = require('fs');
const os = require('os');
const path = require('path');
const L = require('../src/labstatus');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-lab-'));
const put = (f, s) => { fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); fs.writeFileSync(path.join(dir, f), s); };
const NOW = Date.parse('2026-10-17T18:40:00Z');

// ---- the last run, from the end of a log
{
  put('odds/odds.log', '2026-10-17T04:20:27.749Z idle odds-tape: no game within the window\n2026-10-17T18:34:16.236Z idle odds-tape: no game within the window\n');
  const r = L.lastRun(path.join(dir, 'odds/odds.log'));
  ok('the last line: its time, its word, and what it said without the tool\'s name', r.at === Date.parse('2026-10-17T18:34:16.236Z') && r.state === 'idle' && r.text === 'no game within the window', r);
  put('chains/chains.log', '2026-10-16T20:25:00Z ok chain-record: wrote SPY: 87 lines\n2026-10-17T00:00:00Z PROBLEM chain-record: old stamps: DIA 3.5h\n2026-10-17T00:00:0');
  const c = L.lastRun(path.join(dir, 'chains/chains.log'));
  ok('a PROBLEM is a problem, and a line cut off mid-write is passed over for the one before it', c.state === 'problem' && c.text === 'old stamps: DIA 3.5h' && c.at === Date.parse('2026-10-17T00:00:00Z'), c);
  put('big.log', `${'2026-01-01T00:00:00Z ok x: old\n'.repeat(5000)}2026-10-17T18:21:32.484Z ok td-tape: 301 open 1+ markets\n`);
  ok('a long log is read from its end only', L.tail(path.join(dir, 'big.log')).length <= 4096 && L.lastRun(path.join(dir, 'big.log')).text === '301 open 1+ markets');
  ok('no log: no run', L.lastRun(path.join(dir, 'nothing.log')) === null);
  put('long.log', `2026-10-17T18:00:00Z ok x: ${'y'.repeat(6000)}\n`);
  ok('a last line longer than 4 KB is still read (a wider tail)', (L.lastRun(path.join(dir, 'long.log')) || {}).state === 'ok');
}

// ---- the next kickoff
{
  put('odds/games.json', JSON.stringify([
    { id: 'a', kickoff: '2026-10-17T17:00:00Z', home: 'Jets', away: 'Bills' },
    { id: 'b', kickoff: '2026-10-18T17:00:00Z', home: 'Falcons', away: 'Bears' },
    { id: 'c', kickoff: '2026-10-18T13:30:00Z', home: 'Jacksonville Jaguars', away: 'Houston Texans' },
  ]));
  const k = L.nextKickoff(path.join(dir, 'odds/games.json'), NOW);
  ok('the soonest kickoff still to come, by its teams', k.at === Date.parse('2026-10-18T13:30:00Z') && k.game === 'Houston Texans at Jacksonville Jaguars', k);
  put('td/games.json', JSON.stringify({ 'KXNFLTD-26OCT18HOUJAC': { game: 'HOUJAC', kickoff: '2026-10-18T13:30:00.000Z' }, 'KXNFLTD-26OCT12SEADEN': { game: 'SEADEN', kickoff: '2026-10-12T20:25:00.000Z' } }));
  const t = L.nextKickoff(path.join(dir, 'td/games.json'), NOW);
  ok('the touchdown tape\'s games are Kalshi codes, which are no names to read: its kickoff only', t.at === Date.parse('2026-10-18T13:30:00Z') && t.game === null, t);
  ok('nothing still to come, or no file: null', L.nextKickoff(path.join(dir, 'td/games.json'), Date.parse('2026-10-19T00:00:00Z')) === null && L.nextKickoff(path.join(dir, 'none.json'), NOW) === null);
}

// ---- the three tapes together
{
  put('td/td.log', '2026-10-17T18:21:32.484Z ok td-tape: 301 open 1+ markets, 0 games in the next 3h, 0 lines written\n');
  const s = L.labStatus(dir, NOW);
  ok('the odds tape, the touchdown tape and the option chains, in that order', s.tapes.map((t) => t.key).join() === 'odds,td,chains', s.tapes.map((t) => t.key));
  const odds = s.tapes[0], td = s.tapes[1], ch = s.tapes[2];
  ok('each with what it records', s.tapes.every((t) => t.what.length > 40));
  ok('the odds tape reads two hours before the next kickoff', odds.reads === Date.parse('2026-10-18T11:30:00Z') && odds.game === 'Houston Texans at Jacksonville Jaguars' && odds.state === 'idle', odds);
  ok('the touchdown tape three hours before', td.reads === Date.parse('2026-10-18T10:30:00Z') && td.state === 'ok', td);
  ok('the chains have no kickoff, and say their problem', ch.kickoff === null && ch.reads === null && ch.state === 'problem', ch);
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-lab-none-'));
  const n = L.labStatus(empty, NOW);
  ok('a folder with no tapes: each one "none", nothing thrown', n.tapes.every((t) => t.state === 'none' && t.at === null), n);
  fs.rmSync(empty, { recursive: true, force: true });
  // a minute's cache: a new line is not seen until the minute is up
  put('odds/odds.log', '2026-10-17T18:42:16.236Z ok odds-tape: 9 games, 9 with Pinnacle\n');
  ok('read at most once a minute', L.labStatus(dir, NOW + 30e3).tapes[0].state === 'idle' && L.labStatus(dir, NOW + 61e3).tapes[0].state === 'ok');
}

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

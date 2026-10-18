'use strict';
// The odds tape: when a read is due (inside a game's window, a step apart), one game's line from The Odds API's row
// and Kalshi's books, Pinnacle's chance without its margin, Kalshi's fee, the key cut from any error, the offline
// check, and the box's timer. record() runs against a stand-in for fetch: no network, no credit.
const fs = require('fs');
const os = require('os');
const path = require('path');
const T = require('./odds-tape');
const sched = require('../src/oddssched');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-6) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);
const NOW = Date.parse('2026-10-18T15:30:00Z'), MIN = 60e3;
const ev = (min) => ({ commence_time: new Date(NOW + min * MIN).toISOString() });

// ---- is a read due
{
  ok('a game an hour out: due', T.due([ev(60)], NOW, null).due);
  ok('the nearest game three hours out: not due (no credit spent)', !T.due([ev(180)], NOW, null).due);
  ok('a game already started does not count', !T.due([ev(-10)], NOW, null).due);
  ok('a read five minutes ago: not due yet', !T.due([ev(60)], NOW, NOW - 5 * MIN).due);
  ok('ten minutes ago: due again; eight: not yet', T.due([ev(60)], NOW, NOW - 10 * MIN).due && !T.due([ev(60)], NOW, NOW - 8 * MIN).due);
  // the budget (audit 2026-10-17): one read every 10 minutes for 120 minutes is 12 credits a slot; November 2026's
  // heaviest month (about 30 slots: five Sundays' three, five Mondays, Thursdays, Thanksgiving's three, two London
  // mornings) is then about 360 of the 480 above the reserve
  ok('a slot costs 12 credits, and thirty slots fit a month above the reserve', Math.ceil(T.WINDOW_MIN / T.EVERY_MIN) === 12 && 30 * 12 <= 500 - T.RESERVE - 100);
}

// ---- one game's line
{
  const row = { id: 'abc', commence_time: '2026-10-18T17:00:00Z', home_team: 'Denver Broncos', away_team: 'Los Angeles Rams', bookmakers: [
    { key: 'pinnacle', markets: [{ key: 'h2h', last_update: '2026-10-18T15:28:00Z', outcomes: [{ name: 'Denver Broncos', price: 1.8 }, { name: 'Los Angeles Rams', price: 2.1 }] }] },
    { key: 'draftkings', markets: [{ key: 'h2h', outcomes: [{ name: 'Denver Broncos', price: 1.77 }, { name: 'Los Angeles Rams', price: 2.05 }] }] },
  ] };
  const markets = [
    { ticker: 'KXNFLGAME-26OCT18LADEN-DEN', occurrence_datetime: '2026-10-18T20:00:00Z', yes_bid_dollars: '0.5400', yes_ask_dollars: '0.5500' },
    { ticker: 'KXNFLGAME-26OCT18LADEN-LA', occurrence_datetime: '2026-10-18T20:00:00Z', yes_bid_dollars: '0.4500', yes_ask_dollars: '0.4600' },
    { ticker: 'KXNFLGAME-26OCT25LADEN-DEN', occurrence_datetime: '2026-10-25T20:00:00Z', yes_bid_dollars: '0.5', yes_ask_dollars: '0.51' },
  ];
  const idx = T.kalshiIndex(markets, [Date.parse(row.commence_time)]);
  ok("Kalshi's market for next week's game is not this week's", idx.get('DEN').ticker === 'KXNFLGAME-26OCT18LADEN-DEN');
  const g = T.gameLine(row, idx);
  ok('each book its two prices and when it last moved', g.books.pinnacle.home === 1.8 && g.books.pinnacle.upd === '2026-10-18T15:28:00Z' && g.books.draftkings.away === 2.05, g.books);
  ok("the Rams are Kalshi's LA as well as LAR", g.kalshi.away && g.kalshi.away.ticker.endsWith('-LA') && g.kalshi.away.ask === 0.46, g.kalshi);
  near("Pinnacle's chance for Denver, its margin taken out", T.noVig(g.books.pinnacle), (1 / 1.8) / (1 / 1.8 + 1 / 2.1), 1e-12);
  ok('every one of the 32 teams has a Kalshi code', Object.keys(T.NFL).length === 32 && Object.values(T.NFL).every((c) => c.length));
  ok('ten bookmakers or fewer: one region\'s cost', T.BOOKS.length <= 10 && T.BOOKS.includes('pinnacle'));
}

// ---- the fee and the key
{
  ok("Kalshi's fee at 50¢ is 2¢ a contract (7% of p(1-p), rounded up)", T.kalshiFee(0.5) === 0.02, T.kalshiFee(0.5));
  ok('...and 1¢ at 90¢', T.kalshiFee(0.9) === 0.01, T.kalshiFee(0.9));
  ok('the key is cut out of any error that quotes a URL', T.scrub('fetch https://api.the-odds-api.com/v4/sports/x/odds?apiKey=abc123secret&markets=h2h failed') === 'fetch https://api.the-odds-api.com/v4/sports/x/odds?apiKey=…&markets=h2h failed');
}

// ---- the offline check (audit 2026-10-17: a missed game, a stopped tape and a bad run all say so the next morning)
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-test-'));
  const at = Date.parse('2026-10-19T13:00:00Z');   // Monday 9 AM ET, the morning check
  fs.writeFileSync(path.join(dir, 'odds.log'), ['2026-10-18T15:30:00Z ok odds-tape: 2 games read (2 with Pinnacle and both Kalshi sides), 480 credits left',
    '2026-10-18T16:00:00Z PROBLEM odds-tape: HTTP 500', '2026-10-19T12:55:00Z idle odds-tape: no game within the window'].join('\n') + '\n');
  // games.json as the tape now keeps it: Sunday's games stay on it after the listing drops them
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify([{ id: 'abc', kickoff: '2026-10-18T17:00:00Z', home: 'Denver Broncos', away: 'Los Angeles Rams' }, { id: 'zzz', kickoff: '2026-10-18T17:00:00Z', home: 'Buffalo Bills', away: 'New York Jets' }]));
  fs.writeFileSync(path.join(dir, 'odds-2026-10-18.jsonl'), JSON.stringify({ t: '2026-10-18T15:30:00Z', credits: { remaining: 480, used: 20 }, games: [{ id: 'abc', books: {}, kalshi: {} }] }) + '\n');
  const c = T.check(dir, at);
  ok('Monday morning: Sunday\'s game with no tape is a problem, named', c.problems.some((p) => /New York Jets at Buffalo Bills/.test(p)) && !c.problems.some((p) => /Rams at Denver/.test(p)), c);
  ok('...and so is a run that went wrong in the last day, though the last line is fine', c.problems.some((p) => /1 run\(s\) went wrong in the last day; the last: .*HTTP 500/.test(p)), c.problems);
  ok('the credits left are reported', c.lines.some((l) => /^480 credits left/.test(l)), c.lines);
  ok('a tape that ran five minutes ago has not stopped', !c.problems.some((p) => /no run since/.test(p)), c.problems);
  const stopped = T.check(dir, at + 3 * 3600e3);
  ok('a tape with no run for three hours has stopped, though its last line said idle', stopped.problems.some((p) => /^no run since 2026-10-19T12:55:00Z/.test(p)), stopped.problems);
  ok('a bad run over a day old is not raised again', !T.check(dir, Date.parse('2026-10-19T19:00:00Z')).problems.some((p) => /went wrong/.test(p)));
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- the kept schedule
{
  const prev = [{ id: 'sun', kickoff: '2026-10-18T17:00:00Z', home: 'Jets', away: 'Bills' }, { id: 'old', kickoff: '2026-10-08T17:00:00Z', home: 'A', away: 'B' }, { id: 'mon', kickoff: '2026-10-20T00:15:00Z', home: 'X', away: 'Y' }];
  const g = T.mergeGames(prev, [{ id: 'mon', commence_time: '2026-10-20T00:20:00Z', home_team: 'X', away_team: 'Y' }, { id: 'thu', commence_time: '2026-10-23T00:15:00Z', home_team: 'P', away_team: 'Q' }], Date.parse('2026-10-19T13:00:00Z'));
  ok('a game the listing dropped once it finished stays a week; one over a week old goes', g.some((x) => x.id === 'sun') && !g.some((x) => x.id === 'old'), g.map((x) => x.id));
  ok('a game still listed takes its new kickoff, and a new one joins, in kickoff order', g.map((x) => x.id).join() === 'sun,mon,thu' && g.find((x) => x.id === 'mon').kickoff === '2026-10-20T00:20:00Z', g);
}

// ---- a run, against a stand-in for fetch: Kalshi is read before the one paid call, and a dry run makes none
(async () => {
  const realFetch = global.fetch;
  const calls = [];
  const kick = new Date(NOW + 60 * MIN).toISOString();
  const reply = (body, headers = {}) => ({ ok: true, status: 200, json: async () => body, headers: { get: (k) => headers[k] ?? null } });
  const fake = (kalshiOk) => async (url) => {
    calls.push(url.includes('the-odds-api') ? (url.includes('/odds?') ? 'odds' : 'events') : 'kalshi');
    if (url.includes('/events?')) return reply([{ id: 'g1', commence_time: kick, home_team: 'Denver Broncos', away_team: 'Los Angeles Rams' }]);
    if (url.includes('elections.kalshi')) return kalshiOk ? reply({ markets: [], cursor: '' }) : { ok: false, status: 503, json: async () => ({}), headers: { get: () => null } };
    return reply([{ id: 'g1', commence_time: kick, home_team: 'Denver Broncos', away_team: 'Los Angeles Rams', bookmakers: [] }], { 'x-requests-remaining': '470', 'x-requests-used': '30' });
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-run-'));
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify([{ id: 'fri', kickoff: '2026-10-17T00:15:00Z', home: 'Old', away: 'Game' }]));
  try {
    global.fetch = fake(false);
    const down = await T.record({ dir, key: 'test-key', now: NOW });
    ok('Kalshi down: a PROBLEM, and no paid call made', !down.ok && /PROBLEM/.test(down.line) && !calls.includes('odds'), { line: down.line, calls });
    ok('...and the line carries no key', !/test-key/.test(fs.readFileSync(path.join(dir, 'odds.log'), 'utf8')));
    calls.length = 0;
    global.fetch = fake(true);
    const dry = await T.record({ dir, key: 'test-key', now: NOW, dryRun: true });
    ok('a dry run reads the free listing and Kalshi, and stops before the paid call', dry.ok && !calls.includes('odds') && calls.includes('kalshi'), { line: dry.line, calls });
    calls.length = 0;
    const real = await T.record({ dir, key: 'test-key', now: NOW });
    ok('a real run: the listing, then Kalshi, then the one paid read', real.ok && calls.join() === 'events,kalshi,odds' && real.recorded === 1, { calls, line: real.line });
    const kept = JSON.parse(fs.readFileSync(path.join(dir, 'games.json'), 'utf8'));
    ok('games.json keeps the finished game beside the listed one', kept.some((g) => g.id === 'fri') && kept.some((g) => g.id === 'g1'), kept);
  } finally { global.fetch = realFetch; fs.rmSync(dir, { recursive: true, force: true }); }
  runTimer();
})();

// ---- the box's timer
function runTimer() {
  const timers = [], logs = [];
  let runs = 0;
  const s = sched.start({ dataDir: '/data', log: (l) => logs.push(l), setTimer: (fn, ms) => timers.push({ fn, ms }), record: async () => { runs++; return { ok: true, idle: true, line: 'idle odds-tape: no game within the window' }; } });
  ok('the box records into /data/odds, first a minute and a half after boot', s.dir === '/data/odds' && timers[0].ms === 90e3, timers);
  (async () => {
    await timers[0].fn();
    ok('then every 10 minutes, one run at a time', runs === 1 && timers[1].ms === 10 * 60e3, timers.map((t) => t.ms));
    ok('an idle run stays out of the box log', logs.length === 1, logs);
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

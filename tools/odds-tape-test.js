'use strict';
// The odds tape: when a read is due (inside a game's window, a step apart), one game's line from The Odds API's row
// and Kalshi's books, Pinnacle's chance without its margin, Kalshi's fee, the key cut from any error, the offline
// check, and the box's timer. No network: record() is not called.
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
  ok('eight minutes ago: due again', T.due([ev(60)], NOW, NOW - 8 * MIN).due);
  // the budget: a Sunday's three slots at one read every 8 minutes for 120 minutes
  ok('a slot costs 15 credits, a week of five slots about 75-90: inside 500 a month', Math.ceil(T.WINDOW_MIN / T.EVERY_MIN) === 15);
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

// ---- the offline check
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'odds-test-'));
  fs.writeFileSync(path.join(dir, 'odds.log'), '2026-10-18T15:30:00Z ok odds-tape: 2 games read (2 with Pinnacle and both Kalshi sides), 480 credits left\n');
  fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify([{ id: 'abc', kickoff: '2026-10-18T17:00:00Z', home: 'Denver Broncos', away: 'Los Angeles Rams' }, { id: 'zzz', kickoff: '2026-10-18T17:00:00Z', home: 'Buffalo Bills', away: 'New York Jets' }]));
  fs.writeFileSync(path.join(dir, 'odds-2026-10-18.jsonl'), JSON.stringify({ t: '2026-10-18T15:30:00Z', credits: { remaining: 480, used: 20 }, games: [{ id: 'abc', books: {}, kalshi: {} }] }) + '\n');
  const c = T.check(dir, Date.parse('2026-10-18T19:00:00Z'));
  ok('a game that kicked off with no tape is a problem, named', c.problems.length === 1 && /New York Jets at Buffalo Bills/.test(c.problems[0]), c);
  ok('the credits left are reported', c.lines.some((l) => /^480 credits left/.test(l)), c.lines);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- the box's timer
{
  const timers = [], logs = [];
  let runs = 0;
  const s = sched.start({ dataDir: '/data', log: (l) => logs.push(l), setTimer: (fn, ms) => timers.push({ fn, ms }), record: async () => { runs++; return { ok: true, idle: true, line: 'idle odds-tape: no game within the window' }; } });
  ok('the box records into /data/odds, first a minute and a half after boot', s.dir === '/data/odds' && timers[0].ms === 90e3, timers);
  (async () => {
    await timers[0].fn();
    ok('then every 8 minutes, one run at a time', runs === 1 && timers[1].ms === 8 * 60e3, timers.map((t) => t.ms));
    ok('an idle run stays out of the box log', logs.length === 1, logs);
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

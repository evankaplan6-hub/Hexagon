'use strict';
// The odds tape: does Kalshi's price for an NFL game trail the sharp sportsbooks' after news? LOG-ONLY,
// research: no bet, no broker, nothing in the desk reads it, and nothing here can place an order.
//
//   node tools/odds-tape.js --record            # if an NFL game kicks off within WINDOW_MIN: one odds read (Pinnacle and
//                                               # the US books, 1 credit) and Kalshi's NFL game books, appended to
//                                               # data/odds/odds-YYYY-MM-DD.jsonl
//   node tools/odds-tape.js --check             # read-only: the last run, the credits left, any game with no tape
//   node tools/odds-tape.js --grade [--day D]   # each game's gaps between Pinnacle (no-vig) and Kalshi's mid, and what a
//                                               # buy on Kalshi at the ask whenever it trailed by more than the fee made
//   --dir D                                     # any mode: the tape's folder, if not data/odds
//
// WHY (2026-10-17). Five weeks of labs found no free-data rule that beats the market's price (README, "The plan
// from here"). The one edge betting has long known to be real is a slow book trailing a sharp one: Pinnacle moves
// first on news, and a book that has not moved yet is selling yesterday's price. If Kalshi's game markets trail
// Pinnacle's by more than Kalshi's fee (about 1.75¢ a contract at 50¢) for long enough to buy, there is something
// to test; if they track it within the fee, there is not. Evan opened The Odds API's free tier for this (500 credits
// a month); ODDS_API_KEY is in .env on the Mac and a Fly secret on the box, and never written anywhere else.
//
// THE BUDGET. One /odds read for every NFL game costs 1 credit (h2h, up to ten bookmakers named = one region); the
// /events listing, which says when each game kicks off, is free. A read is made only while a game kicks off within
// WINDOW_MIN (120: inactives come out 90 minutes before), at most once every EVERY_MIN (10), so a kickoff slot costs
// about 12 credits, a normal week about 62 and a heavy one (a London morning, a Monday doubleheader) about 90. It was
// every 8 until the audit of 2026-10-17 simulated November 2026 (five Sundays and Mondays, Thanksgiving's three games,
// two London mornings) at about 445 of the 481 credits above the reserve; at 10 that month is about 360. Below RESERVE
// credits left it stops until the 1st. Each line keeps the credits left, from the response's own header.
//
// THE ORDER OF A RUN (audit 2026-10-17): the free /events listing, then Kalshi's books (free), and only then the paid
// /odds read, so a Kalshi outage spends nothing; until then a failed Kalshi read after the paid one threw the credit
// away every run. games.json keeps every game the listing has shown, with its kickoff, for a week: /events drops a
// game once it is over, and --check, run the next morning, could not see that a game went untaped.
//
// WHAT IS RECORDED, one line per read: { t, credits, games: [{ id, kickoff, home, away, books: { pinnacle: { home,
// away, upd }, ... }, kalshi: { home: { ticker, bid, ask }, away: { ... } } }] }. Odds are decimal; `upd` is the
// time the book last changed that market (The Odds API's last_update), which places a move more finely than the
// eight minutes between reads. Kalshi's books are read in the same run, so the two prices are minutes apart at most.
// Each run leaves one ok/PROBLEM/idle line in odds.log.
const fs = require('fs');
const path = require('path');

const SPORT = 'americanfootball_nfl';
const BOOKS = ['pinnacle', 'draftkings', 'fanduel', 'betmgm', 'betfair_ex_eu'];   // five of ten: one region's cost
const WINDOW_MIN = 120, EVERY_MIN = 10, RESERVE = 20;
const ODDS = 'https://api.the-odds-api.com/v4';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
// The Odds API's team names, and the codes Kalshi gives them in its tickers (KXNFLGAME-26OCT19SEADEN-SEA)
const NFL = {
  'Arizona Cardinals': ['ARI'], 'Atlanta Falcons': ['ATL'], 'Baltimore Ravens': ['BAL'], 'Buffalo Bills': ['BUF'], 'Carolina Panthers': ['CAR'],
  'Chicago Bears': ['CHI'], 'Cincinnati Bengals': ['CIN'], 'Cleveland Browns': ['CLE'], 'Dallas Cowboys': ['DAL'], 'Denver Broncos': ['DEN'],
  'Detroit Lions': ['DET'], 'Green Bay Packers': ['GB'], 'Houston Texans': ['HOU'], 'Indianapolis Colts': ['IND'], 'Jacksonville Jaguars': ['JAC', 'JAX'],
  'Kansas City Chiefs': ['KC'], 'Las Vegas Raiders': ['LV'], 'Los Angeles Chargers': ['LAC'], 'Los Angeles Rams': ['LAR', 'LA'], 'Miami Dolphins': ['MIA'],
  'Minnesota Vikings': ['MIN'], 'New England Patriots': ['NE'], 'New Orleans Saints': ['NO'], 'New York Giants': ['NYG'], 'New York Jets': ['NYJ'],
  'Philadelphia Eagles': ['PHI'], 'Pittsburgh Steelers': ['PIT'], 'San Francisco 49ers': ['SF'], 'Seattle Seahawks': ['SEA'], 'Tampa Bay Buccaneers': ['TB'],
  'Tennessee Titans': ['TEN'], 'Washington Commanders': ['WAS', 'WSH'],
};

const r4 = (x) => Math.round(x * 1e4) / 1e4;
const etDay = (t) => new Date(t).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
// the key never leaves this process: an error that quotes a URL has it cut out
const scrub = (s) => String(s || '').replace(/apiKey=[^&\s]+/g, 'apiKey=…');

async function getJson(url, { tries = 3 } = {}) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { fatal: true });
      return { body: await r.json(), headers: r.headers };
    } catch (e) { if (e.fatal || i >= tries - 1) throw new Error(scrub(e.message)); await new Promise((res) => setTimeout(res, 1000 * 2 ** i)); }
  }
}

// Pure: is a read due? `games` from /events ({ commence_time }), `lastRead` the time of the last odds read.
function due(games, now, lastRead, { windowMin = WINDOW_MIN, everyMin = EVERY_MIN } = {}) {
  const soon = games.filter((g) => { const k = Date.parse(g.commence_time); return k > now && k - now <= windowMin * 60e3; });
  if (!soon.length) return { due: false, why: 'no game within the window' };
  if (lastRead && now - lastRead < everyMin * 60e3 - 15e3) return { due: false, why: 'read less than a step ago' };
  return { due: true, games: soon };
}
// Pure: one game's line from The Odds API's /odds row and Kalshi's open game markets (by ticker)
function gameLine(row, kalshiByCode) {
  const books = {};
  for (const b of row.bookmakers || []) {
    const m = (b.markets || []).find((x) => x.key === 'h2h');
    if (!m) continue;
    const price = (name) => { const o = (m.outcomes || []).find((x) => x.name === name); return o ? o.price : null; };
    books[b.key] = { home: price(row.home_team), away: price(row.away_team), upd: m.last_update || null };
  }
  const k = (team) => {
    for (const code of NFL[team] || []) { const x = kalshiByCode.get(code); if (x) return x; }
    return null;
  };
  return { id: row.id, kickoff: row.commence_time, home: row.home_team, away: row.away_team, books, kalshi: { home: k(row.home_team), away: k(row.away_team) } };
}
// Kalshi's open NFL game markets in the games' window, by team code: { ticker, bid, ask } in dollars
function kalshiIndex(markets, kickoffs) {
  const by = new Map();
  for (const m of markets) {
    const occ = Date.parse(m.occurrence_datetime || m.expected_expiration_time || 0) - 3 * 3600e3;   // kickoff = occurrence - 3h (td-tape's reading)
    if (!kickoffs.some((k) => Math.abs(k - occ) <= 2 * 3600e3)) continue;
    const code = m.ticker.split('-').pop();
    by.set(code, { ticker: m.ticker, bid: +m.yes_bid_dollars || null, ask: +m.yes_ask_dollars || null });
  }
  return by;
}

// Pure: the games the listing has shown, kept a week past their kickoff (td-tape's mergeSchedule does the same):
// `prev` the last games.json, `events` this run's /events rows. A game the listing still shows takes its new kickoff.
function mergeGames(prev, events, now) {
  const by = new Map((Array.isArray(prev) ? prev : []).filter((g) => g && g.id).map((g) => [g.id, g]));
  for (const e of events) by.set(e.id, { id: e.id, kickoff: e.commence_time, home: e.home_team, away: e.away_team });
  return [...by.values()].filter((g) => now - Date.parse(g.kickoff) < 7 * 864e5).sort((a, b) => Date.parse(a.kickoff) - Date.parse(b.kickoff));
}

async function record({ dir = 'data/odds', key = process.env.ODDS_API_KEY, now = Date.now(), dryRun = false } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const logLine = (line) => { if (!dryRun) fs.appendFileSync(path.join(dir, 'odds.log'), `${new Date(now).toISOString()} ${line}\n`); return line; };
  if (!key) return { ok: false, line: logLine('PROBLEM odds-tape: no ODDS_API_KEY set') };
  const stateFile = path.join(dir, 'state.json');
  let state = {};
  try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* first run */ }
  try {
    const ev = await getJson(`${ODDS}/sports/${SPORT}/events?apiKey=${key}`);       // free
    const events = ev.body || [];
    let prev = [];
    try { prev = JSON.parse(fs.readFileSync(path.join(dir, 'games.json'), 'utf8')); } catch { /* first run */ }
    if (!dryRun) fs.writeFileSync(path.join(dir, 'games.json'), JSON.stringify(mergeGames(prev, events, now)));
    if (state.remaining != null && state.remaining < RESERVE && etDay(now).slice(0, 7) === String(state.month || '')) return { ok: true, idle: true, line: logLine(`idle odds-tape: ${state.remaining} credits left, under the reserve of ${RESERVE}, until the 1st`) };
    const d = due(events, now, state.lastRead);
    if (!d.due) return { ok: true, idle: true, line: logLine(`idle odds-tape: ${d.why}`) };
    // Kalshi first, the same minutes: every open NFL game market (one or two pages). Free, so a failure here costs nothing.
    const markets = [];
    let cursor = '';
    do {
      const k = await getJson(`${KALSHI}/markets?series_ticker=KXNFLGAME&status=open&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      markets.push(...(k.body.markets || [])); cursor = k.body.cursor;
    } while (cursor);
    // a dry run stops before the one call that costs a credit
    if (dryRun) return { ok: true, idle: true, line: logLine(`idle odds-tape: dry run, ${d.games.length} game(s) due and ${markets.length} Kalshi markets read; no paid read made`) };
    const from = new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'), to = new Date(now + (WINDOW_MIN + 60) * 60e3).toISOString().replace(/\.\d+Z$/, 'Z');
    const od = await getJson(`${ODDS}/sports/${SPORT}/odds?apiKey=${key}&markets=h2h&oddsFormat=decimal&bookmakers=${BOOKS.join(',')}&commenceTimeFrom=${from}&commenceTimeTo=${to}`, { tries: 1 });
    const remaining = +od.headers.get('x-requests-remaining'), used = +od.headers.get('x-requests-used');
    const rows = od.body || [];
    const idx = kalshiIndex(markets, rows.map((r) => Date.parse(r.commence_time)));
    const games = rows.map((r) => gameLine(r, idx));
    const line = { t: new Date(now).toISOString(), credits: { remaining, used }, games };
    if (!dryRun) {
      fs.appendFileSync(path.join(dir, `odds-${etDay(now)}.jsonl`), `${JSON.stringify(line)}\n`);
      fs.writeFileSync(stateFile, JSON.stringify({ lastRead: now, remaining, month: etDay(now).slice(0, 7) }));
    }
    const paired = games.filter((g) => g.kalshi.home && g.kalshi.away && g.books.pinnacle).length;
    return { ok: true, recorded: games.length, line: logLine(`ok odds-tape: ${games.length} games read (${paired} with Pinnacle and both Kalshi sides), ${remaining} credits left`) };
  } catch (e) {
    return { ok: false, line: logLine(`PROBLEM odds-tape: ${scrub(e.message).slice(0, 160)}`) };
  }
}

// ------------------------------------------------------------------ check and grade (offline)
function readTape(dir, day) {
  const out = [];
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => /^odds-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x) && (!day || x.includes(day))).sort() : []) {
    for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) if (l) { try { out.push(JSON.parse(l)); } catch { /* torn */ } }
  }
  return out;
}
// Pinnacle's chance for home, its margin taken out (the two decimal prices' implied chances, scaled to sum to one)
const noVig = (b) => (b && b.home > 1 && b.away > 1 ? (1 / b.home) / (1 / b.home + 1 / b.away) : null);
const kalshiFee = (p) => Math.ceil(0.07 * p * (1 - p) * 100) / 100;

// The morning check (daily check step 10): the tape has run in the last half hour (it runs every 10 minutes, due or
// not), nothing went wrong in the last day, and every game that kicked off in the last three days (games.json keeps
// them a week) has a read. Until the audit of 2026-10-17 it read only the last log line, whose age it never asked,
// and games.json held only the listing's games still to come, so a missed Sunday read as "ok" on Monday.
const RUN_QUIET_MIN = 30, LOOKBACK_H = 72;
function check(dir, now = Date.now()) {
  const problems = [], lines = [];
  let log = [];
  try { log = fs.readFileSync(path.join(dir, 'odds.log'), 'utf8').trim().split('\n').filter(Boolean); } catch { problems.push('no odds.log: the tape has never run'); }
  const last = log[log.length - 1] || '';
  const at = (l) => Date.parse(String(l).split(' ')[0]);
  if (last) {
    lines.push(`last run: ${last}`);
    if (!(now - at(last) <= RUN_QUIET_MIN * 60e3)) problems.push(`no run since ${String(last).split(' ')[0]}: it runs every ${EVERY_MIN} minutes`);
  }
  const bad = log.filter((l) => / PROBLEM /.test(l) && now - at(l) <= 26 * 3600e3);
  if (bad.length) problems.push(`${bad.length} run(s) went wrong in the last day; the last: ${bad[bad.length - 1]}`);
  const tape = readTape(dir);
  const read = tape[tape.length - 1];
  if (read) lines.push(`${read.credits.remaining} credits left at the last read (${read.t})`);
  let games = [];
  try { games = JSON.parse(fs.readFileSync(path.join(dir, 'games.json'), 'utf8')); } catch { /* none yet */ }
  const taped = new Set(tape.flatMap((l) => l.games.map((g) => g.id)));
  for (const g of Array.isArray(games) ? games : []) {
    const k = Date.parse(g.kickoff);
    if (k < now && now - k < LOOKBACK_H * 3600e3 && !taped.has(g.id)) problems.push(`${g.away} at ${g.home} (${g.kickoff}) kicked off with no tape`);
  }
  return { problems, lines };
}

// For each game and read: Pinnacle's no-vig chance against Kalshi's mid for the home side, and the buy a lag would
// call for: Kalshi's ask under Pinnacle's chance by more than the fee (home or away). Graded against how the game
// settled (Kalshi's result, read once per market), net of the fee. One buy per game and side: the first read
// that called for it.
async function grade(dir, day) {
  const tape = readTape(dir, day);
  const first = new Map(), gaps = [];
  for (const line of tape) {
    for (const g of line.games) {
      const p = noVig(g.books.pinnacle), H = g.kalshi.home, A = g.kalshi.away;
      if (p == null || !H || !A || !(H.bid > 0 && H.ask > 0)) continue;
      const mid = (H.bid + H.ask) / 2;
      gaps.push(p - mid);
      for (const [side, s, fair] of [['home', H, p], ['away', A, 1 - p]]) {
        if (!(s.ask > 0)) continue;
        const edge = fair - s.ask - kalshiFee(s.ask);
        const k = `${g.id}:${side}`;
        if (edge > 0 && !first.has(k)) first.set(k, { t: line.t, game: `${g.away} at ${g.home}`, side, ticker: s.ticker, ask: s.ask, fair: r4(fair), edge: r4(edge) });
      }
    }
  }
  const buys = [...first.values()];
  for (const b of buys) {
    try {
      const m = (await getJson(`${KALSHI}/markets/${b.ticker}`)).body.market;
      b.result = m.result || null;
      if (m.result === 'yes' || m.result === 'no') b.pnl = r4((m.result === 'yes' ? 1 : 0) - b.ask - kalshiFee(b.ask));
    } catch { b.result = null; }
  }
  const settled = buys.filter((b) => b.pnl != null), sum = settled.reduce((a, b) => a + b.pnl, 0);
  const abs = gaps.map(Math.abs).sort((a, b) => a - b), q = (x) => (abs.length ? abs[Math.min(abs.length - 1, Math.floor(x * abs.length))] : null);
  return { reads: tape.length, gaps: gaps.length, medianGap: q(0.5), p90Gap: q(0.9), buys, settled: settled.length, perContract: settled.length ? r4(sum / settled.length) : null };
}

if (require.main === module) (async () => {
  const argv = process.argv.slice(2), at = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const dir = at('dir') || path.join(__dirname, '..', 'data', 'odds');
  if (argv.includes('--record')) {
    if (!process.env.ODDS_API_KEY) require('../src/env').loadEnv(path.join(__dirname, '..', '.env'));
    const r = await record({ dir, dryRun: argv.includes('--dry-run') });
    console.log(r.line); process.exit(r.ok ? 0 : 1);
  } else if (argv.includes('--check')) {
    const c = check(dir);
    for (const l of c.lines) console.log(l);
    for (const p of c.problems) console.log(`PROBLEM ${p}`);
    if (!c.problems.length) console.log('ok');
    process.exit(c.problems.length ? 1 : 0);
  } else if (argv.includes('--grade')) {
    const g = await grade(dir, at('day'));
    console.log(`${g.reads} reads, ${g.gaps} game-moments with Pinnacle and Kalshi both priced`);
    if (g.gaps) console.log(`Pinnacle's no-vig chance against Kalshi's mid: median gap ${(g.medianGap * 100).toFixed(1)} points, 90th percentile ${(g.p90Gap * 100).toFixed(1)}`);
    console.log(`${g.buys.length} buys called for (Kalshi's ask under Pinnacle's chance by more than the fee), ${g.settled} settled` + (g.settled ? `: ${g.perContract >= 0 ? '+' : ''}${(g.perContract * 100).toFixed(1)}¢ a contract after the fee` : ''));
    for (const b of g.buys.slice(0, 20)) console.log(`  ${b.t.slice(5, 16)} ${b.game} ${b.side}: ask ${(b.ask * 100).toFixed(0)}¢, Pinnacle ${(b.fair * 100).toFixed(1)}%${b.pnl != null ? ` → ${b.result}, ${b.pnl >= 0 ? '+' : ''}${(b.pnl * 100).toFixed(1)}¢` : ''}`);
  } else {
    console.log('usage: node tools/odds-tape.js --record [--dry-run] | --check | --grade [--day YYYY-MM-DD]  [--dir D]');
  }
})().catch((e) => { console.error(scrub(e.stack || e.message)); process.exit(1); });

module.exports = { record, check, grade, due, gameLine, kalshiIndex, mergeGames, noVig, kalshiFee, scrub, NFL, BOOKS, WINDOW_MIN, EVERY_MIN, RESERVE };

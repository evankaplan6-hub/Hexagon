'use strict';
// Final scores for the team model (tools/team-model.js, tools/pick-lab.js --model): every game of the leagues the
// bets book bets that an open source publishes, from 2024 on so the 2025 season starts with ratings behind it.
//
//   node tools/score-fetch.js            # → data/lab/scores/{nfl,cfb,mlb}.json, and data/lab/picks/names.json
//
//   NFL   nflverse's games.csv (github.com/nflverse/nfldata, open data, updated through the season)
//   CFB   sportsdataverse's cfbfastR-data schedules (open data; it runs about a week behind)
//   MLB   MLB's own stats API (statsapi.mlb.com; free, for individual non-commercial use, which a paper desk's
//         research is). Read three times, one season a call.
//   NBA   nothing yet: the open NBA set (hoopR-data) stops at 2023, and NBA.com and ESPN forbid automated use.
//
// One line per finished game: { league, season, t (start, ms), home, away, hs, as, neutral }, team as the source
// writes it (a code for the NFL and MLB, a name for college). Kalshi names a college team in its market's
// subtitle ("Ohio St.") and its ticker only by a code ("OSU"), so names.json keeps every Kalshi game market's
// subtitle by ticker, for matching. Read-only public data, no key.
const fs = require('fs');
const path = require('path');

const OUT = 'data/lab/scores';
const KALSHI = 'https://api.elections.kalshi.com/trade-api/v2';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, json = true, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.slice(0, 120)}`), { fatal: true });
      return json ? await r.json() : await r.text();
    } catch (e) { if (e.fatal || i >= tries - 1) throw e; await sleep(800 * 2 ** i); }
  }
}

// A CSV reader for these files: quoted fields, commas and doubled quotes inside them, CRLF or LF.
function csv(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; continue; }
    if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(f); rows.push(row); row = []; f = ''; }
    else f += c;
  }
  if (f || row.length) { row.push(f); rows.push(row); }
  const [head, ...body] = rows;
  return body.filter((r) => r.length === head.length).map((r) => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

// nflverse: gameday (Eastern date) + gametime (Eastern, 24h); location "Neutral" for London and the like
const etToMs = (day, hm) => { const guess = Date.parse(`${day}T${hm || '13:00'}:00Z`); const off = new Date(guess).toLocaleString('en-US', { timeZone: 'America/New_York', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)/); return guess - (off ? +off[1] : -5) * 3600e3; };
function nfl(rows) {
  return rows.filter((r) => +r.season >= 2024 && r.home_score !== '' && r.away_score !== '' && r.game_type !== 'PRE')
    .map((r) => ({ league: 'nfl', season: +r.season, t: etToMs(r.gameday, r.gametime), home: r.home_team, away: r.away_team, hs: +r.home_score, as: +r.away_score, neutral: r.location === 'Neutral' }));
}
function cfb(rows) {
  return rows.filter((r) => String(r.completed).toUpperCase() === 'TRUE' && r.home_points !== '' && r.away_points !== '' && r.home_points !== 'NA')
    .map((r) => ({ league: 'cfb', season: +r.season, t: Date.parse(r.start_date), home: r.home_team, away: r.away_team, hs: +r.home_points, as: +r.away_points,
      neutral: String(r.neutral_site).toUpperCase() === 'TRUE', div: [r.home_division, r.away_division] }));
}
function mlb(d) {
  const out = [];
  for (const day of d.dates || []) {
    for (const g of day.games || []) {
      const h = g.teams && g.teams.home, a = g.teams && g.teams.away;
      if (!h || !a || g.status.abstractGameState !== 'Final' || !Number.isFinite(h.score) || !Number.isFinite(a.score)) continue;
      if (!'RFDLW'.includes(g.gameType)) continue;     // regular season and the four playoff rounds, not spring training
      out.push({ league: 'mlb', season: +g.season, t: Date.parse(g.gameDate), home: h.team.abbreviation, away: a.team.abbreviation, hs: h.score, as: a.score, neutral: false, pk: g.gamePk });
    }
  }
  return out;
}

async function kalshiNames(series) {
  const names = {};
  for (const hist of [true, false]) {
    let cursor = '';
    do {
      const d = await get(hist ? `${KALSHI}/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`
        : `${KALSHI}/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      for (const m of d.markets || []) if (m.yes_sub_title) names[m.ticker] = m.yes_sub_title;
      cursor = d.cursor; await sleep(100);
    } while (cursor);
  }
  return names;
}

if (require.main === module) (async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const N = nfl(csv(await get('https://github.com/nflverse/nfldata/raw/master/data/games.csv', false)));
  fs.writeFileSync(path.join(OUT, 'nfl.json'), JSON.stringify(N));
  console.log(`nfl: ${N.length} games`);
  const C = [];
  for (const y of [2024, 2025, 2026]) C.push(...cfb(csv(await get(`https://raw.githubusercontent.com/sportsdataverse/cfbfastR-data/main/schedules/csv/cfb_schedules_${y}.csv`, false))));
  fs.writeFileSync(path.join(OUT, 'cfb.json'), JSON.stringify(C));
  console.log(`cfb: ${C.length} games, the last ${new Date(Math.max(...C.map((g) => g.t))).toISOString().slice(0, 10)}`);
  const M = [];
  for (const [a, b] of [['2024-03-15', '2024-11-05'], ['2025-03-15', '2025-11-05'], ['2026-03-15', new Date().toISOString().slice(0, 10)]]) {
    M.push(...mlb(await get(`https://statsapi.mlb.com/api/v1/schedule?sportId=1&startDate=${a}&endDate=${b}&gameType=R,F,D,L,W&hydrate=team`)));
    await sleep(500);
  }
  fs.writeFileSync(path.join(OUT, 'mlb.json'), JSON.stringify(M));
  console.log(`mlb: ${M.length} games`);
  const names = {};
  for (const s of ['KXNCAAFGAME', 'KXNFLGAME', 'KXMLBGAME']) Object.assign(names, await kalshiNames(s));
  fs.writeFileSync('data/lab/picks/names.json', JSON.stringify(names));
  console.log(`kalshi names: ${Object.keys(names).length} markets`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { csv, nfl, cfb, mlb, etToMs };

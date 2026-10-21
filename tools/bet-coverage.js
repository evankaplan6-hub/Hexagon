'use strict';
// Every game Kalshi listed in the bets book's series, against the games the book bet (README "Every game"). On
// 2026-10-17 the matcher paired 69 of Saturday's 71 college games and nothing said so: Kansas v Kansas State went
// unbet until a person counted (PR #220), because the coverage alarm (src/agents.js) fires only when a whole league
// pairs nothing on a day. This counts game by game, the morning after (ops/daily-check.sh step 11). Evan: "go".
//
//   node tools/bet-coverage.js                     yesterday (Eastern)
//   node tools/bet-coverage.js --day 2026-10-17    one Eastern day; --days 3 for it and the two before
//   node tools/bet-coverage.js --dir D [--dir E]   where the journals are (default data/fly/archive + data/fly/box-now,
//                                                  both filled by ledger-check --box, daily check step 2)
//
// A game is counted on the day Kalshi settled it (not its ticker's date: see games()). It is BET (an OPEN line of strategy "bet" names its Kalshi event), OVER THE CAP (no bet, and an hour before the
// start Kalshi's favourite cost more than BET_MAX_PX, so the book leaves it alone by design) or MISSED: no bet with
// the favourite under the cap. A miss is a game Polymarket did not list, one the matcher did not pair, one a
// veto stopped (venues 30c apart, a stale quote), or, since 2026-10-18, one not bet before its start (paired late,
// or the box down through the hour before: a game is never bet once under way); the line names it and a person
// looks. Exit 1 on a miss.
// Read-only: Kalshi's public API (listing, and candles for the unbet games only) and the journals on disk.
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const TAG = { KXNCAAFGAME: 'NCAAF', KXNFLGAME: 'NFL', KXNBAGAME: 'NBA', KXMLBGAME: 'MLB' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const etDay = (ms) => new Date(ms).toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
const etTime = (ms) => new Date(ms).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });
const addDays = (day, n) => new Date(Date.parse(`${day}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const eventOf = (ticker) => String(ticker).split('-').slice(0, -1).join('-');

// The events the book bet, from journal lines: { event → the first OPEN of strategy "bet" }. pairId is
// "<pm id>:<outcome>|<Kalshi ticker>".
function betEvents(lines) {
  const out = new Map();
  for (const l of lines) {
    if (!l || l.kind !== 'OPEN' || l.strategy !== 'bet' || !l.pairId) continue;
    const ks = String(l.pairId).split('|')[1];
    if (!ks) continue;
    const ev = eventOf(ks);
    if (!out.has(ev)) out.set(ev, { t: l.t, label: l.label, venue: l.venue, side: l.side, px: l.entry });
  }
  return out;
}

// Kalshi's markets → one game per event: its two sides, whether it has settled, and the Eastern day it was played.
// The day is NOT the ticker's: Kalshi listed Saturday 10-17's college games dated the Friday and never re-dated
// them (PR #221), and their occurrence_datetime is the same placeholder. A settled game's close_time is when Kalshi
// closed it, minutes after the final (README "Kalshi closes first, every time"), so the day is the close less four
// hours (a game ending after midnight Eastern belongs to the evening it started). Its start, for the price an hour
// before, is occurrence_datetime less three hours (tools/pick-fetch.js) when that sits within six hours before the
// close, and otherwise the close less three and a half hours (a football game's length; the cap test is coarse).
const SETTLED = new Set(['finalized', 'settled', 'determined']);
function games(markets) {
  const by = new Map();
  for (const m of markets) {
    if (!m.event_ticker || (m.market_type && m.market_type !== 'binary')) continue;
    if (!by.has(m.event_ticker)) by.set(m.event_ticker, []);
    by.get(m.event_ticker).push(m);
  }
  const out = [];
  for (const [event, ms] of by) {
    const series = event.split('-')[0];
    const done = ms.every((m) => SETTLED.has(m.status) || m.result === 'yes' || m.result === 'no');
    const close = Math.max(...ms.map((m) => Date.parse(m.close_time || '') || 0)) || null;
    const occ = Date.parse(ms[0].occurrence_datetime || ms[0].expected_expiration_time || '');
    let start = Number.isFinite(occ) ? occ - 3 * 3600e3 : null;
    if (done && close && !(start != null && start < close && close - start < 6 * 3600e3)) start = close - 3.5 * 3600e3;
    out.push({ event, series, done, day: done && close ? etDay(close - 4 * 3600e3) : null, start,
      name: ms.map((m) => m.yes_sub_title || m.ticker.split('-').pop()).join(' v '), tickers: ms.map((m) => m.ticker) });
  }
  return out.sort((a, b) => (a.start || 0) - (b.start || 0) || (a.event < b.event ? -1 : 1));
}

// One Eastern day: each game settled that day, BET, OVER THE CAP or MISSED. `fav` maps an unbet event to the
// favourite's Kalshi ask an hour before its start (null: no quote then). Pure, for the tests.
function report(day, all, bets, fav, { cap = 0.9 } = {}) {
  const played = all.filter((g) => g.done && g.day === day);
  const rows = { bet: [], over: [], missed: [] };
  for (const g of played) {
    if (bets.has(g.event)) { rows.bet.push(g); continue; }
    const px = fav.get(g.event);
    (px != null && px > cap + 1e-9 ? rows.over : rows.missed).push({ ...g, px });
  }
  const leagues = Object.entries(played.reduce((a, g) => ({ ...a, [TAG[g.series] || g.series]: (a[TAG[g.series] || g.series] || 0) + 1 }), {}))
    .map(([k, n]) => `${k} ${n}`).join(', ');
  const lines = [];
  const head = new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  lines.push(played.length
    ? `${head}: Kalshi settled ${played.length} game${played.length === 1 ? '' : 's'} in the book's series (${leagues}); bet ${rows.bet.length}, over the ${Math.round(cap * 100)}c cap ${rows.over.length}, missed ${rows.missed.length}`
    : `${head}: Kalshi settled no game in the book's series`);
  for (const g of rows.missed) {
    lines.push(`  MISSED ${TAG[g.series] || g.series} ${g.name}${g.start ? ` (${etTime(g.start)} ET)` : ''}: ` +
      (g.px == null ? 'no Kalshi quote an hour before; ' : `favourite ${Math.round(g.px * 100)}c an hour before, under the cap; `) +
      'not bet: Polymarket did not list it, the matcher did not pair it until it had started (a game is bet only before its start), or a veto stopped it');
  }
  return { lines, missed: rows.missed, bet: rows.bet.length, over: rows.over.length, played: played.length };
}

// ------------------------------------------------------------------ the network and the disk
async function get(url, tries = 5) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.slice(0, 120)}`), { fatal: true });
      return await r.json();
    } catch (e) { if (e.fatal || i >= tries - 1) throw e; await sleep(500 * 2 ** i); }
  }
}

// A settled game market's close_time is when it settled, inside [the day 00:00 ET, the next day 04:00 ET + a
// margin]; one not yet settled closes on its schedule, days on. [the day, the day + 6] holds both, without paging
// through a season.
async function listing(series, day) {
  const lo = Math.floor(Date.parse(`${day}T04:00:00Z`) / 1000), hi = lo + 6 * 86400, out = [];
  let cursor = '';
  do {
    const d = await get(`${BASE}/markets?series_ticker=${series}&min_close_ts=${lo}&max_close_ts=${hi}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...(d.markets || []));
    cursor = d.cursor;
    await sleep(100);
  } while (cursor);
  return out;
}

// The favourite's ask an hour before the start: each side's last hourly candle ending by then, the dearer ask.
async function favouriteAsk(g) {
  if (!g.start) return null;
  const at = Math.floor(g.start / 1000) - 3600;
  let best = null;
  for (const t of g.tickers) {
    try {
      const d = await get(`${BASE}/series/${g.series}/markets/${t}/candlesticks?start_ts=${at - 3 * 3600}&end_ts=${at}&period_interval=60`);
      const ks = (d.candlesticks || []).filter((k) => k.end_period_ts <= at && k.yes_ask);
      const k = ks[ks.length - 1];
      const ask = k && parseFloat(k.yes_ask.close_dollars ?? k.yes_ask.close / 100);
      if (ask > 0 && ask < 1.0001 && (best == null || ask > best)) best = ask;
    } catch { /* no candle: unknown */ }
    await sleep(100);
  }
  return best;
}

// The journal files to read for these days. A bet can be journalled up to a week before its game: until
// 2026-10-14 the book bet a game the cycle it was listed, and the league listings pair a week of games at
// once, so Sunday 10-18's Jaguars, Bears, Panthers and Rams bets went in 10-12 to 10-14 and read as MISSED on
// 10-19 when this read two days back (BET_AHEAD_HOURS was 24 until 10-16, 1 since). A journal file is named by
// its UTC day, so the files from nine days before the first day to the day after the last.
const journalFiles = (days) => Array.from({ length: days.length + 10 }, (_, i) => addDays(days[0], i - 9));

function readJournals(dirs, days) {
  const want = new Set(days), lines = [], seen = new Set();
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (!m || !want.has(m[1])) continue;
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!l) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        const k = `${j.t}|${j.id || ''}|${j.kind}`;
        if (!seen.has(k)) { seen.add(k); lines.push(j); }
      }
    }
  }
  return lines;
}

async function run(argv, { log = console.log } = {}) {
  const at = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const dirs = argv.flatMap((a, i) => (argv[i - 1] === '--dir' ? [a] : []));
  const root = path.join(__dirname, '..');
  const cfg = require('../src/config');
  const last = at('day') || etDay(Date.now() - 864e5);
  const n = Math.max(1, +(at('days') || 1));
  const days = Array.from({ length: n }, (_, i) => addDays(last, i - n + 1));
  const files = journalFiles(days);
  // with the lines the 10-15 disk-full holes swallowed, restored beside the journal (tools/journal-gaps.js): three of
  // that night's bets are only there
  const lines = readJournals(dirs.length ? dirs : [path.join(root, 'data/fly/archive'), path.join(root, 'data/fly/box-now')], files);
  const bets = betEvents([...lines, ...require('./journal-gaps').restoredEvents(lines)]);
  let missed = 0;
  for (const day of days) {
    const all = [];
    for (const ser of cfg.betSeries) all.push(...games(await listing(ser, day)));
    const fav = new Map();
    for (const g of all) if (g.done && g.day === day && !bets.has(g.event)) fav.set(g.event, await favouriteAsk(g));
    const r = report(day, all, bets, fav, { cap: cfg.betMaxPx });
    for (const l of r.lines) log(l);
    missed += r.missed.length;
  }
  log(missed ? `PROBLEM ${missed} game${missed === 1 ? '' : 's'} under the cap went unbet` : 'ok');
  return missed;
}

if (require.main === module) {
  run(process.argv.slice(2)).then((m) => process.exit(m ? 1 : 0)).catch((e) => { console.error(e.stack || e.message); process.exit(2); });
}

module.exports = { betEvents, games, report, eventOf, journalFiles, run };

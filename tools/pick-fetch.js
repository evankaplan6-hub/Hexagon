'use strict';
// Download every SETTLED Kalshi game market in the bets book's series, with its hourly bid/ask in the
// day and a half before the game, for tools/pick-lab.js (can a rule pick winners better than "the favourite"?).
//
//   node tools/pick-fetch.js                    # → data/lab/picks/games.jsonl (resumes: games already on file are skipped)
//   node tools/pick-fetch.js --series KXNFLGAME # one series
//
// One market per game is enough: each game is listed as one market per team, and the other team is
// bought as that market's NO (at 1 - the YES bid), so the first team's book prices both sides.
// Kickoff is Kalshi's occurrence_datetime (older markets: expected_expiration_time, the same hour) less three
// hours (the same reading tools/td-tape.js checked on the NFL; MLB tickers carry their start time,
// KXMLBGAME-26OCT151800TBCLE, and agree).
//
// Kalshi moves markets settled before /historical/cutoff behind /historical endpoints (one market a
// candle call there); both are read. Read-only public data, no key. One line per game:
//   { series, event, ticker, team, opp, result: 'yes'|'no', kickTs, closeTs, vol, feeMult,
//     bars: [[hourTs, bidCents, askCents, volume], ...] }   bars from kickoff-36h to kickoff, both sides quoted
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const args = process.argv.slice(2);
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const SERIES = flag('series', 'KXNFLGAME,KXNCAAFGAME,KXMLBGAME,KXNBAGAME').split(',');
const OUT = flag('out', 'data/lab/picks/games.jsonl');
const HOURS = 36;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (x) => (x ? Math.floor(Date.parse(x) / 1000) || null : null);
const cents = (x) => Math.round(parseFloat(x) * 100);

async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.slice(0, 120)}`), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || i >= tries - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { await fn(items[next++]); await sleep(80); }
  }));
}

// the team a market is for, and its opponent, from the tickers: KXNFLGAME-26OCT15SEADEN-SEA → SEA, DEN
function teams(m) {
  const parts = m.ticker.split('-'), team = parts[parts.length - 1];
  const code = parts[parts.length - 2].replace(/^\d{2}[A-Z]{3}\d{2}(\d{4})?/, '');
  const opp = code.startsWith(team) ? code.slice(team.length) : code.endsWith(team) ? code.slice(0, -team.length) : null;
  return { team, opp };
}

async function listing(series, hist) {
  const out = [];
  let cursor = '';
  do {
    const d = await get(hist
      ? `${BASE}/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`
      : `${BASE}/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
    for (const m of d.markets || []) if (m.market_type === 'binary' && (m.result === 'yes' || m.result === 'no')) out.push({ ...m, hist });
    cursor = d.cursor;
    await sleep(80);
  } while (cursor);
  return out;
}

if (require.main === module) (async () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const have = new Set();
  if (fs.existsSync(OUT)) for (const l of fs.readFileSync(OUT, 'utf8').split('\n')) if (l) { try { have.add(JSON.parse(l).event); } catch {} }
  const out = fs.createWriteStream(OUT, { flags: 'a' });
  for (const series of SERIES) {
    let feeMult = 1;
    try { const s = (await get(`${BASE}/series/${series}`)).series || {}; if (Number.isFinite(+s.fee_multiplier)) feeMult = +s.fee_multiplier; } catch {}
    const all = [...await listing(series, true), ...await listing(series, false)];
    // one market per game: the first ticker of each event, in a fixed order
    const byEvent = new Map();
    for (const m of all.sort((a, b) => (a.ticker < b.ticker ? -1 : 1))) if (!byEvent.has(m.event_ticker)) byEvent.set(m.event_ticker, m);
    const todo = [...byEvent.values()].filter((m) => !have.has(m.event_ticker) && ts(m.occurrence_datetime || m.expected_expiration_time));
    console.log(`${series}: ${byEvent.size} games settled, ${todo.length} to fetch (fee x${feeMult})`);
    let done = 0, kept = 0, failed = 0;
    await pool(todo, 4, async (m) => {
      const kickTs = ts(m.occurrence_datetime || m.expected_expiration_time) - 3 * 3600, closeTs = ts(m.close_time);
      const start = kickTs - HOURS * 3600, end = kickTs;
      try {
        const url = m.hist
          ? `${BASE}/historical/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`
          : `${BASE}/series/${series}/markets/${m.ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`;
        const rows = [];
        for (const k of (await get(url)).candlesticks || []) {
          if (k.end_period_ts > kickTs || k.end_period_ts > closeTs) continue;
          const b = k.yes_bid && cents(k.yes_bid.close_dollars ?? k.yes_bid.close), a = k.yes_ask && cents(k.yes_ask.close_dollars ?? k.yes_ask.close);
          if (!(b > 0 && a < 100 && a > b)) continue;
          rows.push([k.end_period_ts, b, a, Math.round(parseFloat(k.volume_fp ?? k.volume) || 0)]);
        }
        const { team, opp } = teams(m);
        out.write(JSON.stringify({ series, event: m.event_ticker, ticker: m.ticker, team, opp, result: m.result, kickTs, closeTs, vol: parseFloat(m.volume_fp ?? m.volume) || 0, feeMult, bars: rows }) + '\n');
        kept++;
      } catch (e) { failed++; if (failed <= 3) process.stderr.write(`  ${m.ticker}: ${e.message}\n`); }
      if (++done % 500 === 0) process.stderr.write(`  ${series}: ${done}/${todo.length}, ${failed} failed\n`);
    });
    console.log(`${series}: wrote ${kept}, ${failed} failed`);
  }
  await new Promise((r) => out.end(r));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { teams };

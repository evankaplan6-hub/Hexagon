'use strict';
// Fetch what tools/weather-lab.js needs to ask one question: did Kalshi's daily-high-temperature
// markets ever price the weather worse than the public forecast did?
//
//   node tools/weather-fetch.js                        # last 12 months, 8 cities  -> data/lab/weather/
//   node tools/weather-fetch.js --since 2025-09-19 --until 2026-09-18 --window 6
//
// Three public, keyless sources, read-only:
//   1. Kalshi's settled "Highest temperature in <city>" markets: strike, result, and the ACTUAL high
//      Kalshi settled on (`expiration_value`). Older ones live behind /historical, newer on /markets.
//   2. Open-Meteo's previous-runs API: `temperature_2m_previous_day1` is the hourly forecast that was
//      issued one day BEFORE the hour it predicts, which is what a person could have read then.
//   3. Kalshi's hourly bid/ask candles for the day before, so the price at decision time is real.
//
// WHICH MARKETS: only strikes within --window degrees of that day's forecast high. That is a choice
// made from the forecast alone, never from how the day turned out, and it drops the far tails that
// trade at 1c and cost hundreds of calls each.
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const TODAY = new Date().toISOString().slice(0, 10);
const SINCE = flag('since', new Date(Date.now() - 365 * 86400000).toISOString().slice(0, 10));
const UNTIL = flag('until', new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10));
const WINDOW = parseFloat(flag('window', 6));
const OUT = flag('out', 'data/lab/weather');

// Kalshi settles each city on a named station. These are that station's coordinates; whatever the
// forecast grid gets wrong about it is a per-city bias, and weather-lab.js fits and removes it.
const CITIES = {
  KXHIGHNY:   { name: 'New York (Central Park)', lat: 40.7789, lon: -73.9692, tz: 'America/New_York' },
  KXHIGHCHI:  { name: 'Chicago (Midway)',        lat: 41.7868, lon: -87.7522, tz: 'America/Chicago' },
  KXHIGHMIA:  { name: 'Miami',                   lat: 25.7959, lon: -80.2870, tz: 'America/New_York' },
  KXHIGHAUS:  { name: 'Austin',                  lat: 30.1945, lon: -97.6699, tz: 'America/Chicago' },
  KXHIGHLAX:  { name: 'Los Angeles (LAX)',       lat: 33.9425, lon: -118.4081, tz: 'America/Los_Angeles' },
  KXHIGHDEN:  { name: 'Denver',                  lat: 39.8561, lon: -104.6737, tz: 'America/Denver' },
  KXHIGHPHIL: { name: 'Philadelphia',            lat: 39.8721, lon: -75.2411, tz: 'America/New_York' },
  KXHIGHHOU:  { name: 'Houston (Hobby)',         lat: 29.6454, lon: -95.2789, tz: 'America/Chicago' },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.slice(0, 110)}`), { fatal: true });
      return await r.json();
    } catch (e) { if (e.fatal || i >= tries - 1) throw e; await sleep(500 * 2 ** i); }
  }
}
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => { while (next < items.length) { await fn(items[next++]); await sleep(40); } }));
}

// Local wall-clock time in a zone -> epoch seconds, without a library: guess UTC, read what the zone
// shows for the guess, and move by the difference.
function localToEpoch(dateStr, hour, tz) {
  const [y, m, d] = dateStr.split('-').map(Number);
  let guess = Date.UTC(y, m - 1, d, hour);
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const shown = (t) => { const p = Object.fromEntries(f.formatToParts(new Date(t)).map((x) => [x.type, x.value])); return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute); };
  guess -= shown(guess) - guess;
  return Math.floor(guess / 1000);
}
const addDays = (s, n) => new Date(Date.parse(`${s}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const MON = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
function eventDate(ev) {
  const m = /-(\d{2})([A-Z]{3})(\d{2})$/.exec(ev);
  return m && MON[m[2]] ? `20${m[1]}-${String(MON[m[2]]).padStart(2, '0')}-${m[3]}` : null;
}

module.exports = { CITIES, localToEpoch, eventDate, addDays };
if (require.main !== module) return;

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const cutoff = Date.parse((await get(`${BASE}/historical/cutoff`)).market_settled_ts) / 1000;
  const first = addDays(SINCE, -1), last = addDays(UNTIL, 1);

  // 2. forecasts: one call per city for the whole span
  const forecasts = {};
  for (const [series, c] of Object.entries(CITIES)) {
    const u = `https://previous-runs-api.open-meteo.com/v1/forecast?latitude=${c.lat}&longitude=${c.lon}&hourly=temperature_2m_previous_day1&start_date=${first}&end_date=${last}&temperature_unit=fahrenheit&timezone=${encodeURIComponent(c.tz)}`;
    const d = await get(u);
    const byDay = {};
    (d.hourly.time || []).forEach((t, i) => {
      const v = d.hourly.temperature_2m_previous_day1[i];
      if (v == null) return;
      const day = t.slice(0, 10);
      (byDay[day] = byDay[day] || []).push(v);
    });
    // a day with under 20 hourly values is a hole in the archive, not a cool day
    forecasts[series] = Object.fromEntries(Object.entries(byDay).filter(([, v]) => v.length >= 20).map(([day, v]) => [day, Math.round(Math.max(...v) * 10) / 10]));
    console.log(`${series}: ${Object.keys(forecasts[series]).length} forecast days`);
    await sleep(300);
  }
  fs.writeFileSync(path.join(OUT, 'forecasts.json'), JSON.stringify(forecasts));

  // 1. markets
  const picked = [];
  for (const [series, c] of Object.entries(CITIES)) {
    const seen = [];
    const take = (m) => {
      if (m.market_type !== 'binary' || (m.result !== 'yes' && m.result !== 'no')) return;
      const day = eventDate(m.event_ticker || '');
      if (!day || day < SINCE || day > UNTIL) return;
      const actual = parseFloat(m.expiration_value);
      if (!Number.isFinite(actual)) return;
      const f = forecasts[series][day];
      if (f == null) return;
      const lo = m.floor_strike, hi = m.cap_strike;
      const strike = lo != null && hi != null ? (lo + hi) / 2 : (lo ?? hi);
      if (strike == null || Math.abs(strike - f) > WINDOW) return;                       // chosen from the forecast alone
      seen.push({ ticker: m.ticker, event: m.event_ticker, series, day, strikeType: m.strike_type, floor: lo, cap: hi, result: m.result, actual, closeTs: Math.floor(Date.parse(m.close_time) / 1000), live: Date.parse(m.close_time) / 1000 > cutoff });
    };
    let cursor = '', pages = 0;
    do {                                                                                  // the older markets
      const d = await get(`${BASE}/historical/markets?series_ticker=${series}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      (d.markets || []).forEach(take); cursor = d.cursor; pages++; await sleep(60);
    } while (cursor && pages < 60);
    cursor = ''; pages = 0;
    do {                                                                                  // the newer ones
      const d = await get(`${BASE}/markets?series_ticker=${series}&status=settled&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      (d.markets || []).forEach(take); cursor = d.cursor; pages++; await sleep(60);
    } while (cursor && pages < 30);
    const uniq = [...new Map(seen.map((m) => [m.ticker, m])).values()];
    picked.push(...uniq);
    console.log(`${series}: ${uniq.length} markets within ${WINDOW}F of the forecast, ${uniq.filter((m) => m.live).length} on the live API`);
  }

  // 3. hourly candles from noon local on the day BEFORE to noon local on the day itself
  const cents = (x) => Math.round(parseFloat(x) * 100);
  const out = fs.createWriteStream(path.join(OUT, 'markets.jsonl'));
  let done = 0, kept = 0, failed = 0;
  const rows = (cs) => cs.map((k) => {
    const b = k.yes_bid && cents(k.yes_bid.close_dollars ?? k.yes_bid.close), a = k.yes_ask && cents(k.yes_ask.close_dollars ?? k.yes_ask.close);
    return b > 0 && a < 100 && a > b ? [Math.floor(k.end_period_ts / 3600) * 3600, b, a, Math.round(parseFloat(k.volume_fp ?? k.volume) || 0)] : null;
  }).filter(Boolean);
  const win = (m) => { const tz = CITIES[m.series].tz; return [localToEpoch(addDays(m.day, -1), 12, tz), localToEpoch(m.day, 12, tz)]; };
  const write = (m, bars) => {
    if (bars.length < 3) return;
    const { live, ...rest } = m;
    out.write(JSON.stringify({ ...rest, city: CITIES[m.series].name, forecast: forecasts[m.series][m.day], bars }) + '\n'); kept++;
  };
  const older = picked.filter((m) => !m.live), newer = picked.filter((m) => m.live).sort((a, b) => a.closeTs - b.closeTs);
  await pool(older, 6, async (m) => {
    const [s, e] = win(m);
    try { write(m, rows((await get(`${BASE}/historical/markets/${m.ticker}/candlesticks?start_ts=${s}&end_ts=${e}&period_interval=60`)).candlesticks || [])); } catch { failed++; }
    if (++done % 500 === 0) process.stderr.write(`  candles ${done}/${picked.length} · ${kept} kept · ${failed} failed\n`);
  });
  const batches = []; for (let i = 0; i < newer.length; i += 5) batches.push(newer.slice(i, i + 5));
  await pool(batches, 4, async (batch) => {
    const s = Math.min(...batch.map((m) => win(m)[0])), e = Math.max(...batch.map((m) => win(m)[1]));
    try {
      const d = await get(`${BASE}/markets/candlesticks?market_tickers=${batch.map((m) => m.ticker).join(',')}&start_ts=${s}&end_ts=${e}&period_interval=60`);
      const by = new Map((d.markets || []).map((x) => [x.market_ticker, x.candlesticks || []]));
      for (const m of batch) { const [ms, me] = win(m); write(m, rows((by.get(m.ticker) || []).filter((k) => k.end_period_ts >= ms && k.end_period_ts <= me))); }
    } catch { failed += batch.length; }
    done += batch.length;
  });
  await new Promise((r) => out.end(r));
  console.log(`wrote ${OUT}/markets.jsonl: ${kept} markets with candles, ${failed} failed`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

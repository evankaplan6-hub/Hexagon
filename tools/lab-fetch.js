'use strict';
// Download SETTLED Kalshi markets with their hourly bid/ask history, for tools/lab.js.
//
//   node tools/lab-fetch.js                         # → data/lab/markets.jsonl
//   node tools/lab-fetch.js --perSeries 15 --max 8000 --days 30
//   node tools/lab-fetch.js --relist                # re-pull the cached listings instead of reusing them
//   node tools/lab-fetch.js --historical --since 2026-04-15 --until 2026-07-15 --skipCategory Sports
//                                                   # OLDER settled markets, from Kalshi's /historical endpoints,
//                                                   # into data/lab/markets-hist.jsonl (same line format). Reuses
//                                                   # the series list the normal run cached, so run that first.
//
// Why settled markets: every tape this repo had before was of markets still open, so a strategy
// that holds to resolution could only be marked, never scored, and every pool was survivors.
// Settled markets carry their result, so a held position is paid what it was actually worth.
//
// HOW MARKETS ARE CHOSEN, which is the whole game. The first version kept markets that had traded
// at least 5,000 contracts in their life, and the sample came out rigged: contracts priced at 20c
// resolved YES 40% of the time, 90c favourites 72%. Lifetime volume is decided AFTER the fact, and
// an upset is what makes a market trade -- a favourite that simply wins is quiet, an underdog
// that comes back is the busiest market of the night. So volume-picked markets are upset-picked,
// and "buy the underdog" scored +10c a contract on nothing but that. The rule now:
//   1. SERIES are chosen by liquidity (a series with 10+ busy markets in the window). That is a
//      property of the series, not of how any one market ended.
//   2. Within a series, whole EVENTS are drawn in a fixed pseudo-random order (a hash of the
//      ticker) and every market in a drawn event is kept, busy or not. Both sides of a game go in
//      together.
//   3. The life filter reads the SCHEDULED end, not the actual close, which for a can-close-early
//      market is when the answer arrived.
// tools/lab.js prints a calibration check on every run so a biased sample is visible, not assumed.
//
// Why this window: Kalshi moves markets settled before `/historical/cutoff` (2026-07-15 when this
// was written) behind separate historical endpoints. Everything after it is on the live API.
//
// Read-only public data, no key. One line per market:
//   { ticker, event, series, category, result: 'yes'|'no', openTs, closeTs, earlyClose, expectTs,
//     vol, feeMult, bars: [[hourTs, bidCents, askCents, volume], ...] }
// A bar is kept only where both sides were quoted (0 < bid < ask < 100), so a missing hour means
// the book was one-sided or empty, not that the price was zero.
const fs = require('fs');
const path = require('path');

const BASE = 'https://api.elections.kalshi.com/trade-api/v2';
const args = process.argv.slice(2);
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
const SINCE = Math.floor(Date.parse(flag('since', '2026-07-15')) / 1000);
const DAYS = parseFloat(flag('days', 30));                        // hourly history kept before close
const MIN_LIFE_H = parseFloat(flag('minLife', 48));               // scheduled life, open to expected end
const SERIES_MIN_BUSY = parseInt(flag('seriesMinBusy', 10), 10);  // busy markets a series needs to qualify
const BUSY_VOL = parseFloat(flag('busyVol', 5000));               // what "busy" means, for choosing SERIES only
const PER_SERIES = parseInt(flag('perSeries', 15), 10);           // markets drawn per series (whole events)
const MAX_EVENT = parseInt(flag('maxEvent', 12), 10);             // skip events with more markets than this (strike ladders)
const MAX = parseInt(flag('max', 8000), 10);
const HIST = args.includes('--historical');
const UNTIL = Math.floor(Date.parse(flag('until', '2100-01-01')) / 1000);   // historical mode: latest close kept
const SKIP_CATEGORY = flag('skipCategory', '');                              // historical mode: drop a whole category
const OUT = flag('out', HIST ? 'data/lab/markets-hist.jsonl' : 'data/lab/markets.jsonl');
const DIR = path.dirname(OUT);
const RELIST = args.includes('--relist');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ts = (x) => (x ? Math.floor(Date.parse(x) / 1000) || null : null);
const hash = (s) => { let h = 2166136261; for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619); return h >>> 0; };

async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    try {
      const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (r.status === 429 || r.status >= 500) throw new Error(`HTTP ${r.status}`);
      if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status} ${url.slice(0, 100)}`), { fatal: true });
      return await r.json();
    } catch (e) {
      if (e.fatal || i >= tries - 1) throw e;
      await sleep(500 * 2 ** i);
    }
  }
}

// run `fn` over `items`, `n` at a time, lightly paced
async function pool(items, n, fn) {
  let next = 0;
  await Promise.all(Array.from({ length: n }, async () => {
    while (next < items.length) { await fn(items[next++]); await sleep(60); }
  }));
}

async function cached(file, build) {
  if (fs.existsSync(file) && !RELIST) { const v = JSON.parse(fs.readFileSync(file, 'utf8')); console.log(`cached ${file}`); return v; }
  const v = await build();
  fs.writeFileSync(file, JSON.stringify(v));
  return v;
}

(async () => {
  fs.mkdirSync(DIR, { recursive: true });

  // 1. which series are liquid: count busy settled markets per series across the window. Slow
  //    (the exchange settles millions of markets a month), so cached.
  // Historical mode does not rescan: series liquidity is a property of the SERIES, already measured by
  // the normal run, and none of it depends on how any older market ended.
  if (HIST && !fs.existsSync(path.join(DIR, 'series-busy.json'))) { console.error('run tools/lab-fetch.js once first: --historical reuses its series-busy.json'); process.exit(1); }
  const busy = await cached(path.join(DIR, 'series-busy.json'), async () => {
    const count = {};
    let cursor = '', pages = 0, seen = 0;
    do {
      const d = await get(`${BASE}/markets?status=settled&mve_filter=exclude&min_close_ts=${SINCE}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
      pages++;
      for (const m of d.markets || []) {
        seen++;
        if ((parseFloat(m.volume_fp) || 0) >= BUSY_VOL) { const s = String(m.event_ticker).split('-')[0]; count[s] = (count[s] || 0) + 1; }
      }
      cursor = d.cursor;
      if (pages % 50 === 0) process.stderr.write(`  series scan: ${pages} pages, ${seen} markets\n`);
      await sleep(50);
    } while (cursor);
    return count;
  });
  let series = Object.entries(busy).filter(([, n]) => n >= SERIES_MIN_BUSY).map(([s]) => s).sort();
  // fee multiplier and category per series (0 on some Politics/Crypto series, 0.5 on MLB games)
  const seriesInfo = new Map();
  const infoOf = async (s) => {
    if (seriesInfo.has(s)) return;
    try { const d = (await get(`${BASE}/series/${s}`)).series || {}; seriesInfo.set(s, { feeMult: Number.isFinite(+d.fee_multiplier) ? +d.fee_multiplier : 1, category: d.category || '' }); }
    catch { seriesInfo.set(s, { feeMult: 1, category: '' }); }
  };
  if (HIST && SKIP_CATEGORY) {
    await pool(series, 4, infoOf);
    series = series.filter((s) => (seriesInfo.get(s) || {}).category !== SKIP_CATEGORY);
    console.log(`historical: ${series.length} series left after skipping ${SKIP_CATEGORY}`);
  }
  console.log(`${series.length} series with ${SERIES_MIN_BUSY}+ markets of ${BUSY_VOL}+ volume`);

  // 2. every settled market in those series, busy or not; draw whole events per series
  const universe = await cached(path.join(DIR, HIST ? 'universe-hist.json' : 'universe.json'), async () => {
    const out = [];
    let done = 0;
    await pool(series, 4, async (s) => {
      let cursor = '', pages = 0;
      const all = [];
      try {
        do {
          const d = await get(HIST ? `${BASE}/historical/markets?series_ticker=${s}&limit=1000${cursor ? `&cursor=${cursor}` : ''}` : `${BASE}/markets?series_ticker=${s}&status=settled&min_close_ts=${SINCE}&limit=1000${cursor ? `&cursor=${cursor}` : ''}`);
          for (const m of d.markets || []) {
            if (m.market_type !== 'binary' || (m.result !== 'yes' && m.result !== 'no')) continue;
            const openTs = ts(m.open_time), closeTs = ts(m.close_time), expectTs = ts(m.expected_expiration_time);
            const schedEnd = m.can_close_early ? expectTs : closeTs;
            if (!(closeTs >= SINCE) || closeTs > UNTIL || !schedEnd || schedEnd - openTs < MIN_LIFE_H * 3600) continue;
            all.push({ ticker: m.ticker, event: m.event_ticker, series: s, result: m.result, openTs, closeTs, earlyClose: !!m.can_close_early, expectTs, vol: parseFloat(m.volume_fp) || 0 });
          }
          cursor = d.cursor;
        } while (cursor && ++pages < 10);
      } catch (e) { process.stderr.write(`  ${s}: ${e.message}\n`); }
      const events = new Map();
      for (const m of all) { if (!events.has(m.event)) events.set(m.event, []); events.get(m.event).push(m); }
      const order = [...events.keys()].sort((a, b) => hash(a) - hash(b));
      let n = 0;
      for (const e of order) {
        const ms = events.get(e);
        if (ms.length > MAX_EVENT) continue;
        if (n >= PER_SERIES) break;
        out.push(...ms); n += ms.length;
      }
      if (++done % 100 === 0) process.stderr.write(`  universe: ${done}/${series.length} series, ${out.length} markets\n`);
    });
    return out;
  });
  const picked = universe.slice().sort((a, b) => hash(a.series) - hash(b.series)).slice(0, MAX);
  console.log(`universe: ${universe.length} markets drawn as whole events; fetching ${picked.length}`);

  // 3. fee multiplier and category for what was picked (already known for any series read above)
  await pool([...new Set(picked.map((m) => m.series))], 4, infoOf);

  // 4. hourly candles, up to DAYS before close, five markets a call
  const out = fs.createWriteStream(OUT);
  const cents = (x) => Math.round(parseFloat(x) * 100);
  // batched by close time so one call spans ~DAYS, not months (the endpoint caps candles per call)
  const byClose = picked.slice().sort((a, b) => a.closeTs - b.closeTs), batches = [];
  for (let i = 0; i < byClose.length; i += (HIST ? 1 : 5)) batches.push(byClose.slice(i, i + (HIST ? 1 : 5)));
  let done = 0, bars = 0, failed = 0, kept = 0;
  await pool(batches, 4, async (batch) => {
    const start = Math.min(...batch.map((m) => Math.max(m.openTs, m.closeTs - DAYS * 86400)));
    const end = Math.max(...batch.map((m) => m.closeTs));
    try {
      // the historical endpoint is one market per call and spells its fields without the _dollars suffix
      const d = HIST
        ? { markets: [{ market_ticker: batch[0].ticker, candlesticks: (await get(`${BASE}/historical/markets/${batch[0].ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`)).candlesticks || [] }] }
        : await get(`${BASE}/markets/candlesticks?market_tickers=${batch.map((m) => m.ticker).join(',')}&start_ts=${start}&end_ts=${end}&period_interval=60`);
      const byTicker = new Map((d.markets || []).map((x) => [x.market_ticker, x.candlesticks || []]));
      for (const m of batch) {
        const from = Math.max(m.openTs, m.closeTs - DAYS * 86400), rows = [];
        for (const k of byTicker.get(m.ticker) || []) {
          if (k.end_period_ts < from || k.end_period_ts > m.closeTs) continue;
          const b = k.yes_bid && cents(k.yes_bid.close_dollars ?? k.yes_bid.close), a = k.yes_ask && cents(k.yes_ask.close_dollars ?? k.yes_ask.close);
          if (!(b > 0 && a < 100 && a > b)) continue;
          rows.push([Math.floor(k.end_period_ts / 3600) * 3600, b, a, Math.round(parseFloat(k.volume_fp ?? k.volume) || 0)]);
        }
        if (rows.length >= 12) { out.write(JSON.stringify({ ...m, ...seriesInfo.get(m.series), bars: rows }) + '\n'); bars += rows.length; kept++; }
      }
    } catch (e) { failed += batch.length; }
    done += batch.length;
    if (done % 1000 < 10) process.stderr.write(`  candles: ${done}/${picked.length}, ${kept} kept, ${bars} bars, ${failed} failed\n`);
  });
  await new Promise((r) => out.end(r));
  console.log(`wrote ${OUT}: ${kept} markets with 12+ quoted hours, ${bars} hourly bars, ${failed} failed`);
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

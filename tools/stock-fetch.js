'use strict';
// Download daily bars for the stock/ETF lab (tools/stock-lab.js): ETFs from Yahoo's public chart
// endpoint, Cboe's option-strategy indexes and VIX from Cboe's own history files.
//
//   node tools/stock-fetch.js                 # every symbol below → data/stocks/bars/<SYMBOL>.json
//   node tools/stock-fetch.js --only SPY,TLT  # just these
//   node tools/stock-fetch.js --refresh       # re-download files that already exist
//
// RESEARCH ONLY. This reads public price history. It has no broker, no account, no key, and no way
// to place an order.
//
// THE UNIVERSE IS FIXED HERE, BEFORE ANY RESULT WAS SEEN, and that is the point of it. Picking
// single stocks that exist today is picking survivors: Apple and Nvidia are in any list made in 2026
// because they won, and every backtest that starts from that list inherits the win. Broad, liquid
// ETFs are the same list whoever makes it and whenever: the whole US market (SPY, DIA), big tech
// (QQQ), small caps (IWM), the nine original sector SPDRs, Treasuries short to long (SHY, IEF, TLT),
// investment-grade and junk corporate bonds (LQD, HYG), gold and silver (GLD, SLV), developed and
// emerging markets outside the US (EFA, EEM), and real estate (VNQ). Leveraged and inverse ETFs are
// left out on purpose: they decay, and a backtest that finds them is finding the decay's timing.
//
// Plus three Cboe indexes, for what free data cannot otherwise show. Historical option chains are
// not free anywhere, so an options-income strategy cannot be backtested honestly from quotes. Cboe
// publishes indexes of the two plain ones instead: BXM (own the S&P 500, sell a one-month at-the-money
// call every month) and PUT (hold T-bills, sell a one-month at-the-money put every month). VIX is the
// market's own price of 30-day S&P volatility, used here only as a signal. Indexes cannot be bought;
// the funds that track them charge fees and trail them. The indexes come from Cboe's own daily
// history files (cdn.cboe.com), the publisher, rather than Yahoo. PUT's file has a handful of
// scattered early points and is daily only from 2007, so only the unbroken run at the end is kept.
//
// One file per symbol:
//   { symbol, source, fetchedAt, currency, bars: [{ d: 'YYYY-MM-DD', o, h, l, c, ac, v }, ...] }
// o/h/l/c are Yahoo's split-adjusted prices; `ac` also folds in dividends (total return). A day with
// no close is dropped rather than guessed. Cboe's BXM and PUT are already total-return indexes and
// carry only a close, so o/h/l are null and `ac` is the close.
const fs = require('fs');
const path = require('path');

const ETFS = ['SPY', 'QQQ', 'IWM', 'DIA',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLY', 'XLP', 'XLI', 'XLU', 'XLB',
  'TLT', 'IEF', 'SHY', 'LQD', 'HYG',
  'GLD', 'SLV', 'EFA', 'EEM', 'VNQ'];
const INDEXES = ['^BXM', '^PUT', '^VIX'];
const CBOE = (sym) => `https://cdn.cboe.com/api/global/us_indices/daily_prices/${sym.slice(1)}_History.csv`;

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
// `range=max` with `interval=1d` silently answers in MONTHLY bars -- SPY comes back as 405 rows
// covering 1993-2026 rather than 8,464 daily ones -- and nothing in the response says so. An explicit
// period1/period2 window returns the real daily series, so the range parameter is not used here.
const PACE_MS = 1100;
// Yahoo refuses (429) every request after the first few on a REUSED connection: a long-lived
// process keeping one socket open gets flagged, while fresh ones are served. `connection: close`
// asks for a new socket each time, which is what a browser tab effectively does.
const DIR = 'data/stocks/bars';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fileFor = (sym, dir = DIR) => path.join(dir, `${sym.replace(/[^A-Za-z0-9]/g, '_')}.json`);

// Yahoo's chart JSON → bars. Pure, so it is tested without the network.
function parseChart(json) {
  const r = json && json.chart && json.chart.result && json.chart.result[0];
  if (!r) {
    const e = json && json.chart && json.chart.error;
    throw new Error(e ? `${e.code}: ${e.description}` : 'no chart result');
  }
  const ts = r.timestamp || [];
  const q = (r.indicators && r.indicators.quote && r.indicators.quote[0]) || {};
  const adj = (r.indicators && r.indicators.adjclose && r.indicators.adjclose[0] && r.indicators.adjclose[0].adjclose) || null;
  const off = (r.meta && r.meta.gmtoffset) || 0;
  const bars = [];
  for (let i = 0; i < ts.length; i++) {
    const c = q.close && q.close[i];
    if (!(c > 0)) continue;
    const d = new Date((ts[i] + off) * 1000).toISOString().slice(0, 10);
    const num = (a) => (a && a[i] > 0 ? a[i] : null);
    const bar = { d, o: num(q.open), h: num(q.high), l: num(q.low), c, ac: adj && adj[i] > 0 ? adj[i] : c, v: (q.volume && q.volume[i]) || 0 };
    if (bars.length && bars[bars.length - 1].d === d) bars[bars.length - 1] = bar;   // the live day can repeat
    else bars.push(bar);
  }
  return { symbol: r.meta && r.meta.symbol, currency: r.meta && r.meta.currency, bars };
}

// Cboe history CSV (DATE,BXM or DATE,OPEN,HIGH,LOW,CLOSE; dates MM/DD/YYYY) → bars, keeping only the
// unbroken daily run after the last gap of more than MAX_GAP_DAYS calendar days. Pure.
const MAX_GAP_DAYS = 10;
function parseCboe(csv) {
  const lines = csv.trim().split(/\r?\n/);
  const head = lines.shift().split(',').map((x) => x.trim().toUpperCase());
  const col = (n) => head.indexOf(n);
  const ci = col('CLOSE') >= 0 ? col('CLOSE') : 1;
  const rows = [];
  for (const l of lines) {
    const f = l.split(',');
    const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((f[0] || '').trim());
    const c = parseFloat(f[ci]);
    if (!m || !(c > 0)) continue;
    const num = (n) => (col(n) >= 0 && parseFloat(f[col(n)]) > 0 ? parseFloat(f[col(n)]) : null);
    rows.push({ d: `${m[3]}-${m[1]}-${m[2]}`, o: num('OPEN'), h: num('HIGH'), l: num('LOW'), c, ac: c, v: 0 });
  }
  rows.sort((a, b) => (a.d < b.d ? -1 : 1));
  let start = 0;
  for (let i = 1; i < rows.length; i++) if ((Date.parse(rows[i].d) - Date.parse(rows[i - 1].d)) / 86400000 > MAX_GAP_DAYS) start = i;
  return rows.slice(start);
}

async function get(url, tries = 6) {
  for (let i = 0; ; i++) {
    let status = 0;
    try {
      const r = await fetch(url, { headers: { 'user-agent': UA, accept: 'application/json', connection: 'close' } });
      status = r.status;
      if (r.status === 200) return await r.json();
      if (r.status === 404) return await r.json().catch(() => ({ chart: { error: { code: 'Not Found', description: 'HTTP 404' } } }));
      throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      if (i + 1 >= tries) throw e;
      const wait = status === 429 ? 15000 * (i + 1) : 2000 * (i + 1);   // a refusal gets a long breath
      console.log(`  ${e.message}, retry in ${wait / 1000}s`);
      await sleep(wait);
    }
  }
}

module.exports = { ETFS, INDEXES, parseChart, parseCboe, fileFor };

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
    const syms = flag('only') ? flag('only').split(',') : [...ETFS, ...INDEXES];
    const refresh = args.includes('--refresh');
    fs.mkdirSync(DIR, { recursive: true });
    const missing = [];
    for (const sym of syms) {
      const file = fileFor(sym);
      if (!refresh && fs.existsSync(file)) { console.log(`${sym.padEnd(5)} cached`); continue; }
      const cboe = INDEXES.includes(sym);
      const url = cboe ? CBOE(sym) : `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?period1=0&period2=9999999999&interval=1d&events=div,splits`;
      try {
        let parsed;
        if (cboe) {
          const r = await fetch(url, { headers: { 'user-agent': UA, connection: 'close' } });
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          parsed = { currency: 'USD', bars: parseCboe(await r.text()) };
        } else parsed = parseChart(await get(url));
        if (!parsed.bars.length) throw new Error('no bars');
        fs.writeFileSync(file, JSON.stringify({ symbol: sym, source: url, fetchedAt: new Date().toISOString(), currency: parsed.currency, bars: parsed.bars }));
        console.log(`${sym.padEnd(5)} ${parsed.bars.length} days ${parsed.bars[0].d} → ${parsed.bars[parsed.bars.length - 1].d}`);
      } catch (e) {
        missing.push(sym);
        console.log(`${sym.padEnd(5)} UNAVAILABLE: ${e.message}`);
      }
      await sleep(PACE_MS);
    }
    if (missing.length) console.log(`\nnot fetched: ${missing.join(' ')} -- the lab runs without them and says so`);
  })();
}

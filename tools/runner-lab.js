'use strict';
// The runner lab: does the runner book's rule (src/desk/books.js, RUNNER) make money over years, not one
// month? Before it shipped on 2026-09-30 the rule had one check, the 37 days 2026-08-25 to 09-30, in which
// the average coin rose a third. Everything before 2026-08-25 is out of sample for it.
//
//   node tools/runner-lab.js --fetch                  Coinbase hourly candles for every RUNNER_COINS coin
//                                                     -> data/crypto/hours/ (resumable; again to extend)
//   node tools/runner-lab.js                          the table, from 2022-01-01 to the last hour
//   node tools/runner-lab.js --from 2025-01-01 --slip 20
//
// RESEARCH ONLY. It reads Coinbase's public candles and nothing else: no key, no account, no order.
//
// THE SCAN, rebuilt from hourly candles and handed to the book's own books.runnerScan and books.runnerExit:
// at the close of each hour, a coin's 24-hour figures are its close 24 hours before (Coinbase's "open"), the
// highest high of the last 24 hours, its close now and the sum of the last 24 hours' volume; "still
// climbing" is against the close an hour before. The book scans every 3 minutes, so this sees the same
// rule twenty times less often: a trail is checked on hourly closes, and a coin that fell through it and
// bounced inside an hour is not sold.
// THE FILLS: at that hour's close, --slip (default 0.10%) worse, plus Robinhood's 0.95% a side
// (DESK_RUNNER_FEE_BPS). Up to four coins, a quarter of the book's value each, never more than its cash;
// a coin sold waits 12 hours. The book's daily loss limit is not modelled.
// THE BIAS: the coins are Robinhood's list of 2026-09-30. Coins that died before then are not on it, and
// coins listed late have no early history, so the early years trade a smaller, surviving set. That flatters
// the rule; read a loss here as a loss, and a gain as at most a gain.
//
// WHAT IT FOUND (2026-10-08, 81 coins, hourly candles 2022-01-01 to 2026-10-08 06:00 UTC): the rule loses. It
// reproduces the check it shipped on (08-25 to 09-30: 48 trades, 15 won, +6%) and the box's own book (from 09-30:
// about -22% on 15 trades, 1 won; the box said -20%). Before 08-25, a fresh $1,000 a quarter ended up in 3 of 20
// quarters; straight through, $1,000 became $20. With no fee and no slip it still lost 83%: a coin up 8%+ near its
// high gave the move back more often than it ran. No one-setting change rescued it. README, "Runners".
const fs = require('fs');
const path = require('path');
const books = require('../src/desk/books');

const DIR = path.join(__dirname, '..', 'data', 'crypto', 'hours');
const HOUR = 3600000;
const FIT_FROM = Date.parse('2026-08-25T00:00:00Z');   // the month the rule was checked on before it shipped
const LIVE_FROM = Date.parse('2026-09-30T00:00:00Z');  // the book's first day on the box: this row is the lab against its own journal

// ------------------------------------------------------------------ the grid
// candles { id: [[tMs, o, h, l, c, v], ...] } -> one hourly timeline. A missing hour (nothing traded) keeps
// the last close with no volume; before a coin's first candle and after its last it has no price.
function buildGrid(candles) {
  const ids = Object.keys(candles).filter((id) => candles[id].length);
  if (!ids.length) return { t0: 0, n: 0, coins: {} };
  const t0 = Math.min(...ids.map((id) => candles[id][0][0]));
  const t1 = Math.max(...ids.map((id) => candles[id][candles[id].length - 1][0]));
  const n = Math.round((t1 - t0) / HOUR) + 1;
  const coins = {};
  for (const id of ids) {
    const c = new Float64Array(n).fill(NaN), h = new Float64Array(n).fill(NaN), v = new Float64Array(n);
    const rows = candles[id];
    for (const [t, , hi, , cl, vol] of rows) { const k = Math.round((t - t0) / HOUR); c[k] = cl; h[k] = hi; v[k] = vol; }
    const first = Math.round((rows[0][0] - t0) / HOUR), last = Math.round((rows[rows.length - 1][0] - t0) / HOUR);
    for (let k = first + 1; k <= last; k++) if (!Number.isFinite(c[k])) { c[k] = c[k - 1]; h[k] = c[k - 1]; }
    coins[id] = { c, h, v, first, last };
  }
  return { t0, n, coins };
}

// Coinbase's 24-hour figures as the book would have read them at the close of hour k, for every coin with
// 24 hours of history behind it. Only hours up to k are read.
function statsAt(grid, k) {
  const out = {};
  if (k < 24) return out;
  for (const [id, g] of Object.entries(grid.coins)) {
    if (k > g.last || k - 24 < g.first) continue;
    let high = -Infinity, volume = 0;
    for (let j = k - 23; j <= k; j++) { if (g.h[j] > high) high = g.h[j]; volume += g.v[j]; }
    out[id] = { open: g.c[k - 24], high, last: g.c[k], volume };
  }
  return out;
}

// ------------------------------------------------------------------ the book
function simulate(grid, { from = -Infinity, to = Infinity, feeBps = 95, slipBps = 10, R = books.RUNNER, start = 1000 } = {}) {
  const fee = feeBps / 10000, slip = slipBps / 10000;
  let cash = start, fees = 0, peakValue = start, maxDD = 0, firstK = null, lastK = null;
  const lots = [], trades = [], cool = {}, curve = [];
  const price = (id, k) => { const g = grid.coins[id]; return g && k <= g.last ? g.c[k] : NaN; };
  const lastPrice = (lot, k) => { const g = grid.coins[lot.sym]; return g.c[Math.min(k, g.last)]; };
  const value = (k) => cash + lots.reduce((a, l) => a + l.qty * lastPrice(l, k), 0);
  const sell = (lot, px, k, why) => {
    const gross = lot.qty * px * (1 - slip), f = gross * fee, got = gross - f;
    cash += got; fees += f;
    trades.push({ sym: lot.sym, openedAt: lot.openedAt, closedAt: grid.t0 + (k + 1) * HOUR, cost: lot.cost, pnl: got - lot.cost, why });
    lots.splice(lots.indexOf(lot), 1);
    cool[lot.sym] = grid.t0 + (k + 1) * HOUR;
  };
  for (let k = 25; k < grid.n; k++) {
    const t = grid.t0 + (k + 1) * HOUR;   // the close of hour k: when the scan runs
    if (t < from || t > to) continue;
    if (firstK == null) firstK = k;
    lastK = k;
    const rows = books.runnerScan(statsAt(grid, k), statsPrev(grid, k), R);
    for (const lot of [...lots]) {
      const last = price(lot.sym, k);
      if (!(last > 0)) {   // gone from Coinbase: sold at its last price once the stale clock runs out, as the engine does
        if (t - lot.openedAt >= R.staleHours * HOUR) sell(lot, lastPrice(lot, k), k, 'no longer listed');
        continue;
      }
      lot.peak = Math.max(lot.peak, last);
      const why = books.runnerExit(lot, last, t, R);
      if (why) sell(lot, last, k, why);
    }
    for (const [id, at] of Object.entries(cool)) if (t - at >= R.coolHours * HOUR) delete cool[id];
    for (const r of rows) {
      if (r.why || cool[r.id] || lots.some((l) => l.sym === r.id)) continue;
      if (lots.length >= R.slots) break;
      const spend = Math.min(cash, value(k) / R.slots);
      if (spend < 5) break;
      const px = r.last * (1 + slip), f = spend * fee / (1 + fee);
      cash -= spend; fees += f;
      lots.push({ sym: r.id, qty: (spend - f) / px, cost: spend, entry: px, peak: r.last, openedAt: t });
    }
    const v = value(k);
    peakValue = Math.max(peakValue, v); maxDD = Math.min(maxDD, v / peakValue - 1);
    curve.push([t, v]);
  }
  const end = lastK == null ? start : value(lastK);
  return { start, end, fees, maxDD, trades, open: lots.map((l) => l.sym), curve, from: firstK == null ? null : grid.t0 + (firstK + 1) * HOUR, to: lastK == null ? null : grid.t0 + (lastK + 1) * HOUR };
}
// the prices at the scan an hour before, for "still climbing"
function statsPrev(grid, k) {
  const out = {};
  for (const [id, g] of Object.entries(grid.coins)) if (k - 1 >= g.first && k - 1 <= g.last) out[id] = g.c[k - 1];
  return out;
}

// ------------------------------------------------------------------ the fetch
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function get(url) {
  for (let i = 0; ; i++) {
    let r = null;
    try { r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', connection: 'close' } }); } catch (e) { if (i >= 5) throw e; }
    if (r && r.status === 200) return r.json();
    if (r && r.status === 404) return null;
    if (i >= 5) throw new Error(`HTTP ${r ? r.status : 'no answer'}: ${url}`);
    await sleep(1000 * 2 ** i);
  }
}
async function candles(id, gran, startMs, endMs) {
  const out = new Map();
  for (let s = startMs; s < endMs;) {
    const e = Math.min(endMs, s + 300 * gran * 1000);
    const rows = await get(`https://api.exchange.coinbase.com/products/${id}/candles?granularity=${gran}&start=${new Date(s).toISOString()}&end=${new Date(e).toISOString()}`);
    for (const [t, l, h, o, c, v] of rows || []) if ((t + gran) * 1000 <= Date.now()) out.set(t, [t * 1000, o, h, l, c, v]);
    s = e;
    await sleep(200);
  }
  return [...out.values()].sort((a, b) => a[0] - b[0]);
}
async function fetchAll(from) {
  fs.mkdirSync(DIR, { recursive: true });
  const listed = new Set(((await get('https://api.exchange.coinbase.com/products')) || []).map((p) => p.id));
  const ids = [...books.RUNNER_COINS].map((c) => `${c}-USD`).filter((id) => listed.has(id)).sort();
  console.log(`${ids.length} of ${books.RUNNER_COINS.size} RUNNER_COINS have a Coinbase USD market`);
  const now = Math.floor(Date.now() / HOUR) * HOUR;
  for (const id of ids) {
    const file = path.join(DIR, `${id}.json`);
    let have = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
    let start = have.length ? have[have.length - 1][0] + HOUR : null;
    if (start == null) {
      // the first day it traded, from daily candles (a handful of requests), so the hourly pass skips years of nothing
      const days = await candles(id, 86400, from, now);
      if (!days.length) { console.log(`${id}: no candles`); continue; }
      start = days[0][0];
    }
    const add = await candles(id, 3600, start, now);
    have = have.concat(add.filter((r) => !have.length || r[0] > have[have.length - 1][0]));
    fs.writeFileSync(file, JSON.stringify(have));
    console.log(`${id}: ${have.length} hours, ${new Date(have[0][0]).toISOString().slice(0, 13)} to ${new Date(have[have.length - 1][0]).toISOString().slice(0, 13)} (+${add.length})`);
  }
}

// ------------------------------------------------------------------ the table
const day = (t) => new Date(t).toISOString().slice(0, 10);
const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(0)}`;
const pct = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
function line(name, r) {
  const won = r.trades.filter((x) => x.pnl > 0).length, med = median(r.trades.map((x) => x.pnl));
  return `${name.padEnd(38)} ${usd(r.start).padStart(6)} -> ${usd(r.end).padStart(7)} ${pct(r.end / r.start - 1).padStart(8)}  ${String(r.trades.length).padStart(4)} trades, ${String(won).padStart(3)} won, median ${usd(med).padStart(4)}  fees ${usd(r.fees).padStart(5)}  worst drop ${pct(r.maxDD)}`;
}
function load() {
  if (!fs.existsSync(DIR)) return null;
  const files = fs.readdirSync(DIR).filter((f) => f.endsWith('.json'));
  if (!files.length) return null;
  return buildGrid(Object.fromEntries(files.map((f) => [f.slice(0, -5), JSON.parse(fs.readFileSync(path.join(DIR, f), 'utf8'))])));
}
function table({ from, slipBps }) {
  const grid = load();
  if (!grid) { console.log('no candles yet: run node tools/runner-lab.js --fetch'); return 1; }
  const base = { slipBps };
  const all = simulate(grid, { ...base, from });
  console.log(`runner lab · ${Object.keys(grid.coins).length} coins · ${day(all.from)} to ${day(all.to)} · hourly scans · 0.95% a side + ${slipBps / 100}% slip · $1,000 each row`);
  console.log(`\nTHE RULE AS SHIPPED`);
  console.log(line('whole span', all));
  console.log(line(`before ${day(FIT_FROM)} (out of sample)`, simulate(grid, { ...base, from, to: FIT_FROM })));
  console.log(line(`${day(FIT_FROM)} to ${day(LIVE_FROM)} (its check)`, simulate(grid, { ...base, from: FIT_FROM, to: LIVE_FROM })));
  console.log(line(`from ${day(LIVE_FROM)} (the live book)`, simulate(grid, { ...base, from: LIVE_FROM })));
  console.log(`\nEACH QUARTER, a fresh $1,000`);
  const q0 = new Date(all.from), qs = [];
  for (let y = q0.getUTCFullYear(), m = Math.floor(q0.getUTCMonth() / 3) * 3; Date.UTC(y, m) < all.to; m += 3) {
    if (m >= 12) { y++; m -= 12; }
    qs.push([Date.UTC(y, m), Date.UTC(y, m + 3)]);
  }
  let up = 0;
  for (const [a, b] of qs) { const r = simulate(grid, { ...base, from: Math.max(a, from), to: b }); if (r.end > r.start) up++; console.log(line(`${new Date(a).getUTCFullYear()} Q${new Date(a).getUTCMonth() / 3 + 1}`, r)); }
  console.log(`${up} of ${qs.length} quarters ended above $1,000`);
  console.log(`\nTHE SAME SPAN, ONE SETTING CHANGED (to read, not to pick: a setting chosen on this table is fitted to it)`);
  const R = books.RUNNER;
  for (const [name, o] of [
    ['trail 5%', { R: { ...R, trail: 0.05 } }], ['trail 15%', { R: { ...R, trail: 0.15 } }], ['trail 20%', { R: { ...R, trail: 0.20 } }],
    ['up 15%+ in 24h', { R: { ...R, minMove: 0.15 } }], ['up 25%+ in 24h', { R: { ...R, minMove: 0.25 } }],
    ['$10M+ traded', { R: { ...R, minVolUsd: 10e6 } }],
    ["Coinbase's 0.40% fee", { feeBps: 40 }], ['no fee, no slip', { feeBps: 0, slipBps: 0 }],
  ]) console.log(line(name, simulate(grid, { ...base, from, ...o })));
  const byCoin = {};
  for (const x of all.trades) (byCoin[x.sym] = byCoin[x.sym] || []).push(x.pnl);
  const ranked = Object.entries(byCoin).map(([id, p]) => [id, p.reduce((a, b) => a + b, 0), p.length]).sort((a, b) => b[1] - a[1]);
  console.log(`\nWHERE IT CAME FROM (whole span): best ${ranked.slice(0, 5).map(([id, s, n]) => `${id.slice(0, -4)} ${usd(s)}/${n}`).join(', ')} · worst ${ranked.slice(-5).reverse().map(([id, s, n]) => `${id.slice(0, -4)} ${usd(s)}/${n}`).join(', ')}`);
  const whys = {};
  for (const x of all.trades) { const w = x.why.replace(/\d+(\.\d+)?%/, '#%'); whys[w] = (whys[w] || 0) + 1; }
  console.log(`exits: ${Object.entries(whys).map(([w, n]) => `${n} ${w}`).join(' · ')}${all.open.length ? ` · still holding ${all.open.join(', ')}` : ''}`);
  return 0;
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const from = Date.parse(`${arg('--from', '2022-01-01')}T00:00:00Z`);
  if (argv.includes('--fetch')) { await fetchAll(from); return 0; }
  return table({ from, slipBps: +arg('--slip', 10) });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { buildGrid, statsAt, simulate, HOUR };

'use strict';
// The SPY lab: do the scalp, dip and options books' rules (src/desk/books.js, SCALP, DIP and ZERO) make money over
// two years of SPY's minutes, not the handful of days each has traded on the box?
//
//   node tools/spy-lab.js --fetch          SPY one-minute bars from Massive (formerly Polygon.io), two years
//                                          -> data/stocks/minutes/SPY.json (needs MASSIVE_API_KEY in .env;
//                                          the free plan's five calls a minute: a few minutes; again to extend)
//   node tools/spy-lab.js                  both books, every day on file
//   node tools/spy-lab.js --iv 1.0 --from 2025-01-01
//
// RESEARCH ONLY. It reads Massive's SPY bars and the desk's own journals. No order, no broker.
//
// SPY: the books' own code decides. Each day's regular-session minutes are labelled by the minute they end,
// as Cboe's are (feeds.parseCboeIntraday), five-minute bars come from feeds.fiveMinute, VWAP from
// feeds.vwapSeries and ATR14 from feeds.atr14 on the session's own daily bars; books.scalpTrigger,
// scalpGate, scalpExit, dipTrigger and dipExit are called as the engine calls them, one bar at a time.
// A day that ends before 3:15 (a 1 PM close) is skipped, as both books skip it.
// OPTIONS: SPY's option prices for past days are not free, so they are MODELLED. Black-Scholes, no rate,
// time left in trading minutes to 4:00, volatility the last 20 sessions' realised volatility times --iv
// (default 1.2: same-day implied volatility usually sits over realised), at least 8%; a dollar strike
// grid, a cent each side of the model's price under $1 and two cents above (SPY's same-day options
// are about that wide), and the desk's $0.03 a contract each way. books.pickScalp and books.pickDip pick
// from that grid. A 1.5x target fills if the modelled bid reaches it at the bar's high (low, for a put).
// The model is checked against every real fill the box has journaled: the table prints model ask against
// the real ask at the same moment. Read the option results through that line.
// SPY ALONE: beside the option P&L, each trade's SPY move in its direction from the trigger's close to its
// exit. If SPY does not move the trade's way after the trigger, no option bought on it can pay.
// Not modelled: the Fed's 2 PM decisions before 2026-10-28 (books.FED lists only the rest of 2026), the
// chain-skew check, the daily loss limit across books.
//
// WHAT IT FOUND (2026-10-08, 475 sessions 2024-10-08 to 2026-10-07, --iv 0.64 fitted to the box's 22 real buys, the
// model's ask then 0.99 of the real one): the lab takes the box's own trades (same minutes and strikes on 09-30, 10-02,
// 10-06, 10-07). Scalps: 1,380 trades, -$2 a trade, SPY 0.00 points the trade's way: no edge; the option P&L's sign
// follows the option model (+$1 a trade at --iv 0.48, -$2 at 0.8). Dips: 150 trades, +$2 a trade, median -$15, SPY
// -0.16 points its way, +$6 to -$6 a trade across the model: not proven either way. README, "Scalps and dips".
// Options (trend days, added the same day): the 12:30 test passed 102 of 475 days; 69 trades, -$5 a trade, median -$16,
// SPY -0.02 points its way; +$2 to -$6 across the model. No edge. It takes the box's one trade (10-05 12:36). README, "Options".
const fs = require('fs');
const path = require('path');
const books = require('../src/desk/books');
const feeds = require('../src/desk/feeds');
const clock = require('../src/desk/clock');

const DIR = path.join(__dirname, '..', 'data', 'stocks', 'minutes');
const FILE = path.join(DIR, 'SPY.json');
const JOURNALS = [path.join(__dirname, '..', 'data', 'fly', 'archive', 'desk'), path.join(__dirname, '..', 'data', 'fly', 'desk-now')];
const FEE = 0.03;          // the desk's per-contract fee, each way (DESK_OPTION_FEE)
const MIN_YEAR = 252 * 390;

// ------------------------------------------------------------------ the sessions
// rows [[tMs (the minute's START, as Massive gives it), o, h, l, c, v], ...] -> [{ day, bars }] with bars
// labelled by their END minute (9:30-9:31 is m = 571), regular session only, and the session's daily bar.
function sessions(rows) {
  const by = new Map();
  for (const [t, o, h, l, c, v] of rows) {
    const e = clock.et(t), m = e.min + 1;
    if (m < 9 * 60 + 31 || m > 16 * 60) continue;
    let s = by.get(e.day);
    if (!s) by.set(e.day, (s = []));
    s.push({ m, t: t + 60000, o, h, l, c, v });
  }
  const out = [];
  for (const [day, bars] of [...by.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    bars.sort((a, b) => a.m - b.m);
    out.push({ day, bars, daily: { day, o: bars[0].o, h: Math.max(...bars.map((b) => b.h)), l: Math.min(...bars.map((b) => b.l)), c: bars[bars.length - 1].c } });
  }
  return out;
}

// ------------------------------------------------------------------ the option model
const ncdf = (x) => {   // Abramowitz-Stegun 7.1.26, |error| < 7.5e-8
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2, t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
};
// Black-Scholes, no rate: { px, delta } of a call (right 'C') or put with `minLeft` trading minutes to go
function bs(S, K, minLeft, vol, right) {
  const T = Math.max(1, minLeft) / MIN_YEAR, sd = vol * Math.sqrt(T);
  const d1 = (Math.log(S / K) + sd * sd / 2) / sd, d2 = d1 - sd;
  if (right === 'C') return { px: S * ncdf(d1) - K * ncdf(d2), delta: ncdf(d1) };
  return { px: K * ncdf(-d2) - S * ncdf(-d1), delta: ncdf(d1) - 1 };
}
const cents = (x) => Math.round(x * 100) / 100;
function quote(S, K, m, vol, right) {
  const { px, delta } = bs(S, K, 16 * 60 - m, vol, right);
  const half = px < 1 ? 0.01 : 0.02;
  return { strike: K, right, mid: px, bid: Math.max(0, cents(px - half)), ask: cents(Math.max(px + half, 0.01)), delta };
}
// a dollar grid either side of SPY, as the books' chain rows: { strike, bid, ask, delta }
function chain(S, m, vol, right) {
  const rows = [], k0 = Math.round(S);
  for (let k = k0 - 15; k <= k0 + 15; k++) rows.push(quote(S, k, m, vol, right));
  return rows;
}
// the day's volatility: the last 20 sessions' realised, times `ivMult`, at least 2%
function dayVol(dailies, idx, ivMult) {
  if (idx < 21) return null;
  const closes = dailies.slice(idx - 21, idx).map((d) => d.c);
  const rets = closes.slice(1).map((c, i) => Math.log(c / closes[i]));
  const mu = rets.reduce((a, x) => a + x, 0) / rets.length;
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - mu) ** 2, 0) / (rets.length - 1));
  return Math.max(0.02, sd * Math.sqrt(252) * ivMult);
}
// The volatility a real ask implies under this model (the model's ask equal to it), by halving; null if none fits.
function impliedVol(S, K, m, right, ask) {
  let lo = 0.005, hi = 2;
  if (quote(S, K, m, lo, right).ask > ask || quote(S, K, m, hi, right).ask < ask) return null;
  for (let i = 0; i < 60; i++) { const mid = (lo + hi) / 2; if (quote(S, K, m, mid, right).mid + (quote(S, K, m, mid, right).mid < 1 ? 0.01 : 0.02) < ask) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}
// The box's real buys: each one's SPY, strike, right, minute (its bar's close) and ask, with the session index.
function realBuys(fills, sess) {
  const byDay = new Map(sess.map((s, i) => [s.day, i])), out = [];
  for (const f of fills) {
    if (f.side !== 'buy' || !(f.spy > 0) || !(f.ask > 0)) continue;
    const e = clock.et(Date.parse(f.barAt || f.t)), idx = byDay.get(e.day);
    if (idx == null) continue;
    out.push({ f, idx, S: f.spy, K: +f.sym.slice(-8) / 1000, right: /C\d{8}$/.test(f.sym) ? 'C' : 'P', m: e.min, ask: f.ask });
  }
  return out;
}
// --iv from the box's own fills: the median of each fill's implied volatility over that day's realised (times 1)
function calibrate(buys, dailies) {
  const r = buys.map((b) => { const iv = impliedVol(b.S, b.K, b.m, b.right, b.ask), rv = dayVol(dailies, b.idx, 1); return iv && rv ? iv / rv : null; }).filter((x) => x != null);
  return r.length ? +median(r).toFixed(2) : null;
}

// ------------------------------------------------------------------ the scalp book, one day
function scalpDay(day, bars1, vol, R = books.SCALP) {
  const bars = feeds.fiveMinute(bars1), vw = feeds.vwapSeries(bars);
  const d = { entries: 0, lossRun: 0, pauseUntil: null, done: false };
  const trades = [];
  let lot = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = bars[i], close = bar.m + 5;
    if (lot) {
      const ext = lot.dir === 'up' ? bar.h : bar.l;
      const row = quote(bar.c, lot.strike, close, vol, lot.right);
      row.high = quote(ext, lot.strike, close, vol, lot.right).bid;
      const ex = books.scalpExit(lot, [bar], bar, row, R);
      if (ex) {
        const px = ex.kind === 'target' ? lot.target : row.bid;
        const pnl = (px - lot.entry) * 100 - 2 * FEE;
        trades.push({ day, book: 'scalps', m: lot.barM + 5, out: close, dir: lot.dir, strike: lot.strike, entry: lot.entry, exit: px, kind: ex.kind, pnl, spy: (lot.dir === 'up' ? 1 : -1) * (bar.c - lot.spy) });
        if (pnl < 0) { d.lossRun++; d.pauseUntil = close + R.pause; } else d.lossRun = 0;
        if (d.lossRun >= R.maxLossRun || d.entries >= R.maxTrades) d.done = true;
        lot = null;
      }
    }
    if (lot || d.done) continue;
    if (bar.m > R.lastBar) { d.done = true; continue; }
    const hit = books.scalpTrigger(bars, vw, i, R);
    if (!hit || books.scalpGate(d, day, hit.m, R)) continue;
    const right = hit.dir === 'up' ? 'C' : 'P';
    const pick = books.pickScalp(chain(bar.c, close, vol, right), hit.dir, hit.m, R);
    if (!pick.row) continue;
    const row = pick.row;
    lot = { dir: hit.dir, level: hit.level, barM: hit.m, entry: row.ask, target: Math.round(row.ask * R.target * 1e4) / 1e4, high0: 0, strike: row.strike, right, spy: bar.c };
    d.entries++;
  }
  if (lot) {   // never past 3:15 on a full day, but a short file could leave one: worth what SPY says at the last bar
    const last = bars[bars.length - 1], val = Math.max(0, lot.right === 'C' ? last.c - lot.strike : lot.strike - last.c);
    trades.push({ day, book: 'scalps', m: lot.barM + 5, out: last.m + 5, dir: lot.dir, strike: lot.strike, entry: lot.entry, exit: val, kind: 'settle', pnl: (val - lot.entry) * 100 - FEE, spy: (lot.dir === 'up' ? 1 : -1) * (last.c - lot.spy) });
  }
  return trades;
}

// ------------------------------------------------------------------ the dip book, one day
function dipDay(day, bars, atr, vol, R = books.DIP) {
  const trades = [];
  if (!(atr > 0) || !bars.length || bars[0].m !== R.open) return trades;
  const vw = feeds.vwapSeries(bars);
  let lots = [], entries = 0, done = false, chainM = null, trade = null;
  for (let i = 0; i < bars.length; i++) {
    const bar = { ...bars[i], vw: vw[i] };
    if (lots.length) {
      const spyOnly = lots.map((l) => books.dipExit(l, [bar], bar, null, R));
      const trailDue = lots.some((l, k) => l.role === 'runner' && spyOnly[k].reclaimM != null) && (chainM == null || bar.m - chainM >= R.trailEvery);
      if (!spyOnly.some((v) => v.exit) && !trailDue) {
        lots.forEach((l, k) => { if (l.reclaimM == null && spyOnly[k].reclaimM != null) l.reclaimM = spyOnly[k].reclaimM; });
      } else {
        const row = quote(bar.c, lots[0].strike, bar.m, vol, 'C');
        chainM = bar.m;
        for (const lot of [...lots]) {
          const { exit, reclaimM } = books.dipExit(lot, [bar], bar, row, R);
          lot.peak = Math.max(lot.peak ?? lot.entry, row.bid);
          if (reclaimM != null) for (const l of lots) if (l.reclaimM == null) l.reclaimM = reclaimM;
          if (!exit) continue;
          trade.pnl += (row.bid - lot.entry) * 100 - 2 * FEE;
          trade.exits.push(`${exit.kind} ${clockTxt(bar.m)} ${row.bid.toFixed(2)}`);
          lots = lots.filter((l) => l !== lot);
        }
        if (!lots.length) {
          trade.spy = bar.c - trade.spyIn;
          trades.push(trade);
          if (trade.pnl < 0 || entries >= R.maxTrades) done = true;
          trade = null;
        }
      }
    }
    if (lots.length || done) continue;
    if (bar.m > R.lastClose) { done = true; continue; }
    if (bar.m < R.firstClose) continue;
    const hit = books.dipTrigger(bars, vw, i, atr, R);
    if (!hit) continue;
    const pick = books.pickDip(chain(bar.c, bar.m, vol, 'C'), bar.c, R);
    if (!pick.row) continue;
    const row = pick.row;
    const base = { strike: row.strike, entry: row.ask, stop: hit.stop, spy: hit.c, barM: hit.m, reclaimM: null, peak: row.ask };
    lots = [{ ...base, role: 'first' }, { ...base, role: 'runner' }];
    trade = { day, book: 'dips', m: hit.m, strike: row.strike, entry: row.ask, pnl: 0, exits: [], spyIn: bar.c };
    entries++; chainM = bar.m;
  }
  if (lots.length) {
    const last = bars[bars.length - 1], val = Math.max(0, last.c - lots[0].strike);
    for (const lot of lots) trade.pnl += (val - lot.entry) * 100 - FEE;
    trade.exits.push('settle'); trade.spy = last.c - trade.spyIn; trades.push(trade);
  }
  return trades;
}
// ------------------------------------------------------------------ the options book (trend days), one day
// The engine's optionsBook and optionExits: the 12:30 test, then the first new high (low) on the trend side of
// VWAP to 2:45, books.pickContract's strike and size, 2x / 3x resting targets, out on a close back through VWAP
// or at 3:15, and one re-entry (one contract) only after the first trade's first exit hit its target.
function optionsDay(day, bars, atr, vol, R = books.ZERO) {
  const out = { verdict: null, trades: [] };
  const vw = feeds.vwapSeries(bars);
  const r = books.trendTest(bars, vw, atr, R);
  out.verdict = r.status === 'pass' ? `pass ${r.dir}` : r.status;
  if (r.status !== 'pass') return out;
  const dir = r.dir, right = dir === 'up' ? 'C' : 'P', sgn = dir === 'up' ? 1 : -1;
  const d = { entries: 0, firstTrade: null, firstExitHit: null, scanIdx: r.idx, ext: r.ext, flatAtIdx: null, done: false };
  let lots = [], trade = null;
  for (let i = r.idx + 1; i < bars.length; i++) {
    const bar = bars[i];
    if (lots.length) {
      const ext = dir === 'up' ? bar.h : bar.l;
      const sell = (lot, px, why) => {
        trade.pnl += (px - lot.entry) * 100 - 2 * FEE; trade.exits.push(`${why} ${clockTxt(bar.m)} ${px.toFixed(2)}`);
        if (d.firstExitHit == null && lot.trade === d.firstTrade) d.firstExitHit = why === 'target';
        lots = lots.filter((l) => l !== lot);
      };
      for (const lot of [...lots]) {
        const row = quote(bar.c, lot.strike, bar.m, vol, right);
        row.high = quote(ext, lot.strike, bar.m, vol, right).bid;
        if (books.targetHit(lot, row)) sell(lot, lot.target, 'target');
      }
      if (lots.length && (books.vwapBreak(bar, vw[i], dir) || bar.m >= R.clock)) {
        const row = quote(bar.c, lots[0].strike, bar.m, vol, right), why = bar.m >= R.clock && !books.vwapBreak(bar, vw[i], dir) ? 'clock' : 'vwap';
        for (const lot of [...lots]) sell(lot, row.bid, why);
      }
      if (!lots.length) { trade.spy = sgn * (bar.c - trade.spyIn); out.trades.push(trade); trade = null; d.flatAtIdx = i; }
      continue;
    }
    if (d.done) continue;
    const canEnter = d.entries === 0 || (d.entries === 1 && d.firstExitHit === true);
    if (!canEnter) { d.done = true; continue; }
    if (d.entries === 1 && d.flatAtIdx != null && d.scanIdx < d.flatAtIdx) {
      const upto = bars.slice(0, d.flatAtIdx + 1);
      d.ext = dir === 'up' ? Math.max(...upto.map((b) => b.h)) : Math.min(...upto.map((b) => b.l));
      d.scanIdx = d.flatAtIdx;
    }
    if (bar.m > R.lastEntry) { d.done = true; continue; }
    const sc = books.scanEntry(bars.slice(0, i + 1), vw, dir, d.scanIdx, d.ext, R);
    d.scanIdx = sc.scanned; d.ext = sc.ext;
    if (!sc.hit) continue;
    const hb = bars[sc.hit.idx];
    d.ext = dir === 'up' ? Math.max(d.ext, hb.h) : Math.min(d.ext, hb.l);
    const pick = books.pickContract(chain(bar.c, bar.m, vol, right), bar.c, dir, R);
    if (!pick.row) continue;
    const qty = d.entries === 1 ? 1 : pick.qty, id = `${day}-${d.entries + 1}`;
    const plan = qty >= 2 ? [['first', R.firstTarget], ['runner', R.runnerTarget]] : [['runner', R.runnerTarget]];
    lots = plan.map(([role, mult]) => ({ role, trade: id, strike: pick.row.strike, entry: pick.row.ask, target: Math.round(pick.row.ask * mult * 1e4) / 1e4, high0: 0 }));
    if (!d.firstTrade) d.firstTrade = id;
    d.entries++;
    trade = { day, book: 'options', m: bar.m, dir, strike: pick.row.strike, entry: pick.row.ask, qty, pnl: 0, exits: [], spyIn: bar.c };
  }
  if (lots.length) {
    const last = bars[bars.length - 1], val = Math.max(0, sgn * (last.c - lots[0].strike));
    for (const lot of lots) trade.pnl += (val - lot.entry) * 100 - FEE;
    trade.exits.push('settle'); trade.spy = sgn * (last.c - trade.spyIn); out.trades.push(trade);
  }
  return out;
}
const clockTxt = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

// ------------------------------------------------------------------ every day
function run(sess, { from = '', to = '9999', ivMult = 1.2 } = {}) {
  const dailies = sess.map((s) => s.daily);
  const scalps = [], dips = [], options = [], verdicts = {};
  let days = 0;
  sess.forEach((s, idx) => {
    if (s.day < from || s.day >= to) return;
    const last = s.bars[s.bars.length - 1];
    if (!last || last.m < 15 * 60 + 15 || s.bars.length < 300) return;   // a 1 PM close, or a short file
    const vol = dayVol(dailies, idx, ivMult), atr = feeds.atr14(dailies, s.day);
    if (vol == null || !atr) return;
    days++;
    scalps.push(...scalpDay(s.day, s.bars, vol));
    dips.push(...dipDay(s.day, s.bars, atr.atr, vol));
    const od = optionsDay(s.day, s.bars, atr.atr, vol);
    verdicts[od.verdict] = (verdicts[od.verdict] || 0) + 1;
    options.push(...od.trades);
  });
  return { days, scalps, dips, options, verdicts };
}

// ------------------------------------------------------------------ the box's own fills, to check against
function journalFills() {
  const out = [], seen = new Set();
  for (const dir of JOURNALS) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^journal-.*\.jsonl$/.test(x)).sort()) {
      for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!line.includes('"FILL"') || !/"book":"(scalps|dips|options)"/.test(line)) continue;
        let j; try { j = JSON.parse(line); } catch { continue; }
        const key = `${j.t}|${j.sym}|${j.side}`;
        if (seen.has(key)) continue;
        seen.add(key); out.push(j);
      }
    }
  }
  return out.sort((a, b) => (a.t < b.t ? -1 : 1));
}

// ------------------------------------------------------------------ the fetch
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
async function fetchAll(key, fromDay) {
  fs.mkdirSync(DIR, { recursive: true });
  let have = fs.existsSync(FILE) ? JSON.parse(fs.readFileSync(FILE, 'utf8')) : [];
  const start = have.length ? new Date(have[have.length - 1][0] + 86400000).toISOString().slice(0, 10) : fromDay;
  const end = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  if (start > end) { console.log(`SPY.json is up to date (${have.length} minutes)`); return; }
  let url = `https://api.massive.com/v2/aggs/ticker/SPY/range/1/minute/${start}/${end}?adjusted=true&sort=asc&limit=50000`;
  const add = [];
  for (let calls = 0; url; calls++) {
    if (calls) await sleep(13000);   // the free plan: five calls a minute
    let r = null;
    for (let i = 0; i < 6; i++) {
      r = await fetch(url, { headers: { authorization: `Bearer ${key}` } });
      if (r.status !== 429) break;
      await sleep(60000);
    }
    if (r.status === 401 || r.status === 403) throw new Error(`Massive refused the key (HTTP ${r.status}): check MASSIVE_API_KEY in .env`);
    if (r.status !== 200) throw new Error(`Massive answered HTTP ${r.status}`);
    const j = await r.json();
    for (const b of j.results || []) add.push([b.t, b.o, b.h, b.l, b.c, b.v]);
    console.log(`  ${add.length} minutes so far${add.length ? `, to ${clock.et(add[add.length - 1][0]).day}` : ''}`);
    url = j.next_url || null;
  }
  // regular session only (9:30-4:00 ET): the books never read the rest
  const keep = add.filter(([t]) => { const m = clock.et(t).min; return m >= 9 * 60 + 30 && m < 16 * 60; });
  const last = have.length ? have[have.length - 1][0] : -Infinity;
  have = have.concat(keep.filter(([t]) => t > last));
  fs.writeFileSync(FILE, JSON.stringify(have));
  console.log(`SPY.json: ${have.length} minutes, ${clock.et(have[0][0]).day} to ${clock.et(have[have.length - 1][0]).day}`);
}

// ------------------------------------------------------------------ the table
const usd = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(0)}`;
const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : NaN; };
function summary(name, ts) {
  if (!ts.length) return `${name.padEnd(30)} no trades`;
  const p = ts.map((x) => x.pnl), sum = p.reduce((a, b) => a + b, 0), mean = sum / p.length;
  const sd = Math.sqrt(p.reduce((a, x) => a + (x - mean) ** 2, 0) / Math.max(1, p.length - 1));
  const lo = mean - 1.96 * sd / Math.sqrt(p.length);
  const spy = ts.map((x) => x.spy).filter(Number.isFinite);
  return `${name.padEnd(30)} ${String(ts.length).padStart(4)} trades  ${String(p.filter((x) => x > 0).length).padStart(4)} won  total ${usd(sum).padStart(7)}  a trade ${usd(mean).padStart(4)} (95% low ${usd(lo)})  median ${usd(median(p)).padStart(4)}  SPY its way ${(spy.reduce((a, b) => a + b, 0) / (spy.length || 1)).toFixed(2)} pts`;
}
function table({ from, ivMult: asked }) {
  if (!fs.existsSync(FILE)) { console.log('no SPY minutes yet: put MASSIVE_API_KEY in .env, then node tools/spy-lab.js --fetch'); return 1; }
  const sess = sessions(JSON.parse(fs.readFileSync(FILE, 'utf8')));
  const fills = journalFills(), byDay = new Map(sess.map((s, i) => [s.day, i])), dailies = sess.map((s) => s.daily);
  const buys = realBuys(fills, sess).filter((b) => dayVol(dailies, b.idx, 1) != null);
  const fitted = calibrate(buys, dailies);
  const ivMult = asked != null ? asked : fitted != null ? fitted : 1.2;
  const r = run(sess, { from, ivMult });
  console.log(`spy lab · ${r.days} full sessions ${sess[0].day} to ${sess[sess.length - 1].day} (from ${from || 'the 21st'}) · modelled options at --iv ${ivMult}${asked == null && fitted != null ? ' (fitted to the box\'s real buys)' : ''} · $0.03 a contract each way`);
  if (buys.length) {
    const ratio = buys.map((b) => quote(b.S, b.K, b.m, dayVol(dailies, b.idx, ivMult), b.right).ask / b.ask);
    console.log(`\nTHE MODEL AGAINST THE BOX'S ${buys.length} REAL BUYS (same SPY, strike, minute): model ask / real ask, median ${median(ratio).toFixed(2)}, from ${Math.min(...ratio).toFixed(2)} to ${Math.max(...ratio).toFixed(2)}${fitted != null ? ` · the fit: --iv ${fitted}` : ''}`);
  } else console.log("\nno journaled buys inside the minutes on file to check the model against (they start 2026-09-29; fetch to yesterday)");
  // the lab's trades on the days the box traded, side by side
  const boxDays = [...new Set(fills.map((f) => clock.et(Date.parse(f.t)).day))].filter((d) => byDay.has(d));
  if (boxDays.length) {
    console.log('\nTHE SAME DAYS, LAB AGAINST BOX (buys: time, strike)');
    for (const day of boxDays) {
      // barAt is the close of the bar the rule acted on, for both books: the lab prints the same
      const box = fills.filter((f) => f.side === 'buy' && clock.et(Date.parse(f.t)).day === day).map((f) => `${f.book} ${clockTxt(clock.et(Date.parse(f.barAt)).min)} ${+f.sym.slice(-8) / 1000}${/C\d{8}$/.test(f.sym) ? 'C' : 'P'}`);
      const lab = run(sess, { from: day, to: day + 'z', ivMult });
      const labs = [...lab.scalps.map((x) => `scalps ${clockTxt(x.m)} ${x.strike}${x.dir === 'up' ? 'C' : 'P'}`), ...lab.dips.map((x) => `dips ${clockTxt(x.m)} ${x.strike}C`),
        ...lab.options.map((x) => `options ${clockTxt(x.m)} ${x.strike}${x.dir === 'up' ? 'C' : 'P'} x${x.qty}`)];
      console.log(`  ${day}  box: ${box.join(', ') || '-'}\n              lab: ${labs.join(', ') || '-'}`);
    }
  }
  console.log('\nTHE RULES AS SHIPPED');
  console.log(summary('scalps', r.scalps));
  console.log(summary('dips (both calls, one trade)', r.dips));
  console.log(summary('options (trend days)', r.options));
  console.log(`  the 12:30 test: ${Object.entries(r.verdicts).sort().map(([k, n]) => `${n} ${k}`).join(' · ')}`);
  console.log('\nEACH YEAR');
  for (const y of [...new Set([...r.scalps, ...r.dips].map((x) => x.day.slice(0, 4)))].sort()) {
    console.log(summary(`scalps ${y}`, r.scalps.filter((x) => x.day.startsWith(y))));
    console.log(summary(`dips ${y}`, r.dips.filter((x) => x.day.startsWith(y))));
    console.log(summary(`options ${y}`, r.options.filter((x) => x.day.startsWith(y))));
  }
  const kinds = {};
  for (const x of r.scalps) kinds[x.kind] = (kinds[x.kind] || 0) + 1;
  console.log(`\nscalp exits: ${Object.entries(kinds).map(([k, n]) => `${n} ${k}`).join(' · ')}`);
  console.log('\nTHE OPTION MODEL MOVED (the SPY column does not move: it is the rule\'s own evidence)');
  for (const iv of [+(ivMult * 0.75).toFixed(2), +(ivMult * 1.25).toFixed(2)]) {
    const x = run(sess, { from, ivMult: iv });
    console.log(summary(`scalps at --iv ${iv}`, x.scalps));
    console.log(summary(`dips at --iv ${iv}`, x.dips));
    console.log(summary(`options at --iv ${iv}`, x.options));
  }
  return 0;
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--fetch')) {
    require('../src/env').loadEnv(path.join(__dirname, '..', '.env'));
    const key = process.env.MASSIVE_API_KEY;
    if (!key) { console.error('MASSIVE_API_KEY is not set in .env: nothing fetched'); return 2; }
    await fetchAll(key, arg('--from', new Date(Date.now() - 730 * 86400000).toISOString().slice(0, 10)));
    return 0;
  }
  return table({ from: arg('--from', ''), ivMult: arg('--iv', null) == null ? null : +arg('--iv') });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { sessions, bs, quote, chain, dayVol, impliedVol, calibrate, scalpDay, dipDay, optionsDay, run };

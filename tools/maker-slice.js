'use strict';
// Where does the maker's money go? tools/fillcheck.js marks every fill the desk took against the
// recorded mid 5/30/120 minutes later and prints one number per bucket. This cuts the desk's OWN
// fills finer, on the same replay: by market, side, run-over or not, price band, series family and
// hour, all marked at 30 minutes. And it scores one candidate rail on them, "stand aside when the
// mid moved X cents in the last K minutes", as kept-vs-refused marks. (A refused fill is only taken
// out; that later fills would sit elsewhere in the queue is ignored, so this is a first cut, not a
// replay. Read the direction, not the second decimal.)
//
//   node tools/maker-slice.js --day 2026-09-22              one ET day from data/fly/archive
//   node tools/maker-slice.js --day 2026-09-22 --standaside  ...plus the stand-aside grid
//   node tools/maker-slice.js --day 2026-09-22 --signals     ...plus the book-lean and flow-direction grids
//   node tools/maker-slice.js --day 2026-09-22 --fair        ...plus the fills on paired markets, with or against Polymarket's mid
//   node tools/maker-slice.js --day 2026-09-21 --no-tennis   leave out the live-match markets (KXWTA/KXATP/KXITF/KXDAVISCUP)
//
// What four days said (2026-09-19 → 09-22, 30-minute marks, the desk's own fills, per contract):
//   run-over fills (the print traded through the quote)  -1.1c to -2.0c   every day, 53-68% of contracts
//   in-rate fills                                          -0.35c to +0.6c  flat: the half-spread and the drift cancel
//   live tennis (09-20, 09-21 only; PR #98 stopped it)     -17c to -71c on the worst markets, +72c on the best: coin flips
//   stand aside on a moved mid (K=10m, X=1c)               takes $24 / $73 / $24 off 09-19/20/21 and nothing off 09-22;
//                                                          the kept fills still mark -0.5c to -0.7c
//   book lean (refuse when our side of the touch is thin)   halves the volume; the kept fills still mark -0.2c to -2.0c,
//                                                          and on 09-20 the kept fills are the WORSE half
//   flow direction (refuse after one-way taker flow at us)  backwards: the fills it refuses mark better than the kept
//   with or against Polymarket (paired markets only)      with: about -0.05c pooled, against: about -0.43c; the sign
//                                                          held every day at two hours. The fair rail (maker.fairSide)
//                                                          rests only the side that agrees with Polymarket
//   curated series vs the crawl-widened universe          widened -0.66c to -1.82c, curated -0.34c to -0.64c, every
//                                                          day; widened was two thirds of the contracts (MAKER_WIDEN off)
// So the loss is not one market, one hour or one side, and neither the book nor the flow announces
// the sweep in time; it is the sweep itself. The one signal that sorts the fills is Polymarket's price
// for the same event, and that only reaches the paired markets. Nothing here makes the book positive.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { makeFillCheck, journalFills, HORIZONS } = require('./fillcheck');

const TENNIS = /^KX(WTA|ATP|ITF|DAVISCUP)/;
const H = 30;

function slices(res, own, out = console.log) {
  const agg = (keyFn) => {
    const m = new Map();
    for (const f of own) {
      const mid = res.midAt(f.k, f.t + H * 60000);
      if (mid == null) continue;
      const k = keyFn(f);
      const o = m.get(k) || { qty: 0, pnl: 0, fills: 0 };
      o.qty += f.qty; o.fills++; o.pnl += f.qty * (f.side === 'buy' ? mid - f.px : f.px - mid);
      m.set(k, o);
    }
    return m;
  };
  const row = (k, o) => `  ${String(k).padEnd(38)} ${String(o.fills).padStart(5)} fills ${String(o.qty).padStart(7)} ctr  ${(100 * o.pnl / o.qty).toFixed(2).padStart(7)}c/ctr  $${o.pnl.toFixed(2).padStart(8)}`;
  const show = (title, m, byName = false, limit = 999) => {
    out(`\n${title}`);
    const rows = [...m].sort((a, b) => (byName ? String(a[0]).localeCompare(String(b[0])) : a[1].pnl - b[1].pnl));
    for (const [k, o] of rows.slice(0, limit)) out(row(k, o));
  };
  const total = agg(() => 'all').get('all');
  if (!total) { out('no marked fills'); return; }
  out(`own fills marked at ${H}m: ${total.qty} contracts, ${(100 * total.pnl / total.qty).toFixed(2)}c/ctr, $${total.pnl.toFixed(2)}`);
  const byM = agg((f) => f.k);
  const sorted = [...byM].sort((a, b) => a[1].pnl - b[1].pnl);
  const losers = sorted.filter(([, o]) => o.pnl < 0), winners = sorted.filter(([, o]) => o.pnl > 0);
  const lossSum = losers.reduce((a, [, o]) => a + o.pnl, 0), winSum = winners.reduce((a, [, o]) => a + o.pnl, 0);
  const share = (n) => (lossSum ? `${(100 * losers.slice(0, n).reduce((a, [, o]) => a + o.pnl, 0) / lossSum).toFixed(0)}%` : '-');
  out(`markets: ${byM.size} · ${losers.length} lose $${(-lossSum).toFixed(2)} · ${winners.length} win $${winSum.toFixed(2)} · worst 5 = ${share(5)} of losses, worst 10 = ${share(10)}`);
  show('worst 12 markets', byM, false, 12);
  show('best 5 markets', new Map(sorted.slice(-5)));
  show('by side', agg((f) => f.side), true);
  show('by run-over (the print traded through the quote) or in-rate', agg((f) => (f.ro ? 'run-over' : 'in-rate')), true);
  show('by price band', agg((f) => (f.px < 0.1 ? 'a <10c' : f.px < 0.3 ? 'b 10-30c' : f.px < 0.7 ? 'c 30-70c' : f.px < 0.9 ? 'd 70-90c' : 'e >90c')), true);
  show('by series family (worst 15)', agg((f) => f.k.replace(/-.*$/, '').replace(/\d+$/, '')), false, 15);
  show('by hour ET', agg((f) => new Date(f.t).toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hour12: false })), true);
  out('\nall horizons:');
  for (const h of HORIZONS) {
    let q = 0, p = 0;
    for (const f of own) { const mid = res.midAt(f.k, f.t + h * 60000); if (mid == null) continue; q += f.qty; p += f.qty * (f.side === 'buy' ? mid - f.px : f.px - mid); }
    out(`  ${String(h).padStart(3)}m: ${q ? (100 * p / q).toFixed(2) : '-'}c/ctr on ${q} contracts`);
  }
}

function standAside(res, own, out = console.log) {
  const mark = (f) => { const mid = res.midAt(f.k, f.t + H * 60000); return mid == null ? null : f.qty * (f.side === 'buy' ? mid - f.px : f.px - mid); };
  // the mid K minutes before the fill; a quiet market can go minutes without a line, so look a little further back
  const midBefore = (k, t, K) => { for (const back of [0, 1, 2, 3, 5]) { const m = res.midAt(k, t - (K + back) * 60000); if (m != null) return m; } return null; };
  out(`\nstand aside when |mid now - mid K min ago| >= X cents.   kept / refused: contracts, c/ctr at ${H}m, $`);
  for (const K of [2, 5, 10, 15]) {
    for (const X of [1, 2, 3, 5]) {
      const kept = { q: 0, p: 0 }, ref = { q: 0, p: 0 };
      let unknown = 0;
      for (const f of own) {
        const pm = mark(f);
        if (pm == null) continue;
        const now = res.midAt(f.k, f.t), before = midBefore(f.k, f.t, K);
        if (now == null || before == null) { unknown++; kept.q += f.qty; kept.p += pm; continue; }
        const o = Math.abs(now - before) * 100 >= X - 1e-9 ? ref : kept;
        o.q += f.qty; o.p += pm;
      }
      const c = (o) => `${String(o.q).padStart(6)} ${(o.q ? 100 * o.p / o.q : 0).toFixed(2).padStart(6)}c $${o.p.toFixed(0).padStart(5)}`;
      out(`  K=${String(K).padStart(2)}m X=${X}c   kept ${c(kept)}   refused ${c(ref)}   (${unknown} fills with no earlier mid, kept)`);
    }
  }
}

// Two signals real makers dodge sweeps with, scored the same way. A: the touch is thin on our side
// (we are selling and the ask holds under theta of bid+ask depth, or the mirror), read from the last
// book row before the fill. B: the last K minutes of taker flow mostly came at our side (lifting
// offers while we sell, hitting bids while we buy), from the print rows. Both are what the desk
// could see before quoting: the book is in desiredQuotes already, the prints come through src/tape.js.
function signals(res, own, books, prints, out = console.log) {
  const mark = (f) => { const mid = res.midAt(f.k, f.t + H * 60000); return mid == null ? null : f.qty * (f.side === 'buy' ? mid - f.px : f.px - mid); };
  const lastBefore = (arr, t) => { let lo = 0, hi = arr.length - 1, best = null; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] < t) { best = arr[m]; lo = m + 1; } else hi = m - 1; } return best; };
  const ourShare = (f) => { const b = lastBefore(books.get(f.k) || [], f.t); if (!b) return null; const [, bs, as] = b; if (bs + as <= 0) return null; return f.side === 'sell' ? as / (bs + as) : bs / (bs + as); };
  const flowAtUs = (f, K, minN) => {
    const ps = prints.get(f.k) || [];
    let same = 0, tot = 0;
    for (let i = ps.length - 1; i >= 0; i--) { const [t, n, s] = ps[i]; if (t >= f.t) continue; if (t < f.t - K * 60000) break; tot += n; if ((f.side === 'sell' && s === 'a') || (f.side === 'buy' && s === 'b')) same += n; }
    return tot >= minN ? same / tot : null;
  };
  const score = (title, rows) => {
    out(`\n${title}`);
    for (const [name, refuse] of rows) {
      const kept = { q: 0, p: 0 }, ref = { q: 0, p: 0 };
      let unknown = 0;
      for (const f of own) { const pm = mark(f); if (pm == null) continue; const r = refuse(f); if (r == null) { unknown++; kept.q += f.qty; kept.p += pm; continue; } const o = r ? ref : kept; o.q += f.qty; o.p += pm; }
      const c = (o) => `${String(o.q).padStart(6)} ${(o.q ? 100 * o.p / o.q : 0).toFixed(2).padStart(6)}c $${o.p.toFixed(0).padStart(5)}`;
      out(`  ${name.padEnd(28)} kept ${c(kept)}   refused ${c(ref)}   (${unknown} unknown, kept)`);
    }
  };
  score('A. book lean: refuse when our side of the touch holds < theta of the touch depth', [0.15, 0.25, 0.35, 0.5].map((th) => [`theta=${th}`, (f) => { const s = ourShare(f); return s == null ? null : s < th; }]));
  score('B. flow: refuse when >= phi of the last K min taker flow came at our side (20+ contracts seen)', [[5, 0.7], [15, 0.7], [15, 0.85], [30, 0.7], [30, 0.85]].map(([K, phi]) => [`K=${K}m phi=${phi}`, (f) => { const s = flowAtUs(f, K, 20); return s == null ? null : s >= phi; }]));
  const dist = (pred) => { const xs = []; for (const f of own) { if (!pred(f)) continue; const s = ourShare(f); if (s != null) xs.push(s); } xs.sort((a, b) => a - b); const q = (p) => (xs.length ? xs[Math.floor(p * (xs.length - 1))].toFixed(2) : '-'); return `n=${xs.length} p25=${q(0.25)} p50=${q(0.5)} p75=${q(0.75)}`; };
  out(`\nour side's share of the touch depth at the fill: run-over ${dist((f) => f.ro)} · in-rate ${dist((f) => !f.ro)}`);
}

// The fills on markets the pair scanner also priced, against Polymarket's mid from the last pair row
// within 30 minutes before the fill: WITH means bought under it or sold over it. Marked at every horizon.
function fair(res, own, pm, out = console.log) {
  const lastBefore = (arr, t) => { let lo = 0, hi = arr.length - 1, best = -1; while (lo <= hi) { const m = (lo + hi) >> 1; if (arr[m][0] < t) { best = m; lo = m + 1; } else hi = m - 1; } return best; };
  const rows = own.filter((f) => pm.has(f.k));
  out(`\nfills on paired markets: ${rows.length} of ${own.length}, on ${new Set(rows.map((f) => f.k)).size} markets, against Polymarket's mid from the last pair row within 30 minutes`);
  for (const h of HORIZONS) {
    const m = new Map(); let none = 0;
    for (const f of rows) {
      const mid = res.midAt(f.k, f.t + h * 60000); if (mid == null) continue;
      const a = pm.get(f.k), i = lastBefore(a, f.t);
      if (i < 0 || f.t - a[i][0] > 30 * 60000) { none++; continue; }
      const edge = f.side === 'buy' ? a[i][1] - f.px : f.px - a[i][1];
      const k = edge > 0.005 ? 'with Polymarket' : edge < -0.005 ? 'against Polymarket' : 'at its mid';
      const o = m.get(k) || { q: 0, p: 0, n: 0 }; o.q += f.qty; o.n++; o.p += f.qty * (f.side === 'buy' ? mid - f.px : f.px - mid); m.set(k, o);
    }
    out(`  ${String(h).padStart(3)}m:` + ['with Polymarket', 'at its mid', 'against Polymarket'].map((k) => { const o = m.get(k); return o ? `  ${k} ${(100 * o.p / o.q).toFixed(2)}c on ${o.q}` : `  ${k} -`; }).join('') + (none ? `   (${none} fills with no reading in time)` : ''));
  }
}

module.exports = { slices, standAside, signals, fair, TENNIS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? (args[i + 1] || true) : null; };
  const root = path.join(__dirname, '..');
  try {
    for (const m of fs.readFileSync(path.join(root, 'fly.toml'), 'utf8').matchAll(/^\s*(MAKER_[A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  } catch { /* no fly.toml: the defaults */ }
  const cfg = { ...require('../src/config') };
  const maker = require('../src/maker');
  const dir = path.resolve(flag('dir') || path.join(root, 'data', 'fly', 'archive'));
  const day = flag('day');
  const books = new Map(), prints = new Map();   // ticker -> [[t, bidSize, askSize]], ticker -> [[t, contracts, takerSide]]
  const pm = new Map();                            // Kalshi ticker -> [[t, Polymarket mid]] from the pair recorder's rows in the same file
  const push = (m, k, v) => { if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
  if (!day || day === true) { console.error('usage: node tools/maker-slice.js --day YYYY-MM-DD [--standaside] [--no-tennis] [--dir DIR]'); process.exit(1); }
  (async () => {
    const dayBefore = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const lines = (d) => { const f = path.join(dir, `journal-${d}.jsonl`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : []; };
    const jall = journalFills([...lines(dayBefore), ...lines(day)]);
    const check = makeFillCheck(cfg, maker, jall.cools);
    let counting = false;
    const read = async (tf) => {
      const rl = readline.createInterface({ input: fs.createReadStream(tf), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.startsWith('{"mk"')) {
          if (!counting || line.indexOf('"pair"') < 0) continue;
          let r; try { r = JSON.parse(line); } catch { continue; }
          const ks = r.pair && String(r.pair).split('|')[1];
          if (ks && Number.isFinite(r.pmBid) && Number.isFinite(r.pmAsk)) push(pm, ks, [Date.parse(r.qt || r.t), (r.pmBid + r.pmAsk) / 2]);
          continue;
        }
        let row; try { row = JSON.parse(line); } catch { continue; }
        if (row.mk === 'b') push(books, row.k, [row.t, row.bs || 0, row.as || 0]);
        else if (row.mk === 'p') push(prints, row.k, [row.t, row.n || 0, row.s]);
        check.feed(row);
      }
    };
    const warm = path.join(dir, `ticks-${dayBefore}.jsonl`);
    if (fs.existsSync(warm)) { check.counting(false); await read(warm); check.counting(true); }
    counting = true;
    const tf = path.join(dir, `ticks-${day}.jsonl`);
    if (!fs.existsSync(tf)) { console.error(`no tape for ${day} in ${dir}`); process.exit(1); }
    await read(tf);
    const res = check.result();
    const noTennis = args.includes('--no-tennis');
    const own = res.fills.filter((f) => f.bucket === 'tape' && !(noTennis && TENNIS.test(f.k)));
    console.log(`${day} (ET)${noTennis ? ', live-match markets left out' : ''}: ${own.length} of the desk's own fills`);
    slices(res, own);
    if (args.includes('--standaside')) standAside(res, own);
    if (args.includes('--signals')) signals(res, own, books, prints);
    if (args.includes('--fair')) fair(res, own, pm);
  })();
}

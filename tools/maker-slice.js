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
//   node tools/maker-slice.js --day 2026-09-21 --no-tennis   leave out the live-match markets (KXWTA/KXATP/KXITF/KXDAVISCUP)
//
// What four days said (2026-09-19 → 09-22, 30-minute marks, the desk's own fills, per contract):
//   run-over fills (the print traded through the quote)  -1.1c to -2.0c   every day, 53-68% of contracts
//   in-rate fills                                          -0.35c to +0.6c  flat: the half-spread and the drift cancel
//   live tennis (09-20, 09-21 only; PR #98 stopped it)     -17c to -71c on the worst markets, +72c on the best: coin flips
//   stand aside on a moved mid (K=10m, X=1c)               takes $24 / $73 / $24 off 09-19/20/21 and nothing off 09-22;
//                                                          the kept fills still mark -0.5c to -0.7c
// So the loss is not one market, one hour or one side; it is the sweep itself, and no rail here
// makes what is left positive.
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

module.exports = { slices, standAside, TENNIS };

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
  if (!day || day === true) { console.error('usage: node tools/maker-slice.js --day YYYY-MM-DD [--standaside] [--no-tennis] [--dir DIR]'); process.exit(1); }
  (async () => {
    const dayBefore = new Date(Date.parse(`${day}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const lines = (d) => { const f = path.join(dir, `journal-${d}.jsonl`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : []; };
    const jall = journalFills([...lines(dayBefore), ...lines(day)]);
    const check = makeFillCheck(cfg, maker, jall.cools);
    const read = async (tf) => {
      const rl = readline.createInterface({ input: fs.createReadStream(tf), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.startsWith('{"mk"')) continue;
        let row; try { row = JSON.parse(line); } catch { continue; }
        check.feed(row);
      }
    };
    const warm = path.join(dir, `ticks-${dayBefore}.jsonl`);
    if (fs.existsSync(warm)) { check.counting(false); await read(warm); check.counting(true); }
    const tf = path.join(dir, `ticks-${day}.jsonl`);
    if (!fs.existsSync(tf)) { console.error(`no tape for ${day} in ${dir}`); process.exit(1); }
    await read(tf);
    const res = check.result();
    const noTennis = args.includes('--no-tennis');
    const own = res.fills.filter((f) => f.bucket === 'tape' && !(noTennis && TENNIS.test(f.k)));
    console.log(`${day} (ET)${noTennis ? ', live-match markets left out' : ''}: ${own.length} of the desk's own fills`);
    slices(res, own);
    if (args.includes('--standaside')) standAside(res, own);
  })();
}

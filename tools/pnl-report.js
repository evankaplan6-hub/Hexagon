'use strict';
// One screen answering "how is the desk actually doing?", from the journals and nothing else.
//
//   node tools/pnl-report.js                    every day in data/fly/archive (the daily pull fills it),
//                                               plus data/fly/box-now for the days the archive lacks yet
//   node tools/pnl-report.js --since 2026-09-16 from that Eastern-agnostic UTC day on
//   node tools/pnl-report.js --marks            also mark the maker's open inventory at Kalshi's current
//                                               prices (public API, read-only, the one network call)
//   node tools/pnl-report.js path/to/journals   a different folder
//
// It exists because every answer to this question used to be an ad-hoc script. The journal is the
// append-only truth (CLAUDE.md), so this reads it and never the dashboard: no password, no running
// desk. What it prints is REALISED money. Anything marked is labelled as a mark.
const fs = require('fs');
const path = require('path');
const maker = require('../src/maker');

const usd = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
const r2 = (x) => Math.round(x * 100) / 100;

// `dir` is one folder or a list of them. With a list, a day is read from the FIRST folder that has
// its journal: the default is [archive, box-now], and the archive wins. box-now is where the daily
// check's ledger-check --box copies today's journal (and any day the pull has not reached), so
// without it "today" was only the tail of yesterday's Eastern file: on 2026-09-24 the check printed
// -$52.78 for the maker's day when the box's journal already said -$113.00. A copy left in box-now
// for a day the pull has archived since is an older, shorter one, so it must never win
// (tools/ledger-check.js pruneBoxNow has the same story).
function load(dir, since) {
  const byDay = new Map();
  for (const d of Array.isArray(dir) ? dir : [dir]) {
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const n of names) if (/^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && !byDay.has(n)) byDay.set(n, path.join(d, n));
  }
  const ev = [];
  for (const [, f] of [...byDay].sort()) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (!since || e.t.slice(0, 10) >= since) ev.push(e); } catch { /* a torn last line */ }
    }
  }
  return ev;
}

// Pure: journal events in, numbers out. `pos` is returned so --marks can price what is still held.
function summarize(events) {
  const day = (e) => e.t.slice(0, 10);
  const days = new Map();
  const D = (k) => days.get(k) || days.set(k, { conv: { n: 0, w: 0, pnl: 0 }, arb: 0, snipe: 0, maker: 0, makerFills: 0, makerQty: 0, runQty: 0 }).get(k);
  const opens = new Map();
  const conv = { n: 0, w: 0, pnl: 0, fees: 0, mind: { n: 0, pnl: 0 }, rules: { n: 0, pnl: 0 }, byReason: new Map() };
  const arb = { n: 0, pnl: 0 };
  const arbGroups = new Set();
  const snipe = { n: 0, w: 0, pnl: 0, fees: 0 };   // the settlement snipe (README): bought on Kalshi after Polymarket settled, held to settlement
  const mk = { fills: 0, qty: 0, runQty: 0, realized: 0, settles: 0, settlePnl: 0, flattens: 0 };
  const pos = {};

  let lastT = null;
  for (const e of events) {
    if (e.t && (!lastT || e.t > lastT)) lastT = e.t;
    const open = opens.get(e.id) || {};
    if (e.kind === 'OPEN') opens.set(e.id, e);
    // Every arb leg's own close, partial close and settlement, the way tools/ledger-check.js books
    // them, and not the group's ARB_UNWOUND/ARB_SETTLED line: those only exist since 03f1ef2
    // (2026-09-12 16:40Z), and the three Fed arbs that closed before it (+$6.61) were missing, so the
    // report said 16 groups and -$228.67 where the ledger has 19 and -$222.06. CLOSE_PARTIAL carries
    // no strategy or group of its own; the OPEN has both. Each leg lands on the day it closed.
    else if ((e.kind === 'CLOSE' || e.kind === 'SETTLE' || e.kind === 'CLOSE_PARTIAL') && (e.strategy || open.strategy) === 'arb') {
      arb.pnl += e.pnl || 0; D(day(e)).arb += e.pnl || 0;
      arbGroups.add(e.group || open.group || e.id);
      arb.n = arbGroups.size;
    } else if (e.kind === 'CLOSE_PARTIAL' && open.strategy === 'converge') {
      // A gain-lock sale of part of a convergence bet. The CLOSE that ends the bet carries only
      // the rest (engine: CLOSE.pnl is the exit's own), so the partial is booked here, as money,
      // without counting a closed trade or a winner.
      conv.pnl += e.pnl || 0; D(day(e)).conv.pnl += e.pnl || 0;
      conv.fees += e.fee || 0;
    } else if ((e.kind === 'CLOSE' || e.kind === 'SETTLE') && e.strategy === 'converge') {
      const pnl = e.pnl || 0;
      const d = D(day(e)).conv;
      d.n++; d.pnl += pnl; if (pnl > 0) d.w++;
      conv.n++; conv.pnl += pnl; if (pnl > 0) conv.w++;
      conv.fees += (e.fee || 0) + ((opens.get(e.id) || {}).fee || 0);
      const isMind = /^mind:/.test(e.reason || '');
      const bucket = isMind ? conv.mind : conv.rules;
      bucket.n++; bucket.pnl += pnl;
      const why = isMind ? 'mind' : String(e.reason || 'other').replace(/[\d.]+/g, '#').replace(/, gap still.*|, held.*| \(.*|\bvs entry.*/, '').trim().slice(0, 34);
      const r = conv.byReason.get(why) || { n: 0, pnl: 0 };
      r.n++; r.pnl += pnl; conv.byReason.set(why, r);
    } else if ((e.kind === 'CLOSE' || e.kind === 'SETTLE') && e.strategy === 'snipe') {
      const pnl = e.pnl || 0;
      snipe.n++; snipe.pnl += pnl; if (pnl > 0) snipe.w++;
      snipe.fees += (e.fee || 0) + ((opens.get(e.id) || {}).fee || 0);
      D(day(e)).snipe += pnl;
    } else if (e.kind === 'MAKER_FILL') {
      const p = pos[e.ticker] || (pos[e.ticker] = { inv: 0, cost: 0, realized: 0 });
      const r = maker.applyFill(p, { side: e.side, qty: e.qty, px: e.px, tradePx: e.tradePx });
      p.inv = r.inv; p.cost = r.cost; p.realized = r.realized;
      mk.fills++; mk.qty += e.qty; if (e.runOver) mk.runQty += e.qty; mk.realized += r.pnl || 0;
      const d = D(day(e)); d.maker += r.pnl || 0; d.makerFills++; d.makerQty += e.qty; if (e.runOver) d.runQty += e.qty;
    } else if (e.kind === 'MAKER_SETTLE') {
      mk.settles++; mk.settlePnl += e.pnl || 0; D(day(e)).maker += e.pnl || 0;
      if (pos[e.ticker]) { pos[e.ticker].inv = 0; pos[e.ticker].cost = 0; }
    } else if (e.kind === 'MAKER_FLATTEN') {
      // A whole position crossed out at the touch: the operator's flatten, and since 2026-09-24 the
      // maker's own cross-out the day before a configured event date. `pnl` is net of the taker fee.
      mk.flattens++; mk.realized += e.pnl || 0; D(day(e)).maker += e.pnl || 0;
      if (pos[e.ticker]) { pos[e.ticker].inv = 0; pos[e.ticker].cost = 0; }
    }
  }
  const held = Object.entries(pos).filter(([, p]) => p.inv).map(([ticker, p]) => ({ ticker, inv: p.inv, cost: p.cost }));
  return { days, conv, arb, snipe, mk, held, lastT };
}

// Public, unauthenticated, read-only. Returns ticker -> yes price to mark at.
async function marksFor(tickers) {
  const out = {};
  for (let i = 0; i < tickers.length; i += 100) {
    const part = tickers.slice(i, i + 100);
    const r = await fetch(`https://api.elections.kalshi.com/trade-api/v2/markets?limit=100&tickers=${part.map(encodeURIComponent).join(',')}`);
    if (!r.ok) throw new Error(`Kalshi ${r.status}`);
    for (const m of (await r.json()).markets || []) {
      const b = parseFloat(m.yes_bid_dollars), a = parseFloat(m.yes_ask_dollars);
      out[m.ticker] = m.result === 'yes' ? 1 : m.result === 'no' ? 0 : (Number.isFinite(b) && Number.isFinite(a) && a > 0 ? (a + b) / 2 : parseFloat(m.last_price_dollars));
    }
  }
  return out;
}

function render(s, unreal) {
  const L = [];
  const { conv, arb, mk } = s;
  const snipe = s.snipe || { n: 0, w: 0, pnl: 0, fees: 0 };
  L.push('CONVERGENCE  (any-market pairs, taker)');
  L.push(`  ${conv.n} closed · ${conv.w} winners · realized ${usd(r2(conv.pnl))} · fees paid ${usd(-r2(conv.fees))} of that`);
  for (const [why, r] of [...conv.byReason.entries()].sort((a, b) => a[1].pnl - b[1].pnl)) L.push(`    ${why.padEnd(36)} ${String(r.n).padStart(3)}  ${usd(r2(r.pnl)).padStart(10)}`);
  L.push(`  RIGO's mind closed ${conv.mind.n} early · ${usd(r2(conv.mind.pnl))}   (the rules closed ${conv.rules.n} · ${usd(r2(conv.rules.pnl))})`);
  L.push('');
  L.push('LOCKED ARBS');
  L.push(`  ${arb.n} groups with a leg closed or settled · ${usd(r2(arb.pnl))}`);
  L.push('');
  L.push('SETTLEMENT SNIPE  (bought on Kalshi after Polymarket settled)');
  L.push(`  ${snipe.n} settled or closed · ${snipe.w} winners · realized ${usd(r2(snipe.pnl))} · fees paid ${usd(-r2(snipe.fees))} of that`);
  L.push('');
  L.push('MAKER');
  const runPct = mk.qty ? Math.round((mk.runQty / mk.qty) * 100) : 0;
  L.push(`  ${mk.fills} fills · ${Math.round(mk.qty)} contracts · ${runPct}% run over · realized ${usd(r2(mk.realized + mk.settlePnl))} (of which ${mk.settles} settlements ${usd(r2(mk.settlePnl))})${mk.flattens ? ` · ${mk.flattens} positions crossed out` : ''}`);
  const heldQty = s.held.reduce((a, h) => a + Math.abs(h.inv), 0);
  L.push(`  still holding ${Math.round(heldQty)} contracts in ${s.held.length} markets${unreal == null ? ' · run with --marks to price them' : ` · marked ${usd(r2(unreal))} (a MARK, not money)`}`);
  const total = conv.pnl + arb.pnl + snipe.pnl + mk.realized + mk.settlePnl;
  L.push('');
  L.push(`ALL-IN REALIZED ${usd(r2(total))}${unreal == null ? '' : ` · with marks ${usd(r2(total + unreal))}`}`);
  L.push('');
  L.push('BY DAY            converge      arb    snipe    maker   maker run-over');
  const rows = [...s.days.entries()].sort();
  rows.forEach(([k, d], i) => {
    const ro = d.makerQty ? `${Math.round((d.runQty / d.makerQty) * 100)}%` : '-';
    // the newest day is whatever the journals hold so far, not a whole day: say up to when
    const upTo = i === rows.length - 1 && s.lastT && s.lastT.slice(0, 10) === k ? `   so far, through ${s.lastT.slice(11, 16)}Z` : '';
    L.push(`  ${k}  ${`${d.conv.n} · ${usd(r2(d.conv.pnl))}`.padStart(14)} ${usd(r2(d.arb)).padStart(8)} ${usd(r2(d.snipe || 0)).padStart(8)} ${usd(r2(d.maker)).padStart(8)}   ${ro.padStart(6)}${upTo}`);
  });
  return L.join('\n');
}

async function main(argv) {
  const args = argv.slice(2);
  const flag = (n) => args.includes(`--${n}`);
  const since = args.includes('--since') ? args[args.indexOf('--since') + 1] : null;
  const dirArg = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--since');
  const archive = path.join(__dirname, '..', 'data', 'fly', 'archive');
  const dir = dirArg || archive;
  if (!fs.existsSync(dir)) { console.error(`no journals at ${dir} -- has the daily pull run? (ops/install-pull.sh)`); process.exit(1); }
  const events = load(dirArg ? dir : [archive, path.join(__dirname, '..', 'data', 'fly', 'box-now')], since);
  if (!events.length) { console.error(`no journal events${since ? ` since ${since}` : ''} in ${dir}`); process.exit(1); }
  const s = summarize(events);
  let unreal = null;
  if (flag('marks') && s.held.length) {
    const mid = await marksFor(s.held.map((h) => h.ticker));
    unreal = s.held.reduce((a, h) => a + (Number.isFinite(mid[h.ticker]) ? h.inv * mid[h.ticker] - h.cost : 0), 0);
  }
  console.log(`${events[0].t.slice(0, 10)} → ${events[events.length - 1].t.slice(0, 16)}Z · ${events.length} journal events\n`);
  console.log(render(s, unreal));
}

if (require.main === module) main(process.argv).catch((e) => { console.error(e.message); process.exit(1); });
module.exports = { summarize, render, load };

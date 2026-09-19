'use strict';
// Historical cross-venue scan. Read-only: touches nothing the running desk owns.
//
// Pulls ~7 days of hourly prices for every currently-matched pair and measures how far apart the
// venues actually were, and what a Kalshi-leg trade would have netted after spread and round-trip
// fees. Answers "was there ever anything to trade?" in minutes instead of waiting a week.
//
//   node tools/history-scan.js            # pairs from the running desk on :8787
//   node tools/history-scan.js data/ticks-2026-09-09.jsonl   # or from a recorded tape
//
// KNOWN LIMIT, and it matters: Kalshi publishes historical bid AND ask (90 days). Polymarket
// publishes a single price, no book, and only ~7 days. So the GAP is measurable but the fill is
// not. History can therefore DISPROVE an opportunity cheaply and cannot fully prove one — a wide
// gap on a market with no resting size looks identical to a wide gap you could have traded.
// That is what src/probe.js exists to settle going forward.
const fs = require('fs');
const GAMMA = 'https://gamma-api.polymarket.com';
const CLOB = 'https://clob.polymarket.com';
const KS = 'https://api.elections.kalshi.com/trade-api/v2';

const cfg = require('../src/config');
const MIN_GAP = cfg.minGap, MIN_EDGE = cfg.minEdge, MAX_SPREAD = cfg.maxSpread, FEE = cfg.ksFeeRate;
const ksFee = (p) => (p > 0 && p < 1 ? FEE * p * (1 - p) : 0);
const hour = (ts) => Math.floor(ts / 3600) * 3600;
const c = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}c` : '  n/a');
const pct = (a, q) => (a.length ? a[Math.min(a.length - 1, Math.floor(q * a.length))] : NaN);
const j = async (u) => { const r = await fetch(u, { headers: { accept: 'application/json' } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };

// Mirrors agents.convEdge for a Kalshi leg, on real historical Kalshi bid/ask: in at the ask (or
// 1-bid for NO), out at the bid once the mid reaches fair, taker fee on both sides.
function ksEdge(ksBid, ksAsk, fair) {
  const spread = Math.max(0, ksAsk - ksBid);
  if (spread > MAX_SPREAD) return null;
  let best = null;
  for (const side of ['yes', 'no']) {
    const px = side === 'yes' ? ksAsk : 1 - ksBid;
    const target = side === 'yes' ? fair : 1 - fair;
    const exit = target - spread / 2;
    const edge = exit - px - ksFee(px) - ksFee(exit);
    if (!best || edge > best.edge) best = { side, edge };
  }
  return best;
}

async function loadPairs(arg) {
  if (arg) { // distinct pairs out of a recorded tape
    const seen = new Map();
    for (const line of fs.readFileSync(arg, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const r = JSON.parse(line);
      if (!r.pair) continue;                 // the maker's book and prints share this file (src/makertape.js)
      const [pmPart, ticker] = String(r.pair).split('|');
      const [id, tokenIndex] = pmPart.split(':');
      if (!seen.has(r.pair)) seen.set(r.pair, { label: r.label, kind: r.kind, startsAt: null, pm: { id, tokenIndex: +tokenIndex }, ks: { ticker } });
    }
    return [...seen.values()];
  }
  return j(`http://localhost:${cfg.port}/api/pairs`).catch(() => {
    throw new Error(`desk not answering on :${cfg.port} — start it, or pass a tick file: node tools/history-scan.js data/ticks-YYYY-MM-DD.jsonl`);
  });
}

(async () => {
  const pairs = await loadPairs(process.argv[2]);
  const end = Math.floor(Date.now() / 1000), start = end - 7 * 86400;
  const rows = [], perPair = [];
  console.log(`scanning ${pairs.length} pairs over 7 days, hourly\n`);

  for (const p of pairs) {
    const ticker = p.ks.ticker, series = ticker.split('-')[0];
    try {
      let tokenId = p.pm.tokenId;
      if (!tokenId) tokenId = JSON.parse((await j(`${GAMMA}/markets/${p.pm.id}`)).clobTokenIds)[p.pm.tokenIndex];
      const [ph, kc] = await Promise.all([
        j(`${CLOB}/prices-history?market=${tokenId}&startTs=${start}&endTs=${end}&fidelity=60`),
        j(`${KS}/series/${series}/markets/${ticker}/candlesticks?start_ts=${start}&end_ts=${end}&period_interval=60`),
      ]);
      const pmByHour = new Map((ph.history || []).map((x) => [hour(x.t), x.p]));
      const mine = [];
      for (const k of (kc.candlesticks || [])) {
        const h = hour(k.end_period_ts);
        const pmP = pmByHour.get(h);
        if (pmP == null) continue;
        const kb = parseFloat(k.yes_bid && k.yes_bid.close_dollars), ka = parseFloat(k.yes_ask && k.yes_ask.close_dollars);
        if (!Number.isFinite(kb) || !Number.isFinite(ka) || ka <= 0 || kb >= 1 || ka < kb) continue;
        // exclude in-play hours: the desk refuses to trade games from 2 minutes before start
        if (p.kind === 'game' && p.startsAt && h * 1000 >= p.startsAt - 120000) continue;
        const ksMid = (kb + ka) / 2, gap = Math.abs(ksMid - pmP), fair = (pmP + ksMid) / 2;
        const e = ksEdge(kb, ka, fair);
        const row = { h, label: p.label, series, pmP, ksBid: kb, ksAsk: ka, gap, edge: e ? e.edge : null };
        rows.push(row); mine.push(row);
      }
      if (mine.length) {
        const g = mine.map((r) => r.gap).sort((a, b) => a - b);
        const wide = mine.filter((r) => r.gap >= 0.15).map((r) => r.h).sort((a, b) => a - b);
        perPair.push({
          label: p.label, n: mine.length, med: pct(g, 0.5), max: g[g.length - 1],
          overGap: mine.filter((r) => r.gap >= MIN_GAP).length,
          tradeable: mine.filter((r) => r.edge >= MIN_EDGE && r.gap >= MIN_GAP).length,
          bestEdge: Math.max(...mine.map((r) => (r.edge == null ? -Infinity : r.edge))),
          // A 15c+ gap that PERSISTS for hours is not an opportunity anyone declined to take —
          // a real one is gone in seconds. Treat it as a price with no book behind it until
          // src/probe.js proves otherwise, and report those pairs separately.
          suspect: wide.length >= 3 && (wide[wide.length - 1] - wide[0]) >= 6 * 3600,
        });
      }
      process.stdout.write(`  ${p.label.padEnd(42).slice(0, 42)} ${String(mine.length).padStart(4)} hrs\n`);
    } catch (e) { process.stdout.write(`  ${p.label.padEnd(42).slice(0, 42)}  skipped (${e.message})\n`); }
    await new Promise((r) => setTimeout(r, 250)); // be polite to both venues
  }

  const suspects = new Set(perPair.filter((p) => p.suspect).map((p) => p.label));
  const real = rows.filter((r) => !suspects.has(r.label));
  const report = (name, set) => {
    if (!set.length) return console.log(`\n${name}: no data`);
    const g = set.map((r) => r.gap).sort((a, b) => a - b);
    const e = set.filter((r) => r.edge != null).map((r) => r.edge).sort((a, b) => a - b);
    console.log(`\n${name}  (${set.length} pair-hours)`);
    console.log(`  gap   median ${c(pct(g, 0.5))}  90th ${c(pct(g, 0.9))}  99th ${c(pct(g, 0.99))}  max ${c(g[g.length - 1])}`);
    console.log(`        at or above ${c(MIN_GAP)}: ${set.filter((r) => r.gap >= MIN_GAP).length} (${(100 * set.filter((r) => r.gap >= MIN_GAP).length / set.length).toFixed(2)}%)`);
    console.log(`  edge  median ${c(pct(e, 0.5))}  90th ${c(pct(e, 0.9))}  max ${c(e[e.length - 1])}`);
    console.log(`        PROFITABLE (edge >= ${c(MIN_EDGE)} and gap >= ${c(MIN_GAP)}): ${set.filter((r) => r.edge >= MIN_EDGE && r.gap >= MIN_GAP).length}`);
  };

  console.log(`\n${'='.repeat(70)}\n${perPair.length} pairs · ${rows.length} pair-hours · in-play hours excluded\n${'='.repeat(70)}`);
  report('ALL PAIRS', rows);
  if (suspects.size) {
    report(`EXCLUDING ${suspects.size} SUSPECT PAIR(S) — wide gaps that persisted for hours`, real);
    console.log(`\n  suspect: ${[...suspects].join(', ')}`);
    console.log('  A 15c+ gap standing for 6+ hours is far more likely a price with no resting size');
    console.log('  than an edge nobody took. Check data/probes-*.jsonl for the live books before');
    console.log('  believing any of it.');
  }
  console.log(`\nPER PAIR                                    hrs   medGap  maxGap  >=gap  tradeable  bestEdge`);
  for (const p of perPair.sort((a, b) => b.max - a.max)) {
    console.log(`  ${(p.suspect ? '! ' : '  ') + p.label.padEnd(38).slice(0, 38)} ${String(p.n).padStart(4)} ${c(p.med).padStart(8)} ${c(p.max).padStart(8)} ${String(p.overGap).padStart(6)} ${String(p.tradeable).padStart(10)} ${c(p.bestEdge).padStart(9)}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

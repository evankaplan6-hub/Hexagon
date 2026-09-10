'use strict';
// Does the LIVE maker desk behave like the simulator that justified building it?
//
//   node tools/maker-verify.js
//
// Pulls the trade tape for every market the desk is currently quoting, restricted to the window
// the desk has actually been running, and replays it through the same no-lookahead fill logic the
// backtest used (src/maker.js fillsFrom). Then compares against what the desk really did.
//
// A divergence here means the live implementation and the thing that was validated are not the
// same strategy -- which is the failure mode that turns a good backtest into a bad desk.
const fs = require('fs');
const ks = require('../src/venues/kalshi');
const http = require('../src/http');
const maker = require('../src/maker');
const cfg = require('../src/config');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

(async () => {
  const snap = await (await fetch(`http://localhost:${cfg.port}/api/state`)).json().catch(() => null);
  if (!snap || !snap.maker) { console.error(`desk not answering on :${cfg.port}`); process.exit(1); }
  const live = snap.maker;
  const tickers = Object.keys(live.markets || {});
  if (!tickers.length) { console.error('desk has not quoted anything yet'); process.exit(1); }

  // the desk's own journal is the record of what it actually did, and when it started
  const jrows = [];
  for (const f of fs.readdirSync(cfg.dataDir).filter((x) => x.startsWith('journal-'))) {
    for (const l of fs.readFileSync(`${cfg.dataDir}/${f}`, 'utf8').split('\n')) {
      if (!l.trim()) continue;
      try { const r = JSON.parse(l); if (String(r.kind).startsWith('MAKER')) jrows.push(r); } catch { /* skip */ }
    }
  }
  if (!jrows.length) { console.error('no maker activity journalled yet'); process.exit(1); }
  const t0 = Date.parse(jrows[0].t), t1 = Date.now();
  console.log(`window ${new Date(t0).toISOString().slice(11, 19)} → ${new Date(t1).toISOString().slice(11, 19)}  (${((t1 - t0) / 60000).toFixed(0)} min), ${tickers.length} markets\n`);

  let simFills = 0, simQty = 0, liveFills = 0, liveQty = 0, crossings = 0;
  console.log('  ' + 'market'.padEnd(32) + 'crossings'.padStart(10) + 'sim fills'.padStart(10) + 'live fills'.padStart(11));
  for (const t of tickers) {
    let trades = [];
    try { trades = ((await http.getJSON(`${ks.BASE}/markets/trades?ticker=${t}&limit=1000`)).trades || []).reverse(); }
    catch { continue; }
    const win = trades.filter((x) => { const ts = Date.parse(x.created_time); return ts >= t0 && ts <= t1; });
    // how many trades even COULD have hit a quote at the touch during the window
    const m = live.markets[t];
    const q = { bid: m.quotes.bid, ask: m.quotes.ask };
    const f = maker.fillsFrom(win, q, 0, cfg, new Set(), { bid: 0, ask: 0 }).fills;
    const lf = jrows.filter((r) => r.ticker === t && r.kind === 'MAKER_FILL');
    crossings += win.length; simFills += f.length; simQty += f.reduce((a, x) => a + x.qty, 0);
    liveFills += lf.length; liveQty += lf.reduce((a, x) => a + (x.qty || 0), 0);
    if (win.length || lf.length) console.log('  ' + t.slice(0, 30).padEnd(32) + String(win.length).padStart(10) + String(f.length).padStart(10) + String(lf.length).padStart(11));
    await sleep(120);
  }
  console.log('\n  trades in window       ' + crossings);
  console.log('  fills: replay ' + simFills + ' (' + Math.round(simQty) + ' contracts)   live ' + liveFills + ' (' + Math.round(liveQty) + ' contracts)');
  console.log('  live equity ' + money(live.equity - cfg.initialBalance) + ' from $' + cfg.initialBalance.toFixed(2) + '   cash $' + live.cash.toFixed(2));
  console.log('\n  NOTE: the replay applies each market\'s CURRENT quote across the whole window, while');
  console.log('  the live desk requoted every cycle as the book moved. They will not match exactly;');
  console.log('  what matters is that they are the same order of magnitude and neither is zero when');
  console.log('  the other is not.');
})();

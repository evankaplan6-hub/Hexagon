'use strict';
// Does the live desk fill the way the model says it should?
//
// This is the one question a week of paper trading exists to answer. The model claims a certain
// number of fills per hour given the queue ahead of us; if the live desk fills much slower, the
// backtest is still too optimistic and the strategy is worth less than it measures. If it fills
// much faster, the queue model is too harsh and the strategy is worth more.
//
// Method: take the markets the desk is quoting, pull the trade tape for the same wall-clock window
// the desk was running, replay it through the desk's OWN fill logic with each market's real
// measured queue, and compare against what the journal says actually happened.
const fs = require('fs');
const path = require('path');
const cfg = require('../src/config');
const ks = require('../src/venues/kalshi');
const maker = require('../src/maker');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const HOURS = parseFloat(process.argv[2]) || 24;
const r2h = (x) => Math.round(x * 100) / 100;

function journalFills(sinceMs) {
  const out = [];
  for (const f of fs.readdirSync(cfg.dataDir).filter((x) => /^journal-.*\.jsonl$/.test(x))) {
    for (const line of fs.readFileSync(path.join(cfg.dataDir, f), 'utf8').split('\n')) {
      if (!line) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      if (j.kind !== 'MAKER_FILL') continue;
      const t = Date.parse(j.t);
      if (t >= sinceMs) out.push({ ...j, at: t });
    }
  }
  return out;
}

(async () => {
  const st = await (await fetch(`http://localhost:${cfg.port}/api/state`)).json();
  const S = st.maker || {};
  // Only count fills this PROCESS produced. The journal spans every build of the day, and the
  // builds before the queue model filled a completely different way -- mixing them in was the
  // first thing this tool got wrong, and it flattered the result by counting fills taken at
  // prices where 15,000 orders were resting.
  const since = Math.max(Date.now() - HOURS * 3600 * 1000, st.startedAt || 0);
  const upH = (Date.now() - since) / 3600000;
  // Same trap as maker-report: `markets` is a shaped ARRAY now, and Object.keys on an array gives
  // "0", "1", "2". This tool went looking for a market called "0", matched nothing, and reported
  // "live 0 fills" on the same line as "17 live fills journalled" -- a contradiction it printed
  // without noticing, which is exactly the failure mode it exists to catch elsewhere.
  const tickers = Array.isArray(S.markets) ? S.markets.map((m) => m.ticker) : Object.keys(S.markets || {});
  if (!tickers.length) return console.log('the desk has no book yet');

  const live = journalFills(since);
  const liveBy = new Map();
  for (const f of live) liveBy.set(f.ticker, (liveBy.get(f.ticker) || 0) + 1);

  console.log(`comparing ${upH.toFixed(1)}h of THIS build · ${tickers.length} markets in the book · ${live.length} live fills journalled\n`);
  if (upH < 1) console.log(`  (only ${(upH * 60).toFixed(0)} minutes so far — too short to conclude anything; run this again tomorrow)\n`);

  let mf = 0, mc = 0, lf = 0, lc = 0;
  console.log('  ticker                              live fills   model fills   queue');
  for (const t of tickers) {
    let d, bk;
    try {
      d = await (await fetch(`${ks.BASE}/markets/trades?ticker=${t}&limit=1000`)).json();
      bk = await ks.fetchBook(t);
    } catch { continue; }
    const tr = (d.trades || []).filter((x) => Date.parse(x.created_time) >= since).reverse();
    const bid = bk.yesBids[0], ask = bk.yesAsks[0];
    if (!bid || !ask || !tr.length) { await sleep(110); continue; }
    // the desk's own logic, the desk's own config, this market's real queue
    const { fills } = maker.fillsFrom(tr, { bid: bid.price, ask: ask.price }, 0, cfg, new Set(), { bid: bid.size, ask: ask.size });
    const l = liveBy.get(t) || 0;
    const lqty = live.filter((f) => f.ticker === t).reduce((a, f) => a + f.qty, 0);
    mf += fills.length; mc += fills.reduce((a, f) => a + f.qty, 0); lf += l; lc += lqty;
    if (l || fills.length) console.log('  ' + t.padEnd(34) + String(l).padStart(8) + String(fills.length).padStart(14) + String(Math.round((bid.size + ask.size) / 2)).padStart(9));
    await sleep(110);
  }
  if (live.length && !lf) {
    console.log(`\n  WARNING: the journal has ${live.length} fills in this window but none matched a market in`);
    console.log('  the book. That is a bug in this tool, not a result -- do not read anything into it.');
  }
  const ratio = mf ? lf / mf : null;
  console.log(`\n  live   ${lf} fills, ${lc} contracts`);
  console.log(`  model  ${mf} fills, ${mc} contracts`);
  console.log(ratio == null ? '\n  model predicts nothing in this window; no comparison possible'
    : `\n  live is running at ${(ratio * 100).toFixed(0)}% of the modelled fill rate`);
  console.log(`\n  Under 50% would mean the backtest is STILL too optimistic and the strategy is worth`);
  console.log(`  less than it measures. Over 150% would mean the queue model is too harsh. Between`);
  console.log(`  those, the +$144 held-out figure stands as written.`);
  // append the reading so a week of these accumulates on its own
  fs.appendFileSync(path.join(cfg.dataDir, 'fillcheck.jsonl'),
    JSON.stringify({ t: new Date().toISOString(), hours: r2h(upH), liveFills: lf, liveQty: lc, modelFills: mf, modelQty: mc, ratio }) + '\n');
})();

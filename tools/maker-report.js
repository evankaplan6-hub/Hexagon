'use strict';
// What the maker desk has actually done, from its own ledger. Written to be read by someone who
// did not build it: every number is either measured or explicitly labelled as a mark, never both.
const cfg = require('../src/config');
const api = require('./api');

const m = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

(async () => {
  const st = await api.state();
  const S = st.maker || {};
  // The snapshot used to be an object keyed by ticker and is now a shaped array. Object.entries on
  // an array yields "0", "1", "2" as the keys, which is why this printed index numbers where the
  // market names belong.
  const mk = Array.isArray(S.markets) ? S.markets.map((m) => [m.ticker, m]) : Object.entries(S.markets || {});
  if (!mk.length) return console.log('the maker desk has no book yet');

  let fills = 0, inv = 0, cost = 0, mtm = 0, quoted = 0;
  const rows = [];
  for (const [t, x] of mk) {
    fills += x.fills || 0; inv += Math.abs(x.inv || 0); cost += x.cost || 0;
    const mark = (x.inv || 0) * (x.mid ?? 0.5);
    mtm += mark;
    // the snapshot exposes bid/ask directly now; this was still looking for the old nested
    // `quotes` object and so reported "0 currently quoting" while 33 markets had live quotes
    if (x.bid != null || x.ask != null) quoted++;
    if (x.fills) rows.push({ t, name: x.sub || x.title || t, fills: x.fills, inv: x.inv, cost: x.cost,
      pl: mark - (x.cost || 0), q: { bid: x.qBid, ask: x.qAsk } });
  }
  const equity = S.equity ?? cfg.initialBalance;
  console.log(`MAKER DESK · ${cfg.mode.toUpperCase()}\n`);
  console.log(`  markets in the book       ${mk.length} (${quoted} currently quoting)`);
  console.log(`  fills                     ${fills}`);
  console.log(`  contracts held            ${Math.round(inv)}`);
  console.log(`  realised                  ${m(S.realized || 0)}   <- profit from round trips that CLOSED`);
  console.log(`  cash                      ${m(S.cash - cfg.initialBalance)}   <- not profit: falls when buying, rises when selling`);
  console.log(`  inventory marked at mid   ${m(mtm)}   <- a MARK, not money; it is only real when it trades out`);
  console.log(`  equity                    ${m(equity - cfg.initialBalance)}`);
  if (S.halted) console.log(`  HALTED                    ${S.halted}`);
  if (!rows.length) return console.log('\n  no fills yet');
  rows.sort((a, b) => b.pl - a.pl);
  console.log(`\n  market                             fills    inv     paid      marked P&L   queue left`);
  for (const r of rows) console.log('  ' + String(r.name).slice(0, 33).padEnd(34) + String(r.fills).padStart(5) + String(Math.round(r.inv)).padStart(7)
    + m(r.cost).padStart(10) + m(r.pl).padStart(13) + `   ${Math.round(r.q.bid || 0)}/${Math.round(r.q.ask || 0)}`);
})().catch((e) => { console.error(e.message); process.exit(1); });

'use strict';
// What the maker desk has actually done, from its own ledger. Written to be read by someone who
// did not build it: every number is either measured or explicitly labelled as a mark, never both.
const cfg = require('../src/config');

const m = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

(async () => {
  const st = await (await fetch(`http://localhost:${cfg.port}/api/state`)).json();
  const S = st.maker || {};
  const mk = Object.entries(S.markets || {});
  if (!mk.length) return console.log('the maker desk has no book yet');

  let fills = 0, inv = 0, cost = 0, mtm = 0, quoted = 0;
  const rows = [];
  for (const [t, x] of mk) {
    fills += x.fills || 0; inv += Math.abs(x.inv || 0); cost += x.cost || 0;
    const mark = (x.inv || 0) * (x.mid ?? 0.5);
    mtm += mark;
    if (x.quotes && (x.quotes.bid != null || x.quotes.ask != null)) quoted++;
    if (x.fills) rows.push({ t, fills: x.fills, inv: x.inv, cost: x.cost, pl: mark - (x.cost || 0), q: x.queue || {} });
  }
  const equity = S.equity ?? cfg.initialBalance;
  console.log(`MAKER DESK · ${cfg.mode.toUpperCase()}\n`);
  console.log(`  markets in the book       ${mk.length} (${quoted} currently quoting)`);
  console.log(`  fills                     ${fills}`);
  console.log(`  contracts held            ${Math.round(inv)}`);
  console.log(`  cash                      ${m(S.cash - cfg.initialBalance)} against $${cfg.initialBalance}`);
  console.log(`  inventory marked at mid   ${m(mtm)}   <- a MARK, not money; it is only real when it trades out`);
  console.log(`  equity                    ${m(equity - cfg.initialBalance)}`);
  if (S.halted) console.log(`  HALTED                    ${S.halted}`);
  if (!rows.length) return console.log('\n  no fills yet');
  rows.sort((a, b) => b.pl - a.pl);
  console.log(`\n  ticker                             fills    inv     paid      marked P&L   queue left`);
  for (const r of rows) console.log('  ' + r.t.padEnd(34) + String(r.fills).padStart(5) + String(Math.round(r.inv)).padStart(7)
    + m(r.cost).padStart(10) + m(r.pl).padStart(13) + `   ${Math.round(r.q.bid || 0)}/${Math.round(r.q.ask || 0)}`);
})();

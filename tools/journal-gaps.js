'use strict';
// The prediction-market desk's journal has two known holes, and this is the record of what went
// into them, so tools/ledger-check.js and tools/pnl-report.js can read past them.
//
// WHAT HAPPENED (audit 2026-10-15). The Fly box's /data filled to 100%: the tick tape wrote 852 MB in a
// day after #198's league listings (README, "the box's disk"). With no space left, the journal's appends
// failed. Two windows of lines never reached the disk:
//
//   W1  2026-10-15 00:00:09.952Z to 04:17:11.655Z: journal-2026-10-14.jsonl stops mid-line at the first
//       instant, and journal-2026-10-15.jsonl begins at the second.
//   W2  2026-10-16 00:31:39.876Z to 00:53:52.964Z: journal-2026-10-15.jsonl stops mid-line at the first
//       instant and picks up again at the second, after the rescue emptied the tape.
//
// The desk kept trading through both in memory, and state.json, saved once there was space again, holds
// the result. So from 10-15 on ledger-check rebuilt the journal and found it apart from the state at
// every line after: taker cash $383.24, fees $2.54, realised $198.39, 9 legs "open" that had settled, 3
// settlements of legs "never opened", 9 maker inventories, maker cash $71.33, 87 maker fills. All of it
// is the holes. Nothing was wrong with the books, and the check was red every day for it.
//
// WHAT IS RESTORED, AND FROM WHERE. Nothing is guessed, and the journal files are not touched: the box's
// journals stay exactly as written, and these are added beside them when a tool reads them.
//   - TAKER: every line the holes swallowed, rebuilt from the state's own record of each leg
//     (state.closed, which keeps the entry, cost, fee, exit time, proceeds and P&L of every closed leg):
//     3 OPENs (two at 00:00:10Z, the night's game bets, and one at 00:30Z) and 9 SETTLEs (the 10-14 game
//     bets that settled 02:20Z-03:54Z). Together they are the $383.24, the $2.54 and the $198.39 to the
//     cent. Each carries `restored: <gap id>` so nothing mistakes it for an original line.
//   - MAKER: individual fills cannot be rebuilt (the state keeps counts and totals, not fills). So one
//     MAKER_GAP line per window says what the window did to each market's inventory, read off the
//     journal's own fill lines: each fill line carries the inventory the maker held after it, and across
//     each window that number jumps from the replay's by a fixed amount, the same on every later line.
//     The maker's cash (+$71.33) and fill count (+87) the state holds beyond the journal cannot be split
//     between the two windows, so W2's line carries both. The lost fills' prices are unknown, so the
//     replay's average cost on those markets is not corrected: the maker's realised P&L by replay can sit
//     a little further from the state's, which ledger-check reports as a note, never a problem.
//
// A new hole would be added here the same way, from the box's state.json and the journals, after a
// check that the restored lines make ledger-check exact. tools/journal-gaps-test.js holds these to it.

const GAPS = [
  {
    id: 'disk-full-2026-10-15-w1',
    from: '2026-10-15T00:00:09.952Z',
    to: '2026-10-15T04:17:11.655Z',
    taker: [
      { t: '2026-10-15T00:00:09.951Z', kind: 'OPEN', id: 'mv8rvh0fkvl-KSn', group: 'mv8rvh0fkvl', pairId: '5429338:0|KXMLBGAME-26OCT152000MILLAD-MIL', label: 'MLB Brewers v Dodgers · Brewers', venue: 'KS', side: 'no', qty: 166, entry: 0.59, fee: 1.41, cost: 99.35, strategy: 'bet', ref: 'KXMLBGAME-26OCT152000MILLAD-MIL' },
      { t: '2026-10-15T00:00:10.057Z', kind: 'OPEN', id: 'mv8rvh3d5fv-PMn', group: 'mv8rvh3d5fv', pairId: '5348327:0|KXNCAAFGAME-26OCT15CSUTXST-CSU', label: 'NCAAF Colorado State v Texas State · Colorado State', venue: 'PM', side: 'no', qty: 118, entry: 0.84, fee: 0.48, cost: 99.6, strategy: 'bet', ref: '68892303358920224436774714116599355656172380111696983630953406756097783564792' },
      { t: '2026-10-15T00:30:10.137Z', kind: 'OPEN', id: 'mv8sy21l9ht-PMy', group: 'mv8sy21l9ht', pairId: '5446807:0|KXNBAGAME-26OCT15OKCHOU-OKC', label: 'NBA Thunder v Rockets · Thunder', venue: 'PM', side: 'yes', qty: 53, entry: 0.569, fee: 0.65, cost: 30.81, strategy: 'bet', ref: '3969172623434954539757907304583256063565722301005908204750343375565413826213' },
      // the nine settlements are filled in from SETTLES below
    ],
    maker: { inv: { 'SENATETX-26-R': 37, 'KXBLUETSUNAMICOMBO-27FEB': 27, 'KXPRESNOMR-28-MR': -14, 'KXPRESNOMD-28-GN': 13, 'KXNFLLASTTOLOSE-27-SF': 3, 'SENATEIA-26-R': -98, 'KXOSCARPIC-27-YOU': -90 }, cash: 0, fills: 0 },
  },
  {
    id: 'disk-full-2026-10-15-w2',
    from: '2026-10-16T00:31:39.876Z',
    to: '2026-10-16T00:53:52.964Z',
    taker: [],
    // cash and fills: both windows together (see the header)
    maker: { inv: { 'CONTROLS-2026-R': -68, 'KXNFLLASTTOLOSE-27-SF': -11, 'KXTRUMPADMINLEAVE-26DEC31-SWIL': -2 }, cash: 71.33, fills: 87 },
  },
];

// W1's nine settlements: each leg and its exit time, then its cost, P&L and reason, as state.closed has
// them. proceeds = cost + pnl (the cost already holds the entry fee; a settlement pays none).
const SETTLES = [
  ['mv7ohtlsyw3-PMn', '2026-10-15T02:20:10.977Z'], ['mv7ohtj1o8l-PMn', '2026-10-15T02:26:56.140Z'], ['mv7oi6af77x-KSn', '2026-10-15T02:48:40.409Z'],
  ['mv7oi65lr9x-PMn', '2026-10-15T02:54:57.045Z'], ['mv7oihoucvf-PMn', '2026-10-15T03:02:56.607Z'], ['mv7oihlux1w-PMy', '2026-10-15T03:13:10.903Z'],
  ['mv7oc60gl1n-KSn', '2026-10-15T03:16:55.463Z'], ['mv7oc63k6qg-PMy', '2026-10-15T03:24:12.018Z'], ['mv7ocj8tpiv-PMy', '2026-10-15T03:54:11.233Z'],
];
const SETTLE_FIGURES = {
  'mv7ohtlsyw3-PMn': { cost: 99.48, pnl: 31.52, reason: 'resolved NO' },
  'mv7ohtj1o8l-PMn': { cost: 99.4, pnl: 38.6, reason: 'resolved NO' },
  'mv7oi6af77x-KSn': { cost: 99.44, pnl: -99.44, reason: 'resolved YES' },
  'mv7oi65lr9x-PMn': { cost: 99.73, pnl: 31.27, reason: 'resolved NO' },
  'mv7oihoucvf-PMn': { cost: 99.49, pnl: -99.49, reason: 'resolved YES' },
  'mv7oihlux1w-PMy': { cost: 14.87, pnl: 12.13, reason: 'resolved YES' },
  'mv7oc60gl1n-KSn': { cost: 99.27, pnl: -99.27, reason: 'resolved YES' },
  'mv7oc63k6qg-PMy': { cost: 99.74, pnl: -99.74, reason: 'resolved NO' },
  'mv7ocj8tpiv-PMy': { cost: 99.97, pnl: 86.03, reason: 'resolved YES' },
};
const r2 = (x) => Math.round(x * 100) / 100;

// The restored lines, each with `restored`, in time order. A SETTLE takes the rest of its fields
// (group, pair, label, venue, side, qty, entry, strategy) from the leg's own OPEN in `events`, which the
// journal still has (those legs opened on 10-14), so the line reads the way the desk would have written it.
function restoredEvents(events = []) {
  const opens = new Map(events.filter((e) => e.kind === 'OPEN').map((e) => [e.id, e]));
  const out = [];
  for (const g of GAPS) {
    for (const e of g.taker) out.push({ ...e, mode: 'paper', restored: g.id });
    if (g.id === 'disk-full-2026-10-15-w1') {
      for (const [id, t] of SETTLES) {
        const o = opens.get(id) || {};
        const f = SETTLE_FIGURES[id];
        const proceeds = r2(f.cost + f.pnl);
        const exit = o.qty ? r2(proceeds / o.qty) : null;
        out.push({ t, mode: 'paper', kind: 'SETTLE', id, group: o.group || id.replace(/-[A-Z]{2}[yn]$/, ''), pairId: o.pairId, label: o.label, venue: o.venue, side: o.side,
          qty: o.qty, entry: o.entry, exit, fee: 0, proceeds, pnl: f.pnl, legPnl: f.pnl, reason: f.reason, strategy: o.strategy || 'bet', restored: g.id });
      }
    }
    // a millisecond before the first line after the window: the jump is in place for that line
    out.push({ t: new Date(Date.parse(g.to) - 1).toISOString(), mode: 'paper', kind: 'MAKER_GAP', inv: g.maker.inv, cash: g.maker.cash, fills: g.maker.fills, restored: g.id });
  }
  return out.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
}

// `events` (sorted by time, as readJournals returns them) with the restored lines merged in, but only
// for a journal that actually reaches past a hole: a fixture or an older archive stays as it was.
function withGaps(events) {
  const last = events.length ? Date.parse(events[events.length - 1].t) : -Infinity;
  const add = restoredEvents(events).filter((e) => Date.parse(e.t) <= last && GAPS.some((g) => g.id === e.restored && Date.parse(g.to) <= last));
  if (!add.length) return { events, restored: [] };
  return { events: [...events, ...add].sort((a, b) => Date.parse(a.t) - Date.parse(b.t)), restored: add };
}

module.exports = { GAPS, restoredEvents, withGaps };

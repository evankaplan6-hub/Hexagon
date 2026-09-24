'use strict';
// Every assertion in the repo, in one command: `npm test`.
//
// Each suite is a standalone script with its own exit code, so they can still be run one at a
// time while working on one file. This just runs them all and refuses to be quiet about a failure.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SUITES = [
  ['decide', 'the taker decision core: ranking, vetoes, sizing rails, exits'],
  ['probe', 'the thin-market probe: threshold, in-play exclusion, cooldown, darkness'],
  ['maker', 'the maker core: quoting, queue and fills, and the realised-P&L invariant'],
  ['makerdesk', "the maker's loop: a restart reposts, an empty universe waits, settlement, the dropped tail, reduce-only, the gain lock, cooling"],
  ['broker', 'fills: ladder walking, paper fees, and the live Kalshi order path'],
  ['fees', 'what each venue charges a taker: Polymarket per market, Kalshi per series, nothing assumed free'],
  ['matcher', 'cross-venue matching: names, dates, sports, the figure guard and the price guard'],
  ['match-any', 'any-market matching: the same person, party, deadline or threshold, and every near-miss rejected'],
  ['rules', 'the rules gate: pairs whose rules match, look-alikes that do not, and the cached Claude check'],
  ['discovery', 'the any-market crawl: both venues page by page, backoff, partial results kept, the registry'],
  ['anymarket', 'the any-market scanner: discover off the cycle, reprice in it, and only verified pairs trade'],
  ['stream', "the Kalshi trade socket: framing, trade shape, and the tape falling back to the poll; the dashboard's stream gzipped a frame at a time"],
  ['engine', 'the ledger: the operator latch, partial exits, and one close per position'],
  ['watchdog', 'the stall watchdog: a loop with no finished round is restarted, and a healthy desk, a sleep, or a live account never is'],
  ['brain', 'the minds: the proposal clamp, request shaping, cost metering and backoff'],
  ['lab', 'the strategy lab: fees, fills, settlement, and no strategy seeing the answer'],
  ['stock-lab', 'the ETF lab: next-open fills, costs per side, metric arithmetic, no peeking, no test data in the pick'],
  ['option-lab', 'the option lab: which contract a setting sells, a round sold at the bid and settled on the close, no peeking; the DoltHub fetcher'],
  ['chains', 'the chain tape: a 0 bid is not a missing one, adjusted roots, the band edges, an unchanged chain is not news, and a frozen feed is STALE and a PROBLEM'],
  ['chartexchange', 'the ChartExchange client and the option history: the key never leaks, pages by number, the calendar, the strike window, and nothing half-written'],
  ['chainsched', "the chain recorder's schedule on the box: three Eastern slots on weekdays, the DST switch, and the 14-day display copy"],
  ['makertape', "the maker's tape: book on change, prints once, our own quote, and a bad disk never reaches the desk"],
  ['whale', 'whale watch: what counts as a bet, said once across a restart, what copying pays'],
  ['http', "the Kalshi pacer: calls spaced apart, the maker's calls first, nothing else waits"],
  ['env', 'the .env reader: comments, quotes, and a # inside a password is part of the password'],
  ['ledger', 'the ledger check: the journal rebuilds the state exactly, and every drift is named'],
  ['disk', 'the box disk: pull copies and verifies before any delete, the brake only trims old tapes'],
  ['ask', 'the Ask panel: the tool loop, append-only chats, limits and budget, route locks, no secrets'],
  ['askui', "the Ask drawer's page code: the answer escaped before it is formatted, and when a chat is over"],
  ['volume', "the desk's own trading volume: what counts as a trade, minute buckets, and the rebuild from the journal"],
  ['chart', 'the dashboard chart: combined ledgers, exact time windows, a flat day that looks flat, history on an even clock'],
  ['weather-lab', 'the weather lab: whole-degree settlement maths, the per-city fit, the answer never shown to the strategy'],
  ['favorites-check', 'the favourites check: the rule fixed in advance, Sports excluded, a four-part verdict'],
  ['fillcheck', "the fill check: a round read in the desk's order, the queue, restarts, the warm-up day, and what a missed fill is put down to"],
  ['pnl-report', 'the P&L report: convergence, arbs from every leg, maker realised from the journals, today from box-now'],
  ['restarts', "the desk's lifecycle: START, STOP and CRASH in the journal, a restart nothing explains, and every reader passes them by"],
  ['lookout', 'the lookout page: the painted room, read-only, fed by the same stream as the floor'],
  ['themes', 'what a market is about: leagues off the series, the tickers that only look like one, and the page filter built on it'],
];

let failed = 0, totalPassed = 0;
// This is a list, not a glob, so each suite carries a line saying what it covers. The price is that
// a new tools/<name>-test.js nobody adds here would never run and nothing would say so (2026-09-24:
// the docs named 24 of the 36 suites and no one could tell from npm test). So a file with no entry
// fails the run, and so does an entry with no file.
const onDisk = fs.readdirSync(__dirname).filter((f) => /-test\.js$/.test(f)).map((f) => f.slice(0, -'-test.js'.length));
const listed = new Set(SUITES.map(([name]) => name));
for (const name of onDisk.filter((n) => !listed.has(n)).sort()) { failed++; console.log(`FAIL  ${name.padEnd(9)} tools/${name}-test.js exists but is not in SUITES in tools/test.js, so it never ran`); }
for (const [name, what] of SUITES) {
  const file = path.join(__dirname, `${name}-test.js`);
  let out = '', code = 0;
  try { out = execFileSync(process.execPath, [file], { encoding: 'utf8' }); }
  catch (e) { out = `${e.stdout || ''}${e.stderr || ''}`; code = e.status == null ? 1 : e.status; }
  const tail = out.trim().split('\n').filter(Boolean).pop() || '(no output)';
  const m = tail.match(/^(\d+) passed, (\d+) failed$/);
  if (m) totalPassed += +m[1];
  // a suite that exits 0 without its summary line stopped early (a promise nobody resolved) and
  // asserted less than it claims: that is a failure, not a pass
  if (code === 0 && !m) code = 1;
  if (code !== 0) {
    failed++;
    console.log(`FAIL  ${name.padEnd(9)} ${tail}`);
    console.log(out.split('\n').filter((l) => /^\s+FAIL/.test(l) || /^\s+got:/.test(l)).join('\n'));
  } else {
    console.log(`ok    ${name.padEnd(9)} ${String(m ? m[1] : '?').padStart(3)} assertions  ${what}`);
  }
}

// golden is a diff harness, not an assertion suite: it must merely run clean.
try { execFileSync(process.execPath, [path.join(__dirname, 'golden.js')], { encoding: 'utf8' }); console.log('ok    golden      fixed-fixture output (diff it by hand after a refactor)'); }
catch (e) { failed++; console.log(`FAIL  golden      ${(e.stderr || e.stdout || '').trim().split('\n').pop()}`); }

console.log(`\n${totalPassed} assertions across ${SUITES.length} suites · ${failed ? `${failed} SUITE(S) FAILED` : 'all green'}`);
process.exit(failed ? 1 : 0);

'use strict';
// Every assertion in the repo, in one command: `npm test`.
//
// Each suite is a standalone script with its own exit code, so they can still be run one at a
// time while working on one file. This just runs them all and refuses to be quiet about a failure.
const { execFileSync } = require('child_process');
const path = require('path');

const SUITES = [
  ['decide', 'the taker decision core: ranking, vetoes, sizing rails, exits'],
  ['probe', 'the thin-market probe: threshold, in-play exclusion, cooldown, darkness'],
  ['maker', 'the maker core: quoting, queue and fills, and the realised-P&L invariant'],
  ['broker', 'fills: ladder walking, paper fees, and the live Kalshi order path'],
  ['fees', 'what each venue charges a taker: Polymarket per market, Kalshi per series, nothing assumed free'],
  ['matcher', 'cross-venue matching: names, dates, sports, the figure guard and the price guard'],
  ['match-any', 'any-market matching: the same person, party, deadline or threshold, and every near-miss rejected'],
  ['rules', 'the rules gate: pairs whose rules match, look-alikes that do not, and the cached Claude check'],
  ['discovery', 'the any-market crawl: both venues page by page, backoff, partial results kept, the registry'],
  ['anymarket', 'the any-market scanner: discover off the cycle, reprice in it, and only verified pairs trade'],
  ['stream', 'the Kalshi trade socket: framing, trade shape, and the tape falling back to the poll'],
  ['engine', 'the ledger: the operator latch, partial exits, and one close per position'],
  ['brain', 'the minds: the proposal clamp, request shaping, cost metering and backoff'],
  ['lab', 'the strategy lab: fees, fills, settlement, and no strategy seeing the answer'],
  ['stock-lab', 'the ETF lab: next-open fills, costs per side, metric arithmetic, no peeking, no test data in the pick'],
  ['whale', 'whale watch: what counts as a bet, said once across a restart, what copying pays'],
  ['http', "the Kalshi pacer: calls spaced apart, the maker's calls first, nothing else waits"],
  ['disk', 'the box disk: pull copies and verifies before any delete, the brake only trims old tapes'],
  ['ask', 'the Ask panel: the tool loop, append-only chats, limits and budget, route locks, no secrets'],
  ['askui', "the Ask drawer's page code: the answer escaped before it is formatted, and when a chat is over"],
];

let failed = 0, totalPassed = 0;
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

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
  ['matcher', 'cross-venue matching: names, dates, sports, and the price-agreement guard'],
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

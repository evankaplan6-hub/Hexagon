'use strict';
// Assertions for src/loginguard.js: ten wrong passwords in ten minutes turn a client away; others and time forgive.
//
//   node tools/loginguard-test.js
const { loginGuard } = require('../src/loginguard');
let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; return; } fail++; console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); };

let t = 1e9;
const g = loginGuard({ now: () => t });
for (let i = 0; i < 9; i++) g.fail('1.1.1.1');
ok('nine wrong passwords: still allowed to try', !g.blocked('1.1.1.1'));
g.fail('1.1.1.1');
ok('the tenth turns the client away', g.blocked('1.1.1.1'));
ok('another address is not affected', !g.blocked('2.2.2.2'));
ok('and is told how long to wait', g.retryAfterSec('1.1.1.1') > 0 && g.retryAfterSec('1.1.1.1') <= 600, g.retryAfterSec('1.1.1.1'));
t += 11 * 60 * 1000;
ok('ten minutes on, it may try again', !g.blocked('1.1.1.1') && g.retryAfterSec('1.1.1.1') === 0);
for (let i = 0; i < 5; i++) g.fail('3.3.3.3');
g.ok('3.3.3.3');
for (let i = 0; i < 9; i++) g.fail('3.3.3.3');
ok('a right password clears the count', !g.blocked('3.3.3.3'));
const big = loginGuard({ now: () => t });
for (let i = 0; i < 6000; i++) big.fail(`ip${i}`);
t += 11 * 60 * 1000; big.fail('x');
ok('a flood of addresses is forgotten once its window passes', !big.blocked('ip1'));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

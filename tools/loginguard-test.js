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
// 2026-10-16 audit: a flood inside the window once made every failure walk the whole map, and kept every address
const flood = loginGuard({ now: () => t, cap: 1000 });
const t0 = process.hrtime.bigint();
for (let i = 0; i < 50000; i++) flood.fail(`f${i}`);
const ms = Number(process.hrtime.bigint() - t0) / 1e6;
ok('50,000 addresses inside the window: the map stays at its cap', flood.size() === 1000, flood.size());
ok('...and costs no more than a straight run (under a second here; quadratic took 15s for 20,000)', ms < 1000, ms);
ok('...the newest are kept, the oldest let go', flood.blocked('f49999') === false && flood.size() === 1000 && (() => { for (let i = 0; i < 9; i++) flood.fail('f49999'); return flood.blocked('f49999'); })());

// server.js cannot be required without starting a desk, so its wiring is pinned from the source (2026-10-16 audit)
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'server.js'), 'utf8');
  const post = src.slice(src.indexOf("if (req.method === 'POST') {"), src.indexOf("if (req.method === 'POST') {") + 600);
  ok('the form login checks the throttle again once its body is in, before any password is compared', /readBody\(req\)\.then\(\(body\) => \{[\s\S]*?if \(guard\.blocked\(who\)\) return tooMany\(\);[\s\S]*?timingEq\(f\.get\('u'\)/.test(post));
  ok('the login page does not hand out the user name', !/name="u" value=/.test(src));
  ok('a link on another site cannot sign the desk out', /p === '\/logout'\) \{\s*\/\/[^\n]*\n\s*if \(req\.headers\['sec-fetch-site'\] === 'cross-site'\)/.test(src));
  ok('pages may load script only from the site, and https is kept for a year', /"script-src 'self'"/.test(src) && /"default-src 'self'"/.test(src) && /strict-transport-security', 'max-age=31536000'/.test(src));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

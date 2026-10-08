'use strict';
// Assertions for src/session.js and the stream's backpressure in src/sse.js -- no network, no wall clock.
//
// The login cookie used to be one fixed value valid for as long as the password stood; it now carries its own
// expiry and an epoch. The throttle key used to be a header anyone could set. And a stream client that stopped
// reading used to grow the box's memory without bound. Each of those is asserted here.
//
//   node tools/session-test.js
const { PassThrough } = require('stream');
const session = require('../src/session');
const sse = require('../src/sse');

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; return; } fail++; console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); };
const group = (n) => console.log(`\n${n}`);
const DAY = 86400000;

group('the login cookie');
{
  const t0 = 1.8e12;
  const tok = session.issue('pw', '', t0);
  ok('a fresh cookie is valid', session.valid('pw', '', tok, t0 + 1000));
  ok('...and still is 29 days on', session.valid('pw', '', tok, t0 + 29 * DAY));
  ok('...and is not after 30 days', !session.valid('pw', '', tok, t0 + 30 * DAY + 1), tok);
  ok('a different password does not open it', !session.valid('other', '', tok, t0 + 1000));
  ok('a different SESSION_EPOCH does not open it (the sign-everyone-out switch)', !session.valid('pw', '2', tok, t0 + 1000));
  ok('the same epoch does', session.valid('pw', '2', session.issue('pw', '2', t0), t0 + 1000));
  const [exp, mac] = tok.split('.');
  ok('pushing the expiry out by hand breaks the signature', !session.valid('pw', '', `${Number(exp) + 365 * DAY}.${mac}`, t0 + 1000));
  ok('so does cutting the signature short', !session.valid('pw', '', `${exp}.${mac.slice(0, 40)}`, t0 + 1000));
  ok('the old fixed-string cookie is no longer accepted', !session.valid('pw', '', 'a'.repeat(64), t0));
  ok('nothing, or junk, is not a session', !session.valid('pw', '', '', t0) && !session.valid('pw', '', undefined, t0) && !session.valid('pw', '', '1.2.3', t0));
  ok('two logins at different moments give different cookies', session.issue('pw', '', t0) !== session.issue('pw', '', t0 + 1000));
  const line = session.setCookie('hexsession', tok, true);
  ok('the cookie is HttpOnly, Secure behind https, and lasts 30 days', /HttpOnly/.test(line) && /; Secure/.test(line) && /Max-Age=2592000/.test(line), line);
  ok('on plain http it is not marked Secure', !/Secure/.test(session.setCookie('hexsession', tok, false)));
  ok('logging out clears it', /^hexsession=;/.test(session.setCookie('hexsession', '', false)) && /Max-Age=0/.test(session.setCookie('hexsession', '', false)));
}

group('which address a login attempt is counted against');
{
  const req = (ip, fly) => ({ headers: fly ? { 'fly-client-ip': fly } : {}, socket: { remoteAddress: ip } });
  ok('off Fly, the typed header is ignored and the socket is used', session.clientKey(req('10.0.0.5', '9.9.9.9'), {}) === '10.0.0.5');
  ok('on Fly, the proxy\'s header is the client', session.clientKey(req('172.16.0.1', '9.9.9.9'), { FLY_MACHINE_ID: 'abc' }) === '9.9.9.9');
  ok('on Fly with no header, the socket', session.clientKey(req('172.16.0.1'), { FLY_MACHINE_ID: 'abc' }) === '172.16.0.1');
  ok('a request with nothing is an empty key, not a crash', session.clientKey({ headers: {} }, {}) === '');
}

group('a stream client that stops reading');
{
  // plain: a response whose buffer never drains
  const mk = () => { const res = new PassThrough({ highWaterMark: 16 }); res.writeHead = () => {}; return res; };
  const big = sse.frame({ x: 'y'.repeat(200 * 1024) });
  const res = mk();
  const c = sse.openStream({ headers: {} }, res);
  let sent = 0;
  for (let i = 0; i < 20; i++) if (c.send(big)) sent++;
  ok('frames are sent until about 1 MB is waiting, then dropped', sent >= 5 && sent <= 7, sent);
  ok('the buffer stops growing near the cap', c.waiting() < sse.MAX_BUFFERED + 300 * 1024, c.waiting());
  ok('a client that has not been cut off yet is still open', !res.destroyed);
  for (let i = 0; i < sse.DROP_LIMIT; i++) c.send(big);
  ok('after DROP_LIMIT dropped frames in a row it is cut off', res.destroyed);

  // it drains: sending resumes and the count of dropped frames starts over
  const res2 = mk();
  const c2 = sse.openStream({ headers: {} }, res2);
  for (let i = 0; i < 10; i++) c2.send(big);
  ok('over the cap, a frame is refused', c2.send(big) === false);
  res2.resume();                                            // the client reads again
  const later = () => new Promise((r) => setImmediate(r));
  (async () => {
    await later(); await later();
    ok('once it reads again, frames go through', c2.send('data: 1\n\n') === true, c2.waiting());
    ok('...and it was not cut off', !res2.destroyed);

    // gzip: the compressor's own queue counts too
    const res3 = mk();
    const c3 = sse.openStream({ headers: { 'accept-encoding': 'gzip' } }, res3);
    const noise = () => sse.frame({ x: require('crypto').randomBytes(150 * 1024).toString('hex') });
    let n = 0;
    for (let i = 0; i < 40; i++) { c3.send(noise()); n++; }
    ok('a gzip client that stops reading is held to a few MB, not 40 frames of 300 KB', c3.waiting() < 4 * 1024 * 1024, c3.waiting());
    c3.close();

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

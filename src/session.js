'use strict';
// The dashboard's login cookie, and the address a login attempt is counted against.
//
// The cookie used to be an HMAC of a fixed string under DASH_PASS: the same value on every login, good
// for as long as the password stood, with no way to sign out (audit 2026-10-07). It is now
// "<expiry ms>.<hmac of the expiry>", so each one dies on its own 30 days after the login that made it,
// and SESSION_EPOCH (any string; a Fly secret) is mixed in, so changing it signs every browser out at once
// without changing the password. Still no session store to keep.
const crypto = require('crypto');

const DAYS = 30;
const DAY_MS = 86400000;

function timingEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

const mac = (pass, epoch, exp) => crypto.createHmac('sha256', pass).update(`hexagon-session-v2|${epoch}|${exp}`).digest('hex');

// A new cookie value, good for DAYS days from `now`.
function issue(pass, epoch = '', now = Date.now()) {
  const exp = now + DAYS * DAY_MS;
  return `${exp}.${mac(pass, epoch, exp)}`;
}

// Is this cookie value one `issue` made under this password and epoch, and not yet expired?
function valid(pass, epoch = '', token, now = Date.now()) {
  const m = /^(\d{1,15})\.([0-9a-f]{64})$/.exec(String(token || ''));
  if (!m) return false;
  const exp = Number(m[1]);
  return exp > now && timingEq(m[2], mac(pass, epoch, exp));
}

// The Set-Cookie line: HttpOnly, and Secure behind Fly's https. No token clears the cookie.
function setCookie(name, token, secure) {
  const flags = `Path=/; HttpOnly; SameSite=Lax${secure ? '; Secure' : ''}`;
  return token ? `${name}=${token}; ${flags}; Max-Age=${DAYS * 86400}` : `${name}=; ${flags}; Max-Age=0`;
}

// The address a request is counted against. Fly puts the real one in Fly-Client-IP, and its proxy is the
// only thing that may be believed about that header: anywhere else (the Mac, a test) it is whatever the
// caller typed, and trusting it let a guesser change address with every attempt. FLY_MACHINE_ID is set
// in every Fly machine.
function clientKey(req, env = process.env) {
  const fly = env.FLY_MACHINE_ID && req.headers && req.headers['fly-client-ip'];
  return String(fly || (req.socket && req.socket.remoteAddress) || '');
}

module.exports = { DAYS, timingEq, issue, valid, setCookie, clientKey };

'use strict';
// A throttle for the login page: the dashboard is on the public internet (Fly) and the password is the
// only lock, so a client that keeps getting it wrong is turned away for a while. Per client address, a
// sliding window; a right password does not count and is never blocked by someone else's wrong ones.
function loginGuard({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now } = {}) {
  const fails = new Map();                      // key -> [times of recent failures]
  const recent = (key) => {
    const t = now(), list = (fails.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) fails.set(key, list); else fails.delete(key);
    return list;
  };
  return {
    blocked: (key) => recent(key).length >= max,
    fail(key) {
      const list = recent(key); list.push(now()); fails.set(key, list);
      if (fails.size > 5000) for (const k of fails.keys()) recent(k);     // keep the map small under a flood
    },
    ok: (key) => { fails.delete(key); },
    retryAfterSec(key) { const l = recent(key); return l.length >= max ? Math.max(1, Math.ceil((windowMs - (now() - l[l.length - max])) / 1000)) : 0; },
  };
}
module.exports = { loginGuard };

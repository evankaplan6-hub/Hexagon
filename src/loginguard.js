'use strict';
// A throttle for the login page: the dashboard is on the public internet (Fly) and the password is the
// only lock, so a client that keeps getting it wrong is turned away for a while. Per client address, a
// sliding window; a right password does not count and is never blocked by someone else's wrong ones.
// The map is held to `cap` addresses, oldest failure out first, and swept once a minute. Until 2026-10-16 every
// failure past 5,000 addresses walked the whole map, and an address still in its window was never dropped: a
// flood of wrong logins from many addresses (an IPv6 block has more than enough) cost about 2ms each at 20,000,
// on a box with an eighth of a core, enough to stall the desk's loops until the watchdog restarted it.
function loginGuard({ max = 10, windowMs = 10 * 60 * 1000, now = Date.now, cap = 10000 } = {}) {
  const fails = new Map();                      // key -> [times of recent failures], in order of the last one
  let swept = now();
  const recent = (key) => {
    const t = now(), list = (fails.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length) fails.set(key, list); else fails.delete(key);
    return list;
  };
  return {
    blocked: (key) => recent(key).length >= max,
    fail(key) {
      const list = recent(key); list.push(now());
      fails.delete(key); fails.set(key, list);  // to the end: the map's first key is the stalest
      if (now() - swept >= 60000) { swept = now(); for (const k of [...fails.keys()]) recent(k); }
      while (fails.size > cap) fails.delete(fails.keys().next().value);
    },
    size: () => fails.size,
    ok: (key) => { fails.delete(key); },
    retryAfterSec(key) { const l = recent(key); return l.length >= max ? Math.max(1, Math.ceil((windowMs - (now() - l[l.length - max])) / 1000)) : 0; },
  };
}
module.exports = { loginGuard };

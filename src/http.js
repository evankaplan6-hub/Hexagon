'use strict';
// Tiny fetch wrapper with timeout + error accounting (used by TESS for health checks).
const stats = { ok: 0, err: 0, lastError: '', recent: [], throttled: 0 };

function noteError(e) {
  stats.err++;
  stats.lastError = String(e && e.message || e).slice(0, 160);
  stats.recent.push(Date.now());
  if (stats.recent.length > 200) stats.recent.splice(0, stats.recent.length - 200);
}
function recentErrors(windowMs = 5 * 60 * 1000) {
  const cut = Date.now() - windowMs;
  stats.recent = stats.recent.filter((t) => t > cut);
  return stats.recent.length;
}

// Kalshi's calls take turns.
//
// Every 15 seconds the taker fires all eleven Kalshi series listings at once, and the maker polls
// the tape and the book every two. Kalshi answers each call in well under 100ms from the box, but
// when a maker round landed inside that burst it was refused (429), backed off 0.4s and 1.6s, and
// took 2.1s instead of 0.07s. Every slow requote on 2026-09-13 started inside the same four seconds
// of the taker's cycle, and the same collisions ran 5-28 refused calls per five minutes -- enough
// to trip TESS's halt from 17:27 to 17:39. Kalshi documents its budget only for keyed accounts; the
// box calls without a key, so the spacing is a knob (KALSHI_GAP_MS), not a published number.
//
// A pacer spaces the START of each call to one host by at least `gapMs`. Two lanes: `priority`
// calls (the maker's tape and book, where a stale second is money) go ahead of anything queued,
// but never closer together than the gap -- jumping the queue must not recreate the burst.
// `now` and `sleep` are injectable so tools/http-test.js can assert it without a clock.
function makePacer({ gapMs, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) }) {
  const urgent = [], normal = [];
  let nextAt = 0, pumping = false;
  async function pump() {
    if (pumping) return;
    pumping = true;
    try {
      while (urgent.length || normal.length) {
        const wait = nextAt - now();
        // re-pick after waking: a priority call that arrived during the wait goes first
        if (wait > 0) { await sleep(wait); continue; }
        const go = urgent.length ? urgent.shift() : normal.shift();
        nextAt = now() + gapMs;
        go();
      }
    } finally { pumping = false; }
  }
  function take(priority = false) {
    if (!(gapMs > 0)) return Promise.resolve();
    return new Promise((resolve) => {
      (priority ? urgent : normal).push(resolve);
      pump();
    });
  }
  return { take, queued: () => urgent.length + normal.length };
}

const pacers = new Map();   // host -> pacer
// Called once from engine.start, never at require time, so no test that builds an engine is paced.
// `clock` ({ now, sleep }) is for tests only.
function paceHost(base, gapMs, clock = {}) {
  const host = new URL(base).host;
  if (gapMs > 0) pacers.set(host, makePacer({ gapMs, ...clock })); else pacers.delete(host);
}

// A turn in a host's queue without making the call through getJSON: the any-market crawl uses its
// own fetch (its errors must not feed TESS's halt) but must still take turns with everything else,
// or its pages land between the maker's calls and get everyone refused.
async function takeTurn(url, priority = false) {
  const pacer = pacers.size ? pacers.get(new URL(url).host) : null;
  if (pacer) await pacer.take(priority);
}

// A refused call (HTTP 429) is a throttle, not an outage, and it is usually over in well under a
// second. It used to count toward TESS's error halt the instant it happened, and the maker retries a
// 429 up to three times -- so one crowded moment could count as three errors, and on the evening of
// 2026-09-15 the box ran 15-38 of them per five minutes and halted new trades again and again. A 429
// now waits what Kalshi asks (Retry-After, held to 0.5-2s), takes a fresh turn in the queue, and is
// tried once more; only if that is refused too does it count. Timeouts and every other failure count
// at once, as before: those are what the halt is for.
const RETRY_MIN_MS = 500, RETRY_MAX_MS = 2000;

// Calls that have started and not finished. Only for the stall watchdog's report: when the desk
// freezes, the first question is whether a request is stuck (and for how long, against a 15s
// timeout) or nothing is waiting on the network at all.
const calls = new Set();
function inflight(now = Date.now(), n = 5) {
  return [...calls]
    .map((c) => ({ url: c.url.slice(0, 110), phase: c.phase, ageSec: Math.round((now - c.since) / 1000) }))
    .sort((a, b) => b.ageSec - a.ageSec)
    .slice(0, n);
}
const queued = () => [...pacers.values()].reduce((n, p) => n + p.queued(), 0);

async function getJSON(url, { timeout = 15000, priority = false, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let attempt = 0; ; attempt++) {
    const call = { url, since: Date.now(), phase: 'queue' };
    calls.add(call);
    // wait for our turn BEFORE the timeout starts, or a queued call would spend its timeout in line
    await takeTurn(url, priority);
    call.phase = 'fetch';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    let retryAfter = null;
    try {
      const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
      if (!r.ok) {
        // A refusal still has a body, and nothing here reads it. Left unread it holds its connection
        // until the garbage collector gets to it -- and a 429 is answered by calling the same host
        // again half a second later, which is when a free connection is wanted. Let it go now.
        try { if (r.body && typeof r.body.cancel === 'function') await r.body.cancel(); } catch { /* it was only ever being thrown away */ }
        const err = new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
        err.status = r.status;
        if (r.status === 429 && attempt === 0) {
          const ra = Number(r.headers && typeof r.headers.get === 'function' ? r.headers.get('retry-after') : NaN);
          retryAfter = Math.min(RETRY_MAX_MS, Math.max(RETRY_MIN_MS, Number.isFinite(ra) ? ra * 1000 : 0));
          stats.throttled++;
        } else {
          throw err;
        }
      } else {
        const j = await r.json();
        stats.ok++;
        return j;
      }
    } catch (e) {
      noteError(e);
      throw e;
    } finally {
      clearTimeout(timer);
      calls.delete(call);
    }
    await sleep(retryAfter);
  }
}

module.exports = { getJSON, stats, noteError, recentErrors, makePacer, paceHost, takeTurn, inflight, queued };

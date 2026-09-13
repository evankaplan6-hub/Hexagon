'use strict';
// Tiny fetch wrapper with timeout + error accounting (used by TESS for health checks).
const stats = { ok: 0, err: 0, lastError: '', recent: [] };

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

async function getJSON(url, { timeout = 15000, priority = false } = {}) {
  // wait for our turn BEFORE the timeout starts, or a queued call would spend its timeout in line
  const pacer = pacers.size ? pacers.get(new URL(url).host) : null;
  if (pacer) await pacer.take(priority);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const r = await fetch(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0' } });
    if (!r.ok) throw new Error(`HTTP ${r.status} ${url.slice(0, 90)}`);
    const j = await r.json();
    stats.ok++;
    return j;
  } catch (e) {
    noteError(e);
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { getJSON, stats, noteError, recentErrors, makePacer, paceHost };

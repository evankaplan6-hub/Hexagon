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

async function getJSON(url, { timeout = 15000 } = {}) {
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

module.exports = { getJSON, stats, noteError, recentErrors };

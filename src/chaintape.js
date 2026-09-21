'use strict';
// Reading the chain tape back, for the dashboard's Options and Stocks tabs (/api/chains).
//
// The tape (tools/chain-record.js) is append-only and grows by ~1.8 MB a snapshot, so the page
// cannot parse the whole file per request and must never try: by the spring a day's file is tens of
// megabytes and the desk's cycle would stall behind it. So this reads the TAIL only -- the last
// `maxBytes` -- and walks the lines backwards, keeping the first time it sees each symbol-expiry.
// Backwards is what makes the bound safe: the newest lines are at the end, so a tail that holds one
// full snapshot holds the answer, and a tail that holds three holds it sooner.
//
// It is read-only and never writes, locks, or trims the tape. A partial first line (the tail cut
// mid-line) is dropped rather than repaired.
const fs = require('fs');
const path = require('path');

const FILE = /^chains-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const TAIL_BYTES = 6 * 1024 * 1024;   // ~3 snapshots of the six-symbol universe

// Newest tape file in the directory, by the date in its name. Names are fixed-width, so name order
// is date order. Null when the folder has no tape yet -- a desk that has never recorded.
function latestFile(dir, { io = fs } = {}) {
  let best = null;
  let names;
  try { names = io.readdirSync(dir); } catch { return null; }
  for (const name of names) {
    const m = FILE.exec(name);
    if (m && (!best || m[1] > best.day)) best = { name, day: m[1] };
  }
  return best;
}

// Read the last `maxBytes` of a file as text. Returns '' for anything unreadable: the tab shows
// "no tape yet" rather than the desk taking an exception over a dashboard panel.
function tail(file, { io = fs, maxBytes = TAIL_BYTES } = {}) {
  let fd = null;
  try {
    const size = io.statSync(file).size;
    const from = Math.max(0, size - maxBytes);
    const len = size - from;
    if (!(len > 0)) return '';
    const buf = Buffer.allocUnsafe(len);
    fd = io.openSync(file, 'r');
    io.readSync(fd, buf, 0, len, from);
    const text = buf.toString('utf8');
    // a tail that starts mid-line: drop the fragment, it is not parseable and never the newest
    return from > 0 ? text.slice(text.indexOf('\n') + 1) : text;
  } catch { return ''; }
  finally { if (fd !== null) { try { io.closeSync(fd); } catch { /* already gone */ } } }
}

// ------------------------------------------------------------------ pure: tape text → what a tab shows
// Walks lines newest-first and keeps the first sighting of each symbol+expiry, which is that
// expiry's latest state. `atm` is the strike nearest spot on the nearest expiry -- the one number a
// person actually reads off an option chain.
function summarize(text, { now = Date.now() } = {}) {
  const lines = String(text || '').split('\n');
  const seen = new Map();          // `${sym}|${exp}` -> row
  const bySym = new Map();
  const snapshots = new Set();
  let cols = null, header = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l[0] !== '{') continue;
    let r;
    try { r = JSON.parse(l); } catch { continue; }
    if (r.cols) { cols = r.cols; header = { band: r.band, maxDte: r.maxDte, source: r.source, v: r.v }; continue; }
    if (!r.sym || !r.exp) continue;
    snapshots.add(r.t);
    const key = `${r.sym}|${r.exp}`;
    if (seen.has(key)) continue;
    seen.set(key, r);
    let s = bySym.get(r.sym);
    // the first row seen for a symbol is its newest, so its spot and times are the symbol's
    if (!s) bySym.set(r.sym, (s = { sym: r.sym, spot: r.spot, sb: r.sb, sa: r.sa, at: r.t, qt: r.qt, h: r.h, expiries: [], contracts: 0 }));
    s.expiries.push({ exp: r.exp, dte: r.dte, c: (r.c || []).length, p: (r.p || []).length });
    s.contracts += (r.c || []).length + (r.p || []).length;
    // nearest expiry wins the atm strip; rows arrive newest-first but in no expiry order
    if (!s._atmDte || (Number.isFinite(r.dte) && r.dte < s._atmDte)) {
      const near = pickAtm(r);
      if (near) { s.atm = near; s._atmDte = r.dte; }
    }
  }
  const symbols = [...bySym.values()].map((s) => {
    delete s._atmDte;
    s.expiries.sort((a, b) => (a.exp < b.exp ? -1 : 1));
    return s;
  }).sort((a, b) => (a.sym < b.sym ? -1 : 1));
  return { cols, header, symbols, snapshots: snapshots.size, at: now };
}

// The strike nearest spot, with both sides of it. Columns are positional (src/venues/cboe.js
// CHAIN_COLS): k, bid, bidSz, ask, askSz, last, iv, delta, ... -- indexes 0,1,3,6,7.
function pickAtm(r) {
  const spot = r.spot;
  if (!(spot > 0) || !Array.isArray(r.c) || !r.c.length) return null;
  const near = (rows) => rows && rows.length
    ? rows.reduce((b, x) => (b === null || Math.abs(x[0] - spot) < Math.abs(b[0] - spot) ? x : b), null) : null;
  const c = near(r.c);
  if (!c) return null;
  // the put at the SAME strike as the chosen call, so the pair is comparable; null when unlisted
  const p = (r.p || []).find((x) => x[0] === c[0]) || null;
  const side = (x) => (x ? { bid: x[1], ask: x[3], iv: x[6], delta: x[7], oi: x[13], vol: x[14] } : null);
  return { exp: r.exp, dte: r.dte, k: c[0], call: side(c), put: side(p) };
}

// The whole read: newest tape file in `dir`, tail of it, summarized.
function read(dir, { io = fs, maxBytes = TAIL_BYTES, now = Date.now } = {}) {
  const f = latestFile(dir, { io });
  if (!f) return { ok: false, why: 'no tape yet', dir, symbols: [], snapshots: 0 };
  const file = path.join(dir, f.name);
  let bytes = 0;
  try { bytes = io.statSync(file).size; } catch { /* reported as 0 */ }
  const out = summarize(tail(file, { io, maxBytes }), { now: now() });
  return { ok: !!out.symbols.length, day: f.day, file: f.name, dir, bytes, ...out };
}

module.exports = { read, summarize, latestFile, tail, pickAtm, FILE, TAIL_BYTES };

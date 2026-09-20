'use strict';
// Discovery: every open market on both venues, outside sports, in a shape the matcher can pair.
//
// The desk's fast path lists eleven Kalshi series and the top Polymarket markets every 15 seconds,
// which is why it only ever paired games and Fed brackets. Phase 2 walks the WHOLE open listing of
// each venue, slowly and off the cycle (every DISCOVER_EVERY_MIN), and hands the result to
// src/match-any.js. Nothing here trades or prices; it only finds.
//
// Three things shaped it, all measured 2026-09-14/15:
//   - Size. Kalshi's open event listing is 64 pages of 200 events, 12,671 events and ~118k nested
//     markets (75k two-sided), and one page is ~3.7 MB decoded. The box has 512 MB, so each page is
//     normalized and filtered BEFORE the next is requested and no raw page is ever held.
//   - Failure must be harmless. A refused or slow crawl must never feed TESS's API-error halt, so
//     this does not go through src/http.js (see makeDiscoveryFetch), and a page that keeps failing
//     ends the crawl with what it has and `complete: false` -- the caller keeps its last good result.
//   - The rules decide whether a pair may trade (src/rules.js), so each record carries its rules
//     text, clipped to keep the registry small, plus a hash of the FULL text: a verdict is cached by
//     the pair of hashes and must be re-read the moment either venue edits a word.
//
// Pure where it can be: the normalizers do no I/O, and the crawlers reach the network only through
// the injected `getJSON` and wait only through the injected `sleep`, so tools/discovery-test.js runs
// with no network and no clock.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const kalshi = require('./venues/kalshi');
const polymarket = require('./venues/polymarket');

const KS_EVENTS = `${kalshi.BASE}/events?status=open&with_nested_markets=true&limit=200`;
const PM_EVENTS = 'https://gamma-api.polymarket.com/events?closed=false&active=true&order=volume24hr&ascending=false&limit=100';
const PM_PAGE = 100;        // Gamma caps `limit` at 100 whatever you ask for

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const sha1 = (s) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const defaultSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A clipped copy that does not pin the original. V8 may keep a slice as a view onto its parent
// string, so 75k "clipped" rules texts could quietly hold every full text alive; the round trip
// through a Buffer makes a fresh string of just the kept part.
function clip(s, n) {
  s = s == null ? '' : String(s);
  return s.length <= n ? s : Buffer.from(s.slice(0, n), 'utf8').toString('utf8');
}

// ---------------------------------------------------------------- Kalshi

// The category an event belongs to. The SERIES category wins when known because the two disagree
// and the series is the one Kalshi maintains: 11 of the first 200 open events on 2026-09-15 did
// (KXNEXTDNCCHAIR events say Politics, the series says Elections; KXWARSHOUT Politics vs Economics).
function ksCategory(ev, seriesInfo) {
  const si = seriesInfo && ev && ev.series_ticker ? seriesInfo.get(ev.series_ticker) : null;
  return (si && si.category) || (ev && ev.category) || null;
}

// One event from GET /events?status=open&with_nested_markets=true -> KS market records.
// Keeps markets that are open and two-sided. "Open" events still nest finalized markets (a player's
// already-settled retirement year), and Kalshi reports an empty book as yes_bid 0.0000 / yes_ask
// 1.0000, so both checks are needed.
function normalizeKsEvent(ev, seriesInfo) {
  if (!ev || !Array.isArray(ev.markets)) return [];
  // From the EVENT, never parsed out of the market ticker: 92 open market tickers do not even start
  // with their event ticker, and 151 series tickers contain a hyphen themselves.
  const seriesTicker = ev.series_ticker || null;
  const category = ksCategory(ev, seriesInfo);
  const out = [];
  for (const m of ev.markets) {
    if (!m || m.status !== 'active') continue;
    const bid = num(m.yes_bid_dollars), ask = num(m.yes_ask_dollars);
    if (bid == null || ask == null || !(bid > 0 && ask < 1 && ask >= bid)) continue;
    const base = kalshi.normalize(m);
    const primary = m.rules_primary || '', secondary = m.rules_secondary || '';
    out.push({
      ...base,
      eventTicker: m.event_ticker || ev.event_ticker || null,
      seriesTicker,
      category,
      eventTitle: ev.title || '',
      eventSubTitle: ev.sub_title || '',
      yesSubTitle: m.yes_sub_title || '',
      strikeType: m.strike_type || null,
      floorStrike: num(m.floor_strike),
      capStrike: num(m.cap_strike),
      customStrike: m.custom_strike && typeof m.custom_strike === 'object' ? m.custom_strike : null,
      mutuallyExclusive: !!ev.mutually_exclusive,
      rulesPrimary: clip(primary, 600),
      rulesSecondary: clip(secondary, 1200),
      rulesHash: sha1(`${primary}\n${secondary}`),
      // kalshi.normalize builds the link from the ticker's first segment, which is the wrong page
      // for a hyphenated series; the event says which series it is.
      url: seriesTicker ? `https://kalshi.com/markets/${seriesTicker.toLowerCase()}` : base.url,
    });
  }
  return out;
}

// ---------------------------------------------------------------- Polymarket

// One item from Gamma GET /events (markets and tags embedded) -> PM market records.
function normalizePmEvent(ev) {
  if (!ev || !Array.isArray(ev.markets)) return [];
  const tags = (Array.isArray(ev.tags) ? ev.tags : []).map((t) => t && t.label).filter(Boolean);
  const out = [];
  for (const m of ev.markets) {
    // `active: false` also drops negRisk placeholders: the unnamed runners ('Person J') and the
    // 'Other' bucket a many-way event reserves, which sit in the listing with bid 0 / ask 1.
    if (!m || !m.active || m.closed || m.acceptingOrders === false) continue;
    const ask = num(m.bestAsk);
    // An ask of 1 is nobody selling: nothing to buy there, and nothing to pair.
    if (ask == null || !(ask > 0 && ask < 1)) continue;
    const base = polymarket.normalize(m);   // null without two outcomes and two tokens
    if (!base) continue;
    // Gamma omits a zero bid rather than sending 0: 4,227 live markets had a bestAsk and no bestBid
    // on 2026-09-14. Reading that as "no quote" dropped real, buyable markets.
    const bid = base.bestBid == null ? 0 : base.bestBid;
    if (bid > ask) continue;
    const description = m.description || ev.description || '';
    const resolutionSource = m.resolutionSource || ev.resolutionSource || '';
    out.push({
      ...base,
      bestBid: bid,
      groupItemTitle: m.groupItemTitle || '',
      eventId: ev.id != null ? String(ev.id) : null,
      eventSlug: ev.slug || null,
      eventTitle: ev.title || base.question,
      tags,
      negRisk: !!(m.negRisk ?? ev.negRisk),
      negRiskOther: !!m.negRiskOther,        // the 'Other' bucket: never the same outcome as a named one
      description: clip(description, 1500),
      resolutionSource: clip(resolutionSource, 300),
      rulesHash: sha1(`${description}\n${resolutionSource}`),
      // /events rows do not embed their event, so polymarket.normalize fell back to the market slug
      url: `https://polymarket.com/event/${ev.slug || base.slug}`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- fetching, with patience

// 429 and anything without a status (timeout, reset, bad JSON) are worth another try, and so is a
// 5xx. Any other 4xx will say the same thing again, so it is not retried.
const retryable = (e) => !e || e.status == null || e.status === 429 || e.status >= 500;

const MAX_ERRORS = 20;
function note(errors, s) { if (errors.length < MAX_ERRORS) errors.push(s); }

// One page, with backoff. Returns { ok: true, data } or { ok: false, error }.
async function fetchPage(getJSON, url, { sleep, backoffMs, label, errors }) {
  for (let attempt = 0; ; attempt++) {
    try {
      return { ok: true, data: await getJSON(url) };
    } catch (e) {
      const msg = String((e && e.message) || e).slice(0, 120);
      if (!retryable(e) || attempt >= backoffMs.length) {
        note(errors, `${label}: ${msg}${attempt ? ` (gave up after ${attempt} retries)` : ''}`);
        return { ok: false, error: e };
      }
      note(errors, `${label}: ${msg} (retry ${attempt + 1}/${backoffMs.length} in ${backoffMs[attempt]}ms)`);
      await sleep(backoffMs[attempt]);
    }
  }
}

// ---------------------------------------------------------------- the crawls

// Walks every open Kalshi event by cursor. `excludeCategories` defaults to Sports -- the desk now
// passes DISCOVER_EXCLUDE_KS instead, which is empty, so the desk crawls sports too; the default
// here stays as it was so a caller that says nothing gets the smaller crawl.
// Returns { markets, events, pages, complete, errors }: `events` counts the
// events that passed the category filter, `seen` every event read.
// `keep`, when given, is applied to each normalized market as its page is read, so what it drops is
// never held: the desk passes one that skips markets nobody holds or trades, because the whole
// non-sports listing is ~70 MB of records on a 512 MB box.
async function crawlKalshi({ getJSON, seriesInfo = null, maxPages = 80, excludeCategories = ['Sports'],
  sleep = defaultSleep, backoffMs = [2000, 4000, 8000], keep = null } = {}) {
  if (typeof getJSON !== 'function') throw new Error('crawlKalshi needs getJSON');
  const excluded = new Set(excludeCategories || []);
  const markets = [], errors = [], tickers = new Set();
  let events = 0, seen = 0, pages = 0, cursor = '', complete = false;
  for (let page = 0; page < maxPages; page++) {
    const url = cursor ? `${KS_EVENTS}&cursor=${encodeURIComponent(cursor)}` : KS_EVENTS;
    const got = await fetchPage(getJSON, url, { sleep, backoffMs, label: `KS page ${page + 1}`, errors });
    if (!got.ok) return { markets, events, seen, pages, complete: false, errors };
    pages++;
    const list = Array.isArray(got.data && got.data.events) ? got.data.events : [];
    cursor = (got.data && got.data.cursor) || '';
    got.data = null;   // the raw page (~3.7 MB) goes now, not at the end of the crawl
    for (const ev of list) {
      seen++;
      if (excluded.has(ksCategory(ev, seriesInfo))) continue;
      events++;
      for (const m of normalizeKsEvent(ev, seriesInfo)) {
        if (keep && !keep(m)) continue;
        if (tickers.has(m.ticker)) continue;
        tickers.add(m.ticker);
        markets.push(m);
      }
    }
    if (!cursor || !list.length) { complete = true; break; }
  }
  // 80 pages is ~25% over the listing's measured size; hitting it means the listing grew or the
  // cursor looped, and either way the result is not the whole listing.
  if (!complete) note(errors, `KS stopped at maxPages ${maxPages} with more to read`);
  return { markets, events, seen, pages, complete, errors };
}

// Walks Gamma's open events, busiest first, 100 per page. Stops at the first event under
// minEventVol (the order is by 24h volume, so the rest are quieter still), at an empty or short
// page, or at maxOffset: Gamma refuses offset 2100 with HTTP 422 'offset too large', so offset 2000
// is the deepest page there is. Reaching it is as complete as the listing gets; `capped` says so.
// Gamma caches responses up to 300 s and ranks by a moving number, so an event can slide across a
// page boundary between two reads: markets are de-duplicated by id.
async function crawlPolymarket({ getJSON, minEventVol = 500, maxOffset = 2000, excludeTags = ['Sports', 'Esports'],
  sleep = defaultSleep, backoffMs = [2000, 4000, 8000] } = {}) {
  if (typeof getJSON !== 'function') throw new Error('crawlPolymarket needs getJSON');
  const excluded = new Set(excludeTags || []);
  const markets = [], errors = [], ids = new Set(), eventIds = new Set();
  let events = 0, seen = 0, pages = 0, complete = false, capped = false;
  for (let offset = 0; ; offset += PM_PAGE) {
    if (offset > maxOffset) { complete = true; capped = true; break; }
    const got = await fetchPage(getJSON, `${PM_EVENTS}&offset=${offset}`, { sleep, backoffMs, label: `PM offset ${offset}`, errors });
    if (!got.ok) {
      // 422 is Gamma saying there are no deeper pages, not a failure
      if (got.error && got.error.status === 422) { complete = true; capped = true; break; }
      return { markets, events, seen, pages, complete: false, capped, errors };
    }
    pages++;
    const list = Array.isArray(got.data) ? got.data : [];
    got.data = null;
    if (!list.length) { complete = true; break; }
    let quiet = false;
    for (const ev of list) {
      if (!ev) continue;
      if ((num(ev.volume24hr) || 0) < minEventVol) { quiet = true; break; }
      seen++;
      if (eventIds.has(String(ev.id))) continue;
      eventIds.add(String(ev.id));
      if ((ev.tags || []).some((t) => t && excluded.has(t.label))) continue;
      events++;
      for (const m of normalizePmEvent(ev)) {
        if (ids.has(m.id)) continue;
        ids.add(m.id);
        markets.push(m);
      }
    }
    if (quiet || list.length < PM_PAGE) { complete = true; break; }
  }
  return { markets, events, seen, pages, complete, capped, errors };
}

// ---------------------------------------------------------------- the fetcher

// A getJSON for discovery only. It deliberately bypasses src/http.js: that wrapper counts every
// failure toward TESS's API-error halt, and a crawl that meets a 429 on page 40 must not stop the
// desk trading. A non-2xx throws with `.status` so the crawlers can tell 429 (wait) from 422 (end).
// `pace` is an optional async gate awaited before each call (e.g. a pacer lane from http.makePacer);
// `fetchImpl` is for tests.
function makeDiscoveryFetch({ timeoutMs = 60000, pace = null, fetchImpl = null } = {}) {
  return async function getJSON(url) {
    if (pace) await pace();
    const f = fetchImpl || globalThis.fetch;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const r = await f(url, { signal: ctl.signal, headers: { accept: 'application/json', 'user-agent': 'the-hexagon/1.0 (discovery)' } });
      if (!r.ok) {
        const e = new Error(`HTTP ${r.status} ${String(url).slice(0, 90)}`);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(timer);
    }
  };
}

// ---------------------------------------------------------------- the registry on disk

// Persisted so a restart does not wait for a full crawl. Written in chunks rather than one
// JSON.stringify: tens of thousands of records with rules text is a string of tens of MB, and
// building it whole would double the crawl's footprint on a 512 MB box. Written to a temp file and
// renamed, so a crash mid-write leaves the previous registry intact rather than half a file.
function saveRegistry(file, data) {
  const ks = (data && data.ksMarkets) || [];
  const pm = (data && data.pmMarkets) || [];
  const head = {
    at: data && data.at != null ? data.at : new Date().toISOString(),
    kalshi: { complete: !!(data && data.kalshi && data.kalshi.complete), count: ks.length },
    polymarket: { complete: !!(data && data.polymarket && data.polymarket.complete), count: pm.length },
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    const body = JSON.stringify(head);
    fs.writeSync(fd, `${body.slice(0, -1)},"ksMarkets":[`);
    writeArray(fd, ks);
    fs.writeSync(fd, '],"pmMarkets":[');
    writeArray(fd, pm);
    fs.writeSync(fd, ']}\n');
    fs.fsyncSync(fd);
  } catch (e) {
    fs.closeSync(fd);
    try { fs.unlinkSync(tmp); } catch { /* already gone */ }
    throw e;
  }
  fs.closeSync(fd);
  fs.renameSync(tmp, file);
  return head;
}
function writeArray(fd, arr) {
  const CHUNK = 500;
  for (let i = 0; i < arr.length; i += CHUNK) {
    const part = arr.slice(i, i + CHUNK).map((x) => JSON.stringify(x)).join(',\n');
    fs.writeSync(fd, `${i ? ',\n' : '\n'}${part}`);
  }
}

// The saved registry, or null when there is none or it cannot be read. Never throws: a corrupt
// file means "crawl again", not "fail to start".
function loadRegistry(file) {
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!d || !Array.isArray(d.ksMarkets) || !Array.isArray(d.pmMarkets)) return null;
    return d;
  } catch {
    return null;
  }
}

module.exports = {
  normalizeKsEvent, normalizePmEvent, crawlKalshi, crawlPolymarket, makeDiscoveryFetch,
  saveRegistry, loadRegistry, ksCategory, KS_EVENTS, PM_EVENTS,
};

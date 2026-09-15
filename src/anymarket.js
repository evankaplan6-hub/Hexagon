'use strict';
// The any-market scanner: the same outcome on Polymarket and Kalshi in every category, not just
// games and Fed brackets.
//
// src/matcher.js is fast and narrow: it re-matches eleven Kalshi series against the top 300
// Polymarket markets every cycle. Everything else on both venues -- elections, CPI, central banks,
// Treasury yields, awards, charts, deadlines -- needs whole events from both venues (a many-way
// Polymarket event is split into one market per outcome, and its brackets are exactly what pairs
// with Kalshi's), which is ~65 Kalshi calls and ~20 Polymarket calls: far too much for a 15-second
// cycle. So this runs in two speeds:
//
//   discover  every DISCOVER_EVERY_MIN, off the cycle: crawl both venues (src/discovery.js), match
//             outcomes (src/match-any.js), and give each candidate a rules verdict (src/rules.js).
//   refresh   every cycle: reprice only the matched markets, in a handful of batched calls.
//
// A pair only TRADES when its two contracts are verified to resolve the same way. Measured
// 2026-09-15: 23 of 76 politics pairs whose rules were read resolve differently (death clauses,
// "announced" vs "actually left", different deadlines), every crypto price pair uses a different
// oracle, and those look-alikes trade within a few cents of each other -- a 6c Netanyahu "arb" and
// a 9c McConnell "arb" would both have passed the matcher's 30c price guard. Everything the rules
// gate has not verified is priced, recorded and narrated as watch-only, never traded.
const fs = require('fs');
const path = require('path');
const decide = require('./decide');

// Only the matched candidates go to disk (a few hundred records), atomically, so a restart has
// pairs at once. The full crawl is tens of MB and is simply fetched again.
const fileStore = {
  save(file, data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data));
    fs.renameSync(tmp, file);
  },
  load(file) {
    try { const d = JSON.parse(fs.readFileSync(file, 'utf8')); return d && Array.isArray(d.candidates) ? d : null; } catch { return null; }
  },
};

const r3 = (x) => Math.round(x * 1000) / 1000;

function makeAnyMarket(cfg, deps = {}) {
  const discovery = deps.discovery || require('./discovery');
  const matchAny = deps.matchAny || require('./match-any').matchAny;
  const rules = deps.rules || require('./rules');
  const ks = deps.ks || require('./venues/kalshi');
  const pm = deps.pm || require('./venues/polymarket');
  const clock = deps.now || Date.now;
  const store = deps.store || fileStore;
  const file = path.join(cfg.dataDir, 'pairs-any.json');

  let candidates = [];                 // matched candidates, best first, capped at anyMaxPairs
  let rejectedCount = 0, differentCount = 0;
  const ksCache = new Map();           // ticker -> KS market record with `at`
  const pmCache = new Map();           // id -> PM market record with `at`
  let last = null;                     // { at, ms, complete, stats }
  let running = false;
  let timer = null;
  const judge = deps.judge !== undefined ? deps.judge
    : (typeof rules.makeRulesJudge === 'function' ? rules.makeRulesJudge(cfg, deps.judgeDeps || {}) : null);

  const verdictOf = (c) => {
    if (judge && typeof rules.finalVerdict === 'function') return rules.finalVerdict(c, judge);
    return rules.staticVerdict(c);
  };

  function adopt(list, at) {
    // Rank: verified first, then the busier side. The cap bounds the per-cycle refresh cost (one
    // Kalshi call per 100 tickers, one Polymarket call per 200 tokens) and the tape.
    const scored = [];
    differentCount = 0;
    for (const c of list) {
      const v = verdictOf(c);
      if (v.verdict === 'different') { differentCount++; continue; }
      scored.push({ c, v, vol: Math.min(c.pm.vol24 || 0, (c.ks.vol24 || 0) * ((c.ks.yesBid + c.ks.yesAsk) / 2 || 0.5)) });
    }
    scored.sort((a, b) => ((b.v.verdict === 'same') - (a.v.verdict === 'same')) || (b.vol - a.vol));
    candidates = scored.slice(0, cfg.anyMaxPairs).map((x) => x.c);
    for (const c of candidates) {
      if (!ksCache.has(c.ks.ticker)) ksCache.set(c.ks.ticker, { ...c.ks, at });
      if (!pmCache.has(c.pm.id)) pmCache.set(c.pm.id, { ...c.pm, at });
    }
    const keepK = new Set(candidates.map((c) => c.ks.ticker)), keepP = new Set(candidates.map((c) => c.pm.id));
    for (const k of [...ksCache.keys()]) if (!keepK.has(k)) ksCache.delete(k);
    for (const k of [...pmCache.keys()]) if (!keepP.has(k)) pmCache.delete(k);
    return scored.length - candidates.length;
  }

  // Restart: pick up the last discovery at once instead of waiting a full crawl with no pairs. The
  // cached prices are old (their `at` is the crawl time), so nothing trades on them until refresh
  // has repriced them.
  function loadSaved() {
    const saved = store.load(file);
    if (!saved || !Array.isArray(saved.candidates)) return 0;
    adopt(saved.candidates, saved.at || 0);
    last = { at: saved.at || 0, ms: null, complete: !!saved.complete, stats: saved.stats || null, restored: true };
    return candidates.length;
  }

  async function discover(E) {
    if (running) return;
    running = true;
    const t0 = clock();
    try {
      const getJSON = discovery.makeDiscoveryFetch({ timeoutMs: 60000 });
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // Kalshi and Polymarket are different hosts; crawl them side by side. Discovery uses its own
      // fetch, so a slow or refused crawl never counts toward TESS's API-error halt.
      const [k, p] = await Promise.all([
        // A Kalshi market nobody holds and nobody traded today has no counterparty to arb against;
        // skipping it as the page is read keeps the crawl's memory to what can matter.
        discovery.crawlKalshi({ getJSON, seriesInfo: ks.seriesInfo, sleep, keep: (m) => (m.oi || 0) > 0 || (m.vol24 || 0) > 0 }),
        discovery.crawlPolymarket({ getJSON, minEventVol: cfg.pmDiscoverMinVol, sleep }),
      ]);
      if (!k.markets.length || !p.markets.length) {
        E.log('HOLT', 'OPS', null, `any-market discovery came back empty (${k.markets.length} Kalshi, ${p.markets.length} Polymarket markets) · keeping the last good set of ${candidates.length} pairs`);
        return;
      }
      const m = matchAny(p.markets, k.markets, {});
      rejectedCount = (m.rejected || []).length;
      const dropped = adopt(m.candidates || [], clock());
      const ms = clock() - t0;
      last = { at: clock(), ms, complete: !!(k.complete && p.complete), stats: { ...(m.stats || {}), ksMarkets: k.markets.length, pmMarkets: p.markets.length, capped: dropped } };
      // Only the matched markets are kept on disk: the full crawl is tens of MB and is re-fetched.
      try { store.save(file, { at: last.at, complete: last.complete, stats: last.stats, candidates }); } catch { /* the next pass tries again */ }
      const s = summary();
      E.log('HOLT', 'SCAN', null, `any-market scan · ${k.markets.length.toLocaleString()} Kalshi + ${p.markets.length.toLocaleString()} Polymarket markets crawled in ${Math.round(ms / 1000)}s · ${s.total} matched (${s.byCategoryText}) · ${s.same} rules-verified to trade, ${s.unclear} watch-only, ${differentCount} dropped as different rules${dropped > 0 ? ` · ${dropped} over the ${cfg.anyMaxPairs}-pair cap` : ''}${last.complete ? '' : ' · crawl incomplete, kept what loaded'}`);
    } catch (e) {
      E.log('HOLT', 'OPS', null, `any-market discovery failed: ${String(e && e.message).slice(0, 120)} · keeping the last good set of ${candidates.length} pairs`);
    } finally {
      running = false;
    }
  }

  // Reprice every matched market. Kalshi in chunks of 100 tickers, Polymarket's CLOB in chunks of
  // 200 tokens. A market that failed to refresh keeps its old `at`, so its pair goes stale and stops
  // trading after MAX_DATA_AGE_SEC rather than trading on an old price. A Kalshi market that is no
  // longer active leaves the cache, so a held position on it is resolved from the venue.
  async function refresh(E) {
    if (!candidates.length) return;
    const now = clock();
    const tickers = [...new Set(candidates.map((c) => c.ks.ticker))];
    const tokens = [...new Set(candidates.map((c) => c.pm.tokenIds && c.pm.tokenIds[c.tokenIndex || 0]).filter(Boolean))];
    const [kr, pr] = await Promise.allSettled([ks.fetchMarketsByTickers(tickers), pm.fetchPrices(tokens)]);
    if (kr.status === 'fulfilled') {
      const seen = new Set();
      for (const m of kr.value) {
        seen.add(m.ticker);
        const prev = ksCache.get(m.ticker);
        if (!prev) continue;
        if (m.status !== 'active' || !(m.yesBid > 0 && m.yesAsk < 1)) {
          // decided or empty: out of the map (a closed market goes to resolution; an empty book is not a price)
          if (m.status !== 'active') ksCache.delete(m.ticker);
          else ksCache.set(m.ticker, { ...prev, yesBid: m.yesBid, yesAsk: m.yesAsk, status: m.status, at: prev.at });
          continue;
        }
        ksCache.set(m.ticker, { ...prev, ...m, rulesPrimary: prev.rulesPrimary, rulesSecondary: prev.rulesSecondary, rulesHash: prev.rulesHash, seriesTicker: prev.seriesTicker, category: prev.category, eventTitle: prev.eventTitle, at: now });
      }
    } else if (E.due('any-ks-refresh', 300)) {
      E.log('TESS', 'OPS', null, `any-market Kalshi reprice failed: ${String(kr.reason && kr.reason.message).slice(0, 100)} · those pairs go stale until it recovers`);
    }
    if (pr.status === 'fulfilled') {
      for (const c of candidates) {
        const tok = c.pm.tokenIds && c.pm.tokenIds[c.tokenIndex || 0];
        const live = tok && pr.value.get(tok);
        const prev = pmCache.get(c.pm.id);
        if (!live || !prev) continue;
        pmCache.set(c.pm.id, { ...prev, bestBid: live.bid, bestAsk: live.ask, at: now });
      }
    } else if (E.due('any-pm-refresh', 300)) {
      E.log('TESS', 'OPS', null, `any-market Polymarket reprice failed: ${String(pr.reason && pr.reason.message).slice(0, 100)} · those pairs go stale until it recovers`);
    }
  }

  // The engine rebuilds its quote maps every cycle from the fast listing; put the matched markets
  // back in. The fast listing wins where both have a market: it is fresher for games and the Fed.
  function inject(E) {
    for (const [t, m] of ksCache) if (!E.quotes.ks.has(t)) E.quotes.ks.set(t, m);
    for (const [id, m] of pmCache) if (!E.quotes.pm.has(id)) E.quotes.pm.set(id, m);
  }

  // Pairs for HOLT, in the shape src/matcher.js produces. `taken` holds the Kalshi tickers and
  // Polymarket ids the fast matcher already paired, which win.
  function pairs(E, taken = { ks: new Set(), pm: new Set() }) {
    const out = [];
    for (const c of candidates) {
      if (taken.ks.has(c.ks.ticker) || taken.pm.has(c.pm.id)) continue;
      const k = ksCache.get(c.ks.ticker), m = pmCache.get(c.pm.id);
      if (!k || !m) continue;
      const v = verdictOf(c);
      if (v.verdict === 'different') continue;
      const closesAt = Date.parse(k.closeTime || '');
      const settles = Date.parse(k.expectedExpiration || '');
      out.push({
        id: c.id, label: c.label, kind: 'event', series: c.series || k.seriesTicker, category: c.category || k.category,
        startsAt: null,
        closesAt: Number.isFinite(closesAt) ? closesAt : null,
        settlesAt: Number.isFinite(settles) ? settles : (Number.isFinite(closesAt) ? closesAt : null),
        watchOnly: v.verdict === 'same' ? null : v.verdict,
        rules: { verdict: v.verdict, source: v.source, reason: v.reason },
        how: c.how,
        pm: { id: m.id, tokenIndex: c.tokenIndex || 0, tokenId: m.tokenIds[c.tokenIndex || 0], question: m.question, url: m.url },
        ks: { ticker: k.ticker, title: k.title, eventTicker: k.eventTicker, url: k.url },
      });
    }
    return out;
  }

  // After BRAM: a watch-only pair that would have produced a signal is worth asking the rules judge
  // about (once per pair of rules texts, cached, inside RULES_DAILY_USD). Asking only then keeps the
  // cost to the handful of pairs that actually show an edge.
  function afterPricing(E) {
    if (!judge || typeof judge.request !== 'function') return;
    const now = clock();
    const byId = new Map(candidates.map((c) => [c.id, c]));
    for (const p of E.pairs) {
      if (p.kind !== 'event' || p.watchOnly !== 'unclear' || !p.q || p.inPlay) continue;
      const r = decide.pairSignals({ ...p, watchOnly: null }, E.cfg, now);
      if (!r.signals.length) continue;
      const c = byId.get(p.id);
      if (c) judge.request(c);
    }
  }

  function summary() {
    const byCat = {};
    let same = 0, unclear = 0;
    for (const c of candidates) {
      const cat = c.category || 'Other';
      byCat[cat] = (byCat[cat] || 0) + 1;
      const v = verdictOf(c).verdict;
      if (v === 'same') same++; else if (v === 'unclear') unclear++;
    }
    const byCategoryText = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, n]) => `${n} ${k.toLowerCase()}`).join(', ') || 'none';
    return { total: candidates.length, same, unclear, byCategory: byCat, byCategoryText };
  }

  function start(E) {
    const n = loadSaved();
    if (n) E.log('HOLT', 'SCAN', null, `any-market scanner restored ${n} matched pairs from the last discovery · repricing them before any can trade`);
    // the first crawl a little after boot, so the desk's own first cycles are not competing with it
    setTimeout(() => discover(E), 20000);
    timer = setInterval(() => discover(E), cfg.discoverEveryMin * 60000);
  }

  function snapshot() {
    const s = summary();
    return {
      enabled: true, pairs: s.total, rulesVerified: s.same, watchOnly: s.unclear, droppedDifferentRules: differentCount,
      rejectedMatches: rejectedCount, byCategory: s.byCategory,
      lastScanAt: last && last.at, lastScanSec: last && last.ms != null ? Math.round(last.ms / 1000) : null, complete: last ? last.complete : null,
      judge: judge && typeof judge.snapshot === 'function' ? judge.snapshot() : null,
    };
  }

  return { start, discover, refresh, inject, pairs, afterPricing, snapshot, summary, loadSaved, _candidates: () => candidates, stop: () => timer && clearInterval(timer) };
}

module.exports = { makeAnyMarket };

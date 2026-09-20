'use strict';
// Assertions for src/anymarket.js -- the any-market scanner's two speeds (discover off the cycle,
// reprice in it), and the rule that decides what may trade: only a pair whose resolution rules
// are verified the same. Discovery, matching, the rules gate and both venues are stubbed, so this
// tests the orchestration itself, with no network and no clock.
//
//   node tools/anymarket-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeAnyMarket, bootCrawlDelayMs } = require('../src/anymarket');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const r2 = (x) => Math.round(x * 1e6) / 1e6;   // 1 - 0.59 is not 0.41 in binary floating point

const T0 = 1788900000000;
const dirs = [];
const cfgFor = (over = {}) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-any-'));
  dirs.push(dataDir);
  return { ...base, dataDir, anyMaxPairs: 3, ...over };
};
const ksm = (ticker, o = {}) => ({ venue: 'KS', ticker, eventTicker: ticker.split('-').slice(0, 2).join('-'), seriesTicker: ticker.split('-')[0], category: 'Elections', title: `t ${ticker}`, yesBid: 0.40, yesAsk: 0.42, vol24: 1000, status: 'active', closeTime: '2026-11-03T15:00:00Z', expectedExpiration: '2027-01-04T15:00:00Z', rulesHash: `k${ticker}`, url: '', ...o });
const pmm = (id, o = {}) => ({ venue: 'PM', id, question: `q ${id}`, tokenIds: [`${id}-y`, `${id}-n`], outcomes: ['Yes', 'No'], bestBid: 0.40, bestAsk: 0.41, vol24: 5000, feeRate: 0.04, rulesHash: `p${id}`, url: '', ...o });
const cand = (pmId, ticker, verdict, o = {}) => ({ id: `${pmId}:0|${ticker}`, pm: pmm(pmId, o.pm), ks: ksm(ticker, o.ks), tokenIndex: 0, how: 'names', score: 1, label: `${pmId} - ${ticker}`, category: 'Elections', series: ticker.split('-')[0], rulesKey: `${pmId}:${ticker}`, _verdict: verdict });

function harness(list, over = {}) {
  const logs = [];
  const E = {
    cfg: cfgFor(over.cfg), quotes: { pm: new Map(), ks: new Map() }, pairs: [],
    log: (agent, kind, pnl, text) => logs.push({ agent, kind, text }), due: () => true,
  };
  let crawl = over.crawl || { k: { markets: [1], complete: true }, p: { markets: [1], complete: true } };
  let prices = over.prices || new Map();
  let ksLive = over.ksLive || [];
  const requested = [];
  const crawlArgs = {};
  const saved = { data: null };
  let clockAt = T0;
  const deps = {
    now: () => clockAt,
    discovery: {
      makeDiscoveryFetch: () => async () => ({}),
      crawlKalshi: async (opts) => { crawlArgs.ks = opts; if (crawl.throw) throw new Error('boom'); return crawl.k; },
      crawlPolymarket: async (opts) => { crawlArgs.pm = opts; return crawl.p; },
    },
    store: {
      save: (file, data) => { saved.data = JSON.parse(JSON.stringify(data)); saved.file = file; },
      load: () => over.registry || null,
    },
    matchAny: () => ({ candidates: list, rejected: [{ why: 'tick' }], stats: {} }),
    rules: { staticVerdict: (c) => ({ verdict: c._verdict, source: 'allowlist', reason: `stub ${c._verdict}` }) },
    judge: { request: (c) => requested.push(c.id), snapshot: () => ({ asked: requested.length }) },
    ks: { seriesInfo: new Map(), fetchMarketsByTickers: async () => { if (over.ksThrow) throw new Error('HTTP 429'); return ksLive; } },
    pm: { fetchPrices: async () => prices },
  };
  deps.sleep = async (ms) => { clockAt += ms; };   // pacing moves the fake clock instead of waiting
  const A = makeAnyMarket(E.cfg, deps);
  return { A, E, logs, requested, saved, crawlArgs, set: { clock: (t) => { clockAt = t; }, crawl: (c) => { crawl = c; }, prices: (p) => { prices = p; }, ksLive: (k) => { ksLive = k; } } };
}

(async () => {
  group('the crawl feeds the maker its universe on the way past');
  {
    // The maker's candidate list comes from this crawl (src/maker.js candidatesFrom): it is the only
    // walk of every open Kalshi market the desk makes, so handing it over costs no extra call.
    const seen = [];
    const h = harness([], { crawl: { k: { markets: [{ ticker: 'X-1', seriesTicker: 'X' }], complete: true }, p: { markets: [1], complete: true } } });
    h.E.maker = { noteCrawl: (E, markets, feeTypeOf) => { seen.push({ markets, feeTypeOf }); return markets.length; } };
    h.E.touch = () => {};
    await h.A.discover(h.E);
    ok('the maker is handed the crawl', seen.length === 1 && seen[0].markets.length === 1, seen);
    ok('...with a way to ask what a series charges', typeof seen[0].feeTypeOf === 'function', seen[0] && typeof seen[0].feeTypeOf);

    const noMaker = harness([]);
    await noMaker.A.discover(noMaker.E);   // no maker on the engine at all
    ok('a desk with no maker still finishes its crawl', noMaker.logs.some((l) => l.agent === 'HOLT'), noMaker.logs.map((l) => l.agent));
  }

  group('the config decides which categories the crawl skips');
  {
    // The crawlers default to skipping Sports; the desk overrides that with DISCOVER_EXCLUDE_KS /
    // DISCOVER_EXCLUDE_PM, which are empty, so sports is crawled. Passing the lists explicitly is
    // the whole mechanism -- if anymarket stops forwarding them the library default silently puts
    // the wall back, and fights disappear from the scan again with nothing to show for it.
    const open = harness([]);
    await open.A.discover(open.E);
    ok('the Kalshi crawl is told what to exclude', Array.isArray(open.crawlArgs.ks.excludeCategories), open.crawlArgs.ks.excludeCategories);
    ok('the Polymarket crawl is told what to exclude', Array.isArray(open.crawlArgs.pm.excludeTags), open.crawlArgs.pm.excludeTags);
    ok('by default nothing is excluded, so sports is crawled',
      open.crawlArgs.ks.excludeCategories.length === 0 && open.crawlArgs.pm.excludeTags.length === 0,
      [open.crawlArgs.ks.excludeCategories, open.crawlArgs.pm.excludeTags]);

    const walled = harness([], { cfg: { discoverExcludeKs: ['Sports'], discoverExcludePm: ['Sports', 'Esports'] } });
    await walled.A.discover(walled.E);
    ok('and a config that names them puts the wall back',
      walled.crawlArgs.ks.excludeCategories.join() === 'Sports' && walled.crawlArgs.pm.excludeTags.join() === 'Sports,Esports',
      [walled.crawlArgs.ks.excludeCategories, walled.crawlArgs.pm.excludeTags]);
  }

  group('discovery keeps verified pairs first, drops different rules, and respects the cap');
  {
    const list = [
      cand('a', 'SENATEIA-26-R', 'unclear', { pm: { vol24: 90000 } }),
      cand('b', 'CONTROLS-2026-D', 'same', { pm: { vol24: 100 } }),
      cand('c', 'KXLEADERSOUT-27JAN01-BNETISR', 'different'),
      cand('d', 'KXMAYORLA-26-NRAM', 'same', { pm: { vol24: 50000 } }),
      cand('e', 'KXTIME-26-ZOH', 'unclear', { pm: { vol24: 10 } }),
    ];
    const { A, E, logs, saved } = harness(list);
    await A.discover(E);
    const ids = A._candidates().map((c) => c.id);
    ok('a pair with different rules is never kept', !ids.some((x) => /BNETISR/.test(x)), ids);
    ok('verified pairs rank ahead of watch-only ones, busier first', ids[0] === 'd:0|KXMAYORLA-26-NRAM' && ids[1] === 'b:0|CONTROLS-2026-D' && ids[2] === 'a:0|SENATEIA-26-R', ids);
    ok('the cap holds', ids.length === 3, ids.length);
    const line = logs.find((l) => /any-market scan/.test(l.text));
    ok('the scan is narrated with what can trade and what is watched', line && /2 rules-verified to trade, 1 watch-only, 1 dropped as different rules/.test(line.text) && /over the 3-pair cap/.test(line.text), line && line.text);
    ok('only matched markets are saved for a restart', saved.data && saved.data.candidates.length === 3 && /pairs-any\.json$/.test(saved.file), saved.data && saved.data.candidates.length);
    const snap = A.snapshot();
    ok('the snapshot counts both', snap.rulesVerified === 2 && snap.watchOnly === 1 && snap.droppedDifferentRules === 1 && snap.byCategory.Elections === 3, snap);
  }

  group('a failed or empty crawl keeps the last good set');
  {
    const { A, E, logs, set } = harness([cand('b', 'CONTROLS-2026-D', 'same')]);
    await A.discover(E);
    set.crawl({ throw: true });
    await A.discover(E);
    ok('after a throw the pairs are still there', A._candidates().length === 1);
    ok('...and it says so', logs.some((l) => /discovery failed: boom · keeping the last good set of 1 pairs/.test(l.text)), logs.map((l) => l.text));
    set.crawl({ k: { markets: [], complete: true }, p: { markets: [1], complete: true } });
    await A.discover(E);
    ok('an empty crawl does not wipe them either', A._candidates().length === 1 && logs.some((l) => /came back empty/.test(l.text)));
  }

  group('pairs: the shape HOLT uses, watch-only unless verified, fast matcher wins');
  {
    const { A, E } = harness([cand('b', 'CONTROLS-2026-D', 'same'), cand('a', 'SENATEIA-26-R', 'unclear')]);
    await A.discover(E);
    const ps = A.pairs(E);
    const v = ps.find((p) => p.ks.ticker === 'CONTROLS-2026-D'), w = ps.find((p) => p.ks.ticker === 'SENATEIA-26-R');
    ok('a verified pair is tradeable', v && v.watchOnly === null && v.kind === 'event' && v.rules.verdict === 'same', v);
    ok('an unclear pair is watch-only', w && w.watchOnly === 'unclear', w);
    ok('pairs carry close, settlement, category and the PM YES token', v.closesAt === Date.parse('2026-11-03T15:00:00Z') && v.settlesAt === Date.parse('2027-01-04T15:00:00Z') && v.category === 'Elections' && v.pm.tokenId === 'b-y', v);
    ok('the id keeps the shape replay parses', v.id === 'b:0|CONTROLS-2026-D');
    const taken = { ks: new Set(['CONTROLS-2026-D']), pm: new Set() };
    ok('a market the fast matcher already paired is left to it', !A.pairs(E, taken).some((p) => p.ks.ticker === 'CONTROLS-2026-D'));
  }

  group('refresh reprices matched markets, and a stale or closed market is never traded on');
  {
    const { A, E, set, logs } = harness([cand('b', 'CONTROLS-2026-D', 'same'), cand('a', 'SENATEIA-26-R', 'same')]);
    set.clock(T0 - 600000);   // discovered ten minutes ago
    await A.discover(E);
    set.clock(T0);
    set.ksLive([
      { ticker: 'CONTROLS-2026-D', yesBid: 0.51, yesAsk: 0.52, vol24: 7, status: 'active', closeTime: '2027-02-01T15:00:00Z' },
      { ticker: 'SENATEIA-26-R', yesBid: 0, yesAsk: 1, status: 'active' },
    ]);
    set.prices(new Map([['b-y', { bid: 0.53, ask: 0.54 }]]));
    await A.refresh(E);
    A.inject(E);
    const k = E.quotes.ks.get('CONTROLS-2026-D'), p = E.quotes.pm.get('b');
    ok('the Kalshi price and time are fresh', k && k.yesBid === 0.51 && k.at === T0, k);
    ok('rules texts from discovery survive a reprice', k.rulesHash === 'kCONTROLS-2026-D' && k.category === 'Elections');
    ok('the Polymarket price comes from the CLOB', p && p.bestBid === 0.53 && p.bestAsk === 0.54 && p.at === T0, p);
    const empty = E.quotes.ks.get('SENATEIA-26-R');
    ok('an empty Kalshi book keeps its OLD time, so the pair goes stale instead of pricing 0/1', empty && empty.at !== T0 && empty.yesBid === 0, empty);

    // A token-1 leg (a fight's second fighter) is priced on token 1, but the cache is keyed by
    // MARKET and holds outcome 0's quote -- the engine takes the complement itself for such a pair,
    // so storing token 1's price raw would flip an already-flipped quote.
    const two = harness([{ ...cand('f', 'KXUFCFIGHT-26SEP19VANPAN-VAN', 'same'), tokenIndex: 1 }]);
    two.set.clock(T0 - 600000);
    await two.A.discover(two.E);
    two.set.clock(T0);
    two.set.ksLive([{ ticker: 'KXUFCFIGHT-26SEP19VANPAN-VAN', yesBid: 0.58, yesAsk: 0.59, vol24: 900, status: 'active', closeTime: '2026-10-04T02:20:00Z' }]);
    two.set.prices(new Map([['f-n', { bid: 0.58, ask: 0.59 }]]));   // token 1 is tokenIds[1]
    await two.A.refresh(two.E);
    two.A.inject(two.E);
    const fp = two.E.quotes.pm.get('f');
    ok('a token-1 leg is repriced off its own token', fp && fp.at === T0, fp);
    ok('...and stored as outcome 0, so the engine\'s flip lands on the right side', fp && r2(fp.bestBid) === 0.41 && r2(fp.bestAsk) === 0.42, fp && [fp.bestBid, fp.bestAsk]);
    set.ksLive([{ ticker: 'CONTROLS-2026-D', status: 'finalized', result: 'yes' }]);
    set.clock(T0 + 61000);   // the next reprice, a minute on
    await A.refresh(E);
    const E2q = { pm: new Map(), ks: new Map() };
    A.inject({ quotes: E2q });
    ok('a decided market leaves the maps, so a held position goes to resolution', !E2q.ks.has('CONTROLS-2026-D'));
    const fast = { pm: new Map(), ks: new Map([['SENATEIA-26-R', { ticker: 'SENATEIA-26-R', fast: true }]]) };
    A.inject({ quotes: fast });
    ok('the fast listing wins where both have a market', fast.ks.get('SENATEIA-26-R').fast === true);
    const bad = harness([cand('b', 'CONTROLS-2026-D', 'same')], { ksThrow: true });
    await bad.A.discover(bad.E);
    await bad.A.refresh(bad.E);
    ok('a failed Kalshi reprice is logged, not thrown', bad.logs.some((l) => /Kalshi reprice failed: HTTP 429/.test(l.text)), bad.logs.map((l) => l.text));
  }

  group('Kalshi is not hammered: the crawl is paced and pairs are repriced once a minute');
  {
    const { A, E, set } = harness([cand('b', 'CONTROLS-2026-D', 'same')], { cfg: { anyRefreshSec: 60 } });
    await A.discover(E);
    set.ksLive([{ ticker: 'CONTROLS-2026-D', yesBid: 0.51, yesAsk: 0.52, status: 'active' }]);
    await A.refresh(E);
    set.clock(T0 + 15000);
    set.ksLive([{ ticker: 'CONTROLS-2026-D', yesBid: 0.60, yesAsk: 0.61, status: 'active' }]);
    await A.refresh(E); A.inject(E);
    ok('a cycle 15 seconds after a reprice does not reprice again', E.quotes.ks.get('CONTROLS-2026-D').yesBid === 0.51, E.quotes.ks.get('CONTROLS-2026-D'));
    set.clock(T0 + 61000);
    E.quotes.ks.clear();
    await A.refresh(E); A.inject(E);
    ok('a minute later it does', E.quotes.ks.get('CONTROLS-2026-D').yesBid === 0.60, E.quotes.ks.get('CONTROLS-2026-D'));
  }
  {
    // a crawl stub that reads three Kalshi pages and two Polymarket pages through the fetchers it is given
    const stamps = [];
    let clock = T0;
    const A2 = makeAnyMarket({ ...base, dataDir: cfgFor().dataDir, anyMaxPairs: 3, discoverGapMs: 1500 }, {
      now: () => clock, sleep: async (ms) => { clock += ms; },
      discovery: {
        makeDiscoveryFetch: ({ pace }) => async () => { if (pace) await pace(); stamps.push({ paced: !!pace, at: clock }); return {}; },
        crawlKalshi: async ({ getJSON }) => { await getJSON('k1'); await getJSON('k2'); await getJSON('k3'); return { markets: [1], complete: true }; },
        crawlPolymarket: async ({ getJSON }) => { await getJSON('p1'); await getJSON('p2'); return { markets: [1], complete: true }; },
      },
      store: { save() {}, load: () => null },
      matchAny: () => ({ candidates: [], rejected: [], stats: {} }),
      rules: { staticVerdict: () => ({ verdict: 'same' }) }, judge: null,
      ks: { seriesInfo: new Map(), fetchMarketsByTickers: async () => [] }, pm: { fetchPrices: async () => new Map() },
    });
    await A2.discover({ log: () => {}, due: () => true, quotes: { pm: new Map(), ks: new Map() } });
    const k = stamps.filter((x) => x.paced).map((x) => x.at);
    ok('Kalshi crawl pages are at least DISCOVER_GAP_MS apart', k.length === 3 && k[1] - k[0] >= 1500 && k[2] - k[1] >= 1500, stamps);
    ok('Polymarket pages are not held back by Kalshi\'s pacing', stamps.filter((x) => !x.paced).length === 2, stamps);
  }

  group('the rules judge is asked only about watch-only pairs that show an edge');
  {
    const { A, E, requested } = harness([cand('a', 'SENATEIA-26-R', 'unclear'), cand('z', 'KXTIME-26-ZOH', 'unclear')]);
    await A.discover(E);
    const mk = (id, q, o = {}) => ({ id, kind: 'event', watchOnly: 'unclear', inPlay: false, label: id, ks: { ticker: 'KXTEST' }, pm: { id: 'x' }, q: { t: T0, pmVol: 5e5, ksVol: 1e5, pmFeeRate: 0, ...q, pmMid: (q.pmBid + q.pmAsk) / 2, ksMid: (q.ksBid + q.ksAsk) / 2 }, ...o });
    E.pairs = [
      mk('a:0|SENATEIA-26-R', { pmBid: 0.40, pmAsk: 0.41, ksBid: 0.50, ksAsk: 0.51 }),          // a fat arb
      mk('z:0|KXTIME-26-ZOH', { pmBid: 0.50, pmAsk: 0.51, ksBid: 0.50, ksAsk: 0.51 }),          // nothing
    ];
    A.afterPricing(E);
    ok('a watch-only pair with an arb on it is sent to the judge', requested.includes('a:0|SENATEIA-26-R'), requested);
    ok('a flat one is not', !requested.includes('z:0|KXTIME-26-ZOH'), requested);
    E.pairs[0].inPlay = true;
    requested.length = 0;
    A.afterPricing(E);
    ok('nor is one inside its live window', requested.length === 0, requested);
  }

  group('a restart restores the last matched pairs, stale until repriced');
  {
    const reg = { at: T0 - 3600000, complete: true, candidates: [cand('b', 'CONTROLS-2026-D', 'same')] };
    const { A, E } = harness([], { registry: reg });
    ok('restored from disk', A.loadSaved() === 1 && A._candidates()[0].id === 'b:0|CONTROLS-2026-D');
    A.inject(E);
    ok('with the crawl time, not now, so nothing trades until refresh', E.quotes.ks.get('CONTROLS-2026-D').at === T0 - 3600000);
  }

  group('the boot crawl serves out the interval instead of restarting it');
  {
    const MIN = 45, every = MIN * 60000, now = T0;
    ok('a cold box, with nothing saved, still crawls 20s after boot',
      bootCrawlDelayMs(0, MIN, now) === 20000, bootCrawlDelayMs(0, MIN, now));
    ok('...and so does one whose saved set carries no crawl time',
      bootCrawlDelayMs(undefined, MIN, now) === 20000, bootCrawlDelayMs(undefined, MIN, now));
    ok('a crawl from five minutes ago waits out the other forty',
      bootCrawlDelayMs(now - 5 * 60000, MIN, now) === every - 5 * 60000, bootCrawlDelayMs(now - 5 * 60000, MIN, now));
    ok('a crawl already older than the interval goes at once, not never',
      bootCrawlDelayMs(now - 2 * every, MIN, now) === 20000, bootCrawlDelayMs(now - 2 * every, MIN, now));
    ok('a crawl due in a second still keeps off the desk\'s first cycles',
      bootCrawlDelayMs(now - (every - 1000), MIN, now) === 20000, bootCrawlDelayMs(now - (every - 1000), MIN, now));
    ok('a crawl time in the future cannot park the crawl past one interval',
      bootCrawlDelayMs(now + 10 * every, MIN, now) === every, bootCrawlDelayMs(now + 10 * every, MIN, now));
    ok('the restart loop is broken: 21 restarts cost one crawl, not 21',
      [...Array(21)].every(() => bootCrawlDelayMs(now - 60000, MIN, now) === every - 60000));
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

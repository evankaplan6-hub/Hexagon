'use strict';
// Assertions for the Polymarket listings in src/venues/polymarket.js: every game of a league off its
// league tag (fetchGames, 2026-10-11), beside the top-N universe. The universe is the busiest N markets
// of all Polymarket by 24h volume, and on 2026-10-11 four of the 13 NFL games sat under that line, so
// the every-game book bet 9 of 13. No network: http.getJSON is stubbed before the venue module loads.
//
//   node tools/polymarket-test.js
const httpPath = require.resolve('../src/http');
const calls = [];
let pages = {};       // tag -> [page0 rows, page1 rows, ...]
let failTags = new Set();
let pageMs = 0;       // how long each page takes to answer
const opts = [];      // the options each call was made with
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true, children: [], paths: [],
  exports: {
    getJSON: async (url, o) => {
      calls.push(url); opts.push(o || {});
      if (pageMs) await new Promise((r) => setTimeout(r, pageMs));
      const u = new URL(url);
      const tag = u.searchParams.get('tag_id'), off = +u.searchParams.get('offset') || 0;
      if (failTags.has(tag)) throw new Error('HTTP 429');
      const list = pages[tag] || [];
      return list[off / 100] || [];
    },
    recentErrors: () => 0, stats: {}, noteError: () => {},
  },
};

const pm = require('../src/venues/polymarket');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (name) => console.log(`\n${name}`);

// A Gamma market row as the /markets listing returns it: strings for the arrays, a start time on a game.
const row = (id, over = {}) => ({
  id, question: `Team ${id} vs. Other ${id}`, slug: `nfl-a${id}-b${id}-2026-10-11`,
  outcomes: '["A", "B"]', outcomePrices: '["0.55", "0.45"]', clobTokenIds: `["t${id}y", "t${id}n"]`,
  bestBid: 0.55, bestAsk: 0.56, volume24hr: 1000, gameStartTime: '2026-10-11 17:00:00+00', endDate: '2026-10-11T17:00:00Z',
  sportsMarketType: 'moneyline', acceptingOrders: true, closed: false, feesEnabled: true, feeSchedule: { rate: 0.05 },
  events: [{ title: `Team ${id} vs. Other ${id}`, slug: `nfl-a${id}-b${id}-2026-10-11` }],
  ...over,
});

(async () => {
  group('fetchGames: the league tag, moneylines only, on the server');
  {
    pages = { 450: [[row('1'), row('2')]] };
    calls.length = 0;
    const r = await pm.fetchGames(['450']);
    ok('one call for a league whose first page is short', calls.length === 1, calls);
    const u = new URL(calls[0]);
    ok('...on the markets endpoint, by league tag', u.pathname === '/markets' && u.searchParams.get('tag_id') === '450', calls[0]);
    ok('...asking the server for moneylines alone', u.searchParams.get('sports_market_types') === 'moneyline', calls[0]);
    ok('...open, active, a hundred a page from offset 0',
      u.searchParams.get('closed') === 'false' && u.searchParams.get('active') === 'true' && u.searchParams.get('limit') === '100' && u.searchParams.get('offset') === '0', calls[0]);
    const ms = r.byTag.get('450');
    ok('both games come back, normalised like the universe', ms && ms.length === 2 && ms[0].venue === 'PM' && ms[0].id === '1' && ms[0].tokenIds.length === 2 && ms[0].sport === 'moneyline', ms);
    ok('...with the start time the matcher pairs on', ms[0].gameStart === '2026-10-11 17:00:00+00', ms[0].gameStart);
    ok('...and the fee rate the book is charged', ms[0].feeRate === 0.05, ms[0].feeRate);
    ok('no league failed', r.failed.length === 0, r.failed);
  }

  group('what is dropped: season futures, closed or one-sided markets');
  {
    pages = { 450: [[
      row('10'),
      row('11', { gameStartTime: null, slug: 'will-the-cardinals-win-the-season-series-against-the-rams-2026', question: 'Will the Cardinals win the season series?' }),
      row('12', { closed: true }),
      row('13', { acceptingOrders: false }),
      row('14', { bestBid: null, bestAsk: null }),
      row('15', { bestBid: 0.56, bestAsk: 0.55 }),
      row('16', { clobTokenIds: '["only-one"]' }),
    ]] };
    const r = await pm.fetchGames(['450']);
    const ids = r.byTag.get('450').map((m) => m.id);
    ok('a season-series future, moneyline by type but with no start time, is not a game', !ids.includes('11'), ids);
    ok('a closed market, one not accepting orders, one with no two-sided book, an inverted one or one token are dropped as the universe drops them',
      ids.join(',') === '10', ids);
  }

  group('pages: on until a short one, capped');
  {
    const full = (n) => Array.from({ length: 100 }, (_, i) => row(`${n}-${i}`));
    pages = { 100351: [full(0), full(1), [row('last')]] };
    calls.length = 0;
    const r = await pm.fetchGames(['100351']);
    ok('three pages read for a league of 201 games', calls.length === 3, calls.length);
    ok('...at offsets 0, 100, 200', calls.map((c) => new URL(c).searchParams.get('offset')).join(',') === '0,100,200', calls);
    ok('...and every row kept', r.byTag.get('100351').length === 201, r.byTag.get('100351').length);
    pages = { 100351: Array.from({ length: 30 }, (_, n) => full(n)) };
    calls.length = 0;
    const capped = await pm.fetchGames(['100351']);
    ok('a league that never pages short stops at ten pages', calls.length === 10, calls.length);
    ok('...keeps the thousand rows it read, and is named in capped (audit 2026-10-15: it was cut off silently)', capped.byTag.get('100351').length === 1000 && capped.capped.join() === '100351', capped.capped);
    pages = { 100351: [full(0), [row('last')]] };
    const whole = await pm.fetchGames(['100351']);
    ok('a league that pages short is not capped', whole.capped.length === 0, whole.capped);
  }

  group('one time budget for the whole read (audit 2026-10-15: ten slow pages held the taker cycle)');
  {
    const full = (n) => Array.from({ length: 100 }, (_, i) => row(`${n}-${i}`));
    pages = { 100351: Array.from({ length: 30 }, (_, n) => full(n)), 450: [[row('n1')]] };
    calls.length = 0; opts.length = 0; pageMs = 40;
    const t0 = Date.now();
    const r = await pm.fetchGames(['100351', '450'], { budgetMs: 100 });
    const took = Date.now() - t0;
    pageMs = 0;
    ok('no page starts once the budget is spent', calls.filter((c) => /tag_id=100351/.test(c)).length <= 3 && took < 250, { pages: calls.length, took });
    ok('a league that runs out is a failed league (its last good list stands), the others are kept', r.failed.join() === '100351' && r.byTag.get('450').length === 1 && !r.byTag.has('100351'), [r.failed, [...r.byTag.keys()]]);
    ok('each page\'s own timeout is held inside what is left of the budget', opts.every((o) => o.timeout > 0 && o.timeout <= 100), opts);
    calls.length = 0; opts.length = 0;
    pages = { 450: [[row('n1')]] };
    await pm.fetchGames(['450']);
    ok('the default budget is twenty seconds, and no page waits longer than the usual fifteen', opts[0].timeout === 15000, opts);
  }

  group('leagues in parallel, one failing does not fail the others');
  {
    pages = { 450: [[row('n1')]], 745: [[row('b1'), row('b2')]], 100351: [[row('c1')]] };
    failTags = new Set(['745']);
    calls.length = 0;
    const r = await pm.fetchGames(['450', '745', '100351', '450']);
    ok('a tag named twice is read once', calls.filter((c) => /tag_id=450/.test(c)).length === 1, calls);
    ok('the leagues that answered are in byTag', r.byTag.has('450') && r.byTag.has('100351') && r.byTag.get('450')[0].id === 'n1', [...r.byTag.keys()]);
    ok('the league that failed is named in failed, and not in byTag', r.failed.join() === '745' && !r.byTag.has('745'), r.failed);
    failTags = new Set(['450', '745', '100351']);
    let threw = null;
    try { await pm.fetchGames(['450', '745', '100351']); } catch (e) { threw = e; }
    ok('every league failing throws, so the caller keeps its last good lists', threw && /every Polymarket league listing failed/.test(threw.message), threw && threw.message);
    failTags = new Set(); calls.length = 0;
    const none = await pm.fetchGames([]);
    ok('no tags: nothing read, nothing failed', none.byTag.size === 0 && none.failed.length === 0 && calls.length === 0, [none.byTag.size, none.failed, calls.length]);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

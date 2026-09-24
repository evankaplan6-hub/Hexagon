'use strict';
// Assertions for the ChartExchange client and the option history -- no network, no wall clock.
//
// The client's one secret rides in every URL, so the first thing checked is that it cannot leak:
// not in an error, not through a `next` link, not in what a caller gets back. Then the parsers,
// because a bar with the wrong day or a strike named two ways would poison a history that a trial
// key cannot go back and re-pull. Then the archive itself: the calendar, the strike window, the
// file, and that a failure leaves nothing half-written.
//
//   node tools/chartexchange-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const cx = require('../src/venues/chartexchange');
const oh = require('./option-history');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'cx-'));
const KEY = 'PLANTED-chartexchange-key-9f8e7d';
const NOW = Date.UTC(2026, 8, 21, 16, 0, 0);   // noon in New York on Monday 2026-09-21

// A fetch that answers from a table of path → handler(params) and records every URL it was asked for.
function fakeFetch(routes, { status = 200, urls = [] } = {}) {
  return async (url) => {
    urls.push(url);
    const u = new URL(url);
    const params = Object.fromEntries(u.searchParams.entries());
    const h = routes[u.pathname.replace('/api/v1', '')];
    if (!h) return { status: 404, text: async () => '<html>not found</html>' };
    const r = h(params);
    if (r && r.__status) return { status: r.__status, text: async () => r.body };
    return { status, text: async () => JSON.stringify(r) };
  };
}
const day = (d) => Math.floor(Date.parse(`${d}T05:00:00Z`) / 1000);   // midnight ET (EDT/EST does not matter to the parser)

// ---------------------------------------------------------------- the key
group('the key');
{
  const urls = [];
  const s = cx.makeSession({ apiKey: KEY, pace: 0, tries: 1, fetchImpl: fakeFetch({
    '/feed/stocks/quote/': () => ({ __status: 400, body: `["Invalid symbol: US:NOPE see http://x/?api_key=${KEY}&page=2"]` }),
  }, { urls }) });
  let msg = '';
  (async () => {
    try { await s.quote('NOPE'); } catch (e) { msg = e.message; }
    ok('a bad symbol is a readable error', /HTTP 400: Invalid symbol: US:NOPE/.test(msg), msg);
    ok('...with the key scrubbed out of the API\'s own words', !msg.includes(KEY) && /api_key=\*\*\*/.test(msg), msg);
    ok('the key went out in the query string', urls.length === 1 && urls[0].includes(`api_key=${KEY}`));
    ok('scrub covers both the parameter and the bare value', cx.scrub(`x?api_key=${KEY}&y=1 and ${KEY} again`, KEY) === 'x?api_key=***&y=1 and *** again');
    ok('no key, no session', (() => { try { cx.makeSession({ apiKey: '' }); return false; } catch (e) { return /CHARTEXCHANGE_API_KEY/.test(e.message); } })());
    ok('enabled() reads the environment it is given', cx.enabled({ CHARTEXCHANGE_API_KEY: ' k ' }) && !cx.enabled({}) && cx.key({ CHARTEXCHANGE_API_KEY: ' k ' }) === 'k');
  })().then(part2);
}

// ---------------------------------------------------------------- paging, pacing, retries
async function part2() {
  group('paging, pacing, retries');
  {
    const urls = [];
    const s = cx.makeSession({ apiKey: KEY, pace: 0, fetchImpl: fakeFetch({
      '/ref/options/contracts/': (p) => {
        const page = Number(p.page);
        ok(`page ${page} asks for 500 rows`, p.page_size === '500', p);
        const rows = (n) => Array.from({ length: n }, (_, i) => ({ underlying: 'US:SPY', symbol: `US:SPY20240419C${400 + i + (page - 1) * 500}`, expiration: '2024-04-19', contract_type: 'C', strike: `${400 + i + (page - 1) * 500}.00` }));
        return page === 1 ? { count: 700, next: `http://chartexchange.com/api/v1/ref/options/contracts/?api_key=${KEY}&page=2`, previous: null, results: rows(500) }
          : { count: 700, next: null, previous: 'http://…', results: rows(200) };
      },
    }, { urls }) });
    const list = await s.contracts('SPY', { expiration: '2024-04-19' });
    ok('every page is read, by number', list.length === 700 && urls.length === 2 && /page=1/.test(urls[0]) && /page=2/.test(urls[1]), urls.map((u) => u.replace(KEY, 'KEY')));
    ok('the API\'s next link is never fetched', urls.every((u) => u.startsWith('https://chartexchange.com/api/v1/')));
    ok('and never returned', !JSON.stringify(list).includes('next') && !JSON.stringify(list).includes(KEY));
  }
  {
    const s = cx.makeSession({ apiKey: KEY, pace: 40, fetchImpl: fakeFetch({ '/feed/stocks/quote/': () => [{ symbol: 'SPY', price: '1' }] }) });
    const t0 = Date.now();
    await s.quote('SPY'); await s.quote('SPY'); await s.quote('SPY');
    ok('calls are spaced by the pace', Date.now() - t0 >= 75, Date.now() - t0);
    ok('calls are counted', s.stats.calls === 3, s.stats);
  }
  {
    let n = 0;
    const s = cx.makeSession({ apiKey: KEY, pace: 0, retryMs: 1, tries: 3, fetchImpl: fakeFetch({ '/feed/stocks/quote/': () => (++n < 3 ? { __status: 503, body: 'busy' } : [{ symbol: 'SPY', price: '2' }]) }) });
    const q = await s.quote('SPY');
    ok('a 5xx is retried and the third answer is taken', q.price === 2 && n === 3 && s.stats.retries === 2, [q, n, s.stats]);
    let n4 = 0, msg = '';
    const s4 = cx.makeSession({ apiKey: KEY, pace: 0, retryMs: 1, tries: 3, fetchImpl: fakeFetch({ '/feed/stocks/quote/': () => { n4++; return { __status: 401, body: '{"detail":"Unauthorized"}' }; } }) });
    let e4 = null;
    try { await s4.quote('SPY'); } catch (e) { e4 = e; msg = e.message; }
    ok('a 401 is not retried and says why', n4 === 1 && /HTTP 401: Unauthorized/.test(msg), [n4, msg]);
    ok('...and is flagged expired: the key, not the call, is what failed', e4 && e4.expired === true && e4.status === 401 && !e4.quota, e4);
    let n5 = 0;
    const s5 = cx.makeSession({ apiKey: KEY, pace: 0, retryMs: 1, tries: 2, fetchImpl: fakeFetch({ '/feed/stocks/quote/': () => { n5++; return { __status: 429, body: '' }; } }) });
    try { await s5.quote('SPY'); } catch (e) { msg = e.message; }
    ok('a 429 is retried, then given up with its status', n5 === 2 && /HTTP 429/.test(msg), [n5, msg]);
    let n7 = 0, q7 = null;
    const s7 = cx.makeSession({ apiKey: KEY, pace: 0, retryMs: 1, tries: 3, fetchImpl: fakeFetch({ '/feed/stocks/quote/': () => { n7++; return { __status: 406, body: '{"detail":"You have reached the maximum number of requests in trial mode. To continue, click \'Skip Trial\'."}' }; } }) });
    try { await s7.quote('SPY'); } catch (e) { q7 = e; }
    ok('the trial cap (406) is not retried and is flagged quota', n7 === 1 && q7 && q7.quota === true && q7.status === 406 && /maximum number of requests/.test(q7.message), [n7, q7 && q7.message]);
    const s6 = cx.makeSession({ apiKey: KEY, pace: 0, tries: 1, fetchImpl: async () => ({ status: 200, text: async () => '<html>' }) });
    try { await s6.quote('SPY'); } catch (e) { msg = e.message; }
    ok('a 200 that is not JSON is an error, not a quote', /not JSON/.test(msg), msg);
  }
  {
    // bars page by the last timestamp seen, stop on a short page or once `until` is in hand
    const asked = [];
    const s = cx.makeSession({ apiKey: KEY, pace: 0, fetchImpl: fakeFetch({
      '/data/stocks/bars/': (p) => {
        asked.push(Number(p.start));
        const start = Number(p.start);
        const n = Number(p.limit);
        let first = day('2024-01-02');                       // stamps are midnights, as the API's are
        while (first < start) first += 86400;
        return Array.from({ length: start < day('2024-03-01') ? n : 3 }, (_, i) => ({ timestamp: first + i * 86400, open: '1', high: '2', low: '0.5', close: `${i + 1}`, volume: '9' }));
      },
    }) });
    const bars = await s.bars('SPY', { start: 0 });
    ok('a full page is followed by another from the next second', asked.length === 2 && asked[1] === day('2024-01-02') + 499 * 86400 + 1, asked);
    ok('the pages are joined, sorted, one row per day', bars.length === 503 && bars[0].d === '2024-01-02' && bars.every((b, i) => i === 0 || b.d > bars[i - 1].d), bars.length);
  }
}

// ---------------------------------------------------------------- parsers
group('parsers');
{
  const b = cx.parseBars([
    { timestamp: 1764651600, open: '144.065', high: '145.515', low: '143.645', close: '144.65', volume: '15657800' },   // 2025-12-02 05:00Z, EST midnight
    { timestamp: 1764565200, open: '141.72', high: '143.6025', low: '141.285', close: '143.175', volume: '12793800' }, // 2025-12-01, out of order
    { timestamp: 1759377600, open: '1', high: '1', low: '1', close: '', volume: '0' },                                   // no close
    { timestamp: 1764565200, open: '141.72', high: '143.6025', low: '141.285', close: '143.2', volume: '12793801' },   // 2025-12-01 again: the last wins
    { timestamp: 1758600000, open: '5', high: '5', low: '5', close: '5', volume: '1' },                                 // 2025-09-23 04:00Z, EDT midnight
  ]);
  ok('bars: numbers, sorted by day, no row without a close', b.length === 3 && b.map((x) => x.d).join() === '2025-09-23,2025-12-01,2025-12-02' && b[2].c === 144.65 && b[2].v === 15657800, b);
  ok('bars: the trading day is the Eastern day of the stamp, summer and winter', b[0].d === '2025-09-23' && b[1].d === '2025-12-01');
  ok('bars: a repeated day keeps the later row', b[1].c === 143.2 && b[1].v === 12793801, b[1]);
  const ob = cx.parseOptionBars([{ timestamp: 1713499200, open: '1.52', high: '2.04', low: '0.01', close: '0.01', volume: '354009', open_interest: '52517' }, { timestamp: 1713412800, open: '3.57', high: '5.05', low: '1.51', close: '1.77', volume: '148111' }]);
  ok('option bars: open interest rides along, null when absent', ob[1].oi === 52517 && ob[1].d === '2024-04-19' && ob[0].oi === null, ob);
  const c = cx.parseContract({ underlying: 'US:TLT', symbol: 'US:TLT20240419C88.5', expiration: '2024-04-19', contract_type: 'C', strike: '88.50' });
  ok('a contract gets its chain-tape name', c.osi === 'TLT240419C00088500' && c.strike === 88.5 && c.right === 'C' && c.root === 'TLT' && c.cx === 'US:TLT20240419C88.5', c);
  ok('a malformed contract is null, not a guess', cx.parseContract({ symbol: 'x', expiration: 'soon', contract_type: 'C', strike: '1' }) === null && cx.parseContract(null) === null);
  ok('symbols: tickers are prefixed, prefixed ones left alone', cx.stockSym('spy') === 'US:SPY' && cx.stockSym('US:SPY') === 'US:SPY' && cx.cryptoSym('btc') === 'BTC:USD' && cx.cryptoSym('ETH:USD') === 'ETH:USD' && cx.cryptoSym('BTC-USD') === 'BTC:USD');
  ok('symbols: an option is spelled the API\'s way, no trailing zeros', cx.optionSym({ root: 'SPY', expiry: '2024-04-19', right: 'C', strike: 500 }) === 'US:SPY20240419C500' && cx.optionSym({ root: 'TLT', expiry: '2024-04-19', right: 'P', strike: 88.5 }) === 'US:TLT20240419P88.5');
  ok('symbols: OSI and CX name the same contract', cx.osiSym({ root: 'SPY', expiry: '2024-04-19', right: 'C', strike: 500 }) === 'SPY240419C00500000');
  const q = cx.parseQuote({ symbol: 'SPY', name: 'SPDR', as_of: '2026-09-23T19:59:59Z', price: '767.93', change: '-5.45', change_pct: '-0.705', exchange: 'NYSE', url: 'https://x' });
  ok('quote: numbers, and the url is not carried', q.price === 767.93 && q.changePct === -0.705 && q.asOf === '2026-09-23T19:59:59Z' && !('url' in q), q);
  const sv = cx.parseShortVolume({ date: '2026-09-22', rt: 19905772, st: 9443880.0, lt: 10461892.0, fs: 6857265.0, xnas: 1 });
  ok('short volume: the short share of the reported total, one decimal', sv.shortPct === 47.4 && sv.total === 19905772 && !('xnas' in sv), sv);
  ok('short volume: a row without a date is dropped', cx.parseShortVolume({ rt: 1 }) === null);
  const dp = cx.parseDarkPoolSummary({ total_count: 232389, total_premium: '10940061730.2000', total_volume: 14139795, bid_pct: '15.11', mid_pct: '63.95', ask_pct: '20.93', bid_volume: 1, mid_volume: 2, ask_volume: 3 });
  ok('dark pool summary: counts, dollars and the bid/mid/ask split', dp.trades === 232389 && dp.premium === 10940061730.2 && dp.atMidPct === 63.95 && dp.askVolume === 3, dp);
  const cs = cx.parseChainSummary({ underlying: 'US:SPY', expiration: '2026-09-30', max_pain: '761.00', call_itm: 97686, call_otm: 394084, put_itm: 33457, put_otm: 1521583, pc_ratio: '3.16' });
  ok('chain summary: max pain and the ratio as numbers', cs.maxPain === 761 && cs.putCallRatio === 3.16 && cs.putOtm === 1521583, cs);
}

// ---------------------------------------------------------------- the option history: calendar and window
group('the option history: calendar and window');
{
  ok('the third Friday', oh.thirdFriday(2024, 4) === '2024-04-19' && oh.thirdFriday(2025, 4) === '2025-04-18' && oh.thirdFriday(2026, 9) === '2026-09-18' && oh.thirdFriday(2021, 1) === '2021-01-15' && oh.thirdFriday(2024, 12) === '2024-12-20');
  ok('monthly expiries across a year end', oh.monthlyExpiries('2024-11', '2025-02').join() === '2024-11-15,2024-12-20,2025-01-17,2025-02-21');
  ok('an expiry that has not passed is not "expired"', oh.lastExpiredMonth('2026-09-23') === '2026-09' && oh.lastExpiredMonth('2026-09-18') === '2026-08' && oh.lastExpiredMonth('2026-09-19') === '2026-09' && oh.lastExpiredMonth('2026-01-02') === '2025-12');
  let threw = false;
  try { oh.monthlyExpiries('2024', '2025-01'); } catch { threw = true; }
  ok('months must be YYYY-MM', threw);
  const bars = [];
  for (let i = 0; i < 120; i++) bars.push({ d: new Date(Date.UTC(2024, 0, 1) + i * 86400000).toISOString().slice(0, 10), c: 100 + (i % 7) });   // closes 100..106
  bars.push({ d: '2024-04-20', c: 500 });    // the day after expiry: must not count
  bars.push({ d: '2024-02-08', c: 1 });      // the day before the window opens: must not count
  const w = oh.strikeWindow(bars.filter((b) => b.d !== '2024-02-08').concat([{ d: '2024-02-08', c: 1 }]), '2024-04-19', { band: 0.10, windowDays: 70 });
  ok('the window is the closes from expiry-70d to expiry, inclusive', w.from === '2024-02-09' && w.to === '2024-04-19' && w.low === 100 && w.high === 106 && w.days === 71, w);
  ok('strikes kept are the band around that range, edges in', Math.abs(w.lo - 90) < 1e-6 && Math.abs(w.hi - 116.6) < 1e-6);
  const cs = [{ strike: 89.99 }, { strike: 90 }, { strike: 100 }, { strike: 116.6 }, { strike: 117 }];
  ok('a strike on the edge is kept, one past it is not', oh.inWindow(cs, w).map((c) => c.strike).join() === '90,100,116.6');
  ok('no bars in the window: null, not an empty window', oh.strikeWindow([{ d: '2023-01-01', c: 5 }], '2024-04-19') === null && oh.strikeWindow([], '2024-04-19') === null);
}

// ---------------------------------------------------------------- the option history: the file and the run
async function part3() {
  group('the option history: the file and the run');
  // A fake ChartExchange: two monthly expiries of SPY (one holiday-shifted to Thursday), the
  // underlying's bars, and a contract whose bars endpoint fails on demand.
  const underlying = [];
  for (let i = 0; i < 600; i++) underlying.push({ timestamp: day('2024-01-01') + i * 86400, open: '100', high: '101', low: '99', close: `${100 + (i % 5)}`, volume: '1' });
  let failOn = null, badOn = null, capAfter = Infinity, deadAfter = Infinity;
  const urls = [];
  const routes = {
    '/data/stocks/bars/': (p) => underlying.filter((b) => b.timestamp >= Number(p.start)).slice(0, 500),
    '/ref/options/contracts/': (p) => {
      const exp = p.expiration;
      if (exp === '2025-04-18') return { count: 0, next: null, previous: null, results: [] };   // Good Friday
      if (exp !== '2025-04-17' && exp !== '2025-05-16') return { count: 0, next: null, previous: null, results: [] };
      const results = [];
      for (const k of [80, 95, 100, 104, 115.5, 130]) for (const right of ['C', 'P']) results.push({ underlying: 'US:SPY', symbol: `US:SPY${exp.replace(/-/g, '')}${right}${k}`, expiration: exp, contract_type: right, strike: k.toFixed(2) });
      return { count: results.length, next: null, previous: null, results };
    },
    '/data/options/bars/': (p) => {
      if (urls.length > capAfter) return { __status: 406, body: '{"detail":"You have reached the maximum number of requests in trial mode."}' };
      if (urls.length > deadAfter) return { __status: 401, body: '{"detail":"Expired"}' };
      // the source answers 500 to any start before its history begins, so the archiver must never ask
      if (Number(p.start) < Math.floor(Date.parse('2021-06-01T00:00:00Z') / 1000)) return { __status: 500, body: 'too early' };
      if (failOn && p.symbol === failOn) return { __status: 500, body: 'boom' };
      if (badOn && p.symbol === badOn) return { __status: 400, body: '["Invalid symbol: "]' };
      return [{ timestamp: day('2025-03-03'), open: '1', high: '2', low: '1', close: '1.5', volume: '3', open_interest: '10' }, { timestamp: day('2025-03-04'), open: '1.5', high: '1.5', low: '1', close: '1.2', volume: '1', open_interest: '12' }];
    },
  };
  const session = cx.makeSession({ apiKey: KEY, pace: 0, tries: 1, fetchImpl: fakeFetch(routes, { urls }) });
  const dir = tmp();
  const lines = [];
  const r = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, band: 0.10, windowDays: 70, now: () => Date.UTC(2025, 5, 1, 16), log: (l) => lines.push(l) });
  ok('both expiries pulled, the holiday one under its Thursday', r.pulled.join() === 'SPY 2025-04-17,SPY 2025-05-16' && fs.existsSync(oh.fileFor(dir, 'SPY', '2025-04-17')) && !fs.existsSync(oh.fileFor(dir, 'SPY', '2025-04-18')), r);
  const f = JSON.parse(fs.readFileSync(oh.fileFor(dir, 'SPY', '2025-04-17'), 'utf8'));
  ok('the file names its source, filters and columns', f.v === 1 && f.source === 'chartexchange' && f.symbol === 'SPY' && f.expiry === '2025-04-17' && f.band === 0.10 && f.windowDays === 70 && f.cols.join() === 'd,o,h,l,c,v,oi' && /no bid or ask/.test(f.note), f);
  ok('the window is written down: closes 100..104, strikes 90..114.4', f.window.low === 100 && f.window.high === 104 && f.window.lo === 90 && f.window.hi === 114.4 && f.window.from === '2025-02-06', f.window);
  ok('only strikes inside it are kept, calls then puts, by strike', f.listed === 12 && f.kept === 6 && f.contracts.map((c) => `${c.right}${c.k}`).join() === 'C95,C100,C104,P95,P100,P104', f.contracts.map((c) => c.osi));
  ok('each contract is named the chain tape\'s way and holds its bars as arrays', f.contracts[0].osi === 'SPY250417C00095000' && JSON.stringify(f.contracts[0].bars) === '[["2025-03-03",1,2,1,1.5,3,10],["2025-03-04",1.5,1.5,1,1.2,1,12]]', f.contracts[0]);
  ok('no next link and no key reached the disk', !fs.readFileSync(oh.fileFor(dir, 'SPY', '2025-04-17'), 'utf8').includes(KEY) && !JSON.stringify(f).includes('"next"'));
  const u = JSON.parse(fs.readFileSync(oh.underlyingFile(dir, 'SPY'), 'utf8'));
  ok('the underlying\'s bars are cached beside the expiries', u.symbol === 'SPY' && u.bars.length === 600 && u.bars[0].d === '2024-01-01' && /not dividend-adjusted/.test(u.note), [u.bars.length, u.note]);
  ok('the run reports what it did', r.expiries === 2 && r.contracts === 12 && r.bars === 24 && r.missing === 0 && r.skipped.length === 0 && r.failed.length === 0 && r.calls === urls.length, r);
  ok('the log reads like the recorder\'s', lines.length === 2 && /^SPY 2025-04-17  12 listed · 6 kept \(90–114\.4\) · 12 bars · \d+ KB · \d+s$/.test(lines[0]), lines);

  // a second run finds the files and fetches nothing per contract
  const calls1 = session.stats.calls;
  const r2 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, now: () => Date.UTC(2025, 5, 1, 16) });
  ok('a file on disk is not pulled again, under either spelling of its date', r2.existing === 2 && r2.pulled.length === 0 && session.stats.calls === calls1, [r2, session.stats.calls - calls1]);
  const r3 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-04', dir, refresh: true, now: () => Date.UTC(2025, 5, 1, 16) });
  ok('--refresh pulls it again', r3.pulled.length === 1 && r3.existing === 0, r3);

  // the source refusing one contract (a 5xx): asked again from later starts, then written as missing
  fs.rmSync(path.join(dir, 'SPY'), { recursive: true });
  failOn = 'US:SPY20250417P100';
  const before4 = urls.length;
  const logs4 = [];
  const r4 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, now: () => Date.UTC(2025, 5, 1, 16), log: (l) => logs4.push(l) });
  const asked = urls.slice(before4).filter((u) => u.includes('SPY20250417P100')).map((u) => Number(new URL(u).searchParams.get('start')));
  ok('the ladder: the floor, two days on, then a month before the window', asked.join() === [day('2021-06-01') - 5 * 3600, day('2021-06-03') - 5 * 3600, day('2025-01-07') - 5 * 3600].join(), asked);
  const f4 = JSON.parse(fs.readFileSync(oh.fileFor(dir, 'SPY', '2025-04-17'), 'utf8'));
  const miss = f4.contracts.find((c) => c.err);
  ok('the file is written with the contract marked, not dropped', f4.kept === 6 && f4.missing === 1 && miss && miss.osi === 'SPY250417P00100000' && miss.bars.length === 0 && /HTTP 500/.test(miss.err), [f4.missing, miss]);
  ok('and the run says so', r4.missing === 1 && r4.pulled.length === 2 && /6 kept .* 1 MISSING/.test(logs4[0]), [r4.missing, logs4[0]]);
  failOn = null;
  const r4b = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, repair: true, now: () => Date.UTC(2025, 5, 1, 16), log: () => {} });
  const f4b = JSON.parse(fs.readFileSync(oh.fileFor(dir, 'SPY', '2025-04-17'), 'utf8'));
  ok('--repair asks for the marked contract only and clears the mark', r4b.repaired === 1 && r4b.missing === 0 && f4b.missing === 0 && !f4b.contracts.some((c) => c.err) && f4b.contracts.find((c) => c.osi === 'SPY250417P00100000').bars.length === 2 && f4b.repairedAt, [r4b, f4b.missing]);
  ok('the ladder is not used for starts already after the floor', oh.startLadder({ from: '2021-06-15' }).length === 2 && oh.startLadder({ from: '2021-07-10' }).length === 3);

  // the trial's request cap: the run stops there, what was pulled stays, nothing half-written
  fs.rmSync(path.join(dir, 'SPY'), { recursive: true });
  capAfter = urls.length + 4;   // the underlying, the listing, and two contracts' bars are served; then the cap
  const logs6 = [];
  const r6c = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, now: () => Date.UTC(2025, 5, 1, 16), log: (l) => logs6.push(l) });
  ok('the cap stops the run and names where', r6c.stopped && /^SPY 2025-04-18: HTTP 406: You have reached the maximum/.test(r6c.stopped) && r6c.pulled.length === 0 && r6c.failed.length === 0, r6c);
  ok('nothing half-written, no file for the cut-off expiry', !fs.existsSync(oh.fileFor(dir, 'SPY', '2025-04-17')) && !fs.existsSync(`${oh.fileFor(dir, 'SPY', '2025-04-17')}.tmp`) && fs.existsSync(oh.underlyingFile(dir, 'SPY')));
  ok('and the remaining expiry was not even asked for', !urls.slice(-3).some((u) => u.includes('2025-05-16')), urls.slice(-3).map((u) => u.replace(KEY, 'KEY')));
  capAfter = Infinity;

  // the key expired (2026-09-23, "HTTP 401: Expired" on every call): the run stops on the first
  // one, like the cap, rather than spending a call per expiry to be refused 67 times
  fs.rmSync(path.join(dir, 'SPY'), { recursive: true });
  deadAfter = urls.length + 4;
  const before6d = urls.length;
  const r6d = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, now: () => Date.UTC(2025, 5, 1, 16), log: () => {} });
  ok('an expired key stops the run and names where', r6d.stopped && /^SPY 2025-04-18: HTTP 401: Expired/.test(r6d.stopped) && r6d.pulled.length === 0 && r6d.failed.length === 0, r6d);
  ok('...after one refused call, not one per expiry', urls.length - before6d === 5, urls.length - before6d);
  ok('...and nothing half-written', !fs.existsSync(oh.fileFor(dir, 'SPY', '2025-04-17')) && !fs.existsSync(`${oh.fileFor(dir, 'SPY', '2025-04-17')}.tmp`));
  deadAfter = Infinity;

  // this side's own mistake (a 4xx) fails the expiry, writes nothing, and the run goes on
  fs.rmSync(path.join(dir, 'SPY'), { recursive: true });
  badOn = 'US:SPY20250417P100';
  const r5x = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, now: () => Date.UTC(2025, 5, 1, 16), log: () => {} });
  ok('the failed expiry has no file, not a partial one', !fs.existsSync(oh.fileFor(dir, 'SPY', '2025-04-17')) && !fs.existsSync(`${oh.fileFor(dir, 'SPY', '2025-04-17')}.tmp`) && fs.existsSync(oh.fileFor(dir, 'SPY', '2025-05-16')));
  ok('and is reported by contract, with the run continuing', r5x.failed.length === 1 && /SPY250417P00100000: HTTP 400/.test(r5x.failed[0].why) && r5x.pulled.join() === 'SPY 2025-05-16', r5x.failed);
  badOn = null;

  // a dry run lists and writes nothing
  fs.rmSync(path.join(dir, 'SPY'), { recursive: true });
  const before = session.stats.calls;
  const r5 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, dryRun: true, now: () => Date.UTC(2025, 5, 1, 16) });
  ok('a dry run counts contracts and writes no expiry file', r5.pulled.length === 2 && r5.contracts === 12 && r5.bars === 0 && !fs.existsSync(oh.fileFor(dir, 'SPY', '2025-05-16')), r5);
  ok('...fetching only the listings and the underlying', session.stats.calls - before <= 5, session.stats.calls - before);

  // expiries after "today" are not history yet
  const r6 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, dryRun: true, now: () => Date.UTC(2025, 4, 1, 16) });
  ok('an expiry still ahead is left to the chain tape', r6.expiries === 1 && r6.pulled.join() === 'SPY 2025-04-17', r6);
  const r7 = await oh.archive(session, { symbols: ['SPY'], from: '2025-04', to: '2025-05', dir, dryRun: true, newestFirst: true, now: () => Date.UTC(2025, 5, 1, 16) });
  ok('--newest-first walks the expiries backwards', r7.pulled.join() === 'SPY 2025-05-16,SPY 2025-04-17', r7.pulled);
  ok('the six underlyings are the chain tape\'s six', oh.SYMBOLS.join() === 'SPY,QQQ,IWM,DIA,TLT,GLD');
  ok('the default run starts where the source\'s option history does', oh.FROM === '2021-07' && oh.OPTION_BARS_FROM === '2021-06-01' && /2021-06-01/.test(f.note), [oh.FROM, f.note]);
}

setTimeout(async () => {
  await part3();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}, 300);

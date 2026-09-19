'use strict';
// Assertions for the Kalshi pacer in src/http.js -- no network, no wall clock.
//
// The pacer exists because the taker's eleven-listing burst and the maker's tape poll kept landing
// in the same instant, and Kalshi refused the overlap: a 0.07s requote became 2.1s of backoff, and
// the refusals tripped TESS's halt. Three things have to hold for the fix to be a fix: calls to one
// host start at least `gapMs` apart, the maker's priority calls go ahead of anything queued without
// ever breaking that spacing, and nothing that is not paced waits at all.
//
//   node tools/http-test.js
const http = require('../src/http');
const { makePacer } = http;

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

// a clock that only moves when the pacer sleeps
function fakeClock() {
  let t = 1000;
  const sleeps = [];
  // time advances a turn of the event loop later, after whatever the last start set in motion has
  // read the clock -- as a real timer would
  return { now: () => t, sleep: (ms) => { sleeps.push(ms); return new Promise((r) => setImmediate(() => { t += ms; r(); })); }, sleeps };
}

async function run() {
  group('an idle line: the call goes at once');
  {
    const c = fakeClock();
    const p = makePacer({ gapMs: 80, now: c.now, sleep: c.sleep });
    await p.take();
    ok('no sleep for the first call', c.sleeps.length === 0, c.sleeps);
    ok('nothing left queued', p.queued() === 0);
  }

  group("the taker's burst: eleven calls at once start 80ms apart");
  {
    const c = fakeClock();
    const p = makePacer({ gapMs: 80, now: c.now, sleep: c.sleep });
    const starts = [];
    await Promise.all(Array.from({ length: 11 }, (_, i) => p.take().then(() => starts.push([i, c.now()]))));
    const gaps = starts.slice(1).map(([, t], i) => t - starts[i][1]);
    ok('all eleven started', starts.length === 11);
    ok('in the order they were asked', starts.every(([i], k) => i === k), starts.map(([i]) => i));
    ok('every start is at least 80ms after the one before', gaps.every((g) => g >= 80), gaps);
    ok('...and no more than that (the line does not dawdle)', gaps.every((g) => g === 80), gaps);
    ok('the whole burst spreads over 800ms', starts[10][1] - starts[0][1] === 800, starts[10][1] - starts[0][1]);
  }

  group("the maker's calls jump the line, but not the gap");
  {
    const c = fakeClock();
    const p = makePacer({ gapMs: 80, now: c.now, sleep: c.sleep });
    const order = [];
    const took = (name, pri) => p.take(pri).then(() => order.push([name, c.now()]));
    const all = [took('listing-1'), took('listing-2'), took('listing-3'), took('tape', true), took('book', true)];
    await Promise.all(all);
    const names = order.map(([n]) => n);
    ok('the first listing was already on its way', names[0] === 'listing-1', names);
    ok('tape and book go next, ahead of the queued listings', names[1] === 'tape' && names[2] === 'book', names);
    ok('the listings follow, in their own order', names[3] === 'listing-2' && names[4] === 'listing-3', names);
    const gaps = order.slice(1).map(([, t], i) => t - order[i][1]);
    ok('priority never closes the gap below 80ms', gaps.every((g) => g >= 80), gaps);
  }

  group('a priority call that arrives while the line is waiting still goes first');
  {
    const c = fakeClock();
    let wake, held = false;
    // the first sleep is released by hand, so a call can arrive mid-wait; later ones run as usual
    const sleep = (ms) => {
      if (held) return c.sleep(ms);
      held = true;
      return new Promise((r) => { wake = () => c.sleep(ms).then(r); });
    };
    const p = makePacer({ gapMs: 80, now: c.now, sleep });
    const order = [];
    const a = p.take().then(() => order.push('a'));
    const b = p.take().then(() => order.push('b'));     // queued; the pacer is now asleep
    await a;
    const late = p.take(true).then(() => order.push('late-tape'));
    wake();
    await Promise.all([b, late]);
    ok('the late priority call beat the normal one that was already waiting', order.join(',') === 'a,late-tape,b', order);
  }

  group('pacing off: a zero gap never queues');
  {
    const c = fakeClock();
    const p = makePacer({ gapMs: 0, now: c.now, sleep: c.sleep });
    await Promise.all([p.take(), p.take(), p.take(true)]);
    ok('no sleeps at all', c.sleeps.length === 0, c.sleeps);
  }

  group('getJSON: only the paced host takes turns');
  {
    const real = global.fetch;
    const seen = [];
    global.fetch = async (url) => { seen.push(String(url)); return { ok: true, json: async () => ({}) }; };
    const KS = 'https://api.elections.kalshi.com/trade-api/v2';
    try {
      // a fake clock whose first wait is released by hand: nothing moves until the test says so
      let release;
      const c = fakeClock();
      const sleep = (ms) => (release ? c.sleep(ms) : new Promise((r) => { release = () => c.sleep(ms).then(r); }));
      http.paceHost(KS, 80, { now: c.now, sleep });
      const calls = [
        http.getJSON(`${KS}/markets?series_ticker=A`),
        http.getJSON(`${KS}/markets?series_ticker=B`),
        http.getJSON(`${KS}/markets/trades?limit=1000`, { priority: true }),
        http.getJSON('https://gamma-api.polymarket.com/markets'),
      ];
      // before the wait is released: the first Kalshi call and the Polymarket call are out, the rest wait
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      ok('the first Kalshi call went at once', seen.includes(`${KS}/markets?series_ticker=A`), seen);
      ok('the Polymarket call did not queue behind Kalshi', seen.includes('https://gamma-api.polymarket.com/markets'), seen);
      ok('the other two Kalshi calls are still waiting their turn', seen.length === 2, seen);
      release();
      await Promise.all(calls);
      const ksOrder = seen.filter((u) => u.startsWith(KS)).map((u) => u.slice(KS.length));
      ok('the maker tape went ahead of the queued listing', ksOrder.join(' ') === '/markets?series_ticker=A /markets/trades?limit=1000 /markets?series_ticker=B', ksOrder);
      // and switched off, a burst goes straight out again
      http.paceHost(KS, 0);
      seen.length = 0;
      const burst = [1, 2, 3].map((i) => http.getJSON(`${KS}/markets?series_ticker=C${i}`));
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
      ok('paceHost(base, 0) removes the pacer: all three out at once', seen.length === 3, seen);
      await Promise.all(burst);
    } finally {
      http.paceHost(KS, 0);
      global.fetch = real;
    }
  }
}

async function retryTests() {
  group('a refused call (429) is tried once more before it counts as an error');
  const real = global.fetch;
  const KS = 'https://api.elections.kalshi.com/trade-api/v2';
  const answer = (status, body = {}, headers = {}) => ({ ok: status < 400, status, headers: { get: (k) => headers[k.toLowerCase()] ?? null }, json: async () => body });
  const noSleep = { slept: [], fn: (ms) => { noSleep.slept.push(ms); return Promise.resolve(); } };
  try {
    let replies = [answer(429, {}, { 'retry-after': '1' }), answer(200, { ok: 1 })];
    let n = 0;
    global.fetch = async () => replies[Math.min(n++, replies.length - 1)];
    const before = http.recentErrors(), throttled = http.stats.throttled;
    const j = await http.getJSON(`${KS}/markets`, { sleep: noSleep.fn });
    ok('a 429 then a success returns the success', j && j.ok === 1 && n === 2, { j, n });
    ok('...waiting what Retry-After asked', noSleep.slept[0] === 1000, noSleep.slept);
    ok('...and counts no error toward the halt', http.recentErrors() === before, http.recentErrors());
    ok('...though it is counted as a throttle', http.stats.throttled === throttled + 1);

    replies = [answer(429), answer(429)]; n = 0; noSleep.slept.length = 0;
    let threw = null;
    try { await http.getJSON(`${KS}/markets`, { sleep: noSleep.fn }); } catch (e) { threw = e; }
    ok('two 429s in a row throw, once', threw && /HTTP 429/.test(threw.message) && n === 2, { n, threw: threw && threw.message });
    ok('...and count exactly one error', http.recentErrors() === before + 1, http.recentErrors());
    ok('...with a wait held to at least half a second when Retry-After says nothing', noSleep.slept[0] === 500, noSleep.slept);

    replies = [answer(429, {}, { 'retry-after': '30' }), answer(200, {})]; n = 0; noSleep.slept.length = 0;
    await http.getJSON(`${KS}/markets`, { sleep: noSleep.fn });
    ok('a long Retry-After is capped at 2 seconds', noSleep.slept[0] === 2000, noSleep.slept);

    replies = [answer(500)]; n = 0;
    const b5 = http.recentErrors();
    try { await http.getJSON(`${KS}/markets`, { sleep: noSleep.fn }); } catch { /* expected */ }
    ok('a 500 is not retried and counts at once', n === 1 && http.recentErrors() === b5 + 1, { n });
  } finally { global.fetch = real; }
}

// The stall watchdog's evidence: which calls are started and not finished, and for how long.
async function inflightTests() {
  group('calls that have started and not finished can be listed, and are gone when they finish');
  const real = global.fetch;
  const KS = 'https://api.elections.kalshi.com/trade-api/v2';
  try {
    let release;
    global.fetch = () => new Promise((r) => { release = () => r({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ ok: 1 }) }); });
    ok('nothing in flight to begin with', http.inflight().length === 0, http.inflight());
    const p = http.getJSON(`${KS}/markets?series_ticker=KXTEST`);
    await new Promise((r) => setImmediate(r));
    const now = Date.now() + 42000;
    const held = http.inflight(now);
    ok('a call waiting on the network is listed', held.length === 1 && held[0].phase === 'fetch' && /series_ticker=KXTEST/.test(held[0].url), held);
    ok('...with its age', held[0].ageSec >= 41 && held[0].ageSec <= 43, held[0]);
    release();
    await p;
    ok('...and gone once it returns', http.inflight().length === 0, http.inflight());

    global.fetch = async () => { throw new Error('boom'); };
    try { await http.getJSON(`${KS}/markets`); } catch { /* expected */ }
    ok('...and gone when it fails', http.inflight().length === 0, http.inflight());

    // a call still waiting for its turn is listed as queued, and counted
    // a pacer whose wait holds until the test lets it go
    let t = 1000, letGo = null;
    http.paceHost(KS, 1000, { now: () => t, sleep: (ms) => new Promise((r) => { letGo = () => { t += ms; r(); }; }) });
    global.fetch = async () => ({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({}) });
    const first = http.getJSON(`${KS}/a`), second = http.getJSON(`${KS}/b`);
    await first;
    await new Promise((r) => setImmediate(r));
    ok('a call waiting for its turn is listed as queued', http.inflight().length === 1 && http.inflight()[0].phase === 'queue', http.inflight());
    ok('...and the queue is counted', http.queued() === 1, http.queued());
    while (!letGo) await new Promise((r) => setImmediate(r));
    letGo();
    await second;
    ok('...and it drains', http.inflight().length === 0 && http.queued() === 0, { held: http.inflight(), q: http.queued() });
  } finally { global.fetch = real; http.paceHost(KS, 0); }
}

run()
  .then(retryTests)
  .then(inflightTests)
  .catch((e) => { fail++; console.log(`  FAIL  threw: ${e.stack}`); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

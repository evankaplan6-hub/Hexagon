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

run()
  .catch((e) => { fail++; console.log(`  FAIL  threw: ${e.stack}`); })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

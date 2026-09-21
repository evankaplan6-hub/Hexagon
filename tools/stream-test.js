'use strict';
// Assertions for src/kalshi-ws.js and the tape's use of it (src/tape.js) -- no network.
//
// The socket is how the maker desk now sees the exchange-wide tape, and the tape is how it sees
// its own fills. Two things have to be true for that to be safe: a frame off the wire has to be
// parsed exactly (a mis-parsed length desynchronises every frame after it), and any interval the
// socket cannot vouch for has to be POLLED and paged back rather than trusted empty. Both are
// asserted here with a fake stream and a fake REST endpoint.
//
//   node tools/stream-test.js
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseFrames, frame, normalizeTrade, acceptFor, openTradeStream } = require('../src/kalshi-ws');
const { makeTape } = require('../src/tape');
const http = require('../src/http');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

group('framing: what the server sends is parsed back exactly');
{
  // server frames are unmasked: 0x81 = FIN + text, then a 7-bit length
  const small = Buffer.concat([Buffer.from([0x81, 5]), Buffer.from('hello')]);
  let r = parseFrames(small);
  ok('a short text frame', r.frames.length === 1 && r.frames[0].op === 1 && r.frames[0].fin && r.frames[0].payload.toString() === 'hello', r);
  ok('...leaves nothing over', r.rest.length === 0);

  // the client's own frames are masked; the parser unmasks them, which makes a roundtrip a test
  const mid = 'x'.repeat(300), big = 'y'.repeat(70000);
  r = parseFrames(Buffer.concat([frame(1, Buffer.from(mid)), frame(1, Buffer.from(big))]));
  ok('a 16-bit length and a 64-bit length in one buffer', r.frames.length === 2 && r.frames[0].payload.toString() === mid && r.frames[1].payload.toString() === big, r.frames.map((f) => f.payload.length));

  // a frame cut mid-way stays in `rest` until the rest of it arrives
  const whole = frame(1, Buffer.from('a complete message'));
  r = parseFrames(whole.subarray(0, 7));
  ok('a partial frame yields nothing', r.frames.length === 0 && r.rest.length === 7, r);
  r = parseFrames(Buffer.concat([r.rest, whole.subarray(7)]));
  ok('...and parses once the rest arrives', r.frames.length === 1 && r.frames[0].payload.toString() === 'a complete message', r);

  // the control frames the keep-alive protocol turns on
  r = parseFrames(Buffer.concat([Buffer.from([0x89, 9]), Buffer.from('heartbeat')]));
  ok('a ping frame carries its opcode and body', r.frames[0].op === 9 && r.frames[0].payload.toString() === 'heartbeat', r.frames[0]);
  r = parseFrames(Buffer.from([0x88, 2, 0x03, 0xe8]));
  ok('a close frame carries its code', r.frames[0].op === 8 && r.frames[0].payload.readUInt16BE(0) === 1000, r.frames[0]);

  // a client frame is masked (RFC 6455 §5.1): the mask bit is set and the body is not plaintext
  const f = frame(1, Buffer.from('secret'), Buffer.from([1, 2, 3, 4]));
  ok('a client frame sets the mask bit', (f[1] & 0x80) !== 0);
  ok('...and does not carry the text in the clear', !f.toString('latin1').includes('secret'));
  ok('...but unmasks to it', parseFrames(f).frames[0].payload.toString() === 'secret');

  ok('an empty buffer is not a frame', parseFrames(Buffer.alloc(0)).frames.length === 0);
  ok('one byte is not a frame', parseFrames(Buffer.from([0x81])).frames.length === 0);
}

group('handshake: the accept key is the one the spec computes');
{
  // the worked example in RFC 6455 §1.3
  ok('RFC 6455 example key', acceptFor('dGhlIHNhbXBsZSBub25jZQ==') === 's3pPLMBiTxaQ9kYGzzhZRbK+xOo=', acceptFor('dGhlIHNhbXBsZSBub25jZQ=='));
}

group('normalizeTrade: a socket print looks exactly like a REST row');
{
  // the example from Kalshi's public-trades doc, verbatim field names
  const msg = { trade_id: 'd91bc706-ee49-470d-82d8-11418bda6fed', market_ticker: 'HIGHNY-22DEC23-B53.5', yes_price_dollars: '0.3600', no_price_dollars: '0.6400', count_fp: '136.00', taker_side: 'no', taker_outcome_side: 'no', taker_book_side: 'ask', is_block_trade: false, ts: 1669149841, ts_ms: 1669149841000 };
  const t = normalizeTrade(msg);
  ok('the ticker is under the REST name', t.ticker === 'HIGHNY-22DEC23-B53.5', t);
  ok('created_time is the millisecond stamp as ISO', t.created_time === '2022-11-22T20:44:01.000Z', t.created_time);
  ok('_t is the millisecond stamp', t._t === 1669149841000, t._t);
  ok('the fields fillsFrom reads are untouched', t.trade_id === msg.trade_id && t.yes_price_dollars === '0.3600' && t.count_fp === '136.00' && t.taker_book_side === 'ask' && t.is_block_trade === false, t);
  ok('a print with only the second stamp still parses', normalizeTrade({ ...msg, ts_ms: undefined })._t === 1669149841000);
  ok('a print with no id is dropped', normalizeTrade({ ...msg, trade_id: '' }) === null);
  ok('a print with no market is dropped', normalizeTrade({ ...msg, market_ticker: undefined }) === null);
  ok('a print with no stamp is dropped', normalizeTrade({ ...msg, ts: undefined, ts_ms: undefined }) === null);
  ok('garbage is dropped', normalizeTrade(null) === null && normalizeTrade('x') === null);
}

// ---------------------------------------------------------------- the tape with a stream
group('the tape reads the socket when it can vouch for the interval, and polls when it cannot');
{
  const T = (id, secs, ticker = 'A') => ({ trade_id: id, ticker, created_time: new Date(1000000000000 + secs * 1000).toISOString(), yes_price_dollars: '0.50', count_fp: '1', taker_book_side: 'bid' });
  const W = (id, secs, ticker = 'A') => ({ ...T(id, secs, ticker), _t: 1000000000000 + secs * 1000 });   // as normalizeTrade shapes it
  // a stream the test drives by hand
  const fake = () => { let next = { trades: [], healthy: false }; return { drain: () => { const d = next; next = { trades: [], healthy: false }; return d; }, feed: (trades, healthy) => { next = { trades, healthy }; }, health: () => ({}) }; };
  const serve = (pages) => {
    const calls = [];
    http.getJSON = async (url) => {
      calls.push(url);
      const m = url.match(/cursor=([^&]+)/);
      const p = pages[m ? m[1] : 'first'];
      if (!p) throw new Error(`no page for cursor ${m ? m[1] : 'first'}`);
      return { trades: p.trades, cursor: p.next || '' };
    };
    return calls;
  };
  const real = http.getJSON;
  const run = async () => {
    const s = fake();
    const tape = makeTape({ maxPages: 5, stream: s });

    // round 1: the socket has just connected, so it cannot vouch for the interval before -> poll
    s.feed([W('c', 12)], false);
    let calls = serve({ first: { trades: [T('c', 12), T('b', 11), T('a', 10, 'Z')], next: 'p2' } });
    let r = await tape.since(['A']);
    ok('an unhealthy socket means a poll', calls.length === 1 && r.source === 'poll', { calls, source: r.source });
    ok('...returning the union, each print once', r.trades.map((t) => t.trade_id).join() === 'b,c', r.trades.map((t) => t.trade_id));

    // round 2: healthy -> no request at all, prints straight from the buffer, oldest first
    s.feed([W('e', 14), W('d', 13), W('z', 13.5, 'Z')], true);
    calls = serve({});
    r = await tape.since(['A']);
    ok('a healthy socket means no request', calls.length === 0 && r.source === 'stream', { calls, source: r.source });
    ok('...only the wanted tickers, oldest first', r.trades.map((t) => t.trade_id).join() === 'd,e', r.trades.map((t) => t.trade_id));
    ok('...and never a gap', r.gap === false && r.gaps === 0, r);

    // round 3: a print already returned arrives again (a reconnect replay) -> not returned twice
    s.feed([W('e', 14), W('f', 15)], true);
    r = await tape.since(['A']);
    ok('a print older than the last one returned is dropped', r.trades.map((t) => t.trade_id).join() === 'f', r.trades.map((t) => t.trade_id));

    // round 3b: a DIFFERENT print stamped the same millisecond as the newest one returned. The
    // exchange runs ~160 prints a second, so this is ordinary; judged on the stamp alone it read
    // as a repeat and a quote it would have filled never was.
    s.feed([W('f', 15), W('f2', 15)], true);
    r = await tape.since(['A']);
    ok('a second print in the same millisecond is new, the repeat is not', r.trades.map((t) => t.trade_id).join() === 'f2', r.trades.map((t) => t.trade_id));
    s.feed([W('f2', 15)], true);
    r = await tape.since(['A']);
    ok('...and it is not returned twice either', r.trades.length === 0, r.trades.map((t) => t.trade_id));

    // round 4: a sequence gap -> poll, and the poll pages back to f (t=15), so g and h are found
    // even though the socket only delivered h
    s.feed([W('h', 17)], false);
    calls = serve({
      first: { trades: [T('h', 17), T('g', 16)], next: 'p2' },
      p2: { trades: [T('f', 15), T('e', 14)], next: '' },
    });
    r = await tape.since(['A']);
    ok('a gap means a poll that pages back to the last print', calls.length === 2 && r.source === 'poll', { calls: calls.length, source: r.source });
    ok('...which finds what the socket missed', r.trades.map((t) => t.trade_id).join() === 'g,h', r.trades.map((t) => t.trade_id));
    ok('...and is not counted as a gap, because nothing was lost', r.gap === false && r.gaps === 0, r);

    // round 5: healthy again, and the watermark carried across sources
    s.feed([W('h', 17), W('i', 18)], true);
    calls = serve({});
    r = await tape.since(['A']);
    ok('back on the socket, the watermark set by the poll holds', calls.length === 0 && r.trades.map((t) => t.trade_id).join() === 'i', r.trades.map((t) => t.trade_id));

    // a healthy socket with nothing buffered is a quiet exchange, not a failure
    s.feed([], true);
    r = await tape.since(['A']);
    ok('a healthy, empty drain returns nothing and polls nothing', r.trades.length === 0 && r.source === 'stream' && calls.length === 0, r);

    // a stream attached later is used from then on
    const tape2 = makeTape({ maxPages: 5 });
    calls = serve({ first: { trades: [T('a', 10)], next: '' } });
    await tape2.since(['A']);
    const s2 = fake();
    tape2.setStream(s2);
    s2.feed([W('b', 11)], true);
    calls = serve({});
    r = await tape2.since(['A']);
    ok('setStream attaches a socket to a tape already polling', calls.length === 0 && r.trades.map((t) => t.trade_id).join() === 'b', r.trades);
    ok('stats count both sources', tape2.stats().polled === 1 && tape2.stats().streamed === 1, tape2.stats());
  };

  // ---- the real client against nothing: no key file, then a refused port
  const clientRun = async () => {
    let threw = null;
    try { openTradeStream({ keyId: 'k', keyPath: path.join(os.tmpdir(), `no-such-key-${process.pid}.pem`) }); }
    catch (e) { threw = e; }
    ok('a missing key file fails at open, not later', !!threw, threw && threw.message);

    // a real key, a port nothing listens on: the client must report unhealthy, never throw, and
    // keep trying with a backoff until closed
    const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    const keyPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-ws-')), 'k.pem');
    fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    const events = [];
    const s = openTradeStream({ keyId: 'test', keyPath, url: 'wss://127.0.0.1:1/trade-api/ws/v2', onEvent: (t, d) => events.push([t, d]) });
    const d0 = s.drain();
    ok('before connecting, a drain is unhealthy and empty', d0.healthy === false && d0.trades.length === 0, d0);
    await new Promise((r) => setTimeout(r, 1500));
    const h = s.health();
    ok('a refused connection leaves it disconnected with the reason recorded', h.connected === false && /connect error/.test(h.lastCloseReason || ''), h);
    ok('...without an open event', !events.some((e) => e[0] === 'open'), events);
    s.close();
    ok('close is idempotent', (s.close(), true));
    fs.rmSync(path.dirname(keyPath), { recursive: true, force: true });
  };

  run().catch((e) => { fail++; console.log(`  FAIL  tape+stream threw: ${e.message}`); })
    .finally(() => { http.getJSON = real; })
    .then(clientRun)
    .catch((e) => { fail++; console.log(`  FAIL  client threw: ${e.message}`); })
    .then(() => {
      console.log(`\n${pass} passed, ${fail} failed`);
      process.exit(fail ? 1 : 0);
    });
}

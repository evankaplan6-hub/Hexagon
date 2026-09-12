'use strict';
// Kalshi's public trade channel over WebSocket, with no dependencies.
//
// Why at all: the maker desk sees its fills by reading the exchange-wide tape, and until now it
// read that tape by polling /markets/trades every two seconds. A page is 1000 prints and the
// exchange runs at ~160 a second, so a busy stretch outran a page, and every such poll was a window
// in which a resting quote could have filled unseen -- 145 of them in the first two days on the
// cloud box. Paging back by cursor (src/tape.js) closed most of that; it still costs a round trip
// every two seconds and still sees a print up to two seconds late. The socket delivers each print
// as it happens, numbered, so a missed print is KNOWN rather than suspected. When anything is
// missed -- a reconnect, a skipped sequence number, a full buffer -- the tape falls back to the
// poll for that round, and the poll pages back to the last print it saw. Nothing is lost silently.
//
// Why hand-rolled: Kalshi authenticates the HANDSHAKE with the same three signed headers the REST
// API uses (an unsigned upgrade is refused with a 401, public channel or not), and Node's built-in
// WebSocket cannot send handshake headers. The alternative was an npm package, and this repo has
// none on purpose. The client side of RFC 6455 is small: one HTTP upgrade, masked frames out,
// unmasked frames in, every ping answered with a pong.
//
// Scope: READ-ONLY market data. The key signs the handshake and nothing else. No order path
// touches this file, and it is never opened without a key, so a box that carries no key (the
// cloud deployment, by design -- see ops/DEPLOY.md) keeps polling exactly as before.
const https = require('https');
const crypto = require('crypto');
const fs = require('fs');

const DEFAULT_URL = 'wss://api.elections.kalshi.com/trade-api/ws/v2';
const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';   // RFC 6455 §1.3, fixed by the spec
const OP = { CONT: 0x0, TEXT: 0x1, BIN: 0x2, CLOSE: 0x8, PING: 0x9, PONG: 0xa };

// ---------------------------------------------------------------- framing (pure)
// Every complete frame at the front of `buf`, and whatever partial frame is left over.
// Server frames arrive unmasked; a masked one is still unmasked here so the parser is total.
function parseFrames(buf) {
  const frames = [];
  let off = 0;
  while (buf.length - off >= 2) {
    const b0 = buf[off], b1 = buf[off + 1];
    const fin = (b0 & 0x80) !== 0, op = b0 & 0x0f, masked = (b1 & 0x80) !== 0;
    let len = b1 & 0x7f, hdr = 2;
    if (len === 126) { if (buf.length - off < 4) break; len = buf.readUInt16BE(off + 2); hdr = 4; }
    else if (len === 127) { if (buf.length - off < 10) break; len = Number(buf.readBigUInt64BE(off + 2)); hdr = 10; }
    if (masked) hdr += 4;
    if (buf.length - off < hdr + len) break;
    let payload = buf.subarray(off + hdr, off + hdr + len);
    if (masked) {
      const m = buf.subarray(off + hdr - 4, off + hdr);
      const out = Buffer.allocUnsafe(len);
      for (let i = 0; i < len; i++) out[i] = payload[i] ^ m[i & 3];
      payload = out;
    }
    frames.push({ fin, op, payload });
    off += hdr + len;
  }
  return { frames, rest: buf.subarray(off) };
}

// One client frame. The spec requires every client-to-server frame to be masked (§5.1); a server
// closes the connection on an unmasked one.
function frame(op, payload = Buffer.alloc(0), mask = crypto.randomBytes(4)) {
  const len = payload.length;
  let hdr;
  if (len < 126) hdr = Buffer.from([0x80 | op, 0x80 | len]);
  else if (len < 65536) { hdr = Buffer.alloc(4); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 126; hdr.writeUInt16BE(len, 2); }
  else { hdr = Buffer.alloc(10); hdr[0] = 0x80 | op; hdr[1] = 0x80 | 127; hdr.writeBigUInt64BE(BigInt(len), 2); }
  const body = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i++) body[i] = payload[i] ^ mask[i & 3];
  return Buffer.concat([hdr, mask, body]);
}

const acceptFor = (key) => crypto.createHash('sha1').update(key + GUID).digest('base64');

// A trade message shaped exactly like a row from /markets/trades, so maker.fillsFrom and the tape
// cannot tell which source a print came from. The socket names the market `market_ticker` and
// stamps `ts_ms`; the REST row says `ticker` and `created_time`. Everything else -- trade_id,
// yes_price_dollars, count_fp, taker_book_side, is_block_trade -- is the same field under the same
// name, checked against Kalshi's AsyncAPI schema.
function normalizeTrade(msg) {
  if (!msg || !msg.trade_id || !msg.market_ticker) return null;
  const ms = Number.isFinite(+msg.ts_ms) ? +msg.ts_ms : Number.isFinite(+msg.ts) ? +msg.ts * 1000 : NaN;
  if (!Number.isFinite(ms)) return null;
  return { ...msg, ticker: msg.market_ticker, created_time: new Date(ms).toISOString(), _t: ms };
}

// ---------------------------------------------------------------- the stream
// `onEvent(type, detail)` is how the desk hears about it: 'open', 'close', 'auth', 'gap'. Never
// throws into the caller; a socket that cannot connect is a stream that reports unhealthy.
function openTradeStream({ keyId, keyPath, url = DEFAULT_URL, onEvent = () => {}, maxBuffer = 200000, staleMs = 30000 } = {}) {
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath, 'utf8'));
  const u = new URL(url);
  const buf = [];
  const st = {
    connected: false, connecting: false, closed: false,
    // `gap` is the one bit the tape reads: has there been ANY window since the last drain in
    // which a print could have been missed? Set on every (re)connect, sequence skip and overflow;
    // cleared by drain. A connect sets it because the interval BEFORE the socket came up is
    // uncovered, so the first round after connecting still polls, and the poll pages back.
    gap: true,
    sid: null, lastSeq: null,
    reconnects: 0, seqGaps: 0, overflows: 0, messages: 0, trades: 0,
    lastFrameAt: 0, connectedAt: 0, lastCloseReason: '', backoffMs: 1000,
  };
  let socket = null, pending = Buffer.alloc(0), fragments = null, cmdId = 0, reconnectTimer = null;

  const say = (type, detail) => { try { onEvent(type, detail); } catch { /* the desk's problem, not the socket's */ } };

  function signedHeaders() {
    const ts = String(Date.now());
    const sig = crypto.sign('sha256', Buffer.from(ts + 'GET' + u.pathname), {
      key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
    return { 'KALSHI-ACCESS-KEY': keyId, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts };
  }

  function send(obj) {
    if (!socket || socket.destroyed) return;
    socket.write(frame(OP.TEXT, Buffer.from(JSON.stringify(obj))));
  }

  function onMessage(text) {
    let m;
    try { m = JSON.parse(text); } catch { return; }
    st.messages++;
    if (m.type === 'trade') {
      if (st.sid != null && m.sid !== st.sid) return;             // not ours
      // Sequence numbers are per subscription and contiguous. A skip is a print we never saw.
      if (st.lastSeq != null && Number.isFinite(m.seq) && m.seq !== st.lastSeq + 1) {
        st.gap = true; st.seqGaps++;
        say('gap', { expected: st.lastSeq + 1, got: m.seq });
      }
      if (Number.isFinite(m.seq)) st.lastSeq = m.seq;
      const t = normalizeTrade(m.msg);
      if (!t) return;
      st.trades++;
      buf.push(t);
      // A consumer that stops draining does not get to keep the socket's memory. Drop the oldest
      // and say so: the tape treats an overflow as a gap and polls back over it.
      if (buf.length > maxBuffer) { buf.splice(0, buf.length - maxBuffer); if (!st.gap) { st.gap = true; st.overflows++; } }
    } else if (m.type === 'subscribed') {
      st.sid = m.msg && m.msg.sid != null ? m.msg.sid : null;
      st.lastSeq = null;
      st.connected = true; st.connecting = false;
      st.connectedAt = Date.now(); st.backoffMs = 1000;
      say('open', { sid: st.sid, reconnects: st.reconnects });
    } else if (m.type === 'error') {
      say('error', m.msg || m);
    }
  }

  function onData(chunk) {
    st.lastFrameAt = Date.now();
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    const { frames, rest } = parseFrames(pending);
    pending = rest;
    for (const f of frames) {
      if (f.op === OP.PING) { if (socket && !socket.destroyed) socket.write(frame(OP.PONG, f.payload)); continue; }
      if (f.op === OP.PONG) continue;
      if (f.op === OP.CLOSE) { drop(`server close${f.payload.length >= 2 ? ` ${f.payload.readUInt16BE(0)}` : ''}`); return; }
      if (f.op === OP.TEXT || f.op === OP.CONT) {
        if (f.op === OP.TEXT && f.fin) { onMessage(f.payload.toString('utf8')); continue; }
        // fragmented text: collect until FIN
        fragments = f.op === OP.TEXT ? [f.payload] : (fragments || []).concat([f.payload]);
        if (f.fin) { onMessage(Buffer.concat(fragments).toString('utf8')); fragments = null; }
      }
      // binary frames are not part of this protocol; ignored
    }
  }

  // Tear the socket down and, unless closed for good, schedule another attempt.
  function drop(reason) {
    const was = st.connected || st.connecting;
    st.connected = false; st.connecting = false; st.sid = null; st.lastSeq = null;
    st.gap = true; st.lastCloseReason = reason;
    if (socket) { const s = socket; socket = null; try { s.destroy(); } catch { /* already gone */ } }
    pending = Buffer.alloc(0); fragments = null;
    if (was) say('close', { reason });
    if (st.closed || reconnectTimer) return;
    reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, st.backoffMs);
    reconnectTimer.unref();
    st.backoffMs = Math.min(st.backoffMs * 2, 30000);
  }

  function connect() {
    if (st.closed || socket) return;
    st.connecting = true;
    if (st.connectedAt) st.reconnects++;
    const wsKey = crypto.randomBytes(16).toString('base64');
    let req;
    try {
      req = https.request({
        host: u.hostname, port: u.port || 443, path: u.pathname + u.search, method: 'GET', timeout: 15000,
        headers: {
          Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': wsKey,
          'user-agent': 'the-hexagon/1.0', ...signedHeaders(),
        },
      });
    } catch (e) { drop(`request failed: ${e.message}`); return; }
    req.on('upgrade', (res, sock, head) => {
      if (res.headers['sec-websocket-accept'] !== acceptFor(wsKey)) { sock.destroy(); drop('bad accept key'); return; }
      socket = sock;
      st.lastFrameAt = Date.now();
      sock.setNoDelay(true);
      sock.on('data', onData);
      sock.on('error', (e) => drop(`socket error: ${e.message}`));
      sock.on('close', () => { if (socket === sock) drop('socket closed'); });
      if (head && head.length) onData(head);
      // exchange-wide: the desk filters for the tickers it quotes, and the set it quotes changes
      // every scan. ~160 prints a second at ~350 bytes is ~55 KB/s inbound, which is nothing.
      send({ id: ++cmdId, cmd: 'subscribe', params: { channels: ['trade'] } });
    });
    req.on('response', (res) => {
      // a plain HTTP response means the upgrade was refused; 401 is a bad or missing signature
      res.resume();
      if (res.statusCode === 401 || res.statusCode === 403) { st.backoffMs = Math.max(st.backoffMs, 60000); say('auth', { status: res.statusCode }); }
      drop(`upgrade refused: HTTP ${res.statusCode}`);
    });
    req.on('timeout', () => { req.destroy(new Error('handshake timeout')); });
    req.on('error', (e) => drop(`connect error: ${e.message}`));
    req.end();
  }

  // The server pings every ten seconds; a socket that has been silent for `staleMs` is dead
  // whatever the TCP layer thinks, and a dead socket that looks connected would make the tape
  // trust an empty buffer.
  const watchdog = setInterval(() => {
    if (st.closed || !socket) return;
    if (Date.now() - st.lastFrameAt > staleMs) drop(`silent for ${Math.round((Date.now() - st.lastFrameAt) / 1000)}s`);
  }, 5000);
  watchdog.unref();

  // Everything buffered since the last drain, and whether the socket covered the whole interval.
  // `healthy` false means: poll this round, and page back.
  function drain() {
    const trades = buf.splice(0, buf.length);
    const healthy = st.connected && !st.gap;
    st.gap = false;
    return { trades, healthy };
  }

  function health() {
    return {
      connected: st.connected, reconnects: st.reconnects, seqGaps: st.seqGaps, overflows: st.overflows,
      trades: st.trades, connectedAt: st.connectedAt || null, lastFrameAt: st.lastFrameAt || null,
      lastCloseReason: st.lastCloseReason || null, buffered: buf.length,
    };
  }

  function close() {
    st.closed = true;
    clearInterval(watchdog);
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    if (socket && !socket.destroyed) { try { socket.write(frame(OP.CLOSE, Buffer.from([0x03, 0xe8]))); } catch { /* closing anyway */ } }
    drop('closed by desk');
  }

  connect();
  return { drain, health, close };
}

module.exports = { openTradeStream, parseFrames, frame, normalizeTrade, acceptFor, DEFAULT_URL };

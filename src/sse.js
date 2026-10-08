'use strict';
// The dashboard's event stream (/api/stream): one per open tab, a desk snapshot every two seconds.
//
// Fly compresses /api/state on its way out but not an event stream, so on 2026-09-24 every open
// dashboard or lookout tab pulled the whole uncompressed snapshot, about 250 KB a second, 21 GB a
// day, from the box. Taking the P&L histories out of the frame (engine.snapshot) cut it to about
// 199 KB; this compresses what is left. Each client gets its own gzip stream, flushed after every
// frame so the frame arrives whole and at once instead of sitting in the compressor's buffer until
// enough follows it. A browser decodes it without being asked; a client that does not say it can
// takes the plain stream as before.
const zlib = require('zlib');

// A client that stops reading without closing (a phone that lost signal, a tab frozen by the OS) left every
// frame to pile up in the box's memory: a 200 KB frame every 100 ms grew 3.6 MB to 24 MB in ten seconds
// (audit 2026-10-07). Each frame is the whole current state, so one that cannot be sent costs nothing the
// next does not carry: it is dropped while more than this is waiting to go out, and the client is cut off
// after DROP_LIMIT frames in a row (a minute at two a second) so it reconnects fresh.
const MAX_BUFFERED = 1 << 20;
const DROP_LIMIT = 30;

// Does this request take gzip? `gzip` or `*` in accept-encoding, unless its q is zero.
function takesGzip(req) {
  const accept = String((req && req.headers && req.headers['accept-encoding']) || '');
  return accept.split(',').some((part) => {
    const [name, ...params] = part.trim().toLowerCase().split(';').map((x) => x.trim());
    if (name !== 'gzip' && name !== '*') return false;
    const q = params.find((x) => x.startsWith('q='));
    return !q || Number(q.slice(2)) > 0;
  });
}

// Open the stream on `res` and return what the server sends frames through. Level 1, the fastest:
// on a 248 KB frame it came to 53 KB in about 1 ms, where the default level took twice the time for
// 44 KB, and the box is pinned at its CPU cap.
function openStream(req, res) {
  const gzip = takesGzip(req);
  const headers = { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive', 'x-accel-buffering': 'no' };
  if (gzip) { headers['content-encoding'] = 'gzip'; headers.vary = 'accept-encoding'; }
  res.writeHead(200, headers);
  let gz = null;
  if (gzip) {
    gz = zlib.createGzip({ level: zlib.constants.Z_BEST_SPEED });
    gz.on('error', () => res.destroy());
    gz.pipe(res);
  }
  let dropped = 0;
  const waiting = () => (res.writableLength || 0) + (gz ? gz.writableLength + gz.readableLength : 0);
  return {
    gzip,
    waiting,
    send(text) {
      if (waiting() > MAX_BUFFERED) { if (++dropped >= DROP_LIMIT) res.destroy(); return false; }
      dropped = 0;
      if (!gz) { res.write(text); return true; }
      gz.write(text);
      // a sync flush ends the frame on a byte boundary the browser can decode, and keeps the
      // compressor's window, so the next frame still compresses against this one
      gz.flush(zlib.constants.Z_SYNC_FLUSH);
      return true;
    },
    close() { if (gz) { gz.unpipe(res); gz.destroy(); } },
  };
}

// One server-sent event carrying `obj`.
const frame = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

module.exports = { openStream, takesGzip, frame, MAX_BUFFERED, DROP_LIMIT };

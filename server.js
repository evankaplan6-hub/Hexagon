'use strict';
// The Hexagon — entry point. Serves the dashboard, streams engine state, runs the desk.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

loadEnv(path.join(__dirname, '.env'));
const cfg = require('./src/config');
const { Engine } = require('./src/engine');

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

if (cfg.mode === 'live') {
  const problems = [];
  if (cfg.demo) problems.push('DEMO=1 cannot be combined with MODE=live');
  if (!cfg.liveConfirm) problems.push('LIVE_CONFIRM must be exactly I_UNDERSTAND_REAL_MONEY');
  if (!cfg.kalshiKeyId) problems.push('KALSHI_API_KEY_ID is empty');
  if (!cfg.kalshiKeyPath || !fs.existsSync(cfg.kalshiKeyPath)) problems.push('KALSHI_PRIVATE_KEY_PATH does not point to a file');
  if (problems.length) {
    console.error('Refusing to start in LIVE mode:\n  - ' + problems.join('\n  - '));
    process.exit(1);
  }
}

const engine = new Engine(cfg);
const clients = new Set();
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

function json(res, obj) {
  res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
}

// Anything not on loopback must carry a password. This is the same shape as the live-mode guard:
// a refusal at startup rather than a warning nobody reads, because the failure mode is silent --
// a public address serves the whole book and log to anyone who finds the port.
const LOOPBACK = ['127.0.0.1', '::1', 'localhost'];
if (!LOOPBACK.includes(cfg.bindHost) && !cfg.dashPass) {
  console.error(`Refusing to start: BIND_HOST=${cfg.bindHost} is not loopback and DASH_PASS is empty.`);
  console.error('  /api/positions and the full activity log are unauthenticated.');
  console.error('  Set DASH_PASS in .env, or bind to 127.0.0.1 and reach it over an SSH tunnel.');
  process.exit(1);
}

// A real login page, not HTTP basic auth.
//
// Basic auth depends on the browser popping a native dialog, and plenty of browsers -- embedded
// panes, in-app webviews -- simply do not. What the user sees then is the 401 body as plain text
// with no way to enter anything: "authentication required" on a white page and no prompt. A form
// and a cookie work everywhere.
//
// The cookie is an HMAC of a fixed string under the password, so there is no session store to keep
// and changing DASH_PASS invalidates every cookie already issued. Basic auth still works alongside
// it, because curl and the tools in tools/ use it.
const COOKIE = 'hexsession';
const sessionToken = () => crypto.createHmac('sha256', cfg.dashPass).update('hexagon-session-v1').digest('hex');

function timingEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
function authed(req) {
  if (!cfg.dashPass) return true;
  const cookies = String(req.headers.cookie || '');
  const m = cookies.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  if (m && timingEq(m[1], sessionToken())) return true;
  const h = String(req.headers.authorization || '');
  if (h.startsWith('Basic ')) {
    return timingEq(Buffer.from(h.slice(6), 'base64').toString('utf8'), `${cfg.dashUser}:${cfg.dashPass}`);
  }
  return false;
}

const LOGIN_PAGE = (err) => `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>The Hexagon</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#06080c;
         color:#e6e8ee; font:14px/1.5 'JetBrains Mono',ui-monospace,Menlo,monospace; }
  form { width:min(320px,90vw); background:#0d1119; border:1px solid #1a2233; border-radius:8px;
         padding:26px; box-shadow:0 18px 50px -20px #000; }
  h1 { margin:0 0 4px; font:700 17px/1 system-ui,sans-serif; letter-spacing:-0.01em; }
  p.sub { margin:0 0 20px; color:#5b6270; font-size:11px; letter-spacing:.1em; text-transform:uppercase; }
  label { display:block; font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:#5b6270; margin:12px 0 5px; }
  input { width:100%; box-sizing:border-box; padding:9px 10px; background:#06080c; color:#e6e8ee;
          border:1px solid #243047; border-radius:4px; font:13px 'JetBrains Mono',monospace; }
  input:focus { outline:none; border-color:#3b82f6; }
  button { width:100%; margin-top:18px; padding:10px; background:#1b2a1e; color:#4ade80; cursor:pointer;
           border:1px solid #2a5a38; border-radius:4px; font:700 12px 'JetBrains Mono',monospace; letter-spacing:.1em; }
  button:hover { background:#22331f; }
  .err { margin-top:14px; color:#f87171; font-size:11px; }
  .hex { display:block; margin:0 auto 14px; }
</style>
<form method="POST" action="/login">
  <svg class="hex" viewBox="0 0 40 40" width="34" height="34"><polygon points="20,3 35,11.5 35,28.5 20,37 5,28.5 5,11.5" fill="none" stroke="#55617a" stroke-width="2"/><polygon points="20,15.5 24.5,18 24.5,22 20,24.5 15.5,22 15.5,18" fill="#6b7488"/></svg>
  <h1>The Hexagon</h1><p class="sub">paper trading desk</p>
  <label for="u">User</label><input id="u" name="u" value="${cfg.dashUser}" autocomplete="username">
  <label for="p">Password</label><input id="p" name="p" type="password" autofocus autocomplete="current-password">
  <button type="submit">ENTER</button>
  ${err ? '<div class="err">wrong user or password</div>' : ''}
</form>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (cfg.dashPass && p === '/login') {
    if (req.method === 'POST') {
      return readBody(req).then((body) => {
        const f = new URLSearchParams(body);
        if (timingEq(f.get('u') || '', cfg.dashUser) && timingEq(f.get('p') || '', cfg.dashPass)) {
          const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
          res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
          return res.end();
        }
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE(true));
      });
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_PAGE(false));
  }
  if (!authed(req)) {
    // an API caller gets a 401 it can act on; a browser gets somewhere to type
    if (p.startsWith('/api/')) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="The Hexagon", charset="UTF-8"' });
      return res.end('authentication required');
    }
    res.writeHead(302, { location: '/login' });
    return res.end();
  }
  // Manual kill switch. TESS's drawdown halt stops NEW risk while leaving every open position
  // running -- halted is not the same as flat. This is the button for getting out of everything.
  // POST only (a GET would fire from a stray link or a prefetch), shared secret required, and
  // disabled outright when FLATTEN_TOKEN is unset: a guessable default is worse than no switch.
  if (p === '/api/flatten') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    if (!cfg.flattenToken) { res.writeHead(503); return res.end('flatten disabled: set FLATTEN_TOKEN in .env'); }
    if (req.headers['x-flatten-token'] !== cfg.flattenToken) { res.writeHead(403); return res.end('bad token'); }
    return engine.flattenAll(url.searchParams.get('reason') || 'manual')
      .then((r) => json(res, r))
      .catch((e) => { res.writeHead(500); res.end(String(e.message).slice(0, 200)); });
  }
  if (p === '/api/resume') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    if (!cfg.flattenToken) { res.writeHead(503); return res.end('disabled: set FLATTEN_TOKEN in .env'); }
    if (req.headers['x-flatten-token'] !== cfg.flattenToken) { res.writeHead(403); return res.end('bad token'); }
    return json(res, engine.resume());
  }
  if (p === '/api/state') return json(res, engine.snapshot());
  if (p === '/api/pairs') return json(res, engine.pairs.map((x) => ({ ...x, q: x.q || null })));
  if (p === '/api/trades') return json(res, engine.state.closed);
  if (p === '/api/positions') return json(res, engine.state.positions);
  if (p === '/api/log') return json(res, engine.state.log);
  if (p === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(engine.snapshot())}\n\n`);
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  const rel = p === '/' ? '/index.html' : p;
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).pipe(res);
});

setInterval(() => {
  if (!clients.size) return;
  const payload = `data: ${JSON.stringify(engine.snapshot())}\n\n`;
  for (const c of clients) c.write(payload);
}, 2000);

// Loopback by default: /api/positions and the whole activity log are unauthenticated, and on a
// live account that is not something to hand the local network. BIND_HOST=0.0.0.0 to override.
server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`The Hexagon  →  http://localhost:${cfg.port}   mode=${cfg.mode.toUpperCase()}${cfg.demo ? ' (DEMO quotes)' : ''}   bound to ${cfg.bindHost}${cfg.dashPass ? '   password set' : ''}${cfg.flattenToken ? '   flatten switch armed' : ''}`);
});

engine.start().catch((e) => { console.error('engine failed to start:', e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { engine.save(); console.log('\nstate saved, bye'); process.exit(0); });

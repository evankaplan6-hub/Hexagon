'use strict';
// The Hexagon — entry point. Serves the dashboard, streams engine state, runs the desk.
const fs = require('fs');
const path = require('path');
const http = require('http');

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

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
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
  console.log(`The Hexagon  →  http://localhost:${cfg.port}   mode=${cfg.mode.toUpperCase()}${cfg.demo ? ' (DEMO quotes)' : ''}   bound to ${cfg.bindHost}${cfg.flattenToken ? '   flatten switch armed' : ''}`);
});

engine.start().catch((e) => { console.error('engine failed to start:', e); process.exit(1); });

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { engine.save(); console.log('\nstate saved, bye'); process.exit(0); });

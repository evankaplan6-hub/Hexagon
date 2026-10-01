'use strict';
// The Hexagon — entry point. Serves the dashboard, streams engine state, runs the desk.
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

require('./src/env').loadEnv(path.join(__dirname, '.env'));
const cfg = require('./src/config');
const { Engine } = require('./src/engine');
const { Desk } = require('./src/desk/engine');
const { pmFloor } = require('./src/pmfloor');
const { actionRefusal, rebindRefusal, routeAsk } = require('./src/ask');
const chaintape = require('./src/chaintape');
const { crashRecord } = require('./src/journal');
const sse = require('./src/sse');

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
// The stocks, crypto and options desk (src/desk/), the desk's main work since 2026-09-25. It shares
// this process with the prediction-market desk above and nothing else: its own ledger under
// data/desk/, its own journal, its own loop, and no broker at all -- paper only whatever MODE says.
// The prediction-market desk trades in paper beside it. Since 2026-09-29 the floor at / shows it whole,
// its four books as cards and its bots in the same activity list (src/pmfloor.js); it used to be one line.
const pmSummary = () => pmFloor(engine, cfg);
// A desk that cannot load its ledger stays down with the reason in the log, and the page falls back
// to the prediction-market floor: its positions still have to settle.
let desk = null;
if (cfg.desk.on) {
  try { desk = new Desk(cfg, { legacy: pmSummary, onStall: deskStalled }); }
  catch (e) { console.error(`stocks/crypto/options desk not started: ${e.message}`); }
}
// START, STOP and CRASH in the journal (src/journal.js says why): a restart the desk did not ask
// for has to be countable the next morning, not just visible in a log that rolls over in half an
// hour. Never in the way of starting or exiting: the journal already swallows a failed write.
const lifecycle = (kind, payload) => { try { engine.journal(engine, kind, payload); } catch { /* the exit still happens */ } };
// The stocks, crypto and options desk's watchdog found its loop stuck (src/desk/engine.js watchdogCheck),
// and has already said so in its own log and journal and saved its ledger. The WATCHDOG line here is what
// tells tools/restarts.js that the next START was this, and the other desk's ledger is saved too, as a
// signal would; then the process ends and Fly starts it again.
function deskStalled(stalled) {
  lifecycle('WATCHDOG', { stalled, restarting: true });
  try { engine.save(); } catch { /* ending anyway */ }
  setTimeout(() => process.exit(1), 250);
}
const clients = new Set();
const deskClients = new Set();
const PUBLIC = path.join(__dirname, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json',
  '.webmanifest': 'application/manifest+json' };
// What an iPhone, an iPad or a Mac fetches to put the floor on its Home Screen or in its Dock, before anyone
// has logged in: the icons and the manifest that names them. They hold no figure from either desk, so they
// are served to anyone, and nothing else is: without them the icon a phone saved was a picture of the login.
const OPEN_FILES = new Set(['/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest']);

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
// Written only once every startup refusal above has passed: a refused start never ran, and a
// START with no STOP after it would read as an unexplained restart the next morning.
lifecycle('START', { sha: cfg.buildSha || null, pid: process.pid });

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
// A one-click link, so the dashboard can be opened without transcribing a password on a phone.
// Derived from DASH_PASS but NOT equal to it: the password itself never travels in a URL, where it
// would end up in browser history and every proxy log between here and the machine. Changing
// DASH_PASS invalidates the link along with every session.
const linkToken = () => crypto.createHmac('sha256', cfg.dashPass).update('hexagon-link-v1').digest('hex').slice(0, 32);

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

// Drawn as the floor is (public/tokens.css, Apple's colours, light or dark as the device is set), and as
// the first thing an iPhone shows when the floor is opened from its Home Screen: the app's icon, and the
// two fields as an iOS grouped list. Their type is 17px: under 16, Safari on an iPhone zooms the page to
// a field as it is tapped.
const attr = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const LOGIN_PAGE = (err) => `<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light dark">
<meta name="theme-color" content="#f2f2f7" media="(prefers-color-scheme: light)">
<meta name="theme-color" content="#000000" media="(prefers-color-scheme: dark)">
<meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-title" content="Hexagon">
<link rel="icon" href="/favicon.svg" type="image/svg+xml"><link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest"><title>The Hexagon</title>
<style>
  :root { color-scheme: light dark; --bg: light-dark(#f2f2f7, #000000); --card: light-dark(#ffffff, #1c1c1e); --ink: light-dark(#1d1d1f, #f5f5f7);
    --ink-3: light-dark(#5d5d62, #9d9da4); --sep: light-dark(#e5e5ea, #38383a); --bad: light-dark(#d70015, #ff453a); --focus: light-dark(#0071e3, #2997ff); }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; min-height: 100dvh; display: grid; place-items: center; padding: max(24px, env(safe-area-inset-top)) 16px max(24px, env(safe-area-inset-bottom));
    background: var(--bg); color: var(--ink); font: 400 15px/1.4 -apple-system, BlinkMacSystemFont, system-ui, 'Segoe UI', Roboto, sans-serif; letter-spacing: -.01em;
    -webkit-font-smoothing: antialiased; -webkit-text-size-adjust: 100%; }
  form { width: min(360px, 100%); text-align: center; }
  .icon { display: block; width: 76px; height: 76px; margin: 0 auto 18px; border-radius: 17px; box-shadow: 0 8px 24px light-dark(rgba(0, 0, 0, .16), rgba(0, 0, 0, .5)); }
  h1 { margin: 0; font-size: 28px; font-weight: 700; letter-spacing: -.02em; }
  .sub { margin: 4px 0 28px; color: var(--ink-3); }
  .fields { overflow: hidden; border-radius: 14px; background: var(--card); text-align: left; }
  label { display: flex; align-items: center; gap: 12px; min-height: 50px; margin-left: 16px; padding-right: 16px; font-size: 17px; }
  label + label { border-top: 1px solid var(--sep); }
  label span { flex: none; width: 88px; }
  input { flex: 1; min-width: 0; padding: 12px 0; border: 0; outline: 0; background: none; color: inherit; font: inherit; }
  .fields:focus-within { box-shadow: 0 0 0 3px var(--focus); }
  button { width: 100%; min-height: 50px; margin-top: 20px; border: 0; border-radius: 14px; cursor: pointer;
    background: #0071e3; color: #ffffff; font: 600 17px/1 -apple-system, BlinkMacSystemFont, system-ui, sans-serif; letter-spacing: -.01em; }
  button:active { opacity: .7; }
  button:focus-visible { outline: 3px solid var(--focus); outline-offset: 2px; }
  .err { margin-top: 14px; color: var(--bad); font-size: 13px; }
</style>
<form method="POST" action="/login">
  <img class="icon" src="/apple-touch-icon.png" alt="">
  <h1>The Hexagon</h1><p class="sub">Paper trading desk</p>
  <div class="fields">
    <label><span>User</span><input name="u" value="${attr(cfg.dashUser)}" autocomplete="username" autocapitalize="none" autocorrect="off" spellcheck="false"></label>
    <label><span>Password</span><input name="p" type="password" autofocus autocomplete="current-password" placeholder="Required"></label>
  </div>
  <button type="submit">Sign In</button>
  ${err ? '<p class="err" role="alert">Wrong user or password.</p>' : ''}
</form>`;

function readBody(req) {
  return new Promise((resolve) => {
    let b = ''; req.on('data', (c) => { b += c; if (b.length > 4096) req.destroy(); });
    req.on('end', () => resolve(b));
  });
}

// A request must never take the desk down. This ran straight inside createServer's listener, so
// anything it threw was an uncaught exception and the process died -- and `new URL(req.url)` throws
// on a request line like `GET http://[ HTTP/1.1`, which Node's parser passes through and which
// arrives BEFORE the login check. One malformed request from anywhere on the internet was enough
// to stop the desk and lose whatever the ledger had not saved. A throw is now a 500 (or a 400 for
// the URL) with the stack in the log, and a rejected branch is caught the same way.
const guard = require('./src/loginguard').loginGuard();
function handle(req, res) {
  let url;
  try { url = new URL(req.url, 'http://localhost'); }
  catch { res.writeHead(400); return res.end('bad request'); }
  const p = url.pathname;
  if (cfg.dashPass && p === '/login') {
    // Fly puts the real address in Fly-Client-IP; elsewhere it is the socket's
    const who = String(req.headers['fly-client-ip'] || req.socket.remoteAddress || '');
    if (req.method === 'POST') {
      if (guard.blocked(who)) {
        res.writeHead(429, { 'content-type': 'text/plain; charset=utf-8', 'retry-after': String(guard.retryAfterSec(who)) });
        return res.end('too many wrong passwords from this address; try again later');
      }
      return readBody(req).then((body) => {
        const f = new URLSearchParams(body);
        if (timingEq(f.get('u') || '', cfg.dashUser) && timingEq(f.get('p') || '', cfg.dashPass)) {
          guard.ok(who);
          const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
          res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
          return res.end();
        }
        guard.fail(who);
        res.writeHead(401, { 'content-type': 'text/html; charset=utf-8' });
        res.end(LOGIN_PAGE(true));
      });
    }
    // ?k=<link token> logs in and drops the token from the address bar on the redirect
    const k = url.searchParams.get('k');
    if (k && timingEq(k, linkToken())) {
      const secure = (req.headers['x-forwarded-proto'] || '').includes('https') ? '; Secure' : '';
      res.writeHead(302, { location: '/', 'set-cookie': `${COOKIE}=${sessionToken()}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000${secure}` });
      return res.end();
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(LOGIN_PAGE(false));
  }
  if (OPEN_FILES.has(p)) {
    res.writeHead(200, { 'content-type': MIME[path.extname(p)], 'cache-control': 'max-age=3600' });
    return fs.createReadStream(path.join(PUBLIC, p)).on('error', () => res.end()).pipe(res);
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
  // With no password, a page on another site could still reach this desk by re-pointing its own
  // name at 127.0.0.1 (DNS rebinding): no login to stop it, and Origin matches Host. Every honest
  // request to a passwordless desk names localhost, so nothing else gets the API (src/ask.js).
  // A desk with DASH_PASS passes straight through.
  if (p.startsWith('/api/')) {
    const foreign = rebindRefusal(req, cfg.dashPass);
    if (foreign) { res.writeHead(foreign.status); return res.end(foreign.text); }
  }
  // Manual kill switch. TESS's drawdown halt stops NEW risk while leaving every open position
  // running -- halted is not the same as flat. This is the button for getting out of everything.
  // POST only (a GET would fire from a stray link or a prefetch), shared secret required, and
  // disabled outright when FLATTEN_TOKEN is unset: a guessable default is worse than no switch.
  if (p === '/api/flatten') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    if (!cfg.flattenToken) { res.writeHead(503); return res.end('flatten disabled: set FLATTEN_TOKEN in .env'); }
    if (!timingEq(req.headers['x-flatten-token'] || '', cfg.flattenToken)) { res.writeHead(403); return res.end('bad token'); }
    return engine.flattenAll(url.searchParams.get('reason') || 'manual')
      .then((r) => json(res, r))
      .catch((e) => { res.writeHead(500); res.end(String(e.message).slice(0, 200)); });
  }
  if (p === '/api/resume') {
    if (req.method !== 'POST') { res.writeHead(405); return res.end('POST only'); }
    if (!cfg.flattenToken) { res.writeHead(503); return res.end('disabled: set FLATTEN_TOKEN in .env'); }
    if (!timingEq(req.headers['x-flatten-token'] || '', cfg.flattenToken)) { res.writeHead(403); return res.end('bad token'); }
    return json(res, engine.resume());
  }
  // Alert actions from the dashboard: research a position, or sell it.
  //
  // These are the first buttons on the page that DO something, so they get three locks:
  //   - POST with an `x-hexagon-action` header. A custom header forces a CORS preflight this server
  //     never answers, so another website open in the same browser cannot fire one at localhost.
  //   - An Origin, when the browser sends one, must be this host.
  //   - Selling needs FLATTEN_TOKEN unless this is a paper account on loopback. Live money, or a
  //     box reachable from elsewhere, does not get a one-click sell.
  // The first two locks live in src/ask.js (actionRefusal), shared with the Ask panel's POST so
  // the two can never drift apart.
  const act = p.match(/^\/api\/alerts\/([\w-]+)\/(research|sell)$/);
  if (act) {
    const refused = actionRefusal(req);
    if (refused) { res.writeHead(refused.status); return res.end(refused.text); }
    const [, groupId, action] = act;
    if (action === 'research') return json(res, engine.research.start(groupId));
    const local = cfg.mode === 'paper' && LOOPBACK.includes(cfg.bindHost);
    if (!local) {
      if (!cfg.flattenToken) { res.writeHead(503); return res.end('selling from the dashboard needs FLATTEN_TOKEN in .env on a live or remote desk'); }
      if (!timingEq(req.headers['x-flatten-token'] || '', cfg.flattenToken)) { res.writeHead(403); return res.end('bad token'); }
    }
    return engine.sellGroup(groupId, 'sold from the dashboard alert')
      .then((r) => json(res, r))
      .catch((e) => { res.writeHead(500); res.end(String(e.message).slice(0, 200)); });
  }
  // The Ask panel. POST /api/ask starts a question (same locks as the alert actions) and returns at
  // once; GET /api/ask/<id> reads its progress and answer. Read-only tools, never a trade.
  if (p === '/api/ask' || p.startsWith('/api/ask/')) {
    return routeAsk(engine.ask, req, p)
      .then((r) => {
        if (r.json !== undefined) { res.writeHead(r.status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); return res.end(JSON.stringify(r.json)); }
        res.writeHead(r.status); res.end(r.text);
      })
      .catch((e) => { res.writeHead(500); res.end(String(e.message).slice(0, 200)); });
  }
  // The stocks, crypto and options desk: its snapshot, its P&L history, and its own stream.
  if (desk && p === '/api/desk/state') return json(res, desk.snapshot());
  if (desk && p === '/api/desk/history') return json(res, desk.pnlHistory());
  if (desk && p === '/api/desk/stream') {
    const client = sse.openStream(req, res);
    client.send(sse.frame(desk.snapshot()));
    deskClients.add(client);
    req.on('close', () => { deskClients.delete(client); client.close(); });
    return;
  }
  if (p === '/api/state') return json(res, engine.snapshot());
  if (p === '/api/pairs') return json(res, engine.pairs.map((x) => ({ ...x, q: x.q || null })));
  // Every market the desk is watching on one subject: MLB, UFC, Elections, Weather. The state
  // snapshot carries only the forty widest gaps -- that is the right cut for a status board and
  // the wrong one for a theme button, which exists precisely to reach the quiet markets it drops.
  // Fetched when a theme is picked rather than pushed every two seconds, so a board of three
  // hundred pairs costs the stream nothing.
  if (p === '/api/markets') {
    const r3 = (x) => (Number.isFinite(x) ? Math.round(x * 1000) / 1000 : null);
    const want = url.searchParams.get('theme') || 'all';
    const held = new Set(engine.state.positions.map((x) => x.pairId).filter(Boolean));
    const list = engine.pairs
      .map((x) => ({ x, theme: engine.themeFor(x) }))
      .filter(({ theme }) => want === 'all' || theme === want)
      .map(({ x, theme }) => ({
        id: x.id, label: x.label, theme, kind: x.kind, series: x.series || null,
        inPlay: !!x.inPlay, watchOnly: x.watchOnly || null, held: held.has(x.id),
        startsAt: x.startsAt || null, closesAt: x.closesAt || null,
        pmMid: x.q ? r3(x.q.pmMid) : null, ksMid: x.q ? r3(x.q.ksMid) : null,
        gap: x.q ? r3(x.q.ksMid - x.q.pmMid) : null,
        pmVol: x.q ? Math.round(x.q.pmVol) : null, ksVol: x.q ? Math.round(x.q.ksVol) : null,
        age: x.q && x.q.t ? Math.round((Date.now() - x.q.t) / 1000) : null,
        pmUrl: x.pm && x.pm.url, ksUrl: x.ks && x.ks.url,
      }))
      // Priced first and widest gap first, the same order the floor ranks by; an unpriced market
      // still comes back, because "watching it, no price yet" is an answer and an absence is not.
      .sort((a, b) => (a.gap == null) - (b.gap == null) || (a.inPlay - b.inPlay) || Math.abs(b.gap) - Math.abs(a.gap));
    // The maker's own book belongs on this list too. It is the other half of what the desk is
    // looking at, it is Kalshi-only so it has no gap to rank by, and leaving it out would make a
    // theme button's count disagree with the list it opens -- 24 quoted markets under a "0".
    const maker = engine.maker.snapshot(engine).markets || [];
    const making = maker
      .map((m) => ({ m, theme: engine.themeFor(m) }))
      .filter(({ theme }) => want === 'all' || theme === want)
      .map(({ m, theme }) => ({
        id: m.ticker, label: m.sub && m.title && m.sub !== m.title ? `${m.title} · ${m.sub}` : (m.title || m.ticker),
        theme, kind: 'maker', series: m.series || null, inPlay: false, watchOnly: null,
        held: !!m.inv, quoting: !!m.quoting, inv: m.inv || 0,
        startsAt: null, closesAt: null, pmMid: null, ksMid: r3(m.mid), gap: null,
        pmVol: null, ksVol: null, age: null, pmUrl: null,
        ksUrl: `https://kalshi.com/markets/${String(m.series || m.ticker).split('-')[0].toLowerCase()}`,
      }))
      .sort((a, b) => Math.abs(b.inv) - Math.abs(a.inv) || (b.quoting - a.quoting));
    const all = [...list, ...making];
    return json(res, { theme: want, total: all.length, pairs: list.length, making: making.length, markets: all.slice(0, 400) });
  }
  if (p === '/api/trades') return json(res, engine.state.closed);
  if (p === '/api/volume') return json(res, engine.volume.entries());
  // The two P&L histories the stream leaves out (engine.snapshot): the page fetches them once a
  // minute instead of being resent 295 KB of them every two seconds.
  if (p === '/api/history') return json(res, engine.pnlHistory());
  // The Stocks and Options tabs. Read-only, off the tape on disk rather than the engine: the desk
  // does not trade these and nothing here touches a position. It reads only the tail of the newest
  // file (src/chaintape.js), so it stays cheap as the tape grows, and it answers with ok:false
  // rather than throwing when no tape exists yet -- a dashboard panel must never take the desk down.
  if (p === '/api/chains') {
    try { return json(res, chaintape.read(path.join(cfg.dataDir, 'chains'))); }
    catch (e) { return json(res, { ok: false, why: String(e && e.message).slice(0, 120), symbols: [], snapshots: 0 }); }
  }
  if (p === '/api/positions') return json(res, engine.state.positions);
  if (p === '/api/log') return json(res, engine.state.log);
  // The snapshot without its histories, gzipped when the browser takes it (src/sse.js).
  if (p === '/api/stream') {
    const client = sse.openStream(req, res);
    client.send(sse.frame(engine.snapshot({ histories: false })));
    clients.add(client);
    req.on('close', () => { clients.delete(client); client.close(); });
    return;
  }
  // The floor at / is the stocks, crypto and options desk; the prediction-market desk's own page,
  // unchanged, is at /pm while it winds down.
  const rel = p === '/' ? (desk ? '/desk.html' : '/index.html') : p === '/pm' ? '/index.html' : p;
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); return res.end('not found');
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);   // an unreadable file must not be an uncaught exception
}

function failed(res, e) {
  console.error('request failed:', (e && e.stack) || e);
  if (res.headersSent) { res.destroy(); return; }
  res.writeHead(500); res.end('internal error');
}
const server = http.createServer((req, res) => {
  try {
    const out = handle(req, res);
    if (out && typeof out.catch === 'function') out.catch((e) => failed(res, e));
  } catch (e) { failed(res, e); }
});

setInterval(() => {
  if (!clients.size) return;
  const payload = sse.frame(engine.snapshot({ histories: false }));
  for (const c of clients) c.send(payload);
}, 2000);
setInterval(() => {
  if (!desk || !deskClients.size) return;
  const payload = sse.frame(desk.snapshot());
  for (const c of deskClients) c.send(payload);
}, 2000);

// Loopback by default: /api/positions and the whole activity log are unauthenticated, and on a
// live account that is not something to hand the local network. BIND_HOST=0.0.0.0 to override.
server.listen(cfg.port, cfg.bindHost, () => {
  console.log(`The Hexagon  →  http://localhost:${cfg.port}   mode=${cfg.mode.toUpperCase()}${cfg.demo ? ' (DEMO quotes)' : ''}   bound to ${cfg.bindHost}${cfg.dashPass ? '   password set' : ''}${cfg.flattenToken ? '   flatten switch armed' : ''}`);
});

engine.start().catch((e) => { console.error('engine failed to start:', e); lifecycle('CRASH', crashRecord('engine.start', e)); process.exit(1); });
// Its own start, and a failure there is its own: the prediction-market desk keeps settling either way.
// Not a CRASH line in the journal: the process carries on, and tools/restarts.js counts CRASH as a restart.
if (desk) desk.start().catch((e) => { console.error('desk failed to start:', e); });
// The chain recorder's schedule (CHAINS=1: the box, which has no cron). A child process, so
// nothing it does can stall a desk loop or take the desk down with it.
if (cfg.chains) require('./src/chainsched').start({ dataDir: cfg.dataDir, keepDays: cfg.chainsKeepDays });

// A deploy stops the desk with SIGTERM, so STOP is what tells a deploy's restart from a crash's.
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { lifecycle('STOP', { signal: sig }); engine.save(); if (desk) desk.save(); console.log('\nstate saved, bye'); process.exit(0); });
// Whatever else gets past every catch above still exits (Fly restarts the desk), but with the
// ledger saved first rather than losing the last ten seconds of it -- the same courtesy a signal gets.
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (e) => { console.error(`${ev}:`, (e && e.stack) || e); lifecycle('CRASH', crashRecord(ev, e)); try { engine.save(); } catch { /* nothing left to save with */ } try { if (desk) desk.save(); } catch { /* same */ } process.exit(1); });
}

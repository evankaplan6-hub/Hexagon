/* The Hexagon — the stocks, crypto and options desk's floor. Consumes /api/desk/stream.
 *
 * The room, the desks, the boards and the bubbles are the prediction-market floor's (public/app.js),
 * carried over rather than shared: that page stays exactly as it is at /pm until its desk's last
 * positions settle, and then it and its script go. What is new here is what the boards SAY -- the
 * three books, their holdings against simply holding, the fills, the market clock -- and the
 * seventh desk, PRED, which is the prediction-market desk winding down. Since 2026-09-25 the desks
 * have no one sitting at them: each bot is its desk, its screen and its name plate, and what it is
 * doing shows on the screen (the avatars went at Evan's asking).
 *
 * Read-only, like the other floor: nothing on this page can place, change or cancel anything.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let S = null;

  // ------------------------------------------------------------ formatting
  // One way to write a number everywhere on the page: a true minus, a plus only when there is something
  // to be plus about, thousands separators, cents on money and prices, and each coin to its own
  // decimals. Zero is neither a gain nor a loss: no sign, and the neutral ink rather than the green.
  const MINUS = '\u2212';
  const money = (x, d = 2) => `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const isZero = (x, d = 2) => Math.abs(x) < 0.5 / 10 ** d;
  const signed = (x, d = 2) => (isZero(x, d) ? money(0, d) : `${x > 0 ? '+' : MINUS}${money(x, d)}`);
  const tone = (x, d = 2) => (isZero(x, d) ? 'zero' : x > 0 ? 'pos' : 'neg');
  const r2 = (x) => Math.round(x * 100) / 100;
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cap = (s) => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
  const ET_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
  const hhmm = (t) => ET_HM.format(new Date(t)).replace(/ [AP]M$/, '');
  const dur = (ms) => {
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
    return h >= 48 ? `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h` : `${h}h ${String(m).padStart(2, '0')}m`;
  };
  const ago = (t) => {
    if (!t || !S) return 'never';
    const d = Math.max(0, Math.round((S.now - t) / 1000));
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    if (d < 172800) return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m ago`;
    return `${Math.floor(d / 86400)}d ago`;
  };
  // a price the way its market quotes it: coins in dollars and cents (or more for small coins), SPY to
  // the cent, an option to the cent of a dollar per share
  const px = (p) => (!Number.isFinite(p) ? '—' : p >= 1 ? `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${p.toFixed(p < 0.1 ? 3 : 2)}`);
  // a coin to the decimals its price needs: a thousandth of a bitcoin is $80, of a SOL twelve cents
  const COIN_DP = { 'BTC-USD': 6, 'ETH-USD': 4, 'SOL-USD': 2 };
  const qtyTxt = (q, book, sym) => (book === 'crypto'
    ? (+q).toLocaleString('en-US', { minimumFractionDigits: COIN_DP[sym] ?? 6, maximumFractionDigits: COIN_DP[sym] ?? 6 })
    : book === 'stocks' ? `${+(+q).toFixed(3)}` : String(q));
  const agentColor = (k) => (S && S.agents.find((a) => a.key === k) || {}).color || 'var(--ink-3)';
  const CYCLE = { HOLT: 0, ILSA: 1, TESS: 2, RIGO: 3, BRAM: 4, KETT: 5, PRED: 6 };
  const isActive = (a) => { const dt = S.now - a.lastActive - (CYCLE[a.key] || 0) * 900; return dt >= 0 && dt < 3200; };
  const bookOf = (k) => (S && S.books || []).find((b) => b.key === k) || null;
  const BOOK_COLOR = { crypto: 'var(--book-crypto)', stocks: 'var(--book-stocks)', options: 'var(--book-options)' };
  // tokens.css, read once for the two things that cannot take a var(): the chart library and the canvas
  const TOK = (() => {
    const cs = getComputedStyle(document.documentElement), t = {};
    for (const k of ['room', 'ink-1', 'ink-2', 'ink-3', 'gain', 'loss', 'bad', 'rule-1']) t[k] = cs.getPropertyValue(`--${k}`).trim();
    return t;
  })();
  const withAlpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };
  const ROLE = {
    HOLT: 'fetches every price: Coinbase live, Cboe 15 minutes late',
    ILSA: 'measures how hard each market has been swinging',
    TESS: 'risk: stale prices, the daily loss limit, the calendar',
    RIGO: "marks every holding and takes the options book's exits",
    BRAM: 'decides what each book should hold, and when an option is worth buying',
    KETT: 'fills every order at the real bid and ask, fees included',
    PRED: 'the prediction-market desk: no new trades, its positions riding to settlement',
  };

  // ------------------------------------------------------------ rendering that keeps what a person is doing
  // The stream lands every two seconds, and replacing a board's HTML each time threw away whatever a
  // person had focused, hovered or selected on it (the review's B5). morph() patches the page into the
  // new HTML instead, so an element that is still there stays the same element. A child is matched by
  // its data-k when it has one, and one marked data-keep (the phone's chart) is left alone entirely.
  function morph(el, html) {
    const t = document.createElement('template');
    t.innerHTML = html;
    patch(el, t.content);
  }
  const sameNode = (x, y) => x.nodeType === y.nodeType && x.nodeName === y.nodeName
    && (x.nodeType !== 1 || x.getAttribute('data-k') === y.getAttribute('data-k'));
  function patch(a, b) {
    const want = [...b.childNodes];
    for (let i = 0; i < want.length; i++) {
      const y = want[i], x = a.childNodes[i];
      if (!x) { a.appendChild(y); continue; }
      if (!sameNode(x, y)) { a.replaceChild(y, x); continue; }
      if (x.nodeType !== 1) { if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue; continue; }
      if (y.hasAttribute('data-keep')) continue;
      for (const { name, value } of [...y.attributes]) if (x.getAttribute(name) !== value) x.setAttribute(name, value);
      for (const { name } of [...x.attributes]) if (!y.hasAttribute(name)) x.removeAttribute(name);
      patch(x, y);
    }
    while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
  }
  // One line, cut at whole words: words go from the end of the dim part first, then from the name
  // (never below one word), and a line never ends on a joining word. Ported from /pm's app.js, where
  // .fitw began; this page used the class without ever calling it, so its rows were sliced through a
  // letter or a figure ("holding would be +$1" for +$14.19; the review's B7).
  const fitMemo = new Map();
  const TRAIL = /(\s+(of|the|a|an|in|on|at|by|for|from|to|and|or|with|vs\.?|as|than|that|would|be|needs?|-|–|·))+$/i;
  const tidyEnd = (t) => t.replace(/[\s,;:·\-–(\[]+$/, '').replace(TRAIL, '').replace(/[\s,;:·\-–(\[]+$/, '');
  function fitWords(line) {
    const w = line.clientWidth;
    if (!w || line.scrollWidth <= w + 1) return;
    const parts = [...line.children].filter((c) => c.tagName === 'SPAN' || c.tagName === 'I');
    const els = parts.length ? parts : [line];
    const full = els.map((e) => e.textContent);
    const key = `${full.join('\u0001')}|${w}|${getComputedStyle(line).fontSize}`;
    const put = (texts) => els.forEach((e, i) => { e.textContent = texts[i]; e.hidden = !texts[i]; });
    if (fitMemo.has(key)) { put(fitMemo.get(key)); return; }
    const texts = full.slice();
    for (let guard = 0; guard < 80 && line.scrollWidth > w + 1; guard++) {
      let i = -1;   // the last part that can still give up a word
      for (let k = texts.length - 1; k >= 0 && i < 0; k--) {
        if (k > 0 ? texts[k].replace(/^\s*·\s*/, '').trim() : texts[k].trim().split(/\s+/).length > 1) i = k;
      }
      if (i < 0) break;
      const prefix = i > 0 && /^\s*·\s*/.test(texts[i]) ? ' · ' : '';
      const body = texts[i].replace(/^\s*·\s*/, '').trim().split(/\s+/);
      body.pop();
      const next = tidyEnd(body.join(' '));
      texts[i] = next ? prefix + next : '';
      put(texts);
    }
    if (fitMemo.size > 800) fitMemo.clear();
    fitMemo.set(key, texts);
  }
  const fitAll = (root) => root.querySelectorAll('.fitw').forEach(fitWords);

  // ------------------------------------------------------------ header
  let lastFrameAt = 0;
  const STALE_MS = 12000;
  const stale = () => lastFrameAt && Date.now() - lastFrameAt > STALE_MS;
  let shownGone = false;
  const deskState = () => (stale() ? ['No signal', 'bad'] : S.halt ? ['Stopped', 'bad'] : S.market && S.market.stale && S.market.stale.crypto ? ['Waiting on prices', 'warn'] : ['Working', 'good']);
  function renderHeader() {
    shownGone = stale();
    const [state, cls] = deskState();
    const pill = $('deskstate');
    pill.className = `pill ${cls}`;
    morph(pill, `<i></i>${esc(state)}${S.halt ? `<span class="why">${esc(String(S.halt))}</span>` : ''}<span class="mode">Paper</span>`);
    // a background tab says how the desk is doing, not just its name
    const title = Number.isFinite(S.pnl) ? `${signed(S.pnl)} · ${state} · The Hexagon` : 'The Hexagon';
    if (document.title !== title) document.title = title;
    const held = (S.books || []).reduce((a, b) => a + b.rows.filter((r) => r.qty > 0).length, 0);
    const day = Math.floor((S.now - S.startedAt) / 86400000) + 1;
    const fact = (k, v, c) => `<span>${k}<b class="${c || ''}">${v}</b></span>`;
    morph($('meta'), fact('day', day) + fact('held', held) + fact('market', S.market ? (S.market.open ? 'open' : 'closed') : '—'));
    const L = S.legacy;
    const pmHtml = `<span class="lg">Prediction markets${L ? (L.groups || L.contracts ? ' · winding down' : ' · settled') : ''}</span><span class="sm">Pred. mkts</span>`;
    if ($('pmlink').innerHTML !== pmHtml) $('pmlink').innerHTML = pmHtml;
  }

  // ------------------------------------------------------------ floor interaction
  let hits = [], hover = null, sel = null;
  const floorBox = { scale: 1, ox: 0, oy: 0 };
  function floorPoint(ev) {
    const r = $('floorc').getBoundingClientRect();
    return { x: (ev.clientX - r.left - floorBox.ox) / floorBox.scale, y: (ev.clientY - r.top - floorBox.oy) / floorBox.scale };
  }
  const hitAt = (p) => hits.find((h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) || null;
  const same = (a, b) => a && b && a.kind === b.kind && a.key === b.key;
  function wireFloor() {
    const cv = $('floorc');
    cv.addEventListener('mousemove', (ev) => { hover = hitAt(floorPoint(ev)); cv.style.cursor = hover ? 'pointer' : 'default'; });
    cv.addEventListener('mouseleave', () => { hover = null; });
    cv.addEventListener('click', (ev) => { const h = hitAt(floorPoint(ev)); sel = same(h, sel) ? null : h; wallKey = ''; });
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { sel = null; wallKey = ''; } });
  }

  // ------------------------------------------------------------ the room (the other floor's, unchanged but for PRED)
  const ROOM_H = 282, WALL_H = 172, SIDE_W = 120;
  const SEAT_MAX = (ROOM_H - WALL_H - 4) / 101;
  const M = 8, G = 10, BUBBLE_LANE = 22, BOARD_H = WALL_H - M - BUBBLE_LANE;
  let L = null;
  function layout(RW) {
    if (L && L.RW === RW) return L;
    const bandR = RW - M - 30;
    const DESK_BAND = 320;
    const stand = Math.round(Math.min(Math.max(170, RW * 0.33), 300, Math.max(150, bandR - DESK_BAND)));
    const bandL = stand + 16, band = bandR - bandL, gap = 16;
    const SEAT = Math.max(0.8, Math.min(SEAT_MAX, (band - 3 * gap) / 256));
    const dw = 64 * SEAT, pitch = Math.min(dw * 1.5, Math.max(dw + gap, (band - dw) / 3));
    const backPitch = Math.max(dw + gap, pitch * 0.94);
    const backY = Math.round(WALL_H + 4 + 16 * SEAT), frontY = Math.round(backY + 43 * SEAT);
    const row = (n, y, p) => {
      const w = (n - 1) * p + dw;
      const x0 = Math.round(Math.max(bandL, bandL + (band - w) / 2));
      return Array.from({ length: n }, (_, i) => [x0 + Math.round(i * p), y]);
    };
    L = {
      RW, SEAT, dw, pitch,
      seats: [...row(3, backY, backPitch), ...row(4, frontY, pitch)],
      cell: [0, 1, 2].map(() => Math.min(72, backPitch / SEAT - 2)).concat([0, 1, 2, 3].map(() => Math.min(72, pitch / SEAT - 2))),
      status: { x: M, y: M, w: SIDE_W, h: BOARD_H },
      tape: { x: RW - M - SIDE_W, y: M, w: SIDE_W, h: BOARD_H },
      screen: { x: M + SIDE_W + G, y: M, w: RW - 2 * (M + SIDE_W + G), h: BOARD_H },
      chart: { x: M, y: M + BOARD_H + G, w: stand, h: ROOM_H - M - (M + BOARD_H + G) },
      rack: { x: RW - M - 26, y: WALL_H + 18, w: 26, h: 60 },
    };
    return L;
  }
  function hash(i, j, k) { let x = (i * 374761393 + j * 668265263 + k * 2246822519) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; }
  function pxl(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, s, x, y, c, size = 7, align = 'left') { ctx.fillStyle = c; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(s, Math.round(x), Math.round(y)); }
  function glow(ctx, cx, cy, r, color, alpha) {
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, color); g.addColorStop(1, 'transparent');
    ctx.save(); ctx.globalAlpha = alpha; ctx.globalCompositeOperation = 'lighter';
    ctx.fillStyle = g; ctx.fillRect(cx - r, cy - r, r * 2, r * 2); ctx.restore();
  }
  function shadow(ctx, x, y, w, h, alpha = 0.5) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = '#000';
    ctx.beginPath(); ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2); ctx.fill(); ctx.restore();
  }
  function scanlines(ctx, x, y, w, h, alpha = 0.5) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = '#000';
    for (let i = 0; i < h; i += 2) ctx.fillRect(x, y + i, w, 1);
    ctx.restore();
  }
  const BRD_FACE = '#080c14', BRD_EDGE = '#26324a', BRD_DARK = '#04060a';
  function panel(ctx, x, y, w, h, face = BRD_FACE, edge = BRD_EDGE) {
    const r = 3;
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r);
    ctx.fillStyle = face; ctx.fill();
    ctx.clip();
    pxl(ctx, x, y, w, 1, edge);
    pxl(ctx, x, y + h - 1, w, 1, BRD_DARK);
    pxl(ctx, x, y, 1, h, edge); pxl(ctx, x + w - 1, y, 1, h, BRD_DARK);
    ctx.restore();
    ctx.save();
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r);
    ctx.strokeStyle = 'rgba(38,50,74,.55)'; ctx.lineWidth = 1; ctx.stroke();
    ctx.restore();
  }

  let seats = [], statusBox = null, wallBox = null, tapeBox = null, chartBox = null;
  let floorSized = '';
  const ROOM_W_MIN = 480, ROOM_W_MAX = 780;
  let RW = 480;
  function floorCtx() {
    const cv = $('floorc'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const key = `${w}x${h}`;
    if (key !== floorSized) { cv.width = w; cv.height = h; floorSized = key; }
    RW = Math.round(Math.max(ROOM_W_MIN, Math.min(ROOM_W_MAX, ROOM_H * (w / h))));
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = TOK.room; ctx.fillRect(0, 0, w, h);
    const scale = Math.min(w / RW, h / ROOM_H);
    floorBox.scale = scale / dpr;
    floorBox.ox = (w - RW * scale) / 2 / dpr;
    floorBox.oy = (h - ROOM_H * scale) / 2 / dpr;
    ctx.setTransform(scale, 0, 0, scale, (w - RW * scale) / 2, (h - ROOM_H * scale) / 2);
    return ctx;
  }

  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    layout(RW);
    const VPX = RW / 2;
    ctx.clearRect(0, 0, RW, ROOM_H);
    hits = [];
    const wall = ctx.createLinearGradient(0, 0, 0, WALL_H);
    wall.addColorStop(0, '#080b14'); wall.addColorStop(0.55, '#0e1422'); wall.addColorStop(1, '#121a2b');
    ctx.fillStyle = wall; ctx.fillRect(0, 0, RW, WALL_H);
    const flr = ctx.createLinearGradient(0, WALL_H, 0, ROOM_H);
    flr.addColorStop(0, '#0c1017'); flr.addColorStop(1, '#070910');
    ctx.fillStyle = flr; ctx.fillRect(0, WALL_H, RW, ROOM_H - WALL_H);
    pxl(ctx, 0, WALL_H - 1, RW, 1, '#243047'); pxl(ctx, 0, WALL_H, RW, 1, '#161d2b');
    ctx.save(); ctx.globalAlpha = 0.5;
    const cols = Math.ceil(RW / 24);
    for (let i = -cols; i <= cols; i++) {
      ctx.strokeStyle = '#131a26'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(VPX + i * 13, WALL_H); ctx.lineTo(VPX + i * 46, ROOM_H); ctx.stroke();
    }
    for (let k = 1, y = WALL_H; y < ROOM_H; k++) { y = WALL_H + Math.pow(k, 1.55) * 3.1; pxl(ctx, 0, y, RW, 0.5, '#141c29'); }
    ctx.restore();
    if (!S) { text(ctx, 'CONNECTING TO THE DESK', VPX, WALL_H / 2, TOK['ink-3'], 8, 'center'); return; }

    glow(ctx, VPX, 58, Math.max(210, RW * 0.42), '#1b3a6b', 0.55);
    glow(ctx, 64, 80, 95, '#14304f', 0.30);
    glow(ctx, RW - 64, 70, 95, '#123d2a', 0.30);

    panel(ctx, L.status.x, L.status.y, L.status.w, L.status.h);
    scanlines(ctx, L.status.x + 1, L.status.y + 1, L.status.w - 2, L.status.h - 2, 0.10);
    statusBox = L.status;

    const ws = L.screen, gx = ws.x + 6, gy = ws.y + 6, gw = ws.w - 12, gh = ws.h - 12;
    panel(ctx, ws.x, ws.y, ws.w, ws.h, '#0a0e17', '#2c3a55');
    pxl(ctx, gx, gy, gw, gh, '#050810');
    const glass = ctx.createLinearGradient(0, gy, 0, gy + gh);
    glass.addColorStop(0, 'rgba(70,120,190,0.10)'); glass.addColorStop(1, 'rgba(70,120,190,0.02)');
    ctx.fillStyle = glass; ctx.fillRect(gx, gy, gw, gh);
    if (sel && sel.kind === 'agent' && !S.agents.some((x) => x.key === sel.key)) sel = null;
    wallBox = { x: gx, y: gy, w: gw, h: gh };
    scanlines(ctx, gx, gy, gw, gh, 0.16);
    glow(ctx, VPX, gy + 16, Math.max(120, gw * 0.4), '#1e4e8a', 0.18);
    pxl(ctx, VPX - 3, ws.y + ws.h, 6, 5, '#141b28'); pxl(ctx, VPX - 9, ws.y + ws.h + 3, 18, 2, '#0d1420');

    panel(ctx, L.tape.x, L.tape.y, L.tape.w, L.tape.h);
    scanlines(ctx, L.tape.x + 1, L.tape.y + 1, L.tape.w - 2, L.tape.h - 2, 0.10);
    tapeBox = L.tape;

    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
    const labels = [], wires = [];
    S.agents.forEach((a, i) => {
      const seat = L.seats[i];
      if (!seat) return;
      const [x, y] = seat, Z = L.SEAT;
      const act = isActive(a);
      const cw = L.cell[i], cx = (64 - cw) / 2;
      hits.push({ x: x + cx * Z, y: y - 18 * Z, w: cw * Z, h: 60 * Z, kind: 'agent', key: a.key });
      const hot = hover && hover.kind === 'agent' && hover.key === a.key;
      const picked = sel && sel.kind === 'agent' && sel.key === a.key;
      const latest = (S.log || []).find((e) => e.agent === a.key);
      const beat = (Math.sin(t * 7 + i * 1.7) + 1) / 2;
      // PRED is a desk being wound down: dimmer, slower, and its screen is an hourglass, not a chart
      const winding = a.key === 'PRED';
      ctx.save();
      ctx.translate(x, y); ctx.scale(Z, Z);
      if (winding) ctx.globalAlpha = 0.72;
      if (hot || picked) {
        ctx.save(); ctx.globalAlpha = picked ? 0.16 : 0.09; pxl(ctx, cx, -18, cw, 60, a.color); ctx.restore();
        if (picked) { pxl(ctx, cx, -18, cw, 1, a.color); pxl(ctx, cx, 41, cw, 1, a.color); }
      }
      shadow(ctx, 2, 26, 60, 10, 0.45);
      pxl(ctx, 12, -16, 40, 24, '#1a2029'); pxl(ctx, 12, -16, 40, 1, '#2f3a4c');
      pxl(ctx, 14, -14, 36, 20, '#04070c');
      if (!winding) for (let j = 0; j < 9; j++) { const hgt = 3 + Math.round(hash(i, j, Math.floor(a.runs / 2)) * 12); pxl(ctx, 16 + j * 4, 4 - hgt, 3, hgt, act ? a.color : '#1e2836'); }
      else {
        // an hourglass: sand falls while the old desk still runs a round, and sits still otherwise
        const c = act ? a.color : '#3b2a55';
        pxl(ctx, 26, -12, 12, 1, c); pxl(ctx, 26, 3, 12, 1, c);
        for (let k = 0; k < 5; k++) { pxl(ctx, 27 + k, -11 + k, 10 - 2 * k, 1, '#1e1530'); pxl(ctx, 27 + k, 2 - k, 10 - 2 * k, 1, '#1e1530'); }
        pxl(ctx, 30, -9, 4, 2, c); pxl(ctx, 28, 0, 8, 2, c);
        if (act && Math.floor(t * 6) % 2) pxl(ctx, 31.5, -5, 1, 4, c);
      }
      scanlines(ctx, 14, -14, 36, 20, 0.22);
      if (act) glow(ctx, 32, -4, 30, a.color, 0.20);
      pxl(ctx, 30, 8, 4, 3, '#1a2029');
      if (act && Math.floor(t * 6) % 2) pxl(ctx, 47, -12, 2, 2, a.color);
      if (act && a.key === 'HOLT') {
        ctx.save(); ctx.strokeStyle = a.color; ctx.globalAlpha = 0.65; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(32, -4, 7, -Math.PI / 2, -Math.PI / 2 + beat * Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      if (act && a.key === 'ILSA') {
        for (let n = 0; n < 3; n++) { const rr = 2 + ((beat * 6 + n * 2) % 6); ctx.save(); ctx.globalAlpha = 0.35 - n * 0.08; ctx.strokeStyle = a.color; ctx.beginPath(); ctx.arc(32, -4, rr, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
      }
      if (act && a.key === 'RIGO') {
        pxl(ctx, 17, -11, 8 + Math.round(beat * 8), 1, latest && latest.pnl < 0 ? '#ef4444' : '#22c55e');
        pxl(ctx, 17, -8, 14 - Math.round(beat * 5), 1, '#5b6270');
      }
      if (act && a.key === 'TESS') {
        const risk = S.halt ? '#ef4444' : '#ec4899'; pxl(ctx, 4, 3, 3, 3, risk); glow(ctx, 5, 4, 8, risk, 0.5 + beat * 0.3);
      }
      pxl(ctx, 0, 11, 64, 9, '#33291d'); pxl(ctx, 0, 11, 64, 1, '#6b5942'); pxl(ctx, 0, 19, 64, 1, '#1b150e');
      pxl(ctx, 2, 20, 4, 8, '#221b13'); pxl(ctx, 58, 20, 4, 8, '#221b13');
      pxl(ctx, 24, 30, 16, 5, '#12151b'); pxl(ctx, 22, 24, 20, 6, '#1a1e27'); pxl(ctx, 22, 24, 20, 1, '#28303d');
      ctx.restore();
      if (act && a.key === 'BRAM') wires.push({ kind: 'wire', color: a.color, fx: x + 32 * Z, fy: y - 17 * Z, tx: VPX, ty: ws.y + ws.h });
      if (act && a.key === 'KETT' && latest && latest.kind === 'FILL') {
        wires.push({ kind: 'packet', color: a.color, fx: x + 32 * Z, fy: y - 6 * Z, tx: L.tape.x + L.tape.w / 2, ty: L.tape.y + 30, down: latest.pnl != null && latest.pnl < 0 });
      }
      labels.push({ key: a.key, bx: x + 32 * Z, by: y + 22 * Z, top: y - 18 * Z, foot: y + 31 * Z, plate: y + 15.5 * Z, px: x + 52 * Z,
        back: i < 3, color: a.color, act, lit: hot || picked, note: a.note, w: 64 * Z });
    });
    for (const w of wires) {
      if (w.kind === 'wire') {
        ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = w.color; ctx.setLineDash([2, 2]); ctx.lineDashOffset = -t * 12;
        ctx.beginPath(); ctx.moveTo(w.fx, w.fy); ctx.lineTo(w.tx, w.ty); ctx.stroke(); ctx.restore();
      } else {
        const run = (t * 2.5) % 1, ox = w.fx + (w.tx - w.fx) * run, oy = w.fy + (w.ty - w.fy) * run;
        pxl(ctx, ox - 1, oy - 1, 3, 3, w.down ? '#ef4444' : '#22c55e'); glow(ctx, ox, oy, 7, w.color, 0.7);
      }
    }
    const rk = L.rack;
    shadow(ctx, rk.x, rk.y + rk.h - 6, 30, 10, 0.5);
    pxl(ctx, rk.x, rk.y, rk.w, rk.h, '#0f131b'); pxl(ctx, rk.x, rk.y, rk.w, 1, '#2a3446'); pxl(ctx, rk.x, rk.y, 1, rk.h, '#1e2635');
    for (let i = 0; i < 6; i++) {
      pxl(ctx, rk.x + 3, rk.y + 4 + i * 9, 20, 6, '#06090e');
      const on = (Math.floor(t * 4) + i) % 3;
      pxl(ctx, rk.x + 19, rk.y + 6 + i * 9, 2, 2, on ? '#22c55e' : '#0f3a1f');
      if (on) glow(ctx, rk.x + 20, rk.y + 7 + i * 9, 5, '#22c55e', 0.5);
    }
    seats = labels;
    ctx.save();
    const vig = ctx.createRadialGradient(VPX, ROOM_H * 0.48, RW * 0.2, VPX, ROOM_H * 0.48, RW * 0.66);
    vig.addColorStop(0, 'transparent'); vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig; ctx.fillRect(0, 0, RW, ROOM_H);
    ctx.restore();
    shadow(ctx, L.chart.x + 4, L.chart.y + L.chart.h - 3, L.chart.w - 8, 8, 0.55);
    panel(ctx, L.chart.x, L.chart.y, L.chart.w, L.chart.h);
    chartBox = { x: L.chart.x + 1, y: L.chart.y + 1, w: L.chart.w - 2, h: L.chart.h - 2 };
    if (stale()) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, RW, ROOM_H); ctx.restore();
      pxl(ctx, VPX - 90, WALL_H - 4, 180, 16, '#1a0d0f'); pxl(ctx, VPX - 90, WALL_H - 4, 180, 1, TOK.bad);
      text(ctx, 'NO SIGNAL FROM THE DESK', VPX, WALL_H, TOK.bad, 7, 'center');
      text(ctx, 'this page is showing the last state it received', VPX, WALL_H + 7, TOK['ink-2'], 5, 'center');
    }
  }

  // ------------------------------------------------------------ what the bots say
  let frameSeq = 0, seenKeys = null, feedHead = '';
  const said = {}, lastSaid = {};
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  // One log line -> { text, sub, level }. The desk writes its log in plain sentences already; the part
  // before the first " · " is what happened, the rest is the detail underneath.
  //   trade  money moved          warn  needs a look
  //   info   a decision           quiet the desk doing its rounds
  function say(e) {
    const t = String(e.text || ''), parts = t.split(' · '), first = cap(parts[0]), rest = parts.slice(1).join(' · ');
    if (e.kind === 'FILL' || e.kind === 'SETTLE') return { text: first, sub: rest, level: 'trade' };
    if (e.kind === 'HALT') return { text: `Stopped buying: ${parts[0]}`, sub: rest, level: 'warn' };
    switch (`${e.agent} ${e.kind}`) {
      case 'HOLT SCAN': case 'RIGO RESEARCH': case 'ILSA RESEARCH': return { text: first, sub: rest, level: 'quiet' };
      case 'TESS OPS': return { text: first, sub: rest, level: /^all clear/i.test(t) || /desk online|new day/.test(t) ? 'quiet' : 'warn' };
      case 'HOLT OPS': return { text: first, sub: rest, level: 'warn' };
      case 'BRAM SIGNAL': return { text: first, sub: rest, level: 'info' };
      case 'BRAM PASS': return { text: first, sub: rest, level: /^options/.test(t) ? 'info' : 'quiet' };
      case 'KETT PASS': return { text: first, sub: rest, level: 'info' };
      default: return { text: first, sub: rest, level: 'info' };
    }
  }
  function ingest() {
    const log = S.log || [];
    const keys = new Set(log.map(logKey));
    if (seenKeys) {
      const fresh = log.filter((e) => !seenKeys.has(logKey(e))).reverse();
      for (const e of fresh) {
        const s = say(e), cur = said[e.agent], loud = s.level !== 'quiet';
        if (!loud && shape(s.text) === lastSaid[e.agent]) continue;
        if (!loud && cur && cur.level !== 'quiet' && cur.until > Date.now()) continue;
        said[e.agent] = { ...s, until: Date.now() + (loud ? 10000 : 6000) };
        lastSaid[e.agent] = shape(s.text);
      }
    }
    seenKeys = keys;
    const head = log.length ? logKey(log[0]) : '';
    if (head !== feedHead) { feedHead = head; renderFeed(log); }
    const fm = $('floor-meta');
    if (S.halt) { fm.className = 'alert'; fm.textContent = `⚠ ${S.halt}`; }
    else { fm.className = ''; fm.textContent = ''; }
  }
  function renderFeed(log) {
    const rows = [], last = {};
    for (const e of log) {
      const s = say(e), k = shape(s.text);
      if (last[e.agent] === k) continue;
      last[e.agent] = k;
      rows.push({ e, s });
      if (rows.length >= 50) break;
    }
    const list = $('feedlist'), top = list.scrollTop;
    list.innerHTML = rows.map(({ e, s }) => {
      const pl = (e.kind === 'FILL' || e.kind === 'SETTLE') && e.pnl != null ? `<span class="fp ${tone(e.pnl)}">${signed(e.pnl)}</span>` : '';
      return `<li class="lv-${s.level}" style="--a:${agentColor(e.agent)}"><span class="ft">${hhmm(e.t)}</span><span class="fa" style="color:${agentColor(e.agent)}">${e.agent}</span>` +
        `<span class="fs">${esc(s.text)}${s.sub && s.level !== 'quiet' ? `<small>${esc(s.sub)}</small>` : ''}</span>${pl}</li>`;
    }).join('') || '<li class="lv-quiet"><span class="fs">Waiting for the first desk round</span></li>';
    list.scrollTop = top;
  }

  // ------------------------------------------------------------ bubbles (one bot speaks at a time)
  const nodes = {};
  const RANK = { warn: 3, trade: 2, info: 1, quiet: 0 };
  let speaking = null;
  const clip = (str, n) => { const t = String(str).trim(); return t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '').replace(/[\s,;:·\-–(]+$/, ''); };
  function placeFx() {
    const fx = $('fx');
    if (!S || !seats.length) return;
    const k = floorBox.scale, X = (x) => floorBox.ox + x * k, Y = (y) => floorBox.oy + y * k;
    const fs = Math.max(12, Math.min(17, k * 6));
    fx.style.fontSize = `${fs}px`;
    fx.classList.toggle('stale', !!stale());
    placeStatus(X, Y, k);
    placeBoards(X, Y, k);
    const now = Date.now(), lines = {};
    for (const st of seats) {
      const ev = said[st.key] && said[st.key].until > now ? said[st.key] : null;
      if (ev && ev.level !== 'quiet') lines[st.key] = ev;
    }
    let best = null;
    for (const key of Object.keys(lines)) { const r = RANK[lines[key].level] || 0; if (!best || r > best.r) best = { key, r }; }
    if (speaking && !lines[speaking.key]) speaking = null;
    if (best && (!speaking || (RANK[lines[best.key].level] || 0) > (RANK[lines[speaking.key].level] || 0))) speaking = { key: best.key };
    for (const st of seats) {
      let n = nodes[st.key];
      if (!n) {
        n = nodes[st.key] = { name: document.createElement('div'), bub: document.createElement('div'), html: '' };
        n.name.className = 'nametag'; n.name.textContent = st.key;
        $('bubbles').append(n.name, n.bub);
      }
      const b = speaking && speaking.key === st.key ? lines[st.key] : null;
      Object.assign(n.name.style, { left: `${X(st.px)}px`, top: `${Y(st.plate)}px`, color: st.lit || st.act ? st.color : '' });
      n.name.style.setProperty('--c', st.color);
      n.name.classList.toggle('on', st.act || st.lit);
      n.name.hidden = false;
      if (!b) { n.bub.hidden = true; continue; }
      const reach = L ? (L.pitch - st.w / 2 - 9) * k : 200;
      const maxw = st.back ? Math.min(440, Math.max(200, st.w * k * 2.1)) : Math.min(440, Math.max(150, reach));
      const room = Math.max(22, Math.floor(maxw / (fs * 0.62)) - st.key.length - 2);
      const line = clip(b.text, room).replace(/[\s·@:,+-]+$/, '');
      const html = `<b class="who" style="color:${st.color}">${esc(st.key)}</b>${esc(line)}`;
      const flip = !st.back && X(RW) - X(st.bx) < maxw * 0.7;
      const cls = `bub lv-${b.level} ${st.back ? 'up' : flip ? 'side flip' : 'side'}`;
      if (html !== n.html || n.cls !== cls) {
        n.bub.innerHTML = html; n.cls = cls; n.bub.className = cls;
        if (html !== n.html) { void n.bub.offsetWidth; n.bub.classList.add('pop'); }
        n.html = html;
      }
      n.bub.hidden = false;
      n.bub.style.setProperty('--c', st.color);
      n.bub.style.maxWidth = `${maxw}px`;
      if (st.back) Object.assign(n.bub.style, { left: `${X(st.bx)}px`, right: '', top: `${Y(st.top - 5)}px` });
      else if (flip) Object.assign(n.bub.style, { left: '', right: `${fx.clientWidth - X(st.bx - 12)}px`, top: `${Y(st.by - 10)}px` });
      else Object.assign(n.bub.style, { left: `${X(st.bx + 12)}px`, right: '', top: `${Y(st.by - 10)}px` });
    }
    const sp = speaking && nodes[speaking.key] && !nodes[speaking.key].bub.hidden && nodes[speaking.key].bub.getBoundingClientRect();
    if (sp) for (const st of seats) {
      const n = nodes[st.key];
      if (!n || n.name.hidden) continue;
      const r = n.name.getBoundingClientRect();
      if (!(r.right < sp.left || sp.right < r.left || r.bottom < sp.top || sp.bottom < r.top)) n.name.hidden = true;
    }
  }

  // ------------------------------------------------------------ the status board: is it working, and where is the money
  function fitText(el, maxFs, minFs) {
    let fs = maxFs;
    el.style.fontSize = `${fs}px`;
    while (el.scrollHeight > el.clientHeight + 1 && fs > minFs) { fs -= 0.5; el.style.fontSize = `${fs}px`; }
  }
  function fitWidth(el, minFs) {
    if (!el) return;
    el.style.fontSize = '';
    const maxW = el.clientWidth + 1;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > maxW && fs > minFs) { fs -= 1; el.style.fontSize = `${fs}px`; }
  }
  // the options book's day, in one sentence a person reads
  function optionsLine() {
    const O = S.options || {}, d = O.day;
    if (!O.enabled) return 'switched off';
    const open = (bookOf('options') || { rows: [] }).rows.length;
    if (open) return `holding ${open} contract${open === 1 ? '' : 's'}`;
    if (!d) return S.market && S.market.open ? 'waiting for today\'s 12:30 test' : 'next 12:30 test on the next trading day';
    const up = d.dir === 'up';
    switch (d.status) {
      case 'waiting': return 'waiting for the 12:30 test';
      case 'armed': return `trend day ${d.dir} (${d.test ? d.test.moveAtr.toFixed(2) : '?'} ATR): watching for a new ${up ? 'high' : 'low'} until 2:45`;
      case 'no-trade': return `no trade: ${d.why || 'not a trend day'}`;
      case 'early-close': return 'no trade: a 1 PM close';
      case 'done': return `done for today after ${d.entries} trade${d.entries === 1 ? '' : 's'}`;
      default: return d.status;
    }
  }
  let statusHtml = '';
  function placeStatus(X, Y, k) {
    if (!statusBox) return;
    const el = $('status');
    Object.assign(el.style, { left: `${X(statusBox.x)}px`, top: `${Y(statusBox.y)}px`, width: `${statusBox.w * k}px`, height: `${statusBox.h * k}px` });
    el.classList.toggle('compact', statusBox.h * k < 230);
    const [state, cls] = deskState();
    const books = S.books || [];
    const held = books.reduce((a, b) => a + b.rows.filter((r) => r.qty > 0).length, 0);
    const atWork = r2(books.reduce((a, b) => a + b.rows.reduce((x, r) => x + (r.value || 0), 0), 0));
    const cash = r2((S.equity || 0) - atWork);
    const mk = S.market || {};
    const lag = mk.delayMin != null ? `SPY ${mk.delayMin} min late` : 'SPY 15 min late';
    const sha = S.build && S.build.sha ? String(S.build.sha).slice(0, 7) : 'dev';
    const html = `<div class="st ${cls}"><i></i>${esc(state)}<em>PAPER</em></div>` +
      (stale() || S.halt ? `<p class="alarm">${esc(stale() ? 'The desk stopped answering' : S.halt)}</p>` : '') +
      `<div class="tiles"><div><b>${books.length}</b><span>books</span></div><div class="${held ? '' : 'off'}"><b>${held}</b><span>held</span></div></div>` +
      `<dl class="mny"><div><dt>At work</dt><dd>${money(atWork, 0)}</dd></div><div><dt>Cash free</dt><dd>${money(cash, 0)}</dd></div></dl>` +
      `<div class="near"><span class="lh">Stock market</span><span class="nx"><b>${mk.open ? 'Open' : 'Closed'}</b> · ${esc(mk.says || '')}</span></div>` +
      `<div class="near extra"><span class="lh">Prices</span><span class="nn">${mk.stale && mk.stale.crypto ? 'crypto stale' : 'crypto live'} · ${esc(lag)}</span></div>` +
      `<div class="near extra"><span class="lh">Options today</span><span class="nn">${esc(cap(optionsLine()))}</span></div>` +
      `<p class="dim">Up ${dur(S.now - S.startedAt)} · build ${esc(sha)}</p>`;
    const key = `${html}|${Math.round(statusBox.w * k)}x${Math.round(statusBox.h * k)}`;
    if (key !== statusHtml) { el.innerHTML = html; statusHtml = key; fitText(el, Math.max(12, Math.min(21, k * 7.2)), 9); }
  }

  // ------------------------------------------------------------ the wall screen: the books
  let wallKey = '', tapeKey = '', clockTxt = '', wallWide = false;
  // The wall's size comes from the room's drawing, not from what it has to hold, so a small room
  // steps it down rather than clipping it (the review's B3): with the number in its own column, the
  // per-book split under it goes first, then the line under the number. A small wall with the number
  // on top is .compact, which keeps the three books and leaves their holdings one click away.
  function fitWall(el) {
    el.classList.remove('short', 'shorter');
    const num = el.querySelector('.wnum');
    if (!num || !wallWide) return;
    if (num.scrollHeight > num.clientHeight + 1) el.classList.add('short');
    if (num.scrollHeight > num.clientHeight + 1) el.classList.add('shorter');
  }
  const sideTag = (txt, cls) => `<span class="sd ${cls || 'long'}">${esc(txt)}</span>`;
  const plCell = (v) => (Number.isFinite(v) ? `<span class="pl ${tone(v)}">${signed(v)}</span>` : '<span class="pl">—</span>');
  function holdingRow(b, r) {
    const tag = b.key === 'options' ? sideTag(`${r.qty} × ${px(r.px)}`, 'long')
      : Number.isFinite(r.target) ? sideTag(`${Math.round(r.target * 100)}%`, 'long') : sideTag('cash', 'arb');
    const sub = b.key === 'options' ? r.label
      : `${r.qty > 0 ? `${qtyTxt(r.qty, b.key, r.sym)} ${b.key === 'crypto' ? r.name : 'sh'} at ${px(r.px)}` : `not held yet, ${px(r.px)}`}${Number.isFinite(r.vol) ? ` · swings ${pct(r.vol)}` : ''}`;
    return `<button class="wr long hold" data-b="${b.key}" data-k="hold:${b.key}:${esc(r.sym)}"><span class="nm"><span class="l1 fitw"><span>${esc(r.name)}</span><i> · ${esc(sub)}</i></span></span>${tag}<span class="val">${money(r.value || 0, 0)}</span>${plCell(r.pnl)}</button>`;
  }
  const heldIn = (b) => b.rows.filter((r) => r.qty > 0).length;
  function bookRow(b) {
    const vs = b.bench != null ? `holding ${signed(b.benchPnl)}` : b.key === 'options' ? optionsLine() : 'starts at its first trade';
    return `<button class="wr bk" data-b="${b.key}" data-k="book:${b.key}" style="--bk:${BOOK_COLOR[b.key]}"><span class="nm"><span class="l1 fitw"><span>${esc(b.name)}</span><i> · ${esc(vs)}</i></span></span>` +
      `${sideTag(heldIn(b) ? `${heldIn(b)} held` : 'flat', heldIn(b) ? 'long' : 'arb')}<span class="val">${money(b.equity, 0)}</span>${plCell(b.pnl)}</button>`;
  }
  function wallHome() {
    const books = S.books || [];
    const bench = books.filter((b) => b.bench != null);
    const benchPnl = bench.length ? r2(bench.reduce((a, b) => a + b.benchPnl, 0)) : null;
    const booksPnl = bench.length ? r2(bench.reduce((a, b) => a + b.pnl, 0)) : null;
    const stat = (label, v, c) => `<div class="${c || ''}"><dt>${label}</dt><dd class="${tone(v)}">${signed(v)}</dd></div>`;
    const fees = r2(books.reduce((a, b) => a + (b.fees || 0), 0));
    const num = `<div class="wbig ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="wsub">all three books, marked now · started with ${money(S.initial, 0)}</div>` +
      `<dl class="wstats">${S.today != null ? stat('Today', S.today) : ''}` +
      `${benchPnl != null ? stat('vs holding', r2(booksPnl - benchPnl)) : ''}` +
      books.map((b) => stat(b.name, b.pnl, 'x')).join('') +
      `${fees ? `<div class="x"><dt>Fees paid</dt><dd class="neg">−${money(fees)}</dd></div>` : ''}</dl>`;
    const held = books.reduce((a, b) => a + heldIn(b), 0);
    let h = `<div class="wh"><span>Paper books</span><span>${held} held · ${esc(S.market ? S.market.says : '')}</span></div>`;
    const head = `<div class="wcols" role="row"><span>Book</span><span>Held</span><span style="text-align:right">Value</span><span style="text-align:right">P&amp;L</span></div>`;
    const rows = books.map((b) => bookRow(b) + b.rows.map((r) => holdingRow(b, r)).join('')).join('');
    h += `<div class="wbody"><div class="wnum">${num}</div><div class="wbook">${head}<div class="wlist">${rows}</div></div></div>`;
    return h;
  }
  function wallBook(key) {
    const b = bookOf(key);
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span style="color:${BOOK_COLOR[key]}">${b ? esc(b.name) : ''} book</span></div>`;
    if (!b) return h + '<p class="wempty">No such book.</p>';
    h += `<div class="wbig ${tone(b.pnl)}">${signed(b.pnl)}</div><div class="wsub">on ${money(b.initial, 0)} · worth ${money(b.equity)} now</div>`;
    h += `<p class="wq">${esc(b.rule)}</p>`;
    const facts = [
      ['Holding instead', b.bench != null ? `${signed(b.benchPnl)} (${money(b.bench)})` : key === 'options' ? 'not a thing to hold' : 'starts at the first trade'],
      ['Banked', signed(b.realized)], ['Fees paid', money(b.fees)],
    ];
    if (key === 'options') {
      const d = S.options && S.options.day, sp = S.options && S.options.spy;
      facts.unshift(['Today', cap(optionsLine())]);
      if (sp) facts.push(['SPY at the last bar', `${sp.c.toFixed(2)} · VWAP ${sp.vwap != null ? sp.vwap.toFixed(2) : '—'} · ATR ${sp.atr != null ? sp.atr.toFixed(2) : '—'}`]);
      if (d && d.test) facts.push(['12:30 test', `${d.test.dir} ${d.test.moveAtr.toFixed(2)} ATR from the open, gave back ${Math.round(d.test.retr * 100)}%`]);
    }
    h += `<dl class="wfacts">${facts.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}</dl>`;
    if (b.rows.length) h += `<div class="wlist">${b.rows.map((r) => holdingRow(b, r)).join('')}</div>`;
    const trades = key === 'options' ? (S.options.trades || []).slice(0, 6) : [];
    if (trades.length) h += `<ol class="wlog">${trades.map((t) => `<li class="lv-${t.open ? 'info' : 'trade'}"><span class="t">${esc(t.date.slice(5))}</span><span>${t.qty} × ${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}</span></li>`).join('')}</ol>`;
    // the fills themselves are on the tape beside this screen; the book's own page keeps its room for the holdings
    return h;
  }
  function wallAgent(a) {
    const lines = [], seen = new Set();
    for (const e of (S.log || []).filter((x) => x.agent === a.key)) {
      const sx = say(e), k = shape(sx.text);
      if (seen.has(k)) continue;
      seen.add(k); lines.push({ e, sx });
      if (lines.length >= 7) break;
    }
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span style="color:${a.color}">${esc(a.key)} · ${esc(cap(String(a.role).toLowerCase()))}</span></div>` +
      `<div class="wq">${esc(cap(ROLE[a.key] || ''))}</div>`;
    if (a.key === 'PRED') {
      const P = S.legacy;
      if (!P) return h + '<p class="wempty">The prediction-market desk is not running in this process.</p>';
      h += `<div class="wbig ${tone(P.pnl)}">${signed(P.pnl)}</div><div class="wsub">all its paper books, marked now · no new trades since 2026-09-25</div>`;
      h += `<dl class="wfacts"><dt>Still open</dt><dd>${P.groups} arb${P.groups === 1 ? '' : 's'} and ${P.contracts.toLocaleString()} maker contracts in ${P.held} markets</dd>` +
        `<dt>Next settles</dt><dd>${P.nextSettle ? new Date(P.nextSettle).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '—'}</dd></dl>`;
      return h + `<p class="wread">Its own floor is still at <a href="/pm">/pm</a> until the last position settles.</p>`;
    }
    return h + (lines.length ? `<ol class="wlog">${lines.map(({ e, sx }) => `<li class="lv-${sx.level}"><span class="t">${hhmm(e.t)}</span><span>${esc(sx.text)}${sx.sub ? `<small class="wsubl"> · ${esc(sx.sub)}</small>` : ''}</span></li>`).join('')}</ol>` : '<p class="wempty">Nothing logged yet.</p>');
  }
  function wallFill(id) {
    const f = (S.fills || []).find((x) => x.id === id);
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span>${f ? `${esc(cap(f.book))} book · ${ago(f.at)}` : ''}</span></div>`;
    if (!f) return h + '<p class="wempty">That trade is no longer on the board.</p>';
    h += `<div class="wtitle">${f.side === 'buy' ? 'Bought' : 'Sold'} ${qtyTxt(f.qty, f.book, f.sym)} ${esc(f.label)}</div>`;
    if (f.pnl != null) h += `<div class="wbig ${tone(f.pnl)}">${signed(f.pnl)}</div><div class="wsub">made or lost on this sale, fees included</div>`;
    h += `<ul class="wrecap"><li>At ${px(f.px)}${f.book === 'options' ? ' a share, 100 shares a contract' : ''}: ${money(f.value)}${f.fee ? `, plus ${money(f.fee)} in fees` : ''}.</li><li>Why: ${esc(f.why || '—')}.</li></ul>`;
    return h;
  }

  // ------------------------------------------------------------ the chart: every book, and what holding would have made
  const RANGES = [['1h', 36e5], ['6h', 216e5], ['24h', 864e5], ['All', Infinity]];
  const chart = { range: 'All' };
  try { const c = JSON.parse(localStorage.getItem('desk-chart') || '{}'); if (RANGES.some(([r]) => r === c.range)) chart.range = c.range; } catch { /* defaults */ }
  let hist = { points: [], initial: 0, loaded: false };
  async function loadHistory() {
    try {
      const r = await fetch('/api/desk/history');
      if (!r.ok) return;
      const h = await r.json();
      hist = { points: h.points || [], initial: h.initial || 0, books: h.books || {}, loaded: true };
      for (const el of plots.keys()) drawChart(el);
    } catch { /* the chart waits for the next try */ }
  }
  const plots = new Map();
  // points: [t, desk P&L, holding P&L|null]. The live end comes from the stream, the rest from history.
  function chartSeries() {
    const bk = hist.books || {}, opt = bk.options || 0;
    // holding: each book's benchmark, or its own value while it has not traded (the options book is never "held": its cash)
    const pts = hist.points.map((p) => [p.t, r2(p.e - hist.initial), p.bc != null && p.bs != null ? r2(p.bc + p.bs + opt - hist.initial) : null]);
    if (S && Number.isFinite(S.pnl)) {
      const bc = bookOf('crypto'), bs = bookOf('stocks');
      const held = (b) => (b.bench != null ? b.bench : b.equity);
      pts.push([S.now, S.pnl, bc && bs ? r2(held(bc) + held(bs) + opt - hist.initial) : null]);
    }
    const span = RANGES.find(([r]) => r === chart.range)[1];
    const from = Number.isFinite(span) ? (S ? S.now : Date.now()) - span : -Infinity;
    return pts.filter((p) => p[0] >= from);
  }
  function chartSkeleton(big) {
    const seg = `<span class="seg">${RANGES.map(([r]) => `<button data-range="${r}" class="${chart.range === r ? 'on' : ''}">${r}</button>`).join('')}</span>`;
    return `<div class="ct"><span class="ctitle">Every paper book</span>${big ? '' : '<button class="cx" data-expand="1" title="Open large">⤢</button>'}</div>` +
      `<div class="chead"><span class="cv"></span><span class="cd"></span></div>` +
      `<div class="cplot"></div><div class="cb">${seg}<span class="cr"></span></div>`;
  }
  function makePlot(el, big) {
    const LW = window.LightweightCharts;
    if (!LW) return null;
    const c = LW.createChart(el.querySelector('.cplot'), {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: TOK['ink-3'], fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontSize: 9, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: TOK['rule-1'] } },
      // a label at the plot's edge is drawn whole or not at all, never cut in half; the bottom margin
      // is set in drawChart from the plot's height, to keep the line clear of the licence's logo
      rightPriceScale: { borderVisible: false, entireTextOnly: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { visible: big, borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true },
      localization: { timeFormatter: (sec) => new Date(sec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
      crosshair: { mode: LW.CrosshairMode.Magnet, horzLine: { visible: big, labelVisible: big } },
    });
    // Above zero the line and its fill are the gain colour, below it the loss colour, whatever the
    // range: it used to take one colour from whether P&L rose over the range, so a losing desk could
    // be drawn green and switching the range could turn the same book red (the review's B6).
    const desk = c.addSeries(LW.BaselineSeries, { baseValue: { type: 'price', price: 0 },
      topLineColor: TOK.gain, topFillColor1: withAlpha(TOK.gain, 0.22), topFillColor2: withAlpha(TOK.gain, 0.02),
      bottomLineColor: TOK.loss, bottomFillColor1: withAlpha(TOK.loss, 0.02), bottomFillColor2: withAlpha(TOK.loss, 0.22),
      lineWidth: big ? 3 : 2, priceLineVisible: false, lastValueVisible: big, crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (v) => signed(v) } });
    const hold = c.addSeries(LW.LineSeries, { color: TOK['ink-3'], lineWidth: 1, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    desk.createPriceLine({ price: 0, color: withAlpha(TOK['ink-3'], 0.45), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
    return { c, desk, hold };
  }
  function drawChart(el) {
    let p = plots.get(el);
    if (!p) return;
    const pts = chartSeries();
    const last = pts.length ? pts[pts.length - 1][1] : (S ? S.pnl : 0);
    const first = pts.length ? pts[0][1] : last;
    morph(el.querySelector('.cv'), `<span class="${tone(last || 0)}">${signed(last || 0)}</span>`);
    el.querySelector('.cd').textContent = pts.length > 1 ? `${signed(last - first)} over ${chart.range === 'All' ? 'all of it' : chart.range}` : '';
    const lastHold = [...pts].reverse().find((x) => x[2] != null);
    morph(el.querySelector('.cr'), lastHold ? `<span title="The dashed line: every book simply holding what it trades, from its first trade">holding: <b class="${tone(lastHold[2])}">${signed(lastHold[2])}</b></span>` : '');
    if (!p.plot) p.plot = makePlot(el, p.big);
    if (!p.plot) return;
    // The licence's logo sits in the plot's bottom-left corner, about 30px tall: the small charts leave
    // that much under the lowest point so the line never runs through it (the review's X2), however
    // short the plot. The large chart's time axis already keeps it clear.
    const ph = el.querySelector('.cplot').clientHeight;
    const bottom = p.big ? 0.12 : Math.min(0.5, Math.max(0.12, 34 / Math.max(1, ph)));
    if (p.bottom !== bottom) { p.plot.c.priceScale('right').applyOptions({ scaleMargins: { top: 0.12, bottom } }); p.bottom = bottom; }
    // the library wants strictly rising whole seconds
    const bySec = new Map();
    for (const [t, v, hv] of pts) bySec.set(Math.floor(t / 1000), [v, hv]);
    const rows = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
    p.plot.desk.setData(rows.map(([t, [v]]) => ({ time: t, value: v })));
    p.plot.hold.setData(rows.filter(([, [, hv]]) => hv != null).map(([t, [, hv]]) => ({ time: t, value: hv })));
    p.plot.c.timeScale().fitContent();
  }
  function wireChart(el, big) {
    el.innerHTML = chartSkeleton(big);
    plots.set(el, { big, plot: null });
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.range) {
        chart.range = b.dataset.range;
        try { localStorage.setItem('desk-chart', JSON.stringify(chart)); } catch { /* private window */ }
        for (const [e2] of plots) { e2.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x.dataset.range === chart.range)); drawChart(e2); }
      }
      if (b.dataset.expand) openBigChart();
    });
  }
  const bigChart = $('chartbig');
  function openBigChart() { bigChart.hidden = false; drawChart($('chartbig-pnl')); }
  function closeBigChart() { bigChart.hidden = true; }
  bigChart.addEventListener('click', (ev) => { if (ev.target === bigChart || ev.target.closest('[data-close]')) closeBigChart(); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeBigChart(); });

  // ------------------------------------------------------------ the boards, laid over the room
  function placeBoards(X, Y, k) {
    const fit = (el, b, fs) => Object.assign(el.style, { left: `${X(b.x)}px`, top: `${Y(b.y)}px`, width: `${b.w * k}px`, height: `${b.h * k}px` }, fs ? { fontSize: `${fs}px` } : {});
    if (wallBox) {
      const el = $('wall');
      const wallFs = Math.max(12, Math.min(21, k * 7.2));
      fit(el, wallBox, null);
      wallWide = wallBox.w > wallBox.h * 2.3 && wallBox.w * k > 560;
      el.classList.toggle('wide', wallWide);
      el.classList.toggle('compact', !wallWide && wallBox.h * k < 235);
      const selPart = sel ? sel.kind + sel.key : '';
      const key = `${frameSeq}|${selPart}|${wallWide}|${Math.round(wallBox.w * k)}`;
      if (key !== wallKey) {
        const list = el.querySelector('.wlist, .wlog');
        const top = list && wallKey.split('|')[1] === selPart ? list.scrollTop : 0;
        wallKey = key;
        el.style.fontSize = `${wallFs}px`;
        const a = sel && sel.kind === 'agent' ? S.agents.find((x) => x.key === sel.key) : null;
        morph(el, sel && sel.kind === 'book' ? wallBook(sel.key) : sel && sel.kind === 'fill' ? wallFill(sel.key) : a ? wallAgent(a) : wallHome());
        if (!sel) fitWall(el);
        const list2 = el.querySelector('.wlist, .wlog');
        if (list2) list2.scrollTop = top;
        el.classList.toggle('more', !!list2 && list2.scrollHeight > list2.clientHeight + 2);
        fitAll(el);
        fitWidth(el.querySelector('.wbig'), 14);
        if (sel) fitText(el, wallFs, 9);
      }
    }
    if (chartBox) {
      const el = $('chart');
      fit(el, chartBox, Math.max(11, Math.min(16, k * 5.2)));
      if (el.dataset.frame !== String(frameSeq)) { el.dataset.frame = String(frameSeq); drawChart(el); }
    }
    if (tapeBox) {
      const el = $('tape');
      fit(el, { x: tapeBox.x + 1, y: tapeBox.y + 1, w: tapeBox.w - 2, h: tapeBox.h - 2 }, Math.max(11.5, Math.min(17, k * 5.6)));
      if (!el.firstChild) el.innerHTML = '<div class="th"><span>Recent fills</span><span class="tclock"></span></div><div class="tbody"><ol></ol><p class="none" hidden></p></div>';
      const tk = `${frameSeq}|${sel && sel.kind === 'fill' ? sel.key : ''}|${Math.round(tapeBox.w * k)}`;
      if (tk !== tapeKey) {
        tapeKey = tk;
        const fills = S.fills || [];
        const ol = el.querySelector('ol'), none = el.querySelector('.none');
        const html = fills.map((f) => `<li class="${f.side}${sel && sel.kind === 'fill' && sel.key === f.id ? ' on' : ''}" data-f="${esc(f.id)}" data-k="${esc(f.id)}">` +
          `<span class="act"><b>${f.side === 'buy' ? 'Bought' : 'Sold'}</b> ${esc(qtyTxt(f.qty, f.book, f.sym))} <i>${esc(f.book === 'crypto' ? f.sym.replace('-USD', '') : f.book === 'options' ? 'contract' + (f.qty === 1 ? '' : 's') : f.sym)}</i></span>` +
          `<span class="px">${f.pnl != null ? `<span class="${tone(f.pnl)}">${signed(f.pnl)}</span>` : money(f.value)}</span>` +
          `<span class="nm fitw"><span>${esc(f.label)}</span><i> · ${esc(f.book)}</i></span><span class="ago">${px(f.px)} · ${ago(f.at).replace(' ago', '').split(' ')[0]}</span></li>`).join('');
        morph(ol, html);
        fitAll(ol);
        ol.hidden = !fills.length; none.hidden = !!fills.length;
        if (!fills.length) none.textContent = 'No fills yet';
        el.classList.toggle('more', ol.scrollHeight > ol.clientHeight + 2);
      }
      const t = new Date(S.now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      const hm = t.replace(/ [AP]M$/, '');
      const on = !S.halt && !stale();
      const html = `<b class="${on ? 'on' : ''}">${hm.slice(0, -3)}<span class="sec">${hm.slice(-3)}</span></b><small>${t.slice(-2)} ET</small>`;
      if (html !== clockTxt) { el.querySelector('.tclock').innerHTML = html; clockTxt = html; }
    }
  }
  $('tape').addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-f]');
    if (!li) return;
    sel = sel && sel.kind === 'fill' && sel.key === li.dataset.f ? null : { kind: 'fill', key: li.dataset.f };
    wallKey = ''; tapeKey = '';
  });
  $('wall').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.back) sel = null;
    else if (b.dataset.b) sel = sel && sel.kind === 'book' && sel.key === b.dataset.b ? null : { kind: 'book', key: b.dataset.b };
    wallKey = '';
  });

  // ------------------------------------------------------------ the Markets tab: what the desk watches
  let feedTab = 'feed';
  function renderMarkets() {
    if (feedTab !== 'markets' || !S) return;
    const rows = [];
    const chg = (last, prev) => (last > 0 && prev > 0 ? (last / prev - 1) : null);
    for (const r of (bookOf('crypto') || { rows: [] }).rows) {
      const c = chg(r.bid, r.prevClose);
      rows.push({ name: r.name, sub: `${r.label} · live`, price: px(r.bid), chg: c, vol: r.vol, want: r.want });
    }
    const sp = S.spy;
    if (sp) rows.push({ name: 'SPY', sub: `S&P 500 ETF · ${S.market && S.market.delayMin != null ? `${S.market.delayMin} min late` : '15 min late'}`, price: px(sp.bid || sp.last), chg: chg(sp.last, sp.prevClose), vol: sp.vol, want: sp.want });
    const head = '<div class="mcols"><span>Market</span><span style="text-align:right">Price</span><span style="text-align:right">Today</span><span style="text-align:right">Swings</span><span style="text-align:right">Target</span></div>';
    const list = rows.map((x) => `<li><span class="nm">${esc(x.name)} <i>${esc(x.sub)}</i></span><span class="v">${x.price}</span>` +
      `<span class="g ${x.chg == null ? 'none' : tone(x.chg, 4)}">${x.chg == null ? '—' : isZero(x.chg, 4) ? '0.00%' : `${x.chg > 0 ? '+' : MINUS}${Math.abs(x.chg * 100).toFixed(2)}%`}</span>` +
      `<span class="v">${Number.isFinite(x.vol) ? pct(x.vol) : '—'}</span><span class="v">${Number.isFinite(x.want) ? pct(x.want) : '—'}</span></li>`).join('');
    const note = `<p class="mnone">"Swings" is how much the market has moved in a year, measured over the last ${S.cfg ? '30 days for crypto and 20 sessions for SPY' : 'few weeks'}. "Target" is how much of its slot the book wants to hold: less when it swings more. Options today: <b>${esc(optionsLine())}</b>.</p>`;
    morph($('marketlist'), `${head}<ol class="mlist">${list}</ol>${note}`);
  }
  $('feed').querySelector('.fh').addEventListener('click', (ev) => {
    const b = ev.target.closest('.ftab');
    if (!b) return;
    feedTab = b.dataset.tab;
    for (const x of document.querySelectorAll('#feed .ftab')) { const on = x === b; x.classList.toggle('on', on); x.setAttribute('aria-selected', on ? 'true' : 'false'); }
    $('feedlist').hidden = feedTab !== 'feed';
    $('marketlist').hidden = feedTab !== 'markets';
    renderMarkets();
  });

  // ------------------------------------------------------------ phones: the facts as type
  let mobileChart = null;
  // A tap on a book card opens that book under the cards: what it holds, its rule, and how it stands
  // against simply holding. It used to pick the book for the wall screen, which phones do not show, so
  // the card looked tappable and did nothing (the review's B4). The panel is always in the page and
  // hidden when closed, so the summary keeps one shape and the chart below it is never rebuilt.
  let mobileBook = null;
  function mobileDetail(b) {
    if (!b) return '';
    const facts = [
      ...(b.key === 'options' ? [['Today', esc(cap(optionsLine()))]] : []),
      ['Holding instead', b.bench != null ? `<span class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</span>` : b.key === 'options' ? 'not a thing to hold' : 'starts at the first trade'],
      ['Banked', `<span class="${tone(b.realized)}">${signed(b.realized)}</span>`],
      ['Fees paid', money(b.fees)],
    ];
    const rows = b.rows.map((r) => {
      const what = b.key === 'options' ? `${r.qty} × ${px(r.px)} · ${r.label}` : r.qty > 0 ? `${qtyTxt(r.qty, b.key, r.sym)} at ${px(r.px)}` : `not held yet, ${px(r.px)}`;
      return `<li data-k="${esc(r.sym)}"><div><b>${esc(r.name)}</b><small>${esc(what)}</small></div><span class="v">${money(r.value || 0)}</span>` +
        `<span class="${Number.isFinite(r.pnl) ? tone(r.pnl) : ''}">${Number.isFinite(r.pnl) ? signed(r.pnl) : '—'}</span></li>`;
    }).join('');
    return `<div class="m-detail-top"><b>${esc(b.name)} book</b><span>worth ${money(b.equity)} · on ${money(b.initial, 0)}</span></div>` +
      `<dl class="m-facts">${facts.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
      (rows ? `<ol class="m-holds">${rows}</ol>` : '<p class="m-none">Nothing held yet.</p>') +
      `<p class="m-rule">${esc(b.rule)}</p>`;
  }
  function renderMobileSummary() {
    const el = $('mobile-summary');
    if (!el || !S) return;
    const [state, cls] = deskState();
    const lf = (S.fills || [])[0];
    const open = mobileBook && bookOf(mobileBook) ? mobileBook : null;
    const books = (S.books || []).map((b) => `<button type="button" class="m-book${open === b.key ? ' open' : ''}" data-b="${b.key}" data-k="${b.key}" aria-expanded="${open === b.key}" aria-controls="m-detail" style="--bk:${BOOK_COLOR[b.key]}"><span>${esc(b.name)}</span><b class="${tone(b.pnl)}">${signed(b.pnl)}</b>` +
      `<small>${b.bench != null ? `holding ${signed(b.benchPnl)}` : b.key === 'options' ? esc(optionsLine()) : 'no trade yet'}</small></button>`).join('');
    morph(el, `<div class="m-hero"><div><span class="m-label">All paper books</span><strong class="${tone(S.pnl)}">${signed(S.pnl)}</strong>` +
      `<small>${S.market ? esc(`Stock market ${S.market.says}`) : ''}</small></div><span class="m-state ${cls}"><i></i>${esc(state)}<small>PAPER</small></span></div>` +
      `<div class="m-books">${books}</div>` +
      `<section id="m-detail" class="m-detail" aria-label="${open ? esc(bookOf(open).name) : ''} book"${open ? '' : ' hidden'}>${open ? mobileDetail(bookOf(open)) : ''}</section>` +
      `<div id="mobile-chart" class="pnl m-chart" data-keep></div>` +
      (lf ? `<div class="m-fill"><div><span class="m-label">Latest fill</span><b>${lf.side === 'buy' ? 'Bought' : 'Sold'} ${esc(qtyTxt(lf.qty, lf.book, lf.sym))} ${esc(lf.label)} at ${px(lf.px)}</b></div><p><span class="why">${esc(lf.why || '')}</span><small>${ago(lf.at)}</small></p></div>`
        : '<div class="m-fill empty"><div><span class="m-label">Latest fill</span><b>No fills yet</b></div></div>') +
      `<div class="m-agents"><span class="m-label">Desks</span><div>${(S.agents || []).map((a) => `<span class="m-agent${isActive(a) ? ' on' : ''}" style="--agent:${a.color}"><i></i>${esc(a.key)}</span>`).join('')}</div></div>`);
    const slot = $('mobile-chart');
    if (slot) {
      if (!mobileChart) { mobileChart = slot; wireChart(slot, false); }
      drawChart(mobileChart);
    }
  }

  // ------------------------------------------------------------ the floor's own size (drag the split)
  const SPLIT_KEY = 'desk-feedh';
  const stage = document.querySelector('.stage'), splitter = $('split');
  const feedRange = () => ({ min: 96, max: Math.max(120, Math.round(stage.clientHeight * 0.7)) });
  function setFeedH(pxv, save = true) {
    const { min, max } = feedRange();
    const v = Math.round(Math.min(max, Math.max(min, pxv)));
    stage.style.setProperty('--feedh', `${v}px`);
    if (save) { try { localStorage.setItem(SPLIT_KEY, String(v)); } catch { /* private window */ } }
  }
  function clearFeedH() { stage.style.removeProperty('--feedh'); try { localStorage.removeItem(SPLIT_KEY); } catch { /* ignore */ } }
  try { const saved = +localStorage.getItem(SPLIT_KEY); if (saved > 0) setFeedH(saved, false); } catch { /* ignore */ }
  if (splitter) {
    let dragging = false;
    splitter.addEventListener('pointerdown', (ev) => { if (ev.button !== 0) return; dragging = true; stage.classList.add('sizing'); splitter.setPointerCapture(ev.pointerId); ev.preventDefault(); });
    splitter.addEventListener('pointermove', (ev) => { if (dragging) setFeedH(stage.getBoundingClientRect().bottom - ev.clientY); });
    const stop = () => { dragging = false; stage.classList.remove('sizing'); };
    splitter.addEventListener('pointerup', stop); splitter.addEventListener('pointercancel', stop);
    splitter.addEventListener('dblclick', clearFeedH);
  }

  // ------------------------------------------------------------ wiring
  function loop(ts) {
    drawFloor(ts / 1000); placeFx();
    if (S && stale() !== shownGone) { renderHeader(); renderMobileSummary(); }
    requestAnimationFrame(loop);
  }
  function render() {
    frameSeq++; renderHeader(); renderMobileSummary(); ingest(); renderMarkets();
    if (!bigChart.hidden) drawChart($('chartbig-pnl'));
  }
  function connect() {
    const es = new EventSource('/api/desk/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); lastFrameAt = Date.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  $('mobile-summary').addEventListener('click', (ev) => {
    const b = ev.target.closest('.m-book[data-b]');
    if (!b) return;
    mobileBook = mobileBook === b.dataset.b ? null : b.dataset.b;
    renderMobileSummary();
  });
  wireChart($('chart'), false);
  wireChart($('chartbig-pnl'), true);
  wireFloor();
  connect();
  loadHistory(); setInterval(loadHistory, 60000);
  requestAnimationFrame(loop);
})();

/* The Hexagon — dashboard client. Consumes the SSE state stream and renders everything. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let S = null;

  // ------------------------------------------------------------ formatting
  const money = (x, d = 2) => `$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const signed = (x, d = 2) => `${x >= 0 ? '+' : '-'}${money(x, d)}`;
  const cents = (x) => `${(Math.abs(x) * 100).toFixed(1)}c`;
  const hhmm = (t) => { const d = new Date(t); return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`; };
  const dur = (ms) => { const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4); return `${h}h ${String(m).padStart(2, '0')}m`; };
  // "nothing is happening" and "something happened four minutes ago" look identical unless the
  // page can say which.
  const ago = (t) => {
    if (!t || !S) return 'never';
    const d = Math.max(0, Math.round((S.now - t) / 1000));
    if (d < 60) return `${d}s ago`;
    if (d < 3600) return `${Math.floor(d / 60)}m ago`;
    return `${Math.floor(d / 3600)}h ${Math.floor((d % 3600) / 60)}m ago`;
  };
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const agentColor = (k) => (S && S.agents.find((a) => a.key === k) || {}).color || '#888';
  // The desks run back-to-back within milliseconds each cycle; stagger the RUN indicator in cycle order
  // so the floor reads as a sequence (scan → flow → ops → settle → price → execute) instead of one flash.
  const CYCLE = { HOLT: 0, ILSA: 1, TESS: 2, RIGO: 3, BRAM: 4, KETT: 5, MAKR: 6 };
  const isActive = (a) => { const dt = S.now - a.lastActive - (CYCLE[a.key] || 0) * 900; return dt >= 0 && dt < 3200; };

  // ------------------------------------------------------------ header + tiles
  function renderHeader() {
    const day = Math.floor((S.now - S.startedAt) / 86400000) + 1;
    const modeCls = S.halt ? 'halt' : 'live';
    const modeTxt = S.halt ? `HALT · ${esc(S.halt)}` : (S.mode === 'live' ? 'LIVE' : 'PAPER');
    const P = S.pnl || {};
    const arb = Number.isFinite(P.arbLocked) ? signed(P.arbLocked) : '—';
    const alert = P.integrityAlerts ? `<span><span class="k">Arb check</span><b class="halt">${P.integrityAlerts} ALERT${P.integrityAlerts === 1 ? '' : 'S'}</b></span>` : '';
    $('meta').innerHTML =
      `<span><span class="k">Day</span><b>${day}</b></span>` +
      `<span><span class="k">Uptime</span><b>${dur(S.now - S.startedAt)}</b></span>` +
      `<span><span class="k">Pairs</span><b>${S.pairCount}</b></span>` +
      `<span><span class="k">Open</span><b>${S.positions.length}</b></span>` +
      `<span><span class="k">Arb locked</span><b class="${P.arbLocked >= 0 ? 'live' : 'halt'}">${arb}</b></span>` +
      alert +
      (S.demo ? `<span class="demo">● DEMO QUOTES</span>` : '') +
      `<span><span class="k">Position</span><b class="${modeCls}">● ${modeTxt}</b></span>`;
  }
  // renderTiles is gone with the tiles it fed. They reported the convergence book -- the desk that
  // found no edge -- so the page opened on "$10,000.00 / +$0.00" while the maker desk was trading.
  // A prominent number describing the wrong desk is worse than no number.

  // The activity log moved onto the floor. It was the last panel under the canvas, and while it
  // sat there the page had something to scroll -- which is the whole reason the wheel kept moving
  // the document instead of the list under the pointer.

  // ------------------------------------------------------------ floor interaction
  // The floor is a control surface, not a picture. Every frame rebuilds a list of hit regions in
  // the 480x260 drawing space; the pointer is mapped into that space and tested against them. Click
  // an agent or a market and the wall screen stops showing the book and shows that thing instead --
  // the big display becomes the focus view rather than a second panel competing for room.
  // When the desk stops, the page keeps ticking. The clock is advanced locally between SSE frames
  // so the seconds animate smoothly, which means a dead server looks exactly like a live one --
  // same numbers, same clock, same lit screens, and the only clue is an activity log whose newest
  // line is quietly minutes old. That is the same failure that has bitten three tools tonight, so
  // the page says it out loud instead.
  let lastFrameAt = 0;
  const STALE_MS = 12000;   // frames arrive every 2s; 12 is well past a hiccup
  const stale = () => lastFrameAt && Date.now() - lastFrameAt > STALE_MS;

  let hits = [];                 // rebuilt each frame: { x, y, w, h, kind, key }
  let hover = null, sel = null;
  // The chart is inside the room too: hover reads a point, click pins it for comparison.
  // Store timestamps rather than array offsets because the server trims history over time.
  let chartBox = null, chartHoverT = null, chartPinnedT = null;
  const chartAt = (p) => {
    if (!chartBox || p.x < chartBox.left || p.x > chartBox.right || p.y < chartBox.top || p.y > chartBox.bottom) return null;
    return chartBox.history.reduce((best, point) => Math.abs(chartBox.xFor(point.t) - p.x) < Math.abs(chartBox.xFor(best.t) - p.x) ? point : best, chartBox.history[0]);
  };

  function floorPoint(ev) {
    const cv = $('floorc'), r = cv.getBoundingClientRect();
    return {
      x: (ev.clientX - r.left - floorBox.ox) / floorBox.scale,
      y: (ev.clientY - r.top - floorBox.oy) / floorBox.scale,
    };
  }
  const hitAt = (p) => hits.find((h) => p.x >= h.x && p.x <= h.x + h.w && p.y >= h.y && p.y <= h.y + h.h) || null;
  const same = (a, b) => a && b && a.kind === b.kind && a.key === b.key;

  function wireFloor() {
    const cv = $('floorc');
    cv.addEventListener('mousemove', (ev) => {
      const p = floorPoint(ev);
      hover = hitAt(p);
      const point = chartAt(p);
      chartHoverT = point ? point.t : null;
      cv.style.cursor = hover || point ? 'pointer' : 'default';
    });
    cv.addEventListener('mouseleave', () => { hover = null; chartHoverT = null; });
    cv.addEventListener('click', (ev) => {
      const p = floorPoint(ev), point = chartAt(p);
      if (point) { chartPinnedT = chartPinnedT === point.t ? null : point.t; return; }
      const h = hitAt(p);
      sel = same(h, sel) ? null : h;          // clicking the selected thing again closes it
    });
    // clicking empty floor clears; so does Escape
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { sel = null; chartPinnedT = null; } });
  }

  const DESKS = [[132, 158], [216, 158], [300, 158], [132, 200], [216, 200], [300, 200], [384, 200]];
  function hash(i, j, k) { let x = (i * 374761393 + j * 668265263 + k * 2246822519) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; }
  function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, s, x, y, c, size = 7, align = 'left') { ctx.fillStyle = c; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(s, Math.round(x), Math.round(y)); }
  // ---- light, shadow and screen texture -----------------------------------------------------
  // Everything on this floor was flat fills, which is why it read as a diagram rather than a room.
  // These are the three things that make a dark interior look lit: a source, what it falls on, and
  // what it misses.
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
  // CRT texture: every other line a shade darker. Cheap, and it stops a large dark rectangle from
  // reading as a hole cut in the wall.
  function scanlines(ctx, x, y, w, h, alpha = 0.5) {
    ctx.save(); ctx.globalAlpha = alpha; ctx.fillStyle = '#000';
    for (let i = 0; i < h; i += 2) ctx.fillRect(x, y + i, w, 1);
    ctx.restore();
  }
  // A recessed panel: dark face, lit top edge, shadowed bottom. One call instead of four px().
  function panel(ctx, x, y, w, h, face, edge) {
    px(ctx, x, y, w, h, face);
    px(ctx, x, y, w, 1, edge);
    px(ctx, x, y + h - 1, w, 1, '#05070b');
    px(ctx, x, y, 1, h, edge); px(ctx, x + w - 1, y, 1, h, '#05070b');
  }
  // one-line job descriptions, because "RIGO · MANAGING" tells you nothing on its own
  const ROLE = {
    HOLT: 'finds and pairs markets across both venues',
    ILSA: 'reads news and sentiment on live events',
    BRAM: 'looks for convergence signals worth trading',
    KETT: 'sizes and places the convergence trades',
    RIGO: 'manages open positions and exits them',
    TESS: 'risk: drawdown, data age, the halt switch',
    MAKR: 'rests quotes and is paid the spread — the desk that trades',
  };
  // Cut to fit on a WORD boundary. An ellipsis is an admission that the text did not fit; a short
  // whole phrase is just a short whole phrase.
  const clip = (str, n) => {
    const t = String(str).trim();
    const out = t.length <= n ? t : t.slice(0, n).replace(/\s+\S*$/, '');
    // never end on a comma, a bullet or an open bracket -- that reads as a sentence cut off,
    // which is the thing a word-boundary cut was supposed to avoid
    return out.replace(/[\s,;:·\-–(\[]+$/, '').trim();
  };
  // What the market actually IS.
  //
  // Kalshi gives a full question in `title` and the specific outcome in `sub`. Clipping the title
  // to fit a column throws away the half that distinguishes one market from another: "Will
  // Republicans win the Senate race in Iowa?" and "...in Texas?" both became "Will Republicans
  // win", twice, on the same board. The outcome is the headline; the question is the subtitle.
  const OUTCOME = (m) => (m.sub || '').trim();
  // The question, compressed to the part that identifies the market. Kalshi writes them in full
  // prose -- "Will Republicans win the Senate race in Iowa?" -- and the outcome above already
  // carries the answer, so the boilerplate is dead weight in a 190px column.
  //   Will The Odyssey win Best Picture at the Oscars?        ->  Best Picture, Oscars
  //   Will Republicans win the Senate race in Iowa?           ->  Republicans win Senate race, Iowa
  //   Will Port of Mobile ... be above 450,000 TEUs?          ->  Port of Mobile throughput, 2026
  // "of" is deliberately left alone: it binds names together, and turning it into a comma made
  // "Port of Mobile" read as two places.
  const QUESTION = (m) => {
    const sub = (m.sub || '').trim();
    let t = String(m.title || '').trim().replace(/\s+/g, ' ').replace(/\?$/, '');
    t = t.replace(/^(Will|Which|Who|What|How many|How much)\s+/i, '');
    if (sub) {
      const esc = sub.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      t = t.replace(new RegExp(`\\b${esc}\\b`, 'i'), '');
      // the threshold is already the headline; "≥80,000" and "80000" are the same number
      const n = sub.replace(/[^0-9]/g, '');
      if (n.length > 2) t = t.replace(new RegExp(`[≥>< ]*\\b${n}\\b`), '');
      // removing the outcome leaves a leading space, and the verb strip below is anchored to ^
      t = t.replace(/\s+/g, ' ').trim();
    }
    t = t
      .replace(/^(win|have|be|receive|reach|get)\s+/i, '')
      .replace(/\bpro football team\b/gi, '')
      .replace(/\bregular season\b/gi, '')
      .replace(/\bcontainer throughput\b/gi, 'throughput')
      .replace(/\bgeneral government net lending\/borrowing balance\b/gi, 'net borrowing')
      .replace(/\bbe at least\b/gi, '≥').replace(/\bat least\b/gi, '≥')
      .replace(/\bbe above\b/gi, '>').replace(/\bbe below\b/gi, '<')
      .replace(/\bthis season\b/gi, '').replace(/\bfor all participants\b/gi, '')
      .replace(/\b(the|a|an)\s+/gi, ' ')
      .replace(/\s+(at|in|for)\s+/gi, ', ')
      .replace(/[≥><]\s+/g, (x) => x.trim())
      .replace(/\s+\bbe\b\s*$/i, '')
      .replace(/\s*,\s*,\s*/g, ', ').replace(/\s+/g, ' ').replace(/^[,\s]+|[,\s]+$/g, '');
    return clip(t.charAt(0).toUpperCase() + t.slice(1), 46);
  };
  // one-line fallback for places with no room for two
  function marketLabel(m, n) {
    const o = OUTCOME(m), q = QUESTION(m);
    if (!o && !q) return clip(m.ticker.replace(/^KX/, ''), n);
    if (!o) return clip(q.replace(/^(Will|Which|How many)\s+/i, '').replace(/\?$/, ''), n);
    return clip(o, n);
  }

  const byTicker = (M, t) => (M.markets || []).find((x) => x.ticker === t);

  // Kept immediately beside drawFloor on purpose. Twice now this has been swallowed by a
  // marker-to-marker deletion of a neighbouring block, and the failure is silent in the source and
  // fatal in the browser: the whole floor goes black sixty times a second.
  //
  // The art is drawn in a fixed 480x262 space but DISPLAYED at whatever size the viewport allows,
  // so the canvas gets a backing store at true device resolution and the context is scaled to
  // match. Coordinates below are unchanged; text draws as vectors at final size rather than being
  // upscaled into a smear.
  let floorSized = '';
  // The element box is whatever CSS ends up giving it, and that is NOT 480:340. Scaling x by
  // w/480 and y by h/340 -- which is what this did -- stretches the room to fit the box: a 736x787
  // element made everything 50% too tall. The shape of the room cannot be left to a stylesheet.
  //
  // So: ONE scale factor, the smaller of the two, with the result centred. The room keeps its
  // proportions at any window size and the leftover is letterbox. `floorBox` is the mapping the
  // pointer has to invert, so it is computed once here and read by floorPoint.
  const floorBox = { scale: 1, ox: 0, oy: 0 };
  // The room ends at the floor's front edge. The ledge that hung below it (P&L and the log) is gone:
  // the chart stands on the empty floor to the left of the desks, and the log is the HTML feed
  // under the room, where it can take whatever height the window has left.
  const ROOM_H = 262;
  function floorCtx() {
    const cv = $('floorc'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const key = `${w}x${h}`;
    if (key !== floorSized) { cv.width = w; cv.height = h; floorSized = key; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h);       // paint the letterbox
    const scale = Math.min(w / 480, h / ROOM_H);
    floorBox.scale = scale / dpr;                              // css px per drawing unit
    floorBox.ox = (w - 480 * scale) / 2 / dpr;
    floorBox.oy = (h - ROOM_H * scale) / 2 / dpr;
    ctx.setTransform(scale, 0, 0, scale, (w - 480 * scale) / 2, (h - ROOM_H * scale) / 2);
    return ctx;
  }

  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 480, ROOM_H);   // the letterbox is repainted in floorCtx
    hits = [];                               // rebuilt every frame; the pointer tests against them
    // ---- the room -----------------------------------------------------------------------------
    // wall: darker at the corners, lifting toward the middle where the big screen hangs
    const wall = ctx.createLinearGradient(0, 0, 0, 150);
    wall.addColorStop(0, '#080b14'); wall.addColorStop(0.55, '#0e1422'); wall.addColorStop(1, '#121a2b');
    ctx.fillStyle = wall; ctx.fillRect(0, 0, 480, 150);
    // floor: a gradient away from the wall, so the far edge reads as further away
    const flr = ctx.createLinearGradient(0, 150, 0, 262);
    flr.addColorStop(0, '#0c1017'); flr.addColorStop(1, '#070910');
    ctx.fillStyle = flr; ctx.fillRect(0, 150, 480, 112);
    px(ctx, 0, 149, 480, 1, '#243047'); px(ctx, 0, 150, 480, 1, '#161d2b');   // skirting
    // Perspective grid. The old one was a plain lattice, which read as graph paper; verticals now
    // converge on a vanishing point behind the wall screen and horizontals space out toward us.
    ctx.save(); ctx.globalAlpha = 0.5;
    const VPX = 240;
    for (let i = -10; i <= 10; i++) {
      const xTop = VPX + i * 13;
      ctx.strokeStyle = '#131a26'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(xTop, 150); ctx.lineTo(VPX + i * 46, 262); ctx.stroke();
    }
    for (let k = 1, y = 150; y < 262; k++) { y = 150 + Math.pow(k, 1.55) * 3.1; px(ctx, 0, y, 480, 0.5, '#141c29'); }
    ctx.restore();
    if (!S) { text(ctx, 'CONNECTING TO THE DESK', 240, 120, '#4b5563', 8, 'center'); return; }

    // The room is lit by its own screens: a wide cool pool from the wall display and two smaller
    // ones from the side boards. This is what stops the floor reading as a flat black rectangle.
    glow(ctx, 240, 78, 210, '#1b3a6b', 0.55);
    glow(ctx, 64, 105, 95, '#14304f', 0.30);
    glow(ctx, 421, 90, 95, '#123d2a', 0.30);

    // ---- everything below is the MAKER desk, because the maker desk is the one that trades ----
    // The boards used to show convergence pairs and convergence thresholds: the desk that measured
    // no edge and correctly does nothing. Reading them told you nothing about whether the machine
    // was working, which is the only question the floor should answer at a glance.
    const M = S.maker || {};
    const halted = S.halt || M.halted;
    // ---- status board (left) : the "is it working" answer, in words
    // The board is drawn here; its words are HTML laid over it (placeStatus), for the same reason
    // as the bubbles -- 5-unit canvas text was unreadable and its lines ran into each other.
    // It runs the full height of the wall now that the emblem is gone (the page header has the logo).
    panel(ctx, 8, 8, 112, 138, '#080c14', '#243047');
    scanlines(ctx, 9, 9, 110, 136, 0.10);
    statusBox = { x: 8, y: 8, w: 112, h: 138 };

    // ---- wall screen : the book, or whatever you clicked on
    // bezel, then glass. A single flat rect read as a hole in the wall; a lit top edge and a
    // shadowed bottom make it an object hanging on it.
    px(ctx, 134, 6, 212, 142, '#0a0e17');
    px(ctx, 134, 6, 212, 1, '#2c3a55'); px(ctx, 134, 147, 212, 1, '#04060a');
    px(ctx, 134, 6, 1, 142, '#222d42'); px(ctx, 345, 6, 1, 142, '#04060a');
    px(ctx, 140, 12, 200, 130, '#050810');
    const glass = ctx.createLinearGradient(0, 12, 0, 142);
    glass.addColorStop(0, 'rgba(70,120,190,0.10)'); glass.addColorStop(1, 'rgba(70,120,190,0.02)');
    ctx.fillStyle = glass; ctx.fillRect(140, 12, 200, 130);

    // The screen's words are HTML (placeBoards): the canvas draws only the glass and its light.
    if (sel && sel.kind === 'market' && !(M.markets || []).some((x) => x.ticker === sel.key)) sel = null;
    if (sel && sel.kind === 'agent' && !S.agents.some((x) => x.key === sel.key)) sel = null;
    wallBox = { x: 140, y: 12, w: 200, h: 130 };
    scanlines(ctx, 140, 12, 200, 130, 0.16);
    glow(ctx, 240, 30, 120, '#1e4e8a', 0.18);              // the screen lighting itself
    px(ctx, 238, 148, 6, 6, '#141b28'); px(ctx, 232, 152, 18, 2, '#0d1420');   // wall mount

    // ---- clock + the fill tape (right): boards drawn here, words laid over them (placeBoards)
    panel(ctx, 370, 8, 102, 24, '#080c14', '#243047');
    clockBox = { x: 370, y: 8, w: 102, h: 24 };
    panel(ctx, 370, 36, 102, 110, '#060f0a', '#1e4a2c');
    scanlines(ctx, 371, 37, 100, 108, 0.12);
    tapeBox = { x: 370, y: 36, w: 102, h: 110 };

    // desks + agents
    // advance the shared clock between SSE frames so the stagger animates smoothly
    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
    const labels = [];
    S.agents.forEach((a, i) => {
      if (!DESKS[i]) return;                 // more agents than seats: skip rather than throw
      const [x, y] = DESKS[i];
      const act = isActive(a);
      // the whole desk is the target, not just the blob -- a 14px character is not a click target
      hits.push({ x: x - 4, y: y - 18, w: 72, h: 60, kind: 'agent', key: a.key });
      const hot = (hover && hover.kind === 'agent' && hover.key === a.key);
      const picked = (sel && sel.kind === 'agent' && sel.key === a.key);
      if (hot || picked) {
        // a soft pool of the agent's own colour, so the highlight reads as light rather than a box
        ctx.save(); ctx.globalAlpha = picked ? 0.16 : 0.09; px(ctx, x - 4, y - 18, 72, 60, a.color); ctx.restore();
        if (picked) { px(ctx, x - 4, y - 18, 72, 1, a.color); px(ctx, x - 4, y + 41, 72, 1, a.color); }
      }
      // contact shadow first, so everything above it sits ON the floor rather than floating
      shadow(ctx, x + 2, y + 26, 60, 10, 0.45);
      // monitor: bezel, screen, and its own light thrown back onto the desk
      px(ctx, x + 12, y - 16, 40, 24, '#1a2029'); px(ctx, x + 12, y - 16, 40, 1, '#2f3a4c');
      px(ctx, x + 14, y - 14, 36, 20, '#04070c');
      const bars = 9;
      for (let j = 0; j < bars; j++) { const hgt = 3 + Math.round(hash(i, j, Math.floor(a.runs / 2)) * 12); px(ctx, x + 16 + j * 4, y + 4 - hgt, 3, hgt, act ? a.color : '#1e2836'); }
      scanlines(ctx, x + 14, y - 14, 36, 20, 0.22);
      if (act) glow(ctx, x + 32, y - 4, 30, a.color, 0.20);
      px(ctx, x + 30, y + 8, 4, 3, '#1a2029');
      if (act && Math.floor(t * 6) % 2) px(ctx, x + 47, y - 12, 2, 2, a.color);
      // Every animation means the desk's real job. They only light while that agent's
      // engine step is current, and KETT's order packet appears only for a real FILL.
      const latest = (S.log || []).find((e) => e.agent === a.key);
      const beat = (Math.sin(t * 7 + i * 1.7) + 1) / 2;
      if (act && a.key === 'HOLT') { // scanner sweep
        ctx.save(); ctx.strokeStyle = a.color; ctx.globalAlpha = 0.65; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x + 32, y - 8, 12, -Math.PI / 2, -Math.PI / 2 + beat * Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      if (act && a.key === 'ILSA') { // incoming-flow pulses
        for (let n = 0; n < 3; n++) { const r = 3 + ((beat * 12 + n * 4) % 12); ctx.save(); ctx.globalAlpha = 0.35 - n * 0.08; ctx.strokeStyle = a.color; ctx.beginPath(); ctx.arc(x + 32, y - 4, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
      }
      if (act && a.key === 'BRAM') { // pricing comparison running to the shared wall
        ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = a.color; ctx.setLineDash([2, 2]); ctx.lineDashOffset = -t * 12;
        ctx.beginPath(); ctx.moveTo(x + 32, y - 17); ctx.lineTo(238, 145); ctx.stroke(); ctx.restore();
      }
      if (act && a.key === 'KETT' && latest && latest.kind === 'FILL') { // confirmed order heads to the fill tape
        const run = (t * 2.5) % 1, ox = x + 32 + (421 - (x + 32)) * run, oy = y - 6 + (70 - (y - 6)) * run;
        px(ctx, ox - 1, oy - 1, 3, 3, latest.pnl != null && latest.pnl < 0 ? '#ef4444' : '#22c55e'); glow(ctx, ox, oy, 7, a.color, 0.7);
      }
      if (act && a.key === 'RIGO') { // settlement ledger strokes
        px(ctx, x + 17, y - 11, 8 + Math.round(beat * 8), 1, latest && latest.pnl < 0 ? '#ef4444' : '#22c55e');
        px(ctx, x + 17, y - 8, 14 - Math.round(beat * 5), 1, '#5b6270');
      }
      if (act && a.key === 'TESS') { // the risk beacon always has a state
        const risk = halted ? '#ef4444' : '#ec4899'; px(ctx, x + 4, y + 3, 3, 3, risk); glow(ctx, x + 5, y + 4, 8, risk, 0.5 + beat * 0.3);
      }
      if (act && a.key === 'MAKR') { // two-sided maker quotes blink independently
        px(ctx, x + 18, y - 12, 4, 2, '#22c55e'); px(ctx, x + 42, y - 12, 4, 2, '#ef4444');
        if (Math.floor(t * 5) % 2) px(ctx, x + 26, y - 10, 12, 1, '#a855f7');
      }
      // desk: lit top edge, dark front face, legs
      px(ctx, x, y + 11, 64, 9, '#33291d'); px(ctx, x, y + 11, 64, 1, '#6b5942'); px(ctx, x, y + 19, 64, 1, '#1b150e');
      px(ctx, x + 2, y + 20, 4, 8, '#221b13'); px(ctx, x + 58, y + 20, 4, 8, '#221b13');
      px(ctx, x + 24, y + 30, 16, 5, '#12151b'); px(ctx, x + 22, y + 24, 20, 6, '#1a1e27'); px(ctx, x + 22, y + 24, 20, 1, '#28303d');
      // blob agent (sits in front of the desk, bobs when active)
      const bob = act ? Math.round(Math.sin(t * 9 + i) * 1.5) : 0;
      const bx = x + 32, by = y + 22 + bob;
      shadow(ctx, bx - 7, by + 3, 14, 5, 0.35);
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.roundRect(bx - 7, by - 8, 14, 13, [6, 6, 5, 5]); ctx.fill();
      ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';   // rim light off the screens
      ctx.beginPath(); ctx.roundRect(bx - 7, by - 8, 14, 4, [6, 6, 0, 0]); ctx.fill(); ctx.restore();
      if (act) glow(ctx, bx, by - 2, 16, a.color, 0.22);
      const blink = Math.floor(t * 1.3 + i * 0.7) % 6 === 0 && ((t * 1.3 + i * 0.7) % 1) < 0.18;
      if (blink) { px(ctx, bx - 4, by - 3, 3, 1, '#fff'); px(ctx, bx + 1, by - 3, 3, 1, '#fff'); }
      else { px(ctx, bx - 4, by - 4, 3, 3, '#fff'); px(ctx, bx + 1, by - 4, 3, 3, '#fff'); px(ctx, bx - 3, by - 3, 1, 1, '#111'); px(ctx, bx + 2, by - 3, 1, 1, '#111'); }
      // where this agent's name and speech bubble go; placeFx lays them over the room as HTML
      labels.push({ key: a.key, bx, by, deskY: y, back: i < 3, color: a.color, act, lit: hot || picked, note: a.note });
    });
    // furniture
    shadow(ctx, 438, 216, 30, 10, 0.5);
    px(ctx, 440, 162, 26, 60, '#0f131b'); px(ctx, 440, 162, 26, 1, '#2a3446'); px(ctx, 440, 162, 1, 60, '#1e2635');
    for (let i = 0; i < 6; i++) { px(ctx, 443, 166 + i * 9, 20, 6, '#06090e'); const on = (Math.floor(t * 4) + i) % 3; px(ctx, 459, 168 + i * 9, 2, 2, on ? '#22c55e' : '#0f3a1f'); if (on) glow(ctx, 460, 169 + i * 9, 5, '#22c55e', 0.5); }

    // Names and speech bubbles are no longer painted into the canvas. At 6 drawing units they came
    // out around 9px on a laptop and could not be read from a chair. They are HTML now (placeFx),
    // laid over the room at real font sizes and positioned from these same desk coordinates.
    seats = labels;

    // vignette: pulls the eye to the middle of the board and hides the hard canvas corners
    ctx.save();
    const vig = ctx.createRadialGradient(240, 130, 90, 240, 130, 320);
    vig.addColorStop(0, 'transparent'); vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig; ctx.fillRect(0, 0, 480, ROOM_H);
    ctx.restore();

    // P&L board, standing on the floor left of the desks (after the vignette, which would bury it)
    panel(ctx, 4, 153, 124, 105, '#080c14', '#243047');
    drawPnl(ctx, 8, 158, 118, 96);

    // a dead feed greys the room out entirely: no chance of reading a frozen board as a live one
    if (stale()) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, 480, ROOM_H); ctx.restore();
      px(ctx, 150, 122, 180, 16, '#1a0d0f'); px(ctx, 150, 122, 180, 1, '#ef4444');
      text(ctx, 'NO SIGNAL FROM THE DESK', 240, 126, '#f87171', 7, 'center');
      text(ctx, 'this page is showing the last state it received', 240, 133, '#7f1d1d', 5, 'center');
    }
  }

  // REALISED is profit from round trips that actually closed. NET is that plus the mark on whatever
  // is still open. The earlier version charted CASH and called it banked, which was wrong: cash
  // falls when we buy and rises when we sell, so a net-short book shows a big positive balance that
  // is only proceeds from contracts still owed. It read as +$51 of earnings on a book that had
  // earned nothing.
  function drawPnl(ctx, x, y, w, h) {
    const H = (S.maker && S.maker.hist) || [];
    text(ctx, 'P&L', x + 4, y, '#7c869a', 6);
    if (H.length < 2) {
      chartBox = null;
      text(ctx, H.length ? 'collecting — one point a minute' : 'no history yet', x + w / 2, y + h / 2 - 4, '#243044', 5, 'center');
      return;
    }
    const t0 = H[0].t, t1 = Math.max(H[H.length - 1].t, t0 + 1);
    // Scale to NET alone. Banked cash is an order of magnitude larger and only ever climbs, so
    // sharing an axis with it flattened the one line worth reading into a wobble along the bottom.
    // It stays on the chart as a faint reference, clipped where it runs off, and as a number below.
    const vals = H.map((p) => p.e).concat([0]);
    let lo = Math.min(...vals), hi = Math.max(...vals);
    const pad = Math.max(0.5, (hi - lo) * 0.15); lo -= pad; hi += pad;
    const L = x + 22, R = x + w - 6, T = y + 8, B = y + h - 8;
    const px_ = (t) => L + (R - L) * ((t - t0) / (t1 - t0));
    const py_ = (v) => B - (B - T) * ((v - lo) / (hi - lo));
    chartBox = { left: L, right: R, top: T, bottom: B, history: H, xFor: px_ };

    // zero line: the break-even the whole thing is measured against
    const zy = py_(0);
    ctx.save(); ctx.setLineDash([2, 2]); ctx.strokeStyle = '#1f2937'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(L, zy); ctx.lineTo(R, zy); ctx.stroke(); ctx.restore();
    text(ctx, '0', L - 3, zy - 2.5, '#39404e', 5.5, 'right');
    text(ctx, signed(hi), L - 3, T - 1, '#39404e', 5.5, 'right');
    text(ctx, signed(lo), L - 3, B - 4, '#39404e', 5.5, 'right');

    const line = (key, col, width, fill) => {
      ctx.save(); ctx.beginPath();
      H.forEach((p, i) => { const X = px_(p.t), Y = py_(p[key]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      if (fill) {
        const last = H[H.length - 1];
        ctx.lineTo(px_(last.t), zy); ctx.lineTo(px_(H[0].t), zy); ctx.closePath();
        const grad = ctx.createLinearGradient(0, T, 0, B);
        grad.addColorStop(0, fill); grad.addColorStop(1, 'transparent');
        ctx.globalAlpha = 0.30; ctx.fillStyle = grad; ctx.fill(); ctx.globalAlpha = 1;
        ctx.beginPath();
        H.forEach((p, i) => { const X = px_(p.t), Y = py_(p[key]); i ? ctx.lineTo(X, Y) : ctx.moveTo(X, Y); });
      }
      ctx.strokeStyle = col; ctx.lineWidth = width; ctx.lineJoin = 'round'; ctx.stroke(); ctx.restore();
    };
    const now = H[H.length - 1];
    // NET only. The second series is not drawn: points recorded before the realised-P&L correction
    // stored CASH in that same field, so the line steps between two different quantities partway
    // along and means nothing across the join. Net is correct for every point ever recorded.
    line('e', now.e >= 0 ? '#22c55e' : '#ef4444', 1, now.e >= 0 ? '#22c55e' : '#ef4444');

    // where it stands right now
    const nx = px_(now.t), ny = py_(now.e);
    px(ctx, nx - 1, ny - 1, 2.5, 2.5, now.e >= 0 ? '#4ade80' : '#f87171');
    glow(ctx, nx, ny, 8, now.e >= 0 ? '#22c55e' : '#ef4444', 0.5);

    // A chart should answer "what happened here?", not merely decorate the room.
    // Hover previews a point; clicking pins it so live updates do not move the comparison away.
    const focusT = chartPinnedT || chartHoverT;
    if (focusT != null) {
      const focus = H.reduce((best, point) => Math.abs(point.t - focusT) < Math.abs(best.t - focusT) ? point : best, H[0]);
      const fx = px_(focus.t), fy = py_(focus.e), pin = chartPinnedT != null;
      ctx.save(); ctx.setLineDash([1, 2]); ctx.strokeStyle = pin ? '#5ec8e0' : '#737a88'; ctx.lineWidth = 0.7;
      ctx.beginPath(); ctx.moveTo(fx, T); ctx.lineTo(fx, B); ctx.stroke(); ctx.restore();
      px(ctx, fx - 2, fy - 2, 4, 4, pin ? '#5ec8e0' : (focus.e >= 0 ? '#4ade80' : '#f87171'));
      const label = `${new Date(focus.t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}  ${signed(focus.e)}`;
      ctx.font = '5px JetBrains Mono, monospace'; const lw = Math.ceil(ctx.measureText(label).width) + 8;
      const lx = Math.min(Math.max(fx - lw / 2, L), R - lw), ly = T + 2;
      px(ctx, lx, ly, lw, 9, '#0d1119'); px(ctx, lx, ly, lw, 1, pin ? '#5ec8e0' : '#434d5b');
      text(ctx, label, lx + 4, ly + 2, pin ? '#93dcec' : '#c3c9d6', 5);
    }

    const mins = Math.round((t1 - t0) / 60000);
    text(ctx, mins < 90 ? `last ${mins}m` : `last ${(mins / 60).toFixed(1)}h`, x + 22, y + h - 4, '#39404e', 5.5);
    text(ctx, 'NET', x + w - 34, y, now.e >= 0 ? '#22c55e' : '#ef4444', 5.5, 'right');
    text(ctx, signed(now.e), x + w - 6, y, now.e >= 0 ? '#22c55e' : '#ef4444', 6.5, 'right');
    // one row under the chart, now that the board is narrow: the span on the left, banked on the right
    text(ctx, `realised ${signed((S.maker && S.maker.realized) || 0)}`, x + w - 6, y + h - 4, '#3f8a5a', 5.5, 'right');
  }

  // ------------------------------------------------------------ notices: what the desk is doing, in words
  // The bots move when their desk runs; these say WHY, in sentences a person can read from a chair.
  // Everything here is HTML laid over the canvas: bubbles above the bots, the feed on the ledge, and
  // the alert in the floor's title bar. Positions come from the same drawing coordinates as the art.
  let seats = [], statusBox = null, wallBox = null, tapeBox = null, clockBox = null;
  let frameSeq = 0;           // bumps on every SSE frame, so the boards rebuild only when data moves
  let seenKeys = null, feedHead = '';
  const said = {};        // agent -> { text, sub, level, until }   the bubble currently showing
  const lastSaid = {};    // agent -> the last sentence it said, numbers blanked, so repeats stay quiet
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  const cap = (s) => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
  const cc = (p) => `${+(p * 100).toFixed(1)}¢`;
  const move = (s) => `${s.replace('-', '−').replace(/\.0$/, '')}¢`;
  const marketName = (tk) => { const m = byTicker(S.maker || {}, tk); return (m && (OUTCOME(m) || QUESTION(m))) || tk.replace(/^KX/, ''); };

  // One log entry -> { text, sub, level }. level: trade (money moved), warn (needs a look),
  // info (a decision worth knowing), quiet (routine: the desk doing its rounds).
  function say(e) {
    const t = String(e.text || ''), parts = t.split(' · '), first = parts[0], rest = parts.slice(1).join(' · ');
    switch (`${e.agent} ${e.kind}`) {
      case 'MAKR FILL': {
        const fills = ((S.maker || {}).recent || []).filter((f) => Math.abs(f.at - e.t) < 5000);
        if (!fills.length) return { text: cap(first), level: 'trade' };
        const g = [];
        for (const f of fills) {
          const x = g.find((y) => y.ticker === f.ticker && y.side === f.side);
          if (x) { x.qty += f.qty; x.val += f.qty * f.px; } else g.push({ ticker: f.ticker, side: f.side, qty: f.qty, val: f.qty * f.px });
        }
        // the outcome alone ("J.D. Vance") does not say which market; the question goes underneath
        const m = byTicker(S.maker || {}, g[0].ticker);
        return { text: cap(g.map((x) => `${x.side === 'buy' ? 'bought' : 'sold'} ${x.qty} ${marketName(x.ticker)} at ${cc(x.val / x.qty)}`).join(', ')),
          sub: m && OUTCOME(m) ? QUESTION(m) : '', level: 'trade' };
      }
      case 'RIGO SETTLE': {
        const i = t.indexOf(' · sold '), label = i > 0 ? t.slice(0, i) : first;
        const pl = e.pnl == null ? '' : `, ${e.pnl >= 0 ? 'made' : 'lost'} ${money(e.pnl)}`;
        return { text: `Closed ${label}${pl}`, sub: parts[parts.length - 1], level: 'trade' };
      }
      case 'HOLT SCAN': {
        const m = t.match(/\+\d+ new: (.+)$/), n = (t.match(/^(\d+) pairs/) || [])[1];
        return m ? { text: `Found a new market on both venues: ${m[1]}`, level: 'info' }
          : { text: `Watching ${n || 'the'} markets listed on both venues`, level: 'quiet' };
      }
      case 'ILSA RESEARCH': {
        const m = t.match(/^(.+?): PM ([−+-]?[\d.]+)c, KS ([−+-]?[\d.]+)c over \S+ · gap ([\d.]+)c (\w+)/);
        if (m) return { text: `${m[1]}: price moved ${move(m[2])} on Polymarket, ${move(m[3])} on Kalshi`, sub: `venues ${+m[4]}¢ apart, ${m[5]}`, level: 'quiet' };
        break;
      }
      case 'BRAM RESEARCH': {
        const n = (t.match(/over (\d+) pairs/) || [])[1], sig = (S.signals || []).length;
        if (n) return { text: sig ? `Checked ${n} pairs: ${sig} worth a closer look` : `Checked ${n} pairs: no price gap big enough to trade`, level: sig ? 'info' : 'quiet' };
        break;
      }
      case 'KETT PASS': {
        const m = t.match(/^(.+?): (.+)$/);
        return m ? { text: `Passed on ${m[1]}`, sub: m[2], level: 'info' } : { text: cap(t), level: 'info' };
      }
      case 'TESS OPS': {
        if (/^HALT\b/.test(first)) return { text: 'Trading stopped', sub: rest, level: 'warn' };
        if (/window is clean/.test(t)) { const d = (t.match(/day ([−+-]?[\d.]+%)/) || [])[1]; return { text: `All clear: prices are fresh${d ? `, account ${d} today` : ''}`, level: 'quiet' }; }
        return { text: cap(first), sub: rest, level: 'warn' };
      }
      case 'MAKR OPS': return { text: cap(first), sub: rest, level: /stale|fail|error|halt|stop/i.test(t) ? 'warn' : 'info' };
      case 'MAKR RESEARCH': {
        const m = t.match(/book: (\d+) contracts.*marked \$([\d.]+) from \$([\d.]+)/);
        if (m) { const net = +m[2] - +m[3]; return { text: `Holding ${m[1]} contracts, ${net >= 0 ? 'up' : 'down'} ${money(net)} if closed now`, level: 'quiet' }; }
        break;
      }
      case 'MAKR SCAN': {
        const m = t.match(/quoting (\d+) of/);
        if (m) return { text: `Offering to buy and sell in ${m[1]} markets`, level: 'quiet' };
        break;
      }
      case 'RIGO RESEARCH': {
        const m = t.match(/(\d+) open/), al = +((t.match(/(\d+) integrity alert/) || [])[1] || 0);
        if (m) return { text: `Checked ${m[1]} open positions${al ? `: ${al} broken arb${al > 1 ? 's' : ''}` : ', all fine'}`, level: 'quiet' };
        break;
      }
    }
    if (e.kind === 'HALT') return { text: `Stopped: ${first}`, sub: rest, level: 'warn' };
    if (e.kind === 'FILL' || e.kind === 'SETTLE') return { text: cap(first), sub: rest, level: 'trade' };
    return { text: cap(first), sub: rest, level: 'info' };
  }

  // What needs a person: a halt, or an arb that is not actually hedged.
  function alerts() {
    const out = [];
    if (S.halt) out.push({ agent: 'TESS', text: `Trading stopped: ${S.halt}` });
    for (const g of S.arbGroups || []) {
      if (g.integrity === 'valid') continue;
      const why = g.integrity === 'orphan_leg' ? 'only one side filled, nothing hedges it' : String(g.integrity).replace(/_/g, ' ');
      out.push({ agent: 'RIGO', group: g.id, text: `Broken arb: ${g.label}`, sub: `${why} · ${signed(g.liquidationPnl)} if sold now` });
    }
    // "Keep until it settles" is a decision, not a fix: the alert stays true, it just stops shouting
    return out.map((a) => ({ ...a, kept: !!(a.group && kept.has(a.group)) }));
  }

  // Called on every SSE frame: new log lines become bubbles; the feed is rebuilt when the log moves.
  function ingest() {
    const log = S.log || [];
    const keys = new Set(log.map(logKey));
    if (seenKeys) {
      const fresh = log.filter((e) => !seenKeys.has(logKey(e))).reverse();   // oldest first
      for (const e of fresh) {
        const s = say(e), cur = said[e.agent], loud = s.level !== 'quiet';
        if (!loud && shape(s.text) === lastSaid[e.agent]) continue;          // same routine line again
        if (!loud && cur && cur.level !== 'quiet' && cur.until > Date.now()) continue;   // don't talk over a trade
        said[e.agent] = { ...s, until: Date.now() + (loud ? 10000 : 6000) };
        lastSaid[e.agent] = shape(s.text);
      }
    }
    seenKeys = keys;

    const head = log.length ? logKey(log[0]) : '';
    if (head !== feedHead) { feedHead = head; renderFeed(log); }
    const al = alerts(), loud = al.filter((a) => !a.kept);
    const fm = $('floor-meta');
    if (!al.length) { fm.className = ''; fm.innerHTML = ''; fm.onclick = null; }
    else {
      const top = loud[0] || al[0];
      fm.className = loud.length ? 'alert' : 'alert kept';
      fm.innerHTML = loud.length
        ? `⚠ ${esc(top.text)} <small>${esc(top.sub || '')}</small>${loud.length > 1 ? ` <small>+${loud.length - 1} more</small>` : ''} <b class="open">Decide ›</b>`
        : `✓ Holding to settlement: ${esc(top.text.replace(/^Broken arb: /, ''))} <b class="open">Open ›</b>`;
      fm.onclick = () => openAlert(top);
    }
    if (panelFor) renderPanel();
  }

  // ------------------------------------------------------------ the alert panel: research, sell, keep
  // An alert used to be a line of red text with nothing to do about it. This is the decision:
  // research what happened, sell the position, or hold it to settlement on purpose.
  const kept = new Set((() => { try { return JSON.parse(localStorage.getItem('hex-kept') || '[]'); } catch { return []; } })());
  const saveKept = () => { try { localStorage.setItem('hex-kept', JSON.stringify([...kept])); } catch { /* private window */ } };
  let panelFor = null;          // the alert the panel is showing
  let confirming = false, sellMsg = null, researchMsg = null, busy = false;

  function openAlert(a) {
    panelFor = a; confirming = false; sellMsg = null; researchMsg = null;
    $('alertpanel').hidden = false;
    renderPanel();
  }
  function closeAlert() { panelFor = null; $('alertpanel').hidden = true; }
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape' && panelFor) closeAlert(); });

  async function act(group, action) {
    try {
      const r = await fetch(`/api/alerts/${encodeURIComponent(group)}/${action}`, { method: 'POST', headers: { 'x-hexagon-action': '1' } });
      const text = await r.text();
      if (r.status === 404) return { ok: false, error: 'The desk is running older code. Restart it to use this button.' };
      let body; try { body = JSON.parse(text); } catch { body = { ok: false, error: text }; }
      return r.ok ? body : { ok: false, error: body.error || text };
    } catch (e) { return { ok: false, error: `Could not reach the desk (${e.message})` }; }
  }

  const venueName = (v) => (v === 'KS' ? 'Kalshi' : 'Polymarket');
  const usd = (v) => (v == null || !Number.isFinite(+v) ? '—' : signed(+v));

  function renderPanel() {
    const a = panelFor, el = $('alertpanel');
    if (!a || !S) return;
    // the alert may have cleared since the panel opened (sold, settled)
    const g = a.group ? (S.arbGroups || []).find((x) => x.id === a.group) : null;
    const legs = a.group ? (S.positions || []).filter((p) => p.group === a.group) : [];
    const gone = a.group && !legs.length;
    const job = a.group && S.research && S.research.jobs ? S.research.jobs[a.group] : null;

    let h = `<button class="x" data-do="close" aria-label="Close">✕</button>`;
    h += `<div class="ah">${gone ? '✓ Resolved' : a.kept ? '✓ Holding to settlement' : '⚠ Needs a decision'}</div>`;
    h += `<h3>${esc(g ? g.label : a.text)}</h3>`;
    if (!a.group) { el.innerHTML = h + `<p>${esc(a.sub || a.text)}</p>`; return; }
    if (gone) { el.innerHTML = h + `<p>Nothing is open in this position any more.</p>${sellMsg ? `<p class="ok">${esc(sellMsg)}</p>` : ''}`; return; }

    const proceeds = legs.reduce((s2, p) => s2 + p.qty * p.sellPx, 0);
    const cost = legs.reduce((s2, p) => s2 + p.cost, 0);
    h += `<p class="why">${esc(a.sub ? cap(a.sub.split(' · ')[0]) : '')}.</p>`;
    h += `<ul class="legs">${legs.map((p) => `<li><b>${p.qty} ${p.side.toUpperCase()}</b> on ${venueName(p.venue)} · paid ${money(p.cost)} · sells for ${cc(p.sellPx)} now (${money(p.qty * p.sellPx)})</li>`).join('')}</ul>`;
    h += `<p class="sum">Sell now and you get <b>${money(proceeds)}</b>, locking in <b class="${proceeds - cost >= 0 ? 'pos' : 'neg'}">${signed(proceeds - cost)}</b>.</p>`;

    // actions
    if (confirming) {
      h += `<div class="confirm"><p>Sell ${legs.map((p) => `${p.qty} ${p.side.toUpperCase()} on ${venueName(p.venue)} at ${cc(p.sellPx)}`).join(' and ')}? You'd receive ${money(proceeds)} and lock in ${signed(proceeds - cost)}.${S.mode === 'live' ? ' <b>This is real money.</b>' : ' Paper account.'}</p>
        <button class="danger" data-do="sell-yes" ${busy ? 'disabled' : ''}>${busy ? 'Selling…' : 'Yes, sell it'}</button><button data-do="sell-no">Cancel</button></div>`;
    } else {
      const running = job && job.status === 'running';
      h += `<div class="acts">
        <button class="primary" data-do="research" ${running || !(S.research && S.research.enabled) ? 'disabled' : ''}>${running ? 'Researching…' : job && job.status === 'done' ? 'Research again' : 'Research'}</button>
        <button class="danger" data-do="sell">Sell now</button>
        <button data-do="keep">${a.kept ? 'Stop holding (alert me again)' : 'Keep until it settles'}</button></div>`;
    }
    if (sellMsg) h += `<p class="${/^Sold/.test(sellMsg) ? 'ok' : 'err'}">${esc(sellMsg)}</p>`;

    // research: a verdict and one sentence
    h += `<div class="research">`;
    if (researchMsg) h += `<p class="err">${esc(researchMsg)}</p>`;
    if (!job) {
      h += S.research && S.research.enabled
        ? `<p class="hint">Research gives a quick verdict (sell, hold or hedge) in about 20 seconds.</p>`
        : `<p class="hint">Research needs ANTHROPIC_API_KEY in .env${S.research ? '' : ' and a desk restart'}.</p>`;
    } else if (job.status === 'running') {
      h += `<p class="hint"><span class="spin"></span> Researching… ${Math.round((S.now - job.startedAt) / 1000)}s</p>`;
    } else if (job.status === 'error') {
      h += `<p class="err">Research failed: ${esc(job.error)}</p>`;
    } else if (job.result) {
      const r = job.result;
      h += `<div class="verdict v-${esc(r.action || 'none')}"><b>${esc((r.action || 'no clear call').toUpperCase())}</b>${r.confidence ? `<span class="conf">${esc(r.confidence)} confidence</span>` : ''}<p>${esc(r.sentence || '')}</p></div>`;
      const took = job.finishedAt && job.startedAt ? `${Math.round((job.finishedAt - job.startedAt) / 1000)}s` : '';
      h += `<p class="cost">${took} · $${(job.usd || 0).toFixed(2)} · ${ago(job.finishedAt)}${job.sources && job.sources.length ? ` · <a href="${esc(job.sources[0].url)}" target="_blank" rel="noopener noreferrer">source</a>` : ''}</p>`;
    }
    h += `</div>`;
    const scroll2 = el.scrollTop;
    el.innerHTML = h;
    el.scrollTop = scroll2;
  }

  $('alertpanel').addEventListener('click', async (ev) => {
    const b = ev.target.closest('button[data-do]');
    if (!b || !panelFor) return;
    const a = panelFor, what = b.dataset.do;
    if (what === 'close') return closeAlert();
    if (what === 'keep') {
      if (kept.has(a.group)) kept.delete(a.group); else kept.add(a.group);
      saveKept(); a.kept = kept.has(a.group);
      if (a.kept) closeAlert(); else renderPanel();
      return;
    }
    if (what === 'sell') { confirming = true; sellMsg = null; return renderPanel(); }
    if (what === 'sell-no') { confirming = false; return renderPanel(); }
    if (what === 'sell-yes') {
      busy = true; renderPanel();
      const r = await act(a.group, 'sell');
      busy = false; confirming = false;
      sellMsg = r.ok ? 'Sold. The position is closed.' : r.remaining ? `Only part of it sold; the desk will keep retrying the rest.` : `Not sold: ${r.error || 'unknown error'}`;
      if (r.ok) { kept.delete(a.group); saveKept(); }
      return renderPanel();
    }
    if (what === 'research') {
      researchMsg = null; b.disabled = true;
      const r = await act(a.group, 'research');
      if (!r.ok) researchMsg = r.error || 'Research did not start';
      return renderPanel();
    }
  });

  function renderFeed(log) {
    const rows = [], last = {};
    for (const e of log) {
      const s = say(e), k = shape(s.text);
      if (last[e.agent] === k) continue;           // collapse the same routine line said every cycle
      last[e.agent] = k;
      rows.push({ e, s });
      if (rows.length >= 40) break;
    }
    const list = $('feedlist'), top = list.scrollTop;
    list.innerHTML = rows.map(({ e, s }) => {
      const pl = e.kind === 'SETTLE' && e.pnl != null ? `<span class="fp ${e.pnl >= 0 ? 'pos' : 'neg'}">${signed(e.pnl)}</span>` : '';
      return `<li class="lv-${s.level}"><span class="ft">${hhmm(e.t)}</span><span class="fa" style="color:${agentColor(e.agent)}">${e.agent}</span>` +
        `<span class="fs">${esc(s.text)}${s.sub && s.level !== 'quiet' ? `<small>${esc(s.sub)}</small>` : ''}</span>${pl}</li>`;
    }).join('') || '<li class="lv-quiet"><span class="fs">Waiting for the first desk cycle</span></li>';
    list.scrollTop = top;
  }

  // Every animation frame: put the names, bubbles and feed where the room currently is on screen.
  const nodes = {};
  function placeFx() {
    const fx = $('fx');
    if (!S || !seats.length) return;
    const k = floorBox.scale, X = (x) => floorBox.ox + x * k, Y = (y) => floorBox.oy + y * k;
    const fs = Math.max(11, Math.min(15, k * 5.4));
    fx.style.fontSize = `${fs}px`;
    fx.classList.toggle('stale', !!stale());
    placeStatus(X, Y, k);
    placeBoards(X, Y, k);

    const now = Date.now(), al = alerts();
    for (const st of seats) {
      let n = nodes[st.key];
      if (!n) {
        n = nodes[st.key] = { name: document.createElement('div'), bub: document.createElement('div'), html: '' };
        n.name.className = 'nametag'; n.name.textContent = st.key;
        $('bubbles').append(n.name, n.bub);
      }
      // name: under the bot in the front row; on the wall below the screen for the back row
      Object.assign(n.name.style, { left: `${X(st.bx)}px`, top: `${Y(st.back ? st.deskY - 7 : st.deskY + 35)}px`, color: st.lit || st.act ? st.color : '' });
      n.name.classList.toggle('on', st.act || st.lit);

      // what to say: a fresh event beats a standing alert beats the desk's own running note
      const ev = said[st.key] && said[st.key].until > now ? said[st.key] : null;
      const alarm = al.find((a) => a.agent === st.key && !a.kept);
      // the standing alert stays short here -- it hangs over the wall screen, and the title bar has the detail
      const b = ev || (alarm && { text: ((n) => `⚠ ${n} problem${n > 1 ? 's' : ''}`)(al.filter((a) => a.agent === st.key && !a.kept).length), level: 'warn' })
        || (st.act && st.note ? { text: cap(st.note), level: 'quiet' } : null);
      if (!b) { n.bub.hidden = true; continue; }
      const html = `${esc(b.text)}${b.sub && b.level !== 'quiet' ? `<small>${esc(b.sub)}</small>` : ''}`;
      // Back row speaks upward, over the bottom of the wall screen. The front row cannot -- the back
      // row's bots sit right above its monitors -- so it speaks sideways, across its own desk.
      const maxw = Math.max(150, Math.min(260, (st.back ? 96 : 70) * k));
      const flip = !st.back && X(480) - X(st.bx + 10) < maxw;
      const cls = `bub lv-${b.level} ${st.back ? 'up' : flip ? 'side flip' : 'side'}`;
      if (html !== n.html || n.cls !== cls) {
        n.bub.innerHTML = html; n.cls = cls;
        n.bub.className = cls;
        if (ev && html !== n.html) { void n.bub.offsetWidth; n.bub.classList.add('pop'); }   // restart the pop animation
        n.html = html;
      }
      n.bub.hidden = false;
      n.bub.style.setProperty('--c', st.color);
      n.bub.style.maxWidth = `${maxw}px`;
      if (st.back) Object.assign(n.bub.style, { left: `${X(st.bx)}px`, right: '', top: `${Y(st.deskY - 19)}px` });
      else if (flip) Object.assign(n.bub.style, { left: '', right: `${fx.clientWidth - X(st.bx - 10)}px`, top: `${Y(st.deskY + 6)}px` });
      else Object.assign(n.bub.style, { left: `${X(st.bx + 10)}px`, right: '', top: `${Y(st.deskY + 6)}px` });
    }
  }

  // The status board on the left wall: is it working, what is it doing, what did it last trade.
  let statusHtml = '';
  function placeStatus(X, Y, k) {
    if (!statusBox) return;
    const el = $('status'), M = S.maker || {};
    Object.assign(el.style, { left: `${X(statusBox.x)}px`, top: `${Y(statusBox.y)}px`, width: `${statusBox.w * k}px`, height: `${statusBox.h * k}px`,
      fontSize: `${Math.max(10, Math.min(17, k * 5.6))}px` });
    // on a small window the board cannot hold every line; keep state, what it is doing, and the last fill
    el.classList.toggle('compact', statusBox.h * k < 150);
    const halted = S.halt || M.halted, working = !halted && M.quoting > 0, gone = stale();
    const [state, cls] = gone ? ['No signal', 'bad'] : halted ? ['Stopped', 'bad'] : working ? ['Working', 'good'] : ['Idle', 'warn'];
    const latest = (S.log || [])[0];
    const now = gone ? 'The desk stopped answering' : halted ? `Trading stopped: ${halted}` : latest ? say(latest).text : 'Waiting for the first desk cycle';
    const nHeld = (M.markets || []).filter((m) => m.inv).length;
    const lf = M.lastFill;
    // the ledger survives a restart but the last-fill detail does not; say which
    const fill = lf ? `Last fill ${ago(lf.at)}: ${lf.side === 'buy' ? 'bought' : 'sold'} ${lf.qty} ${marketName(lf.ticker)} at ${cc(lf.px)}`
      : M.fills ? `${M.fills} fills before the last restart` : 'No fills yet';
    const feed = M.feed || {};
    const html = `<div class="st ${cls}"><i></i>${state}</div>` +
      `<p class="now">${esc(now)}</p>` +
      `<p class="extra">${working ? `Quoting ${M.quoting} markets` : 'Not quoting'} · ${nHeld ? `holding ${M.inv} contracts in ${nHeld}` : 'nothing held'}</p>` +
      `<p>${esc(fill)}</p>` +
      `<p class="dim">${S.mode === 'live' ? 'LIVE · real money' : 'Paper · no real money'} · up ${dur(S.now - S.startedAt)} · ${feed.mode === 'stream' && feed.connected ? 'live trade feed' : 'polling for trades'}</p>`;
    if (html !== statusHtml) { el.innerHTML = html; statusHtml = html; }
  }

  // ------------------------------------------------------------ the wall screen, the fills board, the clock
  // The wall screen answers one question at a glance -- how is the maker desk doing -- and shows the
  // few positions worth watching. Everything else is one click away: a position or a bot opens its
  // own view here, and clicking it again (or Back, or Escape) returns. It used to show three
  // numbers, every open position with a subtitle, and every quoted market, all in 5-unit text.
  const WALL_ROWS = 5;
  let wallKey = '', tapeKey = '', clockTxt = '', wallAll = false;
  const sideTag = (inv) => `<span class="sd ${inv > 0 ? 'long' : 'short'}">${inv > 0 ? 'LONG' : 'SHORT'} ${Math.abs(inv)}</span>`;

  function wallHome(M) {
    const net = (M.equity ?? M.initial ?? 0) - (M.initial ?? 0);
    const held = (M.markets || []).filter((m) => m.inv)
      .map((m) => ({ m, pl: m.mark - m.cost }))
      .sort((a, b) => Math.abs(b.pl) - Math.abs(a.pl) || Math.abs(b.m.inv) - Math.abs(a.m.inv));
    const rows = wallAll ? held : held.slice(0, WALL_ROWS);
    let h = `<div class="wh"><span>Maker desk</span><span>${M.fills || 0} fills</span></div>`;
    h += `<div class="wbig ${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</div>`;
    h += `<div class="wsub">if everything closed now · banked ${signed(M.realized || 0)} · holding ${M.inv || 0} contracts</div>`;
    if (!held.length) h += `<p class="wempty">Nothing held. Quoting ${M.quoting || 0} markets and waiting to be traded against.</p>`;
    else {
      h += `<div class="wlist${wallAll ? ' all' : ''}">${rows.map(({ m, pl }) => `<button class="wr" data-m="${esc(m.ticker)}" title="${esc(m.title || '')}">` +
        `<span class="nm">${esc(OUTCOME(m) || QUESTION(m))}${OUTCOME(m) && QUESTION(m) ? `<i> · ${esc(QUESTION(m))}</i>` : ''}</span>${sideTag(m.inv)}<span class="pl ${pl >= 0 ? 'pos' : 'neg'}">${signed(pl)}</span></button>`).join('')}</div>`;
      h += held.length > WALL_ROWS
        ? `<button class="wmore" data-all="1">${wallAll ? 'Show fewer' : `Biggest ${WALL_ROWS} of ${held.length} positions · show all`}</button>`
        : `<div class="wfoot">${held.length} position${held.length === 1 ? '' : 's'} · click one for details</div>`;
    }
    return h;
  }

  function wallMarket(m, M) {
    let read, tone = '';
    if (!m.quoting && m.inv) { read = 'Dropped from the book. Only quoting the side that works this position off.'; tone = 'warn'; }
    else if (!m.inv) read = 'Nothing held here. Both quotes are resting, waiting to be traded against.';
    else if (Math.abs(m.inv) > 60) { read = `${m.inv > 0 ? 'Long' : 'Short'} ${Math.abs(m.inv)}, close to the ${M.cap || 100}-contract limit. The flow has been one-sided.`; tone = 'bad'; }
    else if (m.qAsk > 5000 || m.qBid > 5000) read = 'A long line of orders sits ahead of ours, so fills here come slowly.';
    else read = 'Working normally: a small position and a short line ahead of us.';
    const pl = m.inv ? m.mark - m.cost : null;
    const clears = m.clear == null ? '—' : m.clear < 1 ? `${(m.clear * 24).toFixed(1)} hours` : `${m.clear.toFixed(1)} days`;
    return `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span>${esc(m.ticker.replace(/^KX/, ''))}</span></div>` +
      `<div class="wtitle">${esc(OUTCOME(m) || QUESTION(m))}</div><div class="wq">${esc(m.title || QUESTION(m))}</div>` +
      `<dl class="wfacts">` +
      `<dt>Position</dt><dd>${m.inv ? `${sideTag(m.inv)} <span class="${pl >= 0 ? 'pos' : 'neg'}">${signed(pl)}</span>` : 'none'}</dd>` +
      `<dt>Our quotes</dt><dd>${m.bid == null && m.ask == null ? 'not quoting' : `${m.bid == null ? '—' : cc(m.bid)} to buy · ${m.ask == null ? '—' : cc(m.ask)} to sell`}</dd>` +
      `<dt>Trading</dt><dd>${m.tpd ? `${m.tpd} trades a day · line clears in ${clears}` : 'not measured yet'}</dd>` +
      `</dl><p class="wread ${tone}">${esc(read)}</p>`;
  }

  function wallAgent(a) {
    const mine = (S.log || []).filter((e) => e.agent === a.key);
    const seen = new Set(), lines = [];
    for (const e of mine) {                    // plain English, repeats folded, newest first
      const sx = say(e), k = shape(sx.text);
      if (seen.has(k)) continue;
      seen.add(k); lines.push({ e, sx });
      if (lines.length >= 6) break;
    }
    return `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span style="color:${a.color}">${esc(a.key)} · ${esc(cap(String(a.role).toLowerCase()))}</span></div>` +
      `<div class="wq">${esc(cap(ROLE[a.key] || ''))}</div>` +
      (lines.length ? `<ol class="wlog">${lines.map(({ e, sx }) => `<li class="lv-${sx.level}"><span class="t">${hhmm(e.t)}</span><span>${esc(sx.text)}</span></li>`).join('')}</ol>`
        : `<p class="wempty">Nothing logged yet.</p>`);
  }

  function placeBoards(X, Y, k) {
    const M = S.maker || {};
    const fit = (el, b, fs) => Object.assign(el.style, { left: `${X(b.x)}px`, top: `${Y(b.y)}px`, width: `${b.w * k}px`, height: `${b.h * k}px`, fontSize: `${fs}px` });

    if (wallBox) {
      const el = $('wall');
      fit(el, wallBox, Math.max(10, Math.min(17, k * 5.6)));
      const key = `${frameSeq}|${sel ? sel.kind + sel.key : ''}|${wallAll}`;
      if (key !== wallKey) {
        const list = el.querySelector('.wlist, .wlog'), top = list && key.split('|')[1] === wallKey.split('|')[1] ? list.scrollTop : 0;
        wallKey = key;
        const m = sel && sel.kind === 'market' ? byTicker(M, sel.key) : null;
        const a = sel && sel.kind === 'agent' ? S.agents.find((x) => x.key === sel.key) : null;
        el.innerHTML = m ? wallMarket(m, M) : a ? wallAgent(a) : wallHome(M);
        const list2 = el.querySelector('.wlist, .wlog');
        if (list2) list2.scrollTop = top;
      }
    }

    if (tapeBox) {
      const el = $('tape');
      fit(el, { x: tapeBox.x + 1, y: tapeBox.y + 1, w: tapeBox.w - 2, h: tapeBox.h - 2 }, Math.max(9.5, Math.min(15, k * 4.8)));
      if (frameSeq + '' !== tapeKey) {
        tapeKey = frameSeq + '';
        const groups = [];
        for (const f of M.recent || []) {            // newest first; a run of the same trade is one line
          const g = groups[groups.length - 1];
          if (g && g.ticker === f.ticker && g.side === f.side) { g.qty += f.qty; g.val += f.qty * f.px; }
          else groups.push({ ticker: f.ticker, side: f.side, qty: f.qty, val: f.qty * f.px, at: f.at });
        }
        el.innerHTML = `<div class="th"><span>Fills</span><span>${M.fills || 0} total</span></div>` +
          (groups.length
            ? `<ol>${groups.map((g) => `<li class="${g.side}"><span class="act">${g.side === 'buy' ? 'Bought' : 'Sold'} ${g.qty}</span><span class="px">${cc(g.val / g.qty)}</span>` +
              `<span class="nm">${esc(marketName(g.ticker))}</span><span class="ago">${ago(g.at).replace(' ago', '')}</span></li>`).join('')}</ol>`
            : `<p class="none">${M.fills ? `${M.fills} fills before the last restart` : 'No fills yet'}</p>`);
      }
    }

    if (clockBox) {
      const el = $('clock');
      fit(el, clockBox, Math.max(12, Math.min(26, k * 10)));
      const halted = S.halt || M.halted, on = !halted && M.quoting > 0;
      const t = new Date(S.now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      const html = `<b class="${on ? 'on' : ''}">${t.replace(/ [AP]M$/, '')}</b><small>${t.slice(-2)} ET</small>`;
      if (html !== clockTxt) { el.innerHTML = html; clockTxt = html; }
    }
  }

  $('wall').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.back) sel = null;
    else if (b.dataset.all) wallAll = !wallAll;
    else if (b.dataset.m) sel = sel && sel.kind === 'market' && sel.key === b.dataset.m ? null : { kind: 'market', key: b.dataset.m };
    wallKey = '';
  });

  function loop(ts) { drawFloor(ts / 1000); placeFx(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ wiring
  function render() { frameSeq++; renderHeader(); ingest(); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); lastFrameAt = Date.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  wireFloor();
  connect();
  
})();

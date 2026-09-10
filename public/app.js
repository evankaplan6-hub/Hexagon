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
    $('meta').innerHTML =
      `<span><span class="k">Day</span><b>${day}</b></span>` +
      `<span><span class="k">Uptime</span><b>${dur(S.now - S.startedAt)}</b></span>` +
      `<span><span class="k">Pairs</span><b>${S.pairCount}</b></span>` +
      `<span><span class="k">Open</span><b>${S.positions.length}</b></span>` +
      (S.demo ? `<span class="demo">● DEMO QUOTES</span>` : '') +
      `<span><span class="k">Position</span><b class="${modeCls}">● ${modeTxt}</b></span>`;
  }
  // renderTiles is gone with the tiles it fed. They reported the convergence book -- the desk that
  // found no edge -- so the page opened on "$10,000.00 / +$0.00" while the maker desk was trading.
  // A prominent number describing the wrong desk is worse than no number.

  // ------------------------------------------------------------ log
  function renderLog() {
    const el = $('log');
    const atTop = el.scrollTop < 8;
    el.innerHTML = S.log.map((e) => {
      const pnl = e.pnl == null ? '' : `<span class="pnl ${e.pnl >= 0 ? 'pos' : 'neg'}">${signed(e.pnl)}</span>`;
      return `<div class="lr ${e.kind}" title="${esc(e.text)}"><span class="t">${hhmm(e.t)}</span><span class="dot" style="background:${agentColor(e.agent)}"></span><span class="ag">${e.agent}</span><span class="k ${e.kind}">${e.kind}</span>${pnl || '<span></span>'}<span class="tx ${e.kind === 'FILL' || e.kind === 'SETTLE' ? 'hi' : ''}">${esc(e.text)}</span></div>`;
    }).join('') || '<div class="empty">waiting for the first cycle…</div>';
    if (atTop) el.scrollTop = 0;
    $('log-meta').textContent = `${S.wins + S.losses} resolved · ${S.log.length} lines`;
  }

  // renderFeed, renderAgents and renderPositions are gone with their panels. The feed listed
  // top-volume markets on both venues and the matched-pair gaps; the positions table showed the
  // convergence book, which is empty by design. The agent cards duplicated the seven agents already
  // sitting at their desks on the floor. All of it was page furniture around the one thing that
  // trades, so it now lives on the floor or not at all.

  // The balance chart plotted the convergence desk's equity: a flat line at the opening balance,
  // because that desk has never opened a position. The maker's numbers are on the wall screen.

  // The floor is pixel art drawn in a fixed 480x260 coordinate space, but DISPLAYED at whatever
  // width the panel is -- 856 css px on a 2x screen. Left alone, every drawn pixel landed on 3.57
  // screen pixels and every label was a smear; `image-rendering: pixelated` kept the edges hard but
  // could not invent resolution that was never rendered. So: a backing store at true device
  // resolution with the context scaled to match. The coordinates below are unchanged, blocks stay
  // blocks, and text is drawn as vectors at final size instead of being upscaled.
  let floorSized = '';
  function floorCtx() {
    const cv = $('floorc'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const key = `${w}x${h}`;
    if (key !== floorSized) { cv.width = w; cv.height = h; floorSized = key; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(w / 480, 0, 0, h / 260, 0, 0);   // keep the 480x260 drawing space
    return ctx;
  }

  const DESKS = [[132, 158], [216, 158], [300, 158], [132, 200], [216, 200], [300, 200], [384, 200]];
  function hash(i, j, k) { let x = (i * 374761393 + j * 668265263 + k * 2246822519) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; }
  function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, s, x, y, c, size = 7, align = 'left') { ctx.fillStyle = c; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(s, Math.round(x), Math.round(y)); }
  function hexagon(ctx, cx, cy, r, c, fill) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); if (fill) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke(); } }
  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 480, 260);
    // room
    const wall = ctx.createLinearGradient(0, 0, 0, 150); wall.addColorStop(0, '#0d1220'); wall.addColorStop(1, '#101828'); ctx.fillStyle = wall; ctx.fillRect(0, 0, 480, 150);
    px(ctx, 0, 150, 480, 110, '#0a0d13'); px(ctx, 0, 149, 480, 2, '#1c2434');
    for (let x = 0; x < 480; x += 24) px(ctx, x, 150, 1, 110, '#0f131b');
    for (let y = 162; y < 260; y += 14) px(ctx, 0, y, 480, 1, '#0f131b');
    if (!S) { text(ctx, 'CONNECTING TO THE DESK…', 240, 120, '#4b5563', 8, 'center'); return; }

    // ---- everything below is the MAKER desk, because the maker desk is the one that trades ----
    // The boards used to show convergence pairs and convergence thresholds: the desk that measured
    // no edge and correctly does nothing. Reading them told you nothing about whether the machine
    // was working, which is the only question the floor should answer at a glance.
    const M = S.maker || {};
    const banked = (M.cash ?? M.initial ?? 0) - (M.initial ?? 0);
    const marked = M.mark || 0;
    const mEq = (M.equity ?? M.initial ?? 0) - (M.initial ?? 0);
    const halted = S.halt || M.halted;
    const working = !halted && M.quoting > 0;

    // emblem
    hexagon(ctx, 58, 30, 20, '#7c869a'); hexagon(ctx, 58, 30, 13, '#7c869a'); hexagon(ctx, 58, 30, 6, '#7c869a', true);
    text(ctx, 'THE HEXAGON', 58, 54, '#c7cdd8', 8, 'center');

    // ---- status board (left) : the "is it working" answer, in words
    px(ctx, 10, 66, 108, 78, '#0b1018'); px(ctx, 10, 66, 108, 1, '#26304a'); px(ctx, 10, 143, 108, 1, '#26304a');
    const stCol = halted ? '#ef4444' : working ? '#22c55e' : '#d4a72c';
    px(ctx, 14, 71, 4, 4, stCol);
    text(ctx, halted ? 'STOPPED' : working ? 'WORKING' : 'IDLE', 22, 70, stCol, 8);
    text(ctx, working ? `quoting ${M.quoting} markets` : (halted ? 'trading stopped' : 'waiting for scan'), 14, 82, '#aab3c5', 6);
    text(ctx, 'resting orders, never crossing', 14, 90, '#5b6270', 5);
    px(ctx, 14, 98, 100, 1, '#141b28');
    const lf = M.lastFill;
    // The ledger survives a restart but the last-fill detail does not, so "no fills yet" beside a
    // screen reading 14 FILLS is a contradiction the reader cannot resolve. Say which.
    text(ctx, lf ? `last fill ${ago(lf.at)}` : (M.fills ? `${M.fills} fills before restart` : 'no fills yet'),
      14, 103, lf || M.fills ? '#c7cdd8' : '#5b6270', 6);
    text(ctx, lf ? `${lf.side === 'buy' ? 'bought' : 'sold'} ${lf.qty} @ ${cents(lf.px)}`
      : (M.fills ? 'waiting for the next' : 'waiting to be traded against'), 14, 112, '#7c869a', 5);
    px(ctx, 14, 120, 100, 1, '#141b28');
    text(ctx, `up ${dur(S.now - S.startedAt)}`, 14, 125, '#7c869a', 5);
    text(ctx, `scanned ${ago(M.lastScanAt)}`, 14, 133, '#7c869a', 5);
    text(ctx, 'PAPER · no real money', 14, 141, '#4b5563', 5);

    // ---- wall screen : the whole book, not a sample of it
    px(ctx, 136, 8, 208, 138, '#1a2030'); px(ctx, 140, 12, 200, 130, '#060910');
    text(ctx, `MAKER DESK 07 · ${S.mode.toUpperCase()}`, 144, 15, '#c7cdd8', 6);
    text(ctx, `${M.fills || 0} FILLS`, 336, 15, '#7c869a', 6, 'right');
    // three numbers, and they mean different things on purpose
    [['BANKED', banked, 'from spread'], ['ON INVENTORY', marked, `${M.inv || 0} contracts`], ['NET', mEq, 'if closed now']]
      .forEach(([lab, v, sub], i) => {
        const cx = 168 + i * 68;
        text(ctx, lab, cx, 25, '#5b6270', 5, 'center');
        text(ctx, signed(v), cx, 32, v >= 0 ? '#22c55e' : '#ef4444', 9, 'center');
        text(ctx, sub, cx, 43, '#4b5563', 5, 'center');
      });
    px(ctx, 144, 50, 192, 1, '#141b28');
    text(ctx, 'MARKET', 144, 54, '#4b5563', 5);
    text(ctx, 'FLOW', 236, 54, '#4b5563', 5, 'right');
    text(ctx, 'BID', 266, 54, '#4b5563', 5, 'right');
    text(ctx, 'ASK', 294, 54, '#4b5563', 5, 'right');
    text(ctx, 'HELD', 336, 54, '#4b5563', 5, 'right');
    const book = (M.markets || []).filter((m) => m.quoting || m.inv);
    const ROWS = 12;   // inner screen is y 12-142; 12 rows from 61 ends at 135, leaving the tail line room
    book.slice(0, ROWS).forEach((m, i) => {
      const y = 61 + i * 6.2;
      px(ctx, 144, y + 1, 3, 3, m.quoting ? '#22c55e' : '#3d4350');
      text(ctx, m.ticker.replace(/^KX/, '').slice(0, 19), 150, y, m.quoting ? '#aab3c5' : '#5b6270', 5);
      text(ctx, m.tpd ? `${m.tpd}/d` : '—', 236, y, '#4b5563', 5, 'right');
      text(ctx, m.bid == null ? '—' : cents(m.bid), 266, y, '#7c869a', 5, 'right');
      text(ctx, m.ask == null ? '—' : cents(m.ask), 294, y, '#7c869a', 5, 'right');
      text(ctx, m.inv ? String(m.inv) : '·', 336, y, m.inv > 0 ? '#22c55e' : m.inv < 0 ? '#ef4444' : '#3d4350', 5, 'right');
    });
    if (!book.length) text(ctx, M.quoting ? 'quoting — no inventory yet' : 'scanning for markets…', 240, 90, '#3d4350', 6, 'center');
    else if (book.length > ROWS) text(ctx, `+${book.length - ROWS} more quoting`, 336, 61 + ROWS * 6.2, '#3d4350', 5, 'right');
    px(ctx, 236, 146, 8, 8, '#1a2030'); // mount

    // ---- clock + how it picks markets (right)
    px(ctx, 372, 10, 98, 20, '#0b1018'); px(ctx, 372, 10, 98, 1, '#26304a');
    text(ctx, new Date(S.now).toTimeString().slice(0, 8), 421, 14, working ? '#22c55e' : '#7c869a', 10, 'center');
    px(ctx, 372, 36, 98, 108, '#0a1710'); px(ctx, 372, 36, 98, 1, '#1e4a2c'); px(ctx, 372, 143, 98, 1, '#1e4a2c');
    text(ctx, 'HOW IT PICKS', 376, 39, '#86efac', 6);
    [
      '- fee-free series only',
      `- queue clears < ${S.cfg.makerMaxClearDays ?? 1}d`,
      `- min ${S.cfg.makerMinTradesPerDay ?? 10} trades/day`,
      `- top ${S.cfg.makerMarkets ?? 24} by queue speed`,
      '',
      `- ${M.tracked || 0} tracked`,
      `- ${M.quoting || 0} quoting now`,
      '',
      halted ? '! TRADING STOPPED' : '- rails clear',
    ].forEach((l, i) => l && text(ctx, l, 376, 48 + i * 10, l[0] === '!' ? '#f87171' : '#4ade80', 6));

    // desks + agents
    // advance the shared clock between SSE frames so the stagger animates smoothly
    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
    const bubbles = [];
    S.agents.forEach((a, i) => {
      if (!DESKS[i]) return;                 // more agents than seats: skip rather than throw
      const [x, y] = DESKS[i];
      const act = isActive(a);
      // monitor
      px(ctx, x + 12, y - 16, 40, 24, '#232935'); px(ctx, x + 14, y - 14, 36, 20, '#070a10'); px(ctx, x + 30, y + 8, 4, 3, '#232935');
      const bars = 9;
      for (let j = 0; j < bars; j++) { const hgt = 3 + Math.round(hash(i, j, Math.floor(a.runs / 2)) * 12); px(ctx, x + 16 + j * 4, y + 4 - hgt, 3, hgt, act ? a.color : '#243044'); }
      if (act && Math.floor(t * 6) % 2) px(ctx, x + 47, y - 12, 2, 2, a.color);
      // desk + chair
      px(ctx, x, y + 11, 64, 9, '#3a2f22'); px(ctx, x, y + 11, 64, 1, '#5a4a36'); px(ctx, x + 2, y + 20, 4, 8, '#2a2219'); px(ctx, x + 58, y + 20, 4, 8, '#2a2219');
      px(ctx, x + 24, y + 30, 16, 5, '#171a21'); px(ctx, x + 22, y + 24, 20, 6, '#1d212b');
      // blob agent (sits in front of the desk, bobs when active)
      const bob = act ? Math.round(Math.sin(t * 9 + i) * 1.5) : 0;
      const bx = x + 32, by = y + 22 + bob;
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.roundRect(bx - 7, by - 8, 14, 13, [6, 6, 5, 5]); ctx.fill();
      const blink = Math.floor(t * 1.3 + i * 0.7) % 6 === 0 && ((t * 1.3 + i * 0.7) % 1) < 0.18;
      if (blink) { px(ctx, bx - 4, by - 3, 3, 1, '#fff'); px(ctx, bx + 1, by - 3, 3, 1, '#fff'); }
      else { px(ctx, bx - 4, by - 4, 3, 3, '#fff'); px(ctx, bx + 1, by - 4, 3, 3, '#fff'); px(ctx, bx - 3, by - 3, 1, 1, '#111'); px(ctx, bx + 2, by - 3, 1, 1, '#111'); }
      text(ctx, a.key, bx, y + 36, act ? '#e6e8ee' : '#5b6270', 6, 'center');
      // Speech bubbles are QUEUED, not drawn here. Drawing one inside this loop put it under the
      // next agent's desk, which is why they read "budget $20" and "22 pairs /" -- the box was
      // being painted over a few iterations later. They go on top, after every desk is down.
      if (act && a.note) bubbles.push({ note: a.note, bx, y, back: i < 3 });
    });
    // second pass: every bubble on top of every desk
    for (const b of bubbles) {
      const s2 = b.note.length > 30 ? b.note.slice(0, 29) + '…' : b.note;
      ctx.font = '6px JetBrains Mono, monospace';
      const w = Math.ceil(ctx.measureText(s2).width) + 6;
      // back row rises off the desk; the room floor starts at y=120, so keep it off the wall screen
      const by2 = b.back ? Math.max(152, b.y - 28) : b.y + 14;
      // Front-row bubbles open to the right of the agent, but the seventh desk sits at the wall,
      // so its bubble ran off the canvas. Flip to the left when there is no room on the right.
      const lx = b.back ? Math.min(Math.max(b.bx - w / 2, 2), 478 - w)
        : (b.bx + 12 + w <= 478 ? b.bx + 12 : Math.max(2, b.bx - 12 - w));
      px(ctx, lx, by2, w, 9, '#e6e8ee');
      const rightward = lx > b.bx;
      if (b.back) px(ctx, b.bx - 1, by2 + 9, 2, 2, '#e6e8ee');
      else px(ctx, rightward ? b.bx + 9 : b.bx - 11, by2 + 4, 3, 2, '#e6e8ee');
      text(ctx, s2, lx + 3, by2 + 2, '#0a0b0d', 6);
    }

    // server rack + plant flavour
    px(ctx, 440, 162, 26, 60, '#12161e'); for (let i = 0; i < 6; i++) { px(ctx, 443, 166 + i * 9, 20, 6, '#0a0d13'); px(ctx, 459, 168 + i * 9, 2, 2, (Math.floor(t * 4) + i) % 3 ? '#22c55e' : '#0f3a1f'); }
    px(ctx, 16, 186, 12, 24, '#2a2219'); px(ctx, 10, 170, 24, 18, '#1a4d2e'); px(ctx, 14, 164, 16, 10, '#236b3d');
  }
  function loop(ts) { drawFloor(ts / 1000); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ wiring
  function render() { renderHeader(); renderLog(); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
  
})();

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

  // The activity log moved onto the floor. It was the last panel under the canvas, and while it
  // sat there the page had something to scroll -- which is the whole reason the wheel kept moving
  // the document instead of the list under the pointer.

  // ------------------------------------------------------------ floor interaction
  // The floor is a control surface, not a picture. Every frame rebuilds a list of hit regions in
  // the 480x260 drawing space; the pointer is mapped into that space and tested against them. Click
  // an agent or a market and the wall screen stops showing the book and shows that thing instead --
  // the big display becomes the focus view rather than a second panel competing for room.
  let hits = [];                 // rebuilt each frame: { x, y, w, h, kind, key }
  let hover = null, sel = null;
  // Scrollable regions inside the canvas. The book, the fill tape and an agent's history all hold
  // more rows than fit, and a canvas has no native scrolling -- so the wheel fell through to the
  // page and moved the whole document instead of the list under the pointer.
  let zones = [];                // rebuilt each frame: { x, y, w, h, id, max }
  const scroll = { book: 0, tape: 0, agentlog: 0, log: 0, pos: 0 };
  const zoneAt = (p) => zones.find((z) => p.x >= z.x && p.x <= z.x + z.w && p.y >= z.y && p.y <= z.y + z.h) || null;

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
      hover = hitAt(floorPoint(ev));
      cv.style.cursor = hover ? 'pointer' : 'default';
    });
    cv.addEventListener('mouseleave', () => { hover = null; });
    cv.addEventListener('click', (ev) => {
      const h = hitAt(floorPoint(ev));
      sel = same(h, sel) ? null : h;          // clicking the selected thing again closes it
      scroll.agentlog = 0; scroll.book = 0; scroll.pos = 0;   // a new view starts at the top
    });
    // Scroll the list under the pointer, and only then let the page have the event. passive:false
    // is required -- without it the browser ignores preventDefault and scrolls the document anyway.
    cv.addEventListener('wheel', (ev) => {
      const z = zoneAt(floorPoint(ev));
      if (!z || z.max <= 0) return;                       // nothing to scroll here: page scrolls
      const next = Math.max(0, Math.min(z.max, scroll[z.id] + (ev.deltaY > 0 ? 1 : -1)));
      if (next !== scroll[z.id]) { scroll[z.id] = next; ev.preventDefault(); }
      else if ((next === 0 && ev.deltaY < 0) || (next === z.max && ev.deltaY > 0)) return; // hand back at the ends
    }, { passive: false });
    // clicking empty floor clears; so does Escape
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') sel = null; });
  }

  const DESKS = [[132, 158], [216, 158], [300, 158], [132, 200], [216, 200], [300, 200], [384, 200]];
  function hash(i, j, k) { let x = (i * 374761393 + j * 668265263 + k * 2246822519) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; }
  function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, s, x, y, c, size = 7, align = 'left') { ctx.fillStyle = c; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(s, Math.round(x), Math.round(y)); }
  function hexagon(ctx, cx, cy, r, c, fill) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); if (fill) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke(); } }
  // ------------------------------------------------------------ focus views
  // What the wall screen shows when you click something. These are the "intelligent" part: not a
  // dump of the fields, but the read on them -- what the position is, and what it means. A market
  // that is 77 short with a 32,000-deep queue on the offer is a specific problem, and the screen
  // should say so rather than leave you to work it out from four numbers.
  function focusHeader(ctx, title, sub) {
    text(ctx, title, 144, 15, '#c7cdd8', 6);
    text(ctx, 'ESC ✕', 336, 15, '#3d4350', 5, 'right');
    if (sub) text(ctx, sub, 144, 23, '#4b5563', 5);
    px(ctx, 144, 31, 192, 1, '#141b28');
  }
  function drawMarketFocus(ctx, m, M) {
    focusHeader(ctx, clip(OUTCOME(m) || QUESTION(m), 34), m.ticker.replace(/^KX/, ''));
    if (m.title) wrap(ctx, QUESTION(m), 150, 37, 180, 7, '#9aa3b5', 5);
    const rows = [
      ['our quote', m.bid == null && m.ask == null ? 'not quoting' : `${m.bid == null ? '—' : cents(m.bid)} bid  /  ${m.ask == null ? '—' : cents(m.ask)} ask`],
      ['flow', m.tpd ? `${m.tpd} trades a day` : 'unmeasured'],
      ['queue ahead of us', m.qBid == null ? '—' : `${m.qBid} on our bid, ${m.qAsk} on our offer`],
      ['clears in', m.clear == null ? '—' : (m.clear < 1 ? `${(m.clear * 24).toFixed(1)} hours` : `${m.clear.toFixed(1)} days`)],
      ['position', m.inv ? `${m.inv > 0 ? 'long' : 'short'} ${Math.abs(m.inv)} contracts` : 'flat'],
      ['paid', m.inv ? signed(m.cost) : '—'],
      ['marked', m.inv ? signed(m.mark - m.cost) : '—'],
      ['fills here', String(m.fills || 0)],
    ];
    rows.forEach(([k, v], i) => {
      const y = 53 + i * 7.4;
      text(ctx, k, 150, y, '#4b5563', 5);
      text(ctx, v, 330, y, '#aab3c5', 5, 'right');
    });
    // the read
    px(ctx, 144, 114, 192, 1, '#141b28');
    let read, col = '#7c869a';
    if (!m.quoting && m.inv) { read = 'Dropped from the book. Quoting one side only, to work it off.'; col = '#d4a72c'; }
    else if (!m.inv) read = 'Flat here. Both sides resting, waiting to be traded against.';
    else if (Math.abs(m.inv) > 60) { read = `${m.inv > 0 ? 'Long' : 'Short'} ${Math.abs(m.inv)} — near the ${M.cap || 100} cap. One-sided flow, not a round trip.`; col = '#f87171'; }
    else if (m.qAsk > 5000 || m.qBid > 5000) read = 'Deep queue here. Fills come slowly; the crowd is served first.';
    else read = 'Working normally — small position, queue clears fast.';
    wrap(ctx, read, 150, 119, 180, 7, col, 5);
  }
  function drawAgentFocus(ctx, a, M) {
    focusHeader(ctx, `${a.n} · ${a.key} · ${a.role}`, ROLE[a.key] || '');
    const all = (S.log || []).filter((e) => e.agent === a.key);
    const LROWS = 8;
    const maxL = Math.max(0, all.length - LROWS);
    scroll.agentlog = Math.min(scroll.agentlog, maxL);
    zones.push({ x: 144, y: 43, w: 192, h: 95, id: 'agentlog', max: maxL });
    const mine = all.slice(scroll.agentlog, scroll.agentlog + LROWS);
    text(ctx, 'RECENT', 150, 37, '#4b5563', 5);
    text(ctx, maxL ? `${scroll.agentlog + 1}-${scroll.agentlog + mine.length} of ${all.length}` : `${a.runs || 0} runs`, 330, 37, '#4b5563', 5, 'right');
    if (!mine.length) text(ctx, 'nothing logged yet', 240, 80, '#3d4350', 6, 'center');
    mine.forEach((e, i) => {
      const y = 46 + i * 11.4;
      text(ctx, hhmm(e.t), 150, y, '#3d4350', 5);
      text(ctx, e.kind, 172, y, a.color, 5);
      text(ctx, clip(String(e.text).split('·')[0], 48), 150, y + 5, '#7c869a', 4.5);
    });
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

  // canvas has no word wrap
  function wrap(ctx, str, x, y, maxw, lh, col, size) {
    ctx.font = `${size}px JetBrains Mono, monospace`;
    const words = String(str).split(' ');
    let line = '', n = 0;
    for (const w of words) {
      const test = line ? line + ' ' + w : w;
      if (ctx.measureText(test).width > maxw && line) { text(ctx, line, x, y + n * lh, col, size); line = w; n++; }
      else line = test;
    }
    if (line) text(ctx, line, x, y + n * lh, col, size);
  }

  // Kept immediately beside drawFloor on purpose. Twice now this has been swallowed by a
  // marker-to-marker deletion of a neighbouring block, and the failure is silent in the source and
  // fatal in the browser: the whole floor goes black sixty times a second.
  //
  // The art is drawn in a fixed 480x340 space but DISPLAYED at whatever size the viewport allows,
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
  function floorCtx() {
    const cv = $('floorc'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const key = `${w}x${h}`;
    if (key !== floorSized) { cv.width = w; cv.height = h; floorSized = key; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h);       // paint the letterbox
    const scale = Math.min(w / 480, h / 340);
    floorBox.scale = scale / dpr;                              // css px per drawing unit
    floorBox.ox = (w - 480 * scale) / 2 / dpr;
    floorBox.oy = (h - 340 * scale) / 2 / dpr;
    ctx.setTransform(scale, 0, 0, scale, (w - 480 * scale) / 2, (h - 340 * scale) / 2);
    return ctx;
  }

  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 480, 340);   // the letterbox is repainted in floorCtx
    hits = []; zones = [];                   // rebuilt every frame; the pointer tests against them
    // room
    const wall = ctx.createLinearGradient(0, 0, 0, 150); wall.addColorStop(0, '#0d1220'); wall.addColorStop(1, '#101828'); ctx.fillStyle = wall; ctx.fillRect(0, 0, 480, 150);
    px(ctx, 0, 150, 480, 112, '#0a0d13'); px(ctx, 0, 149, 480, 2, '#1c2434');
    for (let x = 0; x < 480; x += 24) px(ctx, x, 150, 1, 112, '#0f131b');
    for (let y = 162; y < 262; y += 14) px(ctx, 0, y, 480, 1, '#0f131b');
    if (!S) { text(ctx, 'CONNECTING TO THE DESK', 240, 120, '#4b5563', 8, 'center'); return; }

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
    const nHeld = (M.markets || []).filter((m) => m.inv).length;
    text(ctx, nHeld ? `holding ${M.inv} contracts in ${nHeld}` : 'flat — nothing held', 14, 90, nHeld ? '#c7cdd8' : '#5b6270', 5);
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

    // ---- wall screen : the book, or whatever you clicked on
    px(ctx, 136, 8, 208, 138, '#1a2030'); px(ctx, 140, 12, 200, 130, '#060910');

    if (sel && sel.kind === 'market') {
      const m = (M.markets || []).find((x) => x.ticker === sel.key);
      if (!m) sel = null; else drawMarketFocus(ctx, m, M);
    } else if (sel && sel.kind === 'agent') {
      const a2 = S.agents.find((x) => x.key === sel.key);
      if (!a2) sel = null; else drawAgentFocus(ctx, a2, M);
    }

    if (!sel) {
      text(ctx, `MAKER DESK 07 · ${S.mode.toUpperCase()}`, 144, 15, '#c7cdd8', 6);
      text(ctx, `${M.fills || 0} FILLS`, 336, 15, '#7c869a', 6, 'right');
      // three numbers, and they mean different things on purpose
      [['BANKED', banked, 'from spread'], ['ON INVENTORY', marked, `${M.inv || 0} contracts`], ['NET', mEq, 'if closed now']]
        .forEach(([lab, v, sub], i) => {
          const cx = 168 + i * 68;
          text(ctx, lab, cx, 22, '#5b6270', 5, 'center');
          text(ctx, signed(v), cx, 29, v >= 0 ? '#22c55e' : '#ef4444', 9, 'center');
          text(ctx, sub, cx, 40, '#4b5563', 5, 'center');
        });
      px(ctx, 144, 46, 192, 1, '#141b28');

      // Positions first, and separated. They used to be mixed into one list of 24 quoted markets
      // with a HELD column that was a dot on almost every row -- the five things we actually own
      // were the hardest part of the board to find.
      const all = M.markets || [];
      const held = all.filter((m) => m.inv);
      const flat = all.filter((m) => !m.inv && m.quoting);
      const heldPL = held.reduce((a2, m) => a2 + (m.mark - m.cost), 0);

      const PROWS = Math.min(4, Math.max(1, held.length));
      text(ctx, `OPEN POSITIONS  ${held.length}`, 144, 50, held.length ? '#c7cdd8' : '#4b5563', 5);
      if (held.length) text(ctx, `${signed(heldPL)} marked`, 331, 50, heldPL >= 0 ? '#22c55e' : '#ef4444', 5, 'right');
      if (!held.length) text(ctx, 'flat — nothing held', 144, 59, '#3d4350', 5);
      else {
        const maxP = Math.max(0, held.length - PROWS);
        scroll.pos = Math.min(scroll.pos || 0, maxP);
        zones.push({ x: 144, y: 54, w: 192, h: PROWS * 7 + 2, id: 'pos', max: maxP });
        held.slice(scroll.pos, scroll.pos + PROWS).forEach((m, i) => {
          const y = 57 + i * 9;
          hits.push({ x: 144, y: y - 1, w: 192, h: 9, kind: 'market', key: m.ticker });
          const hot = (hover && hover.kind === 'market' && hover.key === m.ticker);
          if (hot) px(ctx, 144, y - 1, 192, 9, '#101826');
          const long = m.inv > 0, pl = m.mark - m.cost;
          px(ctx, 144, y + 1, 3, 4, long ? '#22c55e' : '#ef4444');
          text(ctx, clip(OUTCOME(m) || QUESTION(m), 22), 150, y, hot ? '#e6e8ee' : '#c7cdd8', 5);
          text(ctx, `${long ? 'LONG' : 'SHORT'} ${Math.abs(m.inv)}`, 262, y, long ? '#4ade80' : '#f87171', 5, 'right');
          text(ctx, cents(Math.abs(m.cost / m.inv)), 292, y, '#5b6270', 5, 'right');
          text(ctx, signed(pl), 331, y, pl >= 0 ? '#22c55e' : '#ef4444', 5, 'right');
          text(ctx, clip(QUESTION(m), 62), 150, y + 4.4, '#4b5563', 4.5);
        });
        if (maxP) text(ctx, `${scroll.pos + 1}-${Math.min(held.length, scroll.pos + PROWS)} of ${held.length}`, 331, 57 + PROWS * 9, '#3d4350', 4.5, 'right');
      }

      // quoting-but-flat: what is on the book waiting to be traded against
      const qTop = 54 + (held.length ? PROWS * 9 + 7 : 14);
      px(ctx, 144, qTop - 4, 192, 1, '#141b28');
      text(ctx, `QUOTING  ${flat.length}`, 144, qTop, '#4b5563', 5);
      text(ctx, 'BID', 292, qTop, '#3d4350', 4.5, 'right');
      text(ctx, 'ASK', 331, qTop, '#3d4350', 4.5, 'right');
      const QROWS = Math.max(1, Math.floor((136 - (qTop + 7)) / 9));
      const maxB = Math.max(0, flat.length - QROWS);
      scroll.book = Math.min(scroll.book, maxB);
      zones.push({ x: 144, y: qTop + 5, w: 192, h: QROWS * 9 + 2, id: 'book', max: maxB });
      flat.slice(scroll.book, scroll.book + QROWS).forEach((m, i) => {
        const y = qTop + 7 + i * 9;
        hits.push({ x: 144, y: y - 1, w: 192, h: 9, kind: 'market', key: m.ticker });
        const hot = (hover && hover.kind === 'market' && hover.key === m.ticker);
        if (hot) px(ctx, 144, y - 1, 192, 9, '#101826');
        px(ctx, 144, y + 1, 3, 3, '#22c55e');
        text(ctx, clip(OUTCOME(m) || QUESTION(m), 24), 150, y, hot ? '#e6e8ee' : '#9aa3b5', 5);
        text(ctx, m.bid == null ? '—' : cents(m.bid), 292, y, '#5b6270', 5, 'right');
        text(ctx, m.ask == null ? '—' : cents(m.ask), 331, y, '#5b6270', 5, 'right');
        text(ctx, clip(QUESTION(m), 62), 150, y + 4.4, '#3d4350', 4.5);
      });
      if (maxB) text(ctx, `${scroll.book + 1}-${Math.min(flat.length, scroll.book + QROWS)} of ${flat.length}`, 331, 136, '#3d4350', 4.5, 'right');
      if (!all.length) text(ctx, 'scanning for markets', 240, 95, '#3d4350', 6, 'center');
      text(ctx, 'click a market or an agent', 144, 136, '#243044', 5);
    }
    px(ctx, 236, 146, 8, 8, '#1a2030'); // mount

    // ---- clock + the fill tape (right)
    px(ctx, 372, 10, 98, 20, '#0b1018'); px(ctx, 372, 10, 98, 1, '#26304a');
    const nyc = new Date(S.now).toLocaleTimeString('en-US',
      { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
    const [hms, ampm] = nyc.split(' ');
    text(ctx, hms, 415, 14, working ? '#22c55e' : '#7c869a', 10, 'center');
    text(ctx, ampm, 466, 17, '#4b5563', 6, 'right');

    // The fill tape. This panel used to restate the selection rules -- four lines of config that
    // never change, in the most valuable strip of the board. What belongs here is the one thing
    // that is genuinely live: the trades as they land.
    px(ctx, 372, 36, 98, 108, '#0a1710'); px(ctx, 372, 36, 98, 1, '#1e4a2c'); px(ctx, 372, 143, 98, 1, '#1e4a2c');
    text(ctx, 'FILLS', 376, 39, '#86efac', 6);
    text(ctx, `${M.fills || 0} total`, 466, 39, '#3f6b4f', 5, 'right');
    const tape = M.recent || [];
    if (!tape.length) {
      text(ctx, M.fills ? `${M.fills} before` : 'none yet', 421, 84, '#2f5a3f', 6, 'center');
      text(ctx, M.fills ? 'this restart' : 'waiting to be', 421, 92, '#2f5a3f', 6, 'center');
      if (!M.fills) text(ctx, 'traded against', 421, 100, '#2f5a3f', 6, 'center');
    } else {
      const TROWS = 10;
      const maxT = Math.max(0, tape.length - TROWS);
      scroll.tape = Math.min(scroll.tape, maxT);
      zones.push({ x: 372, y: 46, w: 98, h: 96, id: 'tape', max: maxT });
      tape.slice(scroll.tape, scroll.tape + TROWS).forEach((f, i) => {
      const y = 49 + i * 9.4;
      const buy = f.side === 'buy';
      px(ctx, 376, y + 1, 3, 3, buy ? '#22c55e' : '#ef4444');
      text(ctx, `${buy ? 'BUY' : 'SELL'} ${f.qty}`, 382, y, buy ? '#4ade80' : '#f87171', 5);
      text(ctx, cents(f.px), 466, y, '#86efac', 5, 'right');
      text(ctx, clip(OUTCOME(byTicker(M, f.ticker) || {}) || f.ticker.replace(/^KX/, ''), 20), 382, y + 4.4, '#3f6b4f', 4.5);
      });
    }

    // desks + agents
    // advance the shared clock between SSE frames so the stagger animates smoothly
    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
    const bubbles = [];
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
      text(ctx, a.key, bx, y + 36, (hot || picked) ? a.color : (act ? '#e6e8ee' : '#5b6270'), 6, 'center');
      // Speech bubbles are QUEUED, not drawn here. Drawing one inside this loop put it under the
      // next agent's desk, which is why they read "budget $20" and "22 pairs /" -- the box was
      // being painted over a few iterations later. They go on top, after every desk is down.
      if (act && a.note) bubbles.push({ note: a.note, bx, y, back: i < 3, color: a.color });
    });
    // furniture, before the bubbles -- the server rack stands where the seventh agent sits and was
    // painting straight over MAKR's line
    px(ctx, 440, 162, 26, 60, '#12161e'); for (let i = 0; i < 6; i++) { px(ctx, 443, 166 + i * 9, 20, 6, '#0a0d13'); px(ctx, 459, 168 + i * 9, 2, 2, (Math.floor(t * 4) + i) % 3 ? '#22c55e' : '#0f3a1f'); }
    px(ctx, 16, 186, 12, 24, '#2a2219'); px(ctx, 10, 170, 24, 18, '#1a4d2e'); px(ctx, 14, 164, 16, 10, '#236b3d');

    // ---- speech bubbles, last of everything so nothing can cover them
    // They used to be solid white blocks with black text: the brightest thing in a dark room, for
    // the least important content on it. Now they read as part of the room -- a dark plate, a hair
    // line in the agent's own colour, and the label in the same grey as the rest of the furniture.
    for (const b of bubbles) {
      // no ellipsis and no run-ons: the note is already a short whole phrase (engine.touch), and
      // if it still overruns it gets cut at a word, not mid-syllable with a dot-dot-dot.
      const s2 = clip(b.note, 34);
      ctx.font = '6px JetBrains Mono, monospace';
      const w = Math.ceil(ctx.measureText(s2).width) + 8;
      const h = 10;
      // back row rises off the desk; the floor starts at y=150, so keep it clear of the wall screen
      const by2 = b.back ? Math.max(152, b.y - 30) : b.y + 13;
      // Front-row bubbles open to the right, but the seventh desk sits against the wall -- flip
      // left when there is no room on the right.
      const lx = b.back ? Math.min(Math.max(b.bx - w / 2, 3), 477 - w)
        : (b.bx + 12 + w <= 477 ? b.bx + 12 : Math.max(3, b.bx - 12 - w));
      const rightward = lx > b.bx;
      px(ctx, lx, by2, w, h, '#0d1119');                    // plate
      px(ctx, lx, by2, w, 1, b.color); px(ctx, lx, by2 + h - 1, w, 1, '#1b2130');
      px(ctx, lx, by2, 1, h, '#1b2130'); px(ctx, lx + w - 1, by2, 1, h, '#1b2130');
      if (b.back) px(ctx, b.bx - 1, by2 + h, 2, 2, '#0d1119');
      else px(ctx, rightward ? lx - 2 : lx + w, by2 + 4, 2, 2, '#0d1119');
      text(ctx, s2, lx + 4, by2 + 2, '#9aa3b5', 6);
    }

    drawLog(ctx);
  }
  // ---- the tape along the bottom of the room: every agent's activity, scrollable in place
  function drawLog(ctx) {
    px(ctx, 0, 262, 480, 78, '#07090e'); px(ctx, 0, 262, 480, 1, '#1c2434');
    const rows = S.log || [];
    const LROWS = 8;
    const maxG = Math.max(0, rows.length - LROWS);
    scroll.log = Math.min(scroll.log, maxG);
    zones.push({ x: 0, y: 262, w: 480, h: 78, id: 'log', max: maxG });
    text(ctx, 'ACTIVITY', 10, 266, '#4b5563', 5);
    if (maxG) text(ctx, `${scroll.log + 1}-${Math.min(rows.length, scroll.log + LROWS)} of ${rows.length}`, 470, 266, '#3d4350', 5, 'right');
    rows.slice(scroll.log, scroll.log + LROWS).forEach((e, i) => {
      const y = 275 + i * 8;
      text(ctx, hhmm(e.t), 10, y, '#3d4350', 5);
      px(ctx, 34, y + 1, 3, 3, agentColor(e.agent));
      text(ctx, e.agent, 40, y, agentColor(e.agent), 5);
      text(ctx, e.kind, 66, y, '#4b5563', 5);
      if (e.pnl != null) text(ctx, signed(e.pnl), 128, y, e.pnl >= 0 ? '#22c55e' : '#ef4444', 5, 'right');
      text(ctx, clip(e.text, 112), 132, y, e.kind === 'FILL' ? '#c7cdd8' : '#7c869a', 5);
    });
    if (!rows.length) text(ctx, 'waiting for the first cycle', 240, 300, '#243044', 6, 'center');
  }

  function loop(ts) { drawFloor(ts / 1000); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ wiring
  function render() { renderHeader(); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  wireFloor();
  connect();
  
})();

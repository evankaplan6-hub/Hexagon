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
  const kvol = (v) => v >= 1e6 ? `$${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(0)}k` : `$${v}`;
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

  // ------------------------------------------------------------ feed
  function renderFeed() {
    const row = (m) => `<div class="fr"><a class="q" href="${esc(m.url)}" target="_blank" rel="noopener">${esc(m.q)}</a><span class="px">${m.px.toFixed(2)}</span><span class="v">${kvol(m.vol)}</span></div>`;
    $('feed-pm').innerHTML = S.universe.pmTop.map(row).join('') || '<div class="empty">no data</div>';
    $('feed-ks').innerHTML = S.universe.ksTop.map(row).join('') || '<div class="empty">no data</div>';
    $('feed-pairs').innerHTML = S.pairs.slice(0, 8).map((p) => {
      const g = Math.abs(p.gap), cls = p.inPlay ? 'cold' : g >= S.cfg.minGap ? 'hot' : g >= 0.01 ? 'warm' : 'cold';
      return `<div class="fr pair" title="${p.inPlay ? 'in-play: not traded' : esc(p.label)}"><span class="q">${p.inPlay ? '<b style="color:#ef4444">▶</b> ' : ''}<a href="${esc(p.pmUrl)}" target="_blank" rel="noopener">${esc(p.label)}</a></span><span class="px">${p.pmMid.toFixed(3)}</span><span class="px">${p.ksMid.toFixed(3)}</span><span class="gap ${cls}">${p.gap >= 0 ? 'KS+' : 'PM+'}${cents(p.gap)}</span></div>`;
    }).join('') || `<div class="empty">no matched pairs yet — HOLT rescans every ${S.cfg.priceEvery}s</div>`;
    const u = S.universe;
    $('feed-meta').textContent = `${u.pm} PM · ${u.ks} KS · ${S.pairCount} matched · data age ${u.dataAge == null ? '—' : u.dataAge + 's'} · api ${u.apiOk} ok / ${u.apiErr} err`;
  }

  // ------------------------------------------------------------ agents + positions
  function renderAgents() {
    $('agents').innerHTML = S.agents.map((a) =>
      `<div class="card ${isActive(a) ? 'run' : ''}"><div class="ch"><span>${a.n} · ${a.role}</span><span class="st">● ${isActive(a) ? 'RUN' : 'IDLE'}</span></div>` +
      `<div class="cb"><div class="blob" style="background:${a.color}"></div><div class="cn">${a.key}</div></div>` +
      `<div class="cnote" title="${esc(a.note || '')}">${esc(a.note || 'standing by')}</div></div>`).join('');
    $('floor-meta').textContent = `${S.mode.toUpperCase()} · 6 agents · ${S.pairCount} pairs · ${S.wins + S.losses} closed`;
  }
  function renderPositions() {
    const head = '<div class="pr head"><span>Pair</span><span>Venue</span><span>Side</span><span class="r">Qty</span><span class="r">Entry</span><span class="r">Mark</span><span class="r">P&amp;L</span><span>Type · Age</span></div>';
    $('positions').innerHTML = head + (S.positions.map((p) =>
      `<div class="pr"><span title="${esc(p.label)}">${esc(p.label)}</span><span>${p.venue === 'PM' ? 'Polymarket' : 'Kalshi'}</span><span>${p.side.toUpperCase()}</span><span class="r">${p.qty}</span><span class="r">${p.entry.toFixed(3)}</span><span class="r">${(p.mark ?? p.entry).toFixed(3)}</span><span class="r ${p.pnl >= 0 ? 'pos' : 'neg'}">${signed(p.pnl)}</span><span>${p.strategy} · ${dur(S.now - p.openedAt)}</span></div>`).join('') || '<div class="empty">flat — no open positions</div>');
    $('pos-meta').textContent = `${S.positions.length} open · ${signed(S.unrealized)} unrealized`;
  }

  // `ago` is used by the floor: "nothing is happening" and "something happened four minutes ago"
  // look identical unless the page can say which.
  const ago = (t) => {
    if (!t) return 'never';
    const s = Math.max(0, Math.round((S.now - t) / 1000));
    if (s < 60) return `${s}s ago`;
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m ago`;
  };

  // ------------------------------------------------------------ maker desk
  // The seventh desk, and the only one currently making money. It keeps a ledger separate from the
  // taker book on purpose, so the tiles above do NOT include it -- combining a convergence book and
  // a maker book into one equity number makes it impossible to tell which of the two is working.
  function renderMaker() {
    const M = S.maker;
    const el = $('mk-book'), tl = $('mk-tiles');
    if (!M || !M.enabled) { $('mk-meta').textContent = 'disabled'; tl.innerHTML = ''; el.innerHTML = '<div class="empty">maker desk is off</div>'; return; }
    const pnl = (M.equity ?? M.initial) - M.initial;
    const cashPnl = (M.cash ?? M.initial) - M.initial;
    tl.innerHTML =
      `<div class="mkt"><span>Equity</span><b class="${pnl >= 0 ? 'pos' : 'neg'}">${signed(pnl)}</b><i>vs ${money(M.initial, 0)} start</i></div>` +
      `<div class="mkt"><span>Cash from spread</span><b class="${cashPnl >= 0 ? 'pos' : 'neg'}">${signed(cashPnl)}</b><i>banked, not a mark</i></div>` +
      `<div class="mkt"><span>Inventory mark</span><b class="${M.mark >= 0 ? 'pos' : 'neg'}">${signed(M.mark)}</b><i>${M.inv} contracts · only real when it trades out</i></div>` +
      `<div class="mkt"><span>Fills</span><b>${M.fills}</b><i>${M.quoting} quoting · ${M.tracked} tracked</i></div>`;
    const head = '<div class="mr head"><span>Market</span><span class="r">Flow</span><span class="r">Queue clears</span><span class="r">Our bid</span><span class="r">Our ask</span><span class="r">Ahead of us</span><span class="r">Inv</span><span class="r">Marked</span></div>';
    el.innerHTML = head + (M.markets.map((m) => {
      const clear = m.clear == null ? '—' : (m.clear < 1 ? `${(m.clear * 24).toFixed(1)}h` : `${m.clear.toFixed(1)}d`);
      const q = m.qBid == null ? '—' : `${m.qBid}/${m.qAsk}`;
      return `<div class="mr ${m.quoting ? '' : 'off'}" title="${esc(m.ticker)}${m.why ? ' · ' + esc(m.why) : ''}">` +
        `<span>${m.quoting ? '<b class="on">●</b>' : '<b class="dimdot">○</b>'} ${esc(m.ticker)}</span>` +
        `<span class="r">${m.tpd == null ? '—' : m.tpd + '/day'}</span>` +
        `<span class="r">${clear}</span>` +
        `<span class="r">${m.bid == null ? '—' : cents(m.bid)}</span>` +
        `<span class="r">${m.ask == null ? '—' : cents(m.ask)}</span>` +
        `<span class="r dim">${q}</span>` +
        `<span class="r ${m.inv > 0 ? 'pos' : m.inv < 0 ? 'neg' : 'dim'}">${m.inv || 0}</span>` +
        `<span class="r ${m.mark >= 0 ? 'pos' : 'neg'}">${m.inv ? signed(m.mark) : '—'}</span></div>`;
    }).join('') || '<div class="empty">no markets in the book yet — first scan takes about a minute</div>');
    $('mk-meta').textContent = M.halted ? `HALTED · ${M.halted}` : `${M.quoting} quoting · ${M.fills} fills · resting orders, never crossing`;
    $('mk-meta').className = M.halted ? 'halt' : '';
  }

  // ------------------------------------------------------------ balance chart
  function sizeCanvas(cv) {
    const r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr) || cv.height !== Math.round(r.height * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    const ctx = cv.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0); return { ctx, w: r.width, h: r.height };
  }
  function drawBalance() {
    const { ctx, w, h } = sizeCanvas($('balance'));
    ctx.clearRect(0, 0, w, h);
    let pts = S.balanceHistory.slice();
    if (pts.length < 2) pts = [{ t: S.startedAt, b: S.initial }, { t: S.now, b: S.equity }];
    const L = 62, R = 118, T = 18, B = h - 16;
    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    let lo = Math.min(...pts.map((p) => p.b), S.initial), hi = Math.max(...pts.map((p) => p.b), S.initial);
    const pad = Math.max((hi - lo) * 0.15, S.initial * 0.002); lo -= pad; hi += pad;
    const X = (t) => L + (t - t0) / (t1 - t0) * (w - L - R), Y = (b) => B - (b - lo) / (hi - lo) * (B - T);
    ctx.font = '10px JetBrains Mono, monospace'; ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const v = lo + (hi - lo) * i / 3, y = Y(v);
      ctx.strokeStyle = '#181c24'; ctx.beginPath(); ctx.moveTo(L, y); ctx.lineTo(w - R, y); ctx.stroke();
      ctx.fillStyle = '#5b6270'; ctx.textAlign = 'right'; ctx.fillText(`$${Math.round(v).toLocaleString()}`, L - 8, y);
    }
    ctx.setLineDash([3, 4]); ctx.strokeStyle = '#2a303b'; ctx.beginPath(); ctx.moveTo(L, Y(S.initial)); ctx.lineTo(w - R, Y(S.initial)); ctx.stroke(); ctx.setLineDash([]);
    const up = S.equity >= S.initial, col = up ? '#22c55e' : '#ef4444';
    const grad = ctx.createLinearGradient(0, T, 0, B); grad.addColorStop(0, up ? 'rgba(34,197,94,.28)' : 'rgba(239,68,68,.28)'); grad.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.b)) : ctx.moveTo(X(p.t), Y(p.b))));
    ctx.lineTo(X(pts[pts.length - 1].t), B); ctx.lineTo(X(pts[0].t), B); ctx.closePath(); ctx.fillStyle = grad; ctx.fill();
    ctx.beginPath(); pts.forEach((p, i) => (i ? ctx.lineTo(X(p.t), Y(p.b)) : ctx.moveTo(X(p.t), Y(p.b))));
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.lineJoin = 'round'; ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.stroke(); ctx.shadowBlur = 0; ctx.lineWidth = 1;
    const last = pts[pts.length - 1];
    ctx.fillStyle = '#0f1116'; ctx.beginPath(); ctx.arc(X(last.t), Y(last.b), 4, 0, 7); ctx.fill(); ctx.strokeStyle = col; ctx.stroke();
    ctx.fillStyle = '#5b6270'; ctx.textAlign = 'left'; ctx.fillText('BALANCE', w - R + 14, Y(last.b) - 12);
    ctx.fillStyle = col; ctx.font = '700 16px Inter, sans-serif'; ctx.fillText(money(last.b), w - R + 14, Y(last.b) + 6);
    ctx.font = '9px JetBrains Mono, monospace';
    const hiP = pts.reduce((a, p) => (p.b > a.b ? p : a)), loP = pts.reduce((a, p) => (p.b < a.b ? p : a));
    ctx.fillStyle = '#8b93a3'; ctx.textAlign = 'center';
    if (hiP.b !== loP.b) { ctx.fillText(`H ${hiP.b.toFixed(1)}`, Math.min(Math.max(X(hiP.t), L + 30), w - R - 30), Y(hiP.b) - 9); ctx.fillText(`L ${loP.b.toFixed(1)}`, Math.min(Math.max(X(loP.t), L + 30), w - R - 30), Y(loP.b) + 10); }
    $('bal-meta').textContent = `${S.balanceHistory.length} marks · since ${new Date(S.startedAt).toLocaleDateString()}`;

    // trade bars
    const bc = sizeCanvas($('bars')); const c2 = bc.ctx; c2.clearRect(0, 0, bc.w, bc.h);
    const trades = S.closed.slice(-70);
    const mx = Math.max(1, ...trades.map((t) => Math.abs(t.pnl)));
    const bw = Math.max(3, Math.min(10, (bc.w - 24) / Math.max(trades.length, 1) - 2)), mid = bc.h / 2;
    c2.strokeStyle = '#1d212a'; c2.beginPath(); c2.moveTo(8, mid); c2.lineTo(bc.w - 8, mid); c2.stroke();
    trades.forEach((t, i) => { const hgt = Math.max(2, Math.abs(t.pnl) / mx * (mid - 6)); c2.fillStyle = t.pnl >= 0 ? '#22c55e' : '#ef4444'; c2.fillRect(12 + i * (bw + 2), t.pnl >= 0 ? mid - hgt : mid, bw, hgt); });
    c2.fillStyle = '#5b6270'; c2.font = '9px JetBrains Mono, monospace'; c2.textAlign = 'right'; c2.textBaseline = 'top'; c2.fillText(trades.length ? `last ${trades.length} settlements` : 'no settlements yet', bc.w - 8, 4);
  }

  // ------------------------------------------------------------ trading floor (pixel scene, 480x200)
  // The floor is pixel art drawn in a fixed 480x200 coordinate space, but it is DISPLAYED at
  // whatever width the panel is -- 856 css px on a 2x display, so every drawn pixel was landing on
  // 3.57 screen pixels and every 6px label was a smear. `image-rendering: pixelated` kept the edges
  // hard but could not invent resolution that was never rendered.
  //
  // Fix: give the canvas a backing store at true device resolution and scale the context to match,
  // so the existing 480x200 coordinates still work unchanged. Blocks stay blocks; text is drawn as
  // vectors at the transformed size, so it comes out sharp instead of upscaled. Same technique the
  // balance chart already used -- the floor simply never got it.
  let floorSized = '';
  function floorCtx() {
    const cv = $('floorc'), r = cv.getBoundingClientRect(), dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(r.width * dpr)), h = Math.max(1, Math.round(r.height * dpr));
    const key = `${w}x${h}`;
    if (key !== floorSized) { cv.width = w; cv.height = h; floorSized = key; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(w / 480, 0, 0, h / 200, 0, 0);   // keep the 480x200 drawing space
    return ctx;
  }
  // One seat per agent. MAKR joined as the seventh and this array still had six, so DESKS[6] was
  // undefined and destructuring it threw on every animation frame -- sixty times a second, with the
  // whole trading floor going dark below the point of failure. The guard below means adding an
  // eighth agent degrades to a missing seat instead of a dead canvas.
  const DESKS = [[132, 126], [216, 126], [300, 126], [132, 164], [216, 164], [300, 164], [384, 164]];
  function hash(i, j, k) { let x = (i * 374761393 + j * 668265263 + k * 2246822519) | 0; x = (x ^ (x >>> 13)) * 1274126177; return ((x ^ (x >>> 16)) >>> 0) / 4294967295; }
  function px(ctx, x, y, w, h, c) { ctx.fillStyle = c; ctx.fillRect(Math.round(x), Math.round(y), Math.round(w), Math.round(h)); }
  function text(ctx, s, x, y, c, size = 7, align = 'left') { ctx.fillStyle = c; ctx.font = `${size}px JetBrains Mono, monospace`; ctx.textAlign = align; ctx.textBaseline = 'top'; ctx.fillText(s, Math.round(x), Math.round(y)); }
  function hexagon(ctx, cx, cy, r, c, fill) { ctx.beginPath(); for (let i = 0; i < 6; i++) { const a = Math.PI / 6 + i * Math.PI / 3; ctx[i ? 'lineTo' : 'moveTo'](cx + r * Math.cos(a), cy + r * Math.sin(a)); } ctx.closePath(); if (fill) { ctx.fillStyle = c; ctx.fill(); } else { ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.stroke(); } }
  function series(ctx, data, x, y, w, h, c) {
    if (!data || data.length < 2) return;
    let lo = Math.min(...data), hi = Math.max(...data); if (hi - lo < 0.01) { lo -= 0.005; hi += 0.005; }
    ctx.strokeStyle = c; ctx.lineWidth = 1; ctx.beginPath();
    data.forEach((v, i) => { const X = x + i / (data.length - 1) * w, Y = y + h - (v - lo) / (hi - lo) * h; ctx[i ? 'lineTo' : 'moveTo'](Math.round(X) + 0.5, Math.round(Y) + 0.5); });
    ctx.stroke();
  }
  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 480, 200);
    // room
    const wall = ctx.createLinearGradient(0, 0, 0, 120); wall.addColorStop(0, '#0d1220'); wall.addColorStop(1, '#101828'); ctx.fillStyle = wall; ctx.fillRect(0, 0, 480, 120);
    px(ctx, 0, 120, 480, 80, '#0a0d13'); px(ctx, 0, 119, 480, 2, '#1c2434');
    for (let x = 0; x < 480; x += 24) px(ctx, x, 120, 1, 80, '#0f131b');
    for (let y = 132; y < 200; y += 14) px(ctx, 0, y, 480, 1, '#0f131b');
    if (!S) { text(ctx, 'CONNECTING TO THE DESK…', 240, 96, '#4b5563', 8, 'center'); return; }

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
    px(ctx, 10, 66, 108, 50, '#0b1018'); px(ctx, 10, 66, 108, 1, '#26304a'); px(ctx, 10, 115, 108, 1, '#26304a');
    const stCol = halted ? '#ef4444' : working ? '#22c55e' : '#d4a72c';
    const stTxt = halted ? 'STOPPED' : working ? 'WORKING' : 'IDLE';
    if (working && Math.floor(t * 2) % 2) px(ctx, 14, 71, 4, 4, stCol); else if (!working) px(ctx, 14, 71, 4, 4, stCol);
    text(ctx, stTxt, 22, 70, stCol, 8);
    text(ctx, working ? `quoting ${M.quoting} markets` : (halted ? 'trading stopped' : 'waiting for scan'), 14, 82, '#aab3c5', 6);
    text(ctx, 'resting orders, never crossing', 14, 90, '#5b6270', 5);
    // The ledger survives a restart but the last-fill detail does not, so "no fills yet" next to a
    // screen reading 11 FILLS is a contradiction the reader has no way to resolve. Say which.
    const lf = M.lastFill;
    const fillTop = lf ? `last fill ${ago(lf.at)}` : (M.fills ? `${M.fills} fills before restart` : 'no fills yet');
    text(ctx, fillTop, 14, 100, lf || M.fills ? '#c7cdd8' : '#5b6270', 6);
    text(ctx, lf ? `${lf.side === 'buy' ? 'bought' : 'sold'} ${lf.qty} @ ${cents(lf.px)}`
      : (M.fills ? 'waiting for the next one' : 'waiting to be traded against'), 14, 108, '#7c869a', 5);

    // ---- wall screen : the book itself
    px(ctx, 136, 8, 208, 100, '#1a2030'); px(ctx, 140, 12, 200, 92, '#060910');
    text(ctx, `MAKER DESK 07 · ${S.mode.toUpperCase()}`, 144, 15, '#c7cdd8', 6);
    text(ctx, `${M.fills || 0} FILLS`, 336, 15, '#7c869a', 6, 'right');
    // three numbers, and they mean different things on purpose
    const cols = [['BANKED', banked, 'from spread'], ['ON INVENTORY', marked, `${M.inv || 0} contracts`], ['NET', mEq, 'if closed now']];
    cols.forEach(([lab, v, sub], i) => {
      const cx = 168 + i * 68;
      text(ctx, lab, cx, 25, '#5b6270', 5, 'center');
      text(ctx, signed(v), cx, 32, v >= 0 ? '#22c55e' : '#ef4444', 9, 'center');
      text(ctx, sub, cx, 43, '#4b5563', 5, 'center');
    });
    px(ctx, 144, 50, 192, 1, '#141b28');
    // the markets we are actually quoting
    const book = (M.markets || []).filter((m) => m.quoting || m.inv).slice(0, 6);
    text(ctx, 'MARKET', 144, 54, '#4b5563', 5);
    text(ctx, 'BID', 258, 54, '#4b5563', 5, 'right');
    text(ctx, 'ASK', 286, 54, '#4b5563', 5, 'right');
    text(ctx, 'HELD', 336, 54, '#4b5563', 5, 'right');
    book.forEach((m, i) => {
      const y = 63 + i * 7;
      px(ctx, 144, y + 1, 3, 3, m.quoting ? '#22c55e' : '#3d4350');
      text(ctx, m.ticker.replace(/^KX/, '').slice(0, 24), 150, y, m.quoting ? '#aab3c5' : '#5b6270', 5);
      text(ctx, m.bid == null ? '—' : cents(m.bid), 258, y, '#7c869a', 5, 'right');
      text(ctx, m.ask == null ? '—' : cents(m.ask), 286, y, '#7c869a', 5, 'right');
      text(ctx, m.inv ? String(m.inv) : '·', 336, y, m.inv > 0 ? '#22c55e' : m.inv < 0 ? '#ef4444' : '#3d4350', 5, 'right');
    });
    if (!book.length) text(ctx, M.quoting ? 'quoting — no inventory yet' : 'scanning for markets…', 240, 74, '#3d4350', 6, 'center');
    px(ctx, 236, 108, 8, 8, '#1a2030'); // mount
    // the strip between the screen and the floor line is 10px tall and 200px wide; anything longer
    // than this ran straight through both side boards
    text(ctx, halted ? String(halted).toUpperCase().slice(0, 30) : 'PAPER · NO REAL MONEY',
      240, 112, halted ? '#ef4444' : '#4b5563', 5, 'center');

    // ---- clock + how it picks markets (right)
    px(ctx, 372, 10, 98, 20, '#0b1018'); px(ctx, 372, 10, 98, 1, '#26304a');
    text(ctx, new Date(S.now).toTimeString().slice(0, 8), 421, 14, working ? '#22c55e' : '#7c869a', 10, 'center');
    text(ctx, `UP ${dur(S.now - S.startedAt)}`, 466, 22, '#4b5563', 5, 'right');
    px(ctx, 372, 36, 98, 78, '#0a1710'); px(ctx, 372, 36, 98, 1, '#1e4a2c'); px(ctx, 372, 113, 98, 1, '#1e4a2c');
    text(ctx, 'HOW IT PICKS', 376, 39, '#86efac', 6);
    [
      '- fee-free series only',
      `- queue must clear < ${S.cfg.makerMaxClearDays ?? 1}d`,
      `- min ${S.cfg.makerMinTradesPerDay ?? 10} trades/day`,
      `- top ${S.cfg.makerMarkets ?? 24} by queue speed`,
      `- ${M.tracked || 0} tracked, ${M.quoting || 0} live`,
      `- scanned ${ago(M.lastScanAt)}`,
      halted ? '! TRADING STOPPED' : '- rails clear',
    ].forEach((l, i) => text(ctx, l, 376, 48 + i * 10, i === 6 && halted ? '#f87171' : '#4ade80', 6));

    // desks + agents
    // advance the shared clock between SSE frames so the stagger animates smoothly
    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
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
      // speech bubble (front row speaks to the right of the desk so it never covers the back row)
      if (act && a.note) {
        const s = a.note.length > 30 ? a.note.slice(0, 29) + '…' : a.note;
        ctx.font = '6px JetBrains Mono, monospace'; const w = Math.ceil(ctx.measureText(s).width) + 6;
        const back = i < 3;
        const by2 = back ? y - 28 : y + 14;
        let lx = back ? Math.min(Math.max(bx - w / 2, 2), 478 - w) : Math.min(bx + 12, 478 - w);
        px(ctx, lx, by2, w, 9, '#e6e8ee');
        if (back) px(ctx, bx - 1, by2 + 9, 2, 2, '#e6e8ee'); else px(ctx, bx + 9, by2 + 4, 3, 2, '#e6e8ee');
        text(ctx, s, lx + 3, by2 + 2, '#0a0b0d', 6);
      }
    });
    // server rack + plant flavour
    px(ctx, 440, 130, 26, 60, '#12161e'); for (let i = 0; i < 6; i++) { px(ctx, 443, 134 + i * 9, 20, 6, '#0a0d13'); px(ctx, 459, 136 + i * 9, 2, 2, (Math.floor(t * 4) + i) % 3 ? '#22c55e' : '#0f3a1f'); }
    px(ctx, 16, 150, 12, 24, '#2a2219'); px(ctx, 10, 134, 24, 18, '#1a4d2e'); px(ctx, 14, 128, 16, 10, '#236b3d');
  }
  function loop(ts) { drawFloor(ts / 1000); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ wiring
  function render() { renderHeader(); renderMaker(); renderLog(); renderFeed(); renderAgents(); renderPositions(); drawBalance(); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
  window.addEventListener('resize', () => S && drawBalance());
})();

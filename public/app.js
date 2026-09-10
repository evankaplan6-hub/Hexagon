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
  function renderTiles() {
    const pnl = S.equity - S.initial;
    $('t-bal').textContent = money(S.equity);
    $('t-bal-s').textContent = `initial ${money(S.initial)} · cash ${money(S.cash)}`;
    const tp = $('t-pnl'); tp.textContent = signed(pnl); tp.className = `tv ${pnl >= 0 ? 'pos' : 'neg'}`;
    $('tile-pnl').className = `tile pnl ${pnl >= 0 ? '' : 'neg'}`;
    $('t-pnl-s').innerHTML = `realized <b class="${S.realized >= 0 ? 'pos' : 'neg'}">${signed(S.realized)}</b> · open ${signed(S.unrealized)} · fees ${money(S.fees)}`;
    $('t-dep').textContent = money(S.deployed);
    $('t-dep-s').textContent = `${S.positions.length} position${S.positions.length === 1 ? '' : 's'} · ${S.equity ? Math.round(S.deployed / S.equity * 100) : 0}% of equity`;
    const n = S.wins + S.losses;
    $('t-win').textContent = n ? `${(S.wins / n * 100).toFixed(1)}%` : '—';
    $('t-win-s').textContent = `${S.wins}W / ${S.losses}L`;
  }

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
  const floor = $('floorc').getContext('2d');
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
    const ctx = floor; ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, 480, 200);
    // room
    const wall = ctx.createLinearGradient(0, 0, 0, 120); wall.addColorStop(0, '#0d1220'); wall.addColorStop(1, '#101828'); ctx.fillStyle = wall; ctx.fillRect(0, 0, 480, 120);
    px(ctx, 0, 120, 480, 80, '#0a0d13'); px(ctx, 0, 119, 480, 2, '#1c2434');
    for (let x = 0; x < 480; x += 24) px(ctx, x, 120, 1, 80, '#0f131b');
    for (let y = 132; y < 200; y += 14) px(ctx, 0, y, 480, 1, '#0f131b');
    if (!S) { text(ctx, 'CONNECTING TO THE DESK…', 240, 96, '#4b5563', 8, 'center'); return; }

    // emblem
    hexagon(ctx, 58, 36, 22, '#7c869a'); hexagon(ctx, 58, 36, 14, '#7c869a'); hexagon(ctx, 58, 36, 6, '#7c869a', true);
    text(ctx, 'THE', 58, 62, '#9aa3b5', 7, 'center'); text(ctx, 'HEXAGON', 58, 70, '#c7cdd8', 8, 'center');
    // pairs board (left)
    px(ctx, 10, 84, 108, 32, '#0b1018'); px(ctx, 10, 84, 108, 1, '#26304a'); px(ctx, 10, 115, 108, 1, '#26304a');
    text(ctx, 'VENUE GAPS', 14, 86, '#6b7a99', 6);
    S.pairs.slice(0, 3).forEach((p, i) => { text(ctx, p.label.slice(0, 16), 14, 94 + i * 7, '#aab3c5', 6); text(ctx, `${p.gap >= 0 ? '+' : '-'}${cents(p.gap)}`, 114, 94 + i * 7, Math.abs(p.gap) >= S.cfg.minGap ? '#d4a72c' : '#7c869a', 6, 'right'); });
    if (!S.pairs.length) text(ctx, 'scanning…', 14, 96, '#5b6270', 6);

    // wall screen
    px(ctx, 136, 8, 208, 100, '#1a2030'); px(ctx, 140, 12, 200, 92, '#060910');
    const top = S.pairs[0];
    text(ctx, top ? top.label.toUpperCase().slice(0, 34) : 'NO PAIRS MATCHED', 144, 15, '#c7cdd8', 6);
    text(ctx, top ? `PM ${top.pmMid.toFixed(3)}   KS ${top.ksMid.toFixed(3)}   GAP ${cents(top.gap)}` : '', 144, 23, '#7c869a', 6);
    for (let i = 1; i < 5; i++) px(ctx, 144, 32 + i * 13, 192, 1, '#111826');
    if (top && top.hist.length > 1) {
      series(ctx, top.hist.map((h) => h[0]), 146, 34, 188, 60, '#3b82f6');
      series(ctx, top.hist.map((h) => h[1]), 146, 34, 188, 60, '#d4a72c');
      px(ctx, 146, 98, 5, 3, '#3b82f6'); text(ctx, 'POLYMARKET', 153, 96, '#7c869a', 6); px(ctx, 206, 98, 5, 3, '#d4a72c'); text(ctx, 'KALSHI', 213, 96, '#7c869a', 6);
    } else text(ctx, 'collecting price history…', 240, 60, '#3d4350', 7, 'center');
    px(ctx, 236, 108, 8, 8, '#1a2030'); // mount
    const pnl = S.equity - S.initial;
    text(ctx, `DESK P&L ${signed(pnl)} · EQUITY ${money(S.equity)} · ${S.pairCount} PAIRS · ${S.positions.length} OPEN`, 240, 110, pnl >= 0 ? '#22c55e' : '#ef4444', 6, 'center');

    // clock + mandate (right)
    px(ctx, 372, 10, 98, 20, '#0b1018'); px(ctx, 372, 10, 98, 1, '#26304a');
    text(ctx, new Date(S.now).toISOString().slice(11, 19), 421, 14, '#22c55e', 10, 'center'); text(ctx, 'UTC', 466, 22, '#4b5563', 5, 'right');
    px(ctx, 372, 36, 98, 78, '#0a1710'); px(ctx, 372, 36, 98, 1, '#1e4a2c'); px(ctx, 372, 113, 98, 1, '#1e4a2c');
    const day = Math.floor((S.now - S.startedAt) / 86400000) + 1;
    text(ctx, `DAY ${day} MANDATE`, 376, 39, '#86efac', 6);
    [`- MODE ${S.mode.toUpperCase()}${S.demo ? ' DEMO' : ''}`, `- MIN GAP ${cents(S.cfg.minGap)} / EDGE ${cents(S.cfg.minEdge)}`, `- ARB EDGE ${cents(S.cfg.minArbEdge)}`, `- EXIT ${cents(S.cfg.exitGap)} · STOP ${cents(S.cfg.stopLoss)}`, `- ${Math.round(S.cfg.maxPositionPct * 100)}% PER POS · MAX ${S.cfg.maxOpenPositions}`, `- DAY DD LIMIT ${(S.cfg.maxDailyDrawdownPct * 100).toFixed(0)}%`, S.halt ? `! ${S.halt.toUpperCase().slice(0, 22)}` : '- WINDOW CLEAN'].forEach((l, i) => text(ctx, l, 376, 48 + i * 10, i === 5 && S.halt ? '#f87171' : '#4ade80', 6));

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
  function render() { renderHeader(); renderTiles(); renderMaker(); renderLog(); renderFeed(); renderAgents(); renderPositions(); drawBalance(); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
  window.addEventListener('resize', () => S && drawBalance());
})();

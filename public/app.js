/* The Hexagon — dashboard client. Consumes the SSE state stream and renders everything. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let S = null;

  // ------------------------------------------------------------ formatting
  const money = (x, d = 2) => `$${Math.abs(x).toLocaleString(undefined, { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const signed = (x, d = 2) => `${x >= 0 ? '+' : '-'}${money(x, d)}`;
  const r2 = (x) => Math.round(x * 100) / 100;
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
    const M = S.maker || {}, P = S.pnl || {};
    const halted = S.halt || M.halted;
    // The pill is the headline: one word for the state, then whose money is at risk. The counts
    // beside it are reference -- they are set to look like reference so the eye can skip them.
    const [state, cls] = stale() ? ['No signal', 'bad'] : halted ? ['Stopped', 'bad']
      : M.quoting > 0 ? ['Working', 'good'] : ['Idle', 'warn'];
    const pill = $('deskstate');
    pill.className = `pill ${cls}`;
    pill.innerHTML = `<i></i>${esc(state)}` +
      (halted ? `<span class="why">${esc(String(halted))}</span>` : '') +
      `<span class="mode${S.mode === 'live' ? ' real' : ''}">${S.mode === 'live' ? 'LIVE · real money' : 'Paper'}</span>` +
      (S.demo ? `<span class="mode demo">Demo quotes</span>` : '');
    const fact = (k, v, c) => `<span>${k}<b class="${c || ''}">${v}</b></span>`;
    $('meta').innerHTML =
      fact('day', day) + fact('pairs', S.pairCount) + fact('open', S.positions.length) +
      fact('locked', Number.isFinite(P.arbLocked) ? signed(P.arbLocked) : '—', P.arbLocked >= 0 ? 'pos' : 'neg') +
      (P.integrityAlerts ? `<span class="alertfact">alerts<b>${P.integrityAlerts}</b></span>` : '');
  }

  // A phone is not a tiny desktop trading floor. Put the four things a person opens the page for
  // into normal HTML type: current maker P&L, market/inventory counts, the last fill, and which
  // desks are awake. The illustrated room is intentionally left to larger screens, where its
  // boards and click targets have enough physical size to work.
  let mobileInfo = null;
  let mobileSort = 'size';
  function mobileInfoPanel(M) {
    if (!mobileInfo) return '';
    let title = '', note = '', rows = [];
    if (mobileInfo === 'quoting') {
      let markets = (M.markets || []).filter((m) => m.quoting);
      if (mobileSort === 'name') markets.sort((a, b) => String(OUTCOME(a) || QUESTION(a) || a.ticker).localeCompare(String(OUTCOME(b) || QUESTION(b) || b.ticker)));
      else markets.sort((a, b) => (b.tpd || 0) - (a.tpd || 0));
      title = `Quoting ${markets.length} market${markets.length === 1 ? '' : 's'}`;
      note = 'The prices where the maker is currently offering to trade.';
      rows = markets.map((m) => {
        const px = m.bid == null && m.ask == null ? 'waiting for prices'
          : `${m.bid == null ? '—' : cc(m.bid)} bid · ${m.ask == null ? '—' : cc(m.ask)} ask`;
        return `<li><div><b>${esc(OUTCOME(m) || QUESTION(m) || m.ticker)}</b>` +
          `${OUTCOME(m) && QUESTION(m) ? `<small>${esc(QUESTION(m))}</small>` : ''}</div>` +
          `<span>${px}${m.tpd != null ? `<small>${m.tpd.toLocaleString()}/day</small>` : ''}</span></li>`;
      });
    } else if (mobileInfo === 'holding') {
      let markets = (M.markets || []).filter((m) => m.inv);
      if (mobileSort === 'name') markets.sort((a, b) => String(OUTCOME(a) || QUESTION(a) || a.ticker).localeCompare(String(OUTCOME(b) || QUESTION(b) || b.ticker)));
      else if (mobileSort === 'pnl') markets.sort((a, b) => ((b.mark || 0) - (b.cost || 0)) - ((a.mark || 0) - (a.cost || 0)));
      else if (mobileSort === 'loss') markets.sort((a, b) => ((a.mark || 0) - (a.cost || 0)) - ((b.mark || 0) - (b.cost || 0)));
      else markets.sort((a, b) => Math.abs(b.inv) - Math.abs(a.inv));
      title = `Holding ${markets.length} market${markets.length === 1 ? '' : 's'}`;
      note = `${(+M.inv || 0).toLocaleString()} contracts in the book right now.`;
      rows = markets.map((m) => {
        const pl = r2((m.mark || 0) - (m.cost || 0));
        return `<li><div><b>${esc(OUTCOME(m) || QUESTION(m) || m.ticker)}</b>` +
          `${OUTCOME(m) && QUESTION(m) ? `<small>${esc(QUESTION(m))}</small>` : ''}</div>` +
          `<span class="${pl >= 0 ? 'pos' : 'neg'}">${m.inv > 0 ? 'Long' : 'Short'} ${Math.abs(m.inv).toLocaleString()}<small>${signed(pl)} marked</small></span></li>`;
      });
    } else {
      let fills = recentFills(M);
      if (mobileSort === 'size') fills.sort((a, b) => (+b.qty || 0) - (+a.qty || 0));
      else if (mobileSort === 'name') fills.sort((a, b) => fillName(a).localeCompare(fillName(b)));
      title = 'Recent fills';
      note = 'Maker and cross-venue entries and closes, newest first.';
      rows = fills.map((f) => `<li><div><b>${esc(fillName(f))}</b><small>${ago(f.at)} · ${f.source === 'maker' ? 'maker' : f.venue}</small></div>` +
        `<span class="${f.side === 'buy' ? 'pos' : 'neg'}">${esc(f.action)} ${(+f.qty || 0).toLocaleString()}<small>at ${cc(f.px)}${f.pnl == null ? '' : ` · ${signed(f.pnl)}`}</small></span></li>`);
    }
    const sorts = mobileInfo === 'holding' ? [['size', 'Largest'], ['pnl', 'Gainers'], ['loss', 'Losers'], ['name', 'Name']] : [['size', mobileInfo === 'quoting' ? 'Flow' : 'Size'], ['name', 'Name']];
    return `<section class="m-detail" id="mobile-detail"><div class="m-detail-head"><div><b>${title}</b><small>${note}</small></div>` +
      `<button type="button" data-mobile-close="1" aria-label="Close ${mobileInfo} details">✕</button></div>` +
      `<div class="m-sort" role="toolbar" aria-label="Sort ${mobileInfo} list">${sorts.map(([k, l]) => `<button type="button" data-mobile-sort="${k}" class="${mobileSort === k ? 'on' : ''}">${l}</button>`).join('')}</div>` +
      (rows.length ? `<ol>${rows.join('')}</ol>` : `<p>Nothing to show yet.</p>`) + `</section>`;
  }

  function renderMobileSummary() {
    const el = $('mobile-summary'), M = S.maker || {};
    if (!el) return;
    const halted = S.halt || M.halted, gone = stale(), working = !halted && M.quoting > 0;
    const [state, cls] = gone ? ['No signal', 'bad'] : halted ? ['Stopped', 'bad'] : working ? ['Working', 'good'] : ['Idle', 'warn'];
    const makerNet = Number.isFinite(M.equity) && Number.isFinite(M.initial) ? M.equity - M.initial : null;
    const pairNet = Number.isFinite(S.equity) && Number.isFinite(S.initial) ? S.equity - S.initial : null;
    const net = makerNet == null || pairNet == null ? null : r2(makerNet + pairNet);
    const held = (M.markets || []).filter((m) => m.inv).length;
    const lf = recentFills(M)[0] || null;
    const agents = (S.agents || []).filter((a) => a.key !== 'MAKR').map((a) => {
      const on = isActive(a);
      return `<span class="m-agent${on ? ' on' : ''}" style="--agent:${a.color || '#6b7384'}"><i></i>${esc(a.key)}</span>`;
    }).join('');
    const latest = lf
      ? `<div class="m-fill"><div><span class="m-label">Latest fill</span><b>${esc(lf.action)} ${lf.qty} at ${cc(lf.px)}</b></div>` +
        `<p>${esc(fillName(lf))}<small>${ago(lf.at)} · ${lf.source === 'maker' ? 'maker' : lf.venue}</small></p></div>`
      : `<div class="m-fill empty"><div><span class="m-label">Latest fill</span><b>${M.fills ? `${M.fills} before restart` : 'No fills yet'}</b></div></div>`;
    el.innerHTML = `<div class="m-hero"><div><span class="m-label">All paper trades</span>` +
      `<strong class="${net != null && net < 0 ? 'neg' : 'pos'}">${net == null ? '—' : signed(net)}</strong>` +
      `<small>${net == null ? 'Waiting for a mark' : `Maker ${signed(makerNet)} · Cross-venue ${signed(pairNet)}`}</small></div>` +
      `<span class="m-state ${cls}"><i></i>${esc(state)}<small>${S.mode === 'live' ? 'REAL MONEY' : 'PAPER'}</small></span></div>` +
      `<div class="m-stats">` +
      `<button type="button" data-mobile-info="quoting" aria-expanded="${mobileInfo === 'quoting'}" aria-controls="mobile-detail" class="${mobileInfo === 'quoting' ? 'on' : ''}"><span>Quoting</span><b>${M.quoting || 0}</b><small>markets</small><i>›</i></button>` +
      `<button type="button" data-mobile-info="holding" aria-expanded="${mobileInfo === 'holding'}" aria-controls="mobile-detail" class="${mobileInfo === 'holding' ? 'on' : ''}"><span>Maker held</span><b>${(+M.inv || 0).toLocaleString()}</b><small>in ${held}</small><i>›</i></button>` +
      `<button type="button" data-mobile-info="fills" aria-expanded="${mobileInfo === 'fills'}" aria-controls="mobile-detail" class="${mobileInfo === 'fills' ? 'on' : ''}"><span>Recent fills</span><b>${recentFills(M).length.toLocaleString()}</b><small>shown</small><i>›</i></button></div>` +
      mobileInfoPanel(M) + `<div id="mobile-chart" class="pnl m-chart" aria-label="Mobile P&amp;L chart"></div>` + latest + `<div class="m-agents"><span class="m-label">Desks</span><div>${agents}</div></div>`;
    const chartEl = $('mobile-chart');
    if (chartEl) { delete chartEl.dataset.built; drawChart(chartEl, false); wireChart(chartEl, false); }
  }
  $('mobile-summary').addEventListener('click', (ev) => {
    const sort = ev.target.closest('[data-mobile-sort]');
    if (sort) { mobileSort = sort.dataset.mobileSort; renderMobileSummary(); return; }
    const tab = ev.target.closest('[data-mobile-info]');
    if (tab) mobileInfo = mobileInfo === tab.dataset.mobileInfo ? null : tab.dataset.mobileInfo;
    else if (ev.target.closest('[data-mobile-close]')) mobileInfo = null;
    else return;
    renderMobileSummary();
  });
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
      cv.style.cursor = hover ? 'pointer' : 'default';
    });
    cv.addEventListener('mouseleave', () => { hover = null; });
    cv.addEventListener('click', (ev) => {
      const h = hitAt(floorPoint(ev));
      sel = same(h, sel) ? null : h;          // clicking the selected thing again closes it
    });
    // clicking empty floor clears; so does Escape
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { sel = null; chart.band = null; } });
  }

  // Where the room's furniture goes. The room is drawn at a fixed HEIGHT whose width follows the
  // shape of the box the page gives it (floorCtx), so a wide window gets a wide room instead of two
  // black bars down the sides. Everything pinned -- the boards on the wall, the rack, the P&L stand
  // -- is placed from an edge; the desks are a cluster in what is left.
  //
  // The wall used to take 150 of 262 units and the seven desks shared the 112 below it, which is the
  // whole reason the cast was drawn so small. The wall is 118 now: the boards on it are HTML text and
  // lose nothing by being shorter, and every unit the floor gains goes into the size of the bots.
  const ROOM_H = 268, WALL_H = 118, SIDE_W = 112;
  let L = null;
  function layout(RW) {
    if (L && L.RW === RW) return L;
    // the desks live between the P&L stand on the left and the server rack on the right
    const bandL = 132, bandR = RW - 46, band = bandR - bandL, gap = 18;
    // How big a desk MAY be is a question about HEIGHT, not width. The back row, the front row and
    // the front row's nametag all have to fit in the 150 units under the wall, and 1.45 is where the
    // nametag reaches the floor line -- so past a certain width the desks stop growing no matter how
    // much room there is. Widening the room therefore cannot make the cast bigger. What it can do is
    // spread it out: on a 2.8:1 window the desks used to take 70% of the floor they stand on and
    // huddle in the middle of an empty plain. The width the seats cannot use goes into the gap
    // between them instead, up to half a desk, and then stops -- seven desks scattered to the far
    // corners is the same mistake in the other direction.
    const SEAT = Math.max(0.95, Math.min(1.45, (band - 3 * gap) / 256));
    const dw = 64 * SEAT, pitch = Math.min(dw * 1.5, Math.max(dw + gap, (band - dw) / 3));
    // The back row sits a little tighter than the front, for perspective -- but 0.94 of a pitch that
    // is already at its minimum is not perspective, it is two desks touching: the back row was down
    // to a 6-unit gap where the front had 12. The nudge only applies to a pitch that can afford it.
    const backPitch = Math.max(dw + gap, pitch * 0.94);
    const backY = Math.round(WALL_H + 4 + 16 * SEAT), frontY = Math.round(backY + 43 * SEAT);
    // centre the row on the room, then slide it inside the band if it does not fit there
    const row = (n, y, p) => {
      const w = (n - 1) * p + dw;
      const x0 = Math.round(Math.max(bandL, bandL + (band - w) / 2));
      return Array.from({ length: n }, (_, i) => [x0 + Math.round(i * p), y]);
    };
    L = {
      RW, SEAT, dw, pitch,
      seats: [...row(3, backY, backPitch), ...row(4, frontY, pitch)],
      // A desk's cell: its highlight and its click target. 72 desk-units was hard-coded and the back
      // row's pitch is smaller than that, so the two boxes overlapped -- the hover pool bled onto the
      // neighbour's desk and a click in the overlap picked whichever bot was tested last. Never wider
      // than the row it is in.
      cell: [0, 1, 2].map(() => Math.min(72, backPitch / SEAT - 2)).concat([0, 1, 2, 3].map(() => Math.min(72, pitch / SEAT - 2))),
      status: { x: 8, y: 6, w: SIDE_W, h: WALL_H - 26 },
      clock:  { x: RW - SIDE_W - 8, y: 6, w: SIDE_W, h: 22 },
      tape:   { x: RW - SIDE_W - 8, y: 32, w: SIDE_W, h: WALL_H - 52 },
      // the glass stops 20 units short of the floor line: that strip is where the back row's bubbles
      // go, and it is the only reason a bubble can no longer cover the number it is talking about
      screen: { x: 134, y: 2, w: RW - 268, h: WALL_H - 26 },
      // the stand starts just under the wall: the 24 units above it were empty floor that no
      // desk can use (the desks start at bandL), and the plot is the one board that wants height
      chart:  { x: 4, y: WALL_H + 10, w: 124, h: ROOM_H - WALL_H - 14 },
      rack:   { x: RW - 40, y: WALL_H + 38, w: 26, h: 60 },
    };
    return L;
  }
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
    ILSA: "reads price moves, and what Polymarket's top bettors just bought",
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
  //
  // A few series put a whole question in `sub` ("Will Democrats hold 235 or more seats in the House
  // AND hold 51 or more seats in the Senate?"). Nothing on the floor truncates text any more, so a
  // name that long wraps to four lines; squeeze the prose instead: "Democrats 235+ House & 51+ Senate".
  const OUTCOME = (m) => {
    const t = (m.sub || '').trim();
    if (t.length <= 40) return t;
    return t.replace(/^Will\s+/i, '').replace(/\?$/, '')
      .replace(/\s+or more\b/gi, '+').replace(/\bseats in the\s+/gi, '').replace(/\b(hold|have|be)\s+/gi, '')
      .replace(/\s+AND\s+/g, ' & ').replace(/\s+/g, ' ').trim();
  };
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
  // The room's width is not fixed. Deriving it from the box's own shape is what removed the two
  // black bars: at 1512px the old 480-wide room letterboxed nearly 300px away, and every one of
  // those pixels is now floor the desks can stand on.
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
    ctx.fillStyle = '#0b0e14'; ctx.fillRect(0, 0, w, h);       // paint the letterbox
    const scale = Math.min(w / RW, h / ROOM_H);
    floorBox.scale = scale / dpr;                              // css px per drawing unit
    floorBox.ox = (w - RW * scale) / 2 / dpr;
    floorBox.oy = (h - ROOM_H * scale) / 2 / dpr;
    ctx.setTransform(scale, 0, 0, scale, (w - RW * scale) / 2, (h - ROOM_H * scale) / 2);
    return ctx;
  }

  function drawFloor(t) {
    const ctx = floorCtx(); ctx.imageSmoothingEnabled = false;
    layout(RW);
    const VPX = RW / 2;
    ctx.clearRect(0, 0, RW, ROOM_H);   // the letterbox is repainted in floorCtx
    hits = [];                               // rebuilt every frame; the pointer tests against them
    // ---- the room -----------------------------------------------------------------------------
    // wall: darker at the corners, lifting toward the middle where the big screen hangs
    const wall = ctx.createLinearGradient(0, 0, 0, WALL_H);
    wall.addColorStop(0, '#080b14'); wall.addColorStop(0.55, '#0e1422'); wall.addColorStop(1, '#121a2b');
    ctx.fillStyle = wall; ctx.fillRect(0, 0, RW, WALL_H);
    // floor: a gradient away from the wall, so the far edge reads as further away
    const flr = ctx.createLinearGradient(0, WALL_H, 0, ROOM_H);
    flr.addColorStop(0, '#0c1017'); flr.addColorStop(1, '#070910');
    ctx.fillStyle = flr; ctx.fillRect(0, WALL_H, RW, ROOM_H - WALL_H);
    px(ctx, 0, WALL_H - 1, RW, 1, '#243047'); px(ctx, 0, WALL_H, RW, 1, '#161d2b');   // skirting
    // Perspective grid. Verticals converge on a vanishing point behind the wall screen and
    // horizontals space out toward us, so the floor reads as depth rather than graph paper.
    ctx.save(); ctx.globalAlpha = 0.5;
    const cols = Math.ceil(RW / 24);
    for (let i = -cols; i <= cols; i++) {
      ctx.strokeStyle = '#131a26'; ctx.lineWidth = 0.5;
      ctx.beginPath(); ctx.moveTo(VPX + i * 13, WALL_H); ctx.lineTo(VPX + i * 46, ROOM_H); ctx.stroke();
    }
    for (let k = 1, y = WALL_H; y < ROOM_H; k++) { y = WALL_H + Math.pow(k, 1.55) * 3.1; px(ctx, 0, y, RW, 0.5, '#141c29'); }
    ctx.restore();
    if (!S) { text(ctx, 'CONNECTING TO THE DESK', VPX, WALL_H / 2, '#4b5563', 8, 'center'); return; }

    // The room is lit by its own screens: a wide cool pool from the wall display and two smaller
    // ones from the side boards. This is what stops the floor reading as a flat black rectangle.
    glow(ctx, VPX, 58, Math.max(210, RW * 0.42), '#1b3a6b', 0.55);
    glow(ctx, 64, 80, 95, '#14304f', 0.30);
    glow(ctx, RW - 64, 70, 95, '#123d2a', 0.30);

    // ---- everything below is the MAKER desk, because the maker desk is the one that trades ----
    const M = S.maker || {};
    const halted = S.halt || M.halted;
    // ---- status board (left) : the "is it working" answer, in words
    // The board is drawn here; its words are HTML laid over it (placeStatus), for the same reason
    // as the bubbles -- 5-unit canvas text was unreadable and its lines ran into each other.
    panel(ctx, L.status.x, L.status.y, L.status.w, L.status.h, '#080c14', '#243047');
    scanlines(ctx, L.status.x + 1, L.status.y + 1, L.status.w - 2, L.status.h - 2, 0.10);
    statusBox = L.status;

    // ---- wall screen : the book, or whatever you clicked on
    // bezel, then glass. A single flat rect read as a hole in the wall; a lit top edge and a
    // shadowed bottom make it an object hanging on it. It is as wide as the room allows now --
    // the desk's own number is the biggest thing in the frame, which is what a scoreboard is for.
    const ws = L.screen, gx = ws.x + 6, gy = ws.y + 6, gw = ws.w - 12, gh = ws.h - 12;
    px(ctx, ws.x, ws.y, ws.w, ws.h, '#0a0e17');
    px(ctx, ws.x, ws.y, ws.w, 1, '#2c3a55'); px(ctx, ws.x, ws.y + ws.h - 1, ws.w, 1, '#04060a');
    px(ctx, ws.x, ws.y, 1, ws.h, '#222d42'); px(ctx, ws.x + ws.w - 1, ws.y, 1, ws.h, '#04060a');
    px(ctx, gx, gy, gw, gh, '#050810');
    const glass = ctx.createLinearGradient(0, gy, 0, gy + gh);
    glass.addColorStop(0, 'rgba(70,120,190,0.10)'); glass.addColorStop(1, 'rgba(70,120,190,0.02)');
    ctx.fillStyle = glass; ctx.fillRect(gx, gy, gw, gh);

    // The screen's words are HTML (placeBoards): the canvas draws only the glass and its light.
    if (sel && sel.kind === 'market' && !sel.at && !(M.markets || []).some((x) => x.ticker === sel.key)) sel = null;
    if (sel && sel.kind === 'agent' && !S.agents.some((x) => x.key === sel.key)) sel = null;
    wallBox = { x: gx, y: gy, w: gw, h: gh };
    scanlines(ctx, gx, gy, gw, gh, 0.16);
    glow(ctx, VPX, gy + 16, Math.max(120, gw * 0.4), '#1e4e8a', 0.18);              // the screen lighting itself
    px(ctx, VPX - 3, ws.y + ws.h, 6, 5, '#141b28'); px(ctx, VPX - 9, ws.y + ws.h + 3, 18, 2, '#0d1420');   // wall mount

    // ---- clock + the fill tape (right): boards drawn here, words laid over them (placeBoards)
    panel(ctx, L.clock.x, L.clock.y, L.clock.w, L.clock.h, '#080c14', '#243047');
    clockBox = L.clock;
    panel(ctx, L.tape.x, L.tape.y, L.tape.w, L.tape.h, '#060f0a', '#1e4a2c');
    scanlines(ctx, L.tape.x + 1, L.tape.y + 1, L.tape.w - 2, L.tape.h - 2, 0.12);
    tapeBox = L.tape;

    // desks + agents
    // advance the shared clock between SSE frames so the stagger animates smoothly
    S.now = Math.max(S.now, (S._rx || 0) + (performance.now() - (S._rxPerf || performance.now())));
    const labels = [], wires = [];
    S.agents.forEach((a, i) => {
      const seat = L.seats[i];
      if (!seat) return;                     // more agents than seats: skip rather than throw
      const [x, y] = seat, Z = L.SEAT;
      const act = isActive(a);
      // the whole desk is the target, not just the blob -- a 14px character is not a click target,
      // but the cell is bounded by the row's pitch so two neighbours can never both own a point
      const cw = L.cell[i], cx = (64 - cw) / 2;
      hits.push({ x: x + cx * Z, y: y - 18 * Z, w: cw * Z, h: 60 * Z, kind: 'agent', key: a.key });
      const hot = (hover && hover.kind === 'agent' && hover.key === a.key);
      const picked = (sel && sel.kind === 'agent' && sel.key === a.key);
      // Every animation means the desk's real job. They only light while that agent's
      // engine step is current, and KETT's order packet appears only for a real FILL.
      const latest = (S.log || []).find((e) => e.agent === a.key);
      const beat = (Math.sin(t * 7 + i * 1.7) + 1) / 2;
      const bob = act ? Math.round(Math.sin(t * 9 + i) * 1.5) : 0;

      // One desk is drawn once, at the origin, and the room decides how big it is. Everything from
      // here to the restore() is in DESK units -- that is what lets the cast grow with the window
      // without every coordinate below being rewritten.
      ctx.save();
      ctx.translate(x, y); ctx.scale(Z, Z);
      if (hot || picked) {
        // a soft pool of the agent's own colour, so the highlight reads as light rather than a box
        ctx.save(); ctx.globalAlpha = picked ? 0.16 : 0.09; px(ctx, cx, -18, cw, 60, a.color); ctx.restore();
        if (picked) { px(ctx, cx, -18, cw, 1, a.color); px(ctx, cx, 41, cw, 1, a.color); }
      }
      // contact shadow first, so everything above it sits ON the floor rather than floating
      shadow(ctx, 2, 26, 60, 10, 0.45);
      // monitor: bezel, screen, and its own light thrown back onto the desk
      px(ctx, 12, -16, 40, 24, '#1a2029'); px(ctx, 12, -16, 40, 1, '#2f3a4c');
      px(ctx, 14, -14, 36, 20, '#04070c');
      for (let j = 0; j < 9; j++) { const hgt = 3 + Math.round(hash(i, j, Math.floor(a.runs / 2)) * 12); px(ctx, 16 + j * 4, 4 - hgt, 3, hgt, act ? a.color : '#1e2836'); }
      scanlines(ctx, 14, -14, 36, 20, 0.22);
      if (act) glow(ctx, 32, -4, 30, a.color, 0.20);
      px(ctx, 30, 8, 4, 3, '#1a2029');
      if (act && Math.floor(t * 6) % 2) px(ctx, 47, -12, 2, 2, a.color);
      // The sweep and the pulses are things happening ON a screen, so they have to fit on it. The
      // glass is 36x20 at (14,-14); a radius-12 arc centred at -8 needed 24 of those 20 units and
      // climbed straight out of the bezel onto the desk behind -- from a chair it read as a stray
      // line lying across two desks. Both are centred on the glass now and sized to stay inside it.
      if (act && a.key === 'HOLT') { // scanner sweep
        ctx.save(); ctx.strokeStyle = a.color; ctx.globalAlpha = 0.65; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(32, -4, 7, -Math.PI / 2, -Math.PI / 2 + beat * Math.PI * 2); ctx.stroke(); ctx.restore();
      }
      if (act && a.key === 'ILSA') { // incoming-flow pulses
        for (let n = 0; n < 3; n++) { const r = 2 + ((beat * 6 + n * 2) % 6); ctx.save(); ctx.globalAlpha = 0.35 - n * 0.08; ctx.strokeStyle = a.color; ctx.beginPath(); ctx.arc(32, -4, r, 0, Math.PI * 2); ctx.stroke(); ctx.restore(); }
      }
      if (act && a.key === 'RIGO') { // settlement ledger strokes
        px(ctx, 17, -11, 8 + Math.round(beat * 8), 1, latest && latest.pnl < 0 ? '#ef4444' : '#22c55e');
        px(ctx, 17, -8, 14 - Math.round(beat * 5), 1, '#5b6270');
      }
      if (act && a.key === 'TESS') { // the risk beacon always has a state
        const risk = halted ? '#ef4444' : '#ec4899'; px(ctx, 4, 3, 3, 3, risk); glow(ctx, 5, 4, 8, risk, 0.5 + beat * 0.3);
      }
      if (act && a.key === 'MAKR') { // two-sided maker quotes blink independently
        px(ctx, 18, -12, 4, 2, '#22c55e'); px(ctx, 42, -12, 4, 2, '#ef4444');
        if (Math.floor(t * 5) % 2) px(ctx, 26, -10, 12, 1, '#a855f7');
      }
      // desk: lit top edge, dark front face, legs
      px(ctx, 0, 11, 64, 9, '#33291d'); px(ctx, 0, 11, 64, 1, '#6b5942'); px(ctx, 0, 19, 64, 1, '#1b150e');
      px(ctx, 2, 20, 4, 8, '#221b13'); px(ctx, 58, 20, 4, 8, '#221b13');
      px(ctx, 24, 30, 16, 5, '#12151b'); px(ctx, 22, 24, 20, 6, '#1a1e27'); px(ctx, 22, 24, 20, 1, '#28303d');
      // blob agent (sits in front of the desk, bobs when active)
      const by = 22 + bob;
      shadow(ctx, 25, by + 3, 14, 5, 0.35);
      ctx.fillStyle = a.color; ctx.beginPath(); ctx.roundRect(25, by - 8, 14, 13, [6, 6, 5, 5]); ctx.fill();
      ctx.save(); ctx.globalAlpha = 0.35; ctx.fillStyle = '#fff';   // rim light off the screens
      ctx.beginPath(); ctx.roundRect(25, by - 8, 14, 4, [6, 6, 0, 0]); ctx.fill(); ctx.restore();
      if (act) glow(ctx, 32, by - 2, 16, a.color, 0.22);
      const blink = Math.floor(t * 1.3 + i * 0.7) % 6 === 0 && ((t * 1.3 + i * 0.7) % 1) < 0.18;
      if (blink) { px(ctx, 28, by - 3, 3, 1, '#fff'); px(ctx, 33, by - 3, 3, 1, '#fff'); }
      else { px(ctx, 28, by - 4, 3, 3, '#fff'); px(ctx, 33, by - 4, 3, 3, '#fff'); px(ctx, 29, by - 3, 1, 1, '#111'); px(ctx, 34, by - 3, 1, 1, '#111'); }
      ctx.restore();

      // The two animations that cross the room belong to the ROOM, not to a desk: they are drawn
      // after every seat so a later desk cannot paint over them.
      if (act && a.key === 'BRAM') wires.push({ kind: 'wire', color: a.color, fx: x + 32 * Z, fy: y - 17 * Z, tx: VPX, ty: ws.y + ws.h });
      if (act && a.key === 'KETT' && latest && latest.kind === 'FILL') {
        wires.push({ kind: 'packet', color: a.color, fx: x + 32 * Z, fy: y - 6 * Z, tx: L.tape.x + L.tape.w / 2, ty: L.tape.y + 30, down: latest.pnl != null && latest.pnl < 0 });
      }
      // where this agent's name and speech bubble go; placeFx lays them over the room as HTML
      labels.push({ key: a.key, bx: x + 32 * Z, by: y + (22 + bob) * Z, top: y - 18 * Z, foot: y + 31 * Z,
        back: i < 3, color: a.color, act, lit: hot || picked, note: a.note, w: 64 * Z });
    });
    for (const w of wires) {
      if (w.kind === 'wire') {
        ctx.save(); ctx.globalAlpha = 0.7; ctx.strokeStyle = w.color; ctx.setLineDash([2, 2]); ctx.lineDashOffset = -t * 12;
        ctx.beginPath(); ctx.moveTo(w.fx, w.fy); ctx.lineTo(w.tx, w.ty); ctx.stroke(); ctx.restore();
      } else {
        const run = (t * 2.5) % 1, ox = w.fx + (w.tx - w.fx) * run, oy = w.fy + (w.ty - w.fy) * run;
        px(ctx, ox - 1, oy - 1, 3, 3, w.down ? '#ef4444' : '#22c55e'); glow(ctx, ox, oy, 7, w.color, 0.7);
      }
    }
    // furniture
    const rk = L.rack;
    shadow(ctx, rk.x, rk.y + rk.h - 6, 30, 10, 0.5);
    px(ctx, rk.x, rk.y, rk.w, rk.h, '#0f131b'); px(ctx, rk.x, rk.y, rk.w, 1, '#2a3446'); px(ctx, rk.x, rk.y, 1, rk.h, '#1e2635');
    for (let i = 0; i < 6; i++) {
      px(ctx, rk.x + 3, rk.y + 4 + i * 9, 20, 6, '#06090e');
      const on = (Math.floor(t * 4) + i) % 3;
      px(ctx, rk.x + 19, rk.y + 6 + i * 9, 2, 2, on ? '#22c55e' : '#0f3a1f');
      if (on) glow(ctx, rk.x + 20, rk.y + 7 + i * 9, 5, '#22c55e', 0.5);
    }

    // Names and speech bubbles are no longer painted into the canvas. At 6 drawing units they came
    // out around 9px on a laptop and could not be read from a chair. They are HTML now (placeFx),
    // laid over the room at real font sizes and positioned from these same desk coordinates.
    seats = labels;

    // vignette: pulls the eye to the middle of the board and hides the hard canvas corners
    ctx.save();
    const vig = ctx.createRadialGradient(VPX, ROOM_H * 0.48, RW * 0.2, VPX, ROOM_H * 0.48, RW * 0.66);
    vig.addColorStop(0, 'transparent'); vig.addColorStop(1, 'rgba(0,0,0,0.55)');
    ctx.fillStyle = vig; ctx.fillRect(0, 0, RW, ROOM_H);
    ctx.restore();

    // P&L board, standing on the floor left of the desks (after the vignette, which would bury it)
    panel(ctx, L.chart.x, L.chart.y, L.chart.w, L.chart.h, '#080c14', '#243047');
    chartBox = { x: L.chart.x + 1, y: L.chart.y + 1, w: L.chart.w - 2, h: L.chart.h - 2 };

    // a dead feed greys the room out entirely: no chance of reading a frozen board as a live one
    if (stale()) {
      ctx.save(); ctx.globalAlpha = 0.55; ctx.fillStyle = '#05070c'; ctx.fillRect(0, 0, RW, ROOM_H); ctx.restore();
      px(ctx, VPX - 90, WALL_H - 4, 180, 16, '#1a0d0f'); px(ctx, VPX - 90, WALL_H - 4, 180, 1, '#ef4444');
      text(ctx, 'NO SIGNAL FROM THE DESK', VPX, WALL_H, '#f87171', 7, 'center');
      text(ctx, 'this page is showing the last state it received', VPX, WALL_H + 7, '#7f1d1d', 5, 'center');
    }
  }

  // ------------------------------------------------------------ notices: what the desk is doing, in words
  // The bots move when their desk runs; these say WHY, in sentences a person can read from a chair.
  // Everything here is HTML laid over the canvas: bubbles above the bots, the feed on the ledge, and
  // the alert in the floor's title bar. Positions come from the same drawing coordinates as the art.
  let seats = [], statusBox = null, wallBox = null, tapeBox = null, clockBox = null, chartBox = null;
  let frameSeq = 0;           // bumps on every SSE frame, so the boards rebuild only when data moves
  let seenKeys = null, feedHead = '';
  const said = {};        // agent -> { text, sub, level, until }   the bubble currently showing
  const lastSaid = {};    // agent -> the last sentence it said, numbers blanked, so repeats stay quiet
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  const cap = (s) => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
  const cc = (p) => `${+(p * 100).toFixed(1)}¢`;
  const move = (s) => `${s.replace('-', '−').replace(/\.0$/, '')}¢`;

  // Categories as glyphs. The desk counts its board by category -- "42 sports, 6 elections, 2 crypto,
  // 2 climate and weather" -- and from a chair that is a hedge of words hiding three numbers. One
  // emoji per category leaves the counts standing on their own. The word is still there for a screen
  // reader and on hover, so nothing is lost by not knowing a glyph.
  const CAT_EMOJI = {
    sports: '⚽', fed: '🏦', economics: '📊', financials: '💵', finance: '💵',
    crypto: '🪙', politics: '🏛️', elections: '🗳️', mentions: '💬',
    entertainment: '🎬', culture: '🎭', music: '🎵', awards: '🏆',
    'science and technology': '🔬', science: '🔬', technology: '💻', tech: '💻',
    'climate and weather': '🌦️', climate: '🌦️', weather: '🌦️',
    commodities: '🛢️', companies: '🏢', health: '🏥', world: '🌍',
    geopolitics: '🌐', transportation: '✈️', other: '🗂️',
  };
  // Only the shapes the desk actually writes a category in: a count ("12 sports") and a whale's
  // leaderboard rank ("#6 in sports this day"). A market question is left alone -- "Will crypto end
  // the year above $100k?" is a market, not a category, and should read as one.
  const CAT_RE = new RegExp(`(\\d+ |#\\d+ in )(${Object.keys(CAT_EMOJI).sort((a, b) => b.length - a.length).join('|')})\\b`, 'g');
  // Runs on already-escaped html: a category name is plain lowercase letters, so a match can never
  // land inside a tag or an entity, and the span it inserts is ours.
  const cats = (html) => String(html).replace(CAT_RE, (m, pre, w) =>
    `${pre}<span class="cat" role="img" aria-label="${w}" title="${w}">${CAT_EMOJI[w]}</span>`);
  const marketName = (tk) => { const m = byTicker(S.maker || {}, tk); return (m && (OUTCOME(m) || QUESTION(m))) || tk.replace(/^KX/, ''); };
  const fillName = (f) => f.label || (f.ticker ? marketName(f.ticker) : 'Unknown market');
  function recentFills(M) {
    const making = (M.recent || []).map((f) => ({ ...f, source: 'maker', action: f.side === 'buy' ? 'Bought' : 'Sold', label: marketName(f.ticker) }));
    const crossing = (S.takerFills || []).map((f) => ({ ...f, source: 'taker', side: f.pnl == null || f.pnl >= 0 ? 'buy' : 'sell' }));
    return [...making, ...crossing].sort((a, b) => b.at - a.at);
  }

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
        // the any-market crawl: every category on both venues, and how many can actually trade
        const scan = t.match(/^any-market scan · .*? · (\d+) matched \(([^)]*)\) · (\d+) rules-verified to trade, (\d+) watch-only/);
        if (scan) return { text: `Scanned every market on both venues: ${scan[1]} matched (${scan[2]})`, sub: `${scan[3]} with rules checked and tradeable, ${scan[4]} watched until their rules are checked`, level: 'info' };
        if (/^any-market scanner restored/.test(t)) return { text: cap(first), level: 'quiet' };
        // labels can carry ' · ' themselves, so a new-pair list ends where the next count begins
        const m = t.match(/\+\d+ new: (.+?)(?: · −\d+ closed| · \d+ rejected|$)/), n = (t.match(/^(\d+) pairs/) || [])[1];
        const mix = (t.match(/^\d+ pairs live \(([^)]*)\)/) || [])[1];
        return m ? { text: `Found a new market on both venues: ${m[1]}`, level: 'info' }
          : { text: `Watching ${n || 'the'} markets listed on both venues${mix ? `: ${mix}` : ''}`, level: 'quiet' };
      }
      case 'ILSA RESEARCH': {
        const m = t.match(/^(.+?): PM ([−+-]?[\d.]+)c, KS ([−+-]?[\d.]+)c over \S+ · gap ([\d.]+)c (\w+)/);
        if (m) return { text: `${m[1]}: price moved ${move(m[2])} on Polymarket, ${move(m[3])} on Kalshi`, sub: `venues ${+m[4]}¢ apart, ${m[5]}`, level: 'quiet' };
        break;
      }
      // whale watch (src/whales.js): "<who> bought $54K on <outcome> at 55c · <market> · #6 in sports… · Kalshi 57c now"
      case 'ILSA WHALE': {
        const cent = (s) => s.replace(/(\d+)c\b/g, '$1¢');
        return { text: `Big bet: ${cent(first)}`, sub: cent(rest), level: 'info' };
      }
      case 'ILSA SCAN': return { text: cap(first), sub: rest, level: 'info' };
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
      // half settled: one venue has paid out and the other has not yet -- normal, not broken
      if (g.integrity === 'valid' || g.integrity === 'half_settled') continue;
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
        ? `⚠ ${esc(top.text)}${loud.length > 1 ? ` <small>+${loud.length - 1} more</small>` : ''} <b class="open">Decide ›</b>`
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
      return `<li class="lv-${s.level}" style="--a:${agentColor(e.agent)}"><span class="ft">${hhmm(e.t)}</span><span class="fa" style="color:${agentColor(e.agent)}">${e.agent}</span>` +
        `<span class="fs">${cats(esc(s.text))}${s.sub && s.level !== 'quiet' ? `<small>${cats(esc(s.sub))}</small>` : ''}</span>${pl}</li>`;
    }).join('') || '<li class="lv-quiet"><span class="fs">Waiting for the first desk cycle</span></li>';
    list.scrollTop = top;
  }

  // Every animation frame: put the names, bubbles and feed where the room currently is on screen.
  const nodes = {};
  // Who is talking. The floor used to give all seven bots a bubble at once, including one for the
  // routine note each desk carries every cycle, and at full width those seven boxes covered the
  // room -- the screen they were talking about, each other, and the bots themselves. A trading
  // floor on television does not caption seven people at once. It mics one.
  //
  // So: one bubble, one line, and only for something that actually happened. The running commentary
  // lives in the feed below the room, where a list belongs, and the desk's standing note lives on
  // the status board, where it already was.
  const RANK = { warn: 3, trade: 2, info: 1, quiet: 0 };
  let speaking = null;                     // { key, sig } -- held until something louder arrives
  function placeFx() {
    const fx = $('fx');
    if (!S || !seats.length) return;
    const k = floorBox.scale, X = (x) => floorBox.ox + x * k, Y = (y) => floorBox.oy + y * k;
    const fs = Math.max(12, Math.min(17, k * 6));
    fx.style.fontSize = `${fs}px`;
    fx.classList.toggle('stale', !!stale());
    placeStatus(X, Y, k);
    placeBoards(X, Y, k);

    const now = Date.now(), al = alerts();
    // what each seat WOULD say, if it were the one holding the microphone
    const lines = {};
    for (const st of seats) {
      const ev = said[st.key] && said[st.key].until > now ? said[st.key] : null;
      const nAl = al.filter((a) => a.agent === st.key && !a.kept).length;
      const b = nAl ? { text: `${nAl} problem${nAl > 1 ? 's' : ''} to look at`, level: 'warn' }
        : ev && ev.level !== 'quiet' ? ev : null;
      if (b) lines[st.key] = b;
    }
    // the loudest line wins, and keeps the floor until it expires or something louder lands
    let best = null;
    for (const key of Object.keys(lines)) {
      const r = RANK[lines[key].level] || 0;
      if (!best || r > best.r) best = { key, r };
    }
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
      // name: on the wall above the back row's monitors, on the floor under the front row's bots.
      // A bubble carries its own name badge, so the tag steps aside rather than fighting it.
      Object.assign(n.name.style, { left: `${X(st.bx)}px`, top: `${Y(st.back ? st.top - 11 : st.foot)}px`, color: st.lit || st.act ? st.color : '' });
      n.name.classList.toggle('on', st.act || st.lit);
      n.name.hidden = !!(b && st.back);

      if (!b) { n.bub.hidden = true; continue; }
      // One line. A sentence that needs two is a sentence for the feed, which has every word of it.
      // The back row speaks up into the clear strip between the boards and the floor -- the boards
      // stop short of it for exactly this reason, and the strip is one line deep. So the sentence is
      // cut to what one line of THIS width holds, not to a fixed number of characters: a bubble that
      // wraps is a bubble standing on the screen it is talking about.
      //
      // Sideways is the front row's only clear direction, and a bubble as wide as the room allows
      // reaches straight across the gap onto the next bot's face -- TESS talking over HOLT, whose
      // name it also buried. Stop it one blob short of the neighbour. The back row is speaking into
      // an empty strip and keeps the full width.
      const reach = L ? (L.pitch - st.w / 2 - 9) * k : 200;
      const maxw = st.back ? Math.min(440, Math.max(200, st.w * k * 2.1))
        : Math.min(440, Math.max(150, reach));
      const room = Math.max(22, Math.floor(maxw / (fs * 0.62)) - st.key.length - 2);
      // a cut on a word boundary can leave the line ending on a word that was going somewhere
      const line = clip(b.text, room).replace(/[\s·@:,+-]+$/, '');
      const html = `<b class="who" style="color:${st.color}">${esc(st.key)}</b>${cats(esc(line))}`;
      const flip = !st.back && X(RW) - X(st.bx) < maxw * 0.7;
      const cls = `bub lv-${b.level} ${st.back ? 'up' : flip ? 'side flip' : 'side'}`;
      if (html !== n.html || n.cls !== cls) {
        n.bub.innerHTML = html; n.cls = cls;
        n.bub.className = cls;
        if (html !== n.html) { void n.bub.offsetWidth; n.bub.classList.add('pop'); }   // restart the pop animation
        n.html = html;
      }
      n.bub.hidden = false;
      n.bub.style.setProperty('--c', st.color);
      n.bub.style.maxWidth = `${maxw}px`;
      if (st.back) Object.assign(n.bub.style, { left: `${X(st.bx)}px`, right: '', top: `${Y(st.top - 5)}px` });
      else if (flip) Object.assign(n.bub.style, { left: '', right: `${fx.clientWidth - X(st.bx - 12)}px`, top: `${Y(st.by - 10)}px` });
      else Object.assign(n.bub.style, { left: `${X(st.bx + 12)}px`, right: '', top: `${Y(st.by - 10)}px` });
    }

    // A narrow room leaves no sideways space to stop short of: the desks are shoulder to shoulder
    // and the bubble has nowhere to go but onto its neighbour. Covering a desk is survivable --
    // burying the name of the bot it is covering is not, so any tag the bubble lands on steps
    // aside, the same way the speaker's own does on the back row. One bot speaks, so this is one
    // rectangle against seven.
    const sp = speaking && nodes[speaking.key] && !nodes[speaking.key].bub.hidden && nodes[speaking.key].bub.getBoundingClientRect();
    if (sp) for (const st of seats) {
      const n = nodes[st.key];
      if (!n || n.name.hidden) continue;
      const r = n.name.getBoundingClientRect();
      if (!(r.right < sp.left || sp.right < r.left || r.bottom < sp.top || sp.bottom < r.top)) n.name.hidden = true;
    }
  }

  // The status board on the left wall: is it working, what is it doing, what did it last trade.
  let statusHtml = '';
  function placeStatus(X, Y, k) {
    if (!statusBox) return;
    const el = $('status'), M = S.maker || {};
    Object.assign(el.style, { left: `${X(statusBox.x)}px`, top: `${Y(statusBox.y)}px`, width: `${statusBox.w * k}px`, height: `${statusBox.h * k}px` });
    // on a small window the board cannot hold every line; keep state, what it is doing, and the last fill
    el.classList.toggle('compact', statusBox.h * k < 150);
    const halted = S.halt || M.halted, working = !halted && M.quoting > 0, gone = stale();
    const [state, cls] = gone ? ['No signal', 'bad'] : halted ? ['Stopped', 'bad'] : working ? ['Working', 'good'] : ['Idle', 'warn'];
    const nHeld = (M.markets || []).filter((m) => m.inv).length;
    // the ledger survives a restart but the last-fill detail does not; the Last fill row says which
    const lf = recentFills(M)[0] || null, feed = M.feed || {};
    // Whose money it is belongs on the state line, where the eye already is, not buried in the
    // footer sentence: those two facts are the whole first glance.
    const live = S.mode === 'live';
    // These were five sentences that wrapped. On a real book -- 3261 contracts in 36 markets, a
    // market name of its own on the fill line -- they wrapped to nine lines and the board answered
    // by shrinking its own type to 11px. A label and its figure wrap far less than a sentence
    // saying the same thing, and the labels give the eye somewhere to land.
    const row = (k, v, cls) => `<div class="${cls || ''}"><dt>${k}</dt><dd>${v}</dd></div>`;
    const html = `<div class="st ${cls}"><i></i>${state}<em class="${live ? 'real' : ''}">${live ? 'LIVE' : 'PAPER'}</em></div>` +
      (gone || halted ? `<p class="alarm">${esc(gone ? 'The desk stopped answering' : `Trading stopped: ${halted}`)}</p>` : '') +
      `<dl class="sf">` +
      row('Maker quotes', working ? `${M.quoting} markets` : '<span class="off">not quoting</span>') +
      row('Maker held', nHeld ? `${M.inv.toLocaleString()} <span class="in">in ${nHeld}</span>` : '<span class="off">nothing</span>') +
      row('Last fill', lf
        ? `${esc(lf.action)} ${lf.qty} at ${cc(lf.px)} <span class="in">· ${ago(lf.at)} · ${lf.source === 'maker' ? 'maker' : lf.venue}</span><small>${esc(fillName(lf))}</small>`
        : `<span class="off">${M.fills ? `${M.fills} before the restart` : 'none yet'}</span>`) +
      // the taker's reach: markets matched on both venues, across every category
      (S.anyMarket && S.anyMarket.enabled
        ? row('Both venues', `${S.pairCount || 0} matched <span class="in">· ${S.anyMarket.rulesVerified || 0} cleared to trade, ${S.anyMarket.watchOnly || 0} watched</span>`, 'extra')
        : '') +
      `</dl>` +
      `<p class="dim">${live ? 'Real money' : 'No real money'} · up ${dur(S.now - S.startedAt)} · ${feed.mode === 'stream' && feed.connected ? 'live trade feed' : 'polling for trades'}</p>`;
    const key = `${html}|${Math.round(statusBox.w * k)}x${Math.round(statusBox.h * k)}`;
    if (key !== statusHtml) { el.innerHTML = html; statusHtml = key; fitText(el, Math.max(12, Math.min(21, k * 7.2)), 9); }
  }

  // Shrink a board's text until everything on it fits. Nothing on the floor is cut off with an
  // ellipsis: a sentence that is half there is worse than a sentence in slightly smaller type.
  function fitText(el, maxFs, minFs) {
    let fs = maxFs;
    el.style.fontSize = `${fs}px`;
    while (el.scrollHeight > el.clientHeight + 1 && fs > minFs) { fs -= 0.5; el.style.fontSize = `${fs}px`; }
  }
  // fitText only catches a board that runs too tall. The wall's hero number is one line that can
  // run too WIDE instead -- a bigger account swing is more digits, and the number sits beside the
  // book rather than above it in wide mode, so at a large enough font a big balance quietly grew
  // wider than its own 15em column and drew straight over the header next to it. Shrink just this
  // element to its own container's width, independent of whatever size the rest of the board is at.
  function fitWidth(el, minFs) {
    if (!el) return;
    el.style.fontSize = '';
    const maxW = el.parentElement.clientWidth;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > maxW && fs > minFs) { fs -= 1; el.style.fontSize = `${fs}px`; }
  }

  // ------------------------------------------------------------ the P&L chart
  // A chart you can ask things of. The headline is one number: every paper trade, across the maker
  // and cross-venue ledgers. Four ranges, a hover readout that says how far a moment is from the
  // start of the range, and a drag
  // that measures the gain or loss between any two moments. The same chart opens large on the wall
  // screen. It is HTML and SVG over the canvas board, so its text is sharp and it takes a mouse.
  //
  const RANGES = [['1h', 36e5], ['6h', 216e5], ['24h', 864e5], ['All', Infinity]];
  const chart = { range: 'All', hoverT: null, band: null, dragFrom: null };
  try {
    const c = JSON.parse(localStorage.getItem('hex-chart') || '{}');
    if (RANGES.some(([r]) => r === c.range)) chart.range = c.range;
  } catch { /* private window: defaults */ }
  const saveChart = () => { try { localStorage.setItem('hex-chart', JSON.stringify({ range: chart.range })); } catch { /* ignore */ } };

  function combinePnlHistory(balanceHistory, makerHistory, initial, validFrom = 0) {
    // Only the maker ledger had the bad 50c marks, so only its history is cut at the repair. The
    // account ledger was right all along: its last value before the repair carries into it. Cutting
    // both made the chart wait for the account's first sample after the repair, and the server
    // thins that ledger to 600 points, so the start drifted by up to a quarter of an hour.
    const acct = (balanceHistory || []).map((p) => ({ t: p.t, v: r2(p.b - initial) })).sort((a, b) => a.t - b.t);
    const making = (makerHistory || []).filter((p) => p.t >= validFrom).map((p) => ({ t: p.t, v: p.e })).sort((a, b) => a.t - b.t);
    // One ledger on its own is not an "all paper trades" history. Wait until both have an
    // observation rather than silently treating the missing ledger as $0.
    if (!acct.length || !making.length) return [];
    // Both ledgers are step functions sampled on different clocks. Start where every available
    // stream has a value, then carry each last observation forward at the union of timestamps.
    const start = Math.max(acct[0].t, making[0].t);
    const times = [...new Set([...acct, ...making].filter((p) => p.t >= start).map((p) => p.t))].sort((a, b) => a - b);
    let ai = 0, mi = 0, av = 0, mv = 0;
    while (ai < acct.length && acct[ai].t <= start) av = acct[ai++].v;
    while (mi < making.length && making[mi].t <= start) mv = making[mi++].v;
    const pts = [];
    for (const t of times) {
      while (ai < acct.length && acct[ai].t <= t) av = acct[ai++].v;
      while (mi < making.length && making[mi].t <= t) mv = making[mi++].v;
      pts.push({ t, v: r2(av + mv) });
    }
    return pts;
  }

  function windowPnlPoints(pts, now, span) {
    if (!Number.isFinite(span) || pts.length < 2) return pts;
    const cutoff = now - span, after = pts.filter((p) => p.t >= cutoff);
    // A P&L history is a step series. The point immediately before the cutoff is the opening
    // value at the cutoff and belongs in the requested range; omitting it shortens every range.
    let before = null;
    for (const p of pts) { if (p.t > cutoff) break; before = p; }
    if (before && (!after.length || after[0].t !== before.t)) after.unshift(before);
    return after.length >= 2 ? after : pts.slice(-2);
  }

  function niceAxis(pts) {
    let lo = Math.min(...pts.map((p) => p.v)), hi = Math.max(...pts.map((p) => p.v));
    const seen = Math.max(hi - lo, 0.02);
    if (lo > 0 && lo <= seen * 0.35) lo = 0;
    if (hi < 0 && -hi <= seen * 0.35) hi = 0;
    const floor = Math.max(1, Math.abs(pts[pts.length - 1].v) * 0.02);
    if (hi - lo < floor) { const mid = (hi + lo) / 2; lo = mid - floor / 2; hi = mid + floor / 2; }
    const padded = (hi - lo) * 0.04, rough = ((hi - lo) + 2 * padded) / 4;
    const mag = 10 ** Math.floor(Math.log10(Math.max(rough, 0.0001))), f = rough / mag;
    const step = (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
    lo = Math.floor((lo - padded) / step) * step;
    hi = Math.ceil((hi + padded) / step) * step;
    if (hi <= lo) hi = lo + step;
    const ticks = [];
    for (let v = lo, i = 0; v <= hi + step / 100 && i < 12; v += step, i++) ticks.push(r2(v));
    return { lo: r2(lo), hi: r2(hi), step: r2(step), ticks };
  }

  function chartPoints() {
    const M = S.maker || {};
    const pts = combinePnlHistory(S.balanceHistory, M.hist, S.initial, M.historyValidFrom || 0);
    if (!pts.length) return [];
    // End on the live combined value so the line is never stale.
    const makerLive = Number.isFinite(M.equity) && Number.isFinite(M.initial) ? M.equity - M.initial : 0;
    const acctLive = Number.isFinite(S.equity) && Number.isFinite(S.initial) ? S.equity - S.initial : 0;
    pts.push({ t: S.now, v: r2(makerLive + acctLive) });
    if (pts.length < 2) return pts;
    const span = RANGES.find(([r]) => r === chart.range)[1];
    return windowPnlPoints(pts, S.now, span);
  }
  const nearest = (pts, t) => pts.reduce((b, p) => (Math.abs(p.t - t) < Math.abs(b.t - t) ? p : b), pts[0]);
  const spanTxt = (ms) => { const m = Math.round(ms / 60000); return m < 60 ? `${m}m` : m < 1440 ? `${(m / 60).toFixed(m < 600 ? 1 : 0)}h` : `${(m / 1440).toFixed(1)}d`; };

  // Four rows, each with one job: which series, the number, the plot, the range. The number used
  // to share the top row with the series buttons and the change over the range sat at the bottom
  // beside the range buttons, where it read as a caption on them rather than as the headline fact.
  function chartSkeleton(big) {
    return `<div class="ct"><span class="ctitle">All paper trades</span>` +
      `${big ? '' : '<button class="cx" data-expand="1" title="Open large">⤢</button>'}</div>` +
      `<div class="chead"><span class="cv"></span><span class="cd"></span></div>` +
      `<div class="cplot"><svg viewBox="0 0 1000 400" preserveAspectRatio="none"></svg><div class="cyaxis"></div>` +
      `<i class="cdot" hidden></i><div class="ctip" hidden></div></div>` +
      `<div class="cb"><span class="seg">${RANGES.map(([r]) => `<button data-range="${r}">${r}</button>`).join('')}</span><span class="cr"></span></div>`;
  }

  function drawChart(el, big) {
    if (!S) return;
    if (el.dataset.built !== (big ? 'big' : 'small')) { el.innerHTML = chartSkeleton(big); el.dataset.built = big ? 'big' : 'small'; }
    // Every range stays clickable. Greying out ranges longer than the history (and forcing 'All')
    // left a freshly reset ledger with one live button, which read as a chart that ignored clicks.
    // A range longer than the history simply shows all of it, and the time axis says so.
    const allPts = (() => { const old = chart.range; chart.range = 'All'; const p = chartPoints(); chart.range = old; return p; })();
    const available = allPts.length > 1 ? allPts[allPts.length - 1].t - allPts[0].t : 0;
    const selectedSpan = RANGES.find(([r]) => r === chart.range)[1];
    const short = Number.isFinite(selectedSpan) && available < selectedSpan;
    el.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === chart.range));
    const pts = chartPoints(), svg = el.querySelector('svg'), tip = el.querySelector('.ctip'), dot = el.querySelector('.cdot');
    if (pts.length < 2) {
      svg.innerHTML = '';
      el.querySelector('.cyaxis').innerHTML = '';
      dot.hidden = true; tip.hidden = true;
      el.querySelector('.cv').textContent = signed(pts.length ? pts[0].v : 0);
      el.querySelector('.cd').innerHTML = '';
      el.querySelector('.cr').textContent = 'collecting, one point a minute';
      return;
    }

    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    // The scale has two ways to lie. Pinned to zero -- as it was -- a desk parked at -$84
    // with 22c of movement in it spends the whole plot on the empty distance back to zero: the line
    // lies flat on the floor of the box and the fill floods the panel. Pinned to the data instead,
    // that same 22c of drift is stretched over the full height and a flat day reads as a
    // rollercoaster. So: follow the data, keep zero when the line is near enough to it to be worth
    // the room, and hold the window open to a floor -- a dollar, or 2% of the level, whichever is
    // larger -- so that small really does look small.
    const axis = niceAxis(pts), { lo, hi } = axis;
    const X = (t) => ((t - t0) / (t1 - t0)) * 1000, Y = (v) => 400 - ((v - lo) / (hi - lo)) * 400;
    const last = pts[pts.length - 1], first = pts[0], up = last.v >= 0;
    const zeroIn = lo < 0 && hi > 0;   // only draw the zero line when it is actually on the plot
    // The line's colour is about the range on show, not the sign of the level: a desk down $84 that
    // has made 22c back today draws green over the last hour, red over the week, and the headline
    // number stays red throughout. That is what the range buttons are for.
    const col = last.v >= first.v ? '#22c55e' : '#ef4444';
    const line = pts.map((p, i) => `${i ? 'L' : 'M'}${X(p.t).toFixed(1)},${Y(p.v).toFixed(1)}`).join('');
    const zy = Y(0).toFixed(1);
    let g = `<defs><linearGradient id="cg-${big ? 'b' : 's'}" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="${col}" stop-opacity=".16"/><stop offset="1" stop-color="${col}" stop-opacity="0"/></linearGradient></defs>`;
    // Gridlines and their labels use clean dollar increments. The old labels were merely the
    // padded pixel bounds (for example -$252.61 and -$997.53), which looked precise but were not
    // observations and made the scale needlessly hard to read.
    for (const v of axis.ticks) g += `<line x1="0" x2="1000" y1="${Y(v).toFixed(1)}" y2="${Y(v).toFixed(1)}" stroke="#8ca8d2" stroke-opacity=".07" vector-effect="non-scaling-stroke"/>`;
    if (chart.band) {
      const a = Math.min(chart.band[0], chart.band[1]), b = Math.max(chart.band[0], chart.band[1]);
      g += `<rect x="${X(a).toFixed(1)}" y="0" width="${Math.max(2, X(b) - X(a)).toFixed(1)}" height="400" fill="#5ec8e0" fill-opacity=".12"/>`;
    }
    // The reference the eye reads against: zero when zero is on the plot, otherwise where this
    // range opened -- which is the line the change beside the number is measured from anyway.
    const ry = zeroIn ? zy : Y(first.v).toFixed(1);
    g += `<line x1="0" x2="1000" y1="${ry}" y2="${ry}" stroke="#44526b" stroke-dasharray="5 5" vector-effect="non-scaling-stroke"/>`;
    // the area hangs off the foot of the plot: it is there to give the line a body, and it says
    // nothing about zero -- hanging it off the zero line is what painted the whole board red
    g += `<path d="${line}L${X(last.t).toFixed(1)},400L${X(first.t).toFixed(1)},400Z" fill="url(#cg-${big ? 'b' : 's'})"/>`;
    g += `<path d="${line}" fill="none" stroke="${col}" stroke-width="${big ? 2.5 : 2}" stroke-linejoin="round" stroke-linecap="round" vector-effect="non-scaling-stroke"/>`;
    if (chart.hoverT != null) g += `<line x1="${X(chart.hoverT).toFixed(1)}" x2="${X(chart.hoverT).toFixed(1)}" y1="0" y2="400" stroke="#94a3b8" stroke-opacity=".6" vector-effect="non-scaling-stroke"/>`;
    svg.innerHTML = g;
    const digits = axis.step < 0.1 ? 2 : axis.step < 1 ? 1 : 0;
    el.querySelector('.cyaxis').innerHTML = axis.ticks.map((v) => `<span style="top:${(Y(v) / 4).toFixed(2)}%">${v === 0 ? '$0' : signed(v, digits)}</span>`).join('');

    const cv = el.querySelector('.cv');
    cv.textContent = signed(last.v); cv.className = `cv ${up ? 'pos' : 'neg'}`;
    // The headline number is a level; on its own it does not say whether the desk is having a good
    // hour. The change over the range, beside it, does -- so it sits with the number, not under the
    // range buttons where it used to look like a label on them.
    const chg = r2(last.v - first.v);
    // On a small window the stand is barely wider than the number itself. The change gives up its
    // tail, and then itself, rather than running off the edge of the board.
    const room = el.clientWidth;
    el.querySelector('.cd').innerHTML = room < 130 ? ''
      : `<b class="${chg >= 0 ? 'pos' : 'neg'}">${chg >= 0 ? '▲' : '▼'} ${signed(chg)}</b>${room < 185 ? '' : ` in ${spanTxt(t1 - t0)}`}`;
    // the bottom line is the time axis, until a drag asks it a question
    // a range longer than the history says how much there is instead of the start and end times
    let read = short ? `only ${spanTxt(available)} of history` : `${hhmm(t0)} → ${hhmm(t1)}`;
    if (chart.band) {
      const a = nearest(pts, Math.min(...chart.band)), b = nearest(pts, Math.max(...chart.band)), d = r2(b.v - a.v);
      read = `${hhmm(a.t)}→${hhmm(b.t)} <b class="${d >= 0 ? 'pos' : 'neg'}">${signed(d)}</b>`;
    }
    el.querySelector('.cr').innerHTML = read;

    if (chart.hoverT != null) {
      const p = nearest(pts, chart.hoverT), since = r2(p.v - first.v);
      dot.hidden = false;
      Object.assign(dot.style, { left: `${X(p.t) / 10}%`, top: `${Y(p.v) / 4}%`, background: p.v >= 0 ? '#4ade80' : '#f87171' });
      tip.hidden = false;
      tip.innerHTML = `<b>${hhmm(p.t)}</b> <span class="${p.v >= 0 ? 'pos' : 'neg'}">${signed(p.v)}</span><br><small>${signed(since)} since ${hhmm(first.t)}</small>`;
      const leftPct = X(p.t) / 10;
      Object.assign(tip.style, leftPct > 55 ? { left: '', right: `${100 - leftPct + 2}%` } : { right: '', left: `${leftPct + 2}%` });
    } else {
      // no hover: the dot rests on the newest point, so the end of the line is never ambiguous
      dot.hidden = false;
      Object.assign(dot.style, { left: `${X(last.t) / 10}%`, top: `${Y(last.v) / 4}%`, background: col });
      tip.hidden = true;
    }
  }

  // One set of handlers serves both charts: they find their own container and redraw it at once,
  // without waiting for the next frame from the desk.
  function wireChart(root, big) {
    const redraw = () => drawChart(root, big);
    const tAt = (ev) => {
      const pts = chartPoints(), r = root.querySelector('svg').getBoundingClientRect();
      if (pts.length < 2 || !r.width) return null;
      const f = Math.max(0, Math.min(1, (ev.clientX - r.left) / r.width));
      return nearest(pts, pts[0].t + f * (pts[pts.length - 1].t - pts[0].t)).t;
    };
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.range) { chart.range = b.dataset.range; chart.band = null; saveChart(); }
      if (b.dataset.expand) { openBigChart(); return; }
      redraw();
    });
    root.addEventListener('pointermove', (ev) => {
      if (ev.pointerType === 'touch') return;
      if (!ev.target.closest('.cplot')) { if (chart.hoverT != null && chart.dragFrom == null) { chart.hoverT = null; redraw(); } return; }
      const t = tAt(ev);
      if (t == null) return;
      chart.hoverT = t;
      if (chart.dragFrom != null) chart.band = [chart.dragFrom, t];
      redraw();
    });
    root.addEventListener('pointerleave', () => { chart.hoverT = null; chart.dragFrom = null; redraw(); });
    root.addEventListener('pointerdown', (ev) => {
      if (ev.pointerType === 'touch') return;
      if (!ev.target.closest('.cplot')) return;
      const t = tAt(ev);
      if (t == null) return;
      chart.dragFrom = t; chart.band = null;
      root.querySelector('.cplot').setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    root.addEventListener('pointerup', (ev) => {
      if (chart.dragFrom == null) return;
      const t = tAt(ev);
      // a click without a drag clears the measurement rather than leaving a zero-width band
      chart.band = t != null && Math.abs(t - chart.dragFrom) > 0 ? [chart.dragFrom, t] : null;
      chart.dragFrom = null;
      redraw();
    });
  }

  // ------------------------------------------------------------ the wall screen, the fills board, the clock
  // The wall screen answers one question at a glance -- how is the maker desk doing -- and shows the
  // few positions worth watching. Everything else is one click away: a position or a bot opens its
  // own view here, and clicking it again (or Back, or Escape) returns. It used to show three
  // numbers, every open position with a subtitle, and every quoted market, all in 5-unit text.
  const WALL_ROWS = 5;
  // A watchlist, not a fixed leaderboard: click a column to sort by it, click it again to flip
  // direction -- the same convention as a Finder list view or a TradingView watchlist, instead of
  // a fixed Biggest/Gainers/Losers choice.
  const WALL_COLS = [['name', 'Name'], ['pl', 'P&amp;L']];
  let wallKey = '', tapeKey = '', clockTxt = '', wallAll = false, wallSortCol = 'pl', wallSortDir = 'desc';
  const sideTag = (inv) => `<span class="sd ${inv > 0 ? 'long' : 'short'}">${inv > 0 ? 'LONG' : 'SHORT'} ${Math.abs(inv)}</span>`;
  const nameOf = (m) => String(OUTCOME(m) || QUESTION(m) || m.ticker);
  const sortHeld = (held) => {
    const dir = wallSortDir === 'asc' ? 1 : -1;
    return held.slice().sort(wallSortCol === 'name'
      ? (a, b) => dir * nameOf(a.m).localeCompare(nameOf(b.m))
      : (a, b) => dir * (a.pl - b.pl));
  };

  // The screen used to be a tall-ish rectangle and the home view was a column: number, then a list
  // under it. It is a wide, shallow band now, so on a wide room the number takes a side and the
  // book takes the rest -- which is the only reason five positions fit where three did.
  let wallWide = false;
  function wallHome(M) {
    const makerNet = r2((M.equity ?? M.initial ?? 0) - (M.initial ?? 0));
    const pairNet = r2((S.equity ?? S.initial ?? 0) - (S.initial ?? 0));
    const net = r2(makerNet + pairNet);
    const held = sortHeld((M.markets || []).filter((m) => m.inv).map((m) => ({ m, pl: m.mark - m.cost })));
    const up = held.filter((x) => x.pl > 0).length, down = held.filter((x) => x.pl < 0).length;
    const rows = wallAll ? held : held.slice(0, WALL_ROWS);
    // A number, what it means, and the two standing facts as labelled figures. They used to run
    // together in one dim sentence, which is the slowest way to read two numbers.
    const num = `<div class="wbig ${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</div>` +
      `<div class="wsub">all paper trades, marked now</div>` +
      `<dl class="wstats"><div><dt>Maker</dt><dd class="${makerNet >= 0 ? 'pos' : 'neg'}">${signed(makerNet)}</dd></div>` +
      `<div><dt>Cross-venue</dt><dd class="${pairNet >= 0 ? 'pos' : 'neg'}">${signed(pairNet)}</dd></div></dl>`;
    const tally = held.length ? `${up ? `<b class="pos">▲${up}</b>` : ''}${down ? `<b class="neg">▼${down}</b>` : ''}` : '';
    let h = `<div class="wh"><span>Paper account</span><span>${tally}${M.quoting || 0} markets quoted</span></div>`;
    if (!held.length) {
      h += num + `<p class="wempty">No maker inventory. Quoting ${M.quoting || 0} markets; cross-venue positions are included in the total above.</p>`;
      return h;
    }
    // The header row is the sort control -- click a column, click it again to flip the arrow.
    // Side isn't a sortable field, just a label, so it keeps the row's middle column aligned.
    const arrow = (dir) => dir === 'asc' ? '▲' : '▼';
    const head = `<div class="wcols" role="row"><button type="button" role="columnheader" aria-sort="${wallSortCol === 'name' ? (wallSortDir === 'asc' ? 'ascending' : 'descending') : 'none'}" data-wcol="name" class="${wallSortCol === 'name' ? 'on' : ''}">Name${wallSortCol === 'name' ? `<i>${arrow(wallSortDir)}</i>` : ''}</button>` +
      `<span class="wcolside">Side</span>` +
      `<button type="button" role="columnheader" aria-sort="${wallSortCol === 'pl' ? (wallSortDir === 'asc' ? 'ascending' : 'descending') : 'none'}" data-wcol="pl" class="${wallSortCol === 'pl' ? 'on' : ''}">P&amp;L${wallSortCol === 'pl' ? `<i>${arrow(wallSortDir)}</i>` : ''}</button></div>`;
    const list = `<div class="wlist${wallAll ? ' all' : ''}">${rows.map(({ m, pl }) => `<button class="wr ${m.inv > 0 ? 'long' : 'short'}" data-m="${esc(m.ticker)}" title="${esc(m.title || '')}">` +
      `<span class="nm">${esc(OUTCOME(m) || QUESTION(m))}${OUTCOME(m) && QUESTION(m) ? `<i> · ${esc(QUESTION(m))}</i>` : ''}</span>${sideTag(m.inv)}<span class="pl ${pl >= 0 ? 'pos' : 'neg'}">${signed(pl)}</span></button>`).join('')}</div>`;
    const foot = held.length > WALL_ROWS || wallAll
      ? `<button class="wmore" data-all="1">${wallAll ? 'Show fewer' : `${WALL_ROWS} of ${held.length} positions · show all`}</button>`
      : `<div class="wfoot">${held.length} maker position${held.length === 1 ? '' : 's'} · click one for details</div>`;
    h += `<div class="wbody">${`<div class="wnum">${num}</div>`}<div class="wbook">${head}${list}${foot}</div></div>`;
    return h;
  }

  // A clicked trade or position: what happened and whether it made money, in a few plain lines.
  // `fill` is the trade that was clicked, or the latest one in this market when a position was.
  const minsAgo = (t) => { const m = Math.round((S.now - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
  function wallRecap(ticker, at, M) {
    const m = byTicker(M, ticker);
    const fill = (M.recent || []).find((f) => f.ticker === ticker && (!at || f.at === at)) || null;
    const name = m ? (OUTCOME(m) || QUESTION(m)) : marketName(ticker);
    const open = m && m.inv ? r2(m.mark - m.cost) : 0;
    const total = m ? r2((m.realized || 0) + open) : null;
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span>${m ? `${m.fills} trade${m.fills === 1 ? '' : 's'} here` : ''}</span></div>`;
    h += `<div class="wtitle">${esc(name)}</div>`;
    if (m && QUESTION(m) && QUESTION(m) !== name) h += `<div class="wq">${esc(QUESTION(m))}</div>`;
    if (total != null) h += `<div class="wbig ${total >= 0 ? 'pos' : 'neg'}">${signed(total)}</div><div class="wsub">profit on this market so far</div>`;
    h += `<ul class="wrecap">`;
    if (fill) {
      const made = fill.pnl ? ` That trade ${fill.pnl > 0 ? 'made' : 'lost'} <b class="${fill.pnl > 0 ? 'pos' : 'neg'}">${money(fill.pnl)}</b>.` : '';
      h += `<li>${fill.side === 'buy' ? 'Bought' : 'Sold'} ${fill.qty} at ${cc(fill.px)}, ${minsAgo(fill.at)}.${made}</li>`;
    }
    if (m) {
      h += m.inv
        ? `<li>Holding ${m.inv > 0 ? 'long' : 'short'} ${Math.abs(m.inv)}: paid ${money(Math.abs(m.cost))}, worth ${money(Math.abs(m.mark))} now (<b class="${open >= 0 ? 'pos' : 'neg'}">${signed(open)}</b>).</li>`
        : `<li>Nothing held here now.</li>`;
      if (m.realized) h += `<li>Already banked from closed trades: <b class="${m.realized >= 0 ? 'pos' : 'neg'}">${signed(m.realized)}</b>.</li>`;
    } else h += `<li>This market is no longer on the desk's board, so its running profit isn't shown.</li>`;
    return h + `</ul>`;
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
      (lines.length ? `<ol class="wlog">${lines.map(({ e, sx }) => `<li class="lv-${sx.level}"><span class="t">${hhmm(e.t)}</span><span>${cats(esc(sx.text))}</span></li>`).join('')}</ol>`
        : `<p class="wempty">Nothing logged yet.</p>`);
  }

  function placeBoards(X, Y, k) {
    const M = S.maker || {};
    const fit = (el, b, fs) => Object.assign(el.style, { left: `${X(b.x)}px`, top: `${Y(b.y)}px`, width: `${b.w * k}px`, height: `${b.h * k}px` }, fs ? { fontSize: `${fs}px` } : {});

    if (wallBox) {
      const el = $('wall');
      const wallFs = Math.max(12, Math.min(21, k * 7.2));
      fit(el, wallBox, null);             // type size is set on rebuild, where fitText may shrink it
      // two columns need real width, not just a wide ratio: beside the Ask drawer the screen keeps
      // its shape but loses a third of its pixels, and 26% of a narrow screen is not a column.
      wallWide = wallBox.w > wallBox.h * 2.3 && wallBox.w * k > 560;
      el.classList.toggle('wide', wallWide);
      // Stacked (not wide), the number sits above the book instead of beside it, so a bigger font
      // now costs the book its own height. Below a real box the number and its breakdown collapse
      // to one line -- the list of positions is why this board exists, and a hero digit that leaves
      // it zero rows visible is a worse tradeoff than a smaller digit.
      el.classList.toggle('compact', !wallWide && wallBox.h * k < 200);
      const selPart = sel ? sel.kind + sel.key + (sel.at || '') : '', sortPart = `${wallSortCol}:${wallSortDir}`;
      const key = `${frameSeq}|${selPart}|${sortPart}|${wallAll}|${wallWide}|${Math.round(wallBox.w * k)}`;
      if (key !== wallKey) {
        const list = el.querySelector('.wlist, .wlog');
        const prevParts = wallKey.split('|');
        // Re-sorting (like clicking a column header anywhere else) jumps back to the top instead
        // of holding a scroll offset that now points at a different row.
        const top = list && prevParts[1] === selPart && prevParts[2] === sortPart ? list.scrollTop : 0;
        wallKey = key;
        const m = sel && sel.kind === 'market';
        const a = sel && sel.kind === 'agent' ? S.agents.find((x) => x.key === sel.key) : null;
        el.style.fontSize = `${wallFs}px`;
        {
          el.innerHTML = sel && sel.kind === 'market' ? wallRecap(sel.key, sel.at, M) : a ? wallAgent(a) : wallHome(M);
          const list2 = el.querySelector('.wlist, .wlog');
          if (list2) list2.scrollTop = top;
          el.classList.toggle('more', !!list2 && list2.scrollHeight > list2.clientHeight + 2);
          fitWidth(el.querySelector('.wbig'), 14);
          if (m) fitText(el, wallFs, 9);
        }
      }
    }

    if (chartBox) {
      const el = $('chart');
      fit(el, chartBox, Math.max(9, Math.min(15, k * 4.6)));
      if (el.dataset.frame !== String(frameSeq)) { el.dataset.frame = String(frameSeq); drawChart(el, false); }
    }

    if (tapeBox) {
      const el = $('tape');
      fit(el, { x: tapeBox.x + 1, y: tapeBox.y + 1, w: tapeBox.w - 2, h: tapeBox.h - 2 }, Math.max(11.5, Math.min(18, k * 6.2)));
      if (`${frameSeq}|${sel && sel.at}` !== tapeKey) {
        tapeKey = `${frameSeq}|${sel && sel.at}`;
        const groups = [];
        for (const f of recentFills(M)) {            // newest first; a run of the same maker trade is one line
          const g = groups[groups.length - 1];
          if (f.source === 'maker' && g && g.source === 'maker' && g.ticker === f.ticker && g.side === f.side) { g.qty += f.qty; g.val += f.qty * f.px; }
          else groups.push({ ...f, val: f.qty * f.px });
        }
        el.innerHTML = `<div class="th"><span>Recent fills</span><span>all strategies</span></div>` +
          (groups.length
            ? `<ol>${groups.map((g) => `<li class="${g.side}${sel && sel.at === g.at ? ' on' : ''}"${g.source === 'maker' ? ` data-t="${esc(g.ticker)}" data-at="${g.at}"` : ''}><span class="act"><b>${esc(g.action)}</b> ${g.qty}</span><span class="px">${cc(g.val / g.qty)}</span>` +
              `<span class="nm">${esc(fillName(g))}${g.source === 'taker' ? ` · ${esc(g.venue)}` : ''}</span><span class="ago">${ago(g.at).replace(' ago', '')}</span></li>`).join('')}</ol>`
            : `<p class="none">${M.fills ? `${M.fills} fills before the last restart` : 'No fills yet'}</p>`);
        const ol = el.querySelector('ol');
        el.classList.toggle('more', !!ol && ol.scrollHeight > ol.clientHeight + 2);
      }
    }

    if (clockBox) {
      const el = $('clock');
      fit(el, clockBox, Math.max(12, Math.min(26, k * 10)));
      const halted = S.halt || M.halted, on = !halted && M.quoting > 0;
      const t = new Date(S.now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      const hm = t.replace(/ [AP]M$/, '');
      const html = `<b class="${on ? 'on' : ''}">${hm.slice(0, -3)}<span class="sec">${hm.slice(-3)}</span></b><small>${t.slice(-2)} ET</small>`;
      if (html !== clockTxt) { el.innerHTML = html; clockTxt = html; }
    }
  }

  // A run of identical fills shows as one line; clicking it recaps the newest of them.
  $('tape').addEventListener('click', (ev) => {
    const li = ev.target.closest('li[data-t]');
    if (!li) return;
    const at = +li.dataset.at;
    sel = sel && sel.at === at ? null : { kind: 'market', key: li.dataset.t, at };
    wallKey = ''; tapeKey = '';
  });

  wireChart($('chart'), false);

  // The large chart used to open on the wall screen, which is a short strip of the room: its plot
  // came out 60px tall, smaller than the stand it was opened from. It opens over the page instead.
  const bigChart = $('chartbig');
  wireChart($('chartbig-pnl'), true);
  function openBigChart() { bigChart.hidden = false; chart.band = null; drawChart($('chartbig-pnl'), true); bigChart.querySelector('.cbback').focus(); }
  function closeBigChart() { if (bigChart.hidden) return; bigChart.hidden = true; chart.hoverT = null; chart.dragFrom = null; chart.band = null; }
  bigChart.addEventListener('click', (ev) => { if (ev.target === bigChart || ev.target.closest('[data-close]')) closeBigChart(); });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeBigChart(); });

  $('wall').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.back) sel = null;
    else if (b.dataset.all) wallAll = !wallAll;
    else if (b.dataset.wcol) {
      if (wallSortCol === b.dataset.wcol) wallSortDir = wallSortDir === 'asc' ? 'desc' : 'asc';
      else { wallSortCol = b.dataset.wcol; wallSortDir = b.dataset.wcol === 'name' ? 'asc' : 'desc'; }
    }
    else if (b.dataset.m) sel = sel && sel.kind === 'market' && sel.key === b.dataset.m ? null : { kind: 'market', key: b.dataset.m };
    wallKey = '';
  });

  function loop(ts) { drawFloor(ts / 1000); placeFx(); requestAnimationFrame(loop); }
  requestAnimationFrame(loop);

  // ------------------------------------------------------------ Ask: questions about the desk, in plain words
  // A question goes to the server, which has Claude look through the desk's state with read-only
  // tools and write a short answer. The POST returns at once with a job id and this polls the job
  // about once a second, showing each step as it happens. Nothing in here can trade or change the
  // desk: the only thing this code ever sends is a question.
  //
  // The floor keeps running the whole time. The drawer sits beside it (or over the right-hand
  // boards on a narrow window) and closes back to exactly the page it opened on.
  const ASK_KEY = 'hex-ask', ASK_MAX = 2000, ASK_TURNS = 40;
  const ASK_CHIPS = ["Why hasn't the desk traded today?", 'How is the maker desk doing?', 'What did the whales bet on today?', 'Is anything wrong right now?'];
  // 'lost': polls kept failing while the desk was answering. The job may still finish on the desk,
  // so the turn keeps its id and is checked again every ASK_LOST_MS instead of being given up on.
  const ASK_STATUS = ['sending', 'working', 'lost', 'done', 'error'];
  const ASK_POLL_MS = 6000, ASK_POST_MS = 15000, ASK_LOST_MS = 15000;   // a poll is a tiny read from memory
  const ASK_HOLD_MS = 5 * 60 * 1000;     // New chat waits this long for a running question (see askControls)
  const ask = { open: false, conversation: null, turns: [], unread: false, gen: 0, toEnd: false, toLast: false };
  const askDollars = (x) => (x > 0 && x < 0.005 ? 'under $0.01' : `$${(+x || 0).toFixed(2)}`);
  const askSteps = (steps) => (Array.isArray(steps) ? steps.filter((s) => s && s.text != null).map((s) => ({ at: +s.at || 0, text: String(s.text) })) : []);
  const askRunning = () => ask.turns.some((t) => t.status === 'sending' || t.status === 'working');
  const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
  const askSentence = (s) => { const t = String(s).trim(); return /[.!?]$/.test(t) ? t : `${t}.`; };
  // The desk ends a refusal with "· start a new chat" when the chat itself is over (expired, too
  // long, too many questions). "try a narrower question, or start a new chat" is about one question,
  // and the chat can still take a narrower one, so that one keeps the chat id.
  const askChatGone = (msg) => /(^|·\s*)start a new chat/i.test(String(msg || ''));
  // fetch with a deadline, body included: a socket that went dead (a laptop waking, a Wi-Fi handoff)
  // never settles on its own, and a request that never settles would hold a question in "working"
  // for good. Throws on a network error or the deadline, like fetch does.
  async function askFetch(url, opts, ms) {
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      return { status: r.status, ok: r.ok, text: await r.text() };
    } finally { clearTimeout(timer); }
  }

  // The answer is untrusted text. ALL of it is escaped first; only then are the four marks the
  // server promises added back: blank-line paragraphs, "- " bullets, **bold** and `code`. Because
  // escaping comes first, the only tags that can reach the page are the ones written here -- a
  // <script> inside an answer shows up as the literal characters. No links, on purpose.
  // (tools/askui-test.js lifts esc, askInline and askFormat out of this file by their text and
  // checks them in node, so keep them free of the page around them)
  function askInline(s) {
    // `code` is parked behind a \0 marker before bold is matched: a ** inside code stays literal,
    // and **bold** can still wrap `code`. Bold must hug its words, so "2 ** 3 ** 4" stays as typed.
    const code = [];
    return esc(String(s).replace(/\0/g, ''))
      .replace(/`([^`\n]+)`/g, (m, c) => `\0${code.push(c) - 1}\0`)
      .replace(/\*\*(?=[^\s*])([^\n]*?[^\s*])\*\*/g, '<b>$1</b>')
      .replace(/\0(\d+)\0/g, (m, i) => `<code>${code[i]}</code>`);
  }
  function askFormat(text) {
    const blocks = String(text == null ? '' : text).replace(/\r\n?/g, '\n').trim().split(/\n[ \t]*\n+/);
    return blocks.map((block) => {
      if (!block.trim()) return '';
      let out = '', para = [], items = [];
      const endPara = () => { if (para.length) out += `<p>${para.map(askInline).join('<br>')}</p>`; para = []; };
      const endList = () => { if (items.length) out += `<ul>${items.map((x) => `<li>${askInline(x)}</li>`).join('')}</ul>`; items = []; };
      for (const line of block.split('\n')) {
        const m = line.match(/^\s*- (.*)$/);
        if (m) { endPara(); items.push(m[1]); }
        else if (items.length && /^\s+\S/.test(line)) items[items.length - 1] += ` ${line.trim()}`;   // a bullet wrapped onto an indented line
        else { endList(); para.push(line); }
      }
      endPara(); endList();
      return out;
    }).join('').replace(/<\/ul><ul>/g, '');   // "- a", blank line, "- b" is still one list (escaped text holds no "<")
  }

  // Keep the chat across a page reload (not across tabs or a closed browser: sessionStorage).
  // Anything read back is re-shaped field by field; the render escapes it all again regardless.
  const askClean = (t) => ({
    q: String(t.q), id: t.id == null ? null : String(t.id), conv: typeof t.conv === 'string' ? t.conv : null, fresh: t.fresh === true,
    status: ASK_STATUS.includes(t.status) ? t.status : 'error',
    steps: askSteps(t.steps), answer: t.answer == null ? null : String(t.answer), error: t.error == null ? null : String(t.error),
    usd: t.usd == null || !Number.isFinite(+t.usd) ? null : +t.usd, searches: +t.searches || 0, t0: +t.t0 || Date.now(), took: +t.took || null,
  });
  try {
    const saved = JSON.parse(sessionStorage.getItem(ASK_KEY) || 'null');
    if (saved && Array.isArray(saved.turns)) {
      ask.conversation = typeof saved.conversation === 'string' ? saved.conversation : null;
      ask.turns = saved.turns.filter((t) => t && typeof t.q === 'string').slice(-ASK_TURNS).map(askClean);
    }
  } catch { /* private window or blocked storage: start with an empty chat */ }
  const askSave = () => { try { sessionStorage.setItem(ASK_KEY, JSON.stringify({ conversation: ask.conversation, turns: ask.turns.slice(-ASK_TURNS) })); } catch { /* ignore */ } };

  // Can a question be sent right now, and if not, why not -- in words, because the answer is
  // usually "a key is missing" or "the desk needs restarting", which a person can act on.
  function askState() {
    if (!S) return { on: false, why: 'Waiting for the desk to connect.' };
    const A = S.ask;
    if (!A || typeof A !== 'object') return { on: false, why: 'Ask needs the server update: restart the desk on the newest code to turn it on.' };
    if (!A.enabled) return { on: false, why: `Ask is off: ${String(A.reason || 'the desk did not say why').replace(/\.?\s*$/, '.')}` };
    if (stale()) return { on: false, why: 'The desk stopped answering. Ask works again when it comes back.' };
    return { on: true, why: '' };
  }

  function askTurnHtml(t) {
    let h = `${t.fresh ? '<div class="asknew">New chat · the desk forgot the questions above</div>' : ''}<div class="askq">${esc(t.q)}</div>`;
    if (t.status === 'sending' || t.status === 'working') {
      const secs = Math.max(0, Math.round((Date.now() - t.t0) / 1000));
      const recent = t.steps.slice(-3), now = recent.pop();
      const doing = now ? now.text : t.status === 'sending' ? 'sending your question' : 'thinking';
      return h + `<div class="aska working">${recent.map((s) => `<div class="old">${esc(cap(s.text))}</div>`).join('')}` +
        `<div><span class="spin" aria-hidden="true"></span>${esc(cap(doing))}…</div><div class="askmeta">${secs}s</div></div>`;
    }
    if (t.status === 'lost') return h + `<div class="aska lost"><p>${esc(t.error || 'Lost contact with the desk.')}</p></div>`;
    h += t.status === 'error'
      ? `<div class="aska error"><p>${esc(t.error || 'Something went wrong.')}</p></div>`
      : `<div class="aska">${t.answer ? askFormat(t.answer) : '<p>No answer came back.</p>'}</div>`;
    if (t.steps.length) {
      h += `<details class="askhow"><summary>What it looked at · ${t.steps.length} step${t.steps.length === 1 ? '' : 's'}</summary>` +
        `<ol>${t.steps.map((s) => `<li>${esc(cap(s.text))}</li>`).join('')}</ol></details>`;
    }
    const meta = [];
    if (t.usd != null && (t.usd > 0 || t.status === 'done')) meta.push(askDollars(t.usd));
    if (t.took) meta.push(`${Math.max(1, Math.round(t.took / 1000))}s`);
    if (t.searches) meta.push(`${t.searches} web search${t.searches === 1 ? '' : 'es'}`);
    return h + (meta.length ? `<div class="askmeta">${meta.join(' · ')}</div>` : '');
  }

  const askEmptyHtml = (on) => `<div class="askempty"><p>Ask anything about the desk in plain words. Claude looks through the desk's live state to answer. It can look, but it cannot trade or change anything.</p>` +
    `<div class="askchips">${ASK_CHIPS.map((c, i) => `<button type="button" data-chip="${i}"${on ? '' : ' disabled'}>${esc(c)}</button>`).join('')}</div></div>`;

  // Rebuild a node only when its markup actually changed: the progress line ticks every second,
  // and re-writing a finished answer would throw away a text selection or an opened step list.
  const askSet = (el, h) => { if (el._h === h) return false; el.innerHTML = h; el._h = h; return true; };

  function askControls() {
    const st = askState(), q = $('ask-q'), n = q.value.length, c = $('ask-count');
    q.disabled = !st.on;
    $('ask-send').disabled = !st.on || askRunning() || !q.value.trim();
    // The desk has no way to stop a question once it starts: leaving it would still spend on it and
    // hold one of the desk's two question slots, with nobody to read the answer. So wait for it --
    // unless it has run far longer than any real answer takes, when something is stuck and New chat
    // is the way out.
    const nw = $('ask-new'), hold = ask.turns.some((t) => (t.status === 'sending' || t.status === 'working') && Date.now() - t.t0 < ASK_HOLD_MS);
    nw.disabled = !ask.turns.length || hold;
    nw.title = hold ? 'Wait for this answer first: the desk finishes a question once it starts, and it still costs' : '';
    c.textContent = n >= ASK_MAX - 300 ? `${n} / ${ASK_MAX}` : '';
    c.classList.toggle('near', n >= ASK_MAX - 100);
    return st;
  }

  function renderAsk() {
    const btn = $('askbtn'), running = askRunning();
    btn.classList.toggle('on', ask.open);
    btn.classList.toggle('busy', running);
    btn.classList.toggle('unread', ask.unread && !running && !ask.open);
    // the dot is only colour, so the button's name carries the same news for a screen reader
    const label = `Ask the desk a question${running ? ' (answering now)' : ask.unread && !ask.open ? ' (an answer is ready)' : ''}`;
    if (btn.getAttribute('aria-label') !== label) btn.setAttribute('aria-label', label);
    if (!ask.open) return;               // the insides only matter while someone can see them

    const A = S && S.ask;
    // money first: on a phone the line runs out of room, and the model name is the part to lose
    askSet($('ask-sub'), !A ? '' : !A.enabled ? 'off'
      : [A.budgetLeft != null && Number.isFinite(+A.budgetLeft) ? `<b>${askDollars(Math.max(0, +A.budgetLeft))}</b> left today` : '', A.model ? esc(A.model) : ''].filter(Boolean).join(' · '));
    const st = askControls(), note = $('ask-note');
    note.hidden = st.on;
    if (note.textContent !== st.why) note.textContent = st.why;

    const log = $('ask-log');
    if (!ask.turns.length) {
      if (log.dataset.mode !== 'empty') { log.dataset.mode = 'empty'; log._h = null; }
      if (askSet(log, askEmptyHtml(st.on))) log.scrollTop = 0;   // a new chat starts at the top, not where the old one was scrolled
      log.removeAttribute('aria-busy');
      return;
    }
    if (log.dataset.mode !== 'chat') { log.innerHTML = ''; log._h = null; log.dataset.mode = 'chat'; }
    const nearEnd = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
    while (log.children.length > ask.turns.length) log.lastElementChild.remove();
    let changed = false, landed = null;
    ask.turns.forEach((t, i) => {
      let el = log.children[i];
      if (!el) { el = document.createElement('div'); el.className = 'askturn'; log.append(el); }
      if (askSet(el, askTurnHtml(t))) {
        changed = true;
        // an answer that just arrived: show its start, not its end
        if (el._st && el._st !== t.status && (t.status === 'done' || t.status === 'error')) landed = el;
        el._st = t.status;
      }
    });
    // a screen reader hears the answer once it lands, not the seconds ticking on the way
    log.setAttribute('aria-busy', String(running));
    // an answer that arrived while the drawer was shut is read from its start too
    const start = landed && (nearEnd || ask.toEnd) ? landed : ask.toLast ? log.lastElementChild : null;
    if (start) log.scrollTop = start.offsetTop - 8;
    else if (ask.toEnd || (changed && nearEnd)) log.scrollTop = log.scrollHeight;
    ask.toEnd = false; ask.toLast = false;
  }

  function askOpen() {
    ask.open = true; ask.toLast = ask.unread; ask.unread = false; ask.toEnd = true;
    $('askdrawer').classList.add('open');
    document.body.classList.add('ask-open');
    $('askbtn').setAttribute('aria-expanded', 'true');
    renderAsk();
    // preventScroll: the drawer starts off-screen, and focusing it would scroll the page to chase it
    ($('ask-q').disabled ? $('ask-close') : $('ask-q')).focus({ preventScroll: true });
  }
  function askClose() {
    const inside = $('askdrawer').contains(document.activeElement);
    ask.open = false;
    $('askdrawer').classList.remove('open');
    document.body.classList.remove('ask-open');
    $('askbtn').setAttribute('aria-expanded', 'false');
    renderAsk();
    if (inside) $('askbtn').focus({ preventScroll: true });
  }
  function askReset() {
    ask.gen++;                            // any poll still running for the old chat stops at its next step
    ask.conversation = null; ask.turns = []; ask.unread = false;
    askSave(); renderAsk();
    if (!$('ask-q').disabled) $('ask-q').focus({ preventScroll: true });
  }

  async function askPost(body) {
    try {
      const r = await askFetch('/api/ask', { method: 'POST', headers: { 'x-hexagon-action': '1', 'content-type': 'application/json' }, body: JSON.stringify(body) }, ASK_POST_MS);
      const text = r.text;
      if (r.status === 404) return { ok: false, error: 'the desk is running older code. Restart it to use Ask.' };
      if (r.status === 401) return { ok: false, error: 'your dashboard login expired. Reload the page to sign in again.' };
      let j = null; try { j = JSON.parse(text); } catch { /* not JSON: use the text */ }
      if (!r.ok || !j) return { ok: false, error: (j && j.error) || text.slice(0, 200) || `the desk answered ${r.status}` };
      return j.ok && j.id ? j : { ok: false, error: j.error || 'the desk did not start the question' };
    } catch (e) {
      // the POST normally returns at once; one this slow may or may not have started the question
      if (e && e.name === 'AbortError') return { ok: false, error: `the desk did not reply within ${ASK_POST_MS / 1000}s` };
      return { ok: false, error: `could not reach the desk (${e.message})` };
    }
  }

  // The log is hidden while the drawer is shut, so it cannot announce anything; this status line
  // outside the drawer tells a screen reader an answer landed. Emptied first so a repeat is heard.
  function askAnnounce(msg) {
    const el = $('ask-live');
    el.textContent = '';
    setTimeout(() => { el.textContent = msg; }, 60);
  }

  function askFinish(turn, status, error) {
    turn.status = status;
    if (error) turn.error = error;
    if (!turn.took) turn.took = Date.now() - turn.t0;
    if (!ask.open) { ask.unread = true; askAnnounce(status === 'done' ? 'The desk answered your question. Open Ask to read it.' : "The desk couldn't answer your question. Open Ask to see why."); }
  }
  // The desk has let go of the chat this turn was part of: the next question starts a fresh one. Only
  // if it is still the chat in use -- a slow check on an old question must not drop a newer chat.
  function askDropChat(turn) {
    if (!ask.conversation || (turn.conv && turn.conv !== ask.conversation)) return;
    ask.conversation = null;
    turn.error = `${turn.error || ''} Your next question starts a fresh chat.`.trim();
  }

  async function askSend(text) {
    const question = String(text || '').trim();
    if (!question || question.length > ASK_MAX || !askState().on || askRunning()) return;
    const gen = ask.gen, q = $('ask-q');
    // the first question after the desk dropped a chat gets a divider: the turns above it are still
    // on screen, but the desk no longer remembers them
    const since = ask.turns.slice(Math.max(0, ask.turns.map((t) => t.fresh).lastIndexOf(true)));
    const turn = askClean({ q: question, status: 'sending', t0: Date.now(), fresh: !ask.conversation && since.some((t) => t.id) });
    ask.turns.push(turn);
    if (ask.turns.length > ASK_TURNS) ask.turns.splice(0, ask.turns.length - ASK_TURNS);
    q.value = ''; askGrow(); ask.toEnd = true;
    askSave(); renderAsk();

    const body = { question };
    if (ask.conversation) body.conversation = turn.conv = ask.conversation;
    const r = await askPost(body);
    if (gen !== ask.gen) return;          // New chat was pressed while the question was on its way
    if (r.ok) {
      turn.id = String(r.id); turn.status = 'working';
      if (typeof r.conversation === 'string' && r.conversation) ask.conversation = turn.conv = r.conversation;
    } else {
      askFinish(turn, 'error', `Couldn't ask: ${askSentence(r.error || 'the desk said no')}`);
      turn.took = null;
      // a follow-up to a chat the desk no longer has can never succeed, so drop the chat id
      if (body.conversation && askChatGone(r.error)) askDropChat(turn);
      if (!q.value) { q.value = question; askGrow(); }   // hand the words back rather than make them retype
    }
    askSave(); renderAsk();
    if (turn.status === 'working') askPoll(turn, gen);
  }

  async function askPoll(turn, gen) {
    let misses = 0;
    while (gen === ask.gen && (turn.status === 'working' || turn.status === 'lost')) {
      // a blip gets a few slower retries; after that the turn is 'lost' and checked every 15s, because
      // the answer (already paid for) is kept on the desk for an hour and may still be there
      await sleep(turn.status === 'lost' ? ASK_LOST_MS : misses ? Math.min(5000, 1000 * (misses + 1)) : 1000);
      if (gen !== ask.gen) return;
      let r = null, j = null;
      try { r = await askFetch(`/api/ask/${encodeURIComponent(turn.id)}`, { cache: 'no-store' }, ASK_POLL_MS); } catch { /* network blip, or no reply in time */ }
      if (gen !== ask.gen) return;
      if (r && r.status === 404) {
        // jobs live in the server's memory, so a 404 means it restarted (or an hour passed)
        askFinish(turn, 'error', "The desk doesn't have this question any more: it restarted, or the answer expired. Ask again.");
        askDropChat(turn);
        break;
      }
      if (r && r.status === 401) { askFinish(turn, 'error', 'Your dashboard login expired. Reload the page to sign in again.'); break; }
      if (r && r.ok) { try { j = JSON.parse(r.text); } catch { /* half a response: treat as a blip */ } }
      if (!j || typeof j !== 'object') {
        if (turn.status === 'working' && ++misses >= 6) {
          turn.status = 'lost';
          turn.error = `Lost contact with the desk while it was answering. Checking again every ${ASK_LOST_MS / 1000}s: the answer shows here if the desk still has it.`;
          askSave(); renderAsk();
        }
        continue;
      }
      misses = 0;
      if (turn.status === 'lost') { turn.status = 'working'; turn.error = null; }
      turn.steps = askSteps(j.steps);
      if (j.usd != null && Number.isFinite(+j.usd)) turn.usd = +j.usd;
      turn.searches = +j.searches || 0;
      if (j.status === 'done' || j.status === 'error') {
        if (j.doneAt && j.startedAt) turn.took = j.doneAt - j.startedAt;     // the server's own clock, both ends
        if (j.status === 'done') { turn.answer = j.answer == null ? null : String(j.answer); askFinish(turn, 'done'); }
        else {
          askFinish(turn, 'error', `Couldn't answer: ${askSentence(j.error || 'something went wrong on the desk')}`);
          // a chat can end mid-question too ("this chat has grown too long · start a new chat")
          if (askChatGone(j.error)) askDropChat(turn);
        }
      }
      askSave(); renderAsk();
    }
    if (gen === ask.gen) { askSave(); renderAsk(); }
  }

  function askGrow() { const q = $('ask-q'); q.style.height = 'auto'; q.style.height = `${Math.min(160, q.scrollHeight + 2)}px`; }

  $('askbtn').addEventListener('click', () => (ask.open ? askClose() : askOpen()));
  $('ask-close').addEventListener('click', askClose);
  $('ask-new').addEventListener('click', askReset);
  $('ask-form').addEventListener('submit', (ev) => { ev.preventDefault(); askSend($('ask-q').value); });
  $('ask-q').addEventListener('keydown', (ev) => {
    // Enter sends, Shift+Enter is a new line; never send in the middle of composing an accented character
    if (ev.key === 'Enter' && !ev.shiftKey && !ev.isComposing && ev.keyCode !== 229) { ev.preventDefault(); askSend(ev.target.value); }
  });
  $('ask-q').addEventListener('input', () => { askGrow(); askControls(); });
  $('ask-log').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-chip]');
    if (!b || b.disabled) return;
    askSend(ASK_CHIPS[+b.dataset.chip]);
    // sending replaces the chips with the chat, and the focused chip with them: without this, focus
    // falls to the page and the next Tab starts from the top
    $('ask-q').focus({ preventScroll: true });
  });
  // Escape inside the drawer belongs to the drawer: it never reaches the floor's selection or the
  // alert panel. An Escape that ends an IME conversion (isComposing, or keyCode 229 in Safari)
  // cancels the conversion only.
  const imeKey = (ev) => ev.isComposing || ev.keyCode === 229;
  $('askdrawer').addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape') return;
    ev.stopPropagation();
    if (!imeKey(ev)) askClose();
  });
  // Escape elsewhere closes one layer at a time: an open alert panel first (its own listener does
  // that), the drawer on the next press. Capture phase, so the panel is seen as it was before this
  // same key closed it.
  window.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Escape' || !ask.open || imeKey(ev) || $('askdrawer').contains(ev.target)) return;
    if ($('alertpanel').hidden) askClose();
  }, true);
  // the elapsed seconds, and the input turning off if the desk stops sending frames (render() only runs on a frame)
  setInterval(() => { if (ask.open) renderAsk(); }, 1000);
  // a reload in the middle of a question picks the job back up; one that never reached the desk cannot
  // be. A lost one gets its quick retries again: the reload may be the network coming back.
  for (const t of ask.turns) {
    if ((t.status === 'working' || t.status === 'lost') && t.id) { t.status = 'working'; t.error = null; askPoll(t, ask.gen); }
    else if (t.status === 'sending' || t.status === 'working' || t.status === 'lost') { t.status = 'error'; t.error = 'The page reloaded before the desk replied. Ask again.'; }
  }
  askSave();

  // ------------------------------------------------------------ wiring
  function render() { frameSeq++; renderHeader(); renderMobileSummary(); ingest(); renderAsk(); if (!bigChart.hidden) drawChart($('chartbig-pnl'), true); }
  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rx = S.now; S._rxPerf = performance.now(); lastFrameAt = Date.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  wireFloor();
  connect();
  renderAsk();
  
})();

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
      else if (mobileSort === 'value') markets.sort((a, b) => Math.abs(b.mark || 0) - Math.abs(a.mark || 0));
      else if (mobileSort === 'loss') markets.sort((a, b) => ((a.mark || 0) - (a.cost || 0)) - ((b.mark || 0) - (b.cost || 0)));
      else markets.sort((a, b) => Math.abs(b.inv) - Math.abs(a.inv));
      title = `Holding ${markets.length} market${markets.length === 1 ? '' : 's'}`;
      note = `${(+M.inv || 0).toLocaleString()} contracts in the book right now.`;
      rows = markets.map((m) => {
        const pl = r2((m.mark || 0) - (m.cost || 0));
        return `<li><div><b>${esc(OUTCOME(m) || QUESTION(m) || m.ticker)}</b>` +
          `${OUTCOME(m) && QUESTION(m) ? `<small>${esc(QUESTION(m))}</small>` : ''}</div>` +
          `<span class="${pl >= 0 ? 'pos' : 'neg'}">${m.inv > 0 ? 'Long' : 'Short'} ${Math.abs(m.inv).toLocaleString()}<small>${money(Math.abs(m.mark || 0))} worth · ${signed(pl)}</small></span></li>`;
      });
    } else {
      let fills = recentFills(M);
      if (mobileSort === 'size') fills.sort((a, b) => (+b.qty || 0) - (+a.qty || 0));
      else if (mobileSort === 'name') fills.sort((a, b) => fillName(a).localeCompare(fillName(b)));
      title = 'Recent fills';
      note = 'Maker and cross-venue entries and closes, newest first.';
      rows = fills.map((f) => `<li><div><b>${esc(fillName(f))}</b><small>${ago(f.at)} · ${f.source === 'maker' ? 'maker' : f.venue}</small></div>` +
        `<span class="${f.side === 'buy' ? 'pos' : 'neg'}">${esc(f.action)} ${(+f.qty || 0).toLocaleString()}<small>at ${cc(f.px)} · ${fillMoney(f, f.qty * f.px)}</small></span></li>`);
    }
    const sorts = mobileInfo === 'holding' ? [['size', 'Largest'], ['pnl', 'Gainers'], ['loss', 'Losers'], ['value', 'Value'], ['name', 'Name']] : [['size', mobileInfo === 'quoting' ? 'Flow' : 'Size'], ['name', 'Name']];
    return `<section class="m-detail" id="mobile-detail"><div class="m-detail-head"><div><b>${title}</b><small>${note}</small></div>` +
      `<button type="button" data-mobile-close="1" aria-label="Close ${mobileInfo} details">✕</button></div>` +
      `<div class="m-sort" role="toolbar" aria-label="Sort ${mobileInfo} list">${sorts.map(([k, l]) => `<button type="button" data-mobile-sort="${k}" class="${mobileSort === k ? 'on' : ''}">${l}</button>`).join('')}</div>` +
      (rows.length ? `<ol>${rows.join('')}</ol>` : `<p>Nothing to show yet.</p>`) + `</section>`;
  }

  let mobileChart = null;
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
      ? `<div class="m-fill"><div><span class="m-label">Latest fill</span><b>${esc(lf.action)} ${lf.qty} at ${cc(lf.px)} · ${money(lf.qty * lf.px)}</b></div>` +
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
    // This card is rebuilt on every frame, but a chart is not: the first one built stays, and each
    // new card gets it moved in, so the plot is not torn down and redrawn every two seconds.
    const slot = $('mobile-chart');
    if (slot) {
      if (!mobileChart) { mobileChart = slot; wireChart(slot, false); } else slot.replaceWith(mobileChart);
      drawChart(mobileChart, false);
    }
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
  // 2026-09-19: the floor gave 40 units back to the wall. The desks were the biggest thing in the
  // room and the boards -- the part with the words on it -- were squeezed around them; the bots are
  // smaller now, the boards and the P&L stand are larger, and the feed under the room is taller.
  const ROOM_H = 282, WALL_H = 172, SIDE_W = 120;
  // the deepest the desks can be: back row, front row and the front nametag take 4 + 101 units per SEAT
  const SEAT_MAX = (ROOM_H - WALL_H - 4) / 101;
  let L = null;
  function layout(RW) {
    if (L && L.RW === RW) return L;
    // the desks live between the P&L stand on the left and the server rack on the right
    const bandL = 176, bandR = RW - 40, band = bandR - bandL, gap = 16;
    // How big a desk MAY be is a question about HEIGHT, not width. The back row, the front row and
    // the front row's nametag all have to fit in the 150 units under the wall, and 1.45 is where the
    // nametag reaches the floor line -- so past a certain width the desks stop growing no matter how
    // much room there is. Widening the room therefore cannot make the cast bigger. What it can do is
    // spread it out: on a 2.8:1 window the desks used to take 70% of the floor they stand on and
    // huddle in the middle of an empty plain. The width the seats cannot use goes into the gap
    // between them instead, up to half a desk, and then stops -- seven desks scattered to the far
    // corners is the same mistake in the other direction.
    const SEAT = Math.max(0.8, Math.min(SEAT_MAX, (band - 3 * gap) / 256));
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
      // the clock is the fill board's header now: one board, not a case with a clock in it
      tape:   { x: RW - SIDE_W - 8, y: 6, w: SIDE_W, h: WALL_H - 26 },
      // the glass stops 20 units short of the floor line: that strip is where the back row's bubbles
      // go, and it is the only reason a bubble can no longer cover the number it is talking about
      screen: { x: SIDE_W + 18, y: 2, w: RW - 2 * SIDE_W - 36, h: WALL_H - 26 },
      // the stand starts just under the wall: the 24 units above it were empty floor that no
      // desk can use (the desks start at bandL), and the plot is the one board that wants height
      chart:  { x: 4, y: WALL_H + 6, w: bandL - 10, h: ROOM_H - WALL_H - 10 },
      rack:   { x: RW - 34, y: WALL_H + 18, w: 26, h: 60 },
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

    // ---- the fill tape, clock in its header (right): boards drawn here, words laid over them (placeBoards)
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
      labels.push({ key: a.key, bx: x + 32 * Z, by: y + (22 + bob) * Z, top: y - 18 * Z, foot: y + 31 * Z, plate: y + 15.5 * Z, px: x + 52 * Z,
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
  let seats = [], statusBox = null, wallBox = null, tapeBox = null, chartBox = null;
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
  const marketName = (tk, f) => { const m = byTicker(S.maker || {}, tk) || (f && f.title ? f : null); return (m && (OUTCOME(m) || QUESTION(m))) || tk.replace(/^KX/, ''); };
  const fillName = (f) => f.label || (f.ticker ? marketName(f.ticker, f) : 'Unknown market');
  // the same name in two parts -- what, then which event -- so a short line drops the event first
  const fillParts = (f) => {
    if (f.label) { const { outcome, question } = splitLabel(f.label); return lead(outcome, question); }
    const m = (f.ticker && byTicker(S.maker || {}, f.ticker)) || (f.title ? f : null);
    return m ? lead(OUTCOME(m), QUESTION(m)) : { head: fillName(f), tail: '' };
  };
  const fillHtml = (f, extra = '') => { const p = fillParts(f); return `<span>${esc(unellipsis(p.head))}</span>${p.tail ? `<i> · ${esc(unellipsis(p.tail))}</i>` : ''}${extra}`; };
  // A trade that closes something is told by what it made or lost, green or red: what it was worth
  // says little once it is over. For the maker that is any fill that realised a profit or a loss (a
  // sale out of a long, a buy that covers a short); a sale that only opened a short made nothing yet,
  // and a row of grey $0.00s said so at length, so it shows what it was worth like any opening trade.
  // A cross-venue close or settlement always shows its result. A fill from before the desk recorded
  // its profit keeps its value. `val` is what the fill was worth.
  const closes = (f) => Number.isFinite(f.pnl) && (f.source === 'maker' ? Math.abs(f.pnl) >= 0.005 : f.action === 'Closed' || f.action === 'Settled');
  const fillMoney = (f, val) => (!closes(f) ? money(val)
    : Math.abs(f.pnl) < 0.005 ? money(0) : `<span class="${f.pnl > 0 ? 'pos' : 'neg'}">${signed(f.pnl)}</span>`);
  function recentFills(M) {
    const making = (M.recent || []).map((f) => ({ ...f, source: 'maker', action: f.side === 'buy' ? 'Bought' : 'Sold', label: marketName(f.ticker, f) }));
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

  // the name of a position a log line is about (a bot's note carries them as `refs`)
  const refName = (r) => { const t = lead(splitLabel(r.label).outcome, splitLabel(r.label).question); return t.head + (t.tail ? ` · ${t.tail}` : ''); };
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
      // a note about a position that does not name it gets the name underneath
      if (!s.sub && Array.isArray(e.refs) && e.refs.length) s = { ...s, sub: e.refs.map((r) => unellipsis(refName(r))).join('; ') };
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
      // 2026-09-19: a nameplate on the desk's front, to the right of the bot sitting at it
      Object.assign(n.name.style, { left: `${X(st.px)}px`, top: `${Y(st.plate)}px`, color: st.lit || st.act ? st.color : '' });
      n.name.style.setProperty('--c', st.color);
      n.name.classList.toggle('on', st.act || st.lit);
      n.name.hidden = false;

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
    el.classList.toggle('compact', statusBox.h * k < 230);
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
    // 2026-09-19: the label-and-sentence grid wrapped every figure onto two or three lines. Now two
    // figures set large with a word under each, the last fill as one line plus its market, and the
    // standing facts as a footer.
    const tile = (v, label, off) => `<div class="${off ? 'off' : ''}"><b>${v}</b><span>${label}</span></div>`;
    const am = S.anyMarket && S.anyMarket.enabled ? S.anyMarket : null;
    const html = `<div class="st ${cls}"><i></i>${state}<em class="${live ? 'real' : ''}">${live ? 'LIVE' : 'PAPER'}</em></div>` +
      (gone || halted ? `<p class="alarm">${esc(gone ? 'The desk stopped answering' : `Trading stopped: ${halted}`)}</p>` : '') +
      `<div class="tiles">` +
      tile(working ? M.quoting : 0, 'quoting', !working) +
      tile(nHeld ? (M.inv || 0).toLocaleString() : 0, nHeld ? `held in ${nHeld}` : 'held', !nHeld) +
      `</div>` +
      `<div class="lf"><span class="lh">Last fill${lf ? ` · ${ago(lf.at)}` : ''}</span>` +
      (lf
        ? `<span class="lx ${lf.side === 'sell' || lf.action === 'Sold' ? 'sell' : 'buy'}"><b>${esc(lf.action)} ${lf.qty}</b><span>at ${cc(lf.px)}</span><em>${fillMoney(lf, lf.qty * lf.px)}</em></span><span class="ln fitw">${fillHtml(lf)}</span>`
        : `<span class="ln">${M.fills ? `${M.fills} before the restart` : 'None yet'}</span>`) +
      `</div>` +
      // the taker's reach: markets matched on both venues, across every category
      (am ? `<div class="pairs extra"><span class="lh">Both venues</span><span><b>${S.pairCount || 0}</b> matched · <b>${am.rulesVerified || 0}</b> tradeable</span></div>` : '') +
      `<p class="dim">Up ${dur(S.now - S.startedAt)} · ${feed.mode === 'stream' && feed.connected ? 'live feed' : 'polling'}</p>`;
    const key = `${html}|${Math.round(statusBox.w * k)}x${Math.round(statusBox.h * k)}`;
    if (key !== statusHtml) { el.innerHTML = html; statusHtml = key; fitText(el, Math.max(12, Math.min(21, k * 7.2)), 9); fitAll(el); }
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
    // the number's own box is its column's width less the padding, so the digits stop short of the rule
    const maxW = el.clientWidth + 1;
    let fs = parseFloat(getComputedStyle(el).fontSize);
    while (el.scrollWidth > maxW && fs > minFs) { fs -= 1; el.style.fontSize = `${fs}px`; }
  }

  // ------------------------------------------------------------ the P&L chart
  // A chart you can ask things of. The headline is one number: every paper trade, across the maker
  // and cross-venue ledgers. Four ranges, a hover readout that says how far a moment is from the
  // start of the range, and a drag that measures the gain or loss between any two moments. The
  // same chart opens large over the page. The plot itself -- line, price scale, crosshair, time
  // axis -- is TradingView's Lightweight Charts (vendored in public/vendor/). The words around it
  // (the headline, the ranges, the tip, the measuring band) are HTML laid over it, so they stay
  // sharp and take a mouse.
  //
  const RANGES = [['1h', 36e5], ['6h', 216e5], ['24h', 864e5], ['All', Infinity]];
  // interval: how long one candle (or one point of the line) is, in minutes; 'auto' picks it from the range
  const INTERVALS = ['auto', 1, 5, 15, 45];
  // ind: the indicator panes under the large chart's price (momentum, and the maker's paper P&L)
  const chart = { range: 'All', type: 'candles', interval: 'auto', ind: true, hoverT: null, band: null, dragFrom: null };
  try {
    const c = JSON.parse(localStorage.getItem('hex-chart') || '{}');
    if (RANGES.some(([r]) => r === c.range)) chart.range = c.range;
    if (c.type === 'line' || c.type === 'candles') chart.type = c.type;
    if (INTERVALS.includes(c.interval)) chart.interval = c.interval;
    if (typeof c.ind === 'boolean') chart.ind = c.ind;
  } catch { /* private window: defaults */ }
  const saveChart = () => { try { localStorage.setItem('hex-chart', JSON.stringify({ range: chart.range, type: chart.type, interval: chart.interval, ind: chart.ind })); } catch { /* ignore */ } };

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

  // The scale has two ways to lie. Pinned to zero -- as it was -- a desk parked at -$84
  // with 22c of movement in it spends the whole plot on the empty distance back to zero: the line
  // lies flat on the floor of the box and the fill floods the panel. Pinned to the data instead,
  // that same 22c of drift is stretched over the full height and a flat day reads as a
  // rollercoaster. So: follow the data, keep zero when the line is near enough to it to be worth
  // the room, and hold the window open to a floor -- a dollar, or 2% of the level, whichever is
  // larger -- so that small really does look small. The chart library picks its own tick marks and
  // adds its own padding; this only says what range the data should be given room for.
  function pnlPriceRange(lo, hi, last) {
    const seen = Math.max(hi - lo, 0.02);
    if (lo > 0 && lo <= seen * 0.35) lo = 0;
    if (hi < 0 && -hi <= seen * 0.35) hi = 0;
    const floor = Math.max(1, Math.abs(last) * 0.02);
    if (hi - lo < floor) { const mid = (hi + lo) / 2; lo = mid - floor / 2; hi = mid + floor / 2; }
    return { min: lo, max: hi };
  }

  // Lightweight Charts gives every point one slot, whatever its timestamp. These ledgers are not
  // sampled evenly -- the server thins old history, and a restart leaves a gap -- so drawn as they
  // come, a day-old stretch would be squeezed into a few minutes. Step the history onto an even
  // clock instead: each slot holds the value that was live at that moment, which is what a step
  // ledger means. The clock ticks in round steps (a minute, five, an hour) so the time axis lands on
  // 08:00 rather than 08:02; `off` is the zone's offset from UTC in seconds, so those steps fall on
  // the local clock. The first slot is the first point and the last is exactly the newest one. Times
  // come out in whole seconds, strictly increasing, which is what the library requires.
  const SLOT_STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 43200, 86400];
  const slotStep = (t0, t1, maxSlots) => SLOT_STEPS.find((n) => n >= (t1 - t0) / maxSlots) || 86400;
  // `stepSec` fixes the step (the interval the user picked) instead of choosing one to fit `maxSlots`;
  // then a long history is cut to its newest `maxSlots` slots, as any chart at that interval would be.
  function evenPnlPoints(pts, maxSlots = 900, off = 0, stepSec = 0) {
    if (pts.length < 2) return pts.slice();
    const t0 = Math.floor(pts[0].t / 1000), t1 = Math.floor(pts[pts.length - 1].t / 1000);
    const step = stepSec || slotStep(t0, t1, maxSlots);
    const firstAt = (Math.floor((t0 + off) / step) + 1) * step - off;
    const from = stepSec ? Math.max(firstAt, (Math.floor((t1 + off) / step) - maxSlots + 2) * step - off) : firstAt;
    const at = from > firstAt ? [] : [t0];
    for (let s = from; s < t1; s += step) at.push(s);
    if (t1 > t0) at.push(t1);
    let i = 0;
    return at.map((sec) => {
      while (i + 1 < pts.length && Math.floor(pts[i + 1].t / 1000) <= sec) i++;
      return { t: sec * 1000, v: pts[i].v };
    });
  }

  // The same clock, as candles: what the desk's P&L did inside each slot. A candle opens at the value
  // the last one closed on, closes on the last value seen inside its slot, and its wicks reach the
  // highest and lowest value the step ledger held in between. A slot with no news is flat, which is
  // true: the ledger did not move. (`v` is the close, so a candle can be found and measured like a
  // line's point.)
  function pnlCandles(pts, maxCandles = 60, off = 0, stepSec = 0) {
    if (pts.length < 2) return [];
    const t0 = Math.floor(pts[0].t / 1000), t1 = Math.floor(pts[pts.length - 1].t / 1000);
    const step = stepSec || slotStep(t0, t1, maxCandles), out = [];
    const firstB = Math.floor((t0 + off) / step) * step - off, lastB = Math.floor((t1 + off) / step) * step - off;
    // a fixed step shows the newest `maxCandles` candles; the first of them opens on the value the
    // history had reached by then
    const from = stepSec ? Math.max(firstB, lastB - (maxCandles - 1) * step) : firstB;
    let i = 0, carry = pts[0].v;
    while (i < pts.length && Math.floor(pts[i].t / 1000) < from) carry = pts[i++].v;
    for (let b = from; b <= t1; b += step) {
      let h = carry, l = carry, c = carry;
      while (i < pts.length && Math.floor(pts[i].t / 1000) < b + step) { c = pts[i].v; h = Math.max(h, c); l = Math.min(l, c); i++; }
      out.push({ t: b * 1000, o: carry, h, l, c, v: c });
      carry = c;
    }
    return out;
  }

  // What the desk traded inside each slot, in dollars: `buckets` are the server's minutes that traded,
  // [minute, contracts, dollars], oldest first. A slot owns everything from its start up to the next
  // slot's start, and the last one owns everything after, so nothing is dropped or counted twice.
  function pnlVolume(slots, buckets) {
    const out = [];
    let j = 0;
    while (j < buckets.length && buckets[j][0] < slots[0].t) j++;
    for (let i = 0; i < slots.length; i++) {
      const to = i + 1 < slots.length ? slots[i + 1].t : Infinity;
      let d = 0;
      while (j < buckets.length && buckets[j][0] < to) d += buckets[j++][2];
      out.push(d);
    }
    return out;
  }

  // ---- the indicator panes (large chart only). They describe the desk; nothing trades off them.
  // Momentum is MACD on the P&L: the gap between a fast and a slow average of the slot values, a
  // slower average of that gap (the signal), and the difference of the two as bars. Periods are in
  // slots, so they follow the candle size. Plain rate of change was the other choice, but per candle
  // it is only close minus open -- the candle body again, drawn a second time. MACD says what the
  // candles cannot: whether the last hour is running ahead of the last few hours. On a step ledger
  // it reads well: a flat stretch decays to zero, a jump shows as a spike that fades.
  const MOMENTUM = { fast: 12, slow: 26, signal: 9 };
  // An average needs history to mean anything: no value until `slow` slots have been seen, no signal
  // until `signal` more. Each average starts on its first input rather than on a zero.
  function pnlMacd(values, fast = 12, slow = 26, signal = 9) {
    const a = (n) => 2 / (n + 1), out = [];
    let ef = null, es = null, sg = null;
    for (let i = 0; i < values.length; i++) {
      const x = values[i];
      ef = ef == null ? x : ef + a(fast) * (x - ef);
      es = es == null ? x : es + a(slow) * (x - es);
      if (i < slow - 1) { out.push(null); continue; }
      const m = ef - es;
      sg = sg == null ? m : sg + a(signal) * (m - sg);
      out.push(i < slow + signal - 2 ? { m, s: null, h: null } : { m, s: sg, h: m - sg });
    }
    return out;
  }

  // Momentum for the slots on show. The averages are warmed on the history before the first slot,
  // at the same step and on the same clock, so a range does not open on a dead stretch of blanks:
  // only the very start of the whole history has none. `step` is the slot length in ms. A candle's
  // value is its close (the last point before its slot ends); a line's is the value live at its moment.
  // A line's first slot is the range's own start, off the round clock and often seconds before the
  // next slot: counted as a whole slot it would skew the averages. So a line is warmed on the clock
  // of its second slot, and its first shows what that clock had reached just before it.
  function pnlMomentum(allPts, slots, step, candles, P = MOMENTUM) {
    if (slots.length < 2 || !allPts.length || !(step > 0)) return slots.map(() => null);
    const skip = !candles && slots.length > 2 && slots[1].t - slots[0].t < step ? 1 : 0;
    const lead = [];
    let i = 0, v = null;
    for (let k = P.slow * 6; k >= 1; k--) {
      const x = slots[skip].t - k * step + (candles ? step : 1000);
      while (i < allPts.length && allPts[i].t < x) v = allPts[i++].v;
      if (v != null) lead.push(v);
    }
    const out = pnlMacd([...lead, ...slots.slice(skip).map((p) => p.v)], P.fast, P.slow, P.signal);
    return [...(skip ? [lead.length ? out[lead.length - 1] : null] : []), ...out.slice(lead.length)];
  }

  // How much of the maker's P&L is only on paper. The maker's history samples, once a minute:
  //   c  realised P&L -- banked when a fill closes part of a position, or at settlement
  //   m  the marked VALUE of the inventory (contracts x mid, short negative) -- not a profit
  //   e  the maker's whole P&L: cash plus that mark, less the opening balance
  // Cash moves by the fill price and realised profit by the fill price less the cost basis, so
  // e = c + (mark - cost basis) + skew: e - c - skew is the gain or loss on contracts still held,
  // which is gone if the marks move before the desk gets out. `m` is not that: a desk long $400 of
  // contracts bought for $400 has m = 400 and nothing on paper. The taker's positions are not in
  // this history, so this is the maker's paper P&L, not the whole headline's.
  // `skew` is a ledger's fixed error between cash and realised profit. It is zero on a clean ledger,
  // but the Fly box's maker booked its realised profit wrongly on partial closes until the fix of
  // 2026-09-12, and its running total still carries that (about $7): e - c alone would show that
  // much "on paper" with nothing held. The current code moves cash and realised profit together, so
  // the error has stayed fixed since, and the caller measures it from the live book (paperSkew).
  // Each slot takes the sample live at its moment (a candle: its close), like the P&L itself.
  // Before the accounting repair the marks were wrong, so that stretch is left out.
  function paperSwing(hist, slots, candles, validFrom = 0, skew = 0) {
    const h = (hist || []).filter((p) => p.t >= validFrom && Number.isFinite(p.e) && Number.isFinite(p.c)).sort((a, b) => a.t - b.t);
    let i = 0, cur = null;
    return slots.map((s, k) => {
      const x = candles ? (k + 1 < slots.length ? slots[k + 1].t : Infinity) : s.t + 1000;
      while (i < h.length && h[i].t < x) cur = h[i++];
      return cur && { p: r2(cur.e - cur.c - skew) };
    });
  }

  // The skew, from the live book: the maker's P&L less its realised profit, less what is really on
  // paper now (each market's mark less its cost basis). Zero when the book cannot say.
  function paperSkew(M) {
    const mk = M && Array.isArray(M.markets) ? M.markets : null;
    if (!mk || ![M.equity, M.initial, M.realized].every(Number.isFinite)) return 0;
    let held = 0;
    for (const m of mk) { const a = +m.mark || 0, b = +m.cost || 0; held += a - b; }
    return r2(M.equity - M.initial - M.realized - held);
  }

  // Bars are slots on a clock, and a zoom or a pan lands BETWEEN bars. To keep it where it is in time
  // when the desk sends new data (the slots move, and the first and last are not evenly spaced),
  // it is turned into moments and back, interpolating between slots. Asking the library for the
  // times of the bars in view instead loses the fraction, and the view snaps by up to a bar
  // every time a frame arrives.
  function barTime(pts, i) {
    const a = Math.max(0, Math.min(pts.length - 2, Math.floor(i)));
    return pts[a].t + (i - a) * (pts[a + 1].t - pts[a].t);
  }
  function timeBar(pts, t) {
    let a = 0, b = pts.length - 1;
    if (t <= pts[0].t) a = 0;
    else if (t >= pts[b].t) a = b - 1;
    else while (b - a > 1) { const m = (a + b) >> 1; if (pts[m].t <= t) a = m; else b = m; }
    return a + (t - pts[a].t) / (pts[a + 1].t - pts[a].t);
  }
  // the moments a plot's view spans, or null
  function viewTimes(plot) {
    const r = plot.pts.length > 1 ? plot.c.timeScale().getVisibleLogicalRange() : null;
    return r && { from: barTime(plot.pts, r.from), to: barTime(plot.pts, r.to) };
  }

  // A trackpad gesture on the plot, as the new visible stretch. `r` is what is showing now, in bars
  // ({from, to}); [lo, hi] is the whole of the data; `w` is the plot's width in pixels. A pan by `d`
  // pixels moves the view with the fingers. A zoom by `d` (the wheel's deltaY: up is negative) grows
  // or shrinks the view by a factor that compounds smoothly, and keeps the bar under pixel `x` where
  // it is, so the chart zooms toward the pointer. A pinch is the same, at a stronger rate. The view
  // never shrinks below five bars, never grows past the data, and never leaves it.
  function pnlView(r, lo, hi, w, mode, d, x) {
    let from = r.from, to = r.to;
    const span = to - from;
    if (mode === 'pan') {
      const shift = d / (w / span);
      from += shift; to += shift;
    } else {
      const next = Math.min(hi - lo, Math.max(5, span * Math.exp(d * (mode === 'pinch' ? 0.012 : 0.002))));
      const f = Math.min(1, Math.max(0, x / w));
      from = from + f * span - f * next; to = from + next;
    }
    const s = to - from;
    if (from < lo) { from = lo; to = lo + s; }
    if (to > hi) { to = hi; from = hi - s; }
    return { from, to };
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
  // The plot row is left empty here: the library builds its canvas inside it.
  const intervalTxt = (i) => (i === 'auto' ? 'Auto' : `${i}m`);
  function chartSkeleton(big) {
    // how far back, then how long each candle is: the two time controls sit together along the bottom
    const rangeBtns = RANGES.map(([r]) => `<button data-range="${r}">${r}</button>`).join('');
    const intBtns = INTERVALS.map((i) => `<button data-int="${i}">${intervalTxt(i)}</button>`).join('');
    // The small stand has room for one control, not nine buttons: one dropdown holds both the range
    // and the candle size. The large chart keeps the two button rows.
    const controls = big
      ? `<span class="seg">${rangeBtns}</span><span class="seg cint-seg" title="Candle size">${intBtns}</span>`
      : `<span class="cmenu-wrap"><button type="button" class="cmenu-btn" data-menu="1" aria-haspopup="true" aria-expanded="false"></button>` +
        `<span class="cmenu" hidden><span class="cmh">Range</span><span class="seg">${rangeBtns}</span><span class="cmh">Candle size</span><span class="seg cint-seg">${intBtns}</span></span></span>`;
    // the large chart has room for the indicator panes: a switch for them, and a name on each
    return `<div class="ct"><span class="ctitle">All paper trades</span><button class="cx crz" data-zoomreset="1" title="Back to the whole range" hidden>↺</button>` +
      `${big ? '<button class="cx cind" data-ind="1" aria-pressed="false">Indicators</button>' : ''}<button class="cx ctype" data-type="1"></button>` +
      `${big ? '' : '<button class="cx" data-expand="1" title="Open large">⤢</button>'}</div>` +
      `<div class="chead"><span class="cv"></span><span class="cd"></span></div>` +
      `<div class="cplot"><i class="cband" hidden></i><div class="ctip" hidden></div>` +
      `${big ? PANES.map((p, i) => `<span class="cpane" data-pane="${i + 1}" hidden>${p.name}</span>`).join('') : ''}</div>` +
      `<div class="cb">${controls}<span class="cr"></span></div>`;
  }

  const UP = '#22c55e', DOWN = '#ef4444', FLAT = '#64748b';
  // volume bars: the candle's own colours, softened; a line has no direction to colour by
  const VOL = { up: 'rgba(34,197,94,.42)', down: 'rgba(239,68,68,.42)', flat: 'rgba(100,116,139,.42)', line: 'rgba(140,168,210,.32)' };
  // the indicator panes: their names (on the pane) and colours. Momentum's line is the chart's cyan,
  // its signal amber; its bars and the paper swing use the candles' green and red, softened.
  const PANES = [{ name: `Momentum · MACD ${MOMENTUM.fast} ${MOMENTUM.slow} ${MOMENTUM.signal}` }, { name: 'Maker P&L not yet banked' }];
  const MOM = { line: '#5ec8e0', signal: '#f59e0b', up: 'rgba(34,197,94,.5)', down: 'rgba(239,68,68,.5)' };
  // a pane's numbers are dollars, like the price's, but can be cents: two decimals until they are big
  const paneTxt = (v) => (Math.abs(v) < 1e-9 ? '$0' : signed(v, Math.abs(v) >= 100 ? 0 : 2));
  const volTxt = (d) => (d >= 1e6 ? `$${(d / 1e6).toFixed(1)}M` : d >= 1e3 ? `$${(d / 1e3).toFixed(1)}k` : `$${Math.round(d)}`);
  // The desk's own trading by the minute, from the server. Not in the 2-second stream: it is a long
  // series that changes slowly, so it is fetched on its own, now and then.
  let volume = [];
  async function loadVolume() {
    try { const r = await fetch('/api/volume'); if (r.ok) volume = await r.json(); } catch { /* the chart is just without bars */ }
  }
  loadVolume(); setInterval(loadVolume, 30000);
  // the button shows the chart you have; the tip says what a click turns it into
  const TYPE_ICON = {
    candles: '<svg viewBox="0 0 16 16" width="1.1em" height="1.1em" aria-hidden="true"><path d="M4.5 1.5v13M11.5 3v10" stroke="currentColor" stroke-width="1.3"/><rect x="2.5" y="4.5" width="4" height="6" fill="currentColor"/><rect x="9.5" y="5.5" width="4" height="5" fill="none" stroke="currentColor" stroke-width="1.3"/></svg>',
    line: '<svg viewBox="0 0 16 16" width="1.1em" height="1.1em" aria-hidden="true"><path d="M1.5 12l4-5 3 2.5 6-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" stroke-linecap="round"/></svg>',
  };
  const plots = new WeakMap();   // chart container -> the Lightweight Chart drawn in it, and what it shows
  // The library reads every time as UTC and puts its tick marks -- the midnights above all -- on
  // UTC's clock, so a date would land at 8pm in New York. It is handed local wall-clock time dressed
  // as UTC instead: each time shifted by this zone's offset, and read back with the same shift. One
  // offset for the whole plot keeps the times in order through a clock change, which a per-point
  // offset would not. So these read the shifted seconds with the UTC getters, and everything else on
  // the page keeps real times.
  const zoneSec = () => -new Date(S.now).getTimezoneOffset() * 60;
  const wall = (sec) => new Date(sec * 1000);
  const wallHm = (sec) => `${String(wall(sec).getUTCHours()).padStart(2, '0')}:${String(wall(sec).getUTCMinutes()).padStart(2, '0')}`;
  const wallDay = (sec) => wall(sec).toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
  // Its kinds of tick mark are numbered: 0 year, 1 month, 2 day of the month, 3 and 4 a time of day.
  const tickTxt = (sec, kind) => kind >= 3 ? wallHm(sec) : kind === 2 ? wallDay(sec)
    : kind === 1 ? wall(sec).toLocaleDateString([], { month: 'short', timeZone: 'UTC' }) : String(wall(sec).getUTCFullYear());
  function dropPlot(el) {
    const old = plots.get(el);
    if (!old) return;
    old.ro.disconnect(); old.c.remove(); plots.delete(el);
  }

  // One chart at a time can be "active": clicked, outlined, and the only one that hears the trackpad.
  // The rest leave wheel and touch alone, so the page still scrolls under the pointer. Active: two
  // fingers up or down (or a pinch) zooms, two fingers sideways pans. A drag stays the measure. The
  // trackpad is read here (trackpad(), below), not by the library: it takes each wheel event alone,
  // so a slightly diagonal swipe flips between zoom and pan and every event repaints. Touch is the
  // library's.
  let activeChart = null;
  const hands = (on) => (on
    ? { handleScroll: { mouseWheel: false, pressedMouseMove: false, horzTouchDrag: true, vertTouchDrag: false },
        handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: false } }
    : { handleScroll: false, handleScale: false });
  function setActive(el) {
    if (activeChart === el) return;
    const was = activeChart;
    activeChart = el;
    for (const e of [was, el]) {
      if (!e) continue;
      e.classList.toggle('active', e === el);
      const plot = plots.get(e);
      if (plot) plot.c.applyOptions(hands(e === el));
    }
  }
  const syncReset = (el) => { const b = el.querySelector('.crz'), plot = plots.get(el); if (b) b.hidden = !(plot && plot.zoomed); };
  function resetZoom(el) {
    const plot = plots.get(el);
    if (!plot) return;
    plot.zoomed = false; fitPlot(plot);
    syncReset(el); paintOverlay(el);
  }
  // Fit the data to the plot. With the edges fixed the library shows exactly bar 0 to the last bar,
  // so [0, n - 1] is the whole of the data. (Do not measure that right after fitContent: the library
  // reports the new range a moment later, and a read straight after still sees the old one.)
  function fitPlot(plot) { plot.c.timeScale().fitContent(); }
  // Repaint the overlay at most once a frame: a pan or a hover sends events faster than the screen
  // draws, and each repaint reads layout.
  function paintSoon(el) {
    const plot = plots.get(el);
    if (!plot || plot.paint) return;
    plot.paint = requestAnimationFrame(() => { plot.paint = 0; paintOverlay(el); });
  }
  // The active chart's trackpad. One gesture is a run of wheel events with gaps under ~160ms
  // (momentum included) and it keeps ONE meaning, chosen from its first moments: sideways pans,
  // up/down zooms, a pinch (which the browser sends as a wheel with Ctrl) zooms harder. A mouse wheel
  // is a zoom at once. Events are added up and applied once per frame.
  function trackpad(root) {
    let g = null, pend = null, raf = 0;
    const flush = () => {
      raf = 0;
      const plot = plots.get(root);
      if (!plot || !pend || !g || !g.mode) return;
      const ts = plot.c.timeScale(), r = ts.getVisibleLogicalRange(), w = ts.width();
      if (!r || !w) return;
      const lo = 0, hi = plot.pts.length - 1;
      // a hard flick sends big numbers: a pan follows the fingers exactly, a zoom takes at most one
      // firm step a frame
      const d = g.mode === 'pan' ? pend.dx : Math.max(-80, Math.min(80, pend.dy));
      const v = pnlView(r, lo, hi, w, g.mode, d, pend.x);
      pend.dx = 0; pend.dy = 0;
      ts.setVisibleLogicalRange(v);
      plot.zoomed = v.from > lo + 1e-3 || v.to < hi - 1e-3;
      syncReset(root);
    };
    root.addEventListener('wheel', (ev) => {
      const plot = plots.get(root);
      if (!plot || activeChart !== root || plot.pts.length < 3 || !ev.target.closest('.cplot')) return;
      ev.preventDefault();   // the page does not scroll, and a pinch does not zoom the page
      const unit = ev.deltaMode === 1 ? 16 : ev.deltaMode === 2 ? 400 : 1;
      const dx = ev.deltaX * unit, dy = ev.deltaY * unit;
      if (!g || ev.timeStamp - g.at > 160) { g = { at: 0, ax: 0, ay: 0, n: 0, mode: ev.ctrlKey ? 'pinch' : null }; pend = { dx: 0, dy: 0, x: 0 }; }
      g.at = ev.timeStamp;
      pend.dx += dx; pend.dy += dy;
      pend.x = ev.clientX - root.querySelector('.cplot').getBoundingClientRect().left;
      if (!g.mode) {
        g.ax += Math.abs(dx); g.ay += Math.abs(dy); g.n++;
        if (dx === 0 && (ev.deltaMode !== 0 || Math.abs(dy) >= 50)) g.mode = 'zoom';          // a mouse wheel
        else if (g.n >= 2 || g.ax + g.ay >= 8) g.mode = g.ax > g.ay ? 'pan' : 'zoom';
      }
      if (g.mode && !raf) raf = requestAnimationFrame(flush);
    }, { passive: false });
  }

  // a click anywhere outside the active chart lets it go
  document.addEventListener('pointerdown', (ev) => { if (activeChart && !activeChart.contains(ev.target)) setActive(null); });

  function makePlot(el, big, candles, ind) {
    const LW = window.LightweightCharts;
    if (!LW) return null;   // the script did not load: the headline and the ranges still work
    const plot = { c: null, s: null, v: null, vols: [], ind, mom: [], swing: [], zoomed: false, paint: 0, ro: null, zero: null, open: null, candles, pts: [], start: null, end: 0, step: 0, off: 0, last: 0, digits: 2, fs: 0, read: '' };
    const c = plot.c = LW.createChart(el.querySelector('.cplot'), {
      autoSize: true,
      // a plot is not dragged (a drag is the measure) and is zoomed only once it has been clicked
      ...hands(el === activeChart),
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: '#657086',
        fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontSize: 9,
        // indicator panes, when shown, are split by a hairline that is not dragged: a drag is the measure
        panes: { enableResize: false, separatorColor: 'rgba(140,168,210,.14)', separatorHoverColor: 'rgba(140,168,210,.14)' },
        // TradingView's terms for the library: their logo, linked, where the chart is (the page's
        // footer is hidden, so it cannot carry the credit)
        attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: 'rgba(140,168,210,.07)' } },
      rightPriceScale: { borderVisible: false, scaleMargins: { top: 0.1, bottom: 0.1 } },
      // the small chart has no room for a time axis: its bottom line says the span instead
      timeScale: { visible: big, borderVisible: false, timeVisible: true, secondsVisible: false,
        fixLeftEdge: true, fixRightEdge: true, rightOffset: 0, tickMarkFormatter: tickTxt },
      localization: { timeFormatter: (sec) => `${wallDay(sec)} ${wallHm(sec)}` },
      crosshair: { mode: LW.CrosshairMode.Magnet,
        vertLine: { color: 'rgba(148,163,184,.6)', labelVisible: big, labelBackgroundColor: '#212b3c' },
        horzLine: { visible: big, labelVisible: big, labelBackgroundColor: '#212b3c' } },
    });
    // Volume is its own series on its own scale, in the bottom fifth of the plot, drawn first so the
    // price sits over it. It has no axis of its own: the tip says the number.
    plot.v = c.addSeries(LW.HistogramSeries, { priceScaleId: '', priceLineVisible: false, lastValueVisible: false,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: volTxt } });
    plot.v.priceScale().applyOptions({ scaleMargins: { top: 0.8, bottom: 0 } });
    const scale = {
      autoscaleInfoProvider: (original) => {
        const r = original();
        if (!r || !r.priceRange) return r;
        const w = pnlPriceRange(r.priceRange.minValue, r.priceRange.maxValue, plot.last);
        return { ...r, priceRange: { minValue: w.min, maxValue: w.max } };
      },
    };
    // A candle is green if the desk made money inside it and red if it lost some; one where nothing
    // happened is grey (see drawChart). The line's colour is about the range on show, not the sign
    // of the level: a desk down $84 that has made 22c back today draws green over the last hour,
    // red over the week, and the headline number stays red throughout. Its colours are set on every
    // draw. Its fill hangs off the foot of the plot: it is there to give the line a body, and it says
    // nothing about zero -- hanging it off the zero line is what painted the whole board red.
    plot.s = candles
      ? c.addSeries(LW.CandlestickSeries, { ...scale, upColor: UP, downColor: DOWN, wickUpColor: UP, wickDownColor: DOWN, borderVisible: false, priceLineVisible: false })
      : c.addSeries(LW.AreaSeries, { ...scale, lineWidth: big ? 3 : 2, relativeGradient: true, priceLineVisible: false, crosshairMarkerRadius: 4 });
    // The reference the eye reads against: zero when zero is on the plot, otherwise where this range
    // opened -- which is the line the change beside the number is measured from anyway.
    const ref = { color: '#44526b', lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false };
    plot.zero = plot.s.createPriceLine({ ...ref, price: 0 });
    plot.open = plot.s.createPriceLine({ ...ref, price: 0, lineVisible: false });
    // The indicator panes, under the price on the same time axis, so a zoom or a pan moves all three.
    // Pane 1 is momentum (bars first, so the lines sit over them), pane 2 the maker's paper P&L,
    // green where the marks are ahead of what was paid and red where behind. Each has its own scale
    // and a dashed zero. The price keeps three fifths of the height.
    if (ind) {
      // Both panes read against zero (momentum turning, paper gains turning to losses), so zero is
      // always on their scale, with at least 50c either side of it: as with the price, a flat day's
      // cents must look like cents, not fill the pane.
      const withZero = (original) => {
        const r = original();
        return r && r.priceRange ? { ...r, priceRange: { minValue: Math.min(-0.5, r.priceRange.minValue), maxValue: Math.max(0.5, r.priceRange.maxValue) } } : r;
      };
      const pane = { priceLineVisible: false, lastValueVisible: false, autoscaleInfoProvider: withZero,
        priceFormat: { type: 'custom', minMove: 0.01, formatter: paneTxt } };
      plot.mh = c.addSeries(LW.HistogramSeries, pane, 1);
      plot.ml = c.addSeries(LW.LineSeries, { ...pane, color: MOM.line, lineWidth: 2, crosshairMarkerRadius: 3 }, 1);
      plot.ms = c.addSeries(LW.LineSeries, { ...pane, color: MOM.signal, lineWidth: 1, crosshairMarkerVisible: false }, 1);
      plot.pp = c.addSeries(LW.BaselineSeries, { ...pane, baseValue: { type: 'price', price: 0 }, lineWidth: 2, crosshairMarkerRadius: 3,
        topLineColor: UP, topFillColor1: 'rgba(34,197,94,.3)', topFillColor2: 'rgba(34,197,94,.04)',
        bottomLineColor: DOWN, bottomFillColor1: 'rgba(239,68,68,.04)', bottomFillColor2: 'rgba(239,68,68,.3)' }, 2);
      plot.ml.createPriceLine({ ...ref, price: 0 });
      plot.pp.createPriceLine({ ...ref, price: 0 });
      for (const i of [1, 2]) c.priceScale('right', i).applyOptions({ borderVisible: false, scaleMargins: { top: 0.14, bottom: 0.08 } });
      c.panes()[0].setStretchFactor(3);
    }
    // A chart that is shut (the large one, once closed) still gets one last crosshair event as it is
    // resized away, and that would leave its hover on the floor chart. Only a chart on show hovers.
    c.subscribeCrosshairMove((p) => {
      if (!el.offsetWidth) return;
      chart.hoverT = p.time == null ? null : (p.time - plot.off) * 1000; paintSoon(el);
    });
    // A panel that was hidden (the large chart, the phone card) gets its size a moment after it shows,
    // and a window can be resized: refit, once the library has taken the new size (its own observer
    // was made first, so it runs first). The library's own size-change event does not fire when its
    // time axis is hidden, which is the small chart and the phone card.
    plot.ro = new ResizeObserver(() => { if (!plot.zoomed) fitPlot(plot); paintOverlay(el); });
    plot.ro.observe(el.querySelector('.cplot'));
    // the band and the tip are pixels, so they follow a zoom or a pan
    c.timeScale().subscribeVisibleTimeRangeChange(() => paintSoon(el));
    plots.set(el, plot);
    return plot;
  }

  // What sits over the plot and changes without the data changing: the hover tip, the measuring
  // band, and the bottom line, which is the time span until a drag asks it a question.
  function paintOverlay(el) {
    const plot = plots.get(el), tip = el.querySelector('.ctip'), band = el.querySelector('.cband');
    // each indicator pane's name sits in its top-left corner, wherever the library has put the pane
    const labels = el.querySelectorAll('.cpane'), on = !!(plot && plot.ind && plot.pts.length >= 2);
    labels.forEach((lab) => {
      const pane = on && plot.c.panes()[+lab.dataset.pane], box = pane && pane.getHTMLElement();
      lab.hidden = !box;
      if (box) lab.style.top = `${box.getBoundingClientRect().top - el.querySelector('.cplot').getBoundingClientRect().top + 3}px`;
    });
    if (!plot || plot.pts.length < 2) { tip.hidden = true; band.hidden = true; return; }
    const { pts, c, start, off } = plot, w = el.querySelector('.cplot').clientWidth, ts = c.timeScale();
    let read = plot.read;
    band.hidden = true;
    if (chart.band) {
      const a = nearest(pts, Math.min(...chart.band)), b = nearest(pts, Math.max(...chart.band));
      // A candle covers its whole slot, so a drag over candles runs from the open of the first one to
      // the close of the last: dragging across everything reads the headline change. A line's point
      // is one moment, and it is measured from that moment.
      const d = r2(b.v - (plot.candles ? a.o : a.v));
      const from = Math.max(a.t, start.t), to = plot.candles ? Math.min(b.t + plot.step, plot.end) : b.t;
      read = `${hhmm(from)}→${hhmm(to)} <b class="${d >= 0 ? 'pos' : 'neg'}">${signed(d)}</b>`;
      const xa = ts.timeToCoordinate(a.t / 1000 + off), xb = ts.timeToCoordinate(b.t / 1000 + off);
      if (xa != null && xb != null) { band.hidden = false; Object.assign(band.style, { left: `${xa}px`, width: `${Math.max(2, xb - xa)}px` }); }
    }
    el.querySelector('.cr').innerHTML = read;
    const p = chart.hoverT == null ? null : nearest(pts, chart.hoverT), x = p && ts.timeToCoordinate(p.t / 1000 + off);
    if (!p || x == null) { tip.hidden = true; return; }
    tip.hidden = false;
    const i = pts.indexOf(p), mo = plot.ind && plot.mom[i], sw = plot.ind && plot.swing[i];
    tip.innerHTML = `<b>${hhmm(p.t)}</b> <span class="${p.v >= 0 ? 'pos' : 'neg'}">${signed(p.v)}</span><br>` +
      (plot.candles && w >= 300 ? `<small>O ${signed(p.o)} · H ${signed(p.h)} · L ${signed(p.l)}</small><br>` : '') +
      (plot.vols[i] > 0 ? `<small>Vol ${volTxt(plot.vols[i])}</small><br>` : '') +
      (mo ? `<small>Momentum ${paneTxt(mo.m)}${mo.s != null ? ` · signal ${paneTxt(mo.s)}` : ''}</small><br>` : '') +
      (sw ? `<small>Maker not yet banked ${paneTxt(sw.p)}</small><br>` : '') +
      `<small>${signed(r2(p.v - start.v))} since ${hhmm(start.t)}</small>`;
    // beside the crosshair, on the roomier side, and never past either edge of the plot
    const tw = tip.offsetWidth, at = x > w * 0.55 ? x - tw - 10 : x + 10;
    Object.assign(tip.style, { right: '', left: `${Math.max(0, Math.min(at, w - tw))}px` });
  }

  function drawChart(el, big) {
    if (!S) return;
    if (el.dataset.built !== (big ? 'big' : 'small')) {
      dropPlot(el);
      el.innerHTML = chartSkeleton(big); el.dataset.built = big ? 'big' : 'small';
    }
    // shut or off-screen (the large chart, the phone card on a desktop): nothing to size a plot to
    if (!el.offsetWidth) return;
    // Every range stays clickable. Greying out ranges longer than the history (and forcing 'All')
    // left a freshly reset ledger with one live button, which read as a chart that ignored clicks.
    // A range longer than the history simply shows all of it, and the time axis says so.
    const allPts = (() => { const old = chart.range; chart.range = 'All'; const p = chartPoints(); chart.range = old; return p; })();
    const available = allPts.length > 1 ? allPts[allPts.length - 1].t - allPts[0].t : 0;
    const selectedSpan = RANGES.find(([r]) => r === chart.range)[1];
    const short = Number.isFinite(selectedSpan) && available < selectedSpan;
    el.querySelectorAll('[data-range]').forEach((b) => b.classList.toggle('on', b.dataset.range === chart.range));
    const candles = chart.type === 'candles', pts = chartPoints();
    // a fixed interval shows the newest stretch of it that fits; auto fits the whole range
    const off = zoneSec(), iv = chart.interval === 'auto' ? 0 : chart.interval * 60;
    const slots = candles ? pnlCandles(pts, big ? 120 : 48, off, iv) : evenPnlPoints(pts, iv ? (big ? 300 : 120) : 900, off, iv);
    let plot = plots.get(el);
    // a different kind of chart is a different plot: build it again rather than swap its series. So
    // is one with the indicator panes switched on or off (the small chart has no room for them).
    // Switching the panes is the same picture with more under it, so a zoom carries over.
    const ind = big && chart.ind;
    const carry = plot && plot.candles === candles && plot.ind !== ind && plot.zoomed ? viewTimes(plot) : null;
    if (plot && (plot.candles !== candles || plot.ind !== ind)) { dropPlot(el); plot = null; }
    plot = plot || makePlot(el, big, candles, ind);
    if (plot && carry) plot.zoomed = true;
    const ib = el.querySelector('.cind');
    if (ib) {
      ib.classList.toggle('on', chart.ind); ib.setAttribute('aria-pressed', String(chart.ind));
      ib.title = chart.ind ? 'Hide the momentum and paper P&L panes' : 'Show momentum and the maker\'s paper P&L under the price';
    }
    const ty = el.querySelector('.ctype');
    ty.innerHTML = TYPE_ICON[chart.type]; ty.title = candles ? 'Candles. Click for a line' : 'Line. Click for candles';
    el.querySelectorAll('.cint-seg [data-int]').forEach((b) => b.classList.toggle('on', b.dataset.int === String(chart.interval)));
    const mb = el.querySelector('.cmenu-btn');
    if (mb) mb.innerHTML = `${chart.range} · ${intervalTxt(chart.interval)}<i>▾</i>`;
    if (pts.length < 2 || slots.length < 2) {
      if (plot) {
        plot.s.setData([]); plot.v.setData([]); plot.pts = []; plot.vols = []; plot.mom = []; plot.swing = [];
        if (plot.ind) for (const x of [plot.mh, plot.ml, plot.ms, plot.pp]) x.setData([]);
      }
      paintOverlay(el);
      el.querySelector('.cv').textContent = signed(pts.length ? pts[0].v : 0);
      el.querySelector('.cd').innerHTML = '';
      el.querySelector('.cr').textContent = 'collecting, one point a minute';
      return;
    }

    const t0 = pts[0].t, t1 = Math.max(pts[pts.length - 1].t, t0 + 1);
    const last = pts[pts.length - 1], first = pts[0], up = last.v >= 0;
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
    if (!plot) { el.querySelector('.cr').textContent = 'chart library did not load'; return; }

    // a range longer than the history says how much there is instead of the start and end times
    plot.read = short ? `only ${spanTxt(available)} of history` : `${hhmm(t0)} → ${hhmm(t1)}`;
    // a fixed interval can show less than the range: say how much
    const clipped = iv && slots[0].t > pts[0].t;
    if (iv) plot.read = clipped ? `last ${spanTxt(t1 - slots[0].t)} · ${chart.interval}m` : `${plot.read} · ${chart.interval}m`;
    // more decimals only where the scale is tight enough to need them. The finest tick the library
    // may draw is the last decimal shown (minMove, below), so two ticks never print the same label
    const vs = candles ? slots.flatMap((p) => [p.h, p.l]) : slots.map((p) => p.v), r = pnlPriceRange(Math.min(...vs), Math.max(...vs), last.v), span = r.max - r.min;
    plot.digits = span >= 8 ? 0 : span >= 0.8 ? 1 : 2;
    plot.last = last.v;
    plot.start = first;   // where the range opened: a candle starts on the round clock, before that
    plot.end = t1;
    plot.step = candles ? slots[1].t - slots[0].t : 0;
    plot.off = off;
    // what the user has zoomed to, as moments, so the desk's next frame does not undo it
    const view = carry || (plot.zoomed ? viewTimes(plot) : null);
    plot.pts = slots;
    const fs = Math.max(8, Math.round(parseFloat(getComputedStyle(el).fontSize) * (big ? 0.72 : 0.62)));
    if (fs !== plot.fs) { plot.fs = fs; plot.c.applyOptions({ layout: { fontSize: fs } }); }
    // where what is on show opened: the range's start, unless a fixed interval has cut the start off
    const opened = slots[0].o ?? slots[0].v, col = last.v >= opened ? UP : DOWN, zeroIn = r.min <= 0 && r.max >= 0;
    plot.open.applyOptions({ price: opened, lineVisible: !zeroIn });
    plot.zero.applyOptions({ lineVisible: zeroIn });
    // Zero is zero even as float noise (the library's ticks are sums). The finest tick the library will
    // draw is the last decimal shown, but it steps by 2.5 as readily as by 2, so an axis whose ticks
    // are not all whole at that many decimals gets one more for every tick, rather than a "-$3" at -$2.50.
    const zero = (v) => Math.abs(v) < 1e-9;
    plot.s.applyOptions({ priceFormat: { type: 'custom', minMove: 10 ** -plot.digits,
      formatter: (v) => (zero(v) ? '$0' : signed(v, plot.digits)),
      tickmarksFormatter: (vs) => {
        let d = plot.digits;
        while (d < 2 && vs.some((v) => Math.abs(v * 10 ** d - Math.round(v * 10 ** d)) > 1e-6)) d++;
        return vs.map((v) => (zero(v) ? '$0' : signed(v, d)));
      } } });
    if (candles) {
      plot.s.setData(slots.map((p) => ({ time: p.t / 1000 + off, open: p.o, high: p.h, low: p.l, close: p.c,
        ...(p.o === p.c ? { color: FLAT, wickColor: FLAT, borderColor: FLAT } : {}) })));
    } else {
      plot.s.applyOptions({ lineColor: col, topColor: `${col}29`, bottomColor: `${col}00` });
      plot.s.setData(slots.map((p) => ({ time: p.t / 1000 + off, value: p.v })));
    }
    const vols = pnlVolume(slots, volume), most = Math.max(...vols);
    plot.vols = vols;
    plot.v.setData(slots.map((p, i) => ({ time: p.t / 1000 + off, value: vols[i],
      color: !candles ? VOL.line : p.c > p.o ? VOL.up : p.c < p.o ? VOL.down : VOL.flat })));
    // room for the bars only when there are some: a desk that has not traded keeps the whole plot
    plot.c.priceScale('right').applyOptions({ scaleMargins: { top: 0.1, bottom: most > 0 ? 0.24 : 0.1 } });
    if (plot.ind) {
      // the slot length the plot is on: a candle's, or the line's even clock (as evenPnlPoints picks it)
      const step = candles ? plot.step : (iv || slotStep(Math.floor(pts[0].t / 1000), Math.floor(last.t / 1000), 900)) * 1000;
      const mom = plot.mom = pnlMomentum(allPts, slots, step, candles);
      // the maker's history ends on its live numbers, as the P&L does
      const M = S.maker || {};
      const live = Number.isFinite(M.equity) && Number.isFinite(M.initial) && Number.isFinite(M.realized)
        ? [{ t: S.now, c: M.realized, e: r2(M.equity - M.initial) }] : [];
      const swing = plot.swing = paperSwing([...(M.hist || []), ...live], slots, candles, M.historyValidFrom || 0, paperSkew(M));
      // a slot with nothing to say yet is left blank (a time with no value), not drawn at zero
      const at = (i) => slots[i].t / 1000 + off;
      plot.mh.setData(slots.map((p, i) => (mom[i] && mom[i].h != null ? { time: at(i), value: mom[i].h, color: mom[i].h >= 0 ? MOM.up : MOM.down } : { time: at(i) })));
      plot.ml.setData(slots.map((p, i) => (mom[i] ? { time: at(i), value: mom[i].m } : { time: at(i) })));
      plot.ms.setData(slots.map((p, i) => (mom[i] && mom[i].s != null ? { time: at(i), value: mom[i].s } : { time: at(i) })));
      plot.pp.setData(slots.map((p, i) => (swing[i] ? { time: at(i), value: swing[i].p } : { time: at(i) })));
    }
    // Fit first: it is the picture when nothing is zoomed. A zoom survives the next frame if what it was looking at is still in the
    // data; otherwise the range or the candle size has changed under it, and the chart starts over.
    fitPlot(plot);
    plot.zoomed = false;
    if (view) {
      const lo = 0, hi = slots.length - 1;
      let from = timeBar(slots, view.from), to = timeBar(slots, view.to);
      if (to > lo && from < hi && to - from > 1e-6) {
        const w = to - from;
        if (from < lo) { from = lo; to = Math.min(hi, lo + w); }
        if (to > hi) { to = hi; from = Math.max(lo, hi - w); }
        try {
          plot.c.timeScale().setVisibleLogicalRange({ from, to });
          plot.zoomed = from > lo + 1e-3 || to < hi - 1e-3;
        } catch { fitPlot(plot); }
      }
    }
    syncReset(el);
    paintOverlay(el);
  }

  // One set of handlers serves every chart: they find their own container and repaint it at once,
  // without waiting for the next frame from the desk. The hover is the library's crosshair; the
  // drag is ours, because a plot that scrolls has no use for one.
  function wireChart(root, big) {
    let dragging = false;
    // the moment under the pointer, snapped to the plot's own slots; off either end (or over the
    // price scale) it is the nearest end
    const timeAt = (ev) => {
      const plot = plots.get(root);
      if (!plot || plot.pts.length < 2) return null;
      const r = root.querySelector('.cplot').getBoundingClientRect(), x = ev.clientX - r.left;
      const sec = plot.c.timeScale().coordinateToTime(x);
      return sec == null ? plot.pts[x < r.width / 2 ? 0 : plot.pts.length - 1].t : nearest(plot.pts, (sec - plot.off) * 1000).t;
    };
    const cancel = () => {
      if (!dragging) return;
      dragging = false; chart.dragFrom = null; chart.band = null;
      paintOverlay(root);
    };
    const menu = root.querySelector.bind(root);
    const setMenu = (open) => {
      const m = menu('.cmenu'), b = menu('.cmenu-btn');
      if (!m) return;
      m.hidden = !open; b.setAttribute('aria-expanded', String(open));
    };
    document.addEventListener('pointerdown', (ev) => { if (!ev.target.closest('.cmenu-wrap')) setMenu(false); });
    window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setMenu(false); });
    root.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.zoomreset) { resetZoom(root); return; }
      // a different range, candle size or kind of chart is a different picture: zoom starts over
      if (b.dataset.range || b.dataset.int || b.dataset.type) { const pl = plots.get(root); if (pl) pl.zoomed = false; }
      if (b.dataset.menu) { const m = menu('.cmenu'); setMenu(m && m.hidden); return; }
      if (b.dataset.range) { chart.range = b.dataset.range; chart.band = null; saveChart(); }
      if (b.dataset.int) {
        chart.interval = b.dataset.int === 'auto' ? 'auto' : +b.dataset.int;
        chart.band = null; saveChart();
      }
      if (b.dataset.type) { chart.type = chart.type === 'candles' ? 'line' : 'candles'; chart.band = null; saveChart(); }
      // the panes on or off: the plot is rebuilt, and a zoom and a measurement (stretches of time) carry over
      if (b.dataset.ind) { chart.ind = !chart.ind; saveChart(); }
      if (b.dataset.expand) { openBigChart(); return; }
      drawChart(root, big);
    });
    // a click on the plot makes it the active chart (the highlight, and the trackpad); a double-click
    // takes the whole range back; a wheel or pinch on the active one is a zoom, which is remembered
    root.addEventListener('pointerdown', (ev) => { if (ev.target.closest('.cplot')) setActive(root); });
    root.addEventListener('dblclick', (ev) => { if (ev.target.closest('.cplot')) resetZoom(root); });
    trackpad(root);
    // a touch pan or pinch is the library's; once the fingers lift, see whether it left the chart zoomed
    root.addEventListener('touchend', () => setTimeout(() => {
      const plot = plots.get(root), r = plot && plot.pts.length ? plot.c.timeScale().getVisibleLogicalRange() : null;
      if (!r) return;
      plot.zoomed = r.from > 1e-3 || r.to < plot.pts.length - 1 - 1e-3;
      syncReset(root);
    }, 0), { passive: true });
    root.addEventListener('pointerdown', (ev) => {
      // the left button only: a right-click or a Ctrl-click opens a menu and may never send a release.
      // No preventDefault here: it would stop the library hearing the mouse move, and freeze its
      // crosshair and the tip mid-drag. Text is not selectable on a chart anyway.
      if (ev.pointerType === 'touch' || ev.button !== 0 || ev.ctrlKey || !ev.target.closest('.cplot')) return;
      const t = timeAt(ev);
      if (t == null) return;
      chart.dragFrom = t; chart.band = null; dragging = true;
      paintOverlay(root);
    });
    // on the window, not the plot: the drag can wander off the plot and still end where it lands
    window.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      if (chart.dragFrom == null) { dragging = false; return; }   // Escape or closing the panel ended it
      const t = timeAt(ev);
      if (t != null) { chart.band = [chart.dragFrom, t]; paintOverlay(root); }
    });
    window.addEventListener('pointerup', (ev) => {
      if (!dragging) return;
      dragging = false;
      if (chart.dragFrom == null) return;
      const t = timeAt(ev);
      // a click without a drag clears the measurement rather than leaving a zero-width band
      chart.band = t != null && t !== chart.dragFrom ? [chart.dragFrom, t] : null;
      chart.dragFrom = null;
      paintOverlay(root);
    });
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', cancel);
  }

  // ------------------------------------------------------------ the wall screen, the fills board, the clock
  // The wall screen answers one question at a glance -- how is the maker desk doing -- and shows the
  // few positions worth watching. Everything else is one click away: a position or a bot opens its
  // own view here, and clicking it again (or Back, or Escape) returns. It used to show three
  // numbers, every open position with a subtitle, and every quoted market, all in 5-unit text.
  // A watchlist, not a fixed leaderboard: click a column to sort by it, click it again to flip
  // direction -- the same convention as a Finder list view or a TradingView watchlist, instead of
  // a fixed Biggest/Gainers/Losers choice.
  let wallKey = '', tapeKey = '', clockTxt = '', wallSortCol = 'pl', wallSortDir = 'desc';
  const sideTag = (inv) => `<span class="sd ${inv > 0 ? 'long' : 'short'}">${inv > 0 ? 'LONG' : 'SHORT'} ${Math.abs(inv)}</span>`;
  const nameOf = (m) => String(lead(OUTCOME(m), QUESTION(m)).head || m.ticker);
  // Every row is { name, type, value, pl }: a maker market, or one cross-venue position.
  const sortHeld = (held) => {
    const dir = wallSortDir === 'asc' ? 1 : -1;
    const by = wallSortCol === 'name' ? (a, b) => dir * a.name.localeCompare(b.name)
      : wallSortCol === 'side' ? (a, b) => dir * a.side.localeCompare(b.side) || b.qty - a.qty
      : wallSortCol === 'type' ? (a, b) => dir * a.type.localeCompare(b.type) || b.pl - a.pl
      : wallSortCol === 'value' ? (a, b) => dir * (a.value - b.value)
        : (a, b) => dir * (a.pl - b.pl);
    return held.slice().sort(by);
  };
  // A locked arb is two contracts on the same question, one per venue. Listed leg by leg it read as
  // two unrelated bets; it is one position, so it gets one row: the question, what each side is
  // worth now, and the total.
  // A pair's label is "question · outcome" or "question - outcome" (Fed OCT 26 · Hike 25bps,
  // Texas Senate - James Talarico (D)). Split at the last separator so a pair reads like a maker
  // row: the outcome first, the question after it in the dimmer type.
  const splitLabel = (label) => {
    const t = unellipsis(label), i = Math.max(t.lastIndexOf(' · '), t.lastIndexOf(' - '));
    return i > 0 ? { outcome: t.slice(i + 3).trim(), question: t.slice(0, i).trim() } : { outcome: t, question: '' };
  };
  // "Trump bans more news outlets from..." -- the venue cut its own title short. The cut is kept (a
  // shorter name is still a name) but the dots go: the board never shows an ellipsis.
  const unellipsis = (s) => String(s || '').replace(/\s*(\.{3}|…)(?=\s|$)/g, '\u0000').split('\u0000')
    .map((t, i, a) => (i < a.length - 1 ? tidyEnd(t) : t)).join('').replace(/\s+/g, ' ').trim();
  // Too long for its line: drop whole words from the end, the dim part first, then the name itself
  // (never below one word), and never end on a connecting word. The result is remembered per text
  // and width, since the board is rebuilt every couple of seconds with the same rows.
  const fitMemo = new Map();
  const TRAIL = /(\s+(of|the|a|an|in|on|at|by|for|from|to|and|or|with|v|vs\.?|will|be|is|-|–|·))+$/i;
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
  // The outcome is the headline when it names something (Tom Cruise, Republican Party). When it is
  // only a date, a threshold or a number -- "Before Oct 1, 2026", "Above $82,500", "3.4%" -- it says
  // nothing on its own, so the event leads and the outcome follows it in the dimmer type.
  const MONTH = '(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';
  const BARE = new RegExp(`^((before|by|after|above|below|over|under|between|less than|more than|at least|at most|yes|no)\\b|[<>≥≤$+−-]?\\d|${MONTH}\\s+\\d)`, 'i');
  const lead = (outcome, question) => (question && (!outcome || BARE.test(outcome.trim()))
    ? { head: question, tail: outcome } : { head: outcome || question, tail: outcome ? question : '' });
  const takerRows = () => {
    const groups = new Map();
    for (const p of S.positions || []) {
      const k = p.group || p.id;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(p);
    }
    return [...groups.values()].map((legs) => {
      legs.sort((a, b) => (a.venue === 'PM' ? -1 : 1) - (b.venue === 'PM' ? -1 : 1));
      const worth = (p) => p.qty * (p.mark ?? p.entry);
      const { head, tail } = (({ outcome, question }) => lead(outcome, question))(splitLabel(legs[0].label));
      return { arb: legs, key: legs[0].group || legs[0].id, name: head, question: tail, label: String(legs[0].label || ''), type: cap(String(legs[0].strategy || 'taker')),
        side: legs.length > 1 ? 'both' : legs[0].side, qty: legs[0].qty, value: r2(legs.reduce((a, p) => a + worth(p), 0)), pl: r2(legs.reduce((a, p) => a + (p.pnl || 0), 0)),
        // under the name, the profit: first what a hedged arb is sure to make at settlement (a narrow
        // board cuts the end of the line, so the number that matters most goes first), then what each
        // side has made or lost at today's marks -- not what each side is worth
        sides: (() => { const g = legs.length > 1 && (S.arbGroups || []).find((x) => x.id === legs[0].group); return g && g.settlementValue != null && Number.isFinite(g.lockedPnl) ? `Locks in <b class="${g.lockedPnl >= 0 ? 'pos' : 'neg'}">${signed(g.lockedPnl)}</b> · ` : ''; })() +
          legs.map((p) => { const d = r2(p.pnl || 0); return `${venueName(p.venue)} ${esc(String(p.side).toUpperCase())} <b class="${d >= 0 ? 'pos' : 'neg'}">${signed(d)}</b>`; }).join(' + ') };
    });
  };

  // The screen used to be a tall-ish rectangle and the home view was a column: number, then a list
  // under it. It is a wide, shallow band now, so on a wide room the number takes a side and the
  // book takes the rest -- which is the only reason five positions fit where three did.
  let wallWide = false;
  function wallHome(M) {
    const makerNet = r2((M.equity ?? M.initial ?? 0) - (M.initial ?? 0));
    const pairNet = r2((S.equity ?? S.initial ?? 0) - (S.initial ?? 0));
    const net = r2(makerNet + pairNet);
    const P = S.pnl || {}, banked = r2((S.realized || 0) + (M.realized || 0));
    const stat = (label, v, cls) => `<div class="${cls || ''}"><dt>${label}</dt><dd class="${v >= 0 ? 'pos' : 'neg'}">${signed(v)}</dd></div>`;
    const held = sortHeld((M.markets || []).filter((m) => m.inv).map((m) => ({ m, name: nameOf(m), tail: lead(OUTCOME(m), QUESTION(m)).tail, type: 'Maker', side: m.inv > 0 ? 'long' : 'short', qty: Math.abs(m.inv), value: Math.abs(m.mark), pl: m.mark - m.cost })).concat(takerRows()));
    const up = held.filter((x) => x.pl > 0).length, down = held.filter((x) => x.pl < 0).length;
    const rows = held;
    // A number, what it means, and the two standing facts as labelled figures. They used to run
    // together in one dim sentence, which is the slowest way to read two numbers.
    const num = `<div class="wbig ${net >= 0 ? 'pos' : 'neg'}">${signed(net)}</div>` +
      `<div class="wsub">all paper trades, marked now</div>` +
      `<dl class="wstats">${stat('Maker', makerNet)}${stat('Cross-venue', pairNet)}` +
      // the rest of the column: how much of that is money already, how much is still a mark,
      // what the arbs are sure to pay, and what the venues have taken
      `${stat('Banked', banked, 'x sep')}${stat('Open', r2(net - banked), 'x')}` +
      `${Number.isFinite(P.arbLocked) ? stat('Locked in', P.arbLocked, 'x') : ''}` +
      `${S.fees ? `<div class="x"><dt>Fees paid</dt><dd>${money(S.fees)}</dd></div>` : ''}</dl>`;
    const tally = held.length ? `${up ? `<b class="pos">▲${up}</b>` : ''}${down ? `<b class="neg">▼${down}</b>` : ''}` : '';
    let h = `<div class="wh"><span>Paper account</span><span>${tally}${held.length ? `${held.length} held · ` : ''}${M.quoting || 0} quoted</span></div>`;
    if (!held.length) {
      h += num + `<p class="wempty">Nothing held. Quoting ${M.quoting || 0} markets.</p>`;
      return h;
    }
    // The header row is the sort control -- click a column, click it again to flip the arrow.
    const arrow = (dir) => dir === 'asc' ? '▲' : '▼';
    const colBtn = (k, label) => `<button type="button" role="columnheader" aria-sort="${wallSortCol === k ? (wallSortDir === 'asc' ? 'ascending' : 'descending') : 'none'}" data-wcol="${k}" class="${wallSortCol === k ? 'on' : ''}">${label}${wallSortCol === k ? `<i>${arrow(wallSortDir)}</i>` : ''}</button>`;
    const head = `<div class="wcols" role="row">${colBtn('name', 'Name')}${colBtn('type', 'Type')}${colBtn('side', 'Side')}${colBtn('value', 'Value')}${colBtn('pl', 'P&amp;L')}</div>`;
    const row = (x) => x.arb
      ? `<button class="wr arb" data-g="${esc(x.key)}" title="${esc(x.label)}"><span class="nm"><span class="l1 fitw"><span>${esc(x.name)}</span>${x.question ? `<i> · ${esc(x.question)}</i>` : ''}</span><small class="legs">${x.sides}</small></span><span class="ty">${esc(x.type)}</span>` +
        `<span class="sd ${x.arb.length > 1 ? 'arb' : 'long'}">${x.arb.length > 1 ? 'BOTH' : x.arb[0].side.toUpperCase()} ${x.arb[0].qty}</span><span class="val">${money(x.value)}</span><span class="pl ${x.pl >= 0 ? 'pos' : 'neg'}">${signed(x.pl)}</span></button>`
      : `<button class="wr ${x.m.inv > 0 ? 'long' : 'short'}" data-m="${esc(x.m.ticker)}" title="${esc(x.m.title || '')}">` +
        `<span class="nm"><span class="l1 fitw"><span>${esc(x.name)}</span>${x.tail ? `<i> · ${esc(x.tail)}</i>` : ''}</span></span><span class="ty">Maker</span>${sideTag(x.m.inv)}<span class="val">${money(Math.abs(x.m.mark))}</span><span class="pl ${x.pl >= 0 ? 'pos' : 'neg'}">${signed(x.pl)}</span></button>`;
    const list = `<div class="wlist">${rows.map(row).join('')}</div>`;
    h += `<div class="wbody">${`<div class="wnum">${num}</div>`}<div class="wbook">${head}${list}</div></div>`;
    return h;
  }

  // A clicked trade or position: what happened and whether it made money, in a few plain lines.
  // `fill` is the trade that was clicked, or the latest one in this market when a position was.
  const minsAgo = (t) => { const m = Math.round((S.now - t) / 60000); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : `${Math.floor(m / 60)}h ${m % 60}m ago`; };
  function wallRecap(ticker, at, M) {
    const m = byTicker(M, ticker);
    const fill = (M.recent || []).find((f) => f.ticker === ticker && (!at || f.at === at)) || null;
    const t = m ? lead(OUTCOME(m), QUESTION(m)) : null, name = t ? t.head : marketName(ticker);
    const open = m && m.inv ? r2(m.mark - m.cost) : 0;
    const total = m ? r2((m.realized || 0) + open) : null;
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span>${m ? `${m.fills} trade${m.fills === 1 ? '' : 's'} here` : ''}</span></div>`;
    h += `<div class="wtitle">${esc(name)}</div>`;
    if (t && t.tail && t.tail !== name) h += `<div class="wq">${esc(t.tail)}</div>`;
    if (total != null) h += `<div class="wbig ${total >= 0 ? 'pos' : 'neg'}">${signed(total)}</div><div class="wsub">profit on this market so far</div>`;
    h += `<ul class="wrecap">`;
    if (fill) {
      const made = fill.pnl ? ` That trade ${fill.pnl > 0 ? 'made' : 'lost'} <b class="${fill.pnl > 0 ? 'pos' : 'neg'}">${money(fill.pnl)}</b>.` : '';
      h += `<li>${fill.side === 'buy' ? 'Bought' : 'Sold'} ${fill.qty} at ${cc(fill.px)} (${money(fill.qty * fill.px)}), ${minsAgo(fill.at)}.${made}</li>`;
    }
    if (m) {
      h += m.inv
        ? `<li>Holding ${m.inv > 0 ? 'long' : 'short'} ${Math.abs(m.inv)}: paid ${money(Math.abs(m.cost))}, worth ${money(Math.abs(m.mark))} now (<b class="${open >= 0 ? 'pos' : 'neg'}">${signed(open)}</b>).</li>`
        : `<li>Nothing held here now.</li>`;
      if (m.realized) h += `<li>Already banked from closed trades: <b class="${m.realized >= 0 ? 'pos' : 'neg'}">${signed(m.realized)}</b>.</li>`;
    } else h += `<li>This market is no longer on the desk's board, so its running profit isn't shown.</li>`;
    return h + `</ul>`;
  }

  // A clicked cross-venue position: each side, what it cost, what it is worth now, and what the
  // pair pays when it settles. Read-only, like the maker recap; selling lives in the alert panel.
  function wallArb(key) {
    const legs = (S.positions || []).filter((p) => (p.group || p.id) === key)
      .sort((a, b) => (a.venue === 'PM' ? -1 : 1) - (b.venue === 'PM' ? -1 : 1));
    const g = (S.arbGroups || []).find((x) => x.id === key);
    let h = `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span>${legs.length ? `${cap(legs[0].strategy || 'taker')} · opened ${minsAgo(legs[0].openedAt)}` : ''}</span></div>`;
    if (!legs.length) return h + `<p class="wempty">Nothing is open in this position any more.</p>`;
    const cost = r2(legs.reduce((a, p) => a + p.cost, 0));
    const worth = r2(legs.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
    const pl = r2(worth - cost);
    const { outcome, question } = splitLabel(legs[0].label || key), t = lead(outcome, question);
    h += `<div class="wtitle">${esc(t.head)}</div>`;
    if (t.tail) h += `<div class="wq">${esc(t.tail)}</div>`;
    h += `<div class="wbig ${pl >= 0 ? 'pos' : 'neg'}">${signed(pl)}</div><div class="wsub">profit if sold at today's marks</div>`;
    h += `<ul class="wrecap">`;
    for (const p of legs) {
      const w = r2(p.qty * (p.mark ?? p.entry)), d = r2(w - p.cost);
      h += `<li>${venueName(p.venue)}: ${p.side.toUpperCase()} ${p.qty} at ${cc(p.entry)}. Paid ${money(p.cost)}, worth ${money(w)} now (<b class="${d >= 0 ? 'pos' : 'neg'}">${signed(d)}</b>).</li>`;
    }
    if (legs.length > 1) h += `<li>Both sides together: paid ${money(cost)}, worth ${money(worth)} now.</li>`;
    if (g && g.settlementValue != null) h += `<li>When it settles it pays ${money(g.settlementValue)}, locking in <b class="${g.lockedPnl >= 0 ? 'pos' : 'neg'}">${signed(g.lockedPnl)}</b>.</li>`;
    else if (g) h += `<li>The two sides don't line up (${esc(String(g.integrity).replace(/_/g, ' '))}), so the settlement value isn't certain.</li>`;
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
    // A line about a position names it underneath (RIGO's "the gap is unchanged" says nothing about
    // which market): a click opens the position, and Back comes back here. One that has closed since
    // is still named, but there is nothing left to open.
    const open = new Set((S.positions || []).map((p) => p.group || p.id));
    const refs = (e) => (Array.isArray(e.refs) && e.refs.length ? `<span class="wrefs">${e.refs.map((r) => (open.has(r.g)
      ? `<button class="wref" data-g="${esc(r.g)}" data-from="${esc(a.key)}" title="Open this position">${esc(unellipsis(refName(r)))} ›</button>`
      : `<span class="wref gone" title="Closed since">${esc(unellipsis(refName(r)))}</span>`)).join('')}</span>` : '');
    return `<div class="wh"><button class="wback" data-back="1">‹ Back</button><span style="color:${a.color}">${esc(a.key)} · ${esc(cap(String(a.role).toLowerCase()))}</span></div>` +
      `<div class="wq">${esc(cap(ROLE[a.key] || ''))}</div>` +
      (lines.length ? `<ol class="wlog">${lines.map(({ e, sx }) => `<li class="lv-${sx.level}"><span class="t">${hhmm(e.t)}</span><span>${cats(esc(sx.text))}${refs(e)}</span></li>`).join('')}</ol>`
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
      // under ~620px the Type column costs the names their width; the edge colour and BOTH still say arb
      el.classList.toggle('narrow', wallBox.w * k < 620);
      // Stacked (not wide), the number sits above the book instead of beside it, so a bigger font
      // now costs the book its own height. Below a real box the number and its breakdown collapse
      // to one line -- the list of positions is why this board exists, and a hero digit that leaves
      // it zero rows visible is a worse tradeoff than a smaller digit.
      el.classList.toggle('compact', !wallWide && wallBox.h * k < 235);
      const selPart = sel ? sel.kind + sel.key + (sel.at || '') : '', sortPart = `${wallSortCol}:${wallSortDir}`;
      const key = `${frameSeq}|${selPart}|${sortPart}|${wallWide}|${Math.round(wallBox.w * k)}`;
      if (key !== wallKey) {
        const list = el.querySelector('.wlist, .wlog');
        const prevParts = wallKey.split('|');
        // Re-sorting (like clicking a column header anywhere else) jumps back to the top instead
        // of holding a scroll offset that now points at a different row.
        const top = list && prevParts[1] === selPart && prevParts[2] === sortPart ? list.scrollTop : 0;
        wallKey = key;
        const m = sel && (sel.kind === 'market' || sel.kind === 'arb');
        const a = sel && sel.kind === 'agent' ? S.agents.find((x) => x.key === sel.key) : null;
        el.style.fontSize = `${wallFs}px`;
        {
          el.innerHTML = sel && sel.kind === 'market' ? wallRecap(sel.key, sel.at, M) : sel && sel.kind === 'arb' ? wallArb(sel.key) : a ? wallAgent(a) : wallHome(M);
          const list2 = el.querySelector('.wlist, .wlog');
          if (list2) list2.scrollTop = top;
          el.classList.toggle('more', !!list2 && list2.scrollHeight > list2.clientHeight + 2);
          fitAll(el);
          fitWidth(el.querySelector('.wbig'), 14);
          if (m) fitText(el, wallFs, 9);
        }
      }
    }

    if (chartBox) {
      const el = $('chart');
      fit(el, chartBox, Math.max(11, Math.min(16, k * 5.2)));
      if (el.dataset.frame !== String(frameSeq)) { el.dataset.frame = String(frameSeq); drawChart(el, false); }
    }

    if (tapeBox) {
      const el = $('tape');
      fit(el, { x: tapeBox.x + 1, y: tapeBox.y + 1, w: tapeBox.w - 2, h: tapeBox.h - 2 }, Math.max(11.5, Math.min(17, k * 5.6)));
      // The clock used to hang in a case of its own above this board, a strip of glass with one
      // number in it. It is this board's header now; the header and the list are built once and
      // the list is refilled, so the clock ticking does not rebuild the trades under it.
      if (!el.firstChild) el.innerHTML = '<div class="th"><span>Recent fills</span><span class="tclock"></span></div><div class="tbody"></div>';
      if (`${frameSeq}|${sel && sel.at}` !== tapeKey) {
        tapeKey = `${frameSeq}|${sel && sel.at}`;
        const groups = [];
        for (const f of recentFills(M)) {            // newest first; a run of the same maker trade is one line
          const g = groups[groups.length - 1];
          if (f.source === 'maker' && g && g.source === 'maker' && g.ticker === f.ticker && g.side === f.side) { g.qty += f.qty; g.val += f.qty * f.px; g.pnl = r2(g.pnl + f.pnl); }
          else groups.push({ ...f, val: f.qty * f.px });
        }
        // two lines a trade: what happened and what it cost, then which market and when
        el.querySelector('.tbody').innerHTML = groups.length
          ? `<ol>${groups.map((g) => `<li class="${g.side}${sel && sel.at === g.at ? ' on' : ''}"${g.source === 'maker' ? ` data-t="${esc(g.ticker)}" data-at="${g.at}"` : ''}>` +
              `<span class="act"><b>${esc(g.action)}</b> ${g.qty}</span><span class="px">${fillMoney(g, g.val)}</span>` +
              `<span class="nm fitw" title="${esc(fillName(g))}">${fillHtml(g)}</span><span class="ago">${cc(g.val / g.qty)} · ${ago(g.at).replace(' ago', '').split(' ')[0]}</span></li>`).join('')}</ol>`
          : `<p class="none">${M.fills ? `${M.fills} fills before the last restart` : 'No fills yet'}</p>`;
        fitAll(el);
        const ol = el.querySelector('ol');
        el.classList.toggle('more', !!ol && ol.scrollHeight > ol.clientHeight + 2);
      }
      const halted = S.halt || M.halted, on = !halted && M.quoting > 0;
      const t = new Date(S.now).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
      const hm = t.replace(/ [AP]M$/, '');
      const html = `<b class="${on ? 'on' : ''}">${hm.slice(0, -3)}<span class="sec">${hm.slice(-3)}</span></b><small>${t.slice(-2)} ET</small>`;
      if (html !== clockTxt) { el.querySelector('.tclock').innerHTML = html; clockTxt = html; }
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
  function closeBigChart() { if (bigChart.hidden) return; if (activeChart === $('chartbig-pnl')) setActive(null); bigChart.hidden = true; chart.hoverT = null; chart.dragFrom = null; chart.band = null; }
  // A click lands on the nearest ancestor of where the press began and where it ended, so a measuring
  // drag let go over the dark backdrop clicks the backdrop. Only a press that began there closes it.
  let pressedInBox = false;
  bigChart.addEventListener('pointerdown', (ev) => { pressedInBox = ev.target !== bigChart; });
  bigChart.addEventListener('click', (ev) => {
    if ((ev.target === bigChart && !pressedInBox) || ev.target.closest('[data-close]')) closeBigChart();
    pressedInBox = false;
  });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { setActive(null); closeBigChart(); } });

  $('wall').addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    // a position opened from a bot's page goes back to that bot, not to the home view
    if (b.dataset.back) sel = sel && sel.from ? { kind: 'agent', key: sel.from } : null;
    else if (b.dataset.wcol) {
      if (wallSortCol === b.dataset.wcol) wallSortDir = wallSortDir === 'asc' ? 'desc' : 'asc';
      else { wallSortCol = b.dataset.wcol; wallSortDir = ['name', 'type', 'side'].includes(b.dataset.wcol) ? 'asc' : 'desc'; }
    }
    else if (b.dataset.g) sel = sel && sel.kind === 'arb' && sel.key === b.dataset.g ? null : { kind: 'arb', key: b.dataset.g, ...(b.dataset.from ? { from: b.dataset.from } : {}) };
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

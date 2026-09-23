/* The lookout: the same desk as the trading floor, drawn as one painted room. It reads the same
   /api/stream frames the floor does and changes nothing -- there is not a single control on it. */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const scene = $('scene'), event = $('event');
  const STALE_MS = 12000;      // frames arrive every 2s; the floor uses the same limit
  const FILL_MS = 2500;        // how long a new fill lights the room
  const COLOR = { BRAM: '#5795ff', RIGO: '#f35d63', KETT: '#58dc83', ILSA: '#f2c446', MAKR: '#b473ed', HOLT: '#84dce0', TESS: '#f49a47' };
  const r2 = (x) => Math.round(x * 100) / 100;
  const signed = (v) => (v == null || !Number.isFinite(v) ? '—' : `${v < 0 ? '−' : '+'}$${Math.abs(r2(v)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
  const tone = (el, v) => { el.style.color = !Number.isFinite(v) ? '' : v < 0 ? '#f27b7f' : '#6fe3a0'; };
  const hhmm = (t) => new Date(t).toLocaleTimeString('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit' });

  let S = null, lastFrameAt = 0, lastFills = null, fillUntil = 0;

  function render() {
    const M = S.maker || {}, P = S.pnl || {};
    const makerNet = Number.isFinite(M.equity) && Number.isFinite(M.initial) ? M.equity - M.initial : null;
    const pairNet = Number.isFinite(S.equity) && Number.isFinite(S.initial) ? S.equity - S.initial : null;
    const net = makerNet == null || pairNet == null ? null : makerNet + pairNet;
    const halted = S.halt || M.halted;
    const live = S.mode === 'live';

    // a new fill on either book lights the room for a moment
    const fills = (M.fills || 0) + (S.takerFills || []).length;
    if (lastFills != null && fills > lastFills) fillUntil = Date.now() + FILL_MS;
    lastFills = fills;

    const agents = S.agents || [];
    const busy = agents.filter((a) => a.active || a.thinking);
    const state = halted ? 'halt' : Date.now() < fillUntil ? 'fill' : busy.length ? 'busy' : 'quiet';
    scene.className = `scene ${state}`;

    $('pnl').textContent = signed(net); tone($('pnl'), net);
    $('equity').textContent = signed(pairNet);
    // positions, not legs: a hedged arb is one position on both venues
    $('positions').textContent = new Set((S.positions || []).map((p) => p.group || p.id)).size;
    $('locked').textContent = signed(P.arbLocked);
    $('maker').textContent = signed(makerNet); tone($('maker'), makerNet);
    $('makerState').textContent = halted ? 'Stopped' : M.quoting > 0 ? 'Quoting' : 'Idle';
    $('quotes').textContent = M.quoting || 0;
    $('inventory').textContent = (+M.inv || 0).toLocaleString();
    $('fills').textContent = (M.fills || 0).toLocaleString();

    $('deskStatus').textContent = halted ? 'Stopped' : busy.length ? 'Working' : 'Monitoring';
    $('brief').textContent = halted ? 'New risk is halted' : busy.length ? `${busy.length} desk${busy.length === 1 ? '' : 's'} working` : 'No trade qualifies';
    $('detail').textContent = halted ? String(halted) : `${S.pairCount || 0} pairs watched · quoting ${M.quoting || 0} markets`;
    for (const i of document.querySelectorAll('.agent-strip i')) {
      const a = agents.find((x) => x.key === i.dataset.k);
      i.style.opacity = a && (a.active || a.thinking) ? '1' : '.35';
    }
    for (const b of document.querySelectorAll('.agent')) {
      const a = agents.find((x) => x.key === b.dataset.agent);
      b.classList.toggle('active', !!a && (a.active || a.thinking));
      b.querySelector('em').textContent = a && a.note ? a.note : 'Nothing yet';
    }

    const last = (S.log || [])[0];
    if (last) {
      event.style.setProperty('--agent', COLOR[last.agent] || '#8c968e');
      event.querySelector('b').textContent = last.agent;
      event.querySelector('span').textContent = String(last.text).split(' · ')[0];
      event.querySelector('span').title = last.text;
      event.querySelector('time').textContent = hhmm(last.t);
    }

    const mode = $('mode');
    mode.classList.toggle('real', live);
    mode.querySelector('b').textContent = live ? 'LIVE' : 'PAPER';
    mode.querySelector('span').textContent = live ? 'Real money' : S.demo ? 'Demo quotes' : 'No real money';
    $('notice').textContent = live ? 'Live desk · real money' : 'Live desk · paper account';

    $('curtain').hidden = state !== 'halt';
    $('curtainTitle').textContent = 'THE DESK IS STOPPED';
    $('curtainText').textContent = 'New risk is disabled. Open positions are still watched.';
  }

  // If frames stop, say so over the room instead of freezing on the last good picture.
  setInterval(() => {
    if (!lastFrameAt || Date.now() - lastFrameAt <= STALE_MS) return;
    scene.className = 'scene stale';
    $('curtain').hidden = false;
    $('curtainTitle').textContent = 'THE FLOOR WENT QUIET';
    $('curtainText').textContent = `No new frame from the desk since ${hhmm(lastFrameAt)}. Reconnecting…`;
    $('notice').textContent = 'No signal from the desk';
  }, 1000);

  document.querySelectorAll('.agent').forEach((a) => a.addEventListener('click', () => {
    const on = a.classList.contains('focus');
    document.querySelectorAll('.agent').forEach((x) => x.classList.remove('focus'));
    if (!on) a.classList.add('focus');
  }));

  function connect() {
    const es = new EventSource('/api/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); lastFrameAt = Date.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  connect();
})();

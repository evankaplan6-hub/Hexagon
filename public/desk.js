/* The Hexagon — the stocks, crypto and options desk's floor at /. Consumes /api/desk/stream.
 *
 * A wall of boards, one screen each: the headline (every book against simply holding what it holds),
 * the desk's own state, the markets it watches, one card per book with everything the book holds,
 * the P&L chart, and what the bots are doing. Until 2026-09-25 the boards were painted into a pixel
 * room with the bots at their desks and sized by the room's zoom, so most of their words were under
 * 12px; the bots and the room went at Evan's asking, and the boards are laid out for reading now.
 * The bots are still the desk's workers: the activity list says which of them did what.
 *
 * Read-only: nothing on this page can place, change or cancel anything.
 */
(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  let S = null;

  // ------------------------------------------------------------ formatting
  // One way to write a number everywhere on the page: a true minus, a plus only when there is something
  // to be plus about, thousands separators, cents on money and prices, and each coin to its own
  // decimals. Zero is neither a gain nor a loss: no sign, and the neutral ink rather than the green.
  const MINUS = '−';
  const money = (x, d = 2) => `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d })}`;
  const isZero = (x, d = 2) => Math.abs(x) < 0.5 / 10 ** d;
  // U+2060, the word joiner, is invisible and holds the sign to the dollar wherever a figure sits in running
  // text (a book's "banked +$4.20"), where the nowrap on .pos, .neg and .zero does not reach. The tab's
  // title and the chart's axis take it out again with plain(): nothing wraps there.
  const signed = (x, d = 2) => (isZero(x, d) ? money(0, d) : `${x > 0 ? '+' : MINUS}\u2060${money(x, d)}`);
  const plain = (s) => s.replace(/\u2060/g, '');
  const tone = (x, d = 2) => (isZero(x, d) ? 'zero' : x > 0 ? 'pos' : 'neg');
  // The desk's log writes money as it adds it up ($1869.41); shown with its thousands separators, the way
  // every other figure on the page reads. Figures already grouped ($83,946.05) are left alone.
  const grouped = (s) => s.replace(/\$(\d{4,})(?=[.\s,)]|$)/g, (m, i) => `$${Number(i).toLocaleString('en-US')}`);
  const figure = (x) => `<span class="${tone(x)}">${signed(x)}</span>`;
  const r2 = (x) => Math.round(x * 100) / 100;
  const pct = (x, d = 0) => `${(x * 100).toFixed(d)}%`;
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cap = (s) => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
  const ET_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true });
  const ET_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
  const ET_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true });
  const hhmm = (t) => ET_HM.format(new Date(t)).replace(/ [AP]M$/, '');
  const dur = (ms) => {
    const h = Math.floor(ms / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
    return h >= 48 ? `${Math.floor(h / 24)}d ${String(h % 24).padStart(2, '0')}h` : `${h}h ${String(m).padStart(2, '0')}m`;
  };
  // a price the way its market quotes it: dollars and cents, and an option's premium to the tenth of a cent
  const px = (p) => (!Number.isFinite(p) ? '—' : p >= 1 ? `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : `$${p.toFixed(p < 0.1 ? 3 : 2)}`);
  // a coin to the decimals its price needs: a thousandth of a bitcoin is $80, of a SOL twelve cents
  const COIN_DP = { 'BTC-USD': 6, 'ETH-USD': 4, 'SOL-USD': 2 };
  const qtyTxt = (q, book, sym) => (book === 'crypto'
    ? (+q).toLocaleString('en-US', { minimumFractionDigits: COIN_DP[sym] ?? 6, maximumFractionDigits: COIN_DP[sym] ?? 6 })
    : book === 'stocks' ? `${+(+q).toFixed(3)}` : String(q));
  const bookOf = (k) => (S && S.books || []).find((b) => b.key === k) || null;
  const BOOK_COLOR = { crypto: 'var(--book-crypto)', stocks: 'var(--book-stocks)', options: 'var(--book-options)' };
  // tokens.css, read once for the one thing that cannot take a var(): the chart library
  const TOK = (() => {
    const cs = getComputedStyle(document.documentElement), t = {};
    for (const k of ['ink-1', 'ink-2', 'ink-3', 'gain', 'loss', 'rule-1']) t[k] = cs.getPropertyValue(`--${k}`).trim();
    return t;
  })();
  const withAlpha = (hex, a) => { const n = parseInt(hex.slice(1), 16); return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`; };

  // ------------------------------------------------------------ rendering that keeps what a person is doing
  // The stream lands every two seconds, and replacing a board's HTML each time would throw away whatever
  // a person had focused, hovered or selected on it. morph() patches the page into the new HTML instead,
  // so an element that is still there stays the same element. A child is matched by its data-k when it
  // has one; a <details> keeps whether the person opened it.
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
      const own = x.nodeName === 'DETAILS' ? 'open' : null;
      for (const { name, value } of [...y.attributes]) if (name !== own && x.getAttribute(name) !== value) x.setAttribute(name, value);
      for (const { name } of [...x.attributes]) if (name !== own && !y.hasAttribute(name)) x.removeAttribute(name);
      patch(x, y);
    }
    while (a.childNodes.length > want.length) a.removeChild(a.lastChild);
  }

  // ------------------------------------------------------------ the header: is it working, and what time is it
  let lastFrameAt = 0, shownGone = null;
  const STALE_MS = 12000;
  const stale = () => lastFrameAt && Date.now() - lastFrameAt > STALE_MS;
  const deskState = () => (stale() ? ['No signal', 'bad'] : S.halt ? ['Stopped', 'bad'] : S.market && S.market.stale && S.market.stale.crypto ? ['Waiting on prices', 'warn'] : ['Working', 'good']);
  // the desk's clock, carried forward between frames
  const nowT = () => (S ? S.now + (performance.now() - (S._rxPerf || performance.now())) : Date.now());
  function renderHeader() {
    const gone = !!stale();
    shownGone = gone;
    const [state, cls] = deskState();
    const pill = $('deskstate');
    pill.className = `pill ${cls}`;
    morph(pill, `<i></i>${esc(state)}<span class="mode">Paper</span>`);
    // a background tab says how the desk is doing, not just its name
    const title = Number.isFinite(S.pnl) ? `${plain(signed(S.pnl))} · ${state} · The Hexagon` : 'The Hexagon';
    if (document.title !== title) document.title = title;
    const L = S.legacy;
    morph($('pmlink'), `Prediction markets${L ? (L.groups || L.contracts ? ': winding down' : ': settled') : ''} ›`);
    $('floor').classList.toggle('gone', gone);
    const msg = gone ? 'No signal from the desk: this page is showing the last state it received.' : S.halt ? `Stopped buying: ${S.halt}` : '';
    const banner = $('banner');
    banner.hidden = !msg;
    if (banner.textContent !== msg) banner.textContent = msg;
  }
  function renderClock() {
    const m = ET_CLOCK.format(new Date(nowT())).match(/^(\d+:\d\d)(:\d\d) ([AP]M)$/);
    const html = m ? `${m[1]}<span class="sec">${m[2]}</span> ${m[3]} ET` : '';
    if ($('clock').innerHTML !== html) $('clock').innerHTML = html;
  }

  // ------------------------------------------------------------ the headline: every book against simply holding
  function heroHtml() {
    const books = S.books || [];
    const bench = books.filter((b) => b.bench != null);
    const benchPnl = bench.length ? r2(bench.reduce((a, b) => a + b.benchPnl, 0)) : null;
    const vs = bench.length ? r2(bench.reduce((a, b) => a + b.pnl, 0) - benchPnl) : null;
    const fees = r2(books.reduce((a, b) => a + (b.fees || 0), 0));
    const atWork = r2(books.reduce((a, b) => a + b.rows.reduce((x, r) => x + (r.value || 0), 0), 0));
    const cash = r2((S.equity || 0) - atWork);
    const kpi = (label, html, title) => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd>${html}</dd></div>`;
    // the one sentence that says why the books and holding differ
    let insight = '';
    if (benchPnl != null) {
      insight = `Simply holding what the books hold would be <b>${figure(benchPnl)}</b>; they are <b>${figure(vs)}</b> against that${fees ? `, after ${money(fees)} in fees` : ''}.`;
      if (vs < 0 && fees >= -vs * 0.5) insight += ' The fees are most of the gap.';
    }
    return `<span class="label">All paper books</span>` +
      `<div class="big ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="sub">on ${money(S.initial, 0)} of paper · marked ${esc(ET_HM.format(new Date(S.now)))} ET</div>` +
      `<dl class="kpis">${kpi('Today', S.today != null ? figure(S.today) : '—')}` +
      `${kpi('vs holding', vs != null ? figure(vs) : '—', 'The books against simply holding what they hold, from each book’s first trade')}` +
      `${kpi('Fees paid', money(fees))}${kpi('At work', `${money(atWork, 0)}<small>${money(cash, 0)} in cash</small>`)}</dl>` +
      (insight ? `<p class="insight">${insight}</p>` : '');
  }

  // ------------------------------------------------------------ the desk: market, prices, the options day, the limits
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
  function deskHtml() {
    const mk = S.market || {}, C = S.cfg || {};
    const cryptoOk = !(mk.stale && mk.stale.crypto);
    const lag = mk.delayMin != null ? `SPY ${mk.delayMin} min late` : 'SPY 15 min late';
    const rows = [
      ['Stock market', `<b>${mk.open ? 'Open' : 'Closed'}</b> · ${esc(mk.says || '')}`],
      ['Prices', `<span class="dot${cryptoOk ? '' : ' warn'}"></span>Crypto ${cryptoOk ? 'live' : 'stale'} · <span class="dot warn"></span>${esc(lag)}`],
      ['Options today', esc(cap(optionsLine()))],
    ];
    // how much of the day's loss limit is used: TESS stops all new buying when it is
    if (C.maxDailyDdPct && S.today != null && S.equity) {
      const start = S.equity - S.today, down = start > 0 ? Math.max(0, -S.today / start) : 0, used = Math.min(1, down / C.maxDailyDdPct);
      rows.push(['Loss limit', `${down ? `down ${(down * 100).toFixed(2)}%` : 'nothing lost'} today; buying stops at ${(C.maxDailyDdPct * 100).toFixed(0)}%` +
        `<span class="meter" role="img" aria-label="${Math.round(used * 100)}% of the daily loss limit used"><i style="width:${(used * 100).toFixed(1)}%"></i></span>`]);
    }
    // the prediction-market desk, winding down in the same process
    const P = S.legacy;
    if (P) {
      const still = P.groups || P.contracts ? `${P.groups} arb${P.groups === 1 ? '' : 's'} and ${Number(P.contracts || 0).toLocaleString('en-US')} maker contracts open` : 'everything settled';
      const next = P.nextSettle ? ` · next settles ${new Date(P.nextSettle).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '';
      rows.push(['Prediction mkts', `<a href="/pm">${figure(P.pnl)}</a> · ${esc(still + next)}`]);
    }
    const sha = S.build && S.build.sha ? String(S.build.sha).slice(0, 7) : 'dev';
    return `<span class="label">The desk</span><dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
      `<p class="deskfoot">Running ${dur(S.now - S.startedAt)} · build ${esc(sha)}</p>`;
  }

  // ------------------------------------------------------------ the markets the desk watches
  function marketsHtml() {
    const rows = [];
    const chg = (last, prev) => (last > 0 && prev > 0 ? last / prev - 1 : null);
    // how fresh each price is lives on the desk board; here, what each market is
    for (const r of (bookOf('crypto') || { rows: [] }).rows) rows.push({ name: r.name, sub: r.label, price: px(r.bid), chg: chg(r.bid, r.prevClose), vol: r.vol, want: r.want });
    const sp = S.spy;
    if (sp) rows.push({ name: 'SPY', sub: 'S&P 500 ETF', price: px(sp.bid || sp.last), chg: chg(sp.last, sp.prevClose), vol: sp.vol, want: sp.want });
    const change = (c) => (c == null ? '—' : `<span class="${tone(c, 4)}">${isZero(c, 4) ? '0.00%' : `${c > 0 ? '+' : MINUS}${Math.abs(c * 100).toFixed(2)}%`}</span>`);
    return `<span class="label">Markets</span><table class="mtab"><thead><tr><th scope="col">Market</th><th scope="col">Price</th><th scope="col">Today</th>` +
      `<th scope="col" title="How much it moves in a year, measured over the last 30 days (crypto) or 20 sessions (SPY)">Swings</th>` +
      '<th scope="col" title="How much of its slot the book wants to hold: less when it swings more">Target</th></tr></thead><tbody>' +
      rows.map((x) => `<tr data-k="${esc(x.name)}"><th scope="row">${esc(x.name)}<small>${esc(x.sub)}</small></th><td>${x.price}</td><td>${change(x.chg)}</td>` +
        `<td>${Number.isFinite(x.vol) ? pct(x.vol) : '—'}</td><td>${Number.isFinite(x.want) ? pct(x.want) : '—'}</td></tr>`).join('') +
      '</tbody></table>';
  }

  // ------------------------------------------------------------ a book: against holding, its line, what it holds, what next
  // The book's own P&L over its history (and simply holding, dashed), from /api/desk/history's per-book values.
  function sparkSvg(key) {
    const field = { crypto: 'c', stocks: 's', options: 'o' }[key], benchField = { crypto: 'bc', stocks: 'bs' }[key];
    const init = (hist.books || {})[key], b = bookOf(key);
    const series = init ? hist.points.filter((p) => p[field] != null).map((p) => [p.t, p[field] - init, benchField && p[benchField] != null ? p[benchField] - init : null]) : [];
    if (b) series.push([S.now, b.pnl, b.bench != null ? b.benchPnl : null]);
    const box = (inner) => `<svg class="spark" viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">${inner}</svg>`;
    if (series.length < 2) return box('<line x1="0" x2="1000" y1="50" y2="50"/>');
    const vals = [0];
    for (const [, v, h] of series) { vals.push(v); if (h != null) vals.push(h); }
    let lo = Math.min(...vals), hi = Math.max(...vals);
    if (hi - lo < 0.01) { hi += 1; lo -= 1; }
    const t0 = series[0][0], t1 = series[series.length - 1][0];
    const X = (t) => (((t - t0) / Math.max(1, t1 - t0)) * 1000).toFixed(1), Y = (v) => (96 - ((v - lo) / (hi - lo)) * 92).toFixed(1);
    const path = (i) => series.filter((s) => s[i] != null).map((s, j) => `${j ? 'L' : 'M'}${X(s[0])},${Y(s[i])}`).join('');
    return box(`<line x1="0" x2="1000" y1="${Y(0)}" y2="${Y(0)}"/>${benchField ? `<path class="hold" d="${path(2)}"/>` : ''}<path class="line" d="${path(1)}"/>`);
  }
  function holdRow(b, r) {
    if (b.key === 'options') {
      return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><small>${r.qty} × ${px(r.px)} · ${esc(r.label)}</small></th>` +
        `<td class="v">${money(r.value || 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td></tr>`;
    }
    const what = r.qty > 0 ? `${qtyTxt(r.qty, b.key, r.sym)} at ${px(r.px)}` : `not held yet · ${px(r.px)}`;
    const want = Number.isFinite(r.target) ? ` · target ${Math.round(r.target * 100)}%` : '';
    return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><small>${what}${want}</small></th>` +
      `<td class="v">${money(r.value || 0, 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td></tr>`;
  }
  // the options book with nothing open: how today's test went, and where SPY is
  function optionsFacts() {
    const O = S.options || {}, d = O.day, sp = O.spy, rows = [];
    if (d && d.test && Number.isFinite(d.test.moveAtr)) rows.push(['12:30 test', `${d.test.dir || d.dir || ''} ${d.test.moveAtr.toFixed(2)} ATR from the open${Number.isFinite(d.test.retr) ? `, gave back ${Math.round(d.test.retr * 100)}%` : ''}`]);
    if (sp && Number.isFinite(sp.c)) rows.push(['SPY, last bar', `${sp.c.toFixed(2)} · VWAP ${sp.vwap != null ? sp.vwap.toFixed(2) : '—'} · ATR ${sp.atr != null ? sp.atr.toFixed(2) : '—'}`]);
    for (const t of (O.trades || []).slice(0, 3)) rows.push([t.date.slice(5).replace('-', '/'), `${t.qty} × ${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No contracts open.</p>';
  }
  function nextLine(b) {
    if (b.key === 'crypto') return `Checks again after midnight UTC: <b>${esc(ET_HM.format(new Date(Math.floor(S.now / 864e5 + 1) * 864e5)))} ET</b>`;
    if (b.key === 'stocks') return S.market && S.market.open ? 'Checks once a trading day, after the open' : `Checks at the next open: <b>${esc(String((S.market && S.market.says) || '').replace(/^opens /, ''))}</b>`;
    return esc(cap(optionsLine()));
  }
  function bookCard(b) {
    const held = b.rows.filter((r) => r.qty > 0).length;
    const chip = b.key === 'options' ? (b.rows.length ? `${b.rows.length} open` : 'no position') : held ? `${held} held` : 'not holding yet';
    const vs = b.bench != null ? `<span class="vs">holding <b class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</b></span>` : '';
    const body = b.rows.length ? `<table class="hold-t"><tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>`
      : b.key === 'options' ? optionsFacts() : '<p class="bksub">Nothing held yet.</p>';
    return `<article class="card bk" data-k="${b.key}" style="--bk:${BOOK_COLOR[b.key]}" aria-label="${esc(b.name)} book">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(chip)}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<div class="bksub">worth ${money(b.equity)} of ${money(b.initial, 0)}${b.fees ? ` · fees ${money(b.fees)}` : ''}${b.realized && !isZero(b.realized) ? ` · banked ${signed(b.realized)}` : ''}</div>` +
      sparkSvg(b.key) + body +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule)}</p></details>` +
      `<p class="next">${nextLine(b)}</p></article>`;
  }
  const renderBooks = () => morph($('books'), (S.books || []).map(bookCard).join(''));

  // ------------------------------------------------------------ what's happening: the bots' log, sorted by what it means
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  // One log line -> { text, sub, level }. The desk writes its log in plain sentences already; the part
  // before the first " · " is what happened, the rest is the detail underneath.
  //   trade  money moved          warn  needs a look
  //   info   a decision           quiet the desk doing its rounds
  function say(e) {
    const t = grouped(String(e.text || '')), parts = t.split(' · '), first = cap(parts[0]), rest = parts.slice(1).join(' · ');
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
  // The routine rounds ("3/3 coins live", "all clear") come every few minutes and used to push the day's
  // few trades out of sight, so they are counted and hidden until asked for.
  const LEVELS = [['trade', 'Trades'], ['info', 'Signals'], ['warn', 'Warnings'], ['quiet', 'Routine']];
  let showing = new Set(['trade', 'info', 'warn']);
  try { const v = JSON.parse(localStorage.getItem('desk-activity') || 'null'); if (Array.isArray(v)) showing = new Set(v); } catch { /* defaults */ }
  function renderActivity() {
    const rows = [], last = {}, count = {};
    for (const e of S.log || []) {
      const s = say(e), k = shape(s.text);
      if (last[e.agent] === k) continue;   // the same round said again: once is enough
      last[e.agent] = k;
      rows.push({ e, s });
      count[s.level] = (count[s.level] || 0) + 1;
    }
    morph($('chips'), LEVELS.map(([lv, name]) => `<button type="button" data-lv="${lv}" class="${showing.has(lv) ? 'on' : ''}" aria-pressed="${showing.has(lv)}">${name}<span>${count[lv] || 0}</span></button>`).join(''));
    const shown = rows.filter(({ s }) => showing.has(s.level)).slice(0, 80);
    morph($('feedlist'), shown.map(({ e, s }) => {
      const amt = (e.kind === 'FILL' || e.kind === 'SETTLE') && e.pnl != null ? `<span class="amt ${tone(e.pnl)}">${signed(e.pnl)}</span>` : '<span class="amt"></span>';
      return `<li class="lv-${s.level}" data-k="${esc(logKey(e))}"><time>${hhmm(e.t)}</time><span class="who">${esc(e.agent)}</span>` +
        `<span class="what">${esc(s.text)}${s.sub ? `<small>${esc(s.sub)}</small>` : ''}</span>${amt}</li>`;
    }).join('') || `<li class="empty">${rows.length ? 'Nothing of those kinds yet.' : 'Waiting for the first desk round.'}</li>`);
  }
  $('chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-lv]');
    if (!b) return;
    if (showing.has(b.dataset.lv)) showing.delete(b.dataset.lv); else showing.add(b.dataset.lv);
    try { localStorage.setItem('desk-activity', JSON.stringify([...showing])); } catch { /* private window */ }
    if (S) renderActivity();
  });
  // a fill or a halt is read out once, by a screen reader, as it lands; nothing else is
  let announced = null;
  function announce() {
    const e = (S.log || []).find((x) => x.kind === 'FILL' || x.kind === 'SETTLE' || x.kind === 'HALT');
    if (!e) return;
    const k = logKey(e);
    if (announced !== null && k !== announced) $('announce').textContent = `${e.agent}: ${say(e).text}`;
    announced = k;
  }

  // ------------------------------------------------------------ the chart: every book, and what holding would have made
  const RANGES = [['1h', 36e5], ['6h', 216e5], ['24h', 864e5], ['All', Infinity]];
  const chart = { range: 'All' };
  try { const c = JSON.parse(localStorage.getItem('desk-chart') || '{}'); if (RANGES.some(([r]) => r === c.range)) chart.range = c.range; } catch { /* defaults */ }
  let hist = { points: [], initial: 0, books: {}, loaded: false };
  async function loadHistory() {
    try {
      const r = await fetch('/api/desk/history');
      if (!r.ok) return;
      const h = await r.json();
      hist = { points: h.points || [], initial: h.initial || 0, books: h.books || {}, loaded: true };
      for (const el of plots.keys()) drawChart(el);
      if (S) renderBooks();
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
    const seg = `<span class="seg">${RANGES.map(([r]) => `<button type="button" data-range="${r}" class="${chart.range === r ? 'on' : ''}">${r}</button>`).join('')}</span>`;
    return `<div class="ct"><span class="ctitle">Profit and loss · every book</span>${big ? '' : '<button type="button" class="cx" data-expand="1" title="Open large" aria-label="Open the chart large">⤢</button>'}</div>` +
      `<div class="chead"><span class="cv"></span><span class="cd"></span></div>` +
      `<div class="cplot"></div><div class="cb">${seg}<span class="cr"></span></div>`;
  }
  function makePlot(el, big) {
    const LW = window.LightweightCharts;
    if (!LW) return null;
    const c = LW.createChart(el.querySelector('.cplot'), {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: TOK['ink-3'], fontFamily: "'JetBrains Mono', ui-monospace, Menlo, monospace", fontSize: 12, attributionLogo: true },
      grid: { vertLines: { visible: false }, horzLines: { color: TOK['rule-1'] } },
      // a label at the plot's edge is drawn whole or not at all, never cut in half; the bottom margin
      // is set in drawChart from the plot's height, to keep the line clear of the licence's logo
      rightPriceScale: { borderVisible: false, entireTextOnly: true, scaleMargins: { top: 0.12, bottom: 0.12 } },
      // the axis in Eastern time, like every other time on the page (the library's own is UTC)
      timeScale: { visible: true, borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true,
        tickMarkFormatter: (sec, type) => (type >= 3 ? ET_HM : ET_DAY).format(new Date(sec * 1000)) },
      localization: { timeFormatter: (sec) => new Date(sec * 1000).toLocaleString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) },
      crosshair: { mode: LW.CrosshairMode.Magnet, horzLine: { visible: big, labelVisible: big } },
    });
    // Above zero the line and its fill are the gain colour, below it the loss colour, whatever the range.
    const desk = c.addSeries(LW.BaselineSeries, { baseValue: { type: 'price', price: 0 },
      topLineColor: TOK.gain, topFillColor1: withAlpha(TOK.gain, 0.22), topFillColor2: withAlpha(TOK.gain, 0.02),
      bottomLineColor: TOK.loss, bottomFillColor1: withAlpha(TOK.loss, 0.02), bottomFillColor2: withAlpha(TOK.loss, 0.22),
      lineWidth: big ? 3 : 2, priceLineVisible: false, lastValueVisible: big, crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (v) => plain(signed(v)) } });
    const hold = c.addSeries(LW.LineSeries, { color: TOK['ink-3'], lineWidth: 1, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    desk.createPriceLine({ price: 0, color: withAlpha(TOK['ink-3'], 0.45), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
    return { c, desk, hold };
  }
  function drawChart(el) {
    const p = plots.get(el);
    if (!p) return;
    const pts = chartSeries();
    const last = pts.length ? pts[pts.length - 1][1] : (S ? S.pnl : 0);
    const first = pts.length ? pts[0][1] : last;
    morph(el.querySelector('.cv'), figure(last || 0));
    el.querySelector('.cd').textContent = pts.length > 1 ? `${signed(last - first)} over ${chart.range === 'All' ? 'all of it' : `the last ${chart.range}`}` : '';
    const lastHold = [...pts].reverse().find((x) => x[2] != null);
    morph(el.querySelector('.cr'), lastHold ? `<span title="The dashed line: every book simply holding what it trades, from its first trade">holding: <b class="${tone(lastHold[2])}">${signed(lastHold[2])}</b></span>` : '');
    if (!p.plot) p.plot = makePlot(el, p.big);
    if (!p.plot) return;
    // The licence's logo sits in the plot's bottom-left corner, about 30px tall, just above the time
    // axis: the chart leaves that much under the lowest point so the line never runs through it.
    const ph = el.querySelector('.cplot').clientHeight - 28;
    const bottom = Math.min(0.5, Math.max(0.12, 34 / Math.max(1, ph)));
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
  // The chart opened large: it takes the keyboard while it is open and gives it back when it closes.
  const bigChart = $('chartbig');
  let opener = null;
  function openBigChart() {
    opener = document.activeElement;
    bigChart.hidden = false;
    drawChart($('chartbig-pnl'));
    bigChart.querySelector('.cbback').focus();
  }
  function closeBigChart() {
    if (bigChart.hidden) return;
    bigChart.hidden = true;
    if (opener && document.contains(opener)) opener.focus();
    opener = null;
  }
  bigChart.addEventListener('click', (ev) => { if (ev.target === bigChart || ev.target.closest('[data-close]')) closeBigChart(); });
  bigChart.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const f = [...bigChart.querySelectorAll('button')];
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') closeBigChart(); });

  // ------------------------------------------------------------ wiring: a frame every two seconds, a clock every second
  function render() {
    renderHeader();
    renderClock();
    morph($('hero'), heroHtml());
    morph($('desk'), deskHtml());
    morph($('markets'), marketsHtml());
    renderBooks();
    renderActivity();
    announce();
    drawChart($('chart'));
    if (!bigChart.hidden) drawChart($('chartbig-pnl'));
    $('floor').removeAttribute('aria-busy');
  }
  function connect() {
    const es = new EventSource('/api/desk/stream');
    es.onmessage = (ev) => { try { S = JSON.parse(ev.data); S._rxPerf = performance.now(); lastFrameAt = Date.now(); render(); } catch (e) { console.error(e); } };
    es.onerror = () => { es.close(); setTimeout(connect, 3000); };
  }
  // Nothing redraws at rest: the clock ticks, and the page notices when the stream has gone quiet.
  setInterval(() => { if (!S) return; renderClock(); if (!!stale() !== shownGone) renderHeader(); }, 1000);
  morph($('hero'), '<span class="label">All paper books</span><p class="sub">Connecting to the desk…</p>');
  wireChart($('chart'), false);
  wireChart($('chartbig-pnl'), true);
  connect();
  loadHistory(); setInterval(loadHistory, 60000);
})();

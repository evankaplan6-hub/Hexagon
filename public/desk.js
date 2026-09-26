/* The Hexagon — the stocks, crypto and options desk's floor at /. Consumes /api/desk/stream.
 *
 * A wall of boards, one screen each: the headline (every book against simply holding what it holds),
 * the desk's own state, one card per book with everything the book holds and the markets it trades,
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
  // The activity list's times keep their AM or PM, and a line naming the day heads anything from before
  // today: a bare "6:17" from yesterday evening read as this morning. Days are Eastern, like the clock.
  const ET_YMD = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' });
  const ET_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const dayKey = (t) => { const p = {}; for (const x of ET_YMD.formatToParts(new Date(t))) p[x.type] = x.value; return `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`; };
  const dayBefore = (k) => new Date(Date.parse(`${k}T12:00:00Z`) - 864e5).toISOString().slice(0, 10);
  const dayName = (t, today) => (dayKey(t) === dayBefore(today) ? 'Yesterday' : ET_DATE.format(new Date(t)));
  // a price the way its market quotes it: dollars and cents, and an option's premium to the tenth of a cent
  // only when it has one (an average over two fills); a $0.07 premium read "$0.070"
  const px = (p) => (!Number.isFinite(p) ? '—' : p >= 1 ? `$${p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : `$${p.toFixed(Math.abs(p * 100 - Math.round(p * 100)) < 1e-6 ? 2 : 3)}`);
  // an Eastern day ("2026-09-25") as its weekday, and a minute of the Eastern day as a time ("3:55 PM")
  const WD = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  const wd = (k) => WD.format(new Date(`${k}T12:00:00Z`));
  const minTxt = (m) => `${((Math.floor(m / 60) + 11) % 12) + 1}:${String(m % 60).padStart(2, '0')} ${m >= 720 ? 'PM' : 'AM'}`;
  const coin = (sym) => String(sym).replace(/-USD$/, '');
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
  // The desk's own heartbeat, the moment its last round finished. The server keeps streaming while a stuck
  // round holds the desk's loop, and then every price on the page stands still under a light that says
  // Working. Two minutes is twelve rounds, and longer than any round's calls can take.
  const stalled = () => !!(S && S.beat && S.now - S.beat > Math.max(120000, 12 * ((S.cfg && S.cfg.everySec) || 10) * 1000));
  // Past the daily loss limit the desk is still marking and may still sell: it is not stopped, it is not buying.
  const deskState = () => (stale() ? ['No signal', 'bad'] : stalled() ? ['Stalled', 'bad'] : S.halt ? ['Not buying', 'warn']
    : S.market && S.market.stale && S.market.stale.crypto ? ['Waiting on prices', 'warn'] : ['Working', 'good']);
  // the desk's clock, carried forward between frames
  const nowT = () => (S ? S.now + (performance.now() - (S._rxPerf || performance.now())) : Date.now());
  function renderHeader() {
    const gone = !!stale(), stuck = stalled();
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
    $('floor').classList.toggle('gone', gone || stuck);
    const msg = gone ? 'No signal from the desk: this page is showing the last state it received.'
      : stuck ? `The desk has finished no round since ${ET_HM.format(new Date(S.beat))} ET: every price and figure here stopped then.`
        : S.halt ? `${cap(S.halt)}. Selling still works.` : '';
    const banner = $('banner');
    banner.hidden = !msg;
    banner.classList.toggle('warn', !gone && !stuck && !!S.halt);
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
    const benchFees = r2(bench.reduce((a, b) => a + (b.fees || 0), 0));   // the fees inside that comparison
    const holdFee = r2(bench.reduce((a, b) => a + (b.benchFee || 0), 0));  // what holding paid to buy in
    const atWork = r2(books.reduce((a, b) => a + b.rows.reduce((x, r) => x + (r.value || 0), 0), 0));
    const cash = r2((S.equity || 0) - atWork);
    const kpi = (label, html, title) => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd>${html}</dd></div>`;
    // the one sentence that says why the books and holding differ
    let insight = '';
    if (benchPnl != null) {
      insight = `Simply holding what the books hold would be <b>${figure(benchPnl)}</b>${holdFee ? `, after its ${money(holdFee)} fee to buy in` : ''}; ` +
        `they are <b>${figure(vs)}</b> against that${benchFees ? `, after ${money(benchFees)} in fees` : ''}.`;
      // Holding pays one fee, to buy in (since 2026-09-26: before, it paid none, and every book started that
      // fee behind it). The books pay one on every trade. When they trail holding and have paid more, the
      // difference is part of why, and when it is more than the whole gap, the books did better than holding
      // before it. When they paid no more than holding, the fees are not why: the gap is how much they hold.
      const extra = r2(benchFees - holdFee), before = r2(vs + extra);
      if (vs < 0 && extra > 0) {
        insight += isZero(before) ? ` The ${money(extra)} they paid in fees beyond holding's is the whole gap.`
          : before > 0 ? ` Before the ${money(extra)} they paid in fees beyond holding's, they are <b class="pos">${money(before)}</b> ahead.`
            : extra >= -vs * 0.5 ? ` The ${money(extra)} they paid in fees beyond holding's is most of the gap.` : '';
      } else if (vs <= -1) {
        insight += ` ${isZero(extra) ? 'The fees are even' : 'Holding paid more in fees'}, so the gap is how much the books hold: their rule keeps some money in cash when prices swing hard.`;
      }
    }
    return `<span class="label">All paper books</span>` +
      `<div class="big ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="sub">on ${money(S.initial, 0)} of paper · marked ${esc(ET_HM.format(new Date(S.now)))} ET</div>` +
      `<dl class="kpis">${kpi('Today', S.today != null ? figure(S.today) : '—')}` +
      `${kpi('vs holding', vs != null ? figure(vs) : '—', 'The books against simply holding what they hold, bought at each book’s first trade with the same fee the book pays to buy')}` +
      `${kpi('Fees paid', money(fees))}${kpi('At work', `${money(atWork, 0)}<small>${money(cash, 0)} in cash</small>`)}</dl>` +
      (insight ? `<p class="insight">${insight}</p>` : '');
  }

  // ------------------------------------------------------------ the desk: market, prices, the options day, the limits
  // the options book's day, in one sentence a person reads
  const today = () => dayKey(nowT());
  // when the stock market next opens, in the desk's own words ("opens Mon 9:30 AM ET"): today, tomorrow or a weekday
  const nextOpenDay = () => { const m = String((S.market && S.market.says) || '').match(/^opens (\w+)/); return m ? m[1] : null; };
  function optionsLine() {
    const O = S.options || {}, d = O.day;
    if (!O.enabled) return 'switched off';
    const open = (bookOf('options') || { rows: [] }).rows.length;
    if (open) return `holding ${open} contract${open === 1 ? '' : 's'}`;
    // Friday's verdict is not Saturday's: a day that is over says when the next test is
    if (!d || d.date !== today()) {
      if (S.market && S.market.open) return 'waiting for today\'s 12:30 test';
      const n = nextOpenDay();
      return !n ? 'next 12:30 test on the next trading day' : `next 12:30 test ${n === 'today' || n === 'tomorrow' ? n : `on ${n}`}`;
    }
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
  // The options day used to have a row here too, word for word the Options card's last line.
  function deskHtml() {
    const mk = S.market || {}, C = S.cfg || {};
    const cryptoOk = !(mk.stale && mk.stale.crypto), spyOk = !(mk.stale && mk.stale.stocks);
    // Amber means look. A quarter of an hour late is how SPY's free feed always is, so its dot is the plain
    // one, and it turns amber only when TESS finds the feed has stopped. Out of hours nothing is late (it
    // said "15 min late" all weekend), and in the first minutes of a session the late tape has no trade
    // from today yet, so the delay is the feed's usual one rather than the hours since yesterday's close.
    const spy = !spyOk ? 'SPY stale' : !mk.open ? 'SPY closed' : mk.delayMin != null && mk.delayMin <= 30 ? `SPY ${mk.delayMin} min late` : 'SPY about 15 min late';
    const rows = [
      ['Stock market', `<b>${mk.open ? 'Open' : 'Closed'}</b> · ${esc(mk.says || '')}`],
      ['Prices', `<span class="dot${cryptoOk ? '' : ' warn'}"></span>Crypto ${cryptoOk ? 'live' : 'stale'} · <span class="dot ${spyOk ? 'late' : 'warn'}"></span>${esc(spy)}`],
    ];
    // how much of the day's loss limit is used: TESS stops all new buying when it is. The meter stays plain
    // until half of it is gone, is amber to 80% and red past that.
    if (C.maxDailyDdPct && S.today != null && S.equity) {
      const start = S.equity - S.today, down = start > 0 ? Math.max(0, -S.today / start) : 0, used = Math.min(1, down / C.maxDailyDdPct);
      const level = used >= 0.8 ? ' bad' : used >= 0.5 ? ' warn' : '';
      rows.push(['Loss limit', `${down ? `down ${(down * 100).toFixed(2)}%` : 'nothing lost'} today; buying stops at ${(C.maxDailyDdPct * 100).toFixed(0)}%` +
        `<span class="meter${level}" role="img" aria-label="${Math.round(used * 100)}% of the daily loss limit used"><i style="width:${(used * 100).toFixed(1)}%"></i></span>`]);
    }
    // the prediction-market desk, winding down in the same process
    const P = S.legacy;
    if (P) {
      const still = P.groups || P.contracts ? `${P.groups} arb${P.groups === 1 ? '' : 's'} and ${Number(P.contracts || 0).toLocaleString('en-US')} maker contracts open` : 'everything settled';
      // a no-break space keeps "Oct 3" on one line
      const next = P.nextSettle ? ` · next settles ${new Date(P.nextSettle).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }).replace(' ', '\u00a0')}` : '';
      rows.push(['Prediction mkts', `<a href="/pm">${figure(P.pnl)}</a> · ${esc(still + next)}`]);
    }
    const sha = S.build && S.build.sha ? String(S.build.sha).slice(0, 7) : 'dev';
    // Since when (it read "Running 19h 02m", which sounds like time since the last restart), and when the
    // last round finished, the heartbeat behind the Stalled light
    const since = new Date(S.startedAt), ago = S.beat ? Math.max(0, Math.round((S.now - S.beat) / 1000)) : null;
    const beat = ago == null ? '' : ` · last round ${ago < 120 ? `${ago}s ago` : `at ${ET_HM.format(new Date(S.beat))}`}`;
    return `<span class="label">The desk</span><dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
      `<p class="deskfoot">Running since ${esc(ET_DAY.format(since))}, ${esc(ET_HM.format(since))}${beat} · build ${esc(sha)}</p>`;
  }

  // ------------------------------------------------------------ a book: against holding, its line, what it holds, what next
  // Each book also shows the markets it trades: until 2026-09-26 a Markets board gave every coin's and SPY's
  // price, move and target once more beside the cards, and took a whole row of a laptop's screen to do it.
  // A desk starts all cash, level with its capital, and records its first minute just after its first buys,
  // with their fees paid: on the box, 21:35:20 on 25 September, five seconds in, at −$31.99. While a line's
  // first point is that minute (the history keeps about three weeks), the line begins at zero at the start,
  // where the desk did. Measured from that first minute, the chart read +$29.76 over a desk that was −$2.23.
  function beganAt(t, start) { return start > 0 && t > start && t - start < 10 * 6e4; }
  // The book's own P&L over its history (and simply holding, dashed), from /api/desk/history's per-book values.
  function sparkSvg(key) {
    const field = { crypto: 'c', stocks: 's', options: 'o' }[key], benchField = { crypto: 'bc', stocks: 'bs' }[key];
    const init = (hist.books || {})[key], b = bookOf(key);
    const series = init ? hist.points.filter((p) => p[field] != null).map((p) => [p.t, p[field] - init, benchField && p[benchField] != null ? p[benchField] - init : null]) : [];
    if (b) series.push([S.now, b.pnl, b.bench != null ? b.benchPnl : null]);
    if (b && beganAt(series[0][0], b.startedAt)) series.unshift([b.startedAt, 0, series[0][2] != null ? 0 : null]);
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
  const change = (c) => (c == null ? '' : `<span class="${tone(c, 4)}">${isZero(c, 4) ? '0.00%' : `${c > 0 ? '+' : MINUS}${Math.abs(c * 100).toFixed(2)}%`}</span>`);
  const SWINGS = 'How much it moves in a year, measured over the last 30 days (crypto) or 20 sessions (SPY)';
  const TARGET = 'How much of its slot the book wants to hold: less when it swings more';
  function holdRow(b, r) {
    if (b.key === 'options') {
      // the price its target sells at, not just "2x", and what it is bid now
      const mult = r.entry > 0 && r.target > 0 ? ` (${Math.round(r.target / r.entry)}x)` : '';
      return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><small>${esc(cap(r.label))} · sells at ${px(r.target)}${mult} · bid ${px(r.px)}</small></th>` +
        `<td class="v">${money(r.value || 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td></tr>`;
    }
    // the price and its move beside the name; under it, how much is held and what the rule wants. SPY's price
    // is its last trade (the book is valued at the bid, which after hours sat 65 cents above the close).
    const last = b.key === 'stocks' && S.spy && S.spy.last > 0 ? S.spy.last : r.px;
    const chg = last > 0 && r.prevClose > 0 ? last / r.prevClose - 1 : null;
    const want = Number.isFinite(r.want) ? r.want : r.target;
    const bits = [`<span>${r.qty > 0 ? `${qtyTxt(r.qty, b.key, r.sym)} held` : 'not held yet'}</span>`];
    if (Number.isFinite(r.vol)) bits.push(`<span title="${SWINGS}">swings ${pct(r.vol)}</span>`);
    if (Number.isFinite(want)) bits.push(`<span title="${TARGET}">target ${pct(want)}</span>`);
    const worth = r.qty > 0 ? `<td class="v">${money(r.value || 0, 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td>` : '<td class="v"></td><td></td>';
    return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><span class="mk">${px(last)}${chg == null ? '' : ` ${change(chg)}`}</span>` +
      `<small>${bits.join(' · ')}</small></th>${worth}</tr>`;
  }
  // the options book with nothing open: how today's test went, and where SPY is
  function optionsFacts() {
    const O = S.options || {}, d = O.day, sp = O.spy, rows = [], td = today();
    const on = (day) => (day && day !== td ? `${wd(day)} ` : '');
    if (d && d.test && Number.isFinite(d.test.moveAtr)) rows.push([`${on(d.date)}12:30 test`, `${d.test.dir || d.dir || ''} ${d.test.moveAtr.toFixed(2)} ATR from the open${Number.isFinite(d.test.retr) ? `, gave back ${Math.round(d.test.retr * 100)}%` : ''}`]);
    // the last five-minute bar, by the time it closed
    if (sp && Number.isFinite(sp.c)) rows.push([`SPY ${on(sp.day)}${Number.isFinite(sp.m) ? minTxt(sp.m + 5) : ''}`, `${sp.c.toFixed(2)} · VWAP ${sp.vwap != null ? sp.vwap.toFixed(2) : '—'} · ATR ${sp.atr != null ? sp.atr.toFixed(2) : '—'}`]);
    for (const t of (O.trades || []).slice(0, 3)) rows.push([t.date.slice(5).replace('-', '/'), `${t.qty} × ${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No contracts open.</p>';
  }
  function nextLine(b) {
    if (b.key === 'crypto') return `Checks again after midnight UTC: <b>${esc(ET_HM.format(new Date(Math.floor(S.now / 864e5 + 1) * 864e5)))} ET</b>`;
    if (b.key === 'stocks') {
      const checked = b.rows.some((r) => r.checkDay === today());
      return S.market && S.market.open ? (checked ? 'Checked today; checks again after the next open' : 'Checks once a trading day, after the open')
        : `Checks at the next open: <b>${esc(String((S.market && S.market.says) || '').replace(/^opens /, ''))}</b>`;
    }
    return esc(cap(optionsLine()));
  }
  // A book that has never traded is its figure, its markets and its next check: no line that has never
  // moved. On a phone every book is its figure until it is opened (the chip is the button), so the page
  // reaches what is happening sooner; which ones are open is remembered.
  let openBooks = new Set();
  try { const v = JSON.parse(localStorage.getItem('desk-books-open') || 'null'); if (Array.isArray(v)) openBooks = new Set(v); } catch { /* defaults */ }
  function bookCard(b) {
    const held = b.rows.filter((r) => r.qty > 0).length;
    const chip = b.key === 'options' ? (b.rows.length ? `${b.rows.length} open` : 'no position') : held ? `${held} held` : 'not holding yet';
    const traded = held || b.fees || !isZero(b.realized || 0) || (b.key === 'options' && ((S.options || {}).trades || []).length);
    const vs = b.bench != null ? `<span class="vs" title="Simply holding what this book trades, from its first trade${b.benchFee ? `, after its ${plain(money(b.benchFee))} fee to buy in` : ''}">` +
      `holding <b class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</b></span>` : '';
    // the two figures on each row are named once, over them, when the book holds something
    const head = b.key === 'options' || held ? '<thead><tr><th></th><th>Worth</th><th>P&amp;L</th></tr></thead>' : '';
    const body = b.rows.length ? `<table class="hold-t">${head}<tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>`
      : b.key === 'options' ? optionsFacts() : '<p class="bksub">Nothing held yet.</p>';
    const open = openBooks.has(b.key);
    return `<article class="card bk${open ? ' open' : ''}" data-k="${b.key}" style="--bk:${BOOK_COLOR[b.key]}" aria-label="${esc(b.name)} book">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(chip)}</span>` +
      `<button type="button" class="chip bktog" data-book="${b.key}" aria-expanded="${open}" aria-controls="bkmore-${b.key}">${esc(chip)}<i aria-hidden="true"></i></button></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<div class="bkmore" id="bkmore-${b.key}">` +
      `<div class="bksub">worth ${money(b.equity)} of ${money(b.initial, 0)}${b.fees ? ` · fees ${money(b.fees)}` : ''}${b.realized && !isZero(b.realized) ? ` · banked ${signed(b.realized)}` : ''}</div>` +
      (traded ? sparkSvg(b.key) : '') + body +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule)}</p></details></div>` +
      `<p class="next">${nextLine(b)}</p></article>`;
  }
  const renderBooks = () => morph($('books'), (S.books || []).map(bookCard).join(''));
  $('books').addEventListener('click', (ev) => {
    const t = ev.target.closest('.bktog');
    if (!t) return;
    if (openBooks.has(t.dataset.book)) openBooks.delete(t.dataset.book); else openBooks.add(t.dataset.book);
    try { localStorage.setItem('desk-books-open', JSON.stringify([...openBooks])); } catch { /* private window */ }
    if (S) renderBooks();
  });

  // ------------------------------------------------------------ what's happening: the desk's trades and the bots' log
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  // One row of the list: { t, who, text, sub, level, pnl, key }. Its level is the engine's word for the line
  // (src/desk/engine.js logLevel), the same one that decides which lines its ring keeps:
  //   trade  money moved          warn  needs a look
  //   info   a decision           quiet the desk doing its rounds
  // The desk writes its log in plain sentences already; the part before the first " · " is what happened,
  // the rest is the detail underneath.
  function logRow(e) {
    const parts = grouped(String(e.text || '')).split(' · ');
    return { t: e.t, who: e.agent, text: cap(parts[0]), sub: parts.slice(1).join(' · '), level: e.level || 'info', pnl: null, key: logKey(e), halt: e.kind === 'HALT' };
  }
  // A trade is a row from the ledger's own fills, not from the log. On 26 September the routine rounds had
  // pushed the log lines of the desk's three buys out of the frame in eight hours, and this list said
  // "Nothing of those kinds yet" beside a book holding all three coins; the frame's eighty fills do not
  // age out that way. A fill's log line says the same thing, so it is left out.
  function fillRow(f) {
    const opt = f.book === 'options', name = opt ? f.label : f.book === 'crypto' ? coin(f.sym) : f.sym;
    const why = String(f.why || ''), expired = /^expired/.test(why);
    const row = { t: f.at, who: expired ? 'RIGO' : 'KETT', level: 'trade', pnl: f.side === 'sell' ? f.pnl : null, key: `fill|${f.id}` };
    if (expired) return { ...row, text: `${name} expired worth ${px(f.px)}`, sub: '' };
    if (f.side === 'sell' && !(f.px > 0)) return { ...row, text: `${name} written off: no bid`, sub: cap(why.replace(/,? no bid$/, '')) };
    const qty = opt ? String(f.qty) : qtyTxt(f.qty, f.book, f.sym);
    return { ...row, text: `${f.side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${name} at ${px(f.px)}`,
      sub: [`${money(f.value)}${f.fee ? `, fee ${money(f.fee)}` : ''}`, why].filter(Boolean).join(' · ') };
  }
  // newest first; the same round said again by the same bot is shown once
  function activityRows() {
    const rows = [], last = {};
    for (const e of S.log || []) {
      if (e.kind === 'FILL' || e.kind === 'SETTLE') continue;
      const r = logRow(e), k = shape(r.text);
      if (last[e.agent] === k) continue;
      last[e.agent] = k;
      rows.push(r);
    }
    for (const f of S.fills || []) rows.push(fillRow(f));
    return rows.sort((a, b) => b.t - a.t);
  }
  // The routine rounds ("3/3 coins live", "all clear") come every few minutes and used to push the day's
  // few trades out of sight, so they are counted and hidden until asked for.
  const LEVELS = [['trade', 'Trades'], ['info', 'Signals'], ['warn', 'Warnings'], ['quiet', 'Routine']];
  let showing = new Set(['trade', 'info', 'warn']);
  try { const v = JSON.parse(localStorage.getItem('desk-activity') || 'null'); if (Array.isArray(v)) showing = new Set(v); } catch { /* defaults */ }
  // A phone shows the latest five of those, and the rest when asked: the list comes second there, under
  // the books, and eighty entries would bury the chart and the desk beneath it.
  const phone = matchMedia('(max-width: 640px)');
  let feedAll = false;
  function renderActivity(rows = activityRows()) {
    const count = {};
    for (const r of rows) count[r.level] = (count[r.level] || 0) + 1;
    morph($('chips'), LEVELS.map(([lv, name]) => `<button type="button" data-lv="${lv}" class="${showing.has(lv) ? 'on' : ''}" aria-pressed="${showing.has(lv)}">${name}<span>${count[lv] || 0}</span></button>`).join(''));
    const kept = rows.filter((r) => showing.has(r.level)).slice(0, 80);
    const shown = phone.matches && !feedAll ? kept.slice(0, 5) : kept;
    const td = today();
    let day = td;
    morph($('feedlist'), shown.map((r) => {
      // newest first: the day's name goes above the first entry from each earlier day
      const k = dayKey(r.t), head = k === day ? '' : `<li class="day" data-k="day|${k}">${esc(dayName(r.t, td))}</li>`;
      day = k;
      const amt = r.pnl != null ? `<span class="amt ${tone(r.pnl)}">${signed(r.pnl)}</span>` : '<span class="amt"></span>';
      return `${head}<li class="lv-${r.level}" data-k="${esc(r.key)}"><time datetime="${new Date(r.t).toISOString()}">${esc(ET_HM.format(new Date(r.t)))}</time><span class="who">${esc(r.who)}</span>` +
        `<span class="what">${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>${amt}</li>`;
    }).join('') + (phone.matches && kept.length > 5 ? `<li class="more" data-k="more"><button type="button" data-more="1">${feedAll ? 'Show the latest five' : `Show ${kept.length - 5} earlier`}</button></li>` : '')
      || `<li class="empty">${rows.length ? 'Nothing of those kinds yet.' : 'Waiting for the first desk round.'}</li>`);
  }
  $('feedlist').addEventListener('click', (ev) => {
    if (!ev.target.closest('button[data-more]')) return;
    feedAll = !feedAll;
    if (S) renderActivity();
  });
  phone.addEventListener('change', () => { if (S) renderActivity(); });
  $('chips').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-lv]');
    if (!b) return;
    if (showing.has(b.dataset.lv)) showing.delete(b.dataset.lv); else showing.add(b.dataset.lv);
    try { localStorage.setItem('desk-activity', JSON.stringify([...showing])); } catch { /* private window */ }
    if (S) renderActivity();
  });
  // a trade or a halt is read out once, by a screen reader, as it lands; nothing else is
  let announced = null;
  function announce(rows) {
    const r = rows.find((x) => x.level === 'trade' || x.halt);
    if (!r) return;
    if (announced !== null && r.key !== announced) $('announce').textContent = `${r.who}: ${r.text}`;
    announced = r.key;
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
  // The library lays its axis out in UTC: its day marks fell on UTC midnight, 8 PM here, and a "Sep 25" sat in
  // the middle of the 25th's evening while the real midnight went unmarked. Each point goes to it as Eastern
  // wall-clock time instead, so a day's mark lands on Eastern midnight, and its labels are read in UTC.
  // The offset is looked up once an hour of time: the clocks change on the hour.
  const ET_PARTS = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
  const offsets = new Map();
  function etOffset(sec) {
    const h = Math.floor(sec / 3600);
    if (!offsets.has(h)) {
      const p = {};
      for (const x of ET_PARTS.formatToParts(new Date(h * 3600e3))) p[x.type] = +x.value;
      offsets.set(h, (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - h * 3600e3) / 1000);
    }
    return offsets.get(h);
  }
  const W_HM = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', hour: 'numeric', minute: '2-digit', hour12: true });
  const W_DAY = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' });
  const W_FULL = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
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
    // from zero at the desk's start while the history reaches back to it (see beganAt)
    if (S && pts.length && beganAt(pts[0][0], S.startedAt)) pts.unshift([S.startedAt, 0, pts[0][2] != null ? 0 : null]);
    const span = RANGES.find(([r]) => r === chart.range)[1];
    const from = Number.isFinite(span) ? (S ? S.now : Date.now()) - span : -Infinity;
    return pts.filter((p) => p[0] >= from);
  }
  function chartSkeleton(big) {
    const seg = `<span class="seg">${RANGES.map(([r]) => `<button type="button" data-range="${r}" class="${chart.range === r ? 'on' : ''}">${r}</button>`).join('')}</span>`;
    // opened large, the dialog's header names the chart, so the chart leaves its own title out
    return (big ? '' : '<div class="ct"><span class="ctitle">Profit and loss · every book</span><button type="button" class="cx" data-expand="1" title="Open large" aria-label="Open the chart large">⤢</button></div>') +
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
      // the axis in Eastern time, like every other time on the page: the times it is given are Eastern
      // wall-clock seconds (etOffset), so it reads them back as UTC
      timeScale: { visible: true, borderVisible: false, timeVisible: true, secondsVisible: false, fixLeftEdge: true, fixRightEdge: true,
        tickMarkFormatter: (sec, type) => (type >= 3 ? W_HM : W_DAY).format(new Date(sec * 1000)) },
      localization: { timeFormatter: (sec) => W_FULL.format(new Date(sec * 1000)) },
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
    // The figure is what changed over the range shown. Over all of it that is the desk's total, the headline's
    // figure too; over 1h, 6h or 24h it is the move in that window, which nothing else on the page gives.
    morph(el.querySelector('.cv'), figure(pts.length > 1 ? r2(last - first) : 0));
    const from = pts.length ? pts[0][0] : 0;
    el.querySelector('.cd').textContent = pts.length < 2 ? '' : chart.range !== 'All' ? `over the last ${chart.range}`
      : `since ${dayKey(from) === dayKey(nowT()) ? `${ET_HM.format(new Date(from))} today` : ET_DAY.format(new Date(from))}`;
    // holding over the same stretch, so the two figures compare: it gave holding's whole total beside the
    // desk's move over the last hour
    const firstHold = pts.find((x) => x[2] != null), lastHold = [...pts].reverse().find((x) => x[2] != null);
    const held = lastHold ? r2(lastHold[2] - firstHold[2]) : null;
    morph(el.querySelector('.cr'), held != null ? `<span title="The dashed line: every book simply holding what it trades, over the same stretch"><i class="dash" aria-hidden="true"></i>holding: <b class="${tone(held)}">${signed(held)}</b></span>` : '');
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
    // The library spaces its points evenly, whatever the time between them, so the hours the desk was down
    // (it restarts on every deploy) took one step, and a move across them looked sudden. The line breaks
    // there instead. A gap is more than ten minutes, and more than three of the history's usual steps (it
    // thins to 1,500 points, so a long history steps a few minutes at a time). The library draws straight
    // through a point with no value, but a point's colour is the colour of the segment leaving it, so the
    // last point before a gap is drawn clear.
    const steps = rows.slice(1).map(([t], i) => t - rows[i][0]).sort((a, b) => a - b);
    const gap = Math.max(600, 3 * (steps.length ? steps[steps.length >> 1] : 0));
    const clear = withAlpha(TOK['ink-3'], 0);
    const deskClear = { topLineColor: clear, bottomLineColor: clear, topFillColor1: clear, topFillColor2: clear, bottomFillColor1: clear, bottomFillColor2: clear };
    const desk = [], hold = [];
    let prev = -Infinity;
    rows.forEach(([t, [v, hv]], i) => {
      const breaks = i + 1 < rows.length && rows[i + 1][0] - t > gap;
      // Eastern wall-clock time; the hour the clocks go back comes round twice, and time may not run backwards
      const time = prev = Math.max(prev + 1, t + etOffset(t));
      desk.push(breaks ? { time, value: v, ...deskClear } : { time, value: v });
      if (hv != null) hold.push(breaks ? { time, value: hv, color: clear } : { time, value: hv });
    });
    p.plot.desk.setData(desk);
    p.plot.hold.setData(hold);
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
    renderBooks();
    const rows = activityRows();
    renderActivity(rows);
    announce(rows);
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

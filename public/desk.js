/* The Hexagon — the stocks, crypto and options desk's floor at /. Consumes /api/desk/stream.
 *
 * One screen with nothing to scroll (2026-10-02, Evan: "It should all be able to fit on one page, not having
 * to scroll down or up"): each desk's figure with every one of its books as a tile (its P&L, what it holds,
 * what it is doing now), the P&L chart, and the latest trades and warnings of both desks. What is behind a
 * tile opens over the page in a sheet: a book's card (#book/crypto, #book/pm-arbs), a desk's numbers (#desk,
 * #pm), or every line of the activity (#activity), each line tagged with the book it is about. The sheets are
 * links, so the back button closes one. Until that morning the floor was four views behind tabs, and before
 * that one wall of boards 2,800px long. Until 2026-09-25 the boards were painted into a pixel room with the
 * bots at their desks; the bots are still the desk's workers, and an activity line's tag names the one that
 * wrote it when pointed at.
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
  // a coin to the decimals its price needs: a thousandth of a bitcoin is $80, of a SOL twelve cents; DOGE
  // is sold in tenths
  const COIN_DP = { 'BTC-USD': 6, 'ETH-USD': 4, 'SOL-USD': 2, 'XRP-USD': 2, 'DOGE-USD': 1 };
  // a coin's price to the decimals it is quoted in: cents from $10, four places under that (XRP $1.4921),
  // five under a dime (DOGE $0.09447); at cents a cheap coin's move is lost
  const coinPx = (p) => (Number.isFinite(p) && p > 0 && p < 10 ? (p < 0.01 ? `$${p.toPrecision(4)}` : `$${p.toFixed(p < 0.1 ? 5 : 4)}`) : px(p));
  // a runner's size: whole coins when there are thousands, two places from one coin, six under one
  const runQty = (q) => (+q).toLocaleString('en-US', { maximumFractionDigits: q >= 1000 ? 0 : q >= 1 ? 2 : 6 });
  const qtyTxt = (q, book, sym) => (book === 'crypto'
    ? (+q).toLocaleString('en-US', { minimumFractionDigits: COIN_DP[sym] ?? 6, maximumFractionDigits: COIN_DP[sym] ?? 6 })
    : book === 'stocks' ? `${+(+q).toFixed(3)}` : String(q));
  const bookOf = (k) => (S && S.books || []).find((b) => b.key === k) || null;
  const BOOK_COLOR = { crypto: 'var(--book-crypto)', stocks: 'var(--book-stocks)', options: 'var(--book-options)', scalps: 'var(--book-scalps)', dips: 'var(--book-dips)', runners: 'var(--book-runners)' };
  // the books that hold option contracts: their rows are contracts, and they are never "held" against a market
  const optBook = (k) => k === 'options' || k === 'scalps' || k === 'dips';
  // the books whose rows are positions opened and closed, not a market held: the option books and the runners
  const lotBook = (k) => optBook(k) || k === 'runners';
  // tokens.css, read for the one thing that cannot take a var(): the chart library. Each colour there is
  // light-dark(), which only an element can resolve, so a hidden one is given the token and its colour read
  // back; and it is read again when the iPhone or the Mac changes between light and dark (see the chart).
  const probe = document.body.appendChild(document.createElement('i'));
  probe.hidden = true;
  const color = (k) => { probe.style.color = `var(--${k})`; return getComputedStyle(probe).color; };
  const readTokens = () => {
    const t = { font: getComputedStyle(document.documentElement).getPropertyValue('--sans').trim() };
    for (const k of ['ink-1', 'ink-2', 'ink-3', 'gain-line', 'loss-line', 'rule-1']) t[k] = color(k);
    return t;
  };
  let TOK = readTokens();
  // "rgb(52, 199, 89)" at another alpha
  const withAlpha = (c, a) => { const [r, g, b] = String(c).match(/[\d.]+/g).map(Number); return `rgba(${r}, ${g}, ${b}, ${a})`; };

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
    morph($('mkt'), marketHtml());
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
  // what the headline and the overview's tile both say: the books against simply holding, the fees, the cash
  function deskTotals() {
    const books = S.books || [];
    const bench = books.filter((b) => b.bench != null);
    const benchPnl = bench.length ? r2(bench.reduce((a, b) => a + b.benchPnl, 0)) : null;
    const vs = bench.length ? r2(bench.reduce((a, b) => a + b.pnl, 0) - benchPnl) : null;
    const fees = r2(books.reduce((a, b) => a + (b.fees || 0), 0));
    const benchFees = r2(bench.reduce((a, b) => a + (b.fees || 0), 0));   // the fees inside that comparison
    const holdFee = r2(bench.reduce((a, b) => a + (b.benchFee || 0), 0));  // what holding paid to buy in
    const atWork = r2(books.reduce((a, b) => a + b.rows.reduce((x, r) => x + (r.value || 0), 0), 0));
    return { benchPnl, vs, fees, benchFees, holdFee, atWork, cash: r2((S.equity || 0) - atWork) };
  }
  const VS_HOLD = 'The books against simply holding what they hold, bought at each book’s first trade with the same fee the book pays to buy';
  function heroHtml() {
    const { benchPnl, vs, fees, benchFees, holdFee, atWork, cash } = deskTotals();
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
    // the six books' headline; the prediction-market desk's has its own board below (renderPm)
    return `<span class="label">Stocks, crypto and options</span>` +
      `<div class="big ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="sub">on ${money(S.initial, 0)} of paper · marked ${esc(ET_HM.format(new Date(S.now)))} ET</div>` +
      `<dl class="kpis">${kpi('Today', S.today != null ? figure(S.today) : '—')}` +
      `${kpi('vs. just holding', vs != null ? figure(vs) : '—', VS_HOLD)}` +
      `${kpi('Fees paid', money(fees))}${kpi('Invested', `${money(atWork, 0)}<small>${money(cash, 0)} in cash</small>`)}</dl>` +
      (insight ? `<p class="insight">${insight}</p>` : '');
  }

  // ------------------------------------------------------------ the page: each desk, and every book as a tile
  // The question a glance asks of the floor is how each desk is doing and what each book is up to, and the answer
  // fits one screen: each desk is a tile, its figure over its books, each book a tile of its own (its P&L, what
  // it holds, what it is doing now) and a link to its card, which opens over the page.
  const plainText = (html) => String(html).replace(/<[^>]+>/g, '').replace(/&amp;/g, '&');
  // a prediction-market book's comparison beside its figure, without the card's own wrapper and its tooltip
  const plainVs = (html) => String(html).replace(/^<span class="vs"[^>]*>|<\/span>$/g, '');
  function bookTile(x) {
    return `<li data-k="${esc(x.k)}"><a href="${x.href}" style="--bk:${x.color}" title="${esc(plainText(`${x.name}: ${x.now}`))}">` +
      `<span class="bth"><i class="sw"></i><span class="btn">${esc(x.name)}</span><span class="btc">${esc(x.chip)}</span></span>` +
      `<span class="btf"><span class="${tone(x.pnl)}">${signed(x.pnl)}</span>${x.vs ? `<span class="btv">${x.vs}</span>` : ''}</span>` +
      `<span class="bts">${x.now}</span></a></li>`;
  }
  // the six books in their two groups, each group's name over its row
  const GROUPS = [
    ['Crypto and SPY', 'Held across days, sized to how hard each one swings. Runners buy a coin that is popping and ride it until it turns.', ['crypto', 'stocks', 'runners']],
    ['SPY same-day options', 'Calls and puts bought and sold within the session, at Cboe’s prices about 15 minutes late.', ['options', 'scalps', 'dips']],
  ];
  function deskTiles() {
    const known = new Set(GROUPS.flatMap((g) => g[2]));
    const groups = GROUPS.map(([title, text, keys], i) => [title, text, [...keys.map(bookOf).filter(Boolean), ...(i ? [] : (S.books || []).filter((b) => !known.has(b.key)))]]);
    return groups.filter((g) => g[2].length).map(([title, text, bs], i) => `<li class="grp" data-k="g${i}" title="${esc(text)}">${esc(title)}</li>` +
      bs.map((b) => bookTile({ k: b.key, href: `#book/${b.key}`, color: BOOK_COLOR[b.key], name: b.name, chip: bookChip(b), pnl: b.pnl,
        vs: b.bench != null ? `just holding ${figure(b.benchPnl)}` : '', now: nextLine(b) })).join('')).join('');
  }
  function ovDeskHtml() {
    const { vs, atWork } = deskTotals();
    const mini = (S.today != null ? `<div><dt>Today</dt><dd>${figure(S.today)}</dd></div>` : '') +
      (vs != null ? `<div title="${esc(VS_HOLD)}"><dt>vs. just holding</dt><dd>${figure(vs)}</dd></div>` : '') +
      `<div><dt>Invested</dt><dd>${money(atWork, 0)}</dd></div>`;
    return `<a class="tilehead" href="#desk"><h2 class="label">Stocks, crypto and options</h2><span class="more">Details</span></a>` +
      `<div class="tilefig"><span class="big ${tone(S.pnl)}">${signed(S.pnl)}</span><span class="of">on ${money(S.initial, 0)} of paper</span><dl class="mini">${mini}</dl></div>` +
      `<p class="tilemkt">${marketHtml()}</p>` +
      `<ul class="tiles">${deskTiles()}</ul>`;
  }
  function renderOvPm() {
    const L = S.legacy, el = $('ovpm');
    el.hidden = !L;
    if (!L) return;
    const [state, cls] = pmState(L);
    morph(el, `<a class="tilehead" href="#pm"><h2 class="label">Prediction markets</h2><span class="pill ${cls}"><i></i>${esc(state)}<span class="mode">Paper</span></span><span class="more">Details</span></a>` +
      `<div class="tilefig"><span class="big ${tone(L.pnl)}">${signed(L.pnl)}</span><span class="of">on ${money(L.initial, 0)} of its own paper · Polymarket and Kalshi${L.halt ? ` · ${esc(L.halt)}` : ''}</span></div>` +
      `<ul class="tiles pmtiles">${PM_ORDER.map((k) => (L.books || []).find((b) => b.key === k)).filter(Boolean).map((b) => {
        const x = pmBits(b);
        return bookTile({ k: `pm-${b.key}`, href: `#book/pm-${b.key}`, color: 'var(--ink-3)', name: b.name, chip: x.chip, pnl: b.pnl, vs: plainVs(x.vs), now: x.next });
      }).join('')}</ul>`);
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
  // the scalp book's day, in one sentence
  function scalpsLine() {
    const X = S.scalps || {}, d = X.day;
    if (!X.enabled) return 'switched off';
    const lot = (bookOf('scalps') || { rows: [] }).rows[0];
    if (lot) return `holding the ${lot.name.replace(/^SPY \S+ /, '')}: out at ${px(lot.target)}, on SPY back ${lot.dir === 'up' ? 'under' : 'over'} ${Number(lot.level).toFixed(2)}, or by ${minTxt(lot.until)}`;
    if (!d || d.date !== today()) {
      if (S.market && S.market.open) return 'watching from 10:05 for a break of the last 30 minutes';
      const n = nextOpenDay();
      return !n ? 'watching from 10:05 on the next trading day' : `watching from 10:05 ${n === 'today' || n === 'tomorrow' ? n : `on ${n}`}`;
    }
    const n = `${d.entries} of ${d.max || 4} trade${(d.max || 4) === 1 ? '' : 's'} today`;
    switch (d.status) {
      case 'waiting': return 'watching from 10:05 for a break of the last 30 minutes';
      case 'watching': {
        const mNow = X.range && X.range.day === d.date ? X.range.m + 5 : null;
        if (d.pauseUntil != null && (mNow == null || mNow < d.pauseUntil)) return `after a loss, pausing until ${minTxt(d.pauseUntil)} · ${n}`;
        return `watching for a close beyond the last 30 minutes${X.range ? ` (${X.range.lo.toFixed(2)} to ${X.range.hi.toFixed(2)})` : ''} · ${n}`;
      }
      case 'done': return `done for today: ${d.why || `${d.entries} trade${d.entries === 1 ? '' : 's'}`}`;
      case 'early-close': return 'no scalps on a 1 PM close';
      default: return d.status;
    }
  }
  // the dip book's day, in one sentence
  function dipsLine() {
    const P = S.dips || {}, d = P.day;
    if (!P.enabled) return 'switched off';
    const rows = (bookOf('dips') || { rows: [] }).rows;
    if (rows.length) {
      const r = rows[0];
      return rows.some((x) => x.role === 'first')
        ? `holding ${rows.length} call${rows.length === 1 ? '' : 's'}: one sells when SPY closes back above VWAP; all out under ${Number(r.stop).toFixed(2)}, or with no reclaim by 12:30 PM`
        : `riding the runner: out if SPY closes under ${Number(r.spy).toFixed(2)}, if it gives back half its gain once doubled, or at 3:15 PM`;
    }
    if (!d || d.date !== today()) {
      if (S.market && S.market.open) return 'watching from 10:05 for a morning dip under VWAP';
      const n = nextOpenDay();
      return !n ? 'watching from 10:05 on the next trading day' : `watching from 10:05 ${n === 'today' || n === 'tomorrow' ? n : `on ${n}`}`;
    }
    const sp = P.spy;
    switch (d.status) {
      case 'waiting': return 'watching from 10:05 for a morning dip under VWAP';
      case 'watching': return sp && sp.need != null
        ? (sp.low <= sp.need ? `SPY has dipped to ${sp.low.toFixed(2)}: buying the first turn up under VWAP, until noon` : `waiting for SPY under ${sp.need.toFixed(2)} (low so far ${sp.low.toFixed(2)}), until noon`)
        : 'watching for a morning dip under VWAP, until noon';
      case 'done': return `done for today: ${d.why || `${d.entries} trade${d.entries === 1 ? '' : 's'}`}`;
      case 'early-close': return 'no dip trades on a 1 PM close';
      default: return d.status;
    }
  }
  // The options day used to have a row here too, word for word the Options card's last line.
  // the market and how fresh its prices are: the desk card's first two rows and the overview tile's last line
  function marketBits() {
    const mk = S.market || {};
    const cryptoOk = !(mk.stale && mk.stale.crypto), spyOk = !(mk.stale && mk.stale.stocks);
    // Amber means look. A quarter of an hour late is how SPY's free feed always is, so its dot is the plain
    // one, and it turns amber only when TESS finds the feed has stopped. Out of hours nothing is late (it
    // said "15 min late" all weekend), and in the first minutes of a session the late tape has no trade
    // from today yet, so the delay is the feed's usual one rather than the hours since yesterday's close.
    const spy = !spyOk ? 'SPY stale' : !mk.open ? 'SPY closed' : mk.delayMin != null && mk.delayMin <= 30 ? `SPY ${mk.delayMin} min late` : 'SPY about 15 min late';
    return { open: !!mk.open, says: mk.says || '', cryptoOk, spyOk, spy };
  }
  // the bar's line (and, on a phone, the desk tile's): the market's hours, then how fresh each price is
  function marketHtml() {
    const M = marketBits();
    return `<span><i class="dot${M.open ? '' : ' late'}"></i>Market ${esc(M.says || (M.open ? 'open' : 'closed'))}</span>` +
      `<span><i class="dot${M.cryptoOk ? '' : ' warn'}"></i>Crypto ${M.cryptoOk ? 'live' : 'stale'}</span>` +
      `<span><i class="dot ${M.spyOk ? 'late' : 'warn'}"></i>${esc(M.spy)}</span>`;
  }
  function deskHtml() {
    const C = S.cfg || {}, M = marketBits();
    const rows = [
      ['Stock market', `<b>${M.open ? 'Open' : 'Closed'}</b> · ${esc(M.says)}`],
      ['Prices', `<span class="dot${M.cryptoOk ? '' : ' warn'}"></span>Crypto ${M.cryptoOk ? 'live' : 'stale'} · <span class="dot ${M.spyOk ? 'late' : 'warn'}"></span>${esc(M.spy)}`],
    ];
    // how much of the day's loss limit is used: TESS stops all new buying when it is. The meter stays plain
    // until half of it is gone, is amber to 80% and red past that.
    if (C.maxDailyDdPct && S.today != null && S.equity) {
      const start = S.equity - S.today, down = start > 0 ? Math.max(0, -S.today / start) : 0, used = Math.min(1, down / C.maxDailyDdPct);
      const level = used >= 0.8 ? ' bad' : used >= 0.5 ? ' warn' : '';
      rows.push(['Loss limit', `${down ? `down ${(down * 100).toFixed(2)}%` : 'nothing lost'} today; buying stops at ${(C.maxDailyDdPct * 100).toFixed(0)}%` +
        `<span class="meter${level}" role="img" aria-label="${Math.round(used * 100)}% of the daily loss limit used"><i style="width:${(used * 100).toFixed(1)}%"></i></span>`]);
    }
    // The prediction-market desk had a row here until 2026-09-29, its figure and what it held; it has its
    // own board on this page now, with its books (renderPm).
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
    const field = { crypto: 'c', stocks: 's', options: 'o', scalps: 'x', dips: 'dp', runners: 'rn' }[key], benchField = { crypto: 'bc', stocks: 'bs' }[key];
    const init = (hist.books || {})[key], b = bookOf(key);
    let series = init ? hist.points.filter((p) => p[field] != null).map((p) => [p.t, p[field] - init, benchField && p[benchField] != null ? p[benchField] - init : null]) : [];
    // a line 36px tall needs a few hundred points, and the history sends up to three thousand
    const every = Math.ceil(series.length / 400);
    if (every > 1) series = series.filter((_, i) => i % every === 0 || i === series.length - 1);
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
    // a wash of the book's colour under its line, to the foot of the box, the way Stocks draws one
    const area = `${path(1)}L${X(t1)},100L${X(t0)},100Z`;
    return box(`<path class="area" d="${area}"/><line x1="0" x2="1000" y1="${Y(0)}" y2="${Y(0)}"/>${benchField ? `<path class="hold" d="${path(2)}"/>` : ''}<path class="line" d="${path(1)}"/>`);
  }
  const change = (c) => (c == null ? '' : `<span class="${tone(c, 4)}">${isZero(c, 4) ? '0.00%' : `${c > 0 ? '+' : MINUS}${Math.abs(c * 100).toFixed(2)}%`}</span>`);
  const SWINGS = 'How much it moves in a year, measured over the last 30 days (crypto) or 20 sessions (SPY)';
  const TARGET = 'How much of its slot the book wants to hold: less when it swings more';
  function holdRow(b, r) {
    if (b.key === 'runners') {
      return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><span class="mk">${coinPx(r.px)}</span>` +
        `<small>${esc(`${runQty(r.qty)} held · bought at ${plain(coinPx(r.entry))} · out under ${plain(coinPx(r.stop))}`)}</small></th>` +
        `<td class="v">${money(r.value || 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td></tr>`;
    }
    if (b.key === 'dips') {
      // no price target: the first sells on SPY's reclaim of VWAP, the runner on a trail
      const plan = r.role === 'runner' ? (r.reclaimed ? `riding · best bid ${px(r.peak)}` : 'rides after the reclaim') : 'sells on the VWAP reclaim';
      return `<tr data-k="${esc(r.sym)}-${esc(r.role)}"><th><span class="tk">${esc(r.name)}</span><small>${esc(cap(r.label))} · ${esc(plan)} · bid ${px(r.px)}</small></th>` +
        `<td class="v">${money(r.value || 0)}</td><td>${Number.isFinite(r.pnl) ? figure(r.pnl) : '—'}</td></tr>`;
    }
    if (optBook(b.key)) {
      // the price its target sells at, not just "2x", and what it is bid now
      const mult = r.entry > 0 && r.target > 0 ? ` (${+(r.target / r.entry).toFixed(1)}x)` : '';
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
    return `<tr data-k="${esc(r.sym)}"><th><span class="tk">${esc(r.name)}</span><span class="mk">${b.key === 'crypto' ? coinPx(last) : px(last)}${chg == null ? '' : ` ${change(chg)}`}</span>` +
      `<small>${bits.join(' · ')}</small></th>${worth}</tr>`;
  }
  // the options book with nothing open: how today's test went, and where SPY is
  function optionsFacts() {
    const O = S.options || {}, d = O.day, sp = O.spy, rows = [], td = today();
    const on = (day) => (day && day !== td ? `${wd(day)} ` : '');
    if (d && d.test && Number.isFinite(d.test.moveAtr)) rows.push([`${on(d.date)}12:30 test`, `${d.test.dir || d.dir || ''} ${d.test.moveAtr.toFixed(2)} ATR from the open${Number.isFinite(d.test.retr) ? `, gave back ${Math.round(d.test.retr * 100)}%` : ''}`]);
    // the last one-minute bar, by the time it closed (the minute it is labelled by)
    if (sp && Number.isFinite(sp.c)) rows.push([`SPY ${on(sp.day)}${Number.isFinite(sp.m) ? minTxt(sp.m) : ''}`, `${sp.c.toFixed(2)} · VWAP ${sp.vwap != null ? sp.vwap.toFixed(2) : '—'} · ATR ${sp.atr != null ? sp.atr.toFixed(2) : '—'}`]);
    for (const t of (O.trades || []).slice(0, 3)) rows.push([t.date.slice(5).replace('-', '/'), `${t.qty} × ${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No contracts open.</p>';
  }
  // the scalp book with nothing open: today's trades, the range the next bar has to break, the last few
  function scalpFacts() {
    const X = S.scalps || {}, d = X.day, rg = X.range, rows = [], td = today();
    const on = (day) => (day && day !== td ? `${wd(day)} ` : '');
    const done = (X.trades || []).filter((t) => t.date === (d && d.date) && !t.open);
    if (d && d.entries) rows.push([d.date === td ? 'Today' : wd(d.date), `${d.entries} trade${d.entries === 1 ? '' : 's'}, ${done.filter((t) => t.pnl > 0).length} made money · ${plain(signed(r2(done.reduce((a, t) => a + t.pnl, 0))))}`]);
    if (rg) rows.push([`SPY ${on(rg.day)}30 min to ${minTxt(rg.m + 5)}`, `${rg.lo.toFixed(2)} to ${rg.hi.toFixed(2)}`]);
    for (const t of (X.trades || []).slice(0, 3)) rows.push([t.date.slice(5).replace('-', '/'), `${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No contract open.</p>';
  }
  // the dip book with nothing open: today's trades, SPY against the dip it needs, the last few
  function dipFacts() {
    const P = S.dips || {}, d = P.day, sp = P.spy, rows = [], td = today();
    const on = (day) => (day && day !== td ? `${wd(day)} ` : '');
    const done = (P.trades || []).filter((t) => t.date === (d && d.date) && !t.open);
    if (d && d.entries) rows.push([d.date === td ? 'Today' : wd(d.date), `${d.entries} trade${d.entries === 1 ? '' : 's'} · ${plain(signed(r2(done.reduce((a, t) => a + t.pnl, 0))))}`]);
    if (sp) rows.push([`SPY ${on(sp.day)}${minTxt(sp.m)}`, `${sp.c.toFixed(2)} · open ${sp.open.toFixed(2)} · low ${sp.low.toFixed(2)}${sp.need != null ? ` · needs ${sp.need.toFixed(2)}` : ''}`]);
    for (const t of (P.trades || []).slice(0, 3)) rows.push([t.date.slice(5).replace('-', '/'), `${t.qty} × ${t.strike}${t.right} at ${px(t.entry)}${t.open ? ' · open' : ` · ${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))}`}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No calls open.</p>';
  }
  // the runner book: the coins moving most at the last scan and what it made of each, then its last trades
  function runnerFacts() {
    const N = S.runners || {}, rows = [];
    for (const r of (N.top || []).slice(0, 4)) rows.push([coin(r.id), `${r.move > 0 ? '+' : r.move < 0 ? MINUS : ''}${Math.abs(r.move * 100).toFixed(1)}% in 24h · ${r.status}`]);
    for (const t of (N.trades || []).filter((x) => !x.open).slice(0, 3)) rows.push([`${wd(dayKey(t.closedAt))} ${coin(t.sym)}`, `${t.pnl >= 0 ? 'made' : 'lost'} ${money(Math.abs(t.pnl))} · ${t.why || 'sold'}`]);
    return rows.length ? `<dl class="bkfacts">${rows.map(([k, v]) => `<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>` : '<p class="bksub">No coin held.</p>';
  }
  function nextLine(b) {
    if (b.key === 'runners') {
      const N = S.runners || {};
      if (!N.enabled) return 'Switched off';
      const every = Math.round((N.every || 180) / 60);
      return N.scanAt ? `Scans every ${every} minutes: last at <b>${esc(ET_HM.format(new Date(N.scanAt)))} ET</b>, ${N.n} coins` : `Scans every ${every} minutes: the first scan is on its way`;
    }
    if (b.key === 'crypto') return `Checks again after midnight UTC: <b>${esc(ET_HM.format(new Date(Math.floor(S.now / 864e5 + 1) * 864e5)))} ET</b>`;
    if (b.key === 'stocks') {
      const checked = b.rows.some((r) => r.checkDay === today());
      return S.market && S.market.open ? (checked ? 'Checked today; checks again after the next open' : 'Checks once a trading day, after the open')
        : `Checks at the next open: <b>${esc(String((S.market && S.market.says) || '').replace(/^opens /, ''))}</b>`;
    }
    return esc(cap(b.key === 'scalps' ? scalpsLine() : b.key === 'dips' ? dipsLine() : optionsLine()));
  }
  // A book that has never traded is its figure, its markets and its next check: no line that has never
  // moved. What it is doing now sits under its figure, in the book's colour: until 2026-10-02 it was the
  // card's last line, under the tables and the rule. A card opens in the sheet, from its tile, and is always whole.
  const bookChip = (b) => {
    const held = b.rows.filter((r) => r.qty > 0).length;
    return lotBook(b.key) ? (b.rows.length ? `${b.rows.length} open` : 'no position') : held ? `${held} held` : 'not holding yet';
  };
  function bookCard(b) {
    const held = b.rows.filter((r) => r.qty > 0).length;
    const traded = held || b.fees || !isZero(b.realized || 0) || (lotBook(b.key) && ((S[b.key] || {}).trades || []).length);
    const vs = b.bench != null ? `<span class="vs" title="Simply holding what this book trades, from its first trade${b.benchFee ? `, after its ${plain(money(b.benchFee))} fee to buy in` : ''}">` +
      `just holding <b class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</b></span>` : '';
    // the two figures on each row are named once, over them, when the book holds something
    const head = lotBook(b.key) || held ? '<thead><tr><th></th><th>Worth</th><th>P&amp;L</th></tr></thead>' : '';
    const body = b.key === 'runners' ? (b.rows.length ? `<table class="hold-t">${head}<tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>` : '') + runnerFacts()
      : b.rows.length ? `<table class="hold-t">${head}<tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>`
      : b.key === 'options' ? optionsFacts() : b.key === 'scalps' ? scalpFacts() : b.key === 'dips' ? dipFacts() : '<p class="bksub">Nothing held yet.</p>';
    return `<article class="card bk" data-k="${b.key}" style="--bk:${BOOK_COLOR[b.key]}" aria-label="${esc(b.name)} book">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(bookChip(b))}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<p class="now">${nextLine(b)}</p>` +
      `<div class="bksub">worth ${money(b.equity)} of ${money(b.initial, 0)}${b.fees ? ` · fees ${money(b.fees)}` : ''}${b.realized && !isZero(b.realized) ? ` · banked ${signed(b.realized)}` : ''}</div>` +
      (traded ? sparkSvg(b.key) : '') + body +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule)}</p></details></article>`;
  }

  // ------------------------------------------------------------ the prediction-market desk: its board and five books
  // The desk Hexagon began as, pricing the same outcomes on Polymarket and Kalshi, trades in paper in the
  // same process. Until 2026-09-29 it was a line on the desk board and a link to its own page at /pm; now
  // its books are cards like the six above (src/pmfloor.js builds what the frame carries as `legacy`),
  // with a contract's price in cents, the way those markets quote it. Its money is its own paper, apart
  // from the six books' headline.
  const cents = (p) => (!Number.isFinite(p) ? '—' : Math.abs(p) >= 0.9995 ? `$${(+p).toFixed(2)}` : `${+(p * 100).toFixed(1)}¢`);
  const nOf = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;
  const ET_DAY_Y = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
  const yearOf = (t) => ET_YMD.format(new Date(t)).slice(-4);
  // a no-break space keeps "Oct 3" on one line; a date in another year says the year
  const settleDay = (t) => (yearOf(t) === yearOf(nowT()) ? ET_DAY : ET_DAY_Y).format(new Date(t)).replace(' ', ' ');
  const whenTxt = (t) => `${dayKey(t) === today() ? '' : `${dayName(t, today())} `}${ET_HM.format(new Date(t))}`;
  const BOOK_NAME = { arb: 'arb', snipe: 'snipe', converge: 'convergence', maker: 'maker', bet: 'every game' };
  // Its loop's own heartbeat, like the desk's (stalled): two minutes, or twelve of its rounds
  function pmState(L) {
    const stuck = L.beat && L.now - L.beat.taker > Math.max(120000, 12 * ((L.every && L.every.taker) || 15) * 1000);
    return stuck ? ['Stalled', 'bad'] : L.halt ? ['Not buying', 'warn'] : L.trading ? ['Working', 'good'] : ['Winding down', 'warn'];
  }
  // a book's rows: the first few, and the rest when asked for (remembered until the page is reloaded)
  const allRows = new Set();
  function rowsTable(k, head, rows, row, first = 5) {
    if (!rows.length) return '';
    const all = allRows.has(k) || rows.length <= first + 1, shown = all ? rows : rows.slice(0, first);
    return `<table class="hold-t">${head}<tbody>${shown.map(row).join('')}</tbody></table>` +
      (rows.length > first + 1 ? `<button type="button" class="rowsmore" data-all="${k}" aria-expanded="${all}">${all ? `Show the first ${first}` : `Show ${rows.length - first} more`}</button>` : '');
  }
  const HEAD = (a, b, lead = '') => `<thead><tr><th class="lead">${lead}</th><th>${a}</th><th>${b}</th></tr></thead>`;
  // a taker position the snipe or convergence book holds: one leg on one venue
  const legRow = (r) => `<tr data-k="${esc(r.id)}"><th><span class="nm">${esc(r.label)}</span><small>${esc(`${cap(r.side)} on ${r.venue} · ${nOf(r.qty, 'contract')} at ${cents(r.entry)}, ${cents(r.mark)} now`)}</small></th>` +
    `<td class="v">${money(r.worth)}</td><td>${figure(r.pnl)}</td></tr>`;
  // the overview's line and a book's card say the same things: its chip and what it does next (the card has
  // its figure's comparison, its rows and its rule as well)
  const PM_ORDER = ['arbs', 'maker', 'bets', 'snipe', 'converge'];
  function pmBits(b) {
    const k = `pm-${b.key}`, L = S.legacy;
    let chip = '', vs = '', sub = '', body = '', next = '';
    if (b.key === 'arbs') {
      chip = b.on ? `${b.rows.length} of ${b.max} open` : b.rows.length ? `${b.rows.length} open · off` : 'switched off';
      vs = `<span class="vs" title="What the open arbs pay when their markets settle, with what the closed ones banked">at settlement <b class="${tone(b.atSettle)}">${signed(b.atSettle)}</b></span>`;
      sub = `paid ${money(b.cost)}, worth ${money(b.worth)} if sold now${b.closed ? ` · banked ${signed(b.realized)} on ${b.closed} closed` : ''}`;
      body = rowsTable(k, HEAD('Paid', 'Locks in'), b.rows, (r) => {
        const broken = r.integrity !== 'valid' && r.integrity !== 'half_settled';
        const when = r.settlesAt ? `settles ${settleDay(r.settlesAt)}` : 'no settle date on record';
        return `<tr data-k="${esc(r.id)}"><th><span class="nm">${esc(r.label)}</span><small>${esc(`${when} · ${nOf(r.qty, 'pair')}${r.integrity === 'half_settled' ? ' · one side settled' : ''}`)}` +
          `${broken ? ` · <b class="neg">${esc(String(r.integrity).replace(/_/g, ' '))}</b>` : ''}</small></th><td class="v">${money(r.cost)}</td><td>${r.locked == null ? '—' : figure(r.locked)}</td></tr>`;
      }) || '<p class="bksub">No arb open.</p>';
      const nxt = b.rows.find((r) => r.settlesAt && r.settlesAt > S.now), then = nxt ? `next settles <b>${esc(settleDay(nxt.settlesAt))}</b>` : '';
      next = !b.on ? `Switched off: the open ones ride to settlement${then ? ` · ${then}` : ''}`
        : b.rows.length >= b.max ? `All ${b.max} slots taken: no new arb until one settles${then ? ` · ${then}` : ''}`
          : `Looks for a new one every ${(L.every && L.every.taker) || 15} seconds${then ? ` · ${then}` : ''}`;
    } else if (b.key === 'maker') {
      chip = !b.on ? 'quoting off' : b.halted ? 'halted' : `quoting ${b.quoting}`;
      vs = `<span class="vs" title="What its closed round trips have made; the rest is on contracts it still holds">banked <b class="${tone(b.realized)}">${signed(b.realized)}</b></span>`;
      sub = `${Number.isFinite(b.equity) ? `worth ${money(b.equity)} of ${money(b.initial, 0)} · ` : ''}${nOf(b.fills, 'fill')} · ${nOf(b.contracts, 'contract')} in ${nOf(b.markets, 'market')}`;
      body = rowsTable(k, HEAD('Worth', 'P&amp;L', 'Moving it most'), b.rows, (r) => `<tr data-k="${esc(r.ticker)}"><th><span class="nm">${esc(r.title || r.ticker)}</span>` +
        `<small>${esc(cap(`${r.sub ? `${r.sub} · ` : ''}${r.inv > 0 ? 'long' : 'short'} ${Math.abs(r.inv).toLocaleString('en-US')} · paid ${money(Math.abs(r.cost))}`))}</small></th><td class="v">${money(r.worth)}</td><td>${figure(r.pnl)}</td></tr>`, 6) +
        (b.markets > b.rows.length ? `<p class="bksub">and ${nOf(b.markets - b.rows.length, 'more market')} held</p>` : '');
      next = b.halted ? esc(cap(b.halted)) : b.lastFillAt ? `Last fill <b>${esc(whenTxt(b.lastFillAt))}</b> ET` : 'No fill yet';
    } else if (b.key === 'snipe') {
      chip = !b.on ? 'switched off' : b.bought ? `${nOf(b.bought, 'buy', 'buys')}` : 'never fired';
      vs = `<span class="vs">${b.watched ? `${nOf(b.watched, 'finished game')} watched in 6 hours` : 'no finished game in 6 hours'}</span>`;
      body = b.rows.length ? `<table class="hold-t">${HEAD('Worth', 'P&amp;L')}<tbody>${b.rows.map(legRow).join('')}</tbody></table>`
        : b.seen.length ? `<dl class="bkfacts">${b.seen.map((e) => `<div><dt>${esc(ET_HM.format(new Date(e.t)))}</dt><dd>${esc(e.text)}${e.sub ? `<small>${esc(e.sub)}</small>` : ''}</dd></div>`).join('')}</dl>` : '';
      next = b.on ? 'Watches every game as it finishes' : b.watching ? 'Switched off: still watches finished games, buying nothing' : 'Switched off';
    } else if (b.key === 'bets') {
      chip = b.on ? `${b.rows.length} open` : b.rows.length ? `${b.rows.length} open · off` : 'switched off';
      vs = b.settled ? `<span class="vs">${b.wins} of ${nOf(b.settled, 'game')} won</span>` : `<span class="vs">${b.games ? `${nOf(b.games, 'game')} bet` : 'no game bet yet'}</span>`;
      body = b.rows.length ? `<table class="hold-t">${HEAD('Worth', 'P&amp;L')}<tbody>${b.rows.map(legRow).join('')}</tbody></table>` : '';
      next = b.on ? `Bets each game once, $${b.stake} on the favourite` : 'Switched off: open bets ride to the final';
    } else {
      chip = b.on ? `${b.rows.length} open` : b.rows.length ? `${b.rows.length} open · off` : 'switched off';
      vs = b.trades ? `<span class="vs">${b.wins} of ${nOf(b.trades, 'trade')} made money</span>` : '';
      body = b.rows.length ? `<table class="hold-t">${HEAD('Worth', 'P&amp;L')}<tbody>${b.rows.map(legRow).join('')}</tbody></table>` : '';
      next = b.on ? `Looks every ${(L.every && L.every.taker) || 15} seconds` : 'Switched off: nothing new opens';
    }
    return { chip, vs, sub, body, next };
  }
  function pmCard(b) {
    const k = `pm-${b.key}`, { chip, vs, sub, body, next } = pmBits(b);
    return `<article class="card bk pmbk" data-k="${k}" style="--bk:var(--ink-3)" aria-label="${esc(b.name)}, prediction markets">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(chip)}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<p class="now">${next}</p>${sub ? `<div class="bksub">${sub}</div>` : ''}${body}` +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule || '')}</p></details></article>`;
  }
  // its sheet: the desk's board, and each of its books' figure and what it does next, each a link to its card
  function pmSheetHtml() {
    const L = S.legacy;
    if (!L) return '<p class="sub">The prediction-market desk is not on the floor right now.</p>';
    const [state, cls] = pmState(L);
    return `<div class="pmhero"><span class="pill ${cls}"><i></i>${esc(state)}<span class="mode">Paper</span></span><a class="pmold" href="/pm">Every market, on its old page ›</a>` +
      `<div class="figline"><span class="fig ${tone(L.pnl)}">${signed(L.pnl)}</span><span class="vs">on ${money(L.initial, 0)} of its own paper · the same outcomes on Polymarket and Kalshi` +
      `${L.halt ? ` · ${esc(L.halt)}` : ''}</span></div></div>` +
      `<dl class="facts">${PM_ORDER.map((k) => (L.books || []).find((b) => b.key === k)).filter(Boolean).map((b) => `<div><dt><a href="#book/pm-${b.key}">${esc(b.name)}</a></dt>` +
        `<dd>${figure(b.pnl)} · ${pmBits(b).next}</dd></div>`).join('')}</dl>`;
  }

  // ------------------------------------------------------------ what's happening: the desk's trades and the bots' log
  const logKey = (e) => `${e.t}|${e.agent}|${e.text}`;
  const shape = (s) => String(s).replace(/[−+-]?\$?\d[\d,.]*%?/g, '#');
  // One row of the list: { t, who, tag, text, sub, level, pnl, key }. Its level is the engine's word for the
  // line (src/desk/engine.js logLevel), the same one that decides which lines its ring keeps:
  //   trade  money moved          warn  needs a look
  //   info   a decision           quiet the desk doing its rounds
  // The desk writes its log in plain sentences already; the part before the first " · " is what happened,
  // the rest is the detail underneath.
  // Its tag says which book a line is about, in the book's colour: until 2026-10-02 the column named the bot
  // that wrote it (BRAM, KETT), which a reader had to know the cast to follow. The bot is still named when the
  // tag is pointed at. A line about one book starts with its name ("scalps: SPY broke above ..."), which the
  // tag then says instead; a coin's or SPY's line is the crypto or stocks book's; the rest is the desk's.
  const ROLE = { HOLT: 'prices', ILSA: 'volatility', TESS: 'risk', RIGO: 'marks and option exits', BRAM: 'signals', KETT: 'fills', PRED: 'the prediction-market desk', MAKR: 'the maker' };
  const DESK_TAG = { name: 'Desk', color: 'var(--ink-3)' };
  const tagOf = (k) => ({ name: (bookOf(k) || {}).name || cap(k), color: BOOK_COLOR[k] || 'var(--ink-3)' });
  function logRow(e) {
    let text = grouped(String(e.text || '')), tag = DESK_TAG;
    const m = text.match(/^(options|scalps|dips|runners):\s*/i);
    if (m) { tag = tagOf(m[1].toLowerCase()); text = text.slice(m[0].length); }
    else if (/^(BTC|ETH|SOL|XRP|DOGE):/.test(text)) tag = tagOf('crypto');
    else if (/^SPY:/.test(text)) tag = tagOf('stocks');
    const parts = text.split(' · ');
    return { t: e.t, who: e.agent, tag, text: cap(parts[0]), sub: parts.slice(1).join(' · '), level: e.level || 'info', pnl: null, key: logKey(e), halt: e.kind === 'HALT' };
  }
  // A trade is a row from the ledger's own fills, not from the log. On 26 September the routine rounds had
  // pushed the log lines of the desk's three buys out of the frame in eight hours, and this list said
  // "Nothing of those kinds yet" beside a book holding all three coins; the frame's eighty fills do not
  // age out that way. A fill's log line says the same thing, so it is left out.
  function fillRow(f) {
    const opt = optBook(f.book), coinish = f.book === 'crypto' || f.book === 'runners', name = opt ? f.label : coinish ? coin(f.sym) : f.sym;
    const why = String(f.why || ''), expired = /^expired/.test(why);
    const row = { t: f.at, who: expired ? 'RIGO' : 'KETT', tag: tagOf(f.book), level: 'trade', pnl: f.side === 'sell' ? f.pnl : null, key: `fill|${f.id}` };
    if (expired) return { ...row, text: `${name} expired worth ${px(f.px)}`, sub: '' };
    if (f.side === 'sell' && !(f.px > 0)) return { ...row, text: `${name} written off: no bid`, sub: cap(why.replace(/,? no bid$/, '')) };
    const qty = opt ? String(f.qty) : f.book === 'runners' ? runQty(f.qty) : qtyTxt(f.qty, f.book, f.sym);
    return { ...row, text: `${f.side === 'buy' ? 'Bought' : 'Sold'} ${qty} ${name} at ${coinish ? coinPx(f.px) : px(f.px)}`,
      sub: [`${money(f.value)}${f.fee ? `, fee ${money(f.fee)}` : ''}`, why].filter(Boolean).join(' · ') };
  }
  // The prediction-market desk's lines and fills (src/pmfloor.js has already put its log in plain words and
  // given each line its level). Its bots have the same names as these, so its lines go under PRED, the
  // name this floor gives that desk, and the maker's under its own, MAKR; a fill is tagged with its book.
  const pmWho = (agent) => (agent === 'MAKR' ? 'MAKR' : 'PRED');
  const PM_TAG = { arb: 'Arbs', snipe: 'Snipe', converge: 'Convergence', maker: 'Maker', bet: 'Every game' };
  const pmTag = (name) => ({ name, color: 'var(--ink-3)' });
  const pmLogRow = (e) => ({ t: e.t, who: pmWho(e.agent), tag: pmTag(e.agent === 'MAKR' ? 'Maker' : 'Predictions'), text: grouped(String(e.text || '')), sub: grouped(String(e.sub || '')), level: e.level || 'info',
    pnl: e.level === 'trade' && Number.isFinite(e.pnl) ? e.pnl : null, key: `pm|${e.t}|${e.agent}|${e.text}`, src: 'pm', halt: e.kind === 'HALT' });
  function pmFillRow(f) {
    const verb = f.action === 'settled' ? 'Settled' : f.action === 'sold' ? 'Sold' : 'Bought';
    return { t: f.at, who: f.book === 'maker' ? 'MAKR' : 'PRED', tag: pmTag(PM_TAG[f.book] || cap(f.book)), level: 'trade', src: 'pm', key: `pm|${f.id}`, pnl: Number.isFinite(f.pnl) ? f.pnl : null,
      text: `${verb} ${Number(f.qty).toLocaleString('en-US')} ${cap(f.side)} on ${f.label}`, sub: `${f.venue} at ${cents(f.px)} · ${BOOK_NAME[f.book] || f.book}` };
  }
  // newest first; the same round said again by the same bot is shown once
  function activityRows() {
    const rows = [], last = {};
    const add = (r, who) => { const k = shape(r.text); if (last[who] === k) return; last[who] = k; rows.push(r); };
    for (const e of S.log || []) {
      if (e.kind === 'FILL' || e.kind === 'SETTLE') continue;
      add(logRow(e), e.agent);
    }
    for (const f of S.fills || []) rows.push(fillRow(f));
    const L = S.legacy;
    if (L) {
      for (const e of L.log || []) add(pmLogRow(e), `pm ${e.agent}`);
      for (const f of L.fills || []) rows.push(pmFillRow(f));
    }
    return rows.sort((a, b) => b.t - a.t);
  }
  // newest first: the day's name goes above the first entry from each earlier day
  function feedHtml(rows) {
    const td = today();
    let day = td;
    return rows.map((r) => {
      const k = dayKey(r.t), head = k === day ? '' : `<li class="day" data-k="day|${k}">${esc(dayName(r.t, td))}</li>`;
      day = k;
      const amt = r.pnl != null ? `<span class="amt ${tone(r.pnl)}">${signed(r.pnl)}</span>` : '<span class="amt"></span>';
      return `${head}<li class="lv-${r.level}" data-k="${esc(r.key)}"><time${Number.isFinite(r.t) ? ` datetime="${new Date(r.t).toISOString()}"` : ''}>${esc(ET_HM.format(new Date(r.t)))}</time>` +
        `<span class="tag" style="--bk:${r.tag.color}" title="${esc(`Written by ${r.who}${ROLE[r.who] ? `, ${ROLE[r.who]}` : ''}`)}"><i class="sw"></i>${esc(r.tag.name)}</span>` +
        `<span class="what">${esc(r.text)}${r.sub ? `<small>${esc(r.sub)}</small>` : ''}</span>${amt}</li>`;
    }).join('');
  }
  // The routine rounds ("3/3 coins live", "all clear") come every few minutes and used to push the day's
  // few trades out of sight, so they are shown only when asked for. Until 2026-10-02 four chips turned each
  // level on and off, and a fifth the prediction-market desk, filled in the ink when on: they read as labels,
  // and no one could tell which were showing. Two segmented controls now, each one choice: how much (each
  // takes in the one before it, and a warning is always shown), and which desk.
  const SHOWS = [['trades', 'Trades', ['trade', 'warn']], ['decisions', 'Trades & signals', ['trade', 'info', 'warn']], ['all', 'Everything', ['trade', 'info', 'warn', 'quiet']]];
  const DESKS = [['both', 'Both desks'], ['desk', 'Stocks & crypto'], ['pm', 'Predictions']];
  const feed = { show: 'decisions', desk: 'both' };
  try { const v = JSON.parse(localStorage.getItem('desk-feed') || '{}'); if (SHOWS.some(([k]) => k === v.show)) feed.show = v.show; if (DESKS.some(([k]) => k === v.desk)) feed.desk = v.desk; } catch { /* defaults */ }
  const segHtml = (attr, opts, on) => opts.map(([k, name, n]) => `<button type="button" data-${attr}="${k}" class="${k === on ? 'on' : ''}" aria-pressed="${k === on}">${esc(name)}${n != null ? `<span>${n}</span>` : ''}</button>`).join('');
  function renderActivity(all = activityRows()) {
    const desk = S.legacy ? feed.desk : 'both';
    const rows = all.filter((r) => desk === 'both' || (desk === 'pm') === (r.src === 'pm'));
    const levels = (k) => SHOWS.find((s) => s[0] === k)[2];
    morph($('fshow'), segHtml('show', SHOWS.map(([k, name]) => [k, name, rows.filter((r) => levels(k).includes(r.level)).length]), feed.show));
    $('fdesk').hidden = !S.legacy;
    morph($('fdesk'), segHtml('desk', DESKS, desk));
    const shown = rows.filter((r) => levels(feed.show).includes(r.level)).slice(0, 200);
    morph($('feedlist'), feedHtml(shown) || `<li class="empty">${rows.length ? 'Nothing of that kind yet.' : 'Waiting for the first desk round.'}</li>`);
  }
  // The overview's few: the latest trades and warnings of both desks. The maker fills every few minutes and
  // would be all of them, so its fills are left to the Activity view and its own line on the overview.
  // As many as fit its card: the page does not scroll, so the rest are hidden rather than pushed off the foot,
  // and every one of them is in the Activity sheet.
  function renderLatest(all) {
    const rows = all.filter((r) => (r.level === 'trade' || r.level === 'warn') && !(r.who === 'MAKR' && r.level === 'trade')).slice(0, 20);
    morph($('latestlist'), feedHtml(rows) || `<li class="empty">${all.length ? 'No trade yet.' : 'Waiting for the first desk round.'}</li>`);
    fitList($('latestlist'));
  }
  function fitList(ol) {
    const items = [...ol.children], room = ol.clientHeight;
    for (const li of items) li.hidden = false;
    if (!room) return;
    let full = false;
    for (const li of items) if (full || li.offsetTop + li.offsetHeight > room + 1) { li.hidden = true; full = true; }
    // a day's name with nothing under it goes too
    const shown = items.filter((li) => !li.hidden);
    if (shown.length > 1 && shown[shown.length - 1].classList.contains('day')) shown[shown.length - 1].hidden = true;
  }
  $('sheetactivity').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-show], button[data-desk]');
    if (!b) return;
    if (b.dataset.show) feed.show = b.dataset.show; else feed.desk = b.dataset.desk;
    try { localStorage.setItem('desk-feed', JSON.stringify(feed)); } catch { /* private window */ }
    if (S) renderActivity();
  });
  // a trade or a halt is read out once, by a screen reader, as it lands; nothing else is. The prediction-
  // market desk's maker fills every few minutes, so its trades are not read out, only its halts.
  let announced = null;
  function announce(rows) {
    const r = rows.find((x) => (x.level === 'trade' && x.src !== 'pm') || x.halt);
    if (!r) return;
    if (announced !== null && r.key !== announced) $('announce').textContent = `${r.tag.name}: ${r.text}`;
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
      hist = { points: h.points || [], initial: h.initial || 0, books: h.books || {}, step: h.step || 60, recentFrom: h.recentFrom || null, loaded: true };
      for (const el of plots.keys()) drawChart(el);
      if (S && sheet) renderSheet();
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
    const bk = hist.books || {}, opt = (bk.options || 0) + (bk.scalps || 0) + (bk.dips || 0) + (bk.runners || 0);
    // holding: each book's benchmark, or its own value while it has not traded (the option books are never "held": their cash)
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
    const grow = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    return (big ? '' : `<div class="ct"><span class="ctitle">Profit and loss<span class="csub"> · stocks, crypto and options</span></span><button type="button" class="cx" data-expand="1" title="Open large" aria-label="Open the chart large">${grow}</button></div>`) +
      `<div class="chead"><span class="cv"></span><span class="cd"></span></div>` +
      `<div class="cplot"></div><div class="cb">${seg}<span class="cr"></span></div>`;
  }
  function makePlot(el, big) {
    const LW = window.LightweightCharts;
    if (!LW) return null;
    const c = LW.createChart(el.querySelector('.cplot'), {
      autoSize: true, handleScroll: false, handleScale: false,
      layout: { background: { type: LW.ColorType.Solid, color: 'transparent' }, textColor: TOK['ink-3'], fontFamily: TOK.font, fontSize: 12, attributionLogo: true },
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
      topLineColor: TOK['gain-line'], topFillColor1: withAlpha(TOK['gain-line'], 0.24), topFillColor2: withAlpha(TOK['gain-line'], 0.02),
      bottomLineColor: TOK['loss-line'], bottomFillColor1: withAlpha(TOK['loss-line'], 0.02), bottomFillColor2: withAlpha(TOK['loss-line'], 0.24),
      lineWidth: big ? 3 : 2, priceLineVisible: false, lastValueVisible: big, crosshairMarkerRadius: 3,
      priceFormat: { type: 'custom', minMove: 0.01, formatter: (v) => plain(signed(v)) } });
    const hold = c.addSeries(LW.LineSeries, { color: TOK['ink-3'], lineWidth: 1, lineStyle: LW.LineStyle.Dashed, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
    desk.createPriceLine({ price: 0, color: withAlpha(TOK['ink-3'], 0.45), lineWidth: 1, lineStyle: LW.LineStyle.Dashed, axisLabelVisible: false });
    // The plot is always the whole range (it cannot be scrolled or zoomed), but when its width changes the
    // library keeps its bar spacing and cuts the end off. The large chart is measured again as it opens and
    // when the axis's font arrives, and four times in six it opened ending 17 minutes early, its last-value
    // label on a price from then: -$5.44 beside a desk at +$1.94. Any change of width fits it again.
    c.timeScale().subscribeSizeChange(() => c.timeScale().fitContent());
    return { c, desk, hold };
  }
  function drawChart(el) {
    const p = plots.get(el);
    // the large chart is built when it opens, at the size it opens at, not while it is hidden at none; the
    // overview's waits the same way while another view is showing, and is drawn as its view opens
    if (!p || (p.big && bigChart.hidden) || (!p.big && el.closest('[hidden]'))) return;
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
    morph(el.querySelector('.cr'), held != null ? `<span title="The dashed line: every book simply holding what it trades, over the same stretch"><i class="dash" aria-hidden="true"></i>just holding: <b class="${tone(held)}">${signed(held)}</b></span>` : '');
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
    let rows = [...bySec.entries()].sort((a, b) => a[0] - b[0]);
    // The library spaces its points evenly, whatever the time between them. The history is every minute
    // over its last day and `step` apart before that (the engine thins the older days), so a range that
    // reaches into those days takes the last one at the same step: at every minute, the last day filled
    // half the width of a five-day chart. A range inside the last day keeps every minute.
    const step = hist.recentFrom && rows.length && rows[0][0] * 1000 < hist.recentFrom ? hist.step : 60;
    if (step > 60) {
      // each point a step on from the last one kept (a round's few seconds either way), and the live end
      const kept = [];
      for (let i = 0; i < rows.length; i++) if (!kept.length || i === rows.length - 1 || rows[i][0] - kept[kept.length - 1][0] >= step - 5) kept.push(rows[i]);
      rows = kept;
    }
    // The hours the desk was down (it restarts on every deploy) took one step too, and a move across them
    // looked sudden, so the line breaks there: a gap is more than ten minutes, and more than three of the
    // range's steps. The library draws straight through a point with no value, but a point's colour is the
    // colour of the segment leaving it, so the last point before a gap is drawn clear.
    const gap = Math.max(600, 3 * step);
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
  // The device went from light to dark or back (on a schedule, at sunset): the page's colours follow by
  // themselves, and the charts are built again in the new ones.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    TOK = readTokens();
    for (const [el, p] of plots) {
      if (p.plot) { p.plot.c.remove(); p.plot = null; p.bottom = null; }
      drawChart(el);
    }
  });

  // ------------------------------------------------------------ the sheet: what is behind a tile, over the page
  // #book/<key> (a prediction-market book's key starts pm-), #desk, #pm or #activity. A tile's link pushes its
  // own entry onto the history, so the back button closes the sheet; Done goes back the same way. A link that
  // arrives from outside (a bookmark, a reload) opens the sheet, and Done then clears it in place.
  // The four views' links of the morning of 2026-10-02 (#desk/crypto, #pm/arbs, #overview) still land.
  const sheetEl = $('sheet');
  let sheet = null, sheetOpener = null;
  function wanted() {
    const [a, b] = decodeURIComponent(location.hash.slice(1)).split('/');
    if (a === 'book' && b) return { kind: 'book', k: b };
    if ((a === 'desk' || a === 'pm') && b) return { kind: 'book', k: a === 'pm' ? `pm-${b}` : b };
    if (a === 'desk' || a === 'pm' || a === 'activity') return { kind: a };
    return null;
  }
  function route() {
    const w = wanted(), was = sheet;
    sheet = w;
    sheetEl.hidden = !w;
    $('sheetactivity').hidden = !w || w.kind !== 'activity';
    $('sheetdetail').hidden = !w || w.kind === 'activity';
    if (w && !was) { sheetOpener = document.activeElement; }
    if (S && w) renderSheet();
    if (w && (!was || was.kind !== w.kind || was.k !== w.k)) { sheetEl.querySelector('.sbody').scrollTop = 0; sheetEl.querySelector('.sdone').focus(); }
    if (!w && was && sheetOpener && document.contains(sheetOpener)) sheetOpener.focus();
    if (!w) sheetOpener = null;
  }
  function closeSheet() {
    if (!sheet) return;
    if (history.state && history.state.sheet) history.back();
    else { history.replaceState(null, '', location.pathname + location.search); route(); }
  }
  // a link to a sheet, anywhere on the page or in a sheet, opens it as an entry of its own
  document.addEventListener('click', (ev) => {
    const a = ev.target.closest('a[href^="#"]');
    if (!a || ev.defaultPrevented || ev.metaKey || ev.ctrlKey || ev.shiftKey) return;
    const href = a.getAttribute('href');
    if (href.length < 2) return;
    ev.preventDefault();
    if (href === location.hash) return;
    if (sheet && history.state && history.state.sheet) history.replaceState({ sheet: 1 }, '', href);
    else history.pushState({ sheet: 1 }, '', href);
    route();
  });
  window.addEventListener('popstate', route);
  window.addEventListener('hashchange', route);
  function sheetTitle() {
    if (!sheet) return '';
    if (sheet.kind === 'activity') return 'Activity';
    if (sheet.kind === 'desk') return 'Stocks, crypto and options';
    if (sheet.kind === 'pm') return 'Prediction markets';
    const pm = sheet.k.startsWith('pm-'), b = pm ? ((S.legacy && S.legacy.books) || []).find((x) => `pm-${x.key}` === sheet.k) : bookOf(sheet.k);
    return b ? `<i class="sw" style="--bk:${pm ? 'var(--ink-3)' : BOOK_COLOR[b.key]}"></i>${esc(b.name)}<span class="chip">${esc(pm ? pmBits(b).chip : bookChip(b))}</span>` : 'Not on the floor';
  }
  function sheetHtml() {
    if (sheet.kind === 'desk') return `<div class="hero">${heroHtml()}</div><div class="deskcard">${deskHtml()}</div>` +
      '<p class="fine">Paper only: no broker is connected to this desk, and it has no way to place a real order. Crypto prices are live from Coinbase; stock and option prices come from Cboe about 15 minutes late, and the desk trades at those same late prices. The prediction-market desk prices Polymarket and Kalshi live and fills on paper against their books.</p>';
    if (sheet.kind === 'pm') return pmSheetHtml();
    const pm = sheet.k.startsWith('pm-');
    const b = pm ? ((S.legacy && S.legacy.books) || []).find((x) => `pm-${x.key}` === sheet.k) : bookOf(sheet.k);
    if (!b) return '<p class="sub">This book is not on the floor right now.</p>';
    const group = pm ? null : GROUPS.find((g) => g[2].includes(b.key));
    return (group ? `<p class="grpnote">${esc(group[0])}: ${esc(group[1])}</p>` : '') + (pm ? pmCard(b) : bookCard(b));
  }
  function renderSheet() {
    if (!sheet) return;
    morph($('sheettitle'), sheetTitle());
    if (sheet.kind === 'activity') renderActivity();
    else morph($('sheetdetail'), sheetHtml());
  }
  sheetEl.addEventListener('click', (ev) => {
    if (ev.target === sheetEl || ev.target.closest('[data-close]')) { closeSheet(); return; }
    // a prediction-market book's rows past the first few
    const t = ev.target.closest('[data-all]');
    if (!t) return;
    if (allRows.has(t.dataset.all)) allRows.delete(t.dataset.all); else allRows.add(t.dataset.all);
    if (S) renderSheet();
  });
  // the keyboard stays in the sheet while it is open, as it does in the large chart
  sheetEl.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const f = [...sheetEl.querySelectorAll('a[href], button, summary')].filter((x) => x.offsetParent !== null);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });
  // Escape closes what is on top: the large chart, else the sheet
  window.addEventListener('keydown', (ev) => { if (ev.key !== 'Escape') return; if (!bigChart.hidden) closeBigChart(); else closeSheet(); });

  // ------------------------------------------------------------ wiring: a frame every two seconds, a clock every second
  function render() {
    renderHeader();
    renderClock();
    morph($('ovdesk'), ovDeskHtml());
    renderOvPm();
    const rows = activityRows();
    renderLatest(rows);
    renderSheet();
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
  // the latest list is as long as its card has room for, which changes with the window and as the cards
  // around it settle (the chart sizes itself after the first frame)
  if (window.ResizeObserver) new ResizeObserver(() => { if (S) fitList($('latestlist')); }).observe($('latestlist'));
  else window.addEventListener('resize', () => { if (S) fitList($('latestlist')); });
  // Nothing redraws at rest: the clock ticks, and the page notices when the stream has gone quiet.
  setInterval(() => { if (!S) return; renderClock(); if (!!stale() !== shownGone) renderHeader(); }, 1000);
  route();
  morph($('ovdesk'), '<span class="label">Stocks, crypto and options</span><p class="of">Connecting to the desk…</p>');
  wireChart($('chart'), false);
  wireChart($('chartbig-pnl'), true);
  connect();
  loadHistory(); setInterval(loadHistory, 60000);
})();

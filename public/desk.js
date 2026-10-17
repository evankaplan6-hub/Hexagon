/* The Hexagon — the stocks, crypto and options desk's floor at /. Consumes /api/desk/stream.
 *
 * Four views of the one floor (2026-10-02; until then a single wall of boards, 2,800px long on a laptop,
 * the prediction-market desk's figure at its foot and its six books under the fold):
 *   Overview         four questions in order (since 2026-10-12): is the desk up or down, is it beating
 *                    just holding (crypto and SPY, with the chart), what did it just do and what is next,
 *                    and is anything wrong; then what it holds, the prediction-market desk's books and the
 *                    books that are off. Everything with more behind it opens it: a sheet for the desk, a
 *                    book, a market and the health, or the card in the view that has it
 *   Stocks & crypto  the six books in full: the headline against simply holding, the desk's state, and
 *                    a card per book, in two groups (crypto and SPY, then SPY's same-day options); since
 *                    2026-10-16 a book switched off and holding nothing goes last, in a group of its own
 *   Predictions      the prediction-market desk that runs in the same process (since 2026-09-29): its
 *                    board and its five books, drawn the same way
 *   Activity         everything both desks did, newest first, each line tagged with the book it is about
 * Each view is a link (#overview, #desk, #pm, #activity, and #desk/crypto or #pm/arbs for one book), so
 * the back button, a bookmark and a reload all land where they were. Until 2026-09-25 the boards were
 * painted into a pixel room with the bots at their desks; the bots are still the desk's workers, and an
 * activity line's tag names the one that wrote it when pointed at.
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
  // a book that is switched off and holds nothing: four of the six since 2026-10-08 (options, scalps, dips, runners)
  const bookOff = (b) => ['options', 'scalps', 'dips', 'runners'].includes(b.key) && !((S[b.key] || {}).enabled) && !b.rows.length;
  const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
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
  const keyOf = (n) => (n && n.nodeType === 1 ? n.getAttribute('data-k') : null);
  // Children were matched by position alone until 2026-10-15: a new fill on top of a list pushed every line
  // down one, each line then differed from the one at its place, and all of them were replaced, the focused
  // one too (a sheet's trade list lost its focus to the page behind on every fill). Now a line whose data-k is
  // still wanted stays the same element: a new one is put in before it, a line that is gone is taken out, and
  // one that moved is moved. One pass and a Map, built on the first keyed miss, so a quiet frame pays nothing.
  // A move keeps focus where the browser can (moveBefore); a new line or a removed one never moves the rest.
  function patch(a, b) {
    const want = [...b.childNodes];
    let have = null, wanted = null;
    for (let i = 0; i < want.length; i++) {
      const y = want[i];
      let x = a.childNodes[i];
      if (x && !sameNode(x, y) && (keyOf(x) != null || keyOf(y) != null)) {
        if (!have) {
          have = new Map(); wanted = new Set(want.map(keyOf).filter((k) => k != null));
          for (let j = i; j < a.childNodes.length; j++) { const k = keyOf(a.childNodes[j]); if (k != null && !have.has(k)) have.set(k, a.childNodes[j]); }
        }
        while (x && keyOf(x) != null && !wanted.has(keyOf(x))) { const n = x.nextSibling; a.removeChild(x); x = n; }
        const m = keyOf(y) != null ? have.get(keyOf(y)) : null;
        if (x && !sameNode(x, y)) {
          if (m && m.nodeName === y.nodeName) { if (a.moveBefore && m.isConnected) a.moveBefore(m, x); else a.insertBefore(m, x); x = m; }
          else if (keyOf(x) != null) { a.insertBefore(y, x); continue; }
        }
      }
      if (have && keyOf(x) != null) have.delete(keyOf(x));
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
  // A page resting in the background (paused, below) is not stale: it closed its own stream. Shown again, it has
  // the usual twelve seconds from then for a frame to come.
  const stale = () => !paused && lastFrameAt && Date.now() - Math.max(lastFrameAt, resumedAt) > STALE_MS;
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
    // the prediction-market desk's view, while there is one to show
    $('pmtab').hidden = !S.legacy;
    // and the address goes with it: left at #pm, the tab was a link to where the page already was, so tapping it
    // fired nothing once that desk came back (2026-10-16 audit)
    if (!S.legacy && view === 'pm') { setView('overview', false); history.replaceState(null, '', '#overview'); }
    $('floor').classList.toggle('gone', gone || stuck);
    document.body.classList.toggle('offline', gone || stuck);
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
    const { benchPnl, vs, fees, benchFees, holdFee, atWork, cash } = deskTotals(), bench = (S.books || []).filter((b) => b.bench != null);
    const kpi = (label, html, title) => `<div${title ? ` title="${esc(title)}"` : ''}><dt>${label}</dt><dd>${html}</dd></div>`;
    // "Fees paid" is every book's, the switched-off ones' too; the sentence under it, the books compared with
    // holding. Both said only "fees", $126.91 beside $53.20 (2026-10-16 audit).
    // the one sentence that says why the books and holding differ
    let insight = '';
    if (benchPnl != null) {
      insight = `Simply holding what the books hold would be <b>${figure(benchPnl)}</b>${holdFee ? `, after its ${money(holdFee)} fee to buy in` : ''}; ` +
        `they are <b>${figure(vs)}</b> against that${benchFees ? `, after the ${money(benchFees)} in fees ${bench.length === 1 ? 'it' : 'they'} paid` : ''}.`;
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
    return `<span class="label">Stocks &amp; crypto desk</span>` +
      `<div class="big ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="sub">on ${money(S.initial, 0)} of paper · marked ${esc(ET_HM.format(new Date(S.now)))} ET</div>` +
      `<dl class="kpis">${kpi('Today', S.today != null ? figure(S.today) : '—')}` +
      `${kpi('vs. just holding', vs != null ? figure(vs) : '—', VS_HOLD)}` +
      `${kpi('Fees paid', money(fees), 'Every book’s fees since the start, the switched-off books’ too')}${kpi('Invested', `${money(atWork, 0)}<small>${money(cash, 0)} in cash</small>`)}</dl>` +
      (insight ? `<p class="insight">${insight}</p>` : '');
  }

  // ------------------------------------------------------------ the overview: four questions, in order
  // Until 2026-10-12 the overview was each desk's figure with every book on a line, the chart and the latest
  // lines, laid out for six books when two of them trade. It opens on what a glance asks now (Evan: "best way
  // to redesign ux?", then "go" on a mockup): is the desk up or down, is it beating just holding, what did it
  // just do and what is next, and is anything wrong; then what it holds, the prediction-market desk, and the
  // books that are off. Anything with more behind it opens it ("make it so everything is interactive if it
  // leads to something else"): a sheet for the desk, a book, a market and the desk's health, a view's card for
  // the rest.
  // The books with a holding to beat that still trade: crypto and SPY. A book has bought in when one of its slots
  // holds something or has a holding price (benchPx), read from its rows: the book's `bench` is null for the
  // seconds after each restart before the first price, too, and the overview said "No book has bought in yet"
  // and "Nothing held yet" on a desk holding $26,000 (found 2026-10-15).
  const boughtIn = (b) => (b.key === 'crypto' || b.key === 'stocks') && b.rows.some((r) => r.qty > 0 || r.benchPx > 0);
  const heldBooks = () => (S.books || []).filter((b) => !bookOff(b) && boughtIn(b));
  const MKT_WORDS = { crypto: 'the coins', stocks: 'SPY' };
  const NUM = ['no', 'one', 'two', 'three', 'four', 'five', 'six'];
  const mktName = (b, r) => (b.key === 'crypto' ? r.label : r.name);
  const share = (r) => (r.worth > 0 ? (r.value || 0) / r.worth : 0);
  const upDown = (x) => (isZero(x) ? 'level' : `${x > 0 ? 'up' : 'down'} ${money(x)}`);
  const aheadTxt = (d) => (d == null ? '' : isZero(d) ? 'level with holding' : `<b class="${tone(d)}">${d > 0 ? 'ahead' : 'behind'} ${money(d)}</b>`);
  const sinceDay = () => ET_DAY.format(new Date(S.startedAt));
  // a time with its day: "Today, 8:00 PM ET", "Yesterday, ...", "Thu, Oct 8, ..."
  const whenFull = (t) => `${dayKey(t) === today() ? 'Today' : dayName(t, today())}, ${ET_HM.format(new Date(t))} ET`;
  const LONG_DAY = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  // when a book checks next, in words: crypto after midnight UTC, SPY a few minutes after the open
  function nextCheck(b) {
    if (b.key === 'crypto') {
      const t = Math.floor(S.now / 864e5 + 1) * 864e5, k = dayKey(t);
      return `${k === today() ? 'tonight' : k === dayKey(S.now + 864e5) ? 'tomorrow' : ET_DATE.format(new Date(t))} at ${ET_HM.format(new Date(t))} ET`;
    }
    if (S.market && S.market.open) return b.rows.some((r) => r.checkDay === today()) ? 'done today; next after the next open' : 'today, a few minutes after the open';
    const n = nextOpenDay();
    return n ? `${LONG_DAY[n] || n} after the 9:30 AM open` : 'after the next open';
  }
  function vsHold() {
    const bs = heldBooks();
    if (!bs.length) return null;
    // bought in, but with no price yet there is no holding to set against it
    if (bs.some((b) => b.bench == null)) return { bs, waiting: true };
    const pnl = r2(bs.reduce((a, b) => a + b.pnl, 0)), hold = r2(bs.reduce((a, b) => a + b.benchPnl, 0));
    return { bs, pnl, hold, vs: r2(pnl - hold) };
  }
  // a line of a list: a swatch, a name, a figure, a chevron, and a line under them. With `sheet` it opens that
  // sheet, with `href` it goes there, and with neither it is only read. `name` and `why` are HTML already.
  function rowHtml(o) {
    const fig = o.fig == null ? '<span></span>' : typeof o.fig === 'number' ? `<span class="rf ${tone(o.fig)}">${signed(o.fig)}</span>` : `<span class="rf">${o.fig}</span>`;
    const inner = `${o.color ? `<i class="sw" style="--bk:${o.color}"></i>` : ''}<span class="rn">${o.name}</span>${fig}` +
      `${o.sheet || o.href ? '<i class="chev" aria-hidden="true"></i>' : '<span></span>'}${o.why ? `<span class="rw">${o.why}</span>` : ''}`;
    const cls = o.color ? 'row' : 'row plain';
    const tag = o.sheet ? `button type="button" class="${cls}" data-sheet="${esc(o.sheet)}"` : o.href ? `a class="${cls}" href="${esc(o.href)}"` : `div class="${cls}"`;
    return `<li data-k="${esc(o.k)}"><${tag}>${inner}</${tag.split(' ')[0]}></li>`;
  }
  // Question one: up or down. The desk's worth, since its start and today; it opens every book.
  function ovHeroHtml() {
    // the share to a tenth of a point, to a hundredth under a tenth (−$12 on $30,000 is −0.04%, not −0.0%), and
    // with no sign when even that is nothing
    const part = S.initial ? Math.abs((S.pnl / S.initial) * 100) : 0, ps = part.toFixed(part < 0.095 ? 2 : 1), none = Number(ps) === 0 || isZero(S.pnl);
    const p = S.initial ? ` (${none ? '0.0' : `${S.pnl > 0 ? '+' : MINUS}${ps}`}%)` : '';
    return `<span class="ovlab">Stocks &amp; crypto desk<i class="chev" aria-hidden="true"></i></span><span class="big">${money(S.equity)}</span>` +
      `<span class="ovsub"><span class="${tone(S.pnl)}">${signed(S.pnl)}${p} since ${esc(sinceDay())}</span>` +
      `${S.today != null ? `<span class="${tone(S.today)}">${signed(S.today)} today</span>` : ''}</span>`;
  }
  // Question two: is it beating just holding. The books still trading against the same markets bought at
  // their first trade and held, with the chart under it and a line for each book.
  function vsHoldHtml() {
    const v = vsHold();
    if (!v) return '<p class="ovp">No book has bought in yet, so there is no holding to compare with.</p>';
    if (v.waiting) return `<div class="verdict zero">Waiting on prices</div><p class="ovp">The desk has just started and has no price yet for ` +
      `${listOf(v.bs.map((b) => MKT_WORDS[b.key] || b.name))}. What it holds is counted at what it paid until the first one comes, and then set against holding.</p>`;
    const head = isZero(v.vs) ? 'Level with holding' : `${v.vs > 0 ? 'Ahead' : 'Behind'} by ${money(v.vs)}`;
    return `<div class="verdict ${tone(v.vs)}">${head}</div><p class="ovp">${v.bs.length === 1 ? 'The book still trading is' : `The ${NUM[v.bs.length] || v.bs.length} books still trading are`} ` +
      `<b class="${tone(v.pnl)}">${upDown(v.pnl)}</b>. Buying ${listOf(v.bs.map((b) => MKT_WORDS[b.key] || b.name))} at each book's first trade and holding would be <b class="${tone(v.hold)}">${upDown(v.hold)}</b>.</p>`;
  }
  function vsBooksHtml() {
    const v = vsHold();
    return v ? v.bs.map((b) => {
      if (v.waiting) return rowHtml({ k: b.key, sheet: `book:${b.key}`, color: BOOK_COLOR[b.key], name: esc(b.name), fig: null, why: `${signed(b.pnl)} · waiting on prices to set holding against it` });
      const w = b.rows.reduce((a, r) => a + (r.worth || 0), 0), h = w > 0 ? b.rows.reduce((a, r) => a + (r.value || 0), 0) / w : 0;
      return rowHtml({ k: b.key, sheet: `book:${b.key}`, color: BOOK_COLOR[b.key], name: esc(b.name), fig: r2(b.pnl - b.benchPnl),
        why: `${signed(b.pnl)} against ${signed(b.benchPnl)} for holding · ${h >= 0.995 ? 'all of its money is in the market, as holding\'s is' : `${pct(h)} of its money is in the market, the rest in cash`}` });
    }).join('') : '';
  }
  // what it holds: each market, how much of its slot is in it, and against holding it
  function mktsHtml() {
    const rows = heldBooks().flatMap((b) => b.rows.map((r) => ({ b, r })));
    if (!rows.length) return '<p class="ovp">Nothing held yet.</p>';
    return '<div class="mkhead" aria-hidden="true"><span>Market</span><span>Held</span><span>Since start</span><span>Holding</span><span>Difference</span></div>' +
      `<ul class="mklist">${rows.map(({ b, r }) => {
        const since = r2(r.worth - r.initial), hold = r.hold == null ? null : r2(r.hold - r.initial), d = hold == null ? null : r2(since - hold);
        return `<li data-k="${esc(r.sym)}"><button type="button" class="mkrow" data-sheet="mkt:${esc(r.sym)}" style="--bk:${BOOK_COLOR[b.key]}">` +
          `<span class="mkn">${esc(mktName(b, r))}<i class="chev" aria-hidden="true"></i></span>` +
          `<span class="mkh"><span class="mkm"><i style="width:${(share(r) * 100).toFixed(1)}%"></i></span>${pct(share(r))}<span class="sr"> held</span></span>` +
          `<span class="mks" data-l="Since start">${figure(since)}</span><span class="mkb" data-l="Holding">${hold == null ? '—' : figure(hold)}</span>` +
          `<span class="mkd">${d == null ? '—' : figure(d)}<span class="sr"> against holding</span></span></button></li>`;
      }).join('')}</ul>`;
  }
  // Question three: what did it just do. The last trade of a book still trading, the rule's own reason for it,
  // and when each book checks next.
  const liveFills = () => (S.fills || []).filter((f) => f.book === 'crypto' || f.book === 'stocks');
  // the reason from the signal line the rule wrote as it moved ("ETH: move from 100% to 88% (45% swings, target 40%)")
  function moveWhy(f) {
    const name = f.book === 'crypto' ? coin(f.sym) : f.sym, label = f.label || name;
    const e = (S.log || []).find((x) => x.kind === 'SIGNAL' && Math.abs(x.t - f.at) < 5 * 6e4 && String(x.text).startsWith(`${name}:`));
    const m = e && String(e.text).match(/: (?:move from (\d+)% to|start at) (\d+)% \((\d+)% swings, target (\d+)%\)/);
    if (!m) return cap(f.why || '');
    return m[1] == null ? `${label} started at ${m[2]}% of its slot: it swings ${m[3]}% a year, and the book aims at ${m[4]}%.`
      : `${label} swings ${m[3]}% a year and the book aims at ${m[4]}%, so the rule moved it from ${m[1]}% to ${m[2]}% of its slot.`;
  }
  function lastTradeHtml() {
    const f = liveFills()[0], band = Math.round(((S.cfg && S.cfg.rebalBand) || 0.1) * 100);
    let top = '<p class="ovp">No trade yet.</p>';
    if (f) {
      const r = fillRow(f), bits = [whenFull(f.at), money(f.value)];
      if (f.side === 'sell' && Number.isFinite(f.pnl)) bits.push(`${plain(signed(f.pnl))} banked`);
      top = `<button type="button" class="lt" data-sheet="mkt:${esc(f.sym)}"><span class="ltw">${esc(r.text)}</span><span class="ltd">${esc(bits.join(' · '))}</span>` +
        `<span class="ltp">${esc(moveWhy(f))}</span><i class="chev" aria-hidden="true"></i></button>`;
    }
    const next = heldBooks().map((b) => rowHtml({ k: `next-${b.key}`, sheet: `book:${b.key}`, name: `<b>Next ${b.key === 'crypto' ? 'crypto' : 'SPY'} check:</b> ${esc(nextCheck(b))}` })).join('');
    return `${top}${next ? `<ul class="rows next">${next}</ul>` : ''}<p class="ovnote">Quiet days are normal: a book trades only when a market's share should move ${band} points or more.</p>`;
  }
  // Question four: is anything wrong. The light in the bar says it in a word; these say what it looked at.
  function healthChecks() {
    const M = marketBits(), C = S.cfg || {}, coins = (bookOf('crypto') || { rows: [] }).rows;
    const at = Math.max(0, ...coins.map((r) => r.at || 0));
    const ago = (t) => { const s = Math.max(0, Math.round((S.now - t) / 1000)); return s < 90 ? `${s} second${s === 1 ? '' : 's'} ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : `at ${ET_HM.format(new Date(t))} ET`; };
    // under half a hundredth of a percent is nothing lost: a cent read "down 0.00% today"
    const start = S.today != null ? S.equity - S.today : 0, down = start > 0 && S.today < 0 && -S.today / start >= 0.00005 ? -S.today / start : 0;
    const sha = S.build && S.build.sha ? String(S.build.sha).slice(0, 7) : 'dev';
    return [
      { k: 'crypto', ok: M.cryptoOk ? 'ok' : 'warn', name: M.cryptoOk ? `Crypto prices live${at ? `, ${ago(at)}` : ''}` : 'Crypto prices stale', detail: `${coins.length} coins from Coinbase` },
      { k: 'spy', ok: M.spyOk ? 'ok' : 'warn', name: !M.spyOk ? 'SPY prices stale' : M.open ? 'SPY prices about 15 minutes late, as always' : 'SPY prices fine; the market is closed',
        detail: `From Cboe's free feed · the stock market ${M.says ? `${M.open ? 'is ' : ''}${M.says}` : M.open ? 'is open' : 'is closed'}` },
      { k: 'loop', ok: stale() || stalled() ? 'bad' : 'ok', name: stale() ? 'No signal from the desk' : stalled() ? `No round since ${ET_HM.format(new Date(S.beat))} ET` : S.beat ? `Last round ${ago(S.beat)}` : 'Waiting for the first round',
        detail: `Running since ${ET_DAY.format(new Date(S.startedAt))}, ${ET_HM.format(new Date(S.startedAt))} · build ${sha}` },
      { k: 'buying', ok: S.halt ? 'warn' : 'ok', name: S.halt ? `Not buying: ${S.halt}` : `Loss limit: ${down ? `down ${(down * 100).toFixed(2)}% today` : 'nothing lost today'}${C.maxDailyDdPct ? `; buying stops at ${(C.maxDailyDdPct * 100).toFixed(0)}%` : ''}`,
        detail: C.maxDailyDdPct ? `Buying stops when the desk is down ${(C.maxDailyDdPct * 100).toFixed(0)}% in a day; selling never does` : '' },
    ];
  }
  const checkName = (c) => `<span class="mark ${c.ok}" aria-hidden="true">${c.ok === 'ok' ? '✓' : '!'}</span><span class="sr">${c.ok === 'ok' ? 'Fine: ' : 'Look: '}</span>${esc(c.name)}`;
  const healthHtml = () => healthChecks().map((c) => rowHtml({ k: c.k, sheet: 'health', name: checkName(c) })).join('');
  // the prediction-market desk: below the books, smaller, each of its books a link to its card
  function ovPmHtml(L) {
    const [state, cls] = pmState(L);
    const books = PM_ORDER.map((k) => (L.books || []).find((b) => b.key === k)).filter(Boolean);
    return `<a class="sechead" href="#pm"><h2 class="sect" id="ovpm-h">Prediction markets</h2><i class="chev" aria-hidden="true"></i></a>` +
      `<p class="lede">The side desk, in paper: ${Number.isFinite(L.equity) ? `${money(L.equity)} from ${money(L.initial, 0)}, ` : ''}${figure(L.pnl)}, counting what is open at today's prices` +
      `${cls === 'good' ? '' : ` · <b>${esc(state)}</b>`}.</p>` +
      `<div class="pmcards">${books.map((b) => {
        const x = pmBits(b);
        return `<a class="card pmc" data-k="pm-${b.key}" href="#pm/${b.key}"><span class="pmn">${esc(b.name)}${b.on ? '' : '<span class="offtag">Off</span>'}<i class="chev" aria-hidden="true"></i></span>` +
          `<span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span><span class="pmw">${b.on ? `${esc(cap(x.chip))} · ` : ''}${x.next}</span></a>`;
      }).join('')}</div>`;
  }
  // the books that are switched off: one line of chips, each to its card on the Stocks & crypto view
  function ovOffHtml(off) {
    const sum = r2(off.reduce((a, b) => a + b.pnl, 0));
    return `<h2 class="sect" id="ovoff-h">Switched off</h2><p class="lede">${esc(listOf(off.map((b, i) => (i ? b.name.toLowerCase() : b.name))))} no longer ` +
      `trade and hold nothing; what they made before stays in the desk's figure. Together: ${figure(sum)}.</p>` +
      `<div class="offchips">${off.map((b) => `<a class="offchip" data-k="off-${b.key}" href="#desk/${b.key}"><i class="sw" style="--bk:${BOOK_COLOR[b.key]}"></i>${esc(b.name)} ` +
        `<span class="${tone(b.pnl)}">${signed(b.pnl)}</span><i class="chev" aria-hidden="true"></i></a>`).join('')}</div>`;
  }
  function renderOverview() {
    morph($('ovhero'), ovHeroHtml());
    $('ovhero').setAttribute('aria-label', `The desk: ${money(S.equity)}, ${plain(signed(S.pnl))} since ${sinceDay()}. Open every book`);
    morph($('vshold'), vsHoldHtml());
    morph($('vsbooks'), vsBooksHtml());
    morph($('mkts'), mktsHtml());
    morph($('lasttrade'), lastTradeHtml());
    morph($('health'), healthHtml());
    const L = S.legacy, off = (S.books || []).filter(bookOff);
    $('ovpm').hidden = !L;
    if (L) morph($('ovpm'), ovPmHtml(L));
    $('ovoff').hidden = !off.length;
    if (off.length) morph($('ovoff'), ovOffHtml(off));
  }

  // ------------------------------------------------------------ sheets: the desk, a book, a market, the health
  // One sheet at a time over the page, drawn from the latest frame on every frame; a line in it can open
  // another, and Back returns. A link to a view (a book's card, Activity) closes it, as any change of view does.
  const card = (title, html) => `<section class="card shcard">${title ? `<h3 class="shlab">${title}</h3>` : ''}${html}</section>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  function tradeList(fills, here) {
    if (!fills.length) return '<p>No trade yet.</p>';
    return `<ul class="rows">${fills.slice(0, 30).map((f) => {
      const r = fillRow(f), held = f.book === 'crypto' || f.book === 'stocks';
      return rowHtml({ k: f.id, sheet: held && f.sym !== here ? `mkt:${f.sym}` : null, href: held ? null : `#desk/${f.book}`, name: esc(r.text), fig: r.pnl,
        why: `${esc(whenFull(f.at))}${r.sub ? ` · ${esc(r.sub)}` : ''}` });
    }).join('')}</ul>`;
  }
  function deskSheet() {
    const { fees, atWork, cash } = deskTotals(), books = S.books || [];
    const on = books.filter((b) => !bookOff(b)), off = books.filter(bookOff);
    const line = (b) => rowHtml({ k: b.key, sheet: boughtIn(b) ? `book:${b.key}` : null, href: boughtIn(b) ? null : `#desk/${b.key}`, color: BOOK_COLOR[b.key], name: esc(b.name), fig: b.pnl,
      why: `${money(b.initial)} at the start · ${money(b.equity)} now` });
    return { title: 'The desk', html:
      card('', `<div class="shfig">${money(S.equity)}</div><p>${figure(S.pnl)} since ${esc(sinceDay())}, from ${money(S.initial)} across ${books.length} books.${S.today != null ? ` ${figure(S.today)} today.` : ''}</p>` +
        kv([['In the market', money(atWork)], ['Cash', money(cash)], ['Fees paid', money(fees)]])) +
      card('Trading', `<ul class="rows">${on.map(line).join('')}</ul>`) +
      (off.length ? card('Switched off', `<ul class="rows">${off.map(line).join('')}</ul><p>Together ${figure(r2(off.reduce((a, b) => a + b.pnl, 0)))}. They hold nothing.</p>`) : '') +
      (S.legacy ? card('Prediction markets', `<ul class="rows">${rowHtml({ k: 'pm', href: '#pm', name: 'The side desk, in paper', fig: S.legacy.pnl, why: `on ${money(S.legacy.initial, 0)} of its own paper, apart from these books` })}</ul>`) : '') };
  }
  function bookSheet(key) {
    const b = bookOf(key);
    if (!b || !boughtIn(b)) return null;
    const d = b.bench == null ? null : r2(b.pnl - b.benchPnl), band = Math.round(((S.cfg && S.cfg.rebalBand) || 0.1) * 100);
    return { title: b.name, html:
      card('', `<div class="shfig">${money(b.equity)}</div><p>${figure(b.pnl)} since its start · holding would be ${d == null ? 'known with the first price' : `${figure(b.benchPnl)} · ${aheadTxt(d)}`}</p>` +
        `<p class="now" style="--bk:${BOOK_COLOR[key]}">${nextLine(b)}</p>`) +
      card('The rule', `<p>${esc(b.rule)}</p><p>It trades only when a market's share should move ${band} points or more.</p>`) +
      card(key === 'crypto' ? 'Coins' : 'Market', `<ul class="rows">${b.rows.map((r) => {
        const since = r2(r.worth - r.initial), hold = r.hold == null ? null : r2(r.hold - r.initial);
        return rowHtml({ k: r.sym, sheet: `mkt:${r.sym}`, color: BOOK_COLOR[key], name: esc(mktName(b, r)), fig: hold == null ? null : r2(since - hold),
          why: `${pct(share(r))} held${Number.isFinite(r.vol) ? ` · swings ${pct(r.vol)} a year` : ''} · ${signed(since)} since start` });
      }).join('')}</ul><p>Each line's figure is how far it is ahead of simply holding it.</p>`) +
      card('Trades', tradeList((S.fills || []).filter((f) => f.book === key))) +
      `<p class="shlink"><a href="#desk/${key}">Its card on Stocks &amp; crypto</a></p>` };
  }
  // why a market holds what it holds: how much it swings, what the rule wants, and the band it trades outside
  function whyHtml(b, r, name) {
    const aim = (String(b.rule).match(/swing about (\d+)%/) || [])[1], band = Math.round(((S.cfg && S.cfg.rebalBand) || 0.1) * 100);
    if (!(r.target > 0) && !(r.qty > 0)) return `<p>Not held yet: it buys at the book's next check.</p>`;
    const want = Number.isFinite(r.want) ? r.want : r.target, gap = Math.round(Math.abs(want - r.target) * 100), moved = Math.round(Math.abs(share(r) - r.target) * 100);
    const swings = Number.isFinite(r.vol) ? `${esc(name)} swings ${pct(r.vol)} a year, measured over the last ${b.key === 'crypto' ? '30 days' : '20 sessions'}${aim ? `, and the book aims at ${aim}%` : ''}. ` : '';
    const rule = want >= 0.995 && r.target >= 0.995 ? 'The rule holds all of the slot in it.'
      : `The rule wants ${pct(want)} of the slot in it; the book last set it at ${pct(r.target)}${gap < band ? `, ${gap} point${gap === 1 ? '' : 's'} away, under the ${band} it takes to trade` : ', and moves it at its next check'}.`;
    return `<p>${swings}${rule}${moved >= 1 ? ` Prices have moved it to ${pct(share(r))} since.` : ''}</p>`;
  }
  function mktSheet(sym) {
    const b = heldBooks().find((x) => x.rows.some((r) => r.sym === sym)) || (S.books || []).find((x) => boughtIn(x) && x.rows.some((r) => r.sym === sym));
    if (!b) return null;
    const r = b.rows.find((x) => x.sym === sym), name = mktName(b, r), P = b.key === 'crypto' ? coinPx : px;
    const since = r2(r.worth - r.initial), hold = r.hold == null ? null : r2(r.hold - r.initial), d = hold == null ? null : r2(since - hold);
    const last = b.key === 'stocks' && S.spy && S.spy.last > 0 ? S.spy.last : r.px, chg = last > 0 && r.prevClose > 0 ? last / r.prevClose - 1 : null;
    const facts = [['Held', `${pct(share(r))} of its slot`], [b.key === 'crypto' ? 'Coins' : 'Shares', r.qty > 0 ? qtyTxt(r.qty, b.key, sym) : 'none'],
      ['Average cost', r.qty > 0 ? P(r.cost / r.qty) : '—'], ['Price', `${P(last)}${chg == null ? '' : ` ${change(chg)}`}`], ['Cash in the slot', money(r.cash)],
      ['Banked', figure(r.realized || 0)], ['Fees paid', money(r.fees || 0)]];
    if (b.key === 'stocks') facts.push(['Prices', esc(marketBits().spy)]);
    return { title: name, html:
      card('', `<div class="shfig">${money(r.worth)}</div><p>${figure(since)} since start · holding would be ${hold == null ? '—' : figure(hold)}${d == null ? '' : ` · ${aheadTxt(d)}`}</p>`) +
      card('Now', kv(facts)) +
      card(`Why ${pct(share(r))}`, whyHtml(b, r, name) + `<p><button type="button" class="seeall" data-sheet="book:${b.key}">How the ${esc(b.name.toLowerCase())} book works</button></p>`) +
      card('Trades', tradeList((S.fills || []).filter((f) => f.sym === sym && f.book === b.key), sym)) };
  }
  function healthSheet() {
    // the prediction desk's light is read from the last frame too, so with no signal it has none either
    const [state, cls] = deskState(), pm = S.legacy ? (stale() ? ['No signal', 'bad'] : pmState(S.legacy)) : null;
    const line = (c) => rowHtml({ k: c.k, href: c.href, name: checkName(c), why: c.detail ? esc(c.detail) : '' });
    return { title: 'Health', html:
      card('', `<div class="shfig st-${cls}">${esc(state)}</div><p>The light in the bar turns amber when prices are stale or the desk is not buying, and red when the desk stops or this page loses its signal.</p>`) +
      card('Checks', `<ul class="rows">${healthChecks().map(line).join('')}</ul>`) +
      (pm ? card('Prediction markets', `<ul class="rows">${line({ k: 'pm', href: '#pm', ok: pm[1] === 'good' ? 'ok' : pm[1], name: pm[0], detail: 'Its own loop, trading in paper beside the books' })}</ul>`) : '') };
  }
  function sheetOf(id) {
    const [kind, arg] = String(id).split(':');
    return kind === 'desk' ? deskSheet() : kind === 'health' ? healthSheet() : kind === 'book' ? bookSheet(arg) : kind === 'mkt' ? mktSheet(arg) : null;
  }
  const sheet = $('sheet');
  let sheetStack = [], sheetOpener = null;
  function renderSheet() {
    if (sheet.hidden || !S) return;
    const s = sheetOf(sheetStack[sheetStack.length - 1]);
    if (!s) { closeSheet(); return; }
    if ($('sheettitle').textContent !== s.title) $('sheettitle').textContent = s.title;
    const prev = sheetStack.length > 1 ? sheetOf(sheetStack[sheetStack.length - 2]) : null, back = $('sheetback');
    back.hidden = !prev;
    if (prev && back.textContent !== prev.title) back.textContent = prev.title;
    // a sheet sits above the banner, so it says so itself when the figures under it have stopped
    const note = stale() ? 'No signal from the desk: these are the last figures it sent.' : stalled() ? `The desk has finished no round since ${ET_HM.format(new Date(S.beat))} ET.` : '';
    morph($('sheetbody'), (note ? `<p class="shstale" role="status">${esc(note)}</p>` : '') + s.html);
  }
  // While a sheet or the large chart is open, the page behind it is inert. The Tab trap below listens on the
  // dialog, and a click on a sheet's plain text put the focus on <body>, where Tab went on through the page under
  // the dimming (2026-10-16 audit).
  const behind = () => { const on = !$('sheet').hidden || !$('chartbig').hidden; for (const el of [$('top'), document.querySelector('.wrap')]) if (el) el.inert = on; };
  function openSheet(id, from) {
    if (!S || !sheetOf(id)) return;
    if (sheet.hidden) { sheetOpener = from || document.activeElement; sheetStack = []; sheet.hidden = false; document.body.classList.add('sheeted'); behind(); }
    const at = sheetStack.indexOf(id);
    sheetStack = at >= 0 ? sheetStack.slice(0, at + 1) : [...sheetStack, id];
    $('sheetbody').textContent = '';     // a sheet opens at its top, not where the last one was scrolled
    renderSheet();
    sheet.querySelector('.shdone').focus({ preventScroll: true });
  }
  function closeSheet() {
    if (sheet.hidden) return;
    sheet.hidden = true;
    sheetStack = [];
    document.body.classList.remove('sheeted');
    behind();
    if (sheetOpener && document.contains(sheetOpener)) sheetOpener.focus({ preventScroll: true });
    sheetOpener = null;
  }
  // Back was the focused button, and on the first sheet it is hidden: the focus fell to the page behind and Tab
  // walked out of the dialog (found 2026-10-15). It stays on Back while there is a sheet to go back to, else on Done.
  const sheetback = $('sheetback');
  sheetback.addEventListener('click', () => {
    sheetStack.pop(); $('sheetbody').textContent = ''; renderSheet();
    if (!sheet.hidden) (sheetback.hidden ? sheet.querySelector('.shdone') : sheetback).focus({ preventScroll: true });
  });
  // a tap on anything that opens a sheet, or the large chart, wherever it is; a tap on the dimmed page closes the sheet
  document.addEventListener('click', (ev) => {
    if (ev.target === sheet || ev.target.closest('#sheet [data-close]')) { closeSheet(); return; }
    // A link in a sheet to a view (the health sheet's prediction-market line, a book's card) closes it. Only a
    // change of hash did, so the same link from that view's own page did nothing (found 2026-10-15): close it
    // here, and go to the book's card again when the link is to the address already showing.
    const go = ev.target.closest('#sheet a[href^="#"]');
    if (go) { closeSheet(); if (go.hash === location.hash) route(); return; }
    const t = ev.target.closest('[data-sheet], [data-expand]');
    if (!t) return;
    if (t.dataset.expand) { closeSheet(); openBigChart(); return; }
    openSheet(t.dataset.sheet, t);
  });
  sheet.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Tab') return;
    const f = [...sheet.querySelectorAll('button:not([hidden]), a[href]')];
    const first = f[0], last = f[f.length - 1];
    if (ev.shiftKey && document.activeElement === first) { ev.preventDefault(); last.focus(); }
    else if (!ev.shiftKey && document.activeElement === last) { ev.preventDefault(); first.focus(); }
  });

  // ------------------------------------------------------------ the desk: market, prices, the options day, the limits
  // the options book's day, in one sentence a person reads
  const today = () => dayKey(nowT());
  // when the stock market next opens, in the desk's own words ("opens Mon 9:30 AM ET"): today, tomorrow or a weekday
  const nextOpenDay = () => { const m = String((S.market && S.market.says) || '').match(/^opens (\w+)/); return m ? m[1] : null; };
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
  function deskHtml() {
    const C = S.cfg || {}, M = marketBits();
    const rows = [
      ['Stock market', `<b>${M.open ? 'Open' : 'Closed'}</b> · ${esc(M.says)}`],
      ['Prices', `<span class="dot${M.cryptoOk ? '' : ' warn'}"></span>Crypto ${M.cryptoOk ? 'live' : 'stale'} · <span class="dot ${M.spyOk ? 'late' : 'warn'}"></span>${esc(M.spy)}`],
    ];
    // how much of the day's loss limit is used: TESS stops all new buying when it is. The meter stays plain
    // until half of it is gone, is amber to 80% and red past that.
    if (C.maxDailyDdPct && S.today != null && S.equity) {
      const start = S.equity - S.today, raw = start > 0 ? Math.max(0, -S.today / start) : 0, down = raw >= 0.00005 ? raw : 0, used = Math.min(1, down / C.maxDailyDdPct);
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
  function nextLine(b) {
    if (b.key === 'crypto') return `Checks again after midnight UTC: <b>${esc(ET_HM.format(new Date(Math.floor(S.now / 864e5 + 1) * 864e5)))} ET</b>`;
    if (b.key === 'stocks') {
      const checked = b.rows.some((r) => r.checkDay === today());
      return S.market && S.market.open ? (checked ? 'Checked today; checks again after the next open' : 'Checks once a trading day, after the open')
        : `Checks at the next open: <b>${esc(String((S.market && S.market.says) || '').replace(/^opens /, ''))}</b>`;
    }
    // the options, scalp, dip and runner books, retired on 2026-10-17
    return 'Switched off';
  }
  // A book that has never traded is its figure, its markets and its next check: no line that has never
  // moved. What it is doing now sits under its figure, in the book's colour: until 2026-10-02 it was the
  // card's last line, under the tables and the rule, and on a phone a card was its figure until its chip
  // (a button there and nowhere else) was tapped. The overview lists every book in a line now, so a card
  // here is always whole.
  const bookChip = (b) => {
    const held = b.rows.filter((r) => r.qty > 0).length;
    return lotBook(b.key) ? (b.rows.length ? `${b.rows.length} open` : 'no position') : held ? `${held} held` : 'not holding yet';
  };
  function bookCard(b) {
    // A switched-off book is its figure and its rule: no line that moves no more, and no table saying "the book is
    // switched off" on every row (the Runners card said it seven times).
    const off = bookOff(b);
    const held = b.rows.filter((r) => r.qty > 0).length;
    const traded = held || b.fees || !isZero(b.realized || 0) || (lotBook(b.key) && ((S[b.key] || {}).trades || []).length);
    const vs = b.bench != null ? `<span class="vs" title="Simply holding what this book trades, from its first trade${b.benchFee ? `, after its ${plain(money(b.benchFee))} fee to buy in` : ''}">` +
      `just holding <b class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</b></span>` : '';
    // the two figures on each row are named once, over them, when the book holds something
    const head = lotBook(b.key) || held ? '<thead><tr><th></th><th>Worth</th><th>P&amp;L</th></tr></thead>' : '';
    const body = b.rows.length ? `<table class="hold-t">${head}<tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>` : '<p class="bksub">Nothing held yet.</p>';
    return `<article class="card bk" data-k="${b.key}" style="--bk:${BOOK_COLOR[b.key]}" aria-label="${esc(b.name)} book">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(bookChip(b))}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<p class="now">${nextLine(b)}</p>` +
      `<div class="bksub">worth ${money(b.equity)} of ${money(b.initial, 0)}${b.fees ? ` · fees ${money(b.fees)}` : ''}${b.realized && !isZero(b.realized) ? ` · banked ${signed(b.realized)}` : ''}</div>` +
      (traded && !off ? sparkSvg(b.key) : '') + (off ? '' : body) +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule)}</p></details></article>`;
  }
  // Two kinds of book, which a reader new to the floor could not tell apart from six cards in a row: the ones
  // that hold crypto and SPY across days, and the ones that trade SPY's options within the day. A book the
  // page does not know yet goes with the first.
  const GROUPS = [
    ['Crypto and SPY', 'Held across days, sized to how hard each one swings.', ['crypto', 'stocks', 'runners']],
    ['SPY same-day options', 'Calls and puts bought and sold within the session, at Cboe’s prices about 15 minutes late.', ['options', 'scalps', 'dips']],
  ];
  // What a group says under its name: its sentence, Runners' own while it trades, and which of its books are off.
  // The first blurb went on describing Runners buying coins for two days after it was switched off.
  // Since 2026-10-16 a book that is switched off and holds nothing is not in its group: four of the six were, and
  // their cards outnumbered the two that trade. They go last, in a group of their own (the overview's chips
  // still open each card), so the groups above are what trades.
  const groupNote = (text, bs) => text + (bs.some((b) => b.key === 'runners') ? ' Runners buy a coin that is popping and ride it until it turns.' : '');
  function renderBooks() {
    const known = new Set(GROUPS.flatMap((g) => g[2]));
    const all = GROUPS.map(([title, text, keys], i) => [title, text, [...keys.map(bookOf).filter(Boolean), ...(i ? [] : (S.books || []).filter((b) => !known.has(b.key)))]]);
    const off = all.flatMap((g) => g[2]).filter(bookOff);
    const groups = all.map(([title, text, bs]) => [title, groupNote(text, bs.filter((b) => !bookOff(b))), bs.filter((b) => !bookOff(b))]);
    if (off.length) groups.push(['Switched off', 'These no longer trade and hold nothing; what they made before stays in the desk’s figure.', off]);
    morph($('books'), groups.filter((g) => g[2].length).map(([title, text, bs], i) => `<section class="bkgroup" data-k="g${i}" aria-label="${esc(title)}">` +
      `<h2>${esc(title)}</h2><p>${esc(text)}</p><div class="bkgrid">${bs.map(bookCard).join('')}</div></section>`).join(''));
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
  // a taker position the snipe, convergence or every-game book holds: one leg on one venue. A game bet is named
  // by the team it is on (src/pmfloor.js gameOf): "No on ... · Texas A&M" read as a bet on Texas A&M.
  const legRow = (r) => {
    const g = r.game;
    return `<tr data-k="${esc(r.id)}"><th><span class="nm">${esc(g ? `${g.pick} over ${g.foe}` : r.label)}</span>` +
      `<small>${esc(`${g ? `${g.league} · ` : ''}${r.startsAt ? `${r.startsAt > S.now ? 'starts' : 'started'} ${whenTxt(r.startsAt)} · ` : ''}${cap(r.side)} on ${r.venue} · ${nOf(r.qty, 'contract')} at ${cents(r.entry)}, ${cents(r.mark)} now`)}</small></th>` +
      `<td class="v">${money(r.worth)}</td><td>${figure(r.pnl)}</td></tr>`;
  };
  // the overview's line and a book's card say the same things: its chip and what it does next (the card has
  // its figure's comparison, its rows and its rule as well)
  const PM_ORDER = ['arbs', 'maker', 'bets', 'snipe', 'converge'];
  function pmBits(b) {
    const k = `pm-${b.key}`, L = S.legacy;
    let chip = '', vs = '', sub = '', body = '', next = '';
    if (b.key === 'arbs') {
      // more open than the cap allows (opened before it was lowered): "19 of 12 open" read as a sum gone wrong
      const over = b.rows.length > b.max;
      chip = b.on ? (over ? `${b.rows.length} open` : `${b.rows.length} of ${b.max} open`) : b.rows.length ? `${b.rows.length} open · off` : 'switched off';
      vs = `<span class="vs" title="What the open arbs pay when their markets settle, with what the closed ones banked">at settlement <b class="${tone(b.atSettle)}">${signed(b.atSettle)}</b></span>`;
      sub = `paid ${money(b.cost)}, worth ${money(b.worth)} if sold now${b.closed ? ` · banked ${signed(b.realized)} on ${b.closed} closed` : ''}`;
      body = rowsTable(k, HEAD('Paid', 'Locks in'), b.rows, (r) => {
        const broken = r.integrity !== 'valid' && r.integrity !== 'half_settled';
        // a settle date that has passed is not "settles": the market has not paid out on the day it was to
        const when = !r.settlesAt ? 'no settle date on record' : r.settlesAt < S.now ? `was to settle ${settleDay(r.settlesAt)}, still open` : `settles ${settleDay(r.settlesAt)}`;
        return `<tr data-k="${esc(r.id)}"><th><span class="nm">${esc(r.label)}</span><small>${esc(`${when} · ${nOf(r.qty, 'pair')}${r.integrity === 'half_settled' ? ' · one side settled' : ''}`)}` +
          `${broken ? ` · <b class="neg">${esc(String(r.integrity).replace(/_/g, ' '))}</b>` : ''}</small></th><td class="v">${money(r.cost)}</td><td>${r.locked == null ? '—' : figure(r.locked)}</td></tr>`;
      }) || '<p class="bksub">No arb open.</p>';
      const nxt = b.rows.find((r) => r.settlesAt && r.settlesAt > S.now), then = nxt ? `next settles <b>${esc(settleDay(nxt.settlesAt))}</b>` : '';
      next = !b.on ? `Switched off: the open ones ride to settlement${then ? ` · ${then}` : ''}`
        : over ? `${b.rows.length} open, more than its ${b.max} slots: no new arb until it is back under${then ? ` · ${then}` : ''}`
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
      // eighty-one open on a college Saturday's eve, every one a row, made this the longest card on the floor
      body = rowsTable(k, HEAD('Worth', 'P&amp;L'), b.rows, legRow, 8);
      next = b.on ? `Bets each game once, $${b.stake} on the favourite, in the hour before it starts` : 'Switched off: open bets ride to the final';
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
  function renderPm() {
    const L = S.legacy, el = $('v-pm');
    if (!L) return;
    const [state, cls] = pmState(L), book = (k) => { const b = (L.books || []).find((x) => x.key === k); return b ? pmCard(b) : ''; };
    morph(el, `<div class="card pmhero"><div class="cardhead"><h2 class="label">Prediction markets</h2>` +
      `<span class="pill ${cls}"><i></i>${esc(state)}<span class="mode">Paper</span></span></div><a class="pmold" href="/pm">Every market, on its old page ›</a>` +
      `<div class="figline"><span class="fig ${tone(L.pnl)}">${signed(L.pnl)}</span><span class="vs">on ${money(L.initial, 0)} of its own paper · the same outcomes on Polymarket and Kalshi` +
      `${L.halt ? ` · ${esc(L.halt)}` : ''}</span></div></div>` +
      `<div class="pmbooks">${PM_ORDER.slice(0, 2).map(book).join('')}<div class="pmside">${PM_ORDER.slice(2).map(book).join('')}</div></div>`);
  }
  $('v-pm').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-all]');
    if (!t) return;
    if (allRows.has(t.dataset.all)) allRows.delete(t.dataset.all); else allRows.add(t.dataset.all);
    if (S) renderPm();
  });

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
  // The tag names the book, so the sub-line no longer says it again ("Polymarket at 51¢ · every game"). The
  // maker's fills come folded by minute and price, with their count (src/pmfloor.js).
  function pmFillRow(f) {
    const verb = f.action === 'settled' ? 'Settled' : f.action === 'sold' ? 'Sold' : 'Bought';
    const row = { t: f.at, who: f.book === 'maker' ? 'MAKR' : 'PRED', tag: pmTag(PM_TAG[f.book] || cap(f.book)), level: 'trade', src: 'pm', key: `pm|${f.id}`, pnl: Number.isFinite(f.pnl) ? f.pnl : null };
    const g = f.game, qty = Number(f.qty).toLocaleString('en-US');
    if (g) {
      // a game bet, by the team it is on: "Bought 124 No on NCAAF Texas A&M v Missouri · Texas A&M" was a bet on
      // Missouri, and the reader had to turn it round. Settled, it says who won.
      const text = f.action === 'bought' ? `Bet on ${g.pick} over ${g.foe}` : f.action === 'sold' ? `Sold the bet on ${g.pick} over ${g.foe}`
        : f.pnl > 0 ? `Won on ${g.pick} over ${g.foe}` : f.pnl < 0 ? `Lost on ${g.pick}: ${g.foe} won` : `Settled: ${g.pick} v ${g.foe}`;
      return { ...row, text, sub: `${g.league} · ${qty} ${cap(f.side)} on ${f.venue} at ${cents(f.px)}${f.action === 'bought' ? ` · pays ${money(f.qty)} if they win` : ''}` };
    }
    return { ...row, text: `${verb} ${qty} ${cap(f.side)} on ${f.label}`, sub: `${f.venue} at ${cents(f.px)}${f.n > 1 ? ` · in ${f.n} fills` : ''}` };
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
  const phone = matchMedia('(max-width: 640px)');
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
  $('v-activity').addEventListener('click', (ev) => {
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
  // points: [t, the books' P&L, holding's P&L|null]. Since 2026-10-12 the chart is the overview's second question,
  // crypto and SPY against simply holding the same markets (the history's c and s, bc and bs fields); until then it
  // was every book's P&L with the four switched-off ones counted as cash in holding's line. The live end comes from
  // the stream, the rest from history.
  const HOLD_FIELDS = { crypto: ['c', 'bc'], stocks: ['s', 'bs'] };
  function chartSeries() {
    const bk = hist.books || {}, keys = Object.keys(HOLD_FIELDS).filter((k) => bk[k] != null);
    const init = keys.reduce((a, k) => a + bk[k], 0);
    const pts = [];
    for (const p of hist.points) {
      if (!keys.length || keys.some((k) => p[HOLD_FIELDS[k][0]] == null)) continue;
      const v = keys.reduce((a, k) => a + p[HOLD_FIELDS[k][0]], 0), held = keys.every((k) => p[HOLD_FIELDS[k][1]] != null);
      pts.push([p.t, r2(v - init), held ? r2(keys.reduce((a, k) => a + p[HOLD_FIELDS[k][1]], 0) - init) : null]);
    }
    const bs = keys.map(bookOf).filter(Boolean);
    if (S && bs.length && bs.length === keys.length) {
      pts.push([S.now, r2(bs.reduce((a, b) => a + b.pnl, 0)), bs.every((b) => b.bench != null) ? r2(bs.reduce((a, b) => a + b.benchPnl, 0)) : null]);
    }
    // from zero at the desk's start while the history reaches back to it (see beganAt)
    if (S && pts.length && beganAt(pts[0][0], S.startedAt)) pts.unshift([S.startedAt, 0, pts[0][2] != null ? 0 : null]);
    const span = RANGES.find(([r]) => r === chart.range)[1];
    const from = Number.isFinite(span) ? (S ? S.now : Date.now()) - span : -Infinity;
    return pts.filter((p) => p[0] >= from);
  }
  // The chart sits under its question on the overview, and in the large sheet under that sheet's own title,
  // so it carries no title of its own (until 2026-10-12 it had one, and its own button to open it large; the
  // card's "Large chart" opens it now)
  function chartSkeleton() {
    const seg = `<span class="seg">${RANGES.map(([r]) => `<button type="button" data-range="${r}" class="${chart.range === r ? 'on' : ''}">${r}</button>`).join('')}</span>`;
    return `<div class="chead"><span class="cv"></span><span class="cd"></span></div><div class="cplot"></div><div class="cb">${seg}<span class="cr"></span></div>`;
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
    // The figure is what changed over the range shown: over all of it, crypto's and SPY's total since their start
    // (the chart has been those two books against holding since 2026-10-12, so it is not the headline's figure,
    // which counts the switched-off books too); over 1h, 6h or 24h, the move in that window.
    morph(el.querySelector('.cv'), figure(pts.length > 1 ? r2(last - first) : 0));
    const from = pts.length ? pts[0][0] : 0;
    el.querySelector('.cd').textContent = pts.length < 2 ? '' : chart.range !== 'All' ? `over the last ${chart.range}`
      : `crypto and SPY since ${dayKey(from) === dayKey(nowT()) ? `${ET_HM.format(new Date(from))} today` : ET_DAY.format(new Date(from))}`;
    // holding over the same stretch, so the two figures compare: it gave holding's whole total beside the
    // desk's move over the last hour
    const firstHold = pts.find((x) => x[2] != null), lastHold = [...pts].reverse().find((x) => x[2] != null);
    const held = lastHold ? r2(lastHold[2] - firstHold[2]) : null;
    morph(el.querySelector('.cr'), held != null ? `<span title="The dashed line: the same markets bought at each book's first trade and simply held, over the same stretch"><i class="dash" aria-hidden="true"></i>just holding: <b class="${tone(held)}">${signed(held)}</b></span>` : '');
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
    el.innerHTML = chartSkeleton();
    plots.set(el, { big, plot: null });
    el.addEventListener('click', (ev) => {
      const b = ev.target.closest('button');
      if (!b) return;
      if (b.dataset.range) {
        chart.range = b.dataset.range;
        try { localStorage.setItem('desk-chart', JSON.stringify(chart)); } catch { /* private window */ }
        for (const [e2] of plots) { e2.querySelectorAll('[data-range]').forEach((x) => x.classList.toggle('on', x.dataset.range === chart.range)); drawChart(e2); }
      }
    });
  }
  // The chart opened large: it takes the keyboard while it is open and gives it back when it closes.
  const bigChart = $('chartbig');
  let opener = null;
  function openBigChart() {
    opener = document.activeElement;
    bigChart.hidden = false;
    drawChart($('chartbig-pnl'));
    behind();
    bigChart.querySelector('.cbback').focus();
  }
  function closeBigChart() {
    if (bigChart.hidden) return;
    bigChart.hidden = true;
    behind();
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
  window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') { closeBigChart(); closeSheet(); } });
  // The device went from light to dark or back (on a schedule, at sunset): the page's colours follow by
  // themselves, and the charts are built again in the new ones.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    TOK = readTokens();
    for (const [el, p] of plots) {
      if (p.plot) { p.plot.c.remove(); p.plot = null; p.bottom = null; }
      drawChart(el);
    }
  });

  // ------------------------------------------------------------ the views: one showing at a time, each a link
  // #overview, #desk, #pm and #activity, and #desk/<book> or #pm/<book> for one book's card, which is scrolled
  // to and lit for a moment. No element has those ids, so the browser does not jump to one by itself.
  const VIEWS = ['overview', 'desk', 'pm', 'activity'];
  let view = null, pendingBook = null;
  // `draw` is false from inside a render, which goes on to draw the view itself
  function setView(v, draw = true) {
    if (v === view) return;
    view = v;
    for (const el of document.querySelectorAll('main > .view')) el.hidden = el.dataset.view !== v;
    for (const a of $('views').querySelectorAll('a')) { if (a.dataset.view === v) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current'); }
    if (S && draw) render();
  }
  function route() {
    // a link cut short inside an escape (#%E0%A4%A) throws in decodeURIComponent, and this runs before the first
    // frame is asked for: the floor stayed blank for good. Read it as written; it names no view, so it is the overview.
    let raw = location.hash.slice(1);
    try { raw = decodeURIComponent(raw); } catch { /* malformed escape */ }
    const [v, k] = raw.split('/');
    const before = view;
    if (!bigChart.hidden) closeBigChart();       // the sheets are not part of the address: they stayed over the new view
    closeSheet();
    setView(VIEWS.includes(v) && !(v === 'pm' && S && !S.legacy) ? v : 'overview');
    pendingBook = k && (view === 'desk' || view === 'pm') ? (view === 'pm' ? `pm-${k}` : k) : null;
    if (pendingBook) showBook(); else if (before !== null && before !== view) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function showBook() {
    const el = pendingBook && document.querySelector(`.view:not([hidden]) .bk[data-k="${CSS.escape(pendingBook)}"]`);
    if (!el) return;
    pendingBook = null;
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------ wiring: a frame every two seconds, a clock every second
  function render() {
    renderHeader();
    renderClock();
    renderOverview();
    morph($('hero'), heroHtml());
    morph($('deskcard'), deskHtml());
    renderBooks();
    renderPm();
    const rows = activityRows();
    renderActivity(rows);
    announce(rows);
    drawChart($('chart'));
    if (!bigChart.hidden) drawChart($('chartbig-pnl'));
    renderSheet();
    $('floor').removeAttribute('aria-busy');
    if (pendingBook) showBook();
  }
  // The stream, kept alive. A phone suspends a page it is not showing and drops its sockets without a word: no
  // `error` comes, so the page sat on "No signal" and the last figures for good, and a Home Screen app has no
  // reload button. A frame is due every two seconds; when none has come in STALE_MS the page opens a new stream
  // itself, and tries at once when it is shown again.
  // A stream that errors after the session ended (DASH_PASS or SESSION_EPOCH changed, or the 30 days ran out)
  // retried for good behind "No signal". The front page redirects to /login when signed out, and fetch can be told
  // not to follow it: a redirect that comes back means the viewer is signed out, so reload into the form.
  const signedOut = () => { fetch('/', { cache: 'no-store', redirect: 'manual' }).then((r) => { if (r.type === 'opaqueredirect') location.reload(); }).catch(() => {}); };
  let es = null, retry = null, lastTry = 0;
  // For the seconds after a restart before the first price, a held slot's row came worth its cash alone: Bitcoin
  // "worth $0.04, since start −$3,333" under a book worth what it paid (found 2026-10-15). The book's own figure
  // holds a slot it has no price for at what it cost (the engine's sleeveValue); each slot's line does the same
  // here, with no gain or loss on it, until the price comes.
  function atCost(F) {
    for (const b of F.books || []) {
      if (b.key !== 'crypto' && b.key !== 'stocks') continue;
      for (const r of b.rows) if (r.qty > 0 && !(r.px > 0)) { r.value = r2(r.cost); r.worth = r2(r.cash + r.cost); r.pnl = null; }
    }
    return F;
  }
  function connect() {
    clearTimeout(retry); retry = null;
    if (es) es.close();
    lastTry = Date.now();
    const mine = es = new EventSource('/api/desk/stream');
    mine.onmessage = (ev) => { try { S = atCost(JSON.parse(ev.data)); S._rxPerf = performance.now(); lastFrameAt = Date.now(); fails = 0; render(); } catch (e) { console.error(e); } };
    // 3 s, then twice as long after each failure in a row, at most a minute: every open tab tried twice every 3 s
    // through an outage, for as long as it lasted (2026-10-16 audit)
    mine.onerror = () => { if (es !== mine) return; mine.close(); es = null; retry = setTimeout(connect, Math.min(60000, 3000 * 2 ** fails++)); signedOut(); };
  }
  // A frame is about 22 KB on the wire every two seconds, some 40 MB an hour, and a tab nobody is looking at went
  // on taking them (2026-10-16 audit). A page hidden for a minute closes its stream; showing it opens it again,
  // and the first frame brings everything up to date. (iOS stops a Home Screen app's page in the background anyway.)
  let fails = 0, paused = false, resumedAt = 0, hideTimer = null;
  document.addEventListener('visibilitychange', () => {
    clearTimeout(hideTimer);
    if (document.visibilityState === 'hidden') {
      hideTimer = setTimeout(() => { if (document.visibilityState !== 'hidden') return; paused = true; clearTimeout(retry); retry = null; if (es) { es.close(); es = null; } }, 60000);
    } else if (paused) { paused = false; resumedAt = Date.now(); fails = 0; connect(); }
  });
  // no frame since the last one, or since the last try when none has come at all
  const quiet = () => Date.now() - Math.max(lastFrameAt, lastTry) > STALE_MS;
  const wake = () => { if (document.visibilityState === 'visible' && quiet() && !retry) connect(); };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('pageshow', wake);
  // The bar's hairline shows once the page has scrolled under it; on a phone, once the large title has gone.
  const bar = $('top');
  const onScroll = () => bar.classList.toggle('scrolled', window.scrollY > (phone.matches ? 50 : 2));
  window.addEventListener('scroll', onScroll, { passive: true });
  onScroll();
  // Nothing redraws at rest: the clock ticks, and the page notices when the stream has gone quiet.
  // When the stream goes quiet everything is drawn again, not just the bar: the overview's Health card and an open
  // sheet went on saying "Working" and "Last round 3 seconds ago" under a banner that said No signal (2026-10-16 audit).
  setInterval(() => { if (quiet() && !retry && !paused) connect(); if (!S) return; renderClock(); if (!!stale() !== shownGone) render(); }, 1000);
  route();
  morph($('ovhero'), '<span class="ovlab">Stocks &amp; crypto desk</span><span class="ovsub">Connecting to the desk…</span>');
  wireChart($('chart'), false);
  wireChart($('chartbig-pnl'), true);
  connect();
  loadHistory(); setInterval(loadHistory, 60000);
})();

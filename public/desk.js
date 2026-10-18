/* The Hexagon — the floor at /. Consumes /api/desk/stream.
 *
 * Four views (2026-10-17, the floor's fifth version; Evan: "u do everything surprise me"):
 *   Today     the whole Hexagon as the day it is having: the date, all the paper in play and its three parts
 *             (crypto and SPY, the games, the arbs and the maker); then today's games as a scoreboard, the crypto
 *             rule against simply holding with how much of each coin it wants, what happens next across all of
 *             it, the lab's tapes and tests, the arbs and the maker, and the health
 *   Games     every game the book bets: its record against what the prices said it would win, then a tile per
 *             game, in progress, up next by start time, and final
 *   Markets   the crypto and SPY books in full (the headline against holding, the desk, the chart, a card each),
 *             the prediction-market desk's arbs, maker, snipe and convergence, and one line for the retired books
 *   Activity  everything any of it did, newest first, each line tagged with the part it is about
 * Until 2026-10-17 the views followed the code, one per desk (an overview of the stocks and crypto desk, its books,
 * the prediction-market desk, activity): the game bets, the busiest thing on the floor, were one card of five on the
 * Predictions view, the four retired books kept a group of their own, and the lab showed nowhere. Now the views
 * follow what is happening.
 * Each view is a link (#today, #games, #markets, #activity, and #markets/crypto or #markets/pm-arbs for one card),
 * so the back button, a bookmark and a reload all land where they were; the old links (#overview, #desk, #pm,
 * #desk/crypto, #pm/arbs, #pm/bets) land on the view that has what they named.
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
  const signed = (x, d = 2) => (isZero(x, d) ? money(0, d) : `${x > 0 ? '+' : MINUS}⁠${money(x, d)}`);
  const plain = (s) => s.replace(/⁠/g, '');
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
  const ET_LONG = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', month: 'long', day: 'numeric' });
  const ET_WEEKDAY = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long' });
  // The activity list's times keep their AM or PM, and a line naming the day heads anything from before
  // today: a bare "6:17" from yesterday evening read as this morning. Days are Eastern, like the clock.
  const ET_YMD = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: 'numeric', day: 'numeric' });
  const ET_DATE = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric' });
  const dayKey = (t) => { const p = {}; for (const x of ET_YMD.formatToParts(new Date(t))) p[x.type] = x.value; return `${p.year}-${p.month.padStart(2, '0')}-${p.day.padStart(2, '0')}`; };
  const addDay = (k, n) => new Date(Date.parse(`${k}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
  const dayBefore = (k) => addDay(k, -1);
  // a day by name: Yesterday, Tomorrow, or its date ("Sat, Oct 18")
  const dayName = (t, today) => { const k = dayKey(t); return k === dayBefore(today) ? 'Yesterday' : k === addDay(today, 1) ? 'Tomorrow' : ET_DATE.format(new Date(t)); };
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
  const qtyTxt = (q, book, sym) => (book === 'crypto'
    ? (+q).toLocaleString('en-US', { minimumFractionDigits: COIN_DP[sym] ?? 6, maximumFractionDigits: COIN_DP[sym] ?? 6 })
    : book === 'stocks' ? `${+(+q).toFixed(3)}` : String(q));
  const bookOf = (k) => (S && S.books || []).find((b) => b.key === k) || null;
  // The parts of the Hexagon and their colours (tokens.css): the two books that trade, the games, the arbs and the
  // maker, the lab. The four books retired on 2026-10-17 (options, scalps, dips, runners) keep their ledgers and
  // their figure inside the desk's, and nothing else: no colour, no card.
  const BOOK_COLOR = { crypto: 'var(--book-crypto)', stocks: 'var(--book-stocks)' };
  const GAMES_COLOR = 'var(--part-games)', SIDE_COLOR = 'var(--part-side)', LAB_COLOR = 'var(--part-lab)';
  const RETIRED = ['options', 'scalps', 'dips', 'runners'];
  const isRetired = (b) => RETIRED.includes(b.key);
  const listOf = (xs) => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
  const nOf = (n, one, many = `${one}s`) => `${Number(n || 0).toLocaleString('en-US')} ${n === 1 ? one : many}`;
  // a contract's price the way those markets quote it: cents, and a dollar at par
  const cents = (p) => (!Number.isFinite(p) ? '—' : Math.abs(p) >= 0.9995 ? `$${(+p).toFixed(2)}` : `${+(p * 100).toFixed(1)}¢`);
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
  const today = () => dayKey(nowT());
  function renderHeader() {
    const gone = !!stale(), stuck = stalled();
    shownGone = gone;
    const [state, cls] = deskState();
    const pill = $('deskstate');
    pill.className = `pill ${cls}`;
    morph(pill, `<i></i>${esc(state)}<span class="mode">Paper</span>`);
    // a background tab says how the Hexagon is doing, not just its name
    const T = totals(), title = Number.isFinite(T.pnl) ? `${plain(signed(T.pnl))} · ${state} · The Hexagon` : 'The Hexagon';
    if (document.title !== title) document.title = title;
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

  // ------------------------------------------------------------ the whole Hexagon: all the paper, and its three parts
  // The stocks and crypto desk and the prediction-market desk keep their own paper. The parts add up to the total:
  // crypto and SPY (with the retired books' figure inside it), the games (the every-game book), and the rest of the
  // prediction-market desk (arbs, maker, snipe, convergence), taken as that desk's figure less the games'.
  const pmBook = (k) => ((S && S.legacy && S.legacy.books) || []).find((b) => b.key === k) || null;
  const SIDE = ['arbs', 'maker', 'snipe', 'converge'];
  const G = () => (S && S.legacy && S.legacy.games) || null;
  function totals() {
    if (!S) return { equity: NaN, initial: NaN, pnl: NaN };
    const L = S.legacy, le = L && Number.isFinite(L.equity) ? L.equity : 0, li = L && Number.isFinite(L.initial) ? L.initial : 0;
    const equity = r2((S.equity || 0) + le), initial = r2((S.initial || 0) + li);
    return { equity, initial, pnl: r2(equity - initial) };
  }
  function parts() {
    // the desk's figure carries the retired books' too, which the crypto rule's card leaves out: said here, so the two
    // figures are not read as one that disagrees with itself
    const gone = r2((S.books || []).filter(isRetired).reduce((a, b) => a + b.pnl, 0));
    const L = S.legacy, out = [{ k: 'desk', name: 'Crypto & SPY', color: BOOK_COLOR.crypto, href: '#markets', pnl: S.pnl,
      sub: `${S.today != null ? `${plain(signed(S.today))} today` : `on ${money(S.initial, 0)}`}${isZero(gone) ? '' : ` · ${plain(signed(gone))} of it retired books`}` }];
    if (L) {
      const bets = pmBook('bets'), g = G(), t = g && g.record.today, R = g && g.record;
      const gp = bets ? bets.pnl : 0;
      out.push({ k: 'games', name: 'Games', color: GAMES_COLOR, href: '#games', pnl: gp,
        sub: t && t.bets ? `${t.won}–${t.bets - t.won} today` : R && R.bets ? `${R.won} of ${nOf(R.bets, 'game')} won` : bets ? `${bets.rows.length} open` : '' });
      const side = SIDE.map(pmBook).filter(Boolean), open = side.reduce((a, b) => a + (b.key === 'maker' ? 0 : b.rows.length), 0);
      out.push({ k: 'side', name: 'Arbs & maker', color: SIDE_COLOR, href: '#markets/side', pnl: r2((L.pnl || 0) - gp),
        sub: `${nOf(open, 'position')} open${(pmBook('maker') || {}).markets ? ` · maker in ${nOf(pmBook('maker').markets, 'market')}` : ''}` });
    }
    return out;
  }
  function todayHeroHtml() {
    const T = totals();
    return `<p class="tddate">${esc(ET_LONG.format(new Date(nowT())))}</p>` +
      `<button type="button" class="tdtotal" data-sheet="desk" aria-label="All the paper in play: ${money(T.equity)}, ${plain(signed(T.pnl))}. Open every part">` +
      `<span class="tdlab">All the paper in play<i class="chev" aria-hidden="true"></i></span><span class="big">${money(T.equity)}</span>` +
      `<span class="tdsub"><span class="${tone(T.pnl)}">${signed(T.pnl)}</span> on ${money(T.initial, 0)} of paper</span></button>` +
      `<nav class="parts" aria-label="The parts">${parts().map((p) => `<a class="part" data-k="part-${p.k}" href="${p.href}" style="--bk:${p.color}">` +
        `<span class="pn"><i class="sw"></i>${esc(p.name)}<i class="chev" aria-hidden="true"></i></span><span class="pf ${tone(p.pnl)}">${signed(p.pnl)}</span>` +
        `<span class="ps">${esc(p.sub)}</span></a>`).join('')}</nav>`;
  }

  // ------------------------------------------------------------ the games: a scoreboard
  // Every game the book bets is a tile, whatever stage it is at: up next (not bet yet; it bets in the hour before
  // the start), bet (not started), live, left alone (the favourite over the cap), won or lost. The bets it holds
  // are the every-game book's rows; the games it has not bet and the ones it settled lately come in the frame's
  // games (src/pmfloor.js gameBoard).
  const LEAGUE_NAME = { NCAAF: 'College', NFL: 'NFL', NBA: 'NBA', MLB: 'MLB' };
  const leagueName = (l) => LEAGUE_NAME[l] || l || '';
  const byStart = (a, b) => (a.start ?? Infinity) - (b.start ?? Infinity) || String(a.pick).localeCompare(String(b.pick));
  // the day a game was played, from when it settled: Kalshi settles minutes after the final, and a game ending
  // after midnight belongs to the evening it started (tools/bet-coverage.js reads it the same way)
  const playedDay = (at) => dayKey(at - 4 * 3600e3);
  function board() {
    const g = G();
    if (!g) return null;
    const bets = pmBook('bets'), now = S.now, ahead = (g.aheadH ?? 1) * 3600e3;
    // A bet whose game has no start on record is one the listing has dropped: finished, or nearly, and waiting on
    // the result ('wait'), not a game still to come. A tile is keyed by its game's pair, so the tile and an open sheet
    // stay the same one when the game goes from up next (a pair) to bet (a position): keyed by the position, the sheet
    // closed itself and the focus fell to the page the moment the bet went in (audit 2026-10-17).
    const open = (bets ? bets.rows : []).map((r) => {
      const x = r.game || {}, known = Number.isFinite(r.startsAt), started = !known || r.startsAt <= now;
      return { k: r.pairId || r.id, stage: !known ? 'wait' : started ? 'live' : 'bet', league: x.league || '', start: r.startsAt, pick: x.pick || r.label, foe: x.foe || '', px: r.mark ?? r.entry,
        status: started ? `Bet ${money(r.cost, 0)} · worth ${money(r.worth, 0)} now` : `Bet ${money(r.cost, 0)} · pays ${money(r.qty, 0)}`, fig: started ? r.pnl : null };
    });
    // A game that has started and was left alone (its favourite over the cap) is not on the board: it is counted
    // (`skipped`). One that has started and is not bet for another reason (no price on one venue, a stale quote, the
    // venues apart, a pairing that came late) is 'late': under way, in progress, never "up next" or "Bets this round"
    // (audit 2026-10-17), and since 2026-10-18 never bet at all: a game is bet only before its start.
    const next = [], skipped = [];
    for (const u of g.upcoming) {
      // the favourite is named by side ('a' or 'b'); with no price there is none, and the first team leads
      u.pick = u.fav === 'a' ? u.a : u.fav === 'b' ? u.b : null;
      const foe = u.pick ? (u.pick === u.a ? u.b : u.a) : u.b, opens = u.startsAt - ahead, begun = u.startsAt <= now;
      if (u.over && begun) { skipped.push(u); continue; }
      next.push({ k: u.id, stage: begun ? 'late' : u.over ? 'skip' : 'next', league: u.league, start: u.startsAt, pick: u.pick || u.a, foe, px: u.px,
        status: !g.on ? 'Not bet: the game bets are switched off' : begun ? (u.px == null ? 'Under way, not bet: no price on both venues' : 'Under way, too late to bet')
          : u.over ? `Left alone: the favourite is ${wholeCents(u.px)}` : opens <= now ? 'Bets this round' : `Bets at ${ET_HM.format(new Date(opens))}` });
    }
    const fin = g.finals.map((f) => ({ k: f.id, stage: f.pnl > 0 ? 'won' : 'lost', league: f.league, start: f.at, day: playedDay(f.at), pick: f.pick, foe: f.foe, px: f.entry,
      status: f.pnl > 0 ? `Won${f.foe ? `: ${f.pick} beat ${f.foe}` : ''}` : `Lost${f.foe ? `: ${f.foe} won` : ''}`, fig: f.pnl }));
    return { g, open, next, fin, skipped, ahead };
  }
  function tileHtml(t) {
    const fin = t.stage === 'won' || t.stage === 'lost';
    const when = t.stage === 'live' ? '<span class="gtlive">Live</span>' : t.stage === 'wait' ? 'Waiting on the result' : t.stage === 'late' ? 'Under way' : fin ? esc(ET_HM.format(new Date(t.start))) : t.start ? esc(whenTxt(t.start)) : '';
    const badge = t.stage === 'won' ? '<span class="gtb pos">Won</span>' : t.stage === 'lost' ? '<span class="gtb neg">Lost</span>' : t.stage === 'skip' ? '<span class="gtb">Skip</span>' : '';
    return `<li data-k="${esc(t.k)}"><button type="button" class="gt st-${t.stage}" data-sheet="game:${esc(t.k)}">` +
      `<span class="gth"><span class="gtl">${esc(leagueName(t.league))}</span><span class="gtw">${when}</span>${badge}</span>` +
      `<span class="gtr gtpick"><i class="gtd" aria-hidden="true"></i><span class="gtn">${esc(t.pick)}<span class="sr">, the pick</span></span><span class="gtp">${t.px != null ? wholeCents(t.px) : ''}</span></span>` +
      `<span class="gtr"><span class="gtn">${esc(t.foe)}</span></span>` +
      `<span class="gts">${t.px != null ? `<span class="gtsp">${wholeCents(t.px)} · </span>` : ''}${esc(t.status)}${t.fig != null ? ` <b class="${tone(t.fig)}">${signed(t.fig)}</b>` : ''}</span></button></li>`;
  }
  // a tile's price to the whole cent: a mid between two quotes read "96.9¢"
  const wholeCents = (p) => (!Number.isFinite(p) ? '' : p >= 0.995 ? '$1' : `${Math.max(1, Math.round(p * 100))}¢`);
  const tiles = (ts) => `<ul class="tiles">${ts.map(tileHtml).join('')}</ul>`;
  // a group of games that start together: how many, and where the book is with them
  function startGroups(ts) {
    const m = new Map();
    for (const t of ts) { const k = t.start ?? 0; if (!m.has(k)) m.set(k, []); m.get(k).push(t); }
    return [...m.entries()].sort((a, b) => a[0] - b[0]);
  }
  function groupStatus(ts, B) {
    // switched off, a group bets nothing, whatever the clock says (its tiles said so and its heading did not)
    if (!B.g.on) return 'not bet: the game bets are switched off';
    const toBet = ts.filter((t) => t.stage === 'next').length, bet = ts.filter((t) => t.stage === 'bet').length, skip = ts.filter((t) => t.stage === 'skip').length;
    const opens = ts[0].start - B.ahead;
    const parts2 = [];
    if (bet) parts2.push(bet === ts.length ? 'all bet' : `${bet} bet`);
    if (toBet) parts2.push(opens <= S.now ? `${toBet === ts.length ? '' : `${toBet} `}betting now`.trim() : `${toBet === ts.length ? 'bets' : `${toBet} bet`} at ${ET_HM.format(new Date(opens))}`);
    if (skip) parts2.push(`${skip} left alone`);
    return parts2.join(', ');
  }
  // Today's card: the day's record, the next few games, and when the next ones are bet
  function tdGamesHtml() {
    const B = board();
    if (!B) return '<p class="ovp">The game bets run on the prediction-market desk, and this frame does not carry it.</p>';
    // today's finals are the games played today, and until 4 AM "today" is still the evening before (playedDay)
    const R = B.g.record.today, td = playedDay(S.now);
    const live = B.open.filter((t) => t.stage === 'live').sort(byStart);
    const soon = [...B.open.filter((t) => t.stage === 'bet'), ...B.next.filter((t) => t.stage === 'next')].sort(byStart);
    const finals = B.fin.filter((t) => t.day === td);
    const head = R.bets
      ? `<div class="verdict"><span class="rec">${R.won}–${R.bets - R.won}</span> <span class="vfig ${tone(R.pnl)}">${signed(R.pnl)}</span></div>` +
        `<p class="ovp">Won ${R.won} of today's ${nOf(R.bets, 'final')}; the prices said ${R.expected.toFixed(1)}.${live.length ? ` ${nOf(live.length, 'game')} in progress.` : ''}</p>`
      : `<div class="verdict zero">${live.length ? `${nOf(live.length, 'game')} in progress` : soon.length ? `${nOf(soon.length, 'game')} to come` : 'No game today'}</div>` +
        `<p class="ovp">No game has finished today yet.${live.length && soon.length ? ` ${soon.length} more to come.` : ''}</p>`;
    const show = [...live, ...soon].slice(0, 6);
    if (show.length < 6) show.push(...finals.slice(0, 6 - show.length));
    const grp = startGroups(soon).find(([st]) => st > S.now);
    const foot = grp ? `<p class="ovnote">Next: ${nOf(grp[1].length, 'game')} at ${esc(whenTxt(grp[0]))} · ${esc(groupStatus(grp[1], B))}.` +
      `${B.skipped.length ? ` ${nOf(B.skipped.length, 'game')} left alone today: the favourite was over ${Math.round((B.g.maxPx || 0.9) * 100)}¢.` : ''}</p>` : '';
    return head + (show.length ? tiles(show) : '') + foot;
  }

  // ------------------------------------------------------------ the crypto rule: against holding, and what it wants
  // The books with a holding to beat that still trade: crypto and SPY. A book has bought in when one of its slots
  // holds something or has a holding price (benchPx), read from its rows: the book's `bench` is null for the
  // seconds after each restart before the first price, too, and the overview said "No book has bought in yet"
  // and "Nothing held yet" on a desk holding $26,000 (found 2026-10-15).
  const boughtIn = (b) => (b.key === 'crypto' || b.key === 'stocks') && b.rows.some((r) => r.qty > 0 || r.benchPx > 0);
  const heldBooks = () => (S.books || []).filter((b) => !isRetired(b) && boughtIn(b));
  const MKT_WORDS = { crypto: 'the coins', stocks: 'SPY' };
  const mktName = (b, r) => (b.key === 'crypto' ? r.label : r.name);
  const share = (r) => (r.worth > 0 ? (r.value || 0) / r.worth : 0);
  const upDown = (x) => (isZero(x) ? 'level' : `${x > 0 ? 'up' : 'down'} ${money(x)}`);
  const aheadTxt = (d) => (d == null ? '' : isZero(d) ? 'level with holding' : `<b class="${tone(d)}">${d > 0 ? 'ahead' : 'behind'} ${money(d)}</b>`);
  const sinceDay = () => ET_DAY.format(new Date(S.startedAt));
  // a time with its day: "Today, 8:00 PM ET", "Yesterday, ...", "Thu, Oct 8, ..."
  const whenFull = (t) => `${dayKey(t) === today() ? 'Today' : dayName(t, today())}, ${ET_HM.format(new Date(t))} ET`;
  // a time, with its day only when it is not today ("Tomorrow 1:00 PM")
  const whenTxt = (t) => `${dayKey(t) === today() ? '' : `${dayName(t, today())} `}${ET_HM.format(new Date(t))}`;
  function vsHold() {
    const bs = heldBooks();
    if (!bs.length) return null;
    // bought in, but with no price yet there is no holding to set against it
    if (bs.some((b) => b.bench == null)) return { bs, waiting: true };
    const pnl = r2(bs.reduce((a, b) => a + b.pnl, 0)), hold = r2(bs.reduce((a, b) => a + b.benchPnl, 0));
    return { bs, pnl, hold, vs: r2(pnl - hold) };
  }
  function tdRuleHtml() {
    const v = vsHold();
    if (!v) return '<p class="ovp">No book has bought in yet, so there is no holding to compare with.</p>';
    if (v.waiting) return `<div class="verdict zero">Waiting on prices</div><p class="ovp">The desk has just started and has no price yet for ` +
      `${listOf(v.bs.map((b) => MKT_WORDS[b.key] || b.name))}. What it holds is counted at what it paid until the first one comes.</p>`;
    const head = isZero(v.vs) ? 'Level with holding' : `${v.vs > 0 ? 'Ahead of' : 'Behind'} just holding by ${money(v.vs)}`;
    return `<div class="verdict ${tone(v.vs)}">${head}</div><p class="ovp">Crypto and SPY are <b class="${tone(v.pnl)}">${upDown(v.pnl)}</b>; ` +
      `bought at each book's first trade and simply held, the same markets would be <b class="${tone(v.hold)}">${upDown(v.hold)}</b>. ` +
      'The rule holds less of a market the harder it swings: it cuts losses, and on its own it does not make money.</p>';
  }
  // each market as a bar: how much of its slot is in it now, and a mark where the rule wants it at today's swings
  function aimsHtml() {
    return heldBooks().flatMap((b) => b.rows.map((r) => {
      const held = share(r), want = Number.isFinite(r.want) ? r.want : Number.isFinite(r.target) ? r.target : null, name = mktName(b, r);
      const w = (x) => (Math.max(0, Math.min(1, x)) * 100).toFixed(1);
      return `<li data-k="aim-${esc(r.sym)}"><button type="button" class="aim" data-sheet="mkt:${esc(r.sym)}" style="--bk:${BOOK_COLOR[b.key]}">` +
        `<span class="an">${esc(name)}</span><span class="av">${pct(held)} held</span>` +
        `<span class="ab" role="img" aria-label="${pct(held)} of its slot held${want != null ? `; the rule wants ${pct(want)}` : ''}"><i style="width:${w(held)}%"></i>${want != null ? `<b style="left:${w(want)}%"></b>` : ''}</span>` +
        `<span class="aw">${Number.isFinite(r.vol) ? `swings ${pct(r.vol)} a year · ` : ''}${want != null ? `the rule wants ${pct(want)}` : 'no reading yet'}</span><i class="chev" aria-hidden="true"></i></button></li>`;
    })).join('');
  }
  // the last trade of a book still trading, and the rule's own reason for it
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
  function tdLastHtml() {
    const f = liveFills()[0], band = Math.round(((S.cfg && S.cfg.rebalBand) || 0.1) * 100);
    const note = `<p class="ovnote">The bar is how much of each slot is in the market; the mark is what the rule wants at today's swings. It trades at its next check when that is ${band} points or more from what it last set.</p>`;
    if (!f) return note;
    const r = fillRow(f), bits = [whenFull(f.at), money(f.value)];
    if (f.side === 'sell' && Number.isFinite(f.pnl)) bits.push(`${plain(signed(f.pnl))} banked`);
    return note + `<ul class="rows">${rowHtml({ k: 'last', sheet: `mkt:${f.sym}`, name: `<b>Last trade:</b> ${esc(r.text)}`, why: esc(`${bits.join(' · ')} · ${moveWhy(f)}`) })}</ul>`;
  }

  // ------------------------------------------------------------ what happens next, across all of it
  const RETESTS = [
    { k: 'rt-odds', t: Date.parse('2026-11-09T15:00:00Z'), text: 'Grade four Sundays of the odds tape', short: 'grade the odds tape' },
    { k: 'rt-dec', t: Date.parse('2026-12-07T15:00:00Z'), text: 'Re-test the game picks and the team model on the college regular season', short: 'the game picks on the college season' },
    { k: 'rt-jan', t: Date.parse('2027-01-25T15:00:00Z'), text: 'Re-test the crypto rule after three months live, and the game picks and the team model on full seasons', short: 'the crypto rule, the picks and the team model' },
    { k: 'rt-mar', t: Date.parse('2027-03-22T14:00:00Z'), text: "Re-run the option labs on six months of the desk's own chains", short: 'the option labs on our own chains' },
  ];
  // when the stock market next opens, from the desk's own words ("opens Mon 9:30 AM ET")
  function nextOpenAt() {
    const m = String((S.market && S.market.says) || '').match(/^opens (\w+) 9:30 AM/);
    if (!m) return null;
    const td = today();
    let k = m[1] === 'today' ? td : m[1] === 'tomorrow' ? addDay(td, 1) : null;
    for (let i = 1; !k && i < 8; i++) { const d = addDay(td, i); if (new Date(`${d}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' }) === m[1]) k = d; }
    if (!k) return null;
    const wall = Date.parse(`${k}T09:30:00Z`) / 1000;
    return (wall - etOffset(wall)) * 1000;
  }
  function nextUp() {
    const now = S.now, ev = [], g = G();
    if (g && g.on) {
      const ahead = (g.aheadH ?? 1) * 3600e3, by = new Map();
      for (const u of g.upcoming) if (u.startsAt > now && !u.over) by.set(u.startsAt, (by.get(u.startsAt) || 0) + 1);
      for (const st of [...by.keys()].sort((a, b) => a - b).slice(0, 3)) {
        const n = by.get(st), at = st - ahead;
        ev.push({ t: Math.max(at, now), now: at <= now, k: `bet-${st}`, href: '#games', color: GAMES_COLOR,
          text: at <= now ? `Betting ${nOf(n, 'game')} that start at ${ET_HM.format(new Date(st))}` : `Bets go in for ${nOf(n, 'game')} starting ${whenTxt(st)}` });
      }
    }
    if (bookOf('crypto')) ev.push({ t: Math.floor(now / 864e5 + 1) * 864e5, k: 'crypto', sheet: 'book:crypto', color: BOOK_COLOR.crypto, text: 'The crypto rule checks its coins' });
    const open = !(S.market && S.market.open) && nextOpenAt();
    if (open && bookOf('stocks')) ev.push({ t: open + 5 * 6e4, k: 'spy', sheet: 'book:stocks', color: BOOK_COLOR.stocks, text: 'The SPY rule checks, a few minutes after the open' });
    for (const tp of (S.lab && S.lab.tapes) || []) {
      if (!tp.kickoff) continue;
      if (tp.reads > now) ev.push({ t: tp.reads, k: `tape-${tp.key}`, sheet: 'lab', color: LAB_COLOR, text: `The ${tp.name.toLowerCase()} starts reading, before ${tp.game || `the ${whenTxt(tp.kickoff)} kickoff`}` });
      else ev.push({ t: now, now: true, k: `tape-${tp.key}`, sheet: 'lab', color: LAB_COLOR, text: `The ${tp.name.toLowerCase()} is reading${tp.game ? `, before ${tp.game} at ${ET_HM.format(new Date(tp.kickoff))}` : ''}` });
    }
    for (const r of RETESTS.filter((x) => x.t > now).slice(0, 2)) ev.push({ t: r.t, k: r.k, sheet: 'lab', color: LAB_COLOR, text: r.text, dateOnly: true });
    return ev.sort((a, b) => a.t - b.t).slice(0, 7);
  }
  function dayLabel(t) {
    const k = dayKey(t), td = today();
    if (k === td) return 'Today';
    if (k === addDay(td, 1)) return 'Tomorrow';
    return t > S.now && t - S.now < 6 * 864e5 ? ET_WEEKDAY.format(new Date(t)) : ET_DATE.format(new Date(t));
  }
  function nextHtml() {
    const ev = nextUp();
    if (!ev.length) return '<li class="empty">Nothing on the clock.</li>';
    return ev.map((e) => {
      const tag = e.sheet ? `button type="button" class="tli" data-sheet="${esc(e.sheet)}"` : `a class="tli" href="${esc(e.href)}"`;
      const when = e.now ? '<span class="tld">Now</span>' : e.dateOnly ? `<span class="tld">${esc(dayLabel(e.t))}</span>` : `<span class="tld">${esc(dayLabel(e.t))}</span>${esc(ET_HM.format(new Date(e.t)))}`;
      return `<li data-k="${esc(e.k)}"><${tag}><span class="tlt${e.now ? ' tlnow' : ''}">${when}</span><span class="tlx"><i class="sw" style="--bk:${e.color}"></i>${esc(e.text)}</span>` +
        `<i class="chev" aria-hidden="true"></i></${tag.split(' ')[0]}></li>`;
    }).join('');
  }

  // ------------------------------------------------------------ the lab: the tapes, the tests, the dates
  // The ideas tested so far and what each found (README has each lab in full). A new test goes in here when it
  // reports; one on test says so.
  const TESTS = [
    { idea: 'Hold less of a coin the harder it swings', verdict: 'The crypto book: it cuts losses against holding; on its own it does not make money (55 coins, 2026-10-08)', kept: true },
    { idea: 'Bet the favourite an hour before the start, not a day', verdict: '+$3.18 a $100 bet in MLB over 2,493 games, so the game bets wait for the last hour (2026-10-16)', kept: true },
    { idea: 'Pick winners: underdogs, line moves, an Elo rating', verdict: 'No picker beat the favourite on 8,068 settled Kalshi games (2026-10-16)', kept: false },
    { idea: 'A team model rated from final scores', verdict: "Kalshi's price beat it in every league, out of sample (2026-10-16)", kept: false },
    { idea: 'ETF rules against owning SPY', verdict: 'Nothing beat buy-and-hold out of sample', kept: false },
    { idea: 'Sell SPY options: covered calls, put writing', verdict: '0 of 24 settings beat owning SPY, out of sample (2026-09-24)', kept: false },
    { idea: "SPY same-day options: trend days, scalps, Evan's dips", verdict: 'No edge over two years of minutes; the three books were retired (2026-10-08)', kept: false },
    { idea: 'Chase coins that are popping', verdict: 'Lost over four years, even before fees; the runners book was retired (2026-10-08)', kept: false },
    { idea: 'Copy the top sports wallets on Polymarket', verdict: 'No, out of sample', kept: false },
    { idea: 'Trade a coin on the X headline feed', verdict: 'No edge in 894 posts over ten days (2026-10-08)', kept: false },
    { idea: "Kalshi's temperature markets against the forecast", verdict: 'No edge, out of sample', kept: false },
    { idea: 'Bet that two venues apart will come back together', verdict: 'Lost on paper; convergence was switched off (2026-09-21)', kept: false },
    { idea: 'Does Kalshi trail the sharp sportsbook by more than its fee?', verdict: 'On test: the odds tape logs Pinnacle beside Kalshi before every NFL kickoff, graded on Nov 9', kept: 'testing' },
  ];
  // how often each tape runs, so one that has gone quiet says so: every 8 minutes, every 15, each weekday's close
  const TAPE_QUIET_H = { odds: 0.5, td: 1, chains: 80 };
  const ago = (t) => { const s = Math.max(0, Math.round((S.now - t) / 1000)); return s < 90 ? `${s} second${s === 1 ? '' : 's'} ago` : s < 5400 ? `${Math.round(s / 60)} minutes ago` : s < 36 * 3600 ? `${Math.round(s / 3600)} hours ago` : `on ${ET_DATE.format(new Date(t))}`; };
  function tapeState(t) {
    if (t.state === 'none' || !t.at) return { cls: 'warn', glyph: '–', word: 'Not running here', line: 'No run on record on this machine' };
    if (S.now - t.at > (TAPE_QUIET_H[t.key] || 2) * 3600e3) return { cls: 'warn', glyph: '!', word: 'Quiet', line: `Last ran ${ago(t.at)}: ${t.text}` };
    if (t.state === 'problem') return { cls: 'bad', glyph: '!', word: 'Problem', line: `${cap(t.text)} · ${ago(t.at)}` };
    if (t.state === 'idle') return { cls: 'idle', glyph: '○', word: 'Waiting', line: `${cap(t.text)} · ${ago(t.at)}` };
    return { cls: 'ok', glyph: '✓', word: 'Recording', line: `${cap(t.text)} · ${ago(t.at)}` };
  }
  const tapeName = (t, st) => `<span class="mark ${st.cls}" aria-hidden="true">${st.glyph}</span><span class="sr">${st.word}: </span>${esc(t.name)}`;
  function tdLabHtml() {
    const tapes = (S.lab && S.lab.tapes) || [], done = TESTS.filter((t) => t.kept !== 'testing'), kept = done.filter((t) => t.kept === true).length;
    const testing = TESTS.filter((t) => t.kept === 'testing');
    const rt = RETESTS.find((r) => r.t > S.now);
    return `<button type="button" class="labsum" data-sheet="lab" style="--bk:${LAB_COLOR}"><span class="lsn"><b>${done.length}</b> ideas tested · <b>${kept}</b> kept</span>` +
      `<span class="lsw">${testing.length ? `On test now: ${esc(testing[0].idea.replace(/\?$/, ''))}.` : 'Nothing on test now.'}</span><i class="chev" aria-hidden="true"></i></button>` +
      (tapes.length ? `<ul class="rows">${tapes.map((t) => { const st = tapeState(t); return rowHtml({ k: `tape-${t.key}`, sheet: 'lab', name: tapeName(t, st), why: esc(st.line) }); }).join('')}</ul>` : '') +
      (rt ? `<p class="ovnote">Next re-test: <b>${esc(ET_DATE.format(new Date(rt.t)))}</b>, ${esc(rt.short)}, in ${nOf(Math.ceil((rt.t - S.now) / 864e5), 'day')}.</p>` : '');
  }

  // ------------------------------------------------------------ the arbs, the maker and the snipe, on Today
  function tdSideHtml() {
    return SIDE.map(pmBook).filter((b) => b && (b.on || b.rows.length || !isZero(b.pnl))).map((b) => {
      const x = pmBits(b);
      return rowHtml({ k: `side-${b.key}`, href: `#markets/pm-${b.key}`, color: SIDE_COLOR, name: `${esc(b.name)}${b.on ? '' : ' <span class="offtag">Off</span>'}`, fig: b.pnl,
        why: b.on ? `${esc(cap(x.chip))} · ${x.next}` : x.next });
    }).join('');
  }

  // ------------------------------------------------------------ a line of a list, and the health
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
  // when a book checks next, in words: crypto after midnight UTC, SPY a few minutes after the open
  const LONG_DAY = { Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday', Sat: 'Saturday' };
  const nextOpenDay = () => { const m = String((S.market && S.market.says) || '').match(/^opens (\w+)/); return m ? m[1] : null; };
  function nextCheck(b) {
    if (b.key === 'crypto') {
      const t = Math.floor(S.now / 864e5 + 1) * 864e5, k = dayKey(t);
      return `${k === today() ? 'tonight' : k === dayKey(S.now + 864e5) ? 'tomorrow' : ET_DATE.format(new Date(t))} at ${ET_HM.format(new Date(t))} ET`;
    }
    if (S.market && S.market.open) return b.rows.some((r) => r.checkDay === today()) ? 'done today; next after the next open' : 'today, a few minutes after the open';
    const n = nextOpenDay();
    return n ? `${LONG_DAY[n] || n} after the 9:30 AM open` : 'after the next open';
  }
  // is anything wrong: the light in the bar says it in a word; these say what it looked at
  function healthChecks() {
    const M = marketBits(), C = S.cfg || {}, coins = (bookOf('crypto') || { rows: [] }).rows;
    const at = Math.max(0, ...coins.map((r) => r.at || 0));
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

  function renderToday() {
    morph($('tdhero'), todayHeroHtml());
    morph($('tdgames'), tdGamesHtml());
    morph($('tdrule'), tdRuleHtml());
    morph($('aims'), aimsHtml());
    morph($('tdlast'), tdLastHtml());
    morph($('tdnext'), nextHtml());
    morph($('tdlab'), tdLabHtml());
    const side = $('tdside').closest('.card');
    side.hidden = !S.legacy;
    if (S.legacy) morph($('tdside'), tdSideHtml());
    morph($('health'), healthHtml());
  }

  // ------------------------------------------------------------ the Games view
  // The record, then a tile per game: in progress, up next in groups that start together, and the finals by day.
  // A league can be picked (remembered here, in this browser).
  const games = { league: 'all' };
  try { const v = JSON.parse(localStorage.getItem('desk-games') || '{}'); if (typeof v.league === 'string') games.league = v.league; } catch { /* defaults */ }
  // a share to a whole point, and to a tenth under ten
  const rateTxt = (n, d) => (d ? pct(n / d, n / d < 0.1 ? 1 : 0) : '—');
  function gheroHtml(B) {
    const R = B.g.record, t = R.today;
    // the wins a fair price expects, and how far chance alone moves that: one standard deviation, from the prices'
    // average (the spread of each game's own chance is not in the frame, so this is close, not exact)
    const p = R.bets ? R.expected / R.bets : 0, sd = Math.sqrt(R.bets * p * (1 - p)), diff = R.won - R.expected;
    const verdict = !R.bets ? 'No game has settled yet.'
      : `${Math.abs(diff).toFixed(1)} ${diff >= 0 ? 'more' : 'fewer'} wins than the prices expected over ${nOf(R.bets, 'game')}: ` +
        `${Math.abs(diff) <= 2 * sd ? `well inside chance (one standard deviation is ${sd.toFixed(1)} wins)` : `more than chance usually gives (one standard deviation is ${sd.toFixed(1)} wins)`}. ` +
        "Bought at the market's own price, the book should lose about the fee over many games; that is the yardstick.";
    const leagues = Object.entries(R.leagues || {}).filter(([, x]) => x.bets).sort((a, b) => b[1].bets - a[1].bets);
    return `<div class="ghs">` +
      `<div class="ghb"><span class="ghl">Today</span><span class="ghr">${t.won}–${t.bets - t.won}</span><span class="ghp">${t.bets ? `${figure(t.pnl)} · the prices said ${t.expected.toFixed(1)} wins` : 'no final yet'}</span></div>` +
      `<div class="ghb"><span class="ghl">Since the start</span><span class="ghr">${R.won}–${R.bets - R.won}</span><span class="ghp">${figure(R.pnl)} on ${money(R.staked, 0)} bet and settled</span></div>` +
      `<div class="ghb"><span class="ghl">Won</span><span class="ghr">${rateTxt(R.won, R.bets)}</span><span class="ghp">the prices said ${rateTxt(R.expected, R.bets)}</span></div></div>` +
      `<p class="ovp">${esc(verdict)}</p>` +
      (leagues.length ? `<table class="lg-t"><thead><tr><th>League</th><th>Bets</th><th>Won</th><th>Prices said</th><th>P&amp;L</th></tr></thead><tbody>` +
        leagues.map(([k, x]) => `<tr data-k="lg-${esc(k)}"><th>${esc(leagueName(k))}</th><td>${x.bets}</td><td>${x.won} <small>${rateTxt(x.won, x.bets)}</small></td><td>${x.expected.toFixed(1)}</td><td>${figure(x.pnl)}</td></tr>`).join('') +
        '</tbody></table>' : '') +
      `<p class="ovnote">${B.g.on ? `Every ${esc(listOf(B.g.leaguesOn.map(leagueName)))} game is bet once, $${B.g.stake} on the favourite, in the hour before it starts.` : 'The game bets are switched off: open bets ride to the final.'}</p>`;
  }
  function gsecHtml(title, sub, body) {
    return body ? `<div class="gsh"><h2 class="sect">${esc(title)}</h2>${sub ? `<span class="gsn">${sub}</span>` : ''}</div>${body}` : '';
  }
  function renderGames() {
    const B = board();
    if (!B) {
      morph($('ghero'), '<p class="ovp">The game bets run on the prediction-market desk, and this frame does not carry it.</p>');
      for (const id of ['gleague', 'glive', 'gnext', 'gfinal']) morph($(id), '');
      return;
    }
    morph($('ghero'), gheroHtml(B));
    const all = [...B.open, ...B.next, ...B.fin];
    const present = [...new Set([...B.g.leaguesOn, ...all.map((t) => t.league).filter(Boolean)])];
    if (games.league !== 'all' && !present.includes(games.league)) games.league = 'all';
    const opts = [['all', 'All'], ...present.map((l) => [l, leagueName(l)])];
    morph($('gleague'), opts.map(([k, name]) => `<button type="button" data-league="${esc(k)}" class="${k === games.league ? 'on' : ''}" aria-pressed="${k === games.league}">${esc(name)}</button>`).join(''));
    const mine = (t) => games.league === 'all' || t.league === games.league;
    const live = [...B.open.filter((t) => t.stage === 'live' && mine(t)).sort(byStart), ...B.next.filter((t) => t.stage === 'late' && mine(t)), ...B.open.filter((t) => t.stage === 'wait' && mine(t))];
    morph($('glive'), gsecHtml('In progress', nOf(live.length, 'game'), live.length ? tiles(live) : ''));
    const soon = [...B.open.filter((t) => t.stage === 'bet'), ...B.next.filter((t) => t.stage !== 'late')].filter(mine).sort(byStart);
    morph($('gnext'), gsecHtml('Up next', soon.length ? nOf(soon.length, 'game') : '', startGroups(soon).map(([st, ts]) =>
      `<div class="ggrp" data-k="g-${st}"><h3><span>${esc(st ? whenTxt(st) : 'Start not on record')}</span><span class="gsn">${nOf(ts.length, 'game')} · ${esc(groupStatus(ts, B))}</span></h3>${tiles(ts)}</div>`).join('')) ||
      (live.length ? '' : `<div class="gsh"><h2 class="sect">Up next</h2></div><p class="ovp">No game on the board in the next thirty hours${games.league === 'all' ? '' : ` in ${esc(leagueName(games.league))}`}.</p>`));
    const fin = B.fin.filter(mine), byDay = new Map();
    for (const t of fin) { const k = t.day; if (!byDay.has(k)) byDay.set(k, []); byDay.get(k).push(t); }
    morph($('gfinal'), gsecHtml('Final', '', [...byDay.entries()].map(([k, ts]) => {
      const won = ts.filter((t) => t.stage === 'won').length, pnl = r2(ts.reduce((a, t) => a + t.fig, 0));
      return `<div class="ggrp" data-k="f-${k}"><h3><span>${esc(k === playedDay(S.now) ? 'Today' : dayName(Date.parse(`${k}T16:00:00Z`), playedDay(S.now)))}</span><span class="gsn">${won}–${ts.length - won} · ${figure(pnl)}</span></h3>${tiles(ts)}</div>`;
    }).join('')));
  }
  $('gleague').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-league]');
    if (!b) return;
    games.league = b.dataset.league;
    try { localStorage.setItem('desk-games', JSON.stringify(games)); } catch { /* private window */ }
    if (S) renderGames();
  });

  // ------------------------------------------------------------ sheets: the Hexagon, a book, a market, a game, the lab, the health
  // One sheet at a time over the page, drawn from the latest frame on every frame; a line in it can open
  // another, and Back returns. A link to a view (a book's card, Activity) closes it, as any change of view does.
  const card = (title, html) => `<section class="card shcard">${title ? `<h3 class="shlab">${title}</h3>` : ''}${html}</section>`;
  const kv = (pairs) => `<dl class="kv">${pairs.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  function tradeList(fills, here) {
    if (!fills.length) return '<p>No trade yet.</p>';
    return `<ul class="rows">${fills.slice(0, 30).map((f) => {
      const r = fillRow(f), held = f.book === 'crypto' || f.book === 'stocks';
      return rowHtml({ k: f.id, sheet: held && f.sym !== here ? `mkt:${f.sym}` : null, name: esc(r.text), fig: r.pnl,
        why: `${esc(whenFull(f.at))}${r.sub ? ` · ${esc(r.sub)}` : ''}` });
    }).join('')}</ul>`;
  }
  // the whole Hexagon: its total, its parts, and the retired books
  function deskSheet() {
    const T = totals(), { fees, atWork, cash } = deskTotals(), books = S.books || [];
    const live = books.filter((b) => !isRetired(b)), gone = books.filter(isRetired);
    const line = (b) => rowHtml({ k: b.key, sheet: boughtIn(b) ? `book:${b.key}` : null, color: BOOK_COLOR[b.key], name: esc(b.name), fig: b.pnl,
      why: `${money(b.initial)} at the start · ${money(b.equity)} now` });
    const ps = parts().filter((p) => p.k !== 'desk');
    return { title: 'The Hexagon', html:
      card('', `<div class="shfig">${money(T.equity)}</div><p>${figure(T.pnl)} on ${money(T.initial, 0)} of paper, in ${S.legacy ? 'three parts' : 'one part'}. No real money.</p>`) +
      card('Crypto & SPY', `<ul class="rows">${live.map(line).join('')}</ul>` + kv([['In the market', money(atWork)], ['Cash', money(cash)], ['Fees paid', money(fees)]])) +
      (ps.length ? card('The prediction-market desk', `<ul class="rows">${ps.map((p) => rowHtml({ k: p.k, href: p.href, color: p.color, name: esc(p.name), fig: p.pnl, why: esc(p.sub) })).join('')}</ul>` +
        `<p>Its own paper: ${money(S.legacy.equity)} from ${money(S.legacy.initial, 0)}.</p>`) : '') +
      (gone.length ? card('Retired', `<ul class="rows">${gone.map((b) => rowHtml({ k: b.key, color: null, name: esc(b.name), fig: b.pnl, why: 'retired 2026-10-17 · holds nothing' })).join('')}</ul>` +
        `<p>Together ${figure(r2(gone.reduce((a, b) => a + b.pnl, 0)))}, still inside the Crypto &amp; SPY figure. Their labs found no edge; their rules are kept for the labs.</p>`) : '') };
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
      `<p class="shlink"><a href="#markets/${key}">Its card on Markets</a></p>` };
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
  const change = (c) => (c == null ? '' : `<span class="${tone(c, 4)}">${isZero(c, 4) ? '0.00%' : `${c > 0 ? '+' : MINUS}${Math.abs(c * 100).toFixed(2)}%`}</span>`);
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
  // one game: the bet the book holds, the one it settled, or the game it has still to bet
  function gameSheet(id) {
    const g = G(), bets = pmBook('bets');
    if (!g) return null;
    const rule = card('The rule', `<p>${esc((bets && bets.rule) || '')}</p>`) + '<p class="shlink"><a href="#games">Every game</a></p>';
    const r = bets && bets.rows.find((x) => x.id === id || x.pairId === id);
    if (r) {
      const x = r.game || {}, started = Number.isFinite(r.startsAt) && r.startsAt <= S.now;
      return { title: x.pick ? `${x.pick} over ${x.foe}` : r.label, html:
        card('', `<div class="shfig ${tone(r.pnl)}">${signed(r.pnl)}</div><p>${esc(leagueName(x.league))}${r.startsAt ? ` · ${started ? 'started' : 'starts'} ${esc(whenFull(r.startsAt))}` : ' · the start is not on record'}</p>`) +
        card('The bet', kv([['On', esc(x.pick || r.label)], ['Bought', `${nOf(r.qty, 'contract')} of ${esc(cap(r.side))} on ${esc(r.venue)} at ${cents(r.entry)}`],
          ['Cost', money(r.cost)], ['Pays if they win', money(r.qty)], ['Worth now', `${money(r.worth)} at ${cents(r.mark)}`]])) + rule };
    }
    const f = g.finals.find((x) => x.id === id);
    if (f) {
      return { title: f.foe ? `${f.pick} over ${f.foe}` : f.pick, html:
        card('', `<div class="shfig ${tone(f.pnl)}">${signed(f.pnl)}</div><p>${f.pnl > 0 ? 'Won' : 'Lost'} · ${esc(leagueName(f.league))} · settled ${esc(whenFull(f.at))}</p>`) +
        card('The bet', kv([['On', esc(f.pick)], ['Bought', `${nOf(f.qty, 'contract')} on ${esc(f.venue)} at ${cents(f.entry)}${f.openedAt ? `, ${esc(whenFull(f.openedAt))}` : ''}`],
          ['Cost', money(f.cost)], ['Result', f.pnl > 0 ? `${esc(f.pick)} won: paid ${money(f.qty)}` : `${esc(f.foe || 'the other side')} won: paid nothing`]])) + rule };
    }
    const u = g.upcoming.find((x) => x.id === id);
    if (u) {
      const opens = u.startsAt - (g.aheadH ?? 1) * 3600e3;
      return { title: `${u.a} v ${u.b}`, html:
        card('', `<div class="shfig">${u.px != null ? cents(u.px) : '—'}</div><p>${u.pick ? `${esc(u.pick)}, the favourite` : 'No price yet'} · ${esc(leagueName(u.league))} · ${u.startsAt > S.now ? 'starts' : 'started'} ${esc(whenFull(u.startsAt))}</p>`) +
        card('The bet', `<p>${!g.on ? 'The game bets are switched off.' : u.over ? `Left alone: a favourite over ${Math.round((g.maxPx || 0.9) * 100)}¢ is a game all but decided.`
          : opens <= S.now ? `Bets this round: $${g.stake} on ${esc(u.pick || 'the favourite')}, at whichever venue sells it cheaper after its fee.`
            : `Bets at ${esc(ET_HM.format(new Date(opens)))} ET, an hour before the start: $${g.stake} on whichever team is the favourite then.`}</p>`) + rule };
    }
    return null;
  }
  function labSheet() {
    const tapes = (S.lab && S.lab.tapes) || [];
    return { title: 'The lab', html:
      card('', `<p>A third of the Hexagon's work since 2026-10-17: collect what cannot be fetched later, test each idea the same way (a train and a holdout, ±2 standard errors, the fee in), and re-test on fixed dates. No new book without that.</p>`) +
      (tapes.length ? card('The tapes', `<ul class="rows">${tapes.map((t) => {
        const st = tapeState(t);
        return rowHtml({ k: t.key, name: tapeName(t, st), why: `${esc(t.what)}<br>${esc(st.line)}${t.kickoff ? ` · next ${t.reads > S.now ? `reads ${esc(whenFull(t.reads))}` : 'reading now'}` : ''}` });
      }).join('')}</ul>`) : '') +
      card('The dates', `<ul class="rows">${RETESTS.map((r) => rowHtml({ k: r.k, name: `<b>${esc(ET_DATE.format(new Date(r.t)))}</b> · ${esc(r.text)}`, why: r.t > S.now ? `in ${nOf(Math.ceil((r.t - S.now) / 864e5), 'day')}` : 'done' })).join('')}</ul>`) +
      card('Tested so far', `<ul class="rows">${TESTS.map((t, i) => rowHtml({ k: `t${i}`, name: `<span class="mark ${t.kept === true ? 'ok' : t.kept === 'testing' ? 'idle' : 'no'}" aria-hidden="true">${t.kept === true ? '✓' : t.kept === 'testing' ? '○' : '×'}</span>` +
        `<span class="sr">${t.kept === true ? 'Kept: ' : t.kept === 'testing' ? 'On test: ' : 'Not kept: '}</span>${esc(t.idea)}`, why: esc(t.verdict) })).join('')}</ul>`) };
  }
  function healthSheet() {
    // the prediction desk's light is read from the last frame too, so with no signal it has none either
    const [state, cls] = deskState(), pm = S.legacy ? (stale() ? ['No signal', 'bad'] : pmState(S.legacy)) : null;
    const line = (c) => rowHtml({ k: c.k, href: c.href, name: checkName(c), why: c.detail ? esc(c.detail) : '' });
    return { title: 'Health', html:
      card('', `<div class="shfig st-${cls}">${esc(state)}</div><p>The light in the bar turns amber when prices are stale or the desk is not buying, and red when the desk stops or this page loses its signal.</p>`) +
      card('Checks', `<ul class="rows">${healthChecks().map(line).join('')}</ul>`) +
      (pm ? card('Prediction markets', `<ul class="rows">${line({ k: 'pm', href: '#markets/side', ok: pm[1] === 'good' ? 'ok' : pm[1], name: pm[0], detail: 'Its own loop, trading the games, arbs and maker in paper beside the books' })}</ul>`) : '') };
  }
  // A sheet's id is its kind and, after the first colon, what it is of: "game:5348755:0|KXNCAAFGAME-...-KU" is a
  // game pair's id, colons and all.
  function sheetOf(id) {
    const s = String(id), i = s.indexOf(':'), kind = i < 0 ? s : s.slice(0, i), arg = i < 0 ? '' : s.slice(i + 1);
    return kind === 'desk' ? deskSheet() : kind === 'health' ? healthSheet() : kind === 'book' ? bookSheet(arg) : kind === 'mkt' ? mktSheet(arg)
      : kind === 'game' ? gameSheet(arg) : kind === 'lab' ? labSheet() : null;
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
    // here, and go to the card again when the link is to the address already showing.
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

  // ------------------------------------------------------------ Markets: crypto and SPY in full
  // what the headline says: the books against simply holding, the fees, the cash
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
    return `<span class="label">Crypto &amp; SPY</span>` +
      `<div class="big ${tone(S.pnl)}">${signed(S.pnl)}</div>` +
      `<div class="sub">on ${money(S.initial, 0)} of paper · marked ${esc(ET_HM.format(new Date(S.now)))} ET</div>` +
      `<dl class="kpis">${kpi('Today', S.today != null ? figure(S.today) : '—')}` +
      `${kpi('vs. just holding', vs != null ? figure(vs) : '—', VS_HOLD)}` +
      `${kpi('Fees paid', money(fees), 'Every book’s fees since the start, the retired books’ too')}${kpi('Invested', `${money(atWork, 0)}<small>${money(cash, 0)} in cash</small>`)}</dl>` +
      (insight ? `<p class="insight">${insight}</p>` : '');
  }
  // the market and how fresh its prices are
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
    const sha = S.build && S.build.sha ? String(S.build.sha).slice(0, 7) : 'dev';
    // Since when (it read "Running 19h 02m", which sounds like time since the last restart), and when the
    // last round finished, the heartbeat behind the Stalled light
    const since = new Date(S.startedAt), agoS = S.beat ? Math.max(0, Math.round((S.now - S.beat) / 1000)) : null;
    const beat = agoS == null ? '' : ` · last round ${agoS < 120 ? `${agoS}s ago` : `at ${ET_HM.format(new Date(S.beat))}`}`;
    return `<span class="label">The desk</span><dl class="facts">${rows.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>` +
      `<p class="deskfoot">Running since ${esc(ET_DAY.format(since))}, ${esc(ET_HM.format(since))}${beat} · build ${esc(sha)}</p>`;
  }
  // A desk starts all cash, level with its capital, and records its first minute just after its first buys,
  // with their fees paid: on the box, 21:35:20 on 25 September, five seconds in, at −$31.99. While a line's
  // first point is that minute (the history keeps about three weeks), the line begins at zero at the start,
  // where the desk did. Measured from that first minute, the chart read +$29.76 over a desk that was −$2.23.
  function beganAt(t, start) { return start > 0 && t > start && t - start < 10 * 6e4; }
  // The book's own P&L over its history (and simply holding, dashed), from /api/desk/history's per-book values.
  function sparkSvg(key) {
    const field = { crypto: 'c', stocks: 's' }[key], benchField = { crypto: 'bc', stocks: 'bs' }[key];
    const init = (hist.books || {})[key], b = bookOf(key);
    let series = init && field ? hist.points.filter((p) => p[field] != null).map((p) => [p.t, p[field] - init, benchField && p[benchField] != null ? p[benchField] - init : null]) : [];
    // a line 40px tall needs a few hundred points, and the history sends up to three thousand
    const every = Math.ceil(series.length / 400);
    if (every > 1) series = series.filter((_, i) => i % every === 0 || i === series.length - 1);
    if (b) series.push([S.now, b.pnl, b.bench != null ? b.benchPnl : null]);
    if (b && series.length && beganAt(series[0][0], b.startedAt)) series.unshift([b.startedAt, 0, series[0][2] != null ? 0 : null]);
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
    const checked = b.rows.some((r) => r.checkDay === today());
    return S.market && S.market.open ? (checked ? 'Checked today; checks again after the next open' : 'Checks once a trading day, after the open')
      : `Checks at the next open: <b>${esc(String((S.market && S.market.says) || '').replace(/^opens /, ''))}</b>`;
  }
  // A book that has never traded is its figure, its markets and its next check: no line that has never moved.
  function bookCard(b) {
    const held = b.rows.filter((r) => r.qty > 0).length;
    const traded = held || b.fees || !isZero(b.realized || 0);
    const vs = b.bench != null ? `<span class="vs" title="Simply holding what this book trades, from its first trade${b.benchFee ? `, after its ${plain(money(b.benchFee))} fee to buy in` : ''}">` +
      `just holding <b class="${tone(b.benchPnl)}">${signed(b.benchPnl)}</b></span>` : '';
    // the two figures on each row are named once, over them, when the book holds something
    const head = held ? '<thead><tr><th></th><th>Worth</th><th>P&amp;L</th></tr></thead>' : '';
    const body = b.rows.length ? `<table class="hold-t">${head}<tbody>${b.rows.map((r) => holdRow(b, r)).join('')}</tbody></table>` : '<p class="bksub">Nothing held yet.</p>';
    return `<article class="card bk" data-k="${b.key}" data-anchor="${b.key}" style="--bk:${BOOK_COLOR[b.key] || 'var(--ink-3)'}" aria-label="${esc(b.name)} book">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${held ? `${held} held` : 'not holding yet'}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<p class="now">${nextLine(b)}</p>` +
      `<div class="bksub">worth ${money(b.equity)} of ${money(b.initial, 0)}${b.fees ? ` · fees ${money(b.fees)}` : ''}${b.realized && !isZero(b.realized) ? ` · banked ${signed(b.realized)}` : ''}</div>` +
      (traded ? sparkSvg(b.key) : '') + body +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule)}</p></details></article>`;
  }

  // ------------------------------------------------------------ Markets: the arbs, the maker, the snipe
  // The desk Hexagon began as, pricing the same outcomes on Polymarket and Kalshi, trades in paper in the same
  // process (src/pmfloor.js builds what the frame carries as `legacy`), with a contract's price in cents, the way
  // those markets quote it. Its game bets are the Games view; the rest of its books are here.
  const ET_DAY_Y = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric', year: 'numeric' });
  const yearOf = (t) => ET_YMD.format(new Date(t)).slice(-4);
  // a no-break space keeps "Oct 3" on one line; a date in another year says the year
  const settleDay = (t) => (yearOf(t) === yearOf(nowT()) ? ET_DAY : ET_DAY_Y).format(new Date(t)).replace(' ', ' ');
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
  // a taker position the snipe or convergence holds: one leg on one venue
  const legRow = (r) => `<tr data-k="${esc(r.id)}"><th><span class="nm">${esc(r.label)}</span>` +
    `<small>${esc(`${r.startsAt ? `${r.startsAt > S.now ? 'starts' : 'started'} ${whenTxt(r.startsAt)} · ` : ''}${cap(r.side)} on ${r.venue} · ${nOf(r.qty, 'contract')} at ${cents(r.entry)}, ${cents(r.mark)} now`)}</small></th>` +
    `<td class="v">${money(r.worth)}</td><td>${figure(r.pnl)}</td></tr>`;
  // Today's line and a book's card say the same things: its chip and what it does next (the card has its
  // figure's comparison, its rows and its rule as well)
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
    return `<article class="card bk pmbk" data-k="${k}" data-anchor="${k}" style="--bk:${SIDE_COLOR}" aria-label="${esc(b.name)}, prediction markets">` +
      `<header><i class="sw"></i><h3>${esc(b.name)}</h3><span class="chip">${esc(chip)}</span></header>` +
      `<div class="figline"><span class="fig ${tone(b.pnl)}">${signed(b.pnl)}</span>${vs}</div>` +
      `<p class="now">${next}</p>${sub ? `<div class="bksub">${sub}</div>` : ''}${body}` +
      `<details class="rule"><summary>How this book trades</summary><p>${esc(b.rule || '')}</p></details></article>`;
  }
  function sideHtml() {
    const L = S.legacy, [state, cls] = pmState(L), books = SIDE.map(pmBook).filter(Boolean);
    const side = r2((L.pnl || 0) - ((pmBook('bets') || {}).pnl || 0));
    return `<div class="sidehead" data-anchor="side"><div class="cardhead"><h2 class="sect">Arbs, maker and snipe</h2>` +
      `<span class="pill ${cls}"><i></i>${esc(state)}<span class="mode">Paper</span></span></div>` +
      `<p class="lede">The prediction-market desk's other books, on its own paper beside the games: <b>${figure(side)}</b> together, counting what is open at today's prices` +
      `${L.halt ? ` · ${esc(L.halt)}` : ''}. <a class="pmold" href="/pm">Every market, on its old page ›</a></p></div>` +
      `<div class="pmbooks">${books.map(pmCard).join('')}</div>`;
  }
  function renderMarkets() {
    morph($('hero'), heroHtml());
    morph($('deskcard'), deskHtml());
    morph($('books'), ['crypto', 'stocks'].map(bookOf).filter(Boolean).map(bookCard).join(''));
    $('side').hidden = !S.legacy;
    if (S.legacy) morph($('side'), sideHtml());
    const gone = (S.books || []).filter(isRetired);
    $('retired').hidden = !gone.length;
    if (gone.length) morph($('retired'), `Retired on 2026-10-17: ${esc(listOf(gone.map((b, i) => (i ? b.name.toLowerCase() : b.name))))}. Together ` +
      `${figure(r2(gone.reduce((a, b) => a + b.pnl, 0)))}, still inside the figure above. Their labs found no edge, and they hold nothing. ` +
      '<button type="button" class="seeall" data-sheet="desk">Each one</button>');
  }
  $('v-markets').addEventListener('click', (ev) => {
    const t = ev.target.closest('[data-all]');
    if (!t) return;
    if (allRows.has(t.dataset.all)) allRows.delete(t.dataset.all); else allRows.add(t.dataset.all);
    if (S) renderMarkets();
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
  // Its tag says which part a line is about, in the part's colour; the bot that wrote it is named when the tag is
  // pointed at. A line about one book starts with its name ("scalps: SPY broke above ..."), which the tag then says
  // instead; a coin's or SPY's line is the crypto or stocks book's; the rest is the desk's.
  const ROLE = { HOLT: 'prices', ILSA: 'volatility', TESS: 'risk', RIGO: 'marks', BRAM: 'signals', KETT: 'fills', PRED: 'the prediction-market desk', MAKR: 'the maker' };
  const DESK_TAG = { name: 'Desk', color: 'var(--ink-3)' };
  const tagOf = (k) => ({ name: (bookOf(k) || {}).name || cap(k), color: BOOK_COLOR[k] || 'var(--ink-3)' });
  function logRow(e) {
    let text = grouped(String(e.text || '')), tag = DESK_TAG;
    const m = text.match(/^(options|scalps|dips|runners):\s*/i);
    if (m) { tag = tagOf(m[1].toLowerCase()); text = text.slice(m[0].length); }
    else if (/^(BTC|ETH|SOL|XRP|DOGE):/.test(text)) tag = tagOf('crypto');
    else if (/^SPY:/.test(text)) tag = tagOf('stocks');
    const parts2 = text.split(' · ');
    return { t: e.t, who: e.agent, tag, text: cap(parts2[0]), sub: parts2.slice(1).join(' · '), level: e.level || 'info', pnl: null, key: logKey(e), halt: e.kind === 'HALT' };
  }
  // A trade is a row from the ledger's own fills, not from the log. On 26 September the routine rounds had
  // pushed the log lines of the desk's three buys out of the frame in eight hours, and this list said
  // "Nothing of those kinds yet" beside a book holding all three coins; the frame's eighty fills do not
  // age out that way. A fill's log line says the same thing, so it is left out.
  // (The retired books' fills, options contracts and runners' coins, still come in the frame and read as they did.)
  const optBook = (k) => k === 'options' || k === 'scalps' || k === 'dips';
  const runQty = (q) => (+q).toLocaleString('en-US', { maximumFractionDigits: q >= 1000 ? 0 : q >= 1 ? 2 : 6 });
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
  // name this floor gives that desk, and the maker's under its own, MAKR; a fill is tagged with its book, a game
  // bet in the games' colour and the rest in the side books'.
  const pmWho = (agent) => (agent === 'MAKR' ? 'MAKR' : 'PRED');
  const PM_TAG = { arb: 'Arbs', snipe: 'Snipe', converge: 'Convergence', maker: 'Maker', bet: 'Games' };
  const pmTag = (name) => ({ name, color: name === 'Games' ? GAMES_COLOR : SIDE_COLOR });
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
  // few trades out of sight, so they are shown only when asked for. Two segmented controls, each one choice:
  // how much (each takes in the one before it, and a warning is always shown), and which part.
  const SHOWS = [['trades', 'Trades', ['trade', 'warn']], ['decisions', 'Trades & signals', ['trade', 'info', 'warn']], ['all', 'Everything', ['trade', 'info', 'warn', 'quiet']]];
  const DESKS = [['both', 'All of it'], ['desk', 'Crypto & SPY'], ['pm', 'Games, arbs & maker']];
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

  // ------------------------------------------------------------ the chart: crypto and SPY, and what holding would have made
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
      if (S && view === 'markets') renderMarkets();
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
  // points: [t, the books' P&L, holding's P&L|null]: crypto and SPY against simply holding the same markets (the
  // history's c and s, bc and bs fields). The live end comes from the stream, the rest from history.
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
  // The chart sits under its question, and in the large sheet under that sheet's own title, so it carries no title
  // of its own; the card's "Large chart" opens it large
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
    // others wait the same way while their view is not showing, and are drawn as it opens
    if (!p || (p.big && bigChart.hidden) || (!p.big && el.closest('[hidden]'))) return;
    const pts = chartSeries();
    const last = pts.length ? pts[pts.length - 1][1] : (S ? S.pnl : 0);
    const first = pts.length ? pts[0][1] : last;
    // The figure is what changed over the range shown: over all of it, crypto's and SPY's total since their start
    // (not the headline's figure, which counts the retired books too); over 1h, 6h or 24h, the move in that window.
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
  // #today, #games, #markets and #activity, and #markets/<card> for one card on Markets (a book, pm-arbs, side,
  // retired), which is scrolled to and lit for a moment. No element has those ids, so the browser does not jump to
  // one by itself. The floor's links before 2026-10-17 land on the view that has what they named.
  const VIEWS = ['today', 'games', 'markets', 'activity'];
  const OLD_VIEWS = { overview: 'today', desk: 'markets', pm: 'markets' };
  let view = null, pendingAnchor = null;
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
    // frame is asked for: the floor stayed blank for good. Read it as written; it names no view, so it is Today.
    let raw = location.hash.slice(1);
    try { raw = decodeURIComponent(raw); } catch { /* malformed escape */ }
    let [v, k] = raw.split('/');
    // the old links: #pm/bets is the Games view, #pm/arbs a card on Markets, #desk/options a retired book
    if (v === 'pm') { if (k === 'bets') { v = 'games'; k = null; } else k = k ? `pm-${k}` : 'side'; }
    else if (v === 'desk' && RETIRED.includes(k)) k = 'retired';
    v = OLD_VIEWS[v] || v;
    const before = view;
    if (!bigChart.hidden) closeBigChart();       // the sheets are not part of the address: they stayed over the new view
    closeSheet();
    setView(VIEWS.includes(v) ? v : 'today');
    pendingAnchor = k && view === 'markets' ? k : null;
    if (pendingAnchor) showAnchor(); else if (before !== null && before !== view) window.scrollTo({ top: 0, behavior: 'instant' });
  }
  function showAnchor() {
    const el = pendingAnchor && document.querySelector(`.view:not([hidden]) [data-anchor="${CSS.escape(pendingAnchor)}"]`);
    if (!el || el.hidden) return;
    pendingAnchor = null;
    el.scrollIntoView({ block: 'start' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  }
  window.addEventListener('hashchange', route);

  // ------------------------------------------------------------ wiring: a frame every two seconds, a clock every second
  // Only the view showing is drawn (each is drawn whole as it opens); the activity's rows are read every frame so a
  // trade can be read out wherever the reader is.
  function render() {
    renderHeader();
    renderClock();
    if (view === 'today') renderToday();
    else if (view === 'games') renderGames();
    else if (view === 'markets') renderMarkets();
    const rows = activityRows();
    if (view === 'activity') renderActivity(rows);
    announce(rows);
    drawChart($('chart'));
    drawChart($('chart2'));
    if (!bigChart.hidden) drawChart($('chartbig-pnl'));
    renderSheet();
    $('floor').removeAttribute('aria-busy');
    if (pendingAnchor) showAnchor();
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
  // When the stream goes quiet everything is drawn again, not just the bar: the Health card and an open sheet went
  // on saying "Working" and "Last round 3 seconds ago" under a banner that said No signal (2026-10-16 audit).
  setInterval(() => { if (quiet() && !retry && !paused) connect(); if (!S) return; renderClock(); if (!!stale() !== shownGone) render(); }, 1000);
  route();
  morph($('tdhero'), `<p class="tddate">${esc(ET_LONG.format(new Date()))}</p><span class="tdlab">Connecting to the desk…</span>`);
  morph($('ghero'), '<p class="ovp">Connecting to the desk…</p>');
  wireChart($('chart'), false);
  wireChart($('chart2'), false);
  wireChart($('chartbig-pnl'), true);
  connect();
  loadHistory(); setInterval(loadHistory, 60000);
})();

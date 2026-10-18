'use strict';
// Static contract for the floor at / (public/desk.*): since 2026-10-17 four views of the whole Hexagon, Today, Games,
// Markets and Activity. Every view has its link and its panel and only Today shows at load, no element's id is a
// view's name (a link to #games would otherwise scroll to it), every element desk.js reads is in desk.html, the old
// links land, the page only reads, everything with more behind it opens it, and on a phone the views are a tab bar
// at the foot of the screen. tools/tokens-test.js holds the colours, the type floor and the app icons.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/desk.html'), js = read('public/desk.js'), css = read('public/desk.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- the views: a link and a panel each, in the same order desk.js knows them
const VIEWS = ['today', 'games', 'markets', 'activity'];
const jsViews = ((js.match(/const VIEWS = \[([^\]]*)\]/) || [])[1] || '').match(/'([\w-]+)'/g) || [];
ok('desk.js knows the four views', JSON.stringify(jsViews.map((v) => v.slice(1, -1))) === JSON.stringify(VIEWS), jsViews);
const nav = (html.match(/<nav class="views"[\s\S]*?<\/nav>/) || [''])[0];
const links = [...nav.matchAll(/<a href="#([\w-]+)" data-view="([\w-]+)"/g)].map((m) => [m[1], m[2]]);
ok('the bar has a link to each view, its hash its name', JSON.stringify(links) === JSON.stringify(VIEWS.map((v) => [v, v])), links);
ok('each tab has its icon, for the phone\'s tab bar', (nav.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g) || []).length === 4);
const panels = [...html.matchAll(/<section class="view[^"]*" id="v-([\w-]+)" data-view="([\w-]+)"[^>]*>/g)].map((m) => ({ id: m[1], view: m[2], hidden: /\shidden\b/.test(m[0]) }));
ok('each view has its panel', JSON.stringify(panels.map((p) => p.view)) === JSON.stringify(VIEWS) && panels.every((p) => p.id === p.view), panels);
ok('only Today shows before the first frame', panels.every((p) => p.hidden === (p.view !== 'today')), panels);
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
ok('no element is named for a view, so a view\'s link never scrolls the page to one', !ids.some((i) => VIEWS.includes(i)), ids.filter((i) => VIEWS.includes(i)));
ok('ids are unique', new Set(ids).size === ids.length, ids.filter((i, k) => ids.indexOf(i) !== k));
const read$ = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
ok('every element desk.js reads is in desk.html', read$.every((i) => ids.includes(i)), read$.filter((i) => !ids.includes(i)));
ok('a card\'s own link (#markets/crypto, #markets/pm-arbs) opens its view and lights the card', /let raw = location\.hash\.slice\(1\)/.test(js) && /let \[v, k\] = raw\.split\('\/'\)/.test(js)
  && /data-anchor="\$\{b\.key\}"/.test(js) && /data-anchor="\$\{k\}"/.test(js) && /\[data-anchor="\$\{CSS\.escape\(pendingAnchor\)\}"\]/.test(js));
ok('the old links land: #overview on Today, #desk and #pm on Markets, #pm/bets on Games, a retired book on its line',
  /const OLD_VIEWS = \{ overview: 'today', desk: 'markets', pm: 'markets' \}/.test(js) && /if \(k === 'bets'\) \{ v = 'games'; k = null; \}/.test(js) && /RETIRED\.includes\(k\)\) k = 'retired'/.test(js) && /data-anchor="retired"/.test(html));
ok('the views follow the back button', /addEventListener\('hashchange', route\)/.test(js));
// A hash cut short inside an escape (#%E0%A4%A) makes decodeURIComponent throw, and route() runs at load before
// the stream is opened: the floor stayed blank for good (found 2026-10-07, in the browser).
ok('a malformed hash cannot stop the floor: decodeURIComponent is only ever called inside a try', /try \{ raw = decodeURIComponent\(raw\); \} catch/.test(js) && [...js.matchAll(/decodeURIComponent\(/g)].length === 1);
// The Home Screen app: iOS suspends the page and drops the stream's socket without an `error`, and there is no
// reload button, so the page watches its own stream (a frame is due every two seconds) and opens a new one.
ok('the page reopens a stream that has gone quiet, on a timer and the moment it is shown again', /const quiet = \(\) => Date\.now\(\) - Math\.max\(lastFrameAt, lastTry\) > STALE_MS/.test(js) && /setInterval\(\(\) => \{ if \(quiet\(\) && !retry && !paused\) connect\(\);/.test(js) && /document\.addEventListener\('visibilitychange', wake\)/.test(js) && /window\.addEventListener\('pageshow', wake\)/.test(js));
ok('one stream at a time: a new one closes the old, and a closed one cannot schedule another', /if \(es\) es\.close\(\)/.test(js) && /if \(es !== mine\) return/.test(js) && /clearTimeout\(retry\)/.test(js));
ok('only the view showing is drawn each frame, and a view is drawn whole as it opens', /if \(view === 'today'\) renderToday\(\);\s*else if \(view === 'games'\) renderGames\(\);\s*else if \(view === 'markets'\) renderMarkets\(\);/.test(js) && /if \(S && draw\) render\(\);/.test(js));

// ---- read-only: the stream, the history, nothing else
const fetches = [...js.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
// ...and one probe, when the stream errors: GET / and do not follow its redirect to /login, so a signed-out page reloads into the form
ok('it fetches only the P&L history, and the front page to see whether it is still signed in', JSON.stringify(fetches) === JSON.stringify(['/api/desk/history', '/']) && /fetch\('\/', \{ cache: 'no-store', redirect: 'manual' \}\)/.test(js), fetches);
ok('it reads only the desk\'s stream', [...js.matchAll(/new EventSource\('([^']+)'\)/g)].map((m) => m[1]).join() === '/api/desk/stream');
ok('it sends nothing: no POST, no form, no socket', !/(method:|POST|XMLHttpRequest|WebSocket|sendBeacon)/.test(js) && !/<form\b/.test(html));

// ---- on a phone, a tab bar at the foot of the screen
const phone = (css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}\n/) || [])[1] || '';
ok('on a phone the views are a tab bar fixed to the foot of the screen, over the home indicator',
  /\.views \{[^}]*position: fixed;[^}]*bottom: 0;/.test(phone) && /\.views \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('...and the page leaves room under its last card for it', /\.wrap \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('the bar\'s blur is drawn behind it, not on it, so the tab bar inside it is held to the screen', !/\.top \{[^}]*backdrop-filter/.test(css) && /\.top::before \{[^}]*backdrop-filter/.test(css));
ok('a hidden view, tab or tile is gone whatever its own display', /\[hidden\] \{ display: none !important; \}/.test(css));
ok('the four tab names are short enough for a quarter of a 375px screen', [...nav.matchAll(/<span>([^<]+)<\/span>/g)].every((m) => m[1].length <= 8), [...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]));

// ---- Today (2026-10-17): the date and all the paper, its parts, then the games, the crypto rule, what comes next,
// the lab, the arbs and the maker, the health
const tv = (html.match(/<section class="view tv" id="v-today"[\s\S]*?\n    <\/section>\n/) || [''])[0];
const at = (id) => tv.indexOf(`id="${id}"`);
ok('Today reads in order: the paper, the games, the crypto rule, next up, the lab, the arbs, the health',
  ['tdhero', 'tdgames', 'tdrule', 'tdnext', 'tdlab', 'tdside', 'health'].every((id, i, a) => at(id) > 0 && (i === 0 || at(a[i - 1]) < at(id))), ['tdhero', 'tdgames', 'tdrule', 'tdnext', 'tdlab', 'tdside', 'health'].map(at));
ok('the crypto rule carries the chart and the bars of what it wants, and the card opens the chart large', tv.indexOf('id="chart"') > at('tdrule') && tv.indexOf('id="aims"') > tv.indexOf('id="chart"') && /id="tdr-h">The crypto rule<\/h2><button type="button" class="seeall" data-expand="1">Large chart</.test(tv));
ok('the main column takes 7 of the 12 and the side 5; on a tablet or a phone both are full width',
  /\.tdmain \{ grid-column: span 7; \}/.test(css) && /\.tdaside \{ grid-column: span 5; \}/.test(css) && /\.tdmain, \.tdaside \{ grid-column: 1 \/ -1; \}/.test(css));
ok('all the paper is both desks\' together, and its three parts add up to it: the games\' figure and the rest of their desk\'s',
  /const equity = r2\(\(S\.equity \|\| 0\) \+ le\), initial = r2\(\(S\.initial \|\| 0\) \+ li\)/.test(js) && /pnl: r2\(\(L\.pnl \|\| 0\) - gp\)/.test(js));
ok('the Crypto & SPY part says how much of its figure is the retired books\'', /of it retired books/.test(js));
ok('the total opens the whole Hexagon, each part its view', /class="tdtotal" data-sheet="desk"/.test(js) && /href: '#games'/.test(js) && /href: '#markets\/side'/.test(js));
ok('what comes next spans all of it: the bets, the two rules\' checks, the tapes and the re-test dates',
  /k: `bet-\$\{st\}`/.test(js) && /k: 'crypto', sheet: 'book:crypto'/.test(js) && /k: 'spy', sheet: 'book:stocks'/.test(js) && /k: `tape-\$\{tp\.key\}`/.test(js) && /for \(const r of RETESTS\.filter/.test(js));
ok('the re-test dates are the plan\'s: Nov 9, Dec 7, Jan 25, Mar 22', /2026-11-09T/.test(js) && /2026-12-07T/.test(js) && /2027-01-25T/.test(js) && /2027-03-22T/.test(js));
ok('the lab counts the ideas tested and kept from one list, and one on test says so', /const TESTS = \[/.test(js) && /kept: 'testing'/.test(js) && (js.match(/kept: true/g) || []).length === 2);
ok('a tape that has gone quiet says so, by how often it runs', /const TAPE_QUIET_H = \{ odds: 0\.5, td: 1, chains: 80 \}/.test(js) && /word: 'Quiet'/.test(js));

// ---- the games: every game a tile, at whatever stage
ok('a tile is up next, bet, live, under way unbet, waiting on the result, left alone, won or lost', ['next', 'bet', 'live', 'late', 'wait', 'skip', 'won', 'lost'].every((st) => new RegExp(`'${st}'`).test(js)));
ok('a bet whose game has no start on record waits on its result, not "up next"', /stage: !known \? 'wait' : started \? 'live' : 'bet'/.test(js));
// the audit of 2026-10-17
ok('a tile and its sheet follow a game from up next to the bet and the final: keyed by its pair, found by it', /return \{ k: r\.pairId \|\| r\.id, stage:/.test(js) && /const fin = g\.finals\.map\(\(f\) => \(\{ k: f\.id, stage:/.test(js) && /x\.id === id \|\| x\.pairId === id/.test(js));
ok('a game under way and not bet is "late", in progress, never up next or "Bets this round"', /stage: begun \? 'late' :/.test(js) && /B\.next\.filter\(\(t\) => t\.stage !== 'late'\)/.test(js));
ok('switched off, a group of games says so in its heading too', /if \(!B\.g\.on\) return 'not bet: the game bets are switched off'/.test(js));
ok('until 4 AM "today" is still the evening before, for the finals as for the games', /td = playedDay\(S\.now\)/.test(js) && /k === playedDay\(S\.now\) \? 'Today'/.test(js));
ok('every tile opens its game', /class="gt st-\$\{t\.stage\}" data-sheet="game:\$\{esc\(t\.k\)\}"/.test(js) && /kind === 'game' \? gameSheet\(arg\)/.test(js));
ok('a sheet\'s id splits at its first colon only: a game pair\'s id has colons of its own', /const s = String\(id\), i = s\.indexOf\(':'\)/.test(js));
ok('the pick is marked by more than its colour', /<span class="sr">, the pick<\/span>/.test(js));
ok('a final belongs to the day its game was played, not the day it settled', /const playedDay = \(at\) => dayKey\(at - 4 \* 3600e3\)/.test(js));
ok('the record is set against what the prices said, with chance\'s spread beside it', /the prices said/.test(js) && /one standard deviation is/.test(js) && /should lose about the fee over many games/.test(js));
ok('a team\'s whole name, and on a phone the price at the tile\'s foot', !/\.gtn \{[^}]*text-overflow: ellipsis/.test(css) && /\.gtp \{ display: none; \}/.test(phone) && /\.gtsp \{ display: inline;/.test(phone));
ok('the league picked is remembered here, and only here', /localStorage\.setItem\('desk-games'/.test(js));

// ---- Markets, and the retired books
ok('Markets holds the crypto and SPY books only, then the arbs, maker, snipe and convergence, then one line for the retired',
  /\['crypto', 'stocks'\]\.map\(bookOf\)/.test(js) && /const SIDE = \['arbs', 'maker', 'snipe', 'converge'\]/.test(js) && /Retired on 2026-10-17/.test(js));
ok('the retired books have no card and no colour: four of six used to outnumber the two that trade', !/var\(--book-(options|scalps|dips|runners)\)/.test(js + css) && !/GROUPS/.test(js));
ok('an arb past its settle date says so', /was to settle \$\{settleDay\(r\.settlesAt\)\}, still open/.test(js));
ok('arbs over their cap are not "19 of 12 open"', /const over = b\.rows\.length > b\.max/.test(js) && /more than its \$\{b\.max\} slots/.test(js));
ok('a game bet is named by the team it is on, with what it pays', /Bet on \$\{g\.pick\} over \$\{g\.foe\}/.test(js) && /pays \$\{money\(f\.qty\)\} if they win/.test(js) && /Won on \$\{g\.pick\} over \$\{g\.foe\}/.test(js));
ok('a book has bought in by its rows, not by its holding figure, which is null until the first price',
  /const boughtIn = \(b\) => \(b\.key === 'crypto' \|\| b\.key === 'stocks'\) && b\.rows\.some\(\(r\) => r\.qty > 0 \|\| r\.benchPx > 0\)/.test(js) && !/heldBooks = [^\n]*bench != null/.test(js));
ok('...and with no price yet the crypto rule says it is waiting on prices', /if \(bs\.some\(\(b\) => b\.bench == null\)\) return \{ bs, waiting: true \}/.test(js) && /verdict zero">Waiting on prices</.test(js));
ok('a held slot with no price is worth what it cost, as the book counts it, not its cash alone',
  /if \(r\.qty > 0 && !\(r\.px > 0\)\) \{ r\.value = r2\(r\.cost\); r\.worth = r2\(r\.cash \+ r\.cost\); r\.pnl = null; \}/.test(js) && /S = atCost\(JSON\.parse\(ev\.data\)\)/.test(js));
ok('the chart is crypto and SPY against holding them', /const HOLD_FIELDS = \{ crypto: \['c', 'bc'\], stocks: \['s', 'bs'\] \}/.test(js));

// ---- sheets: everything with more behind it opens it ("Make it so everything is interactive if it leads to something else", 2026-10-12)
const sheets = [...new Set([...(html + js).matchAll(/data-sheet="([a-z]+)(?::|")/g)].map((m) => m[1]))];
const known = ((js.match(/function sheetOf\(id\) \{[\s\S]*?\n  \}/) || [''])[0].match(/kind === '(\w+)'/g) || []).map((m) => m.slice(10, -1));
ok('every sheet the page opens is one sheetOf draws', sheets.length >= 6 && sheets.every((k) => known.includes(k)), { sheets, known });
ok('the light opens the health, and each check does too', /id="deskstate" data-sheet="health"/.test(html) && /sheet: 'health', name: checkName\(c\)/.test(js));
ok('each market\'s bar opens its sheet, and the lab its own', /class="aim" data-sheet="mkt:/.test(js) && /class="labsum" data-sheet="lab"/.test(js) && /data-sheet="lab">Every test</.test(html));
ok('a sheet is a dialog with Back and Done, and a change of view or Escape closes it',
  /<div id="sheet" hidden>\s*<div class="shbox" role="dialog" aria-modal="true"/.test(html) && /id="sheetback"/.test(html) && /class="shdone" data-close="1"/.test(html)
  && /closeBigChart\(\);[^\n]*\n\s*closeSheet\(\);/.test(js) && /if \(ev\.key === 'Escape'\) \{ closeBigChart\(\); closeSheet\(\); \}/.test(js));
ok('an open sheet is drawn again from every frame', /renderSheet\(\);\n\s*\$\('floor'\)\.removeAttribute\('aria-busy'\)/.test(js));
ok('a line that opens nothing is not a button: only a sheet or a link makes one', /const tag = o\.sheet \? `button type="button" class="\$\{cls\}"[^`]*` : o\.href \? `a class="\$\{cls\}"[^`]*` : `div class="\$\{cls\}"`/.test(js));

// ---- motion (2026-10-10): a view opens at once, as an app's tab does; what moves answers an action
ok('no card animates in when a view opens', !/animation: rise/.test(css) && !/@keyframes rise/.test(css));
ok('the sheets still open as sheets, and a card still lights when a link led to it', /\[data-anchor\]\.flash \{ animation: flash/.test(css) && /@keyframes sheetin/.test(css) && /@keyframes sheetup/.test(css));
ok('...and both only when the device allows motion', (css.match(/@media \(prefers-reduced-motion: no-preference\)/g) || []).length >= 4);

// ---- the audits that carry over (2026-10-15, 10-16): a hidden page rests, a failed stream backs off, stale figures
// say so everywhere, the page behind a dialog is inert
ok('a page hidden for a minute closes its stream, and opens it when shown', /paused = true; clearTimeout\(retry\); retry = null; if \(es\) \{ es\.close\(\); es = null; \}/.test(js) && /\} else if \(paused\) \{ paused = false; resumedAt = Date\.now\(\); fails = 0; connect\(\); \}/.test(js) && /\}, 60000\);/.test(js));
ok('...and is not "No signal" while it rests', /const stale = \(\) => !paused && lastFrameAt && Date\.now\(\) - Math\.max\(lastFrameAt, resumedAt\) > STALE_MS/.test(js));
ok('a failed stream waits 3s, then twice as long each time, at most a minute', /retry = setTimeout\(connect, Math\.min\(60000, 3000 \* 2 \*\* fails\+\+\)\)/.test(js));
ok('when the stream goes quiet everything is drawn again, the open sheet with it, and the sheet says so', /if \(!!stale\(\) !== shownGone\) render\(\);/.test(js) && /class="shstale"/.test(js) && /body\.offline #sheetbody/.test(css));
ok('the page behind a sheet or the large chart is inert', /el\.inert = on/.test(js) && (js.match(/behind\(\);/g) || []).length >= 4);
ok('the small links are at least 24px tall', /\.seeall, \.pmold, \.rule summary \{ display: inline-flex; align-items: center; min-height: 24px; \}/.test(css));
ok('a cent down is nothing lost, not "down 0.00%"', (js.match(/>= 0\.00005/g) || []).length >= 2);
ok('"1 second ago", not "1 seconds ago"', /\$\{s\} second\$\{s === 1 \? '' : 's'\} ago/.test(js));
ok('the health line says what the 5% is: a loss limit', /`Loss limit: \$\{down \?/.test(js));
ok('Back keeps the focus in the sheet: on Back while there is one to go back to, else on Done',
  /if \(!sheet\.hidden\) \(sheetback\.hidden \? sheet\.querySelector\('\.shdone'\) : sheetback\)\.focus\(/.test(js));
ok('a link in a sheet closes it, and the same address as the one showing goes to its card again',
  /const go = ev\.target\.closest\('#sheet a\[href\^="#"\]'\);\s*if \(go\) \{ closeSheet\(\); if \(go\.hash === location\.hash\) route\(\); return; \}/.test(js));
ok('a verdict is a sentence and wraps, though a figure\'s colour keeps a figure whole', /\.verdict\.pos, \.verdict\.neg, \.verdict\.zero \{ white-space: normal; \}/.test(css));

// morph's patch, run on a small stand-in for the DOM: a line that is still wanted stays the same element when a
// new one comes in on top, one goes, or two swap. Until 2026-10-15 a new fill replaced every line under it.
{
  const src = (js.match(/  const sameNode = [\s\S]*?\n  function patch\(a, b\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  class N {
    constructor(name, k, text) { this.nodeName = name; this.nodeType = name === '#text' ? 3 : 1; this.nodeValue = text ?? null; this.attrs = new Map(k == null ? [] : [['data-k', k]]); this.childNodes = []; this.parentNode = null; }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    setAttribute(n, v) { this.attrs.set(n, String(v)); } removeAttribute(n) { this.attrs.delete(n); } hasAttribute(n) { return this.attrs.has(n); }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get isConnected() { return true; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, c); c.parentNode = this; return c; }
    appendChild(c) { return this.insertBefore(c, null); }
    replaceChild(c, old) { this.insertBefore(c, old); return this.removeChild(old); }
  }
  const li = (k) => { const n = new N('LI', k); n.appendChild(new N('#text', null, `line ${k}`)); return n; };
  const list = (ks) => { const u = new N('UL'); for (const k of ks) u.appendChild(li(k)); return u; };
  let patch = null;
  try { patch = new Function(`${src}; return patch;`)(); } catch (e) { ok('patch can be read out of desk.js', false, e.message); }
  if (patch) {
    const run = (from, to) => { const a = list(from), was = new Map(a.childNodes.map((c) => [c.getAttribute('data-k'), c])); patch(a, list(to)); return { a, was }; };
    const kept = ({ a, was }, ks) => ks.every((k) => a.childNodes.find((c) => c.getAttribute('data-k') === k) === was.get(k));
    const order = ({ a }) => a.childNodes.map((c) => c.getAttribute('data-k')).join();
    let r = run(['a', 'b', 'c'], ['n', 'a', 'b', 'c']);
    ok('patch: a new line on top leaves every line under it the same element', order(r) === 'n,a,b,c' && kept(r, ['a', 'b', 'c']), order(r));
    r = run(['a', 'b', 'c'], ['b', 'c']);
    ok('patch: a line that goes takes no other with it', order(r) === 'b,c' && kept(r, ['b', 'c']), order(r));
    r = run(['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'x']);
    ok('patch: lines that swap are moved, not drawn again', order(r) === 'b,a,d,x' && kept(r, ['a', 'b', 'd']), order(r));
    r = run(['a', 'b'], ['a', 'b']);
    ok('patch: a frame that changes nothing keeps everything', order(r) === 'a,b' && kept(r, ['a', 'b']) && r.a.childNodes[1].childNodes[0].nodeValue === 'line b');
  }
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

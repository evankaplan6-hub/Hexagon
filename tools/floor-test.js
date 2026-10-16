'use strict';
// Static contract for the floor at / (public/desk.*) as four views (2026-10-02), the overview's four questions (2026-10-12): every view has its link and
// its panel and only the overview shows at load, no element's id is a view's name (a link to #desk would
// otherwise scroll to it), every element desk.js reads is in desk.html, the six books are each in one of the
// two groups, the page only reads, and on a phone the views are a tab bar at the foot of the screen.
// tools/tokens-test.js holds the colours, the type floor and the app icons.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/desk.html'), js = read('public/desk.js'), css = read('public/desk.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- the views: a link and a panel each, in the same order desk.js knows them
const VIEWS = ['overview', 'desk', 'pm', 'activity'];
const jsViews = ((js.match(/const VIEWS = \[([^\]]*)\]/) || [])[1] || '').match(/'([\w-]+)'/g) || [];
ok('desk.js knows the four views', JSON.stringify(jsViews.map((v) => v.slice(1, -1))) === JSON.stringify(VIEWS), jsViews);
const nav = (html.match(/<nav class="views"[\s\S]*?<\/nav>/) || [''])[0];
const links = [...nav.matchAll(/<a href="#([\w-]+)" data-view="([\w-]+)"/g)].map((m) => [m[1], m[2]]);
ok('the bar has a link to each view, its hash its name', JSON.stringify(links) === JSON.stringify(VIEWS.map((v) => [v, v])), links);
const panels = [...html.matchAll(/<section class="view[^"]*" id="v-([\w-]+)" data-view="([\w-]+)"[^>]*>/g)].map((m) => ({ id: m[1], view: m[2], hidden: /\shidden\b/.test(m[0]) }));
ok('each view has its panel', JSON.stringify(panels.map((p) => p.view)) === JSON.stringify(VIEWS) && panels.every((p) => p.id === p.view), panels);
ok('only the overview shows before the first frame', panels.every((p) => p.hidden === (p.view !== 'overview')), panels);
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
ok('no element is named for a view, so a view\'s link never scrolls the page to one', !ids.some((i) => VIEWS.includes(i)), ids.filter((i) => VIEWS.includes(i)));
ok('ids are unique', new Set(ids).size === ids.length, ids.filter((i, k) => ids.indexOf(i) !== k));
const read$ = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
ok('every element desk.js reads is in desk.html', read$.every((i) => ids.includes(i)), read$.filter((i) => !ids.includes(i)));
ok('a book\'s own link (#desk/crypto, #pm/arbs) opens its view and its card', /let raw = location\.hash\.slice\(1\)/.test(js) && /\[v, k\] = raw\.split\('\/'\)/.test(js) && /href="#desk\/\$\{b\.key\}"/.test(js) && /href="#pm\/\$\{b\.key\}"/.test(js));
ok('the views follow the back button', /addEventListener\('hashchange', route\)/.test(js));
// A hash cut short inside an escape (#%E0%A4%A) makes decodeURIComponent throw, and route() runs at load before
// the stream is opened: the floor stayed blank for good (found 2026-10-07, in the browser).
ok('a malformed hash cannot stop the floor: decodeURIComponent is only ever called inside a try', /try \{ raw = decodeURIComponent\(raw\); \} catch/.test(js) && [...js.matchAll(/decodeURIComponent\(/g)].length === 1);
// The Home Screen app: iOS suspends the page and drops the stream's socket without an `error`, and there is no
// reload button, so the page watches its own stream (a frame is due every two seconds) and opens a new one.
ok('the page reopens a stream that has gone quiet, on a timer and the moment it is shown again', /const quiet = \(\) => Date\.now\(\) - Math\.max\(lastFrameAt, lastTry\) > STALE_MS/.test(js) && /setInterval\(\(\) => \{ if \(quiet\(\) && !retry\) connect\(\);/.test(js) && /document\.addEventListener\('visibilitychange', wake\)/.test(js) && /window\.addEventListener\('pageshow', wake\)/.test(js));
ok('one stream at a time: a new one closes the old, and a closed one cannot schedule another', /if \(es\) es\.close\(\)/.test(js) && /if \(es !== mine\) return/.test(js) && /clearTimeout\(retry\)/.test(js));

// ---- the six books, each in one group
const groups = ((js.match(/const GROUPS = \[([\s\S]*?)\n  \];/) || [])[1] || '');
const grouped = [...groups.matchAll(/\[('[\w]+'(?:, '[\w]+')*)\]\],?$/gm)].flatMap((m) => m[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1)));
const BOOKS = ['crypto', 'stocks', 'options', 'scalps', 'dips', 'runners'];
ok('each of the six books is in one group, and only once', grouped.length === 6 && BOOKS.every((b) => grouped.includes(b)), grouped);
ok('each book has its colour from the tokens', BOOKS.every((b) => new RegExp(`${b}: 'var\\(--book-${b}\\)'`).test(js)));

// ---- read-only: the stream, the history, nothing else
const fetches = [...js.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
// ...and one probe, when the stream errors: GET / and do not follow its redirect to /login, so a signed-out page reloads into the form
ok('it fetches only the P&L history, and the front page to see whether it is still signed in', JSON.stringify(fetches) === JSON.stringify(['/api/desk/history', '/']) && /fetch\('\/', \{ cache: 'no-store', redirect: 'manual' \}\)/.test(js), fetches);
ok('it reads only the desk\'s stream', [...js.matchAll(/new EventSource\('([^']+)'\)/g)].map((m) => m[1]).join() === '/api/desk/stream');
ok('it sends nothing: no POST, no form, no socket', !/(method:|POST|XMLHttpRequest|WebSocket|sendBeacon)/.test(js) && !/<form\b/.test(html));

// ---- on a phone, a tab bar at the foot of the screen
const phone = (css.match(/@media \(max-width: 640px\) \{([\s\S]*)\}\s*$/) || [])[1] || '';
ok('on a phone the views are a tab bar fixed to the foot of the screen, over the home indicator',
  /\.views \{[^}]*position: fixed;[^}]*bottom: 0;/.test(phone) && /\.views \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('...and the page leaves room under its last card for it', /\.wrap \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('the bar\'s blur is drawn behind it, not on it, so the tab bar inside it is held to the screen', !/\.top \{[^}]*backdrop-filter/.test(css) && /\.top::before \{[^}]*backdrop-filter/.test(css));
ok('a hidden view, tab or tile is gone whatever its own display', /\[hidden\] \{ display: none !important; \}/.test(css));

// ---- the overview (2026-10-12): four questions in order, and everything with more behind it opens it
const ov = (html.match(/<section class="view ov" id="v-overview"[\s\S]*?\n    <\/section>\n/) || [''])[0];
const at = (id) => ov.indexOf(`id="${id}"`);
ok('the overview asks its four questions in order: up or down, against holding, the last trade, the health',
  ['ovhero', 'vshold', 'lasttrade', 'health'].every((id, i, a) => at(id) > 0 && (i === 0 || at(a[i - 1]) < at(id))), ['ovhero', 'vshold', 'lasttrade', 'health'].map(at));
ok('...then what it holds, the prediction-market desk and the books that are off', at('mkts') > at('vshold') && at('ovpm') > at('health') && at('ovoff') > at('ovpm'));
ok('the holding question carries the chart, and the card opens it large', ov.indexOf('id="chart"') > at('vshold') && /data-expand="1">Large chart</.test(ov));
ok('the main column takes 7 of the 12 and the side 5; on a tablet or a phone both are full width',
  /\.ovmain \{ grid-column: span 7; \}/.test(css) && /\.ovaside \{ grid-column: span 5; \}/.test(css) && /\.ovmain, \.ovaside \{ grid-column: 1 \/ -1; \}/.test(css));
// "Make it so everything is interactive if it leads to something else" (Evan, 2026-10-12)
const sheets = [...new Set([...(html + js).matchAll(/data-sheet="([a-z]+)(?::|")/g)].map((m) => m[1]))];
const known = ((js.match(/function sheetOf\(id\) \{[\s\S]*?\n  \}/) || [''])[0].match(/kind === '(\w+)'/g) || []).map((m) => m.slice(10, -1));
ok('every sheet the page opens is one sheetOf draws', sheets.length >= 4 && sheets.every((k) => known.includes(k)), { sheets, known });
ok('the figure opens every book, the light opens the health, and each check does too',
  /id="ovhero" data-sheet="desk"/.test(html) && /id="deskstate" data-sheet="health"/.test(html) && /sheet: 'health', name: checkName\(c\)/.test(js));
ok('each book against holding, each market, the last trade and each next check opens its sheet',
  /sheet: `book:\$\{b\.key\}`, color: BOOK_COLOR/.test(js) && /class="mkrow" data-sheet="mkt:/.test(js) && /class="lt" data-sheet="mkt:/.test(js) && /k: `next-\$\{b\.key\}`, sheet: `book:/.test(js));
ok('the side desk\'s books and the switched-off books go to their cards', /class="card pmc" data-k="pm-\$\{b\.key\}" href="#pm\/\$\{b\.key\}"/.test(js) && /class="offchip" data-k="off-\$\{b\.key\}" href="#desk\/\$\{b\.key\}"/.test(js));
ok('a sheet is a dialog with Back and Done, and a change of view or Escape closes it',
  /<div id="sheet" hidden>\s*<div class="shbox" role="dialog" aria-modal="true"/.test(html) && /id="sheetback"/.test(html) && /class="shdone" data-close="1"/.test(html)
  && /closeBigChart\(\);[^\n]*\n\s*closeSheet\(\);/.test(js) && /if \(ev\.key === 'Escape'\) \{ closeBigChart\(\); closeSheet\(\); \}/.test(js));
ok('an open sheet is drawn again from every frame', /renderSheet\(\);\n\s*\$\('floor'\)\.removeAttribute\('aria-busy'\)/.test(js));
ok('a line that opens nothing is not a button: only a sheet or a link makes one', /const tag = o\.sheet \? `button type="button" class="\$\{cls\}"[^`]*` : o\.href \? `a class="\$\{cls\}"[^`]*` : `div class="\$\{cls\}"`/.test(js));
ok('the chart is crypto and SPY against holding them', /const HOLD_FIELDS = \{ crypto: \['c', 'bc'\], stocks: \['s', 'bs'\] \}/.test(js));
// ---- motion (2026-10-10): a view opens at once, as an app's tab does; what moves answers an action
ok('no card animates in when a view opens', !/animation: rise/.test(css) && !/@keyframes rise/.test(css));
ok('the chart sheet still opens as a sheet, and a book\'s card still lights when a line led to it', /\.bk\.flash \{ animation: flash/.test(css) && /@keyframes sheetin/.test(css) && /@keyframes sheetup/.test(css));
ok('...and both only when the device allows motion', (css.match(/@media \(prefers-reduced-motion: no-preference\)/g) || []).length >= 4);

// ---- the floor's words (2026-10-10 audit): a bet named by its pick, an overdue arb, arbs over their cap, the
// switched-off books on one line, and no book named twice under its tag
ok('a game bet is named by the team it is on, with what it pays', /Bet on \$\{g\.pick\} over \$\{g\.foe\}/.test(js) && /pays \$\{money\(f\.qty\)\} if they win/.test(js) && /Won on \$\{g\.pick\} over \$\{g\.foe\}/.test(js));
ok('...on its card too', /\$\{g\.pick\} over \$\{g\.foe\}` : r\.label/.test(js));
ok('an arb past its settle date says so', /was to settle \$\{settleDay\(r\.settlesAt\)\}, still open/.test(js));
ok('arbs over their cap are not "19 of 12 open"', /const over = b\.rows\.length > b\.max/.test(js) && /more than its \$\{b\.max\} slots/.test(js));
ok('the switched-off books share one line of chips on the overview', /const bookOff = /.test(js) && /function ovOffHtml\(off\)/.test(js) && /const L = S\.legacy, off = \(S\.books \|\| \[\]\)\.filter\(bookOff\)/.test(js));
ok('...and a card without a line or a table', /\(traded && !off \? sparkSvg\(b\.key\) : ''\) \+ \(off \? '' : body\)/.test(js));
ok('a group says which of its books are off, and Runners\' sentence only while it trades', /const groupNote = /.test(js) && /groupNote\(text, bs\)/.test(js) && !/swings\. Runners buy/.test(js));
ok('a fill\'s sub-line no longer repeats its book, and a folded maker fill says its count', !/BOOK_NAME/.test(js) && /in \$\{f\.n\} fills/.test(js));

// ---- the 2026-10-15 audit: focus in a sheet, a sheet's links, the seconds after a restart, a share of nothing
ok('Back keeps the focus in the sheet: on Back while there is one to go back to, else on Done',
  /if \(!sheet\.hidden\) \(sheetback\.hidden \? sheet\.querySelector\('\.shdone'\) : sheetback\)\.focus\(/.test(js));
ok('a link in a sheet closes it, and the same address as the one showing goes to its card again',
  /const go = ev\.target\.closest\('#sheet a\[href\^="#"\]'\);\s*if \(go\) \{ closeSheet\(\); if \(go\.hash === location\.hash\) route\(\); return; \}/.test(js));
ok('a book has bought in by its rows, not by its holding figure, which is null until the first price',
  /const boughtIn = \(b\) => \(b\.key === 'crypto' \|\| b\.key === 'stocks'\) && b\.rows\.some\(\(r\) => r\.qty > 0 \|\| r\.benchPx > 0\)/.test(js)
  && /const heldBooks = \(\) => \(S\.books \|\| \[\]\)\.filter\(\(b\) => !bookOff\(b\) && boughtIn\(b\)\)/.test(js) && !/heldBooks = [^\n]*bench != null/.test(js));
ok('...and with no price yet the overview says it is waiting on prices', /if \(bs\.some\(\(b\) => b\.bench == null\)\) return \{ bs, waiting: true \}/.test(js) && /verdict zero">Waiting on prices</.test(js));
ok('a held slot with no price is worth what it cost, as the book counts it, not its cash alone',
  /if \(r\.qty > 0 && !\(r\.px > 0\)\) \{ r\.value = r2\(r\.cost\); r\.worth = r2\(r\.cash \+ r\.cost\); r\.pnl = null; \}/.test(js) && /S = atCost\(JSON\.parse\(ev\.data\)\)/.test(js));
ok('the desk\'s share has no sign when it is nothing, and hundredths under a tenth', /toFixed\(part < 0\.095 \? 2 : 1\)/.test(js) && /\$\{none \? '0\.0' :/.test(js));

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

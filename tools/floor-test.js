'use strict';
// Static contract for the floor at / (public/desk.*) as four views (2026-10-02): every view has its link and
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
ok('a book\'s own link (#desk/crypto, #pm/arbs) opens its view and its card', /let raw = location\.hash\.slice\(1\)/.test(js) && /\[v, k\] = raw\.split\('\/'\)/.test(js) && /href: `#desk\/\$\{b\.key\}`/.test(js) && /href: `#pm\/\$\{b\.key\}`/.test(js));
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

// ---- the overview's two tiles (2026-10-10): the main desk leads, the prediction desk sits quieter beside it
ok('the prediction-market tile is the quiet one', /<section class="card tile quiet" id="ovpm"/.test(html));
ok('the main desk takes 7 of the 12 columns and the quiet tile 5, lining up with the chart and the latest under them',
  /\.ov \.tile \{ grid-column: span 7;/.test(css) && /\.ov \.tile\.quiet \{ grid-column: span 5; \}/.test(css) && /\.ov \.chartcard \{ grid-column: span 7;/.test(css) && /\.ov \.latest \{ grid-column: span 5; \}/.test(css));
ok('the quiet tile\'s figure is a card figure, not the desk\'s headline', /\.tile\.quiet \.big \{ font-size: var\(--type-figure\); \}/.test(css));
ok('on a tablet or a phone both tiles go full width, the quiet one too', /\.ov \.tile, \.ov \.tile\.quiet, \.ov \.chartcard, \.ov \.latest \{ grid-column: 1 \/ -1; \}/.test(css));

// ---- the floor's words (2026-10-10 audit): a bet named by its pick, an overdue arb, arbs over their cap, the
// switched-off books on one line, and no book named twice under its tag
ok('a game bet is named by the team it is on, with what it pays', /Bet on \$\{g\.pick\} over \$\{g\.foe\}/.test(js) && /pays \$\{money\(f\.qty\)\} if they win/.test(js) && /Won on \$\{g\.pick\} over \$\{g\.foe\}/.test(js));
ok('...on its card too', /\$\{g\.pick\} over \$\{g\.foe\}` : r\.label/.test(js));
ok('an arb past its settle date says so', /was to settle \$\{settleDay\(r\.settlesAt\)\}, still open/.test(js));
ok('arbs over their cap are not "19 of 12 open"', /const over = b\.rows\.length > b\.max/.test(js) && /more than its \$\{b\.max\} slots/.test(js));
ok('the switched-off books share one line on the overview', /const bookOff = /.test(js) && /chip: 'switched off'/.test(js) && /\$\{on\.map\(/.test(js));
ok('...and a card without a line or a table', /\(traded && !off \? sparkSvg\(b\.key\) : ''\) \+ \(off \? '' : body\)/.test(js));
ok('a group says which of its books are off, and Runners\' sentence only while it trades', /const groupNote = /.test(js) && /groupNote\(text, bs\)/.test(js) && !/swings\. Runners buy/.test(js));
ok('a fill\'s sub-line no longer repeats its book, and a folded maker fill says its count', !/BOOK_NAME/.test(js) && /in \$\{f\.n\} fills/.test(js));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

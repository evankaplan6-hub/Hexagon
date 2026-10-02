'use strict';
// Static contract for the floor at / (public/desk.*) as one screen with nothing to scroll (2026-10-02, Evan:
// "It should all be able to fit on one page, not having to scroll down or up"): the page is the window's
// height and its grid shares that height out, the chart and the latest list take what their cards have and
// never set it, every book is a tile linking to its sheet, the sheet's links are the ones desk.js opens, no
// element's id is one of those links (the browser would scroll to it), every element desk.js reads is in
// desk.html, and the page only reads. tools/tokens-test.js holds the colours, the type floor and the icons.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/desk.html'), js = read('public/desk.js'), css = read('public/desk.css').replace(/\/\*[\s\S]*?\*\//g, '');
const rule = (sel) => { const m = css.match(new RegExp(`(?:^|\\n)${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\{([^}]*)\\}`)); return m ? m[1] : ''; };

// ---- one screen: the page is the window's height, and the grid shares it out
ok('the page is the window\'s height', /height: 100dvh/.test(rule('body')) && /display: flex/.test(rule('body')) && /flex-direction: column/.test(rule('body')));
ok('...and scrolls only if the window is too small for it, never sideways', /overflow-y: auto/.test(rule('body')) && /overflow-x: hidden/.test(rule('body')));
ok('the grid is what is left of the window under the bar, not its own content\'s height (which grew it past the window)',
  /flex: 1 1 0/.test(rule('.board')) && /min-height: 0/.test(rule('.board')));
ok('the grid\'s rows share that height out, each at least as tall as its tiles', /grid-template-rows: minmax\(min-content, [\d.]+fr\) minmax\(min-content, [\d.]+fr\)/.test(rule('.board')));
ok('the chart takes what its card has and never sets it', /height: 0/.test(rule('.board .pnl .cplot')));
ok('the latest list takes what its card has and never sets it', /height: 0/.test(rule('.latest .feed')) && /overflow: hidden/.test(rule('.latest .feed')));
ok('...and shows only the lines that fit whole, again as its card changes size', /function fitList\(ol\)/.test(js) && /new ResizeObserver\(\(\) => \{ if \(S\) fitList\(\$\('latestlist'\)\); \}\)/.test(js));
ok('the four cards are on the grid, and the banner is not (a hidden grid item still leaves its gap)',
  ['ovdesk', 'ovpm'].every((id) => new RegExp(`<main id="floor" class="board"[\\s\\S]*id="${id}"[\\s\\S]*</main>`).test(html))
  && /<main id="floor" class="board"[\s\S]*class="card chartcard"[\s\S]*class="card latest"[\s\S]*<\/main>/.test(html)
  && !/<main[\s\S]*id="banner"[\s\S]*<\/main>/.test(html));
ok('no footer, no second wall: the page is the grid', !/<footer/.test(html) && !/class="view/.test(html));

// ---- every book a tile, each a link to its sheet
const BOOKS = ['crypto', 'stocks', 'options', 'scalps', 'dips', 'runners'];
const groups = ((js.match(/const GROUPS = \[([\s\S]*?)\n  \];/) || [])[1] || '');
const grouped = [...groups.matchAll(/\[('[\w]+'(?:, '[\w]+')*)\]\],?$/gm)].flatMap((m) => m[1].match(/'(\w+)'/g).map((s) => s.slice(1, -1)));
ok('each of the six books is in one group, and only once', grouped.length === 6 && BOOKS.every((b) => grouped.includes(b)), grouped);
ok('each book has its colour from the tokens', BOOKS.every((b) => new RegExp(`${b}: 'var\\(--book-${b}\\)'`).test(js)));
ok('a book\'s tile links to its sheet, a prediction-market book\'s too', /href: `#book\/\$\{b\.key\}`/.test(js) && /href: `#book\/pm-\$\{b\.key\}`/.test(js));
ok('each desk\'s name links to its numbers, and the latest to the whole activity', /<a class="tilehead" href="#desk">/.test(js) && /<a class="tilehead" href="#pm">/.test(js) && /href="#activity"/.test(html));

// ---- the sheet: the links the page uses are the ones it opens; the back button closes it
ok('the sheet opens for #book/<key>, #desk, #pm and #activity', /if \(a === 'book' && b\) return \{ kind: 'book', k: b \}/.test(js) && /if \(a === 'desk' \|\| a === 'pm' \|\| a === 'activity'\) return \{ kind: a \}/.test(js));
ok('...and the four views\' links of that morning still land', /if \(\(a === 'desk' \|\| a === 'pm'\) && b\) return \{ kind: 'book'/.test(js));
ok('a tile\'s link is an entry of its own, so the back button closes the sheet', /history\.pushState\(\{ sheet: 1 \}/.test(js) && /addEventListener\('popstate', route\)/.test(js) && /history\.back\(\)/.test(js));
ok('Escape closes what is on top, the large chart before the sheet', /if \(!bigChart\.hidden\) closeBigChart\(\); else closeSheet\(\);/.test(js));
ok('the sheet is a modal dialog with a title and a Done', /id="sheet" class="sheet" hidden role="dialog" aria-modal="true" aria-labelledby="sheettitle"/.test(html) && /class="sdone" data-close="1">Done</.test(html));
ok('a sheet longer than the window scrolls inside itself, not the page', /overflow-y: auto/.test(rule('.sbody')) && /overscroll-behavior: contain/.test(rule('.sbody')));
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
ok('no element is named for a link the page opens, so following one never scrolls the page', !ids.some((i) => ['book', 'desk', 'pm', 'activity', 'overview'].includes(i)), ids);
ok('ids are unique', new Set(ids).size === ids.length, ids.filter((i, k) => ids.indexOf(i) !== k));
const read$ = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
ok('every element desk.js reads is in desk.html', read$.every((i) => ids.includes(i)), read$.filter((i) => !ids.includes(i)));
ok('the chart legend\'s dashes keep their own class: the grid is .board, not .dash', !/(^|\n)\.dash[\s{:.]/.test(css) && /\.pnl \.cr \.dash \{/.test(css));

// ---- read-only: the stream, the history, nothing else
const fetches = [...js.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
ok('it fetches only the P&L history', JSON.stringify(fetches) === JSON.stringify(['/api/desk/history']), fetches);
ok('it reads only the desk\'s stream', [...js.matchAll(/new EventSource\('([^']+)'\)/g)].map((m) => m[1]).join() === '/api/desk/stream');
ok('it sends nothing: no POST, no form, no socket', !/(method:|POST|XMLHttpRequest|WebSocket|sendBeacon)/.test(js) && !/<form\b/.test(html));
ok('paper only is still said: on the desk\'s light and in its sheet', /id="deskstate" title="Paper only/.test(html) && /<p class="fine">Paper only: no broker is connected/.test(js));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

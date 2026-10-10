'use strict';
// The desk's design tokens (public/tokens.css) and the one sheet built on them (public/desk.css):
// every text colour reads at 4.5:1 or better on every surface, in light and in dark, the ratios the
// comments claim are the ratios the colours give, desk.css writes no colour of its own, nothing names
// a token that is not there, and the page loads no font: it is the system's own. Since 2026-09-29 the
// page is also an app an iPhone or a Mac can keep on its Home Screen or in its Dock: its icons are what
// tools/icons.js draws, its manifest names them, and the server hands those files, and only those, to
// someone who has not logged in.
const fs = require('fs'), path = require('path');
const icons = require('./icons');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tokensCss = read('public/tokens.css'), deskCss = read('public/desk.css'), html = read('public/desk.html'), js = read('public/desk.js');
const server = read('server.js');

// ---- the tokens, each as its light and its dark value, and what each comment says about it
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const T = {}, LIGHT = {}, DARK = {}, claims = {};
for (const line of tokensCss.split('\n')) {
  const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);\s*(?:\/\*(.*?)\*\/)?/);
  if (!m) continue;
  const [, name, value, comment] = m;
  T[name] = value.trim();
  const ld = T[name].match(/^light-dark\(\s*([^,]+?)\s*,\s*([^)]+?)\s*\)$/);
  LIGHT[name] = ld ? ld[1] : T[name];
  DARK[name] = ld ? ld[2] : T[name];
  const c = comment && comment.match(/(\d+(?:\.\d+)?):1 light,\s*(\d+(?:\.\d+)?):1 dark/);
  if (c) claims[name] = { light: +c[1], dark: +c[2] };
}
ok('tokens.css defines its tokens on :root', /:root\s*\{/.test(tokensCss) && Object.keys(T).length > 40, Object.keys(T).length);
ok('the page is light or dark as the device is set', /color-scheme:\s*light dark/.test(tokensCss));

const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (hex) => { const c = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const SCHEMES = [['light', LIGHT], ['dark', DARK]];
const hex = (S, scheme, name) => { const v = S[name]; ok(`${name} is a six-digit hex colour in ${scheme}`, /^#[0-9a-f]{6}$/i.test(v || ''), v); return v; };

const INKS = ['--ink-1', '--ink-2', '--ink-3', '--accent', '--gain', '--loss', '--ok', '--warn', '--bad'];
const GROUNDS = ['--bg-0', '--bg-1'];
for (const [scheme, S] of SCHEMES) {
  for (const ink of INKS) for (const g of GROUNDS) {
    const r = ratio(hex(S, scheme, ink), hex(S, scheme, g));
    ok(`${ink} on ${g} reads at 4.5:1 or better in ${scheme}`, r >= 4.5, +r.toFixed(2));
  }
  ok(`a picked segment's label (--ink-1 on --seg-on) reads at 4.5:1 or better in ${scheme}`, ratio(hex(S, scheme, '--ink-1'), hex(S, scheme, '--seg-on')) >= 4.5);
  ok(`the faintest ink is the one labels use, and it is not faint, in ${scheme}`, ratio(hex(S, scheme, '--ink-3'), hex(S, scheme, '--bg-1')) >= 6);
  ok(`the six books are six colours apart from the money colours in ${scheme}`,
    new Set(['--book-crypto', '--book-stocks', '--book-options', '--book-scalps', '--book-dips', '--book-runners', '--gain', '--loss'].map((n) => S[n])).size === 8);
}
ok('every text colour has a light and a dark value', INKS.every((n) => /^light-dark\(/.test(T[n])), INKS.filter((n) => !/^light-dark\(/.test(T[n])));
for (const [name, c] of Object.entries(claims)) for (const [scheme, S] of SCHEMES) {
  const r = ratio(hex(S, scheme, name), hex(S, scheme, '--bg-1'));
  ok(`${name}'s comment says ${c[scheme]}:1 on --bg-1 in ${scheme}, and it is`, Math.abs(r - c[scheme]) < 0.06, +r.toFixed(2));
}
ok('the ink colours carry their ratios in their comments', ['--ink-1', '--ink-2', '--ink-3', '--accent', '--gain', '--loss', '--warn'].every((n) => claims[n]),
  ['--ink-1', '--ink-2', '--ink-3', '--accent', '--gain', '--loss', '--warn'].filter((n) => !claims[n]));

// ---- desk.css writes no colour of its own (a mask's colour is only its alpha, so masks may)
const RAW = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch|light-dark)\(|\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink)\b/i;
const decls = [];
(function walk(css) { for (const m of noComments(css).matchAll(/\{([^{}]*)\}/g)) for (const d of m[1].split(';')) { const i = d.indexOf(':'); if (i > 0) decls.push([d.slice(0, i).trim(), d.slice(i + 1).trim()]); } })(deskCss);
const raw = decls.filter(([p, v]) => !/^(-webkit-)?mask-image$/.test(p) && RAW.test(v.replace(/var\([^)]*\)/g, '')));
ok('desk.css takes every colour from tokens.css', raw.length === 0, raw.slice(0, 5).map(([p, v]) => `${p}: ${v}`));
ok('desk.css has no :root of its own', !/:root\s*\{/.test(deskCss));

// ---- every token named is a token that exists
const setInline = ['--bk', '--c', '--a', '--agent', '--feedh'];        // desk.js sets these on an element
const definedInDesk = [...noComments(deskCss).matchAll(/(--[\w-]+)\s*:/g)].map((m) => m[1]);
const known = new Set([...Object.keys(T), ...setInline, ...definedInDesk]);
const used = [...new Set([...noComments(deskCss).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]))];
ok('every var() in desk.css names a real token', used.every((u) => known.has(u)), used.filter((u) => !known.has(u)));
const tokUsedInTokens = [...noComments(tokensCss).matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
const jsTok = (js.match(/for \(const k of \[([^\]]*)\]\) t\[k\]/) || [])[1];
const jsNames = jsTok ? [...jsTok.matchAll(/'([\w-]+)'/g)].map((m) => `--${m[1]}`) : [];
ok('desk.js reads its chart colours from tokens.css', jsNames.length >= 5 && jsNames.every((n) => n in T), jsNames.filter((n) => !(n in T)));
ok('desk.js reads the chart\'s font from tokens.css too', /getPropertyValue\('--sans'\)/.test(js));
ok('desk.js reads the colours again when the device changes between light and dark', /matchMedia\('\(prefers-color-scheme: dark\)'\)\.addEventListener\('change'/.test(js) && /TOK = readTokens\(\)/.test(js));
const jsVars = [...js.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
ok('every var() desk.js writes into a style names a real token', jsVars.every((v) => v in T), jsVars.filter((v) => !(v in T)));
// the type and space scales are there for the layout step; everything else should be in use
const everywhere = new Set([...used, ...tokUsedInTokens, ...jsNames, ...jsVars, '--sans']);
const idle = Object.keys(T).filter((n) => !everywhere.has(n) && !/^--(type|space)-/.test(n));
ok('every token outside the type and space scales is used', idle.length === 0, idle);
ok('the books take their colour from the tokens, not from desk.js', /crypto: 'var\(--book-crypto\)'/.test(js) && !/BOOK_COLOR = \{[^}]*#/.test(js));

// ---- the page loads the tokens, then its own sheet, and not /pm's; and no font from anywhere
const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
ok('desk.html loads tokens.css, then desk.css, and nothing else of ours', JSON.stringify(links) === JSON.stringify(['tokens.css', 'desk.css']), links);
ok('desk.html does not load style.css', !/style\.css/.test(html));
ok('the mark is drawn in the text colour, not a hex of its own', !/(?:stroke|fill)="#/.test(html));
ok('no web font is loaded: the page is in the system\'s own', !/fonts\.(googleapis|gstatic)\.com|@font-face|\.woff2?\b/.test(html + deskCss + tokensCss));
ok('the type is Apple\'s system font first (San Francisco), then the others\'', /^-apple-system, BlinkMacSystemFont, system-ui\b/.test(T['--sans'] || ''), T['--sans']);
ok('figures are all one width, so a changing price does not shift its neighbours', /body\s*\{[^}]*font-variant-numeric:\s*tabular-nums/.test(noComments(deskCss)));
const small = decls.filter(([p, v]) => /^font(-size)?$/.test(p) && /\b(\d+(?:\.\d+)?)px\b/.test(v) && +v.match(/\b(\d+(?:\.\d+)?)px\b/)[1] < 12);
ok('no type in desk.css is under the 12px floor', small.length === 0, small);

// ---- on an iPhone, an iPad and a Mac
const meta = (name) => [...html.matchAll(new RegExp(`<meta name="${name}" content="([^"]*)"(?: media="([^"]*)")?>`, 'g'))].map((m) => ({ content: m[1], media: m[2] }));
ok('the page reaches round a notch (viewport-fit=cover) and desk.css pads by the safe areas',
  /viewport-fit=cover/.test((meta('viewport')[0] || {}).content || '') && /env\(safe-area-inset-left\)/.test(deskCss) && /env\(safe-area-inset-right\)/.test(deskCss) && /env\(safe-area-inset-bottom\)/.test(deskCss));
const tc = meta('theme-color');
ok('Safari tints its bars in the page\'s own colour, light and dark', tc.length === 2
  && tc.some((t) => /light/.test(t.media) && t.content === LIGHT['--bg-0']) && tc.some((t) => /dark/.test(t.media) && t.content === DARK['--bg-0']), tc);
ok('added to a Home Screen it opens as an app, named Hexagon', (meta('apple-mobile-web-app-capable')[0] || {}).content === 'yes' && (meta('apple-mobile-web-app-title')[0] || {}).content === 'Hexagon');
ok('iOS does not turn a figure into a phone link', (meta('format-detection')[0] || {}).content === 'telephone=no');
ok('the bar across the top blurs what scrolls under it, in Safari too', /-webkit-backdrop-filter:[^;]*blur/.test(deskCss) && /[^-]backdrop-filter:[^;]*blur/.test(deskCss));
const outsideHover = noComments(deskCss).replace(/@media \(hover: hover\) \{[\s\S]*?\n\}/g, '');
ok('hover looks only where a pointer hovers: a finger leaves none stuck', /@media \(hover: hover\)/.test(deskCss) && !/:hover/.test(outsideHover), (outsideHover.match(/[^\n]*:hover[^\n]*/) || [])[0]);

// ---- the icons: tools/icons.js's drawing, in the sizes the page and the manifest name
const touch = (html.match(/<link rel="apple-touch-icon" href="([^"]+)">/) || [])[1];
ok('desk.html names its Home Screen icon and its manifest', touch === 'apple-touch-icon.png' && /<link rel="manifest" href="manifest\.webmanifest">/.test(html), touch);
let manifest = {};
try { manifest = JSON.parse(read('public/manifest.webmanifest')); } catch (e) { ok('the manifest is JSON', false, e.message); }
ok('the manifest opens / on its own, as Hexagon', manifest.start_url === '/' && manifest.display === 'standalone' && manifest.short_name === 'Hexagon');
const files = { 'apple-touch-icon.png': 180, ...Object.fromEntries((manifest.icons || []).map((i) => [i.src, +String(i.sizes).split('x')[0]])) };
ok('every icon named is one tools/icons.js draws, at that size', Object.entries(files).every(([f, n]) => icons.SIZES[f] === n), files);
const C = icons.colours(tokensCss);
for (const [f, n] of Object.entries(icons.SIZES)) {
  let got = null;
  try { got = icons.unpng(fs.readFileSync(path.join(root, 'public', f))); } catch (e) { ok(`public/${f} is there`, false, e.message); continue; }
  ok(`public/${f} is ${n}x${n} and what tools/icons.js draws in tokens.css's colours (run it after changing them)`, got.size === n && got.colorType === 2 && got.rgb.equals(icons.draw(n, C)), got.size);
}
ok('the tab\'s icon is the app icon, in the same colours', ['--icon-top', '--icon-bottom', '--icon-core'].every((k) => read('public/favicon.svg').includes(T[k])));

// ---- what the server hands out before the login: the icons and the manifest, and nothing else
const open = (server.match(/const OPEN_FILES = new Set\(\[([^\]]*)\]\)/) || [])[1];
const openList = open ? [...open.matchAll(/'([^']+)'/g)].map((m) => m[1]) : [];
ok('the server serves the icons and the manifest without the login, since a Home Screen asks for them before one',
  ['/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png', '/manifest.webmanifest'].every((f) => openList.includes(f)), openList);
ok('...and nothing else: no page, no script, no sheet, no API', openList.every((f) => /^\/[\w-]+\.(png|svg|webmanifest)$/.test(f)), openList);
ok('...and it does that before the login check, not in place of it', server.indexOf('if (OPEN_FILES.has(p))') > 0 && server.indexOf('if (OPEN_FILES.has(p))') < server.indexOf('if (!authed(req, who))'));
ok('the server names the manifest\'s type', /'\.webmanifest': 'application\/manifest\+json'/.test(server));
ok('the login page is the floor\'s own: the system font, light or dark, and the app\'s icon',
  /const LOGIN_PAGE[\s\S]*?color-scheme: light dark[\s\S]*?-apple-system[\s\S]*?apple-touch-icon\.png/.test(server));
ok('the login\'s fields are 17px, so Safari on an iPhone does not zoom to them', /const LOGIN_PAGE[\s\S]*?label \{[^}]*font-size: 17px/.test(server) && /input \{[^}]*font: inherit/.test(server));
ok('the login rings the field that has the keyboard, not the whole group', /const LOGIN_PAGE[\s\S]*?input:focus-visible \{ outline: 2px solid var\(--focus\)/.test(server) && !/\.fields:focus-within/.test(server));

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

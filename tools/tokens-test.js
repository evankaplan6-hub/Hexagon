'use strict';
// The desk's design tokens (public/tokens.css) and the one sheet built on them (public/desk.css):
// every text colour reads at 4.5:1 or better on every surface, the ratios the comments claim are the
// ratios the colours give, desk.css writes no colour of its own, nothing names a token that is not
// there, and the fonts desk.html asks for cover every weight the sheet uses.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const tokensCss = read('public/tokens.css'), deskCss = read('public/desk.css'), html = read('public/desk.html'), js = read('public/desk.js');

// ---- the tokens, and what each comment says about it
const noComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '');
const T = {}, claims = {};
for (const line of tokensCss.split('\n')) {
  const m = line.match(/^\s*(--[\w-]+)\s*:\s*([^;]+);\s*(?:\/\*(.*?)\*\/)?/);
  if (!m) continue;
  T[m[1]] = m[2].trim();
  const c = m[3] && m[3].match(/(\d+(?:\.\d+)?):1/);
  if (c) claims[m[1]] = { ratio: +c[1], on: (m[3].match(/on (--[\w-]+)/) || [])[1] || '--bg-1' };
}
ok('tokens.css defines its tokens on :root', /:root\s*\{/.test(tokensCss) && Object.keys(T).length > 40, Object.keys(T).length);

const lin = (v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const lum = (hex) => { const c = [1, 3, 5].map((i) => lin(parseInt(hex.slice(i, i + 2), 16) / 255)); return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; };
const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
const hex = (name) => { const v = T[name]; ok(`${name} is a six-digit hex colour`, /^#[0-9a-f]{6}$/i.test(v || ''), v); return v; };

const INKS = ['--ink-1', '--ink-2', '--ink-3', '--gain', '--loss', '--ok', '--warn', '--bad'];
const GROUNDS = ['--bg-0', '--bg-1'];
for (const ink of INKS) for (const g of GROUNDS) {
  const r = ratio(hex(ink), hex(g));
  ok(`${ink} on ${g} reads at 4.5:1 or better`, r >= 4.5, +r.toFixed(2));
}
ok('a picked segment\'s label (--ink-1 on --line-2) reads at 4.5:1 or better', ratio(hex('--ink-1'), hex('--line-2')) >= 4.5);
ok('the faintest ink is the one labels use, and it is not faint', ratio(hex('--ink-3'), hex('--bg-1')) >= 6);
for (const [name, c] of Object.entries(claims)) {
  const r = ratio(hex(name), hex(c.on));
  ok(`${name}'s comment says ${c.ratio}:1 on ${c.on}, and it is`, Math.abs(r - c.ratio) < 0.06, +r.toFixed(2));
}
ok('the books are three different colours from the money colours', new Set(['--book-crypto', '--book-stocks', '--book-options', '--gain', '--loss'].map((n) => T[n])).size === 5);

// ---- desk.css writes no colour of its own (a mask's colour is only its alpha, so masks may)
const RAW = /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(|\b(?:white|black|red|green|blue|gray|grey|silver|orange|yellow|purple|pink)\b/i;
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
ok('desk.js reads its chart and canvas colours from tokens.css', jsNames.length >= 5 && jsNames.every((n) => n in T), jsNames.filter((n) => !(n in T)));
const jsVars = [...js.matchAll(/var\((--[\w-]+)\)/g)].map((m) => m[1]);
ok('every var() desk.js writes into a style names a real token', jsVars.every((v) => v in T), jsVars.filter((v) => !(v in T)));
// the type and space scales are there for the layout step; everything else should be in use
const everywhere = new Set([...used, ...tokUsedInTokens, ...jsNames, ...jsVars]);
const idle = Object.keys(T).filter((n) => !everywhere.has(n) && !/^--(type|space)-/.test(n));
ok('every token outside the type and space scales is used', idle.length === 0, idle);
ok('the books take their colour from the tokens, not from desk.js', /crypto: 'var\(--book-crypto\)'/.test(js) && !/BOOK_COLOR = \{[^}]*#/.test(js));

// ---- the page loads the tokens, then its own sheet, and not /pm's
const links = [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1]);
ok('desk.html loads tokens.css, then desk.css, and nothing else of ours', JSON.stringify(links) === JSON.stringify(['tokens.css', 'desk.css']), links);
ok('desk.html does not load style.css', !/style\.css/.test(html));
ok('the mark is drawn in the text colour, not a hex of its own', !/(?:stroke|fill)="#/.test(html));

// ---- every weight the sheet uses is a weight the fonts were asked for
const fontsUrl = (html.match(/href="(https:\/\/fonts\.googleapis\.com\/css2\?[^"]+)"/) || [])[1] || '';
const loaded = {};
for (const m of fontsUrl.matchAll(/family=([^:&]+):wght@([\d.;]+)/g)) {
  const fam = decodeURIComponent(m[1]).replace(/\+/g, ' ');
  const spec = m[2];
  loaded[fam] = spec.includes('..') ? (() => { const [a, b] = spec.split('..').map(Number); return (w) => w >= a && w <= b; })() : ((ws) => (w) => ws.includes(w))(spec.split(';').map(Number));
}
ok('the fonts ask for Inter and JetBrains Mono', loaded.Inter && loaded['JetBrains Mono'], Object.keys(loaded));
const weights = new Set([400]);
for (const [p, v] of decls) {
  if (p === 'font-weight' && /^\d{3}$/.test(v)) weights.add(+v);
  if (p === 'font') { const w = v.match(/^(?:italic\s+)?(\d{3})\b/); if (w) weights.add(+w[1]); }
}
const missing = [...weights].filter((w) => !(loaded.Inter && loaded.Inter(w) && loaded['JetBrains Mono'] && loaded['JetBrains Mono'](w)));
ok('every font weight desk.css uses is loaded for both families', missing.length === 0, { used: [...weights].sort(), missing });

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

'use strict';
// Static contract for the lookout: the painted room that shows the desk from /api/stream.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/lookout.html'), js = read('public/lookout.js'), css = read('public/lookout.css'), index = read('public/index.html');
ok('the floor links to the lookout and the lookout links back', /href="lookout\.html"/.test(index) && /href="\/"/.test(html));
ok('the room is the painted scene asset', /assets\/lookout-concept-a\.png/.test(html) && fs.existsSync(path.join(root, 'public/assets/lookout-concept-a.png')));
ok('all seven named desks exist', ['BRAM', 'KETT', 'RIGO', 'TESS', 'HOLT', 'ILSA', 'MAKR'].every((k) => html.includes(`data-agent="${k}"`)));
ok('it reads the same stream as the floor', /new EventSource\('\/api\/stream'\)/.test(js));
ok('it only reads: no POST, fetch, socket or trading control', !/(fetch\s*\(|XMLHttpRequest|WebSocket|method:|POST)/.test(js) && !/(sell|flatten|resume)/i.test(html + js));
ok('no made-up numbers are left in the page', !/\$9,915|−\$84\.12|−\$11\.04/.test(html + js));
ok('a stopped stream is shown, not frozen', /STALE_MS/.test(js) && /THE FLOOR WENT QUIET/.test(js));
ok('live mode is labelled as real money', /Real money/.test(js) && /\.mode\.real/.test(css));
ok('scene keeps the image ratio', /aspect-ratio:1672\/941/.test(css));
ok('reduced motion is supported', /prefers-reduced-motion/.test(css));
console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

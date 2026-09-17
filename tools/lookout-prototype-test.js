'use strict';
// Static contract for the gated fixture-only visual prototype.
const fs=require('fs'),path=require('path');
let pass=0,fail=0;const ok=(n,c)=>{if(c)pass++;else{fail++;console.log(`  FAIL  ${n}`)}};
const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'public/lookout-prototype.html'),'utf8'),js=fs.readFileSync(path.join(root,'public/lookout-prototype.js'),'utf8'),css=fs.readFileSync(path.join(root,'public/lookout-prototype.css'),'utf8');
ok('prototype exists separately from the operator dashboard',/Lookout Prototype A/.test(html)&&!/lookout-prototype/.test(fs.readFileSync(path.join(root,'public/index.html'),'utf8')));
ok('selected concept A is the scene asset',/assets\/lookout-concept-a\.png/.test(html)&&fs.existsSync(path.join(root,'public/assets/lookout-concept-a.png')));
ok('all seven named desks exist', ['BRAM','KETT','RIGO','TESS','HOLT','ILSA','MAKR'].every((k)=>html.includes(`data-agent="${k}"`)));
ok('busy quiet fill halt and stale fixtures exist', ['busy','quiet','fill','halt','stale'].every((k)=>new RegExp(`${k}:\\{`).test(js)));
ok('prototype makes no network request',!/(EventSource|fetch\s*\(|XMLHttpRequest|WebSocket)/.test(js));
ok('prototype has no mutation or trading controls',!/(sell|flatten|resume|research|POST)/i.test(html+js));
ok('scene keeps the approved image ratio',/aspect-ratio:1672\/941/.test(css));
ok('three wall instruments share headers, headlines and supporting facts',html.match(/class="screen /g)?.length===3&&html.match(/class="screenbar"/g)?.length===3&&html.match(/class="facts"/g)?.length===2);
ok('widget fixtures cover portfolio and maker density', ['positions','locked','inventory','fills','deskStatus'].every((id)=>html.includes(`id="${id}"`)));
ok('reduced motion is supported',/prefers-reduced-motion/.test(css));
console.log(`\n${pass} passed, ${fail} failed`);process.exit(fail?1:0);

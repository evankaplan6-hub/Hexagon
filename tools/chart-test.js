'use strict';
// Pure arithmetic behind the browser P&L chart. Lift the exact functions from public/app.js so a
// dashboard refactor cannot quietly turn one ledger into two, shorten a selected range, or draw a
// value outside the dollar scale printed beside it.
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, got === want, got);

const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const line = (start) => {
  const i = src.indexOf(`\n  ${start}`);
  if (i < 0) throw new Error(`app.js no longer has "${start}"`);
  return src.slice(i + 1, src.indexOf('\n', i + 1));
};
const fn = (name) => {
  const i = src.indexOf(`\n  function ${name}(`);
  if (i < 0) throw new Error(`app.js no longer has function ${name}`);
  return src.slice(i + 1, src.indexOf('\n  }\n', i) + 4);
};
const lifted = [line('const r2 = '), fn('combinePnlHistory'), fn('windowPnlPoints'), fn('niceAxis')].join('\n');
const { combinePnlHistory, windowPnlPoints, niceAxis } = new Function(
  `${lifted}\nreturn { combinePnlHistory, windowPnlPoints, niceAxis };`)();

{
  const combined = combinePnlHistory(
    [{ t: 1, b: 95 }, { t: 3, b: 94 }],
    [{ t: 2, e: -2 }, { t: 4, e: -3 }], 100);
  eq('the two ledgers carry forward on their own clocks', JSON.stringify(combined), JSON.stringify([
    { t: 2, v: -7 }, { t: 3, v: -8 }, { t: 4, v: -9 },
  ]));
  eq('history before an accounting repair is excluded', JSON.stringify(combinePnlHistory(
    [{ t: 1, b: 95 }, { t: 4, b: 94 }], [{ t: 2, e: -2 }, { t: 4, e: -3 }], 100, 4)),
  JSON.stringify([{ t: 4, v: -9 }]));
  eq('the account ledger carries into the repair; only the maker history is cut', JSON.stringify(combinePnlHistory(
    [{ t: 1, b: 95 }], [{ t: 2, e: -2 }, { t: 5, e: -3 }], 100, 3)),
  JSON.stringify([{ t: 5, v: -8 }]));
  ok('one ledger is never mislabeled as all paper trades', combinePnlHistory([{ t: 1, b: 95 }], [], 100).length === 0);

  const windowed = windowPnlPoints([{ t: 1, v: -1 }, { t: 5, v: -2 }, { t: 9, v: -3 }], 10, 3);
  eq('a range begins with the step that was live at its cutoff', JSON.stringify(windowed), JSON.stringify([{ t: 5, v: -2 }, { t: 9, v: -3 }]));

  const axis = niceAxis([{ t: 1, v: -966.65 }, { t: 2, v: -319.51 }]);
  ok('the loss scale rounds outward to clean $200 ticks', axis.lo === -1000 && axis.hi === -200 && axis.step === 200, axis);
  ok('every plotted value remains inside the rounded axis', -966.65 >= axis.lo && -319.51 <= axis.hi, axis);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

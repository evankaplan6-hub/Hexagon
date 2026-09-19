'use strict';
// The desk's own trading volume: what counts as a trade, the minute buckets, and the rebuild from
// the journal so a restart does not empty the chart.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeVolume, trade, KEEP_MS } = require('../src/volume');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), got);

const T0 = Date.UTC(2026, 8, 19, 12, 0, 0);   // on a minute

// what counts as a trade
eq('a maker fill is contracts and its price', trade('MAKER_FILL', { qty: 10, px: 0.4 }), [10, 0.4]);
eq('a maker flatten is a sale', trade('MAKER_FLATTEN', { qty: 5, px: 0.2 }), [5, 0.2]);
eq('a cross-venue open is contracts at the entry', trade('OPEN', { qty: 3, entry: 0.55 }), [3, 0.55]);
eq('an early unwind is contracts at the exit', trade('CLOSE', { qty: 3, exit: 0.6 }), [3, 0.6]);
eq('a partial exit counts what was sold, not what is left', trade('CLOSE_PARTIAL', { sold: 2, remaining: 9, exit: 0.7 }), [2, 0.7]);
eq('a settlement is a payout, not a trade', trade('SETTLE', { qty: 3, exit: 1 }), null);
eq('a log line is not a trade', trade('MAKER_COOL', { qty: 3 }), null);

// the minute buckets
{
  const v = makeVolume();
  v.note('MAKER_FILL', { qty: 10, px: 0.5 }, T0 + 5000);
  v.note('MAKER_FILL', { qty: 4, px: 0.25 }, T0 + 50000);   // the same minute
  v.note('OPEN', { qty: 2, entry: 0.5 }, T0 + 61000);       // the next
  eq('fills in one minute add up: contracts and dollars', v.entries(T0 + 90000), [[T0, 14, 6], [T0 + 60000, 2, 1]]);
  v.note('MAKER_FILL', { qty: 'x', px: 0.5 }, T0);
  v.note('MAKER_FILL', { qty: 5, px: null }, T0);
  v.note('MAKER_FILL', { qty: 5, px: 0 }, T0);
  v.note('MAKER_FILL', { qty: 0, px: 0.5 }, T0);
  v.note('CLOSE', { qty: 5 }, T0);
  eq('rubbish is ignored, not counted as zero or NaN', v.entries(T0 + 90000).length, 2);
  v.note('MAKER_FLATTEN', { qty: -8, px: 0.5 }, T0 + 120000);
  eq('a short position flattening still counts its size', v.entries(T0 + 150000)[2], [T0 + 120000, 8, 4]);
  eq('entries are oldest first', v.entries(T0 + 150000).map((e) => e[0]), [T0, T0 + 60000, T0 + 120000]);
  eq('minutes older than the keep window are dropped', v.entries(T0 + KEEP_MS + 100000).length, 1);
}

// the rebuild from the journal
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vol-'));
  const line = (t, kind, p) => JSON.stringify({ t: new Date(t).toISOString(), cycle: 1, mode: 'paper', kind, ...p });
  fs.writeFileSync(path.join(dir, 'journal-2026-09-19.jsonl'), [
    line(T0 + 1000, 'MAKER_FILL', { qty: 10, px: 0.5 }),
    line(T0 + 2000, 'SETTLE', { qty: 99, exit: 1 }),
    line(T0 + 3000, 'MAKER_COOL', { qty: 99 }),
    'not json but mentions "kind":"OPEN"',
    line(T0 + 70000, 'CLOSE_PARTIAL', { sold: 4, exit: 0.5 }),
    line(T0 - 20 * 864e5, 'MAKER_FILL', { qty: 50, px: 0.5 }),   // long gone
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, 'ticks-2026-09-19.jsonl'), line(T0, 'MAKER_FILL', { qty: 1e6, px: 1 }));   // not a journal
  const v = makeVolume();
  eq('the journal is read: fills counted, settlements, noise, junk and old lines not', v.load(dir, T0 + 100000), 2);
  eq('and the buckets match what was written', v.entries(T0 + 100000), [[T0, 10, 5], [T0 + 60000, 4, 2]]);
  eq('a missing directory is an empty chart, not an error', makeVolume().load(path.join(dir, 'nope')), 0);
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

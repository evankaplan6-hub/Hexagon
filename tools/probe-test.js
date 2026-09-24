'use strict';
// Assertions for the thin-market probe (src/probe.js). No network: the venue modules are stubbed
// in the require cache before probe.js loads, and the clock is frozen.
//
// This file exists because the probe's failure mode was invisible. PROBE_GAP sat at 10c against a
// pre-game book whose widest recorded gap was 3c, so it took zero samples for its entire life and
// nothing said so. A threshold that can never fire is a test case, not a tuning question.
//
//   node tools/probe-test.js
const path = require('path');

const stub = (rel, exports) => {
  const f = require.resolve(rel);
  require.cache[f] = { id: f, filename: f, loaded: true, exports, children: [], paths: [] };
};
let pmCalls = 0, ksCalls = 0, probed = [];
stub('../src/venues/polymarket', { fetchBook: async (tok) => { pmCalls++; probed.push(String(tok).replace(/^tok/, '')); return { bids: [{ price: 0.50, size: 100 }], asks: [{ price: 0.51, size: 200 }] }; } });
stub('../src/venues/kalshi', { fetchBook: async () => { ksCalls++; return { yesBids: [{ price: 0.54, size: 300 }], yesAsks: [{ price: 0.55, size: 400 }] }; } });

const { makeProbe } = require('../src/probe');
const baseCfg = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => { if (cond) { pass++; return; } fail++; console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); };
const group = (n) => console.log(`\n${n}`);

const T0 = 1788900000000;
const HOUR = 3600000;
const mkPair = (id, gap, opts = {}) => {
  const pmMid = 0.50, ksMid = 0.50 + gap;
  return {
    id, label: `pair ${id}`, kind: 'game', series: 'KXTEST', inPlay: !!opts.inPlay,
    pm: { tokenId: `tok${id}` }, ks: { ticker: `KXTEST-${id}` },
    q: { pmBid: pmMid - 0.005, pmAsk: pmMid + 0.005, ksBid: ksMid - 0.005, ksAsk: ksMid + 0.005, pmMid, ksMid, pmVol: 1e5, ksVol: 1e5 },
  };
};
const fakeE = (pairs, opts = {}) => {
  const logs = [];
  return { pairs, cycle: 1, logs, log: (a, k, p, t) => logs.push(t), due: opts.due === undefined ? () => true : opts.due };
};
const tmp = path.join(process.env.TMPDIR || '/tmp', `probe-test-${process.pid}`);
const cfg = (over = {}) => ({ ...baseCfg, dataDir: tmp, record: true, ...over });

(async () => {
  const RealNow = Date.now;
  let clock = T0;
  Date.now = () => clock;
  try {
    group('the shipped threshold fires on the book this desk actually sees');
    {
      // 3.00c is the widest pre-game gap in 17,649 recorded non-in-play ticks. At the old 0.10 it
      // was 3x under the trigger; at minGap it is exactly the case worth validating.
      const p = makeProbe(cfg());
      pmCalls = ksCalls = 0;
      await p(fakeE([mkPair('a', 0.030)]));
      ok('a 3.0c pre-game gap is probed', pmCalls === 1 && ksCalls === 1, { pmCalls, ksCalls });

      const old = makeProbe(cfg({ probeGap: 0.10 }));
      pmCalls = ksCalls = 0;
      await old(fakeE([mkPair('b', 0.030)]));
      ok('...and would NOT have been at the old 10c', pmCalls === 0 && ksCalls === 0, { pmCalls, ksCalls });
    }

    group('in-play stays excluded, however wide');
    {
      const p = makeProbe(cfg());
      pmCalls = ksCalls = 0;
      await p(fakeE([mkPair('c', 0.22, { inPlay: true })]));
      ok('a 22c in-play gap is still ignored', pmCalls === 0, { pmCalls });
    }

    group('a dark probe says so, and says which number would end it');
    {
      const p = makeProbe(cfg());
      const quiet = [mkPair('d', 0.008)];            // under the threshold: nothing to probe
      const E = fakeE(quiet);
      await p(E);
      ok('a freshly booted desk does NOT cry darkness', E.logs.length === 0, E.logs);

      clock = T0 + HOUR + 1000;                       // ...an hour later, with still nothing taken
      await p(E);
      ok('after an hour of nothing, it reports', E.logs.length === 1, E.logs);
      const line = E.logs[0] || '';
      ok('names the widest gap it actually saw', line.includes('0.8c'), line);
      ok('names the threshold it was measured against', line.includes('3.0c'), line);
      ok('and says the threshold is the problem', line.includes('above anything this book offers'), line);
    }

    group('a probe that IS firing never reports darkness');
    {
      const p = makeProbe(cfg());
      const E = fakeE([mkPair('e', 0.05)]);
      await p(E);
      clock += HOUR + 1000;
      await p(fakeE([mkPair('e', 0.05)]));           // still there, already probed today
      ok('no darkness line while samples are landing', E.logs.length === 0, E.logs);
    }

    group('the per-pair cooldown and per-cycle cap still bound the API cost');
    {
      const p = makeProbe(cfg({ probesPerCycle: 2 }));
      pmCalls = ksCalls = 0; probed = [];
      const many = [mkPair('f', 0.20), mkPair('g', 0.15), mkPair('h', 0.10), mkPair('i', 0.05)];
      await p(fakeE(many));
      ok('at most probesPerCycle probes per cycle', pmCalls === 2, { pmCalls });
      ok('and it takes the two WIDEST', probed.join(',') === 'f,g', probed);

      probed = [];
      clock += 1000;                                  // inside the 600s cooldown
      await p(fakeE(many));
      ok('the two just probed are skipped, not re-probed', !probed.includes('f') && !probed.includes('g'), probed);
      ok('so the next-widest pair gets its turn', probed.join(',') === 'h,i', probed);

      probed = [];
      clock += baseCfg.probeEverySec * 1000 + 1000;   // past the cooldown, same day, same gaps
      await p(fakeE(many));
      ok('a steady pair is not probed again the same day, cooldown or not', probed.length === 0, probed);
    }

    group('once per ET day, again only when the gap moves 1c, never while watch-only (2026-09-24)');
    {
      // 2026-09-23: 5,206 probes, 3,005 of them on watch-only pairs, KXBOND-30-ATJ alone 147 times
      const noon = Date.parse('2026-09-23T16:00:00Z');   // 12:00 ET
      clock = noon;
      const p = makeProbe(cfg());
      probed = [];
      const watch = { ...mkPair('w', 0.05), watchOnly: 'unclear' };
      await p(fakeE([watch]));
      ok('a watch-only pair with a 5c gap is not probed', probed.length === 0, probed);
      const steady = mkPair('s', 0.05);
      await p(fakeE([steady]));
      ok('a steady pair is probed once', probed.join(',') === 's', probed);
      for (let i = 1; i <= 20; i++) { clock = noon + i * 11 * 60000; await p(fakeE([steady])); }
      ok('...and not again across the next 3h40m of the same ET day', probed.join(',') === 's', probed);
      clock += 11 * 60000;
      await p(fakeE([mkPair('s', 0.059)]));
      ok('0.9c wider is not enough', probed.join(',') === 's', probed);
      await p(fakeE([mkPair('s', 0.06)]));
      ok('1c wider than its last probe: probed again', probed.join(',') === 's,s', probed);
      clock += 60000;
      await p(fakeE([mkPair('s', 0.08)]));
      ok('...but never inside probeEverySec, however far it moved', probed.join(',') === 's,s', probed);
      clock += baseCfg.probeEverySec * 1000;
      await p(fakeE([mkPair('s', 0.055)]));
      ok('0.5c narrower is not enough either', probed.join(',') === 's,s', probed);
      await p(fakeE([mkPair('s', 0.05)]));
      ok('1c narrower than its last probe: probed again', probed.join(',') === 's,s,s', probed);
      clock = Date.parse('2026-09-24T04:05:00Z');     // 00:05 ET: a new Eastern day
      await p(fakeE([mkPair('s', 0.05)]));
      ok('a new ET day: probed once more, gap unchanged', probed.join(',') === 's,s,s,s', probed);
    }
  } finally {
    Date.now = RealNow;
    try { require('fs').rmSync(tmp, { recursive: true, force: true }); } catch {}
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

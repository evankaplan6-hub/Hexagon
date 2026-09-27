'use strict';
// The settlement-lag study (tools/settle-lag.js) on a made-up tape: the 99c reading, and from the
// watch's pmClosedAt on (2026-09-27), what Kalshi offered the winner after Polymarket's close, for how
// long, and with how much at the touch. No network, no clock; the disk only in a temp folder.
//
//   node tools/settle-lag-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { study } = require('./settle-lag');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const T0 = Date.parse('2026-09-27T20:00:00Z');
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
// one game row every 15 seconds, the way the recorder writes them
const row = (pair, label, sec, o) => ({ t: iso(sec), qt: iso(sec), cycle: sec, pair, label, kind: 'game', series: 'KXNFLGAME', inPlay: true, pmVol: 1, ksVol: 1, ...o });

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-settle-lag-'));
  try {
    const lines = [];
    // Vikings: Polymarket reads 99c at +0; stops taking orders at +10s; closes at +100s. Kalshi offers
    // the winner at 93c at the close (120 at the touch), 94c at +130s, then 99c from +160s.
    const vik = 'pmV:0|KXNFLGAME-26SEP27MINGB-MIN';
    for (let s = -30; s <= 400; s += 15) {
      const closed = s >= 105, halted = s >= 15, kept = s >= 60;
      const ks = s < 150 ? { ksBid: 0.9, ksAsk: s < 120 ? 0.93 : 0.94, ksBidSize: 40, ksAskSize: s < 120 ? 120 : 80 } : { ksBid: 0.99, ksAsk: 1, ksBidSize: 5000, ksAskSize: 0 };
      const pm = s < 0 ? { pmBid: 0.95, pmAsk: 0.97 } : { pmBid: 0.99, pmAsk: 1 };
      const o = { ...pm, ...ks };
      if (kept) { o.pmGone = true; o.qt = iso(45); o.ksQt = iso(s); }
      if (halted) o.pmHaltedAt = iso(10);
      if (closed) o.pmClosedAt = iso(100);
      lines.push(row(vik, 'NFL Vikings v Packers · Vikings', s, o));
    }
    // Packers-style NO game: closes at +40s with Kalshi already at 0/1 for YES (the winner NO at 100c)
    const no = 'pmN:0|KXNFLGAME-26SEP27DALNYG-DAL';
    for (let s = 0; s <= 200; s += 15) {
      lines.push(row(no, 'NFL Cowboys v Giants · Cowboys', s, { pmBid: 0, pmAsk: 0.01, ksBid: 0, ksAsk: 0.01, ksBidSize: 0, ksAskSize: 90000, ...(s >= 45 ? { pmClosedAt: iso(40) } : {}) }));
    }
    // a game Polymarket read settled but never closed on the tape (the old tapes all look like this)
    const open = 'pmO:0|KXMLBGAME-26SEP27NYMWSH-NYM';
    for (let s = 0; s <= 60; s += 15) lines.push(row(open, 'MLB Mets v Nationals · Mets', s, { pmBid: 0.99, pmAsk: 1, ksBid: 0.99, ksAsk: 1 }));
    // Kalshi still under par when the tape let the pair go: the window is "at least"
    const late = 'pmL:0|KXNFLGAME-26SEP27KCBUF-KC';
    for (let s = 0; s <= 120; s += 15) lines.push(row(late, 'NFL Chiefs v Bills · Chiefs', s, { pmBid: 0.99, pmAsk: 1, ksBid: 0.9, ksAsk: 0.92, ksBidSize: 10, ksAskSize: 30, ...(s >= 30 ? { pmClosedAt: iso(30), pmGone: true, qt: iso(15), ksQt: iso(s) } : {}) }));
    const file = path.join(dir, 'ticks-2026-09-27.jsonl');
    fs.writeFileSync(file, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');

    group("after Polymarket stops taking orders, and after it closes: what Kalshi offered, for how long, how many at the touch");
    const out = [];
    const r = await study(file, { out: (s) => out.push(s) });
    const by = (lbl) => r.settled.find((f) => f.label.startsWith(lbl));
    const v = by('NFL Vikings'), n = by('NFL Cowboys'), k = by('NFL Chiefs'), m = by('MLB Mets');
    ok('three games closed on the tape, one stopped taking orders; the one Polymarket never closed has neither', r.closed.length === 3 && r.halted.length === 1 && !m.close && !m.halt, { closed: r.closed.map((f) => f.label), halted: r.halted.map((f) => f.label) });
    ok('Vikings: stopped taking orders 10s after the 99c reading, closed 100s after it', v && v.halt.afterSec === 10 && v.halt.at === '20:00:10' && v.close.afterSec === 100 && v.close.at === '20:01:40', v && { halt: v.halt, close: v.close });
    ok('...once orders stopped, Kalshi offered the winner at 93c with 120 at the touch, and stayed 2c+ net until the +135s row: 2m05s', v && Math.abs(v.halt.px - 0.93) < 1e-9 && v.halt.size === 120 && v.halt.worth && v.halt.underSec === 125 && v.halt.maxSize === 120 && v.halt.open === false, v && v.halt);
    ok('...once closed, 93c, ~6.5c net, 2c+ for 35s, at most 120 at the touch, then shut', v && Math.abs(v.close.px - 0.93) < 1e-9 && v.close.net > 0.06 && v.close.net < 0.07 && v.close.underSec === 35 && v.close.maxSize === 120 && v.close.open === false, v && v.close);
    ok('Cowboys (NO won): Kalshi already at par at the close, no window', n && n.winner === 'NO' && n.close.worth === false && n.close.underSec === 0, n && n.close);
    ok('Chiefs: still 2c+ under par on the last row: "at least" 90s', k && k.close.open === true && k.close.underSec === 90 && k.close.maxSize === 30, k && k.close);
    const text = out.join('\n');
    ok('the summary says what Kalshi offered once orders stopped', /once Polymarket stopped taking orders \(seen in 1 of those 4, a median 10s after the 99c reading\): Kalshi 2c\+ net under par then in 1: NFL Vikings v Packers [\d.]+c for 2m05s \(120 at the touch\) · for a minute or more in 1/.test(text), text);
    ok('...and once the market closed', /once Polymarket closed the market \(3 of those 4 closed on the tape, a median 40s after the 99c reading\): Kalshi 2c\+ net under par then in 2: NFL Chiefs v Bills [\d.]+c for ≥1m30s \(30 at the touch\), NFL Vikings v Packers [\d.]+c for 35s \(120 at the touch\) · for a minute or more in 1/.test(text), text);
    ok('the Vikings get their own lines', /Polymarket read YES at 20:00:00 · stopped taking orders by 20:00:10 \(\+10s\) · closed at 20:01:40 \(\+1m40s\)/.test(text) && /once Polymarket stopped taking orders, Kalshi offered the winner at 93c \(120 at the touch\)/.test(text) && /once Polymarket closed it, Kalshi offered the winner at 93c/.test(text), text);

    group('a Kalshi quote that stopped repricing is not an offer');
    {
      const stale = [];
      const id = 'pmS:0|KXNFLGAME-26SEP27SFLA-SF';
      for (let s = 0; s <= 120; s += 15) stale.push(row(id, 'NFL 49ers v Rams · 49ers', s, { pmBid: 0.99, pmAsk: 1, ksBid: 0.9, ksAsk: 0.93, ksAskSize: 50, ...(s >= 30 ? { pmClosedAt: iso(30), pmGone: true, qt: iso(0), ksQt: iso(15) } : {}) }));
      const f2 = path.join(dir, 'ticks-stale.jsonl');
      fs.writeFileSync(f2, stale.map((l) => JSON.stringify(l)).join('\n') + '\n');
      const r2 = await study(f2, { out: () => {} });
      const c = r2.closed[0] && r2.closed[0].close;
      ok("Kalshi's side last repriced at +15s: only its fresh rows count, so the window ends there", c && c.underSec === 15, c);
    }

    group('an old tape (no pmClosedAt) says so, and nothing else changes');
    {
      const f3 = path.join(dir, 'ticks-old.jsonl');
      fs.writeFileSync(f3, lines.filter((l) => l.pair === open).map((l) => JSON.stringify(l)).join('\n') + '\n');
      const o3 = [];
      const r3 = await study(f3, { out: (s) => o3.push(s) });
      ok('no close on the tape: one line says the watch starts 2026-09-27', r3.closed.length === 0 && r3.halted.length === 0 && /no row on this tape says when Polymarket stopped or closed a game/.test(o3.join('\n')), o3);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

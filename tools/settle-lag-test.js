'use strict';
// The settlement-lag study (tools/settle-lag.js) on a made-up tape: the 99c reading, and from the
// watch's pmProposedAt and pmClosedAt on, what Kalshi offered the winner, for how long, and with how much
// at the touch; and which venue closed each game first, from the watch's journal lines and (stubbed) the
// venues' own records. No network, no clock; the disk only in a temp folder.
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
    // Vikings: Polymarket reads 99c at +0; its resolver proposes at +10s; closes at +100s. Kalshi offers
    // the winner at 93c at the close (120 at the touch), 94c at +130s, then 99c from +160s.
    const vik = 'pmV:0|KXNFLGAME-26SEP27MINGB-MIN';
    for (let s = -30; s <= 400; s += 15) {
      const closed = s >= 105, proposed = s >= 15, kept = s >= 60;
      const ks = s < 150 ? { ksBid: 0.9, ksAsk: s < 120 ? 0.93 : 0.94, ksBidSize: 40, ksAskSize: s < 120 ? 120 : 80 } : { ksBid: 0.99, ksAsk: 1, ksBidSize: 5000, ksAskSize: 0 };
      const pm = s < 0 ? { pmBid: 0.95, pmAsk: 0.97 } : { pmBid: 0.99, pmAsk: 1 };
      const o = { ...pm, ...ks };
      if (kept) { o.pmGone = true; o.qt = iso(45); o.ksQt = iso(s); }
      if (proposed) o.pmProposedAt = iso(10);
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

    group("after Polymarket's resolver proposes the result, and after it closes: what Kalshi offered, for how long, how many at the touch");
    const out = [];
    const r = await study(file, { out: (s) => out.push(s) });
    const by = (lbl) => r.settled.find((f) => f.label.startsWith(lbl));
    const v = by('NFL Vikings'), n = by('NFL Cowboys'), k = by('NFL Chiefs'), m = by('MLB Mets');
    ok('three games closed on the tape, one was proposed; the one Polymarket never closed has neither', r.closed.length === 3 && r.proposed.length === 1 && !m.close && !m.proposal, { closed: r.closed.map((f) => f.label), proposed: r.proposed.map((f) => f.label) });
    ok('Vikings: proposed 10s after the 99c reading, closed 100s after it', v && v.proposal.afterSec === 10 && v.proposal.at === '20:00:10' && v.close.afterSec === 100 && v.close.at === '20:01:40', v && { proposal: v.proposal, close: v.close });
    ok('...once proposed, Kalshi offered the winner at 93c with 120 at the touch, and stayed 2c+ net until the +135s row: 2m05s', v && Math.abs(v.proposal.px - 0.93) < 1e-9 && v.proposal.size === 120 && v.proposal.worth && v.proposal.underSec === 125 && v.proposal.maxSize === 120 && v.proposal.open === false, v && v.proposal);
    ok('...once closed, 93c, ~6.5c net, 2c+ for 35s, at most 120 at the touch, then shut', v && Math.abs(v.close.px - 0.93) < 1e-9 && v.close.net > 0.06 && v.close.net < 0.07 && v.close.underSec === 35 && v.close.maxSize === 120 && v.close.open === false, v && v.close);
    ok('Cowboys (NO won): Kalshi already at par at the close, no window', n && n.winner === 'NO' && n.close.worth === false && n.close.underSec === 0, n && n.close);
    ok('Chiefs: still 2c+ under par on the last row: "at least" 90s', k && k.close.open === true && k.close.underSec === 90 && k.close.maxSize === 30, k && k.close);
    const text = out.join('\n');
    ok("the summary says what Kalshi offered once the resolver proposed", /once Polymarket's resolver proposed the result \(seen in 1 of those 4, a median 10s after the 99c reading\): Kalshi 2c\+ net under par then in 1: NFL Vikings v Packers [\d.]+c for 2m05s \(120 at the touch\) · for a minute or more in 1/.test(text), text);
    ok('...and once the market closed', /once Polymarket closed the market \(3 of those 4 closed on the tape, a median 40s after the 99c reading\): Kalshi 2c\+ net under par then in 2: NFL Chiefs v Bills [\d.]+c for ≥1m30s \(30 at the touch\), NFL Vikings v Packers [\d.]+c for 35s \(120 at the touch\) · for a minute or more in 1/.test(text), text);
    ok('the Vikings get their own lines', /Polymarket read YES at 20:00:00 · its resolver proposed it by 20:00:10 \(\+10s\) · closed at 20:01:40 \(\+1m40s\)/.test(text) && /once Polymarket's resolver proposed it, Kalshi offered the winner at 93c \(120 at the touch\)/.test(text) && /once Polymarket closed it, Kalshi offered the winner at 93c/.test(text) && /\[proposed\]/.test(text), text);
    ok('no journal and no --venues: the venues\' close times are not on record, and it says how to get them', /the close: neither venue's close time is on record for these games \(the watch journals both from 2026-09-30; --venues asks the venues\)/.test(text), text);

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
      ok('no proposal or close on the tape: one line says so', r3.closed.length === 0 && r3.proposed.length === 0 && /on the tape: no row says when Polymarket's resolver proposed or closed a game/.test(o3.join('\n')), o3);
    }

    group('which venue closed first: the watch\'s journal lines, then the venues for the rest (2026-09-30)');
    {
      // Phillies v Braves on 2026-09-29 is the shape: Kalshi closed 3 minutes after the 99c reading, paid
      // out 2 minutes later, and Polymarket closed 67 minutes after the reading. The Mets' line comes the
      // next day (a late game), with Kalshi still open at Polymarket's close.
      const j = (day, o) => JSON.stringify({ t: o.pmClosedAt, cycle: 1, mode: 'paper', kind: 'SNIPE_WATCH', ...o });
      fs.writeFileSync(path.join(dir, 'journal-2026-09-27.jsonl'), [
        JSON.stringify({ t: iso(0), kind: 'OPEN', id: 'x' }),
        j('2026-09-27', { pairId: vik, label: 'NFL Vikings v Packers · Vikings', won: 'yes', readAt: iso(0), proposedAt: iso(10), pmClosedAt: iso(4020), ks: { status: 'finalized', closedAt: iso(180), settledAt: iso(310), result: 'yes' } }),
      ].join('\n') + '\n');
      fs.writeFileSync(path.join(dir, 'journal-2026-09-28.jsonl'), j('2026-09-28', { pairId: open, label: 'MLB Mets v Nationals · Mets', won: 'yes', readAt: iso(0), proposedAt: iso(300), pmClosedAt: iso(1800), ks: { status: 'active', closedAt: null, settledAt: null } }) + '\n');
      const asked = [];
      const venues = async (games) => { asked.push(...games.map((x) => x.id)); return new Map(games.map((x) => [x.id, { source: 'venues', proposedAt: null, pmClosedAt: iso(1500), ks: { status: 'finalized', closedAt: iso(240), settledAt: iso(360) } }])); };
      const o4 = [];
      const r4 = await study(file, { out: (x) => o4.push(x), journals: ['journal-2026-09-27.jsonl', 'journal-2026-09-28.jsonl', 'journal-2026-09-29.jsonl'].map((f) => path.join(dir, f)), venues, all: true });
      const t4 = o4.join('\n');
      ok('the venues are asked only about the games the journal does not have', asked.sort().join() === [k.id, n.id].sort().join(), asked);
      ok('all four games timed, two from the journal (one from the next day\'s) and two from the venues', r4.timed.length === 4, r4.timed.map((f) => f.label));
      ok('the summary: Kalshi closed first in 3 of 3 it had closed, the Mets still open at Polymarket\'s close',
        /the close, by each venue's own record \(4 of those 4: 2 from the watch's journal, 2 from the venues\): Kalshi closed first in 3 of 3, a median 4m00s after the 99c reading, and paid out a median 6m00s after it; Polymarket closed a median 30m00s after it \(25m00s to 67m00s\) · Kalshi still open at Polymarket's close in 1: MLB Mets v Nationals$/m.test(t4), t4);
      ok("the resolver's proposals, from the journal: a median 5m00s after the reading, before Kalshi closed in 2 of 2", /Polymarket's resolver proposed the result a median 5m00s after the 99c reading, before Kalshi closed in 2 of 2/.test(t4), t4);
      ok('--all lists each game: the Vikings proposed +10s, Kalshi closed +3m00s, paid out +5m10s, Polymarket closed +67m00s', /NFL Vikings v Packers · Vikings\s+read at 20:00:00 · proposed \+10s · Kalshi closed \+3m00s, paid out \+5m10s · Polymarket closed \+67m00s/.test(t4), t4);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

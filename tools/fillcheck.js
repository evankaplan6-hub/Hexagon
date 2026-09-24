'use strict';
// Does the paper maker fill the way its own tape says it should, and where does it lose the rest?
//
//   node tools/fillcheck.js                       the newest closed day in data/fly/archive
//   node tools/fillcheck.js --days 3              ...the newest three
//   node tools/fillcheck.js --day 2026-09-20      a named ET day (repeatable)
//   node tools/fillcheck.js --dir /data --day 2026-09-21      on the box, against its own files
//   flags: --markets (the per-market table)   --makerParticipation 0.1 (or any maker tunable)
//
// Reads files and nothing else: no network, no box, no clock. One ET day is 50-100 MB of tape and
// is streamed, so this is safe on the 512 MB box too -- but the Mac's pulled copy costs the box nothing.
//
// WHAT THIS REPLACES, AND WHY. The first version asked Kalshi for each held market's last 1,000
// prints and replayed them against the touch AS IT STOOD WHEN THE TOOL RAN, as if that quote had
// rested on both sides of all ~120 markets for the whole 24 hours, with the queue ahead of it
// worked off once and never rejoined. The desk quotes 24 markets at a time, works the rest off on
// one side only, rejoins the back of the queue every time its price moves, and pulls a side at the
// cap, on a gain lock and while cooled. So "live is 39% of model" (2026-09-21) compared the desk
// with a desk that cannot exist, and its window -- "this build" -- was never that: `startedAt` in
// the state is the ledger's first day, so it was always 24 hours across every restart. The number
// could not be read either way, and it was the number MAKER_PARTICIPATION was going to be judged on.
//
// Since 2026-09-19 the maker writes down what it actually saw and did (src/makertape.js): the top
// of every book it looked at with sizes, every print on those markets, and its own resting quote
// and inventory. That is everything the fill logic reads. So three numbers, on the same prints:
//
//   JOURNAL  what the paper book booked (MAKER_FILL lines).
//   TAPE     the desk's RECORDED quotes replayed against the recorded prints with the recorded depth
//            as the queue, through the desk's own maker.fillsFrom. If the ledger is honest this
//            reproduces the journal; where it does not, the difference is the finding.
//   ALWAYS   the same prints against a desk that never stops: both sides at the recorded touch
//            (maker.desiredQuotes on the recorded book, its own inventory, the real queue), in every
//            market for as long as the desk was looking at it. Not a target -- most of what it fills
//            and the desk does not is a rail doing its job -- but every fill it has that the tape
//            replay lacks is put down to what the desk's recorded quote was doing at that print:
//            pulled by a rail, not at the touch, further back in the queue, or not up yet after a
//            restart. The rails are the price of the risk limits; the rest is operational loss, and
//            that share is what a restart-free day should shrink.
//
// And the question under all of it: is a fill worth having? Each one is marked against the recorded
// mid HORIZONS minutes later, per contract, for the fills the desk took and for each bucket of fills
// it did not. Half a spread is what a fill pays; what the price does next is what it costs. The
// run-over share never answered this -- on 2026-09-20 the gate's refused fills were run over as
// often as the desk's own (64%) yet marked half a cent worse thirty minutes on, and the desk's own
// fills marked about -1c per contract at every horizon on both days measured, which is the maker's
// whole P&L question in one number: the spread on these markets does not cover the drift after a fill.
//
// File order is the order the desk saw things in, and the replay keeps it: within a round the tape
// holds the books, then the prints, then the quote that round ended on, so a print is matched
// against the quote from the round BEFORE it, as it was live. The always-on desk requotes off a
// book only once that round's prints are past, or it would be quoting with a book it had not seen.
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const r2 = (x) => Math.round(x * 100) / 100;
const HORIZONS = [5, 30, 120];   // minutes after a fill that it is marked at
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '-');

// why the always-on desk filled a print and the recorded quote did not, in the order they are tested
const REASONS = [
  ['restart', 'not up yet after a restart: the saved quote is withdrawn until the first round ends', 'ops'],
  ['cooled', 'cooled by the run-over gate (MAKER_COOL in the journal): both sides withdrawn for the cooldown', 'rail'],
  ['entire', 'both sides withdrawn for another reason: halted, or a book the desk would not quote', 'rail'],
  ['growing', 'the growing side withdrawn: a rotated-out market worked off one-sided, the cap, or the gain lock; or a reduce-only quote stopped at flat', 'rail'],
  ['side', 'that side withdrawn while flat or reducing', 'rail'],
  ['price', 'quoted, but not at the price the always-on desk had: a round behind the book', 'ops'],
  ['queue', 'quoted at that price, but further back in the queue: it had rejoined the back more recently', 'ops'],
];

// ---------------------------------------------------------------- the replay (pure)
// Feed it tape rows in file order; ask for result() at the end. `maker` is src/maker.js.
// `cools` is ticker -> [[fromMs, untilMs]] from the journal's MAKER_COOL lines, so a quote the run-over
// gate pulled is told apart from one pulled by a halt.
function makeFillCheck(cfg, maker, cools = new Map()) {
  const cooledAt = (k, t) => (cools.get(k) || []).some(([a, b]) => t >= a && t < b);
  const M = new Map();
  // A market first seen after a start marker is down like every other until its first quote line:
  // the desk posts nothing in a market until the end of the round it first looks at it.
  let sinceStart = false;
  const st = (k) => {
    let s = M.get(k);
    if (!s) {
      s = { book: null, seenBook: null, rq: { bid: null, ask: null }, rqueue: { bid: 0, ask: 0 }, rinv: 0, down: sinceStart,
        mq: { bid: null, ask: null }, mqueue: { bid: 0, ask: 0 }, minv: null, seen: new Set(),
        tape: { fills: 0, qty: 0, ro: 0 }, always: { fills: 0, qty: 0 }, prints: 0 };
      M.set(k, s);
    }
    return s;
  };
  const pending = new Map();      // ticker -> the book this round showed, not yet quoted off by the always-on desk
  const dirty = new Set();        // tickers whose always-on inventory moved: the cap may have changed its quote
  const marks = {};               // g lines by reason
  const lost = Object.fromEntries(REASONS.map(([k]) => [k, { fills: 0, qty: 0, ro: 0 }]));
  const both = { fills: 0, tapeQty: 0, alwaysQty: 0 };
  const mids = new Map();         // ticker -> [[t, mid]] in file order, for the marks
  const fills = [];               // every counted fill: { bucket, k, t, side, px, qty } -- marked at the end
  const note = (bucket, k, t, f) => { if (counting) fills.push({ bucket, k, t, side: f.side, px: f.px, qty: f.qty, ro: !!f.runOver }); };
  const tapeOnly = { fills: 0, qty: 0 };
  let lastKind = null, lastBookT = null, prints = 0, rows = 0;
  // Warm-up: the day before is fed through first with counting off. A quote that has not changed since
  // yesterday has no line today until it does, and its place in the queue was earned yesterday.
  let counting = true, warmed = false, firstT = null, lastT = null, exact = 0, inferred = 0;
  const bump = (o, k, n) => { if (counting) o[k] += n; };

  const requeue = maker.queueAfter;   // the desk's own rule, so the replay cannot drift from it
  const requoteAlways = (s) => {
    if (!s.book) return;
    const q = maker.desiredQuotes(s.book, s.minv || 0, cfg);
    const next = { bid: q.bid ?? null, ask: q.ask ?? null, ...(q.reduceOnly ? { reduceOnly: true } : {}) };
    s.mqueue = requeue(s.mq, s.mqueue, next, s.book);
    s.mq = next;
  };
  const flush = () => {
    for (const [k, bk] of pending) { const s = st(k); s.book = bk; requoteAlways(s); dirty.delete(k); }
    pending.clear();
    for (const k of dirty) requoteAlways(st(k));
    dirty.clear();
  };

  function feed(row) {
    if (!counting) warmed = true;
    if (counting) { rows++; if (row.mk !== 'p' && Number.isFinite(row.t)) { if (firstT == null) firstT = row.t; lastT = row.t; } }
    const kind = row.mk;
    if (kind === 'g') {
      flush();
      if (counting) marks[row.why] = (marks[row.why] || 0) + 1;
      // A new process (src/makertape.js writes this once, on its first line). The quotes saved in the
      // ledger are withdrawn for the whole first round and re-posted at its end (src/makerdesk.js),
      // so until a market's next quote line nothing of ours is resting there.
      if (row.why === 'start') { sinceStart = true; for (const s of M.values()) { s.rq = { bid: null, ask: null }; s.rqueue = { bid: 0, ask: 0 }; s.down = true; } }
    } else if (kind === 'b') {
      // a new round: the books come first, and all of one round's books carry the same read time
      if (lastKind === 'p' || lastKind === 'q' || (lastBookT != null && row.t !== lastBookT)) flush();
      lastBookT = row.t;
      const bk = { yesBids: [{ price: row.b, size: row.bs || 0 }], yesAsks: [{ price: row.a, size: row.as || 0 }] };
      st(row.k).seenBook = bk;             // the recorded quote that ends THIS round rejoins this depth
      if (Number.isFinite(row.b) && Number.isFinite(row.a)) (mids.get(row.k) || mids.set(row.k, []).get(row.k)).push([row.t, (row.b + row.a) / 2]);
      pending.set(row.k, bk);              // the always-on desk quotes off it once this round's prints are past
    } else if (kind === 'p') {
      const s = st(row.k);
      if (s.seen.has(row.id)) { lastKind = kind; return; }   // a restart can write the same print twice; the ledger's own dedupe spans it
      s.seen.add(row.id); if (counting) { s.prints++; prints++; }
      const t = { trade_id: row.id, yes_price_dollars: String(row.p), count_fp: String(row.n), taker_book_side: row.s === 'b' ? 'bid' : 'ask', is_block_trade: !!row.blk };
      const a = maker.fillsFrom([t], s.rq, s.rinv, cfg, new Set(), s.rqueue);
      const m = maker.fillsFrom([t], s.mq, s.minv || 0, cfg, new Set(), s.mqueue);
      s.rqueue = a.queue; s.mqueue = m.queue;
      const fa = a.fills[0], fm = m.fills[0];
      if (fa) { s.rinv += fa.side === 'buy' ? fa.qty : -fa.qty; bump(s.tape, 'fills', 1); bump(s.tape, 'qty', fa.qty); if (fa.runOver) bump(s.tape, 'ro', fa.qty); note('tape', row.k, row.t, fa); }
      if (fm) { s.minv = (s.minv || 0) + (fm.side === 'buy' ? fm.qty : -fm.qty); bump(s.always, 'fills', 1); bump(s.always, 'qty', fm.qty); dirty.add(row.k); }
      if (!counting) { /* state only */ }
      else if (fa && fm) { both.fills++; both.tapeQty += fa.qty; both.alwaysQty += fm.qty; }
      else if (fa) { tapeOnly.fills++; tapeOnly.qty += fa.qty; }
      else if (fm) {
        const have = fm.side === 'buy' ? s.rq.bid : s.rq.ask, other = fm.side === 'buy' ? s.rq.ask : s.rq.bid;
        const growing = (fm.side === 'buy' && s.rinv > 0) || (fm.side === 'sell' && s.rinv < 0);
        const crosses = have != null && (fm.side === 'buy' ? have >= row.p : have <= row.p);
        // a reduce-only quote that the print did reach, but with nothing left to reduce: stopped at flat
        const stopped = crosses && s.rq.reduceOnly && !(fm.side === 'buy' ? s.rinv < 0 : s.rinv > 0);
        const why = s.down ? 'restart' : have == null && other == null ? (cooledAt(row.k, row.t) ? 'cooled' : 'entire') : have == null ? (growing ? 'growing' : 'side') : stopped ? 'growing' : crosses ? 'queue' : 'price';
        lost[why].fills++; lost[why].qty += fm.qty; if (fm.runOver) lost[why].ro += fm.qty;
        note(why, row.k, row.t, fm);
      }
    } else if (kind === 'q') {
      const s = st(row.k);
      // `ro`: the quote was reduce-only, and maker.fillsFrom clips each fill on it at flat (since
      // 2026-09-24). A tape from before it has no `ro` and replays unclipped, as the desk then filled.
      const next = { bid: row.b ?? null, ask: row.a ?? null, ...(row.ro ? { reduceOnly: true } : {}) };
      // The desk's own number where the tape has it (qb/qa, since the evening of 2026-09-21). An older tape has only
      // the depth at the touch, so a quote first seen is assumed to have just joined the back of it.
      if (Number.isFinite(row.qb) && Number.isFinite(row.qa)) { s.rqueue = { bid: row.qb, ask: row.qa }; if (counting) exact++; }
      else { s.rqueue = requeue(s.rq, s.rqueue, next, s.seenBook); if (counting) inferred++; }
      s.rq = next; s.down = false;
      s.rinv = row.i || 0;                 // the ledger's own inventory: the replay never drifts from it for long
      if (s.minv == null) s.minv = s.rinv; // the always-on desk starts from the position the real one had
    }
    lastKind = kind;
  }

  // the recorded mid at `t`: the last book line at or before it, and only if that line is recent. The
  // book is written at least once a minute while the desk looks at a market, so a line older than
  // that means the tape was not looking then -- the end of the day, a halt, a market dropped and
  // later re-quoted -- and a mark against it would be against a price hours old.
  const MID_STALE_MS = 90000;
  const midAt = (k, t) => {
    const a = mids.get(k) || [];
    let lo = 0, hi = a.length - 1, best = null;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (a[m][0] <= t) { best = a[m]; lo = m + 1; } else hi = m - 1; }
    return best && t - best[0] <= MID_STALE_MS ? best[1] : null;
  };
  // per bucket and horizon: contracts that could be marked, and what they made per contract
  function markFills() {
    const out = {};
    for (const f of fills) {
      const b = out[f.bucket] || (out[f.bucket] = Object.fromEntries(HORIZONS.map((h) => [h, { qty: 0, pnl: 0 }])));
      for (const h of HORIZONS) {
        const m = midAt(f.k, f.t + h * 60000);
        if (m == null) continue;
        b[h].qty += f.qty; b[h].pnl += f.qty * (f.side === 'buy' ? m - f.px : f.px - m);
      }
    }
    for (const b of Object.values(out)) for (const h of HORIZONS) b[h].perContract = b[h].qty ? b[h].pnl / b[h].qty : null;
    return out;
  }

  function result() {
    flush();
    const sum = (f) => [...M.values()].reduce((a, s) => a + f(s), 0);
    return {
      rows, prints, markets: [...M.values()].filter((s) => s.prints).length, marks, firstT, lastT,
      // is the queue in this replay the desk's own, or this tool's guess?
      exactQueue: exact > 0 && exact >= inferred * 20, warmed,
      tape: { fills: sum((s) => s.tape.fills), qty: sum((s) => s.tape.qty), ro: sum((s) => s.tape.ro) },
      always: { fills: sum((s) => s.always.fills), qty: sum((s) => s.always.qty) },
      both, tapeOnly, lost, marked: markFills(), fills, midAt,   // the raw fills and the mid lookup, for anyone slicing the marks another way
      byMarket: new Map([...M].map(([k, s]) => [k, { prints: s.prints, tape: s.tape, always: s.always }])),
    };
  }
  return { feed, result, counting: (on) => { counting = !!on; } };
}

// MAKER_FILL lines, per market: what the paper book booked. And MAKER_COOL, as windows per market.
// `within(from, to)` gives the same totals over only the fills in that window (the stretch the tape
// covers), without reading the journal again.
function journalFills(lines, { from = -Infinity, to = Infinity } = {}) {
  const cools = new Map(), all = [];
  for (const line of lines) {
    if (!line || line.indexOf('"MAKER_') < 0) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    if (j.kind === 'MAKER_COOL') {
      const a = Date.parse(j.t), b = Date.parse(j.until);
      if (Number.isFinite(a) && Number.isFinite(b)) { if (!cools.has(j.ticker)) cools.set(j.ticker, []); cools.get(j.ticker).push([a, b]); }
      continue;
    }
    if (j.kind !== 'MAKER_FILL') continue;
    all.push({ at: Date.parse(j.t), ticker: j.ticker, qty: j.qty || 0, ro: !!j.runOver });
  }
  const within = (a, b) => {
    const by = new Map();
    let fills = 0, qty = 0, ro = 0;
    for (const f of all) {
      if (!(f.at >= a && f.at <= b)) continue;
      const m = by.get(f.ticker) || { fills: 0, qty: 0 };
      m.fills++; m.qty += f.qty; by.set(f.ticker, m);
      fills++; qty += f.qty; if (f.ro) ro += f.qty;
    }
    return { fills, qty, ro, by, cools, within };
  };
  return within(from, to);
}

// How far the tape replay may sit from the journal, market by market, before it is a problem and not
// rounding. The two can differ honestly: a print the poll returned in one ET day and the desk booked
// in the next, a tape line lost to a failed write, a round where a book failed to load. Measured:
// 2026-09-20, warmed up on the 19th, 8,817 contracts replayed against 8,826 journalled and 0.1% apart
// market by market. The 19th itself, the tape's first day with nothing to warm up on, is 11% apart by
// market while its totals sit 4% apart -- misses cancelling -- so a cold replay is reported, not judged.
const AGREE = 0.05;
function verdict(res, jr) {
  // by market, so a day where one market over-fills and another under-fills does not read as agreement
  let off = 0;
  for (const k of new Set([...res.byMarket.keys(), ...jr.by.keys()])) off += Math.abs(((res.byMarket.get(k) || {}).tape || { qty: 0 }).qty - (jr.by.get(k) || { qty: 0 }).qty);
  const apart = jr.qty ? off / jr.qty : (res.tape.qty ? 1 : 0);
  const ops = ['restart', 'price', 'queue'].reduce((a, k) => a + res.lost[k].qty, 0);
  const rails = ['cooled', 'entire', 'growing', 'side'].reduce((a, k) => a + res.lost[k].qty, 0);
  // judged only when the replay knows where each quote stood: the desk's own queue numbers on the tape.
  // A warm-up day helps a guessed queue (the 19th cold was 11% by market, the 20th warmed 0.1%) but
  // it is still a guess, and a guess must not fail the daily check.
  return { apart, agrees: apart <= AGREE, exact: !!res.exactQueue, ops, rails, coverage: res.always.qty ? res.tape.qty / res.always.qty : null, opsShare: res.always.qty ? ops / res.always.qty : null };
}

module.exports = { makeFillCheck, journalFills, verdict, REASONS, AGREE, HORIZONS };

// ---------------------------------------------------------------- the script
if (require.main === module) {
  const args = process.argv.slice(2);
  const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const flag = (name) => all(name)[0];
  const root = path.join(__dirname, '..');
  // The tape comes from the box, so the replay runs on the box's settings: fly.toml's MAKER_* where
  // this shell has not set its own. (On the box they are already in the environment.)
  try {
    for (const m of fs.readFileSync(path.join(root, 'fly.toml'), 'utf8').matchAll(/^\s*(MAKER_[A-Z0-9_]+)\s*=\s*"([^"]*)"/gm)) if (process.env[m[1]] === undefined) process.env[m[1]] = m[2];
  } catch { /* no fly.toml: the defaults */ }
  const cfg = { ...require('../src/config') };
  for (let i = 0; i < args.length; i++) {
    const k = args[i].replace(/^--/, '');
    if (args[i].startsWith('--maker') && k in cfg && Number.isFinite(parseFloat(args[i + 1]))) cfg[k] = parseFloat(args[i + 1]);
  }
  const maker = require('../src/maker');
  const dir = path.resolve(flag('dir') || path.join(root, 'data', 'fly', 'archive'));
  if (!fs.existsSync(dir)) { console.error(`no such folder: ${dir}`); process.exit(1); }
  const have = fs.readdirSync(dir).map((f) => (/^ticks-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(f) || [])[1]).filter(Boolean).sort();
  const days = all('day').length ? all('day') : have.slice(-(parseInt(flag('days'), 10) || 1));
  if (!days.length) { console.error(`no ticks-YYYY-MM-DD.jsonl in ${dir} (the pull copies closed days: node tools/fly-pull.js)`); process.exit(1); }

  (async () => {
    // the journals first: the replay wants to know when a market was cooled. A cooldown that began
    // the day before is read too, or the first hours of the window would call it a halt.
    const dayBefore = new Date(Date.parse(`${days[0]}T12:00:00Z`) - 86400000).toISOString().slice(0, 10);
    const lines = (d) => { const f = path.join(dir, `journal-${d}.jsonl`); return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n') : []; };
    const jall = journalFills([...lines(dayBefore), ...days.flatMap(lines)]);   // one pass: cooldowns and every fill with its time
    const check = makeFillCheck(cfg, maker, jall.cools);
    const read = async (tf) => {
      const rl = readline.createInterface({ input: fs.createReadStream(tf), crlfDelay: Infinity });
      for await (const line of rl) {
        if (!line.startsWith('{"mk"')) continue;         // the pair recorder shares the file
        let row; try { row = JSON.parse(line); } catch { continue; }
        check.feed(row);
      }
    };
    const warm = path.join(dir, `ticks-${dayBefore}.jsonl`);
    if (fs.existsSync(warm)) { check.counting(false); await read(warm); check.counting(true); }
    for (const d of days) {
      const tf = path.join(dir, `ticks-${d}.jsonl`);
      if (!fs.existsSync(tf)) { console.error(`no tape for ${d} in ${dir}`); process.exit(1); }
      await read(tf);
    }
    const res = check.result();
    // the journal only over the stretch the tape covers: the recorder was switched on partway through 2026-09-19
    const jr = jall.within(res.firstT == null ? -Infinity : res.firstT - 5000, res.lastT == null ? Infinity : res.lastT + 5000);
    const v = verdict(res, jr);
    if (!res.rows) { console.log(`${days.join(', ')}: the tape holds no maker lines (RECORD_MAKER=0, or the maker was off)`); return; }

    const line = (name, x, extra = '') => console.log(`  ${name.padEnd(9)}${String(x.fills).padStart(6)} fills ${String(Math.round(x.qty)).padStart(7)} contracts${extra}`);
    console.log(`${days[0]}${days.length > 1 ? ` → ${days[days.length - 1]}` : ''} (ET) · ${res.markets} markets looked at · ${res.prints} prints on them · cap ${cfg.makerCap}, soft cap ${cfg.makerSoftCap}, participation ${cfg.makerParticipation}`);
    const mk = Object.entries(res.marks).map(([k, n]) => `${n} ${k}`).join(' · ');
    console.log(`holes in the tape: ${mk || 'none'}${res.marks.start === undefined ? ' · (no start markers: a tape from before restarts were written down, so a restart reads as nothing here)' : ''}\n`);
    line('JOURNAL', jr, ` · ${pct(jr.ro, jr.qty)} run over`);
    line('TAPE', res.tape, ` · ${pct(res.tape.ro, res.tape.qty)} run over   the recorded quotes, replayed`);
    line('ALWAYS', res.always, '                 both sides at the touch, never down');

    console.log(`\n1. Does the ledger fill the way its own tape says?`);
    const problem = v.exact && !v.agrees;
    console.log(!v.exact
      ? `   not judged: this tape has no recorded queue positions (qb/qa, from the evening of 2026-09-21), so where each quote stood\n   is this tool's guess${res.warmed ? ', warmed up on the day before' : ', cold: no tape for the day before to warm up on'}. Market by market the replay is ${(v.apart * 100).toFixed(1)}% of the journal's contracts away.`
      : v.agrees
        ? `   yes: market by market the replay is within ${(v.apart * 100).toFixed(1)}% of the journal's contracts (the bar is ${AGREE * 100}%)`
        : `   PROBLEM: market by market the replay is ${(v.apart * 100).toFixed(0)}% of the journal's contracts away (the bar is ${AGREE * 100}%) · furthest apart:`);
    if (problem || args.includes('--markets')) {
      const rowsBy = [...new Set([...res.byMarket.keys(), ...jr.by.keys()])].map((k) => {
        const t = (res.byMarket.get(k) || { tape: { fills: 0, qty: 0 }, always: { fills: 0, qty: 0 }, prints: 0 }), j = jr.by.get(k) || { fills: 0, qty: 0 };
        return { k, j, t: t.tape, a: t.always, prints: t.prints, d: Math.abs(t.tape.qty - j.qty) };
      }).filter((r) => r.j.qty || r.t.qty || r.a.qty).sort((x, y) => y.d - x.d);
      console.log('   market                                      prints   journal      tape    always   (contracts)');
      for (const r of rowsBy.slice(0, args.includes('--markets') ? 1000 : 8)) console.log(`   ${r.k.slice(0, 42).padEnd(42)}${String(r.prints).padStart(8)}${String(r.j.qty).padStart(10)}${String(r.t.qty).padStart(10)}${String(r.a.qty).padStart(10)}`);
    }

    console.log(`\n2. What did a desk that never stops fill, and the recorded quotes did not? (${pct(res.tape.qty, res.always.qty)} coverage by contracts)`);
    console.log(`   filled by both                     ${String(res.both.fills).padStart(6)} fills ${String(Math.round(res.both.alwaysQty)).padStart(7)} contracts (${Math.round(res.both.tapeQty)} on the tape: a different place in the queue)`);
    for (const [k, words, sort] of REASONS) if (res.lost[k].fills) console.log(`   ${sort === 'rail' ? 'rail' : 'OPS '} ${String(res.lost[k].fills).padStart(6)} fills ${String(Math.round(res.lost[k].qty)).padStart(7)} contracts ${pct(res.lost[k].ro, res.lost[k].qty).padStart(4)} run over  ${words}`);
    if (res.tapeOnly.fills) console.log(`   (and ${res.tapeOnly.fills} fills, ${Math.round(res.tapeOnly.qty)} contracts, only the recorded quotes had: the always-on desk was at its cap or a price away)`);
    console.log(`\n   rails ${pct(v.rails, res.always.qty)} of the always-on contracts · operations ${pct(v.ops, res.always.qty)}`);
    console.log('   The rails are what the risk limits cost and are meant to. The operations share is what restarts,');
    console.log('   a round\'s delay and queue resets cost: that is the number a quiet day should bring down.');

    console.log(`\n3. Was a fill worth having? Marked against the recorded mid ${HORIZONS.join(', ')} minutes later, per contract`);
    console.log(`   (a fill pays half the spread; what the price does next is what it costs)`);
    const cents = (x) => (x == null ? '     -' : `${x >= 0 ? '+' : '-'}${Math.abs(x * 100).toFixed(2)}c`.padStart(6));
    const rowOf = (name, b) => b && console.log(`   ${name.padEnd(34)}${HORIZONS.map((h) => cents(b[h].perContract)).join('  ')}   ${String(Math.round(b[HORIZONS[0]].qty)).padStart(6)} contracts`);
    console.log(`   ${''.padEnd(34)}${HORIZONS.map((h) => `${h}m`.padStart(6)).join('  ')}`);
    rowOf('the desk\'s own fills', res.marked.tape);
    for (const [k, , sort] of REASONS) rowOf(`refused: ${k}${sort === 'rail' ? ' (rail)' : ''}`, res.marked[k]);
    const own = res.marked.tape && res.marked.tape[30].perContract;
    if (own != null) console.log(own < 0
      ? `   The desk's own fills lose ${Math.abs(own * 100).toFixed(2)}c a contract within half an hour: the spread is not covering the drift after a fill.`
      : `   The desk's own fills are still ahead ${(own * 100).toFixed(2)}c a contract half an hour on.`);

    // one reading per run, so a week of them accumulates beside the tape they came from
    try {
      fs.appendFileSync(path.join(dir, 'fillcheck.jsonl'), JSON.stringify({ t: new Date().toISOString(), days, journal: { fills: jr.fills, qty: jr.qty }, tape: res.tape, always: res.always, apart: r2(v.apart), exactQueue: v.exact, coverage: v.coverage == null ? null : r2(v.coverage), ops: v.ops, rails: v.rails, marks: res.marks,
        marked: Object.fromEntries(Object.entries(res.marked).map(([b, hs]) => [b, Object.fromEntries(HORIZONS.map((h) => [h, hs[h].perContract == null ? null : Math.round(hs[h].perContract * 10000) / 10000]))])) }) + '\n');
    } catch { /* a read-only folder is not a reason to fail the check */ }
    process.exit(problem ? 1 : 0);
  })().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

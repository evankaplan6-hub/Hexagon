'use strict';
// Replay the MAKER desk against Kalshi's own trade history.
//
//   node tools/maker-replay.js --fetch data/fly/kstrades.jsonl data/fly/journal-*.jsonl
//   node tools/maker-replay.js data/fly/kstrades.jsonl data/fly/journal-*.jsonl
//   node tools/maker-replay.js data/fly/kstrades.jsonl data/fly/journal-*.jsonl --makerSoftCap 1 --markets
//
// tools/replay.js scores the TAKER desks against the tick tape, and the tick tape carries no maker
// rows at all: it records cross-venue pairs, and the maker fills off Kalshi's exchange-wide trade
// feed, which nothing records. So a change to the maker could not be scored before it shipped --
// the only evidence was the live journal, which is one run of one configuration.
//
// This closes that. `--fetch` pulls the full trade history for every market the desk has held,
// over the window the journal says it was running (Kalshi keeps it; `cursor` pages it). The replay
// then runs the SAME pure functions the live desk runs -- desiredQuotes, fillsFrom, applyFill --
// on the same two-second cadence, with the wall clock replaced by the tape.
//
// WHAT IT CANNOT KNOW, in order of how much it matters:
//   - The book. The tape has prints, not quotes. The touch is reconstructed from them: a taker on
//     the bid side lifted the ask at that price, a taker on the ask side hit the bid, so the last
//     print on each side is where the touch was. Between prints the book can move without
//     trading, and the live desk sees that every two seconds while this does not. Reconstructed
//     quotes are therefore STALER than live ones, which makes run-over more likely here, not less.
//   - The queue. Nothing records how much size was resting ahead of us, so by default nothing is.
//     That is the first backtest's error over again, and it shows: against the journal's 2.25
//     days, at-touch fills over-count six-fold (9,205 contracts against 1,464) while run-over
//     fills land within 2% (2,083 against 2,126), because a sweep through our level does not
//     care who was ahead of us. `--queue N` puts N contracts ahead of every quote that moves to a
//     new price (staying put keeps what is left, as makerdesk does). No single N reproduces both
//     numbers: at 5,000 the at-touch count is about right (1,987) and the run-over count has
//     collapsed to 491, because a reconstructed touch moves on every print and rejoins the back
//     of a deep queue each time. So the default is 0, where the number this desk is losing money
//     on -- run-over -- is reproduced, and a deep-queue run is the sensitivity check, not the
//     headline.
//   - The universe. Which markets the desk was quoting at any moment is not journalled, so a
//     market is treated as quoted from its first live fill to the end of the window. Markets that
//     never filled are not replayed at all.
// The two book biases pull in opposite directions and neither is small, so treat the absolute
// numbers as a different instrument from the journal's. What this is for is the DIFFERENCE between
// two configurations on the same tape -- run it before and after, and read the delta.
const fs = require('fs');
const maker = require('../src/maker');
const ks = require('../src/venues/kalshi');
const base = require('../src/config');

const args = process.argv.slice(2);
const BARE = ['--fetch', '--markets', '--quiet'];               // flags that take no value
const files = args.filter((a, i) => !a.startsWith('--') && !(i > 0 && args[i - 1].startsWith('--') && !BARE.includes(args[i - 1])));
const flag = (name) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
const has = (name) => args.includes(`--${name}`);
// contracts ahead of a quote that has just moved to a new price -- see the note on the queue above
const QUEUE = flag('queue') !== undefined ? parseFloat(flag('queue')) : 0;
if (!files.length) { console.error('usage: node tools/maker-replay.js [--fetch] <kstrades.jsonl> <journal-*.jsonl...> [--<makerKnob> value] [--markets]'); process.exit(1); }

const r2 = (x) => Math.round(x * 100) / 100;
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;
const pct = (a, b) => (b ? `${(100 * a / b).toFixed(0)}%` : '-');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- inputs
const tradesFile = files.find((f) => !/journal/.test(f));
const journalFiles = files.filter((f) => /journal/.test(f));
if (!tradesFile || !journalFiles.length) { console.error('need one trades file and at least one journal file'); process.exit(1); }

const journal = [];
for (const f of journalFiles) for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
  if (!l.trim()) continue;
  try { const r = JSON.parse(l); if (r.kind === 'MAKER_FILL') journal.push({ ...r, at: Date.parse(r.t) }); } catch { /* skip */ }
}
journal.sort((a, b) => a.at - b.at);
if (!journal.length) { console.error('no MAKER_FILL rows in the journal'); process.exit(1); }
// when each market entered the book, as far as the journal can say
const firstFill = new Map();
for (const f of journal) if (!firstFill.has(f.ticker)) firstFill.set(f.ticker, f.at);
const t0 = journal[0].at, t1 = journal[journal.length - 1].at;

// ---------------------------------------------------------------- fetch
async function fetchTrades() {
  const out = fs.createWriteStream(tradesFile);
  let total = 0;
  for (const ticker of firstFill.keys()) {
    let cursor = '', n = 0, done = false, pages = 0;
    while (!done && pages < 200) {
      const url = `${ks.BASE}/markets/trades?ticker=${ticker}&limit=1000&min_ts=${Math.floor(t0 / 1000)}${cursor ? `&cursor=${cursor}` : ''}`;
      let d;
      try {
        const r = await fetch(url, { headers: { accept: 'application/json' } });
        if (r.status === 429) { await sleep(2000); continue; }
        d = await r.json();
      } catch { await sleep(1000); continue; }
      pages++;
      for (const x of (d.trades || [])) {
        if (Date.parse(x.created_time) < t0) { done = true; continue; }
        out.write(JSON.stringify(x) + '\n'); n++;
      }
      cursor = d.cursor || '';
      if (!cursor || !(d.trades || []).length) done = true;
      await sleep(150);
    }
    total += n;
    console.log(`  ${ticker.padEnd(40)} ${String(n).padStart(6)} trades`);
  }
  await new Promise((r) => out.end(r));
  console.log(`${total} trades for ${firstFill.size} markets → ${tradesFile}`);
}

// ---------------------------------------------------------------- replay
function loadTrades() {
  const byTicker = new Map();
  for (const l of fs.readFileSync(tradesFile, 'utf8').split('\n')) {
    if (!l.trim()) continue;
    let t; try { t = JSON.parse(l); } catch { continue; }
    t._t = Date.parse(t.created_time);
    if (!Number.isFinite(t._t) || !firstFill.has(t.ticker)) continue;
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker).push(t);
  }
  for (const v of byTicker.values()) v.sort((a, b) => a._t - b._t);
  return byTicker;
}

// The touch, from prints. A print with the taker on the bid side lifted an ask AT that price;
// one with the taker on the ask side hit a bid at it. When the two last prints cross -- the book
// moved and only one side has printed since -- the older side is placed one tick beyond the
// newer, which is the tightest book Kalshi allows and the one the desk most often quotes into.
function touchFrom(book, t) {
  const p = parseFloat(t.yes_price_dollars);
  if (!Number.isFinite(p)) return book;
  const b = { ...book };
  if (t.taker_book_side === 'bid') { b.ask = p; if (b.bid != null && b.bid >= p) b.bid = r2(p - 0.01); }
  else if (t.taker_book_side === 'ask') { b.bid = p; if (b.ask != null && b.ask <= p) b.ask = r2(p + 0.01); }
  return b;
}
const asBook = (b) => ({
  yesBids: b.bid == null ? [] : [{ price: b.bid, size: QUEUE }],
  yesAsks: b.ask == null ? [] : [{ price: b.ask, size: QUEUE }],
});

function run(cfg, byTicker) {
  const every = cfg.makerEverySec * 1000;
  const totals = { fills: 0, qty: 0, roFills: 0, roQty: 0, roCost: 0, realized: 0, cooled: 0 };
  const rows = [];
  for (const [ticker, trades] of byTicker) {
    const since = firstFill.get(ticker);
    const m = { inv: 0, cost: 0, realized: 0, quotes: { bid: null, ask: null }, queue: { bid: 0, ask: 0 }, tox: [], cooledUntil: 0 };
    const seen = new Set();
    let book = { bid: null, ask: null };
    let i = 0;
    // warm the book on everything before the market entered the desk's universe
    while (i < trades.length && trades[i]._t < since) book = touchFrom(book, trades[i++]);
    const s = { bought: 0, boughtCost: 0, sold: 0, soldProceeds: 0, fills: 0, qty: 0, roFills: 0, roQty: 0, roCost: 0, cooled: 0 };
    let now = since;
    while (i < trades.length || now <= t1) {
      const end = now + every;
      // 1) fill what was resting, against the prints that arrived this cycle
      const batch = [];
      while (i < trades.length && trades[i]._t < end) batch.push(trades[i++]);
      const { fills, queue } = maker.fillsFrom(batch, m.quotes, m.inv, cfg, seen, m.queue);
      m.queue = queue;
      for (const f of fills) {
        const res = maker.applyFill(m, f);
        m.inv = res.inv; m.cost = res.cost; m.realized = res.realized;
        s.fills++; s.qty += f.qty;
        if (f.side === 'buy') { s.bought += f.qty; s.boughtCost += f.qty * f.px; } else { s.sold += f.qty; s.soldProceeds += f.qty * f.px; }
        if (f.runOver) { s.roFills++; s.roQty += f.qty; s.roCost += Math.abs(f.px - f.tradePx) * f.qty; }
        m.tox = maker.toxWindow(m.tox, f);
      }
      for (const t of batch) book = touchFrom(book, t);
      // 2) requote off the book as it now stands, exactly as makerdesk does
      const q = maker.desiredQuotes(asBook(book), m.inv, cfg);
      let next = { bid: q.bid, ask: q.ask };
      const g = maker.toxicGate(m, cfg, end);
      m.tox = g.tox; m.cooledUntil = g.cooledUntil;
      if (g.cooled) { next = { bid: null, ask: null }; if (g.tripped) s.cooled++; }
      // queue position, as makerdesk keeps it: a new price joins the back, the same price keeps
      // whatever has already been worked down
      const bk = asBook(book);
      const prev = m.queue;
      m.queue = {
        bid: next.bid == null ? 0 : (next.bid === m.quotes.bid ? prev.bid : (bk.yesBids[0] ? bk.yesBids[0].size : 0)),
        ask: next.ask == null ? 0 : (next.ask === m.quotes.ask ? prev.ask : (bk.yesAsks[0] ? bk.yesAsks[0].size : 0)),
      };
      m.quotes = next;
      m.mid = q.mid ?? m.mid;
      now = end;
      if (i >= trades.length && now > t1) break;
    }
    const mid = m.mid ?? 0.5;
    const rt = Math.min(s.bought, s.sold);
    const captured = rt > 0 ? rt * (s.soldProceeds / s.sold - s.boughtCost / s.bought) : 0;
    rows.push({ ticker, ...s, rt, captured, inv: m.inv, cost: m.cost, realized: m.realized, mark: m.inv * mid, mid });
    totals.fills += s.fills; totals.qty += s.qty; totals.roFills += s.roFills; totals.roQty += s.roQty; totals.roCost += s.roCost;
    totals.realized += m.realized; totals.cooled += s.cooled;
  }
  totals.rt = rows.reduce((a, r) => a + r.rt, 0);
  totals.captured = rows.reduce((a, r) => a + r.captured, 0);
  totals.oneSided = rows.reduce((a, r) => a + Math.abs(r.inv), 0);
  totals.unrealized = rows.reduce((a, r) => a + (r.mark - r.cost), 0);
  return { totals, rows };
}

function report(label, { totals: T, rows }, showMarkets) {
  console.log(`\n${label}`);
  console.log(`  fills / contracts                ${T.fills} / ${T.qty}`);
  console.log(`  run-over fills / contracts       ${T.roFills} (${pct(T.roFills, T.fills)}) / ${T.roQty} (${pct(T.roQty, T.qty)})`);
  console.log(`  at-touch fills / contracts       ${T.fills - T.roFills} / ${T.qty - T.roQty}`);
  console.log(`  run-over cost vs tape            ${money(-T.roCost)}`);
  console.log(`  spread captured on round trips   ${money(T.captured)} on ${T.rt} contracts`);
  console.log(`  net one-sided inventory          ${T.oneSided}`);
  console.log(`  realized                         ${money(T.realized)}`);
  console.log(`  inventory marked at mid          ${money(T.unrealized)}   (mark less cost, a MARK not money)`);
  console.log(`  realized + mark                  ${money(T.realized + T.unrealized)}`);
  if (T.cooled) console.log(`  toxicity withdrawals             ${T.cooled}`);
  if (showMarkets) {
    console.log(`\n  ${'market'.padEnd(34)}${'fills'.padStart(6)}${'qty'.padStart(6)}${'run-over'.padStart(10)}${'inv'.padStart(6)}${'realized'.padStart(10)}${'mark-cost'.padStart(11)}${'cooled'.padStart(8)}`);
    for (const r of [...rows].sort((a, b) => (a.realized + a.mark - a.cost) - (b.realized + b.mark - b.cost))) {
      if (!r.fills) continue;
      console.log(`  ${r.ticker.padEnd(34)}${String(r.fills).padStart(6)}${String(r.qty).padStart(6)}${pct(r.roQty, r.qty).padStart(10)}${String(r.inv).padStart(6)}${money(r.realized).padStart(10)}${money(r.mark - r.cost).padStart(11)}${String(r.cooled || '').padStart(8)}`);
    }
  }
}

// ---------------------------------------------------------------- go
(async () => {
  if (has('fetch')) { await fetchTrades(); return; }
  const cfg = { ...base };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--') || BARE.includes(a)) continue;
    const k = a.slice(2);
    if (k === 'queue') { i++; continue; }
    if (!(k in cfg)) { console.error(`unknown knob --${k}`); process.exit(1); }
    const v = parseFloat(args[++i]);
    if (!Number.isFinite(v)) { console.error(`--${k} needs a number`); process.exit(1); }
    cfg[k] = v;
  }
  const byTicker = loadTrades();
  const n = [...byTicker.values()].reduce((a, v) => a + v.length, 0);
  console.log(`${n} prints across ${byTicker.size} markets · ${new Date(t0).toISOString().slice(0, 16)} → ${new Date(t1).toISOString().slice(0, 16)} · requote every ${cfg.makerEverySec}s, participation ${cfg.makerParticipation}, cap ${cfg.makerCap}, queue ${QUEUE} ahead of a new quote`);
  console.log(`\x1b[2mquotes are reconstructed from prints and the queue is modelled: read the DIFFERENCE between runs, not the level\x1b[0m`);
  const knobs = args.filter((a) => a.startsWith('--') && !BARE.includes(a)).map((a) => `${a.slice(2)}=${args[args.indexOf(a) + 1]}`);
  report(knobs.length ? knobs.join(' ') : 'as configured', run(cfg, byTicker), has('markets'));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

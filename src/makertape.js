'use strict';
// The maker's market data, kept. Every two seconds the maker fetches the top of the book (price AND
// size) for every market it quotes, and reads every print on those markets -- and throws both away.
// tools/maker-replay.js therefore has to RECONSTRUCT the touch from prints and guess the queue, and
// that guess is the largest unknown in the desk: the replay and the live paper book disagree by
// about $130 in five days on nothing but queue position (README, "Replaying the maker"). This is
// the record that closes it. Nothing new is fetched; the data was already in hand.
//
// Lines go into the SAME DATA_DIR/ticks-YYYY-MM-DD.jsonl the pair recorder writes, so the disk
// brake, the daily pull and the trim all cover it with no change. They are told apart by `mk`
// (pair lines have `pair` and no `mk`), and the two tools that read those files skip lines
// without a `pair`.
//
//   {"mk":"b","t":ms,"k":ticker,"b":0.44,"bs":120,"a":0.45,"as":300}       top of book, on change
//   {"mk":"p","t":ms,"k":ticker,"id":trade_id,"p":0.45,"n":12,"s":"b"|"a"}  a print (taker on the bid / ask book side)
//   {"mk":"q","t":ms,"k":ticker,"b":0.44,"a":0.45,"i":-12,"qb":310,"qa":0}   OUR resting quote and inventory, on change,
//                                                                           and how much is still ahead of each side
//   {"mk":"g","t":ms,"why":"start"|"halt"|"data-failure"|"tape-gap"|"write-failed"|"resume"}   a hole in what was observed
//
// `g` says the tape is NOT a record of quiet here. While the desk is halted it withdraws every quote
// and looks at nothing, and a replay that read only b/p/q would see the last quote rest straight
// through it and credit fills the paper book could not have had; "halt" is written once on entry, a
// `q` line with null prices for every withdrawn market, and "resume" on the first round after, which
// also rewrites every book. "tape-gap" is a round where the exchange traded more than the poll could
// page back over. "write-failed" is the first line after a failed append, so lost lines read as a hole.
//
// "start" is the first line a new process writes. Without it a restart was invisible here: the last
// quote before it read as resting straight through the outage and through the first round after,
// when the desk has withdrawn everything it had saved (src/makerdesk.js). `qb`/`qa` are the queue
// model's contracts still ahead of our bid and ask when the line was written. The tape had the depth
// at the touch but not our PLACE in it, so a replay had to assume every quote it first saw had just
// joined the back -- and a quote that had rested for days (CONTROLH-2026-R bid 10c, 103 contracts
// filled on 2026-09-19) replayed to nothing behind a queue the desk had long since worked through.
// tools/fillcheck.js reads both.
//
// Book lines are written when the price or size changes, and otherwise once a minute so a flat market
// and a gap in the tape stay apart (`hb:1`). `t` on a print is the exchange's own timestamp; on a
// book or quote it is when this desk read it. Roughly 20 MB a day for 24 markets.
const fs = require('fs');
const path = require('path');
const { ET_DAY } = require('./recorder');

const HEARTBEAT_MS = 60000;
const r4 = (x) => Math.round(x * 10000) / 10000;

function makeMakerTape(cfg, { io = fs, clock = Date.now } = {}) {
  if (!cfg.record || cfg.makerRecord === false) return () => {};
  let warnedAt = 0;
  const lastBook = new Map();    // ticker -> { key, at }
  const lastQuote = new Map();   // ticker -> key
  const seen = new Set();        // print ids already written; a poll can return the same print twice
  let inGap = null;              // why the desk is not looking, or null
  let lost = false;              // the last append failed: say so on the next one that works
  let started = false;           // has this process put its "start" line on disk yet
  // `books`/`trades`/`markets` as fetched this round; `at` is when the books arrived (not when this ran);
  // `gap` says the desk is not looking this round and why; `missed` says the poll skipped prints.
  return (E, { books, trades, markets, at, gap, missed } = {}) => {
    const now = clock();
    const lines = [];
    // Nothing below changes what is remembered until the append has succeeded. A failed write must
    // leave every book, quote and print to be written again, not marked as already on disk.
    const pendBook = new Map(), pendQuote = new Map(), pendSeen = [];
    const marker = (why, extra) => lines.push(JSON.stringify({ mk: 'g', t: now, why, ...extra }));
    let nextGap = inGap, resnapshot = false;
    if (!started) marker('start');
    if (lost) marker('write-failed');
    if (gap) { if (inGap !== gap) marker(gap); nextGap = gap; }
    else if (inGap) { marker('resume', { after: inGap }); nextGap = null; resnapshot = true; }
    if (missed) marker('tape-gap');
    for (const [ticker, b] of (books || new Map())) {
      const bid = b.yesBids && b.yesBids[0], ask = b.yesAsks && b.yesAsks[0];
      if (!bid || !ask) continue;
      const row = { mk: 'b', t: Number.isFinite(at) ? at : now, k: ticker, b: r4(bid.price), bs: Math.round(bid.size || 0), a: r4(ask.price), as: Math.round(ask.size || 0) };
      const key = `${row.b}|${row.bs}|${row.a}|${row.as}`;
      const prev = resnapshot ? null : lastBook.get(ticker);
      if (prev && prev.key === key && now - prev.at < HEARTBEAT_MS) continue;
      if (prev && prev.key === key) row.hb = 1;
      pendBook.set(ticker, { key, at: now });
      lines.push(JSON.stringify(row));
    }
    for (const [ticker, ts] of (trades || new Map())) {
      for (const t of ts) {
        if (!t || seen.has(t.trade_id)) continue;
        const p = parseFloat(t.yes_price_dollars), n = parseFloat(t.count_fp);
        if (!Number.isFinite(p) || !Number.isFinite(n)) continue;
        pendSeen.push(t.trade_id);
        lines.push(JSON.stringify({ mk: 'p', t: Number.isFinite(t._t) ? t._t : now, k: ticker, id: t.trade_id, p: r4(p), n, s: t.taker_book_side === 'bid' ? 'b' : 'a', ...(t.is_block_trade ? { blk: 1 } : {}) }));
      }
    }
    for (const [ticker, m] of Object.entries(markets || {})) {
      const q = m && m.quotes;
      if (!q) continue;
      const key = `${q.bid ?? ''}|${q.ask ?? ''}|${m.inv || 0}`;
      if (lastQuote.get(ticker) === key) continue;
      pendQuote.set(ticker, key);
      const ahead = m.queue || {};
      lines.push(JSON.stringify({ mk: 'q', t: now, k: ticker, b: q.bid == null ? null : r4(q.bid), a: q.ask == null ? null : r4(q.ask), i: m.inv || 0,
        qb: q.bid == null ? 0 : Math.round(ahead.bid || 0), qa: q.ask == null ? 0 : Math.round(ahead.ask || 0) }));
    }
    if (!lines.length) { inGap = nextGap; return; }
    try {
      io.mkdirSync(cfg.dataDir, { recursive: true });
      io.appendFileSync(path.join(cfg.dataDir, `ticks-${ET_DAY.format(new Date(now))}.jsonl`), lines.join('\n') + '\n');
    } catch (e) {
      lost = true;
      // like the pair tape: it must never halt the desk, and a bad disk must not flood the log
      if (now - warnedAt > 300000) { warnedAt = now; try { E.log('MAKR', 'OPS', null, `maker tape write failed: ${String(e.message).slice(0, 120)}`); } catch { /* nothing left to tell */ } }
      return;
    }
    lost = false; started = true; inGap = nextGap;
    if (resnapshot) lastBook.clear();
    for (const [k, v] of pendBook) lastBook.set(k, v);
    for (const [k, v] of pendQuote) lastQuote.set(k, v);
    for (const id of pendSeen) seen.add(id);
    if (seen.size > 20000) { let n = 0; for (const id of seen) { if (n++ > 10000) break; seen.delete(id); } }
  };
}

module.exports = { makeMakerTape };

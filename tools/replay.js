'use strict';
// Replay the desk's decisions against a recorded tick tape.
//
//   node tools/replay.js data/ticks-2026-09-09.jsonl
//   node tools/replay.js data/ticks-*.jsonl --minEdge 0.002 --minGap 0.02
//   node tools/replay.js data/ticks-*.jsonl --sweep
//
// This is only possible because src/decide.js takes `now` as an argument and does no I/O: the
// SAME functions that decide live decide here, against a file and a synthetic clock. If replay
// and the live desk ever disagree, one of them has grown a hidden dependency on the wall clock
// or the network, and that is the bug.
//
// WHAT THIS CANNOT TELL YOU, and it matters more than anything it can:
//   The tape records TOP OF BOOK only -- one price and one size-free level per venue. So fills
//   here assume you get the whole order at the recorded ask. Real depth is finite; the live desk
//   walks a ladder and is frequently capped or rejected by it. Every P&L below is therefore an
//   UPPER BOUND, and a generous one on thin markets. Treat a losing replay as conclusive and a
//   winning one as a hypothesis that still has to survive data/probes-*.jsonl.
const fs = require('fs');
const decide = require('../src/decide');
const ks = require('../src/venues/kalshi');
const pm = require('../src/venues/polymarket');
const base = require('../src/config');

const args = process.argv.slice(2);
const files = args.filter((a) => !a.startsWith('--'));
const flag = (name, d) => { const i = args.indexOf(`--${name}`); return i >= 0 && args[i + 1] ? parseFloat(args[i + 1]) : d; };
const has = (name) => args.includes(`--${name}`);
if (!files.length) { console.error('usage: node tools/replay.js <tick file...> [--minGap X] [--minEdge Y] [--sweep]'); process.exit(1); }

const r2 = (x) => Math.round(x * 100) / 100;
const c = (x) => `${(x * 100).toFixed(2)}c`;
const money = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}`;

// --- rebuild the desk's view of one cycle from recorded rows ----------------
function loadCycles(files) {
  const byT = new Map();
  for (const f of files) {
    for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let r; try { r = JSON.parse(line); } catch { continue; }
      const t = Date.parse(r.t);
      if (!Number.isFinite(t)) continue;
      if (!byT.has(t)) byT.set(t, []);
      const [pmPart, ticker] = String(r.pair).split('|');
      const [pmId, tokenIndex] = pmPart.split(':');
      byT.get(t).push({
        id: r.pair, label: r.label, kind: r.kind, series: r.series, inPlay: !!r.inPlay,
        category: r.category, watchOnly: r.watch || undefined, stale: !!r.stale,
        closesAt: r.closesAt ? Date.parse(r.closesAt) : undefined, settlesAt: r.settlesAt ? Date.parse(r.settlesAt) : undefined,
        pm: { id: pmId, tokenIndex: +tokenIndex, tokenId: `tok:${r.pair}` },
        ks: { ticker },
        q: {
          pmBid: r.pmBid, pmAsk: r.pmAsk, ksBid: r.ksBid, ksAsk: r.ksAsk,
          pmMid: (r.pmBid + r.pmAsk) / 2, ksMid: (r.ksBid + r.ksAsk) / 2,
          pmSpread: r.pmAsk - r.pmBid, ksSpread: r.ksAsk - r.ksBid,
          pmVol: r.pmVol || 0, ksVol: r.ksVol || 0,
          // the Polymarket taker rate the desk priced this line at; tapes older than 2026-09-15 do
          // not carry it and are priced at the fallback, as the live desk prices an unknown market
          pmFeeRate: Number.isFinite(r.pmFee) ? r.pmFee : undefined,
          // the quote's own observation time, so the staleness gate behaves as it did live
          t: r.qt ? Date.parse(r.qt) : t,
        },
      });
    }
  }
  const cycles = [...byT.entries()].sort((a, b) => a[0] - b[0]);
  // Any-market pairs (kind 'event') are written only when something changes, plus a heartbeat
  // (src/recorder.js). Between lines the desk was still pricing them at the last written values, so
  // carry each forward into every cycle until its next line, with the quote time moved up to the
  // cycle -- unless the line itself said the quote was stale. A pair silent for longer than two
  // heartbeats was no longer being priced and is dropped rather than carried.
  const last = new Map();
  const HEARTBEAT_GRACE = 2 * Math.max(1, Number(base.recordHeartbeatMin) || 15) * 60000 + 60000;
  for (const [t, pairs] of cycles) {
    const here = new Set(pairs.map((p) => p.id));
    for (const [id, { p, at }] of last) {
      if (here.has(id)) continue;
      if (t - at > HEARTBEAT_GRACE) { last.delete(id); continue; }
      pairs.push({ ...p, carried: true, q: { ...p.q, t: p.stale ? p.q.t : t } });
    }
    for (const p of pairs) if (p.kind === 'event' && !p.carried) last.set(p.id, { p, at: t });
  }
  return cycles;
}

const markPrice = (pos, q) => (pos.venue === 'PM'
  ? (pos.side === 'yes' ? q.pmBid : Math.round((1 - q.pmAsk) * 1000) / 1000)
  : (pos.side === 'yes' ? q.ksBid : Math.round((1 - q.ksAsk) * 1000) / 1000));
// Same fee shapes as the live broker: Kalshi per series (the ticker is the ref), Polymarket at the
// rate the tape recorded for that market.
const feeFor = (venue, qty, px, cfg, ref, rate) => (venue === 'KS' ? ks.fee(qty, px, cfg.ksFeeRate, ref) : r2(pm.fee(qty, px, Number.isFinite(rate) ? rate : cfg.pmFeeFallback)));

function run(cycles, cfg, { verbose = false } = {}) {
  let cash = cfg.initialBalance;
  const positions = [], closed = [];
  const cooldown = new Map();
  let signalsSeen = 0;

  for (const [now, pairs] of cycles) {
    const byId = new Map(pairs.map((p) => [p.id, p]));

    // RIGO: mark, then ask the core whether to exit
    for (const pos of [...positions]) {
      const pair = byId.get(pos.pairId);
      if (pair && pair.q) pos.mark = markPrice(pos, pair.q);
      const intent = decide.exitIntent(pos, pair, cfg, now);
      if (!intent) continue;
      const fee = feeFor(pos.venue, pos.qty, intent.px, cfg, pos.ref, pos.feeRate);
      const proceeds = r2(pos.qty * intent.px - fee);
      cash = r2(cash + proceeds);
      positions.splice(positions.indexOf(pos), 1);
      cooldown.set(pos.pairId, now);
      closed.push({ ...pos, exit: intent.px, exitAt: now, reason: intent.reason, pnl: r2(proceeds - pos.cost), fees: r2(pos.fee + fee) });
      if (verbose) console.log(`  ${new Date(now).toISOString().slice(5, 16)} EXIT  ${pos.label.slice(0, 30).padEnd(30)} ${money(r2(proceeds - pos.cost)).padStart(9)}  ${intent.reason}`);
    }

    // BRAM: what does the core see this cycle?
    const { signals } = decide.scan(pairs, cfg, now);
    signalsSeen += signals.length;

    // KETT, minus the parts the tape cannot support (no ladders, so no depth cap and no
    // live-book re-verification; both of those only ever REDUCE fills, never add them)
    let considered = 0;
    for (const s of signals) {
      if (considered >= 2) break;
      if (positions.some((p) => p.pairId === s.pair.id)) continue;
      if (now - (cooldown.get(s.pair.id) || 0) < 10 * 60 * 1000) continue;
      if (decide.bookFull(positions, s, cfg)) continue;
      considered++;
      const equity = r2(cash + positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
      const budget = r2(Math.max(0, Math.min(cfg.maxPositionPct * equity, cash * 0.95)));
      if (budget < 5) break;
      const rate = decide.pmRate(s.pair.q, cfg);
      const unit = s.legs.reduce((a, l) => a + l.px + (l.venue === 'KS' ? ks.fee(1, l.px, cfg.ksFeeRate, s.pair.ks.ticker) : pm.feePerShare(l.px, rate)), 0);
      const qty = Math.floor(budget / unit);
      if (qty < 5) continue;
      const group = `r${now}${considered}`;
      let cost = 0;
      const legs = s.legs.map((l) => {
        const fee = feeFor(l.venue, qty, l.px, cfg, s.pair.ks.ticker, rate);
        cost = r2(cost + qty * l.px + fee);
        return { venue: l.venue, side: l.side, px: l.px, fee };
      });
      if (cost > cash) continue;
      cash = r2(cash - cost);
      for (const l of legs) {
        positions.push({
          id: `${group}-${l.venue}${l.side[0]}`, group, pairId: s.pair.id, label: s.pair.label,
          venue: l.venue, side: l.side, qty, entry: l.px, fee: l.fee, ref: l.venue === 'KS' ? s.pair.ks.ticker : null, feeRate: l.venue === 'PM' ? rate : undefined,
          cost: r2(qty * l.px + l.fee), mark: l.px, openedAt: now, strategy: s.type,
        });
      }
      if (verbose) console.log(`  ${new Date(now).toISOString().slice(5, 16)} OPEN  ${s.pair.label.slice(0, 30).padEnd(30)} ${String(qty).padStart(6)}x ${s.type} edge ${c(s.edge)}`);
    }
  }
  const equity = r2(cash + positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
  return { closed, open: positions.length, equity, signalsSeen,
    realized: r2(closed.reduce((a, x) => a + x.pnl, 0)),
    fees: r2(closed.reduce((a, x) => a + x.fees, 0)),
    wins: closed.filter((x) => x.pnl > 0).length, losses: closed.filter((x) => x.pnl <= 0).length };
}

// --- go ---------------------------------------------------------------------
const cycles = loadCycles(files);
if (!cycles.length) { console.error('no rows parsed'); process.exit(1); }
const span = (cycles[cycles.length - 1][0] - cycles[0][0]) / 3600000;
console.log(`${cycles.length} cycles over ${span.toFixed(1)}h  ·  ${new Date(cycles[0][0]).toISOString().slice(0, 16)} → ${new Date(cycles[cycles.length - 1][0]).toISOString().slice(0, 16)}`);
console.log(`\x1b[2mfills assume the full order at top of book: the tape has no depth, so every P&L here is an UPPER BOUND\x1b[0m\n`);

if (has('sweep')) {
  // Does ANY threshold pair make this book pay? Loosening the bar buys more trades, not more
  // edge -- if the whole grid is red, that is the answer, and no tuning rescues it.
  console.log(`${'minGap'.padStart(7)} ${'minEdge'.padStart(8)} ${'trades'.padStart(7)} ${'wins'.padStart(5)} ${'realized'.padStart(10)} ${'fees'.padStart(9)}`);
  for (const g of [0.005, 0.01, 0.02, 0.03, 0.05, 0.08]) {
    for (const e of [-0.005, 0, 0.002, 0.005, 0.01, 0.02]) {
      const r = run(cycles, { ...base, minGap: g, minEdge: e });
      const flagged = r.realized > 0 ? '\x1b[32m' : r.closed.length ? '\x1b[31m' : '\x1b[2m';
      console.log(`${flagged}${c(g).padStart(7)} ${c(e).padStart(8)} ${String(r.closed.length).padStart(7)} ${String(r.wins).padStart(5)} ${money(r.realized).padStart(10)} ${('$' + r.fees.toFixed(2)).padStart(9)}\x1b[0m`);
    }
  }
} else {
  const cfg = { ...base, minGap: flag('minGap', base.minGap), minEdge: flag('minEdge', base.minEdge) };
  console.log(`minGap ${c(cfg.minGap)}  minEdge ${c(cfg.minEdge)}  exitGap ${c(cfg.exitGap)}  stop ${c(cfg.stopLoss)}  maxHold ${cfg.maxHoldMin}m\n`);
  const r = run(cycles, cfg, { verbose: true });
  console.log(`\nsignals seen  ${r.signalsSeen}`);
  console.log(`trades closed ${r.closed.length}   wins ${r.wins}  losses ${r.losses}   still open ${r.open}`);
  console.log(`realized      ${money(r.realized)}   fees paid $${r.fees.toFixed(2)}`);
  console.log(`equity        $${r.equity.toFixed(2)}  from $${base.initialBalance.toFixed(2)}`);
}

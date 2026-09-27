'use strict';
// The settlement lag on game pairs, from the tick tape: when Polymarket settles a game (its book goes to
// 99/100 on the winner, or 0/1, on BOTH sides), what was Kalshi still offering the winner at, how fresh
// was that quote, and what would buying it have netted after Kalshi's fee? And the reverse, the rare
// times Kalshi went to 99 first.
//
//   node tools/settle-lag.js --day 2026-09-20            one ET day from data/fly/archive (repeatable)
//   node tools/settle-lag.js --day 2026-09-20 --all      every game, not only the ones worth 2c+
//
// What four days said (2026-09-19 → 09-22, ~180 game pairs): Polymarket settles first, nearly always.
// In ten games Kalshi's fresh quote was still 3c to 13c under par for the winner at that moment
// (Vikings 86c, Saints 87c, Guardians 88c, Nationals 90c, Royals 89c for NO...), and the tape stopped
// 15-30 seconds later because the pair left the listing with Polymarket's market. That is the settlement
// snipe (decide.snipeSignal); from 2026-09-23 the desk keeps such pairs for SNIPE_HOLD_SEC and the rows
// carry pmGone and Kalshi's top-of-book sizes, so the next Sunday says how long the window lasts.
//
// Two artifacts to know: an EMPTY Polymarket book records as 0/1 (rain delays, suspended games), which
// is why both sides have to agree before a row counts as settled; and a mismatched pair (the wrong game
// of a series: the Rays-Yankees doubleheader on 2026-09-22, Polymarket's game 1 paired with Kalshi's
// game 2) shows a 40c "gap" with Kalshi mid-game. The snipe's SNIPE_MIN_KS_PRICE is for the second.
//
// And the one that matters most (2026-09-24): a "settled" row here is a Polymarket 99c/1.00 READING,
// not a settlement. NC State v Vanderbilt read 0.99/1 for 2m15s on 2026-09-19, then traded back to 4c,
// and NC State lost; Temple did the same that day. Every edge this study counted was seen while
// Polymarket's market was still open. The desk now buys only once Polymarket's market record says
// closed or resolved, so the edge has to be measured again after the close -- Sunday 09-27 may show
// little or none.
//
// After the close (tapes from 2026-09-27 on). SNIPE=0 had also stopped the desk keeping finished game
// pairs, so the 09-25 and 09-26 tapes end at the listing drop. The snipe's watch (SNIPE_WATCH, on
// whether or not the snipe buys) asks Polymarket's market record whether each finished game has closed
// and stamps its rows: pmHaltedAt (first said "not accepting orders"), pmClosedAt (first said closed or
// resolved), and on kept rows ksQt, Kalshi's own quote time. From each of those two moments this says
// what Kalshi offered the winner, how many seconds it stayed 2c+ net under par, and how many contracts
// were at the touch: the two numbers the snipe was switched off waiting for. The two are far apart:
// on 09-26 Polymarket's record said closed only at resolution, 17-46 minutes after the 99c reading
// (closedTime = umaEndDate), while its listing dropped the game within seconds. The snipe buys only
// after the close, so the close is its test; the halt is when the game is over.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ks = require('../src/venues/kalshi');

const settledYes = (r) => r.pmBid >= 0.99 && r.pmAsk >= 0.999;
const settledNo = (r) => r.pmBid <= 0.001 && r.pmAsk <= 0.01;
const hhmmss = (s) => String(s).slice(11, 19);
const age = (r) => (r.qt ? `${Math.round((Date.parse(r.t) - Date.parse(r.qt)) / 1000)}s` : '?');
const secs = (ms) => { const s = Math.round(ms / 1000); return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`; };
// Kalshi's side of a row is fresh: on a kept row qt is the frozen Polymarket side's time, ksQt is Kalshi's
const ksFresh = (r, maxSec = 30) => { const q = r.ksQt || r.qt; return !q || Date.parse(r.t) - Date.parse(q) <= maxSec * 1000; };
// What Kalshi offered the winner from row `from` on, on its fresh rows only, timed from t0 (ms): the
// first row's price, net and size, how long it stayed 2c+ net row after row, the most at the touch
// while it did, and `open` when the tape let the pair go while it still did (so "at least").
function windowFrom(rows, from, t0, at, size) {
  const post = rows.slice(from).filter((r) => ksFresh(r));
  const x = post.length ? at(post[0]) : null;
  const worth = x != null && x.net >= 0.02;
  let underSec = 0, maxSize = null, open = worth;
  if (worth) {
    for (const r of post) {
      if (at(r).net < 0.02) { open = false; break; }
      underSec = (Date.parse(r.t) - t0) / 1000;
      if (Number.isFinite(size(r))) maxSize = Math.max(maxSize || 0, size(r));
    }
  }
  return { px: x && x.px, net: x && x.net, agree: x && x.agree, size: post.length ? size(post[0]) : null, worth, underSec, maxSize, open };
}
const offered = (k) => `Kalshi offered the winner at ${k.px == null ? '?' : `${(k.px * 100).toFixed(0)}c`}${Number.isFinite(k.size) ? ` (${k.size} at the touch)` : ''} → ${k.net == null ? '?' : `${(k.net * 100).toFixed(1)}c net`} · 2c+ net for ${k.open ? 'at least ' : ''}${secs(k.underSec * 1000)}${k.maxSize != null ? `, at most ${k.maxSize} at the touch` : ''}`;

async function study(file, { all = false, out = console.log, ksFeeRate = 0.07 } = {}) {
  const g = new Map();
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) {
    if (l.startsWith('{"mk"') || l.indexOf('"kind":"game"') < 0) continue;
    let j; try { j = JSON.parse(l); } catch { continue; }
    if (!g.has(j.pair)) g.set(j.pair, { label: j.label, rows: [] });
    g.get(j.pair).rows.push(j);
  }
  const found = [];
  for (const [id, { label, rows }] of g) {
    const ticker = id.split('|')[1];
    const i = rows.findIndex((r) => settledYes(r) || settledNo(r));
    if (i < 0) continue;
    const yesWon = settledYes(rows[i]);
    const at = (r) => { const px = yesWon ? r.ksAsk : 1 - r.ksBid; return { px, net: 1 - px - ks.feePerContract(px, ksFeeRate, ticker), agree: yesWon ? r.ksBid : 1 - r.ksAsk }; };
    const first = at(rows[i]);
    const after = rows.slice(i);
    const best = after.reduce((b, r) => Math.max(b, at(r).net), -1);
    const rec = { ticker, label, when: hhmmss(rows[i].t), winner: yesWon ? 'YES' : 'NO', px: first.px, net: first.net, agree: first.agree, best, rowsAfter: after.length - 1, sizes: after.some((r) => r.ksAskSize != null), pmGone: after.some((r) => r.pmGone) };
    found.push(rec);
    // From the two moments the watch stamps (pmHaltedAt, pmClosedAt): what Kalshi offered after each.
    const size = (r) => (yesWon ? r.ksAskSize : r.ksBidSize);
    const since = (iso) => (Date.parse(iso) - Date.parse(rows[i].t)) / 1000;
    const hi = rows.findIndex((r) => r.pmHaltedAt);
    if (hi >= 0) rec.halt = { at: hhmmss(rows[hi].pmHaltedAt), afterSec: since(rows[hi].pmHaltedAt), ...windowFrom(rows, hi, Date.parse(rows[hi].pmHaltedAt), at, size) };
    const ci = rows.findIndex((r) => r.pmClosedAt);
    if (ci >= 0) {
      const closedAt = Date.parse(rows[ci].pmClosedAt);
      rec.close = { at: hhmmss(rows[ci].pmClosedAt), afterSec: since(rows[ci].pmClosedAt), watchedSec: (Date.parse(rows[rows.length - 1].t) - closedAt) / 1000, ...windowFrom(rows, ci, closedAt, at, size) };
    }
    if ((rec.halt || rec.close) && (all || (rec.halt && rec.halt.worth) || (rec.close && rec.close.worth))) {
      const h = rec.halt, k = rec.close;
      out(`\n${ticker.padEnd(34)} ${label.padEnd(38)} Polymarket read ${rec.winner} at ${rec.when}`
        + `${h ? ` · stopped taking orders by ${h.at} (+${secs(h.afterSec * 1000)})` : ''}`
        + `${k ? ` · closed at ${k.at} (+${secs(k.afterSec * 1000)}) · the tape watched ${secs(k.watchedSec * 1000)} more` : ` · not closed while the tape watched (last row ${hhmmss(rows[rows.length - 1].t)})`}`);
      if (h) out(`    once Polymarket stopped taking orders, ${offered(h)}`);
      if (k) out(`    once Polymarket closed it, ${offered(k)}`);
      const from = h && h.worth ? hi : k && k.worth ? ci : -1;
      if (from >= 0) {
        for (const r of rows.slice(from, from + 12)) {
          const y = at(r);
          out(`    ${hhmmss(r.t)} +${secs(Date.parse(r.t) - Date.parse(rows[i].t)).padStart(6)}  KS ${String(r.ksBid).padEnd(4)}/${String(r.ksAsk).padEnd(4)}${r.ksAskSize != null ? `  (${r.ksBidSize}x${r.ksAskSize})` : ''}${ksFresh(r) ? '' : '  (Kalshi quote stale)'}  buy the winner at ${(y.px * 100).toFixed(0)}c → ${(y.net * 100).toFixed(1)}c net${r.pmClosedAt ? '  [closed]' : r.pmHaltedAt ? '  [no orders]' : ''}`);
        }
      }
    }
    if (!all && best < 0.02) continue;
    out(`\n${ticker.padEnd(34)} ${label.padEnd(38)} Polymarket settled ${rec.winner} at ${rec.when} · rows after: ${rec.rowsAfter}${rec.pmGone ? ' (kept past the close)' : ''}`);
    for (const r of rows.slice(Math.max(0, i - 1), i + 8)) {
      const x = at(r);
      out(`    ${hhmmss(r.t)} age ${age(r).padStart(4)}  PM ${String(r.pmBid).padEnd(5)}/${String(r.pmAsk).padEnd(5)}  KS ${String(r.ksBid).padEnd(4)}/${String(r.ksAsk).padEnd(4)}${r.ksAskSize != null ? `  (${r.ksBidSize}x${r.ksAskSize})` : ''}  buy the winner at ${(x.px * 100).toFixed(0)}c → ${(x.net * 100).toFixed(1)}c net${x.agree < 0.75 ? '   ← Kalshi does not agree: another game, or not over' : ''}`);
    }
  }
  const real = found.filter((f) => f.agree >= 0.75);
  const worth = real.filter((f) => f.best >= 0.02);
  out(`\n${path.basename(file)}: ${g.size} game pairs · Polymarket settled ${found.length} on the tape · ${real.length} with Kalshi agreeing on the winner · ${worth.length} worth 2c+ net at some row after: ${worth.map((f) => `${f.label.split(' · ')[0]} ${(f.best * 100).toFixed(1)}c`).join(', ') || 'none'}`);
  const halted = real.filter((f) => f.halt), closed = real.filter((f) => f.close);
  if (!halted.length && !closed.length) {
    out(`after the close: no row on this tape says when Polymarket stopped or closed a game (the watch stamps them from 2026-09-27)`);
    return { pairs: g.size, settled: found, worth, halted, closed };
  }
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const line = (list, key) => {
    const under = list.filter((f) => f[key].worth).sort((a, b) => b[key].underSec - a[key].underSec);
    return `Kalshi 2c+ net under par then in ${under.length}${under.length ? `: ${under.map((f) => `${f.label.split(' · ')[0]} ${(f[key].net * 100).toFixed(1)}c for ${f[key].open ? '≥' : ''}${secs(f[key].underSec * 1000)}${f[key].maxSize != null ? ` (${f[key].maxSize} at the touch)` : ''}`).join(', ')}` : ''} · for a minute or more in ${under.filter((f) => f[key].underSec >= 60).length}`;
  };
  if (halted.length) out(`once Polymarket stopped taking orders (seen in ${halted.length} of those ${real.length}, a median ${secs(median(halted.map((f) => f.halt.afterSec)) * 1000)} after the 99c reading): ${line(halted, 'halt')}`);
  if (closed.length) out(`once Polymarket closed the market (${closed.length} of those ${real.length} closed on the tape, a median ${secs(median(closed.map((f) => f.close.afterSec)) * 1000)} after the 99c reading): ${line(closed, 'close')}`);
  else out(`once Polymarket closed the market: none of those ${real.length} closed while the tape watched`);
  return { pairs: g.size, settled: found, worth, halted, closed };
}

module.exports = { study, settledYes, settledNo };

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const dir = path.resolve(all('dir')[0] || path.join(__dirname, '..', 'data', 'fly', 'archive'));
  const days = all('day');
  if (!days.length) { console.error('usage: node tools/settle-lag.js --day YYYY-MM-DD [--day ...] [--all] [--dir DIR]'); process.exit(1); }
  (async () => {
    for (const d of days) {
      const f = path.join(dir, `ticks-${d}.jsonl`);
      if (!fs.existsSync(f)) { console.error(`no tape for ${d} in ${dir}`); continue; }
      await study(f, { all: args.includes('--all') });
    }
  })();
}

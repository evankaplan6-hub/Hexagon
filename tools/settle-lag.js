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
// of a series) shows a 40c "gap" with Kalshi mid-game. The snipe's SNIPE_MIN_KS_PRICE is for the second.
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const ks = require('../src/venues/kalshi');

const settledYes = (r) => r.pmBid >= 0.99 && r.pmAsk >= 0.999;
const settledNo = (r) => r.pmBid <= 0.001 && r.pmAsk <= 0.01;
const hhmmss = (s) => String(s).slice(11, 19);
const age = (r) => (r.qt ? `${Math.round((Date.parse(r.t) - Date.parse(r.qt)) / 1000)}s` : '?');

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
  return { pairs: g.size, settled: found, worth };
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

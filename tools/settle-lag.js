'use strict';
// The settlement lag on game pairs, from the tick tape: when Polymarket settles a game (its book goes to
// 99/100 on the winner, or 0/1, on BOTH sides), what was Kalshi still offering the winner at, how fresh
// was that quote, and what would buying it have netted after Kalshi's fee? And the reverse, the rare
// times Kalshi went to 99 first.
//
//   node tools/settle-lag.js --day 2026-09-20            one ET day from data/fly/archive (repeatable)
//   node tools/settle-lag.js --day 2026-09-20 --all      every game, not only the ones worth 2c+
//   node tools/settle-lag.js --day 2026-09-29 --venues   ask both venues' records when each game closed,
//                                                        for games the watch did not journal (network)
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
//
// What 09-27 to 09-29 said (2026-09-30): no row was stamped, and could not be. Kalshi closes a finished
// game first, every time: over 105 games, a median 4.4 minutes after Polymarket's 99c reading, and pays
// it out two minutes later; Polymarket's record says closed a median 32 minutes after the reading (11 to
// 111), never sooner than 9.7 minutes after Kalshi has paid out. The desk lets a pair go five minutes
// after Kalshi's quote stops, so no kept row lives to the close, and there is nothing to buy at it. And
// "not accepting orders" comes only with the close. So, since 2026-09-30:
//   - the rows carry pmProposedAt instead of pmHaltedAt: when Polymarket's resolver first proposed the
//     result (about 20 seconds after the final on 09-30), which is when the snipe now buys. From it, this
//     says what Kalshi offered the winner, the way it does from the close;
//   - the watch follows each game to Polymarket's close and journals one SNIPE_WATCH line with both
//     venues' own close times. This reads them from the day's journal and the next day's (a late game
//     closes after midnight), and --venues asks the venues' records for any game with no line: the
//     tapes before the watch journalled, and games a restart cut off.
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

// The watch's SNIPE_WATCH lines (agents.watchCloses) from these journal files, by pair id.
function watchLines(files) {
  const by = new Map();
  for (const f of files) {
    if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) {
      if (l.indexOf('"SNIPE_WATCH"') < 0) continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      if (j.kind === 'SNIPE_WATCH' && j.pairId) by.set(j.pairId, { source: 'journal', proposedAt: j.proposedAt || null, pmClosedAt: j.pmClosedAt || null, ks: j.ks || null });
    }
  }
  return by;
}
// The same, from the venues' own records, for games with no line: Kalshi's close and payout (its
// close_time is a backstop months out while a market is open, so it counts only once the market is not
// active) and Polymarket's closedTime. `games` is [{ id, ticker, pmId }].
async function askVenues(games, { pm = require('../src/venues/polymarket'), kalshi = ks } = {}) {
  const by = new Map();
  if (!games.length) return by;
  const km = new Map((await kalshi.fetchMarketsByTickers([...new Set(games.map((x) => x.ticker))]).catch(() => [])).map((m) => [m.ticker, m]));
  for (const x of games) {
    const m = await pm.fetchMarket(x.pmId).catch(() => null), k = km.get(x.ticker);
    by.set(x.id, {
      source: 'venues', proposedAt: null,
      pmClosedAt: m && Number.isFinite(m.closedTime) ? new Date(m.closedTime).toISOString() : null,
      ks: k ? { status: k.status, closedAt: k.status !== 'active' ? k.closeTime : null, settledAt: k.settledAt || null } : null,
    });
  }
  return by;
}

async function study(file, { all = false, out = console.log, ksFeeRate = 0.07, journals = [], venues = null } = {}) {
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
    rec.id = id; rec.pmId = id.split(':')[0]; rec.readAt = rows[i].t;
    // From the two moments the watch stamps (pmProposedAt, pmClosedAt): what Kalshi offered after each.
    const size = (r) => (yesWon ? r.ksAskSize : r.ksBidSize);
    const since = (iso) => (Date.parse(iso) - Date.parse(rows[i].t)) / 1000;
    const hi = rows.findIndex((r) => r.pmProposedAt);
    if (hi >= 0) rec.proposal = { at: hhmmss(rows[hi].pmProposedAt), afterSec: since(rows[hi].pmProposedAt), ...windowFrom(rows, hi, Date.parse(rows[hi].pmProposedAt), at, size) };
    const ci = rows.findIndex((r) => r.pmClosedAt);
    if (ci >= 0) {
      const closedAt = Date.parse(rows[ci].pmClosedAt);
      rec.close = { at: hhmmss(rows[ci].pmClosedAt), afterSec: since(rows[ci].pmClosedAt), watchedSec: (Date.parse(rows[rows.length - 1].t) - closedAt) / 1000, ...windowFrom(rows, ci, closedAt, at, size) };
    }
    if ((rec.proposal || rec.close) && (all || (rec.proposal && rec.proposal.worth) || (rec.close && rec.close.worth))) {
      const h = rec.proposal, k = rec.close;
      out(`\n${ticker.padEnd(34)} ${label.padEnd(38)} Polymarket read ${rec.winner} at ${rec.when}`
        + `${h ? ` · its resolver proposed it by ${h.at} (+${secs(h.afterSec * 1000)})` : ''}`
        + `${k ? ` · closed at ${k.at} (+${secs(k.afterSec * 1000)}) · the tape watched ${secs(k.watchedSec * 1000)} more` : ` · not closed while the tape watched (last row ${hhmmss(rows[rows.length - 1].t)})`}`);
      if (h) out(`    once Polymarket's resolver proposed it, ${offered(h)}`);
      if (k) out(`    once Polymarket closed it, ${offered(k)}`);
      const from = h && h.worth ? hi : k && k.worth ? ci : -1;
      if (from >= 0) {
        for (const r of rows.slice(from, from + 12)) {
          const y = at(r);
          out(`    ${hhmmss(r.t)} +${secs(Date.parse(r.t) - Date.parse(rows[i].t)).padStart(6)}  KS ${String(r.ksBid).padEnd(4)}/${String(r.ksAsk).padEnd(4)}${r.ksAskSize != null ? `  (${r.ksBidSize}x${r.ksAskSize})` : ''}${ksFresh(r) ? '' : '  (Kalshi quote stale)'}  buy the winner at ${(y.px * 100).toFixed(0)}c → ${(y.net * 100).toFixed(1)}c net${r.pmClosedAt ? '  [closed]' : r.pmProposedAt ? '  [proposed]' : ''}`);
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
  const proposed = real.filter((f) => f.proposal), closed = real.filter((f) => f.close);
  const median = (xs) => { const v = [...xs].sort((a, b) => a - b); return v[Math.floor(v.length / 2)]; };
  const line = (list, key) => {
    const under = list.filter((f) => f[key].worth).sort((a, b) => b[key].underSec - a[key].underSec);
    return `Kalshi 2c+ net under par then in ${under.length}${under.length ? `: ${under.map((f) => `${f.label.split(' · ')[0]} ${(f[key].net * 100).toFixed(1)}c for ${f[key].open ? '≥' : ''}${secs(f[key].underSec * 1000)}${f[key].maxSize != null ? ` (${f[key].maxSize} at the touch)` : ''}`).join(', ')}` : ''} · for a minute or more in ${under.filter((f) => f[key].underSec >= 60).length}`;
  };
  if (proposed.length) out(`once Polymarket's resolver proposed the result (seen in ${proposed.length} of those ${real.length}, a median ${secs(median(proposed.map((f) => f.proposal.afterSec)) * 1000)} after the 99c reading): ${line(proposed, 'proposal')}`);
  if (closed.length) out(`once Polymarket closed the market (${closed.length} of those ${real.length} closed on the tape, a median ${secs(median(closed.map((f) => f.close.afterSec)) * 1000)} after the 99c reading): ${line(closed, 'close')}`);
  else if (proposed.length) out(`once Polymarket closed the market: none of those ${real.length} closed while the tape watched`);
  if (!proposed.length && !closed.length) out(`on the tape: no row says when Polymarket's resolver proposed or closed a game (the watch stamps the proposal from 2026-09-30)`);

  // Which venue closed first, by each one's own record: the watch's journal lines, and with --venues the
  // venues themselves for the games with none.
  const known = watchLines(journals);
  if (venues) {
    const missing = real.filter((f) => !known.has(f.id)).map((f) => ({ id: f.id, ticker: f.ticker, pmId: f.pmId }));
    for (const [id, v] of await venues(missing)) known.set(id, v);
  }
  const after = (iso, t0) => { const t = Date.parse(iso || ''); return Number.isFinite(t) ? (t - t0) / 1000 : null; };
  for (const f of real) {
    const v = known.get(f.id);
    if (!v) continue;
    const t0 = Date.parse(f.readAt), k = v.ks || {};
    f.venues = { source: v.source, proposedSec: after(v.proposedAt, t0), pmSec: after(v.pmClosedAt, t0), ksSec: after(k.closedAt, t0), paidSec: after(k.settledAt, t0), ksStatus: k.status || null };
  }
  const timed = real.filter((f) => f.venues && f.venues.pmSec != null);
  if (!timed.length) {
    out(`the close: neither venue's close time is on record for these games (the watch journals both from 2026-09-30; --venues asks the venues)`);
    return { pairs: g.size, settled: found, worth, proposed, closed, timed };
  }
  const both = timed.filter((f) => f.venues.ksSec != null);
  const ksFirst = both.filter((f) => f.venues.ksSec <= f.venues.pmSec);
  const ksLater = timed.filter((f) => (f.venues.ksSec != null && f.venues.ksSec > f.venues.pmSec) || f.venues.ksStatus === 'active');
  const paid = both.filter((f) => f.venues.paidSec != null);
  const pmSecs = timed.map((f) => f.venues.pmSec);
  const fromJ = timed.filter((f) => f.venues.source === 'journal').length;
  const m = (xs) => secs(median(xs) * 1000);
  if (all) {
    for (const f of timed) {
      const v = f.venues;
      out(`    ${f.label.padEnd(40)} read at ${f.when}${v.proposedSec != null ? ` · proposed +${secs(v.proposedSec * 1000)}` : ''}${v.ksSec != null ? ` · Kalshi closed +${secs(v.ksSec * 1000)}` : ` · Kalshi ${v.ksStatus || '?'}`}${v.paidSec != null ? `, paid out +${secs(v.paidSec * 1000)}` : ''} · Polymarket closed +${secs(v.pmSec * 1000)}`);
    }
  }
  out(`the close, by each venue's own record (${timed.length} of those ${real.length}: ${fromJ} from the watch's journal, ${timed.length - fromJ} from the venues): `
    + `Kalshi closed first in ${ksFirst.length} of ${both.length}${both.length ? `, a median ${m(both.map((f) => f.venues.ksSec))} after the 99c reading` : ''}${paid.length ? `, and paid out a median ${m(paid.map((f) => f.venues.paidSec))} after it` : ''}; `
    + `Polymarket closed a median ${m(pmSecs)} after it (${secs(Math.min(...pmSecs) * 1000)} to ${secs(Math.max(...pmSecs) * 1000)}) · `
    + `Kalshi still open at Polymarket's close in ${ksLater.length}${ksLater.length ? `: ${ksLater.map((f) => f.label.split(' · ')[0]).join(', ')}` : ''}`);
  const props = timed.filter((f) => f.venues.proposedSec != null);
  if (props.length) {
    const early = props.filter((f) => f.venues.ksSec == null || f.venues.proposedSec < f.venues.ksSec);
    out(`Polymarket's resolver proposed the result a median ${m(props.map((f) => f.venues.proposedSec))} after the 99c reading, before Kalshi closed in ${early.length} of ${props.length}`);
  }
  return { pairs: g.size, settled: found, worth, proposed, closed, timed };
}

module.exports = { study, settledYes, settledNo, watchLines, askVenues };

if (require.main === module) {
  const args = process.argv.slice(2);
  const all = (name) => args.flatMap((a, i) => (a === `--${name}` ? [args[i + 1]] : []));
  const dir = path.resolve(all('dir')[0] || path.join(__dirname, '..', 'data', 'fly', 'archive'));
  const days = all('day');
  if (!days.length) { console.error('usage: node tools/settle-lag.js --day YYYY-MM-DD [--day ...] [--all] [--venues] [--dir DIR]'); process.exit(1); }
  (async () => {
    for (const d of days) {
      const f = path.join(dir, `ticks-${d}.jsonl`);
      if (!fs.existsSync(f)) { console.error(`no tape for ${d} in ${dir}`); continue; }
      // the watch journals a game when Polymarket closes it, up to two hours on: after midnight for a late game
      const next = new Date(Date.parse(`${d}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
      const journals = [d, next].map((x) => path.join(dir, `journal-${x}.jsonl`));
      await study(f, { all: args.includes('--all'), journals, venues: args.includes('--venues') ? askVenues : null });
    }
  })();
}

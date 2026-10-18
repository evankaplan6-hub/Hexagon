'use strict';
// The game bets' record against what their prices said (README "Every game"): every settled bet of the every-game
// book, how many won, how many the prices expected (each bet's price is the market's chance for its team, so the
// prices added up are the wins a fair price expects), and how far chance alone moves that: one standard deviation,
// sqrt of the sum of p(1-p) over the bets, exact. By Eastern week and by league. Evan, 2026-10-17, after the new
// Games view showed 69 won of 123 where the prices said 81 and the January re-test was the next look: "boooo".
// So this is the look between: the Monday check runs it (scheduled task hexagon-weekly-pnl).
//
//   node tools/bet-record.js                  the journals: data/fly/archive (the hourly pull) and data/fly/box-now (the
//                                             daily check's copy of the box's unarchived days)
//   node tools/bet-record.js --box            the archive and the box's own unarchived journals, copied to a temp folder
//                                             (read-only on the box)
//   node tools/bet-record.js --state F        a desk state.json's closed legs instead (it keeps only the newest 2,000)
//   node tools/bet-record.js --flips          also: of last week's bets placed over an hour before the start, the
//                                             ones no longer the favourite an hour before it (Kalshi's public candles);
//                                             exit 1 if Kalshi could not be asked about some of them
//
// From the journals since the audit of 2026-10-17: the state's closed legs are capped at the newest 2,000, about ten
// weeks of the book, and the record would have begun dropping its oldest games around the January re-test. A bet's
// SETTLE line carries its label, side, venue, price, size and money; its OPEN line its cost.
//
// Read-only: the ledger, and with --flips Kalshi's public API. What it found on 2026-10-17 (README, "Is the book
// unlucky?"): no bug, prices did not drift against the picks, and every Kalshi favourite in those weeks fell short
// as much as the book's (a run of upsets, mostly college football); six picks bet a day ahead stopped being the
// favourite before kickoff and five lost, which the one-hour rule (since 2026-10-16) is for.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' });
const etDay = (t) => ET.format(new Date(t));
// a game is dated by its settlement less four hours: Kalshi settles minutes after the final, and a game ending after
// midnight belongs to the evening it started (tools/bet-coverage.js and the floor read it the same way)
const playedDay = (t) => etDay(t - 4 * 3600e3);
// the Monday that starts an Eastern day's week (tools/week-report.js's weeks)
function weekOf(day) {
  const d = new Date(`${day}T12:00:00Z`), back = (d.getUTCDay() + 6) % 7;
  return new Date(d.getTime() - back * 864e5).toISOString().slice(0, 10);
}
const r2 = (x) => Math.round(x * 100) / 100;
const usd = (x) => `${x >= 0 ? '+' : '−'}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const LEAGUE = { NCAAF: 'College', NFL: 'NFL', NBA: 'NBA', MLB: 'MLB' };

// every settled bet of the every-game book, oldest first: { id, ticker, label, league, side, venue, p, cost, pnl, won, opened, at, day }
function settled(state) {
  return (state.closed || []).filter((c) => c.strategy === 'bet' && Number.isFinite(c.exitAt) && Number.isFinite(c.entry)).map((c) => ({
    id: c.id, ticker: String(c.pairId || '').split('|')[1] || null, label: c.label, league: String(c.label || '').split(' ')[0],
    side: c.side, venue: c.venue, p: c.entry, cost: c.cost, pnl: c.pnl, won: c.pnl > 0, opened: c.openedAt, at: c.exitAt, day: playedDay(c.exitAt),
  })).sort((a, b) => a.at - b.at);
}
// The same, from journal lines: each SETTLE of strategy "bet", its cost from its OPEN (the state's closed leg keeps
// both). The lines the 10-15 disk-full holes swallowed are restored beside them (tools/journal-gaps.js).
function settledFromJournal(lines) {
  const opens = new Map(), out = [], seen = new Set();
  for (const e of lines) if (e && e.kind === 'OPEN' && e.strategy === 'bet') opens.set(e.id, e);
  for (const e of lines) {
    if (!e || e.kind !== 'SETTLE' || e.strategy !== 'bet' || seen.has(e.id) || !Number.isFinite(e.entry)) continue;
    seen.add(e.id);
    const o = opens.get(e.id) || {}, at = Date.parse(e.t);
    out.push({ id: e.id, ticker: String(e.pairId || o.pairId || '').split('|')[1] || null, label: e.label || o.label, league: String(e.label || o.label || '').split(' ')[0],
      side: e.side, venue: e.venue, p: e.entry, cost: Number.isFinite(o.cost) ? o.cost : r2(e.qty * e.entry + (o.fee || 0)), pnl: e.pnl, won: e.pnl > 0,
      opened: Number.isFinite(e.heldMs) ? at - e.heldMs : (o.t ? Date.parse(o.t) : null), at, day: playedDay(at) });
  }
  return out.sort((a, b) => a.at - b.at);
}
function readJournals(dirs) {
  const lines = [], seen = new Set();
  for (const dir of dirs) {
    if (!dir || !fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((x) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(x)).sort()) {
      for (const l of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
        if (!l) continue;
        let j; try { j = JSON.parse(l); } catch { continue; }
        const k = `${j.t}|${j.id || ''}|${j.kind}`;
        if (!seen.has(k)) { seen.add(k); lines.push(j); }
      }
    }
  }
  return [...lines, ...require('./journal-gaps').restoredEvents(lines)];
}
// a record: bets, wins, the wins the prices expected, chance's spread (one sd), how many sds the wins are off, the money
function record(xs) {
  const won = xs.filter((x) => x.won).length, expected = xs.reduce((a, x) => a + x.p, 0), v = xs.reduce((a, x) => a + x.p * (1 - x.p), 0);
  const sd = Math.sqrt(v);
  return { bets: xs.length, won, expected: r2(expected), sd: r2(sd), z: sd ? r2((won - expected) / sd) : 0, staked: r2(xs.reduce((a, x) => a + x.cost, 0)), pnl: r2(xs.reduce((a, x) => a + x.pnl, 0)) };
}
const verdict = (r) => (!r.bets ? 'no bet settled' : Math.abs(r.z) < 2 ? 'within luck' : r.z < 0 ? 'more short than luck usually gives' : 'more ahead than luck usually gives');
const groupBy = (xs, f) => { const g = new Map(); for (const x of xs) { const k = f(x); if (!g.has(k)) g.set(k, []); g.get(k).push(x); } return g; };

// the report, as lines a person reads: `input` is the settled bets, or a state to read them from. `now` picks "last
// week": the last whole Eastern week before today's.
function report(input, now = Date.now()) {
  const xs = Array.isArray(input) ? input : settled(input), all = record(xs);
  const thisWeek = weekOf(etDay(now)), lastWeek = weekOf(new Date(Date.parse(`${thisWeek}T12:00:00Z`) - 7 * 864e5).toISOString().slice(0, 10));
  const fmt = (r) => `${r.won}–${r.bets - r.won}, the prices said ${r.expected.toFixed(1)} (${r.won - r.expected >= 0 ? '+' : '−'}${Math.abs(r.won - r.expected).toFixed(1)}, ${Math.abs(r.z).toFixed(1)} sd${r.z ? (r.z < 0 ? ' short' : ' ahead') : ''}) · ${usd(r.pnl)}`;
  const L = [];
  L.push(`Game bets, settled: ${fmt(all)} · ${verdict(all)}`);
  const lw = record(xs.filter((x) => weekOf(x.day) === lastWeek));
  L.push(`Last week (from Mon ${lastWeek}): ${lw.bets ? `${fmt(lw)} · ${verdict(lw)}` : 'no bet settled'}`);
  const tw = record(xs.filter((x) => weekOf(x.day) === thisWeek));
  if (tw.bets) L.push(`This week so far: ${fmt(tw)}`);
  L.push('');
  L.push('By week:');
  for (const [wk, ys] of groupBy(xs, (x) => weekOf(x.day))) L.push(`  ${wk}  ${fmt(record(ys))}`);
  L.push('By league:');
  for (const [lg, ys] of [...groupBy(xs, (x) => x.league)].sort((a, b) => b[1].length - a[1].length)) L.push(`  ${(LEAGUE[lg] || lg).padEnd(8)} ${fmt(record(ys))}`);
  L.push('');
  L.push("(The prices are what the book paid, about 1.7c a bet over Kalshi's fair mid, so the expected wins run a little high. One sd is chance's" +
    ' spread from the bets\' own prices; under 2 is within luck.)');
  return { lines: L, all, lastWeek: lw, xs, weeks: { thisWeek, lastWeek } };
}

// --flips: of the bets settled last week that were placed over an hour before the start, the ones Kalshi no longer
// had as the favourite an hour before it (the pick lab's "an hour out beats a day out", live). Each is named by the
// team bet on (a NO leg is the other team). A bet Kalshi could not be asked about is counted, not passed over: "no
// flips" with Kalshi down was a false all-clear (audit 2026-10-17).
async function flips(xs, week) {
  const B = 'https://api.elections.kalshi.com/trade-api/v2', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const { gameOf } = require('../src/pmfloor');
  let unreached = 0;
  const get = async (u) => {
    for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: { 'user-agent': 'the-hexagon/1.0' } }); if (r.status === 404) return null; if (r.ok) return r.json(); } catch { /* retry */ } await sleep(600 * 2 ** i); }
    throw new Error('unreached');
  };
  const out = [];
  for (const x of xs.filter((y) => weekOf(y.day) === week && y.ticker)) {
    try {
      const series = x.ticker.split('-')[0];
      const m = ((await get(`${B}/markets/${x.ticker}`)) || {}).market || {};
      const occ = Date.parse(m.occurrence_datetime || ''), close = Date.parse(m.close_time || '');
      let start = Number.isFinite(occ) ? occ - 3 * 3600e3 : null;
      if (!(start != null && start < close && close - start < 6 * 3600e3) && Number.isFinite(close)) start = close - 3.5 * 3600e3;
      if (!(start - x.opened > 65 * 60e3)) continue;
      const ts = Math.floor((start - 3600e3) / 1000);
      const d = await get(`${B}/series/${series}/markets/${x.ticker}/candlesticks?start_ts=${ts - 4 * 3600}&end_ts=${ts}&period_interval=60`);
      const ks = ((d && d.candlesticks) || []).filter((k) => k.end_period_ts <= ts + 60);
      const k = ks[ks.length - 1], b = k && parseFloat(k.yes_bid && (k.yes_bid.close_dollars ?? k.yes_bid.close / 100)), a = k && parseFloat(k.yes_ask && (k.yes_ask.close_dollars ?? k.yes_ask.close / 100));
      if (!(b > 0 && a > 0)) continue;
      const pick = x.side === 'yes' ? (a + b) / 2 : 1 - (a + b) / 2;
      // under 49.5c: 49.6c is a game the market had even, not a favourite turned round
      const g = gameOf({ strategy: 'bet', label: x.label, side: x.side });
      if (pick < 0.495) out.push({ ...x, then: Math.round(pick * 1000) / 1000, name: g ? `${g.pick} over ${g.foe}` : x.label });
    } catch { unreached++; }
    await sleep(100);
  }
  return { flipped: out, unreached };
}

// --box: the box's journals the archive does not have yet (today's, and any the hourly pull has not copied),
// fetched to a temp folder; read-only on the box
function boxJournals(archive) {
  const { execFileSync } = require('child_process');
  const fly = process.env.FLY_BIN || (fs.existsSync(path.join(os.homedir(), '.fly', 'bin', 'fly')) ? path.join(os.homedir(), '.fly', 'bin', 'fly') : 'fly');
  const have = new Set(fs.existsSync(archive) ? fs.readdirSync(archive) : []);
  const names = execFileSync(fly, ['ssh', 'console', '-q', '-a', 'hexagon-desk', '-C', 'ls /data'], { encoding: 'utf8', timeout: 120000 })
    .split(/\s+/).filter((n) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && !have.has(n));
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-record-'));
  for (const n of names) execFileSync(fly, ['ssh', 'sftp', 'get', '-q', '-a', 'hexagon-desk', `/data/${n}`, path.join(dir, n)], { stdio: 'ignore', timeout: 300000 });
  return dir;
}

if (require.main === module) (async () => {
  const argv = process.argv.slice(2), at = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const root = path.join(__dirname, '..'), archive = path.join(root, 'data', 'fly', 'archive');
  let xs, tmp = null;
  if (at('state')) xs = settled(JSON.parse(fs.readFileSync(at('state'), 'utf8')));
  else {
    if (argv.includes('--box')) tmp = boxJournals(archive);
    try { xs = settledFromJournal(readJournals([archive, tmp || path.join(root, 'data', 'fly', 'box-now')])); }
    finally { if (tmp) fs.rmSync(tmp, { recursive: true, force: true }); }
  }
  const r = report(xs);
  for (const l of r.lines) console.log(l);
  if (argv.includes('--flips')) {
    const { flipped, unreached } = await flips(r.xs, r.weeks.lastWeek);
    console.log(flipped.length ? `\nLast week, bet over an hour ahead and no longer the favourite an hour before the start: ${flipped.length}, ${flipped.filter((x) => x.won).length} won`
      : `\nLast week, no pick bet over an hour ahead had stopped being the favourite an hour before the start${unreached ? ', of those Kalshi answered about' : ''}.`);
    for (const x of flipped) console.log(`  ${x.name} · bet at ${Math.round(x.p * 100)}c, ${Math.round(x.then * 100)}c an hour before · ${x.won ? 'won' : 'lost'}`);
    if (unreached) { console.log(`PROBLEM Kalshi could not be asked about ${unreached} of last week's bets: the flip list is incomplete`); process.exitCode = 1; }
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { settled, settledFromJournal, readJournals, record, report, verdict, weekOf, playedDay, flips };

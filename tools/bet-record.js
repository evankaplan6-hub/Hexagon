'use strict';
// The game bets' record against what their prices said (README "Every game"): every settled bet of the every-game
// book, how many won, how many the prices expected (each bet's price is the market's chance for its team, so the
// prices added up are the wins a fair price expects), and how far chance alone moves that: one standard deviation,
// sqrt of the sum of p(1-p) over the bets, exact. By Eastern week and by league. Evan, 2026-10-17, after the new
// Games view showed 69 won of 123 where the prices said 81 and the January re-test was the next look: "boooo".
// So this is the look between: the Monday check runs it (scheduled task hexagon-weekly-pnl).
//
//   node tools/bet-record.js                  data/fly/box-now/state.json (ledger-check --box, daily check step 2)
//   node tools/bet-record.js --box            the box's state.json, copied to a temp file (read-only on the box)
//   node tools/bet-record.js --file F         any prediction-market desk state.json
//   node tools/bet-record.js --flips          also: of last week's bets placed over an hour before the start, the
//                                             ones no longer the favourite an hour before it (Kalshi's public candles)
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
// a record: bets, wins, the wins the prices expected, chance's spread (one sd), how many sds the wins are off, the money
function record(xs) {
  const won = xs.filter((x) => x.won).length, expected = xs.reduce((a, x) => a + x.p, 0), v = xs.reduce((a, x) => a + x.p * (1 - x.p), 0);
  const sd = Math.sqrt(v);
  return { bets: xs.length, won, expected: r2(expected), sd: r2(sd), z: sd ? r2((won - expected) / sd) : 0, staked: r2(xs.reduce((a, x) => a + x.cost, 0)), pnl: r2(xs.reduce((a, x) => a + x.pnl, 0)) };
}
const verdict = (r) => (!r.bets ? 'no bet settled' : Math.abs(r.z) < 2 ? 'within luck' : r.z < 0 ? 'more short than luck usually gives' : 'more ahead than luck usually gives');
const groupBy = (xs, f) => { const g = new Map(); for (const x of xs) { const k = f(x); if (!g.has(k)) g.set(k, []); g.get(k).push(x); } return g; };

// the report, as lines a person reads. `now` picks "last week": the last whole Eastern week before today's.
function report(state, now = Date.now()) {
  const xs = settled(state), all = record(xs);
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
// had as the favourite an hour before it (the pick lab's "an hour out beats a day out", live)
async function flips(xs, sinceMs) {
  const B = 'https://api.elections.kalshi.com/trade-api/v2', sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const get = async (u) => { for (let i = 0; i < 4; i++) { try { const r = await fetch(u, { headers: { 'user-agent': 'the-hexagon/1.0' } }); if (r.status === 404) return null; if (r.ok) return r.json(); } catch { /* retry */ } await sleep(600 * 2 ** i); } return null; };
  const out = [];
  for (const x of xs.filter((y) => y.at >= sinceMs && y.ticker)) {
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
    if (pick < 0.495) out.push({ ...x, then: Math.round(pick * 1000) / 1000 });
    await sleep(100);
  }
  return out;
}

function boxState() {
  const { execFileSync } = require('child_process');
  const fly = process.env.FLY_BIN || (fs.existsSync(path.join(os.homedir(), '.fly', 'bin', 'fly')) ? path.join(os.homedir(), '.fly', 'bin', 'fly') : 'fly');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bet-record-')), to = path.join(dir, 'state.json');
  try {
    execFileSync(fly, ['ssh', 'sftp', 'get', '-q', '-a', 'hexagon-desk', '/data/state.json', to], { stdio: 'ignore', timeout: 300000 });
    return JSON.parse(fs.readFileSync(to, 'utf8'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

if (require.main === module) (async () => {
  const argv = process.argv.slice(2), at = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : null; };
  const state = argv.includes('--box') ? boxState() : JSON.parse(fs.readFileSync(at('file') || path.join(__dirname, '..', 'data', 'fly', 'box-now', 'state.json'), 'utf8'));
  const r = report(state);
  for (const l of r.lines) console.log(l);
  if (argv.includes('--flips')) {
    const since = Date.parse(`${r.weeks.lastWeek}T04:00:00Z`);
    const f = await flips(r.xs, since);
    console.log(f.length ? `\nBet over an hour ahead and no longer the favourite an hour before the start (since ${r.weeks.lastWeek}): ${f.length}, ${f.filter((x) => x.won).length} won` : `\nSince ${r.weeks.lastWeek}, no pick bet over an hour ahead had stopped being the favourite an hour before the start.`);
    for (const x of f) console.log(`  ${x.label} · bet at ${Math.round(x.p * 100)}c, ${Math.round(x.then * 100)}c an hour before · ${x.won ? 'won' : 'lost'}`);
  }
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { settled, record, report, verdict, weekOf, playedDay };

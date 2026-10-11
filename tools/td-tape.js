'use strict';
// The anytime-touchdown tape: Kalshi's "1+ touchdowns" player markets, recorded in the hours before
// kickoff and graded once the games settle, to measure what a one-sided prop board costs. LOG-ONLY,
// research: no bet, no broker, nothing in the desk reads it, and nothing here can place an order.
//
//   node tools/td-tape.js --record            # append every open 1+ TD market whose game kicks off within
//                                             # RECORD_AHEAD_H and has not kicked off -> data/td/td-YYYY-MM-DD.jsonl
//   node tools/td-tape.js --record --dry-run  # fetch and report, write nothing (ops/install-td-tape.sh uses this)
//   node tools/td-tape.js --grade [--day D]   # the last record before kickoff, per market, against Kalshi's result
//   node tools/td-tape.js --check             # read-only: is the tape alive? (one line, exit 1 on a PROBLEM)
//
// WHY (2026-10-11, Evan: "parlays? atd parlay?"). The NFL knowledge base in the SharpAI skill prices the
// anytime-touchdown market from base rates (lead backs score in 47.7% of games, fair +110; receivers with
// 6+ targets 35%) and lists its hold as an open gap: anytime boards are one-sided at the sportsbooks, so
// the hold never shows as a two-way sum, and nobody has measured it. Kalshi lists the same market two-sided
// (KXNFLTD, "<player>: 1+"), about 23 players a game, with a bid and an ask. So the hold can be measured:
// buy every YES at the ask, or every NO at its ask, and see what the board returns over a season. That is
// the whole study. If it loses about the spread plus the fee, the board is fair and a parlay of its legs
// compounds that loss; if YES at the ask returns more than that, there is something to look at.
//
// WHAT IS RECORDED. One JSON line per market per run, appended to the file of the game's Eastern day:
//   {"t":"2026-10-11T16:45:02Z","ticker":"KXNFLTD-26OCT11BALATL-ATLCWOERNER89-1","event":"KXNFLTD-26OCT11BALATL",
//    "game":"BALATL","player":"Charlie Woerner","team":"ATL","kickoff":"2026-10-12T00:20:00Z",
//    "bid":0.05,"ask":0.06,"bidSz":100,"askSz":18385,"vol":0,"oi":0,"status":"active"}
// Only markets whose game kicks off within RECORD_AHEAD_H (3 hours) and has not kicked off yet: inactives
// are published 90 minutes before kickoff, so a tape at 15-minute steps holds the board after that news,
// and the grader takes each market's LAST record before kickoff. A run with no game in the window reads
// one Kalshi page and writes nothing. Markets other than "1+" (2+, 3+) are not kept.
//
// KICKOFF. Kalshi's market rows carry no kickoff field. `occurrence_datetime` is the expected END of the
// game: on 2026-10-11 it read 20:00Z, 23:05Z, 23:25Z and 03:20Z for games kicking off at 17:00Z (1 PM
// ET), 20:05Z, 20:25Z and 00:20Z, three hours later each time, on the game markets and the touchdown
// markets alike (expected_expiration_time varies: +3h on three of them, +6h on one). So kickoff =
// occurrence_datetime - 3h, and the raw field is kept on every line so a day where that stops being
// true can be re-read. The grader also refuses a "last record" more than PRE_KICK_MAX_H before kickoff.
//
// GRADING. finalized with result yes/no counts; a market settled at anything but 0 or 1 is void (Kalshi
// settles a player who was active but took no snap "to the fair market price before game start"); an
// open market is pending. Both-side returns, gross and net of Kalshi's fee on the way in (settlement is
// free): YES bought at the ask pays 1 - ask on a touchdown and loses the ask otherwise; NO bought at
// 1 - bid pays the bid when no touchdown and loses 1 - bid otherwise. Cut by the YES ask in four bands.
// Each run leaves one ok/PROBLEM line in data/td/td.log, and --check reads the last one.
const fs = require('fs');
const path = require('path');
const http = require('../src/http');
const ks = require('../src/venues/kalshi');

const SERIES = 'KXNFLTD';
const DIR = path.join(__dirname, '..', 'data', 'td');
const LOG = 'td.log';
const RECORD_AHEAD_H = 3;       // record a game's board from this long before kickoff
const PRE_KICK_MAX_H = 2;       // a "last record before kickoff" older than this is no pre-kickoff record
const GAME_LENGTH_H = 3;        // occurrence_datetime - this = kickoff (see KICKOFF above)
const BANDS = [[0, 0.10, 'ask <= 10c'], [0.10, 0.25, '10c < ask <= 25c'], [0.25, 0.40, '25c < ask <= 40c'], [0.40, 1, 'ask > 40c']];
const FEE_RATE = 0.07;          // Kalshi's base rate; the series multiplier is read from the venue (ks.loadFeeMultipliers)

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDay = (ms) => ET.format(new Date(ms));

// Kalshi's row -> a tape line (without `t`), or null for anything that is not a "1+" market with a kickoff.
function parseMarket(m) {
  if (!m || !/-1$/.test(String(m.ticker || ''))) return null;
  const occ = Date.parse(m.occurrence_datetime || '');
  if (!Number.isFinite(occ)) return null;
  const event = String(m.event_ticker || '');
  const game = event.split('-')[1] ? event.split('-')[1].replace(/^\d{2}[A-Z]{3}\d{2}/, '') : null;
  const seg = String(m.ticker).split('-')[2] || '';
  return {
    ticker: m.ticker, event, game,
    player: String(m.yes_sub_title || m.title || '').replace(/:\s*1\+.*$/, '').trim(),
    team: teamOf(game, seg),
    kickoff: new Date(occ - GAME_LENGTH_H * 3600e3).toISOString(),
    occurrence: m.occurrence_datetime,
    bid: num(m.yes_bid_dollars), ask: num(m.yes_ask_dollars),
    bidSz: num(m.yes_bid_size_fp) || 0, askSz: num(m.yes_ask_size_fp) || 0,
    vol: num(m.volume_fp) || 0, oi: num(m.open_interest_fp) || 0,
    status: m.status || null,
  };
}
// "BALATL" + "ATLCWOERNER89" -> "ATL". The event code is the two team codes run together (LVNE is LV + NE,
// CLENYJ is CLE + NYJ), so every split into 2-3 letter codes is tried and the one that prefixes the player
// segment wins. MINNO + "MINJJEFFERSON18" matches both MI (of a MI + NNO split) and MIN: when every hit is
// a prefix of the longest, the longest is the team; two unrelated hits, or none, are null rather than a guess.
function teamOf(game, seg) {
  if (!game || !seg) return null;
  const hits = new Set();
  for (let i = 2; i <= 3 && i < game.length; i++) {
    const [a, h] = [game.slice(0, i), game.slice(i)];
    if (h.length < 2 || h.length > 3) continue;
    if (seg.startsWith(h)) hits.add(h);
    if (seg.startsWith(a)) hits.add(a);
  }
  if (!hits.size) return null;
  const longest = [...hits].sort((x, y) => y.length - x.length)[0];
  return [...hits].every((x) => longest.startsWith(x)) ? longest : null;
}

// Which parsed markets a run at `now` records: kickoff within RECORD_AHEAD_H, not yet kicked off.
function toRecord(markets, now) {
  const ahead = RECORD_AHEAD_H * 3600e3;
  return markets.filter((m) => { const k = Date.parse(m.kickoff); return k > now && k - now <= ahead; });
}
const fileFor = (dir, kickoffIso) => path.join(dir, `td-${etDay(Date.parse(kickoffIso))}.jsonl`);

async function fetchOpen(getJSON = http.getJSON) {
  const out = [];
  let cursor = '';
  for (let page = 0; page < 20; page++) {
    const r = await getJSON(`${ks.BASE}/markets?series_ticker=${SERIES}&status=open&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
    for (const m of (r && r.markets) || []) out.push(m);
    cursor = (r && r.cursor) || '';
    if (!cursor) break;
  }
  return out;
}

// One line for td.log: what the run did, ok or PROBLEM. PROBLEM only when something that should have
// worked did not: Kalshi unreachable, or a file that would not take the write.
function logLine(now, { ok, recorded, games, open, note }) {
  return `${new Date(now).toISOString()} ${ok ? 'ok' : 'PROBLEM'} td-tape: ${open} open 1+ markets, ${games} game${games === 1 ? '' : 's'} in the next ${RECORD_AHEAD_H}h, ${recorded} line${recorded === 1 ? '' : 's'} written${note ? ` · ${note}` : ''}`;
}

async function record({ dir = DIR, now = Date.now(), dryRun = false, getJSON = http.getJSON, io = fs } = {}) {
  let raw;
  try { raw = await fetchOpen(getJSON); }
  catch (e) {
    const line = logLine(now, { ok: false, recorded: 0, games: 0, open: 0, note: `Kalshi: ${String(e.message).slice(0, 80)}` });
    if (!dryRun) { io.mkdirSync(dir, { recursive: true }); io.appendFileSync(path.join(dir, LOG), line + '\n'); }
    return { ok: false, line, recorded: 0 };
  }
  const all = raw.map(parseMarket).filter(Boolean);
  const due = toRecord(all, now);
  const t = new Date(now).toISOString();
  const byFile = new Map();
  for (const m of due) {
    const f = fileFor(dir, m.kickoff);
    if (!byFile.has(f)) byFile.set(f, []);
    byFile.get(f).push(JSON.stringify({ t, ...m }));
  }
  let ok = true, note = '';
  if (!dryRun) {
    try {
      io.mkdirSync(dir, { recursive: true });
      for (const [f, lines] of byFile) io.appendFileSync(f, lines.join('\n') + '\n');
    } catch (e) { ok = false; note = `write failed: ${String(e.message).slice(0, 80)}`; }
  }
  const games = new Set(due.map((m) => m.event)).size;
  const line = logLine(now, { ok, recorded: dryRun ? 0 : due.length, games, open: all.length, note: dryRun ? `dry run, ${due.length} would be written` : note });
  if (!dryRun) { try { io.appendFileSync(path.join(dir, LOG), line + '\n'); } catch { /* the log is a courtesy; the tape is the record */ } }
  return { ok, line, recorded: dryRun ? 0 : due.length, due, files: [...byFile.keys()] };
}

// ---------------------------------------------------------------- grading (pure, given records and results)
function readTape(dir = DIR, day = null) {
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^td-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && (!day || f === `td-${day}.jsonl`)).sort();
  const out = [];
  for (const f of files) for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { out.push(JSON.parse(line)); } catch { /* a torn last line from a killed run is not data */ }
  }
  return out;
}
// Per ticker, the last record before kickoff and no older than PRE_KICK_MAX_H; `skipped` counts the rest.
function lastBeforeKickoff(records) {
  const by = new Map();
  for (const r of records) {
    const k = Date.parse(r.kickoff), t = Date.parse(r.t);
    if (!(t < k) || k - t > PRE_KICK_MAX_H * 3600e3) continue;
    const prev = by.get(r.ticker);
    if (!prev || Date.parse(prev.t) < t) by.set(r.ticker, r);
  }
  const all = new Set(records.map((r) => r.ticker));
  return { picked: [...by.values()], skipped: [...all].filter((t) => !by.has(t)).length };
}
// `results`: ticker -> { status, result, settlementValue } (ks.normalize's fields). `fee(px)` is the fee on
// one contract bought at px, or 0. Returns the study's numbers.
function grade(picked, results, fee = () => 0) {
  const rows = [];
  let pending = 0, voided = 0, noPrice = 0;
  for (const r of picked) {
    const res = results.get(r.ticker);
    if (!res || res.status !== 'finalized' || !/^(yes|no)$/.test(res.result || '')) { pending++; continue; }
    if (res.settlementValue != null && res.settlementValue !== 0 && res.settlementValue !== 1) { voided++; continue; }
    if (!(r.ask > 0 && r.ask < 1 && r.bid >= 0 && r.bid < r.ask)) { noPrice++; continue; }
    const hit = res.result === 'yes';
    const yesCost = r.ask, noCost = 1 - r.bid;
    rows.push({
      ...r, hit,
      yesPnl: (hit ? 1 - r.ask : -r.ask), yesFee: fee(r.ask), yesCost,
      noPnl: (hit ? -(1 - r.bid) : r.bid), noFee: fee(noCost), noCost,
    });
  }
  const sum = (xs, f) => xs.reduce((a, x) => a + f(x), 0);
  const side = (xs, pnl, feeK, cost) => {
    const c = sum(xs, (x) => x[cost]);
    return { gross: c ? sum(xs, (x) => x[pnl]) / c : null, net: c ? (sum(xs, (x) => x[pnl]) - sum(xs, (x) => x[feeK])) / c : null, cost: c };
  };
  const stats = (xs) => ({
    n: xs.length, hits: xs.filter((x) => x.hit).length,
    hitRate: xs.length ? xs.filter((x) => x.hit).length / xs.length : null,
    meanAsk: xs.length ? sum(xs, (x) => x.ask) / xs.length : null,
    meanSpread: xs.length ? sum(xs, (x) => x.ask - x.bid) / xs.length : null,
    yes: side(xs, 'yesPnl', 'yesFee', 'yesCost'), no: side(xs, 'noPnl', 'noFee', 'noCost'),
  });
  return {
    graded: rows.length, pending, voided, noPrice,
    all: stats(rows),
    bands: BANDS.map(([lo, hi, label]) => ({ label, ...stats(rows.filter((x) => x.ask > lo && x.ask <= hi)) })),
    games: new Set(rows.map((x) => x.event)).size,
  };
}
const pct = (x) => (x == null ? '   n/a' : `${(x * 100) >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`);
function report(g, { day = null, skipped = 0 } = {}) {
  const out = [];
  out.push(`anytime touchdown tape${day ? ` · ${day}` : ''}: ${g.graded} markets graded over ${g.games} game${g.games === 1 ? '' : 's'}` +
    ` (${g.pending} pending, ${g.voided} void, ${g.noPrice} unpriced, ${skipped} with no record in the ${PRE_KICK_MAX_H}h before kickoff)`);
  const line = (label, s) => `  ${label.padEnd(18)} n ${String(s.n).padStart(4)}  scored ${s.hitRate == null ? ' n/a ' : (s.hitRate * 100).toFixed(1) + '%'}` +
    `  mean ask ${s.meanAsk == null ? 'n/a' : (s.meanAsk * 100).toFixed(1) + 'c'}  spread ${s.meanSpread == null ? 'n/a' : (s.meanSpread * 100).toFixed(1) + 'c'}` +
    `  YES at ask ${pct(s.yes.gross)} gross ${pct(s.yes.net)} net  ·  NO at ask ${pct(s.no.gross)} gross ${pct(s.no.net)} net`;
  out.push(line('every market', g.all));
  for (const b of g.bands) if (b.n) out.push(line(b.label, b));
  out.push('  (a fair two-sided board returns about minus half the spread on either side, minus the fee; both sides losing more than that is the hold)');
  return out.join('\n');
}

async function gradeTape({ dir = DIR, day = null } = {}) {
  const records = readTape(dir, day);
  if (!records.length) return `no tape${day ? ` for ${day}` : ''} in ${dir}`;
  const { picked, skipped } = lastBeforeKickoff(records);
  const tickers = picked.map((r) => r.ticker);
  const fresh = await ks.fetchMarketsByTickers(tickers);
  const results = new Map(fresh.map((m) => [m.ticker, m]));
  let fee = () => 0;
  try { await ks.loadFeeMultipliers([SERIES]); fee = (px) => ks.feePerContract(px, FEE_RATE, `${SERIES}-X`); }
  catch { /* no multiplier: net reads as gross and the report says so below */ }
  const g = grade(picked, results, fee);
  return report(g, { day, skipped });
}

// --check, read-only: the last td.log line, the tape's size, PROBLEM if the last run was one.
function check(dir = DIR) {
  const log = path.join(dir, LOG);
  if (!fs.existsSync(log)) return { ok: false, text: `PROBLEM: no ${log} yet -- the tape has not run` };
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  const last = lines[lines.length - 1] || '';
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^td-.*\.jsonl$/.test(f)) : [];
  const ok = !/ PROBLEM /.test(last);
  return { ok, text: `${ok ? 'ok' : 'PROBLEM'}: last run ${last.slice(0, 20)} · ${files.length} day${files.length === 1 ? '' : 's'} on tape · ${last.replace(/^\S+ /, '')}` };
}

module.exports = { parseMarket, teamOf, toRecord, fileFor, logLine, record, readTape, lastBeforeKickoff, grade, report, check, etDay, SERIES, DIR, LOG, RECORD_AHEAD_H, PRE_KICK_MAX_H, GAME_LENGTH_H, BANDS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  (async () => {
    if (has('--grade')) { console.log(await gradeTape({ day: val('--day') })); return; }
    if (has('--check')) { const c = check(); console.log(c.text); process.exit(c.ok ? 0 : 1); }
    const r = await record({ dryRun: has('--dry-run') });
    console.log(r.line);
    if (has('--dry-run') && r.due) for (const m of r.due.slice(0, 8)) console.log(`  ${m.game} ${m.player} (${m.team || '?'}) ${(m.bid * 100).toFixed(0)}/${(m.ask * 100).toFixed(0)}c · kickoff ${m.kickoff}`);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.error(e); process.exit(1); });
}

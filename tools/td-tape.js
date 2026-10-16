'use strict';
// The anytime-touchdown tape: Kalshi's "1+ touchdowns" player markets, recorded in the hours before
// kickoff and graded once the games settle, to measure what a one-sided prop board costs. LOG-ONLY,
// research: no bet, no broker, nothing in the desk reads it, and nothing here can place an order.
//
//   node tools/td-tape.js --record            # append every open 1+ TD market whose game kicks off within
//                                             # RECORD_AHEAD_H and has not kicked off -> data/td/td-YYYY-MM-DD.jsonl
//   node tools/td-tape.js --record --dry-run  # fetch and report, write nothing (ops/install-td-tape.sh uses this)
//   node tools/td-tape.js --grade [--day D]   # the last record before kickoff, per market, against Kalshi's result
//   node tools/td-tape.js --check [--venue]   # read-only: is the tape alive, and did it miss a game? (exit 1 on a
//                                             # PROBLEM; --venue adds one read of Kalshi's open listing)
//   --dir D                                   # any mode: the tape's folder, if not data/td
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
//
// GRADING A VOID (2026-10-15). Kalshi finalizes a voided market as status 'finalized' with result 'scalar'
// (and a settlement value between 0 and 1). The grader used to test for yes/no first, so every void fell
// through to "pending" and stayed there forever. A finalized scalar is now a void before anything else is
// asked of it.
//
// A MISSED GAME (2026-10-15). On 2026-10-15 the Thursday game, SEA at DEN (kickoff 00:15Z on the 16th), has
// no tape: the Mac slept on battery and launchd's 15-minute interval did not fire between 18:23Z and 00:42Z,
// and nothing said so -- --check read only the last td.log line, which was ok. So each --record run now also
// keeps data/td/games.json, every game it has seen in Kalshi's open listing with its kickoff (the listing
// carries the coming week's games, so any run in that week learns a game; a run reads that listing anyway,
// so this costs no request). --check is then offline: every game in that schedule that kicked off in the
// last LOOKBACK_H with no tape line in the PRE_KICK_MAX_H before kickoff (no line at all, or only lines too
// early to grade) is a PROBLEM, one line each. A job that has not run for STALE_H is a PROBLEM too, since a
// game listed and played in that time would never reach the schedule. And a run that comes more than
// GAP_MIN after the last ok one, across a game's recording window, says so in its td.log line ("gap: ...").
//
// ON THE BOX (2026-10-16). The next Thursday it happened again, the check in place: the Mac asleep on battery,
// SEA at DEN unrecorded. So the Fly box runs record() itself, every 15 minutes inside the desk (src/tdsched.js,
// TD_TAPE=1), into /data/td; the hourly pull copies each finished day to data/fly/archive/td/, and the daily
// check runs --check --dir /data/td on the box. The Mac's launchd job, if still installed, is a spare tape.
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
const SCHEDULE = 'games.json';  // every game the listing has shown, event -> { game, kickoff, seen } (see A MISSED GAME)
const SCHEDULE_KEEP_D = 60;     // a game that kicked off longer ago than this leaves the schedule
const GAP_MIN = 30;             // two runs further apart than this, across a game's window, is a gap worth a note
const STALE_H = 24;             // --check: no run for this long is a PROBLEM
const LOOKBACK_H = 48;          // --check: games that kicked off this recently are checked for a tape (a day's
                                // check plus a skipped one; an older miss was flagged then and is not repeated)

const num = (x) => { const n = parseFloat(x); return Number.isFinite(n) ? n : null; };
const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const etDay = (ms) => ET.format(new Date(ms));
const dur = (ms) => { const m = Math.round(ms / 60000); return m >= 60 ? `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m` : `${m}m`; };

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

// ---------------------------------------------------------------- the schedule, the log's tail, a gap
function readSchedule(dir = DIR, io = fs) {
  try { const s = JSON.parse(io.readFileSync(path.join(dir, SCHEDULE), 'utf8')); return s && typeof s === 'object' && !Array.isArray(s) ? s : {}; }
  catch { return {}; }
}
// The old schedule plus every game in `markets` (parsed rows), at the listing's latest kickoff (a flexed game
// moves while it is listed); `seen` is when a run first saw it. Games kicked off over SCHEDULE_KEEP_D ago drop.
function mergeSchedule(prev, markets, now) {
  const out = {};
  const keepFrom = now - SCHEDULE_KEEP_D * 86400e3;
  for (const [e, g] of Object.entries(prev || {})) if (g && Date.parse(g.kickoff) >= keepFrom) out[e] = g;
  for (const m of markets) {
    if (!m.event || !Number.isFinite(Date.parse(m.kickoff))) continue;
    out[m.event] = { game: m.game, kickoff: m.kickoff, seen: (out[m.event] && out[m.event].seen) || new Date(now).toISOString() };
  }
  return out;
}
// The last few td.log lines, read from the end: the log grows by about 100 lines a day and is read every run.
function logTail(dir = DIR, bytes = 8192) {
  let fd;
  try { fd = fs.openSync(path.join(dir, LOG), 'r'); } catch { return []; }
  try {
    const size = fs.fstatSync(fd).size, n = Math.min(bytes, size), b = Buffer.alloc(n);
    fs.readSync(fd, b, 0, n, size - n);
    const lines = b.toString('utf8').split('\n').filter((x) => x.trim());
    if (n < size) lines.shift();   // the first line of a cut read is a partial line
    return lines;
  } finally { fs.closeSync(fd); }
}
const lineTime = (line) => Date.parse(String(line || '').split(' ')[0]);
// "gap: ..." when the last ok run was more than GAP_MIN ago and some game's recording window
// [kickoff - RECORD_AHEAD_H, kickoff) fell in between; '' otherwise (a quiet night's sleep is no gap).
function gapNote(prevMs, now, schedule) {
  if (!Number.isFinite(prevMs) || now - prevMs <= GAP_MIN * 60e3) return '';
  const hit = Object.values(schedule || {}).filter((g) => {
    const k = Date.parse(g.kickoff);
    return k - RECORD_AHEAD_H * 3600e3 < now && k > prevMs;
  }).map((g) => g.game).sort();
  if (!hit.length) return '';
  return `gap: no run for ${dur(now - prevMs)} (since ${new Date(prevMs).toISOString().slice(0, 16)}Z), across the window of ${hit.join(', ')}`;
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
  const schedule = mergeSchedule(readSchedule(dir, io), all, now);
  const prevOk = logTail(dir).filter((l) => / ok td-tape: /.test(l)).pop();
  const gap = gapNote(lineTime(prevOk), now, schedule);
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
      // whole-file replace by rename, so a run killed mid-write leaves the old schedule, never half of one
      const sf = path.join(dir, SCHEDULE);
      io.writeFileSync(sf + '.tmp', JSON.stringify(schedule) + '\n');
      io.renameSync(sf + '.tmp', sf);
    } catch (e) { ok = false; note = `write failed: ${String(e.message).slice(0, 80)}`; }
  }
  const games = new Set(due.map((m) => m.event)).size;
  note = [dryRun ? `dry run, ${due.length} would be written` : note, gap].filter(Boolean).join(' · ');
  const line = logLine(now, { ok, recorded: dryRun ? 0 : due.length, games, open: all.length, note });
  if (!dryRun) { try { io.appendFileSync(path.join(dir, LOG), line + '\n'); } catch { /* the log is a courtesy; the tape is the record */ } }
  return { ok, line, recorded: dryRun ? 0 : due.length, due, files: [...byFile.keys()], schedule, gap };
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
    if (!res || res.status !== 'finalized') { pending++; continue; }
    // void before yes/no: Kalshi finalizes a void as result 'scalar' (see GRADING A VOID)
    if (res.result === 'scalar' || (res.settlementValue != null && res.settlementValue !== 0 && res.settlementValue !== 1)) { voided++; continue; }
    if (!/^(yes|no)$/.test(res.result || '')) { pending++; continue; }
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
function report(g, { day = null, skipped = 0, note = '' } = {}) {
  const out = [];
  out.push(`anytime touchdown tape${day ? ` · ${day}` : ''}: ${g.graded} markets graded over ${g.games} game${g.games === 1 ? '' : 's'}` +
    ` (${g.pending} pending, ${g.voided} void, ${g.noPrice} unpriced, ${skipped} with no record in the ${PRE_KICK_MAX_H}h before kickoff)`);
  const line = (label, s) => `  ${label.padEnd(18)} n ${String(s.n).padStart(4)}  scored ${s.hitRate == null ? ' n/a ' : (s.hitRate * 100).toFixed(1) + '%'}` +
    `  mean ask ${s.meanAsk == null ? 'n/a' : (s.meanAsk * 100).toFixed(1) + 'c'}  spread ${s.meanSpread == null ? 'n/a' : (s.meanSpread * 100).toFixed(1) + 'c'}` +
    `  YES at ask ${pct(s.yes.gross)} gross ${pct(s.yes.net)} net  ·  NO at ask ${pct(s.no.gross)} gross ${pct(s.no.net)} net`;
  out.push(line('every market', g.all));
  for (const b of g.bands) if (b.n) out.push(line(b.label, b));
  out.push('  (a fair two-sided board returns about minus half the spread on either side, minus the fee; both sides losing more than that is the hold)');
  if (note) out.push(`  ${note}`);
  return out.join('\n');
}

async function gradeTape({ dir = DIR, day = null } = {}) {
  const records = readTape(dir, day);
  if (!records.length) return `no tape${day ? ` for ${day}` : ''} in ${dir}`;
  const { picked, skipped } = lastBeforeKickoff(records);
  const tickers = picked.map((r) => r.ticker);
  const fresh = await ks.fetchMarketsByTickers(tickers);
  const results = new Map(fresh.map((m) => [m.ticker, m]));
  // ks.loadFeeMultipliers never throws: a refused lookup leaves the series out, and feePerContract then bills
  // the full rate. Until 2026-10-15 that happened silently (this comment said it was reported); now the report
  // says so in one line, since "net" is then the most the series could cost, not what it does.
  let note = '';
  try {
    const mults = await ks.loadFeeMultipliers([SERIES]);
    if (!(mults && mults.has(SERIES))) note = `fee: Kalshi's ${SERIES} fee multiplier did not load, so "net" charges the full ${Math.round(FEE_RATE * 100)}% rate`;
  } catch (e) { note = `fee: the multiplier lookup failed (${String(e.message).slice(0, 60)}), so "net" charges the full ${Math.round(FEE_RATE * 100)}% rate`; }
  const fee = (px) => ks.feePerContract(px, FEE_RATE, `${SERIES}-X`);
  const g = grade(picked, results, fee);
  return report(g, { day, skipped, note });
}

// The games in `schedule` that kicked off in the LOOKBACK_H before `now` with no tape line in the
// PRE_KICK_MAX_H before kickoff (the grader's own test of a usable record): each with how many lines it has.
function missedGames(dir, schedule, now) {
  const out = [], days = new Map();
  for (const [event, g] of Object.entries(schedule || {})) {
    const k = Date.parse(g.kickoff);
    if (!(k <= now && now - k <= LOOKBACK_H * 3600e3)) continue;
    const day = etDay(k);
    if (!days.has(day)) days.set(day, readTape(dir, day));
    const lines = days.get(day).filter((r) => r.event === event);
    if (lines.some((r) => { const t = Date.parse(r.t); return t < k && k - t <= PRE_KICK_MAX_H * 3600e3; })) continue;
    out.push({ event, game: g.game, kickoff: g.kickoff, day, lines: lines.length });
  }
  return out.sort((x, y) => Date.parse(x.kickoff) - Date.parse(y.kickoff));
}

// --check, read-only: the last td.log line, how long ago it was, and every game the schedule says kicked off
// lately with no usable tape. `listing` (Kalshi's raw open rows, --venue) adds games the schedule lacks.
// PROBLEM, and ok false, on any of the three. The first line sums up; a missed game gets a line of its own.
function check(dir = DIR, { now = Date.now(), listing = null } = {}) {
  const tail = logTail(dir);
  if (!tail.length) return { ok: false, text: `PROBLEM: no ${path.join(dir, LOG)} yet -- the tape has not run`, missed: [] };
  const last = tail[tail.length - 1];
  const lastT = lineTime(last);
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^td-.*\.jsonl$/.test(f)) : [];
  const problems = [];
  if (/ PROBLEM /.test(last)) problems.push('the last run was a PROBLEM');
  if (!Number.isFinite(lastT) || now - lastT > STALE_H * 3600e3) {
    problems.push(`no run for ${Number.isFinite(lastT) ? dur(now - lastT) : 'an unknown time'}: the job is not firing (on the box: TD_TAPE=1 in fly.toml, src/tdsched.js; on the Mac: launchctl list | grep tdtape), and a game listed and played meanwhile never reaches the schedule`);
  }
  let schedule = readSchedule(dir);
  const fromFile = Object.keys(schedule).length;
  if (listing) schedule = mergeSchedule(schedule, listing.map(parseMarket).filter(Boolean), now);
  const missed = missedGames(dir, schedule, now);
  if (missed.length) problems.push(`${missed.length} game${missed.length === 1 ? '' : 's'} kicked off in the last ${LOOKBACK_H}h with no usable tape`);
  const kicked = Object.values(schedule).filter((g) => { const k = Date.parse(g.kickoff); return k <= now && now - k <= LOOKBACK_H * 3600e3; }).length;
  const sched = !fromFile && !listing ? `no schedule yet (${SCHEDULE} comes with the next --record run), so a missed game cannot be named`
    : `${kicked} game${kicked === 1 ? '' : 's'} kicked off in the last ${LOOKBACK_H}h${missed.length ? '' : ', each on tape'}`;
  const ok = !problems.length;
  const lines = [`${ok ? 'ok' : `PROBLEM (${problems.join('; ')})`}: last run ${Number.isFinite(lastT) ? `${new Date(lastT).toISOString().slice(0, 19)}Z` : last.slice(0, 20)} · ${files.length} day${files.length === 1 ? '' : 's'} on tape · ${sched} · ${last.replace(/^\S+ /, '')}`];
  for (const m of missed) {
    lines.push(`  PROBLEM: ${m.game} (${m.event}) kicked off ${m.kickoff.slice(0, 16)}Z with ${m.lines ? `${m.lines} line${m.lines === 1 ? '' : 's'} in td-${m.day}.jsonl, none in the ${PRE_KICK_MAX_H}h before kickoff` : `no line in td-${m.day}.jsonl`}: its board was not recorded, and cannot be now`);
  }
  return { ok, text: lines.join('\n'), missed };
}

module.exports = { parseMarket, teamOf, toRecord, fileFor, logLine, record, readTape, lastBeforeKickoff, grade, report, gradeTape, check, missedGames,
  readSchedule, mergeSchedule, gapNote, logTail, etDay, SERIES, DIR, LOG, SCHEDULE, RECORD_AHEAD_H, PRE_KICK_MAX_H, GAME_LENGTH_H, GAP_MIN, STALE_H, LOOKBACK_H, BANDS };

if (require.main === module) {
  const args = process.argv.slice(2);
  const has = (f) => args.includes(f);
  const val = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
  (async () => {
    const dir = val('--dir') ? path.resolve(val('--dir')) : DIR;
    if (has('--grade')) { console.log(await gradeTape({ dir, day: val('--day') })); return; }
    if (has('--check')) {
      // --venue: one read of the open listing's first page, the request --record makes every 15 minutes
      let listing = null;
      if (has('--venue')) {
        try { listing = ((await http.getJSON(`${ks.BASE}/markets?series_ticker=${SERIES}&status=open&limit=1000`)) || {}).markets || []; }
        catch (e) { console.log(`(Kalshi's listing did not load: ${String(e.message).slice(0, 80)}; checked offline)`); }
      }
      const c = check(dir, { listing });
      console.log(c.text);
      process.exit(c.ok ? 0 : 1);
    }
    const r = await record({ dir, dryRun: has('--dry-run') });
    console.log(r.line);
    if (has('--dry-run') && r.due) for (const m of r.due.slice(0, 8)) console.log(`  ${m.game} ${m.player} (${m.team || '?'}) ${(m.bid * 100).toFixed(0)}/${(m.ask * 100).toFixed(0)}c · kickoff ${m.kickoff}`);
    process.exit(r.ok ? 0 : 1);
  })().catch((e) => { console.error(e); process.exit(1); });
}

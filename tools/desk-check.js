'use strict';
// Step 8 of the daily check (ops/daily-check.sh): the stocks, crypto and options desk (src/desk/).
// Four questions, one screen:
//
//   ALIVE   is its loop still running? It records the books' value once a minute; a state whose
//           newest minute is old is a desk that stopped, or one that could not save it (a journal
//           newer than the state, a 'state save failed' line, the box's disk nearly full: 2026-10-15)
//   TODAY   did each book do today's check? Crypto once a UTC day, SPY once a trading day after the
//           open, the options book's 12:30 verdict, the scalp and dip books watching from 10:05, the
//           runner book's scan every 3 minutes -- a book that skipped its day is a book that could not
//           get prices or could not decide
//   LEDGER  does the state add up? Every fill and settlement in the journal is replayed, with the
//           engine's own rounding, and each book's cash, holdings, realised P&L and fees must come out
//           to the penny of what state.json says
//   BOOKS   what has each book made, against simply holding what it trades
//
//   node tools/desk-check.js --box      the Fly box: /data/desk/state.json and its journals are copied
//                                       into data/fly/desk-now/ (replaced each run), then checked
//   node tools/desk-check.js            the desk on this Mac: data/desk/
//   node tools/desk-check.js --dir D    any folder holding a desk's state.json and journal-*.jsonl
//
// Read-only on the box: `fly ssh console` to list /data/desk and read /data's free space (one call),
// and `fly ssh sftp get` to copy, nothing
// else. It reads no secret and cannot place an order (the desk has no broker to place one with).
// Exit code 1 on any PROBLEM, so the daily check counts it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const clock = require('../src/desk/clock');
const { stateTime } = require('../src/desk/engine');

const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const JOURNAL = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MIN = 60000;
const short = (id) => String(id).replace(/-USD$/, '');
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const OPTION_BOOKS = ['options', 'scalps', 'dips'];
// free space on the box's /data under which the check says so: the state alone is a few MB, rewritten whole
const LOW_DISK_MB = 200;

// ---------------------------------------------------------------- reading
function readDesk(dir) {
  let state = null;
  try { state = JSON.parse(fs.readFileSync(path.join(dir, 'state.json'), 'utf8')); } catch (e) { state = { error: e.message }; }
  const days = [];
  const events = [];
  let torn = 0;
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => JOURNAL.test(n)).sort(); } catch { /* no journals */ }
  for (const n of names) {
    days.push(JOURNAL.exec(n)[1]);
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { torn++; }
    }
  }
  events.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { state, events, days, torn };
}

// stateTime, the newest moment the state vouches for, is the engine's own (src/desk/engine.js): it also
// reads it on start, to put back fills the journal has and the saved state lost.

// The newest line the desk's loop wrote to its journal: a fill, a check, a verdict. The watchdog's line and
// the process's comings and goings are not the loop's work, so they do not count.
function journalTime(events) {
  let t = 0;
  for (const e of events || []) if (e.kind !== 'WATCHDOG' && e.kind !== 'START' && e.kind !== 'STOP' && e.kind !== 'CRASH') t = Math.max(t, Date.parse(e.t) || 0);
  return t;
}

// ---------------------------------------------------------------- pure: the rebuild
// Each book's cash, holdings, realised P&L and fees from the journal alone, rounded exactly where
// the engine rounds (src/desk/engine.js kett, kettOption, settleLot), so the two agree to the penny
// and a drift of one cent is a real one. Starting cash is each sleeve's own `initial` in the state.
function rebuild(events, S, { until = Infinity } = {}) {
  const B = S.books || {};
  const sleeves = {};
  for (const key of ['crypto', 'stocks']) {
    for (const [sym, sl] of Object.entries((B[key] && B[key].sleeves) || {})) sleeves[`${key}:${sym}`] = { cash: sl.initial, qty: 0, realized: 0, fees: 0 };
  }
  // the two books of option contracts, each from its own starting cash
  const lots = {};
  for (const key of OPTION_BOOKS) if (B[key]) lots[key] = { cash: B[key].initial || 0, realized: 0, fees: 0, open: 0 };
  // the runner book: coins, a holding per coin
  const runners = B.runners ? { cash: B.runners.initial || 0, realized: 0, fees: 0, qty: {} } : null;
  let fills = 0, unknown = 0;
  for (const e of events) {
    if (Date.parse(e.t) > until) continue;
    if (e.kind === 'FILL' && e.book === 'runners' && runners) {
      fills++;
      runners.cash = r2(runners.cash + e.cash); runners.fees = r2(runners.fees + (e.fee || 0));
      const q = runners.qty[e.sym] || 0;
      if (e.side === 'buy') runners.qty[e.sym] = r6(q + e.qty);
      else { runners.qty[e.sym] = r6(Math.max(0, q - e.qty)); runners.realized = r2(runners.realized + (e.pnl || 0)); }
      continue;
    }
    const o = lots[e.book];
    if (e.kind === 'SETTLE' && o) {
      const cash = r2(e.value * 100 * e.qty);
      o.cash = r2(o.cash + cash); o.realized = r2(o.realized + e.pnl); o.open -= e.qty;
      fills++;
      continue;
    }
    if (e.kind !== 'FILL') continue;
    fills++;
    if (o) {
      o.cash = r2(o.cash + e.cash); o.fees = r2(o.fees + (e.fee || 0));
      if (e.side === 'buy') o.open += e.qty;
      else { o.open -= e.qty; o.realized = r2(o.realized + (e.pnl || 0)); }
      continue;
    }
    const sl = sleeves[`${e.book}:${e.sym}`];
    if (!sl) { unknown++; continue; }
    sl.cash = r2(sl.cash + e.cash);
    if (e.side === 'buy') sl.qty = r6(sl.qty + e.qty);
    else {
      const q = Math.min(e.qty, sl.qty);
      sl.realized = r2(sl.realized + (e.pnl || 0));
      sl.qty = r6(Math.max(0, sl.qty - q));
      if (sl.qty < 1e-6) sl.qty = 0;
    }
    sl.fees = r2(sl.fees + (e.fee || 0));
  }
  return { sleeves, ...lots, runners, fills, unknown };
}

// Every difference between the rebuild and the state, as sentences.
function compare(built, S) {
  const problems = [];
  const cent = (a, b) => Math.abs(a - b) > 0.005;
  for (const key of ['crypto', 'stocks']) {
    for (const [sym, sl] of Object.entries((S.books[key] && S.books[key].sleeves) || {})) {
      const b = built.sleeves[`${key}:${sym}`];
      const name = `${key} ${short(sym)}`;
      if (cent(b.cash, sl.cash)) problems.push(`${name}: cash ${money(sl.cash)} in the state, ${money(b.cash)} by the journal`);
      if (Math.abs(b.qty - sl.qty) > 1e-6) problems.push(`${name}: holds ${sl.qty} in the state, ${b.qty} by the journal`);
      if (cent(b.realized, sl.realized)) problems.push(`${name}: realised ${money(sl.realized)} in the state, ${money(b.realized)} by the journal`);
      if (cent(b.fees, sl.fees)) problems.push(`${name}: fees ${money(sl.fees)} in the state, ${money(b.fees)} by the journal`);
    }
  }
  for (const key of OPTION_BOOKS) {
    const o = S.books[key], bo = built[key];
    if (!o || !bo) continue;
    const open = (o.lots || []).reduce((a, l) => a + (l.qty || 0), 0);
    if (cent(bo.cash, o.cash)) problems.push(`${key}: cash ${money(o.cash)} in the state, ${money(bo.cash)} by the journal`);
    if (cent(bo.realized, o.realized)) problems.push(`${key}: realised ${money(o.realized)} in the state, ${money(bo.realized)} by the journal`);
    if (cent(bo.fees, o.fees)) problems.push(`${key}: fees ${money(o.fees)} in the state, ${money(bo.fees)} by the journal`);
    if (bo.open !== open) problems.push(`${key}: ${open} contract(s) held in the state, ${bo.open} by the journal`);
  }
  const rn = S.books.runners, br = built.runners;
  if (rn && br) {
    if (cent(br.cash, rn.cash)) problems.push(`runners: cash ${money(rn.cash)} in the state, ${money(br.cash)} by the journal`);
    if (cent(br.realized, rn.realized)) problems.push(`runners: realised ${money(rn.realized)} in the state, ${money(br.realized)} by the journal`);
    if (cent(br.fees, rn.fees)) problems.push(`runners: fees ${money(rn.fees)} in the state, ${money(br.fees)} by the journal`);
    const held = {};
    for (const l of rn.lots || []) held[l.sym] = r6((held[l.sym] || 0) + l.qty);
    for (const sym of new Set([...Object.keys(held), ...Object.keys(br.qty)])) {
      if (Math.abs((held[sym] || 0) - (br.qty[sym] || 0)) > 1e-6) problems.push(`runners ${short(sym)}: holds ${held[sym] || 0} in the state, ${br.qty[sym] || 0} by the journal`);
    }
  }
  if (built.unknown) problems.push(`${built.unknown} journal fill(s) name a book or coin the state does not have`);
  return problems;
}

// ---------------------------------------------------------------- pure: alive, and today's checks
// `now` is injected so the tests can stand anywhere in the week. `journalAt` is the newest line the loop
// journaled (journalTime) and `freeMb` the free space on the box's /data (--box only), for telling a loop
// that stopped from a state that could not be saved.
function health(S, now, { journalAt = 0, freeMb = null } = {}) {
  const problems = [], lines = [], notes = [];
  const h = S.history || [];
  const last = h.length ? h[h.length - 1].t : null;
  const young = now - (S.startedAt || 0) < 30 * MIN;           // a desk this new has not had a day yet
  if (last == null) {
    if (young) lines.push('started minutes ago: no minute recorded yet'); else problems.push('the desk has never recorded a minute');
  } else {
    const age = Math.round((now - last) / MIN);
    // On 2026-10-15 the box's disk filled: the loop ran on, its journal lines went in, and state.json could
    // not be written, and this said "the loop has stopped". A journal newer than the state's last minute, a
    // 'state save failed' line, or a disk nearly full says which it is.
    const saveFailed = (S.log || []).some((l) => l.t >= last && /state save failed/.test(l.text || ''));
    const lowDisk = freeMb != null && freeMb < LOW_DISK_MB;
    // and since then a minute is not recorded while a slot has no price (src/desk/engine.js priced): a loop
    // running after a restart, waiting on one feed, says so in the log it saves
    const unpriced = (S.log || []).find((l) => l.t >= last && /^no price yet for/.test(l.text || ''));
    if (now - last > 10 * MIN && unpriced) problems.push(`no round recorded for ${age} minutes, but the desk is running: ${unpriced.agent}: ${unpriced.text}`);
    else if (now - last > 10 * MIN && (journalAt > last + MIN || saveFailed || lowDisk)) {
      const why = [journalAt > last + MIN ? `its journal has a line from ${Math.round((now - journalAt) / MIN)} min ago` : null, saveFailed ? "its log says 'state save failed'" : null, lowDisk ? `the box has ${freeMb} MB free on /data` : null].filter(Boolean);
      problems.push(`the state has not been saved for ${age} minutes, but the desk did not stop: ${why.join(', ')}. state.json could not be written (disk full? df -m /data on the box); a restart now would load the old state`);
    } else if (now - last > 10 * MIN) problems.push(`no round recorded for ${age} minutes: the desk's loop has stopped (fly logs | grep " desk ")`);
    else lines.push(`last round recorded ${age < 1 ? 'under a minute' : `${age} min`} ago`);
  }
  if (freeMb != null) {
    if (freeMb < LOW_DISK_MB) problems.push(`the box has ${freeMb} MB free on /data (under ${LOW_DISK_MB}): the desk's 3 MB state saves fail on a full disk, and fills wait for the journal`);
    else lines.push(`the box has ${freeMb} MB free on /data`);
  }
  // crypto: every sleeve checked on today's UTC day once it is 00:30 UTC
  const B = S.books || {};
  const uday = utcDay(now), umin = new Date(now).getUTCHours() * 60 + new Date(now).getUTCMinutes();
  const coins = Object.entries((B.crypto && B.crypto.sleeves) || {});
  const behind = coins.filter(([, sl]) => sl.checkDay !== uday).map(([id]) => short(id));
  if (!behind.length) lines.push(`crypto checked ${uday} (UTC): ${coins.map(([id, sl]) => `${short(id)} ${Math.round((sl.target || 0) * 100)}%`).join(', ')}`);
  else if (umin >= 30 && !young) problems.push(`crypto: ${behind.join(', ')} not checked today (${uday} UTC): no fresh Coinbase prices, or no daily candle for yesterday`);
  else lines.push(`crypto: today's check is due after midnight UTC (${behind.join(', ')} last checked ${coins.map(([, sl]) => sl.checkDay || 'never')[0]})`);
  // SPY: checked on a trading day once the late tape has shown the open (about 9:50 ET; flagged from 10:15)
  const e = clock.et(now), sess = clock.session(e.day);
  const spy = ((B.stocks && B.stocks.sleeves) || {}).SPY;
  if (spy) {
    if (spy.checkDay === e.day) lines.push(`SPY checked today: ${Math.round((spy.target || 0) * 100)}%`);
    else if (sess && e.min >= 10 * 60 + 15 && !young) problems.push(`SPY: not checked today (${e.day}): the Cboe quote did not reach the desk after the open`);
    else lines.push(`SPY: next check after the ${sess && e.min < sess.open ? 'open today' : 'next open'} (last ${spy.checkDay || 'never'})`);
  }
  // The options, scalp, dip and runner books were retired on 2026-10-17 (switched off since 10-08): nothing of
  // theirs runs to check. Until then this asked each for its 12:30 verdict, its morning watch, its scan every three
  // minutes and its contracts out by 3:15. Their ledgers are still replayed to the penny (rebuild, above).
  const retired = ['options', 'scalps', 'dips', 'runners'].filter((k) => B[k]);
  if (retired.length) lines.push(`${retired.join(', ')}: retired, holding nothing`);
  for (const k of retired) if ((B[k].lots || []).length) problems.push(`${k}: retired but holding ${B[k].lots.length}: the engine no longer marks or sells them`);
  // what the bots flagged in the last day, most recent first, each wording once
  const since = now - 24 * 3600000, seen = new Set();
  for (const l of S.log || []) {
    if (l.t < since) break;
    const bad = l.kind === 'HALT' || /did not load|failed|not filled|stalled|stale|out of step/i.test(l.text || '');
    if (!bad) continue;
    const key = String(l.text).replace(/[\d.,$%]+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    if (/desk round failed|journal write failed|state save failed/.test(l.text)) problems.push(`${l.agent}: ${l.text}`);
    else notes.push(`${new Date(l.t).toISOString().slice(5, 16).replace('T', ' ')}Z ${l.agent}: ${l.text}`);
  }
  return { problems, lines, notes };
}

// ---------------------------------------------------------------- pure: entries the chain's timing refused
// A book skips an entry whose option chain is not from the trigger bar's moment (OPTIONS_SKIP, SCALP_SKIP, DIP_SKIP), and
// should: a fill at a price from another minute is not the rule. A few a week is the Cboe files drifting; three or more in
// a day is a feed that is out of step, and on 2026-10-01 it cost 8 skips against 3 fills while the check only said "out of
// step" under NOTES. Returns the problem text, or null.
function skips(events, now) {
  const since = now - 24 * 3600000, n = {};
  for (const ev of events || []) {
    if (!/^(OPTIONS|SCALP|DIP)_SKIP$/.test(ev.kind || '') || !(Date.parse(ev.t) >= since)) continue;
    const book = ev.kind.split('_')[0].toLowerCase();
    n[book] = (n[book] || 0) + 1;
  }
  const total = Object.values(n).reduce((a, b) => a + b, 0);
  return total >= 3 ? `${total} entries skipped in the last 24h because the option chain was out of step with the bars (${Object.entries(n).map(([k, v]) => `${k} ${v}`).join(', ')}): the Cboe files are lagging, and trades are being lost to it` : null;
}

// ---------------------------------------------------------------- pure: what each book made
// From the newest minute the desk recorded: each book's value, and holding's (the engine records a
// book that has not traded yet at its own value, so its "holding" is flat until it does). Holding paid
// the book's fee to buy in (since 2026-09-26), which the line says beside it.
function bookLines(S) {
  const h = S.history || [], p = h[h.length - 1], B = S.books || {};
  if (!p) return ['no minute recorded yet'];
  const sleeves = (key) => Object.values((B[key] && B[key].sleeves) || {});
  const traded = (key) => sleeves(key).some((sl) => sl.benchPx > 0);
  const banked = (key) => r2(sleeves(key).reduce((a, sl) => a + (sl.realized || 0), 0));
  const fees = (key) => r2(sleeves(key).reduce((a, sl) => a + (sl.fees || 0), 0));
  const holdFee = (key) => r2(sleeves(key).reduce((a, sl) => { const k = (sl.benchFeeBps || 0) / 10000; return a + (sl.benchPx > 0 ? sl.initial * k / (1 + k) : 0); }, 0));
  const holding = (key, v, initial) => `holding would be ${signed(r2(v - initial))}${holdFee(key) > 0 ? ` after its ${money(holdFee(key))} fee to buy in` : ''}`;
  const row = (name, value, initial, extra) => `${name.padEnd(8)}${money(value).padStart(12)}  ${signed(r2(value - initial)).padStart(10)}  ${extra}`;
  const out = [];
  const c = B.crypto, s = B.stocks, o = B.options;
  if (c) out.push(row('crypto', p.c, c.initial, traded('crypto') ? `${holding('crypto', p.bc, c.initial)} · banked ${signed(banked('crypto'))} · fees ${money(fees('crypto'))}` : 'not traded yet'));
  if (s) out.push(row('stocks', p.s, s.initial, traded('stocks') ? `${holding('stocks', p.bs, s.initial)} · banked ${signed(banked('stocks'))} · fees ${money(fees('stocks'))}` : 'not traded yet'));
  if (o) {
    const done = (o.trades || []).filter((t) => !t.open);
    const won = done.filter((t) => t.pnl > 0).length;
    out.push(row('options', p.o, o.initial, `${done.length} trade${done.length === 1 ? '' : 's'} closed (${won} made money) · banked ${signed(o.realized || 0)} · fees ${money(o.fees || 0)}`));
  }
  for (const [key, field] of [['scalps', 'x'], ['dips', 'dp']]) {
    const x = B[key];
    if (!x) continue;
    const done = (x.trades || []).filter((t) => !t.open);
    const won = done.filter((t) => t.pnl > 0).length;
    // a minute from before the book joined the desk has no value for it: its cash, untouched
    out.push(row(key, p[field] ?? x.initial, x.initial, `${done.length} trade${done.length === 1 ? '' : 's'} closed (${won} made money) · banked ${signed(x.realized || 0)} · fees ${money(x.fees || 0)}`));
  }
  if (B.runners) {
    const x = B.runners, done = (x.trades || []).filter((t) => !t.open), won = done.filter((t) => t.pnl > 0).length;
    out.push(row('runners', p.rn ?? x.initial, x.initial, `${done.length} trade${done.length === 1 ? '' : 's'} closed (${won} made money) · holding ${(x.lots || []).length} · banked ${signed(x.realized || 0)} · fees ${money(x.fees || 0)}`));
  }
  const init = Object.values(B).reduce((a, b) => a + (b && Number.isFinite(b.initial) ? b.initial : 0), 0);
  out.push(row('desk', p.e, init, `as of ${new Date(p.t).toISOString().slice(0, 16).replace('T', ' ')}Z`));
  return out;
}

// ---------------------------------------------------------------- the box
// Copies /data/desk/state.json and every journal there into `dest`, replacing the last run's copies.
// The desk's journals are a few kilobytes a day, so all of them come down every time.
// The one console call lists /data/desk and reads /data's free space with it (df -P: one line per disk, the
// fourth field free 1 MB blocks), so the check sees a full disk without a second round trip.
function parseListing(out) {
  const rows = String(out || '').split('\n').map((x) => x.trim());
  const names = rows.filter((n) => n === 'state.json' || JOURNAL.test(n));
  const df = rows.map((r) => r.split(/\s+/)).find((f) => f.length >= 6 && f[f.length - 1] === '/data' && /^\d+$/.test(f[3]));
  return { names, freeMb: df ? Number(df[3]) : null };
}
function pullDesk(app, dest, log) {
  const fly = process.env.FLY_BIN || (fs.existsSync(path.join(process.env.HOME || '', '.fly', 'bin', 'fly')) ? path.join(process.env.HOME, '.fly', 'bin', 'fly') : 'fly');
  const listing = execFileSync(fly, ['ssh', 'console', '-q', '-a', app, '-C', "sh -c 'ls /data/desk; df -Pm /data'"], { encoding: 'utf8', timeout: 120000 });
  const { names: want, freeMb } = parseListing(listing);
  if (!want.includes('state.json')) throw new Error('the box has no /data/desk/state.json: is DESK on in fly.toml?');
  fs.mkdirSync(dest, { recursive: true });
  for (const n of fs.readdirSync(dest)) if (n === 'state.json' || JOURNAL.test(n)) fs.unlinkSync(path.join(dest, n));
  for (const name of want) execFileSync(fly, ['ssh', 'sftp', 'get', '-q', '-a', app, `/data/desk/${name}`, path.join(dest, name)], { stdio: 'ignore', timeout: 300000 });
  log(`box     copied /data/desk: state.json and ${want.length - 1} journal(s) into ${path.relative(path.join(__dirname, '..'), dest)}`);
  return { dir: dest, freeMb };
}

// ---------------------------------------------------------------- main
function run(argv, { log = console.log, now = Date.now() } = {}) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] || true) : null; };
  const root = path.join(__dirname, '..');
  let dir = flag('dir') || path.join(root, 'data', 'desk'), freeMb = null;
  if (argv.includes('--box')) {
    try { ({ dir, freeMb } = pullDesk(flag('app') || 'hexagon-desk', path.join(root, 'data', 'fly', 'desk-now'), log)); }
    catch (e) { log(`PROBLEM could not copy the desk from the box: ${String(e.message).split('\n')[0].slice(0, 160)}`); return 1; }
  }
  const { state: S, events, days, torn } = readDesk(dir);
  if (!S || S.error || !S.books) { log(`PROBLEM no desk state in ${dir}${S && S.error ? ` (${S.error.slice(0, 80)})` : ''}`); return 1; }
  const until = stateTime(S);
  const built = rebuild(events, S, { until });
  const ledger = compare(built, S);
  const hl = health(S, now, { journalAt: journalTime(events), freeMb });
  const skipped = skips(events, now);
  if (skipped) hl.problems.push(skipped);
  log(`desk    state as of ${new Date(until).toISOString().slice(0, 19)}Z · journals ${days[0] || '?'} → ${days[days.length - 1] || '?'} · ${built.fills} fill(s) replayed${torn ? ` · ${torn} torn line(s) skipped` : ''}`);
  for (const l of hl.lines) log(`TODAY   ${l}`);
  if (ledger.length) { log(`LEDGER  ${ledger.length} PROBLEM(S): the state does not match the journal`); for (const p of ledger) log(`  ${p}`); }
  else log("LEDGER  OK: every book's cash, holdings, realised P&L and fees are what the journal says");
  const bl = bookLines(S);
  log(`BOOKS   ${bl[0]}`);
  for (const l of bl.slice(1)) log(`        ${l}`);
  if (hl.notes.length) { log(`NOTES   what the bots flagged in the last 24h (each wording once, newest first):`); for (const n of hl.notes.slice(0, 6)) log(`  ${n}`); }
  if (hl.problems.length) { log(`\n${hl.problems.length} PROBLEM(S) with the desk itself:`); for (const p of hl.problems) log(`  ${p}`); }
  return ledger.length || hl.problems.length ? 1 : 0;
}

module.exports = { readDesk, stateTime, journalTime, parseListing, rebuild, compare, health, bookLines, skips, run, LOW_DISK_MB };

if (require.main === module) process.exitCode = run(process.argv.slice(2));

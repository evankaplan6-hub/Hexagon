'use strict';
// Step 8 of the daily check (ops/daily-check.sh): the stocks, crypto and options desk (src/desk/).
// Four questions, one screen:
//
//   ALIVE   is its loop still running? It records the books' value once a minute; a state whose
//           newest minute is old is a desk that stopped
//   TODAY   did each book do today's check? Crypto once a UTC day, SPY once a trading day after the
//           open, the options book's 12:30 verdict -- a book that skipped its day is a book that
//           could not get prices or could not decide
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
// Read-only on the box: `fly ssh console` to list /data/desk and `fly ssh sftp get` to copy, nothing
// else. It reads no secret and cannot place an order (the desk has no broker to place one with).
// Exit code 1 on any PROBLEM, so the daily check counts it.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const clock = require('../src/desk/clock');

const r2 = (x) => Math.round(x * 100) / 100;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (x) => `${x >= 0 ? '+' : '-'}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const JOURNAL = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/;
const MIN = 60000;
const short = (id) => String(id).replace(/-USD$/, '');
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);

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

// The newest moment the state vouches for. Every fill is saved the instant it happens
// (src/desk/engine.js pushFill), the minute's value on the next save.
function stateTime(S) {
  const h = S.history || [], f = S.fills || [];
  return Math.max(h.length ? h[h.length - 1].t : 0, f.length ? f[0].at : 0, S.startedAt || 0);
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
  const o = { cash: (B.options && B.options.initial) || 0, realized: 0, fees: 0, open: 0 };
  let fills = 0, unknown = 0;
  for (const e of events) {
    if (Date.parse(e.t) > until) continue;
    if (e.kind === 'SETTLE' && e.book === 'options') {
      const cash = r2(e.value * 100 * e.qty);
      o.cash = r2(o.cash + cash); o.realized = r2(o.realized + e.pnl); o.open -= e.qty;
      fills++;
      continue;
    }
    if (e.kind !== 'FILL') continue;
    fills++;
    if (e.book === 'options') {
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
  return { sleeves, options: o, fills, unknown };
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
  const o = S.books.options || {}, bo = built.options;
  const open = (o.lots || []).reduce((a, l) => a + (l.qty || 0), 0);
  if (cent(bo.cash, o.cash)) problems.push(`options: cash ${money(o.cash)} in the state, ${money(bo.cash)} by the journal`);
  if (cent(bo.realized, o.realized)) problems.push(`options: realised ${money(o.realized)} in the state, ${money(bo.realized)} by the journal`);
  if (cent(bo.fees, o.fees)) problems.push(`options: fees ${money(o.fees)} in the state, ${money(bo.fees)} by the journal`);
  if (bo.open !== open) problems.push(`options: ${open} contract(s) held in the state, ${bo.open} by the journal`);
  if (built.unknown) problems.push(`${built.unknown} journal fill(s) name a book or coin the state does not have`);
  return problems;
}

// ---------------------------------------------------------------- pure: alive, and today's checks
// `now` is injected so the tests can stand anywhere in the week.
function health(S, now) {
  const problems = [], lines = [], notes = [];
  const h = S.history || [];
  const last = h.length ? h[h.length - 1].t : null;
  const young = now - (S.startedAt || 0) < 30 * MIN;           // a desk this new has not had a day yet
  if (last == null) {
    if (young) lines.push('started minutes ago: no minute recorded yet'); else problems.push('the desk has never recorded a minute');
  } else {
    const age = Math.round((now - last) / MIN);
    if (now - last > 10 * MIN) problems.push(`no round recorded for ${age} minutes: the desk's loop has stopped (fly logs | grep " desk ")`);
    else lines.push(`last round recorded ${age < 1 ? 'under a minute' : `${age} min`} ago`);
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
  // the options book: a 12:30 verdict by 1:00 ET on a trading day with a normal close, and nothing
  // still held once the 3:15 clock and the late tape are both past
  const o = B.options || {}, d = o.day;
  const said = { 'no-trade': 'no trade', armed: 'a trend day, watching for the trigger until 2:45', done: 'done for the day', 'early-close': 'a 1 PM close, no trade', waiting: 'waiting for 12:30' };
  const optTxt = (x) => {
    const why = x.why || (x.test && x.test.why) || '';
    return `options today: ${said[x.status] || x.status}${x.test ? ` (${x.test.dir}, ${x.test.moveAtr.toFixed(2)} ATR from the open)` : ''}${why ? `: ${why}` : ''}`;
  };
  if (sess && !sess.early && e.min >= 13 * 60 && !young) {
    if (!d || d.date !== e.day || d.status === 'waiting') problems.push(`options: no 12:30 verdict today (${e.day}): SPY's minute bars or daily bars did not load`);
    else lines.push(optTxt(d));
  } else if (d && d.date === e.day) lines.push(optTxt(d));
  else lines.push(sess && sess.early ? 'options: no trade on a 1 PM close' : 'options: the next 12:30 test is on the next trading day');
  const held = (o.lots || []).filter((l) => l.expiry < e.day || (l.expiry === e.day && sess && e.min >= 15 * 60 + 40));
  if (held.length) problems.push(`options: ${held.length} contract(s) still held past the 3:15 clock`);
  // what the bots flagged in the last day, most recent first, each wording once
  const since = now - 24 * 3600000, seen = new Set();
  for (const l of S.log || []) {
    if (l.t < since) break;
    const bad = l.kind === 'HALT' || /did not load|failed|not filled|stalled|stale|out of step/i.test(l.text || '');
    if (!bad) continue;
    const key = String(l.text).replace(/[\d.,$%]+/g, '#');
    if (seen.has(key)) continue;
    seen.add(key);
    if (/desk round failed|journal write failed/.test(l.text)) problems.push(`${l.agent}: ${l.text}`);
    else notes.push(`${new Date(l.t).toISOString().slice(5, 16).replace('T', ' ')}Z ${l.agent}: ${l.text}`);
  }
  return { problems, lines, notes };
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
  const init = (c ? c.initial : 0) + (s ? s.initial : 0) + (o ? o.initial : 0);
  out.push(row('desk', p.e, init, `as of ${new Date(p.t).toISOString().slice(0, 16).replace('T', ' ')}Z`));
  return out;
}

// ---------------------------------------------------------------- the box
// Copies /data/desk/state.json and every journal there into `dest`, replacing the last run's copies.
// The desk's journals are a few kilobytes a day, so all of them come down every time.
function pullDesk(app, dest, log) {
  const fly = process.env.FLY_BIN || (fs.existsSync(path.join(process.env.HOME || '', '.fly', 'bin', 'fly')) ? path.join(process.env.HOME, '.fly', 'bin', 'fly') : 'fly');
  const listing = execFileSync(fly, ['ssh', 'console', '-q', '-a', app, '-C', 'ls /data/desk'], { encoding: 'utf8', timeout: 120000 });
  const want = listing.split('\n').map((x) => x.trim()).filter((n) => n === 'state.json' || JOURNAL.test(n));
  if (!want.includes('state.json')) throw new Error('the box has no /data/desk/state.json: is DESK on in fly.toml?');
  fs.mkdirSync(dest, { recursive: true });
  for (const n of fs.readdirSync(dest)) if (n === 'state.json' || JOURNAL.test(n)) fs.unlinkSync(path.join(dest, n));
  for (const name of want) execFileSync(fly, ['ssh', 'sftp', 'get', '-q', '-a', app, `/data/desk/${name}`, path.join(dest, name)], { stdio: 'ignore', timeout: 300000 });
  log(`box     copied /data/desk: state.json and ${want.length - 1} journal(s) into ${path.relative(path.join(__dirname, '..'), dest)}`);
  return dest;
}

// ---------------------------------------------------------------- main
function run(argv, { log = console.log, now = Date.now() } = {}) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] || true) : null; };
  const root = path.join(__dirname, '..');
  let dir = flag('dir') || path.join(root, 'data', 'desk');
  if (argv.includes('--box')) {
    try { dir = pullDesk(flag('app') || 'hexagon-desk', path.join(root, 'data', 'fly', 'desk-now'), log); }
    catch (e) { log(`PROBLEM could not copy the desk from the box: ${String(e.message).split('\n')[0].slice(0, 160)}`); return 1; }
  }
  const { state: S, events, days, torn } = readDesk(dir);
  if (!S || S.error || !S.books) { log(`PROBLEM no desk state in ${dir}${S && S.error ? ` (${S.error.slice(0, 80)})` : ''}`); return 1; }
  const until = stateTime(S);
  const built = rebuild(events, S, { until });
  const ledger = compare(built, S);
  const hl = health(S, now);
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

module.exports = { readDesk, stateTime, rebuild, compare, health, bookLines, run };

if (require.main === module) process.exitCode = run(process.argv.slice(2));

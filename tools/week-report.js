'use strict';
// The weekly report: each week, what each book made against simply holding what it trades, and what the
// prediction-market desk's books banked. Asked for 2026-09-26 as "a weekly books-vs-holding report once
// there are weeks of data" (not for the live floor: the floor says now, this says how the weeks went);
// built 2026-10-15, three weeks in.
//
//   node tools/week-report.js            reads the copies the daily check leaves on this Mac:
//                                        data/fly/desk-now/ (desk-check --box: the desk's state.json and
//                                        every journal) and data/fly/archive + data/fly/box-now (the
//                                        prediction-market journals). Run ops/daily-check.sh first for
//                                        today's numbers. Prints the weeks and writes
//                                        data/reports/weeks.html, one page to read on a phone
//   node tools/week-report.js --desk D   a different desk folder (state.json + journal-*.jsonl)
//   node tools/week-report.js --no-html  print only
//   node tools/week-report.js --no-save  do not add this run's finished weeks to data/reports/desk-weeks.json
//
// Read-only: no network, no box, nothing written but the page. Where the numbers come from:
//
//   STOCKS AND CRYPTO   the desk's minute history (state.json `history`): each minute the crypto book's
//                       value (c) and holding's (bc), the SPY book's (s) and holding's (bs), the whole
//                       desk's (e). A week runs Monday to Sunday, Eastern, and is measured from the last
//                       minute before it to its own last minute, so the weeks add up to the whole run.
//                       Books and coins that joined later were written into the history as cash from the
//                       start (engine addBook/addCoins), so a change in value is P&L, never a deposit.
//                       "Holding" is buying what the book trades on its first day and doing nothing more,
//                       after the same fee to buy in (engine chargeHoldingFee).
//   OFF BOOKS           options, scalps, dips and runners, off since 2026-10-08: the desk's change less
//                       the two books', so the rows add up to the desk.
//   PREDICTION MARKETS  REALISED money per book from the journals, through tools/pnl-report.js's own
//                       summarize, by the day each close landed on (that report's days: Eastern, ending at 4 AM, as
//                       the floor and tools/bet-record.js date a game; the UTC day until 2026-10-20). The maker's
//                       open inventory is not marked here; pnl-report --marks does that.
const fs = require('fs');
const path = require('path');
const clock = require('../src/desk/clock');
const pnl = require('./pnl-report');

const r2 = (x) => Math.round(x * 100) / 100;
const MINUS = '−';
const signed = (x) => `${x < 0 ? '-' : '+'}$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const pct = (x) => `${x < 0 ? '-' : '+'}${Math.abs(x * 100).toFixed(2)}%`;

// The Monday that starts the week holding an Eastern date 'YYYY-MM-DD'.
function mondayOf(day) {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
}
const sundayOf = (monday) => { const d = new Date(`${monday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 6); return d.toISOString().slice(0, 10); };

// The minutes grouped by Eastern week, each with the minute before it (or its own first, for the first week) and its last
function weekGroups(history) {
  const h = (history || []).filter((p) => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  const weeks = [];
  let prev = null, cur = null;
  for (const p of h) {
    const wk = mondayOf(clock.et(p.t).day);
    if (!cur || cur.week !== wk) {
      if (cur) weeks.push(cur);
      cur = { week: wk, from: prev || p, to: p };
    }
    cur.to = p;
    prev = p;
  }
  if (cur) weeks.push(cur);
  return weeks;
}
// Pure: the desk's minute history in, one row per Eastern week out, oldest first. Each figure is the
// change from the last minute before the week (or the week's first, for the first week) to its last.
function deskWeeks(history) {
  return weekGroups(history).map(({ week, from, to }) => row(week, from, to));
}
const addWeek = (monday, n) => { const d = new Date(`${monday}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + 7 * n); return d.toISOString().slice(0, 10); };
const point = (p) => ({ t: p.t, c: p.c, bc: p.bc, s: p.s, bs: p.bs, e: p.e });

// The weeks once the history no longer reaches back to the start (audit 2026-10-20). The desk keeps only its newest
// 30,000 minutes, about 21 days (src/desk/engine.js), and the report used to put the starting cash just before
// whatever minute came first: by 10-20 the first week (Sep 21-27) read +$0.00 beside its three fills, and the next
// took the whole move since the start. Now a week the history covers is measured as always; a week it no longer
// covers comes from `saved`, the rows earlier runs measured while they could (data/reports/desk-weeks.json); and a
// stretch neither covers is ONE row (`weeksIn` its weeks), from the last value known (a saved week's end, or the
// start) to the end of the history's first week. Each row carries its last minute (`to`) for the runs after.
function measuredWeeks(history, { start = null, saved = {} } = {}) {
  const h = (history || []).filter((p) => p && Number.isFinite(p.t) && (!start || p.t > start.t)).sort((a, b) => a.t - b.t);
  if (!h.length) return [];
  const firstWeek = mondayOf(clock.et(h[0].t).day);
  const kept = Object.values(saved || {}).filter((r) => r && r.week < firstWeek && r.to && Number.isFinite(r.to.t)).sort((a, b) => (a.week < b.week ? -1 : 1));
  const last = kept[kept.length - 1] || null;
  const from0 = last ? last.to : start || h[0];
  const fromWeek = last ? addWeek(last.week, 1) : mondayOf(clock.et(from0.t).day);
  const groups = weekGroups([from0, ...h]).filter((g) => g.week >= firstWeek);
  const rows = groups.map((g, i) => {
    const weeksIn = [];
    if (i === 0) for (let w = fromWeek; w <= g.week; w = addWeek(w, 1)) weeksIn.push(w);
    else weeksIn.push(g.week);
    return { ...row(weeksIn[0], g.from, g.to), end: sundayOf(g.week), weeksIn, to: point(g.to) };
  });
  return [...kept.map((r) => ({ ...r, weeksIn: r.weeksIn || [r.week], saved: true })), ...rows];
}

function row(week, a, b) {
  const d = (k) => (Number.isFinite(a[k]) && Number.isFinite(b[k]) ? r2(b[k] - a[k]) : null);
  const base = (k) => (Number.isFinite(a[k]) && a[k] > 0 ? a[k] : null);
  const crypto = d('c'), cryptoHold = d('bc'), spy = d('s'), spyHold = d('bs'), desk = d('e');
  return {
    week, end: sundayOf(week), fromT: a.t, toT: b.t,
    crypto, cryptoHold, cryptoVs: crypto != null && cryptoHold != null ? r2(crypto - cryptoHold) : null,
    cryptoPct: crypto != null && base('c') ? crypto / base('c') : null,
    cryptoHoldPct: cryptoHold != null && base('bc') ? cryptoHold / base('bc') : null,
    spy, spyHold, spyVs: spy != null && spyHold != null ? r2(spy - spyHold) : null,
    spyPct: spy != null && base('s') ? spy / base('s') : null,
    spyHoldPct: spyHold != null && base('bs') ? spyHold / base('bs') : null,
    off: desk != null && crypto != null && spy != null ? r2(desk - crypto - spy) : null,
    desk, deskPct: desk != null && base('e') ? desk / base('e') : null,
  };
}

// The whole run as one row, from the start to the last minute.
function wholeRun(history) {
  const h = (history || []).filter((p) => p && Number.isFinite(p.t)).sort((a, b) => a.t - b.t);
  return h.length ? row(mondayOf(clock.et(h[0].t).day), h[0], h[h.length - 1]) : null;
}

// The desk before its first trade: every book at its starting cash, and holding too. The first minute
// of the history is already past the first buys, so measuring from it left out the first day's fees and
// spread (crypto $31.98, holding's fee to buy in $40.21 on 2026-09-25): the report said -$1,104 since the
// start where tools/desk-check.js, which counts from the starting cash, said -$1,136. Books and coins that
// joined later are in `initial` already, as they are in the history.
function startPoint(S) {
  const B = (S && S.books) || {};
  const init = (k) => (B[k] && Number.isFinite(B[k].initial) ? B[k].initial : null);
  const c = init('crypto'), s = init('stocks');
  if (c == null || s == null || !Number.isFinite(S.startedAt)) return null;
  const e = Object.keys(B).reduce((a, k) => a + (init(k) || 0), 0);
  return { t: S.startedAt, c, bc: c, s, bs: s, e: r2(e) };
}

// Pure: the desk's journal events in, fills and fees per week and book.
function deskTrades(events) {
  const out = new Map();
  for (const e of events || []) {
    if (e.kind !== 'FILL' || !e.t) continue;
    const wk = mondayOf(clock.et(Date.parse(e.t)).day);
    const w = out.get(wk) || out.set(wk, { fills: 0, fees: 0, byBook: {} }).get(wk);
    w.fills++; w.fees = r2(w.fees + (e.fee || 0));
    w.byBook[e.book] = (w.byBook[e.book] || 0) + 1;
  }
  return out;
}

// Pure: pnl-report's days (UTC day -> each book's realised P&L) folded into weeks.
const PM_BOOKS = [['arb', 'Arbs'], ['maker', 'Maker'], ['snipe', 'Snipe'], ['bets', 'Game bets'], ['conv', 'Convergence']];
function pmWeeks(days) {
  const out = new Map();
  for (const [day, d] of days || []) {
    const wk = mondayOf(day);
    const w = out.get(wk) || out.set(wk, { arb: 0, maker: 0, snipe: 0, bets: 0, conv: 0, total: 0 }).get(wk);
    const add = { arb: d.arb || 0, maker: d.maker || 0, snipe: d.snipe || 0, bets: d.bets || 0, conv: (d.conv && d.conv.pnl) || 0 };
    for (const [k, v] of Object.entries(add)) { w[k] = r2(w[k] + v); w.total = r2(w.total + v); }
  }
  return out;
}

// The prediction-market books over the weeks the report shows. That desk ran from 2026-09-10, two weeks
// before this one began; its earlier weeks are pnl-report's, not this page's.
// a row's weeks: one, or the several a stretch the history no longer covers holds (measuredWeeks)
const weeksOf = (w) => w.weeksIn || [w.week];
// the trades, or the prediction desk's money, over a row's weeks
function overWeeks(map, w, zero, add) {
  const got = weeksOf(w).map((k) => map.get(k)).filter(Boolean);
  return got.length ? got.reduce(add, zero()) : null;
}
const tradesOver = (trades, w) => overWeeks(trades, w, () => ({ fills: 0, fees: 0, byBook: {} }), (a, t) => {
  a.fills += t.fills; a.fees = r2(a.fees + t.fees); for (const [b, n] of Object.entries(t.byBook)) a.byBook[b] = (a.byBook[b] || 0) + n; return a; });
const pmOver = (pm, w) => overWeeks(pm, w, () => ({ arb: 0, maker: 0, snipe: 0, bets: 0, conv: 0, total: 0 }), (a, p) => {
  for (const [k] of PM_BOOKS) a[k] = r2(a[k] + p[k]); a.total = r2(a.total + p.total); return a; });
const title = (w) => (weeksOf(w).length > 1 ? `Weeks of ${fmtDay(w.week)} – ${fmtDay(w.end)}, together (the desk's minutes for them are gone; measured from ${weeksOf(w)[0] === w.week ? 'the start' : 'the last week kept'})` : `Week of ${fmtDay(w.week)} – ${fmtDay(w.end)}`);
function pmTotal(pm, weeks) {
  const shown = weeks.flatMap(weeksOf).map((k) => pm.get(k)).filter(Boolean);
  if (!shown.length) return null;
  return shown.reduce((a, p) => { for (const [k] of PM_BOOKS) a[k] = r2(a[k] + p[k]); a.total = r2(a.total + p.total); return a; },
    { arb: 0, maker: 0, snipe: 0, bets: 0, conv: 0, total: 0 });
}

function readJournals(dir) {
  const ev = [];
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n)).sort(); } catch { return ev; }
  for (const n of names) {
    for (const line of fs.readFileSync(path.join(dir, n), 'utf8').split('\n')) {
      if (!line) continue;
      try { ev.push(JSON.parse(line)); } catch { /* a line a full disk tore */ }
    }
  }
  return ev;
}

const vsWords = (x) => (x == null ? 'n/a' : Math.abs(x) < 0.005 ? 'level with holding' : `${x > 0 ? 'ahead of' : 'behind'} holding by $${Math.abs(x).toFixed(2)}`);
const fmtDay = (day) => new Date(`${day}T12:00:00Z`).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

// Plain text, newest week first.
function renderText({ weeks, whole, trades, pm, asOf }) {
  const L = [];
  L.push(`The weeks · books against simply holding · as of ${new Date(asOf).toISOString().slice(0, 16).replace('T', ' ')}Z`);
  L.push('');
  const one = (w, title) => {
    L.push(title);
    if (w.crypto != null) L.push(`  crypto   ${signed(w.crypto).padStart(11)} ${w.cryptoPct != null ? `(${pct(w.cryptoPct)})` : ''}   holding ${signed(w.cryptoHold)}${w.cryptoHoldPct != null ? ` (${pct(w.cryptoHoldPct)})` : ''}   ${vsWords(w.cryptoVs)}`);
    if (w.spy != null) L.push(`  SPY      ${signed(w.spy).padStart(11)} ${w.spyPct != null ? `(${pct(w.spyPct)})` : ''}   holding ${signed(w.spyHold)}${w.spyHoldPct != null ? ` (${pct(w.spyHoldPct)})` : ''}   ${vsWords(w.spyVs)}`);
    if (w.off != null && Math.abs(w.off) >= 0.005) L.push(`  off books${signed(w.off).padStart(11)}   options, scalps, dips, runners (off since 2026-10-08)`);
    if (w.desk != null) L.push(`  desk     ${signed(w.desk).padStart(11)} ${w.deskPct != null ? `(${pct(w.deskPct)})` : ''}`);
  };
  for (const w of [...weeks].reverse()) {
    one(w, title(w));
    const t = tradesOver(trades, w);
    L.push(`  trades   ${t ? `${t.fills} fill${t.fills === 1 ? '' : 's'} (${Object.entries(t.byBook).map(([b, n]) => `${b} ${n}`).join(', ')}) · fees $${t.fees.toFixed(2)}` : 'none'}`);
    const p = pmOver(pm, w);
    if (p) L.push(`  predictions realised ${signed(p.total)}: ${PM_BOOKS.filter(([k]) => Math.abs(p[k]) >= 0.005).map(([k, n]) => `${n.toLowerCase()} ${signed(p[k])}`).join(', ') || 'nothing closed'}`);
    L.push('');
  }
  if (whole) {
    one(whole, 'Since the start');
    const t = pmTotal(pm, weeks);
    if (t) L.push(`  predictions realised ${signed(t.total)} (these weeks): ${PM_BOOKS.filter(([k]) => Math.abs(t[k]) >= 0.005).map(([k, n]) => `${n.toLowerCase()} ${signed(t[k])}`).join(', ')}`);
  }
  return L.join('\n');
}

// One page, light or dark as the device is set, no script, no requests.
function renderHtml({ weeks, whole, trades, pm, asOf }) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (x) => (x == null ? '—' : `<span class="${x > 0.004 ? 'up' : x < -0.004 ? 'down' : ''}">${signed(x).replace('-', MINUS)}</span>`);
  const pc = (x) => (x == null ? '' : ` <small>${pct(x).replace('-', MINUS)}</small>`);
  const vs = (x) => (x == null ? '—' : Math.abs(x) < 0.005 ? '<span>level</span>' : `<span class="${x > 0 ? 'up' : 'down'}">${x > 0 ? 'ahead' : 'behind'} $${Math.abs(x).toFixed(2)}</span>`);
  const deskRows = (w) => [
    w.crypto != null ? `<tr><th>Crypto</th><td>${money(w.crypto)}${pc(w.cryptoPct)}</td><td>${money(w.cryptoHold)}${pc(w.cryptoHoldPct)}</td><td>${vs(w.cryptoVs)}</td></tr>` : '',
    w.spy != null ? `<tr><th>SPY</th><td>${money(w.spy)}${pc(w.spyPct)}</td><td>${money(w.spyHold)}${pc(w.spyHoldPct)}</td><td>${vs(w.spyVs)}</td></tr>` : '',
    w.off != null && Math.abs(w.off) >= 0.005 ? `<tr><th>Off books</th><td>${money(w.off)}</td><td></td><td></td></tr>` : '',
    `<tr class="sum"><th>Desk</th><td>${money(w.desk)}${pc(w.deskPct)}</td><td></td><td></td></tr>`,
  ].join('');
  const pmRows = (p) => (p ? PM_BOOKS.filter(([k]) => Math.abs(p[k]) >= 0.005).map(([k, n]) => `<tr><th>${n}</th><td>${money(p[k])}</td></tr>`).join('') + `<tr class="sum"><th>Realised</th><td>${money(p.total)}</td></tr>` : '<tr><td>Nothing closed</td></tr>');
  const section = (title, w, t, p) => `<section><h2>${esc(title)}</h2>
<table class="desk"><thead><tr><th></th><th>Book</th><th>Holding</th><th>Against holding</th></tr></thead><tbody>${deskRows(w)}</tbody></table>
${t !== undefined ? `<p class="note">${t ? `${t.fills} trade${t.fills === 1 ? '' : 's'} · fees $${t.fees.toFixed(2)}` : 'No trades'}</p>` : ''}
<h3>Prediction markets, realised</h3><table class="pm"><tbody>${pmRows(p)}</tbody></table></section>`;
  const total = pmTotal(pm, weeks);
  const body = [...weeks].reverse().map((w) => section(title(w), w, tradesOver(trades, w), pmOver(pm, w))).join('\n')
    + (whole ? section('Since the start', whole, undefined, total) : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>The Weeks</title><style>
:root{--bg:#f5f5f7;--card:#fff;--text:#1d1d1f;--muted:#5f5f64;--line:#d2d2d7;--up:#1a7f37;--down:#c9341f;color-scheme:light dark}
@media (prefers-color-scheme:dark){:root{--bg:#000;--card:#1c1c1e;--text:#f5f5f7;--muted:#a1a1a6;--line:#38383a;--up:#4cd964;--down:#ff6961}}
body{margin:0;background:var(--bg);color:var(--text);font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:24px 16px 48px}h1{font-size:28px;margin:0 0 4px}.sub{color:var(--muted);margin:0 0 20px}
section{background:var(--card);border-radius:14px;padding:16px;margin:0 0 16px}h2{font-size:18px;margin:0 0 10px}h3{font-size:14px;color:var(--muted);margin:14px 0 6px;font-weight:600}
table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums}th,td{text-align:right;padding:6px 4px;border-top:1px solid var(--line)}th:first-child,td:first-child{text-align:left}
td,tbody th{white-space:nowrap}thead th{color:var(--muted);font-weight:500;font-size:13px;border-top:0}tbody th{font-weight:500}.sum th,.sum td{font-weight:600}
small{color:var(--muted);font-size:12px}.up{color:var(--up)}.down{color:var(--down)}.note{color:var(--muted);font-size:13px;margin:8px 0 0}
@media (max-width:480px){section{padding:14px 12px}table{font-size:14px}th,td{padding:6px 2px}table.desk thead th:nth-child(3),table.desk td:nth-child(3){display:none}}
</style></head><body><main><h1>The Weeks</h1>
<p class="sub">Each book against simply holding what it trades, Monday to Sunday, Eastern. Paper money. As of ${esc(new Date(asOf).toISOString().slice(0, 16).replace('T', ' '))} UTC.</p>
${body}
<p class="note">Holding is buying what each book trades on its first day, after the same fee, and doing nothing more. Prediction markets show money banked, by the UTC day it closed; open maker inventory is not marked.</p>
</main></body></html>
`;
}

function main(argv) {
  const has = (f) => argv.includes(f);
  const at = argv.indexOf('--desk');
  const deskDir = at >= 0 ? argv[at + 1] : path.join('data', 'fly', 'desk-now');
  let S;
  try { S = JSON.parse(fs.readFileSync(path.join(deskDir, 'state.json'), 'utf8')); }
  catch (e) { console.error(`no desk state in ${deskDir} (${e.code || e.message}): run ops/daily-check.sh (or node tools/desk-check.js --box) first`); return 1; }
  const start = startPoint(S);
  const history = start ? [start, ...(S.history || []).filter((p) => p.t > start.t)] : S.history;
  // the weeks earlier runs measured, for the weeks the desk's history no longer reaches (measuredWeeks)
  const keptFile = path.join('data', 'reports', 'desk-weeks.json');
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(keptFile, 'utf8')).weeks || {}; } catch { /* the first run */ }
  const weeks = measuredWeeks(S.history, { start, saved });
  const whole = wholeRun(history);
  // a week is kept once it is over and was measured on its own, from the minute before it to its last
  const today = clock.et(Date.now()).day;
  for (const w of weeks) if (!w.saved && weeksOf(w).length === 1 && w.end < today) saved[w.week] = w;
  if (!has('--no-save')) {
    fs.mkdirSync(path.dirname(keptFile), { recursive: true });
    fs.writeFileSync(keptFile, JSON.stringify({ note: 'each finished week as tools/week-report.js measured it; the desk keeps only ~21 days of minutes', weeks: saved }, null, 1));
  }
  const trades = deskTrades(readJournals(deskDir));
  const pm = pmWeeks(pnl.summarize(pnl.load([path.join('data', 'fly', 'archive'), path.join('data', 'fly', 'box-now')])).days);
  const last = (S.history || []).reduce((m, p) => Math.max(m, p.t || 0), 0);
  const data = { weeks, whole, trades, pm, asOf: last };
  console.log(renderText(data));
  if (!has('--no-html')) {
    const out = path.join('data', 'reports', 'weeks.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, renderHtml(data));
    console.log(`\nwrote ${out}`);
  }
  return 0;
}

if (require.main === module) process.exitCode = main(process.argv.slice(2));
module.exports = { mondayOf, deskWeeks, measuredWeeks, wholeRun, startPoint, deskTrades, pmWeeks, pmTotal, renderText, renderHtml };

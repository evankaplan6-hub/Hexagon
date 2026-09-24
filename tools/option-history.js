'use strict';
// The option history: daily bars and open interest for EXPIRED option contracts, from ChartExchange,
// one file per underlying per monthly expiry under data/options/history/.
//
//   node tools/option-history.js                          # the six ETFs, every monthly expiry from 2021-07 to the last one expired
//   node tools/option-history.js --only SPY,QQQ --from 2024-01 --to 2024-06
//   node tools/option-history.js --band 0.15 --window 90  # wider strike window (see below)
//   node tools/option-history.js --pace 400               # slower: milliseconds between calls
//   node tools/option-history.js --newest-first           # most recent expiries first, for a key that may not last
//   node tools/option-history.js --repair                 # ask again for contracts an earlier run could not fetch (marked err)
//   node tools/option-history.js --refresh                # re-pull expiries whose file already exists
//   node tools/option-history.js --dry-run                # list what would be pulled, fetch no bars, write nothing
//
// READ-ONLY. A data key, no account, no order path: the standing of tools/chain-record.js. Needs
// CHARTEXCHANGE_API_KEY in .env (src/venues/chartexchange.js).
//
// WHY. README.md's options section opens with "free historical option chains do not exist", and the
// chain tape (tools/chain-record.js) is the answer to that: start writing live chains down and wait a
// year. ChartExchange turns out to sell the other half -- not chains, but the DAILY BAR AND OPEN
// INTEREST OF EVERY CONTRACT, including ones that expired years ago, back to June 2021. That is
// enough to ask the ETF lab's unanswered question (does any rule for selling options beat owning
// the underlying?) on five years of real prints instead of waiting a year for the tape, with one
// honest caveat the file header repeats: a daily bar is the trades that happened, with no bid or ask,
// so a backtest on it fills at the last print, which is the wrong side as often as the right one.
// The chain tape's bid/ask spreads are what say how much that flatters a rule; the two histories
// name contracts the same way (OSI symbols) so they join.
//
// The subscription is a trial to 2026-10-07, AND THE TRIAL CAPS REQUESTS: on 2026-09-23 the key was
// refused (HTTP 406, "maximum number of requests in trial mode") after roughly 800 calls, one
// expiry into a run that needs ~60,000. The run stops there rather than failing every remaining
// expiry, and is resumable: an expiry whose file exists is skipped, so it picks up where it stopped
// once the key answers again -- a paid plan removes the cap; whether it also resets daily is not
// documented and will be known by the next run.
//
// WHAT IT KEEPS. For each underlying and each MONTHLY expiry (the third Friday, or the Thursday
// before when that Friday is a holiday -- Good Friday 2025 listed nothing), every call and put whose
// strike lies within ±BAND of where the underlying CLOSED over the WINDOW days before expiry: not
// spot on one day, but the whole range of closes, so a contract that was at the money at any entry
// point in the window is in, whatever the underlying did afterwards. Per contract, its whole life
// of daily bars: date, open, high, low, close, volume, open interest. A day with no trade has no
// bar; that gap is real information (nobody dealt) and is not filled.
//
// WHAT IT THROWS AWAY. Weekly and daily expiries, and strikes outside the band. SPY lists ~300
// contracts a monthly expiry across every strike, and about 200 sit inside ±10% of a two-month
// range; six underlyings over 62 months is ~60,000 contract fetches, one call each, and at the
// default pace that is a few hours. Both limits are written into every file's header.
//
// THE FILE. data/options/history/<SYM>/<SYM>-<EXPIRY>.json:
//   { v:1, source, symbol, expiry, fetchedAt, band, windowDays,
//     window:{ from, to, low, high, lo, hi, days },   <- closes ran low..high; strikes kept lo..hi
//     listed, kept, cols:["d","o","h","l","c","v","oi"], note,
//     contracts:[ { osi:"SPY240419C00500000", right:"C", k:500, bars:[[d,o,h,l,c,v,oi], ...] }, ... ] }
// plus <SYM>/<SYM>-underlying.json, the underlying's own daily bars from the same source (split-
// adjusted, NOT dividend-adjusted -- the right series to compare strikes against).
const fs = require('fs');
const path = require('path');
const { makeSession, enabled, KEY_ENV } = require('../src/venues/chartexchange');
const { SYMBOLS } = require('./chain-record');
const { ET_DAY } = require('../src/recorder');

// Resolved against the repo, not the current directory, for the reason tools/chain-record.js gives.
const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'options', 'history');
const BAND = 0.10;
const WINDOW_DAYS = 70;
// The API's option bars begin in the last week of May 2021: a `start` much before that is answered
// with a server error (HTTP 500), not an empty list, for every contract however new -- found by
// probing, not documented. So every bars request starts here, and the first monthly expiry worth
// pulling is July 2021, the first with a month of life on the tape. (Contracts are LISTED back to
// 2020, which is what made 2021-01 look possible; the listing is not the history.)
//
// And the same 500 comes back now and then for ONE contract at ONE start while the next start, two
// days on, is served -- the same query answered empty once and with an error a minute later. So a
// contract is asked for from a short ladder of later starts before it is given up on, and one given
// up on is written into the file with `err` and no bars rather than dropped: a strike missing from
// a file reads as "not inside the band", and that would be a lie. `--repair` asks again for those.
const OPTION_BARS_FROM = '2021-06-01';
const FROM = '2021-07';
const UNDERLYING_FROM = '2020-06-01';   // the underlying's bars go back to 2003; from here covers the first window
const COLS = ['d', 'o', 'h', 'l', 'c', 'v', 'oi'];
const MONTH_RE = /^\d{4}-\d{2}$/;

const iso = (ms) => new Date(ms).toISOString();
const etDay = (ms) => ET_DAY.format(new Date(ms));
const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
const addDays = (d, n) => new Date(dayMs(d) + n * 86400000).toISOString().slice(0, 10);
const secOf = (d) => Math.floor(dayMs(d) / 1000);

// ------------------------------------------------------------------ pure: the calendar
// The third Friday of a month, the standard monthly expiry. `m` is 1-12.
function thirdFriday(y, m) {
  const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay();          // 0 Sunday .. 6 Saturday
  const day = 1 + ((5 - first + 7) % 7) + 14;
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
// Every third Friday from month `from` to month `to`, both 'YYYY-MM', inclusive.
function monthlyExpiries(from, to) {
  if (!MONTH_RE.test(from) || !MONTH_RE.test(to)) throw new Error('months are YYYY-MM');
  const out = [];
  let [y, m] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(thirdFriday(y, m));
    if (++m > 12) { m = 1; y++; }
  }
  return out;
}
// The month whose third Friday is the last one strictly before `today` (an Eastern day). An expiry
// that has not passed is still being written by the market; the chain tape covers those.
function lastExpiredMonth(today) {
  let [y, m] = today.slice(0, 7).split('-').map(Number);
  if (thirdFriday(y, m) >= today) { if (--m < 1) { m = 12; y--; } }
  return `${y}-${String(m).padStart(2, '0')}`;
}

// ------------------------------------------------------------------ pure: the strike window
// Where the underlying closed over the `windowDays` calendar days up to and including the expiry,
// widened by `band` each way. null when the bars do not cover the window at all.
function strikeWindow(bars, expiry, { band = BAND, windowDays = WINDOW_DAYS } = {}) {
  const from = addDays(expiry, -windowDays);
  const closes = (bars || []).filter((b) => b.d >= from && b.d <= expiry && b.c > 0).map((b) => b.c);
  if (!closes.length) return null;
  const low = Math.min(...closes), high = Math.max(...closes);
  const EPS = 1e-9;   // the edges are struck strikes, not wings: 100*(1-0.1) is 90.00000000000001
  return { from, to: expiry, low, high, lo: low * (1 - band) - EPS, hi: high * (1 + band) + EPS, days: closes.length };
}
const inWindow = (contracts, w) => (contracts || []).filter((c) => c.strike >= w.lo && c.strike <= w.hi);

// ------------------------------------------------------------------ pure: the file
function fileFor(dir, symbol, expiry) { return path.join(dir, symbol, `${symbol}-${expiry}.json`); }
function underlyingFile(dir, symbol) { return path.join(dir, symbol, `${symbol}-underlying.json`); }

function historyFile({ symbol, expiry, at, band, windowDays, window, listed, contracts, calls = null }) {
  const missing = contracts.filter((c) => c.err).length;
  const sorted = [...contracts].sort((a, b) => (a.right === b.right ? a.strike - b.strike : a.right < b.right ? -1 : 1));
  const rows = (bars) => bars.map((b) => [b.d, b.o, b.h, b.l, b.c, b.v, b.oi == null ? null : b.oi]);
  return {
    v: 1, source: 'chartexchange', symbol, expiry, fetchedAt: iso(at), band, windowDays,
    window: { from: window.from, to: window.to, low: window.low, high: window.high, lo: r2(window.lo), hi: r2(window.hi), days: window.days },
    listed, kept: sorted.length, missing, cols: COLS,
    note: `one object per contract, its daily bars from ${OPTION_BARS_FROM} (where the source's option history begins) or its listing, whichever is later, as arrays in \`cols\` order; a day with no bar is a day the `
      + 'contract did not trade; o/h/l/c are trade prints with no bid or ask behind them, and oi is open interest at that '
      + `day's end; strikes outside ±${Math.round(band * 100)}% of the underlying's closes over the ${windowDays} days before expiry `
      + 'were not recorded; the underlying\'s own bars are in the -underlying file (split-adjusted, not dividend-adjusted); '
      + 'osi is the same contract name the chain tape (data/chains/) uses; a contract with `err` is one the source would not '
      + 'serve (its bars are unknown, not absent) and `missing` counts them -- run with --repair to ask again',
    ...(calls == null ? {} : { calls }),
    contracts: sorted.map((c) => ({ osi: c.osi, right: c.right, k: c.strike, bars: rows(c.bars || []), ...(c.err ? { err: c.err } : {}) })),
  };
}
const r2 = (x) => Math.round(x * 100) / 100;

// ------------------------------------------------------------------ the pull
function readJson(file, io) { try { return JSON.parse(io.readFileSync(file, 'utf8')); } catch { return null; } }
// Written whole or not at all: a crash mid-write must not leave a file the next run would skip.
function writeJson(file, obj, io) {
  io.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  io.writeFileSync(tmp, JSON.stringify(obj));
  io.renameSync(tmp, file);
}

// The underlying's bars, from the cache when it already reaches `until`, else from the API.
async function underlyingBars(session, symbol, { dir, until, at, io = fs, refresh = false }) {
  const file = underlyingFile(dir, symbol);
  const cached = readJson(file, io);
  const last = cached && Array.isArray(cached.bars) && cached.bars.length ? cached.bars[cached.bars.length - 1].d : null;
  if (!refresh && last && last >= until) return cached.bars;
  const bars = await session.bars(symbol, { start: secOf(UNDERLYING_FROM), until });
  if (!bars.length) throw new Error(`no bars for ${symbol}`);
  writeJson(file, { v: 1, source: 'chartexchange', symbol, fetchedAt: iso(at), from: UNDERLYING_FROM, cols: ['d', 'o', 'h', 'l', 'c', 'v'], note: 'daily bars, split-adjusted, not dividend-adjusted', bars }, io);
  return bars;
}

// The contracts listed for the monthly expiry: the third Friday, else the Thursday before it
// (exchange holidays move the expiry a day earlier and the Friday lists nothing).
async function listMonthly(session, symbol, friday) {
  for (const expiry of [friday, addDays(friday, -1)]) {
    const listed = await session.contracts(symbol, { expiration: expiry });
    if (listed.length) return { expiry, listed };
  }
  return { expiry: friday, listed: [] };
}

// One contract's bars, asked for from each start in turn while the source answers with ITS error
// (a 5xx); a 4xx is this side's mistake and is thrown. Empty-handed after the ladder: no bars and
// the last error, for the file to carry.
function startLadder(window) {
  const floor = secOf(OPTION_BARS_FROM);
  return [...new Set([floor, secOf(addDays(OPTION_BARS_FROM, 2)), secOf(addDays(window.from, -30))])].filter((s) => s >= floor).sort((a, b) => a - b);
}
async function contractBars(session, c, window, expiry) {
  let last = null;
  for (const start of startLadder(window)) {
    try { return { bars: await session.optionBars(c.cx, { start, until: expiry }) }; }
    catch (e) { if (e.quota || e.expired || !(e.status >= 500)) throw e; last = e; }
  }
  return { bars: [], err: last ? last.message : 'no answer' };
}

// One underlying, one monthly expiry. Resolves to what happened; a contract the source will not
// serve is written with `err`, and only this side's own mistake (a 4xx) fails the expiry, which is
// reported and left for the next run.
async function pullExpiry(session, { symbol, friday, bars, band, windowDays, dryRun = false, at, log = () => {} }) {
  const { expiry, listed } = await listMonthly(session, symbol, friday);
  if (!listed.length) return { symbol, expiry, status: 'skipped', why: 'no contracts listed' };
  const window = strikeWindow(bars, expiry, { band, windowDays });
  if (!window) return { symbol, expiry, status: 'skipped', why: 'no underlying bars in the window' };
  const kept = inWindow(listed, window);
  if (!kept.length) return { symbol, expiry, status: 'skipped', why: 'no strikes inside the window', listed: listed.length };
  if (dryRun) return { symbol, expiry, status: 'dry-run', listed: listed.length, kept: kept.length, window };
  const calls0 = session.stats.calls;
  const contracts = [];
  let barCount = 0, missing = 0;
  for (const c of kept) {
    try {
      const { bars: b, err } = await contractBars(session, c, window, expiry);
      barCount += b.length;
      if (err) missing++;
      contracts.push({ ...c, bars: b, ...(err ? { err } : {}) });
    } catch (e) {
      if (e.quota || e.expired) throw e;   // the run's problem, not this expiry's: archive() stops on it
      return { symbol, expiry, status: 'failed', why: `${c.osi}: ${e.message}`, listed: listed.length, kept: kept.length, done: contracts.length };
    }
  }
  const file = historyFile({ symbol, expiry, at, band, windowDays, window, listed: listed.length, contracts, calls: session.stats.calls - calls0 });
  return { symbol, expiry, status: 'pulled', listed: listed.length, kept: kept.length, bars: barCount, missing, window, file };
}

// A file whose contracts carry `err`: ask for those again, and rewrite the file if any came back.
async function repairFile(session, file, io) {
  const f = readJson(file, io);
  if (!f || !Array.isArray(f.contracts) || !(f.missing > 0)) return { missing: 0, fixed: 0 };
  let fixed = 0;
  for (const c of f.contracts) {
    if (!c.err) continue;
    const { bars, err } = await contractBars(session, { cx: cxOf(f.symbol, f.expiry, c) }, f.window, f.expiry);
    if (err) continue;
    c.bars = bars.map((b) => [b.d, b.o, b.h, b.l, b.c, b.v, b.oi == null ? null : b.oi]);
    delete c.err;
    fixed++;
  }
  if (fixed) { f.missing -= fixed; f.repairedAt = iso(Date.now()); writeJson(file, f, io); }
  return { missing: f.missing + fixed, fixed };
}
// The API's name for a contract in a file, rebuilt from the file's own fields.
const cxOf = (symbol, expiry, c) => `US:${symbol}${expiry.replace(/-/g, '')}${c.right}${String(Math.round(c.k * 1000) / 1000)}`;

// The whole run. `io` and `now` are injectable so tools/chartexchange-test.js drives it with a
// fake session and a temp directory and no clock.
async function archive(session, { symbols = SYMBOLS, from = FROM, to = null, dir = DIR, band = BAND, windowDays = WINDOW_DAYS,
  refresh = false, repair = false, dryRun = false, newestFirst = false, io = fs, now = Date.now, log = () => {} } = {}) {
  const at = now();
  const today = etDay(at);
  const toMonth = to || lastExpiredMonth(today);
  // Newest first when the key is on a clock: if it dies halfway, the years a backtest wants most
  // are the ones on disk. Skip-existing makes the order otherwise immaterial.
  const fridays = monthlyExpiries(from, toMonth).filter((d) => d < today);
  if (newestFirst) fridays.reverse();
  const out = { at, from, to: toMonth, expiries: fridays.length, pulled: [], skipped: [], failed: [], existing: 0, contracts: 0, bars: 0, missing: 0, repaired: 0, bytes: 0, calls0: session.stats.calls };
  for (const symbol of symbols) {
    let bars;
    try { bars = await underlyingBars(session, symbol, { dir, until: (newestFirst ? fridays[0] : fridays[fridays.length - 1]) || today, at, io, refresh }); }
    catch (e) {
      if (e.quota || e.expired) { out.stopped = `${symbol} underlying: ${e.message}`; out.calls = session.stats.calls - out.calls0; return out; }
      out.failed.push({ symbol, expiry: '*', why: `underlying: ${e.message}` }); log(`${symbol}  underlying bars: ${e.message}`); continue;
    }
    for (const friday of fridays) {
      const file = fileFor(dir, symbol, friday);
      // the Thursday spelling of a holiday-shifted expiry is checked too, so it is not pulled twice
      const already = [file, fileFor(dir, symbol, addDays(friday, -1))].find((f) => io.existsSync(f));
      if (already && !refresh) {
        out.existing++;
        if (repair && !dryRun) {
          let r;
          try { r = await repairFile(session, already, io); }
          catch (e) { if (e.quota || e.expired) { out.stopped = `${symbol} repair: ${e.message}`; out.calls = session.stats.calls - out.calls0; return out; } throw e; }
          if (r.missing) { out.repaired += r.fixed; out.missing += r.missing - r.fixed; log(`${symbol} ${path.basename(already, '.json').slice(-10)}  repaired ${r.fixed} of ${r.missing} missing contracts`); }
        }
        continue;
      }
      const t0 = Date.now();
      let r;
      try { r = await pullExpiry(session, { symbol, friday, bars, band, windowDays, dryRun, at, log }); }
      catch (e) {
        // The trial's request cap, or a key the source no longer accepts: every call from here on
        // is refused, so the run stops here rather than reporting each remaining expiry as its own
        // failure. What is on disk stays.
        if (e.quota || e.expired) { out.stopped = `${symbol} ${friday}: ${e.message}`; out.calls = session.stats.calls - out.calls0; return out; }
        r = { symbol, expiry: friday, status: 'failed', why: e.message };
      }
      const took = ((Date.now() - t0) / 1000).toFixed(0);
      if (r.status === 'pulled') {
        const text = JSON.stringify(r.file);
        writeJson(fileFor(dir, symbol, r.expiry), r.file, io);
        out.pulled.push(`${symbol} ${r.expiry}`); out.contracts += r.kept; out.bars += r.bars; out.missing += r.missing; out.bytes += Buffer.byteLength(text);
        log(`${symbol} ${r.expiry}  ${r.listed} listed · ${r.kept} kept (${r2(r.window.lo)}–${r2(r.window.hi)}) · ${r.bars} bars${r.missing ? ` · ${r.missing} MISSING` : ''} · ${(Buffer.byteLength(text) / 1024).toFixed(0)} KB · ${took}s`);
      } else if (r.status === 'dry-run') {
        out.pulled.push(`${symbol} ${r.expiry}`); out.contracts += r.kept;
        log(`${symbol} ${r.expiry}  ${r.listed} listed · ${r.kept} would be pulled (${r2(r.window.lo)}–${r2(r.window.hi)})`);
      } else if (r.status === 'failed') {
        out.failed.push({ symbol, expiry: r.expiry, why: r.why });
        log(`${symbol} ${r.expiry}  FAILED after ${r.done || 0} of ${r.kept || '?'} contracts: ${r.why}`);
      } else {
        out.skipped.push({ symbol, expiry: r.expiry, why: r.why });
        log(`${symbol} ${r.expiry}  skipped: ${r.why}`);
      }
    }
  }
  out.calls = session.stats.calls - out.calls0;
  return out;
}

module.exports = { SYMBOLS, DIR, BAND, WINDOW_DAYS, FROM, OPTION_BARS_FROM, COLS, thirdFriday, monthlyExpiries, lastExpiredMonth, strikeWindow, inWindow, startLadder, fileFor, underlyingFile, historyFile, listMonthly, pullExpiry, repairFile, underlyingBars, archive };

if (require.main === module) {
  require('../src/env').loadEnv(path.join(__dirname, '..', '.env'));
  (async () => {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
    const numFlag = (name, d) => {
      const raw = flag(name, null);
      if (raw === null) return d;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) { console.error(`--${name} must be a number, not ${JSON.stringify(raw)}. Nothing was pulled.`); process.exit(2); }
      return v;
    };
    if (!enabled()) { console.error(`${KEY_ENV} is not set in .env; nothing was pulled.`); process.exit(2); }
    const symbols = flag('only') ? flag('only').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : SYMBOLS;
    const opts = { symbols, from: flag('from', FROM), to: flag('to', null), dir: flag('dir', DIR), band: numFlag('band', BAND), windowDays: numFlag('window', WINDOW_DAYS),
      refresh: args.includes('--refresh'), repair: args.includes('--repair'), dryRun: args.includes('--dry-run'), newestFirst: args.includes('--newest-first'), log: console.log };
    for (const m of [opts.from, opts.to]) if (m && !MONTH_RE.test(m)) { console.error(`--from and --to are months like 2024-01, not ${JSON.stringify(m)}`); process.exit(2); }
    const session = makeSession({ pace: numFlag('pace', 250), tries: 2, retryMs: 1000 });
    const t0 = Date.now();
    console.log(`${iso(t0)}  ${symbols.join(' ')}  monthly expiries ${opts.from} → ${opts.to || 'the last expired'}  strikes ±${Math.round(opts.band * 100)}% of ${opts.windowDays}-day closes  → ${opts.dir}${opts.dryRun ? '  (dry run)' : ''}\n`);
    // One line per run in the history dir, whatever happens: the daily job (ops/run-history.sh) is
    // read by this file, and a fortnight of "STOPPED after 0" is a fact worth having in one place.
    const runLine = (text) => {
      if (opts.dryRun) return;
      try { fs.mkdirSync(opts.dir, { recursive: true }); fs.appendFileSync(path.join(opts.dir, 'history.log'), `${iso(Date.now())} ${text}\n`); } catch { /* the console line above still says it */ }
    };
    try {
      const r = await archive(session, opts);
      const min = ((Date.now() - t0) / 60000).toFixed(1);
      runLine(`pulled ${r.pulled.length} expiries · ${r.contracts} contracts · ${r.calls} calls · ${min} min${r.missing ? ` · ${r.missing} missing` : ''}${r.failed.length ? ` · ${r.failed.length} FAILED` : ''}${r.stopped ? ` · STOPPED (${r.stopped.slice(0, 80)})` : ''}`);
      console.log(`\n${opts.dryRun ? 'would pull' : 'pulled'} ${r.pulled.length} of ${r.expiries * symbols.length} expiries · ${r.contracts} contracts · ${r.bars} bars · ${(r.bytes / 1048576).toFixed(1)} MB · ${r.calls} API calls · ${min} min`
        + `${r.existing ? ` · ${r.existing} already on disk` : ''}${r.repaired ? ` · ${r.repaired} contracts repaired` : ''}`);
      if (r.missing) console.log(`${r.missing} contracts the source would not serve are marked err in their files; run again with --repair to ask for them`);
      if (r.skipped.length) console.log(`skipped ${r.skipped.length}: ${r.skipped.map((s) => `${s.symbol} ${s.expiry} (${s.why})`).join(', ')}`);
      if (r.failed.length) console.log(`FAILED ${r.failed.length}, run again to retry: ${r.failed.map((s) => `${s.symbol} ${s.expiry} (${s.why})`).join(', ')}`);
      if (r.stopped) {
        const why = /HTTP 401/.test(r.stopped)
          ? 'The key is refused (expired): every call is one refused call until a key the source accepts is in .env. What was pulled is on disk.'
          : "The trial's request cap. What was pulled is on disk; run again once the key answers (a paid plan, or tomorrow if the cap is daily) and it resumes from here.";
        console.log(`\nSTOPPED at ${r.stopped}\n${why}`);
        process.exit(3);
      }
      process.exit(r.failed.length ? 1 : 0);
    } catch (e) {
      console.error(`stopped: ${e.message}`);
      runLine(`PROBLEM ${e.message.slice(0, 160)}`);
      process.exit(1);
    }
  })();
}

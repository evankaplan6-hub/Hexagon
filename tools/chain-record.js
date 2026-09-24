'use strict';
// The chain tape: live option chains, appended to data/chains/chains-YYYY-MM-DD.jsonl.
//
//   node tools/chain-record.js                  # one snapshot of the universe below, now
//   node tools/chain-record.js --every 30       # ... and again every 30 minutes, until killed
//   node tools/chain-record.js --only SPY --dte 45 --band 0.2
//   node tools/chain-record.js --again          # record even if nothing has changed since last time
//   node tools/chain-record.js --dry-run        # fetch and report, write nothing (ops/install-chains.sh uses this)
//   node tools/chain-record.js --check          # read-only: is the tape healthy? (ops/daily-check.sh uses this)
//
// READ-ONLY. No broker, no account, no key, no order path -- the same standing as
// tools/stock-fetch.js. Quotes come from Cboe's free delayed feed (src/venues/cboe.js).
//
// WHY BOTHER, given the ETF lab found nothing. The lab's verdict -- 0 of 66 settings beat
// buy-and-hold SPY out of sample -- is about daily ETF TIMING rules, and it stands. This aims at
// the hole the lab itself names: "no real options (the two Cboe indexes are one canned strategy
// each)". Free historical chains cannot be bought, so the only honest options backtest anyone can
// run a year from now is one whose data started being written today. Nothing here decides or
// trades anything. It is the collection that has a deadline, because an unrecorded day is gone.
//
// THE FILE FORMAT. One JSON line per symbol per expiry per snapshot, after a header line written
// when the day's file is created:
//
//   {"v":1,"cols":["k","bid","bidSz",...],"band":0.3,"maxDte":70,...}        <- header, once per file
//   {"t":"2026-09-21T20:05:02.118Z","sym":"SPY","spot":761.69,"sb":762.94,"sa":762.99,
//    "qt":"2026-09-21 20:04:11","exp":"2026-09-25","dte":4,"h":"3f9c…",
//    "c":[[755,6.8,46,6.84,160,6.82,0.2081,0.87,0.0027,0.831,-0.0906,1.4,6.85,4210,18322,"2026-09-21T15:59:58"], …],
//    "p":[ … ]}
//
// `c` and `p` are calls and puts, one array per contract in the header's column order. A null is
// Cboe declining to say; a 0 bid is a real quote and means something different. `t` is when this
// process asked, `qt` is Cboe's own stamp on the file. `h` is the content hash described below.
//
// WHAT IT DELIBERATELY DOES NOT KEEP. Strikes outside `--band` of spot (default ±30%) and expiries
// beyond `--dte` (default 70 days). One SPY response is 12,312 contracts across 31 expiries and
// 1.2 MB; filtered it is 5,060 across 15 and 493 KB. The strategies this is meant to feed --
// covered calls, put-writing, the wheel, anything BXM-shaped -- live inside two months and near
// the money, and LEAPs five years out would quadruple a year of tape for data no such rule reads.
// Both limits are recorded in the header so a reader knows what was filtered rather than guessing
// at a gap. At the defaults the whole universe is ~1.7 MB a snapshot: 0.4 GB a year once daily.
//
// WHY A CONTENT HASH AND NOT A CLOCK. Cboe's `timestamp` is when it last rebuilt that file, not
// when the market last moved: on one Saturday fetch SPY read 21:19 and IWM read the previous
// evening, and neither had a live quote behind it. So freshness is judged by what actually
// arrived. Each symbol's filtered chain is hashed, the hash is kept in `.seen.json`, and an
// unchanged chain is skipped. A weekend, a holiday, a feed that has stalled and a market that
// genuinely has not moved all collapse to the same honest answer -- nothing new -- instead of
// filling the tape with copies of Friday that a reader would have to detect and drop later.
//
// AND CBOE'S STAMP AS WELL, SINCE 2026-09-24. The hash alone let a frozen feed through. Cboe stopped
// rebuilding its files after the 09-22 evening (every stamp read 2026-09-22 23:29 to 09-23 03:56 UTC
// for a day and a half), and the hash is taken AFTER the date filter: when an expiry rolled off at
// midnight, the same frozen file hashed differently, and the 09-24 09:45 run wrote 70 lines --
// every one a copy of a 09-22 or 09-23 line -- as that morning's chains. Only DIA, with no expiry
// rolling off, was skipped. So now:
//   - the content is compared expiry by expiry as well as whole: the same spot and the same quotes
//     on every expiry both snapshots hold is not news, so one expiry rolling off, or a new one
//     coming inside the 70 days, no longer makes an old file look new. That also covers a file
//     Cboe rebuilt with a new stamp and the same content (the Saturday case above).
//   - Cboe's stamp is kept beside the hash (the newest one the chain has been seen under), and an
//     unchanged symbol whose file still carries that same stamp is reported as STALE: Cboe has not
//     rebuilt it at all since the last run. That is the feed frozen, not a quiet market, and it is
//     what src/chainsched.js and the verdict below say out loud. The content still decides what
//     is skipped: a changed chain under an old stamp is recorded, because the quotes are what
//     cannot be fetched again, and a stamp alone never is.
// And each run leaves one ok/PROBLEM line in data/chains/chains.log (see verdict below), because
// nothing noticed any of this: 09-23 16:25 ET failed on all six symbols in ~40 seconds, the job
// still exited 0, and the lost session cannot be fetched again from anyone.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeSession, daysToExpiry, CHAIN_COLS } = require('../src/venues/cboe');
const { ET_DAY } = require('../src/recorder');
const { wall, instant } = require('../src/chainsched');
const { read: readTape } = require('../src/chaintape');

// FIXED HERE, BEFORE ANY RESULT, for the reason tools/stock-fetch.js fixes its ETF universe:
// choosing underlyings after seeing which ones paid is choosing survivors. These are six heavily
// optioned broad ETFs, and each already has daily bars in data/stocks/bars/, so a chain and its
// underlying's history join on the date with nothing left to reconcile.
const SYMBOLS = ['SPY', 'QQQ', 'IWM', 'DIA', 'TLT', 'GLD'];
// Under DATA_DIR when the desk sets one, so the server's /api/chains reads what this writes
// (server.js joins cfg.dataDir with 'chains'). Overridden per run by --dir.
//
// Resolved against the REPO, not the current directory, and deliberately: `data` on its own sent a
// run started from anywhere else -- a one-off catch-up from a home directory, say -- to
// <cwd>/data/chains, where it reported success, printed a byte count, and left a day of chains
// nobody would look in while the dashboard went on saying the tape was empty. This matches how
// src/config.js computes the same default.
const DIR = path.join(process.env.DATA_DIR || path.join(__dirname, '..', 'data'), 'chains');
const SEEN = '.seen.json';
// One line per run, ok or PROBLEM, beside the tape. ops/run-chains.sh writes its PROBLEM lines
// here too (node missing, a worktree), so this one file answers "has the job been working".
const LOG = 'chains.log';
const BAND = 0.30;
const MAX_DTE = 70;
// How old Cboe's stamp may be on a weekday run at or after 16:00 Eastern before it is a PROBLEM.
// The 16:25 and 20:00 runs normally see a stamp minutes old (09-22: 20:26 UTC at 20:27, 23:58 at
// 00:00); DIA's, the laziest, was 27 minutes. 09-23's 20:00 run saw ones 20 to 25 hours old.
const STALE_HOURS = 3;
const CLOSE_HOUR = 16;
// When every symbol fails, the whole run is tried again this many times, this far apart. 09-23
// 16:25 ET lost the closing chains to a failure that lasted ~40 seconds of per-symbol retries; a
// few minutes' patience costs nothing on a job that runs three times a day. The retries try each
// symbol once rather than three times, so a feed that is really down still ends the run in a
// few minutes, not a quarter of an hour of connect timeouts.
const RUN_RETRIES = 2;
const RUN_RETRY_MS = 60000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const iso = (ms) => new Date(ms).toISOString();
// The Eastern calendar day, the same one that names the file. US options expire on an Eastern
// date, so days-to-expiry is counted on that calendar: at 22:00 ET the UTC date is already
// tomorrow, and a UTC count would shorten every expiry by a day for two hours each evening.
const etDay = (ms) => ET_DAY.format(new Date(ms));

// ------------------------------------------------------------------ pure, so the tests need no network
// What this snapshot of a symbol actually says, as one hash. Spot is in it, so any real market
// move changes it; the fetch time is NOT, so a re-fetch of an unchanged market does not.
function chainHash(chain) {
  const h = crypto.createHash('sha256');
  h.update(String(chain.symbol)).update('|').update(String(chain.spot));
  for (const exp of [...chain.byExpiry.keys()].sort()) {
    const e = chain.byExpiry.get(exp);
    h.update('|').update(exp).update(JSON.stringify(e.calls)).update(JSON.stringify(e.puts));
  }
  return h.digest('hex');
}

// The same content, one short hash per expiry, kept in the seen file so the next run can compare
// the expiries both snapshots hold. The whole-chain hash above changes when the date filter drops
// an expiry at midnight or lets a new one inside the day limit; these do not.
function expiryHashes(chain) {
  const out = {};
  for (const exp of [...chain.byExpiry.keys()].sort()) {
    const e = chain.byExpiry.get(exp);
    out[exp] = crypto.createHash('sha256').update(JSON.stringify(e.calls)).update(JSON.stringify(e.puts)).digest('hex').slice(0, 16);
  }
  return out;
}

// Nothing has moved since `prev` (a seen entry): the same spot, and every expiry both hold quoted
// exactly the same. At least one shared expiry, so two chains with nothing in common never match.
function sameQuotes(prev, chain, exps) {
  if (!prev || !prev.exps || prev.spot !== chain.spot) return false;
  const shared = Object.keys(exps).filter((x) => prev.exps[x] !== undefined);
  return shared.length > 0 && shared.every((x) => prev.exps[x] === exps[x]);
}

// Cboe's stamp as an instant. It is UTC with no offset written ('2026-09-22 13:47:17' came back
// from a fetch at 13:48:07Z); null for anything unparseable.
function stampMs(qt) {
  if (!qt) return null;
  const t = Date.parse(`${String(qt).trim().replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? t : null;
}

// The newest weekday at or before `at`, Eastern, whose `hh`:00 has already passed.
function lastWeekdayAt(at, hh) {
  const w = wall(at);
  for (let back = 0; back < 10; back++) {
    const dw = wall(Date.UTC(w.y, w.m - 1, w.d - back, 12));
    if (dw.dow < 1 || dw.dow > 5) continue;
    const t = instant(dw.y, dw.m, dw.d, hh, 0);
    if (t <= at) return { at: t, day: `${dw.y}-${String(dw.m).padStart(2, '0')}-${String(dw.d).padStart(2, '0')}` };
  }
  return null;
}

// How new a stamp a run at `at` must see. At or after 16:00 on a weekday: within STALE_HOURS.
// Any other time (a 09:45 run, a weekend one): newer than the last weekday's 16:00 -- the 09-24
// 09:45 run saw stamps from before the 09-23 open, and that alone says the feed had frozen.
function freshSince(at) {
  const w = wall(at);
  if (w.dow >= 1 && w.dow <= 5 && w.hh >= CLOSE_HOUR) return { since: at - STALE_HOURS * 3600000, closeRun: true };
  const last = lastWeekdayAt(at, CLOSE_HOUR);
  return { since: last ? last.at : -Infinity, closeRun: false, after: last ? `${last.day} 16:00 ET` : null };
}

// A run's one line for chains.log: what it did, and ok or PROBLEM. PROBLEM, and a non-zero exit,
// when (a) at or after 16:00 on a weekday a symbol failed or a stamp is over STALE_HOURS old,
// (b) at any other time a stamp is older than the last weekday's 16:00, or (c) the seen file could
// not be written. A weekday market holiday on which Cboe does not rebuild its files will raise
// one; that is the price of hearing about a real freeze the same day rather than a week later.
// Pure: the run's result and its time in, the line out.
function verdict(r, { symbols = SYMBOLS } = {}) {
  const at = r.at;
  const failed = r.failed || [], stale = r.stale || [];
  const fresh = freshSince(at);
  const age = (ms) => `${((at - ms) / 3600000).toFixed(1)}h`;
  const stamps = Object.entries(r.quotes || {}).map(([sym, qt]) => ({ sym, qt, ms: stampMs(qt) }));
  const old = stamps.filter((s) => s.ms === null || s.ms < fresh.since);
  const notes = [];
  if (failed.length) {
    const byWhy = new Map();
    for (const f of failed) byWhy.set(f.why, [...(byWhy.get(f.why) || []), f.sym]);
    notes.push(`failed: ${[...byWhy].map(([why, syms]) => `${syms.join(' ')} (${why})`).join(', ')}`);
  }
  if (stale.length) {
    notes.push(stale.length === symbols.length
      ? `all ${stale.length} stale: Cboe has not rebuilt a file since the last run`
      : `stale: ${stale.join(' ')} (Cboe file not rebuilt since the last run)`);
  }
  if (old.length) notes.push(`old stamps: ${old.map((s) => (s.ms === null ? `${s.sym} none` : `${s.sym} ${s.qt} (${age(s.ms)})`)).join(', ')}`);
  else if (stamps.length) {
    const oldest = stamps.reduce((a, b) => (b.ms < a.ms ? b : a));
    notes.push(`oldest stamp ${oldest.qt} (${age(oldest.ms)})`);
  }
  if (r.seenError) notes.push(`${SEEN} not written: ${r.seenError}`);
  if ((r.attempts || 1) > 1) notes.push(`after ${r.attempts} attempts`);
  const problem = !!r.seenError || old.length > 0 || (fresh.closeRun && failed.length > 0);
  const what = r.dryRun ? `dry run, nothing written (${r.lines} lines would have been)` : r.lines ? `wrote ${r.recorded.join(' ')}: ${r.lines} lines, ${r.contracts} contracts`
    : failed.length === symbols.length ? 'nothing fetched' : 'nothing new';
  const level = problem ? 'PROBLEM' : 'ok';
  return { level, problem, line: `${iso(at).slice(0, 19)}Z ${level} chain-record: ${[what, ...notes].join('; ')}` };
}

// One tape line per expiry. Pure: `at` is passed in, never read from a clock here.
function tapeLines(chain, { at, hash }) {
  const today = etDay(at);
  const out = [];
  for (const exp of [...chain.byExpiry.keys()].sort()) {
    const e = chain.byExpiry.get(exp);
    if (!e.calls.length && !e.puts.length) continue;
    out.push({
      t: iso(at), sym: chain.symbol, spot: chain.spot,
      sb: chain.spotBid, sa: chain.spotAsk, sbz: chain.spotBidSz, saz: chain.spotAskSz,
      qt: chain.quoteAt, exp, dte: daysToExpiry(exp, today), h: hash.slice(0, 12),
      // The band was wanted and could not be measured (no spot in the response), so this line holds
      // EVERY strike while the header says otherwise. Marked rather than dropped: the quotes are
      // real and unrepeatable, and a reader has to be able to tell this line from a filtered one.
      ...(chain.bandAsked > 0 && !chain.bandApplied ? { nb: true } : {}),
      c: e.calls, p: e.puts,
    });
  }
  return out;
}

function headerLine({ at, band, maxDte, symbols }) {
  return {
    v: 1, cols: CHAIN_COLS, startedAt: iso(at), source: 'cboe-delayed-quotes', symbols, band, maxDte,
    note: 'one line per symbol per expiry per snapshot; c=calls p=puts, each contract an array in `cols` order; '
      + 'null means Cboe did not quote it, a 0 bid is a real quote; t=fetched at, qt=Cboe file stamp, h=content hash; '
      + 'nb=true means this line could NOT be band-filtered (no spot in the response) and holds every strike; '
      + `strikes outside ±${Math.round(band * 100)}% of spot and expiries beyond ${maxDte} days were not recorded; `
      + 'quotes are delayed ~15 minutes',
  };
}

// ------------------------------------------------------------------ the disk half
function readSeen(dir, { io = fs } = {}) {
  try { return JSON.parse(io.readFileSync(path.join(dir, SEEN), 'utf8')); } catch { return {}; }
}
function writeSeen(dir, seen, { io = fs } = {}) {
  io.mkdirSync(dir, { recursive: true });
  io.writeFileSync(path.join(dir, SEEN), JSON.stringify(seen, null, 1));
}

function appendLines(dir, at, lines, { io = fs, header = null } = {}) {
  if (!lines.length) return { file: null, bytes: 0, fresh: false };
  io.mkdirSync(dir, { recursive: true });
  // Eastern, matching src/recorder.js's tick tapes: a UTC filename would cut a session's own
  // afternoon into the next day's file from 20:00 ET.
  const file = path.join(dir, `chains-${etDay(at)}.jsonl`);
  const fresh = !!header && !io.existsSync(file);
  const text = (fresh ? [JSON.stringify(header)] : []).concat(lines.map((l) => JSON.stringify(l))).join('\n') + '\n';
  io.appendFileSync(file, text);
  return { file, bytes: Buffer.byteLength(text), fresh };
}

// One pass over the universe. Returns what it wrote, so --every can report per round.
// `tries` passes through to the session: the whole-run retries (recordRun) ask each symbol once.
async function snapshot(session, { symbols, dir, band, maxDte, again = false, dryRun = false, now = Date.now, log = () => {}, io = fs, tries } = {}) {
  const at = now();
  const today = etDay(at);
  const seen = readSeen(dir, { io });
  const lines = [];
  let contracts = 0;
  // `quotes` is Cboe's stamp for every symbol that answered, recorded or not, so verdict() can
  // judge the feed's age even on a run that wrote nothing; `failed` and `stale` are the reasons
  // it can raise a PROBLEM on.
  const skipped = [], recorded = [], failed = [], stale = [], quotes = {};
  let restamped = false;
  for (const sym of symbols) {
    try {
      const chain = await session.chain(sym, { band, maxDte, today, ...(tries ? { tries } : {}) });
      if (chain.quoteAt) quotes[sym] = chain.quoteAt;
      const prev = seen[sym];
      const hash = chainHash(chain);
      const exps = expiryHashes(chain);
      // the whole point: an unchanged chain is not news, whatever the feed's own clock claims --
      // and whatever today's date filter makes of it (2026-09-24: 70 lines of a frozen file written)
      if (!again && prev && (prev.hash === hash || sameQuotes(prev, chain, exps))) {
        // the very file the last run saw: Cboe has not rebuilt it since
        if (chain.quoteAt && prev.qt === chain.quoteAt) { skipped.push(`${sym} (STALE: Cboe file still stamped ${chain.quoteAt})`); stale.push(sym); }
        else {
          skipped.push(`${sym} (unchanged since ${prev.at})`);
          // Rebuilt with the same quotes: remember the new stamp, so a feed that freezes on THIS
          // file is called STALE by the next run, not "unchanged" for ever. Only the stamp moves;
          // the hashes, and `at` (when it was last recorded), stay those of the tape's own line.
          if (chain.quoteAt) { seen[sym] = { ...prev, qt: chain.quoteAt }; restamped = true; }
        }
        continue;
      }
      const rows = tapeLines(chain, { at, hash });
      if (!rows.length) { skipped.push(`${sym} (nothing inside the filters)`); continue; }
      for (const r of rows) contracts += r.c.length + r.p.length;
      lines.push(...rows);
      seen[sym] = { hash, qt: chain.quoteAt, at: iso(at), spot: chain.spot, expiries: rows.length, kept: chain.kept, seen: chain.seen, exps };
      recorded.push(sym);
    } catch (e) {
      // One symbol refusing must not cost the other five their snapshot. The cause's code rides
      // along: 09-23 16:25 logged a bare 'fetch failed' six times, and whether that was DNS, a
      // refused connection or a timeout cannot now be told.
      const cause = e && e.cause && (e.cause.code || e.cause.message);
      const why = `${String(e && e.message)}${cause ? `: ${cause}` : ''}`.slice(0, 80);
      failed.push({ sym, why });
      skipped.push(`${sym} (${why})`);
    }
  }
  const base = { at, recorded, skipped, failed, stale, quotes };
  if (!lines.length) {
    // Nothing to append, but a new stamp to remember. Safe without a tape write: no hash changes,
    // so this can never make a later run skip a snapshot that was not kept.
    let seenError = '';
    if (restamped && !dryRun) { try { writeSeen(dir, seen, { io }); } catch (e) { seenError = String(e && e.message).slice(0, 120); } }
    return { ...base, lines: 0, contracts: 0, file: null, bytes: 0, fresh: false, ...(seenError ? { seenError } : {}) };
  }
  // A dry run proves the whole path -- the fetch, the filters, the hashing -- and touches neither
  // the tape nor the seen file, so it cannot make the next real run skip a snapshot as "unchanged".
  if (dryRun) return { ...base, lines: lines.length, contracts, file: null, bytes: 0, fresh: false, dryRun: true };
  const w = appendLines(dir, at, lines, { io, header: headerLine({ at, band, maxDte, symbols }) });
  // Written only after the tape is safely on disk: a crash between the two must re-record, never
  // skip a snapshot it did not actually keep. Caught, because the tape IS written by this point --
  // letting it throw reports a failed snapshot for a successful one, and hides which file is at
  // fault while every later run silently appends a duplicate of this same snapshot.
  let seenError = '';
  try { writeSeen(dir, seen, { io }); }
  catch (e) { seenError = String(e && e.message).slice(0, 120); }
  return { ...base, lines: lines.length, contracts, ...w, ...(seenError ? { seenError } : {}) };
}

// A snapshot, and if every symbol failed, the whole run again after a wait (RUN_RETRIES times).
// A run where even one symbol answered is not retried: the feed is up, and the ones that failed
// are named in the verdict.
async function recordRun(session, opts, { retries = RUN_RETRIES, waitMs = RUN_RETRY_MS, wait = sleep, log = () => {} } = {}) {
  for (let attempt = 1; ; attempt++) {
    const r = await snapshot(session, attempt > 1 ? { ...opts, tries: 1 } : opts);
    r.attempts = attempt;
    const allFailed = opts.symbols.length > 0 && r.failed.length === opts.symbols.length;
    if (!allFailed || attempt > retries) return r;
    log(`  every symbol failed; the whole run again in ${Math.round(waitMs / 1000)}s (${attempt} of ${retries + 1})`);
    await wait(waitMs);
  }
}

function appendLog(dir, line, { io = fs } = {}) {
  io.mkdirSync(dir, { recursive: true });
  io.appendFileSync(path.join(dir, LOG), line + '\n');
}

// --check, for ops/daily-check.sh: read-only. The last line of chains.log; the newest Cboe stamp
// per symbol in the newest tape; and whether the last finished weekday (from 17:00 Eastern that
// day) has a quote stamped that day for every symbol, in that day's own file. The last is the
// question that matters: 09-23 has none, and a lost session is only worth hearing about while
// the next one can still be saved. Returns the lines to print and how many are problems.
function checkTape(dir, { now = Date.now(), io = fs, symbols = SYMBOLS } = {}) {
  const out = [];
  let problems = 0;
  let last = '';
  try { last = io.readFileSync(path.join(dir, LOG), 'utf8').trim().split('\n').pop() || ''; } catch { /* reported below */ }
  if (!last) { out.push(`PROBLEM: no ${path.join(dir, LOG)} yet -- the recorder has not run since it began writing one`); problems++; }
  else {
    out.push(`last run: ${last}`);
    if (/ PROBLEM /.test(last)) problems++;
  }
  const t = readTape(dir, { io, now: () => now });
  if (!t.ok) out.push(`newest tape: ${t.why}`);
  else {
    out.push(`newest tape ${t.file}, newest Cboe stamp per symbol:`);
    for (const s of t.symbols) {
      const ms = stampMs(s.qt);
      out.push(`  ${s.sym.padEnd(4)} ${s.qt || 'none'}${ms === null ? '' : ` UTC (${((now - ms) / 3600000).toFixed(1)}h old)`}, fetched ${s.at}`);
    }
    const absent = symbols.filter((sym) => !t.symbols.some((s) => s.sym === sym));
    if (absent.length) out.push(`  not in this file: ${absent.join(' ')}`);
  }
  const day = (lastWeekdayAt(now, 17) || {}).day;
  if (day) {
    const have = new Set();
    let text = null;
    try { text = io.readFileSync(path.join(dir, `chains-${day}.jsonl`), 'utf8'); } catch { /* no file that day */ }
    for (const l of String(text || '').split('\n')) {
      if (!l || l[0] !== '{') continue;
      let r;
      try { r = JSON.parse(l); } catch { continue; }
      const ms = stampMs(r.qt);
      if (r.sym && ms !== null && etDay(ms) === day) have.add(r.sym);
    }
    const missing = symbols.filter((s) => !have.has(s));
    if (text === null) { out.push(`PROBLEM: ${day} has no tape at all (chains-${day}.jsonl); a market holiday is the one innocent reason`); problems++; }
    else if (missing.length) { out.push(`PROBLEM: ${day} has no quote stamped that day for ${missing.join(' ')}; a market holiday is the one innocent reason`); problems++; }
    else out.push(`${day}: every symbol has a quote stamped that day`);
  }
  return { lines: out, problems };
}

module.exports = {
  SYMBOLS, DIR, BAND, MAX_DTE, SEEN, LOG, STALE_HOURS, RUN_RETRIES, chainHash, expiryHashes, sameQuotes, stampMs, lastWeekdayAt, freshSince, verdict,
  tapeLines, headerLine, appendLines, readSeen, writeSeen, snapshot, recordRun, appendLog, checkTape, etDay,
};

if (require.main === module) {
  (async () => {
    const args = process.argv.slice(2);
    const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
    const symbols = flag('only') ? flag('only').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean) : SYMBOLS;
    // A non-finite flag turns its filter OFF (`band > 0` is false for NaN) and writes the NaN into
    // the header as null, with a note reading "outside +/-NaN% of spot". `--dte 45d` reads as
    // valid and is not. The tape cannot be re-collected, so this refuses rather than guesses.
    const numFlag = (name, d) => {
      const raw = flag(name, null);
      if (raw === null) return d;
      const v = Number(raw);
      if (!Number.isFinite(v) || v < 0) {
        console.error(`--${name} must be a number, not ${JSON.stringify(raw)}. Nothing was recorded.`);
        process.exit(2);
      }
      return v;
    };
    const band = numFlag('band', BAND);
    const maxDte = numFlag('dte', MAX_DTE);
    const dir = flag('dir', DIR);
    const again = args.includes('--again');
    const dryRun = args.includes('--dry-run');
    const every = numFlag('every', 0);
    if (args.includes('--check')) {
      const c = checkTape(dir, { symbols });
      for (const l of c.lines) console.log(l);
      process.exit(c.problems ? 1 : 0);
    }
    const session = makeSession();
    // The run's verdict line is printed LAST, and src/chainsched.js reads the last lines: on the box
    // that is how a PROBLEM or an all-stale run reaches the dashboard's tabs. It also goes to
    // chains.log (not on a dry run, which writes nothing), and a PROBLEM makes the exit non-zero,
    // so `launchctl list` shows it where 09-23 showed 0.
    const settle = (line, problem) => {
      console.log(`  ${line}`);
      if (dryRun) return;
      try { appendLog(dir, line); } catch (e) { console.log(`  (and ${LOG} could not be written: ${e.message})`); }
      if (problem) process.exitCode = 1;
    };
    for (;;) {
      const t0 = Date.now();
      console.log(`\n${iso(t0)}  ${symbols.join(' ')}  ±${Math.round(band * 100)}%  ≤${maxDte}d`);
      try {
        const r = await recordRun(session, { symbols, dir, band, maxDte, again, dryRun, log: console.log }, { log: console.log });
        if (r.dryRun) console.log(`  dry run: ${r.recorded.join(' ')} · ${r.lines} lines, ${r.contracts} contracts would be written · nothing was`);
        else if (r.lines) console.log(`  ${r.recorded.join(' ')} · ${r.lines} lines, ${r.contracts} contracts, ${(r.bytes / 1024).toFixed(0)} KB → ${r.file}${r.fresh ? ' (new file)' : ''}`);
        else console.log('  nothing new to record');
        if (r.skipped.length) console.log(`  skipped: ${r.skipped.join(', ')}`);
        if (r.seenError) console.log(`  WARNING: the tape was written but ${SEEN} could not be: ${r.seenError}\n  every later run will re-record this same snapshot until that file is writable again`);
        const v = verdict(r, { symbols });
        settle(v.line, v.problem);
      } catch (e) {
        console.log(`  snapshot failed: ${e.message}`);
        settle(`${iso(Date.now()).slice(0, 19)}Z PROBLEM chain-record: snapshot failed: ${String(e && e.message).slice(0, 120)}`, true);
      }
      if (!(every > 0)) break;
      const wait = Math.max(1000, every * 60000 - (Date.now() - t0));
      console.log(`  next in ${Math.round(wait / 60000)} min`);
      await sleep(wait);
    }
  })();
}

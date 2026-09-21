'use strict';
// The chain tape: live option chains, appended to data/chains/chains-YYYY-MM-DD.jsonl.
//
//   node tools/chain-record.js                  # one snapshot of the universe below, now
//   node tools/chain-record.js --every 30       # ... and again every 30 minutes, until killed
//   node tools/chain-record.js --only SPY --dte 45 --band 0.2
//   node tools/chain-record.js --again          # record even if nothing has changed since last time
//   node tools/chain-record.js --dry-run        # fetch and report, write nothing (ops/install-chains.sh uses this)
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
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { makeSession, daysToExpiry, CHAIN_COLS } = require('../src/venues/cboe');
const { ET_DAY } = require('../src/recorder');

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
const BAND = 0.30;
const MAX_DTE = 70;

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
async function snapshot(session, { symbols, dir, band, maxDte, again = false, dryRun = false, now = Date.now, log = () => {}, io = fs } = {}) {
  const at = now();
  const today = etDay(at);
  const seen = readSeen(dir, { io });
  const lines = [];
  let contracts = 0;
  const skipped = [], recorded = [];
  for (const sym of symbols) {
    try {
      const chain = await session.chain(sym, { band, maxDte, today });
      const hash = chainHash(chain);
      // the whole point: an unchanged chain is not news, whatever the feed's own clock claims
      if (!again && seen[sym] && seen[sym].hash === hash) { skipped.push(`${sym} (unchanged since ${seen[sym].at})`); continue; }
      const rows = tapeLines(chain, { at, hash });
      if (!rows.length) { skipped.push(`${sym} (nothing inside the filters)`); continue; }
      for (const r of rows) contracts += r.c.length + r.p.length;
      lines.push(...rows);
      seen[sym] = { hash, at: iso(at), spot: chain.spot, expiries: rows.length, kept: chain.kept, seen: chain.seen };
      recorded.push(sym);
    } catch (e) {
      // One symbol refusing must not cost the other five their snapshot.
      skipped.push(`${sym} (${String(e.message).slice(0, 60)})`);
    }
  }
  if (!lines.length) return { at, lines: 0, contracts: 0, recorded, skipped, file: null, bytes: 0, fresh: false };
  // A dry run proves the whole path -- the fetch, the filters, the hashing -- and touches neither
  // the tape nor the seen file, so it cannot make the next real run skip a snapshot as "unchanged".
  if (dryRun) return { at, lines: lines.length, contracts, recorded, skipped, file: null, bytes: 0, fresh: false, dryRun: true };
  const w = appendLines(dir, at, lines, { io, header: headerLine({ at, band, maxDte, symbols }) });
  // Written only after the tape is safely on disk: a crash between the two must re-record, never
  // skip a snapshot it did not actually keep. Caught, because the tape IS written by this point --
  // letting it throw reports a failed snapshot for a successful one, and hides which file is at
  // fault while every later run silently appends a duplicate of this same snapshot.
  let seenError = '';
  try { writeSeen(dir, seen, { io }); }
  catch (e) { seenError = String(e && e.message).slice(0, 120); }
  return { at, lines: lines.length, contracts, recorded, skipped, ...w, ...(seenError ? { seenError } : {}) };
}

module.exports = { SYMBOLS, DIR, BAND, MAX_DTE, SEEN, chainHash, tapeLines, headerLine, appendLines, readSeen, writeSeen, snapshot, etDay };

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
    const session = makeSession();
    for (;;) {
      const t0 = Date.now();
      console.log(`\n${iso(t0)}  ${symbols.join(' ')}  ±${Math.round(band * 100)}%  ≤${maxDte}d`);
      try {
        const r = await snapshot(session, { symbols, dir, band, maxDte, again, dryRun, log: console.log });
        if (r.dryRun) console.log(`  dry run: ${r.recorded.join(' ')} · ${r.lines} lines, ${r.contracts} contracts would be written · nothing was`);
        else if (r.lines) console.log(`  ${r.recorded.join(' ')} · ${r.lines} lines, ${r.contracts} contracts, ${(r.bytes / 1024).toFixed(0)} KB → ${r.file}${r.fresh ? ' (new file)' : ''}`);
        else console.log('  nothing new to record');
        if (r.skipped.length) console.log(`  skipped: ${r.skipped.join(', ')}`);
        if (r.seenError) console.log(`  WARNING: the tape was written but ${SEEN} could not be: ${r.seenError}\n  every later run will re-record this same snapshot until that file is writable again`);
      } catch (e) {
        console.log(`  snapshot failed: ${e.message}`);
      }
      if (!(every > 0)) break;
      const wait = Math.max(1000, every * 60000 - (Date.now() - t0));
      console.log(`  next in ${Math.round(wait / 60000)} min`);
      await sleep(wait);
    }
  })();
}

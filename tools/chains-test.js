'use strict';
// Assertions for the chain tape -- no network, no wall clock.
//
// This is a data collector, and the only failure that matters is a quiet one. A tape that looks
// full but has lost the difference between "not quoted" and "a zero bid", or that has silently
// dropped the adjusted contracts, or that is three hundred copies of Friday, is worse than no tape
// at all: the mistake surfaces in a year, when the data is finally wanted and cannot be
// re-collected. So these lean on the parsing, the de-duplication and the file format rather than on
// the fetching.
//
//   node tools/chains-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { makeSession, parseChain, parseOsi, daysToExpiry, CHAIN_COLS } = require('../src/venues/cboe');
const { chainHash, tapeLines, headerLine, appendLines, readSeen, writeSeen, snapshot, etDay, SEEN, SYMBOLS } = require('./chain-record');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'chains-'));

// noon in New York on 2026-09-21, when the Eastern and UTC dates agree
const NOW = Date.UTC(2026, 8, 21, 16, 0, 0);
const TODAY = '2026-09-21';

// A Cboe delayed-quote response, shaped exactly like the captured one.
function fixture({ symbol = 'TEST', spot = 100, strikes = [70, 85, 90, 100, 110, 115, 130],
  expiries = ['260925', '261120', '270320'], timestamp = '2026-09-21 20:04:11', root = null } = {}) {
  const options = [];
  for (const e of expiries) {
    for (const k of strikes) {
      for (const right of ['C', 'P']) {
        const pad = String(Math.round(k * 1000)).padStart(8, '0');
        options.push({
          option: `${root || symbol}${e}${right}${pad}`,
          // strike 130 is the "Cboe did not say" case; strike 70 is a real, quoted zero
          bid: k === 130 ? undefined : (k === 70 ? 0 : k / 100),
          bid_size: k === 130 ? undefined : 46, ask: k / 100 + 0.02, ask_size: 160,
          iv: 0.20812345, open_interest: 3487, volume: 0,
          delta: 0.87034321, gamma: 0.00271234, vega: 0.8311111, theta: -0.0906111, rho: 1.4038111,
          theo: 85.50914321, last_trade_price: 76.47,
          last_trade_time: k === 130 ? null : '2026-09-18T16:14:25',
        });
      }
    }
  }
  return { timestamp, symbol, data: { options, symbol, current_price: spot, bid: spot + 0.01, ask: spot + 0.02, bid_size: 12, ask_size: 34 } };
}

group('parseOsi: the symbol is read from the right');
{
  ok('a plain root', JSON.stringify(parseOsi('SPY261218C00690000')) === JSON.stringify({ root: 'SPY', expiry: '2026-12-18', right: 'C', strike: 690 }), parseOsi('SPY261218C00690000'));
  // an adjusted contract after a split carries a digit in the root; anchoring on letters drops
  // exactly the contracts whose pricing is most unusual
  ok('a root with a digit in it still parses', (parseOsi('QQQ1260921P00450000') || {}).root === 'QQQ1', parseOsi('QQQ1260921P00450000'));
  ok('a weekly root parses', (parseOsi('SPXW261002P06300000') || {}).strike === 6300, parseOsi('SPXW261002P06300000'));
  ok('strike is thousandths', (parseOsi('SPY261218C00007500') || {}).strike === 7.5, parseOsi('SPY261218C00007500'));
  ok('a fractional strike survives', (parseOsi('TLT261218C00081500') || {}).strike === 81.5, parseOsi('TLT261218C00081500'));
  ok('rubbish is null, not a guess', parseOsi('garbage') === null);
  ok('empty is null', parseOsi('') === null && parseOsi(null) === null);
  ok('a zero strike is refused', parseOsi('SPY261218C00000000') === null);
}

group('parseChain: the response → tape rows');
{
  const c = parseChain(fixture(), {});
  ok('symbol', c.symbol === 'TEST', c.symbol);
  ok('spot', c.spot === 100, c.spot);
  ok('the underlying quote and its depth ride along', c.spotBid === 100.01 && c.spotBidSz === 12 && c.spotAskSz === 34, [c.spotBid, c.spotBidSz, c.spotAskSz]);
  ok('Cboe’s own file stamp is kept', c.quoteAt === '2026-09-21 20:04:11', c.quoteAt);
  ok('one bucket per expiry', c.byExpiry.size === 3, c.byExpiry.size);
  const e = c.byExpiry.get('2026-09-25');
  ok('calls and puts are split', e.calls.length === 7 && e.puts.length === 7, [e.calls.length, e.puts.length]);
  ok('a row is the frozen column count', e.calls[0].length === CHAIN_COLS.length, e.calls[0].length);
  ok('rows sort by strike', e.calls.map((r) => r[0]).join() === '70,85,90,100,110,115,130', e.calls.map((r) => r[0]));
  const zero = e.calls.find((r) => r[0] === 70);
  const unquoted = e.calls.find((r) => r[0] === 130);
  ok('a real 0 bid stays 0', zero[1] === 0, zero[1]);
  ok('an unquoted bid is null, not 0', unquoted[1] === null, unquoted[1]);
  ok('an unquoted size is null too', unquoted[2] === null, unquoted[2]);
  ok('bid size is kept -- Yahoo has none and a fill model needs it', zero[2] === 46, zero[2]);
  ok('greeks survive at four decimals', zero[7] === 0.8703 && zero[10] === -0.0906, [zero[7], zero[10]]);
  ok('gamma keeps six, being small', zero[8] === 0.002712, zero[8]);
  ok('a never-traded contract has a null last trade time', unquoted[15] === null, unquoted[15]);
  ok('and a traded one keeps Cboe’s string as given', zero[15] === '2026-09-18T16:14:25', zero[15]);
  ok('seen and kept are counted', c.seen === 42 && c.kept === 42, [c.seen, c.kept]);
}

group('parseChain: the filters');
{
  const b = parseChain(fixture(), { band: 0.15 });
  const e = b.byExpiry.get('2026-09-25');
  ok('keeps only strikes inside ±15% of spot', e.calls.map((r) => r[0]).join() === '85,90,100,110,115', e.calls.map((r) => r[0]));
  // 100*(1+0.15) is 114.99999999999999 in floating point; a strike exactly on the edge must not
  // fall out of it, and the edges of a round band are struck strikes, not wings
  ok('the band edges are inclusive', e.calls.some((r) => r[0] === 115) && e.calls.some((r) => r[0] === 85), e.calls.map((r) => r[0]));
  ok('kept is lower than seen once filtered', b.kept === 30 && b.seen === 42, [b.kept, b.seen]);

  const d = parseChain(fixture(), { maxDte: 70, today: TODAY });
  ok('drops expiries past the day limit', d.byExpiry.size === 2, [...d.byExpiry.keys()]);
  ok('and keeps the near ones', d.byExpiry.has('2026-09-25') && d.byExpiry.has('2026-11-20'), [...d.byExpiry.keys()]);

  // Cboe keeps this morning's expiry in the file for a while; it is settled and teaches nothing
  const past = parseChain(fixture({ expiries: ['260918', '260925'] }), { maxDte: 70, today: TODAY });
  ok('an already-expired expiry is dropped', past.byExpiry.size === 1 && past.byExpiry.has('2026-09-25'), [...past.byExpiry.keys()]);

  // Without spot there is nothing to measure a band from. Dropping the chain would look like a
  // quiet market; keeping it whole is the honest failure.
  const noSpot = parseChain(fixture({ spot: null }), { band: 0.15 });
  ok('no spot → the band is not applied rather than emptying the chain', noSpot.byExpiry.get('2026-09-25').calls.length === 7, noSpot.kept);
  ok('no spot → spot is null, not 0', noSpot.spot === null, noSpot.spot);

  ok('a malformed contract is dropped, not guessed', parseChain({ data: { options: [{ option: 'nonsense', bid: 1 }], symbol: 'X' } }, {}).kept === 0);
  let threw = null;
  try { parseChain({}, {}); } catch (e2) { threw = e2.message; }
  ok('a body with no data throws rather than returning an empty chain', /no option data/.test(threw || ''), threw);
}

group('daysToExpiry: dates, not timestamps');
{
  ok('an expiry today is 0, not -1', daysToExpiry(TODAY, TODAY) === 0, daysToExpiry(TODAY, TODAY));
  ok('four days out', daysToExpiry('2026-09-25', TODAY) === 4);
  ok('yesterday is negative', daysToExpiry('2026-09-20', TODAY) === -1);
  ok('across a month end', daysToExpiry('2026-11-20', TODAY) === 60);
  ok('a missing side is null, not 0', daysToExpiry(null, TODAY) === null && daysToExpiry(TODAY, null) === null);
}

group('chainHash: what counts as news');
{
  const a = parseChain(fixture(), {});
  const b = parseChain(fixture(), {});
  ok('the same chain hashes the same', chainHash(a) === chainHash(b));
  ok('a different spot is news', chainHash(parseChain(fixture({ spot: 101 }), {})) !== chainHash(a));
  ok('a different quote is news', chainHash(parseChain(fixture({ strikes: [70, 85, 90, 100, 110, 115, 131] }), {})) !== chainHash(a));
  // the feed's own clock moves on a weekend while nothing behind it does
  ok('a new file stamp alone is NOT news', chainHash(parseChain(fixture({ timestamp: '2026-09-22 09:00:00' }), {})) === chainHash(a));
  ok('a different symbol is news', chainHash(parseChain(fixture({ symbol: 'OTHER' }), {})) !== chainHash(a));
}

group('tapeLines: one line per expiry');
{
  const c = parseChain(fixture(), { maxDte: 70, today: TODAY });
  const h = chainHash(c);
  const lines = tapeLines(c, { at: NOW, hash: h });
  ok('one line per expiry kept', lines.length === 2, lines.length);
  ok('lines come out in expiry order', lines[0].exp < lines[1].exp, lines.map((l) => l.exp));
  ok('t is the moment of the snapshot', lines[0].t === new Date(NOW).toISOString(), lines[0].t);
  ok('qt is Cboe’s own stamp, and they are distinguishable', lines[0].qt === '2026-09-21 20:04:11' && lines[0].qt !== lines[0].t);
  ok('days to expiry is on the line', lines[0].dte === 4 && lines[1].dte === 60, lines.map((l) => l.dte));
  ok('no line carries a negative dte', lines.every((l) => l.dte >= 0));
  ok('the hash prefix is on every line of the snapshot', lines.every((l) => l.h === h.slice(0, 12)), lines.map((l) => l.h));
  ok('calls and puts ride as c and p', Array.isArray(lines[0].c) && Array.isArray(lines[0].p));
}

group('the file: Eastern day, header once');
{
  const dir = tmp();
  const c = parseChain(fixture(), { maxDte: 70, today: TODAY });
  const lines = tapeLines(c, { at: NOW, hash: chainHash(c) });
  const header = headerLine({ at: NOW, band: 0.3, maxDte: 70, symbols: SYMBOLS });
  const a = appendLines(dir, NOW, lines, { header });
  ok('the filename is the Eastern day', path.basename(a.file) === 'chains-2026-09-21.jsonl', path.basename(a.file));
  ok('a new file is marked as new', a.fresh === true);
  const b = appendLines(dir, NOW, lines, { header });
  ok('appending again does not re-write the header', b.fresh === false);
  const body = fs.readFileSync(a.file, 'utf8').trim().split('\n');
  ok('header plus two snapshots of two expiries', body.length === 5, body.length);
  const hdr = JSON.parse(body[0]);
  ok('the header carries the column order, so the file explains itself', hdr.cols.join() === CHAIN_COLS.join(), hdr.cols);
  ok('the header records what was filtered out', hdr.band === 0.3 && hdr.maxDte === 70, [hdr.band, hdr.maxDte]);
  ok('the header names the source', /cboe/.test(hdr.source), hdr.source);
  ok('every line is valid JSON', body.every((l) => { try { JSON.parse(l); return true; } catch { return false; } }));
  // 02:00 UTC on the 22nd is 22:00 ET on the 21st
  const evening = appendLines(dir, Date.UTC(2026, 8, 22, 2, 0, 0), lines, { header });
  ok('an evening snapshot stays in the Eastern day’s file', path.basename(evening.file) === 'chains-2026-09-21.jsonl', path.basename(evening.file));
  ok('nothing to write creates no file', appendLines(tmp(), NOW, [], { header }).file === null);
  ok('etDay is Eastern, not UTC', etDay(Date.UTC(2026, 8, 22, 2, 0, 0)) === '2026-09-21', etDay(Date.UTC(2026, 8, 22, 2, 0, 0)));
  fs.rmSync(dir, { recursive: true, force: true });
}

group('the seen file');
{
  const dir = tmp();
  ok('a missing seen file reads as empty, not a crash', JSON.stringify(readSeen(dir)) === '{}');
  writeSeen(dir, { SPY: { hash: 'abc', at: 'x' } });
  ok('it round-trips', readSeen(dir).SPY.hash === 'abc');
  fs.writeFileSync(path.join(dir, SEEN), '{ not json');
  ok('a corrupt seen file reads as empty rather than stopping the run', JSON.stringify(readSeen(dir)) === '{}');
  fs.rmSync(dir, { recursive: true, force: true });
}

// Everything below is async and is awaited in order rather than fired off: an un-awaited block
// races the exit at the bottom, and assertions that never ran look exactly like ones that passed.
async function dedupe() {
  group('snapshot: an unchanged chain is not news');
  const dir = tmp();
  const session = { chain: async (sym, o) => parseChain(fixture({ symbol: sym }), o) };
  const opts = { symbols: ['AAA'], dir, band: 0, maxDte: 70, now: () => NOW, log: () => {} };
  const one = await snapshot(session, opts);
  ok('the first snapshot records', one.lines === 2 && one.recorded.join() === 'AAA', [one.lines, one.recorded]);
  const two = await snapshot(session, opts);
  ok('the identical second snapshot is skipped', two.lines === 0 && two.file === null, [two.lines, two.file]);
  ok('and says why', two.skipped.some((s) => /unchanged/.test(s)), two.skipped);
  const forced = await snapshot(session, { ...opts, again: true });
  ok('--again overrides the skip', forced.lines === 2, forced.lines);

  // a dry run must not poison the next real one by marking a snapshot it never wrote
  const dirD = tmp();
  const dry = await snapshot(session, { ...opts, dir: dirD, dryRun: true });
  ok('a dry run reports what it would write', dry.lines === 2 && dry.dryRun === true, [dry.lines, dry.dryRun]);
  ok('and writes no tape', dry.file === null && !fs.readdirSync(dirD).some((f) => f.endsWith('.jsonl')), fs.readdirSync(dirD));
  ok('and no seen file, so the next real run still records', JSON.stringify(readSeen(dirD)) === '{}', readSeen(dirD));
  ok('the real run after a dry one does record', (await snapshot(session, { ...opts, dir: dirD })).lines === 2);
  fs.rmSync(dirD, { recursive: true, force: true });

  const moved = { chain: async (sym, o) => parseChain(fixture({ symbol: sym, spot: 101 }), o) };
  const three = await snapshot(moved, opts);
  ok('a moved market records again', three.lines === 2, three.lines);
  const body = fs.readFileSync(three.file, 'utf8').trim().split('\n');
  ok('the tape holds header + 3 recorded snapshots', body.length === 7, body.length);
  ok('the skipped one left no trace', new Set(body.slice(1).map((l) => JSON.parse(l).h)).size === 2, body.slice(1).map((l) => JSON.parse(l).h));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function resilience() {
  group('snapshot: one bad symbol must not cost the others');
  const dir = tmp();
  const seen = [];
  const session = {
    chain: async (sym, o) => {
      seen.push(sym);
      if (sym === 'BAD') throw new Error('HTTP 404');
      if (sym === 'EMPTY') return parseChain(fixture({ symbol: sym, expiries: ['270320'] }), { ...o, maxDte: 70, today: TODAY });
      return parseChain(fixture({ symbol: sym }), o);
    },
  };
  const r = await snapshot(session, { symbols: ['GOOD', 'BAD', 'EMPTY', 'ALSOGOOD'], dir, band: 0, maxDte: 70, now: () => NOW, log: () => {} });
  ok('both good symbols are recorded', r.recorded.join() === 'GOOD,ALSOGOOD', r.recorded);
  ok('the failing one is reported, not swallowed', r.skipped.some((s) => s.startsWith('BAD')), r.skipped);
  ok('the empty one is reported too', r.skipped.some((s) => /EMPTY.*nothing inside/.test(s)), r.skipped);
  ok('every symbol was still attempted', seen.join() === 'GOOD,BAD,EMPTY,ALSOGOOD', seen);
  ok('contracts are counted across both sides', r.contracts === 56, r.contracts);
  const kept = readSeen(dir);
  ok('only the recorded symbols enter the seen file', Object.keys(kept).join() === 'GOOD,ALSOGOOD', Object.keys(kept));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function crashSafety() {
  group('snapshot: the seen file must never run ahead of the tape');
  const dir = tmp();
  const session = { chain: async (sym, o) => parseChain(fixture({ symbol: sym }), o) };
  // a disk that refuses the tape write, exactly when the seen file has not been written yet
  const io = {
    ...fs,
    appendFileSync: () => { throw new Error('ENOSPC'); },
    writeFileSync: () => { throw new Error('writeSeen must not be reached'); },
  };
  let threw = null;
  try { await snapshot(session, { symbols: ['AAA'], dir, band: 0, maxDte: 70, now: () => NOW, log: () => {}, io }); } catch (e) { threw = e.message; }
  ok('a failed tape write surfaces rather than being marked recorded', threw === 'ENOSPC', threw);
  ok('and the seen file was never written', JSON.stringify(readSeen(dir)) === '{}', readSeen(dir));
  fs.rmSync(dir, { recursive: true, force: true });
}

async function network() {
  group('the session: what reaches the wire');
  const calls = [];
  const fake = async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => fixture({ symbol: 'SPY' }) }; };
  const s = makeSession({ fetchImpl: fake, pace: 0, retryMs: 1 });
  const c = await s.chain('SPY', { band: 0.15 });
  ok('one request per symbol -- every expiry arrives together', calls.length === 1, calls.length);
  ok('it is Cboe’s delayed-quote file', /cdn\.cboe\.com.*delayed_quotes\/options\/SPY\.json$/.test(calls[0].url), calls[0].url);
  ok('connection: close, as the CDN wants', calls[0].init.headers.connection === 'close', calls[0].init.headers);
  ok('the band is applied to what comes back', c.byExpiry.get('2026-09-25').calls.every((r) => Math.abs(r[0] / 100 - 1) <= 0.15 + 1e-9));

  let n = 0;
  const flaky = async () => (++n < 3 ? { status: 503, json: async () => ({}) } : { status: 200, json: async () => fixture({}) });
  const s2 = makeSession({ fetchImpl: flaky, pace: 0, retryMs: 1 });
  ok('a transient failure is retried', (await s2.chain('X')).symbol === 'TEST', n);
  const dead = makeSession({ fetchImpl: async () => ({ status: 500, json: async () => ({}) }), pace: 0, retryMs: 1 });
  let threw = null;
  try { await dead.chain('X'); } catch (e) { threw = e.message; }
  ok('a permanent failure gives up and says the status', /HTTP 500/.test(threw || ''), threw);
}

(async () => {
  await dedupe();
  await resilience();
  await crashSafety();
  await network();
  // exactly this shape: tools/test.js parses the last line, and treats a suite that exits 0
  // without it as having stopped early rather than as having passed
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`\nFAILED  the suite itself threw: ${e && e.stack}`); process.exit(1); });

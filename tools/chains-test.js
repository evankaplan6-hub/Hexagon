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
const { chainHash, tapeLines, headerLine, appendLines, readSeen, writeSeen, snapshot, etDay, SEEN, SYMBOLS, DIR } = require('./chain-record');
const { read: readTape, summarize, latestFile, tail, pickAtm } = require('../src/chaintape');

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

group('a line the band could not be applied to says so');
{
  // With no spot there is nothing to measure a band from, so every strike is kept while the file
  // header still records the band that was asked for. The line has to carry the difference: the
  // tape cannot be re-collected, and "the wings were filtered out" must not be confusable with
  // "the wings were never there".
  const asked = parseChain(fixture(), { band: 0.15 });
  ok('a band that applied is reported as applied', asked.bandApplied === true && asked.bandAsked === 0.15, [asked.bandAsked, asked.bandApplied]);
  const cant = parseChain(fixture({ spot: null }), { band: 0.15 });
  ok('a band that could not be measured is reported as asked but not applied', cant.bandAsked === 0.15 && cant.bandApplied === false, [cant.bandAsked, cant.bandApplied]);
  ok('and every strike really is kept', cant.byExpiry.get('2026-09-25').calls.length === 7, cant.kept);

  const okLine = tapeLines(asked, { at: NOW, hash: chainHash(asked) })[0];
  const nbLine = tapeLines(cant, { at: NOW, hash: chainHash(cant) })[0];
  ok('a filtered line carries no marker', okLine.nb === undefined, okLine.nb);
  ok('an unfiltered line is marked nb', nbLine.nb === true, nbLine.nb);
  // asking for no band at all is not the same as asking and failing
  const noBand = parseChain(fixture({ spot: null }), { band: 0 });
  ok('no band asked means no marker', tapeLines(noBand, { at: NOW, hash: chainHash(noBand) })[0].nb === undefined);
  ok('the header explains the marker, so the file reads itself', /nb=true/.test(headerLine({ at: NOW, band: 0.3, maxDte: 70, symbols: ['A'] }).note));
}

group('the default tape directory does not depend on where the command was run');
{
  // `data` on its own resolved against the CURRENT directory, so a run started from anywhere but
  // the repo wrote a day of irreplaceable chains where the dashboard never looks, and said it had
  // succeeded. It has to be the same absolute path server.js reads.
  ok('the default directory is absolute', path.isAbsolute(DIR), DIR);
  ok('and it is the repo’s own data/chains', DIR === path.join(__dirname, '..', 'data', 'chains'), DIR);
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

group('reading the tape back: the newest file, and only its tail');
{
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'chains-2026-09-18.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'chains-2026-09-21.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'chains-2026-09-19.jsonl'), '{}\n');
  fs.writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
  fs.writeFileSync(path.join(dir, SEEN), '{}');
  ok('the newest day wins', (latestFile(dir) || {}).name === 'chains-2026-09-21.jsonl', latestFile(dir));
  ok('a file that is not a tape is ignored', !/notes|seen/.test((latestFile(dir) || {}).name || ''));
  ok('a directory with no tape is null, not a throw', latestFile(path.join(dir, 'nope')) === null);

  const big = path.join(dir, 'chains-2026-09-21.jsonl');
  fs.writeFileSync(big, 'AAAA\nBBBB\nCCCC\nDDDD\n');
  ok('a tail bigger than the file is the whole file', tail(big, { maxBytes: 1e6 }).startsWith('AAAA'));
  // the cut lands mid-line; that fragment is not parseable and must be dropped, not repaired
  const cut = tail(big, { maxBytes: 12 });
  ok('a tail cut mid-line drops the fragment', !/^A|^BB/.test(cut) && cut.includes('DDDD'), cut);
  ok('an unreadable file is empty, not a throw', tail(path.join(dir, 'gone.jsonl')) === '');
  ok('no tape at all reads as ok:false with a reason', (() => { const r = readTape(path.join(dir, 'nope')); return r.ok === false && r.why === 'no tape yet' && r.symbols.length === 0; })());
  fs.rmSync(dir, { recursive: true, force: true });
}

group('summarize: newest line per symbol-expiry wins');
{
  const hdr = JSON.stringify(headerLine({ at: NOW, band: 0.3, maxDte: 70, symbols: ['AAA'] }));
  // same symbol+expiry twice: the LATER line (further down the file) is the truth
  const early = JSON.stringify({ t: '2026-09-21T14:00:00.000Z', sym: 'AAA', spot: 100, sb: 99.9, sa: 100.1, qt: 'x', exp: '2026-09-25', dte: 4, c: [[100, 1, 5, 1.1, 5, 1, 0.2, 0.5, 0, 0, 0, 0, 0, 7, 3, null]], p: [] });
  const late = JSON.stringify({ t: '2026-09-21T20:00:00.000Z', sym: 'AAA', spot: 101, sb: 100.9, sa: 101.1, qt: 'y', exp: '2026-09-25', dte: 4, c: [[100, 2, 5, 2.1, 5, 2, 0.3, 0.6, 0, 0, 0, 0, 0, 9, 4, null]], p: [] });
  // same snapshot as `late`, so it carries the same underlying quote -- tapeLines stamps every
  // line of a snapshot with it, and a fixture that omits it tests a file the recorder cannot write
  const other = JSON.stringify({ t: '2026-09-21T20:00:00.000Z', sym: 'AAA', spot: 101, sb: 100.9, sa: 101.1, qt: 'y', exp: '2026-11-20', dte: 60, c: [[100, 5, 1, 5.2, 1, 5, 0.4, 0.7, 0, 0, 0, 0, 0, 1, 0, null]], p: [] });
  const r = summarize([hdr, early, late, other, 'not json', ''].join('\n'), { now: NOW });
  ok('one entry per symbol', r.symbols.length === 1, r.symbols.length);
  const s0 = r.symbols[0];
  ok('the later line wins the spot', s0.spot === 101, s0.spot);
  ok('and the later quote', s0.sb === 100.9 && s0.qt === 'y', [s0.sb, s0.qt]);
  ok('both expiries are kept', s0.expiries.length === 2, s0.expiries.map((e) => e.exp));
  ok('expiries come out in date order', s0.expiries[0].exp < s0.expiries[1].exp);
  ok('the duplicate is not double-counted', s0.contracts === 2, s0.contracts);
  ok('distinct snapshots are counted', r.snapshots === 2, r.snapshots);
  ok('the header is picked up', r.header && r.header.band === 0.3 && r.header.maxDte === 70, r.header);
  ok('the column order comes back for the reader', (r.cols || []).length === CHAIN_COLS.length, r.cols);
  ok('a malformed line is skipped, not fatal', true);
  ok('empty text is an empty summary, not a throw', summarize('', { now: NOW }).symbols.length === 0);
  ok('the nearest expiry wins the atm strip', s0.atm && s0.atm.exp === '2026-09-25', s0.atm);
}

group('an expiry that settles today is the nearest one, not an unset one');
{
  // The bug this pins: `!s._atmDte` reads a days-to-expiry of 0 as "nothing chosen yet", so the
  // 0-dte expiry -- the one that matters most on an expiration day -- lost to whatever came next.
  const row = (t, exp, dte) => JSON.stringify({ t, sym: 'AAA', spot: 100, exp, dte,
    c: [[100, 1, 5, 1.1, 5, 1, 0.2, 0.5, 0, 0, 0, 0, 0, 7, 3, null]], p: [] });
  // newest snapshot carries only the same-day expiry; an older one in the same tail carries a later
  // one, so the 0-dte row is the FIRST the backwards walk sees
  const r = summarize([
    row('2026-09-21T14:00:00.000Z', '2026-09-25', 4),
    row('2026-09-21T20:00:00.000Z', '2026-09-21', 0),
  ].join('\n'), { now: NOW });
  ok('the 0-dte expiry wins the atm strip', r.symbols[0].atm.dte === 0, r.symbols[0].atm);
  ok('and it is the right expiry', r.symbols[0].atm.exp === '2026-09-21', r.symbols[0].atm.exp);
  // the ordinary way round still works: a nearer expiry seen later still takes it
  const r2 = summarize([
    row('2026-09-21T20:00:00.000Z', '2026-09-21', 0),
    row('2026-09-21T20:00:00.000Z', '2026-09-25', 4),
  ].join('\n'), { now: NOW });
  ok('a nearer expiry still wins when seen second', r2.symbols[0].atm.dte === 0, r2.symbols[0].atm);
}

group('a tape with no rows yet is empty, not broken');
{
  const dir = tmp();
  // the recorder writes the header when it creates the day's file; the first snapshot lands after
  fs.writeFileSync(path.join(dir, 'chains-2026-09-21.jsonl'), JSON.stringify(headerLine({ at: NOW, band: 0.3, maxDte: 70, symbols: ['AAA'] })) + '\n');
  const r = readTape(dir, { now: () => NOW });
  ok('it is not ok, because there is nothing to show', r.ok === false);
  ok('but it says the tape is empty, not unreadable', /no snapshots/.test(r.why || ''), r.why);
  ok('and it still names the file it found', /chains-2026-09-21/.test(r.file || ''), r.file);
  // a missing directory keeps its own, different wording
  ok('a missing tape still says so', readTape(path.join(dir, 'nope')).why === 'no tape yet');
  fs.rmSync(dir, { recursive: true, force: true });
}

group('pickAtm: the strike a person actually reads');
{
  const mk = (k, bid) => [k, bid, 5, bid + 0.1, 5, bid, 0.2, 0.5, 0, 0, 0, 0, 0, 11, 2, null];
  const r = { spot: 100.4, exp: '2026-09-25', dte: 4, c: [mk(95, 6), mk(100, 2), mk(105, 0.5)], p: [mk(95, 0.4), mk(100, 1.5)] };
  const a = pickAtm(r);
  ok('the strike nearest spot is chosen', a.k === 100, a.k);
  ok('the call side is carried', a.call.bid === 2 && a.call.ask === 2.1, a.call);
  ok('the put at the SAME strike is paired with it', a.put.bid === 1.5, a.put);
  ok('implied vol rides along', a.call.iv === 0.2 && a.call.delta === 0.5, a.call);
  ok('open interest and volume too', a.call.oi === 11 && a.call.vol === 2, a.call);
  // a strike quoted on one side only must not invent the other
  const oneSided = pickAtm({ spot: 105, exp: 'x', dte: 1, c: [mk(105, 1)], p: [mk(95, 1)] });
  ok('an unlisted put comes back null, not zero', oneSided.put === null, oneSided.put);
  ok('a chain with no calls is null', pickAtm({ spot: 100, c: [], p: [mk(100, 1)] }) === null);
  ok('no spot means no atm rather than a wrong one', pickAtm({ spot: null, c: [mk(100, 1)] }) === null);
  // ties: 100 and 101 are equidistant from 100.5 — the first wins, and it must be deterministic
  const tie = pickAtm({ spot: 100.5, exp: 'x', dte: 1, c: [mk(100, 1), mk(101, 1)], p: [] });
  ok('a tie resolves the same way every time', tie.k === pickAtm({ spot: 100.5, exp: 'x', dte: 1, c: [mk(100, 1), mk(101, 1)], p: [] }).k, tie.k);
}

group('the reader against a tape the recorder actually wrote');
{
  const dir = tmp();
  const c = parseChain(fixture({ symbol: 'AAA' }), { maxDte: 70, today: TODAY });
  const lines = tapeLines(c, { at: NOW, hash: chainHash(c) });
  appendLines(dir, NOW, lines, { header: headerLine({ at: NOW, band: 0.3, maxDte: 70, symbols: ['AAA'] }) });
  const r = readTape(dir, { now: () => NOW });
  ok('it reads what the recorder wrote', r.ok === true && r.symbols.length === 1, r);
  ok('the day and file name come back', r.day === '2026-09-21' && /chains-2026-09-21/.test(r.file), [r.day, r.file]);
  ok('the byte size is reported', r.bytes > 0, r.bytes);
  ok('the spot survives the round trip', r.symbols[0].spot === 100, r.symbols[0].spot);
  ok('every recorded expiry is listed', r.symbols[0].expiries.length === lines.length, r.symbols[0].expiries.length);
  ok('and the atm strike is found', r.symbols[0].atm && r.symbols[0].atm.k === 100, r.symbols[0].atm);
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

async function seenUnwritable() {
  group('a seen file that cannot be written is named, not disguised as a failed snapshot');
  const dir = tmp();
  const session = { chain: async (sym, o) => parseChain(fixture({ symbol: sym }), o) };
  const io = { ...fs, writeFileSync: () => { throw new Error('EACCES'); } };
  let threw = null, r = null;
  try { r = await snapshot(session, { symbols: ['AAA'], dir, band: 0, maxDte: 70, now: () => NOW, log: () => {}, io }); }
  catch (e) { threw = e.message; }
  ok('the snapshot does not throw: the tape was written', threw === null, threw);
  ok('the tape really is on disk', r && r.lines === 2 && fs.existsSync(r.file), r && r.file);
  ok('and the one file at fault is named', r && /EACCES/.test(r.seenError || ''), r && r.seenError);
  ok('a healthy run carries no such warning', !(await snapshot(session, { symbols: ['BBB'], dir, band: 0, maxDte: 70, now: () => NOW, log: () => {} })).seenError);
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
  await seenUnwritable();
  await network();
  // exactly this shape: tools/test.js parses the last line, and treats a suite that exits 0
  // without it as having stopped early rather than as having passed
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`\nFAILED  the suite itself threw: ${e && e.stack}`); process.exit(1); });

'use strict';
// The desk check (step 8 of the daily check): a real day of the desk replays from its journal to the
// penny, every kind of drift is named, and "alive" and "did today's check" are read right at every
// hour of the week. No network, no clock. The days are tools/fixtures/retired/: a trend day of the options book,
// a morning of scalps and a morning dip, recorded on 2026-10-17 by the engine as it was before those books were
// retired (it ran tools/desk-fixture.js's fake market), so that the ledgers the box still carries for them are
// replayed by a test that no longer needs their code.
const fs = require('fs');
const os = require('os');
const path = require('path');
const clock = require('../src/desk/clock');
const { at } = require('./desk-fixture');
const FIX = path.join(__dirname, 'fixtures', 'retired');
const C = require('./desk-check');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, JSON.stringify(got) === JSON.stringify(want), got);

async function main() {
  // a real afternoon: crypto and SPY bought, two options bought, one sold at 2x, one on a VWAP break
  const ddir = path.join(FIX, 'trend');

  const { state: S, events } = C.readDesk(ddir);
  const built = C.rebuild(events, S, { until: C.stateTime(S) });
  eq("a real day's journal rebuilds the state to the penny", C.compare(built, S), []);
  eq('every fill replayed: three coins, SPY, and four option fills', built.fills, 7);
  eq('the options book ends flat', built.options.open, 0);

  // the whole report on that day, as the daily check prints it
  const lines = [];
  const code = C.run(['--dir', ddir], { log: (l) => lines.push(l), now: at('12:47') });
  eq('a healthy day exits 0', code, 0);
  ok('it says the ledger is OK', lines.some((l) => /^LEDGER  OK/.test(l)), lines);
  ok('each book on its own line, crypto against holding', lines.some((l) => /crypto .*holding would be/.test(l)), lines);
  ok('and what holding paid to buy in: 0.40% of what its $9,000 bought', lines.some((l) => /crypto .*holding would be \S+ after its \$35\.86 fee to buy in · banked/.test(l)), lines);
  ok('SPY holding pays no fee, and its line claims none', lines.some((l) => /stocks .*holding would be/.test(l)) && !lines.some((l) => /stocks .*fee to buy in/.test(l)), lines);
  ok('the options book counts its closed trades', lines.some((l) => /options .*1 trade closed \(1 made money\)/.test(l)), lines);
  ok('the four retired books are one line, not a check each', lines.some((l) => /^TODAY   options, scalps, dips, runners: retired, holding nothing$/.test(l)), lines);
  ok("today's checks are reported, not flagged", lines.some((l) => /^TODAY   SPY checked today/.test(l)) && lines.some((l) => /^TODAY   crypto checked 2026-09-23/.test(l)), lines);

  // drift: each kind is named, on the book it is in
  const tamper = (fn) => { const s = JSON.parse(JSON.stringify(S)); fn(s); return C.compare(C.rebuild(events, s, { until: C.stateTime(s) }), s); };
  const p1 = tamper((s) => { s.books.options.cash += 1; });
  ok('a dollar of options cash the journal never paid is named', p1.length === 1 && /^options: cash/.test(p1[0]), p1);
  const p2 = tamper((s) => { s.books.crypto.sleeves['ETH-USD'].qty += 0.01; });
  ok('ether the journal never bought is named', p2.length === 1 && /^crypto ETH: holds/.test(p2[0]), p2);
  const p3 = tamper((s) => { s.books.stocks.sleeves.SPY.fees = 1; });
  ok('fees the journal never charged are named', p3.length === 1 && /^stocks SPY: fees/.test(p3[0]), p3);
  const lost = events.filter((e) => !(e.kind === 'FILL' && e.sym === 'SOL-USD'));
  const p4 = C.compare(C.rebuild(lost, S, { until: C.stateTime(S) }), S);
  ok('a fill missing from the journal shows as cash and holdings apart', p4.some((x) => /^crypto SOL: cash/.test(x)) && p4.some((x) => /^crypto SOL: holds/.test(x)), p4);
  // a fill journaled after the state was last saved is not a drift yet
  const later = [...events, { t: new Date(C.stateTime(S) + 60000).toISOString(), kind: 'FILL', book: 'crypto', sym: 'BTC-USD', side: 'buy', qty: 1, cash: -84000, fee: 336 }];
  eq('a fill newer than the state is left for the next run', C.compare(C.rebuild(later, S, { until: C.stateTime(S) }), S), []);

  // alive
  eq('a desk that recorded a minute ago is alive', C.health(S, at('12:48')).problems.filter((x) => /loop/.test(x)), []);
  ok('three hours of silence is a stopped loop', C.health(S, at('15:47')).problems.some((x) => /no round recorded for 18\d minutes/.test(x)), C.health(S, at('15:47')).problems);
  // ...unless the desk was running and could not save (2026-10-15, the box's disk full)
  {
    const unsaved = (h) => h.problems.some((x) => /^the state has not been saved for 18\d minutes, but the desk did not stop/.test(x)) && !h.problems.some((x) => /loop has stopped/.test(x));
    const hj = C.health(S, at('15:47'), { journalAt: at('15:40') });
    ok('a journal newer than the state is a state that could not be saved, not a stopped loop', unsaved(hj) && hj.problems.some((x) => /journal has a line from 7 min ago/.test(x)), hj.problems);
    const sf = JSON.parse(JSON.stringify(S));
    sf.log.unshift({ t: at('12:50'), agent: 'TESS', kind: 'OPS', text: 'state save failed: ENOSPC: no space left on device, write · a restart now would lose the last minutes' });
    ok("so is a 'state save failed' line after the last minute", unsaved(C.health(sf, at('15:47'))), C.health(sf, at('15:47')).problems);
    const hd = C.health(S, at('15:47'), { freeMb: 12 });
    ok('and a box with 12 MB free on /data', unsaved(hd) && hd.problems.some((x) => /^the box has 12 MB free on \/data \(under 200\)/.test(x)), hd.problems);
    ok('a journal line from before the last minute changes nothing', C.health(S, at('15:47'), { journalAt: C.stateTime(S) }).problems.some((x) => /loop has stopped/.test(x)));
    const roomy = C.health(S, at('12:48'), { freeMb: 4200 });
    ok('room on the disk is a line, not a problem', roomy.lines.includes('the box has 4200 MB free on /data') && !roomy.problems.some((x) => /MB free/.test(x)), roomy);
    ok('a low disk on a running desk is a problem of its own', C.health(S, at('12:48'), { freeMb: 150 }).problems.some((x) => /150 MB free/.test(x)));
    const np = JSON.parse(JSON.stringify(S));
    np.log.unshift({ t: at('15:40'), agent: 'HOLT', kind: 'OPS', text: "no price yet for ETH · the books' value is not recorded until every slot has one" });
    const hp = C.health(np, at('15:47'), { journalAt: at('15:40') }).problems;
    ok('a desk waiting for a price after a restart is running, and says which', hp.some((x) => /but the desk is running: HOLT: no price yet for ETH/.test(x)) && !hp.some((x) => /loop has stopped|has not been saved/.test(x)), hp);
    eq("the journal's newest line is the loop's, not the watchdog's", C.journalTime([{ t: '2026-09-23T16:00:00Z', kind: 'FILL' }, { t: '2026-09-23T17:00:00Z', kind: 'WATCHDOG' }]), Date.parse('2026-09-23T16:00:00Z'));
    // the box's one console call: the listing, then df -P's line for /data
    const box = C.parseListing('state.json\njournal-2026-10-14.jsonl\njournal-2026-10-15.jsonl\nstate.json.tmp\nFilesystem     1048576-blocks  Used Available Capacity Mounted on\n/dev/vdc                  976   941        35      97% /data\n');
    eq('the listing and the free space come from one call', box, { names: ['state.json', 'journal-2026-10-14.jsonl', 'journal-2026-10-15.jsonl'], freeMb: 35 });
    eq('no df line: free space unknown, not zero', C.parseListing('state.json\n').freeMb, null);
    // audit 2026-10-20: the state first, then only the days the archive lacks come from the box
    const plan = C.copyPlan(['journal-2026-10-15.jsonl', 'state.json', 'journal-2026-10-18.jsonl', 'journal-2026-10-20.jsonl'], ['journal-2026-10-15.jsonl', 'journal-2026-10-18.jsonl']);
    eq('the state comes from the box first, then the journal the archive lacks (today\'s)', plan.fromBox.join(), 'state.json,journal-2026-10-20.jsonl');
    eq('the archived days are copied from the archive, not the box', plan.fromArchive.join(), 'journal-2026-10-15.jsonl,journal-2026-10-18.jsonl');
    eq('with no archive, everything from the box, the state first', C.copyPlan(['journal-2026-10-15.jsonl', 'state.json'], []).fromBox.join(), 'state.json,journal-2026-10-15.jsonl');
  }

  // today's checks, across the week (the state's history moved along so the loop reads alive)
  const MIN = 60000;
  const alive = (t) => { const s = JSON.parse(JSON.stringify(S)); s.history.push({ ...s.history[s.history.length - 1], t: t - MIN }); return s; };
  const thu2am = Date.parse('2026-09-24T02:00:00Z');
  const pc = C.health(alive(thu2am), thu2am).problems;
  ok('crypto not checked by 2 AM UTC on the next day is flagged, coin by coin', pc.some((x) => /crypto: BTC, ETH, SOL not checked today \(2026-09-24 UTC\)/.test(x)), pc);
  const thu0010 = Date.parse('2026-09-24T00:10:00Z');
  eq('ten minutes after midnight UTC it is not yet due', C.health(alive(thu0010), thu0010).problems.filter((x) => /crypto/.test(x)), []);
  const thu11 = clock.etToUtc('2026-09-24T11:00:00');
  ok('SPY not checked by 11 AM on a trading day is flagged', C.health(alive(thu11), thu11).problems.some((x) => /^SPY: not checked today/.test(x)));
  const thu0945 = clock.etToUtc('2026-09-24T09:45:00');
  eq('at 9:45 the late tape has not shown the open yet', C.health(alive(thu0945), thu0945).problems.filter((x) => /SPY/.test(x)), []);
  const sat = clock.etToUtc('2026-09-26T11:00:00');
  eq('on a Saturday there is no SPY check to miss', C.health(alive(sat), sat).problems.filter((x) => /SPY|options/.test(x)), []);
  const thu13 = clock.etToUtc('2026-09-24T13:05:00');
  eq('a retired book has no 12:30 verdict or scan to miss', C.health(alive(thu13), thu13).problems.filter((x) => /options|scalps|dips|runners/.test(x)), []);
  const stuck = JSON.parse(JSON.stringify(S));
  stuck.books.options.lots = [{ expiry: '2026-09-23', qty: 1, osi: 'SPY260923C00705000' }];
  ok('a retired book that somehow holds a contract is a problem: nothing marks or sells it', C.health(stuck, at('15:45')).problems.some((x) => /^options: retired but holding 1/.test(x)));

  // what the bots flagged: a note, except a round that failed outright
  const noisy = JSON.parse(JSON.stringify(S));
  noisy.log.unshift({ t: at('12:47'), agent: 'HOLT', kind: 'OPS', text: 'SPY quote did not load: HTTP 503 from cdn.cboe.com · trying again' });
  noisy.log.unshift({ t: at('12:47') + 1, agent: 'TESS', kind: 'OPS', text: 'desk round failed: x is not a function' });
  const hn = C.health(noisy, at('12:48'));
  ok('a feed hiccup is a note', hn.notes.some((x) => /HOLT: SPY quote did not load/.test(x)), hn.notes);
  ok('a round that threw is a problem', hn.problems.some((x) => /desk round failed/.test(x)), hn.problems);
  const skewed = JSON.parse(JSON.stringify(S));
  skewed.log.unshift({ t: at('12:47'), agent: 'BRAM', kind: 'PASS', text: "options: new high at 12:45 not taken · the option chain is out of step with the bars: its prices are 185s older than the bar's close (limit 120s)" });
  const hs = C.health(skewed, at('12:48'));
  ok('an option trade skipped for a chain out of step with the bars is a note', hs.notes.some((x) => /BRAM: .*out of step/.test(x)), hs.notes);
  ok('not a problem with the desk', !hs.problems.some((x) => /out of step/.test(x)), hs.problems);

  // a morning of scalps replays to the penny too, and the scalp book has its own line
  {
    const sd = path.join(FIX, 'scalps');
    const { state: SS, events: ev } = C.readDesk(sd);
    const bs = C.rebuild(ev, SS, { until: C.stateTime(SS) });
    eq("the scalp book's journal rebuilds its state to the penny", C.compare(bs, SS), []);
    eq('its cash and what it banked', [bs.scalps.cash, bs.scalps.realized, bs.scalps.open], [1028.88, 28.88, 0]);
    const drift = JSON.parse(JSON.stringify(SS));
    drift.books.scalps.realized += 1;
    ok('a drift in it is named on its book', C.compare(C.rebuild(ev, drift, { until: C.stateTime(drift) }), drift).some((x) => /^scalps: realised/.test(x)));
    const out = [];
    eq('a healthy scalp morning exits 0', C.run(['--dir', sd], { log: (l) => out.push(l), now: at('10:22') }), 0);
    ok('its line counts the trades and what they made', out.some((l) => /scalps .*2 trades closed \(1 made money\) · banked \+\$28\.88/.test(l)), out);

  }

  // a morning dip replays to the penny too
  {
    const pd = path.join(FIX, 'dips');
    const { state: PS, events: pev } = C.readDesk(pd);
    const bp = C.rebuild(pev, PS, { until: C.stateTime(PS) });
    eq("the dip book's journal rebuilds its state to the penny", C.compare(bp, PS), []);
    eq('its cash and what it banked', [bp.dips.cash, bp.dips.realized, bp.dips.open], [1054.88, 54.88, 0]);
    const out = [];
    eq('a healthy dip morning exits 0', C.run(['--dir', pd], { log: (l) => out.push(l), now: at('10:23') }), 0);
    ok('its line counts the trade and what it made', out.some((l) => /dips .*1 trade closed \(1 made money\) · banked \+\$54\.88/.test(l)), out);
    ok('the desk line counts all six books', out.some((l) => /desk .*\$23,/.test(l)), out);
  }

  // no state at all
  const none = [], dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-check-'));
  eq('no desk state is a problem, said plainly', C.run(['--dir', path.join(dir, 'nowhere')], { log: (l) => none.push(l) }), 1);
  ok('and it names the folder', /^PROBLEM no desk state in/.test(none[0]), none);
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---- entries the chain's timing refused
{
  const now = Date.parse('2026-10-02T01:00:00Z');
  const ev = (kind, hoursAgo) => ({ t: new Date(now - hoursAgo * 3600000).toISOString(), kind });
  ok('two skips in a day are the files drifting: no problem', C.skips([ev('SCALP_SKIP', 3), ev('DIP_SKIP', 5)], now) === null);
  const p = C.skips([ev('SCALP_SKIP', 3), ev('SCALP_SKIP', 4), ev('DIP_SKIP', 5), ev('DIP_SKIP', 5), ev('DIP_SKIP', 6), ev('OPTIONS_SKIP', 7)], now);
  ok('three or more are a feed out of step: a problem that counts each book', /6 entries skipped/.test(p || '') && /scalp 2/.test(p) && /dip 3/.test(p) && /options 1/.test(p), p);
  ok('skips older than a day do not count', C.skips([ev('SCALP_SKIP', 30), ev('SCALP_SKIP', 31), ev('DIP_SKIP', 40)], now) === null);
  ok('other journal lines do not count', C.skips([ev('FILL', 1), ev('REBALANCE', 2), ev('SCALP_SKIP', 3)], now) === null && C.skips(null, now) === null);
}

main().then(() => { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.log(`  FAIL  threw: ${e.stack}`); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

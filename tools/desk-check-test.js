'use strict';
// The desk check (step 8 of the daily check): a real day of the desk replays from its journal to the
// penny, every kind of drift is named, and "alive" and "did today's check" are read right at every
// hour of the week. No network, no clock: the desk runs on tools/desk-fixture.js's fake market.
const fs = require('fs');
const os = require('os');
const path = require('path');
const clock = require('../src/desk/clock');
const { Desk } = require('../src/desk/engine');
const { deskConfig, fakeMarket, playTrendDay, at } = require('./desk-fixture');
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'desk-check-'));
  let T = at('12:31');
  const M = fakeMarket(() => T);
  const desk = new Desk(deskConfig(dir), { feeds: M.feeds, now: () => T });
  desk.quiet = true;
  await playTrendDay(desk, M, (t) => { T = t; });
  desk.record(); desk.save();
  const ddir = path.join(dir, 'desk');

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
  ok('no 12:30 verdict by 1 PM on a trading day is flagged', C.health(alive(thu13), thu13).problems.some((x) => /^options: no 12:30 verdict today/.test(x)));
  eq('on the day it had one, it is reported', C.health(alive(at('13:05')), at('13:05')).problems, []);
  const thanksgivingFri = clock.etToUtc('2026-11-27T13:30:00');
  eq('a 1 PM close has no 12:30 test to miss', C.health(alive(thanksgivingFri), thanksgivingFri).problems.filter((x) => /options/.test(x)), []);
  const stuck = JSON.parse(JSON.stringify(S));
  stuck.books.options.lots = [{ expiry: '2026-09-23', qty: 1, osi: 'SPY260923C00705000' }];
  ok('a contract still held after 3:40 on its day is flagged', C.health(stuck, at('15:45')).problems.some((x) => /still held past the 3:15 clock/.test(x)));

  // what the bots flagged: a note, except a round that failed outright
  const noisy = JSON.parse(JSON.stringify(S));
  noisy.log.unshift({ t: at('12:47'), agent: 'HOLT', kind: 'OPS', text: 'SPY quote did not load: HTTP 503 from cdn.cboe.com · trying again' });
  noisy.log.unshift({ t: at('12:47') + 1, agent: 'TESS', kind: 'OPS', text: 'desk round failed: x is not a function' });
  const hn = C.health(noisy, at('12:48'));
  ok('a feed hiccup is a note', hn.notes.some((x) => /HOLT: SPY quote did not load/.test(x)), hn.notes);
  ok('a round that threw is a problem', hn.problems.some((x) => /desk round failed/.test(x)), hn.problems);

  // no state at all
  const none = [];
  eq('no desk state is a problem, said plainly', C.run(['--dir', path.join(dir, 'nowhere')], { log: (l) => none.push(l) }), 1);
  ok('and it names the folder', /^PROBLEM no desk state in/.test(none[0]), none);
  fs.rmSync(dir, { recursive: true, force: true });
}

main().then(() => { console.log(`${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0); })
  .catch((e) => { console.log(`  FAIL  threw: ${e.stack}`); console.log(`${pass} passed, ${fail + 1} failed`); process.exit(1); });

'use strict';
// Assertions for the anytime-touchdown tape (tools/td-tape.js) -- no network, no wall clock.
//
// A collector's only bad failure is a quiet one: a tape that recorded the 2+ markets as 1+, filed a
// Sunday-night game under Monday, took an in-game price as "before kickoff", or graded a no-snap void
// as a loss would read as a hold that is not there. So this leans on the parsing, the window, the
// pick of the last pre-kickoff record and the grading arithmetic. http.getJSON is stubbed before the
// tool loads.
//
//   node tools/td-tape-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const httpPath = require.resolve('../src/http');
let pages = [], calls = [], failNext = false;
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true, children: [], paths: [],
  exports: {
    getJSON: async (url) => {
      calls.push(url);
      if (failNext) { failNext = false; throw new Error('HTTP 503'); }
      const u = new URL(url), cursor = u.searchParams.get('cursor');
      const i = cursor ? +cursor.replace('page', '') : 0;
      const page = pages[i] || { markets: [] };
      return { markets: page.markets, cursor: pages[i + 1] ? `page${i + 1}` : '' };
    },
    recentErrors: () => 0, stats: {}, noteError: () => {},
  },
};
const T = require('./td-tape');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'td-tape-'));
const H = 3600e3;

// Kalshi's row for "<player>: 1+" in a game. `end` is occurrence_datetime, kickoff + 3h.
const row = (ticker, event, sub, end, over = {}) => ({
  ticker, event_ticker: event, yes_sub_title: sub, title: `${sub} touchdowns`, status: 'active',
  occurrence_datetime: end, yes_bid_dollars: '0.0500', yes_ask_dollars: '0.0600', yes_bid_size_fp: '100.00', yes_ask_size_fp: '18385.00',
  volume_fp: '12.00', open_interest_fp: '3.00', ...over,
});
const SNF_END = '2026-10-12T03:20:00Z';   // Ravens-Falcons, 8:20 PM ET Sunday: kicks off 00:20Z Monday
const ONE_END = '2026-10-11T20:00:00Z';   // the 1 PM ET games

(async () => {
  group('parsing: 1+ markets only, kickoff three hours before the expected end, the team off the ticker');
  {
    const m = T.parseMarket(row('KXNFLTD-26OCT11BALATL-ATLCWOERNER89-1', 'KXNFLTD-26OCT11BALATL', 'Charlie Woerner: 1+', SNF_END));
    ok('a 1+ market parses', m && m.player === 'Charlie Woerner' && m.game === 'BALATL' && m.team === 'ATL' && m.bid === 0.05 && m.ask === 0.06 && m.askSz === 18385, m);
    ok('kickoff is the expected end less three hours (the four 2026-10-11 slots checked)', Date.parse(m.kickoff) === Date.parse('2026-10-12T00:20:00Z'), m.kickoff);
    ok('...and the raw field is kept', m.occurrence === SNF_END);
    ok('a 2+ market is not kept', T.parseMarket(row('KXNFLTD-26OCT11BALATL-ATLCWOERNER89-2', 'KXNFLTD-26OCT11BALATL', 'Charlie Woerner: 2+', SNF_END)) === null);
    ok('no expected end: not kept', T.parseMarket(row('KXNFLTD-26OCT11BALATL-X-1', 'KXNFLTD-26OCT11BALATL', 'X: 1+', '')) === null);
    ok('two-letter codes: LV + NE', T.teamOf('LVNE', 'NEDMAYE10') === 'NE' && T.teamOf('LVNE', 'LVBJACOBS8') === 'LV');
    ok('CLE + NYJ', T.teamOf('CLENYJ', 'NYJBHALL20') === 'NYJ' && T.teamOf('CLENYJ', 'CLEQJUDKINS10') === 'CLE');
    ok('MIN + NO: a Vikings player matches MI and MIN, and MIN is the team', T.teamOf('MINNO', 'MINJJEFFERSON18') === 'MIN' && T.teamOf('MINNO', 'NOOBECKHAM13') === 'NO');
    ok('an ambiguous or unmatched segment is null, not a guess', T.teamOf('BALATL', 'ZZZSOMEONE1') === null && T.teamOf('', 'ATLX') === null);
  }

  group('the window: games kicking off within three hours, not yet kicked off; a Sunday night game files under Sunday');
  {
    const ms = [
      T.parseMarket(row('KXNFLTD-26OCT11CINMIA-CINJCHASE1-1', 'KXNFLTD-26OCT11CINMIA', 'Ja\'Marr Chase: 1+', ONE_END)),
      T.parseMarket(row('KXNFLTD-26OCT11BALATL-ATLCWOERNER89-1', 'KXNFLTD-26OCT11BALATL', 'Charlie Woerner: 1+', SNF_END)),
      T.parseMarket(row('KXNFLTD-26OCT12BUFLAR-BUFJALLEN17-1', 'KXNFLTD-26OCT12BUFLAR', 'Josh Allen: 1+', '2026-10-13T03:15:00Z')),
    ];
    const noon = Date.parse('2026-10-11T16:00:00Z');                 // noon ET Sunday: the 1 PM games are an hour off
    ok('at noon ET only the 1 PM games are due', T.toRecord(ms, noon).map((m) => m.game).join() === 'CINMIA');
    ok('at 1:01 PM ET the 1 PM games have kicked off and nothing is due', T.toRecord(ms, Date.parse('2026-10-11T17:01:00Z')).length === 0);
    ok('at 5:30 PM ET the night game is due (kickoff 8:20, within three hours)', T.toRecord(ms, Date.parse('2026-10-11T21:30:00Z')).map((m) => m.game).join() === 'BALATL');
    ok('at 5:00 PM ET it is not yet (3h20m out)', T.toRecord(ms, Date.parse('2026-10-11T21:00:00Z')).length === 0);
    ok('the night game files under the Eastern day of its kickoff, Sunday, though it kicks off Monday UTC', T.fileFor('/x', ms[1].kickoff) === '/x/td-2026-10-11.jsonl', T.fileFor('/x', ms[1].kickoff));
    ok('Monday night files under Monday', T.fileFor('/x', ms[2].kickoff) === '/x/td-2026-10-12.jsonl');
  }

  group('record: pages followed by cursor, lines appended to the day file, one log line, a dry run writes nothing');
  {
    const dir = tmp();
    const ja = row('KXNFLTD-26OCT11CINMIA-CINJCHASE1-1', 'KXNFLTD-26OCT11CINMIA', 'Ja\'Marr Chase: 1+', ONE_END, { yes_bid_dollars: '0.3300', yes_ask_dollars: '0.3500' });
    const two = row('KXNFLTD-26OCT11CINMIA-CINJCHASE1-2', 'KXNFLTD-26OCT11CINMIA', 'Ja\'Marr Chase: 2+', ONE_END);
    const snf = row('KXNFLTD-26OCT11BALATL-ATLCWOERNER89-1', 'KXNFLTD-26OCT11BALATL', 'Charlie Woerner: 1+', SNF_END);
    pages = [{ markets: [ja, two] }, { markets: [snf] }];
    calls = [];
    const noon = Date.parse('2026-10-11T16:00:00Z');
    const dry = await T.record({ dir, now: noon, dryRun: true });
    ok('a dry run follows both pages', calls.length === 2 && /cursor=page1/.test(calls[1]), calls);
    ok('...reports what it would write, and writes nothing', dry.ok && dry.recorded === 0 && dry.due.length === 1 && !fs.existsSync(dir + '/td-2026-10-11.jsonl') && !fs.existsSync(path.join(dir, T.LOG)), dry.line);
    const r = await T.record({ dir, now: noon });
    ok('a real run writes the due market and says so', r.ok && r.recorded === 1 && / ok td-tape: 2 open 1\+ markets, 1 game in the next 3h, 1 line written$/.test(r.line), r.line);
    const lines = fs.readFileSync(dir + '/td-2026-10-11.jsonl', 'utf8').trim().split('\n').map(JSON.parse);
    ok('the line carries the time of the run, the prices and the kickoff', lines.length === 1 && lines[0].t === '2026-10-11T16:00:00.000Z' && lines[0].bid === 0.33 && lines[0].ask === 0.35 && lines[0].kickoff === '2026-10-11T17:00:00.000Z', lines[0]);
    ok('td.log has the run\'s line', fs.readFileSync(path.join(dir, T.LOG), 'utf8').trim() === r.line);
    const quiet = await T.record({ dir, now: Date.parse('2026-10-11T18:00:00Z') });
    ok('a run with no game in the window writes no tape line, and the log says 0 written', quiet.ok && quiet.recorded === 0 && / 0 games in the next 3h, 0 lines written$/.test(quiet.line) && fs.readFileSync(dir + '/td-2026-10-11.jsonl', 'utf8').trim().split('\n').length === 1, quiet.line);
    failNext = true;
    const down = await T.record({ dir, now: noon });
    ok('Kalshi down: a PROBLEM line, nothing recorded, exit status false', !down.ok && down.recorded === 0 && / PROBLEM td-tape: .*Kalshi: HTTP 503/.test(down.line), down.line);
    const c = T.check(dir);
    ok('--check reads the last line as a PROBLEM', !c.ok && /^PROBLEM/.test(c.text) && /1 day on tape/.test(c.text), c.text);
    await T.record({ dir, now: noon });
    ok('...and ok once a run succeeds', T.check(dir).ok);
    ok('--check with no log yet is a PROBLEM', !T.check(tmp()).ok);
  }

  group('grading: the last record before kickoff, results, voids, the fee, the bands');
  {
    const k = '2026-10-11T17:00:00.000Z', kMs = Date.parse(k);
    const rec = (ticker, minsBefore, bid, ask, over = {}) => ({ t: new Date(kMs - minsBefore * 60000).toISOString(), ticker, event: 'KXNFLTD-26OCT11CINMIA', game: 'CINMIA', player: ticker, team: 'CIN', kickoff: k, bid, ask, ...over });
    const records = [
      rec('A', 150, 0.30, 0.34), rec('A', 45, 0.33, 0.35), rec('A', 15, 0.34, 0.36),   // last before kickoff: 15 minutes out
      rec('A', -5, 0.60, 0.62),                                                         // in play: never "before kickoff"
      rec('B', 170, 0.05, 0.07),                                                        // only a record 2h50m out: too old
      rec('C', 30, 0.08, 0.10), rec('D', 30, 0.45, 0.50), rec('E', 30, 0.20, 0.22), rec('F', 30, 0.10, 0.12), rec('G', 30, 0.00, 0.01),
    ];
    const { picked, skipped } = T.lastBeforeKickoff(records);
    const A = picked.find((r) => r.ticker === 'A');
    ok('A: the 15-minutes-out record, not the in-play one or an earlier one', A && A.ask === 0.36 && A.bid === 0.34, A);
    ok('B: a record older than two hours before kickoff is no pre-kickoff record', !picked.some((r) => r.ticker === 'B') && skipped === 1, { picked: picked.map((r) => r.ticker), skipped });
    const results = new Map([
      ['A', { status: 'finalized', result: 'yes', settlementValue: 1 }],
      ['C', { status: 'finalized', result: 'no', settlementValue: 0 }],
      ['D', { status: 'finalized', result: 'yes', settlementValue: 1 }],
      ['E', { status: 'finalized', result: 'no', settlementValue: 0.21 }],   // active, no snap: settled at the pre-game price
      ['F', { status: 'active', result: '', settlementValue: null }],       // still open
      ['G', { status: 'finalized', result: 'no', settlementValue: 0 }],     // 0.00/0.01: no bid, graded all the same (bid 0 is a price)
    ]);
    const g = T.grade(picked, results, (px) => 0.02 * px * (1 - px));
    ok('four graded, one pending, one void', g.graded === 4 && g.pending === 1 && g.voided === 1 && g.noPrice === 0, g);
    // YES at the ask: A 0.36 -> +0.64, C 0.10 -> -0.10, D 0.50 -> +0.50, G 0.01 -> -0.01; cost 0.97; pnl +1.03
    ok('YES at the ask, gross: pnl over cost', Math.abs(g.all.yes.gross - 1.03 / 0.97) < 1e-9, g.all.yes);
    const fees = [0.36, 0.10, 0.50, 0.01].reduce((a, p) => a + 0.02 * p * (1 - p), 0);
    ok('...net takes the fee on each entry', Math.abs(g.all.yes.net - (1.03 - fees) / 0.97) < 1e-9, g.all.yes);
    // NO at 1 - bid: A (hit) -0.66, C +0.08, D (hit) -0.55, G +0.00; cost 0.66+0.92+0.55+1.00 = 3.13; pnl -1.13
    ok('NO at its ask, gross', Math.abs(g.all.no.gross - (-1.13 / 3.13)) < 1e-9, g.all.no);
    ok('the scored rate and mean ask', g.all.hits === 2 && Math.abs(g.all.hitRate - 0.5) < 1e-9 && Math.abs(g.all.meanAsk - 0.2425) < 1e-9, g.all);
    const band = (l) => g.bands.find((b) => b.label === l);
    ok('bands cut by the YES ask', band('ask <= 10c').n === 2 && band('25c < ask <= 40c').n === 1 && band('ask > 40c').n === 1 && band('10c < ask <= 25c').n === 0, g.bands.map((b) => [b.label, b.n]));
    const text = T.report(g, { day: '2026-10-11', skipped });
    ok('the report says what was graded and what was not', /4 markets graded over 1 game \(1 pending, 1 void, 0 unpriced, 1 with no record/.test(text) && /every market/.test(text) && /ask > 40c/.test(text), text);
    ok('a market with no two-sided price is counted, not graded', T.grade([rec('H', 30, 0.5, 0.5)], new Map([['H', { status: 'finalized', result: 'no', settlementValue: 0 }]])).noPrice === 1);
  }

  group('reading the tape back');
  {
    const dir = tmp();
    fs.writeFileSync(dir + '/td-2026-10-11.jsonl', '{"t":"a","ticker":"X","kickoff":"k"}\n{"t":"b","ticker":"Y","kickoff":"k"}\n{"torn');
    fs.writeFileSync(dir + '/td-2026-10-12.jsonl', '{"t":"c","ticker":"Z","kickoff":"k"}\n');
    fs.writeFileSync(dir + '/td.log', 'x\n');
    ok('every day, torn last line dropped', T.readTape(dir).map((r) => r.ticker).join() === 'X,Y,Z');
    ok('one day', T.readTape(dir, '2026-10-12').map((r) => r.ticker).join() === 'Z');
    ok('no tape: nothing', T.readTape(tmp()).length === 0 && T.readTape('/nonexistent/dir').length === 0);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

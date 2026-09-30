'use strict';
// The headline lab: Eastern post times, minutes with no trade, one position at a time, a bot that
// cannot buy before it has the post, the fee both ways, and the baseline from the same kind of day.
const { parseLog, series, pick, measure, CRYPTO } = require('./headline-lab');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (name, got, want, tol = 1e-9) => ok(`${name} (want ~${want})`, Number.isFinite(got) && Math.abs(got - want) <= tol, got);

const MIN = 60000;
const line = (id, time_et, text = 'HEADLINE') => JSON.stringify({ seen_et: time_et, time_et, lag_s: 5, account: 'acct', id, text });

// the log: Eastern wall time to the instant, each post once, oldest first, a bad line skipped
{
  const posts = parseLog([line('2', '2026-09-28 10:00:20'), line('1', '2026-09-28 03:48:28'), '{not json', line('1', '2026-09-28 03:48:28'), '', line('3', '2026-01-15 09:30:00')].join('\n'));
  ok('three posts, the repeat dropped', posts.length === 3, posts.map((p) => p.id));
  ok('oldest first', posts.map((p) => p.id).join() === '3,1,2', posts.map((p) => p.id));
  ok('September is UTC-4', posts[1].t === Date.parse('2026-09-28T07:48:28Z'), new Date(posts[1].t).toISOString());
  ok('January is UTC-5', posts[0].t === Date.parse('2026-01-15T14:30:00Z'), new Date(posts[0].t).toISOString());
}

// a minute with no trade opens and closes at the last close
{
  const s = series([{ t: 2 * MIN, o: 102, c: 103 }, { t: 0, o: 100, c: 101 }]);
  ok('one entry a minute, the gap filled', s.o.length === 3 && s.o[1] === 101 && s.c[1] === 101, s);
  ok('the minute after the gap is its own', s.o[2] === 102 && s.c[2] === 103, s);
}

// one position at a time: busy from the post's minute for the hold plus two minutes
{
  const at = (h, m, sec) => ({ t: Date.parse('2026-09-28T14:00:00Z') + (h * 60 + m) * MIN + sec * 1000 });
  const got = pick([at(0, 0, 10), at(0, 3, 0), at(0, 6, 59), at(0, 7, 0)], 5);
  ok('a post while holding is skipped; the first minute free is taken', got.length === 2 && got[1].t === at(0, 7, 0).t, got.map((p) => new Date(p.t).toISOString()));
}

// a flat market from Monday 2026-09-28 00:00 ET, with steps put in by the test
const MON = Date.parse('2026-09-28T04:00:00Z');
const minute = (day, hh, mm) => MON + day * 1440 * MIN + (hh * 60 + mm) * MIN;
function market(from, days, steps) {
  const out = [];
  let px = 100;
  for (let t = from; t < from + days * 1440 * MIN; t += MIN) {
    const o = px;
    if (steps[t] != null) px = steps[t];   // the price moves during this minute: it closes at the step
    out.push({ t, o, c: px });
  }
  return series(out);
}
const post = (t) => ({ t, id: String(t), account: 'acct', text: 'X' });

// the bot has the post five seconds late and cannot buy the jump it has not seen
{
  // posted 10:00:20; the price jumps to 101 during 10:00, so the first whole minute the bot watches is 10:01
  const s = market(MON, 1, { [minute(0, 10, 0)]: 101 });
  const r = measure([post(minute(0, 10, 0) + 20000)], s, { hold: 5, bps: 0 });
  near('the move after counts from the open of the post\'s minute', r.trades[0].move, 0.01);
  ok('up after the first minute, so it follows', r.follow.n === 1, r.follow);
  near('but it buys at 10:02 at 101 and earns none of the jump', r.follow.gross, 0);
  near('the ceiling had the jump', r.ceiling, 0.01);
}
{
  // posted 10:00:58: the bot has it at 10:01:03, so its first whole minute is 10:02, and it buys at 10:03
  const s = market(MON, 1, { [minute(0, 10, 1)]: 101, [minute(0, 10, 2)]: 102, [minute(0, 10, 3)]: 103 });
  const r = measure([post(minute(0, 10, 0) + 58000)], s, { hold: 5, bps: 0 });
  near('it buys at the 10:03 open, 102, and rides to 103', r.follow.gross, 103 / 102 - 1);
}

// the fee both ways, and a flat market is not followed
{
  const s = market(MON, 1, { [minute(0, 10, 1)]: 101, [minute(0, 10, 4)]: 110 });
  const r = measure([post(minute(0, 10, 0) + 20000)], s, { hold: 5, bps: 40 });
  near('net = sell less 0.40% over buy plus 0.40%', r.follow.net, (110 * 0.996) / (101 * 1.004) - 1);
  ok('a win after the fee', r.follow.won === 1, r.follow);
  const flat = measure([post(minute(0, 10, 0) + 20000)], market(MON, 1, {}), { hold: 5, bps: 40 });
  ok('flat: nothing to follow', flat.follow.n === 0, flat.follow);
  near('flat: the ceiling is the fee alone', flat.ceiling, 0.996 / 1.004 - 1);
  ok('flat: it never clears', flat.clears === 0, flat.clears);
}

// the baseline is the same clock time on days of the same kind: a Monday against Tuesday, never the weekend
{
  const SAT = MON - 2 * 1440 * MIN;
  const at = (day, hh, mm) => SAT + day * 1440 * MIN + (hh * 60 + mm) * MIN;
  // a 2% step on Saturday at 10:02, a 1% step on Tuesday at 10:02 (levels, so every other stretch is flat)
  const s = market(SAT, 4, { [at(0, 10, 2)]: 102, [at(3, 10, 2)]: 102 * 1.01 });
  const r = measure([post(at(2, 10, 0) + 20000)], s, { hold: 5, bps: 0 });
  near('Monday 10:00 is measured against Tuesday 10:00 alone', r.trades[0].base, 0.01);
  ok('x is 0: no move after this post, 1% on the other day', r.matched === 0, r.matched);
}

// the crypto-or-Fed filter matches whole words
ok('Powell is Fed news', CRYPTO.test('POWELL SAYS RATES WILL STAY'));
ok('the Fed is', CRYPTO.test('FED HOLDS RATES'));
ok('FedEx is not', !CRYPTO.test('FEDEX RAISES GUIDANCE'));
ok('ethics is not ether', !CRYPTO.test('ETHICS PANEL MEETS'));
ok('bitcoin is', CRYPTO.test('Bitcoin tops $120,000'));

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

'use strict';
// Assertions for the option lab (tools/option-lab.js) and its fetcher (tools/dolt-fetch.js): which
// contract a setting sells, the arithmetic of a round, the fee, a holiday expiry, and that the
// tuning half can never read a price from the scoring half. Synthetic chains only: no network, no clock.
//
//   node tools/option-lab-test.js
const lab = require('./option-lab');
const dolt = require('./dolt-fetch');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const C = (exp, strike, bid, ask, delta, cp = 'C') => ({ exp, strike, cp, bid, ask, iv: 0.2, delta });
const bars = (rows) => rows.map(([d, c, ac]) => ({ d, o: c, c, ac: ac === undefined ? c : ac }));

// ---------------------------------------------------------------- the pick
{
  const day = '2024-01-02';
  const chain = [
    C('2024-01-05', 100, 1, 1.1, 0.5),                    // 3 days out: under MIN_DTE, never sold
    C('2024-01-19', 100, 2, 2.1, 0.52), C('2024-01-19', 102, 1.2, 1.3, 0.41), C('2024-01-19', 104, 0.6, 0.7, 0.29),
    C('2024-02-02', 100, 3, 3.1, 0.51), C('2024-02-02', 104, 1.5, 1.6, 0.31), C('2024-02-02', 108, 0, 0.05, 0.19),
    C('2024-02-16', 100, 4, 4.2, -0.48, 'P'), C('2024-02-16', 96, 2, 2.1, -0.3, 'P'),
  ];
  const a = lab.pick(chain, day, 'C', { dte: 14, delta: 0.5 });
  ok('pick: nearest expiry to 14 days, never one under MIN_DTE', a && a.exp === '2024-01-19' && a.strike === 100, a);
  const b = lab.pick(chain, day, 'C', { dte: 30, delta: 0.3 });
  ok('pick: nearest expiry to 30 days, strike nearest delta 0.3', b && b.exp === '2024-02-02' && b.strike === 104, b);
  const c = lab.pick(chain, day, 'C', { dte: 30, delta: 0.2 });
  ok('pick: a zero bid cannot be sold, so the nearest sellable strike is taken', c && c.strike === 104, c);
  const d = lab.pick(chain, day, 'P', { dte: 14, delta: 0.3 });
  ok('pick: puts by |delta|, and only the side asked for', d && d.cp === 'P' && d.strike === 96, d);
  ok('pick: nothing sellable is null', lab.pick([C('2024-01-19', 100, 0, 0.1, 0.5)], day, 'C', { dte: 14, delta: 0.5 }) === null);
  ok('pick: a crossed quote is not sellable', lab.pick([C('2024-01-19', 100, 2, 1.5, 0.5)], day, 'C', { dte: 14, delta: 0.5 }) === null);
  ok('intrinsic: call and put', lab.intrinsic('C', 100, 103) === 3 && lab.intrinsic('C', 100, 97) === 0 && lab.intrinsic('P', 100, 97) === 3 && lab.intrinsic('P', 100, 103) === 0);
}

// ---------------------------------------------------------------- a round's arithmetic
function market({ chains, spy, shy }) {
  return {
    chains: { dates: Object.keys(chains).sort(), byDate: new Map(Object.entries(chains)) },
    spy: lab.series(bars(spy)),
    cash: shy ? lab.series(bars(shy)) : null,
  };
}
{
  // one call round: sell the 102 call at 1.00 bid (ask 1.20) on 01-02, SPY 100 → 105 by the 01-19 expiry
  const M = market({
    chains: {
      '2024-01-02': [C('2024-01-19', 102, 1.0, 1.2, 0.4)],
      '2024-01-22': [C('2024-02-09', 106, 1.0, 1.1, 0.4)],
    },
    spy: [['2024-01-02', 100, 50], ['2024-01-19', 105, 53], ['2024-01-22', 106, 53.5]],
    shy: [['2024-01-02', 80], ['2024-01-19', 80.4], ['2024-01-22', 80.5]],
  });
  const { rounds } = lab.simulate(M, 'covered-call', { dte: 14, delta: 0.4 }, { from: '2024-01-01', to: '2024-01-31', fee: 0.65, bps: 5 });
  const r = rounds[0];
  ok('covered call: one round, the next would settle after `to` so it is not started', rounds.length === 1, rounds);
  ok('covered call: sold at the bid, not the mid', r.bid === 1.0);
  ok('covered call: settles against the raw close on expiry', r.sT === 105 && r.owed === 3, r);
  ok('covered call: the round runs to the next quote day after expiry', r.end === '2024-01-22', r);
  const want = (53.5 / 50 - 1) + (1.0 - 0.0065 - 3 - 105 * 5 / 1e4) / 100;
  ok('covered call: stock total return plus premium less fee, payout and assignment cost, per share', near(r.r, want), { got: r.r, want });
  ok('covered call: SPY over the same dates is the adjusted-close ratio', near(r.spyR, 53.5 / 50 - 1), r.spyR);

  const P = market({
    chains: { '2024-01-02': [C('2024-01-19', 98, 1.5, 1.6, -0.35, 'P')] },
    spy: [['2024-01-02', 100], ['2024-01-19', 95]],
    shy: [['2024-01-02', 80], ['2024-01-19', 80.4]],
  });
  const pr = lab.simulate(P, 'put-write', { dte: 14, delta: 0.3 }, { from: '2024-01-01', to: '2024-01-31', fee: 0, bps: 0 }).rounds[0];
  ok('put-write: cash return plus premium less payout, per dollar of strike', near(pr.r, (80.4 / 80 - 1) + (1.5 - 3) / 98), pr);
  ok('put-write: the last round ends at its settlement when no later quote day exists', pr.end === '2024-01-19', pr);
  const none = lab.simulate(P, 'put-write', { dte: 14, delta: 0.3 }, { from: '2024-01-01', to: '2024-01-31', fee: 0, bps: 0, cash: null }).rounds[0];
  ok('put-write: --cash none earns nothing on the collateral', near(none.r, (1.5 - 3) / 98), none);
}
{
  // an expiry on a holiday settles on the trading day before it
  const M = market({
    chains: { '2024-03-18': [C('2024-03-29', 100, 1, 1.1, 0.5)] },
    spy: [['2024-03-18', 100], ['2024-03-28', 101], ['2024-04-01', 90]],
  });
  const r = lab.simulate(M, 'covered-call', { dte: 14, delta: 0.5 }, { from: '2024-03-01', to: '2024-04-30', fee: 0, bps: 0, cash: null }).rounds[0];
  ok('a holiday expiry settles on the close before it, never the one after', r && r.sT === 101 && r.owed === 1, r);
}

{
  // a hole in the mirror after an expiry: the round ends at settlement, and the hole is not a year
  const M = market({
    chains: {
      '2019-05-10': [C('2019-05-24', 100, 1, 1.1, 0.5)],
      '2020-06-01': [C('2020-06-15', 100, 1, 1.1, 0.5)],
      '2020-06-03': [C('2020-06-17', 100, 1, 1.1, 0.5)],
    },
    spy: [['2019-05-10', 100], ['2019-05-24', 100], ['2020-06-01', 150], ['2020-06-15', 150], ['2020-06-16', 150]],
  });
  const { rounds } = lab.simulate(M, 'covered-call', { dte: 14, delta: 0.5 }, { from: '2019-01-01', to: '2020-06-16', fee: 0, bps: 0, cash: null });
  ok('a hole after an expiry: the round ends at its settlement, not a year later', rounds[0].end === '2019-05-24' && near(rounds[0].spyR, 0), rounds[0]);
  ok('stats: years count time in a round, not the hole between rounds', lab.stats(rounds).years < 0.1, lab.stats(rounds));
  ok('firstDay: a stray day before a long hole is not the start', lab.firstDay(M.chains) === '2020-06-01', lab.firstDay(M.chains));
}

{
  // the mirror dates quotes on market holidays; a round never starts on one
  const M = market({
    chains: {
      '2024-01-15': [C('2024-01-26', 100, 5, 5.1, 0.5)],      // MLK day: SPY did not trade
      '2024-01-16': [C('2024-01-26', 100, 1, 1.1, 0.5)],
    },
    spy: [['2024-01-12', 100], ['2024-01-16', 100], ['2024-01-26', 100]],
  });
  const r = lab.simulate(M, 'covered-call', { dte: 10, delta: 0.5 }, { from: '2024-01-01', to: '2024-01-31', fee: 0, bps: 0, cash: null }).rounds;
  ok('a quote dated on a market holiday is never sold', r.length === 1 && r[0].start === '2024-01-16' && r[0].bid === 1, r);
}

// ---------------------------------------------------------------- no peeking
{
  const chains = {}, spy = [];
  let px = 100;
  for (let t = Date.parse('2023-01-02'); t <= Date.parse('2023-12-29'); t += 86400000) {
    const d = new Date(t).toISOString().slice(0, 10), wd = new Date(t).getUTCDay();
    if (wd === 0 || wd === 6) continue;
    px *= 1.001;
    spy.push([d, px]);
    const exp = new Date(t + 28 * 86400000).toISOString().slice(0, 10);
    chains[d] = [C(exp, Math.round(px), 1, 1.1, 0.5), C(exp, Math.round(px * 1.04), 0.4, 0.5, 0.3)];
  }
  const M = market({ chains, spy });
  const cut = '2023-08-01';
  const dev = lab.simulate(M, 'covered-call', { dte: 30, delta: 0.5 }, { from: '2023-01-02', to: cut, cash: null });
  // poison everything after the cut: a dev run that read any of it would change
  const poisoned = market({
    chains: Object.fromEntries(Object.entries(chains).map(([d, v]) => [d, d > cut ? v.map((c) => ({ ...c, bid: 99 })) : v])),
    spy: spy.map(([d, c]) => [d, d > cut ? c * 3 : c]),
  });
  const dev2 = lab.simulate(poisoned, 'covered-call', { dte: 30, delta: 0.5 }, { from: '2023-01-02', to: cut, cash: null });
  ok('no peeking: the tuning half reads nothing after the cut', JSON.stringify(dev.rounds) === JSON.stringify(dev2.rounds) && dev.rounds.length > 3, dev.rounds.length);
  ok('no peeking: no dev round ends after the cut', dev.rounds.every((r) => r.end <= cut && r.exp <= cut));
  ok('cutDate: 60% of the way through the quote days', lab.cutDate(M.chains) > '2023-08-01' && lab.cutDate(M.chains) < '2023-08-15', lab.cutDate(M.chains));
}

// ---------------------------------------------------------------- scoring
{
  const rounds = [
    { start: '2020-01-01', end: '2020-07-01', r: 0.10 },
    { start: '2020-07-01', end: '2021-01-01', r: -0.20 },
  ];
  const s = lab.stats(rounds);
  ok('stats: total is the compounded rounds', near(s.total, 1.1 * 0.8 - 1), s);
  ok('stats: drawdown from the peak after the first round', near(s.maxDD, 0.2), s);
  ok('stats: CAGR over calendar years', near(s.cagr, (1.1 * 0.8) ** (1 / (366 / 365.25)) - 1), s);
  ok('stats: no rounds is zeros, not NaN', lab.stats([]).cagr === 0 && lab.stats([]).n === 0);
}

// ---------------------------------------------------------------- the fetcher
{
  const w = dolt.weekdays('2024-09-20', '2024-09-24');
  ok('weekdays: Friday, Monday, Tuesday', w.join() === '2024-09-20,2024-09-23,2024-09-24', w);
  ok('query: one symbol, one day, on the primary key', /WHERE date='2024-09-20' AND act_symbol='SPY'/.test(dolt.query('SPY', '2024-09-20')));
  let threw = false;
  try { dolt.query("SPY' OR '1'='1", '2024-09-20'); } catch (e) { threw = true; }
  ok('query: a symbol that is not a ticker is refused, never pasted into SQL', threw);
  const rows = dolt.parse({ query_execution_status: 'Success', rows: [
    { expiration: '2024-10-18', strike: '570.00', call_put: 'Put', bid: '5.10', ask: '5.14', vol: '0.1500', delta: '-0.4000', gamma: '0.0100', theta: '-0.2000', vega: '0.6000', rho: '-0.1000' },
    { expiration: '2024-10-18', strike: '575.00', call_put: 'Call', bid: '0.00', ask: '', vol: null, delta: '0.5', gamma: '0', theta: '0', vega: '0', rho: '0' },
  ] });
  ok('parse: numbers are numbers, Put is P and Call is C', rows[0][1] === 570 && rows[0][2] === 'P' && rows[0][3] === 5.1 && rows[1][2] === 'C', rows);
  ok('parse: a 0 bid stays 0 and a blank is null', rows[1][3] === 0 && rows[1][4] === null && rows[1][5] === null, rows[1]);
  ok('parse: no rows is an empty day, not an error', dolt.parse({ query_execution_status: 'Success', rows: [] }).length === 0);
  let t1 = false, t2 = false;
  try { dolt.parse({ query_execution_status: 'Error', query_execution_message: 'query error: context deadline exceeded' }); } catch (e) { t1 = /deadline/.test(e.message); }
  try { dolt.parse({ query_execution_status: 'Success', rows: new Array(dolt.ROW_CAP).fill({}) }); } catch (e) { t2 = /cap/.test(e.message); }
  ok('parse: a server timeout is an error, so the day is asked again rather than written empty', t1);
  ok('parse: a page at the row cap may be truncated, so it is refused', t2);
}
(async () => {
  let calls = 0;
  const flaky = async () => {
    calls++;
    if (calls < 3) return { ok: true, json: async () => ({ query_execution_status: 'Error', query_execution_message: 'context deadline exceeded' }) };
    return { ok: true, json: async () => ({ query_execution_status: 'Success', rows: [] }) };
  };
  const got = await dolt.fetchDay('SPY', '2024-09-20', { get: flaky, pause: async () => {} });
  ok('fetchDay: a timeout is retried until the server answers', calls === 3 && got.length === 0, calls);
  let gaveUp = false;
  try { await dolt.fetchDay('SPY', '2024-09-20', { tries: 2, get: async () => ({ ok: false, status: 503 }), pause: async () => {} }); } catch (e) { gaveUp = /503/.test(e.message); }
  ok('fetchDay: gives up after its tries and says why', gaveUp);

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

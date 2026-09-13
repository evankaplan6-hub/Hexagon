'use strict';
// Assertions for whale watch (src/whales.js) and the lab that scores it (tools/whale-lab.js):
// what counts as a bet, what the floor says about it, and what copying it pays.
//
//   node tools/whale-test.js
const { betsFrom, describe } = require('../src/whales');
const { normalizeFill } = require('../src/venues/polymarket');
const lab = require('./whale-lab');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;
const H = 3600;
const fill = (over) => ({ wallet: '0xw', name: 'whale', tx: 'x', ts: 0, side: 'BUY', conditionId: 'C1', outcomeIndex: 0, outcome: 'Yes', price: 0.5, size: 1000, usd: 500, title: 'A vs B', slug: 's', eventSlug: 'e1', ...over });

// ---------------------------------------------------------------- normalizing the public feed
{
  const f = normalizeFill({ proxyWallet: '0xABC', side: 'BUY', conditionId: 'C', outcomeIndex: 1, outcome: 'No', price: 0.4, size: 100, usdcSize: 40, timestamp: 1789000000, title: 'T', eventSlug: 'ev', transactionHash: '0xt' });
  ok('wallet is lower-cased so leaderboard and feed keys agree', f.wallet === '0xabc', f.wallet);
  ok('usdcSize is the dollars', f.usd === 40 && f.side === 'BUY' && f.outcomeIndex === 1 && f.ts === 1789000000, f);
  ok('usd falls back to price x size', normalizeFill({ conditionId: 'C', price: 0.4, size: 100, side: 'SELL' }).usd === 40);
  ok('a fill with no market is dropped', normalizeFill({ price: 0.4, size: 100 }) === null);
}

// ---------------------------------------------------------------- what counts as a bet
{
  const b = betsFrom([fill({ ts: 0, usd: 6000, price: 0.50 }), fill({ ts: 60, usd: 5000, price: 0.52, tx: 'y' })], { minUsd: 10000 });
  ok('two buys that sum past the bar are one bet', b.length === 1, b);
  ok('the bet is priced at the fill that crossed the bar, not the first', b[0].price === 0.52 && b[0].ts === 60 && b[0].tx === 'y', b[0]);
  ok('the bet carries the running total', b[0].usd === 11000, b[0].usd);

  ok('buys under the bar are not a bet', betsFrom([fill({ usd: 9999 })], { minUsd: 10000 }).length === 0);
  ok('a single buy at the bar is a bet', betsFrom([fill({ usd: 10000 })], { minUsd: 10000 }).length === 1);

  const spread = betsFrom([fill({ ts: 0, usd: 6000 }), fill({ ts: 7 * H, usd: 6000 })], { minUsd: 10000, windowSec: 6 * H });
  ok('buys further apart than the window do not add up', spread.length === 0, spread);

  const churn = betsFrom([fill({ ts: 0, usd: 8000 }), fill({ ts: 10, side: 'SELL', usd: 7000 }), fill({ ts: 20, usd: 8000 })], { minUsd: 10000 });
  ok('sells net against buys, so cycling inventory is not conviction', churn.length === 0, churn);

  const more = betsFrom([fill({ ts: 0, usd: 12000 }), fill({ ts: 100, usd: 50000 })], { minUsd: 10000 });
  ok('a wallet that keeps adding is still one bet', more.length === 1 && more[0].ts === 0, more);

  const order = betsFrom([fill({ ts: 100, usd: 5000, price: 0.6 }), fill({ ts: 0, usd: 6000, price: 0.4 })], { minUsd: 10000 });
  ok('fills are ordered by time before summing', order.length === 1 && order[0].ts === 100 && order[0].price === 0.6, order);

  const two = betsFrom([fill({ usd: 12000 }), fill({ usd: 12000, wallet: '0xother' }), fill({ usd: 12000, conditionId: 'C2' })], { minUsd: 10000 });
  ok('different wallets and different markets are different bets', two.length === 3, two.length);

  const hedge = betsFrom([fill({ usd: 12000, outcomeIndex: 0 }), fill({ usd: 12000, outcomeIndex: 1, outcome: 'No' }), fill({ usd: 12000, conditionId: 'C2' })], { minUsd: 10000 });
  ok('both sides of one market are flagged hedged', hedge.filter((b) => b.hedged).length === 2 && hedge.find((b) => b.conditionId === 'C2').hedged === false, hedge.map((b) => [b.conditionId, b.hedged]));

  const avg = betsFrom([fill({ ts: 0, usd: 5000, size: 10000, price: 0.5 }), fill({ ts: 1, usd: 6000, size: 10000, price: 0.6 })], { minUsd: 10000 })[0];
  ok('avg is dollars bought over shares bought', near(avg.avg, 0.55), avg.avg);
  ok('junk fills are skipped, not thrown on', betsFrom([null, { conditionId: 'C' }, fill({ usd: 12000 })], { minUsd: 10000 }).length === 1);
}

// ---------------------------------------------------------------- what the floor says
{
  const bet = { wallet: '0x5e94', name: 'pleaseplease123', outcome: 'Arizona Diamondbacks', outcomeIndex: 1, usd: 53614, price: 0.555, title: 'Texas Rangers vs. Arizona Diamondbacks', hedged: false };
  const t = describe(bet, { rank: 6, pnl: 827137, period: 'MONTH' }, { ks: { px: 0.57 } });
  ok('one plain sentence with the size, side, price and market first', t.startsWith('pleaseplease123 bought $54K on Arizona Diamondbacks at 56c · Texas Rangers vs. Arizona Diamondbacks'), t);
  ok('rank and profit, then the Kalshi price of the same outcome', / · #6 in sports this month, \+\$827K · Kalshi 57c now$/.test(t), t);
  // public/app.js splits on ' · ' and shows the first part as the bubble
  ok('the first clause stands alone for the bubble', t.split(' · ')[0] === 'pleaseplease123 bought $54K on Arizona Diamondbacks at 56c', t.split(' · ')[0]);
  const anon = describe({ ...bet, name: '', hedged: true }, null);
  ok('no name falls back to the wallet, no rank or Kalshi is simply left out', anon.startsWith('0x5e94… bought') && !/Kalshi|#/.test(anon), anon);
  ok('a hedge says so', /likely hedging$/.test(anon), anon);
  ok('millions read as millions', describe({ ...bet, usd: 1250000 }, null).includes('$1.3M'));
  ok('a bet during the game says so', / · during the game$/.test(describe(bet, null, { inPlay: true })));
  ok('an unknown start says nothing', !/during/.test(describe(bet, null, { inPlay: null })));
  const no = describe({ ...bet, outcome: 'No', title: 'Will Getafe CF win on 2026-09-13?' }, null);
  ok('"No" carries its market in the first clause, and the market is not repeated', no.split(' · ')[0] === 'pleaseplease123 bought $54K on No (Will Getafe CF win on 2026-09-13?) at 56c' && no.split(' · ').length === 1, no);
  ok('"Over" too', describe({ ...bet, outcome: 'Over', title: 'Rockies vs. Tigers: O/U 8.5' }, null).startsWith('pleaseplease123 bought $54K on Over (Rockies vs. Tigers: O/U 8.5) at 56c'));
}

// ---------------------------------------------------------------- settlement and timing
{
  ok('a settled winner pays 1', lab.payout({ resolved: true, prices: [1, 0] }, 0) === 1);
  ok('a settled loser pays 0', lab.payout({ resolved: true, prices: [1, 0] }, 1) === 0);
  ok('a split market pays its final price', lab.payout({ resolved: true, prices: [0.5, 0.5] }, 1) === 0.5);
  ok('an unsettled market pays nothing yet', lab.payout({ resolved: false, prices: [0.99, 0.01] }, 0) === null);
  ok('an unknown market pays nothing yet', lab.payout(undefined, 0) === null);

  const m = { gameStart: '2026-09-11 19:00:00+00' };
  ok("Polymarket's game start format is read as UTC", lab.startTs(m) === Date.UTC(2026, 8, 11, 19) / 1000, lab.startTs(m));
  ok('a bet before the start is pre-game', lab.phase({ ts: lab.startTs(m) - 1 }, m) === 'pre-game');
  ok('a bet at or after the start is in-play', lab.phase({ ts: lab.startTs(m) }, m) === 'in-play');
  ok('no start time is its own bucket', lab.phase({ ts: 0 }, {}) === 'no start time');
}

// ---------------------------------------------------------------- what copying pays
{
  ok('win at 50c, no costs: $100 buys 200 shares, +$100', near(lab.copyPnl({ price: 0.5 }, 1, { slip: 0, fee: 0 }), 100));
  ok('lose: −$100', near(lab.copyPnl({ price: 0.5 }, 0, { slip: 0, fee: 0 }), -100));
  ok('slippage raises the price paid: win at 50c+2c', near(lab.copyPnl({ price: 0.5 }, 1, { slip: 0.02, fee: 0 }), 100 / 0.52 - 100));
  ok('the fee comes out of the shares bought', near(lab.copyPnl({ price: 0.5 }, 1, { slip: 0, fee: 0.01 }), 100 / (0.5 * 1.01) - 100));
  ok('no copy once slippage reaches a dollar', lab.copyPnl({ price: 0.98 }, 1, { slip: 0.02, fee: 0 }) === null);
  ok('no copy of an unsettled bet', lab.copyPnl({ price: 0.5 }, null, { slip: 0, fee: 0 }) === null);
}

// ---------------------------------------------------------------- summaries count games once
{
  const s = lab.summarize([{ pnl: 100, event: 'g1', won: true, price: 0.5 }, { pnl: -100, event: 'g2', won: false, price: 0.5 }]);
  ok('return is profit over stake', s.n === 2 && s.events === 2 && s.roi === 0 && s.win === 0.5, s);
  const piled = lab.summarize([...Array(10)].map(() => ({ pnl: 50, event: 'g1', won: true, price: 0.6 })).concat([{ pnl: -50, event: 'g2', won: false, price: 0.6 }]));
  ok('ten bets on one game are one game for t', piled.events === 2 && piled.n === 11, piled);
  const many = lab.summarize([...Array(10)].map((_, i) => ({ pnl: i % 2 ? 60 : 40, event: `g${i}`, won: true, price: 0.6 })));
  ok('t grows with independent games that agree', many.t > 10, many.t);
  ok('an empty list summarizes to zeros', lab.summarize([]).n === 0 && lab.summarize([]).t === 0);

  const bets = [
    ...[...Array(10)].map(() => ({ wallet: 'good', price: 0.5, pay: 1 })),
    ...[...Array(10)].map(() => ({ wallet: 'bad', price: 0.5, pay: 0 })),
    ...[...Array(3)].map(() => ({ wallet: 'few', price: 0.5, pay: 1 })),
  ];
  const r = lab.rankWallets(bets, { minBets: 10 });
  ok('wallets rank by return on their own bets', r.length === 2 && r[0].wallet === 'good' && near(r[0].roi, 1) && near(r[1].roi, -1), r);
  ok('a wallet with too few bets is not rankable', !r.some((x) => x.wallet === 'few'));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

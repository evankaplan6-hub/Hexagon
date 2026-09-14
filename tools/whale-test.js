'use strict';
// Assertions for whale watch (src/whales.js) and the lab that scores it (tools/whale-lab.js):
// what counts as a bet, what the floor says about it, what copying it pays, and that it is said
// once: not again when the feed corrects a half-indexed fill, and not again after a restart.
//
//   node tools/whale-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { betsFrom, describe, makeWhaleWatch, recordDays, readRecord, panelEntry } = require('../src/whales');
const pm = require('../src/venues/polymarket');
const { normalizeFill, outcomeIndex, fillKey } = pm;
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
  ok('usd falls back to price x size', normalizeFill({ conditionId: 'C', outcomeIndex: 0, price: 0.4, size: 100, side: 'SELL' }).usd === 40);
  ok('a fill with no market is dropped', normalizeFill({ outcomeIndex: 0, price: 0.4, size: 100 }) === null);
}

// ---------------------------------------------------------------- an outcome the feed has not indexed yet
{
  // what /activity served for tx 0xb68803c14a… at 21:17:18Z on 2026-09-13, and 75s later
  const half = { proxyWallet: '0x821d', name: 'Flaznorp', side: 'BUY', conditionId: '0x8e46', outcomeIndex: 999, outcome: 'Under', price: 0.6272, size: 16000, usdcSize: 10035, timestamp: 1789334235, title: 'AA Argentinos Juniors vs. Gimnasia: O/U 2.5', slug: 'arg-aaj-gim-2026-09-13-total-2pt5', eventSlug: '', transactionHash: '0xb68803c14a' };
  const whole = { ...half, outcomeIndex: 1, eventSlug: 'arg-aaj-gim-2026-09-13-more-markets' };
  ok('outcome 999 is dropped, not guessed', normalizeFill(half) === null);
  ok('the corrected copy of the same fill is kept', normalizeFill(whole) && normalizeFill(whole).outcomeIndex === 1, normalizeFill(whole));
  ok('outcome 0 is a real side, not a missing one', normalizeFill({ ...whole, outcomeIndex: 0 }).outcomeIndex === 0);
  ok('an index sent as text still reads', normalizeFill({ ...whole, outcomeIndex: '1' }).outcomeIndex === 1);
  const junk = [999, 2, -1, 0.5, null, undefined, '', ' ', 'abc', true, NaN, [1]];
  ok('no other value is an outcome: a missing index is not quietly outcome 0', junk.every((x) => outcomeIndex(x) === null && normalizeFill({ ...whole, outcomeIndex: x }) === null), junk.map((x) => outcomeIndex(x)));

  // the lab's cache was written before normalizeFill checked, so betsFrom checks too
  ok("betsFrom skips a 999 fill it is handed directly (the lab's cache)", betsFrom([fill({ outcomeIndex: 999, usd: 50000 })], { minUsd: 10000 }).length === 0);

  // the incident: a real bet already called, then a new fill arrives half-indexed, then corrected
  const called = fill({ ts: 0, usd: 15000, outcomeIndex: 1, outcome: 'Under', tx: 'a' });
  const late = { wallet: '0xw', name: 'whale', tx: 'b', ts: 900, side: 'BUY', conditionId: 'C1', outcome: 'Under', price: 0.52, size: 23000, usd: 12000, title: 'A vs B', slug: 's' };
  const read = (rows) => betsFrom(rows.map((r) => normalizeFill({ proxyWallet: r.wallet, name: r.name, side: r.side, conditionId: r.conditionId, outcomeIndex: r.outcomeIndex, outcome: r.outcome, price: r.price, size: r.size, usdcSize: r.usd, timestamp: r.ts, title: r.title, slug: r.slug, eventSlug: r.eventSlug, transactionHash: r.tx })).filter(Boolean), { minUsd: 10000, windowSec: 6 * H });
  const r2 = read([called, { ...late, outcomeIndex: 999, eventSlug: '' }]);
  ok('a half-indexed fill beside a called bet makes no second bet and no hedge', r2.length === 1 && r2[0].outcomeIndex === 1 && !r2[0].hedged, r2.map((b) => [b.key, b.hedged]));
  const r3 = read([called, { ...late, outcomeIndex: 1, eventSlug: 'e1' }]);
  ok('corrected, it adds to the same bet: still one, still not a hedge', r3.length === 1 && r3[0].key === r2[0].key && !r3[0].hedged, r3.map((b) => [b.key, b.hedged]));
  const both = read([{ ...late, outcomeIndex: 999, eventSlug: '' }, { ...late, outcomeIndex: 1, eventSlug: 'e1' }]);
  ok('both copies in one read are one bet, under the real outcome', both.length === 1 && both[0].outcomeIndex === 1 && both[0].usd === 12000 && !both[0].hedged, both);
}

// ---------------------------------------------------------------- one fill served twice
{
  const once = fill({ tx: 't1', usd: 6000 });
  ok('the same fill twice in one read counts once', betsFrom([once, { ...once }], { minUsd: 10000 }).length === 0);
  const twice = betsFrom([once, { ...once }, fill({ tx: 't2', usd: 6000 })], { minUsd: 10000 });
  ok('...and the bet is not inflated by it', twice.length === 1 && twice[0].usd === 12000, twice);
  // a sweep: one tx, one size, two price levels (ferrariChampions2026's feed on 2026-09-14)
  const sweep = betsFrom([fill({ tx: 't3', usd: 6000, price: 0.34 }), fill({ tx: 't3', usd: 6000, price: 0.35 })], { minUsd: 10000 });
  ok('one tx at two prices is two fills', sweep.length === 1 && sweep[0].usd === 12000, sweep);
  ok('fillKey tells the sweep apart and the repeat not', fillKey(fill({ tx: 't3', price: 0.34 })) !== fillKey(fill({ tx: 't3', price: 0.35 })) && fillKey(once) === fillKey({ ...once }));
  const noTx = betsFrom([fill({ tx: undefined, usd: 6000 }), fill({ tx: undefined, usd: 6000 })], { minUsd: 10000 });
  ok("without a tx identical rows are separate fills (the lab's compact cache)", noTx.length === 1 && noTx[0].usd === 12000, noTx);
}

// ---------------------------------------------------------------- which record files a restart reads
{
  const ms = (s) => Date.parse(s);
  ok('twelve hours inside one ET day is one file', recordDays(ms('2026-09-13T15:00:00Z'), ms('2026-09-14T03:00:00Z')).join() === '2026-09-13', recordDays(ms('2026-09-13T15:00:00Z'), ms('2026-09-14T03:00:00Z')));
  ok('twelve hours across ET midnight is yesterday and today', recordDays(ms('2026-09-13T20:00:00Z'), ms('2026-09-14T08:00:00Z')).join() === '2026-09-13,2026-09-14', recordDays(ms('2026-09-13T20:00:00Z'), ms('2026-09-14T08:00:00Z')));
  ok('ET, not UTC: 02:00Z on the 14th is still the 13th in New York', recordDays(ms('2026-09-13T22:00:00Z'), ms('2026-09-14T02:00:00Z')).join() === '2026-09-13');
  const long = recordDays(ms('2027-03-14T04:59:00Z'), ms('2027-03-16T04:59:00Z'));
  ok('a longer window reads every day, the 23-hour spring-forward day included', long.join() === '2027-03-13,2027-03-14,2027-03-15,2027-03-16', long);
}

// ---------------------------------------------------------------- reading the record back
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-whale-'));
  try {
    const now = Date.parse('2026-09-14T08:00:00Z'), from = now / 1000 - 12 * 3600;
    const rec = (over) => JSON.stringify({ t: '2026-09-13T21:18:33.947Z', key: '0xw|C1|1', wallet: '0xw', name: 'whale', conditionId: 'C1', outcomeIndex: 1, outcome: 'Under', title: 'A vs B', eventSlug: 'e1', ts: from + 3600, price: 0.6, usd: 15284, hedged: false, rank: 6, walletPnl: 864821, kalshi: null, inPlay: null, ...over });
    fs.writeFileSync(path.join(dir, 'whales-2026-09-13.jsonl'), [
      rec({}),
      '{"t":"2026-09-13T21:19:00Z","key":"torn',                                // a write cut off mid-line
      '', 'null', '42', '[]', 'not json at all',
      rec({ key: undefined }), rec({ ts: 'soon' }),                             // no key, no usable ts
      rec({ key: '0xw|C9|1', ts: from - 60 }),                                  // made before the window
      rec({ key: '0xw|C1|999', outcomeIndex: 999, eventSlug: '' }),             // a half-indexed call
      rec({ t: '2026-09-13T21:20:34.239Z', rank: 7 }),                          // a restart's repeat
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(dir, 'whales-2026-09-14.jsonl'), rec({ t: '2026-09-14T06:13:21Z', key: '0xw|C2|0', conditionId: 'C2', outcomeIndex: 0, outcome: 'Broncos', ts: now / 1000 - 600 }) + '\n');
    fs.writeFileSync(path.join(dir, 'whales-2026-09-12.jsonl'), rec({ t: '2026-09-12T12:00:00Z', key: '0xw|C8|0', outcomeIndex: 0, ts: from + 60 }) + '\n');   // a day outside the window is not opened
    const got = readRecord(dir, from, now);
    ok('torn, foreign, keyless, old and half-indexed lines are skipped', got.map((r) => r.key).join() === '0xw|C1|1,0xw|C2|0', got.map((r) => r.key));
    ok('a key said twice is read back once, as first said', got[0]?.rank === 6, got[0]);
    ok("yesterday's and today's files are both read, in the order the bets were called", got[1]?.conditionId === 'C2');
    ok('a directory with no record is simply nothing', readRecord(path.join(dir, 'missing'), from, now).length === 0);
    const e = panelEntry({ ts: 100, key: 'k' });
    ok('a sparse record still makes a whole panel row: nulls, never undefined', Object.values(e).every((v) => v !== undefined) && e.url === null && e.usd === null && e.hedged === false, e);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
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

// ---------------------------------------------------------------- the watch itself, across a restart
// The Polymarket calls are stubbed in-process: the leaderboard is one wallet, and /activity serves
// whatever raw rows `feed` holds, through the real normalizeFill. Times are minutes before now, far
// inside the 20-minute freshness and the 12-hour memory, so the wall clock cannot flip a result.
async function watchTests() {
  const real = { fetchLeaderboard: pm.fetchLeaderboard, fetchActivity: pm.fetchActivity };
  const dirs = [];
  const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-whale-')); dirs.push(d); return d; };
  let feed = [];
  pm.fetchLeaderboard = async ({ offset = 0 } = {}) => (offset ? [] : [{ wallet: '0xw', name: 'whale', rank: 3, pnl: 500000, vol: 2e6 }]);
  pm.fetchActivity = async (wallet) => feed.filter((r) => r.proxyWallet === wallet).map(pm.normalizeFill).filter(Boolean);
  const now = Math.floor(Date.now() / 1000);
  const row = (over) => ({ proxyWallet: '0xw', name: 'whale', side: 'BUY', conditionId: 'C1', outcomeIndex: 1, outcome: 'Under', price: 0.52, size: 30000, usdcSize: 15600, timestamp: now - 600, title: 'Padres vs. Giants: O/U 7.5', slug: 'mlb-sd-sf-total-7pt5', eventSlug: 'mlb-sd-sf', transactionHash: '0xa', ...over });
  const desk = () => ({ logs: [], log(agent, kind, pnl, text) { this.logs.push({ agent, kind, text }); }, due: () => true, quotes: { pm: new Map() }, pairs: [] });
  const config = (over) => ({ dataDir: tmp(), record: true, whaleTop: 25, whalePeriod: 'MONTH', whaleMinUsd: 10000, whaleWindowMin: 360, whaleFreshMin: 20, whalePerPoll: 5, whaleBoardMin: 30, ...over });
  const whaleLines = (E) => E.logs.filter((l) => l.kind === 'WHALE');
  const recordLines = (dir) => fs.readdirSync(dir).filter((f) => /^whales-.*\.jsonl$/.test(f)).flatMap((f) => fs.readFileSync(path.join(dir, f), 'utf8').split('\n')).filter((l) => { try { return !!JSON.parse(l).key; } catch { return false; } });

  try {
    // ---- a deploy: the same bet is on the feed before and after
    {
      const cfg = config();
      feed = [row()];
      const E1 = desk(), before = makeWhaleWatch(cfg);
      await before.step(E1);
      ok('first run: the bet is called once and recorded once', whaleLines(E1).length === 1 && recordLines(cfg.dataDir).length === 1, [whaleLines(E1), recordLines(cfg.dataDir)]);
      const shown = before.snapshot().recent[0];

      // the restart also finds a torn line and some junk in today's record
      const file = fs.readdirSync(cfg.dataDir).find((f) => f.startsWith('whales-'));
      fs.appendFileSync(path.join(cfg.dataDir, file), '{"t":"2026-09-14T13:4\n\nnot json\n[]\n');
      const E2 = desk(), after = makeWhaleWatch(cfg);
      await after.step(E2);
      ok('after the restart the same bet is not called again', whaleLines(E2).length === 0, whaleLines(E2));
      ok('...nor recorded again', recordLines(cfg.dataDir).length === 1, recordLines(cfg.dataDir).length);
      // (no WHALE line in both: the panel row has to come from the record, not from calling it again)
      ok('...the malformed lines did not stop the read back', whaleLines(E2).length === 0 && after.snapshot().recent.length === 1, after.snapshot().recent);
      ok('...and it is back on the panel exactly as it was shown live', whaleLines(E2).length === 0 && JSON.stringify(after.snapshot().recent[0]) === JSON.stringify(shown), [after.snapshot().recent[0], shown]);
      ok('the leaderboard line still says the watch is on', E2.logs.some((l) => l.kind === 'SCAN'), E2.logs);

      feed = [row(), row({ conditionId: 'C2', outcomeIndex: 0, outcome: 'Broncos', transactionHash: '0xb', timestamp: now - 60, usdcSize: 20000, eventSlug: 'nfl-den-kc' })];
      await after.step(E2);
      await after.step(E2);
      ok('a new bet after the restart is called once', whaleLines(E2).length === 1 && /Broncos/.test(whaleLines(E2)[0].text), whaleLines(E2));
      const rec = after.snapshot().recent;
      ok('the panel lists it first, then the restored one', rec.length === 2 && rec[0].outcome === 'Broncos' && rec[1].outcome === 'Under', rec.map((x) => x.outcome));
      ok('restored and live rows have the same fields', Object.keys(rec[0]).join() === Object.keys(rec[1]).join(), rec.map((x) => Object.keys(x)));
      ok('the record has the two bets, once each', recordLines(cfg.dataDir).length === 2);
    }

    // ---- the feed's half-indexed fill, read by read
    {
      const cfg = config();
      const E = desk(), w = makeWhaleWatch(cfg);
      const calls = () => whaleLines(E).length;
      feed = [row()];                                                                               // $15.6K on Under: a bet
      await w.step(E);
      feed = [row(), row({ transactionHash: '0xc', timestamp: now - 120, usdcSize: 12000, outcomeIndex: 999, eventSlug: '' })];   // more on Under, half-indexed
      await w.step(E);
      ok('a half-indexed fill beside a called bet says nothing new', calls() === 1, whaleLines(E));
      feed = [row(), row({ transactionHash: '0xc', timestamp: now - 120, usdcSize: 12000 })];     // the same fill, corrected
      await w.step(E);
      ok('corrected, it is the same bet: nothing new either', calls() === 1, whaleLines(E));
      ok('no call says "both sides"', !whaleLines(E).some((l) => /hedging/.test(l.text)), whaleLines(E));

      feed = [row({ conditionId: 'C3', outcomeIndex: 999, outcome: 'Alejandro Moro Canas', transactionHash: '0xafbb', timestamp: now - 60, usdcSize: 37073, eventSlug: '' })];
      await w.step(E);
      ok('a new bet whose only fill is half-indexed waits', calls() === 1, whaleLines(E));
      feed = [row({ conditionId: 'C3', outcomeIndex: 0, outcome: 'Alejandro Moro Canas', transactionHash: '0xafbb', timestamp: now - 60, usdcSize: 37073, eventSlug: 'atp-canas-blancan' })];
      await w.step(E);
      await w.step(E);
      ok('...and is called once, when the corrected copy arrives', calls() === 2 && /Alejandro Moro Canas/.test(whaleLines(E)[1].text), whaleLines(E));
      ok('...with its link, which the half-indexed copy lacked', w.snapshot().recent[0]?.url === 'https://polymarket.com/event/atp-canas-blancan', w.snapshot().recent[0]);
      ok('the record holds two bets and no outcome 999', recordLines(cfg.dataDir).length === 2 && recordLines(cfg.dataDir).every((l) => JSON.parse(l).outcomeIndex !== 999), recordLines(cfg.dataDir));
    }

    // ---- RECORD=0, and a data directory that is not there
    {
      const base = tmp();
      const cfg = config({ record: false, dataDir: path.join(base, 'never-made') });
      feed = [row()];
      const E = desk(), w = makeWhaleWatch(cfg);
      await w.step(E);
      ok('RECORD=0 with no record to read: the bet is still called', whaleLines(E).length === 1 && !w.snapshot().lastError, [whaleLines(E), w.snapshot().lastError]);
      ok('...and nothing is written', !fs.existsSync(cfg.dataDir));
      const E2 = desk(), broken = makeWhaleWatch(config({ dataDir: undefined }));
      await broken.step(E2);
      ok('a record that cannot even be looked for does not stop the watch', whaleLines(E2).length === 1 && !broken.snapshot().lastError, [E2.logs, broken.snapshot().lastError]);
    }
  } finally {
    Object.assign(pm, real);
    for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  }
}

watchTests()
  .catch((e) => { fail++; console.log(`  FAIL  threw: ${e.stack}`); })
  .finally(() => {
    console.log(`${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  });

'use strict';
// Assertions for what each venue charges a taker, read from the venue itself.
//
// Two things were wrong for the desk's whole life before 2026-09-15. Polymarket was modelled as
// free (PM_TAKER_FEE, default 0) while 99% of its markets charge shares x rate x p x (1-p) at 3-7%
// by category -- including the Fed market the desk already traded. And Kalshi's per-series fee
// multiplier was loaded for eleven series only, looked up by the text before a ticker's first
// hyphen (wrong for 151 series), and cached as full rate after any failed call until a restart.
// No network: http.getJSON is stubbed before the venue modules load.
//
//   node tools/fees-test.js
const httpPath = require.resolve('../src/http');
let seriesCalls = 0, failNext = false;
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true, children: [], paths: [],
  exports: {
    getJSON: async (url) => {
      if (failNext) { failNext = false; throw new Error('HTTP 429'); }
      if (/\/series$/.test(url)) {
        seriesCalls++;
        return { series: [
          { ticker: 'KXMLBGAME', fee_multiplier: 0.5, fee_type: 'quadratic', category: 'Sports' },
          { ticker: 'KXNFLWINS', fee_multiplier: 1, fee_type: 'quadratic', category: 'Sports' },
          { ticker: 'KXNFLWINS-ANY', fee_multiplier: 0, fee_type: 'quadratic', category: 'Sports' },
          { ticker: 'KXBTCY', fee_multiplier: 0, fee_type: 'quadratic', category: 'Crypto' },
          { ticker: 'KXFEDDECISION', fee_multiplier: 1, fee_type: 'quadratic_with_maker_fees', category: 'Economics' },
        ] };
      }
      const m = url.match(/\/series\/([A-Z0-9-]+)$/);
      if (m) return { series: { fee_multiplier: m[1] === 'KXZERO' ? 0 : 1 } };
      return {};
    },
    recentErrors: () => 0, stats: {}, noteError: () => {},
  },
};

const pm = require('../src/venues/polymarket');
const ks = require('../src/venues/kalshi');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

(async () => {
  group('Polymarket: the rate comes from the market, and unknown is not free');
  {
    ok('feesEnabled false is a zero rate (geopolitics)', pm.feeRateOf({ feesEnabled: false, feeSchedule: { rate: 0.05 } }) === 0);
    ok('a published schedule is used', pm.feeRateOf({ feesEnabled: true, feeSchedule: { exponent: 1, rate: 0.05, takerOnly: true } }) === 0.05);
    ok('a schedule given as strings is still read', pm.feeRateOf({ feeSchedule: { rate: '0.04' } }) === 0.04);
    ok('no schedule is unknown (null), not zero', pm.feeRateOf({ feesEnabled: true }) === null && pm.feeRateOf({}) === null);
    ok('a negative rate is not a rate', pm.feeRateOf({ feeSchedule: { rate: -1 } }) === null);
    // docs.polymarket.com/trading/fees: 100 shares at 50c on a 5% market is $1.25
    ok('100 shares at 50c on 0.05 cost $1.25', Math.abs(pm.fee(100, 0.5, 0.05) - 1.25) < 1e-12, pm.fee(100, 0.5, 0.05));
    ok('crypto at 0.07 is 1.75c a share at 50c, the same as Kalshi at full rate', Math.abs(pm.feePerShare(0.5, 0.07) - ks.feePerContract(0.5)) < 1e-12);
    ok('symmetric around 50c', Math.abs(pm.feePerShare(0.2, 0.05) - pm.feePerShare(0.8, 0.05)) < 1e-12);
    ok('zero at and beyond the tails', pm.feePerShare(0, 0.05) === 0 && pm.feePerShare(1, 0.05) === 0 && pm.feePerShare(1.2, 0.05) === 0);
    ok('rounded to 5 decimals like the venue', pm.fee(3, 0.333, 0.05) === Math.round(3 * 0.05 * 0.333 * 0.667 * 1e5) / 1e5);
    const n = pm.normalize({ id: 1, question: 'q', outcomes: '["Yes","No"]', clobTokenIds: '["a","b"]', bestBid: '0.4', bestAsk: '0.41', feesEnabled: true, feeType: 'economics_fees', feeSchedule: { exponent: 1, rate: 0.05 } });
    ok('normalize carries the rate and the fee type', n && n.feeRate === 0.05 && n.feeType === 'economics_fees', n);
  }

  group('Kalshi: every series from one call, looked up by its real ticker');
  {
    const n = await ks.loadSeriesIndex();
    ok('the index loads every series in the response', n === 5 && seriesCalls === 1, n);
    ok('MLB bills at half', ks.multFor('KXMLBGAME-26SEP171940DETCWS-DET') === 0.5);
    // KXNFLWINS-ANY is its own series with its own multiplier; the first-hyphen rule read KXNFLWINS
    ok('a hyphenated series is found by longest prefix', ks.seriesFor('KXNFLWINS-ANY-27-KC') === 'KXNFLWINS-ANY' && ks.multFor('KXNFLWINS-ANY-27-KC') === 0, ks.seriesFor('KXNFLWINS-ANY-27-KC'));
    ok('...without stealing its shorter neighbour', ks.seriesFor('KXNFLWINS-27KC-T10') === 'KXNFLWINS' && ks.multFor('KXNFLWINS-27KC-T10') === 1);
    ok('a zero-fee series really bills zero', ks.fee(100, 0.5, 0.07, 'KXBTCY-27JAN0100-B22500') === 0);
    ok('an unknown series bills at full rate', ks.multFor('KXNOSUCH-26-X') === 1);
    ok('the index keeps category and fee type', ks.seriesInfo.get('KXFEDDECISION').feeType === 'quadratic_with_maker_fees' && ks.seriesInfo.get('KXBTCY').category === 'Crypto');
    failNext = true;
    let threw = false;
    try { await ks.loadSeriesIndex(); } catch { threw = true; }
    ok('a failed reload throws to the caller', threw);
    ok('...and keeps the last good table', ks.multFor('KXMLBGAME-X') === 0.5);
  }

  group('Kalshi: a failed per-series lookup is not cached as full rate');
  {
    failNext = true;
    await ks.loadFeeMultipliers(['KXZERO']);
    ok('after a failure the series is still unknown (billed at full rate for now)', ks.multFor('KXZERO-1') === 1);
    await ks.loadFeeMultipliers(['KXZERO']);
    ok('and the next load gets its real multiplier', ks.multFor('KXZERO-1') === 0);
  }

  group('Kalshi: markets carry when they close and when they are expected to settle');
  {
    const m = ks.normalize({ ticker: 'KXFEDDECISION-26SEP-H0', event_ticker: 'KXFEDDECISION-26SEP', close_time: '2026-09-16T17:59:00Z', expected_expiration_time: '2026-09-16T18:05:00Z', latest_expiration_time: '2026-12-16T00:00:00Z', can_close_early: true, status: 'determined', result: '', settlement_value_dollars: '0.3500', market_type: 'binary' });
    ok('close, expected and latest expiration', m.closeTime === '2026-09-16T17:59:00Z' && m.expectedExpiration === '2026-09-16T18:05:00Z' && m.latestExpiration === '2026-12-16T00:00:00Z', m);
    ok('can close early, settlement value and market type', m.canCloseEarly === true && m.settlementValue === 0.35 && m.marketType === 'binary', m);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

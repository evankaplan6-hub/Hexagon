'use strict';
// A fake market for the stocks, crypto and options desk (src/desk/), shared by tools/desk-test.js and
// tools/desk-check-test.js: a quiet crypto market, a calm SPY with a 6-point ATR, and a Wednesday
// afternoon that trends up, triggers the options book, hits a 2x target and breaks VWAP. No network:
// every feed is an object the test edits between rounds. (Not a *-test.js file, so tools/test.js
// does not run it on its own.)
const clock = require('../src/desk/clock');

const DAY = '2026-09-23';                       // a Wednesday
const at = (hm) => clock.etToUtc(`${DAY}T${hm}:00`);

// One-minute SPY bars from 9:31 (Cboe labels a bar by the minute it ends) to `to`, climbing `slope` a
// minute from 700; `drops` sets a minute's close outright.
function upDay({ to = 12 * 60 + 30, slope = 0.02, drops = {} } = {}) {
  const ones = [];
  let px = 700;
  for (let m = 571; m <= to; m++) {
    const o = px; px = drops[m] != null ? drops[m] : px + slope;
    ones.push({ m, o, h: Math.max(o, px) + 0.01, l: Math.min(o, px) - 0.01, c: px, v: 1000 });
  }
  return ones;
}

// The desk's config, with a $9,000 crypto book so each coin's slot is a round $3,000.
const deskConfig = (dir) => ({
  dataDir: dir, buildSha: '',
  desk: {
    on: true, cryptoUsd: 9000, stocksUsd: 10000, optionsUsd: 1000, coins: ['BTC-USD', 'ETH-USD', 'SOL-USD'],
    cryptoVolTarget: 0.4, cryptoLookback: 30, stockSym: 'SPY', stockVolTarget: 0.15, stockLookback: 20,
    rebalBand: 0.1, cryptoFeeBps: 40, stockFeeBps: 0, optionFee: 0.03, options: true, maxDailyDdPct: 0.05, everySec: 10,
    chainSkewSec: 120,
  },
});

// `now` is the test's clock (a function), read when the market is built and whenever the quote moves.
function fakeMarket(now) {
  const W = {};
  const uday = (t) => new Date(t).toISOString().slice(0, 10);
  // crypto: 60 finished days to yesterday, alternating 3% moves (about 57% a year: a 0.69 weight)
  const cryptoDaily = (px) => {
    const out = [], y = Date.parse(`${uday(now() - 86400000)}T00:00:00Z`);
    let c = px;
    for (let i = 59; i >= 0; i--) { c = c * Math.exp(i % 2 ? 0.03 : -0.03); out.push({ day: uday(y - i * 86400000), t: y - i * 86400000, o: c, h: c, l: c, c, v: 1 }); }
    return out;
  };
  W.ticks = { 'BTC-USD': { bid: 84000, ask: 84000.01, last: 84000, at: now() }, 'ETH-USD': { bid: 2700, ask: 2700.05, last: 2700, at: now() }, 'SOL-USD': { bid: 200, ask: 200.01, last: 200, at: now() } };
  W.daily = { 'BTC-USD': cryptoDaily(84000), 'ETH-USD': cryptoDaily(2700), 'SOL-USD': cryptoDaily(200) };
  W.books = {};
  for (const [id, t] of Object.entries(W.ticks)) W.books[id] = { bids: [{ price: t.bid, size: 1e6 }], asks: [{ price: t.ask, size: 1e6 }] };
  // SPY: 30 calm sessions to Tuesday with a 6-point range (ATR 6)
  const spyDaily = [];
  for (let i = 30, day = '2026-09-22'; i > 0; i--, day = clock.prevTradingDay(day)) spyDaily.unshift({ day, o: 700, h: 703 + (i % 2), l: 697 + (i % 2), c: 700 + (i % 2), v: 1 });
  W.spyDaily = spyDaily;
  W.chain = null;
  // today's minute bars up to `to`, and a quote from the last of them, a minute old
  const setMinutes = (to, drops) => {
    const ones = upDay({ to, drops });
    W.intra = { day: DAY, bars: ones.map((b) => ({ ...b, day: DAY, t: at(`${String(Math.floor(b.m / 60)).padStart(2, '0')}:${String(b.m % 60).padStart(2, '0')}`) })) };
    const last = ones[ones.length - 1];
    W.quote = { sym: 'SPY', bid: last.c - 0.01, ask: last.c + 0.01, last: last.c, prevClose: 700, open: 700, at: now() - 60000, fileAt: now() };
  };
  const call = (k, bid, ask, high) => ({ osi: `SPY260923C00${k}000`, strike: k, right: 'C', bid, ask, bidSz: 100, askSz: 100, high });
  const feeds = {
    stats: { ok: 0, err: 0, lastError: null, bytes: 0 },
    async ticker(id) { return W.ticks[id]; },
    async book(id) { return W.books[id]; },
    async cryptoDaily(id) { return W.daily[id]; },
    async quote() { return W.quote; },
    async intraday() { return W.intra; },
    async daily() { return W.spyDaily; },
    async expiry(sym, day) { return W.chain && W.chain.expiry === day ? W.chain : null; },
  };
  return { W, feeds, setMinutes, call };
}

// The whole afternoon, round by round, for a test that only needs the ledger it leaves behind:
// crypto and SPY bought at 12:31, two 705 calls at 12:36, the first sold at its 2x target at 12:41,
// the runner at the bid on a VWAP break at 12:46. Each chain carries its own time, the close of the
// bar that round acts on, as Cboe's does. `setNow(t)` moves the test's clock.
async function playTrendDay(desk, M, setNow) {
  setNow(at('12:31')); M.setMinutes(12 * 60 + 30); await desk.step();
  setNow(at('12:36')); M.setMinutes(12 * 60 + 35);
  M.W.chain = { expiry: DAY, spot: 703.7, at: at('12:35'), calls: [M.call(704, 0.3, 0.31, 0.5), M.call(705, 0.09, 0.1, 0.15), M.call(706, 0.04, 0.05, 0.1)], puts: [] };
  await desk.step();
  setNow(at('12:41')); M.setMinutes(12 * 60 + 40);
  M.W.chain = { ...M.W.chain, at: at('12:40'), calls: [M.call(704, 0.5, 0.51, 0.6), M.call(705, 0.21, 0.22, 0.22), M.call(706, 0.08, 0.09, 0.1)] };
  await desk.step();
  setNow(at('12:46')); M.setMinutes(12 * 60 + 45, { 761: 701.5, 762: 701.2, 763: 701, 764: 700.9, 765: 700.8 });
  M.W.chain = { ...M.W.chain, at: at('12:45'), calls: [M.call(704, 0.1, 0.11, 0.6), M.call(705, 0.05, 0.06, 0.22), M.call(706, 0.01, 0.02, 0.1)] };
  await desk.step();
}

module.exports = { DAY, at, upDay, deskConfig, fakeMarket, playTrendDay };

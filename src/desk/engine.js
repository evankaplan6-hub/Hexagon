'use strict';
// The stocks, crypto and options desk: six paper books, the six bots that run them, and the ledger.
//
// PAPER ONLY. There is no broker here and no way to reach one: every fill is src/desk/broker.js
// pricing an order against public market data, written into this desk's own ledger. It shares the
// process with the prediction-market desk (src/engine.js), which keeps running until its last
// positions settle, and nothing else: its own state file, its own journal, its own loop.
//
//   data/desk/state.json               the working copy (temp-then-rename, like the other desk's)
//   data/desk/journal-YYYY-MM-DD.jsonl  append-only: every fill, rebalance and 12:30 verdict
//
// THE BOOKS (src/desk/books.js has the rules and why):
//   crypto   BTC, ETH, SOL, XRP, DOGE, a slot each, volatility-targeted at 40% a year; checked once a UTC day
//            (XRP and DOGE since 2026-09-30, each with its own slot of cash: addCoins)
//   stocks   SPY, volatility-targeted at 15% a year; checked once a trading day after the open
//   options  SPY same-day options on trend days only, Evan's afternoon rules
//   scalps   SPY same-day options held for minutes: the stack's 0DTE scalp method (since 2026-09-29)
//   dips     SPY same-day calls on a morning dip under VWAP: Evan's own best trade, as rules (2026-09-29)
//   runners  coins popping right now, scanned every 3 minutes, held until they fall 10% from their best
//            (2026-09-30, after Evan's QNT)
// The crypto and stocks books are scored against simply holding what they trade, from their first trade;
// the three option books and the runner book against their own cash.
//
// THE BOTS, one job each, in the order a round runs them:
//   HOLT  market data     prices from Coinbase (live) and Cboe (15 minutes behind)
//   ILSA  volatility      how hard each market has been swinging, and SPY's trend today
//   TESS  risk            stale data, the daily loss limit, the calendar
//   RIGO  settlement      marks every position; takes the option books' exits
//   BRAM  signals         what each book should hold now; the 12:30 test, the entry triggers
//   KETT  execution       fills every order against the book or the touch
// PRED sits at the seventh desk: the prediction-market desk, trading in paper beside it (server.js feeds it).
const fs = require('fs');
const path = require('path');
const clock = require('./clock');
const feedsLib = require('./feeds');
const broker = require('./broker');
const books = require('./books');
const watchdog = require('../watchdog');

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const r6 = (x) => Math.round(x * 1e6) / 1e6;
const utcDay = (t) => new Date(t).toISOString().slice(0, 10);
const iso = (t) => (Number.isFinite(t) ? new Date(t).toISOString() : null);
const MIN = 60000, HOUR = 3600000;
const WATCHDOG_EVERY_MS = 15000;

const AGENTS = [
  { key: 'BRAM', n: '01', role: 'SIGNALS', color: '#3b82f6' },
  { key: 'KETT', n: '02', role: 'EXECUTION', color: '#22c55e' },
  { key: 'RIGO', n: '03', role: 'SETTLEMENT', color: '#ef4444' },
  { key: 'TESS', n: '04', role: 'RISK', color: '#ec4899' },
  { key: 'HOLT', n: '05', role: 'MARKET DATA', color: '#e5e7eb' },
  { key: 'ILSA', n: '06', role: 'VOLATILITY', color: '#f59e0b' },
  { key: 'PRED', n: '07', role: 'WIND-DOWN', color: '#a855f7' },
];
const COIN_NAME = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ether', 'SOL-USD': 'Solana', 'XRP-USD': 'XRP', 'DOGE-USD': 'Dogecoin' };
// the coins Coinbase sells in coarser steps than the millionth the paper broker otherwise fills in
const COIN_STEP = { 'DOGE-USD': 0.1 };
const BOOKS = ['crypto', 'stocks', 'options', 'scalps', 'dips', 'runners'];
// the books that hold option contracts rather than sleeves of a market
const optionBook = (key) => key === 'options' || key === 'scalps' || key === 'dips';
// the books that joined a desk already running, with the setting that gives each its cash
const LATER = { scalps: 'scalpsUsd', dips: 'dipsUsd', runners: 'runnersUsd' };
// each book's value in a minute of the history
const FIELD = { crypto: 'c', stocks: 's', options: 'o', scalps: 'x', dips: 'dp', runners: 'rn' };
const short = (id) => String(id).replace(/-USD$/, '');

class Desk {
  // `feeds` and `now` are injectable so tools/desk-test.js can run whole rounds with no network and
  // no clock. `legacy` is a function returning the prediction-market desk's summary, or null.
  // `onStall` is server.js ending the process when the watchdog finds the loop stuck (watchdogCheck).
  constructor(cfg, { feeds, now, legacy, onStall } = {}) {
    this.cfg = cfg;
    this.D = cfg.desk;
    this.dir = path.join(cfg.dataDir, 'desk');
    this.file = path.join(this.dir, 'state.json');
    this.now = now || Date.now;
    this.feeds = feeds || feedsLib.makeFeeds();
    this.legacy = legacy || (() => null);
    this.onStall = onStall || null;
    this.fees = { cryptoBps: this.D.cryptoFeeBps, stockBps: this.D.stockFeeBps, optionPerContract: this.D.optionFee };
    this.state = this.load();
    this.mkt = { coins: {}, spy: { quote: null, quoteAt: 0, intra: null, intraAt: 0, bars5: [], vwap: [], vwap1: [], daily: null, dailyAt: 0, atr: null }, chain: null };
    // the runner book's list of what Coinbase trades and in what steps (read every six hours), and when its scan last failed
    this.mkt.runners = { steps: null, stepsAt: 0, failAt: 0 };
    for (const id of Object.keys(this.state.books.crypto.sleeves)) this.mkt.coins[id] = { tick: null, tickAt: 0, daily: null, dailyAt: 0, vol: null, w: null };
    this.agentStatus = Object.fromEntries(AGENTS.map((a) => [a.key, { lastActive: 0, runs: 0, note: '' }]));
    this.timers = {};
    this.halt = null;
    this.stale = { crypto: true, stocks: true };
    this.cycle = 0;
    this.stepping = false;
    this.dirty = false;
    this.lastStepMs = 0;
    this.beat = this.now();
  }

  // ---------------------------------------------------------------- the ledger
  fresh() {
    const t = this.now(), D = this.D;
    const coins = Object.fromEntries(D.coins.map((id) => [id, sleeve(r2(D.cryptoUsd / D.coins.length))]));
    return {
      version: 1, startedAt: t,
      books: {
        crypto: { key: 'crypto', initial: D.cryptoUsd, startedAt: t, sleeves: coins },
        stocks: { key: 'stocks', initial: D.stocksUsd, startedAt: t, sleeves: { [D.stockSym]: sleeve(D.stocksUsd) } },
        options: lotBook('options', D.optionsUsd, t),
        scalps: lotBook('scalps', D.scalpsUsd, t),
        dips: lotBook('dips', D.dipsUsd, t),
        runners: lotBook('runners', D.runnersUsd, t),
      },
      fills: [], log: [], history: [],
      dayKey: null, dayStart: null,
    };
  }
  load() {
    // A ledger that exists but will not parse is a corrupt book, not a new account: refuse to start
    // rather than overwrite it on the next save (the other desk's rule, src/engine.js load).
    if (!fs.existsSync(this.file)) return this.fresh();
    let s;
    try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
    catch (e) { throw new Error(`desk state ${this.file} is unreadable (${e.message}). Refusing to start and overwrite it; move it aside to begin a fresh paper account.`); }
    if (!s || s.version !== 1 || !s.books) throw new Error(`desk state ${this.file} has unexpected version ${s && s.version}. Refusing to start.`);
    this.chargeHoldingFee(s);
    for (const key of Object.keys(LATER)) this.addBook(s, key);
    this.addCoins(s);
    return s;
  }
  // The scalp and dip books joined a desk that had been running since 2026-09-25 (Evan, 2026-09-29), and the
  // runner book on 2026-09-30. A
  // ledger from before one of them gets it as cash, and the desk's value in its history and at the start
  // of today is raised by that cash, as if the book had been there idle all along: the P&L they show does
  // not move.
  addBook(s, key) {
    if (s.books[key]) return;
    const t = this.now(), cash = this.D[LATER[key]];
    s.books[key] = lotBook(key, cash, t);
    for (const p of s.history || []) p.e = r2(p.e + cash);
    if (s.dayStart > 0) s.dayStart = r2(s.dayStart + cash);
    (s.added || (s.added = {}))[key] = { at: t, cash, journaled: false };
  }
  // XRP and DOGE joined a crypto book that had held BTC, ETH and SOL since 2026-09-25 (Evan, 2026-09-30:
  // BTC and ETH "barely move for any real profit"). A coin in DESK_COINS that the ledger has no slot for
  // gets one the size of the slots it has, as new cash, the way the scalp and dip books joined: nothing is
  // sold to pay for it, so no fee and no trade the rule did not ask for. The book's value and holding's in
  // its history, and the desk's at the start of today, are raised by that cash, so the P&L they show does
  // not move. Its first check comes on the next round with fresh prices, and holding starts at that trade,
  // as it did for the first three. A coin taken out of DESK_COINS keeps its slot: nothing sells one out.
  addCoins(s) {
    const c = s.books.crypto, have = Object.values(c.sleeves);
    const slot = have.length ? r2(have.reduce((a, sl) => a + sl.initial, 0) / have.length) : r2(this.D.cryptoUsd / this.D.coins.length);
    const t = this.now();
    for (const id of this.D.coins) {
      if (c.sleeves[id]) continue;
      c.sleeves[id] = sleeve(slot);
      c.initial = r2(c.initial + slot);
      for (const p of s.history || []) {
        p.e = r2(p.e + slot);
        if (Number.isFinite(p.c)) p.c = r2(p.c + slot);
        if (Number.isFinite(p.bc)) p.bc = r2(p.bc + slot);
      }
      if (s.dayStart > 0) s.dayStart = r2(s.dayStart + slot);
      (s.addedCoins || (s.addedCoins = {}))[id] = { at: t, cash: slot, journaled: false };
    }
  }
  // The fee a book pays to buy, in basis points; simply holding pays it to buy in too.
  feeBps(key) { return (key === 'crypto' ? this.fees.cryptoBps : this.fees.stockBps) || 0; }
  // Until 2026-09-26 holding bought in free of the fee the book pays on a buy, so every book began about
  // 0.4% of its slot behind holding before any price moved. Evan's call that day: holding pays it too, as
  // anyone simply holding would. A ledger from before then gets the fee its holding would have paid, at the
  // rate the book pays now, and the holding values in its history are put on the same footing, once (a
  // ledger that has the fee is left alone).
  chargeHoldingFee(s) {
    for (const [key, field] of [['crypto', 'bc'], ['stocks', 'bs']]) {
      const sleeves = Object.values((s.books[key] && s.books[key].sleeves) || {});
      const unset = sleeves.filter((sl) => sl.benchPx > 0 && sl.benchFeeBps == null);
      if (!unset.length) continue;
      const bps = this.feeBps(key);
      for (const sl of unset) sl.benchFeeBps = bps;
      // The history holds holding's value only from the minute every sleeve had bought in (before that, the
      // book's own value). When every one of them bought in without the fee, each of those values lacks it.
      if (!bps || unset.length !== sleeves.length) continue;
      const from = Math.max(...sleeves.map((sl) => sl.benchAt || 0));
      for (const p of s.history || []) if (p.t >= from && Number.isFinite(p[field])) p[field] = r2(p[field] / (1 + bps / 10000));
    }
  }
  save() {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('desk save failed', e.message); }
  }
  journal(kind, payload) {
    const t = this.now();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(path.join(this.dir, `journal-${clock.et(t).day}.jsonl`), JSON.stringify({ t: new Date(t).toISOString(), kind, ...payload }) + '\n');
    } catch (e) { if (this.due('journal-err', 300)) this.log('TESS', 'OPS', null, `journal write failed: ${String(e.message).slice(0, 100)}`); }
  }
  due(name, sec) {
    const t = this.now();
    if (!this.timers[name] || t - this.timers[name] >= sec * 1000) { this.timers[name] = t; return true; }
    return false;
  }
  // What the bot says on the floor is the first clause of its latest line, cut on a word.
  touch(agent, note) {
    const a = this.agentStatus[agent];
    a.lastActive = this.now(); a.runs++;
    if (!note) return;
    let n = String(note).split('·')[0].trim();
    if (n.length > 30) n = n.slice(0, 30).replace(/\s+\S*$/, '').trim();
    a.note = n;
  }
  log(agent, kind, pnl, text, extra) {
    const e = { t: this.now(), agent, kind, pnl: pnl == null ? null : r2(pnl), text, ...(extra || {}) };
    this.state.log.unshift(e);
    // The routine rounds (prices, swings, marks, all clear) come thirteen times an hour, and the desk
    // trades about once a day. In one ring they pushed its trades and decisions out of the page's frame
    // within hours and out of the ring in about thirty: on 26 September the page said "Nothing of those
    // kinds yet" beside a crypto book holding the three coins it had bought eight hours before the oldest
    // line it was sent. Routine lines now make way for each other, the newest ROUTINE_KEEP of them kept,
    // so the rest of the ring holds weeks of what the desk did.
    let routine = 0;
    this.state.log = this.state.log.filter((x) => logLevel(x) !== 'quiet' || ++routine <= ROUTINE_KEEP);
    if (this.state.log.length > LOG_KEEP) this.state.log.length = LOG_KEEP;
    this.touch(agent, text);
    this.dirty = true;
    if (!this.quiet) console.log(`${new Date(e.t).toISOString().slice(11, 19)} desk ${agent} ${kind.padEnd(7)} ${text}`);
  }

  // ---------------------------------------------------------------- valuation
  coinBid(id) { const c = this.mkt.coins[id]; return c && c.tick ? c.tick.bid : null; }
  spyBid() { const q = this.mkt.spy.quote; return q ? (q.bid || q.last) : null; }
  sleeveValue(sl, px) { return r2(sl.cash + (sl.qty > 0 && px > 0 ? sl.qty * px : sl.qty > 0 ? sl.cost : 0)); }
  lotBid(lot) {
    const ch = this.mkt.chain;
    const row = ch && ch.expiry === lot.expiry ? (lot.right === 'C' ? ch.calls : ch.puts).find((r) => r.osi === lot.osi) : null;
    return row && Number.isFinite(row.bid) ? row.bid : lot.mark ?? lot.entry;
  }
  bookValue(key) {
    const b = this.state.books[key];
    if (key === 'crypto') return r2(Object.entries(b.sleeves).reduce((a, [id, sl]) => a + this.sleeveValue(sl, this.coinBid(id)), 0));
    if (key === 'stocks') return r2(Object.values(b.sleeves).reduce((a, sl) => a + this.sleeveValue(sl, this.spyBid()), 0));
    // coins, marked at the last scan's price
    if (key === 'runners') return r2(b.cash + b.lots.reduce((a, l) => a + l.qty * (l.mark ?? l.entry), 0));
    return r2(b.cash + b.lots.reduce((a, l) => a + l.qty * 100 * (l.mark ?? l.entry), 0));
  }
  // What simply holding the same thing from the book's first trade would be worth now: the whole slot,
  // bought at that trade's mid price, with the fee the book pays on a buy (0.40% for crypto, none for SPY)
  // coming out of the slot, as it does for any buyer.
  // A slot that has not bought in yet (a coin that joined the book later, before its first check) is held
  // as the cash it is; a book none of whose slots has bought in has no holding to show.
  benchValue(key) {
    const b = this.state.books[key];
    if (!b.sleeves) return null;
    const all = Object.entries(b.sleeves);
    if (!all.some(([, sl]) => sl.benchPx > 0)) return null;
    let v = 0;
    for (const [id, sl] of all) {
      if (!(sl.benchPx > 0)) { v += sl.initial; continue; }
      const px = key === 'crypto' ? this.coinBid(id) : this.spyBid();
      if (!(px > 0)) return null;
      v += sl.initial * px / (sl.benchPx * (1 + (sl.benchFeeBps || 0) / 10000));
    }
    return r2(v);
  }
  // What holding paid to buy in: the fee on what the slot bought, the slot less that fee. A slot not
  // bought in yet has paid nothing.
  benchFee(key) {
    const b = this.state.books[key];
    if (!b.sleeves) return null;
    const all = Object.values(b.sleeves);
    if (!all.some((sl) => sl.benchPx > 0)) return null;
    let f = 0;
    for (const sl of all) {
      if (!(sl.benchPx > 0)) continue;
      const k = (sl.benchFeeBps || 0) / 10000;
      f += sl.initial * k / (1 + k);
    }
    return r2(f);
  }
  equity() { return r2(BOOKS.reduce((a, k) => a + this.bookValue(k), 0)); }
  initial() { const b = this.state.books; return r2(BOOKS.reduce((a, k) => a + b[k].initial, 0)); }

  // ---------------------------------------------------------------- the loop
  async start() {
    // The watchdog first, so that a first round that never finishes is caught too.
    if (this.onStall && this.cfg.watchdogSec > 0) {
      this.beat = this.wdLast = this.now();
      setInterval(() => this.watchdogCheck(), WATCHDOG_EVERY_MS);
    }
    const B = this.state.books;
    this.log('TESS', 'OPS', null, `desk online · paper only · ${BOOKS.map((k) => `${k} ${usd(B[k].initial)}`).join(', ')} · equity ${usd(this.equity())}`);
    if (!this.state.startedJournaled) { this.journal('DESK_START', { books: Object.fromEntries(BOOKS.map((k) => [k, B[k].initial])) }); this.state.startedJournaled = true; }
    for (const [book, a] of Object.entries(this.state.added || {})) {
      if (!a.journaled) { this.journal('BOOK_START', { book, cash: a.cash }); a.journaled = true; this.dirty = true; }
    }
    for (const [sym, a] of Object.entries(this.state.addedCoins || {})) {
      if (!a.journaled) { this.journal('SLEEVE_START', { book: 'crypto', sym, cash: a.cash }); a.journaled = true; this.dirty = true; }
    }
    await this.step();
    setInterval(() => { this.step().catch((e) => console.error('desk step', e)); }, this.D.everySec * 1000);
    setInterval(() => { if (this.dirty) this.save(); }, 10000);
  }
  async step() {
    if (this.stepping) return;
    this.stepping = true;
    const t0 = this.now();
    try {
      this.cycle++;
      await this.holt();
      this.ilsa();
      this.tess();
      await this.rigo();
      await this.bram();
      this.record();
    } catch (e) {
      this.log('TESS', 'OPS', null, `desk round failed: ${String(e && e.message).slice(0, 140)}`);
    } finally {
      this.beat = this.now();
      this.lastStepMs = this.beat - t0;
      this.stepping = false;
    }
  }

  // ---------------------------------------------------------------- the watchdog
  // A round that never returns holds the loop for good (`stepping` turns every later round away), and a
  // desk that is up and finishing nothing looks from outside like a quiet market: the prediction-market
  // desk's lesson of 2026-09-19 (src/watchdog.js). The page's light says Stalled after two minutes. Past
  // WATCHDOG_SEC (300) with no finished round the desk says so in its log and journal, saves, and asks
  // server.js to end the process, and Fly's restart policy ("always") brings it back. The other desk's
  // rules: never a laptop that was asleep, and in live mode (the prediction-market desk's, in this same
  // process, with an order possibly in flight) it only reports, every ten minutes.
  watchdogCheck(t = this.now()) {
    const limitMs = (this.cfg.watchdogSec || 0) * 1000;
    if (!(limitMs > 0)) return null;
    const asleep = watchdog.wasSuspended({ now: t, last: this.wdLast, everyMs: WATCHDOG_EVERY_MS });
    this.wdLast = t;
    if (asleep) { this.beat = t; return null; }
    const stalled = watchdog.stalledLoops({ now: t, limitMs, beats: { desk: this.beat } });
    if (!stalled.length) return null;
    const live = this.cfg.mode === 'live';
    if (live && !this.due('watchdog-live', 600)) return stalled;
    this.log('TESS', 'OPS', null, `WATCHDOG: no round finished in ${Math.round(stalled[0].idleMs / 1000)}s (limit ${this.cfg.watchdogSec}s)${this.stepping ? ', one still open' : ''} · ${live ? 'live mode, not restarting' : 'saving and restarting'}`);
    this.journal('WATCHDOG', { stalled, stepping: !!this.stepping, restarting: !live });
    if (live) return stalled;
    this.save();
    if (this.onStall) this.onStall(stalled);
    return stalled;
  }

  // ---------------------------------------------------------------- HOLT: market data
  // Crypto every round (three small calls). SPY's quote every 30 seconds and its minute bars every
  // minute while the session is on the tape -- the tape runs 15 minutes late, so that is until 4:25
  // -- and rarely otherwise. Daily bars hourly for crypto, every few hours for SPY. The option chain
  // is 6 MB and is read only when the options book needs it (optionChain below).
  async holt() {
    const t = this.now(), e = clock.et(t);
    const s = clock.session(e.day);
    const onTape = !!s && e.min >= s.open && e.min < s.close + 25;
    const jobs = [];
    const fail = (what) => (err) => { if (this.due(`holt-${what}`, 300)) this.log('HOLT', 'OPS', null, `${what} did not load: ${String(err && err.message).slice(0, 90)} · trying again`); };
    for (const [id, c] of Object.entries(this.mkt.coins)) {
      jobs.push(this.feeds.ticker(id).then((x) => { if (x) { c.tick = x; c.tickAt = t; } }).catch(fail(`${short(id)} price`)));
      if (!c.daily || t - c.dailyAt > HOUR || utcDay(c.dailyAt) !== utcDay(t)) {
        jobs.push(this.feeds.cryptoDaily(id, t).then((x) => { if (x && x.length) { c.daily = x; c.dailyAt = t; } }).catch(fail(`${short(id)} daily bars`)));
      }
    }
    const S = this.mkt.spy;
    if (t - S.quoteAt > (onTape ? 30000 : 10 * MIN)) jobs.push(this.feeds.quote(this.D.stockSym).then((x) => { if (x) { S.quote = x; S.quoteAt = t; } }).catch(fail('SPY quote')));
    if (t - S.intraAt > (onTape ? 60000 : 30 * MIN)) jobs.push(this.feeds.intraday(this.D.stockSym).then((x) => { if (x && x.bars.length) { S.intra = x; S.intraAt = t; } }).catch(fail('SPY minute bars')));
    if (!S.daily || t - S.dailyAt > 3 * HOUR || clock.et(S.dailyAt).day !== e.day) jobs.push(this.feeds.daily(this.D.stockSym).then((x) => { if (x && x.length) { S.daily = x; S.dailyAt = t; } }).catch(fail('SPY daily bars')));
    await Promise.all(jobs);
    if (S.intra) {
      // the scalp book reads five-minute bars
      S.bars5 = feedsLib.fiveMinute(S.intra.bars);
      S.vwap = feedsLib.vwapSeries(S.bars5);
      // the options and dip books read the one-minute bars themselves (Cboe publishes a minute only once it is over)
      S.vwap1 = feedsLib.vwapSeries(S.intra.bars);
    }
    if (S.daily) {
      // A day file that stops short of the last session gives an ATR from the wrong fortnight: the
      // stack's checker calls that stale and gives no verdict, and so does this.
      const day = S.intra ? S.intra.day : e.day;
      S.atr = feedsLib.atr14(S.daily, day);
      if (S.atr) S.atr.stale = S.atr.asof !== clock.prevTradingDay(day);
    }
    const live = Object.values(this.mkt.coins).filter((c) => c.tick && t - c.tickAt < 60000).length;
    if (this.due('holt-say', 600)) {
      const q = S.quote, lag = q && q.at ? Math.round((t - q.at) / MIN) : null;
      this.log('HOLT', 'SCAN', null, `${live}/${this.D.coins.length} coins live from Coinbase · SPY ${q ? q.last.toFixed(2) : 'no quote'}${lag != null && onTape ? `, ${lag} min behind` : ''} · market ${clock.describe(t)}`);
    } else this.touch('HOLT');
  }

  // ---------------------------------------------------------------- ILSA: how hard each market is swinging
  ilsa() {
    const t = this.now(), D = this.D;
    const moods = [];
    for (const [id, c] of Object.entries(this.mkt.coins)) {
      const closes = c.daily ? c.daily.map((b) => b.c) : null;
      const v = closes ? books.volTargetWeight(closes, { target: D.cryptoVolTarget, lookback: D.cryptoLookback, perYear: 365 }) : null;
      c.vol = v ? v.vol : null; c.w = v ? v.w : null;
      if (v) moods.push(`${short(id)} ${Math.round(v.vol * 100)}%`);
    }
    const S = this.mkt.spy;
    const closes = this.spyCloses();
    const sv = closes ? books.volTargetWeight(closes, { target: D.stockVolTarget, lookback: D.stockLookback, perYear: 252 }) : null;
    S.vol = sv ? sv.vol : null; S.w = sv ? sv.w : null;
    if (sv) moods.push(`SPY ${Math.round(sv.vol * 100)}%`);
    if (moods.length && this.due('ilsa-say', 3600)) this.log('ILSA', 'RESEARCH', null, `swinging (a year): ${moods.join(', ')} · the more it swings, the less the books hold`);
    else this.touch('ILSA');
    void t;
  }
  // SPY's daily closes through the last finished session. Cboe's daily file can lag a day behind; the
  // quote's own previous close fills in yesterday when it does.
  spyCloses() {
    const S = this.mkt.spy;
    if (!S.daily || !S.daily.length) return null;
    const closes = S.daily.map((b) => b.c);
    const today = clock.et(this.now()).day;
    const prev = clock.prevTradingDay(today);
    const last = S.daily[S.daily.length - 1].day;
    const q = S.quote;
    if (last < prev && q && q.prevClose > 0 && q.at && clock.et(q.at).day === today) closes.push(q.prevClose);
    return closes;
  }

  // ---------------------------------------------------------------- TESS: risk
  tess() {
    const t = this.now(), e = clock.et(t);
    const coins = Object.values(this.mkt.coins);
    this.stale.crypto = coins.some((c) => !c.tick || t - c.tickAt > 60000);
    const s = clock.session(e.day), q = this.mkt.spy.quote;
    const inSession = !!s && e.min >= s.open + 20 && e.min < s.close;
    // the feed runs ~15 minutes late; in the session a quote more than 25 minutes old is a feed that stopped
    this.stale.stocks = !q || !q.at || (inSession && (t - q.at > 25 * MIN || t - this.mkt.spy.quoteAt > 5 * MIN));
    // the day's loss limit, on the whole desk, from the first mark of the Eastern day
    const eq = this.equity();
    if (this.state.dayKey !== e.day) { this.state.dayKey = e.day; this.state.dayStart = eq; }
    const dd = this.state.dayStart > 0 ? eq / this.state.dayStart - 1 : 0;
    const why = dd <= -this.D.maxDailyDdPct ? `down ${(Math.abs(dd) * 100).toFixed(1)}% today, past the ${(this.D.maxDailyDdPct * 100).toFixed(0)}% limit: no new buying until tomorrow` : null;
    if (why && why !== this.halt) this.log('TESS', 'HALT', null, why);
    if (!why && this.halt) this.log('TESS', 'OPS', null, 'new day: buying allowed again');
    this.halt = why;
    if (!clock.calendarCovers(e.day) && this.due('tess-cal', 86400)) this.log('TESS', 'OPS', null, `the market calendar in src/desk/clock.js ends ${clock.LAST_YEAR}: add next year's NYSE holidays`);
    if (this.due('tess-say', 900)) {
      const bits = [this.stale.crypto ? 'crypto prices stale' : 'crypto prices fresh', q ? (this.stale.stocks && inSession ? 'SPY feed stalled' : 'SPY feed ok') : 'no SPY quote yet'];
      this.log('TESS', 'OPS', null, `${this.halt ? 'HALTED' : 'all clear'} · ${bits.join(', ')} · desk ${dd > 0 ? '+' : dd < 0 ? MINUS : ''}${Math.abs(dd * 100).toFixed(2)}% today`);
    } else this.touch('TESS');
  }

  // ---------------------------------------------------------------- RIGO: marks and the options book's exits
  async rigo() {
    const b = this.state.books;
    const o = b.options, x = b.scalps, p = b.dips;
    if (o.lots.length) await this.optionExits();
    if (x.lots.length) await this.scalpExits();
    if (p.lots.length) await this.dipExits();
    for (const l of [...o.lots, ...x.lots, ...p.lots]) l.mark = this.lotBid(l);
    if (this.due('rigo-say', 1800)) {
      const held = [...Object.entries(b.crypto.sleeves), ...Object.entries(b.stocks.sleeves)].filter(([, sl]) => sl.qty > 0).map(([id]) => short(id));
      const n = o.lots.length + x.lots.length + p.lots.length;
      this.log('RIGO', 'RESEARCH', null, `marked ${held.length ? held.join(', ') : 'nothing held'}${n ? ` + ${n} option${n === 1 ? '' : 's'}` : ''} · desk ${usd(this.equity())}`);
    } else this.touch('RIGO');
  }

  // The options book's exits, once per finished one-minute bar while it holds anything (five-minute bars
  // until 2026-09-29): a target hit sells that contract at its target, a one-minute close back through
  // VWAP or the 3:15 minute sells everything at the bid. The chain is read every one of those minutes, as
  // the checks run every minute: a target is a resting limit, and one that filled lets the re-entry look
  // for its fresh trigger from the next minute on. A book still holding after the close (a feed outage all
  // afternoon) is settled at what the option is worth against SPY's close.
  async optionExits() {
    const o = this.state.books.options, S = this.mkt.spy, t = this.now();
    const e = clock.et(t), today = e.day, s = clock.session(today);
    // the tape of a session is over 20 minutes after its close; anything still held then expired
    const afterTape = !s || e.min >= s.close + 20;
    for (const l of o.lots.filter((x) => x.expiry < today || (x.expiry === today && afterTape))) this.settleLot('options', l);
    if (!o.lots.length) return;
    const bars = S.intra ? S.intra.bars : [], last = bars[bars.length - 1];
    if (!last || !o.day || S.intra.day !== o.day.date) return;
    if (o.day.exitBarM === last.m) return;          // this minute was already handled
    // every finished minute since the last one handled (normally just the one), from the minute the
    // position was bought on: a feed that skipped a minute must not skip a VWAP break with it
    const since = o.day.exitBarM == null ? o.day.entryBarM : o.day.exitBarM;
    const fresh = bars.map((b, i) => ({ b, vw: S.vwap1[i] })).filter((x) => x.b.m > since);
    o.day.exitBarM = last.m;
    this.dirty = true;
    await this.optionChain(today, true);
    // no same-day chain in hand (a restart, then Cboe failing): nothing to sell at and no right to write the
    // contracts off as unbid. Try these minutes again next round, as the scalp and dip books do.
    if (!this.mkt.chain || this.mkt.chain.expiry !== today) {
      o.day.exitBarM = since;
      if (this.due('option-nochain', 300)) this.log('RIGO', 'OPS', null, 'options: the option chain did not load · holding, trying again');
      return;
    }
    const dir = o.day.dir;
    const byOsi = (osi, right) => { const ch = this.mkt.chain; return ch && ch.expiry === today ? (right === 'C' ? ch.calls : ch.puts).find((r) => r.osi === osi) : null; };
    // a sale is never held back for a chain out of step with the bars (selling is never blocked), but
    // it is journaled with both times like a buy, and said once on the floor
    const onLast = this.chainSyncAt(this.mkt.chain, today, last.m);
    let said = false;
    const flag = (sync) => { if (!sync.ok && !said) { said = true; this.log('RIGO', 'OPS', null, `options: selling anyway · ${sync.why}`); } };
    for (const lot of [...o.lots]) {
      const row = byOsi(lot.osi, lot.right);
      if (books.targetHit(lot, row)) { flag(onLast); await this.kett({ book: 'options', lot, side: 'sell', px: lot.target, sync: onLast.rec, why: `${lot.role === 'first' ? '2x' : '3x'} target hit` }); }
    }
    if (!o.lots.length) return;
    const brk = fresh.find((x) => books.vwapBreak(x.b, x.vw, dir));
    const clockOut = last.m >= books.ZERO.clock;
    if (brk || clockOut) {
      const why = brk ? `SPY closed ${dir === 'up' ? 'below' : 'above'} VWAP at ${hm(brk.b.m)} (${brk.b.c.toFixed(2)} vs ${brk.vw.toFixed(2)})` : '3:15 clock';
      const sync = brk ? this.chainSyncAt(this.mkt.chain, today, brk.b.m) : onLast;
      flag(sync);
      for (const lot of [...o.lots]) {
        const row = byOsi(lot.osi, lot.right);
        // a contract with no line in a chain that did load is tried again next round, not written off
        if (!row) { o.day.exitBarM = since; if (this.due('option-norow', 300)) this.log('RIGO', 'OPS', null, `options: ${lotName(lot)} is not in the option chain · trying again`); continue; }
        await this.kett({ book: 'options', lot, side: 'sell', market: row, sync: sync.rec, why });
      }
    }
  }
  // Worth its intrinsic value against SPY's last price: what an expiring option pays.
  settleLot(key, lot) {
    const o = this.state.books[key], S = this.mkt.spy, today = clock.et(this.now()).day;
    // against SPY's close on the day it expired: a desk that was down at the close must not settle the lot on
    // a later day's price. Today's last price is the close once the tape is over; a past expiry waits for its
    // daily bar (and is settled on the last price only after a week without one).
    const bar = lot.expiry < today && S.daily ? S.daily.find((b) => b.day === lot.expiry) : null;
    if (lot.expiry < today && !bar && this.now() - clock.etToUtc(`${lot.expiry}T16:00:00`) < 7 * 86400000) {
      if (this.due(`settle-wait-${lot.osi}`, 1800)) this.log('RIGO', 'OPS', null, `${lotName(lot)}: expired ${lot.expiry}, waiting for SPY's close that day to settle it`);
      return;
    }
    const spy = bar ? bar.c : S.quote ? S.quote.last : null;
    const val = spy > 0 ? Math.max(0, lot.right === 'C' ? spy - lot.strike : lot.strike - spy) : 0;
    const cash = r2(val * 100 * lot.qty);
    const pnl = r2(cash - lot.cost);
    o.cash = r2(o.cash + cash); o.realized = r2(o.realized + pnl);
    o.lots = o.lots.filter((x) => x !== lot);
    this.noteExit(key, lot, pnl, false);
    this.journal('SETTLE', { book: key, osi: lot.osi, qty: lot.qty, value: val, spy, pnl });
    this.pushFill({ book: key, sym: lot.osi, label: lotName(lot), side: 'sell', qty: lot.qty, px: r4(val), value: cash, fee: 0, pnl, why: 'expired: worth its intrinsic value' });
    this.log('RIGO', 'SETTLE', pnl, `${lotName(lot)} expired worth ${prem(val)} · ${pnl >= 0 ? 'made' : 'lost'} ${usd(Math.abs(pnl))}`);
  }
  noteExit(key, lot, pnl, targetHit) {
    const o = this.state.books[key], d = o.day;
    const tr = o.trades.find((x) => x.id === lot.trade);
    if (tr) { tr.pnl = r2((tr.pnl || 0) + pnl); tr.open = Math.max(0, (tr.open || 0) - lot.qty); if (!tr.open) tr.closedAt = this.now(); }
    this.dirty = true;
    if (key === 'scalps') { if (tr && !tr.open && d && d.date === tr.date) this.scalpClosed(d, tr); return; }
    if (key === 'dips') { if (tr && !tr.open && d && d.date === tr.date) this.dipClosed(d, tr); return; }
    // the re-entry is earned by the FIRST exit of the first trade hitting its target
    if (d && d.firstExitHit == null && lot.trade === d.firstTrade) d.firstExitHit = !!targetHit;
    // the re-entry's fresh extreme is counted from the minute the book went flat
    if (d && !o.lots.length) d.flatAtIdx = (this.mkt.spy.intra ? this.mkt.spy.intra.bars.length : 0) - 1;
  }
  // A scalp has closed: a loss starts the pause and counts toward the run that ends the day.
  scalpClosed(d, tr) {
    const R = books.SCALP, bars = this.mkt.spy.bars5, last = bars[bars.length - 1];
    if (tr.pnl < 0) { d.lossRun++; d.pauseUntil = last ? last.m + 5 + R.pause : null; } else d.lossRun = 0;
    const done = d.lossRun >= R.maxLossRun ? `${R.maxLossRun} losses in a row` : d.entries >= R.maxTrades ? `${R.maxTrades} trades, the most it takes in a day` : '';
    if (done) {
      d.status = 'done'; d.why = done;
      this.log('BRAM', 'PASS', null, `scalps: done for today · ${done}`);
    }
  }

  // The scalp book's exits, once per finished five-minute bar while it holds its one contract
  // (books.scalpExit): its 1.5x target, SPY back inside the range it broke, 15 minutes without a gain,
  // 30 minutes, or the 3:15 clock. Anything still held after the close is settled like the options book's.
  async scalpExits() {
    const x = this.state.books.scalps, S = this.mkt.spy, t = this.now();
    const e = clock.et(t), today = e.day, s = clock.session(today);
    const afterTape = !s || e.min >= s.close + 20;
    for (const l of x.lots.filter((l) => l.expiry < today || (l.expiry === today && afterTape))) this.settleLot('scalps', l);
    const lot = x.lots[0], d = x.day;
    const bars = S.bars5, last = bars[bars.length - 1];
    if (!lot || !last || !d || !S.intra || S.intra.day !== d.date || d.exitBarM === last.m) return;
    const since = d.exitBarM == null ? lot.barM : d.exitBarM;
    const fresh = bars.filter((b) => b.m > since);
    if (!fresh.length) return;
    await this.optionChain(today, true);
    const ch = this.mkt.chain;
    const row = ch && ch.expiry === today ? (lot.right === 'C' ? ch.calls : ch.puts).find((r) => r.osi === lot.osi) : null;
    // no line for the contract: nothing to judge or sell at, so the bar is tried again next round
    if (!row) { if (this.due('scalp-norow', 300)) this.log('RIGO', 'OPS', null, `scalps: ${lotName(lot)} is not in the option chain · trying again`); return; }
    d.exitBarM = last.m;
    this.dirty = true;
    const ex = books.scalpExit(lot, fresh, last, row);
    if (!ex) return;
    const R = books.SCALP, at = hm(ex.bar.m + 5);
    const why = {
      target: () => `${R.target}x target hit`,
      stop: () => `SPY closed back ${lot.dir === 'up' ? 'under' : 'over'} ${lot.level.toFixed(2)} at ${at} (${ex.bar.c.toFixed(2)})`,
      clock: () => '3:15 clock',
      hold: () => `${R.hold} minutes up`,
      time: () => `${R.timeStop} minutes in and bid ${prem(row.bid)}, not above its ${prem(lot.entry)}`,
    }[ex.kind]();
    const sync = this.chainSync(ch, today, ex.kind === 'stop' ? ex.bar.m : last.m);
    if (!sync.ok) this.log('RIGO', 'OPS', null, `scalps: selling anyway · ${sync.why}`);
    await this.kett({ book: 'scalps', lot, side: 'sell', px: ex.kind === 'target' ? lot.target : null, market: row, sync: sync.rec, why });
  }

  // A dip trade has closed: a loss ends the day (the morning's low was not the low), and so do two trades.
  dipClosed(d, tr) {
    const R = books.DIP;
    const done = tr.pnl < 0 ? `a trade lost ${usd(Math.abs(tr.pnl))}` : d.entries >= R.maxTrades ? `${R.maxTrades} trades, the most it takes in a day` : '';
    if (done) {
      d.status = 'done'; d.why = done;
      this.log('BRAM', 'PASS', null, `dips: done for today · ${done}`);
    }
  }

  // The dip book's exits, on every new one-minute bar while it holds its calls (books.dipExit). SPY alone
  // decides the stop, the reclaim that sells the first call, the runner's fade, 12:30 and 3:15, so the
  // 6 MB chain is read only to sell, and every five minutes while the runner rides for its trail.
  async dipExits() {
    const x = this.state.books.dips, S = this.mkt.spy, t = this.now(), R = books.DIP;
    const e = clock.et(t), today = e.day, s = clock.session(today);
    const afterTape = !s || e.min >= s.close + 20;
    for (const l of x.lots.filter((l) => l.expiry < today || (l.expiry === today && afterTape))) this.settleLot('dips', l);
    const d = x.day, bars = S.intra ? S.intra.bars : [], last = bars[bars.length - 1];
    if (!x.lots.length || !last || !d || S.intra.day !== d.date || d.exitM === last.m) return;
    const since = d.exitM == null ? x.lots[0].barM : d.exitM;
    const fresh = bars.map((b, i) => ({ ...b, vw: S.vwap1[i] })).filter((b) => b.m > since);
    if (!fresh.length) return;
    // what SPY alone says, and whether the runner's bid is due a look
    const spyOnly = x.lots.map((lot) => books.dipExit(lot, fresh, last, null));
    const trailDue = x.lots.some((l, k) => l.role === 'runner' && spyOnly[k].reclaimM != null) && (d.chainM == null || last.m - d.chainM >= R.trailEvery);
    if (!spyOnly.some((v) => v.exit) && !trailDue) {
      for (const [k, lot] of x.lots.entries()) if (lot.reclaimM == null && spyOnly[k].reclaimM != null) lot.reclaimM = spyOnly[k].reclaimM;
      d.exitM = last.m; this.dirty = true;
      return;
    }
    await this.optionChain(today, true);
    const ch = this.mkt.chain;
    const row = ch && ch.expiry === today ? ch.calls.find((r) => r.osi === x.lots[0].osi) : null;
    // no line for the contract: nothing to sell at, so these minutes are tried again next round
    if (!row) { if (this.due('dip-norow', 300)) this.log('RIGO', 'OPS', null, `dips: ${lotName(x.lots[0])} is not in the option chain · trying again`); return; }
    d.exitM = last.m; d.chainM = last.m;
    this.dirty = true;
    for (const lot of [...x.lots]) {
      const { exit, reclaimM } = books.dipExit(lot, fresh, last, row);
      if (Number.isFinite(row.bid)) lot.peak = Math.max(lot.peak ?? lot.entry, row.bid);
      // the reclaim is the trade's, not one contract's: the runner rides from the minute the first one sold on
      if (reclaimM != null) for (const l of x.lots) if (l.trade === lot.trade && l.reclaimM == null) l.reclaimM = reclaimM;
      if (!exit) continue;
      const at = hm(exit.bar.m);
      // only the chosen reason is written: `bar` is a fresh bar (with its VWAP) for the first three, the newest otherwise
      const why = {
        stop: () => `SPY closed under ${lot.stop.toFixed(2)} at ${at} (${exit.bar.c.toFixed(2)}): the morning's low did not hold`,
        reclaim: () => `SPY closed back above VWAP at ${at} (${exit.bar.c.toFixed(2)} vs ${exit.bar.vw.toFixed(2)})`,
        fade: () => `SPY closed back under ${lot.spy.toFixed(2)}, where it was bought, at ${at}`,
        late: () => `no close back above VWAP by ${hm(R.reclaimBy)}`,
        trail: () => `gave back half its gain from ${prem(lot.peak)}`,
        clock: () => '3:15 clock',
      }[exit.kind]();
      const sync = this.chainSyncAt(ch, today, exit.bar.m);
      if (!sync.ok) this.log('RIGO', 'OPS', null, `dips: selling anyway · ${sync.why}`);
      await this.kett({ book: 'dips', lot, side: 'sell', px: null, market: row, sync: sync.rec, why });
    }
  }

  // Today's same-day chain, read at most once a bar (`force` re-reads for the exit check and a trigger).
  // Both option books may want it in the same round: a read from the last 20 seconds serves both.
  async optionChain(day, force = false) {
    const ch = this.mkt.chain, t = this.now();
    if (ch && ch.expiry === day && t - ch.fetchedAt < (force ? 20000 : 4 * MIN)) return ch;
    try {
      const x = await this.feeds.expiry(this.D.stockSym, day);
      if (x && (x.calls.length || x.puts.length)) { x.fetchedAt = t; this.mkt.chain = x; }
    } catch (e) { if (this.due('holt-chain', 120)) this.log('HOLT', 'OPS', null, `SPY option chain did not load: ${String(e.message).slice(0, 90)}`); }
    return this.mkt.chain && this.mkt.chain.expiry === day ? this.mkt.chain : null;
  }
  // The chain against the close of the five-minute bar that starts at minute `barM` (Eastern) on
  // `day` (the scalp book's bars): books.chainSync's verdict, and in `rec` the three fields every option fill journals.
  chainSync(ch, day, barM) { return this.chainSyncAt(ch, day, barM + 5); }
  // The same against the minute `closeM` (Eastern) on `day` that a bar closed at: the options and dip books' one-minute bars.
  chainSyncAt(ch, day, closeM) {
    const barAt = clock.atMin(day, closeM);
    const chainAt = ch && ch.expiry === day && Number.isFinite(ch.at) ? ch.at : null;
    const v = ch && ch.expiry === day ? books.chainSync(chainAt, barAt, this.D.chainSkewSec) : { ok: false, skewSec: null, why: "no option chain for today's expiry" };
    return { ...v, rec: { barAt: iso(barAt), chainAt: iso(chainAt), skewSec: v.skewSec } };
  }

  // ---------------------------------------------------------------- BRAM: what each book should hold
  async bram() {
    await this.cryptoBook();
    await this.stockBook();
    if (this.D.options) await this.optionsBook();
    if (this.D.scalps) await this.scalpBook();
    if (this.D.dips) await this.dipBook();
    if (this.D.runners) await this.runnerBook();
    this.touch('BRAM');
  }
  // Once a UTC day, as soon as yesterday's daily candle is final -- the lab decided on the close
  // and traded at the next open, and crypto's next open is the same minute.
  async cryptoBook() {
    const t = this.now(), day = utcDay(t), yday = utcDay(t - 86400000);
    if (this.stale.crypto) return;
    for (const [id, sl] of Object.entries(this.state.books.crypto.sleeves)) {
      const c = this.mkt.coins[id];
      if (sl.checkDay === day || !c.daily || !c.daily.length || c.daily[c.daily.length - 1].day !== yday || !Number.isFinite(c.w)) continue;
      sl.checkDay = day; this.dirty = true;
      await this.rebalance('crypto', id, sl, c.w, c.vol, c.tick);
    }
  }
  // Once a trading day, from the first quote at or after 9:35 on the delayed tape.
  async stockBook() {
    const t = this.now(), today = clock.et(t).day, S = this.mkt.spy, q = S.quote;
    if (!clock.isTradingDay(today) || this.stale.stocks || !q || !q.at) return;
    // Only while the tape is running: a quote from inside today's session and no older than the
    // feed's own delay. After the close the last quote is the 3:59 price, and buying at it at 4:30
    // would be a fill no broker gives.
    const qe = clock.et(q.at), s = clock.session(today);
    if (qe.day !== today || qe.min < clock.OPEN_MIN + 5 || qe.min >= s.close || t - q.at > 25 * MIN) return;
    for (const [sym, sl] of Object.entries(this.state.books.stocks.sleeves)) {
      if (sl.checkDay === today || !Number.isFinite(S.w)) continue;
      sl.checkDay = today; this.dirty = true;
      await this.rebalance('stocks', sym, sl, S.w, S.vol, q);
    }
  }
  async rebalance(bookKey, sym, sl, w, vol, quote) {
    const name = bookKey === 'crypto' ? short(sym) : sym;
    const volTxt = `${Math.round(vol * 100)}% swings`;
    if (!books.needsRebalance(w, sl.target, this.D.rebalBand)) {
      this.log('BRAM', 'PASS', null, `${name}: hold ${Math.round((sl.target ?? 0) * 100)}% · target ${Math.round(w * 100)}% (${volTxt}) is within ${Math.round(this.D.rebalBand * 100)} points`);
      return;
    }
    const px = quote.bid > 0 && quote.ask > 0 ? (quote.bid + quote.ask) / 2 : quote.last;
    const worth = this.sleeveValue(sl, quote.bid || px);
    const wantQty = (w * worth) / px, delta = wantQty - sl.qty;
    const from = sl.target;
    // The benchmark starts where the book does: holding the same thing from its first trade, not from
    // whatever price happened to be on the screen when the desk booted on a Saturday, and paying the same
    // fee to buy in.
    if (!(sl.benchPx > 0)) { sl.benchPx = px; sl.benchAt = this.now(); sl.benchFeeBps = this.feeBps(bookKey); }
    this.log('BRAM', 'SIGNAL', null, `${name}: ${from == null ? 'start at' : 'move from ' + Math.round(from * 100) + '% to'} ${Math.round(w * 100)}% (${volTxt}, target ${Math.round((bookKey === 'crypto' ? this.D.cryptoVolTarget : this.D.stockVolTarget) * 100)}%)`);
    this.journal('REBALANCE', { book: bookKey, sym, from, to: r4(w), vol: r4(vol), px, worth });
    const kind = bookKey === 'crypto' ? 'crypto' : 'stock';
    const minTrade = Math.abs(delta * px) >= 1;
    if (minTrade && delta > 0 && this.halt) { this.log('KETT', 'PASS', null, `${name}: not buying · ${this.halt}`); return; }
    if (minTrade) await this.kett({ book: bookKey, sym, sl, kind, side: delta > 0 ? 'buy' : 'sell', qty: Math.abs(delta), quote, why: `to ${Math.round(w * 100)}% of the ${name} slot` });
    sl.target = w;
    this.dirty = true;
  }

  // The options book, from 12:30 on the delayed tape, on each new one-minute bar (books.trendTest and the rules
  // above it; five-minute bars until 2026-09-29).
  async optionsBook() {
    const o = this.state.books.options, S = this.mkt.spy, t = this.now();
    const today = clock.et(t).day;
    if (!S.intra || S.intra.day !== today || !clock.isTradingDay(today)) return;
    if (!o.day || o.day.date !== today) {
      o.day = { date: today, status: clock.isEarlyClose(today) ? 'early-close' : 'waiting', test: null, dir: null, entries: 0, firstTrade: null, firstExitHit: null, scanIdx: null, ext: null, flatAtIdx: null, exitBarM: null };
      this.dirty = true;
      if (o.day.status === 'early-close') this.log('BRAM', 'PASS', null, 'options: 1 PM close today, SPY same-day options stop at 1 PM · no trade');
    }
    const d = o.day;
    if (d.status === 'early-close' || d.status === 'no-trade' || d.status === 'done') return;
    const bars = S.intra.bars, vw = S.vwap1;
    if (d.status === 'waiting') {
      const r = books.trendTest(bars, vw, S.atr && !S.atr.stale ? S.atr.atr : null);
      if (r.status === 'wait') return;
      if (r.status === 'none' && S.atr && S.atr.stale) r.why = `SPY's daily bars end ${S.atr.asof}, a session short (stale ATR)`;
      if (r.status === 'none') {
        // a minute can still arrive late; give it until 12:45 on the tape before calling the day
        const lastM = bars.length ? bars[bars.length - 1].m : 0;
        if (lastM < books.ZERO.check + 15) return;
        d.status = 'no-trade'; d.why = r.why;
        this.log('BRAM', 'PASS', null, `options: no 12:30 verdict (${r.why}) · no trade today`);
        this.journal('OPTIONS_DAY', { date: today, status: 'none', why: r.why });
        return;
      }
      d.test = { dir: r.dir, move: r4(r.move), atr: r4(r.atr), moveAtr: r4(r.moveAtr), vwap: r4(r.vwap), c1230: r.c1230, open: r.open, retr: r4(r.retr), why: r.why };
      d.dir = r.dir;
      this.journal('OPTIONS_DAY', { date: today, status: r.status, ...d.test });
      if (r.status === 'fail') {
        d.status = 'no-trade';
        this.log('BRAM', 'PASS', null, `options: not a trend day (${r.why}) · no trade today`);
        return;
      }
      d.status = 'armed'; d.scanIdx = r.idx; d.ext = r.ext;
      this.log('BRAM', 'SIGNAL', null, `options: trend day ${r.dir}, ${r.moveAtr.toFixed(2)} ATR from the open and ${r.dir === 'up' ? 'above' : 'below'} VWAP · watching for a new ${r.dir === 'up' ? 'high' : 'low'} until 2:45`);
      return;
    }
    // armed: hunt the trigger on minutes not yet scanned, only while flat
    if (o.lots.length || d.status !== 'armed') return;
    const canEnter = d.entries === 0 || (d.entries === 1 && d.firstExitHit === true);
    if (!canEnter) { if (d.entries >= 1 && d.firstExitHit != null) { d.status = 'done'; this.dirty = true; } return; }
    if (d.entries === 1 && d.flatAtIdx != null && d.scanIdx < d.flatAtIdx) {
      // the re-entry needs a FRESH extreme: everything up to the minute the first trade ended on is the extreme to beat
      const upto = bars.slice(0, d.flatAtIdx + 1);
      d.ext = d.dir === 'up' ? Math.max(...upto.map((b) => b.h)) : Math.min(...upto.map((b) => b.l));
      d.scanIdx = d.flatAtIdx;
    }
    const lastM = bars.length ? bars[bars.length - 1].m : 0;
    if (lastM > books.ZERO.lastEntry && d.scanIdx >= bars.length - 1) { d.status = 'done'; this.log('BRAM', 'PASS', null, `options: no new ${d.dir === 'up' ? 'high' : 'low'} by 2:45 · done for today`); return; }
    const s = books.scanEntry(bars, vw, d.dir, d.scanIdx, d.ext);
    d.scanIdx = s.scanned; d.ext = s.ext; this.dirty = true;
    if (!s.hit) return;
    // Whatever happens to this trigger, the next one has to beat this bar's own extreme.
    const hb = bars[s.hit.idx];
    d.ext = d.dir === 'up' ? Math.max(d.ext, hb.h) : Math.min(d.ext, hb.l);
    // A trigger is only worth acting on while it is the newest minute: after a restart the scan can land
    // on one from half an hour ago, and buying it at the current price is not the rule.
    if (s.hit.idx < bars.length - 1) { this.log('BRAM', 'PASS', null, `options: new ${d.dir === 'up' ? 'high' : 'low'} at ${hm(s.hit.m)} was missed (the desk was not running) · waiting for the next one`); return; }
    if (this.halt) { this.log('KETT', 'PASS', null, `options: trigger at ${hm(s.hit.m)} not taken · ${this.halt}`); return; }
    // a fresh chain, never the four-minute cache: the fill has to be from the trigger's moment
    const ch = await this.optionChain(today, true);
    if (!ch) { this.log('BRAM', 'PASS', null, `options: trigger at ${hm(s.hit.m)} but the chain did not load`); return; }
    const sync = this.chainSyncAt(ch, today, s.hit.m);
    if (!sync.ok) {
      this.log('BRAM', 'PASS', null, `options: new ${d.dir === 'up' ? 'high' : 'low'} at ${hm(s.hit.m)} not taken · ${sync.why}`);
      this.journal('OPTIONS_SKIP', { date: today, bar: hm(s.hit.m), ...sync.rec, why: sync.why });
      return;
    }
    const rows = d.dir === 'up' ? ch.calls : ch.puts;
    const spot = ch.spot > 0 ? ch.spot : s.hit.c;
    const pick = books.pickContract(rows, spot, d.dir);
    if (!pick.row) { this.log('BRAM', 'PASS', null, `options: new ${d.dir === 'up' ? 'high' : 'low'} at ${hm(s.hit.m)} (${s.hit.c.toFixed(2)}) but ${pick.why}`); return; }
    const qty = d.entries === 1 ? 1 : pick.qty;
    this.log('BRAM', 'SIGNAL', null, `options: new ${d.dir === 'up' ? 'high' : 'low'} at ${hm(s.hit.m)}, SPY ${s.hit.c.toFixed(2)} · buy ${qty} ${pick.row.strike} ${d.dir === 'up' ? 'call' : 'put'} at ${prem(pick.row.ask)}${d.entries === 1 ? ' (the one re-entry)' : ''}`);
    const f = await this.kett({ book: 'options', side: 'buy', row: pick.row, qty, sync: sync.rec, why: d.entries === 1 ? 're-entry on a fresh extreme' : `trend-day trigger at ${hm(s.hit.m)}` });
    // exits are judged on the minutes after the one it was bought on
    if (f) { d.entryBarM = s.hit.m; d.exitBarM = null; }
  }

  // The scalp book (books.scalpTrigger and the rules above it), on each new five-minute bar from 10:05 to
  // 2:30 on the delayed tape, only while it holds nothing: one contract, one position, no adds.
  async scalpBook() {
    const x = this.state.books.scalps, S = this.mkt.spy, t = this.now(), R = books.SCALP;
    const today = clock.et(t).day;
    if (!S.intra || S.intra.day !== today || !clock.isTradingDay(today)) return;
    if (!x.day || x.day.date !== today) {
      x.day = { date: today, status: clock.isEarlyClose(today) ? 'early-close' : 'waiting', why: '', entries: 0, lossRun: 0, pauseUntil: null, scanIdx: null, exitBarM: null };
      this.dirty = true;
      if (x.day.status === 'early-close') this.log('BRAM', 'PASS', null, 'scalps: 1 PM close today · no scalps');
    }
    const d = x.day, bars = S.bars5, vw = S.vwap;
    if (d.status === 'early-close' || d.status === 'done' || !bars.length) return;
    const i = bars.length - 1, bar = bars[i];
    // a desk that starts mid-session looks only at the newest bar, never back
    if (d.scanIdx == null) d.scanIdx = i - 1;
    if (d.scanIdx >= i) return;
    const from = d.scanIdx;
    d.scanIdx = i; this.dirty = true;
    if (x.lots.length) return;
    if (bar.m > R.lastBar) {
      d.status = 'done'; d.why = `no entries after ${hm(R.lastBar + 5)}`;
      this.log('BRAM', 'PASS', null, `scalps: ${hm(R.lastBar + 5)}, done for today · ${d.entries} trade${d.entries === 1 ? '' : 's'}`);
      return;
    }
    if (bar.m < R.firstBar) return;
    if (d.status === 'waiting') d.status = 'watching';
    let hit = null;
    for (let j = from + 1; j <= i && !hit; j++) {
      if (bars[j].m >= R.firstBar && bars[j].m <= R.lastBar) hit = books.scalpTrigger(bars, vw, j);
    }
    if (!hit) return;
    const up = hit.dir === 'up', side = up ? 'call' : 'put';
    const what = `SPY ${up ? 'broke above' : 'broke below'} ${hit.level.toFixed(2)} at ${hm(hit.m + 5)}`;
    const gate = books.scalpGate(d, today, hit.m);
    if (gate) { this.log('BRAM', 'PASS', null, `scalps: ${what} · not taken: ${gate}`); return; }
    if (this.halt) { this.log('KETT', 'PASS', null, `scalps: ${what} · not taken: ${this.halt}`); return; }
    // a fresh chain: the fill has to be from the trigger's moment
    const ch = await this.optionChain(today, true);
    if (!ch) { this.log('BRAM', 'PASS', null, `scalps: ${what} · the option chain did not load`); return; }
    const sync = this.chainSync(ch, today, hit.m);
    if (!sync.ok) {
      this.log('BRAM', 'PASS', null, `scalps: ${what} · not taken: ${sync.why}`);
      this.journal('SCALP_SKIP', { date: today, bar: hm(hit.m + 5), ...sync.rec, why: sync.why });
      return;
    }
    const pick = books.pickScalp(up ? ch.calls : ch.puts, hit.dir, hit.m);
    if (!pick.row) { this.log('BRAM', 'PASS', null, `scalps: ${what} · ${pick.why}`); return; }
    const row = pick.row, target = r4(row.ask * R.target);
    this.log('BRAM', 'SIGNAL', null, `scalps: ${what}, ${hit.c.toFixed(2)} vs VWAP ${hit.vwap.toFixed(2)} · buy 1 ${row.strike} ${side} at ${prem(row.ask)} (delta ${Math.abs(row.delta).toFixed(2)}) · out at ${prem(target)}, SPY back ${up ? 'under' : 'over'} ${hit.level.toFixed(2)}, or by ${hm(hit.m + 5 + R.hold)}`);
    const f = await this.kett({
      book: 'scalps', side: 'buy', row, qty: 1, sync: sync.rec, why: `${up ? 'break above' : 'break below'} the last 30 minutes at ${hm(hit.m + 5)}`,
      lot: { dir: hit.dir, level: r4(hit.level), barM: hit.m },
      // what the stack's §8 asks every trade to journal
      detail: { dir: hit.dir, spy: r4(hit.c), level: r4(hit.level), vwap: r4(hit.vwap), delta: row.delta, bid: row.bid, ask: row.ask, bidSz: row.bidSz, askSz: row.askSz },
    });
    // exits are judged on the bars after the one it was bought on, not from the last trade's last handled bar
    if (f) d.exitBarM = null;
  }

  // The dip book (books.dipTrigger and the rules above it), on each new one-minute bar from 10:05 to noon on
  // the delayed tape, only while it holds nothing.
  async dipBook() {
    const x = this.state.books.dips, S = this.mkt.spy, t = this.now(), R = books.DIP;
    const today = clock.et(t).day;
    if (!S.intra || S.intra.day !== today || !clock.isTradingDay(today)) return;
    if (!x.day || x.day.date !== today) {
      x.day = { date: today, status: clock.isEarlyClose(today) ? 'early-close' : 'waiting', why: '', entries: 0, scanM: null, exitM: null, chainM: null };
      this.dirty = true;
      if (x.day.status === 'early-close') this.log('BRAM', 'PASS', null, 'dips: 1 PM close today · no dip trades');
    }
    const d = x.day, bars = S.intra.bars, vw = S.vwap1;
    if (d.status === 'early-close' || d.status === 'done' || !bars.length) return;
    const i = bars.length - 1, bar = bars[i];
    // a desk that starts mid-session looks only at the newest minute, never back
    if (d.scanM == null) d.scanM = bar.m - 1;
    if (d.scanM >= bar.m) return;
    const from = d.scanM;
    d.scanM = bar.m; this.dirty = true;
    if (x.lots.length) return;
    if (bar.m > R.lastClose) {
      d.status = 'done'; d.why = d.entries ? `${d.entries} trade${d.entries === 1 ? '' : 's'}` : 'no dip to buy by noon';
      this.log('BRAM', 'PASS', null, `dips: noon, done for today · ${d.why}`);
      return;
    }
    if (bar.m < R.firstClose) return;
    if (d.status === 'waiting') d.status = 'watching';
    const atr = S.atr && !S.atr.stale ? S.atr.atr : null;
    if (!atr) { if (this.due('dip-atr', 1800)) this.log('BRAM', 'PASS', null, `dips: no ATR14 from SPY's daily bars${S.atr && S.atr.stale ? ` (they end ${S.atr.asof})` : ''} · no dip trades until it loads`); return; }
    // every minute since the last look (normally just the newest): a read that brings two must not drop the first
    let hit = null;
    for (let j = bars.findIndex((b) => b.m > from); j >= 0 && j <= i && !hit; j++) {
      if (bars[j].m >= R.firstClose && bars[j].m <= R.lastClose) hit = books.dipTrigger(bars, vw, j, atr);
    }
    if (!hit) return;
    const what = `SPY turned up off ${hit.low.toFixed(2)} (${hit.dip.toFixed(2)} ATR under the open) at ${hm(hit.m)}`;
    if (this.halt) { this.log('KETT', 'PASS', null, `dips: ${what} · not taken: ${this.halt}`); return; }
    const ch = await this.optionChain(today, true);
    if (!ch) { this.log('BRAM', 'PASS', null, `dips: ${what} · the option chain did not load`); return; }
    const sync = this.chainSyncAt(ch, today, hit.m);
    if (!sync.ok) {
      this.log('BRAM', 'PASS', null, `dips: ${what} · not taken: ${sync.why}`);
      this.journal('DIP_SKIP', { date: today, bar: hm(hit.m), ...sync.rec, why: sync.why });
      return;
    }
    const pick = books.pickDip(ch.calls, ch.spot > 0 ? ch.spot : hit.c);
    if (!pick.row) { this.log('BRAM', 'PASS', null, `dips: ${what} · ${pick.why}`); return; }
    const row = pick.row, stop = r4(hit.stop);
    this.log('BRAM', 'SIGNAL', null, `dips: ${what}, ${hit.c.toFixed(2)} under VWAP ${hit.vwap.toFixed(2)} · buy ${R.qty} ${row.strike} calls at ${prem(row.ask)} · the first sells when SPY closes back above VWAP; out under ${stop.toFixed(2)}, or with no reclaim by ${hm(R.reclaimBy)}`);
    const f = await this.kett({
      book: 'dips', side: 'buy', row, qty: R.qty, sync: sync.rec, why: `dip buy: SPY turned up off ${hit.low.toFixed(2)} at ${hm(hit.m)}`,
      lot: { dir: 'up', stop, spy: r4(hit.c), barM: hit.m, reclaimM: null },
      detail: { dir: 'up', spy: r4(hit.c), open: r4(hit.open), low: r4(hit.low), dipAtr: r4(hit.dip), vwap: r4(hit.vwap), stop, delta: row.delta, bid: row.bid, ask: row.ask, bidSz: row.bidSz, askSz: row.askSz },
    });
    if (f) { d.exitM = null; d.chainM = hit.m; }
  }

  // ---------------------------------------------------------------- the runner book: coins popping right now
  // Every DESK_RUNNER_EVERY_SEC (3 minutes), one call for every coin's last 24 hours (src/desk/books.js RUNNER
  // has the rule and why). What the book holds is marked at the scan's price and sold first if it has fallen
  // 10% from its best; then, with a slot free, it buys the strongest runner it does not hold. Coinbase's
  // product list, read every six hours, gives the step each coin is sold in; a coin missing from it (delisted,
  // halted, cancel-only) is never bought. The scan runs whatever the stock market is doing: crypto never closes.
  async runnerBook() {
    const t = this.now(), b = this.state.books.runners, M = this.mkt.runners, R = books.RUNNER;
    const every = this.D.runnerEverySec * 1000;
    if ((b.scan && t - b.scan.at < every) || t - M.failAt < MIN) return;
    let stats = null;
    try {
      if (!M.steps || t - M.stepsAt > 6 * HOUR) { const p = await this.feeds.coinProducts(); if (p) { M.steps = p; M.stepsAt = t; } }
      stats = await this.feeds.coinStats();
    } catch (e) {
      M.failAt = t;
      if (this.due('runner-feed', 600)) this.log('HOLT', 'OPS', null, `runners: Coinbase's 24-hour figures did not load: ${String(e && e.message).slice(0, 80)} · trying again in a minute`);
      return;
    }
    if (!stats || !M.steps) { M.failAt = t; return; }
    // "still climbing" is against the scan before, and only when that scan was the last one (not before an outage)
    const prev = b.scan && t - b.scan.at <= 2 * every ? b.scan.px : null;
    const rows = books.runnerScan(stats, prev, R);
    for (const lot of [...b.lots]) {
      const s = stats[lot.sym], last = s ? s.last : null;
      if (!(last > 0)) continue;
      lot.mark = last; lot.peak = Math.max(lot.peak, last);
      const why = books.runnerExit(lot, last, t, R);
      if (why) await this.kettRunner({ side: 'sell', lot, why });
    }
    b.cool = b.cool || {};
    for (const [id, at] of Object.entries(b.cool)) if (t - at >= R.coolHours * HOUR) delete b.cool[id];
    const held = () => new Set(b.lots.map((l) => l.sym));
    for (const r of rows) {
      if (r.why || held().has(r.id) || b.cool[r.id] || !M.steps[r.id]) continue;
      if (b.lots.length >= R.slots) break;
      const spend = r2(Math.min(b.cash, this.bookValue('runners') / R.slots));
      if (spend < 5) break;
      const what = `${short(r.id)} is running: up ${pctTxt(r.move)} in 24 hours, ${pctTxt(-r.offHigh)} off its high, still climbing, $${Math.round(r.volUsd / 1e6)}M traded`;
      if (this.halt) { this.log('KETT', 'PASS', null, `runners: ${what} · not buying: ${this.halt}`); break; }
      this.log('BRAM', 'SIGNAL', null, `runners: ${what} · buy ${usd(spend)}`);
      await this.kettRunner({ side: 'buy', row: r, spend, why: `running: up ${pctTxt(r.move)} in 24 hours, ${pctTxt(-r.offHigh)} off its high` });
    }
    // what the floor shows: the coins moving most, and what the book made of each
    const h = held();
    const top = rows.slice(0, 6).map((r) => ({
      id: r.id, move: r4(r.move), offHigh: r4(r.offHigh), volUsd: Math.round(r.volUsd), last: r.last,
      status: h.has(r.id) ? 'held' : b.cool[r.id] ? 'sold in the last 12 hours' : r.why ? r.why : !M.steps[r.id] ? 'not trading on Coinbase' : this.halt ? 'not buying today' : 'running, no slot free',
    }));
    b.scan = { at: t, n: rows.length, px: Object.fromEntries(rows.map((r) => [r.id, r.last])), top };
    b.scans = (b.scans || 0) + 1;
    this.dirty = true;
    if (this.due('runner-say', 1800)) {
      const running = rows.filter((r) => !r.why).map((r) => `${short(r.id)} +${pctTxt(r.move)}`);
      this.log('BRAM', 'PASS', null, `runners: scanned ${rows.length} coins with $${R.minVolUsd / 1e6}M+ traded · ${running.length ? `running: ${running.slice(0, 4).join(', ')}` : 'none running'} · holding ${b.lots.length ? b.lots.map((l) => short(l.sym)).join(', ') : 'nothing'}`);
    }
  }
  // The runner book's fills: a buy spends its quarter walking Coinbase's asks, a sale walks the bids, both
  // paying DESK_RUNNER_FEE_BPS (Robinhood's 0.95%), in the step Coinbase sells the coin in.
  async kettRunner(order) {
    const b = this.state.books.runners, M = this.mkt.runners, t = this.now();
    const buy = order.side === 'buy', sym = buy ? order.row.id : order.lot.sym, name = short(sym);
    let book = null;
    try { book = await this.feeds.book(sym); } catch (e) { /* said below */ }
    if (!book || !book.bids.length || !book.asks.length) { this.log('KETT', 'PASS', null, `runners: ${name} ${order.side} not filled · its order book did not load`); return null; }
    const market = { bid: book.bids[0].price, ask: book.asks[0].price, book };
    const step = Math.max(1e-6, (M.steps && M.steps[sym]) || 1e-6);
    const f = broker.fill(buy ? { kind: 'crypto', side: 'buy', qty: order.spend / market.ask, cash: order.spend, step } : { kind: 'crypto', side: 'sell', qty: order.lot.qty, step },
      market, { ...this.fees, cryptoBps: this.D.runnerFeeBps });
    if (!(f.qty > 0)) { this.log('KETT', 'PASS', null, `runners: ${name} ${order.side} not filled · ${f.reason}`); return null; }
    let pnl = null;
    if (buy) {
      const id = `R${b.nextLot}`, r = order.row;
      b.lots.push({ id: b.nextLot++, trade: id, sym, qty: f.qty, cost: r2(-f.cash), entry: f.avg, peak: r.last, mark: r.last, openedAt: t });
      b.trades.unshift({ id, sym, qty: f.qty, entry: f.avg, cost: r2(-f.cash), openedAt: t, open: true, pnl: 0 });
      if (b.trades.length > 120) b.trades.length = 120;
    } else {
      const lot = order.lot, sold = Math.min(f.qty, lot.qty), out = r2(lot.cost * (sold / lot.qty));
      pnl = r2(f.cash - out);
      lot.qty = r6(lot.qty - sold); lot.cost = r2(lot.cost - out);
      b.realized = r2(b.realized + pnl);
      const tr = b.trades.find((x) => x.id === lot.trade);
      if (tr) tr.pnl = r2(tr.pnl + pnl);
      // the rest of a sale the book's depth could not take goes at the next scan
      if (lot.qty < 1e-6) {
        b.lots = b.lots.filter((x) => x !== lot);
        (b.cool || (b.cool = {}))[sym] = t;
        if (tr) Object.assign(tr, { open: false, exit: f.avg, closedAt: t, why: order.why });
      }
    }
    b.cash = r2(b.cash + f.cash); b.fees = r2(b.fees + f.fee);
    this.dirty = true;
    const detail = buy ? { move: r4(order.row.move), offHigh: r4(order.row.offHigh), volUsd: Math.round(order.row.volUsd), last: order.row.last, was: order.row.was } : {};
    this.journal('FILL', { book: 'runners', sym, side: order.side, qty: f.qty, px: f.avg, notional: f.notional, fee: f.fee, cash: f.cash, pnl, why: order.why, ...detail });
    this.pushFill({ book: 'runners', sym, label: name, side: order.side, qty: f.qty, px: f.avg, value: f.notional, fee: f.fee, pnl, why: order.why });
    this.log('KETT', 'FILL', pnl, `${buy ? 'bought' : 'sold'} ${fmtCoins(f.qty)} ${name} at ${fmtPx(f.avg)} · ${usd(f.notional)}, fee ${usd(f.fee)}${buy ? '' : ` · ${pnl >= 0 ? 'made' : 'lost'} ${usd(Math.abs(pnl))}`} · ${order.why}`);
    return f;
  }

  // ---------------------------------------------------------------- KETT: fills
  async kett(order) {
    const b = this.state.books;
    let f;
    if (optionBook(order.book)) return this.kettOption(order);
    const { sl, kind, side, sym } = order;
    let market = { bid: order.quote.bid, ask: order.quote.ask };
    if (kind === 'crypto') {
      try { market.book = await this.feeds.book(sym); }
      catch (e) { if (this.due('kett-book', 120)) this.log('KETT', 'OPS', null, `${short(sym)} order book did not load, filling at the touch: ${String(e.message).slice(0, 60)}`); }
    }
    if (kind === 'stock' && !(market.bid > 0 && market.ask > 0)) market = { bid: order.quote.last, ask: order.quote.last };
    f = broker.fill({ kind, side, qty: side === 'sell' ? Math.min(order.qty, sl.qty) : order.qty, cash: side === 'buy' ? sl.cash : undefined, step: kind === 'crypto' ? COIN_STEP[sym] : undefined }, market, this.fees);
    if (!(f.qty > 0)) { this.log('KETT', 'PASS', null, `${short(sym)}: ${side} not filled · ${f.reason}`); return null; }
    let pnl = null;
    if (side === 'buy') { sl.cash = r2(sl.cash + f.cash); sl.qty = r6(sl.qty + f.qty); sl.cost = r2(sl.cost - f.cash); }
    else {
      const q = Math.min(f.qty, sl.qty), frac = sl.qty > 0 ? q / sl.qty : 0;
      const out = r2(sl.cost * frac);
      pnl = r2(f.cash - out);
      sl.realized = r2(sl.realized + pnl); sl.cost = r2(sl.cost - out); sl.qty = r6(Math.max(0, sl.qty - q)); sl.cash = r2(sl.cash + f.cash);
      if (sl.qty < 1e-6) { sl.qty = 0; sl.cost = 0; }
    }
    sl.fees = r2(sl.fees + f.fee);
    this.dirty = true;
    const label = kind === 'crypto' ? `${COIN_NAME[sym] || short(sym)}` : sym;
    this.journal('FILL', { book: order.book, sym, side, qty: f.qty, px: f.avg, notional: f.notional, fee: f.fee, cash: f.cash, pnl, why: order.why });
    this.pushFill({ book: order.book, sym, label, side, qty: f.qty, px: f.avg, value: f.notional, fee: f.fee, pnl, why: order.why });
    this.log('KETT', 'FILL', pnl, `${side === 'buy' ? 'bought' : 'sold'} ${fmtQty(f.qty, kind, sym)} ${label} at ${fmtPx(f.avg)} · ${usd(f.notional)}${f.fee ? `, fee ${usd(f.fee)}` : ''} · ${order.why}`);
    void b;
    return f;
  }
  // Both option books: the options book's two contracts (2x and 3x targets) or the scalp book's one (1.5x).
  kettOption(order) {
    const key = order.book, o = this.state.books[key], d = o.day;
    if (order.side === 'buy') {
      const row = order.row;
      const f = broker.fill({ kind: 'option', side: 'buy', qty: order.qty, cash: o.cash }, { bid: row.bid, ask: row.ask, bidSz: row.bidSz, askSz: row.askSz }, this.fees);
      if (!(f.qty > 0)) { this.log('KETT', 'PASS', null, `${row.strike} ${row.right === 'C' ? 'call' : 'put'}: not bought · ${f.reason}`); return null; }
      const tradeId = `${d.date}-${d.entries + 1}`;
      const base = { expiry: d.date, osi: row.osi, strike: row.strike, right: row.right, entry: f.avg, high0: Number.isFinite(row.high) ? row.high : null, trade: tradeId, openedAt: this.now(), mark: f.avg, ...(order.lot || {}) };
      const each = r2(-f.cash / f.qty);
      // the dip book has no price target: its first contract sells on SPY's reclaim of VWAP, its runner on a trail
      const plan = key === 'scalps' ? [['scalp', books.SCALP.target]]
        : key === 'dips' ? (f.qty >= 2 ? [['first', null], ['runner', null]] : [['first', null]])
          : f.qty >= 2 ? [['first', books.ZERO.firstTarget], ['runner', books.ZERO.runnerTarget]] : [['runner', books.ZERO.runnerTarget]];
      for (let i = 0; i < f.qty; i++) {
        const [role, mult] = plan[Math.min(i, plan.length - 1)];
        o.lots.push({ ...base, id: o.nextLot++, qty: 1, cost: each, role, target: mult == null ? null : r4(f.avg * mult), ...(key === 'dips' ? { peak: f.avg } : {}) });
      }
      o.cash = r2(o.cash + f.cash); o.fees = r2(o.fees + f.fee);
      d.entries++; if (!d.firstTrade) d.firstTrade = tradeId;
      o.trades.unshift({ id: tradeId, date: d.date, dir: (order.lot && order.lot.dir) || d.dir, osi: row.osi, strike: row.strike, right: row.right, qty: f.qty, entry: f.avg, openedAt: this.now(), open: f.qty, pnl: 0 });
      if (o.trades.length > 120) o.trades.length = 120;
      this.dirty = true;
      const label = lotName(base);
      this.journal('FILL', { book: key, sym: row.osi, side: 'buy', qty: f.qty, px: f.avg, notional: f.notional, fee: f.fee, cash: f.cash, why: order.why, ...order.sync, ...(order.detail || {}) });
      this.pushFill({ book: key, sym: row.osi, label, side: 'buy', qty: f.qty, px: f.avg, value: f.notional, fee: f.fee, pnl: null, why: order.why });
      const targets = o.lots.filter((l) => l.trade === tradeId && l.target != null).map((l) => prem(l.target));
      this.log('KETT', 'FILL', null, `bought ${f.qty} ${label} at ${prem(f.avg)} · ${usd(f.notional)}${targets.length ? ` · target${targets.length === 1 ? '' : 's'} ${targets.join(' and ')}` : ''}`);
      return f;
    }
    // a sale: at the target (a resting limit that filled) or at the bid
    const lot = order.lot;
    const market = order.px != null ? { bid: order.px, ask: order.px, bidSz: lot.qty } : order.market ? { bid: order.market.bid, bidSz: Number.isFinite(order.market.bidSz) ? Math.max(order.market.bidSz, lot.qty) : lot.qty } : null;
    if (!market || !(market.bid > 0)) {
      // no bid at all: a same-day option with nothing bid for it is worth nothing to a seller
      const pnl = r2(-lot.cost);
      o.realized = r2(o.realized + pnl); o.lots = o.lots.filter((x) => x !== lot);
      this.noteExit(key, lot, pnl, false);
      this.journal('FILL', { book: key, sym: lot.osi, side: 'sell', qty: lot.qty, px: 0, notional: 0, fee: 0, cash: 0, pnl, why: `${order.why}; no bid`, ...order.sync });
      this.pushFill({ book: key, sym: lot.osi, label: lotName(lot), side: 'sell', qty: lot.qty, px: 0, value: 0, fee: 0, pnl, why: `${order.why}, no bid` });
      this.log('KETT', 'FILL', pnl, `${lotName(lot)}: no bid · written off, lost ${usd(Math.abs(pnl))} · ${order.why}`);
      return null;
    }
    const f = broker.fill({ kind: 'option', side: 'sell', qty: lot.qty }, market, this.fees);
    if (!(f.qty > 0)) return null;
    const pnl = r2(f.cash - lot.cost);
    o.cash = r2(o.cash + f.cash); o.realized = r2(o.realized + pnl); o.fees = r2(o.fees + f.fee);
    o.lots = o.lots.filter((x) => x !== lot);
    this.noteExit(key, lot, pnl, order.px != null);
    this.journal('FILL', { book: key, sym: lot.osi, side: 'sell', qty: f.qty, px: f.avg, notional: f.notional, fee: f.fee, cash: f.cash, pnl, why: order.why, ...order.sync });
    this.pushFill({ book: key, sym: lot.osi, label: lotName(lot), side: 'sell', qty: f.qty, px: f.avg, value: f.notional, fee: f.fee, pnl, why: order.why });
    this.log('KETT', 'FILL', pnl, `sold ${f.qty} ${lotName(lot)} at ${prem(f.avg)} · ${pnl >= 0 ? 'made' : 'lost'} ${usd(Math.abs(pnl))} · ${order.why}`);
    return f;
  }
  // Every fill is saved to disk at once, not on the next ten-second save: a restart in between would
  // come back holding less than the journal says was bought, and the book would buy it again.
  pushFill(f) {
    this.state.fills.unshift({ id: `${this.now()}-${this.state.fills.length}`, at: this.now(), ...f });
    if (this.state.fills.length > 300) this.state.fills.length = 300;
    this.save();
  }

  // ---------------------------------------------------------------- history
  record() {
    const t = this.now(), h = this.state.history;
    const last = h[h.length - 1];
    if (last && t - last.t < MIN) return;
    const v = Object.fromEntries(BOOKS.map((k) => [FIELD[k], this.bookValue(k)]));
    // what holding would be worth; a book that has not traded yet is its own cash, so the line is whole from the start
    const bc = this.benchValue('crypto'), bs = this.benchValue('stocks');
    h.push({ t, e: r2(Object.values(v).reduce((a, x) => a + x, 0)), ...v, bc: bc ?? v.c, bs: bs ?? v.s });
    if (h.length > 30000) h.splice(0, h.length - 30000);
    this.dirty = true;
  }
  // For the chart and each book's line: every minute of the last day, so the 1h, 6h and 24h views keep
  // their detail, and the days before thinned to about 1,500 points. It used to be thinned alike, the whole
  // way, and at the 30,000 minutes it keeps that would have drawn the last hour in three points. `step` is
  // how far apart the thinned points are and `recentFrom` where every minute begins, so the page can tell
  // the thinning from an hour the desk was down.
  pnlHistory() {
    const h = this.state.history, b = this.state.books;
    const end = h.length ? h[h.length - 1].t : this.now();
    let i = h.findIndex((p) => p.t > end - 864e5);
    if (i < 0) i = h.length;
    const k = Math.max(1, Math.ceil(i / 1500));
    return {
      initial: this.initial(), books: Object.fromEntries(BOOKS.map((k) => [k, b[k].initial])),
      step: 60 * k, recentFrom: i < h.length ? h[i].t : null,
      points: [...h.slice(0, i).filter((_, j) => j % k === 0), ...h.slice(i)],
    };
  }

  // ---------------------------------------------------------------- snapshot for the page
  snapshot() {
    const t = this.now(), b = this.state.books, S = this.mkt.spy, D = this.D;
    const legacy = safe(this.legacy);
    const pa = this.agentStatus.PRED;
    if (legacy) { pa.note = legacy.note || ''; pa.lastActive = legacy.lastCycleAt || 0; }
    const sleeveRow = (bookKey, id, sl, px, extra) => {
      const value = sl.qty > 0 && px > 0 ? r2(sl.qty * px) : 0;
      return {
        sym: id, name: bookKey === 'crypto' ? short(id) : id, label: bookKey === 'crypto' ? COIN_NAME[id] || short(id) : 'SPDR S&P 500 ETF',
        qty: sl.qty, px, value, cost: sl.cost, pnl: r2(value - sl.cost), realized: sl.realized, fees: sl.fees,
        cash: sl.cash, target: sl.target, checkDay: sl.checkDay, initial: sl.initial, benchPx: sl.benchPx, ...extra,
      };
    };
    const coinRows = Object.entries(b.crypto.sleeves).map(([id, sl]) => {
      const c = this.mkt.coins[id];
      return sleeveRow('crypto', id, sl, this.coinBid(id), { vol: c.vol, want: c.w, bid: c.tick && c.tick.bid, ask: c.tick && c.tick.ask, at: c.tick && c.tick.at, prevClose: c.daily && c.daily.length ? c.daily[c.daily.length - 1].c : null });
    });
    const stockRows = Object.entries(b.stocks.sleeves).map(([id, sl]) => sleeveRow('stocks', id, sl, this.spyBid(), {
      vol: S.vol, want: S.w, bid: S.quote && S.quote.bid, ask: S.quote && S.quote.ask, at: S.quote && S.quote.at, prevClose: S.quote && S.quote.prevClose,
    }));
    const o = b.options, d = o.day, x = b.scalps, xd = x.day, SC = books.SCALP, p = b.dips, pd = p.day, DP = books.DIP, rn = b.runners, RN = books.RUNNER;
    const book = (key, name, rule, rows) => {
      const equity = this.bookValue(key), bench = this.benchValue(key), bk = b[key];
      const realized = bk.sleeves ? r2(Object.values(bk.sleeves).reduce((a, sl) => a + sl.realized, 0)) : bk.realized;
      const fees = bk.sleeves ? r2(Object.values(bk.sleeves).reduce((a, sl) => a + sl.fees, 0)) : bk.fees;
      return { key, name, rule, initial: bk.initial, startedAt: bk.startedAt, equity, pnl: r2(equity - bk.initial), realized, fees, bench, benchPnl: bench == null ? null : r2(bench - bk.initial), benchFee: bench == null ? null : this.benchFee(key), rows };
    };
    const lastBar = S.bars5.length ? S.bars5[S.bars5.length - 1] : null;
    const six = S.bars5.slice(-SC.range);
    const range6 = six.length === SC.range ? { hi: Math.max(...six.map((z) => z.h)), lo: Math.min(...six.map((z) => z.l)) } : null;
    const one = S.intra ? S.intra.bars : [];
    const quote = S.quote;
    const equity = this.equity();
    return {
      now: t, name: 'The Hexagon', kind: 'desk', mode: 'paper', startedAt: this.state.startedAt, halt: this.halt,
      // when the last round finished: the stream keeps coming from the server while a stuck round holds the
      // loop, and the page's prices then stand still under a light that says Working
      beat: this.beat,
      build: { sha: this.cfg.buildSha || null },
      equity, initial: this.initial(), pnl: r2(equity - this.initial()),
      today: this.state.dayStart > 0 ? r2(equity - this.state.dayStart) : null,
      market: { open: clock.isOpen(t), says: clock.describe(t), stale: this.stale, delayMin: quote && quote.at && clock.isOpen(t) ? Math.round((t - quote.at) / MIN) : null },
      books: [
        book('crypto', 'Crypto', `Holds ${Object.keys(b.crypto.sleeves).map(short).join(', ')}, ${SHARE[Object.keys(b.crypto.sleeves).length] || 'a slot each'}, sized to swing about ${Math.round(D.cryptoVolTarget * 100)}% a year: less of a coin while it has been wild. Checked once a day after midnight UTC.`, coinRows),
        book('stocks', 'Stocks', `Holds ${D.stockSym}, sized to swing about ${Math.round(D.stockVolTarget * 100)}% a year: trims when the market gets jumpy. Checked once a trading day after the open.`, stockRows),
        book('options', 'Options', 'SPY same-day options on trend days only (the stack\'s afternoon rules, on one-minute bars): a new high after a 12:30 trend test buys a call 1-2 points out; out at 2x or 3x, a one-minute close back through VWAP, or 3:15.', o.lots.map((l) => ({
          sym: l.osi, name: lotName(l), label: l.role === 'first' ? 'first contract' : 'runner', qty: l.qty, px: l.mark, value: r2(l.qty * 100 * (l.mark ?? l.entry)), cost: l.cost, pnl: r2(l.qty * 100 * (l.mark ?? l.entry) - l.cost), target: l.target, entry: l.entry,
        }))),
        book('scalps', 'Scalps', `SPY same-day options held for minutes (the stack's 0DTE scalp method): a five-minute close beyond the last 30 minutes' range, on the same side of VWAP, buys one call or put near 0.40 delta, 10:05 to 2:30. Out at ${SC.target}x, on SPY closing back inside the range, from ${SC.timeStop} minutes in unless it is bid above its cost, at ${SC.hold} minutes, or 3:15. At most ${SC.maxTrades} a day; done after ${SC.maxLossRun} losses in a row.`, x.lots.map((l) => ({
          sym: l.osi, name: lotName(l), label: 'scalp', qty: l.qty, px: l.mark, value: r2(l.qty * 100 * (l.mark ?? l.entry)), cost: l.cost, pnl: r2(l.qty * 100 * (l.mark ?? l.entry) - l.cost), target: l.target, entry: l.entry,
          dir: l.dir, level: l.level, until: l.barM + 5 + SC.hold,
        }))),
        book('dips', 'Dips', `Evan's own morning trade, as rules, on one-minute bars (he trades it off a 45-second chart; one minute is the finest the free feed has): from 10:05 to noon, when SPY is at least ${DP.dipAtr} ATR under its open and a minute closes over the one before it within 20 minutes of the low, still under the open and VWAP, it buys ${DP.qty} calls ${DP.nearMin}-${DP.nearMax} points out for $${DP.premiumMin.toFixed(2)}-$${DP.premiumMax.toFixed(2)}. One sells when SPY closes back above VWAP; the other rides until SPY falls back to where it was bought, gives back half its gain once doubled, or 3:15. Both go if SPY closes ${DP.stopAtr} ATR under the morning low, or has not got back above VWAP by 12:30. At most ${DP.maxTrades} a day; done after a loss.`, p.lots.map((l) => ({
          sym: l.osi, name: lotName(l), label: l.role === 'runner' ? 'runner' : 'first contract', qty: l.qty, px: l.mark, value: r2(l.qty * 100 * (l.mark ?? l.entry)), cost: l.cost, pnl: r2(l.qty * 100 * (l.mark ?? l.entry) - l.cost), target: null, entry: l.entry,
          role: l.role, stop: l.stop, spy: l.spy, reclaimed: l.reclaimM != null, peak: l.peak,
        }))),
        book('runners', 'Runners', `Coins popping right now, as Evan bought QNT: every ${Math.round(D.runnerEverySec / 60)} minutes it scans every coin Robinhood sells, and one with $${RN.minVolUsd / 1e6}M or more traded in 24 hours, up ${pctTxt(RN.minMove)} or more on 24 hours ago, within ${pctTxt(RN.nearHigh)} of its 24-hour high and above its price at the last scan is a runner. It buys the strongest it does not hold, up to ${RN.slots} at once, each a quarter of the book. Out when it falls ${pctTxt(RN.trail)} from its best since bought, or after ${RN.staleHours} hours not above what it cost; a coin sold waits ${RN.coolHours} hours. At Robinhood's ${+(D.runnerFeeBps / 100).toFixed(2)}% a side.`, rn.lots.map((l) => ({
          sym: l.sym, name: short(l.sym), label: 'runner', qty: l.qty, px: l.mark, value: r2(l.qty * (l.mark ?? l.entry)), cost: l.cost, pnl: r2(l.qty * (l.mark ?? l.entry) - l.cost), entry: l.entry,
          peak: l.peak, stop: r6(l.peak * (1 - RN.trail)), openedAt: l.openedAt,
        }))),
      ],
      options: {
        enabled: !!D.options,
        day: d ? { date: d.date, status: d.status, test: d.test, dir: d.dir, entries: d.entries, why: d.why || (d.test && d.test.why) || '' } : null,
        // the newest minute (m is the minute it closed), as the book reads it
        spy: one.length ? { m: one[one.length - 1].m, c: one[one.length - 1].c, vwap: S.vwap1.length ? r4(S.vwap1[S.vwap1.length - 1]) : null, open: one[0].o, atr: S.atr ? r4(S.atr.atr) : null, day: S.intra.day } : null,
        trades: o.trades.slice(0, 20),
      },
      scalps: {
        enabled: !!D.scalps,
        day: xd ? { date: xd.date, status: xd.status, entries: xd.entries, lossRun: xd.lossRun, pauseUntil: xd.pauseUntil, why: xd.why || '', max: SC.maxTrades } : null,
        // the range the next bar has to close beyond: the last 30 minutes' high and low
        range: range6 ? { hi: range6.hi, lo: range6.lo, m: lastBar.m, day: S.intra.day } : null,
        trades: x.trades.slice(0, 20),
      },
      dips: {
        enabled: !!D.dips,
        day: pd ? { date: pd.date, status: pd.status, entries: pd.entries, why: pd.why || '', max: DP.maxTrades } : null,
        // where SPY stands against the dip it needs: the open, the low so far, the line the low has to reach
        spy: one.length && one[0].m === DP.open ? { day: S.intra.day, m: one[one.length - 1].m, c: one[one.length - 1].c, open: one[0].o, low: Math.min(...one.map((z) => z.l)), need: S.atr ? r4(one[0].o - DP.dipAtr * S.atr.atr) : null, vwap: S.vwap1.length ? r4(S.vwap1[S.vwap1.length - 1]) : null } : null,
        trades: p.trades.slice(0, 20),
      },
      runners: {
        enabled: !!D.runners, every: D.runnerEverySec,
        // the last scan: when, how many coins it could look at, and the six moving most with what the book made of each
        scanAt: rn.scan ? rn.scan.at : null, n: rn.scan ? rn.scan.n : 0, top: rn.scan ? rn.scan.top : [],
        slots: RN.slots, trades: rn.trades.slice(0, 20),
      },
      spy: quote ? { last: quote.last, bid: quote.bid, ask: quote.ask, prevClose: quote.prevClose, open: quote.open, high: quote.high, low: quote.low, at: quote.at, vol: S.vol, want: S.w, spark: S.intra ? S.intra.bars.filter((_, i) => i % 5 === 0).map((x) => x.c) : [] } : null,
      fills: this.state.fills.slice(0, 80),
      log: this.state.log.slice(0, 150).map((e) => ({ ...e, level: logLevel(e) })),
      agents: AGENTS.map((a) => ({ ...a, ...this.agentStatus[a.key], active: t - this.agentStatus[a.key].lastActive < 4000 })),
      legacy,
      feed: { ...this.feeds.stats },
      cycleMs: this.lastStepMs,
      cfg: { everySec: D.everySec, rebalBand: D.rebalBand, cryptoFeeBps: D.cryptoFeeBps, optionFee: D.optionFee, maxDailyDdPct: D.maxDailyDdPct },
    };
  }
}

const hm = (m) => { const h = Math.floor(m / 60), mm = m % 60, h12 = ((h + 11) % 12) + 1; return `${h12}:${String(mm).padStart(2, '0')}`; };
// an option book's ledger: its cash, what it has banked and paid, the contracts it holds and its day
// a slot of the crypto or stocks book: its cash, what it holds, and where holding it started
function sleeve(initial) {
  return { initial, cash: initial, qty: 0, cost: 0, realized: 0, fees: 0, target: null, checkDay: null, benchPx: null, benchFeeBps: null };
}
// how the crypto book's slots split it, for its line on the floor
const SHARE = { 1: 'all in one', 2: 'half each', 3: 'a third each', 4: 'a quarter each', 5: 'a fifth each', 6: 'a sixth each' };
function lotBook(key, initial, t) {
  return { key, initial, startedAt: t, cash: initial, realized: 0, fees: 0, lots: [], day: null, trades: [], nextLot: 1 };
}
function lotName(l) {
  const md = String(l.expiry || '').slice(5).replace('-', '/');
  return `SPY ${md} ${l.strike}${l.right === 'C' ? 'C' : 'P'}`;
}
// The feed prints these lines as they are, so they follow the floor's way of writing a number
// (public/desk.js): a true minus, thousands separators, cents on money, each coin to its own decimals.
const MINUS = '\u2212';
const COIN_DP = { 'BTC-USD': 6, 'ETH-USD': 4, 'SOL-USD': 2, 'XRP-USD': 2, 'DOGE-USD': 1 };
const usd = (x) => `$${x.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const fmtQty = (q, kind, sym) => (kind === 'crypto' ? q.toLocaleString('en-US', { minimumFractionDigits: COIN_DP[sym] ?? 6, maximumFractionDigits: COIN_DP[sym] ?? 6 })
  : kind === 'stock' ? String(+q.toFixed(3)) : String(q));
// a price to the decimals it is quoted in: cents from $10, four places under that (XRP $1.4921), five
// under a dime (DOGE $0.09447), four figures under a cent (BONK $0.000003740)
const fmtPx = (p) => (p >= 10 ? usd(p) : p >= 0.01 ? `$${p.toFixed(p < 0.1 ? 5 : 4)}` : `$${p.toPrecision(4)}`);
// an option's premium, in dollars and cents like every other price
const prem = (p) => `$${p.toFixed(2)}`;
// a runner's size: whole coins when there are thousands of them, cents' worth of places otherwise
const fmtCoins = (q) => q.toLocaleString('en-US', { maximumFractionDigits: q >= 1000 ? 0 : q >= 1 ? 2 : 6 });
const pctTxt = (x) => `${+(Math.abs(x) * 100).toFixed(1)}%`;

// What a log line is, for the page's filters and for which lines the ring keeps:
//   trade  money moved       warn   needs a look
//   info   a decision        quiet  the desk doing its rounds
// The page used to work this out from the text, and a line from before this was written is judged the
// same way, so a ledger's old ring sorts itself out on its first new line.
const LOG_KEEP = 400, ROUTINE_KEEP = 60;
function logLevel(e) {
  const t = String(e.text || '');
  if (e.kind === 'FILL' || e.kind === 'SETTLE') return 'trade';
  if (e.kind === 'HALT') return 'warn';
  switch (`${e.agent} ${e.kind}`) {
    case 'HOLT SCAN': case 'RIGO RESEARCH': case 'ILSA RESEARCH': return 'quiet';
    case 'TESS OPS': return /^all clear/i.test(t) || /desk online|new day/.test(t) ? 'quiet' : 'warn';
    case 'HOLT OPS': return 'warn';
    case 'BRAM PASS': return /^(options|scalps|dips)/.test(t) ? 'info' : 'quiet';
    default: return 'info';
  }
}
function safe(fn) { try { return fn(); } catch { return null; } }

module.exports = { Desk, AGENTS, lotName, hm, logLevel, ROUTINE_KEEP };

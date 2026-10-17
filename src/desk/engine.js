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
const { appendWhole } = require('../journal');

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
// the books retired on 2026-10-17 (switched off since 10-08): their ledgers stay, their trading is gone
const RETIRED = ['options', 'scalps', 'dips', 'runners'];
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
    this.mkt = { coins: {}, spy: { quote: null, quoteAt: 0, daily: null, dailyAt: 0 } };
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
    this.catchUp(s);
    return s;
  }
  // The state on disk behind its own journal: a fill was journaled, the save after it failed (2026-10-15, the
  // box's disk full: the journal's few hundred bytes went in, the 3.4 MB state did not), and the process
  // restarted before a save got through. The old state came back, the crypto book found its day unchecked,
  // and bought again. So every crypto and SPY fill the journal holds after the state's last moment is put
  // back into its slot, rounded as kett rounds it, and each REBALANCE line marks its slot's day checked.
  // The option and runner books (off since 2026-10-08) are not replayed: a fill of theirs found here is said
  // on start (TESS), and tools/desk-check.js's ledger names the difference.
  catchUp(s) {
    const since = stateTime(s);
    let names = [];
    try { names = fs.readdirSync(this.dir).filter((n) => /^journal-\d{4}-\d{2}-\d{2}\.jsonl$/.test(n) && n.slice(8, 18) >= clock.et(since).day).sort(); }
    catch { return; }
    const events = [];
    for (const n of names) {
      for (const line of fs.readFileSync(path.join(this.dir, n), 'utf8').split('\n')) {
        if (!line) continue;
        let e;
        try { e = JSON.parse(line); } catch { continue; }      // a line a full disk tore
        if (Date.parse(e.t) >= since) events.push(e);
      }
    }
    events.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
    // a fill from the state's last moment may be in it already: the one whose save got through, the line
    // journaled a moment before pushFill saved it
    const saved = s.fills.filter((f) => f.at >= since - 5000);
    const inState = (e) => {
      const sym = e.kind === 'SETTLE' ? e.osi : e.sym, side = e.kind === 'SETTLE' ? 'sell' : e.side;
      const i = saved.findIndex((f) => f.book === e.book && f.sym === sym && f.side === side && f.qty === e.qty && Math.abs(f.at - Date.parse(e.t)) <= 5000);
      return i >= 0 && saved.splice(i, 1);
    };
    const to = {}, put = [], left = {};
    for (const e of events) {
      const sl = s.books[e.book] && s.books[e.book].sleeves && s.books[e.book].sleeves[e.sym];
      if (e.kind === 'REBALANCE' && sl) {
        const t = Date.parse(e.t);
        sl.checkDay = e.book === 'crypto' ? utcDay(t) : clock.et(t).day;
        to[`${e.book}:${e.sym}`] = e.to;
        continue;
      }
      if (e.kind !== 'FILL' && e.kind !== 'SETTLE') continue;
      if (inState(e)) continue;
      if (!sl || e.kind !== 'FILL') { left[e.book] = (left[e.book] || 0) + 1; continue; }
      if (e.side === 'buy') { sl.cash = r2(sl.cash + e.cash); sl.qty = r6(sl.qty + e.qty); sl.cost = r2(sl.cost - e.cash); }
      else {
        const q = Math.min(e.qty, sl.qty), out = r2(sl.cost * (sl.qty > 0 ? q / sl.qty : 0));
        sl.realized = r2(sl.realized + (e.pnl || 0)); sl.cost = r2(sl.cost - out); sl.qty = r6(Math.max(0, sl.qty - q)); sl.cash = r2(sl.cash + e.cash);
        if (sl.qty < 1e-6) { sl.qty = 0; sl.cost = 0; }
      }
      sl.fees = r2(sl.fees + (e.fee || 0));
      if (to[`${e.book}:${e.sym}`] != null) sl.target = to[`${e.book}:${e.sym}`];
      const at = Date.parse(e.t);
      s.fills.unshift({ id: `${at}-${s.fills.length}`, at, book: e.book, sym: e.sym, label: e.book === 'crypto' ? COIN_NAME[e.sym] || short(e.sym) : e.sym, side: e.side, qty: e.qty, px: e.px, value: e.notional, fee: e.fee, pnl: e.pnl, why: e.why });
      put.push(`${e.side === 'buy' ? 'bought' : 'sold'} ${e.book === 'crypto' ? short(e.sym) : e.sym}`);
    }
    if (s.fills.length > 300) s.fills.length = 300;
    if (put.length || Object.keys(left).length) this.caughtUp = { put, left };
  }
  // What catchUp put back, said on start where the floor and the daily check see it, and saved at once.
  sayCaughtUp() {
    const cu = this.caughtUp;
    if (!cu) return;
    if (cu.put.length) { this.log('TESS', 'OPS', null, `the saved state was behind its journal (a state save failed before the restart): put back ${cu.put.join(', ')} from the journal`); this.save(); }
    for (const [book, n] of Object.entries(cu.left)) this.log('TESS', 'OPS', null, `${book}: ${n} fill(s) in the journal after the state's last save (a state save failed before the restart) were not put back · its ledger is behind the journal: run tools/desk-check.js`);
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
    } catch (e) {
      console.error('desk save failed', e.message);
      // said where the floor and the daily check can see it (disk full, volume gone): the desk keeps running on memory
      if (this.due('save-failed', 600)) this.log('TESS', 'OPS', null, `state save failed: ${String(e.message).slice(0, 90)} · a restart now would lose the last minutes`);
    }
  }
  // True when the line is on disk. Every fill and settlement is journaled BEFORE the book moves, and a fill
  // whose line cannot be written is not made (2026-10-15, the box's disk full): a fill the journal never
  // had is one no rebuild can find, and one the state lost while the journal kept it is put back from the
  // journal on the next start (catchUp).
  journal(kind, payload) {
    const t = this.now();
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      // whole lines only: a line a full disk cut short does not swallow the next (src/journal.js)
      if (!this.journalSt) this.journalSt = { check: true };
      appendWhole(path.join(this.dir, `journal-${clock.et(t).day}.jsonl`), JSON.stringify({ t: new Date(t).toISOString(), kind, ...payload }) + '\n', this.journalSt);
      return true;
    } catch (e) {
      if (this.due('journal-err', 300)) this.log('TESS', 'OPS', null, `journal write failed: ${String(e.message).slice(0, 100)}`);
      return false;
    }
  }
  // An order whose fill could not be journaled: not made, and tried again once the journal can be written.
  // Said once in five minutes, however many books are waiting.
  held(what) {
    if (this.due('fill-held', 300)) this.log('KETT', 'OPS', null, `${what}: not filled · the journal could not be written (disk full?), and a fill it does not have is one a restart can repeat · trying again`);
    return null;
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
  // SPY is marked at its bid while the market is open, what a sale would get. Outside the session Cboe's bid is an
  // after-hours one, wide and thin: on the evening of 2026-10-16 it was $761.20 under a $763.25 last trade, and
  // the stocks book read $26.71 below the price on its own row (2026-10-16 audit). Closed, it is marked at the
  // last trade. Holding is marked the same way, so the comparison with it does not move.
  spyBid() {
    const q = this.mkt.spy.quote;
    if (!q) return null;
    return clock.isOpen(this.now()) ? (q.bid || q.last) : (q.last || q.bid);
  }
  sleeveValue(sl, px) { return r2(sl.cash + (sl.qty > 0 && px > 0 ? sl.qty * px : sl.qty > 0 ? sl.cost : 0)); }
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
      const h = slotHold(sl, key === 'crypto' ? this.coinBid(id) : this.spyBid());
      if (h == null) return null;
      v += h;
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
  // Does every crypto and SPY slot that holds something, or is held against holding, have a price loaded
  // since this start? Until one does, sleeveValue marks it at cost and benchValue has no holding figure, so
  // the first minute after a restart with one coin's ticker failing recorded that coin at cost and holding
  // equal to the book, and on the day's first mark started the loss limit from it (audit 2026-10-15).
  // record() and the day's base wait for it; said once in ten minutes while they do.
  priced() {
    const B = this.state.books, missing = [];
    for (const [id, sl] of Object.entries(B.crypto.sleeves)) if ((sl.qty > 0 || sl.benchPx > 0) && !(this.coinBid(id) > 0)) missing.push(short(id));
    for (const [sym, sl] of Object.entries(B.stocks.sleeves)) if ((sl.qty > 0 || sl.benchPx > 0) && !(this.spyBid() > 0)) missing.push(sym);
    if (missing.length && this.due('unpriced', 600)) this.log('HOLT', 'OPS', null, `no price yet for ${missing.join(', ')} · the books' value is not recorded until every slot has one`);
    return !missing.length;
  }
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
    this.sayCaughtUp();
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
  // Crypto every round (three small calls). SPY's quote every 30 seconds while the session is on the tape --
  // the tape runs 15 minutes late, so that is until 4:25 -- and every ten minutes otherwise. Daily bars hourly
  // for crypto, every few hours for SPY. SPY's minute bars and the option chain were read for the option books
  // and went with them on 2026-10-17: two fewer downloads from Cboe's delayed feed, whose terms forbid them.
  async holt() {
    const t = this.now(), e = clock.et(t);
    const s = clock.session(e.day);
    const onTape = !!s && e.min >= s.open && e.min < s.close + 25;
    const jobs = [], failed = new Map();
    // When the network goes, every feed fails in the same round: on 2026-10-16 that was six lines in one minute,
    // one a coin. The round's failures with the same error are one line, "BTC price, ETH price and SPY quote".
    const fail = (what) => (err) => {
      if (!this.due(`holt-${what}`, 300)) return;
      const why = String(err && err.message).slice(0, 90);
      failed.set(why, [...(failed.get(why) || []), what]);
    };
    for (const [id, c] of Object.entries(this.mkt.coins)) {
      jobs.push(this.feeds.ticker(id).then((x) => { if (x) { c.tick = x; c.tickAt = t; } }).catch(fail(`${short(id)} price`)));
      if (!c.daily || t - c.dailyAt > HOUR || utcDay(c.dailyAt) !== utcDay(t)) {
        jobs.push(this.feeds.cryptoDaily(id, t).then((x) => { if (x && x.length) { c.daily = x; c.dailyAt = t; } }).catch(fail(`${short(id)} daily bars`)));
      }
    }
    const S = this.mkt.spy;
    // Cboe's files are a courtesy of a free delayed feed whose terms forbid automated download and which blocks by address: a failed
    // fetch was retried every round (10 seconds, three feeds), which is how a block gets worse. Each feed now waits twice as long
    // after each failure in a row (10 s, 20 s, 40 s ... at most two minutes) and starts over after one that works.
    const waiting = (key) => { const f = S.fail && S.fail[key]; return !!f && t - f.at < Math.min(2 * MIN, 10000 * 2 ** (f.n - 1)); };
    const cboe = (key, what, run, take) => {
      jobs.push(run().then((x) => { if (take(x) && S.fail) delete S.fail[key]; }).catch((err) => {
        S.fail = S.fail || {}; S.fail[key] = { at: t, n: ((S.fail[key] && S.fail[key].n) || 0) + 1 };
        fail(what)(err);
      }));
    };
    if (t - S.quoteAt > (onTape ? 30000 : 10 * MIN) && !waiting('quote')) cboe('quote', 'SPY quote', () => this.feeds.quote(this.D.stockSym), (x) => { if (!x) return false; S.quote = x; S.quoteAt = t; return true; });
    if ((!S.daily || t - S.dailyAt > 3 * HOUR || clock.et(S.dailyAt).day !== e.day) && !waiting('daily')) cboe('daily', 'SPY daily bars', () => this.feeds.daily(this.D.stockSym), (x) => { if (!(x && x.length)) return false; S.daily = x; S.dailyAt = t; return true; });
    await Promise.all(jobs);
    for (const [why, whats] of failed) {
      const names = whats.length < 2 ? whats[0] : `${whats.slice(0, -1).join(', ')} and ${whats[whats.length - 1]}`;
      this.log('HOLT', 'OPS', null, `${names} did not load: ${why} · trying again`);
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
    // and only on a desk with a price for every slot: one marked at cost would start the day, or cross the
    // limit, on a figure that is not the market's (priced)
    const eq = this.equity(), priced = this.priced();
    if (this.state.dayKey !== e.day && priced) { this.state.dayKey = e.day; this.state.dayStart = eq; }
    const dd = priced && this.state.dayKey === e.day && this.state.dayStart > 0 ? eq / this.state.dayStart - 1 : 0;
    const live = dd <= -this.D.maxDailyDdPct ? `down ${(Math.abs(dd) * 100).toFixed(1)}% today, past the ${(this.D.maxDailyDdPct * 100).toFixed(0)}% limit: no new buying until tomorrow` : null;
    // "no new buying until tomorrow" means it: once the limit is crossed the halt holds for the rest of the Eastern day, saved
    // with the state. It used to lift the moment the day's figure came back inside the limit, and the desk bought again
    // at -4.5% on a day it had told itself to stop at -5.6% (audit 2026-10-07).
    if (live && this.state.haltDay !== e.day) { this.state.haltDay = e.day; this.state.haltWhy = live; this.dirty = true; }
    // The day's reason is the one saved when the limit was crossed, not the live figure: the page's banner reads it
    // out to a screen reader whenever it changes, and the live percentage changed it every 0.1% (2026-10-16 audit).
    const why = this.state.haltDay === e.day ? this.state.haltWhy : live;
    // said once, when it starts: the text carries the live percentage, so comparing it logged a line for every 0.1%
    if (why && !this.halt) this.log('TESS', 'HALT', null, why);
    if (!why && this.halt) this.log('TESS', 'OPS', null, 'new day: buying allowed again');
    this.halt = why;
    if (!clock.calendarCovers(e.day) && this.due('tess-cal', 86400)) this.log('TESS', 'OPS', null, `the market calendar in src/desk/clock.js ends ${clock.LAST_YEAR}: add next year's NYSE holidays`);
    if (this.due('tess-say', 900)) {
      const bits = [this.stale.crypto ? 'crypto prices stale' : 'crypto prices fresh', q ? (this.stale.stocks && inSession ? 'SPY feed stalled' : 'SPY feed ok') : 'no SPY quote yet'];
      this.log('TESS', 'OPS', null, `${this.halt ? 'HALTED' : 'all clear'} · ${bits.join(', ')} · desk ${dd > 0 ? '+' : dd < 0 ? MINUS : ''}${Math.abs(dd * 100).toFixed(2)}% today`);
    } else this.touch('TESS');
  }

  // ---------------------------------------------------------------- RIGO: marks
  async rigo() {
    const b = this.state.books;
    if (this.due('rigo-say', 1800)) {
      const held = [...Object.entries(b.crypto.sleeves), ...Object.entries(b.stocks.sleeves)].filter(([, sl]) => sl.qty > 0).map(([id]) => short(id));
      this.log('RIGO', 'RESEARCH', null, `marked ${held.length ? held.join(', ') : 'nothing held'} · desk ${usd(this.equity())}`);
    } else this.touch('RIGO');
  }

  // ---------------------------------------------------------------- BRAM: what each book should hold
  async bram() {
    await this.cryptoBook();
    await this.stockBook();
    // The options, scalp, dip and runner books were switched off on 2026-10-08 after their labs (tools/spy-lab.js,
    // tools/runner-lab.js) found no edge, and their code came out on 2026-10-17: each keeps its ledger (its cash,
    // what it banked and paid, its trades) and says it is off, for the daily check and the floor. Their rules
    // are still in src/desk/books.js, where the labs run them.
    for (const k of RETIRED) if (this.state.books[k]) this.state.books[k].off = true;
    this.touch('BRAM');
  }
  // Once a UTC day, as soon as yesterday's daily candle is final -- the lab decided on the close
  // and traded at the next open, and crypto's next open is the same minute.
  async cryptoBook() {
    const t = this.now(), day = utcDay(t), yday = utcDay(t - 86400000);
    // a sleeve is held back by its OWN coin's tick: one delisted or halted coin used to stop all five (audit 2026-10-07)
    for (const [id, sl] of Object.entries(this.state.books.crypto.sleeves)) {
      const c = this.mkt.coins[id];
      if (!c || !c.tick || t - c.tickAt > 60000) continue;
      if (sl.checkDay === day || !c.daily || !c.daily.length || c.daily[c.daily.length - 1].day !== yday || !Number.isFinite(c.w)) continue;
      const was = sl.checkDay;
      sl.checkDay = day; this.dirty = true;
      // an order the journal could not take is not a check done: the next round tries again
      if (await this.rebalance('crypto', id, sl, c.w, c.vol, c.tick) === 'held') sl.checkDay = was;
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
      const was = sl.checkDay;
      sl.checkDay = today; this.dirty = true;
      if (await this.rebalance('stocks', sym, sl, S.w, S.vol, q) === 'held') sl.checkDay = was;
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
    this.log('BRAM', 'SIGNAL', null, `${name}: ${from == null ? 'start at' : 'move from ' + Math.round(from * 100) + '% to'} ${Math.round(w * 100)}% (${volTxt}, target ${Math.round((bookKey === 'crypto' ? this.D.cryptoVolTarget : this.D.stockVolTarget) * 100)}%)`);
    if (!this.journal('REBALANCE', { book: bookKey, sym, from, to: r4(w), vol: r4(vol), px, worth })) { this.held(name); return 'held'; }
    const kind = bookKey === 'crypto' ? 'crypto' : 'stock';
    const minTrade = Math.abs(delta * px) >= 1;
    if (minTrade && delta > 0 && this.halt) { this.log('KETT', 'PASS', null, `${name}: not buying · ${this.halt}`); return; }
    // The benchmark starts where the book does: holding the same thing from its first trade, not from
    // whatever price happened to be on the screen when the desk booted on a Saturday, and paying the same
    // fee to buy in. Set only once the buy is allowed: a halted first check used to start it at a price the book
    // never paid (BTC 84,000 benchmarked, bought at 80,000 the next day).
    const benchNew = !(sl.benchPx > 0);
    if (benchNew) { sl.benchPx = px; sl.benchAt = this.now(); sl.benchFeeBps = this.feeBps(bookKey); }
    if (minTrade) {
      const order = { book: bookKey, sym, sl, kind, side: delta > 0 ? 'buy' : 'sell', qty: Math.abs(delta), quote, why: `to ${Math.round(w * 100)}% of the ${name} slot` };
      const f = await this.kett(order);
      // held for the journal: holding starts with the trade the book really makes, not this one
      if (order.held) { if (benchNew) sl.benchPx = sl.benchAt = sl.benchFeeBps = null; return 'held'; }
      // `target` is what the book was last traded TO. Recording it for an order that did not fill (no depth, not enough cash) made
      // the next check compare tomorrow's weight with a position that was never taken, and sit in cash while the two were within the
      // band (audit 2026-10-07). The check still counts as done for today: the next one starts from what the book really holds.
      if (!f) { this.dirty = true; return; }
    }
    sl.target = w;
    this.dirty = true;
  }

  // ---------------------------------------------------------------- KETT: fills
  async kett(order) {
    const b = this.state.books;
    let f;
    const { sl, kind, side, sym } = order;
    let market = { bid: order.quote.bid, ask: order.quote.ask };
    if (kind === 'crypto') {
      try { market.book = await this.feeds.book(sym); }
      catch (e) { if (this.due('kett-book', 120)) this.log('KETT', 'OPS', null, `${short(sym)} order book did not load, filling at the touch: ${String(e.message).slice(0, 60)}`); }
    }
    if (kind === 'stock' && !(market.bid > 0 && market.ask > 0)) market = { bid: order.quote.last, ask: order.quote.last };
    f = broker.fill({ kind, side, qty: side === 'sell' ? Math.min(order.qty, sl.qty) : order.qty, cash: side === 'buy' ? sl.cash : undefined, step: kind === 'crypto' ? COIN_STEP[sym] : undefined }, market, this.fees);
    if (!(f.qty > 0)) { this.log('KETT', 'PASS', null, `${short(sym)}: ${side} not filled · ${f.reason}`); return null; }
    // the journal first: a fill it cannot hold is not made (journal)
    const q = Math.min(f.qty, sl.qty), out = side === 'sell' ? r2(sl.cost * (sl.qty > 0 ? q / sl.qty : 0)) : 0;
    const pnl = side === 'sell' ? r2(f.cash - out) : null;
    if (!this.journal('FILL', { book: order.book, sym, side, qty: f.qty, px: f.avg, notional: f.notional, fee: f.fee, cash: f.cash, pnl, why: order.why })) { order.held = true; return this.held(`${short(sym)} ${side}`); }
    if (side === 'buy') { sl.cash = r2(sl.cash + f.cash); sl.qty = r6(sl.qty + f.qty); sl.cost = r2(sl.cost - f.cash); }
    else {
      sl.realized = r2(sl.realized + pnl); sl.cost = r2(sl.cost - out); sl.qty = r6(Math.max(0, sl.qty - q)); sl.cash = r2(sl.cash + f.cash);
      if (sl.qty < 1e-6) { sl.qty = 0; sl.cost = 0; }
    }
    sl.fees = r2(sl.fees + f.fee);
    this.dirty = true;
    const label = kind === 'crypto' ? `${COIN_NAME[sym] || short(sym)}` : sym;
    this.pushFill({ book: order.book, sym, label, side, qty: f.qty, px: f.avg, value: f.notional, fee: f.fee, pnl, why: order.why });
    this.log('KETT', 'FILL', pnl, `${side === 'buy' ? 'bought' : 'sold'} ${fmtQty(f.qty, kind, sym)} ${label} at ${fmtPx(f.avg)} · ${usd(f.notional)}${f.fee ? `, fee ${usd(f.fee)}` : ''} · ${order.why}`);
    void b;
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
    if (!this.priced()) return;
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
    // A slot's own figures as the overview's market list and a market's sheet show them: what it is worth with
    // its cash, and what simply holding it would be worth (the book's benchmark, one slot at a time)
    const sleeveRow = (bookKey, id, sl, px, extra) => {
      const value = sl.qty > 0 && px > 0 ? r2(sl.qty * px) : 0, hold = slotHold(sl, px);
      return {
        sym: id, name: bookKey === 'crypto' ? short(id) : id, label: bookKey === 'crypto' ? COIN_NAME[id] || short(id) : 'SPDR S&P 500 ETF',
        qty: sl.qty, px, value, cost: sl.cost, pnl: r2(value - sl.cost), realized: sl.realized, fees: sl.fees,
        cash: sl.cash, target: sl.target, checkDay: sl.checkDay, initial: sl.initial, benchPx: sl.benchPx,
        worth: r2(sl.cash + value), hold: hold == null ? null : r2(hold), ...extra,
      };
    };
    const coinRows = Object.entries(b.crypto.sleeves).map(([id, sl]) => {
      const c = this.mkt.coins[id];
      return sleeveRow('crypto', id, sl, this.coinBid(id), { vol: c.vol, want: c.w, bid: c.tick && c.tick.bid, ask: c.tick && c.tick.ask, at: c.tick && c.tick.at, prevClose: c.daily && c.daily.length ? c.daily[c.daily.length - 1].c : null });
    });
    const stockRows = Object.entries(b.stocks.sleeves).map(([id, sl]) => sleeveRow('stocks', id, sl, this.spyBid(), {
      vol: S.vol, want: S.w, bid: S.quote && S.quote.bid, ask: S.quote && S.quote.ask, at: S.quote && S.quote.at, prevClose: S.quote && S.quote.prevClose,
    }));
    const o = b.options, x = b.scalps, p = b.dips, rn = b.runners;
    const book = (key, name, rule, rows) => {
      const equity = this.bookValue(key), bench = this.benchValue(key), bk = b[key];
      const realized = bk.sleeves ? r2(Object.values(bk.sleeves).reduce((a, sl) => a + sl.realized, 0)) : bk.realized;
      const fees = bk.sleeves ? r2(Object.values(bk.sleeves).reduce((a, sl) => a + sl.fees, 0)) : bk.fees;
      return { key, name, rule, initial: bk.initial, startedAt: bk.startedAt, equity, pnl: r2(equity - bk.initial), realized, fees, bench, benchPnl: bench == null ? null : r2(bench - bk.initial), benchFee: bench == null ? null : this.benchFee(key), rows };
    };
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
        // retired on 2026-10-17 (README, "Retired books"): the figure each finished on, what it did, and its lab's verdict
        book('options', 'Options', 'Bought SPY same-day calls and puts on trend days, by the investment stack\'s afternoon rules, from 2026-09-25 to 10-08. Switched off when tools/spy-lab.js found no edge over two years of SPY minutes; its code was retired on 2026-10-17 and the rule is kept in src/desk/books.js for the lab.', []),
        book('scalps', 'Scalps', 'Held SPY same-day options for minutes after a 30-minute breakout (the stack\'s 0DTE scalp method), from 2026-09-29 to 10-08. Switched off when tools/spy-lab.js found no edge; code retired 2026-10-17, the rule kept for the lab.', []),
        book('dips', 'Dips', 'Bought calls on Evan\'s morning dip under VWAP, as rules, from 2026-09-29 to 10-08. Switched off when no change to it held up out of sample in tools/spy-lab.js; code retired 2026-10-17, the rule kept for the lab.', []),
        book('runners', 'Runners', 'Chased coins popping on Coinbase, as Evan bought QNT, from 2026-09-30 to 10-08. Switched off when tools/runner-lab.js found it lost over four years even before fees; code retired 2026-10-17, the rule kept for the lab.', []),
      ],
      // the retired books: off, with the trades they made (a book's sheet lists them)
      options: { enabled: false, trades: o.trades.slice(0, 20) },
      scalps: { enabled: false, trades: x.trades.slice(0, 20) },
      dips: { enabled: false, trades: p.trades.slice(0, 20) },
      runners: { enabled: false, trades: rn.trades.slice(0, 20) },
      spy: quote ? { last: quote.last, bid: quote.bid, ask: quote.ask, prevClose: quote.prevClose, open: quote.open, high: quote.high, low: quote.low, at: quote.at, vol: S.vol, want: S.w } : null,
      // the newest eighty, and every older trade of the books that hold markets across days: a market's sheet lists
      // all of its trades, and the switched-off books' scalps and runners pushed Solana's first buy out of the eighty
      fills: [...this.state.fills.slice(0, 80), ...this.state.fills.slice(80).filter((f) => f.book === 'crypto' || f.book === 'stocks').slice(0, 60)],
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
// What holding one slot would be worth at this price: the slot bought at its first trade's price, less the fee
// a buyer pays; a slot not bought in yet is the cash it is, and with no price there is no figure
function slotHold(sl, px) {
  if (!(sl.benchPx > 0)) return sl.initial;
  if (!(px > 0)) return null;
  return sl.initial * px / (sl.benchPx * (1 + (sl.benchFeeBps || 0) / 10000));
}
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
// The newest moment a saved state vouches for: every fill is saved the instant it is made (pushFill), the
// minute's value on the next save. tools/desk-check.js reads the same.
function stateTime(S) {
  const h = S.history || [], f = S.fills || [];
  return Math.max(h.length ? h[h.length - 1].t : 0, f.length ? f[0].at : 0, S.startedAt || 0);
}

module.exports = { Desk, AGENTS, lotName, hm, logLevel, ROUTINE_KEEP, stateTime };

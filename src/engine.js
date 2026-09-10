'use strict';
const fs = require('fs');
const path = require('path');
const pm = require('./venues/polymarket');
const ks = require('./venues/kalshi');
const http = require('./http');
const { makeBroker } = require('./broker');
const { makeRecorder } = require('./recorder');
const { makeProbe } = require('./probe');
const { makeJournal } = require('./journal');
const { makeMakerDesk } = require('./makerdesk');
const agents = require('./agents');

const AGENTS = [
  { key: 'BRAM', n: '01', role: 'PRICING', color: '#3b82f6' },
  { key: 'KETT', n: '02', role: 'EXECUTION', color: '#22c55e' },
  { key: 'RIGO', n: '03', role: 'SETTLEMENT', color: '#ef4444' },
  { key: 'TESS', n: '04', role: 'OPS', color: '#ec4899' },
  { key: 'HOLT', n: '05', role: 'SCANNER', color: '#e5e7eb' },
  { key: 'ILSA', n: '06', role: 'SENTIMENT', color: '#f59e0b' },
  { key: 'MAKR', n: '07', role: 'MAKING', color: '#a855f7' },
];
const r2 = (x) => Math.round(x * 100) / 100;
const r3 = (x) => Math.round(x * 1000) / 1000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'state.json');
    this.state = this.load();
    this.broker = makeBroker(cfg, this);
    this.recordTick = makeRecorder(cfg);
    this.probe = makeProbe(cfg);
    this.journal = makeJournal(cfg);
    this.maker = makeMakerDesk(cfg);
    this.lastCycleMs = 0;
    // Operator halt, distinct from TESS's automatic one. TESS recomputes its halt from scratch
    // every cycle, so anything written to this.halt is gone within 15s -- a kill switch that
    // un-sets itself is not a kill switch. This latches until a human clears it.
    this.operatorHalt = null;
    this.pinned = new Map(); // positions' markets, kept alive when they drop out of the universe
    this.quotes = { pm: new Map(), ks: new Map() };
    this.pairs = [];
    this.rejected = [];
    this.signals = [];
    this.history = new Map(); // pairId -> [{t, pmMid, ksMid}]
    this.bias = new Map();
    this.agentStatus = Object.fromEntries(AGENTS.map((a) => [a.key, { lastActive: 0, runs: 0, note: '' }]));
    this.timers = {};
    this.lastQuoteAt = 0;
    this.halt = 'warming up';
    this.cycle = 0;
    this.resolutionChecks = new Map();
    this.cooldown = new Map(); // pairId -> last exit time; no re-entry for a while
    this.demoShift = new Map();
    this.liveReady = cfg.mode !== 'live';
    this.liveBalance = null;
    this.dirty = false;
    this.stepping = false;
  }

  // ---------------------------------------------------------------- persistence
  load() {
    // A ledger that exists but will not parse is a CORRUPT BOOK, not a new account. Silently
    // returning a fresh balance here would erase real positions and P&L on the next save, so a
    // missing file starts fresh and a broken one refuses to start.
    if (fs.existsSync(this.file)) {
      let s;
      try { s = JSON.parse(fs.readFileSync(this.file, 'utf8')); }
      catch (e) { throw new Error(`state file ${this.file} is unreadable (${e.message}). Refusing to start and overwrite it \u2014 move it aside to begin a fresh account.`); }
      if (!s || s.version !== 1) throw new Error(`state file ${this.file} has unexpected version ${s && s.version}. Refusing to start.`);
      if (!s.maker) s.maker = { cash: this.cfg.initialBalance, equity: this.cfg.initialBalance, markets: {}, fills: 0 };
      return s;
    }
    return {
      version: 1, startedAt: Date.now(), mode: this.cfg.mode,
      initial: this.cfg.initialBalance, cash: this.cfg.initialBalance,
      positions: [], closed: [], balanceHistory: [], log: [],
      dayKey: null, dayStartEquity: this.cfg.initialBalance,
      stats: { wins: 0, losses: 0, realized: 0, fees: 0, groupsClosed: 0 },
      // the MAKER desk keeps its own cash and inventory. Separate on purpose: mixing a taker book
      // and a maker book into one equity number makes it impossible to tell which one is working.
      maker: { cash: this.cfg.initialBalance, equity: this.cfg.initialBalance, markets: {}, fills: 0 },
    };
  }
  save() {
    // temp-then-rename: a crash mid-write leaves the previous ledger intact instead of a
    // truncated file that load() would now refuse to start from
    try {
      fs.mkdirSync(this.cfg.dataDir, { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('save failed', e.message); }
  }

  // ---------------------------------------------------------------- helpers
  due(name, sec) {
    const now = Date.now();
    if (!this.timers[name] || now - this.timers[name] >= sec * 1000) { this.timers[name] = now; return true; }
    return false;
  }
  // The note is what the agent SAYS on the floor, in a box about thirty characters wide. log()
  // also calls touch with the full log line, which is how the floor ended up full of sentences
  // sliced off mid-word. Keep the first clause, and cut on a word boundary if even that is long --
  // a short true statement beats a long one with its end missing.
  touch(agent, note) {
    const a = this.agentStatus[agent];
    a.lastActive = Date.now(); a.runs++;
    if (!note) return;
    let n = String(note).split('·')[0].trim();
    if (n.length > 30) n = n.slice(0, 30).replace(/\s+\S*$/, '').trim();
    a.note = n;
  }
  log(agent, kind, pnl, text) {
    const entry = { t: Date.now(), agent, kind, pnl: pnl == null ? null : r2(pnl), text };
    this.state.log.unshift(entry);
    if (this.state.log.length > 500) this.state.log.length = 500;
    this.touch(agent, text);
    this.dirty = true;
    const p = pnl == null ? '' : `${pnl >= 0 ? '+' : '-'}$${Math.abs(pnl).toFixed(2)}`;
    console.log(`${new Date().toISOString().slice(11, 19)} ${agent} ${kind.padEnd(8)} ${p.padEnd(9)} ${text}`);
  }
  equity() { return r2(this.state.cash + this.state.positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0)); }
  budget() { return r2(Math.max(0, Math.min(this.cfg.maxPositionPct * this.equity(), this.state.cash * 0.95))); }

  quote(pair) {
    const m = this.quotes.pm.get(pair.pm.id), k = this.quotes.ks.get(pair.ks.ticker);
    if (!m || !k) return null;
    let pmBid = m.bestBid, pmAsk = m.bestAsk;
    if (pair.pm.tokenIndex === 1) { pmBid = 1 - m.bestAsk; pmAsk = 1 - m.bestBid; }
    let ksBid = k.yesBid, ksAsk = k.yesAsk;
    if (this.cfg.demo) {
      const s = this.demoShift.get(pair.id) || 0;
      ksBid = clamp(r3(ksBid + s), 0.01, 0.98); ksAsk = clamp(r3(ksAsk + s), ksBid + 0.01, 0.99);
    }
    if (![pmBid, pmAsk, ksBid, ksAsk].every(Number.isFinite) || pmAsk <= 0 || ksAsk <= 0 || pmBid >= 1 || ksBid >= 1) return null;
    return {
      pmBid, pmAsk, ksBid, ksAsk,
      pmMid: (pmBid + pmAsk) / 2, ksMid: (ksBid + ksAsk) / 2,
      pmSpread: pmAsk - pmBid, ksSpread: ksAsk - ksBid,
      pmVol: m.vol24, ksVol: k.vol24,
      // this pair's OWN observation time, not the global clock: see refreshQuotes
      t: Math.min(m.at || this.lastQuoteAt, k.at || this.lastQuoteAt),
    };
  }
  markPrice(pos, q) {
    if (pos.venue === 'PM') return pos.side === 'yes' ? q.pmBid : r3(1 - q.pmAsk);
    return pos.side === 'yes' ? q.ksBid : r3(1 - q.ksAsk);
  }

  // Fresh order book for a pair on `venue`: ask ladder for buying `side`, plus live YES top-of-book.
  async book(venue, pair, side) {
    if (this.cfg.demo) {
      const q = pair.q;
      const yesBid = venue === 'PM' ? q.pmBid : q.ksBid, yesAsk = venue === 'PM' ? q.pmAsk : q.ksAsk;
      const ask = side === 'yes' ? yesAsk : 1 - yesBid;
      return { asks: [{ price: r3(ask), size: 400 }, { price: r3(ask + 0.01), size: 900 }], yesBid, yesAsk };
    }
    if (venue === 'PM') {
      const m = this.quotes.pm.get(pair.pm.id);
      const b = await pm.fetchBook(m.tokenIds[pair.pm.tokenIndex]);
      // the NO book mirrors the YES book on Polymarket's CLOB (buy NO at p == sell YES at 1-p)
      const asks = side === 'yes' ? b.asks : b.bids.map((l) => ({ price: r3(1 - l.price), size: l.size }));
      return { asks, yesBid: b.bids[0] ? b.bids[0].price : null, yesAsk: b.asks[0] ? b.asks[0].price : null };
    }
    const b = await ks.fetchBook(pair.ks.ticker);
    return { asks: side === 'yes' ? b.yesAsks : b.noAsks, yesBid: b.yesBids[0] ? b.yesBids[0].price : null, yesAsk: b.yesAsks[0] ? b.yesAsks[0].price : null };
  }

  // Has the market behind a position resolved? Checked only once the market leaves the open listing.
  async resolution(pos) {
    if (pos.venue === 'KS' ? this.quotes.ks.has(pos.ref) : this.quotes.pm.has(pos.pmId)) return null;
    const last = this.resolutionChecks.get(pos.id) || 0;
    if (Date.now() - last < 60000) return null;
    this.resolutionChecks.set(pos.id, Date.now());
    if (pos.venue === 'KS') {
      const m = await ks.fetchMarket(pos.ref);
      if (m && (m.result === 'yes' || m.result === 'no')) return { resolved: true, yesWins: m.result === 'yes' };
      if (m && m.status === 'open') this.quotes.ks.set(m.ticker, m); // just fell out of the top listing
      return null;
    }
    const m = await pm.fetchMarket(pos.pmId);
    if (m && m.closed && m.resolved && m.prices.length > pos.tokenIndex) return { resolved: true, yesWins: m.prices[pos.tokenIndex] > 0.5 };
    if (m && !m.closed) this.quotes.pm.set(m.id, m);
    return null;
  }

  // ---------------------------------------------------------------- positions
  // The exchange reference for one leg. A Polymarket NO leg is a DIFFERENT token from the YES
  // leg. The old inline expression fell back to the YES token id whenever the market was missing
  // from the quote map: harmless bookkeeping on paper, the wrong instrument with real money.
  // There is no safe default here, so fail loudly and let the caller skip the signal.
  legRef(pair, leg) {
    if (leg.venue === 'KS') return pair.ks.ticker;
    if (leg.side === 'yes') return pair.pm.tokenId;
    const ref = ((this.quotes.pm.get(pair.pm.id) || {}).tokenIds || [])[1 - pair.pm.tokenIndex];
    if (!ref) throw new Error(`no Polymarket NO token for ${pair.label} (market ${pair.pm.id} absent from quote map)`);
    return ref;
  }
  open(signal, leg, fill, group, note) {
    const pos = {
      id: `${group}-${leg.venue}${leg.side[0]}`, group, pairId: signal.pair.id, label: signal.pair.label,
      venue: leg.venue,
      ref: this.legRef(signal.pair, leg),
      pmId: signal.pair.pm.id, tokenIndex: signal.pair.pm.tokenIndex,
      side: leg.side, qty: fill.filled, entry: fill.avg, fee: fill.fee, cost: fill.cost, mark: fill.avg,
      openedAt: Date.now(), strategy: signal.type, entryGap: signal.gap != null ? r3(Math.abs(signal.gap)) : null, note,
      orderId: fill.orderId || null,
    };
    this.state.cash = r2(this.state.cash - fill.cost);
    this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
    this.state.positions.push(pos);
    this.journal(this, 'OPEN', { id: pos.id, group, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, entry: pos.entry, fee: pos.fee, cost: pos.cost, strategy: pos.strategy, ref: pos.ref, orderId: pos.orderId, cash: this.state.cash });
    this.dirty = true;
    return pos;
  }

  async close(pos, px, reason, resolved = false) {
    let fill;
    if (resolved) fill = { filled: pos.qty, avg: px, fee: 0, proceeds: r2(pos.qty * px) };
    else {
      // A position whose exit does not fill is STUCK, not closed. Flag it so RIGO keeps trying
      // every cycle instead of leaving naked directional risk sitting in the book unattended.
      pos.exitSeq = (pos.exitSeq || 0) + 1;
      try { fill = await this.broker.sell({ venue: pos.venue, ref: pos.ref, side: pos.side, qty: pos.qty, px, key: `${pos.id}-out-${pos.exitSeq}` }); }
      catch (e) {
        pos.orphan = true; this.journal(this, 'EXIT_FAIL', { id: pos.id, reason: String(e.message).slice(0, 120), attempt: pos.exitSeq });
        if (this.due(`exit-fail-${pos.id}`, 120)) this.log('RIGO', 'PASS', null, `${pos.label}: exit failed (${e.message.slice(0, 80)}) \u00b7 flagged stuck, will retry`);
        return;
      }
      if (!fill.filled) {
        pos.orphan = true; this.journal(this, 'EXIT_FAIL', { id: pos.id, reason: fill.reason || 'no fill', attempt: pos.exitSeq });
        if (this.due(`exit-fail-${pos.id}`, 120)) this.log('RIGO', 'PASS', null, `${pos.label}: exit unfilled (${fill.reason || 'no fill'}) \u00b7 flagged stuck, will retry`);
        return;
      }
    }
    const idx = this.state.positions.indexOf(pos);
    if (idx < 0) return;
    this.state.positions.splice(idx, 1);
    this.cooldown.set(pos.pairId, Date.now());
    this.state.cash = r2(this.state.cash + fill.proceeds);
    this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
    const pnl = r2(fill.proceeds - pos.cost);
    const closed = { ...pos, exit: fill.avg, exitAt: Date.now(), pnl, reason };
    this.state.closed.push(closed);
    if (this.state.closed.length > 2000) this.state.closed.splice(0, this.state.closed.length - 2000);
    this.state.stats.realized = r2(this.state.stats.realized + pnl);
    // score a group (arb = 2 legs, converge = 1 leg) once its last leg closes
    const stillOpen = this.state.positions.some((p) => p.group === pos.group);
    let text = `${pos.label} · sold ${pos.qty} ${pos.side.toUpperCase()} @ ${pos.venue === 'PM' ? 'Polymarket' : 'Kalshi'} ${fill.avg.toFixed(3)} (in ${pos.entry.toFixed(3)}) · ${reason}`;
    if (!stillOpen) {
      const gpnl = r2(this.state.closed.filter((c) => c.group === pos.group).reduce((a, c) => a + c.pnl, 0));
      this.state.stats.groupsClosed++;
      if (gpnl >= 0) this.state.stats.wins++; else this.state.stats.losses++;
      if (pos.strategy === 'arb') text += ` · arb pair net ${gpnl >= 0 ? '+' : '−'}$${Math.abs(gpnl).toFixed(2)}`;
    }
    this.journal(this, resolved ? 'SETTLE' : 'CLOSE', { id: pos.id, group: pos.group, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, entry: pos.entry, exit: fill.avg, fee: fill.fee, proceeds: fill.proceeds, pnl, reason, strategy: pos.strategy, heldMs: Date.now() - pos.openedAt, cash: this.state.cash });
    this.log('RIGO', 'SETTLE', pnl, text);
    this.dirty = true;
  }

  // Manual kill switch, reachable only over POST /api/flatten with FLATTEN_TOKEN. Halting new
  // risk is not the same as being flat: TESS's drawdown halt stops entries while leaving every
  // open position running. This is the button for when you want out of everything, now.
  async flattenAll(reason = 'manual flatten') {
    const open = [...this.state.positions];
    this.operatorHalt = `flattened by operator (${reason}) \u2014 POST /api/resume to re-enable`;
    this.journal(this, 'FLATTEN_REQUESTED', { reason, positions: open.length });
    this.log('TESS', 'OPS', null, `FLATTEN ALL requested (${reason}) \u00b7 ${open.length} position${open.length === 1 ? '' : 's'} to close`);
    for (const pos of open) {
      const pair = this.pairs.find((p) => p.id === pos.pairId);
      const px = pair && pair.q ? this.markPrice(pos, pair.q) : (pos.mark ?? pos.entry);
      await this.close(pos, px, `flatten: ${reason}`).catch(() => {});
    }
    // one switch covers both desks: maker inventory is real risk too
    const mk = await this.maker.flatten(this, reason).catch(() => ({ markets: 0, contracts: 0 }));
    const left = this.state.positions.length;
    this.log('TESS', 'OPS', null, left ? `flatten incomplete \u00b7 ${left} position(s) would not fill, flagged stuck` : 'flatten complete \u00b7 book is empty \u00b7 new risk stays disabled until /api/resume');
    return { requested: open.length, remaining: left, halted: this.operatorHalt, makerMarketsFlattened: mk.markets, makerContracts: Math.round(mk.contracts) };
  }

  resume() {
    const was = this.operatorHalt;
    this.operatorHalt = null;
    this.maker.resume(this);
    this.journal(this, 'RESUMED', { was });
    this.log('TESS', 'OPS', null, 'operator halt cleared \u00b7 automatic risk checks resume control');
    return { resumed: !!was };
  }

  // ---------------------------------------------------------------- data
  async refreshQuotes() {
    const [pmRes, ksRes] = await Promise.allSettled([pm.fetchUniverse(this.cfg.pmUniverse), ks.fetchAll(this.cfg.ksSeries)]);
    // Stamp each market with when IT was fetched. lastQuoteAt only advances when BOTH venues
    // succeed, so it cannot tell "everything is fresh" from "this one market stopped updating" \u2014
    // and quote() carries a pair's last good quote forward indefinitely when it cannot reprice.
    const at = Date.now();
    if (pmRes.status === 'fulfilled') this.quotes.pm = new Map(pmRes.value.map((m) => [m.id, Object.assign(m, { at })]));
    if (ksRes.status === 'fulfilled') this.quotes.ks = new Map(ksRes.value.map((m) => [m.ticker, Object.assign(m, { at })]));
    if (pmRes.status === 'fulfilled' && ksRes.status === 'fulfilled') this.lastQuoteAt = Date.now();
    else if (this.due('quote-err', 60)) {
      const why = [pmRes, ksRes].filter((r) => r.status === 'rejected').map((r) => r.reason && r.reason.message).join(' | ');
      this.log('TESS', 'OPS', null, `quote refresh failed: ${String(why).slice(0, 140)}`);
    }
  }
  // A market holding an open position must stay in the quote map even after it falls out of the
  // top-N universe listing. Without this HOLT stops rebuilding its pair, RIGO's `E.pairs.find`
  // returns undefined, and the position is never marked, stopped, max-held or flattened again \u2014
  // it simply sits until resolution with nothing watching it. Polymarket listings are ranked by
  // 24h volume, so a pre-game market drifting below rank 300 during a normal 4-hour hold hits
  // exactly this. refreshQuotes replaces the whole map each cycle, so re-pin every cycle.
  async pinPositions() {
    for (const pos of this.state.positions) {
      const map = pos.venue === 'KS' ? this.quotes.ks : this.quotes.pm;
      const key = pos.venue === 'KS' ? pos.ref : pos.pmId;
      if (map.has(key)) continue;
      if (!this.due(`pin-${pos.id}`, 60)) {          // at most one refetch a minute per position
        const cached = this.pinned.get(pos.id);
        if (cached) map.set(key, cached);            // stale, but honestly timestamped via cached.at
        continue;
      }
      try {
        const m = pos.venue === 'KS' ? await ks.fetchMarket(pos.ref) : await pm.fetchMarket(pos.pmId);
        if (!m || m.closed || m.status === 'closed') continue; // settled: resolution() handles it
        m.at = Date.now();
        this.pinned.set(pos.id, m);
        map.set(key, m);
      } catch { /* never block the cycle; resolution() is the backstop */ }
    }
    for (const id of [...this.pinned.keys()]) if (!this.state.positions.some((p) => p.id === id)) this.pinned.delete(id);
  }

  // The Gamma listing can lag the CLOB by minutes; overwrite pair quotes with live CLOB top-of-book.
  async refreshPairPrices() {
    const toks = [...new Set(this.pairs.map((p) => p.pm.tokenId).filter(Boolean))];
    if (!toks.length) return;
    let prices;
    try { prices = await pm.fetchPrices(toks); }
    catch (e) { if (this.due('clob-err', 120)) this.log('TESS', 'OPS', null, `CLOB price refresh failed: ${String(e.message).slice(0, 100)} · falling back to listing quotes`); return; }
    for (const p of this.pairs) {
      const live = prices.get(p.pm.tokenId), m = this.quotes.pm.get(p.pm.id);
      if (!live || !m) continue;
      if (p.pm.tokenIndex === 0) { m.bestBid = live.bid; m.bestAsk = live.ask; }
      else { m.bestBid = 1 - live.ask; m.bestAsk = 1 - live.bid; }
    }
  }
  perturbDemo() {
    for (const p of this.pairs) {
      let s = (this.demoShift.get(p.id) || 0) * 0.55;
      if (Math.random() < 0.22) s += (Math.random() - 0.5) * 0.14;
      this.demoShift.set(p.id, Math.abs(s) < 0.003 ? 0 : r3(s));
    }
  }
  recordHistory() {
    const t = Date.now();
    for (const p of this.pairs) {
      if (!p.q) continue;
      const h = this.history.get(p.id) || [];
      h.push({ t, pmMid: p.q.pmMid, ksMid: p.q.ksMid });
      if (h.length > 240) h.shift();
      this.history.set(p.id, h);
    }
    for (const id of [...this.history.keys()]) if (!this.pairs.some((p) => p.id === id)) this.history.delete(id);
  }
  pushBalance() {
    const eq = this.equity();
    const h = this.state.balanceHistory;
    const last = h[h.length - 1];
    if (!last || Math.abs(last.b - eq) >= 0.005 || Date.now() - last.t > 120000) {
      h.push({ t: Date.now(), b: eq });
      if (h.length > 5000) h.splice(0, h.length - 5000);
      this.dirty = true;
    }
  }

  // ---------------------------------------------------------------- loop
  async start() {
    // per-series taker multipliers before anything prices: MLB bills at half, fourteen series at
    // zero, and a flat rate made the desk decline trades that were cheaper than it believed
    await ks.loadFeeMultipliers(this.cfg.ksSeries).catch(() => {});
    if (this.cfg.mode === 'live') await this.broker.init();
    this.log('TESS', 'OPS', null, `desk online · ${this.cfg.mode.toUpperCase()} mode${this.cfg.demo ? ' with DEMO quote noise' : ''} · equity $${this.equity().toFixed(2)} · ${this.cfg.ksSeries.length} Kalshi series vs top ${this.cfg.pmUniverse} Polymarket markets`);
    await this.step();
    setInterval(() => this.step().catch((e) => console.error(e)), this.cfg.priceEvery * 1000);
    // The maker gets its own loop. Riding the taker's 15s cycle every other tick meant a 30-second
    // stale quote, which cost more than everything else on this desk combined. `running` is the
    // guard: a slow round must never start a second one on top of itself.
    let running = false;
    setInterval(async () => {
      if (running) return;
      running = true;
      const t0 = Date.now();
      try { await this.maker.step(this); }
      catch (e) { this.log('MAKR', 'OPS', null, `maker cycle error: ${String(e.message).slice(0, 110)}`); }
      finally {
        running = false;
        this.lastMakerMs = Date.now() - t0;
        if (this.lastMakerMs > this.cfg.makerEverySec * 1000 && this.due('makr-slow', 300)) {
          this.log('MAKR', 'OPS', null, `requote took ${(this.lastMakerMs / 1000).toFixed(1)}s, longer than the ${this.cfg.makerEverySec}s target · quotes are going stale`);
        }
      }
    }, this.cfg.makerEverySec * 1000);
    setInterval(() => { if (this.dirty) this.save(); }, 10000);
  }
  async step() {
    if (this.stepping) return;
    this.stepping = true;
    const t0 = Date.now();
    try {
      this.cycle++;
      await this.refreshQuotes();
      await this.pinPositions(); // before HOLT: it rebuilds pairs from whatever is in the map
      agents.HOLT(this);
      await this.refreshPairPrices();
      if (this.cfg.demo) this.perturbDemo();
      for (const p of this.pairs) p.q = this.quote(p) || p.q || null;
      this.recordHistory();
      if (this.cycle % this.cfg.sentimentEveryCycles === 1) agents.ILSA(this);
      agents.TESS(this);
      await agents.RIGO(this);
      agents.BRAM(this);
      this.recordTick(this); // durable tape of what BRAM just saw; never throws
      await this.probe(this);  // full order books whenever a gap looks too good; never throws
      await agents.KETT(this);
      // the maker runs on its own cadence: requoting every cycle costs an API call per market and
      // buys nothing when the book has not moved
      // the maker runs on its own timer now (see start) -- it must not wait on the taker cycle
      this.pushBalance();
    } catch (e) {
      http.noteError(e);
      this.log('TESS', 'OPS', null, `cycle error: ${String(e.message).slice(0, 140)}`);
    } finally {
      this.lastCycleMs = Date.now() - t0;
      // A cycle that outruns its own interval means the next tick is silently dropped by the
      // `stepping` guard. That used to happen invisibly; say so.
      if (this.lastCycleMs > this.cfg.priceEvery * 1000 && this.due('slow-cycle', 300)) {
        this.log('TESS', 'OPS', null, `cycle took ${(this.lastCycleMs / 1000).toFixed(1)}s, longer than the ${this.cfg.priceEvery}s interval \u00b7 ticks are being skipped`);
      }
      this.stepping = false;
    }
  }

  // ---------------------------------------------------------------- snapshot for the UI
  snapshot() {
    const now = Date.now();
    const s = this.state;
    const equity = this.equity();
    const unrealized = r2(s.positions.reduce((a, p) => a + (p.qty * (p.mark ?? p.entry) - p.cost), 0));
    const deployed = r2(s.positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
    let hist = s.balanceHistory;
    if (hist.length > 600) { const k = Math.ceil(hist.length / 600); hist = hist.filter((_, i) => i % k === 0 || i === hist.length - 1); }
    const pairs = this.pairs.filter((p) => p.q).map((p) => ({
      id: p.id, label: p.label, kind: p.kind, series: p.series, inPlay: !!p.inPlay, startsAt: p.startsAt || null,
      pmMid: r3(p.q.pmMid), ksMid: r3(p.q.ksMid), gap: r3(p.q.ksMid - p.q.pmMid),
      age: p.q.t ? Math.round((now - p.q.t) / 1000) : null,
      pmVol: Math.round(p.q.pmVol), ksVol: Math.round(p.q.ksVol), pmUrl: p.pm.url, ksUrl: p.ks.url,
      bias: this.bias.get(p.id) ? r2(this.bias.get(p.id).score) : null,
      hist: (this.history.get(p.id) || []).slice(-60).map((h) => [r3(h.pmMid), r3(h.ksMid)]),
    })).sort((a, b) => (a.inPlay - b.inPlay) || Math.abs(b.gap) - Math.abs(a.gap));
    const top = (list, key) => list.sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
    return {
      now, name: 'The Hexagon', mode: this.cfg.mode, demo: this.cfg.demo, startedAt: s.startedAt, halt: this.halt,
      initial: s.initial, cash: s.cash, equity, deployed, unrealized, realized: s.stats.realized, fees: s.stats.fees,
      wins: s.stats.wins, losses: s.stats.losses, liveBalance: this.liveBalance,
      positions: s.positions.map((p) => ({ id: p.id, label: p.label, venue: p.venue, side: p.side, qty: p.qty, entry: p.entry, mark: p.mark, cost: p.cost, pnl: r2(p.qty * (p.mark ?? p.entry) - p.cost), strategy: p.strategy, openedAt: p.openedAt })),
      closed: s.closed.slice(-80).map((c) => ({ t: c.exitAt, pnl: c.pnl, label: c.label, reason: c.reason, strategy: c.strategy })),
      log: s.log.slice(0, 150),
      balanceHistory: hist,
      agents: AGENTS.map((a) => ({ ...a, ...this.agentStatus[a.key], active: now - this.agentStatus[a.key].lastActive < 4000 })),
      pairs: pairs.slice(0, 40),
      pairCount: this.pairs.length,
      cycleMs: this.lastCycleMs,
      maker: this.maker.snapshot(this),
      universe: {
        pm: this.quotes.pm.size, ks: this.quotes.ks.size, dataAge: this.lastQuoteAt ? Math.round((now - this.lastQuoteAt) / 1000) : null,
        apiOk: http.stats.ok, apiErr: http.stats.err, lastError: http.stats.lastError, rejected: this.rejected.length,
        pmTop: top([...this.quotes.pm.values()]).map((m) => ({ q: m.question, px: r3((m.bestBid + m.bestAsk) / 2), vol: Math.round(m.vol24), url: m.url })),
        ksTop: top([...this.quotes.ks.values()]).map((m) => ({ q: m.title, px: r3((m.yesBid + m.yesAsk) / 2), vol: Math.round(m.vol24), url: m.url })),
      },
      signals: this.signals.slice(0, 5).map((x) => ({ type: x.type, label: x.pair.label, edge: r3(x.edge), gap: x.gap != null ? r3(x.gap) : null })),
      cfg: { minGap: this.cfg.minGap, minEdge: this.cfg.minEdge, exitGap: this.cfg.exitGap, stopLoss: this.cfg.stopLoss, minArbEdge: this.cfg.minArbEdge, maxPositionPct: this.cfg.maxPositionPct, maxOpenPositions: this.cfg.maxOpenPositions, maxDailyDrawdownPct: this.cfg.maxDailyDrawdownPct, maxHoldMin: this.cfg.maxHoldMin, priceEvery: this.cfg.priceEvery,
        makerMarkets: this.cfg.makerMarkets, makerMinTradesPerDay: this.cfg.makerMinTradesPerDay,
        makerMaxClearDays: this.cfg.makerMaxClearDays },
    };
  }
}

module.exports = { Engine, AGENTS };

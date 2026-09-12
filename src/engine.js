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
const { MAX_VENUE_DISAGREE } = require('./matcher');
const { Brain } = require('./brain');

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
// A POST whose response was lost is neither a failed order nor a safe retry. The live broker
// persists the intent before sending it; the engine keeps the affected position out of RIGO's
// retry loop until reconciliation can say whether the exchange accepted it.
const ambiguousOrder = (e) => !!(e && (e.ambiguousOrder || e.code === 'KALSHI_ORDER_UNKNOWN'));

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
    // The minds. Constructed even without a key: `enabled()` is false and every desk
    // falls straight through to its deterministic path.
    this.brain = new Brain(cfg);
    this.brainSignals = [];   // mind-originated signals, merged into the book after BRAM

    this.lastCycleMs = 0;
    // Operator halt, distinct from TESS's automatic one. TESS recomputes its halt from scratch
    // every cycle, so anything written to this.halt is gone within 15s -- a kill switch that
    // un-sets itself is not a kill switch. This latches until a human clears it.
    //
    // ...and it must survive a RESTART, or it is not a latch either. save() serialises only
    // `this.state`, so an instance field here was gone on the next boot: an operator flattens the
    // book, the machine restarts (fly deploy, --restart=always, a crash), and the desk quietly
    // re-arms itself with nobody having called /api/resume. The maker's equivalent lives in
    // state.maker.halted and always did survive, so ONE operator action left the two desks in
    // opposite states -- which is how this surfaced at all.
    this.operatorHalt = this.state.operatorHalt || null;
    // Positions with a close in flight. Process-local on purpose: a restart must NOT believe a
    // close is still running, or a genuinely stuck position could never be retried.
    this.closing = new Set();
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
      // Group metadata is additive. Older paper ledgers did not retain an explicit arb record,
      // so retain them and derive their scorecard from the open legs instead of treating a
      // restart as an accounting error.
      if (!s.arbGroups) s.arbGroups = {};
      return s;
    }
    return {
      version: 1, startedAt: Date.now(), mode: this.cfg.mode,
      initial: this.cfg.initialBalance, cash: this.cfg.initialBalance,
      positions: [], closed: [], balanceHistory: [], log: [],
      arbGroups: {},
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
      this.state.operatorHalt = this.operatorHalt || null;   // latched across restarts
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

  // A locked arb has two useful valuations. Liquidation is what both legs would fetch at their
  // current bids, and is deliberately what equity()/risk limits use. Settlement is the $1 payout
  // of a verified complementary pair. Mixing them made healthy arbs look like losses whenever
  // either venue's mark was stale or one side had temporarily disappeared from the book.
  arbScorecard() {
    const byGroup = new Map();
    for (const pos of this.state.positions) if (pos.strategy === 'arb') {
      const g = byGroup.get(pos.group) || [];
      g.push(pos); byGroup.set(pos.group, g);
    }
    const groups = [];
    for (const [id, legs] of byGroup) {
      const meta = this.state.arbGroups[id] || {};
      const sides = new Set(legs.map((p) => p.side));
      const venues = new Set(legs.map((p) => p.venue));
      const qtys = new Set(legs.map((p) => p.qty));
      const pairIds = new Set(legs.map((p) => p.pairId));
      let integrity = 'valid';
      if (legs.length !== 2) integrity = legs.length < 2 ? 'orphan_leg' : 'too_many_legs';
      else if (sides.size !== 2 || !sides.has('yes') || !sides.has('no')) integrity = 'missing_complement';
      else if (venues.size !== 2 || !venues.has('PM') || !venues.has('KS')) integrity = 'venue_mismatch';
      else if (qtys.size !== 1) integrity = 'quantity_mismatch';
      else if (pairIds.size !== 1 || (meta.pairId && !pairIds.has(meta.pairId))) integrity = 'pair_mismatch';
      // Everything above checks the SHAPE of the pair, and a mismatched pair has a perfect shape.
      // On 2026-09-12 the desk held "EPL Mar win": Kalshi's Everton (Tottenham v Everton) against
      // Polymarket's Everton de Viña del Mar. One YES, one NO, one per venue, equal size, one
      // pairId -- valid on every line above, reported as +$26 locked, and heading for about -$198
      // because both legs lost. The only evidence a held arb is two different events is that its
      // two venues price the outcome very differently, so re-apply the matcher's own definition of
      // "we matched the wrong thing" to each leg's live market. Where either market has no usable
      // quote the check is skipped, not failed: a price that lags or briefly leaves the book is
      // exactly what this scorecard exists NOT to mistake for a loss.
      let venueGap = null;
      if (integrity === 'valid') {
        const ksLeg = legs.find((p) => p.venue === 'KS'), pmLeg = legs.find((p) => p.venue === 'PM');
        const a = this.legQuote(ksLeg), b = this.legQuote(pmLeg);
        if (a && b) {
          venueGap = r3(Math.abs(a.mid - b.mid));
          if (venueGap > MAX_VENUE_DISAGREE) integrity = 'venues_disagree';
        }
      }
      const entryCost = r2(legs.reduce((a, p) => a + p.cost, 0));
      const liquidationValue = r2(legs.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
      const qty = legs.length ? Math.min(...legs.map((p) => p.qty)) : 0;
      const settlementValue = integrity === 'valid' ? qty : null;
      groups.push({
        id, label: legs[0] && legs[0].label, pairId: legs[0] && legs[0].pairId,
        qty, legs: legs.length, integrity, venueGap, entryCost, liquidationValue,
        liquidationPnl: r2(liquidationValue - entryCost),
        settlementValue, lockedPnl: settlementValue == null ? null : r2(settlementValue - entryCost),
      });
    }
    return groups;
  }
  pnlScorecard() {
    const groups = this.arbScorecard();
    const arbLiquidation = r2(groups.reduce((a, g) => a + g.liquidationPnl, 0));
    const arbLocked = r2(groups.reduce((a, g) => a + (g.lockedPnl || 0), 0));
    // A group this scorecard cannot vouch for (any integrity other than 'valid') has no settlement
    // figure, and "no figure" must not become $0 in a total. Counting it at zero reported the
    // mismatched Everton arb as costing nothing at settlement (+$9.81 overall) while it was heading
    // for -$198. What it is demonstrably worth is what it would sell for now, so it enters the
    // settlement total at its liquidation P&L.
    const arbUnvouched = r2(groups.filter((g) => g.lockedPnl == null).reduce((a, g) => a + g.liquidationPnl, 0));
    const convergenceUnrealized = r2(this.state.positions.filter((p) => p.strategy !== 'arb')
      .reduce((a, p) => a + p.qty * (p.mark ?? p.entry) - p.cost, 0));
    const maker = this.maker && this.maker.snapshot ? this.maker.snapshot(this) : {};
    const makerNet = Number.isFinite(maker.equity) && Number.isFinite(maker.initial) ? r2(maker.equity - maker.initial) : null;
    return {
      realized: this.state.stats.realized, convergenceUnrealized, arbLocked, arbUnvouched, arbLiquidation, makerNet,
      totalLiquidation: r2(this.state.stats.realized + arbLiquidation + convergenceUnrealized),
      totalAtSettlement: r2(this.state.stats.realized + arbLocked + arbUnvouched + convergenceUnrealized),
      integrityAlerts: groups.filter((g) => g.integrity !== 'valid').length,
    };
  }
  createArbGroup(signal, group, legs, refs, qty) {
    const sides = new Set(legs.map((l) => l.side));
    const venues = new Set(legs.map((l) => l.venue));
    if (legs.length !== 2 || sides.size !== 2 || !sides.has('yes') || !sides.has('no') || venues.size !== 2 || !venues.has('PM') || !venues.has('KS') || !Number.isFinite(qty) || qty <= 0) {
      const reason = 'arb legs are not one PM/KS YES/NO pair';
      this.journal(this, 'ARB_REJECTED', { group, label: signal.pair.label, pairId: signal.pair.id, reason });
      throw new Error(reason);
    }
    const record = { group, pairId: signal.pair.id, label: signal.pair.label, qty, expectedPayout: qty, refs: [...refs], status: 'intended', createdAt: Date.now(), validationVersion: 1 };
    this.state.arbGroups[group] = record;
    this.journal(this, 'ARB_INTENT', record);
    this.journal(this, 'ARB_VALIDATED', { group, pairId: record.pairId, qty, expectedPayout: qty, validationVersion: 1 });
    this.dirty = true;
    return record;
  }
  completeArbGroup(group) {
    const score = this.arbScorecard().find((g) => g.id === group);
    const record = this.state.arbGroups[group];
    if (!record || !score) return;
    record.status = score.integrity === 'valid' ? 'filled' : 'alert';
    record.integrity = score.integrity;
    if (score.integrity === 'valid') this.journal(this, 'ARB_FILLED', { group, pairId: score.pairId, qty: score.qty, entryCost: score.entryCost, lockedPnl: score.lockedPnl });
    else this.journal(this, 'ARB_INTEGRITY_ALERT', { group, pairId: score.pairId, integrity: score.integrity });
    this.dirty = true;
  }

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
  // One leg's own market, in the PAIR's outcome terms ({bid, ask, mid} for YES), or null.
  //
  // RIGO marks positions through their pair, and a pair disappears the moment either market
  // leaves the listing: a match ends, a Polymarket market closes awaiting resolution, or a bad
  // pair is fixed in the matcher and never rebuilt. The mark then froze at its last value -- on
  // 2026-09-12 the dashboard carried a Chilean football leg at 19c for hours after it was worth
  // nothing, and showed a -$198 loss as -$97. pinPositions already keeps every held market in the
  // quote map; this is what reads it.
  legQuote(pos) {
    if (!pos) return null;
    let bid, ask;
    if (pos.venue === 'KS') {
      const k = this.quotes.ks.get(pos.ref);
      if (!k) return null;
      bid = k.yesBid; ask = k.yesAsk;
    } else {
      const m = this.quotes.pm.get(pos.pmId);
      if (!m) return null;
      if (Number.isFinite(m.bestBid) && Number.isFinite(m.bestAsk)) { bid = m.bestBid; ask = m.bestAsk; }
      else if (Number.isFinite((m.prices || [])[0])) { bid = ask = m.prices[0]; } // no book: last price
      if (pos.tokenIndex === 1 && Number.isFinite(bid) && Number.isFinite(ask)) [bid, ask] = [1 - ask, 1 - bid];
    }
    if (!Number.isFinite(bid) || !Number.isFinite(ask) || ask < bid || bid < 0 || ask > 1) return null;
    return { bid, ask, mid: (bid + ask) / 2 };
  }
  // What this position would sell for on its own venue, or null. Same bid-side convention as
  // markPrice, so a position marked either way is marked the same way.
  venueMark(pos) {
    const q = this.legQuote(pos);
    if (!q) return null;
    return pos.side === 'yes' ? r3(q.bid) : r3(1 - q.ask);
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

  // `pos.exitSeq++` and the broker round trip below both happen BEFORE the ownership check further
  // down, so two concurrent entrants -- two POSTs to /api/flatten, or a flatten landing inside
  // RIGO's await -- each minted a DIFFERENT idempotency key and sent a separate real sell for the
  // same contracts. Kalshi cannot dedupe two different client_order_ids. Paper hides it entirely:
  // PaperBroker.sell does no I/O, so the loop drains before anything can interleave.
  async close(pos, px, reason, resolved = false) {
    // An uncertain sell may have filled at the exchange. Do not turn its next scheduled RIGO pass
    // into a new client-order ID and a possible oversell; reconciliation owns this position now.
    if (pos.pendingExit) {
      if (this.due(`exit-pending-${pos.id}`, 300)) this.log('RIGO', 'HALT', null, `${pos.label}: exit ${pos.pendingExit.clientOrderId || 'order'} is awaiting reconciliation · not retrying`);
      return;
    }
    if (this.closing.has(pos.id)) return;
    this.closing.add(pos.id);
    try { return await this._close(pos, px, reason, resolved); }
    finally { this.closing.delete(pos.id); }
  }

  async _close(pos, px, reason, resolved = false) {
    let fill;
    if (resolved) fill = { filled: pos.qty, avg: px, fee: 0, proceeds: r2(pos.qty * px) };
    else {
      // A position whose exit does not fill is STUCK, not closed. Flag it so RIGO keeps trying
      // every cycle instead of leaving naked directional risk sitting in the book unattended.
      pos.exitSeq = (pos.exitSeq || 0) + 1;
      try { fill = await this.broker.sell({ venue: pos.venue, ref: pos.ref, side: pos.side, qty: pos.qty, px, key: `${pos.id}-out-${pos.exitSeq}` }); }
      catch (e) {
        if (ambiguousOrder(e)) {
          // The broker has already durably recorded the order intent. Keep the same local marker
          // alongside the position so a later cycle cannot manufacture a fresh exit key before
          // that record has been reconciled against Kalshi.
          pos.pendingExit = { clientOrderId: e.clientOrderId || `${pos.id}-out-${pos.exitSeq}`, intent: e.intent || null, at: Date.now() };
          this.liveReady = false;
          this.journal(this, 'EXIT_UNKNOWN', { id: pos.id, group: pos.group, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, attempt: pos.exitSeq, clientOrderId: pos.pendingExit.clientOrderId, intent: pos.pendingExit.intent, reason: String(e.message || 'order response unknown').slice(0, 120) });
          this.log('RIGO', 'HALT', null, `${pos.label}: exit response unknown · awaiting reconciliation before any retry`);
          this.save(); // persist the local no-retry marker with the broker's pending intent now
          return;
        }
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
    // A PARTIAL fill is not a close. `!fill.filled` above only catches a ZERO fill, so a sell that
    // got 30 of 100 used to splice the WHOLE position out, credit the 30 lots' proceeds, and book
    // the P&L against the full 100-lot cost -- stranding 70 real contracts with no local record:
    // unmarked by RIGO, uncounted against maxOpenPositions, invisible to the drawdown rail, and
    // past the reach of the orphan retry because the position object was already gone. open() has
    // always sized from fill.filled (`qty: fill.filled`); the exit path never learned to. Paper
    // never partial-fills, so this could only ever bite in live mode.
    if (fill.filled < pos.qty) {
      const sold = fill.filled;
      const costShare = r2(pos.cost * (sold / pos.qty));
      const pnl = r2(fill.proceeds - costShare);
      const before = pos.qty;
      pos.qty -= sold;
      pos.cost = r2(pos.cost - costShare);
      pos.orphan = true;                                   // RIGO retries the remainder every cycle
      pos.partialPnl = r2((pos.partialPnl || 0) + pnl);     // carried into the group score on final close
      this.state.cash = r2(this.state.cash + fill.proceeds);
      this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
      this.state.stats.realized = r2(this.state.stats.realized + pnl);
      this.journal(this, 'CLOSE_PARTIAL', { id: pos.id, group: pos.group, label: pos.label, venue: pos.venue, side: pos.side, sold, remaining: pos.qty, entry: pos.entry, exit: fill.avg, fee: fill.fee, proceeds: fill.proceeds, pnl, reason, attempt: pos.exitSeq, cash: this.state.cash });
      this.log('RIGO', 'SETTLE', pnl, `${pos.label} \u00b7 sold ${sold} of ${before} ${pos.side.toUpperCase()} @ ${pos.venue === 'PM' ? 'Polymarket' : 'Kalshi'} ${fill.avg.toFixed(3)} \u00b7 ${pos.qty} left unsold, flagged stuck and retried \u00b7 ${reason}`);
      this.dirty = true;
      return;
    }
    const idx = this.state.positions.indexOf(pos);
    if (idx < 0) return;
    this.state.positions.splice(idx, 1);
    this.cooldown.set(pos.pairId, Date.now());
    this.state.cash = r2(this.state.cash + fill.proceeds);
    this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
    const exitPnl = r2(fill.proceeds - pos.cost);
    // `closed` contains one record per leg, not one per fill. A partial close has already moved
    // cash and global realised P&L, so roll it into this final leg total before group scoring (and
    // before the dashboard presents the leg as closed).
    const partialPnl = r2(pos.partialPnl || 0);
    const pnl = r2(partialPnl + exitPnl);
    const closed = { ...pos, exit: fill.avg, exitAt: Date.now(), pnl, exitPnl, partialPnl, reason };
    this.state.closed.push(closed);
    if (this.state.closed.length > 2000) this.state.closed.splice(0, this.state.closed.length - 2000);
    this.state.stats.realized = r2(this.state.stats.realized + exitPnl);
    // score a group (arb = 2 legs, converge = 1 leg) once its last leg closes
    const stillOpen = this.state.positions.some((p) => p.group === pos.group);
    let text = `${pos.label} · sold ${pos.qty} ${pos.side.toUpperCase()} @ ${pos.venue === 'PM' ? 'Polymarket' : 'Kalshi'} ${fill.avg.toFixed(3)} (in ${pos.entry.toFixed(3)}) · ${reason}`;
    if (!stillOpen) {
      const gpnl = r2(this.state.closed.filter((c) => c.group === pos.group).reduce((a, c) => a + c.pnl, 0));
      this.state.stats.groupsClosed++;
      if (gpnl >= 0) this.state.stats.wins++; else this.state.stats.losses++;
      if (pos.strategy === 'arb') {
        text += ` · arb pair net ${gpnl >= 0 ? '+' : '−'}$${Math.abs(gpnl).toFixed(2)}`;
        const group = this.state.arbGroups[pos.group];
        if (group) { group.status = resolved ? 'settled' : 'closed'; group.closedAt = Date.now(); group.realizedPnl = gpnl; }
        this.journal(this, resolved ? 'ARB_SETTLED' : 'ARB_UNWOUND', { group: pos.group, label: pos.label, pnl: gpnl, reason });
      }
    }
    this.journal(this, resolved ? 'SETTLE' : 'CLOSE', { id: pos.id, group: pos.group, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, entry: pos.entry, exit: fill.avg, fee: fill.fee, proceeds: fill.proceeds, pnl: exitPnl, legPnl: pnl, partialPnl, reason, strategy: pos.strategy, heldMs: Date.now() - pos.openedAt, cash: this.state.cash });
    this.log('RIGO', 'SETTLE', exitPnl, text);
    this.dirty = true;
  }

  // Manual kill switch, reachable only over POST /api/flatten with FLATTEN_TOKEN. Halting new
  // risk is not the same as being flat: TESS's drawdown halt stops entries while leaving every
  // open position running. This is the button for when you want out of everything, now.
  async flattenAll(reason = 'manual flatten') {
    const open = [...this.state.positions];
    this.operatorHalt = `flattened by operator (${reason}) \u2014 POST /api/resume to re-enable`;
    this.save();   // a kill switch that waits for the next 10s save is not a kill switch
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
      // Every cycle now, not every fourth. The deterministic half is cheap, and the Claude
      // half is fired rather than awaited, so cadence here costs nothing but a `due` check.
      agents.ILSA(this);
      agents.TESS(this);
      await agents.RIGO(this);
      agents.BRAM(this);
      // Strictly after BRAM, which assigns this.signals wholesale, and strictly before
      // KETT, which spends against it. See agents.mergeBrainSignals.
      agents.mergeBrainSignals(this);
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
    const pnl = this.pnlScorecard();
    const arbGroups = this.arbScorecard();
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
      initial: s.initial, cash: s.cash, equity, deployed, unrealized, realized: s.stats.realized, fees: s.stats.fees, pnl,
      wins: s.stats.wins, losses: s.stats.losses, liveBalance: this.liveBalance,
      positions: s.positions.map((p) => ({ id: p.id, label: p.label, venue: p.venue, side: p.side, qty: p.qty, entry: p.entry, mark: p.mark, cost: p.cost, pnl: r2(p.qty * (p.mark ?? p.entry) - p.cost), strategy: p.strategy, openedAt: p.openedAt })),
      arbGroups,
      closed: s.closed.slice(-80).map((c) => ({ t: c.exitAt, pnl: c.pnl, label: c.label, reason: c.reason, strategy: c.strategy })),
      log: s.log.slice(0, 150),
      balanceHistory: hist,
      // `thinking` is a live state the floor can draw: a desk with a Claude turn open right now.
      // It is deliberately separate from `active`, which means the desk's engine step is current.
      agents: AGENTS.map((a) => ({ ...a, ...this.agentStatus[a.key], active: now - this.agentStatus[a.key].lastActive < 4000, thinking: this.brain.thinking(a.key) })),
      brain: this.brain.snapshot(),
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
        makerMarkets: this.cfg.makerMarkets, makerMinTradesPerDay: this.cfg.makerMinTradesPerDay },
    };
  }
}

module.exports = { Engine, AGENTS };

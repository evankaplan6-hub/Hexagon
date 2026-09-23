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
const { makeVolume } = require('./volume');
const { makeMakerDesk } = require('./makerdesk');
const { makeWhaleWatch } = require('./whales');
const { makeAnyMarket } = require('./anymarket');
const agents = require('./agents');
const { MAX_VENUE_DISAGREE } = require('./matcher');
const { Brain } = require('./brain');
const { Research } = require('./research');
const { Ask } = require('./ask');
const watchdog = require('./watchdog');
const { themeOf, themeMeta, themeRank, tickerOfPairId } = require('./themes');

const WATCHDOG_EVERY_MS = 15000;

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

// The settlement price of a Kalshi market's YES, or null while it is undecided. `result` is the
// normal signal; a determined or finalized market with no yes/no result but a settlement value
// settles at that value.
function ksSettlement(m) {
  if (!m) return null;
  if (m.result === 'yes') return 1;
  if (m.result === 'no') return 0;
  if ((m.status === 'determined' || m.status === 'finalized') && Number.isFinite(m.settlementValue) && m.settlementValue >= 0 && m.settlementValue <= 1) return m.settlementValue;
  return null;
}
// A resolved Polymarket outcome price, accepted only at the three values Polymarket actually
// settles at: 1, 0, or 0.5 for a question resolved 50-50. Anything else is not a settlement this
// code understands, and guessing would book real P&L on a guess.
function pmSettlement(px) {
  const x = Number(px);
  if (!Number.isFinite(x)) return null;
  for (const v of [0, 0.5, 1]) if (Math.abs(x - v) <= 0.001) return v;
  return null;
}

// When this process started. Module scope, so it is fixed at require time and a restart is the
// only thing that can move it.
const BOOTED_AT = Date.now();

class Engine {
  constructor(cfg) {
    this.cfg = cfg;
    this.file = path.join(cfg.dataDir, 'state.json');
    this.state = this.load();
    this.broker = makeBroker(cfg, this);
    this.recordTick = makeRecorder(cfg);
    this.probe = makeProbe(cfg);
    // The chart's volume bars: what the desk traded, by the minute. Every fill passes through the
    // journal, so the counter listens there, and a restart rebuilds it from the journal files.
    this.volume = makeVolume();
    this.volume.load(cfg.dataDir);
    const write = makeJournal(cfg);
    this.journal = (E, kind, payload) => { this.volume.note(kind, payload); write(E, kind, payload); };
    this.beat = { taker: Date.now(), maker: Date.now() };   // when each loop last finished a round
    this.maker = makeMakerDesk(cfg);
    this.whales = cfg.whaleWatch ? makeWhaleWatch(cfg) : null;   // advisory: never trades
    this.any = cfg.anyMarkets ? makeAnyMarket(cfg) : null;       // every category, not just games and the Fed
    // The minds. Constructed even without a key: `enabled()` is false and every desk
    // falls straight through to its deterministic path.
    this.brain = new Brain(cfg);
    this.brainSignals = [];   // mind-originated signals, merged into the book after BRAM
    this.research = new Research(cfg, this);   // operator-requested deep dives on an alert
    this.ask = new Ask(cfg, this);             // the Ask panel: operator questions over read-only tools

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
    // pairId -> last exit time; no re-entry for a while. RESTORED FROM THE LEDGER, because a
    // cooldown that only lives in memory is not a cooldown: the box restarts on every deploy and
    // on every watchdog stall, and until 2026-09-19 each restart re-armed every pair the desk had
    // just closed. Six of the week's twenty-four re-entries inside the window happened that way,
    // and they lost $151 of the convergence book's $622. Entries older than the window are dropped
    // on the way in, so a ledger that sat idle for a day does not come back holding stale bars.
    this.cooldown = new Map(
      Object.entries((this.state && this.state.cooldown) || {})
        .filter(([, at]) => Number.isFinite(at) && Date.now() - at < cfg.reentryCooldownMs),
    );
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
      // The re-entry bars, latched the same way. Pruned on the way out as well as on the way in,
      // so the ledger cannot grow a bar per pair the desk has ever traded.
      this.state.cooldown = Object.fromEntries(
        [...this.cooldown].filter(([, at]) => Number.isFinite(at) && Date.now() - at < this.cfg.reentryCooldownMs),
      );
      fs.writeFileSync(tmp, JSON.stringify(this.state));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
    } catch (e) { console.error('save failed', e.message); }
  }

  // ---------------------------------------------------------------- helpers
  due(name, sec) {
    const now = Date.now();
    // Most names carry a position id (`exit-book-<id>`, `pin-<id>`) and nothing ever took one out, so
    // the map grew by a few keys per position for the life of the process. The longest interval
    // anything asks for is an hour; a name untouched for a day answers "due" either way.
    if (now - (this.timersPrunedAt || 0) >= 3600 * 1000) {
      this.timersPrunedAt = now;
      for (const k of Object.keys(this.timers)) if (now - this.timers[k] >= 86400 * 1000) delete this.timers[k];
    }
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
  // Which market a line is about, if it is about one at all. The desk writes its log in sentences
  // that name a market in its own words, never by id, so this is a scan -- but it happens ONCE,
  // here, when the line is written. Doing it in snapshot() would rescan 150 lines against 300
  // labels every two seconds on a box that is already short of CPU.
  //
  // A line that names nothing gets no theme, and the dashboard's filter never hides one of those:
  // "All clear", "Checked 305 pairs" and every warning the desk raises are about the whole desk.
  lineTheme(text, refs) {
    const t = String(text || '').toLowerCase();
    // WHERE the name is, not just whether it appears. A line about one market opens with it
    // ("Presidential 2028 - A.O.C.: pair watched for 1m...") or hangs it off the "@" the gap
    // notices use ("venue gap 5.7c: Polymarket over Kalshi @ <market>"). A name anywhere else is
    // a mention inside a desk-wide sentence -- HOLT's scan summary ends by naming the newest pair
    // it found -- and attributing the whole line to it would hide that summary from every other
    // theme. Being too strict here costs a line its tag, which shows it everywhere; being too
    // loose hides something the desk meant everyone to read.
    const heads = [t, ...t.split('@ ').slice(1)];
    const refNames = Array.isArray(refs) ? refs.map((r) => String((r && r.label) || '').toLowerCase()) : [];
    // shorter than this is not a name, it is a coincidence waiting to happen
    const named = (label) => {
      const l = String(label || '').toLowerCase();
      return l.length >= 8 && (heads.some((h) => h.startsWith(l)) || refNames.some((r) => r.includes(l)));
    };
    for (const p of this.pairs) if (named(p.label)) return this.themeFor(p);
    const mk = (this.state.maker && this.state.maker.markets) || {};
    for (const ticker of Object.keys(mk)) {
      const m = mk[ticker];
      if (named(m.title) || named(m.sub)) return this.themeFor({ ticker, series: m.series });
    }
    return null;
  }

  // `refs`: the open positions an entry is about, [{ id, g, label }], so the dashboard can name them
  // and open them on a click. A note that names no market ("the gap is unchanged") is unreadable
  // without it.
  log(agent, kind, pnl, text, refs) {
    const entry = { t: Date.now(), agent, kind, pnl: pnl == null ? null : r2(pnl), text };
    if (Array.isArray(refs) && refs.length) entry.refs = refs;
    const theme = this.lineTheme(text, refs);
    if (theme) entry.theme = theme;
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
      // One venue settling before the other is the normal shape outside games: Kalshi settles the
      // Fed minutes after the statement, Polymarket waits hours for UMA. A group whose other leg
      // closed on a resolution is half settled, not broken, and what the open leg will pay is
      // already known: the complement of what the settled leg paid.
      const settledLeg = legs.length === 1 ? this.state.closed.find((c) => c.group === id && c.strategy === 'arb' && /^resolved/.test(String(c.reason || '')) && c.venue !== legs[0].venue && c.side !== legs[0].side) : null;
      // ...but "already known" holds only if the settled leg settled the OUTCOME, at 0 or 1. A leg
      // that paid something in between did not answer the question, it cashed out of it, and the
      // open leg is then naked on an outcome still to come. Kalshi's game rules do exactly this: a
      // game "not started within 48 hours" of its scheduled time resolves "to a fair price", while
      // Polymarket keeps its market open until the game is actually played and pays 0 or 1 then.
      // So a postponed game leaves a settled Kalshi leg at, say, 55c against a Polymarket leg that
      // is still a coin flip -- and the complement rule below would book that as a tidy locked
      // profit. Game pairs come from the fast path (src/matcher.js), which runs no rules check at
      // all, so this scorecard is the only place the mismatch can be caught.
      const terminal = (x) => Number.isFinite(x) && (x <= 0.001 || x >= 0.999);
      if (settledLeg) integrity = terminal(settledLeg.exit) ? 'half_settled' : 'settled_midprice';
      else if (legs.length !== 2) integrity = legs.length < 2 ? 'orphan_leg' : 'too_many_legs';
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
      // `settled_midprice` deliberately falls through to null: with no vouchable settlement figure
      // the group enters the totals at its liquidation value (pnlScorecard's arbUnvouched), which
      // is what it is demonstrably worth rather than what a broken hedge would have paid.
      const settlementValue = integrity === 'valid' ? qty
        : integrity === 'half_settled' && Number.isFinite(settledLeg.exit) ? r2(qty * (1 - settledLeg.exit)) : null;
      groups.push({
        id, label: legs[0] && legs[0].label, pairId: legs[0] && legs[0].pairId, theme: this.themeFor(legs[0] || {}),
        // when the pair resolves, where the desk knows: the dashboard says what settles next
        settlesAt: legs.map((p) => p.settlesAt).find(Number.isFinite) ?? null,
        qty, legs: legs.length, integrity, venueGap, entryCost, liquidationValue,
        liquidationPnl: r2(liquidationValue - entryCost),
        settlementValue, lockedPnl: settlementValue == null ? null : r2(settlementValue - entryCost),
      });
    }
    return groups;
  }
  // `groups` and `maker` may be passed in by a caller that has just computed them (snapshot does,
  // every two seconds); left out, they are computed here.
  pnlScorecard(groups = this.arbScorecard(), maker = (this.maker && this.maker.snapshot ? this.maker.snapshot(this) : {})) {
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
    const makerNet = Number.isFinite(maker.equity) && Number.isFinite(maker.initial) ? r2(maker.equity - maker.initial) : null;
    return {
      realized: this.state.stats.realized, convergenceUnrealized, arbLocked, arbUnvouched, arbLiquidation, makerNet,
      totalLiquidation: r2(this.state.stats.realized + arbLiquidation + convergenceUnrealized),
      totalAtSettlement: r2(this.state.stats.realized + arbLocked + arbUnvouched + convergenceUnrealized),
      integrityAlerts: groups.filter((g) => g.integrity !== 'valid' && g.integrity !== 'half_settled').length,
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
    record.status = score.integrity === 'valid' || score.integrity === 'half_settled' ? 'filled' : 'alert';
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
      // this Polymarket market's own taker fee rate; decide.pmRate falls back when it is unknown
      pmFeeRate: Number.isFinite(m.feeRate) ? m.feeRate : this.cfg.pmFeeFallback,
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
  // The ladder a sale of this leg would walk: the OTHER side's asks, which are this side's bids
  // mirrored (buy NO at p == sell YES at 1-p; engine.book). Null when there is nothing to fetch it
  // against -- a market the desk has no listing for, a demo pair with no quote, a fetch that
  // failed -- and the sale then fills at the mark in full, as every sale did before. The paper
  // broker used to do that for every exit, which is unlimited depth at the bid; buys have always
  // walked the fetched book (KETT), and the two halves of a round trip should be equally honest.
  async exitLadder(pos) {
    const listed = pos.venue === 'KS' ? this.quotes.ks.has(pos.ref) : this.quotes.pm.has(pos.pmId);
    if (!listed) return null;
    const pair = this.pairs.find((p) => p.id === pos.pairId) || { pm: { id: pos.pmId, tokenIndex: pos.tokenIndex }, ks: { ticker: pos.ref }, q: null };
    if (this.cfg.demo && !pair.q) return null;
    try {
      const b = await this.book(pos.venue, pair, pos.side === 'yes' ? 'no' : 'yes');
      return Array.isArray(b && b.asks) ? b.asks : null;
    } catch (e) {
      if (this.due(`exit-book-${pos.id}`, 300)) this.log('RIGO', 'OPS', null, `${pos.label}: could not read the book to sell into (${String(e.message).slice(0, 60)}) · filling at the mark`);
      return null;
    }
  }

  // Is this position's market taking orders? Why not, in words, or null when it is (or when the
  // desk has no listing to say). Kalshi halts a market it is about to settle ("inactive": a
  // cancelled Davis Cup match, 2026-09-21), and Polymarket closes one awaiting resolution. A sell
  // then cannot fill on either venue -- but PaperBroker.sell does no I/O and fills whatever it is
  // asked, so the paper ledger would have booked a sale that no exchange could have made.
  marketHalted(pos) {
    const m = pos.venue === 'KS' ? this.quotes.ks.get(pos.ref) : this.quotes.pm.get(pos.pmId);
    if (!m) return null;
    if (pos.venue === 'KS') return m.status && m.status !== 'active' ? `Kalshi market is ${m.status}` : null;
    if (m.closed) return 'Polymarket market is closed';
    return m.accepting === false ? 'Polymarket market is not accepting orders' : null;
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

  // Has the market behind a position resolved? Returns { resolved, yesPx }: the settlement price of
  // the PAIR's YES outcome, which RIGO turns into this leg's price. A price rather than a winner,
  // because not every market settles at 0 or 1. Polymarket resolves an ambiguous or cancelled
  // question 50-50, and the old `prices[tokenIndex] > 0.5` booked that YES leg at $0 and its NO leg
  // at $1. Kalshi can settle at a settlement value that is not a clean yes/no.
  //
  // Checked when the market has left the open listing (a finished game drops out of it), and also
  // when it is still listed but its Kalshi close time has passed or it is no longer active -- a
  // closed market that lingers in a listing would otherwise never be asked.
  async resolution(pos) {
    const listed = pos.venue === 'KS' ? this.quotes.ks.get(pos.ref) : this.quotes.pm.get(pos.pmId);
    if (listed) {
      const closeMs = pos.venue === 'KS' ? Date.parse(listed.closeTime || '') : NaN;
      const inactive = pos.venue === 'KS' ? (listed.status && listed.status !== 'active') : (listed.closed || listed.accepting === false);
      if (!inactive && !(Number.isFinite(closeMs) && Date.now() >= closeMs)) return null;
    }
    const last = this.resolutionChecks.get(pos.id) || 0;
    if (Date.now() - last < 60000) return null;
    this.resolutionChecks.set(pos.id, Date.now());
    if (pos.venue === 'KS') {
      const m = await ks.fetchMarket(pos.ref);
      const yesPx = ksSettlement(m);
      if (yesPx != null) return { resolved: true, yesPx };
      // Kalshi reports an open market as 'active', never 'open': this re-pin compared against
      // 'open' and so never ran
      if (m && m.status === 'active' && !listed) this.quotes.ks.set(m.ticker, m); // just fell out of the top listing
      return null;
    }
    const m = await pm.fetchMarket(pos.pmId);
    if (m && m.closed && m.resolved && m.prices.length > pos.tokenIndex) {
      const yesPx = pmSettlement(m.prices[pos.tokenIndex]);
      if (yesPx != null) return { resolved: true, yesPx };
      if (this.due(`odd-settle-${pos.id}`, 3600)) this.log('RIGO', 'HALT', null, `${pos.label}: Polymarket resolved at ${m.prices[pos.tokenIndex]}, not 0, 0.5 or 1 · not settling it automatically, needs a person`);
      return null;
    }
    if (m && !m.closed && !listed) this.quotes.pm.set(m.id, m);
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
      // Carried on the position, not only the pair: the pair is what disappears when a Kalshi
      // market closes, and both the close-guard exit and the Polymarket exit fee still need these.
      closesAt: Number.isFinite(signal.pair.closesAt) ? signal.pair.closesAt : null,
      settlesAt: Number.isFinite(signal.pair.settlesAt) ? signal.pair.settlesAt : null,
    };
    if (leg.venue === 'PM') pos.feeRate = signal.pair.q && Number.isFinite(signal.pair.q.pmFeeRate) ? signal.pair.q.pmFeeRate : this.cfg.pmFeeFallback;
    this.state.cash = r2(this.state.cash - fill.cost);
    this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
    this.state.positions.push(pos);
    this.journal(this, 'OPEN', { id: pos.id, group, pairId: pos.pairId, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, entry: pos.entry, fee: pos.fee, cost: pos.cost, strategy: pos.strategy, entryGap: pos.entryGap, ref: pos.ref, orderId: pos.orderId, cash: this.state.cash });
    this.dirty = true;
    return pos;
  }

  // `pos.exitSeq++` and the broker round trip below both happen BEFORE the ownership check further
  // down, so two concurrent entrants -- two POSTs to /api/flatten, or a flatten landing inside
  // RIGO's await -- each minted a DIFFERENT idempotency key and sent a separate real sell for the
  // same contracts. Kalshi cannot dedupe two different client_order_ids. Paper hides it entirely:
  // PaperBroker.sell does no I/O, so the loop drains before anything can interleave.
  async close(pos, px, reason, resolved = false, qty = pos.qty) {
    // An uncertain sell may have filled at the exchange. Do not turn its next scheduled RIGO pass
    // into a new client-order ID and a possible oversell; reconciliation owns this position now.
    if (pos.pendingExit) {
      if (this.due(`exit-pending-${pos.id}`, 300)) this.log('RIGO', 'HALT', null, `${pos.label}: exit ${pos.pendingExit.clientOrderId || 'order'} is awaiting reconciliation · not retrying`);
      return;
    }
    if (this.closing.has(pos.id)) return;
    this.closing.add(pos.id);
    try { return await this._close(pos, px, reason, resolved, Math.max(1, Math.min(pos.qty, Math.floor(qty)))); }
    finally { this.closing.delete(pos.id); }
  }

  async _close(pos, px, reason, resolved = false, qty = pos.qty) {
    let fill;
    if (resolved) fill = { filled: qty, avg: px, fee: 0, proceeds: r2(qty * px) };
    else {
      // No order goes to a market that is not taking them: it could not fill on a real venue, and
      // the paper broker would fill it anyway. The position waits for settlement (engine.resolution
      // is already asking after it), and the caller is told why nothing was sold.
      const halted = this.marketHalted(pos);
      if (halted) {
        if (this.due(`exit-halted-${pos.id}`, 300)) this.log('RIGO', 'PASS', null, `${pos.label}: ${halted} · no sale possible, waiting for settlement`);
        return { sold: false, why: `${halted}: no sale possible until it settles` };
      }
      // What is actually bid where this leg would sell (exitLadder), so the paper fill is the size
      // the book had rather than the size the desk wanted: a partial is then a partial, stuck and
      // retried, not a full exit at a price nobody was bidding for that many.
      const book = await this.exitLadder(pos);
      // A position whose exit does not fill is STUCK, not closed. Flag it so RIGO keeps trying
      // every cycle instead of leaving naked directional risk sitting in the book unattended.
      pos.exitSeq = (pos.exitSeq || 0) + 1;
      try { fill = await this.broker.sell({ venue: pos.venue, ref: pos.ref, side: pos.side, qty, px, feeRate: pos.feeRate, book, key: `${pos.id}-out-${pos.exitSeq}` }); }
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
    //
    // ...but only a fill short of what was ASKED for is stuck. The gain lock (decide.gainLockIntent)
    // asks for part of a position on purpose, to keep the rest as a runner; measured against
    // `pos.qty` that sale read as a stuck exit, and RIGO's orphan branch sold the runner at mark on
    // the very next cycle -- the feature never once kept a runner.
    if (fill.filled < pos.qty) {
      const sold = fill.filled;
      const stuck = sold < qty;
      const costShare = r2(pos.cost * (sold / pos.qty));
      const pnl = r2(fill.proceeds - costShare);
      const before = pos.qty;
      pos.qty -= sold;
      pos.cost = r2(pos.cost - costShare);
      if (stuck) pos.orphan = true;                        // RIGO retries the remainder every cycle
      pos.partialPnl = r2((pos.partialPnl || 0) + pnl);     // carried into the group score on final close
      this.state.cash = r2(this.state.cash + fill.proceeds);
      this.state.stats.fees = r2(this.state.stats.fees + fill.fee);
      this.state.stats.realized = r2(this.state.stats.realized + pnl);
      this.journal(this, 'CLOSE_PARTIAL', { id: pos.id, group: pos.group, label: pos.label, venue: pos.venue, side: pos.side, sold, remaining: pos.qty, stuck, entry: pos.entry, exit: fill.avg, fee: fill.fee, proceeds: fill.proceeds, pnl, reason, attempt: pos.exitSeq, cash: this.state.cash });
      this.log('RIGO', 'SETTLE', pnl, `${pos.label} \u00b7 sold ${sold} of ${before} ${pos.side.toUpperCase()} @ ${pos.venue === 'PM' ? 'Polymarket' : 'Kalshi'} ${fill.avg.toFixed(3)} \u00b7 ${pos.qty} ${stuck ? 'left unsold, flagged stuck and retried' : 'kept'} \u00b7 ${reason}`);
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
    this.journal(this, resolved ? 'SETTLE' : 'CLOSE', { id: pos.id, group: pos.group, pairId: pos.pairId, label: pos.label, venue: pos.venue, side: pos.side, qty: pos.qty, entry: pos.entry, exit: fill.avg, fee: fill.fee, proceeds: fill.proceeds, pnl: exitPnl, legPnl: pnl, partialPnl, reason, strategy: pos.strategy, heldMs: Date.now() - pos.openedAt, cash: this.state.cash });
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

  // Sell every open leg of one group at its own venue's bid -- the operator's "sell now" on an
  // alert. Same close() path RIGO and flatten use, so a failed or partial exit is flagged stuck and
  // retried exactly as it would be for them. Does NOT halt the desk; that is flattenAll's job.
  async sellGroup(groupId, reason = 'operator sell') {
    const legs = this.state.positions.filter((p) => p.group === groupId);
    if (!legs.length) return { ok: false, error: 'nothing open in that group' };
    this.journal(this, 'OPERATOR_SELL', { group: groupId, label: legs[0].label, legs: legs.length, reason });
    this.log('TESS', 'OPS', null, `operator sell requested \u00b7 ${legs[0].label} \u00b7 ${legs.length} leg${legs.length === 1 ? '' : 's'}`);
    const whys = [];
    for (const pos of legs) {
      const px = this.venueMark(pos) ?? pos.mark ?? pos.entry;
      const r = await this.close(pos, px, `operator: ${reason}`).catch(() => null);
      if (r && r.why) whys.push(r.why);
    }
    const left = this.state.positions.filter((p) => p.group === groupId).length;
    this.save();
    // `error` says why a leg could not be sold at all, so the page does not promise a retry that
    // no exchange will honour
    return { ok: left === 0, sold: legs.length - left, remaining: left, ...(whys.length ? { error: whys[0] } : {}) };
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
    // Both venues' fast listings are re-read every PM_LIST_EVERY_SEC / KS_LIST_EVERY_SEC, not every
    // cycle (src/config.js says why). In between, each map is rebuilt from its last listing -- the
    // same objects, so pinned and injected markets are re-added exactly as before -- and
    // refreshPairPrices reprices the markets the desk is actually pricing: Polymarket's from the
    // CLOB, Kalshi's by ticker. A failed listing is retried on the next cycle.
    const now = Date.now();
    const due = (list, sec) => !list || now - list.at >= sec * 1000;
    const pmDue = due(this.pmList, this.cfg.pmListEverySec), ksDue = due(this.ksList, this.cfg.ksListEverySec);
    const [pmRes, ksRes] = await Promise.allSettled([
      pmDue ? pm.fetchUniverse(this.cfg.pmUniverse) : null,
      ksDue ? ks.fetchAll(this.cfg.ksSeries) : null,
    ]);
    // Stamp each market with when IT was fetched. lastQuoteAt only advances when BOTH venues
    // succeed, so it cannot tell "everything is fresh" from "this one market stopped updating" \u2014
    // and quote() carries a pair's last good quote forward indefinitely when it cannot reprice.
    // A reused listing keeps its own `at`: only a price that actually arrived moves it.
    const at = Date.now();
    const pmOk = !pmDue || pmRes.status === 'fulfilled', ksOk = !ksDue || ksRes.status === 'fulfilled';
    if (pmDue && pmRes.status === 'fulfilled') this.pmList = { at, markets: pmRes.value.map((m) => Object.assign(m, { at })) };
    if (ksDue && ksRes.status === 'fulfilled') {
      const markets = ksRes.value.map((m) => Object.assign(m, { at }));
      this.ksList = { at, markets, tickers: new Set(markets.map((m) => m.ticker)) };
    }
    if (pmOk && this.pmList) this.quotes.pm = new Map(this.pmList.markets.map((m) => [m.id, m]));
    if (ksOk && this.ksList) this.quotes.ks = new Map(this.ksList.markets.map((m) => [m.ticker, m]));
    if (pmOk && ksOk) this.lastQuoteAt = Date.now();
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
        // Settled: leave it out of the map so resolution() runs. Kalshi reports a decided market as
        // 'determined' or 'finalized', never 'closed' -- checking only 'closed' re-pinned the tied
        // Tottenham v Everton leg at a 0c bid on 2026-09-12, and since resolution() only looks at
        // markets missing from the map, the position could never settle. A result is the real signal.
        if (!m || m.closed || m.status === 'closed' || m.result === 'yes' || m.result === 'no') continue;
        m.at = Date.now();
        this.pinned.set(pos.id, m);
        map.set(key, m);
      } catch { /* never block the cycle; resolution() is the backstop */ }
    }
    for (const id of [...this.pinned.keys()]) if (!this.state.positions.some((p) => p.id === id)) this.pinned.delete(id);
  }

  // The Gamma listing can lag the CLOB by minutes, and is only re-read every PM_LIST_EVERY_SEC;
  // overwrite pair quotes with live CLOB top-of-book, and stamp the market with when that price
  // arrived. A market the CLOB did not answer for keeps its old stamp and goes stale on its own.
  async refreshPairPrices() {
    await Promise.all([this.refreshPmPairPrices(), this.refreshKsPairPrices()]);
  }
  async refreshPmPairPrices() {
    const toks = [...new Set(this.pairs.map((p) => p.pm.tokenId).filter(Boolean))];
    if (!toks.length) return;
    let prices;
    try { prices = await pm.fetchPrices(toks); }
    catch (e) { if (this.due('clob-err', 120)) this.log('TESS', 'OPS', null, `CLOB price refresh failed: ${String(e.message).slice(0, 100)} · falling back to listing quotes`); return; }
    const at = Date.now();
    for (const p of this.pairs) {
      const live = prices.get(p.pm.tokenId), m = this.quotes.pm.get(p.pm.id);
      if (!live || !m) continue;
      if (p.pm.tokenIndex === 0) { m.bestBid = live.bid; m.bestAsk = live.ask; }
      else { m.bestBid = 1 - live.ask; m.bestAsk = 1 - live.bid; }
      m.at = at;
    }
  }
  // The Kalshi half. The fast listing (every open market in KS_SERIES) is only re-read every
  // KS_LIST_EVERY_SEC, so the markets from it that the desk is actually pricing -- the fast path's
  // pairs and its open Kalshi legs -- are repriced every cycle by ticker, one call per 200. The
  // any-market pairs are not in that listing and keep their own reprice (ANY_REFRESH_SEC). A market
  // no longer active, or with no two-sided book, leaves the map at once, as it used to by dropping
  // out of the next listing, so resolution() takes over a leg held on it. A market the call did not
  // answer for keeps its old stamp and goes stale on its own.
  async refreshKsPairPrices() {
    const listed = this.ksList && this.ksList.tickers;
    if (!listed) return;
    const want = new Set();
    for (const p of this.pairs) if (listed.has(p.ks.ticker)) want.add(p.ks.ticker);
    for (const pos of this.state.positions) if (pos.venue === 'KS' && listed.has(pos.ref)) want.add(pos.ref);
    if (!want.size) return;
    let fresh;
    try { fresh = await ks.fetchMarketsByTickers([...want]); }
    catch (e) { if (this.due('ks-reprice-err', 120)) this.log('TESS', 'OPS', null, `Kalshi price refresh failed: ${String(e.message).slice(0, 100)} \u00b7 those pairs go stale until it recovers`); return; }
    const at = Date.now(), gone = [];
    for (const f of fresh) {
      const m = want.has(f.ticker) && this.quotes.ks.get(f.ticker);
      if (!m) continue;
      if (f.status !== 'active' || f.yesBid == null || f.yesAsk == null || !(f.yesAsk >= f.yesBid)) { gone.push(f.ticker); continue; }
      Object.assign(m, f, { at });
    }
    if (!gone.length) return;
    for (const t of gone) { this.quotes.ks.delete(t); listed.delete(t); }
    this.ksList.markets = this.ksList.markets.filter((m) => listed.has(m.ticker));
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
    // Kalshi's REST calls take turns from here on (src/http.js). Not in the constructor: tests
    // build engines, and nothing that never starts should be paced.
    http.paceHost(ks.BASE, this.cfg.kalshiGapMs);
    // First of all, so that a startup which never finishes is caught too: the watchdog needs nothing
    // the rest of start() builds.
    if (this.cfg.watchdogSec > 0) {
      this.beat.taker = this.beat.maker = this.wdLast = Date.now();
      setInterval(() => this.watchdogCheck(), WATCHDOG_EVERY_MS);
    }
    // per-series taker multipliers before anything prices: MLB bills at half, fourteen series at
    // zero, and a flat rate made the desk decline trades that were cheaper than it believed. One
    // call covers every series on the exchange; the per-series loop is the fallback if it fails.
    const loadSeries = async (first) => {
      try { await ks.loadSeriesIndex(); }
      catch (e) {
        if (first) await ks.loadFeeMultipliers(this.cfg.ksSeries).catch(() => {});
        this.log('TESS', 'OPS', null, `Kalshi series list failed to load (${String(e.message).slice(0, 80)}) · ${first ? 'fee multipliers loaded per series instead' : 'keeping the last good list'}`);
      }
    };
    await loadSeries(true);
    // Kalshi adds series and can change a fee schedule; a box that runs for weeks re-reads it daily.
    setInterval(() => { loadSeries(false); }, 24 * 3600 * 1000);
    if (this.cfg.mode === 'live') await this.broker.init();
    this.log('TESS', 'OPS', null, `desk online · ${this.cfg.mode.toUpperCase()} mode${this.cfg.demo ? ' with DEMO quote noise' : ''} · equity $${this.equity().toFixed(2)} · ${this.cfg.ksSeries.length} Kalshi series vs top ${this.cfg.pmUniverse} Polymarket markets`);
    await this.step();
    setInterval(() => this.step().catch((e) => console.error(e)), this.cfg.priceEvery * 1000);
    // The maker gets its own loop. Riding the taker's 15s cycle every other tick meant a 30-second
    // stale quote, which cost more than everything else on this desk combined.
    setInterval(() => this.makerRound(), this.cfg.makerEverySec * 1000);
    // Whale watch on its own timer too: a slow trade feed must never hold up pricing. step() guards
    // itself against overlapping and never throws.
    if (this.whales) setInterval(() => this.whales.step(this), this.cfg.whaleEverySec * 1000);
    // The any-market crawl runs on its own timer too; only the repricing of matched pairs is in the cycle.
    if (this.any) this.any.start(this);
    setInterval(() => { if (this.dirty) this.save(); }, 10000);
  }
  // One maker round. `makerRunning` is the guard: a slow round must never start a second one on
  // top of itself -- which is also why one round that never returns silences the maker for good,
  // and why the watchdog below watches the beat this leaves behind.
  async makerRound() {
    if (this.makerRunning) return;
    this.makerRunning = true;
    const t0 = Date.now();
    try { await this.maker.step(this); }
    catch (e) { this.log('MAKR', 'OPS', null, `maker cycle error: ${String(e.message).slice(0, 110)}`); }
    finally {
      this.makerRunning = false;
      this.beat.maker = Date.now();
      this.lastMakerMs = this.beat.maker - t0;
      // The first round after a start has to wait for the full universe scan (~20s) before
      // there is anything to quote. That is expected, and warning about it made every deploy
      // look like a latency problem.
      const scanned = this.maker.blockedOnScan ? this.maker.blockedOnScan() : false;
      if (!scanned && this.lastMakerMs > this.cfg.makerEverySec * 1000 && this.due('makr-slow', 300)) {
        this.log('MAKR', 'OPS', null, `requote took ${(this.lastMakerMs / 1000).toFixed(1)}s, longer than the ${this.cfg.makerEverySec}s target · quotes are going stale`);
      }
    }
  }
  // The stall watchdog (src/watchdog.js, config.watchdogSec). Called every WATCHDOG_EVERY_MS.
  // Returns the stalled loops, or null. On a stall it says what was waiting on the network -- that
  // is the evidence for what froze -- then saves and asks the host for a restart. `now` is
  // injectable for the tests.
  watchdogCheck(now = Date.now()) {
    const limitMs = this.cfg.watchdogSec * 1000;
    if (!(limitMs > 0)) return null;
    const asleep = watchdog.wasSuspended({ now, last: this.wdLast, everyMs: WATCHDOG_EVERY_MS });
    this.wdLast = now;
    if (asleep) { this.beat.taker = this.beat.maker = now; return null; }
    const stalled = watchdog.stalledLoops({ now, limitMs, beats: this.beat });
    if (!stalled.length) return null;
    const live = this.cfg.mode === 'live';
    if (live && !this.due('watchdog-live', 600)) return stalled;
    const held = http.inflight(now);
    const queued = http.queued();
    const idle = stalled.map((s) => `${s.loop} ${Math.round(s.idleMs / 1000)}s`).join(', ');
    this.log('TESS', 'OPS', null, `WATCHDOG: no finished round in ${idle} (limit ${this.cfg.watchdogSec}s) · ${held.length} calls in flight, ${queued} queued for Kalshi · ${live ? 'live mode, not restarting' : 'saving and restarting'}`);
    this.journal(this, 'WATCHDOG', { stalled, taking: !!this.stepping, making: !!this.makerRunning, inflight: held, queued, restarting: !live });
    if (!live) { this.save(); this.exit(1); }
    return stalled;
  }
  // Exit code 1 so Fly's restart policy (fly.toml [[restart]] "always") brings the desk back. The
  // delay lets the log line and the journal write reach the disk and the pipe first.
  exit(code) { setTimeout(() => process.exit(code), 250); }
  async step() {
    if (this.stepping) return;
    this.stepping = true;
    const t0 = Date.now();
    try {
      this.cycle++;
      await this.refreshQuotes();
      if (this.any) {
        // the matched any-market pairs, repriced in a few batched calls and put back into the maps
        // the fast listing just replaced; a failed reprice leaves them stale, never the cycle broken
        await this.any.refresh(this).catch((e) => { if (this.due('any-refresh-err', 300)) this.log('TESS', 'OPS', null, `any-market reprice error: ${String(e.message).slice(0, 100)}`); });
        this.any.inject(this);
      }
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
      if (this.any) this.any.afterPricing(this);   // ask the rules judge about watch-only pairs showing an edge
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
      this.beat.taker = Date.now();
      this.lastCycleMs = this.beat.taker - t0;
      // A cycle that outruns its own interval means the next tick is silently dropped by the
      // `stepping` guard. That used to happen invisibly; say so.
      if (this.lastCycleMs > this.cfg.priceEvery * 1000 && this.due('slow-cycle', 300)) {
        this.log('TESS', 'OPS', null, `cycle took ${(this.lastCycleMs / 1000).toFixed(1)}s, longer than the ${this.cfg.priceEvery}s interval \u00b7 ticks are being skipped`);
      }
      this.stepping = false;
    }
  }

  // What a market is ABOUT, in one word -- MLB, UFC, Elections, Weather (src/themes.js). The page's
  // theme buttons are built out of this, so everything the page can filter carries one.
  //
  // The record itself often cannot answer. A pair from the any-market crawl has Kalshi's category,
  // but a game pair from the fast path (src/matcher.js) has none, a maker market carries only its
  // series, and a position carries only its pair id. All three do have a Kalshi ticker, so the
  // exchange's own series index -- loaded at boot and re-read daily -- supplies the category. When
  // it has not loaded, every ticker rule still decides on its own; only the category rules go quiet.
  themeFor(m) {
    const ticker = m.ticker || tickerOfPairId(m.pairId || m.id || '');
    const series = m.series || (ticker ? ks.seriesFor(ticker) : '');
    const category = m.category || (series ? (ks.seriesInfo.get(series) || {}).category : null);
    return themeOf({ series, ticker, category });
  }

  // ---------------------------------------------------------------- snapshot for the UI
  snapshot() {
    const now = Date.now();
    const s = this.state;
    const equity = this.equity();
    // each computed once: the scorecard, the maker's book and the P&L that reads both
    const arbGroups = this.arbScorecard();
    const maker = this.maker.snapshot(this);
    const pnl = this.pnlScorecard(arbGroups, maker);
    const unrealized = r2(s.positions.reduce((a, p) => a + (p.qty * (p.mark ?? p.entry) - p.cost), 0));
    const deployed = r2(s.positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0));
    let hist = s.balanceHistory;
    if (hist.length > 600) { const k = Math.ceil(hist.length / 600); hist = hist.filter((_, i) => i % k === 0 || i === hist.length - 1); }
    const pairs = this.pairs.filter((p) => p.q).map((p) => ({
      id: p.id, label: p.label, kind: p.kind, series: p.series, category: p.category || null, theme: this.themeFor(p), inPlay: !!p.inPlay, startsAt: p.startsAt || null,
      closesAt: p.closesAt || null, watchOnly: p.watchOnly || null,
      pmMid: r3(p.q.pmMid), ksMid: r3(p.q.ksMid), gap: r3(p.q.ksMid - p.q.pmMid),
      age: p.q.t ? Math.round((now - p.q.t) / 1000) : null,
      pmVol: Math.round(p.q.pmVol), ksVol: Math.round(p.q.ksVol), pmUrl: p.pm.url, ksUrl: p.ks.url,
      bias: this.bias.get(p.id) ? r2(this.bias.get(p.id).score) : null,
      hist: (this.history.get(p.id) || []).slice(-60).map((h) => [r3(h.pmMid), r3(h.ksMid)]),
    })).sort((a, b) => (a.inPlay - b.inPlay) || Math.abs(b.gap) - Math.abs(a.gap));
    const top = (list, key) => list.sort((a, b) => b.vol24 - a.vol24).slice(0, 8);
    // The maker has its own recent-fill ring. The taker ledger stores positions and closed legs
    // instead, so expose their entries and exits in one small structured feed for the dashboard.
    // Otherwise the board labelled "Fills" contradicts a taker close directly below it in the log.
    const takerFills = [];
    for (const p of [...s.positions, ...s.closed.slice(-80)]) {
      const theme = this.themeFor(p);
      if (Number.isFinite(p.openedAt)) takerFills.push({
        id: `${p.id}:open`, at: p.openedAt, action: 'Opened', label: p.label, theme,
        qty: p.qty, px: p.entry, venue: p.venue, contractSide: p.side, pnl: null,
      });
      if (Number.isFinite(p.exitAt)) takerFills.push({
        id: `${p.id}:close`, at: p.exitAt, action: /^resolved/.test(String(p.reason || '')) ? 'Settled' : 'Closed', label: p.label, theme,
        qty: p.qty, px: p.exit, venue: p.venue, contractSide: p.side, pnl: Number.isFinite(p.exitPnl) ? p.exitPnl : p.pnl,
      });
    }
    takerFills.sort((a, b) => b.at - a.at);
    // The maker's own book and fill ring, themed the same way. Its markets carry a series and no
    // category, which is exactly the case themeFor's series-index lookup exists for.
    maker.markets = (maker.markets || []).map((m) => ({ ...m, theme: this.themeFor(m) }));
    maker.recent = (maker.recent || []).map((f) => ({ ...f, theme: this.themeFor(f) }));
    // The theme bar the dashboard draws. Counted over EVERY pair, not the forty widest gaps sent
    // above: the whole point of a theme button is to reach the markets that cut leaves out, and a
    // bar built from the forty would report "MLB 1" on a fourteen-game Sunday.
    const themeRows = new Map();
    const themeRow = (k) => {
      let r = themeRows.get(k);
      if (!r) themeRows.set(k, r = { key: k, name: themeMeta(k).name, glyph: themeMeta(k).glyph, n: 0, watching: 0, making: 0, tradeable: 0, priced: 0, held: 0, quoting: 0, best: null });
      return r;
    };
    // Per theme: how many of its pairs have a price on both venues, and the one standing widest
    // apart. The status board needs both to say why a subject is not being traded, and it cannot
    // work them out for itself -- `pairs` above is the forty widest on the WHOLE board, and on a
    // quiet subject that cut is empty. A pair the desk could act on always wins over a wider one
    // it may not (a watch-only pair's two venues' rules are unverified, src/rules.js), so the
    // notice can tell "nothing is near the bar" from "everything here is unverified".
    const pairScore = (p, gap) => (p.watchOnly ? 0 : 1e6) + Math.abs(gap);
    for (const p of this.pairs) {
      const r = themeRow(this.themeFor(p));
      r.watching++; r.n++;
      if (!p.watchOnly) r.tradeable++;
      const gap = p.q ? p.q.ksMid - p.q.pmMid : null;
      if (!Number.isFinite(gap)) continue;
      r.priced++;
      if (!r.best || pairScore(p, gap) > r.best.score) r.best = { score: pairScore(p, gap), gap: r3(gap), tradeable: !p.watchOnly, label: String(p.label || '').slice(0, 90) };
    }
    // Held is per POSITION GROUP, not per leg: a cross-venue arb is one position held in two
    // places, and counting its legs would say the desk holds twice what it does.
    for (const g of new Map(s.positions.map((p) => [p.group || p.id, p])).values()) themeRow(this.themeFor(g)).held++;
    // The maker's own book is the other half of what the desk looks at, and it is Kalshi-only, so
    // it is counted alongside the cross-venue pairs rather than inside them. `n` is what the
    // dashboard's theme button shows, and it has to be everything that button then opens.
    for (const m of maker.markets) { const r = themeRow(m.theme); r.n++; r.making++; if (m.inv) r.held++; if (m.quoting) r.quoting++; }
    const themes = [...themeRows.values()]
      .sort((a, b) => b.n - a.n || b.held - a.held || themeRank(a.key) - themeRank(b.key))
      // `score` is only how the widest pair was picked; the page reads the gap and the label
      .map((r) => ({ ...r, best: r.best ? { gap: r.best.gap, tradeable: r.best.tradeable, label: r.best.label } : null }));
    return {
      now, name: 'The Hexagon', mode: this.cfg.mode, demo: this.cfg.demo, startedAt: s.startedAt, halt: this.halt,
      // What this process was built from, and when it started. `bootedAt` is deliberately not
      // `startedAt`: that one is the ACCOUNT's age and survives every restart, so it cannot answer
      // "did the box actually pick up that deploy?" -- which is the question this pair exists for.
      build: { sha: this.cfg.buildSha || null, bootedAt: BOOTED_AT },
      initial: s.initial, cash: s.cash, equity, deployed, unrealized, realized: s.stats.realized, fees: s.stats.fees, pnl,
      wins: s.stats.wins, losses: s.stats.losses, liveBalance: this.liveBalance,
      // `sellPx` is what sellGroup would ask for this leg right now, so the confirm box can say it
      positions: s.positions.map((p) => ({ id: p.id, group: p.group, label: p.label, theme: this.themeFor(p), venue: p.venue, side: p.side, qty: p.qty, entry: p.entry, mark: p.mark, cost: p.cost, pnl: r2(p.qty * (p.mark ?? p.entry) - p.cost), sellPx: this.venueMark(p) ?? p.mark ?? p.entry, strategy: p.strategy, openedAt: p.openedAt, settlesAt: Number.isFinite(p.settlesAt) ? p.settlesAt : null })),
      arbGroups,
      closed: s.closed.slice(-80).map((c) => ({ t: c.exitAt, pnl: c.pnl, label: c.label, reason: c.reason, strategy: c.strategy })),
      takerFills: takerFills.slice(0, 120),
      log: s.log.slice(0, 150),
      balanceHistory: hist,
      // `thinking` is a live state the floor can draw: a desk with a Claude turn open right now.
      // It is deliberately separate from `active`, which means the desk's engine step is current.
      agents: AGENTS.map((a) => ({ ...a, ...this.agentStatus[a.key], active: now - this.agentStatus[a.key].lastActive < 4000, thinking: this.brain.thinking(a.key) })),
      brain: this.brain.snapshot(),
      research: this.research.snapshot(),
      ask: this.ask.snapshot(),
      pairs: pairs.slice(0, 40),
      pairCount: this.pairs.length,
      cycleMs: this.lastCycleMs,
      maker,
      themes,
      whales: this.whales ? this.whales.snapshot() : { enabled: false },
      anyMarket: this.any ? this.any.snapshot() : { enabled: false },
      universe: {
        pm: this.quotes.pm.size, ks: this.quotes.ks.size, dataAge: this.lastQuoteAt ? Math.round((now - this.lastQuoteAt) / 1000) : null,
        apiOk: http.stats.ok, apiErr: http.stats.err, lastError: http.stats.lastError, rejected: this.rejected.length,
        pmTop: top([...this.quotes.pm.values()]).map((m) => ({ q: m.question, px: r3((m.bestBid + m.bestAsk) / 2), vol: Math.round(m.vol24), url: m.url })),
        ksTop: top([...this.quotes.ks.values()]).map((m) => ({ q: m.title, px: r3((m.yesBid + m.yesAsk) / 2), vol: Math.round(m.vol24), url: m.url })),
      },
      signals: this.signals.slice(0, 5).map((x) => ({ type: x.type, label: x.pair.label, theme: this.themeFor(x.pair), edge: r3(x.edge), gap: x.gap != null ? r3(x.gap) : null })),
      cfg: { minGap: this.cfg.minGap, minEdge: this.cfg.minEdge, exitGap: this.cfg.exitGap, stopLoss: this.cfg.stopLoss, paperStopLossPct: this.cfg.paperStopLossPct, gainLockTriggerPct: this.cfg.gainLockTriggerPct, gainLockGivebackPct: this.cfg.gainLockGivebackPct, gainLockRetainPct: this.cfg.gainLockRetainPct, minArbEdge: this.cfg.minArbEdge, maxPositionPct: this.cfg.maxPositionPct, maxOpenPositions: this.cfg.maxOpenPositions, maxArbGroups: this.cfg.maxArbGroups, maxLongArbGroups: this.cfg.maxLongArbGroups, longDays: this.cfg.longDays, maxDailyDrawdownPct: this.cfg.maxDailyDrawdownPct, maxHoldMin: this.cfg.maxHoldMin, priceEvery: this.cfg.priceEvery,
        makerMarkets: this.cfg.makerMarkets, makerMinTradesPerDay: this.cfg.makerMinTradesPerDay },
    };
  }
}

module.exports = { Engine, AGENTS };

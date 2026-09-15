'use strict';
// The Ask panel's tools: read-only views over the running desk, for src/ask.js.
//
// Two rules hold for every tool in this file:
//
//   1. READ ONLY. Nothing here opens, closes, sells, flattens, resumes, saves or writes. A tool
//      that could change the desk would put a sentence written by a language model one step away
//      from a real order, and the Ask panel exists to answer questions, not to act on them.
//
//   2. WHITELIST, DON'T BLACKLIST. Every answer is built from named fields. Nothing spreads cfg,
//      process.env, a position or a raw journal line into the output, because the way a secret
//      leaks is an object that someone later adds a secret to, passed along whole. The finished
//      text is then scrubbed for the known secret values anyway (redactor), as a backstop -- the
//      whitelist is the defence, the scrub only catches a mistake in it.
//
// Every result is bounded (MAX_OUT). A tool answer is re-sent on every later request in its
// conversation, so a megabyte here is paid for over and over.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const http = require('./http');

const ROOT = path.join(__dirname, '..');
const MAX_OUT = 10000;                 // characters per tool result, before the cut note
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const AGENT_KEYS = ['HOLT', 'ILSA', 'TESS', 'RIGO', 'BRAM', 'KETT', 'MAKR'];
// Not required from src/engine.js (AGENTS lives there): the engine requires ask.js, which
// requires this, so the engine's exports are still empty while this file loads.
const ROLES = { HOLT: 'scanner: matches markets across venues', ILSA: 'sentiment: price drift and whale watch', TESS: 'ops: health, risk and halts', RIGO: 'settlement: marks, exits, settles', BRAM: 'pricing: decides if a trade is worth it', KETT: 'execution: places trades', MAKR: 'maker: rests quotes on Kalshi' };
const LOG_KINDS = ['OPS', 'SCAN', 'RESEARCH', 'PASS', 'FILL', 'SETTLE', 'HALT', 'WHALE'];
const VEN = { PM: 'Polymarket', KS: 'Kalshi' };

const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const ET_TIME = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

// ---------------------------------------------------------------- formatting
// Units ride inside the value ("$12.40", "42c", "+$1.20"), so the model never has to guess
// whether 0.42 is dollars, cents or a probability.
const r2 = (x) => Math.round(x * 100) / 100;
const fin = (x) => typeof x === 'number' && Number.isFinite(x);
const money = (x) => (fin(x) ? `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}` : null);
const signed = (x) => (fin(x) ? `${x < 0 ? '-' : '+'}$${Math.abs(x).toFixed(2)}` : null);
const cents = (p) => (fin(p) ? `${String(r2(p * 100))}c` : null);
const signedCents = (p) => (fin(p) ? `${p < 0 ? '-' : '+'}${String(r2(Math.abs(p) * 100))}c` : null);
const clip = (s, n) => { const t = String(s == null ? '' : s); return t.length > n ? `${t.slice(0, n)}…` : t; };

// Eastern wall-clock time, because that is the operator's clock and the desk's day boundary.
// Converting UTC in its head is exactly the arithmetic a model gets wrong around DST.
function et(ms) {
  if (!fin(ms) || ms <= 0) return null;
  const p = Object.fromEntries(ET_TIME.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second} ET`;
}
const etDay = (ms) => ET_DAY.format(new Date(ms));

// Input coercion. A bad argument is the model's mistake, so it comes back as an error it can read
// and correct rather than a silently different query.
function int(v, dflt, lo, hi, name) {
  if (v == null) return dflt;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number`);
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
function text(v, name, max = 120) {
  if (v == null || v === '') return null;
  if (typeof v !== 'string') throw new Error(`${name} must be text`);
  return v.trim().toLowerCase().slice(0, max) || null;
}
function day(v, name, dflt) {
  if (v == null || v === '') return dflt;
  if (typeof v !== 'string' || !DAY_RE.test(v.trim())) throw new Error(`${name} must be an Eastern date like 2026-09-14`);
  return v.trim();
}

// ---------------------------------------------------------------- secrets backstop
// Values that must never appear in anything a tool returns. Names are matched, values are
// replaced: whatever ends up set in .env under a secret-shaped name is covered without this list
// having to know every variable the desk will ever grow.
const SECRET_NAME = /KEY|SECRET|TOKEN|PASS|PEM|PRIVATE|COOKIE|SESSION|CREDENTIAL/i;
function secretValues(E, env = process.env) {
  const cfg = (E && E.cfg) || {};
  const vals = [cfg.dashPass, cfg.flattenToken, cfg.kalshiKeyId, cfg.kalshiKeyPath, E && E.brain && E.brain.key];
  for (const [k, v] of Object.entries(env)) if (SECRET_NAME.test(k)) vals.push(v);
  // the dashboard's session cookie and one-click link are HMACs of DASH_PASS (server.js)
  if (cfg.dashPass) {
    vals.push(crypto.createHmac('sha256', cfg.dashPass).update('hexagon-session-v1').digest('hex'));
    vals.push(crypto.createHmac('sha256', cfg.dashPass).update('hexagon-link-v1').digest('hex').slice(0, 32));
  }
  // six characters, so a secret-shaped variable holding "1" or "true" does not blank every digit
  return [...new Set(vals.map((v) => String(v == null ? '' : v).trim()).filter((v) => v.length >= 6))];
}
function redact(s, secrets) {
  let out = s;
  for (const v of secrets) if (out.includes(v)) out = out.split(v).join('[redacted]');
  return out;
}

function bounded(s, max = MAX_OUT) {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n…[cut here: ${s.length - max} more characters not shown. Ask again with a smaller limit or a contains filter.]`;
}

// ---------------------------------------------------------------- desk_overview
function deskOverview(E, _in, now) {
  const s = E.state;
  const eq = E.equity();
  const unrealized = s.positions.reduce((a, p) => a + (p.qty * (p.mark ?? p.entry) - p.cost), 0);
  const deployed = s.positions.reduce((a, p) => a + p.qty * (p.mark ?? p.entry), 0);
  const pnl = E.pnlScorecard();
  const mk = E.maker && E.maker.snapshot ? E.maker.snapshot(E) : null;
  const research = E.research ? E.research.snapshot() : null;
  const whales = E.whales ? E.whales.snapshot() : null;
  return {
    asOf: et(now),
    account: E.cfg.mode === 'live' ? 'LIVE (real money)' : 'paper (pretend money, no real trades)',
    demoQuotes: !!E.cfg.demo,
    ledgerStarted: et(s.startedAt),
    takerBook: {
      what: 'the six trading desks share this book; the maker has its own',
      startingBalance: money(s.initial), cash: money(s.cash), equityAtMarks: money(eq),
      inOpenPositions: money(r2(deployed)), openPositions: s.positions.length, maxOpenPositions: E.cfg.maxOpenPositions, maxArbGroups: E.cfg.maxArbGroups,
      realizedPnlAllTime: signed(s.stats.realized), unrealizedPnlAtMarks: signed(r2(unrealized)), feesPaidAllTime: money(s.stats.fees),
      groupsWon: s.stats.wins, groupsLost: s.stats.losses,
      today: { easternDay: s.dayKey || etDay(now), equityAtDayStart: money(s.dayStartEquity), pnlToday: fin(s.dayStartEquity) ? signed(r2(eq - s.dayStartEquity)) : null },
      pnlIfAllHeldToSettlement: signed(pnl.totalAtSettlement), pnlIfAllSoldNow: signed(pnl.totalLiquidation), arbAlerts: pnl.integrityAlerts,
    },
    makerBook: mk ? {
      startingBalance: money(mk.initial), cash: money(mk.cash), equityAtMids: money(mk.equity),
      pnl: fin(mk.equity) && fin(mk.initial) ? signed(r2(mk.equity - mk.initial)) : null, realizedPnl: signed(mk.realized),
      fillsAllTime: mk.fills, marketsQuoting: mk.quoting, contractsHeld: Math.round(mk.inv || 0), halted: mk.halted || null,
    } : null,
    halts: {
      riskHalt: E.halt || null,
      operatorHalt: E.operatorHalt || null,
      meaning: 'riskHalt is TESS stopping NEW trades (stale data, API errors, drawdown, or warming up after a start); operatorHalt is a manual flatten that stays until resumed. Open positions keep being managed either way.',
    },
    desks: AGENT_KEYS.filter((k) => E.agentStatus[k]).map((k) => {
      const a = E.agentStatus[k];
      return { desk: k, job: ROLES[k], saying: clip(a.note, 80), lastActive: et(a.lastActive), secondsSinceActive: a.lastActive ? Math.round((now - a.lastActive) / 1000) : null };
    }),
    health: {
      quoteAgeSec: E.lastQuoteAt ? Math.round((now - E.lastQuoteAt) / 1000) : null,
      polymarketMarketsScanned: E.quotes.pm.size, kalshiMarketsScanned: E.quotes.ks.size, matchedPairs: E.pairs.length,
      apiCallsOk: http.stats.ok, apiErrorsTotal: http.stats.err, apiErrorsLast5Min: http.recentErrors(), lastApiError: clip(http.stats.lastError, 160) || null,
      lastCycleMs: E.lastCycleMs, lastMakerRoundMs: E.lastMakerMs ?? null,
    },
    claude: {
      desksMinds: E.brain ? E.brain.status() : null,
      researchToday: research ? `${money(research.dayUsd)} of ${money(research.dayCap)}` : null,
    },
    whaleWatch: whales && whales.enabled ? { following: whales.watching, lastError: clip(whales.lastError, 120) || null } : 'off',
  };
}

// ---------------------------------------------------------------- open_positions
const INTEGRITY = {
  valid: 'ok: one YES and one NO on the same event, pays $1 a pair at settlement',
  orphan_leg: 'PROBLEM: only one leg is held, so it is not hedged',
  too_many_legs: 'PROBLEM: more than two legs',
  missing_complement: 'PROBLEM: the two legs are not one YES and one NO',
  venue_mismatch: 'PROBLEM: both legs are on the same venue',
  quantity_mismatch: 'PROBLEM: the legs have different sizes',
  pair_mismatch: 'PROBLEM: the legs belong to different pairs',
  venues_disagree: 'PROBLEM: the venues price it very differently, so the two legs may be different events',
};
function openPositions(E, _in, now) {
  const s = E.state;
  const research = E.research ? E.research.snapshot().jobs : {};
  return {
    asOf: et(now),
    note: 'taker book only; maker inventory is in maker_status. Prices are per contract; a contract pays $1 if its side wins.',
    count: s.positions.length,
    positions: s.positions.slice(0, 40).map((p) => {
      const mark = p.mark ?? p.entry;
      return {
        id: p.id, group: p.group, market: clip(p.label, 80), venue: VEN[p.venue] || p.venue, side: String(p.side || '').toUpperCase(),
        contracts: p.qty, entryPrice: cents(p.entry), markPrice: cents(mark), sellPriceNow: cents(E.venueMark(p) ?? mark),
        cost: money(p.cost), pnlAtMark: signed(r2(p.qty * mark - p.cost)),
        strategy: p.strategy === 'arb' ? 'locked arb leg' : p.strategy === 'converge' ? 'convergence bet' : p.strategy,
        openedAt: et(p.openedAt), heldMinutes: p.openedAt ? Math.round((now - p.openedAt) / 60000) : null,
        exitStuck: !!p.orphan, exitAwaitingReconciliation: !!p.pendingExit,
      };
    }),
    lockedArbs: E.arbScorecard().slice(0, 20).map((g) => ({
      group: g.id, market: clip(g.label, 80), contracts: g.qty, legs: g.legs, check: INTEGRITY[g.integrity] || g.integrity,
      cost: money(g.entryCost), worthIfSoldNow: money(g.liquidationValue), pnlIfSoldNow: signed(g.liquidationPnl),
      pnlAtSettlement: g.lockedPnl == null ? 'unknown (the pair failed its check)' : signed(g.lockedPnl), venueGap: cents(g.venueGap),
    })),
    researchVerdicts: Object.entries(research || {}).slice(0, 10).map(([group, j]) => ({
      group, status: j.status, verdict: j.result ? j.result.action : null, sentence: j.result ? clip(j.result.sentence, 240) : null,
      at: et(j.finishedAt || j.startedAt), error: j.error ? clip(j.error, 120) : null,
    })),
  };
}

// ---------------------------------------------------------------- closed_trades
function closedTrades(E, input, now) {
  const limit = int(input.limit, 20, 1, 100, 'limit');
  const contains = text(input.contains, 'contains');
  let since = null;
  if (input.since != null && input.since !== '') {
    if (typeof input.since !== 'string') throw new Error('since must be text');
    const v = input.since.trim();
    if (DAY_RE.test(v)) since = { day: v };
    else if (Number.isFinite(Date.parse(v))) since = { ms: Date.parse(v) };
    else throw new Error('since must be an Eastern date like 2026-09-14 or an ISO time');
  }
  const all = E.state.closed.slice().reverse();          // newest first
  const hits = all.filter((c) => {
    if (since && since.day && !(c.exitAt && etDay(c.exitAt) >= since.day)) return false;
    if (since && since.ms != null && !(c.exitAt >= since.ms)) return false;
    if (contains && !String(c.label || '').toLowerCase().includes(contains)) return false;
    return true;
  });
  const total = hits.reduce((a, c) => a + (fin(c.pnl) ? c.pnl : 0), 0);
  return {
    asOf: et(now),
    note: 'one row per closed LEG (a locked arb has two). The in-memory list keeps the newest 2,000 legs; the journal tool has the full record.',
    matchingLegs: hits.length, shown: Math.min(limit, hits.length),
    pnlOfMatchingLegs: signed(r2(total)), winningLegs: hits.filter((c) => c.pnl > 0).length, losingLegs: hits.filter((c) => c.pnl < 0).length,
    trades: hits.slice(0, limit).map((c) => ({
      closedAt: et(c.exitAt), openedAt: et(c.openedAt), market: clip(c.label, 80), venue: VEN[c.venue] || c.venue, side: String(c.side || '').toUpperCase(),
      contracts: c.qty, entryPrice: cents(c.entry), exitPrice: cents(c.exit), pnl: signed(c.pnl), reason: clip(c.reason, 140),
      strategy: c.strategy === 'arb' ? 'locked arb leg' : c.strategy === 'converge' ? 'convergence bet' : c.strategy, group: c.group,
    })),
  };
}

// ---------------------------------------------------------------- activity_log
function activityLog(E, input, now) {
  const limit = int(input.limit, 30, 1, 100, 'limit');
  const contains = text(input.contains, 'contains');
  const agent = input.agent == null || input.agent === '' ? null : String(input.agent).toUpperCase();
  if (agent && !AGENT_KEYS.includes(agent)) throw new Error(`agent must be one of ${AGENT_KEYS.join(', ')}`);
  const kind = input.kind == null || input.kind === '' ? null : String(input.kind).toUpperCase();
  if (kind && !LOG_KINDS.includes(kind)) throw new Error(`kind must be one of ${LOG_KINDS.join(', ')}`);
  const hits = E.state.log.filter((l) => (!agent || l.agent === agent) && (!kind || l.kind === kind)
    && (!contains || String(l.text || '').toLowerCase().includes(contains)));
  return {
    asOf: et(now),
    note: 'newest first. The log keeps the newest 500 lines across all desks; the journal tool is the permanent record of trades.',
    matchingLines: hits.length, shown: Math.min(limit, hits.length),
    lines: hits.slice(0, limit).map((l) => ({ at: et(l.t), desk: l.agent, kind: l.kind, pnl: l.pnl == null ? null : signed(l.pnl), text: clip(l.text, 320) })),
  };
}

// ---------------------------------------------------------------- journal
// Journal payloads differ by kind, so the whitelist is by field name: every scalar field the
// engine, broker, maker, research and ask ever journal. A field not on this list is not shown.
const JOURNAL_FIELDS = ['id', 'group', 'label', 'venue', 'side', 'qty', 'entry', 'exit', 'fee', 'cost', 'proceeds', 'pnl', 'legPnl',
  'partialPnl', 'reason', 'strategy', 'heldMs', 'cash', 'sold', 'remaining', 'attempt', 'ref', 'orderId', 'clientOrderId', 'pairId',
  'expectedPayout', 'entryCost', 'lockedPnl', 'integrity', 'positions', 'legs', 'was', 'ticker', 'px', 'tradePx', 'runOver', 'inv',
  'rate', 'until', 'equity', 'usd', 'estimated', 'searches', 'action', 'sentence', 'confidence', 'status', 'rounds', 'tools', 'model', 'validationVersion'];
function journalDates(dir) {
  try { return fs.readdirSync(dir).map((f) => (f.match(/^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/) || [])[1]).filter(Boolean).sort(); }
  catch { return []; }
}
async function journal(E, input, now) {
  const date = day(input.date, 'date', etDay(now));
  const limit = int(input.limit, 40, 1, 200, 'limit');
  const contains = text(input.contains, 'contains');
  let kinds = null;
  if (input.kinds != null) {
    const list = Array.isArray(input.kinds) ? input.kinds : [input.kinds];
    kinds = new Set(list.map((k) => String(k).trim().toUpperCase()).filter((k) => /^[A-Z_]{1,40}$/.test(k)));
    if (!kinds.size) kinds = null;
  }
  const dir = E.cfg.dataDir;
  const file = path.join(dir, `journal-${date}.jsonl`);
  if (!fs.existsSync(file)) {
    return { date, found: false, note: 'no journal file for that Eastern day', availableDates: journalDates(dir).slice(-14) };
  }
  // Streamed line by line, keeping only the last `limit` matches: a maker day is thousands of fill
  // lines, and a synchronous read of the whole file would stall the desk's event loop.
  const counts = {};
  const ring = [];
  let lines = 0, matched = 0, unreadable = 0;
  const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    lines++;
    let r;
    try { r = JSON.parse(line); } catch { unreadable++; continue; }
    if (!r || typeof r !== 'object') { unreadable++; continue; }
    const k = String(r.kind || '?');
    counts[k] = (counts[k] || 0) + 1;
    if (kinds && !kinds.has(k)) continue;
    if (contains && !line.toLowerCase().includes(contains)) continue;
    matched++;
    ring.push(r);
    if (ring.length > limit) ring.shift();
  }
  return {
    date, found: true, asOf: et(now),
    note: 'the permanent record, one line per event. Money fields are dollars (cost, pnl, cash, proceeds, fee); price fields are dollars per contract (entry, exit, px: 0.42 = 42c).',
    linesInDay: lines, countsByKind: counts, unreadableLines: unreadable || undefined,
    matchingLines: matched, shown: ring.length, newestFirst: true,
    entries: ring.reverse().map((r) => {
      const o = { at: et(Date.parse(r.t)), kind: String(r.kind || '?') };
      for (const f of JOURNAL_FIELDS) {
        const v = r[f];
        if (v == null) continue;
        if (typeof v === 'string') o[f] = clip(v, 200);
        else if (typeof v === 'number' || typeof v === 'boolean') o[f] = v;
      }
      return o;
    }),
  };
}

// ---------------------------------------------------------------- markets
function markets(E, input, now) {
  const limit = int(input.limit, 15, 1, 40, 'limit');
  const contains = text(input.contains, 'contains');
  const cfg = E.cfg;
  const whyNot = {};
  for (const p of E.pairs) {
    const why = !p.q ? 'no quote yet' : p.inPlay ? 'in-play (event live, or its Kalshi market closes soon)' : p.veto || null;
    if (why) whyNot[why] = (whyNot[why] || 0) + 1;
  }
  const rows = E.pairs
    .filter((p) => !contains || [p.label, p.pm && p.pm.question, p.ks && p.ks.title, p.ks && p.ks.ticker, p.series, p.category].some((x) => String(x || '').toLowerCase().includes(contains)))
    .sort((a, b) => (!!a.inPlay - !!b.inPlay) || (Math.abs(b.q ? b.q.ksMid - b.q.pmMid : 0) - Math.abs(a.q ? a.q.ksMid - a.q.pmMid : 0)));
  return {
    asOf: et(now),
    note: 'matched pairs: the same outcome on Polymarket and Kalshi. Prices are YES prices per contract. netEdge is the profit per contract after spread and fees if traded now; negative is the normal reading.',
    matchedPairs: E.pairs.length, inPlay: E.pairs.filter((p) => p.inPlay).length, rejectedMatches: E.rejected.length,
    watchOnlyUntilRulesChecked: E.pairs.filter((p) => p.watchOnly).length,
    anyMarketScanner: E.any ? E.any.snapshot() : { enabled: false },
    tradeSignalsThisCycle: (E.signals || []).slice(0, 5).map((s) => ({ market: clip(s.pair.label, 80), type: s.type === 'arb' ? 'locked arb' : 'convergence', netEdge: cents(s.edge) })),
    whyPairsAreNotTrading: whyNot,
    rules: {
      minGap: `${cents(cfg.minGap)} (venues must disagree by this much to be interesting)`,
      minEdge: `${cents(cfg.minEdge)} (profit per contract after spread and fees needed to trade)`,
      minArbEdge: `${cents(cfg.minArbEdge)} (locked arb profit per contract needed)`,
      maxSpread: cents(cfg.maxSpread), priceBand: `${cents(cfg.minMid)} to ${cents(cfg.maxMid)}`,
      thickVenueVolumeRatio: cfg.convMinVolRatio, gamesUntradeable: 'from 2 minutes before start',
      anyPairUntradeable: `from ${cfg.closeGuardMin} minutes before its Kalshi market closes`,
    },
    matchingPairs: rows.length, shown: Math.min(limit, rows.length),
    pairs: rows.slice(0, limit).map((p) => {
      const q = p.q;
      const bias = E.bias.get(p.id);
      return {
        market: clip(p.label, 80), kind: p.kind, category: p.kind === 'game' ? 'Sports' : p.kind === 'fed' ? 'Economics' : p.category || null, series: p.series, inPlay: !!p.inPlay, startsAt: et(p.startsAt), kalshiClosesAt: et(p.closesAt), expectedSettlement: et(p.settlesAt),
        rules: p.rules ? { verdict: p.rules.verdict, checkedBy: p.rules.source, why: clip(p.rules.reason, 160) } : null,
        tradeable: !p.watchOnly,
        polymarket: q ? { bid: cents(q.pmBid), ask: cents(q.pmAsk), volume24h: money(Math.round(q.pmVol || 0)) } : null,
        kalshi: q ? { bid: cents(q.ksBid), ask: cents(q.ksAsk), volume24h: money(Math.round(q.ksVol || 0)) } : null,
        gapKalshiMinusPolymarket: q ? signedCents(q.ksMid - q.pmMid) : null,
        quoteAgeSec: q && q.t ? Math.round((now - q.t) / 1000) : null,
        fairValue: cents(p.fair), bestTrade: p.best ? { venue: VEN[p.best.venue] || p.best.venue, side: String(p.best.side).toUpperCase(), netEdge: signedCents(p.best.edge) } : null,
        stoppedBy: !q ? 'no quote yet' : p.inPlay ? 'in-play' : p.veto || null,
        gapTrend: bias && fin(bias.score) ? (bias.score > 0.1 ? 'narrowing' : bias.score < -0.1 ? 'widening' : 'steady') : null,
        polymarketQuestion: clip(p.pm && p.pm.question, 120), kalshiTitle: clip(p.ks && p.ks.title, 120), kalshiTicker: p.ks && p.ks.ticker,
      };
    }),
  };
}

// ---------------------------------------------------------------- maker_status
function makerStatus(E, input, now) {
  const limit = int(input.limit, 12, 1, 40, 'limit');
  const contains = text(input.contains, 'contains');
  const mk = E.maker && E.maker.snapshot ? E.maker.snapshot(E) : null;
  if (!mk) return { asOf: et(now), enabled: false };
  const hist = mk.hist || [];
  // one point an hour is enough to say which way it has been going
  const trend = [];
  let lastT = -Infinity;
  for (const h of hist) if (h.t - lastT >= 3600e3) { trend.push({ at: et(h.t), pnl: signed(h.e), realized: signed(h.c) }); lastT = h.t; }
  if (hist.length && trend.length && hist[hist.length - 1].t !== lastT) { const h = hist[hist.length - 1]; trend.push({ at: et(h.t), pnl: signed(h.e), realized: signed(h.c) }); }
  const rows = (mk.markets || []).filter((m) => !contains || [m.ticker, m.title, m.sub].some((x) => String(x || '').toLowerCase().includes(contains)));
  const fill = (f) => (f ? { at: et(f.at), ticker: f.ticker, side: f.side, contracts: f.qty, price: cents(f.px), pnl: signed(f.pnl || 0) } : null);
  return {
    asOf: et(now),
    note: 'the maker rests buy and sell quotes on Kalshi markets that charge makers no fee and earns the spread when someone trades against them. Its cash and P&L are separate from the taker book.',
    enabled: !!mk.enabled, halted: mk.halted || null,
    startingBalance: money(mk.initial), cash: money(mk.cash), equityAtMids: money(mk.equity),
    pnl: fin(mk.equity) && fin(mk.initial) ? signed(r2(mk.equity - mk.initial)) : null, realizedPnl: signed(mk.realized),
    fillsAllTime: mk.fills, marketsQuoting: mk.quoting, marketsTracked: mk.tracked, contractsHeld: Math.round(mk.inv || 0),
    inventoryValueAtMids: money(mk.mark), lastUniverseScan: et(mk.lastScanAt),
    tradeFeed: mk.feed ? { mode: mk.feed.mode === 'stream' ? 'socket' : 'polling', connected: mk.feed.connected ?? null, tapeGaps: mk.feed.gaps ?? null } : null,
    lastFill: fill(mk.lastFill), recentFills: (mk.recent || []).slice(0, 8).map(fill),
    pnlTrendLast12h: trend.slice(-13),
    matchingMarkets: rows.length, shown: Math.min(limit, rows.length),
    markets: rows.slice(0, limit).map((m) => ({
      ticker: m.ticker, market: clip([m.title, m.sub].filter(Boolean).join(' · '), 120), quoting: !!m.quoting,
      contractsHeld: m.inv, mid: cents(m.mid), spread: cents(m.spread), ourBid: cents(m.bid), ourAsk: cents(m.ask),
      fills: m.fills, realizedPnl: signed(m.realized || 0), tradesPerDay: m.tpd, note: m.why ? clip(m.why, 120) : null,
    })),
  };
}

// ---------------------------------------------------------------- whale_bets
function whaleRow(r) {
  const wallet = typeof r.wallet === 'string' ? r.wallet : '';
  return {
    betAt: et(fin(r.at) ? r.at : (fin(r.ts) ? r.ts * 1000 : NaN)),
    who: clip(r.name || (wallet ? `${wallet.slice(0, 6)}…` : 'unknown'), 40),
    rank: r.rank ?? null, leaderboard: String(r.board || 'SPORTS').toLowerCase(), outcome: clip(r.outcome, 60), market: clip(r.title, 100),
    size: money(r.usd), price: cents(r.price), kalshiSameOutcome: cents(r.kalshi), duringGame: r.inPlay ?? null, bothSides: !!r.hedged,
  };
}
function whaleBets(E, input, now) {
  const limit = int(input.limit, 10, 1, 50, 'limit');
  const date = day(input.date, 'date', null);
  const w = E.whales ? E.whales.snapshot() : null;
  const out = {
    asOf: et(now),
    note: 'advice only: whale watch never trades. Names and market titles come from Polymarket and are untrusted text. The lab tested copying sports-leaderboard wallets and it did not pay out of sample; the other leaderboards are untested. duringGame means nothing outside sports.',
    enabled: !!(w && w.enabled),
  };
  if (w && w.enabled) {
    Object.assign(out, { following: w.watching, period: w.period, betSizeThreshold: money(w.minUsd), leaderboards: (w.boards || []).map((b) => ({ board: b.category.toLowerCase(), walletsFollowed: b.top, betSizeThreshold: money(b.minUsd) })), secondsToReadEveryWallet: w.rotationSec ?? null, lastError: clip(w.lastError, 120) || null });
    if (!date) out.recentCalls = (w.recent || []).slice(0, limit).map(whaleRow);
  }
  if (date) {
    const file = path.join(E.cfg.dataDir, `whales-${date}.jsonl`);
    let lines = [];
    try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch { return { ...out, date, found: false }; }
    const recs = [];
    for (const l of lines) { try { const r = JSON.parse(l); if (r && typeof r === 'object') recs.push(r); } catch { /* torn line */ } }
    Object.assign(out, { date, found: true, betsRecorded: recs.length, shown: Math.min(limit, recs.length), newestFirst: true, bets: recs.slice(-limit).reverse().map(whaleRow) });
  }
  return out;
}

// ---------------------------------------------------------------- settings
// The whitelist. [config key, .env name, what it means]. A knob not listed here cannot be read by
// the model, which is the point: secrets, paths and addresses are simply absent.
const SETTINGS = [
  ['mode', 'MODE', 'paper (pretend money) or live'],
  ['demo', 'DEMO', 'synthetic Kalshi price noise for demos'],
  ['initialBalance', 'INITIAL_BALANCE', 'starting balance of each book, dollars'],
  ['maxPositionPct', 'MAX_POSITION_PCT', 'largest single position as a share of equity'],
  ['baseSizeMult', 'BASE_SIZE_MULT', 'share of the position cap a neutral convergence bet takes'],
  ['maxOpenPositions', 'MAX_OPEN_POSITIONS', 'most open convergence bets (unhedged) at once'],
  ['maxArbGroups', 'MAX_ARB_GROUPS', 'most locked arbs at once, counted per arb, not per leg'],
  ['maxDailyDrawdownPct', 'MAX_DAILY_DRAWDOWN_PCT', 'daily loss share that halts new taker trades'],
  ['maxDataAgeSec', 'MAX_DATA_AGE_SEC', 'quote age in seconds that halts new trades'],
  ['maxApiErrors', 'MAX_API_ERRORS', 'API errors in 5 minutes that halt new trades'],
  ['minGap', 'MIN_GAP', 'venue disagreement (dollars per contract) that makes a pair interesting'],
  ['minEdge', 'MIN_EDGE', 'profit per contract after spread and fees needed for a convergence trade'],
  ['minArbEdge', 'MIN_ARB_EDGE', 'profit per contract needed for a locked arb'],
  ['convMinVolRatio', 'CONV_MIN_VOL_RATIO', 'how many times more volume the thick venue needs'],
  ['arbUnwindMargin', 'ARB_UNWIND_MARGIN', 'gain per contract over holding needed to unwind an arb early'],
  ['exitGap', 'EXIT_GAP', 'gap at which a convergence bet is closed as done'],
  ['stopLoss', 'STOP_LOSS', 'loss per contract that stops out a convergence bet'],
  ['maxHoldMin', 'MAX_HOLD_MIN', 'longest a convergence bet is held, minutes'],
  ['minMid', null, 'lowest price a convergence bet is taken at'],
  ['maxMid', null, 'highest price a convergence bet is taken at'],
  ['maxSpread', null, 'widest bid-ask spread a trade will cross'],
  ['slipLimit', 'SLIP_LIMIT', 'how far past the signal price a fill may walk'],
  ['pmFeeFallback', 'PM_FEE_FALLBACK', 'Polymarket taker fee rate used only when a market does not publish its own (fee = rate x shares x P x (1-P))'],
  ['closeGuardMin', 'CLOSE_GUARD_MIN', 'minutes before a Kalshi market closes that its pair stops trading and convergence bets are closed'],
  ['ksFeeRate', 'KS_FEE_RATE', 'Kalshi taker fee rate (fee = rate x contracts x P x (1-P))'],
  ['priceEvery', 'PRICE_EVERY_SEC', 'seconds between taker cycles'],
  ['reentryCooldownMs', 'REENTRY_COOLDOWN_MIN', 'wait after an exit before re-entering a pair (milliseconds here)'],
  ['pmUniverse', 'PM_UNIVERSE', 'Polymarket markets scanned, by volume'],
  ['ksSeries', 'KS_SERIES', 'Kalshi series scanned by the fast matcher (games and the Fed)'],
  ['anyMarkets', 'ANY_MARKETS', 'any-market scanner on or off (every category on both venues)'],
  ['anyMaxPairs', 'ANY_MAX_PAIRS', 'most any-market pairs kept and repriced each cycle'],
  ['discoverEveryMin', 'DISCOVER_EVERY_MIN', 'minutes between full any-market crawls'],
  ['arbMinApr', 'ARB_MIN_APR', 'yearly return a locked arb must beat for the time its money is tied up'],
  ['maxLongArbGroups', 'MAX_LONG_ARB_GROUPS', 'most locked arbs settling more than LONG_DAYS out'],
  ['longDays', 'LONG_DAYS', 'days after which an arb counts as long-dated'],
  ['entryPersistCycles', 'ENTRY_PERSIST_CYCLES', 'cycles an any-market signal must last before trading'],
  ['rulesCheck', 'RULES_CHECK', 'whether unclear pairs showing an edge may be put to Claude for a rules verdict'],
  ['rulesDailyUsd', 'RULES_DAILY_USD', 'daily spending ceiling for the rules check'],
  ['probeGap', 'PROBE_GAP', 'gap that triggers a full order-book probe'],
  ['record', 'RECORD', 'whether the tick tape is recorded'],
  ['tapeMinFreeMb', 'TAPE_MIN_FREE_MB', 'free disk (MB) below which old tick tapes are trimmed; 0 is off'],
  ['makerEnabled', 'MAKER', 'maker desk on or off'],
  ['makerMarkets', 'MAKER_MARKETS', 'markets the maker quotes'],
  ['makerCap', 'MAKER_CAP', 'maker inventory cap per market, contracts'],
  ['makerSoftCap', 'MAKER_SOFT_CAP', 'share of the cap where the growing side is withdrawn; 1 is off'],
  ['makerParticipation', 'MAKER_PARTICIPATION', 'share of crossing volume the fill model assumes the maker wins'],
  ['makerMinSpread', 'MAKER_MIN_SPREAD', 'narrowest spread the maker quotes'],
  ['makerMinTradesPerDay', 'MAKER_MIN_TPD', 'fewest trades a day a maker market needs'],
  ['makerMinDaysToClose', 'MAKER_MIN_DAYS_TO_CLOSE', 'fewest days to close a maker market needs'],
  ['makerMinMid', 'MAKER_MIN_MID', 'lowest price the maker quotes'],
  ['makerMaxMid', 'MAKER_MAX_MID', 'highest price the maker quotes'],
  ['makerEverySec', 'MAKER_EVERY_SEC', 'seconds between maker requotes'],
  ['makerStream', 'MAKER_STREAM', 'read the Kalshi trade socket when a key is configured'],
  ['makerMaxRunOver', 'MAKER_MAX_RUNOVER', 'run-over share that cools a maker market; 1 is off'],
  ['makerToxCooldownMin', 'MAKER_TOX_COOLDOWN_MIN', 'minutes a cooled maker market rests'],
  ['makerToxByContracts', 'MAKER_TOX_BY_CONTRACTS', 'run-over share counted in contracts (1) or fills (0)'],
  ['makerMaxDrawdownPct', 'MAKER_MAX_DRAWDOWN_PCT', 'maker drawdown from its peak that halts it'],
  ['kalshiGapMs', 'KALSHI_GAP_MS', 'milliseconds between Kalshi API calls'],
  ['brainEnabled', 'BRAIN', "desks' Claude minds on or off"],
  ['brainModelDeep', 'BRAIN_MODEL_DEEP', 'model for BRAM and KETT'],
  ['brainModelFast', 'BRAIN_MODEL_FAST', 'model for the other desks'],
  ['brainEffort', 'BRAIN_EFFORT', "desks' thinking effort"],
  ['brainDailyUsd', 'BRAIN_DAILY_USD', "desks' Claude spend cap per Eastern day, dollars"],
  ['researchEnabled', 'RESEARCH', 'alert Research button on or off'],
  ['researchModel', 'RESEARCH_MODEL', 'model for Research'],
  ['researchDailyUsd', 'RESEARCH_DAILY_USD', 'Research spend cap per Eastern day, dollars'],
  ['askEnabled', 'ASK', 'this Ask panel on or off'],
  ['askModel', 'ASK_MODEL', 'model answering Ask questions'],
  ['askEffort', 'ASK_EFFORT', 'thinking effort for Ask'],
  ['askDailyUsd', 'ASK_DAILY_USD', 'Ask spend cap per Eastern day, dollars'],
  ['askMaxRounds', 'ASK_MAX_ROUNDS', 'lookup rounds allowed per question'],
  ['whaleWatch', 'WHALE_WATCH', 'whale watch on or off'],
  ['whaleCategories', 'WHALE_CATEGORIES', 'Polymarket leaderboards whale watch follows'],
  ['whaleTop', 'WHALE_TOP', 'sports wallets followed'],
  ['whaleTopOther', 'WHALE_TOP_OTHER', 'wallets followed on each other leaderboard'],
  ['whaleMinUsdOther', 'WHALE_MIN_USD_OTHER', 'net buying that counts as a bet for a wallet on a non-sports leaderboard, dollars'],
  ['whalePeriod', 'WHALE_PERIOD', 'leaderboard period the wallets are ranked on'],
  ['whaleMinUsd', 'WHALE_MIN_USD', 'net buying on one outcome that counts as a bet, dollars'],
  ['whaleWindowMin', 'WHALE_WINDOW_MIN', 'minutes that buying is summed over'],
];
function settings(E, input) {
  const contains = text(input.contains, 'contains');
  const cfg = E.cfg;
  const rows = SETTINGS
    .filter(([k, envName, what]) => !contains || [k, envName, what].some((x) => String(x || '').toLowerCase().includes(contains)))
    .map(([k, envName, what]) => {
      let v = cfg[k];
      if (Array.isArray(v)) v = `${v.length} entries: ${clip(v.join(','), 300)}`;
      else if (v !== null && typeof v === 'object') v = null;       // never pass an object through
      return { setting: envName || `${k} (fixed in src/config.js)`, value: v === undefined ? null : v, meaning: what };
    });
  return {
    note: 'current values from src/config.js and .env. Only non-secret settings are listed. Changing one means editing .env and restarting the desk; this panel cannot change anything.',
    // presence only, never the value: says why a feature is off without saying what the secret is
    secretsPresent: {
      anthropicKey: !!(E.brain && E.brain.key), dashboardPassword: !!cfg.dashPass, flattenSwitch: !!cfg.flattenToken,
      kalshiKey: !!(cfg.kalshiKeyId && cfg.kalshiKeyPath),
    },
    shown: rows.length,
    settings: rows,
  };
}

// ---------------------------------------------------------------- docs
// README.md and ops/DEPLOY.md, split at their headings and searched by keyword. Parsed again only
// when a file's size or modification time changes (one stat per file per call): a local desk sees
// an edited or pulled README without a restart. The box's copies are baked into its image, and a
// merge that touches either file redeploys it (.github/workflows/test.yml).
const DOC_FILES = ['README.md', 'ops/DEPLOY.md'];
let docCache = null;
function docSections(root = ROOT) {
  const files = [];
  for (const rel of DOC_FILES) {
    try { const st = fs.statSync(path.join(root, rel)); files.push({ rel, stamp: `${st.size}@${st.mtimeMs}` }); } catch { /* not on this machine */ }
  }
  const key = `${root}|${files.map((f) => `${f.rel}:${f.stamp}`).join('|')}`;
  if (docCache && docCache.key === key) return docCache;
  const out = [];
  for (const { rel } of files) {
    let body;
    try { body = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { continue; }
    let cur = null, inFence = false;
    for (const line of body.split('\n')) {
      if (/^```/.test(line)) inFence = !inFence;
      const h = !inFence && line.match(/^(#{1,3})\s+(.*)$/);
      if (h) { cur = { file: rel, heading: h[2].trim(), lines: [] }; out.push(cur); continue; }
      if (!cur) { cur = { file: rel, heading: '(top)', lines: [] }; out.push(cur); }
      cur.lines.push(line);
    }
  }
  docCache = { key, sections: out.map((s) => ({ file: s.file, heading: s.heading, text: s.lines.join('\n').trim() })).filter((s) => s.text) };
  return docCache;
}
function docs(_E, input, _now, root = ROOT) {
  if (typeof input.query !== 'string' || !input.query.trim()) throw new Error('query is required: a few keywords');
  const limit = int(input.limit, 2, 1, 4, 'limit');
  const words = [...new Set(input.query.toLowerCase().split(/[^a-z0-9_]+/).filter((w) => w.length >= 3))].slice(0, 12);
  if (!words.length) throw new Error('query needs at least one word of three or more letters');
  const secs = docSections(root).sections;
  if (!secs.length) return { found: false, note: 'README.md and ops/DEPLOY.md are not on this machine' };
  const scored = secs.map((s) => {
    const head = s.heading.toLowerCase(), body = s.text.toLowerCase();
    let score = 0;
    for (const w of words) {
      if (head.includes(w)) score += 5;
      let i = body.indexOf(w), n = 0;
      while (i >= 0 && n < 20) { n++; i = body.indexOf(w, i + w.length); }
      score += n;
    }
    return { s, score };
  }).filter((x) => x.score > 0).sort((a, b) => b.score - a.score);
  return {
    query: input.query.slice(0, 120), matchingSections: scored.length,
    note: 'the project docs. They describe how the desk was built and measured; numbers in them are from when they were written, not live.',
    sections: scored.slice(0, limit).map(({ s }) => ({ file: s.file, heading: s.heading, text: clip(s.text, 3500) })),
    otherMatchingHeadings: scored.slice(limit, limit + 8).map(({ s }) => `${s.file}: ${s.heading}`),
  };
}

// ---------------------------------------------------------------- the tool list
// Byte-stable and in a fixed (name-sorted) order: tools render at the very front of the prompt, so
// any change here re-bills every cached conversation. Nothing per-request goes in a description.
const INT = (description) => ({ type: 'integer', description });
const STR = (description) => ({ type: 'string', description });
const DEFS = [
  {
    name: 'activity_log',
    description: 'The desk floor activity log: what each desk said and did, newest first (the last 500 lines). Call this for "what happened", "why did X do Y", recent halts, errors, fills and whale calls.',
    input_schema: { type: 'object', properties: {
      agent: { type: 'string', enum: AGENT_KEYS, description: 'only this desk' },
      kind: { type: 'string', enum: LOG_KINDS, description: 'only this kind of line' },
      contains: STR('only lines containing this text (case-insensitive)'),
      limit: INT('lines to return, 1-100, default 30'),
    } },
  },
  {
    name: 'closed_trades',
    description: 'Closed taker trades (one row per leg), newest first, with entry, exit, P&L and why each closed, plus the P&L total of the matching rows. Call this for results, wins and losses, or "how did we do today". For the maker desk use maker_status.',
    input_schema: { type: 'object', properties: {
      since: STR('only trades closed on or after this Eastern date (2026-09-14) or ISO time'),
      contains: STR('only markets whose name contains this text'),
      limit: INT('rows to return, 1-100, default 20'),
    } },
  },
  {
    name: 'desk_overview',
    description: 'The whole desk at a glance: paper or live, cash, equity and P&L for the taker book and the maker book, today\'s P&L, any halt, what each desk is doing, data and API health, Claude spend. Call this first for most questions about how the desk is doing.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'docs',
    description: 'Search the project docs (README.md and ops/DEPLOY.md) by keyword and return the best matching sections. Call this for how the strategy works, what a rule or setting means, why the desk rarely trades, the fee math, deployment, or the flatten and resume controls.',
    input_schema: { type: 'object', properties: {
      query: STR('a few keywords, e.g. "fee edge gap" or "flatten resume"'),
      limit: INT('sections to return, 1-4, default 2'),
    }, required: ['query'] },
  },
  {
    name: 'journal',
    description: 'The permanent journal for one Eastern day: every open, close, settle, failed exit, maker fill, flatten and resume, newest first, with counts by kind for the whole day. Call this for history older than the in-memory lists, exact event times, or counting events.',
    input_schema: { type: 'object', properties: {
      date: STR('Eastern date like 2026-09-14; default today'),
      kinds: { type: 'array', items: { type: 'string' }, description: 'only these kinds, e.g. ["OPEN","CLOSE","SETTLE","MAKER_FILL","EXIT_FAIL"]' },
      contains: STR('only lines containing this text'),
      limit: INT('entries to return, 1-200, default 40'),
    } },
  },
  {
    name: 'maker_status',
    description: 'The maker desk: its separate cash, equity and P&L, fills, inventory, recent fills, hourly P&L trend, feed health, and each market it quotes. Call this for any question about the maker, making, quotes or fills.',
    input_schema: { type: 'object', properties: {
      contains: STR('only markets whose ticker or title contains this text'),
      limit: INT('markets to return, 1-40, default 12'),
    } },
  },
  {
    name: 'markets',
    description: 'Matched markets (the same outcome on Polymarket and Kalshi) with live prices, the gap between venues, the best trade and its profit after fees, and the rule that stopped each one, plus a tally of why pairs are not trading. Call this for "why isn\'t it trading" or anything about a specific market\'s prices.',
    input_schema: { type: 'object', properties: {
      contains: STR('only pairs whose name, question, title or ticker contains this text'),
      limit: INT('pairs to return, 1-40, default 15'),
    } },
  },
  {
    name: 'open_positions',
    description: 'Open taker positions: each leg with entry, mark, sell price now and P&L, every locked arb with its health check and settlement value, and any Research verdicts. Call this for what the desk holds or whether a position has a problem.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'settings',
    description: 'Current values of the desk\'s non-secret settings with what each means (thresholds, risk limits, caps, models, spend caps), and whether each secret is present (never its value). Call this for "what is the limit on X" or "is Y switched on".',
    input_schema: { type: 'object', properties: {
      contains: STR('only settings whose name or meaning contains this text'),
    } },
  },
  {
    name: 'whale_bets',
    description: 'Whale watch: big bets by top wallets on the Polymarket leaderboards the desk follows (sports, politics, economics, crypto and more), which the desk announces but never trades on. Recent calls by default, or everything recorded for one Eastern day.',
    input_schema: { type: 'object', properties: {
      date: STR('Eastern date like 2026-09-14 to read that day\'s record; omit for the most recent calls'),
      limit: INT('bets to return, 1-50, default 10'),
    } },
  },
];

const RUN = {
  activity_log: activityLog, closed_trades: closedTrades, desk_overview: deskOverview, docs, journal,
  maker_status: makerStatus, markets, open_positions: openPositions, settings, whale_bets: whaleBets,
};

// What the dashboard shows while a tool runs. Plain words; the page escapes them.
function stepFor(name, input = {}) {
  const i = input || {};
  const q = (v) => clip(String(v).replace(/\s+/g, ' ').trim(), 60);
  switch (name) {
    case 'desk_overview': return 'reading the desk overview';
    case 'open_positions': return 'reading open positions';
    case 'closed_trades': return `reading closed trades${i.since ? ` since ${q(i.since)}` : ''}${i.contains ? ` for "${q(i.contains)}"` : ''}`;
    case 'activity_log': return `reading the activity log${i.agent ? ` for ${q(i.agent)}` : ''}${i.contains ? ` for "${q(i.contains)}"` : ''}`;
    case 'journal': return `reading the journal for ${i.date ? q(i.date) : 'today'}`;
    case 'markets': return `reading matched markets${i.contains ? ` for "${q(i.contains)}"` : ''}`;
    case 'maker_status': return 'reading the maker desk';
    case 'whale_bets': return 'reading whale bets';
    case 'settings': return 'reading the settings';
    case 'docs': return `searching the docs: ${q(i.query || '')}`;
    default: return `using ${q(name)}`;
  }
}

// Run one tool. Resolves to the finished, bounded, scrubbed text; rejects with a readable error
// for a bad argument or an unknown tool, which src/ask.js returns to the model as is_error.
async function runTool(E, name, input, now = Date.now(), env = process.env) {
  const fn = Object.prototype.hasOwnProperty.call(RUN, name) ? RUN[name] : null;
  if (!fn) throw new Error(`there is no tool called ${clip(name, 40)}`);
  const args = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const out = await fn(E, args, now);
  return bounded(redact(JSON.stringify(out), secretValues(E, env)));
}

// RUN is exported so tools/ask-test.js can check the whitelist on its own, without the scrub.
module.exports = { DEFS, RUN, runTool, stepFor, secretValues, redact, bounded, et, SETTINGS, MAX_OUT };

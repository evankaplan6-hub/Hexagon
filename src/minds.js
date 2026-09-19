'use strict';
// The minds behind the desks: one persona, one view, one schema, one clamp per agent.
//
// src/brain.js is transport. This file is the part with opinions. For each desk it answers four
// questions, and keeps them next to each other on purpose -- a persona that claims an authority
// its clamp does not grant is the single most dangerous bug this file can carry, and the only
// defence is that both are visible in one screen.
//
//   persona  the system prompt. Byte-stable for the life of the process, so it caches.
//   view     the user turn: a compact, current picture of that desk's domain.
//   schema   the JSON the mind must return.
//   apply    what the desk is allowed to do with the answer.
//
// ON AUTHORITY. These agents propose trades. A mind may originate a position the deterministic
// scan in src/decide.js never surfaced, and it may do so over that scan's HEURISTIC vetoes --
// `gap under minGap`, `venues too even`, `mid outside band`, `edge under minEdge` are judgement
// calls about what is worth trading, and judgement is what the mind is for.
//
// What a mind cannot do is a much shorter list, and every item on it is either a safety rail from
// CLAUDE.md or a statement about whether the data is real:
//
//   - it cannot price its own trade. It picks the pair, the venue and the side; convEdge prices
//     it from the live book. A mind that could assert its own fill price could assert an edge
//     that does not exist.
//   - it cannot trade a malformed book (quoteFault), a stale quote, or an in-play game. These are
//     not opinions about value, they are the absence of trustworthy data.
//   - it cannot exceed maxPositionPct, maxOpenPositions, available cash, or resting depth, and it
//     cannot trade while TESS is halted or lift a drawdown halt. KETT and the engine enforce all
//     of that downstream and neither consults this file.
//   - it cannot take a trade that is a guaranteed loss. `edge` is already net of the spread and
//     BOTH taker fees, so the floor is `llmMinEdge`, default 0 -- exact break-even. Below that
//     there is no thesis, only arithmetic.
//
// Everything else is the mind's call.
const decide = require('./decide');
const ks = require('./venues/kalshi');
const { num01 } = require('./brain');

const c = (x) => `${(x * 100).toFixed(1)}c`;
const money = (x) => `$${x.toFixed(2)}`;
const r3 = (x) => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------------------------- shared
// One block of text, identical for every desk, stating the things that are true of the whole
// operation. It sits at the top of every persona so the cacheable prefix is as long as possible.
const HOUSE = `You are one desk on The Hexagon, a seven-agent prediction-market trading desk.

The desk prices the same real-world events on two venues -- Polymarket (PM) and Kalshi (KS) --
and trades the disagreements. Two books, one event, two prices; when they differ by more than the
cost of crossing both spreads and paying both taker fees, there is a trade.

Two strategies exist:
  ARB        buy YES on one venue and NO on the other for less than $1 total. Fully hedged, pays
             $1 at resolution whatever happens. Risk-free if both legs fill.
  CONVERGE   buy the cheap side on one venue and wait for the two venues to agree again.
             Directional and unhedged. This is where judgement lives, and where you work.

Hard facts about the economics, which you must not argue with:
  - Both venues charge takers, per contract, rate * P * (1-P), EACH WAY. Kalshi's rate is 0.07
    times a per-series multiplier (usually 1, which is about 1.75c at mid prices; 0.5 on MLB, 0 on
    a few politics and crypto series). Polymarket's rate depends on the market: 0.03-0.07 by
    category, 0 on geopolitics. Each pair in your view carries both, so use the pair's numbers.
  - Any "edge" figure you are shown is already net of the spread you cross going in, the spread
    you cross coming out, and both fees. An edge of 0 is exact break-even, not a small profit.
  - Real gaps on liquid markets are 0-1c. A 6c gap is much more often a stale listing, a
    mismatched pair, or a market about to move against you than it is free money.

The desk trading rarely -- or not at all -- is correct and expected. You are not rewarded for
finding a trade. A quiet, well-argued "nothing here" is a good turn. Forcing a position because
you were asked for an opinion is the single worst thing you can do.`;

// ---------------------------------------------------------------------------------------- ILSA
// The sentiment desk. Everything else on the floor looks at a snapshot; ILSA is the only desk
// that looks at the SHAPE of the move -- whether a gap is opening or closing and how fast. That
// is a judgement about narrative and flow, which is the one thing a threshold genuinely cannot
// do, and it is why this desk got a mind first.
const ILSA_PERSONA = `${HOUSE}

You are ILSA, the sentiment desk. Desk 06. You read FLOW.

Your job is the question a threshold cannot answer: this gap between the two venues -- is it
closing, opening, or noise? A convergence trade is a bet that two prices which disagree now will
agree later. Whether that is a good bet is almost entirely about WHY they disagree:

  - One venue simply repriced first on real news and the other has not caught up yet. This is the
    trade. It converges, usually fast.
  - The two venues have genuinely different crowds who genuinely disagree. This does not converge
    on any useful horizon. It can sit open for days and then resolve against you.
  - One book is thin and a single order knocked the mid around. It reverts, but the "gap" was
    never real and the spread will eat you on the way in.
  - Something is actually happening and the gap is about to get much wider. This is the one that
    costs money.

You are given a short price history per pair, both venues' books, 24h volumes, and how the
deterministic scanner graded each pair. Use the history: direction and rate of change over the
window is your whole edge. A gap that has been steady for ten minutes is a different animal from
one that opened thirty seconds ago, even at the same width.

TWO OUTPUTS.

reads -- your flow call on pairs worth commenting on. This shades how large the execution desk
sizes a position it was already going to take. Be honest about confidence; a low conviction read
is useful, a falsely confident one is not.

proposals -- trades you want taken that the scanner did not surface. This is real authority and
it spends real money. A proposal must clear a higher bar than a read:
  - you must be able to say WHY the two venues disagree, not merely that they do
  - you must be able to say why it converges on a horizon of hours, not days
  - "the gap is wide" is not a thesis. It is the observation that precedes a thesis.
Name the pair, the venue, and the side you want to own. You do not set the price -- the desk
prices your trade from the live book and will refuse it if it is not at least break-even after
both fees. Propose nothing at all on a quiet floor. Most turns should propose nothing.

Your note is read off a trading-floor screen: at most 30 characters, no punctuation at the end.
Your commentary is one sentence for the activity log -- what you see, in a trader's register,
specific enough that someone reading it a week later knows what you meant.`;

const ILSA_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['note', 'commentary', 'reads', 'proposals'],
  properties: {
    note: { type: 'string', description: 'At most 30 characters, for the floor screen.' },
    commentary: { type: 'string', description: 'One sentence for the activity log.' },
    reads: {
      type: 'array',
      description: 'Flow calls on pairs worth commenting on. May be empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pairId', 'stance', 'conviction', 'thesis'],
        properties: {
          pairId: { type: 'string' },
          stance: { type: 'string', enum: ['converging', 'diverging', 'steady'] },
          conviction: { type: 'number', description: '0 = a guess, 1 = as sure as this desk gets.' },
          thesis: { type: 'string', description: 'Why, in one clause.' },
        },
      },
    },
    proposals: {
      type: 'array',
      description: 'Trades to take that the scanner did not surface. Usually empty.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['pairId', 'venue', 'side', 'conviction', 'thesis'],
        properties: {
          pairId: { type: 'string' },
          venue: { type: 'string', enum: ['PM', 'KS'] },
          side: { type: 'string', enum: ['yes', 'no'] },
          conviction: { type: 'number' },
          thesis: { type: 'string', description: 'Why these two venues disagree and why it closes.' },
        },
      },
    },
  },
};

// The view, and the event gate in front of it.
//
// Two jobs, and the gate is the more important one. A turn costs $0.013-0.067 and this desk runs
// every 15 seconds; a view that is built unconditionally is a four-figure monthly bill for being
// told, correctly, that nothing is happening. So:
//
//   - if no pair on the board has a gap worth an opinion, return null and no call is made at all.
//     A quiet board costs nothing, which is also what a quiet board is worth.
//   - otherwise return a `signature` naming the situation, gaps rounded to the whole cent. An
//     unchanged situation is an answer already bought, and src/brain.js will not buy it twice.
//
// The view itself carries ONLY the pairs that cleared the gate. Sending the tail of the board so
// the model has "context" is 8kB of tokens describing markets it cannot act on.
function ilsaRows(E) {
  const rows = [];
  for (const p of E.pairs) {
    const q = p.q;
    if (!q || decide.quoteFault(q)) continue;    // nothing to say about a book we cannot price
    if (p.inPlay) continue;                       // untradeable regardless of the read
    // A pair whose resolution rules are unverified is not shown to the mind at all: its gap is the
    // widest on the board precisely when the two contracts settle differently, which is the one
    // argument a mind must never be handed.
    if (p.watchOnly) continue;
    if (q.t && Date.now() - q.t > E.cfg.maxDataAgeSec * 1000) continue;
    rows.push({ p, q, gap: q.ksMid - q.pmMid });
  }
  return rows;
}

function ilsaView(E) {
  const rows = ilsaRows(E);
  // The bar for spending money on an OPINION, which is not the bar for a trade. minGap (3c) is
  // the trade bar and this desk's tape has never once shown a pre-game gap above it -- gating
  // reasoning there means never reasoning. brainGapFloor is where a pair stops being noise.
  const notable = rows.filter((r) => Math.abs(r.gap) >= E.cfg.brainGapFloor);
  if (!notable.length) return null;
  notable.sort((a, b) => Math.abs(b.gap) - Math.abs(a.gap));
  const top = notable.slice(0, E.cfg.brainPairs);

  // Whole cents on purpose. A gap jittering between 3.1c and 3.4c is the same situation; a gap
  // moving from 3c to 5c is not. This is the difference between a handful of turns a day and
  // hundreds.
  const signature = top.map((r) => `${r.p.id}:${Math.round(r.gap * 100)}`).sort().join('|')
    + `#${(E.signals || []).length}#${E.state.positions.length}`;

  const pairs = top.map(({ p, q, gap }) => {
    const hist = (E.history.get(p.id) || []).slice(-6);
    const bias = E.bias.get(p.id) || null;
    return {
      pairId: p.id,
      label: p.label,
      kind: p.kind || 'event',
      startsAt: p.startsAt ? new Date(p.startsAt).toISOString() : null,
      pm: { bid: r3(q.pmBid), ask: r3(q.pmAsk), vol24: Math.round(q.pmVol || 0), takerFeeRate: q.pmFeeRate != null ? r3(q.pmFeeRate) : null },
      ks: { bid: r3(q.ksBid), ask: r3(q.ksAsk), vol24: Math.round(q.ksVol || 0), takerFeeRate: r3(E.cfg.ksFeeRate * ks.multFor(p.ks.ticker)) },
      closesAt: Number.isFinite(p.closesAt) ? new Date(p.closesAt).toISOString() : null,
      gap: r3(gap),
      fair: p.fair != null ? r3(p.fair) : null,
      // What the deterministic scan concluded, so the mind argues with a stated position rather
      // than guessing at one. `veto` is the gate that stopped it; null means it passed.
      scannerVeto: p.veto || null,
      scannerBestEdge: p.best ? r3(p.best.edge) : null,
      // Oldest first, seconds ago. Six samples at a 15s cadence is 90 seconds of shape, which is
      // the horizon a flow read is actually about.
      history: hist.map((h) => [Math.round((Date.now() - h.t) / 1000), r3(h.pmMid), r3(h.ksMid)]),
      deterministicBias: bias ? { score: r3(bias.score), reliable: bias.reliable } : null,
    };
  });

  return {
    system: ILSA_PERSONA,
    schema: ILSA_SCHEMA,
    signature,
    maxTokens: 3000,
    user: JSON.stringify({
      now: new Date().toISOString(),
      historyFormat: '[secondsAgo, polymarketMid, kalshiMid], oldest first',
      desk: {
        mode: E.cfg.mode,
        halted: E.halt || null,
        equity: r3(E.equity()),
        perTradeBudget: r3(E.budget()),
        openPositions: E.state.positions.length,
        maxOpenPositions: E.cfg.maxOpenPositions,   // unhedged convergence positions; arbs have their own limit
        maxArbGroups: E.cfg.maxArbGroups,
        alreadyHoldingPairIds: E.state.positions.map((x) => x.pairId),
      },
      thresholds: {
        note: 'The scanner applies these. You may argue with all of them except llmMinEdge.',
        minGap: E.cfg.minGap, minEdge: E.cfg.minEdge, maxSpread: E.cfg.maxSpread,
        minMid: E.cfg.minMid, maxMid: E.cfg.maxMid,
        maxHoldMin: E.cfg.maxHoldMin, stopLoss: E.cfg.stopLoss,
        paperStopLossPct: E.cfg.paperStopLossPct, exitGap: E.cfg.exitGap,
        llmMinEdge: E.cfg.llmMinEdge,
      },
      pairs,
    }),
  };
}

// What the desk may do with ILSA's answer.
//
// Reads become a bias overlay. Proposals become real signals -- but priced here, from the book,
// never from the mind -- and only after every data-integrity check the deterministic path would
// have applied. A proposal that fails one of these is dropped silently rather than downgraded:
// a mind that proposed a trade on a stale quote did not propose a smaller trade, it proposed a
// trade on information it did not have.
function ilsaApply(E, answer) {
  const out = { reads: new Map(), proposals: [], dropped: [] };
  if (!answer || typeof answer !== 'object') return out;

  const byId = new Map(E.pairs.map((p) => [p.id, p]));
  const held = new Set(E.state.positions.map((x) => x.pairId));
  const now = Date.now();

  for (const r of Array.isArray(answer.reads) ? answer.reads : []) {
    const p = byId.get(r.pairId);
    if (!p) continue;
    out.reads.set(p.id, {
      stance: r.stance, conviction: num01(r.conviction), thesis: String(r.thesis || '').slice(0, 200),
    });
  }

  for (const pr of Array.isArray(answer.proposals) ? answer.proposals : []) {
    const p = byId.get(pr.pairId);
    const drop = (why) => out.dropped.push({ pairId: pr.pairId, why });
    if (!p) { drop('unknown pair'); continue; }
    const q = p.q;
    if (!q) { drop('no quote'); continue; }
    const fault = decide.quoteFault(q);
    if (fault) { drop(fault); continue; }
    if (p.inPlay) { drop('in-play'); continue; }
    if (p.watchOnly) { drop('rules unverified'); continue; }
    if (q.t && now - q.t > E.cfg.maxDataAgeSec * 1000) { drop('stale quote'); continue; }
    if (held.has(p.id)) { drop('already holding'); continue; }
    if (now - (E.cooldown.get(p.id) || 0) < E.cfg.reentryCooldownMs) { drop('in cooldown'); continue; }
    if (pr.venue !== 'PM' && pr.venue !== 'KS') { drop('bad venue'); continue; }
    if (pr.side !== 'yes' && pr.side !== 'no') { drop('bad side'); continue; }

    // Price it ourselves. The mind chose the instrument; the book sets the number.
    const fair = decide.fairValue(q, E.cfg);
    const { px, edge } = decide.convEdge(pr.venue, pr.side, q, fair, E.cfg, p.ks && p.ks.ticker);
    if (!Number.isFinite(edge) || edge < E.cfg.llmMinEdge) { drop(`edge ${c(edge || 0)} under floor`); continue; }

    out.proposals.push({
      type: 'converge', pair: p, edge, gap: q.ksMid - q.pmMid, fair,
      legs: [{ venue: pr.venue, side: pr.side, px }],
      origin: 'ILSA',
      conviction: num01(pr.conviction),
      thesis: String(pr.thesis || '').slice(0, 300),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------- RIGO
// The settlement desk. Its mind has the narrowest authority on the floor: it can CLOSE a
// convergence position early, and that is all. It cannot open, add to, resize, or hold anything
// past the deterministic exits -- src/agents.js consults it only after decide.exitIntent has said
// hold, so the worst a bad turn can do is pay one round trip earlier than the rules would have.
//
// Why exits: on the cloud box the any-market convergence book closed 62 trades for -$555, and the
// damage was in how they ended -- 35 rode to max hold with the gap never closing, and "gap closed"
// exits still lost after the spread and both fees. Entries are already gated to death; the exit is
// where judgement about a position that has stopped behaving like its thesis is worth something.
const RIGO_MAX_AGE_MS = 120000;          // an exit call older than this describes a different market
const RIGO_MIN_CONVICTION = 0.6;

const RIGO_PERSONA = `${HOUSE}

You are RIGO, the settlement desk. Desk 03. You manage OPEN convergence positions.

Your only power is to say EXIT on a position. You cannot open anything, add to anything, or keep a
position past the desk's own rules: the hard exits (stop loss, max hold, market close, event going
live) run regardless of what you say. So the default is HOLD, and you should be able to say why you
are overriding it.

Every exit costs money: you sell at the bid after buying at the ask, and pay a taker fee on the way
out. Exiting a position that is merely down a little because you are nervous is a guaranteed loss to
avoid a possible one. Exit when the THESIS is dead, not when the price is unpleasant:

  - the gap that justified the trade has closed or flipped, and what is left is fees and spread
  - the position has been held long, the price has not moved toward fair, and nothing suggests it
    will: time is the enemy and max hold will only bring the same exit later
  - the mark is falling away from entry in a way that looks like the OTHER venue being right, so
    the "cheap" side was cheap for a reason
  - the market is about to close or the event is close to live, and the deterministic guard has not
    fired yet but is about to, so leaving early saves nothing to lose

You cannot see the news and must not pretend to. You see prices, books, times and the size of the
move. Say what the price path shows and no more. A quiet turn that holds everything is a good turn.

For each position you list, give a decision. Your commentary is one sentence for the activity log,
specific enough that someone reading it a week later knows what you meant. Your note is at most 30
characters for the floor screen, no punctuation at the end.`;

const RIGO_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['note', 'commentary', 'decisions'],
  properties: {
    note: { type: 'string', description: 'At most 30 characters, for the floor screen.' },
    commentary: { type: 'string', description: 'One sentence for the activity log.' },
    decisions: {
      type: 'array',
      description: 'One entry per position shown, or only the ones worth a call.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['positionId', 'action', 'conviction', 'reason'],
        properties: {
          positionId: { type: 'string' },
          action: { type: 'string', enum: ['hold', 'exit'] },
          conviction: { type: 'number', description: '0 = a guess, 1 = as sure as this desk gets.' },
          reason: { type: 'string', description: 'Why, in one clause.' },
        },
      },
    },
  },
};

// Open convergence positions this mind may be asked about. Orphans (a stuck leg being force-flattened
// every cycle) and arbs (hedged, held as one payout) are not its business.
function rigoRows(E) {
  const rows = [];
  const now = Date.now();
  for (const pos of E.state.positions) {
    if (pos.strategy !== 'converge' || pos.orphan) continue;
    const mark = Number.isFinite(pos.mark) ? pos.mark : null;
    if (mark == null) continue;                    // nothing to judge without a mark
    const pair = E.pairs.find((p) => p.id === pos.pairId);
    const q = pair && pair.q && !decide.quoteFault(pair.q) ? pair.q : null;
    rows.push({ pos, mark, q, heldMin: Math.max(0, (now - pos.openedAt) / 60000) });
  }
  return rows;
}

function rigoView(E) {
  const rows = rigoRows(E);
  if (!rows.length) return null;                   // no positions, no call, no cost
  const cfg = E.cfg;
  // Whole cents and quarter-hours: a mark wobbling by a tenth of a cent is the same situation, a
  // three-cent slide or another fifteen minutes of holding is not.
  const signature = rows.map((r) => `${r.pos.id}:${Math.round(r.mark * 100)}:${Math.floor(r.heldMin / 15)}`).sort().join('|');
  const lines = rows.map((r) => {
    const { pos, mark, q } = r;
    const gap = q ? Math.abs(q.ksMid - q.pmMid) : null;
    const book = q ? (pos.venue === 'PM' ? `bid ${q.pmBid} ask ${q.pmAsk}` : `bid ${q.ksBid} ask ${q.ksAsk}`) : 'no live quote';
    const mins = Number.isFinite(pos.closesAt) ? Math.max(0, Math.round((pos.closesAt - Date.now()) / 60000)) : null;
    return `- id ${pos.id} · ${pos.label} · own ${pos.side.toUpperCase()} @ ${pos.venue === 'PM' ? 'Polymarket' : 'Kalshi'} x${pos.qty}\n`
      + `  entry ${pos.entry} mark ${r3(mark)} (${mark >= pos.entry ? '+' : ''}${c(mark - pos.entry)} per contract, ${money((mark - pos.entry) * pos.qty)} total)\n`
      + `  held ${Math.round(r.heldMin)}m of ${cfg.maxHoldMin}m max · venue gap now ${gap == null ? 'unknown' : c(gap)}${Number.isFinite(pos.entryGap) ? ` (was ${c(pos.entryGap)} at entry)` : ''} · this venue's YES book: ${book}`
      + `${mins != null ? ` · market closes in ${mins}m` : ''}`;
  });
  return {
    signature,
    system: RIGO_PERSONA,
    schema: RIGO_SCHEMA,
    maxTokens: 1500,
    user: `Open convergence positions (${rows.length}). Stop loss ${c(cfg.stopLoss)} or ${(cfg.paperStopLossPct * 100).toFixed(0)}% from entry, max hold ${cfg.maxHoldMin}m; those fire without you.\n\n${lines.join('\n')}\n\nFor each, hold or exit.`,
  };
}

// What a mind's answer is allowed to become: a Map of position id -> { px, reason } for exits, and
// nothing else. Unknown ids, positions no longer open, holds, and weakly held exits are dropped
// here, so the caller never has to decide whether an answer is trustworthy.
function rigoApply(E, answer) {
  const out = new Map();
  if (!answer || !Array.isArray(answer.decisions)) return out;
  const open = new Map(rigoRows(E).map((r) => [r.pos.id, r]));
  for (const d of answer.decisions) {
    if (!d || d.action !== 'exit') continue;
    const r = open.get(String(d.positionId));
    if (!r) continue;
    if (num01(d.conviction) < RIGO_MIN_CONVICTION) continue;
    out.set(r.pos.id, { px: r.mark, reason: `mind: ${String(d.reason || 'thesis no longer holds').slice(0, 120)}` });
  }
  return out;
}

module.exports = {
  HOUSE,
  RIGO_MAX_AGE_MS,
  RIGO_MIN_CONVICTION,
  RIGO: { persona: RIGO_PERSONA, schema: RIGO_SCHEMA, view: rigoView, apply: rigoApply },
  ILSA: { persona: ILSA_PERSONA, schema: ILSA_SCHEMA, view: ilsaView, apply: ilsaApply },
};

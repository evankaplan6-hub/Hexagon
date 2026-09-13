'use strict';
// Operator research: the "Research" button on a dashboard alert.
//
// An alert means a person has a decision to make about one position -- sell it now, or hold it to
// settlement -- and the desk's own numbers are not enough to make it. A broken arb's mark says what
// the leg would fetch, not WHY: whether the match has been played, whether the market has already
// resolved, whether the other venue was even pricing the same event. So this gathers everything
// the desk knows about the group, re-reads both venues live, and asks Claude -- with web search,
// for the real-world side -- for a one-sentence verdict: sell, hold, or hedge.
//
// Same three promises as src/brain.js, for the same reasons:
//   1. It never blocks a cycle. start() returns at once; the answer lands in snapshot() later.
//   2. It never throws into a cycle or the server. Every failure becomes the job's `error`.
//   3. It never trades. The answer is advice for a person; selling is a separate, confirmed POST.
//
// It runs only on a click, so it has its own daily cap (RESEARCH_DAILY_USD) instead of drawing on
// the desks' paced budget.
const pm = require('./venues/polymarket');
const ks = require('./venues/kalshi');
const { priceFor } = require('./brain');

const WEB_SEARCH_USD = 0.01;      // $10 per 1,000 searches
const MAX_CONTINUATIONS = 4;      // pause_turn resumes when the server-side search loop runs long
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const iso = (t) => (t ? new Date(t).toISOString() : null);

// Byte-stable, so it caches across reports. The operator wants a verdict, not a report: one of
// three actions and one sentence, so the model is told to search only as much as that needs.
const SYSTEM = `You are the research desk for The Hexagon, a trading desk that prices the same events on Polymarket and Kalshi and trades when they disagree.

An operator clicked "Research" on an alert about one position and needs a fast verdict. You get everything the desk knows: legs still held, what they cost, what they sell for now, legs already closed, and each market's live venue data.

If the real-world event matters (has the game been played? what was the score? are the two venues' markets even the same event?), do at most one or two quick web searches. Then pick exactly one action:
- sell: sell what is held now at the sell price given
- hold: keep it until the market settles
- hedge: buy the opposite side on the other venue so the position is covered again

Reply with one JSON object and nothing else, no code fences:
{"action": "sell" | "hold" | "hedge", "sentence": "ONE plain-English sentence, under 30 words, saying why, with the key dollar figure", "confidence": "low" | "medium" | "high"}`;

class Research {
  constructor(cfg, engine) {
    this.cfg = cfg;
    this.E = engine;
    this.jobs = new Map();          // group id -> job; process-local, like the brain's answers
    this.day = ET_DAY.format(new Date());
    this.daySpend = 0;
    this.fallbacks = true;          // dropped for good if this deployment rejects the parameter
  }

  _rollDay() {
    const k = ET_DAY.format(new Date());
    if (k !== this.day) { this.day = k; this.daySpend = 0; }
  }

  // Kick off a report for one group. Returns { ok, error? } immediately.
  start(groupId) {
    if (!this.cfg.researchEnabled) return { ok: false, error: 'research is switched off (RESEARCH=0)' };
    if (!this.E.brain.key) return { ok: false, error: 'no ANTHROPIC_API_KEY in .env' };
    const cur = this.jobs.get(groupId);
    if (cur && cur.status === 'running') return { ok: true, running: true };
    this._rollDay();
    if (this.daySpend >= this.cfg.researchDailyUsd) {
      return { ok: false, error: `today's research budget is spent ($${this.daySpend.toFixed(2)} of $${this.cfg.researchDailyUsd.toFixed(2)})` };
    }
    const known = this.E.state.positions.some((p) => p.group === groupId) || this.E.state.arbGroups[groupId];
    if (!known) return { ok: false, error: 'no position with that id' };

    const job = { status: 'running', startedAt: Date.now(), usd: 0, searches: 0 };
    this.jobs.set(groupId, job);
    if (this.jobs.size > 20) this.jobs.delete(this.jobs.keys().next().value);
    const label = (this.E.state.positions.find((p) => p.group === groupId) || this.E.state.arbGroups[groupId] || {}).label || groupId;
    this.E.log('RIGO', 'OPS', null, `researching ${label} for the operator`);
    this._run(groupId, job)
      .then((out) => {
        Object.assign(job, out, { status: 'done' });
        const r = out.result || {};
        this.E.journal(this.E, 'RESEARCH', { group: groupId, usd: job.usd, searches: job.searches, action: r.action, sentence: r.sentence, confidence: r.confidence });
        this.E.log('RIGO', 'OPS', null, `research on ${label}: ${r.action ? `${r.action.toUpperCase()} · ` : ''}${r.sentence || 'see the alert'}`);
      })
      .catch((e) => { job.status = 'error'; job.error = String((e && e.message) || e).slice(0, 240); })
      .finally(() => { job.finishedAt = Date.now(); });
    return { ok: true };
  }

  // Everything the desk knows about one group, plus a live read of every market it touched.
  async facts(groupId) {
    const E = this.E;
    const open = E.state.positions.filter((p) => p.group === groupId);
    const closed = E.state.closed.filter((c) => c.group === groupId);
    const score = E.arbScorecard().find((g) => g.id === groupId) || null;
    const markets = [];
    const seen = new Set();
    // An arb's pair id names both markets ("<pmId>:<tokenIndex>|<ksTicker>"). Reading the side that
    // is NOT held is what makes "hedge" a priced option instead of a guess.
    const pairId = (score && score.pairId) || (E.state.arbGroups[groupId] || {}).pairId || '';
    const [pmPart, ksTicker] = String(pairId).split('|');
    const pairLegs = [];
    if (ksTicker) pairLegs.push({ venue: 'KS', ref: ksTicker });
    if (pmPart) pairLegs.push({ venue: 'PM', pmId: pmPart.split(':')[0] });
    for (const p of [...open, ...closed, ...pairLegs]) {
      const key = p.venue === 'KS' ? `KS:${p.ref}` : `PM:${p.pmId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        if (p.venue === 'KS') {
          const m = await ks.fetchMarket(p.ref);
          markets.push(m ? { venue: 'Kalshi', ticker: p.ref, title: m.title, outcome: m.subTitle, status: m.status, result: m.result || null, yesBid: m.yesBid, yesAsk: m.yesAsk, last: m.last, closeTime: m.closeTime, url: m.url } : { venue: 'Kalshi', ticker: p.ref, error: 'market not found' });
        } else {
          const m = await pm.fetchMarket(p.pmId);
          markets.push(m ? { venue: 'Polymarket', id: p.pmId, question: m.question, event: m.eventTitle, outcomes: m.outcomes, prices: m.prices, bestBid: m.bestBid, bestAsk: m.bestAsk, closed: m.closed, resolved: m.resolved, endDate: m.endDate, gameStart: m.gameStart, url: m.url } : { venue: 'Polymarket', id: p.pmId, error: 'market not found' });
        }
      } catch (e) { markets.push({ venue: p.venue, error: String(e.message).slice(0, 100) }); }
    }
    return {
      now: iso(Date.now()),
      account: E.cfg.mode === 'live' ? 'LIVE (real money)' : 'paper (no real money)',
      label: (open[0] || closed[0] || E.state.arbGroups[groupId] || {}).label || null,
      alert: score ? { integrity: score.integrity, entryCost: score.entryCost, valueIfSoldNow: score.liquidationValue, pnlIfSoldNow: score.liquidationPnl, lockedPnlAtSettlement: score.lockedPnl } : null,
      stillHeld: open.map((p) => ({
        venue: p.venue === 'KS' ? 'Kalshi' : 'Polymarket', side: p.side.toUpperCase(), contracts: p.qty,
        entryPrice: p.entry, cost: p.cost, sellPriceNow: E.venueMark(p) ?? p.mark ?? p.entry,
        proceedsIfSoldNow: r2(p.qty * (E.venueMark(p) ?? p.mark ?? p.entry)), payoutIfSideWins: p.qty, openedAt: iso(p.openedAt),
      })),
      alreadyClosed: closed.map((c) => ({
        venue: c.venue === 'KS' ? 'Kalshi' : 'Polymarket', side: c.side.toUpperCase(), contracts: c.qty,
        entryPrice: c.entry, exitPrice: c.exit, pnl: c.pnl, reason: c.reason, closedAt: iso(c.exitAt),
      })),
      markets,
    };
  }

  async _run(groupId, job) {
    const f = await this.facts(groupId);
    const model = this.cfg.researchModel;
    const user = `Alert on: ${f.label}\n\nEverything the desk knows, as JSON:\n${JSON.stringify(f, null, 1)}`;
    const body = {
      model,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'low' },   // a one-sentence verdict; speed matters more than depth
      system: [{ type: 'text', text: SYSTEM, cache_control: { type: 'ephemeral' } }],
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: 2 }],
      messages: [{ role: 'user', content: user }],
    };
    const assistant = [];
    const sources = new Map();
    let res;
    for (let i = 0; ; i++) {
      res = await this._post(body);
      this._meter(job, res);
      for (const b of res.content || []) {
        assistant.push(b);
        if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
          for (const r of b.content) if (r.url && !sources.has(r.url)) sources.set(r.url, r.title || r.url);
        }
      }
      if (res.stop_reason === 'refusal') throw new Error('the model declined to research this');
      // A long server-side search loop pauses rather than finishing; resend the turn so far and the
      // server picks up where it stopped. No "continue" message -- it resumes from the content.
      if (res.stop_reason === 'pause_turn' && i < MAX_CONTINUATIONS) {
        body.messages = [body.messages[0], { role: 'assistant', content: assistant.slice() }];
        continue;
      }
      break;
    }
    const text = assistant.filter((b) => b.type === 'text').map((b) => b.text).join('');
    return { result: parseAnswer(text), sources: [...sources].slice(0, 8).map(([url, title]) => ({ url, title })), model: res.model || model };
  }

  async _post(body) {
    const send = (withFallbacks) => this.E.brain._post(
      withFallbacks ? { ...body, fallbacks: 'default' } : body,
      this.cfg.researchTimeoutMs,
      withFallbacks ? { 'anthropic-beta': FALLBACK_BETA } : {},
    );
    if (!this.fallbacks) return send(false);
    try { return await send(true); }
    catch (e) {
      if (e.status === 400 && /fallback/i.test(e.message)) { this.fallbacks = false; return send(false); }
      throw e;
    }
  }

  _meter(job, res) {
    const u = res && res.usage;
    if (!u) return;
    const p = priceFor(res.model || this.cfg.researchModel);
    const searches = (u.server_tool_use && u.server_tool_use.web_search_requests) || 0;
    const usd = (u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output
      + (u.cache_read_input_tokens || 0) * p.cacheRead + (u.cache_creation_input_tokens || 0) * p.cacheWrite
      + searches * WEB_SEARCH_USD;
    job.usd = r4(job.usd + usd);
    job.searches += searches;
    this._rollDay();
    this.daySpend = r4(this.daySpend + usd);
  }

  snapshot() {
    this._rollDay();
    return {
      enabled: !!(this.cfg.researchEnabled && this.E.brain.key),
      dayUsd: this.daySpend,
      dayCap: this.cfg.researchDailyUsd,
      jobs: Object.fromEntries([...this.jobs].map(([id, j]) => [id, {
        status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt || null, usd: j.usd, searches: j.searches,
        model: j.model || null, result: j.result || null, sources: j.sources || [], error: j.error || null,
      }])),
    };
  }
}

// The answer is JSON in prose mode (web search results carry citations, which structured outputs
// refuse), so take the outermost object and tolerate a fence or a stray sentence around it. The
// action is checked against the three the panel knows how to show.
const ACTIONS = ['sell', 'hold', 'hedge'];
function parseAnswer(text) {
  const t = String(text || '');
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) {
    try {
      const o = JSON.parse(t.slice(a, b + 1));
      if (o && typeof o === 'object') {
        return {
          action: ACTIONS.includes(String(o.action).toLowerCase()) ? String(o.action).toLowerCase() : null,
          sentence: String(o.sentence || '').trim(),
          confidence: ['low', 'medium', 'high'].includes(o.confidence) ? o.confidence : null,
        };
      }
    } catch { /* fall through */ }
  }
  return { action: null, sentence: t.replace(/\s+/g, ' ').trim().slice(0, 300) || 'No answer came back.', confidence: null };
}

module.exports = { Research, parseAnswer };

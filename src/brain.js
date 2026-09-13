'use strict';
// The Claude layer: what makes the desks agents rather than functions.
//
// Every desk in src/agents.js is a deterministic function of its inputs. That is the right shape
// for the parts that move money -- it is testable, replayable and auditable -- but it is not a
// trader. This module gives each desk a mind: a persona, a compact view of its own domain, and a
// structured answer it is accountable for. src/minds.js owns the personas and schemas; this file
// owns the transport, the cadence and the money it costs.
//
// ---------------------------------------------------------------------------------------------
// WHY THERE IS NO TIMER
//
// The first version of this file fired a turn per desk per cycle. Measured on a realistic 12-pair
// board that is $0.067 a turn and 20 seconds of latency -- $384/day for ONE desk at a 15s cycle,
// and about $80,000/month for seven. Dropping to Sonnet and halving the view got that to $4,000.
// The model was never the problem. The timer was.
//
// This desk's whole premise, stated plainly in its README, is that real cross-venue gaps on
// liquid markets are 0-1c and that trading rarely is correct behaviour. Most cycles nothing
// happens. Re-reading an unchanged board 5,760 times a day is not more agentic, it is the same
// judgement bought over and over at full price -- in the cost sweep every single turn against a
// quiet board came back proposing nothing, which was the right answer and an expensive way to
// hear it.
//
// So turns are EVENT-DRIVEN. A mind's view carries a `signature`: a short string naming the
// situation it describes. Identical signature, no call. The desk reasons when something happens
// to reason about and is silent -- and free -- when nothing does. Cost now scales with how busy
// the market is, which is the same thing as scaling with how much the judgement is worth.
//
// ---------------------------------------------------------------------------------------------
// Three properties the rest of the desk depends on, in order of how badly a violation would hurt:
//
//   1. IT NEVER BLOCKS THE CYCLE. The taker loop runs every PRICE_EVERY_SEC (15s by default) and
//      a single turn takes 7-24 seconds. So nothing here is awaited from inside a cycle.
//      `refresh()` fires a call and returns immediately; `advice()` returns the most recent
//      COMPLETED answer. A desk always acts on a real answer -- just possibly a cycle or two old.
//
//   2. IT NEVER THROWS INTO A CYCLE. A rate limit, a dropped socket, a 500, a malformed body, an
//      expired key, an exhausted budget: all of it is caught here and recorded. The desk falls
//      back to exactly the behaviour it had before this file existed. A dead API is a quiet desk,
//      never a broken one.
//
//   3. IT NEVER PRINTS THE KEY. The key is read once from the environment and lives only in the
//      request header. Error bodies are truncated and come from Anthropic, not from us.
//
// Zero dependencies, per CLAUDE.md -- this calls the Messages API over Node 20's built-in fetch
// rather than @anthropic-ai/sdk. That is a deliberate project constraint, not an oversight.
const http = require('./http');

const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';

// Per-MTok list prices converted to per-token, so a running total is just a sum. Cache reads bill
// at a tenth of input and cache writes at 1.25x, which is the whole argument for the stable-prefix
// layout in src/minds.js: a persona that never changes is nearly free to resend.
const PRICES = {
  'claude-opus-5': { input: 5 / 1e6, output: 25 / 1e6, cacheRead: 0.5 / 1e6, cacheWrite: 6.25 / 1e6 },
  'claude-sonnet-5': { input: 2 / 1e6, output: 10 / 1e6, cacheRead: 0.2 / 1e6, cacheWrite: 2.5 / 1e6 },
  'claude-haiku-4-5': { input: 1 / 1e6, output: 5 / 1e6, cacheRead: 0.1 / 1e6, cacheWrite: 1.25 / 1e6 },
};
// An unknown model bills at the most expensive rate we know. Under-reporting spend is the one
// direction this must never round, because the daily cap is computed from it.
const priceFor = (m) => PRICES[m] || PRICES['claude-opus-5'];

// Eastern, matching TESS's drawdown day. A UTC rollover would reset the budget at 8pm ET, in the
// middle of the evening slate this desk mostly trades.
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

const r4 = (x) => Math.round(x * 10000) / 10000;
const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

// A mind may return a number where the schema promised one and still be wrong about the range.
// Everything crossing out of this module goes through here first.
const num01 = (x) => (Number.isFinite(x) ? clamp(x, 0, 1) : 0);

class Brain {
  constructor(cfg) {
    this.cfg = cfg;
    // Read once. `server.js` loads .env before requiring the engine, so this is populated by then.
    this.key = String(process.env.ANTHROPIC_API_KEY || '').trim();
    this.inflight = new Map();          // agent -> true while a call is open; never queue a second
    this.answers = new Map();           // agent -> { at, data, ms, usage }
    this.signatures = new Map();        // agent -> signature of the last situation we paid to read
    this.lastCallAt = new Map();        // agent -> when, for the per-desk minimum gap
    this.failures = new Map();          // agent -> consecutive failure count, for backoff
    this.cooldownUntil = 0;             // global pause after a 429 or a run of 5xx
    this.lastError = null;              // surfaced on the dashboard so a dead key is visible
    this.day = ET_DAY.format(new Date());
    this.daySpend = 0;
    this.dayCalls = 0;
    this.stats = { calls: 0, ok: 0, errors: 0, skipped: 0, inTok: 0, outTok: 0, cacheRead: 0, cacheWrite: 0, usd: 0 };
    this.perAgent = new Map();
    // Structured outputs are the contract these minds are written against. If this deployment's
    // API rejects `output_config.format`, fall back to asking for the same JSON in the prompt and
    // parsing it ourselves -- once, permanently, rather than eating a 400 on every call.
    this.formatMode = 'schema';
  }

  // BRAM prices and KETT executes: those turns decide whether money moves and get the better
  // model. The rest are noticing and summarising, which the cheaper one does well.
  modelFor(agent) {
    return this.cfg.brainDeepAgents.includes(agent) ? this.cfg.brainModelDeep : this.cfg.brainModelFast;
  }

  // ---- the cost rail ------------------------------------------------------------------------
  _rollDay() {
    const k = ET_DAY.format(new Date());
    if (k !== this.day) { this.day = k; this.daySpend = 0; this.dayCalls = 0; }
  }

  // The budget is PACED across the day, not handed over at midnight. An unpaced cap has an ugly
  // failure mode that looks nothing like overspending: a busy hour at the open eats the whole
  // day's allowance by 10am and the desks are deterministic through the entire evening slate --
  // which is when this desk actually trades. So the allowance ramps with the clock.
  //
  // 15% is available immediately as burst, because a real event at 9:31am should not have to wait
  // for the clock to catch up; the remaining 85% accrues linearly. Spend is only known AFTER a
  // turn, so this is a ceiling with at most one turn of overshoot -- the alternative is
  // pre-estimating tokens and refusing turns that would have been affordable.
  _dayFraction() {
    const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(new Date());
    const h = Number(parts.find((x) => x.type === 'hour').value);
    const m = Number(parts.find((x) => x.type === 'minute').value);
    return clamp((h * 60 + m) / 1440, 0, 1);
  }
  allowance() { return r4(this.cfg.brainDailyUsd * (0.15 + 0.85 * this._dayFraction())); }
  overBudget() { this._rollDay(); return this.daySpend >= Math.min(this.cfg.brainDailyUsd, this.allowance()); }
  budgetLeft() { this._rollDay(); return Math.max(0, r4(Math.min(this.cfg.brainDailyUsd, this.allowance()) - this.daySpend)); }

  enabled() { return !!this.key && this.cfg.brainEnabled; }

  // Why the desks are not thinking, in words a dashboard can show.
  status() {
    if (!this.cfg.brainEnabled) return 'disabled (BRAIN=0)';
    if (!this.key) return 'no ANTHROPIC_API_KEY';
    if (this.overBudget()) return `paced budget spent ($${this.daySpend.toFixed(3)} of $${this.cfg.brainDailyUsd.toFixed(2)}/day)`;
    if (Date.now() < this.cooldownUntil) return `backing off ${Math.ceil((this.cooldownUntil - Date.now()) / 1000)}s`;
    return `live · $${this.budgetLeft().toFixed(3)} left today`;
  }

  // The freshest COMPLETED answer for this agent, or null. `maxAgeMs` lets a caller refuse to act
  // on advice older than it is willing to trust -- a flow read from six minutes ago is a different
  // claim than one from six seconds ago, and only the caller knows which matters.
  advice(agent, maxAgeMs = Infinity) {
    const e = this.answers.get(agent);
    if (!e) return null;
    if (Date.now() - e.at > maxAgeMs) return null;
    return e.data;
  }

  ageMs(agent) {
    const e = this.answers.get(agent);
    return e ? Date.now() - e.at : null;
  }

  thinking(agent) { return this.inflight.has(agent); }

  // Fire a turn for `agent` if the situation warrants one. Returns nothing and never rejects: the
  // caller is a trading cycle, not a consumer of this promise.
  //
  // `build` is a thunk, not a value, so the view is only assembled when a call might actually go
  // out. It returns null when the desk has nothing worth asking about, or a spec carrying a
  // `signature` -- see the header. Every gate below is ordered cheapest-first.
  refresh(agent, build) {
    if (!this.enabled()) return;
    if (this.inflight.has(agent)) return;
    if (Date.now() < this.cooldownUntil) return;
    if (this.overBudget()) { this.stats.skipped++; return; }
    // A flapping quote must not buy the same turn ten times a minute, however much the signature
    // moves. The trigger decides IF a turn is worth buying; this bounds how often.
    if (Date.now() - (this.lastCallAt.get(agent) || 0) < this.cfg.brainMinGapSec * 1000) return;

    let spec;
    try { spec = build(); } catch (e) { this._fail(agent, e); return; }
    if (!spec) return;                                   // the desk has nothing to ask
    // The event gate. An unchanged situation is an answer we have already paid for.
    if (spec.signature != null && this.signatures.get(agent) === spec.signature) { this.stats.skipped++; return; }

    this.signatures.set(agent, spec.signature == null ? null : spec.signature);
    this.lastCallAt.set(agent, Date.now());
    this.inflight.set(agent, true);
    this._turn(agent, spec)
      .then((res) => {
        this.answers.set(agent, { at: Date.now(), data: res.data, ms: res.ms, usage: res.usage });
        this.failures.delete(agent);
      })
      .catch((e) => {
        // A failed turn did not answer the question, so the situation is still unread: forget the
        // signature or the desk will never retry this board.
        this.signatures.delete(agent);
        this._fail(agent, e);
      })
      .finally(() => this.inflight.delete(agent));
  }

  _fail(agent, e) {
    const n = (this.failures.get(agent) || 0) + 1;
    this.failures.set(agent, n);
    this.stats.errors++;
    const a = this._agentStats(agent); a.errors++;
    this.lastError = `${agent}: ${String(e && e.message || e).slice(0, 120)}`;
    http.noteError(e);
    // A 429 or a wall of 5xx is about the account, not this agent, so the pause is global.
    // Everything else backs off just the desk that failed, via the same counter.
    const status = e && e.status;
    if (status === 429 || status >= 500 || n >= 3) {
      const retryAfter = (e && e.retryAfter) ? e.retryAfter * 1000 : 0;
      const backoff = Math.max(retryAfter, Math.min(60000, 2000 * Math.pow(2, Math.min(n, 5))));
      this.cooldownUntil = Date.now() + backoff;
    }
  }

  _agentStats(agent) {
    let a = this.perAgent.get(agent);
    if (!a) { a = { calls: 0, errors: 0, usd: 0, lastMs: 0, model: this.modelFor(agent) }; this.perAgent.set(agent, a); }
    return a;
  }

  async _turn(agent, spec) {
    const t0 = Date.now();
    this.stats.calls++;
    this._rollDay();
    this.dayCalls++;
    const model = spec.model || this.modelFor(agent);
    const a = this._agentStats(agent); a.calls++; a.model = model;
    let res;
    try {
      res = await this._post(this._body(spec, model, this.formatMode), spec.timeoutMs || this.cfg.brainTimeoutMs);
    } catch (e) {
      // One self-heal, once per process: an API that will not take `output_config.format` gets
      // asked for the same JSON in prose from here on. Any other 400 is a real bug in the view
      // or the schema and must surface, not be silently downgraded.
      if (e.status === 400 && this.formatMode === 'schema' && /output_config|format|json_schema/i.test(e.message)) {
        this.formatMode = 'prompt';
        res = await this._post(this._body(spec, model, 'prompt'), spec.timeoutMs || this.cfg.brainTimeoutMs);
      } else throw e;
    }
    const ms = Date.now() - t0;
    a.lastMs = ms;
    this._meter(agent, model, res.usage);
    if (res.stop_reason === 'refusal') {
      throw new Error(`refused (${(res.stop_details && res.stop_details.category) || 'unspecified'})`);
    }
    const data = spec.parse ? spec.parse(this._json(res)) : this._json(res);
    return { data, ms, usage: res.usage };
  }

  _body(spec, model, mode) {
    const body = {
      model,
      max_tokens: spec.maxTokens || 3000,
      // Adaptive thinking, and the raw chain is not requested back: these desks act on the
      // structured answer, and a summary would only be logged and never read.
      thinking: { type: 'adaptive' },
      output_config: { effort: spec.effort || this.cfg.brainEffort },
      // The persona is byte-stable across every call for a desk, so it caches; the volatile view
      // goes in the user turn, after the breakpoint. See src/minds.js.
      system: [{ type: 'text', text: spec.system, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: mode === 'schema' ? spec.user : `${spec.user}\n\nReply with JSON only -- no prose, no code fences -- matching exactly this JSON Schema:\n${JSON.stringify(spec.schema)}` }],
    };
    if (mode === 'schema') body.output_config.format = { type: 'json_schema', schema: spec.schema };
    return body;
  }

  // `extraHeaders` is for callers that opt into a beta (src/research.js); the key header is fixed.
  async _post(body, timeoutMs, extraHeaders = {}) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(API_URL, {
        method: 'POST',
        headers: {
          ...extraHeaders,
          'content-type': 'application/json',
          'x-api-key': this.key,
          'anthropic-version': API_VERSION,
        },
        body: JSON.stringify(body),
        signal: ac.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        // The body is Anthropic's error JSON. It does not contain the key, and it is the only
        // thing that ever says WHICH field the API objected to -- so it is worth carrying.
        const err = new Error(`HTTP ${res.status} ${text.slice(0, 240)}`);
        err.status = res.status;
        const ra = Number(res.headers.get('retry-after'));
        err.retryAfter = Number.isFinite(ra) ? ra : null;
        throw err;
      }
      return JSON.parse(text);
    } catch (e) {
      if (e.name === 'AbortError') { const t = new Error(`timed out after ${timeoutMs}ms`); t.status = 408; throw t; }
      throw e;
    } finally { clearTimeout(timer); }
  }

  // The answer, as an object. Structured outputs put it in the text block verbatim; prompt mode
  // sometimes wraps it in a fence despite being told not to, so tolerate that rather than lose a
  // whole turn to three backticks.
  _json(res) {
    const block = (res.content || []).find((b) => b.type === 'text');
    if (!block) throw new Error('no text block in response');
    let t = block.text.trim();
    if (t.startsWith('```')) t = t.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(t); } catch { throw new Error(`unparseable answer: ${t.slice(0, 120)}`); }
  }

  _meter(agent, model, u) {
    if (!u) return;
    const p = priceFor(model);
    const inTok = u.input_tokens || 0, outTok = u.output_tokens || 0;
    const cr = u.cache_read_input_tokens || 0, cw = u.cache_creation_input_tokens || 0;
    const usd = inTok * p.input + outTok * p.output + cr * p.cacheRead + cw * p.cacheWrite;
    this.stats.ok++;
    this.stats.inTok += inTok; this.stats.outTok += outTok;
    this.stats.cacheRead += cr; this.stats.cacheWrite += cw;
    this.stats.usd = r4(this.stats.usd + usd);
    this._rollDay();
    this.daySpend = r4(this.daySpend + usd);
    const a = this._agentStats(agent); a.usd = r4(a.usd + usd);
  }

  // What the dashboard shows. Spend against the cap is the number that decides whether any of
  // this stays switched on, so it leads.
  snapshot() {
    return {
      status: this.status(),
      deep: this.cfg.brainModelDeep,
      fast: this.cfg.brainModelFast,
      effort: this.cfg.brainEffort,
      lastError: this.lastError,
      dayUsd: this.daySpend,
      dayCap: this.cfg.brainDailyUsd,
      dayAllowance: this.allowance(),
      dayCalls: this.dayCalls,
      usd: this.stats.usd,
      calls: this.stats.calls,
      skipped: this.stats.skipped,
      errors: this.stats.errors,
      cacheHitTok: this.stats.cacheRead,
      agents: Object.fromEntries([...this.perAgent].map(([k, v]) => [k, { ...v, thinking: this.inflight.has(k), ageMs: this.ageMs(k) }])),
    };
  }
}

module.exports = { Brain, num01, clamp, PRICES, priceFor };

'use strict';
// Assertions for the Claude layer (src/brain.js, src/minds.js). Zero dependencies, NO NETWORK.
//
// Nothing here calls Anthropic. That is the point: the interesting behaviour of this layer is not
// what the model says, it is what the desk is willing to DO with what the model says -- and that
// is pure, so it can be pinned exactly like the decision core is.
//
// The clamp in minds.ILSA.apply is the highest-consequence function added to this repo. It is the
// only thing standing between a sentence written by a language model and a real order, so every
// rail it enforces gets a case here, including the ones a live desk would rarely hit.
//
//   node tools/brain-test.js
const assert = require('assert');
const minds = require('../src/minds');
const agents = require('../src/agents');
const { Brain, num01 } = require('../src/brain');
const cfg = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
// Assertions that can only be made after a fire-and-forget turn settles; drained at the bottom.
const pending = [];

// A pair whose Kalshi book is far above Polymarket's, with almost all the volume on Kalshi -- so
// fair value leans to KS and buying YES on PM is genuinely, obviously cheap. This is the shape of
// the one trade a mind is supposed to be able to originate.
const mkPair = (over = {}) => ({
  id: 'p1', label: 'fixture pair', kind: 'event', ks: { ticker: 'KXTEST' }, pm: { id: 'pm1', tokenIndex: 0 },
  inPlay: false, fair: null, best: null, veto: null,
  q: { pmBid: 0.40, pmAsk: 0.42, pmMid: 0.41, ksBid: 0.60, ksAsk: 0.62, ksMid: 0.61, pmVol: 100, ksVol: 1e6, t: Date.now() },
  ...over,
});

// The smallest engine-shaped object minds.ILSA.apply actually reads.
const mkE = (pairs, over = {}) => ({
  cfg,
  pairs,
  bias: new Map(),
  history: new Map(),
  cooldown: new Map(),
  halt: null,
  state: { positions: [], cash: 10000 },
  equity: () => 10000,
  budget: () => 200,
  ...over,
});

const propose = (over = {}) => ({ pairId: 'p1', venue: 'PM', side: 'yes', conviction: 0.8, thesis: 'KS repriced on news, PM has not caught up', ...over });

// -------------------------------------------------------------------------------------------
group('a clean proposal becomes a signal, priced from the book rather than from the model');
{
  const E = mkE([mkPair()]);
  const r = minds.ILSA.apply(E, { note: 'n', commentary: 'c', reads: [], proposals: [propose()] });
  ok('one proposal survives', r.proposals.length === 1, r.dropped);
  const s = r.proposals[0];
  ok('typed as a convergence trade', s.type === 'converge', s.type);
  ok('attributed to ILSA', s.origin === 'ILSA', s.origin);
  ok('carries the thesis onto the signal', /repriced/.test(s.thesis), s.thesis);
  ok('one leg, on the proposed venue and side', s.legs.length === 1 && s.legs[0].venue === 'PM' && s.legs[0].side === 'yes', s.legs);
  // The mind named the instrument; convEdge named the price. A YES buy lifts the ask.
  ok('price is the live ask, not anything the model said', Math.abs(s.legs[0].px - 0.42) < 1e-9, s.legs[0].px);
  ok('edge is positive on this book', s.edge > 0, s.edge);
}

group('every data-integrity rail drops the proposal rather than shrinking it');
{
  const cases = [
    ['unknown pair', mkE([mkPair()]), propose({ pairId: 'nope' }), 'unknown pair'],
    ['no quote at all', mkE([mkPair({ q: null })]), propose(), 'no quote'],
    ['crossed book', mkE([mkPair({ q: { ...mkPair().q, pmAsk: 0.38 } })]), propose(), 'crossed book'],
    ['in-play game', mkE([mkPair({ inPlay: true })]), propose(), 'in-play'],
    // an any-market pair whose resolution rules are unverified: two contracts that may settle differently
    ['rules unverified', mkE([mkPair({ watchOnly: 'unclear' })]), propose(), 'rules unverified'],
    ['stale quote', mkE([mkPair({ q: { ...mkPair().q, t: Date.now() - (cfg.maxDataAgeSec + 60) * 1000 } })]), propose(), 'stale quote'],
    ['bad venue', mkE([mkPair()]), propose({ venue: 'NYSE' }), 'bad venue'],
    ['bad side', mkE([mkPair()]), propose({ side: 'maybe' }), 'bad side'],
  ];
  for (const [name, E, p, why] of cases) {
    const r = minds.ILSA.apply(E, { proposals: [p] });
    ok(`${name}: nothing minted`, r.proposals.length === 0, r.proposals);
    ok(`${name}: reported as "${why}"`, r.dropped.length === 1 && r.dropped[0].why === why, r.dropped);
  }
}

group('position and churn rails');
{
  const held = mkE([mkPair()], { state: { positions: [{ pairId: 'p1' }], cash: 10000 } });
  const r1 = minds.ILSA.apply(held, { proposals: [propose()] });
  ok('a pair already held is not doubled into', r1.proposals.length === 0 && r1.dropped[0].why === 'already holding', r1.dropped);

  const cooling = mkE([mkPair()]);
  cooling.cooldown.set('p1', Date.now() - 60000);          // exited a minute ago
  const r2 = minds.ILSA.apply(cooling, { proposals: [propose()] });
  ok('the re-entry cooldown is honoured', r2.proposals.length === 0 && r2.dropped[0].why === 'in cooldown', r2.dropped);

  const cold = mkE([mkPair()]);
  cold.cooldown.set('p1', Date.now() - cfg.reentryCooldownMs - 1000);
  const r3 = minds.ILSA.apply(cold, { proposals: [propose()] });
  ok('and released once it expires', r3.proposals.length === 1, r3.dropped);
}

group('the break-even floor is the one threshold a thesis cannot talk past');
{
  // Both venues agree, so fair sits between them and there is no move to collect: buying the ask
  // and selling the bid loses the spread. A confident thesis must not rescue this.
  const flat = mkPair({ q: { pmBid: 0.40, pmAsk: 0.42, pmMid: 0.41, ksBid: 0.40, ksAsk: 0.42, ksMid: 0.41, pmVol: 1e5, ksVol: 1e5, t: Date.now() } });
  const r = minds.ILSA.apply(mkE([flat]), { proposals: [propose({ conviction: 1 })] });
  ok('a negative-edge trade is refused at full conviction', r.proposals.length === 0, r.proposals);
  ok('and says it was the edge floor', /under floor/.test(r.dropped[0].why), r.dropped);
}

group('reads are clamped, and only for pairs that exist');
{
  const E = mkE([mkPair()]);
  const r = minds.ILSA.apply(E, {
    reads: [
      { pairId: 'p1', stance: 'converging', conviction: 4.2, thesis: 'x' },
      { pairId: 'ghost', stance: 'diverging', conviction: 0.9, thesis: 'y' },
    ],
    proposals: [],
  });
  ok('an out-of-range conviction is clamped to 1', r.reads.get('p1').conviction === 1, r.reads.get('p1'));
  ok('a read on an unknown pair is discarded', !r.reads.has('ghost'), [...r.reads.keys()]);
  ok('num01 floors a negative at 0', num01(-3) === 0, num01(-3));
  ok('num01 turns a non-number into 0', num01('lots') === 0, num01('lots'));
}

group('a malformed answer is survivable');
{
  const E = mkE([mkPair()]);
  for (const bad of [null, undefined, 'a string', 42, {}, { reads: 'not an array', proposals: 'nope' }]) {
    let threw = null;
    try { minds.ILSA.apply(E, bad); } catch (e) { threw = e; }
    ok(`apply(${JSON.stringify(bad)}) does not throw`, !threw, threw && threw.message);
  }
}

// -------------------------------------------------------------------------------------------
group('mergeBrainSignals respects BRAM and the ranking');
{
  const p1 = mkPair(), p2 = mkPair({ id: 'p2' });
  const arb = { type: 'arb', pair: p2, edge: 0.01, legs: [] };
  const mindSignal = { type: 'converge', pair: p1, edge: 0.09, origin: 'ILSA', legs: [{ venue: 'PM', side: 'yes', px: 0.42 }] };

  const E = { signals: [arb], brainSignals: [mindSignal] };
  agents.mergeBrainSignals(E);
  ok('the proposal is added', E.signals.length === 2, E.signals.length);
  ok('a locked arb still outranks a fatter directional edge', E.signals[0].type === 'arb', E.signals.map((s) => s.type));

  // BRAM already found something on this pair: the scanner's version is the one with arithmetic
  // behind it, and KETT refuses a second position per pair anyway.
  const dup = { signals: [{ type: 'converge', pair: p1, edge: 0.01, legs: [] }], brainSignals: [mindSignal] };
  agents.mergeBrainSignals(dup);
  ok('no duplicate signal for a pair BRAM already surfaced', dup.signals.length === 1, dup.signals.length);
  ok('and the scanner\'s signal is the one kept', !dup.signals[0].origin, dup.signals[0]);

  const none = { signals: [arb], brainSignals: [] };
  agents.mergeBrainSignals(none);
  ok('an empty proposal list is a no-op', none.signals.length === 1, none.signals.length);
}

// -------------------------------------------------------------------------------------------
group('the transport refuses to do anything without a key');
{
  const saved = process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_API_KEY;
  const b = new Brain(cfg);
  ok('disabled with no key', b.enabled() === false, b.enabled());
  ok('and says why', /no ANTHROPIC_API_KEY/.test(b.status()), b.status());
  let built = false;
  b.refresh('ILSA', () => { built = true; return null; });
  ok('refresh does not even build the view', built === false);
  ok('advice is null', b.advice('ILSA') === null);
  ok('thinking is false', b.thinking('ILSA') === false);

  const off = new Brain({ ...cfg, brainEnabled: false });
  off.key = 'sk-ant-fake';
  ok('BRAIN=0 disables it even with a key', off.enabled() === false, off.status());
  process.env.ANTHROPIC_API_KEY = saved;
}

group('request shaping');
{
  const b = new Brain(cfg);
  b.key = 'sk-ant-fake';
  const spec = { system: 'persona', user: '{"a":1}', schema: { type: 'object' }, effort: 'high', maxTokens: 1234 };

  const schemaBody = b._body(spec, cfg.brainModelFast, 'schema');
  ok('model is whatever the caller picked', schemaBody.model === cfg.brainModelFast, schemaBody.model);
  ok('adaptive thinking, no budget_tokens', schemaBody.thinking.type === 'adaptive' && !('budget_tokens' in schemaBody.thinking), schemaBody.thinking);
  ok('effort rides inside output_config', schemaBody.output_config.effort === 'high', schemaBody.output_config);
  ok('schema goes in output_config.format', schemaBody.output_config.format.type === 'json_schema', schemaBody.output_config.format);
  // The persona is the cacheable prefix; the volatile view sits after it in the user turn.
  ok('the persona carries the cache breakpoint', schemaBody.system[0].cache_control.type === 'ephemeral', schemaBody.system[0]);
  ok('the view is not in the cached prefix', !JSON.stringify(schemaBody.system).includes('"a":1'), schemaBody.system);

  const promptBody = b._body(spec, cfg.brainModelFast, 'prompt');
  ok('the fallback drops output_config.format', promptBody.output_config.format === undefined, promptBody.output_config);
  ok('and inlines the schema in the turn instead', /JSON Schema/.test(promptBody.messages[0].content), promptBody.messages[0].content.slice(0, 80));
}

group('answer parsing tolerates a fenced body');
{
  const b = new Brain(cfg);
  ok('plain JSON', b._json({ content: [{ type: 'text', text: '{"note":"hi"}' }] }).note === 'hi');
  ok('```json fenced', b._json({ content: [{ type: 'text', text: '```json\n{"note":"hi"}\n```' }] }).note === 'hi');
  ok('bare fenced', b._json({ content: [{ type: 'text', text: '```\n{"note":"hi"}\n```' }] }).note === 'hi');
  assert.throws(() => b._json({ content: [{ type: 'thinking', thinking: 'x' }] }), /no text block/);
  pass++;
  assert.throws(() => b._json({ content: [{ type: 'text', text: 'sorry, no' }] }), /unparseable/);
  pass++;
}

group('cost metering');
{
  const b = new Brain(cfg);
  b._meter('ILSA', 'claude-opus-5', { input_tokens: 1e6, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 });
  ok('1M input tokens bills $5.00', b.stats.usd === 5, b.stats.usd);
  b._meter('ILSA', 'claude-opus-5', { input_tokens: 0, output_tokens: 1e6 });
  ok('1M output tokens adds $25.00', b.stats.usd === 30, b.stats.usd);
  b._meter('ILSA', 'claude-opus-5', { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 1e6 });
  ok('1M cached input tokens adds only $0.50', b.stats.usd === 30.5, b.stats.usd);
  ok('it is attributed to the desk that spent it', b.perAgent.get('ILSA').usd === 30.5, b.perAgent.get('ILSA'));
  ok('a missing usage block is ignored', (b._meter('ILSA', 'claude-opus-5', null), b.stats.usd === 30.5), b.stats.usd);
}

group('failure backs off rather than propagating');
{
  const b = new Brain(cfg);
  b.key = 'sk-ant-fake';
  const rateLimited = Object.assign(new Error('HTTP 429 slow down'), { status: 429, retryAfter: 30 });
  b._fail('ILSA', rateLimited);
  ok('a 429 pauses every desk, not just this one', b.cooldownUntil > Date.now() + 25000, b.cooldownUntil - Date.now());
  ok('and the reason is visible', /429/.test(b.lastError), b.lastError);
  ok('status reports the backoff', /backing off/.test(b.status()), b.status());
  let built = false;
  b.refresh('ILSA', () => { built = true; return null; });
  ok('no call is attempted while backing off', built === false);

  const b2 = new Brain(cfg);
  b2.key = 'sk-ant-fake';
  b2._fail('ILSA', new Error('unparseable answer'));
  ok('one soft failure does not pause the desk', b2.cooldownUntil <= Date.now(), b2.cooldownUntil - Date.now());
  b2._fail('ILSA', new Error('unparseable answer'));
  b2._fail('ILSA', new Error('unparseable answer'));
  ok('three in a row does', b2.cooldownUntil > Date.now(), b2.cooldownUntil - Date.now());
}

group('the view is not built when there is nothing to say');
{
  ok('no pairs at all', minds.ILSA.view(mkE([])) === null);
  ok('every pair in-play', minds.ILSA.view(mkE([mkPair({ inPlay: true })])) === null);
  ok('every book malformed', minds.ILSA.view(mkE([mkPair({ q: { ...mkPair().q, ksAsk: 0.1 } })])) === null);
  ok('every quote stale', minds.ILSA.view(mkE([mkPair({ q: { ...mkPair().q, t: Date.now() - (cfg.maxDataAgeSec + 60) * 1000 } })])) === null);

  // THE cost gate: a board where nothing is wider than minGap must not buy a turn at all.
  const tight = mkPair({ q: { pmBid: 0.40, pmAsk: 0.42, pmMid: 0.41, ksBid: 0.405, ksAsk: 0.425, ksMid: 0.415, pmVol: 1e5, ksVol: 1e5, t: Date.now() } });
  ok('a quiet board buys no turn', minds.ILSA.view(mkE([tight])) === null, 'expected null');

  const v = minds.ILSA.view(mkE([mkPair()]));
  ok('a board with a real gap does produce a view', !!v && !!v.user, v);
  const body = JSON.parse(v.user);
  ok('the view names the pair', body.pairs[0].pairId === 'p1', body.pairs[0]);
  ok('it states the break-even floor', body.thresholds.llmMinEdge === cfg.llmMinEdge, body.thresholds);
  ok('it discloses what is already held', Array.isArray(body.desk.alreadyHoldingPairIds), body.desk);
  ok('the persona is stable across calls', minds.ILSA.view(mkE([mkPair()])).system === v.system);
  ok('it carries a signature', typeof v.signature === 'string' && v.signature.length > 0, v.signature);

  // Whole-cent rounding: jitter inside a cent is the same situation and must not be re-bought.
  const jittered = mkPair({ q: { ...mkPair().q, ksBid: 0.6012, ksAsk: 0.6212, ksMid: 0.6112 } });
  ok('sub-cent jitter keeps the same signature', minds.ILSA.view(mkE([jittered])).signature === v.signature, [minds.ILSA.view(mkE([jittered])).signature, v.signature]);
  const moved = mkPair({ q: { ...mkPair().q, ksBid: 0.65, ksAsk: 0.67, ksMid: 0.66 } });
  ok('a whole-cent move changes it', minds.ILSA.view(mkE([moved])).signature !== v.signature, minds.ILSA.view(mkE([moved])).signature);
}

group('the daily spend cap is a refusal, not a suggestion');
{
  const b = new Brain({ ...cfg, brainDailyUsd: 1 });
  b.key = 'sk-ant-fake';
  ok('starts under budget', b.overBudget() === false, b.daySpend);
  // Paced, so what is available now is a fraction of the cap -- never more than the cap itself.
  ok('the allowance never exceeds the cap', b.allowance() <= 1 + 1e-9, b.allowance());
  ok('and at least the burst floor is available', b.allowance() >= 0.15 - 1e-9, b.allowance());
  ok('what is left tracks the allowance', Math.abs(b.budgetLeft() - Math.min(1, b.allowance())) < 1e-9, [b.budgetLeft(), b.allowance()]);
  b._meter('ILSA', 'claude-opus-5', { input_tokens: 100000, output_tokens: 20000 });  // $0.50 + $0.50
  ok('spend accrues against the day', b.daySpend === 1, b.daySpend);
  ok('and the cap is now binding', b.overBudget() === true, b.daySpend);
  ok('status says so in words', /paced budget spent/.test(b.status()), b.status());
  let built = false;
  b.refresh('ILSA', () => { built = true; return { system: 's', user: 'u', schema: {} }; });
  ok('no view is even built past the cap', built === false);
  ok('and the skip is counted', b.stats.skipped === 1, b.stats.skipped);

  // A new Eastern day releases it.
  b.day = '1999-01-01';
  ok('an ET day rollover resets the budget', b.overBudget() === false, b.daySpend);
  ok('and zeroes the spend', b.daySpend === 0, b.daySpend);

  // Pacing exists so a busy morning cannot leave the desk mute through the evening slate, which
  // is when this desk actually trades. Pin the ramp rather than the wall-clock value.
  const paced = new Brain({ ...cfg, brainDailyUsd: 10 });
  const at = (frac) => { paced._dayFraction = () => frac; return paced.allowance(); };
  ok('at midnight only the burst is available', Math.abs(at(0) - 1.5) < 1e-9, at(0));
  ok('at midday roughly half the cap', Math.abs(at(0.5) - 5.75) < 1e-9, at(0.5));
  ok('by end of day the whole cap', Math.abs(at(1) - 10) < 1e-9, at(1));
  ok('the ramp is monotonic', at(0.2) < at(0.6) && at(0.6) < at(0.9));
  // $2 spent at 8am is fine; the same $2 at 1am is not.
  paced.daySpend = 2;
  paced._dayFraction = () => 0.33;
  ok('spend inside the paced allowance passes', paced.overBudget() === false, paced.allowance());
  paced._dayFraction = () => 0.01;
  ok('the same spend too early in the day does not', paced.overBudget() === true, paced.allowance());
}

group('the event gate refuses to buy the same answer twice');
{
  const b = new Brain({ ...cfg, brainMinGapSec: 0 });
  b.key = 'sk-ant-fake';
  let builds = 0, turns = 0;
  const spec = () => { builds++; return { system: 's', user: 'u', schema: {}, signature: 'board-A' }; };
  // Stub the turn so nothing leaves the machine; we are testing the gate, not the transport.
  b._turn = async () => { turns++; return { data: { ok: true }, ms: 1, usage: null }; };

  b.refresh('ILSA', spec);
  ok('the first look is bought', builds === 1 && turns === 1, { builds, turns });
  b.inflight.delete('ILSA');
  b.refresh('ILSA', spec);
  ok('an unchanged board is not bought again', turns === 1, turns);
  ok('and the skip is counted', b.stats.skipped === 1, b.stats.skipped);
  b.inflight.delete('ILSA');
  b.refresh('ILSA', () => ({ system: 's', user: 'u', schema: {}, signature: 'board-B' }));
  ok('a changed board is', turns === 2, turns);

  // A failed turn must not leave the signature latched, or that board is never re-read.
  const b2 = new Brain({ ...cfg, brainMinGapSec: 0 });
  b2.key = 'sk-ant-fake';
  b2._turn = async () => { throw new Error('boom'); };
  b2.refresh('ILSA', () => ({ system: 's', user: 'u', schema: {}, signature: 'board-C' }));
  // refresh() is deliberately fire-and-forget, so this assertion can only be made once the
  // rejected turn has settled. Collected here and awaited at the bottom of the file.
  pending.push(async () => {
    await new Promise((r) => setImmediate(r));
    ok('a failed turn forgets the signature so it can retry', b2.signatures.get('ILSA') === undefined, b2.signatures.get('ILSA'));
  });
}

group('the minimum gap bounds a flapping board');
{
  const b = new Brain({ ...cfg, brainMinGapSec: 45 });
  b.key = 'sk-ant-fake';
  b._turn = async () => ({ data: {}, ms: 1, usage: null });
  b.refresh('ILSA', () => ({ system: 's', user: 'u', schema: {}, signature: 'x' }));
  b.inflight.delete('ILSA');
  let built = false;
  b.refresh('ILSA', () => { built = true; return { system: 's', user: 'u', schema: {}, signature: 'totally-different' }; });
  ok('a brand new situation still waits out the minimum gap', built === false);
}

group('deep and fast models are routed by desk');
{
  const b = new Brain(cfg);
  ok('BRAM gets the deep model', b.modelFor('BRAM') === cfg.brainModelDeep, b.modelFor('BRAM'));
  ok('KETT gets the deep model', b.modelFor('KETT') === cfg.brainModelDeep, b.modelFor('KETT'));
  ok('ILSA gets the fast one', b.modelFor('ILSA') === cfg.brainModelFast, b.modelFor('ILSA'));
  ok('HOLT gets the fast one', b.modelFor('HOLT') === cfg.brainModelFast, b.modelFor('HOLT'));
  // Sonnet is 2.5x cheaper than Opus on both legs; an unknown model must bill at the dearest
  // rate we know, because the daily cap is computed from this.
  const b2 = new Brain(cfg);
  b2._meter('X', 'claude-sonnet-5', { input_tokens: 1e6, output_tokens: 0 });
  ok('sonnet input bills $2.00', b2.stats.usd === 2, b2.stats.usd);
  const b3 = new Brain(cfg);
  b3._meter('X', 'some-future-model', { input_tokens: 1e6, output_tokens: 0 });
  ok('an unknown model bills at the dearest known rate', b3.stats.usd === 5, b3.stats.usd);
}

group('RIGO: a mind that can only close a convergence position early');
{
  const now = Date.now();
  const pos = (over = {}) => ({ id: 'a1', pairId: 'p1', label: 'Fixture', venue: 'PM', side: 'yes', qty: 100, entry: 0.40, mark: 0.38,
    strategy: 'converge', openedAt: now - 90 * 60000, closesAt: null, entryGap: 0.05, cost: 40, ...over });
  const R = (positions) => ({ cfg, pairs: [mkPair()], state: { positions } });
  const say = (decisions) => ({ note: 'n', commentary: 'c', decisions });
  const exit = (id, conviction = 0.8) => ({ positionId: id, action: 'exit', conviction, reason: 'thesis dead' });

  ok('no open positions: no view, so no call and no cost', minds.RIGO.view(R([])) === null);
  ok('an arb or a stuck leg is not shown to the mind', minds.RIGO.view(R([pos({ strategy: 'arb' }), pos({ id: 'o', orphan: true })])) === null);
  ok('a position with no mark cannot be judged', minds.RIGO.view(R([pos({ mark: undefined })])) === null);

  const v = minds.RIGO.view(R([pos()]));
  ok('a view carries a signature, a persona, a schema and the position', v && v.signature && v.system && v.schema && /id a1/.test(v.user), v && v.user);
  ok('...including the gap it was opened on and the hold clock', /was 5\.0c at entry/.test(v.user) && /held 90m of 240m/.test(v.user), v.user);
  ok('the signature ignores a tenth of a cent of wobble', minds.RIGO.view(R([pos({ mark: 0.3804 })])).signature === minds.RIGO.view(R([pos({ mark: 0.3811 })])).signature);
  ok('...and moves on a whole-cent slide', minds.RIGO.view(R([pos({ mark: 0.35 })])).signature !== v.signature);

  const E = R([pos(), pos({ id: 'a2' })]);
  const out = minds.RIGO.apply(E, say([exit('a1'), { positionId: 'a2', action: 'hold', conviction: 0.9, reason: 'fine' }]));
  ok('an exit becomes an exit at the position mark, and a hold becomes nothing', out.size === 1 && out.get('a1').px === 0.38 && /^mind: /.test(out.get('a1').reason), [...out]);
  ok('an exit on a position that is not open is dropped', minds.RIGO.apply(E, say([exit('ghost')])).size === 0);
  ok('a weakly held exit is dropped', minds.RIGO.apply(E, say([exit('a1', 0.59)])).size === 0);
  ok('a non-finite conviction is dropped, not read as sure', minds.RIGO.apply(E, say([exit('a1', NaN)])).size === 0);
  ok('an arb leg named by the mind is dropped', minds.RIGO.apply(R([pos({ id: 'x', strategy: 'arb' })]), say([exit('x')])).size === 0);
  ok('an orphaned leg named by the mind is left to the retry loop', minds.RIGO.apply(R([pos({ id: 'x', orphan: true })]), say([exit('x')])).size === 0);
  ok('garbage in gives an empty map, never a throw', minds.RIGO.apply(E, null).size === 0 && minds.RIGO.apply(E, { decisions: 'exit everything' }).size === 0);
  ok('an answer cannot open or resize: nothing but an exit map comes out', [...minds.RIGO.apply(E, say([exit('a1')])).values()].every((x) => Object.keys(x).sort().join() === 'px,reason'));
  ok('a stale answer is not trusted by the desk', minds.RIGO_MAX_AGE_MS === 120000);
}

group('per-desk switch: BRAIN turns the layer on, BRAIN_AGENTS picks the desks');
{
  const on = new Brain({ ...cfg, brainEnabled: true, brainAgents: ['RIGO'] });
  on.key = 'sk-ant-fake';
  ok('a listed desk may think', on.enabled('RIGO') === true);
  ok('an unlisted desk may not, whatever BRAIN says', on.enabled('ILSA') === false && on.enabled('BRAM') === false);
  ok('the layer as a whole reads as live', on.enabled() === true);
  let built = false;
  on.refresh('ILSA', () => { built = true; return null; });
  ok('an unlisted desk does not even build its view', built === false);
  const noKey = new Brain({ ...cfg, brainEnabled: true, brainAgents: ['RIGO'] });
  noKey.key = '';
  ok('no key: no desk thinks', noKey.enabled('RIGO') === false);
  ok('the default list is ILSA, the behaviour BRAIN=1 always meant', cfg.brainAgents.join() === 'ILSA', cfg.brainAgents);
}

group('RIGO end to end: the deterministic exits run first, the mind only ever shortens');
pending.push(async () => {
  const now = Date.now();
  const mk = (id, over = {}) => ({ id, pairId: 'p1', label: 'Fixture ' + id, venue: 'PM', side: 'yes', qty: 10, entry: 0.40, mark: 0.40,
    strategy: 'converge', openedAt: now - 60 * 60000, closesAt: null, entryGap: 0.05, cost: 4, ...over });
  const closes = [];
  const run = async ({ positions, advice, enabled = true }) => {
    closes.length = 0;
    const E = {
      cfg, pairs: [mkPair()], state: { positions, stats: { realized: 0 } }, log() {}, touch() {}, due: () => false,
      resolution: async () => null, markPrice: (p) => p.mark, close: async (p, px, reason) => { closes.push({ id: p.id, px, reason }); },
      brain: { enabled: (a) => enabled && a === 'RIGO', refresh() {}, advice: () => advice },
    };
    await agents.RIGO(E);
    return closes.slice();
  };
  const say = (...d) => ({ note: 'n', commentary: 'c', decisions: d });
  const ex = (id) => ({ positionId: id, action: 'exit', conviction: 0.9, reason: 'gap gone' });

  let c = await run({ positions: [mk('a')], advice: say(ex('a')) });
  ok('a mind exit closes the position it named', c.length === 1 && c[0].id === 'a' && /^mind: gap gone/.test(c[0].reason), c);
  c = await run({ positions: [mk('a'), mk('b')], advice: say(ex('a')) });
  ok('...and only that one', c.length === 1 && c[0].id === 'a', c);
  c = await run({ positions: [mk('a')], advice: say({ positionId: 'a', action: 'hold', conviction: 1, reason: 'x' }) });
  ok('a hold changes nothing', c.length === 0, c);
  c = await run({ positions: [mk('a')], advice: say(ex('a')), enabled: false });
  ok('with the desk switched off the answer is ignored', c.length === 0, c);
  c = await run({ positions: [mk('a')], advice: null });
  ok('no answer yet: the desk behaves as it always did', c.length === 0, c);
  c = await run({ positions: [mk('a', { openedAt: now - 300 * 60000 })], advice: say({ positionId: 'a', action: 'hold', conviction: 1, reason: 'wait' }) });
  ok('a mind cannot keep a position past max hold: the rule exits it regardless', c.length === 1 && /max hold/.test(c[0].reason), c);
  c = await run({ positions: [mk('a', { strategy: 'arb', group: 'g' })], advice: say(ex('a')) });
  ok('an arb leg is never closed on a mind\'s word', c.length === 0, c);

  // a failing mind must say so in the log, once per window, and say why
  const logs = [];
  const E2 = { cfg, pairs: [mkPair()], state: { positions: [mk('a')], stats: { realized: 0 } }, log: (...a) => logs.push(a), touch() {}, due: (() => { const seen = new Set(); return (k) => (seen.has(k) ? false : (seen.add(k), true)); })(),
    resolution: async () => null, markPrice: (p) => p.mark, close: async () => {},
    brain: { enabled: (a) => a === 'RIGO', refresh() {}, advice: () => null, failures: new Map([['RIGO', 3]]), lastError: 'RIGO: HTTP 401 invalid x-api-key' } };
  await agents.RIGO(E2); await agents.RIGO(E2);
  const bad = logs.filter((l) => /mind failing/.test(l[3]));
  ok('a failing mind is logged with its count and its reason', bad.length === 1 && /3 in a row/.test(bad[0][3]) && /401/.test(bad[0][3]), logs);
  ok('...as an OPS line, and only once per window', bad[0][1] === 'OPS' && bad.length === 1);
  const E3 = { ...E2, brain: { ...E2.brain, failures: new Map() } }; logs.length = 0;
  await agents.RIGO(E3);
  ok('a healthy mind logs nothing about failures', !logs.some((l) => /mind failing/.test(l[3])), logs);
});

// Everything above is synchronous except the handful of assertions that have to wait for a
// fire-and-forget turn to settle. Drain those, then report.
(async () => {
  for (const f of pending) await f();
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();

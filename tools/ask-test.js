'use strict';
// Assertions for the Ask panel (src/ask.js, src/ask-tools.js). Zero dependencies, NO NETWORK, and
// the panel's clock is pinned: every call to Anthropic goes to a scripted stub.
//
// What is pinned here is not what the model says but what the harness does around it: the tool
// loop's shape (every result back in one message, a failing tool as is_error), pause_turn, the
// refusal, the round cap, the budget, the conversation staying append-only, the limits, the exact
// request body, the HTTP locks -- and that no tool can ever hand back a secret.
//
//   node tools/ask-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const EventEmitter = require('events');
const { Engine } = require('../src/engine');
const base = require('../src/config');
const { routeAsk, actionRefusal, rebindRefusal, echoable, withTailMark, answerText, TOOLS, SYSTEM } = require('../src/ask');
const tools = require('../src/ask-tools');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

const T0 = Date.parse('2026-09-14T14:00:00Z');       // 10:00 ET
const ET_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
const TODAY = ET_DAY.format(new Date(T0));
const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-ask-')); dirs.push(d); return d; };
const copy = (x) => JSON.parse(JSON.stringify(x));
const stripMarks = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k === 'cache_control' ? undefined : v)));

// ---- scripted responses ----------------------------------------------------------------------
const usage = (o = {}) => ({ input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...o });
const R = {
  text: (t, u) => ({ model: 'claude-opus-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig-answer' }, { type: 'text', text: t }], usage: usage(u) }),
  tools: (uses, u) => ({
    model: 'claude-opus-5', stop_reason: 'tool_use', usage: usage(u),
    content: [{ type: 'thinking', thinking: '', signature: 'sig-tools' }, { type: 'text', text: 'Let me look that up.' }, ...uses.map(([id, name, input]) => ({ type: 'tool_use', id, name, input }))],
  }),
  pause: () => ({ model: 'claude-opus-5', stop_reason: 'pause_turn', content: [{ type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'Everton score' } }], usage: usage({ server_tool_use: { web_search_requests: 1 } }) }),
  refusal: () => ({ model: 'claude-opus-5', stop_reason: 'refusal', stop_details: { category: 'cyber' }, content: [], usage: usage({ input_tokens: 0, output_tokens: 0 }) }),
};
const httpErr = (status, msg) => Object.assign(new Error(`HTTP ${status} ${msg}`), { status });

// A real Engine over a temp dir with the transport replaced by the script. Nothing here can reach
// the network: the only thing that would is brain._post, and it is the stub.
function setup(over = {}) {
  const cfg = { ...base, mode: 'paper', demo: false, dataDir: tmp(), record: false, makerEnabled: false, whaleWatch: false,
    askEnabled: true, askModel: 'claude-opus-5', askEffort: 'medium', askDailyUsd: 3, askMaxRounds: 8, askTimeoutMs: 120000, ...over };
  const E = new Engine(cfg);
  E.log = () => {};
  E.journalled = [];
  E.journal = (_e, kind, data) => E.journalled.push({ kind, data });
  E.brain.key = 'sk-ant-test-not-a-key';
  const calls = [], script = [];
  E.brain._post = async (body, timeoutMs, headers) => {
    calls.push({ body: copy(body), timeoutMs, headers: { ...headers } });
    const next = script.shift();
    if (!next) throw new Error('the script ran out');
    return typeof next === 'function' ? next(body) : next;
  };
  const ask = E.ask;
  let clock = T0;
  ask.now = () => clock;
  const slept = [];
  ask.sleep = async (ms) => { slept.push(ms); };
  ask._rollDay();
  return { E, ask, calls, script, slept, tick: (ms) => { clock += ms; } };
}
async function askAndWait(ask, q, conv) {
  const r = ask.start(q, conv);
  if (r.ok) await ask.wait(r.id);
  return { r, job: r.ok ? ask.job(r.id) : null };
}
const deferred = () => { let release; const p = new Promise((res) => { release = res; }); return { p, release }; };

(async () => {
  // -------------------------------------------------------------------------------------------
  group('the request body: adaptive thinking, effort, a cached stable prefix, web search, fallbacks');
  {
    const { ask, calls, script } = setup();
    script.push(R.text('The desk has $10,000.00 in cash.'));
    const { r, job } = await askAndWait(ask, 'How much cash does the desk have?');
    ok('the question starts', r.ok && typeof r.id === 'string' && typeof r.conversation === 'string', r);
    ok('and is answered', job.status === 'done' && job.answer === 'The desk has $10,000.00 in cash.', job);
    const { body, headers, timeoutMs } = calls[0];
    ok('model is ASK_MODEL', body.model === 'claude-opus-5', body.model);
    ok('max_tokens 16000', body.max_tokens === 16000, body.max_tokens);
    ok('adaptive thinking', JSON.stringify(body.thinking) === '{"type":"adaptive"}', body.thinking);
    ok('effort rides in output_config', body.output_config && body.output_config.effort === 'medium', body.output_config);
    const raw = JSON.stringify(body);
    ok('no budget_tokens anywhere', !raw.includes('budget_tokens'));
    ok('no sampling parameters', !('temperature' in body) && !('top_p' in body) && !('top_k' in body), Object.keys(body));
    ok('the system prompt carries the cache breakpoint', body.system.length === 1 && body.system[0].cache_control && body.system[0].cache_control.type === 'ephemeral', body.system.map((b) => b.cache_control));
    ok('and holds nothing per request', !JSON.stringify(body.system).includes('How much cash') && !/Asked at|\d{4}-\d{2}-\d{2}/.test(body.system[0].text));
    ok('the question and "now" are in the user turn', /^Asked at 2026-09-14 10:00:00 ET\.\n\nHow much cash does the desk have\?$/.test(body.messages[0].content[0].text), body.messages[0].content[0].text);
    ok('the growing conversation is marked for caching too', body.messages[0].content[0].cache_control && body.messages[0].content[0].cache_control.type === 'ephemeral', body.messages[0]);
    const ws = body.tools.find((t) => t.type === 'web_search_20260209');
    ok('web search is offered, max 3 uses', ws && ws.name === 'web_search' && ws.max_uses === 3, ws);
    const names = body.tools.map((t) => t.name);
    ok('tools are in a fixed name order', JSON.stringify(names) === JSON.stringify([...names].sort()), names);
    ok('every read-only tool is offered', ['activity_log', 'closed_trades', 'desk_overview', 'docs', 'journal', 'maker_status', 'market_data', 'markets', 'open_positions', 'settings', 'whale_bets'].every((n) => names.includes(n)), names);
    ok('no tool_choice on an ordinary round', !('tool_choice' in body), body.tool_choice);
    ok('the refusal fallback is requested', body.fallbacks === 'default' && headers['anthropic-beta'] === 'server-side-fallback-2026-07-01', [body.fallbacks, headers]);
    ok('the per-call timeout is ASK_TIMEOUT_MS', timeoutMs === 120000, timeoutMs);

    script.push(R.text('Nothing is open.'));
    await askAndWait(ask, 'Anything open right now?');
    ok('system and tools are byte-identical across questions', JSON.stringify([calls[0].body.system, calls[0].body.tools]) === JSON.stringify([calls[1].body.system, calls[1].body.tools]));
    ok('the exported prompt is what was sent', calls[0].body.system[0].text === SYSTEM && JSON.stringify(calls[0].body.tools) === JSON.stringify(TOOLS));
  }

  group('cost: every token kind and every search is metered against the day');
  {
    const { ask, script, E } = setup({ askDailyUsd: 10 });
    // $0.50 input + $0.50 output + $0.50 cache read + $0.50 cache write + 2 searches at $0.01
    script.push(R.text('ok', { input_tokens: 100000, output_tokens: 20000, cache_read_input_tokens: 1e6, cache_creation_input_tokens: 80000, server_tool_use: { web_search_requests: 2 } }));
    const { job } = await askAndWait(ask, 'cost check');
    ok('the question costs $2.02', job.usd === 2.02, job.usd);
    ok('two searches counted', job.searches === 2, job.searches);
    ok('the day spend matches', ask.daySpend === 2.02, ask.daySpend);
    const snap = ask.snapshot();
    ok('the snapshot says what is left', snap.spentUsd === 2.02 && snap.budgetLeft === 7.98 && snap.reason === 'live · $7.98 left today', snap);
    ok('the question is journalled with its cost', E.journalled.some((j) => j.kind === 'ASK' && j.data.usd === 2.02 && j.data.status === 'done'), E.journalled);
    const snap2 = setup({ askDailyUsd: 10 }).ask;
    snap2.day = '1999-01-01'; snap2.daySpend = 9;
    ok('a new Eastern day resets the spend', snap2.snapshot().spentUsd === 0, snap2.snapshot());
  }

  // -------------------------------------------------------------------------------------------
  group('parallel tool calls come back as ONE user message, in order');
  {
    const { ask, calls, script } = setup();
    script.push(R.tools([['toolu_1', 'desk_overview', {}], ['toolu_2', 'open_positions', {}]]));
    script.push(R.text('Cash is $10,000.00 and nothing is open.'));
    const { job } = await askAndWait(ask, 'How is the desk doing?');
    ok('two calls to the model', calls.length === 2, calls.length);
    const sent = calls[1].body.messages;
    const lastMsg = sent[sent.length - 1];
    ok('the results are one user message', lastMsg.role === 'user' && lastMsg.content.length === 2, lastMsg);
    ok('one tool_result per tool_use, same order', lastMsg.content.map((b) => `${b.type}:${b.tool_use_id}`).join(',') === 'tool_result:toolu_1,tool_result:toolu_2', lastMsg.content.map((b) => b.tool_use_id));
    ok('neither is an error', lastMsg.content.every((b) => !b.is_error));
    ok('results are text', lastMsg.content.every((b) => typeof b.content === 'string' && b.content.startsWith('{')), lastMsg.content.map((b) => typeof b.content));
    const asst = sent[sent.length - 2];
    ok('the assistant turn is sent back whole, thinking and signature included', asst.role === 'assistant' && asst.content[0].type === 'thinking' && asst.content[0].signature === 'sig-tools' && asst.content.filter((b) => b.type === 'tool_use').length === 2, asst);
    ok('the answer is the final text, not the preamble', job.answer === 'Cash is $10,000.00 and nothing is open.', job.answer);
    const steps = job.steps.map((s) => s.text);
    ok('each tool call shows a plain step', steps.includes('reading the desk overview') && steps.includes('reading open positions'), steps);
    ok('steps are {at, text}', job.steps.every((s) => typeof s.at === 'number' && typeof s.text === 'string' && Object.keys(s).length === 2), job.steps);
  }

  group('a failing tool is an is_error result, never a missing one');
  {
    const { ask, calls, script } = setup();
    script.push(R.tools([['toolu_a', 'journal', { date: '../../etc/passwd' }], ['toolu_b', 'place_order', { side: 'yes' }], ['toolu_c', 'settings', { contains: 'mingap' }]]));
    script.push(R.text('Done.'));
    const { job } = await askAndWait(ask, 'try the tools');
    const res = calls[1].body.messages.at(-1).content;
    ok('all three results are there', res.length === 3 && res.map((b) => b.tool_use_id).join() === 'toolu_a,toolu_b,toolu_c', res);
    ok('a bad date is an error the model can read', res[0].is_error === true && /date must be an Eastern date/.test(res[0].content), res[0]);
    ok('an unknown tool is an error, and nothing ran', res[1].is_error === true && /no tool called place_order/.test(res[1].content), res[1]);
    ok('the good call still succeeds', !res[2].is_error && /MIN_GAP/.test(res[2].content), res[2]);
    ok('the question still finishes', job.status === 'done', job);
  }

  group('pause_turn continues the same assistant turn, bounded');
  {
    const { ask, calls, script } = setup();
    script.push(R.pause());
    script.push({
      model: 'claude-opus-5', stop_reason: 'end_turn', usage: usage(),
      content: [{ type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{ type: 'web_search_result', url: 'https://example.com', title: 'Score' }] }, { type: 'text', text: 'Everton won 2-1 (from the web).' }],
    });
    const { r, job } = await askAndWait(ask, 'Did Everton win?');
    ok('resent once to continue', calls.length === 2, calls.length);
    const second = calls[1].body.messages;
    ok('the paused turn is resent as the trailing assistant message, no "continue" added', second.length === 2 && second[1].role === 'assistant' && second[1].content[0].type === 'server_tool_use', second);
    ok('the continuation still marks the question for caching, where the paused request wrote it', second[0].content[0].cache_control && second[0].content[0].cache_control.type === 'ephemeral' && !JSON.stringify(second[1]).includes('cache_control'), second);
    const conv = ask.convs.get(r.conversation);
    ok('the history holds ONE assistant message with both halves', conv.messages.length === 2 && conv.messages[1].content.map((b) => b.type).join() === 'server_tool_use,web_search_tool_result,text', conv.messages.map((m) => m.role));
    ok('the answer', job.answer === 'Everton won 2-1 (from the web).', job.answer);
    ok('the web search shows as a step', job.steps.some((s) => s.text === 'searching the web: Everton score'), job.steps);
    ok('the search is counted', job.searches === 1, job.searches);

    const b = setup();
    for (let i = 0; i < 10; i++) b.script.push(R.pause());
    const { job: j2 } = await askAndWait(b.ask, 'search forever');
    ok('an endless pause stops', j2.status === 'error' && /ran too long/.test(j2.error), j2);
    ok('after a bounded number of resumes', b.calls.length === 5, b.calls.length);
  }

  group('a refusal is said plainly and leaves no trace in the chat');
  {
    const { ask, calls, script } = setup();
    script.push(R.refusal());
    const { r, job } = await askAndWait(ask, 'something the classifier dislikes');
    ok('the job errors in plain words', job.status === 'error' && /couldn't answer that one/.test(job.error), job);
    ok('the chat keeps nothing from it', ask.convs.get(r.conversation).messages.length === 0);
    script.push(R.text('Fine.'));
    const { job: j2 } = await askAndWait(ask, 'a normal follow-up', r.conversation);
    ok('a follow-up still works', j2.status === 'done', j2);
    ok('and sends only its own question', calls[1].body.messages.length === 1, calls[1].body.messages.length);
  }

  group('the round cap ends with an answer, never a loop, and never re-writes the cache');
  {
    const { ask, calls, script } = setup({ askMaxRounds: 2 });
    const told = (body) => body.messages.at(-1).content.some((b) => b.type === 'text' && /last lookup/.test(b.text));
    const again = (body) => (told(body) ? R.text('Best answer with what I found.') : R.tools([[`toolu_${calls.length}`, 'desk_overview', {}]]));
    script.push(again, again, again, again);
    const { r, job } = await askAndWait(ask, 'keep looking');
    ok('two tool rounds, then one call told to answer', calls.length === 3, calls.length);
    ok('no call changes tool choice: that would re-write the whole chat\'s cache', calls.every((c) => !('tool_choice' in c.body)), calls.map((c) => c.body.tool_choice));
    ok('the last call still offers the same tools', JSON.stringify(calls[2].body.tools) === JSON.stringify(calls[0].body.tools));
    const tail = calls[2].body.messages.at(-1).content;
    ok('and says why, after the results', tail.at(-1).type === 'text' && /last lookup/.test(tail.at(-1).text) && tail[0].type === 'tool_result', tail.map((b) => b.type));
    ok('the answer lands', job.status === 'done' && job.answer === 'Best answer with what I found.', job);
    ok('the whole turn is kept', ask.convs.get(r.conversation).messages.length === 6, ask.convs.get(r.conversation).messages.length);

    const b = setup({ askMaxRounds: 1 });
    b.script.push(R.tools([['toolu_x', 'settings', {}]]), R.tools([['toolu_y', 'settings', {}], ['toolu_z', 'markets', {}]]), R.text('Answer from what I had.'));
    const { r: rb, job: jb } = await askAndWait(b.ask, 'ignore the cap');
    ok('a model that asks for a lookup anyway still ends with an answer', jb.status === 'done' && jb.answer === 'Answer from what I had.', jb);
    ok('after exactly one call with tools switched off', b.calls.length === 3 && !b.calls[1].body.tool_choice && b.calls[2].body.tool_choice && b.calls[2].body.tool_choice.type === 'none', b.calls.map((c) => c.body.tool_choice));
    const denied = b.calls[2].body.messages.at(-1).content;
    ok('every lookup it asked for gets an error result, and none runs', denied.length === 3 && denied[0].is_error && denied[0].tool_use_id === 'toolu_y' && denied[1].is_error && denied[1].tool_use_id === 'toolu_z' && denied[2].type === 'text' && b.ask.jobs.get(rb.id).toolCalls === 1, denied);
    ok('the forced call repeats the one before it exactly (markers aside)', JSON.stringify(stripMarks(b.calls[2].body.messages.slice(0, b.calls[1].body.messages.length))) === JSON.stringify(stripMarks(b.calls[1].body.messages)));

    const c = setup({ askMaxRounds: 1 });
    c.script.push(R.tools([['toolu_x', 'settings', {}]]), R.tools([['toolu_y', 'settings', {}]]), R.tools([['toolu_z', 'settings', {}]]), R.text('never sent'));
    const { job: jc } = await askAndWait(c.ask, 'ignore the cap twice');
    ok('a tool call even with tools off gets a plain stop', jc.status === 'error' && /more lookups than one question allows/.test(jc.error), jc);
    ok('with no further calls', c.calls.length === 3, c.calls.length);
  }

  group('one round runs at most twelve lookups; the rest come back as errors');
  {
    const { ask, calls, script } = setup();
    script.push(R.tools(Array.from({ length: 14 }, (_, i) => [`toolu_${i}`, 'settings', { contains: 'maker' }])), R.text('ok'));
    const { r, job } = await askAndWait(ask, 'fan out');
    const res = calls[1].body.messages.at(-1).content;
    ok('all fourteen get a result, in order', res.length === 14 && res.every((x, i) => x.tool_use_id === `toolu_${i}`), res.map((x) => x.tool_use_id));
    ok('twelve ran', ask.jobs.get(r.id).toolCalls === 12 && res.slice(0, 12).every((x) => !x.is_error), ask.jobs.get(r.id).toolCalls);
    ok('the last two are errors that say why', res.slice(12).every((x) => x.is_error && /at most 12 lookups/.test(x.content)), res.slice(12));
    ok('and the question still finishes', job.status === 'done', job);
  }

  group('max_tokens: a usable partial answer is kept and labelled');
  {
    const { ask, script } = setup();
    script.push({ ...R.text('The desk made $4.10 today, mostly from'), stop_reason: 'max_tokens' });
    const { job } = await askAndWait(ask, 'long one');
    ok('done, marked as cut off', job.status === 'done' && /mostly from\n\n\(The answer was cut off here\.\)$/.test(job.answer), job.answer);
  }

  // -------------------------------------------------------------------------------------------
  group('the budget: refused before a question, stopped inside one');
  {
    const { ask, script, calls } = setup({ askDailyUsd: 3 });
    ask.daySpend = 3;
    const r = ask.start('How much cash?');
    ok('a spent day refuses to start', !r.ok && /spent/.test(r.error), r);
    ok('and calls nothing', calls.length === 0);
    const snap = ask.snapshot();
    ok('the snapshot says it is off and why', snap.enabled === false && /spent/.test(snap.reason) && snap.budgetLeft === 0, snap);

    const b = setup({ askDailyUsd: 1 });
    b.script.push(R.tools([['toolu_1', 'desk_overview', {}]], { input_tokens: 300000 }));   // $1.50
    b.script.push(R.text('never sent'));
    const { r: r2, job } = await askAndWait(b.ask, 'expensive');
    ok('running out mid-question stops with a clear message', job.status === 'error' && /ran out while answering/.test(job.error), job);
    ok('before the next round is bought', b.calls.length === 1, b.calls.length);
    ok('the half-finished turn is not kept', b.ask.convs.get(r2.conversation).messages.length === 0);
    ok('and it still counted the spend', job.usd === 1.5013 && b.ask.daySpend === 1.5013, [job.usd, b.ask.daySpend]);
    void script;
  }

  group('the budget is a ceiling: the most a call can cost is held before it goes out');
  {
    const { ask, script } = setup();
    ok('the most a new question\'s first call can cost is about $0.45 on Opus 5 (16,000 output tokens, the prompt written to cache, 3 searches)', ask.minCallUsd > 0.42 && ask.minCallUsd < 0.5, ask.minCallUsd);
    ask.daySpend = 3 - ask.minCallUsd * 0.9;
    const s1 = ask.snapshot();
    ok('less left than one question can cost: off, and it says so', s1.enabled === false && /less than one question can cost/.test(s1.reason) && s1.budgetLeft > 0.3, s1);
    ok('and a question is refused before any call', !ask.start('anything?').ok);

    const b = setup();
    b.ask.daySpend = 3 - b.ask.minCallUsd * 1.5;
    const d = deferred();
    b.script.push(() => d.p);
    const first = b.ask.start('first');
    ok('with room for one question, one starts', first.ok, first);
    await new Promise((res) => setImmediate(res));
    ok('its worst case is held while its call is out', b.ask.held > 0.42 && b.calls.length === 1, [b.ask.held, b.calls.length]);
    const second = b.ask.start('second, in another chat');
    ok('a second question cannot spend the same last dollar', !second.ok && /held for the questions being answered/.test(second.error), second);
    d.release(R.text('one'));
    await b.ask.wait(first.id);
    ok('the hold is released when the call returns, and only real usage stays', b.ask.held === 0 && b.ask.jobs.get(first.id).usd === 0.0018, [b.ask.held, b.ask.jobs.get(first.id).usd]);

    const c = setup();
    c.script.push(R.text('first answer'));
    const { r: rc } = await askAndWait(c.ask, 'start a chat');
    const conv = c.ask.convs.get(rc.conversation);
    conv.messages.push({ role: 'user', content: [{ type: 'text', text: 'y'.repeat(250000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    c.ask.daySpend = 3 - 0.8;
    const follow = c.ask.start('and now?', rc.conversation);
    ok('a follow-up in a long chat starts (the day has room for a short question)', follow.ok, follow);
    await c.ask.wait(follow.id);
    const jf = c.ask.job(follow.id);
    ok('but its call, which could cost more than is left, is never made', jf.status === 'error' && /cannot cover a question in a chat this long · start a new chat/.test(jf.error) && c.calls.length === 1, [jf.error, c.calls.length]);
    ok('and nothing was charged for it', jf.usd === 0, jf.usd);
  }

  group('a question that pulls in too much stops before sending it');
  {
    const { ask, calls, script, E } = setup({ askDailyUsd: 50 });
    for (let i = 0; i < 500; i++) E.state.log.push({ t: T0 - i * 1000, agent: 'BRAM', kind: 'RESEARCH', pnl: null, text: `gate ledger ${'8 gap under minGap · '.repeat(14)}${i}` });
    script.push(R.text('hi'));
    const { r } = await askAndWait(ask, 'start');
    const conv = ask.convs.get(r.conversation);
    conv.messages.push({ role: 'user', content: [{ type: 'text', text: 'y'.repeat(295000) }] }, { role: 'assistant', content: [{ type: 'text', text: 'ok' }] });
    script.push(R.tools(Array.from({ length: 12 }, (_, i) => [`toolu_${i}`, 'activity_log', { limit: 100 }])), R.text('never sent'));
    const { job } = await askAndWait(ask, 'read the whole log twelve times', r.conversation);
    ok('the round that would push the request past the limit is not sent', job.status === 'error' && /more than one request can carry/.test(job.error) && calls.length === 2, [job.error, calls.length]);
  }

  group('a call whose reply never arrived is still charged: the API may have finished it');
  {
    const timeout = () => { throw Object.assign(new Error('timed out after 120000ms'), { status: 408 }); };
    const a = setup();
    a.script.push(timeout);
    const { job } = await askAndWait(a.ask, 'slow one');
    const most = a.ask._worstCase(a.ask._body([{ role: 'user', content: [{ type: 'text', text: `Asked at 2026-09-14 10:00:00 ET.\n\nslow one` }] }], false));
    ok('a timeout is an error that says so, and what it counted', job.status === 'error' && /took longer than 120s/.test(job.error) && /\$0\.4\d is counted against today's budget/.test(job.error), job.error);
    ok('charged the most that call could cost', job.usd === most && a.ask.daySpend === most && most > 0.42, [job.usd, a.ask.daySpend, most]);
    ok('journalled as an estimated charge', a.E.journalled.some((j) => j.kind === 'ASK_SPEND' && j.data.estimated === true && j.data.usd === most), a.E.journalled);
    ok('and not retried: a slow model is slow again, at the same price', a.calls.length === 1, a.calls.length);

    const b = setup();
    b.script.push(() => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other side closed'), { code: 'UND_ERR_SOCKET' }) }); }, R.text('second try'));
    const { job: jb } = await askAndWait(b.ask, 'dropped');
    ok('a dropped connection is retried once', jb.status === 'done' && jb.answer === 'second try' && b.calls.length === 2, jb);
    ok('the first attempt is charged as well as the second', jb.usd > 0.42 && b.E.journalled.filter((j) => j.kind === 'ASK_SPEND').length === 2, [jb.usd, b.E.journalled]);
    ok('and the step says what happened', jb.steps.some((s) => /connection dropped/.test(s.text)), jb.steps);

    const c = setup();
    const refused = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) }); };
    const neverOpened = () => { throw Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('Connect Timeout Error'), { code: 'UND_ERR_CONNECT_TIMEOUT' }) }); };
    c.script.push(refused, neverOpened);
    const { job: jc } = await askAndWait(c.ask, 'no network');
    ok('a connection that was never made costs nothing', jc.status === 'error' && jc.usd === 0 && c.ask.daySpend === 0 && !c.E.journalled.some((j) => j.kind === 'ASK_SPEND'), [jc, c.ask.daySpend]);

    const d = setup();
    d.script.push(() => { throw httpErr(529, 'overloaded'); }, () => { throw httpErr(529, 'overloaded'); });
    const { job: jd } = await askAndWait(d.ask, 'busy');
    ok('an error Anthropic answered with costs nothing', jd.status === 'error' && jd.usd === 0 && /having trouble/.test(jd.error), jd);
  }

  group('a rate limit waits as long as Anthropic asks, or says how long');
  {
    const a = setup();
    a.script.push(() => { throw Object.assign(httpErr(429, 'rate_limit_error'), { retryAfter: 45 }); }, R.text('after the wait'));
    const { job } = await askAndWait(a.ask, 'q');
    ok('retry-after 45s is waited in full, then retried', job.status === 'done' && a.slept.length === 1 && a.slept[0] === 45000 && a.calls.length === 2, [a.slept, a.calls.length]);
    ok('and the step says how long', job.steps.some((s) => s.text === 'the API was busy, trying again in 45s'), job.steps);

    const b = setup();
    b.script.push(() => { throw Object.assign(httpErr(429, 'rate_limit_error'), { retryAfter: 120 }); });
    const { job: jb } = await askAndWait(b.ask, 'q');
    ok('a wait longer than a minute is not sat through', b.slept.length === 0 && b.calls.length === 1, [b.slept, b.calls.length]);
    ok('the error says when to try again', jb.status === 'error' && /try again in 2 minutes/.test(jb.error), jb.error);
  }

  group('a refusal fallback: every attempt is metered, not just the one that answered');
  {
    const { ask, script } = setup();
    const u = usage({ iterations: [{ type: 'message', model: 'claude-opus-5', input_tokens: 40000, output_tokens: 3000 }, { type: 'fallback_message', model: 'claude-opus-4-8', input_tokens: 100, output_tokens: 50 }] });
    script.push({ ...R.text('answered by the fallback'), model: 'claude-opus-4-8', usage: u });
    const { job } = await askAndWait(ask, 'q');
    const want = 40100 * 5e-6 + 3050 * 25e-6;
    ok('the declined attempt is charged too', Math.abs(job.usd - want) < 1e-4 && Math.abs(ask.daySpend - want) < 1e-4, [job.usd, want]);
    const b = setup();
    b.script.push(R.text('ok', { input_tokens: 1000, output_tokens: 1000, iterations: [{ type: 'message' }] }));
    const { job: jb } = await askAndWait(b.ask, 'q');
    ok('an iterations list without token counts never lowers the charge', Math.abs(jb.usd - (1000 * 5e-6 + 1000 * 25e-6)) < 1e-4, jb.usd);
  }

  group('a restart does not hand out a fresh day: spend is added back up from the journal');
  {
    const dir = tmp();
    const line = (t, kind, data) => JSON.stringify({ t, cycle: 1, mode: 'paper', kind, ...data });
    const YESTERDAY = ET_DAY.format(new Date(T0 - 86400e3)), TOMORROW = ET_DAY.format(new Date(T0 + 86400e3));
    fs.writeFileSync(path.join(dir, `journal-${TODAY}.jsonl`), [
      line('2026-09-14T13:00:00Z', 'ASK_SPEND', { usd: 0.25, searches: 0, model: 'claude-opus-5' }),
      line('2026-09-14T13:01:00Z', 'ASK_SPEND', { usd: 0.4412, searches: 0, model: 'claude-opus-5', estimated: true }),
      line('2026-09-14T13:02:00Z', 'ASK', { status: 'done', usd: 0.69, searches: 0 }),     // the summary: not counted twice
      line('2026-09-14T13:03:00Z', 'OPEN', { usd: 99 }),
      '{"kind":"ASK_SPEND","usd":', 'not json',
    ].join('\n'));
    fs.writeFileSync(path.join(dir, `journal-${YESTERDAY}.jsonl`), line('2026-09-13T13:00:00Z', 'ASK_SPEND', { usd: 2 }));
    fs.writeFileSync(path.join(dir, `journal-${TOMORROW}.jsonl`), line('2026-09-15T13:00:00Z', 'ASK_SPEND', { usd: 0.1 }));
    const { ask, script, E, tick } = setup({ dataDir: dir });
    ok('today\'s ASK_SPEND lines are the day\'s spend so far', ask.daySpend === 0.6912, ask.daySpend);
    ok('and the panel says what is left', ask.snapshot().reason === 'live · $2.31 left today', ask.snapshot());
    script.push(R.text('ok'));
    await askAndWait(ask, 'q');
    const spent = E.journalled.filter((j) => j.kind === 'ASK_SPEND');
    ok('each metered call writes its own ASK_SPEND line', spent.length === 1 && spent[0].data.usd === 0.0018 && !('estimated' in spent[0].data), spent);
    tick(86400e3);
    ok('a new Eastern day starts from that day\'s journal', ask.snapshot().spentUsd === 0.1, ask.snapshot());
  }

  group('conversations are append-only: earlier turns are byte-identical after a follow-up');
  {
    const { ask, calls, script } = setup();
    script.push(R.tools([['toolu_1', 'desk_overview', {}]]), R.text('Cash is $10,000.00.'));
    const { r } = await askAndWait(ask, 'How much cash?');
    const conv = ask.convs.get(r.conversation);
    const before = JSON.stringify(conv.messages);
    const n1 = conv.messages.length;
    ok('the first question stored its whole turn', n1 === 4 && conv.messages.map((m) => m.role).join() === 'user,assistant,user,assistant', conv.messages.map((m) => m.role));
    ok('cache markers are never stored', !before.includes('cache_control'));
    ok('inside a question, each request repeats the last one exactly (markers aside)', JSON.stringify(stripMarks(calls[1].body.messages.slice(0, 1))) === JSON.stringify(stripMarks(calls[0].body.messages)));

    script.push(R.text('It is paper money.'));
    const { job: j2 } = await askAndWait(ask, 'Is that real money?', r.conversation);
    ok('the follow-up is answered', j2.status === 'done' && j2.conversation === r.conversation, j2);
    ok('earlier messages are unchanged, byte for byte', JSON.stringify(conv.messages.slice(0, n1)) === before);
    ok('the follow-up request starts with the stored history exactly', JSON.stringify(calls[2].body.messages.slice(0, n1)) === before);
    ok('and appends the new question after it', calls[2].body.messages.length === n1 + 1 && /Is that real money\?/.test(calls[2].body.messages[n1].content[0].text));
    ok('thinking blocks came back unchanged', conv.messages[1].content[0].signature === 'sig-tools' && conv.messages[3].content[0].signature === 'sig-answer');
    ok('the history grew by exactly the new turn', conv.messages.length === n1 + 2, conv.messages.length);
  }

  // -------------------------------------------------------------------------------------------
  group('limits: one question per chat, two in flight, twelve per chat, an hour idle, twenty chats');
  {
    const { ask, script } = setup();
    const d1 = deferred(), d2 = deferred();
    script.push(() => d1.p, () => d2.p);
    const a = ask.start('first');
    ok('a question starts', a.ok, a);
    const busy = ask.start('second in the same chat', a.conversation);
    ok('the same chat is busy while it runs', !busy.ok && /still working/.test(busy.error), busy);
    const b = ask.start('another chat');
    ok('a second chat may run alongside', b.ok, b);
    const c = ask.start('a third chat');
    ok('a third is refused while two run', !c.ok && /already being answered/.test(c.error), c);
    ok('the snapshot counts two in flight', ask.snapshot().inflight === 2, ask.snapshot());
    ok('a running job reads as working', ask.job(a.id).status === 'working' && ask.job(a.id).answer === null && ask.job(a.id).doneAt === null, ask.job(a.id));
    d1.release(R.text('one')); d2.release(R.text('two'));
    await ask.wait(a.id); await ask.wait(b.id);
    ok('both finish and free their slots', ask.snapshot().inflight === 0 && ask.job(a.id).answer === 'one' && ask.job(b.id).answer === 'two');
  }
  {
    const { ask, script } = setup();
    let conv;
    for (let i = 0; i < 12; i++) {
      script.push(R.text(`answer ${i}`));
      const { r, job } = await askAndWait(ask, `question ${i}`, conv);
      conv = r.conversation;
      if (job.status !== 'done') ok(`question ${i} answered`, false, job);
    }
    const thirteenth = ask.start('one more', conv);
    ok('the thirteenth question in a chat is refused', !thirteenth.ok && /12 questions/.test(thirteenth.error), thirteenth);
  }
  {
    const { ask, script, tick } = setup();
    script.push(R.text('hi'));
    const { r } = await askAndWait(ask, 'hello');
    tick(59 * 60 * 1000);
    ok('a job is still readable inside the hour', ask.job(r.id) !== null);
    tick(2 * 60 * 1000);
    ok('a job is gone after about an hour', ask.job(r.id) === null);
    const late = ask.start('still there?', r.conversation);
    ok('a chat idle for an hour has expired', !late.ok && /expired/.test(late.error), late);
    const unknown = ask.start('hi', 'not-a-real-chat');
    ok('an unknown chat id is refused the same way', !unknown.ok && /expired/.test(unknown.error), unknown);
  }
  {
    const { ask, script, tick } = setup();
    const ids = [];
    for (let i = 0; i < 20; i++) {
      script.push(R.text('ok'));
      const { r } = await askAndWait(ask, `chat ${i}`);
      ids.push(r.conversation);
      tick(1000);
    }
    ok('twenty chats are kept', ask.convs.size === 20, ask.convs.size);
    script.push(R.text('ok'));
    const { r } = await askAndWait(ask, 'chat 21');
    ok('a new chat past twenty still starts', r.ok, r);
    ok('by retiring the chat idle the longest', ask.convs.size === 20 && !ask.convs.has(ids[0]) && ask.convs.has(ids[1]) && ask.convs.has(r.conversation));
  }

  group('questions are validated, and start() never throws');
  {
    const { ask, calls } = setup();
    ok('empty', !ask.start('   ').ok && /type a question/.test(ask.start('   ').error));
    ok('not text', !ask.start({ q: 1 }).ok);
    ok('2,000 characters is allowed to start', ask.start('x'.repeat(2000)).ok);
    const long = ask.start('x'.repeat(2001));
    ok('2,001 is too long', !long.ok && /too long/.test(long.error), long);
    const noKey = setup();
    noKey.E.brain.key = '';
    const nk = noKey.ask.start('hi');
    ok('no key: refused with the contract reason', !nk.ok && nk.error === 'add ANTHROPIC_API_KEY to turn this on', nk);
    const s = noKey.ask.snapshot();
    ok('no key: the snapshot says so', s.enabled === false && s.reason === 'add ANTHROPIC_API_KEY to turn this on', s);
    ok('the snapshot has exactly the contract keys', JSON.stringify(Object.keys(s)) === JSON.stringify(['enabled', 'reason', 'model', 'dailyUsd', 'spentUsd', 'budgetLeft', 'inflight']), Object.keys(s));
    ok('the engine snapshot carries it', JSON.stringify(Object.keys(noKey.E.snapshot().ask)) === JSON.stringify(Object.keys(s)));
    const off = setup({ askEnabled: false });
    ok('ASK=0 is off', !off.ask.start('hi').ok && off.ask.snapshot().enabled === false);
    // a transport that throws synchronously still becomes a job error
    const t = setup();
    t.E.brain._post = () => { throw new Error('socket exploded'); };
    const { job } = await askAndWait(t.ask, 'boom');
    ok('a throwing transport becomes the job error', job.status === 'error' && /socket exploded/.test(job.error), job);
    void calls;
  }

  group('transport: the fallback parameter is dropped for good if rejected; a busy API is retried once');
  {
    const { ask, calls, script } = setup();
    script.push(() => { throw httpErr(400, '{"type":"error","error":{"type":"invalid_request_error","message":"fallbacks: Extra inputs are not permitted"}}'); });
    script.push(R.text('ok'));
    const { job } = await askAndWait(ask, 'q');
    ok('the question still answers', job.status === 'done', job);
    ok('the retry has no fallbacks and no beta header', calls[1].body.fallbacks === undefined && !calls[1].headers['anthropic-beta'], calls[1]);
    script.push(R.text('ok'));
    await askAndWait(ask, 'q2');
    ok('and later questions do not try again', calls[2].body.fallbacks === undefined, calls[2].body.fallbacks);

    const b = setup();
    b.script.push(() => { throw httpErr(529, 'overloaded'); }, R.text('second try'));
    const { job: j2 } = await askAndWait(b.ask, 'q');
    ok('an overloaded API is retried once', j2.status === 'done' && j2.answer === 'second try' && b.calls.length === 2, j2);
    ok('and says so', j2.steps.some((s) => /busy/.test(s.text)), j2.steps);

    const c = setup();
    c.script.push(() => { throw httpErr(401, '{"error":{"message":"invalid x-api-key"}}'); });
    const { job: j3 } = await askAndWait(c.ask, 'q');
    ok('a refused key is explained, not retried', j3.status === 'error' && /refused the key/.test(j3.error) && c.calls.length === 1, j3);
  }

  group('errors are scrubbed for secrets, like tool output');
  {
    const { ask, E, script, calls } = setup({ flattenToken: 'PLANTED-flatten-token-1a2b3c4d' });
    const key = 'sk-ant-PLANTED-9f8e7d6c\nsecond-half-of-a-two-line-paste';
    E.brain.key = key;
    script.push(() => { throw new TypeError(`Headers.append: "${key}" is an invalid header value.`); });
    const { job } = await askAndWait(ask, 'q');
    ok('a malformed key is named, not quoted', job.status === 'error' && /ANTHROPIC_API_KEY looks malformed/.test(job.error) && !job.error.includes('PLANTED'), job.error);
    ok('and costs nothing: the request never left', job.usd === 0, job.usd);
    script.push(() => { throw new Error(`something odd happened near ${key} and PLANTED-flatten-token-1a2b3c4d`); });
    const { job: j2 } = await askAndWait(ask, 'q2');
    ok('any other error text is scrubbed of secret values', j2.status === 'error' && !j2.error.includes('PLANTED') && j2.error.includes('[redacted]'), j2.error);
    script.push(R.tools([['toolu_s', 'PLANTED-flatten-token-1a2b3c4d', {}]]), R.text('ok'));
    const { job: j3 } = await askAndWait(ask, 'q3');
    const res = calls.at(-1).body.messages.at(-1).content[0];
    ok('a tool error is scrubbed before it goes to the model', j3.status === 'done' && res.tool_use_id === 'toolu_s' && res.is_error && !res.content.includes('PLANTED') && res.content.includes('[redacted]'), res);
  }

  group('pure helpers');
  {
    const blocks = [
      { type: 'thinking', thinking: '', signature: 's1' }, { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'server_tool_use', id: 'a', name: 'web_search', input: {} }, { type: 'web_search_tool_result', tool_use_id: 'a', content: [] },
      { type: 'server_tool_use', id: 'b', name: 'web_search', input: {} }, { type: 'text', text: 'partial' },
      { type: 'fallback', from: { model: 'claude-opus-5' }, to: { model: 'claude-opus-4-8' } },
      { type: 'thinking', thinking: '', signature: 's2' }, { type: 'text', text: 'rest' },
    ];
    ok('echoable drops what the fallback model cannot use, before the boundary only',
      echoable(blocks).map((b) => b.type + (b.id || b.signature || '')).join() === 'server_tool_usea,web_search_tool_result,text,fallback,thinkings2,text', echoable(blocks).map((b) => b.type));
    const plainBlocks = [{ type: 'thinking', signature: 'x' }, { type: 'text', text: 'hi' }];
    ok('echoable leaves an ordinary response untouched (same array)', echoable(plainBlocks) === plainBlocks);
    const msgs = [{ role: 'user', content: [{ type: 'text', text: 'a' }] }];
    const marked = withTailMark(msgs);
    ok('withTailMark marks a copy', marked[0].content[0].cache_control && !msgs[0].content[0].cache_control);
    const cont = withTailMark([...msgs, { role: 'assistant', content: [{ type: 'text', text: 'b' }] }]);
    ok('withTailMark on a paused turn marks the user message before it, not the assistant one', cont[0].content[0].cache_control && cont[1].content[0].cache_control === undefined && !msgs[0].content[0].cache_control, cont);
    ok('answerText skips the narration before a search', answerText([{ type: 'text', text: 'Let me check.' }, { type: 'server_tool_use', id: 'a' }, { type: 'web_search_tool_result', tool_use_id: 'a' }, { type: 'text', text: 'Final ' }, { type: 'text', text: 'answer' }]) === 'Final answer');
  }

  // -------------------------------------------------------------------------------------------
  group('HTTP routes: the alert actions\' locks, a small JSON body, the job shape');
  {
    const { ask, script } = setup();
    const req = ({ method = 'POST', headers = {}, body = null } = {}) => {
      const r = new EventEmitter();
      r.method = method;
      r.headers = { host: 'localhost:8787', ...headers };
      r.destroy = () => {};
      setImmediate(() => { if (body != null) r.emit('data', Buffer.from(body)); r.emit('end'); r.emit('close'); });
      return r;
    };
    const H = { 'x-hexagon-action': '1', 'content-type': 'application/json' };
    let out = await routeAsk(ask, req({ method: 'GET', headers: H }), '/api/ask');
    ok('GET /api/ask is refused', out.status === 405, out);
    out = await routeAsk(ask, req({ headers: { 'content-type': 'application/json' }, body: '{"question":"hi"}' }), '/api/ask');
    ok('no action header is refused', out.status === 403 && /action header/.test(out.text), out);
    out = await routeAsk(ask, req({ headers: { ...H, origin: 'https://evil.example' }, body: '{"question":"hi"}' }), '/api/ask');
    ok('a foreign Origin is refused', out.status === 403 && /cross-origin/.test(out.text), out);
    out = await routeAsk(ask, req({ headers: { ...H, origin: 'http://localhost:9999' }, body: '{"question":"hi"}' }), '/api/ask');
    ok('same host, different port is foreign', out.status === 403, out);
    out = await routeAsk(ask, req({ headers: H, body: '{not json' }), '/api/ask');
    ok('bad JSON is an ok:false answer', out.status === 200 && out.json.ok === false && /not valid JSON/.test(out.json.error), out);
    out = await routeAsk(ask, req({ headers: H, body: '["hi"]' }), '/api/ask');
    ok('a JSON array is refused', out.status === 200 && out.json.ok === false, out);
    out = await routeAsk(ask, req({ headers: H, body: JSON.stringify({ question: 'x'.repeat(2001) }) }), '/api/ask');
    ok('a 2,001-character question is too long', out.json.ok === false && /too long/.test(out.json.error), out);
    out = await routeAsk(ask, req({ headers: H, body: JSON.stringify({ question: 'x'.repeat(9000) }) }), '/api/ask');
    ok('a body over the 8 KB cap is refused in words', out.status === 200 && out.json.ok === false && /too long/.test(out.json.error), out);
    out = await routeAsk(ask, req({ headers: H, body: '{"question":""}' }), '/api/ask');
    ok('an empty question', out.json.ok === false && /type a question/.test(out.json.error), out);
    out = await routeAsk(ask, req({ headers: H, body: '{"question":"hi","conversation":"gone"}' }), '/api/ask');
    ok('an unknown conversation', out.json.ok === false && /expired/.test(out.json.error), out);

    script.push(R.text('Hello.'));
    out = await routeAsk(ask, req({ headers: { ...H, origin: 'http://localhost:8787' }, body: '{"question":"hi"}' }), '/api/ask');
    ok('a good POST from this host starts a question', out.status === 200 && out.json.ok === true && typeof out.json.id === 'string' && typeof out.json.conversation === 'string', out);
    ok('the POST answer is exactly {ok, id, conversation}', JSON.stringify(Object.keys(out.json)) === '["ok","id","conversation"]', Object.keys(out.json));
    await ask.wait(out.json.id);
    const got = await routeAsk(ask, req({ method: 'GET' }), `/api/ask/${out.json.id}`);
    ok('GET /api/ask/<id> returns the job', got.status === 200 && got.json.status === 'done' && got.json.answer === 'Hello.', got);
    ok('with exactly the contract fields', JSON.stringify(Object.keys(got.json)) === JSON.stringify(['id', 'conversation', 'question', 'status', 'steps', 'answer', 'error', 'usd', 'searches', 'startedAt', 'doneAt']), Object.keys(got.json));
    ok('an Origin of "null" is let through, as for the alerts', (await routeAsk(ask, req({ headers: { ...H, origin: 'null' }, body: '{"question":""}' }), '/api/ask')).status === 200);
    const miss = await routeAsk(ask, req({ method: 'GET' }), '/api/ask/no-such-job');
    ok('an unknown job is a 404', miss.status === 404, miss);
    const post = await routeAsk(ask, req({ headers: H }), `/api/ask/${out.json.id}`);
    ok('POST to a job is refused', post.status === 405, post);
    ok('actionRefusal passes a proper action', actionRefusal({ method: 'POST', headers: { host: 'a:1', origin: 'http://a:1', 'x-hexagon-action': '1' } }) === null);
    // DNS rebinding: the attacker's page names itself in both Origin and Host, so the lock above passes
    const rebound = { method: 'POST', headers: { host: 'rebind.attacker.example:8787', origin: 'http://rebind.attacker.example:8787', 'x-hexagon-action': '1' } };
    ok('a rebound page passes the Origin check (why the Host check exists)', actionRefusal(rebound) === null);
    ok('but a passwordless desk refuses a foreign Host', rebindRefusal(rebound, '') && rebindRefusal(rebound, '').status === 403 && rebindRefusal(rebound, undefined).status === 403, rebindRefusal(rebound, ''));
    // the operator's own dashboard must never be locked out: every way a browser or tools/api.js names a loopback desk
    const own = ['localhost:8787', '127.0.0.1:8787', '[::1]:8787', 'LOCALHOST:8787', 'localhost:9000', 'localhost', '127.0.0.1', '[::1]'];
    ok('localhost, 127.0.0.1 and [::1], with or without a port (an SSH tunnel on another port too), are let through', own.every((host) => rebindRefusal({ method: 'GET', headers: { host } }, '') === null), own.filter((host) => rebindRefusal({ headers: { host } }, '')));
    const foreign = ['127.0.0.1.nip.io:8787', 'localhost.attacker.example', 'attacker.localhost', '', 'localhost@evil.example', 'evil.example/@localhost', 'localhost:8787:1', '192.168.1.20:8787', undefined];
    ok('a lookalike, a LAN address, a missing Host or a userinfo trick is refused', foreign.every((host) => rebindRefusal({ headers: { host } }, '') !== null), foreign.filter((host) => !rebindRefusal({ headers: { host } }, '')));
    ok('a desk with DASH_PASS (the Fly box) is not Host-checked: its login stops a rebound page', rebindRefusal({ headers: { host: 'hexagon-desk.fly.dev' } }, 'a-password') === null && rebindRefusal(rebound, 'a-password') === null);

    // server.js cannot be required without starting a desk, so pin its wiring from the source
    const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const authAt = src.indexOf('if (!authed(req))'), askAt = src.indexOf('routeAsk(engine.ask');
    ok('server.js routes /api/ask behind the dashboard login', authAt > 0 && askAt > authAt, [authAt, askAt]);
    ok('the alert actions use the same lock function', (src.match(/actionRefusal\(req\)/g) || []).length === 1 && /require\('\.\/src\/ask'\)/.test(src));
    ok('the old inline lock is gone, so the two cannot drift', !/x-hexagon-action'\] !== '1'/.test(src));
    const rebindAt = src.indexOf('rebindRefusal(req, cfg.dashPass)'), alertsAt = src.indexOf("p.match(/^\\/api\\/alerts");
    ok('server.js checks Host on every /api/ route, before any of them, passing the password', /if \(p\.startsWith\('\/api\/'\)\) \{\s*const foreign = rebindRefusal\(req, cfg\.dashPass\);/.test(src) && rebindAt > authAt && rebindAt < alertsAt && rebindAt < askAt && rebindAt < src.indexOf("p === '/api/flatten'") && rebindAt < src.indexOf("p === '/api/stream'"), [authAt, rebindAt, alertsAt, askAt]);
    ok('and the page itself (not under /api/) is never Host-checked', !/rebindRefusal\(req, cfg\.dashPass\)/.test(src.slice(0, src.indexOf("if (p.startsWith('/api/')) {"))));
  }

  // -------------------------------------------------------------------------------------------
  group('the tools: read-only, bounded, and secret-free');
  {
    // Plant fake secrets everywhere a careless tool could find them: config, the environment, the
    // brain's key, a key file on disk, and the cookie tokens derived from the password.
    const dir = tmp();
    const pem = path.join(dir, 'PLANTED-pem-path-kalshi.pem');
    const S = {
      anthropic: 'sk-ant-PLANTED-anthropic-9f8e7d6c', dash: 'PLANTED-dash-pass-4c3b2a19', flatten: 'PLANTED-flatten-token-1a2b3c4d',
      kalshiId: 'PLANTED-kalshi-key-id-77aa88bb', polyKey: 'PLANTED-polymarket-us-secret-5566', pemBody: 'PLANTED-PEM-BODY-abcdef123456', pemPath: pem,
      cxKey: 'PLANTED-chartexchange-key-3344cc',
    };
    fs.writeFileSync(pem, `-----BEGIN PRIVATE KEY-----\n${S.pemBody}\n-----END PRIVATE KEY-----\n`);
    S.cookie = crypto.createHmac('sha256', S.dash).update('hexagon-session-v1').digest('hex');
    S.link = crypto.createHmac('sha256', S.dash).update('hexagon-link-v1').digest('hex').slice(0, 32);
    const savedEnv = { ...process.env };
    Object.assign(process.env, { ANTHROPIC_API_KEY: S.anthropic, DASH_PASS: S.dash, FLATTEN_TOKEN: S.flatten, KALSHI_API_KEY_ID: S.kalshiId, KALSHI_PRIVATE_KEY_PATH: pem, POLYMARKET_US_SECRET_KEY: S.polyKey, CHARTEXCHANGE_API_KEY: S.cxKey });
    const { E, ask, calls, script } = setup({ dataDir: dir, dashPass: S.dash, flattenToken: S.flatten, kalshiKeyId: S.kalshiId, kalshiKeyPath: pem, chartexchangeKey: S.cxKey });
    // A ChartExchange that answers the way the real one does, key and all, so the whitelist has
    // something to leave out: the API echoes the request URL back in `next`.
    const cxCalls = [];
    E.cx = {
      quote: async (sym) => { cxCalls.push(['quote', sym]); return { symbol: 'SPY', name: 'SPDR S&P 500 ETF Trust', price: 767.93, change: -5.45, changePct: -0.705, asOf: '2026-09-14T13:30:00Z', exchange: 'NYSE', url: `https://chartexchange.com/?api_key=${S.cxKey}` }; },
      cryptoQuote: async (sym) => { cxCalls.push(['cryptoQuote', sym]); return { symbol: 'BTCUSD', name: 'Bitcoin', price: 84315.67, change: -1993.1, changePct: -2.309, asOf: '2026-09-14T13:59:00Z', exchange: 'Composite' }; },
      shortVolume: async (sym, o) => { cxCalls.push(['shortVolume', sym, o]); return [{ d: '2026-09-11', total: 19905772, short: 9443880, long: 10461892, offExchange: 6857265, shortPct: 47.4, next: `?api_key=${S.cxKey}` }]; },
      darkPoolSummary: async (sym, date) => { cxCalls.push(['darkPoolSummary', sym, date]); return date === '2026-09-11' ? { trades: 232389, volume: 14139795, premium: 10940061730.2, atBidPct: 15.11, atMidPct: 63.95, atAskPct: 20.93, bidVolume: 1, midVolume: 2, askVolume: 3 } : { trades: 0, volume: 0, premium: 0 }; },
      chainSummary: async (sym, exp) => { cxCalls.push(['chainSummary', sym, exp]); return { underlying: 'US:SPY', expiration: exp, maxPain: 761, callItm: 97686, callOtm: 394084, putItm: 33457, putOtm: 1521583, putCallRatio: 3.16 }; },
    };
    E.brain.key = S.anthropic;
    const planted = Object.values(S);

    // a desk with something in every corner
    E.state.positions = [
      { id: 'g1-KSy', group: 'g1', pairId: 'pm1:0|KXA', label: 'EPL EVE win 09-13', venue: 'KS', ref: 'KXA', pmId: 'pm1', tokenIndex: 0, side: 'yes', qty: 20, entry: 0.31, mark: 0.30, cost: 6.3, fee: 0.1, openedAt: T0 - 3600e3, strategy: 'arb' },
      { id: 'g1-PMn', group: 'g1', pairId: 'pm1:0|KXA', label: 'EPL EVE win 09-13', venue: 'PM', ref: 'tok2', pmId: 'pm1', tokenIndex: 0, side: 'no', qty: 20, entry: 0.66, mark: 0.67, cost: 13.2, fee: 0, openedAt: T0 - 3600e3, strategy: 'arb', orderId: 'ord-1' },
    ];
    E.state.arbGroups.g1 = { pairId: 'pm1:0|KXA', qty: 20, status: 'filled' };
    E.state.closed = [{ id: 'g0-KSy', group: 'g0', label: 'Fed SEP 26', venue: 'KS', side: 'yes', qty: 10, entry: 0.40, exit: 0.45, pnl: 0.42, reason: 'gap closed', strategy: 'converge', openedAt: T0 - 7200e3, exitAt: T0 - 3600e3 }];
    for (let i = 0; i < 500; i++) E.state.log.push({ t: T0 - i * 1000, agent: 'BRAM', kind: 'RESEARCH', pnl: null, text: `gate ledger over 19 pairs · ${'8 gap under minGap · '.repeat(12)}${i}` });
    E.pairs = [{ id: 'pm1:0|KXA', label: 'EPL EVE win 09-13', kind: 'game', series: 'KXEPLGAME', inPlay: false, startsAt: T0 + 3600e3,
      pm: { id: 'pm1', tokenIndex: 0, question: 'Will Everton win?' }, ks: { ticker: 'KXA', title: 'Tottenham vs Everton' },
      q: { pmBid: 0.32, pmAsk: 0.34, ksBid: 0.30, ksAsk: 0.32, pmMid: 0.33, ksMid: 0.31, pmVol: 1e5, ksVol: 3e5, t: T0 - 4000 },
      fair: 0.315, best: { venue: 'PM', side: 'no', px: 0.68, edge: -0.021 }, veto: 'edge under minEdge' }];
    E.state.maker.markets.KXB = { series: 'KXB', inv: 12, cost: 6, realized: 1.2, fills: 30, quotes: { bid: 0.49, ask: 0.51 }, seen: ['x'], title: 'Balance of power', sub: 'R/R', mid: 0.5, spread: 0.02 };
    E.state.maker.hist = [{ t: T0 - 7200e3, c: 1, m: 5, e: 6 }, { t: T0 - 3000e3, c: 1.1, m: 5, e: 6.1 }, { t: T0 - 60e3, c: 1.2, m: 6, e: 7.2 }];
    E.research.jobs.set('g1', { status: 'done', startedAt: T0 - 600e3, finishedAt: T0 - 580e3, usd: 0.12, searches: 1, result: { action: 'hold', sentence: 'Hold to settlement.', confidence: 'high' }, sources: [] });
    E.whales = { snapshot: () => ({ enabled: true, watching: 25, period: 'MONTH', minUsd: 10000, polls: 9, boardAt: T0, lastError: '', recent: [{ at: T0 - 120e3, wallet: '0xabc123def456', name: 'bigbettor', rank: 3, outcome: 'Yes', title: 'Will NYY win?', usd: 54000, price: 0.55, kalshi: 0.57, inPlay: false, hedged: false, url: null }] }) };
    const jl = [];
    for (let i = 0; i < 250; i++) jl.push({ t: new Date(T0 - (400 - i) * 1000).toISOString(), cycle: i, mode: 'paper', kind: 'MAKER_FILL', ticker: 'KXB', side: 'buy', qty: 2, px: 0.49, tradePx: 0.49, runOver: false, inv: i });
    for (let i = 0; i < 20; i++) jl.push({ t: new Date(T0 - (100 - i) * 1000).toISOString(), cycle: 300 + i, mode: 'paper', kind: 'CLOSE', id: `c${i}`, label: 'Fed SEP 26', pnl: i / 10, reason: 'gap closed', intent: { nested: 'object is dropped' }, notOnTheList: 'dropped too' });
    fs.writeFileSync(path.join(dir, `journal-${TODAY}.jsonl`), `${jl.map((x) => JSON.stringify(x)).join('\n')}\nnot json at all\n`);
    fs.writeFileSync(path.join(dir, `whales-${TODAY}.jsonl`), `${JSON.stringify({ t: new Date(T0).toISOString(), key: 'k', wallet: '0xabc', name: 'whale', ts: Math.floor(T0 / 1000) - 60, outcome: 'No', title: 'Will BOS win?', usd: 12000, price: 0.84, rank: 9, kalshi: null, inPlay: false, hedged: false, outcomeIndex: 1 })}\n`);

    const inputs = {
      desk_overview: [{}], open_positions: [{}],
      closed_trades: [{}, { limit: 100, since: TODAY }, { since: '2026-09-14T13:00:00Z', contains: 'fed' }],
      activity_log: [{}, { limit: 100 }, { agent: 'BRAM', kind: 'RESEARCH', contains: 'ledger' }],
      journal: [{}, { date: TODAY, limit: 200 }, { kinds: ['CLOSE'], limit: 5 }],
      markets: [{}, { limit: 40, contains: 'everton' }],
      maker_status: [{}, { limit: 40 }],
      whale_bets: [{}, { date: TODAY }],
      market_data: [{ symbol: 'SPY' }, { symbol: 'btc', kind: 'crypto' }, { symbol: 'SPY', what: 'short_volume', limit: 3 }, { symbol: 'SPY', what: 'dark_pool' }, { symbol: 'SPY', what: 'dark_pool', date: '2026-09-13' }, { symbol: 'SPY', what: 'max_pain' }],
      settings: [{}, { contains: 'key' }, { contains: 'pass' }, { contains: 'token' }],
      docs: [{ query: 'key env password token secret pem private' }, { query: 'KALSHI_PRIVATE_KEY_PATH ANTHROPIC_API_KEY DASH_PASS FLATTEN_TOKEN' }, { query: 'flatten resume', limit: 4 }],
    };
    ok('every tool is exercised', Object.keys(inputs).sort().join() === tools.DEFS.map((d) => d.name).sort().join(), Object.keys(inputs));
    const stateBefore = JSON.stringify(E.state);
    const trip = (what) => () => { throw new Error(`${what} called from a read-only tool`); };
    E.save = trip('save'); E.close = trip('close'); E.sellGroup = trip('sellGroup'); E.flattenAll = trip('flattenAll'); E.resume = trip('resume');
    E.broker.buy = trip('broker.buy'); E.broker.sell = trip('broker.sell');

    const leaks = [];
    const outputs = {};
    for (const [name, list] of Object.entries(inputs)) {
      for (const input of list) {
        let raw, out;
        try {
          raw = JSON.stringify(await tools.RUN[name](E, { ...input }, T0));      // the whitelist alone
          out = await tools.runTool(E, name, { ...input }, T0);                // with the scrub
        } catch (e) { ok(`${name}(${JSON.stringify(input)}) runs`, false, e.stack); continue; }
        (outputs[name] = outputs[name] || []).push(out);
        for (const sec of planted) {
          if (raw.includes(sec)) leaks.push(`${name} raw: ${sec}`);
          if (out.includes(sec)) leaks.push(`${name}: ${sec}`);
        }
      }
    }
    ok('no tool output contains a planted secret, even before the scrub', leaks.length === 0, leaks);
    ok('the settings say which secrets are present, not what they are', /"secretsPresent":\{"anthropicKey":true,"dashboardPassword":true,"flattenSwitch":true,"kalshiKey":true,"chartexchangeKey":true\}/.test(outputs.settings[0]), outputs.settings[0].slice(0, 400));
    {
      const md = outputs.market_data.map((o) => JSON.parse(o));
      ok('market_data: the quote, with its source and staleness named', md[0].available && md[0].price === '767.93' && md[0].changeTodayPct === '-0.705%' && /delayed 30 minutes/.test(md[0].staleness) && /ChartExchange/.test(md[0].source) && /2026-09-14 09:30:00 ET/.test(md[0].asOf), md[0]);
      ok('market_data: nothing off the whitelist, the url least of all', !('url' in md[0]) && !JSON.stringify(md).includes('next'), Object.keys(md[0]));
      // every input above ran twice (the whitelist alone, then with the scrub), so calls are read by kind
      const call = (kind) => cxCalls.find((c) => c[0] === kind);
      ok('market_data: a crypto quote asks the crypto feed', call('cryptoQuote') && call('cryptoQuote')[1] === 'BTC' && md[1].price === '84315.67' && /live/.test(md[1].staleness), [call('cryptoQuote'), md[1]]);
      ok('market_data: short volume as a share, with what it is and is not', md[2].days.length === 1 && md[2].days[0].shortPct === '47.4%' && /NOT short interest/.test(md[2].meaning) && call('shortVolume')[2].limit === 3, md[2]);
      ok('market_data: dark pool defaults to the last weekday before today', call('darkPoolSummary')[2] === '2026-09-11' && md[3].found && md[3].dollars === '$10940061730.20' && md[3].atMidPct === '63.95%', [call('darkPoolSummary'), md[3]]);
      ok('market_data: a day with no prints says so instead of showing zeros', md[4].found === false && /no prints/.test(md[4].note) && !('trades' in md[4]), md[4]);
      ok('market_data: max pain defaults to the next Friday and says what it is not', call('chainSummary')[2] === '2026-09-18' && md[5].maxPain === '761' && md[5].putCallRatio === '3.16' && /not a forecast/.test(md[5].meaning), [call('chainSummary'), md[5]]);
      let threw = '';
      try { await tools.runTool(E, 'market_data', { symbol: 'not a ticker!' }, T0); } catch (e) { threw = e.message; }
      ok('market_data: a bad ticker is refused before any call', /plain ticker/.test(threw), threw);
      try { threw = ''; await tools.runTool(E, 'market_data', { symbol: 'SPY', what: 'everything' }, T0); } catch (e) { threw = e.message; }
      ok('market_data: an unknown `what` is refused', /what must be one of/.test(threw), threw);
      const cxSaved = E.cx, nCalls = cxCalls.length;
      E.cx = null;
      const off = JSON.parse(await tools.runTool(E, 'market_data', { symbol: 'SPY' }, T0));
      ok('market_data: without a key it says so and calls nothing', off.available === false && /CHARTEXCHANGE_API_KEY/.test(off.note) && cxCalls.length === nCalls, off);
      E.cx = cxSaved;
      ok('market_data: the step line names the lookup', tools.stepFor('market_data', { symbol: 'spy', what: 'dark_pool' }) === 'looking up dark pool for spy on ChartExchange', tools.stepFor('market_data', { symbol: 'spy', what: 'dark_pool' }));
    }
    ok('no tool changed the desk', JSON.stringify(E.state) === stateBefore);

    const logOut = outputs.activity_log[1];
    ok('a big answer is cut to size with a note', logOut.length <= tools.MAX_OUT + 200 && /cut here/.test(logOut), logOut.length);
    const j = JSON.parse(outputs.journal[2]);
    ok('journal: counts the whole day by kind', j.countsByKind.MAKER_FILL === 250 && j.countsByKind.CLOSE === 20 && j.unreadableLines === 1, j.countsByKind);
    ok('journal: filters by kind, newest first, to the limit', j.matchingLines === 20 && j.shown === 5 && j.entries[0].id === 'c19' && j.entries[4].id === 'c15', j.entries && j.entries.map((e) => e.id));
    ok('journal: fields off the whitelist are not shown', !('intent' in j.entries[0]) && !('notOnTheList' in j.entries[0]) && !('mode' in j.entries[0]), j.entries[0]);
    ok('journal: times are Eastern', /^2026-09-14 09:5\d:\d\d ET$/.test(j.entries[0].at), j.entries[0].at);
    const nofile = JSON.parse(await tools.runTool(E, 'journal', { date: '2026-01-01' }, T0));
    ok('journal: a missing day lists the days there are', nofile.found === false && nofile.availableDates.includes(TODAY), nofile);
    const m = JSON.parse(outputs.markets[0]);
    ok('markets: says which rule stopped each pair', m.pairs[0].stoppedBy === 'edge under minEdge' && m.whyPairsAreNotTrading['edge under minEdge'] === 1, m.pairs[0]);
    ok('markets: prices carry units', m.pairs[0].polymarket.bid === '32c' && m.pairs[0].gapKalshiMinusPolymarket === '-2c' && m.pairs[0].bestTrade.netEdge === '-2.1c', m.pairs[0]);
    const pos = JSON.parse(outputs.open_positions[0]);
    ok('open_positions: legs, the arb check and the research verdict', pos.count === 2 && /^ok: /.test(pos.lockedArbs[0].check) && pos.researchVerdicts[0].verdict === 'hold', pos);
    const mk = JSON.parse(outputs.maker_status[0]);
    ok('maker_status: inventory and an hourly trend', mk.markets[0].ticker === 'KXB' && mk.markets[0].contractsHeld === 12 && mk.pnlTrendLast12h.length === 3, mk);
    const wb = JSON.parse(outputs.whale_bets[1]);
    ok('whale_bets: a recorded day', wb.found && wb.bets[0].who === 'whale' && wb.bets[0].size === '$12000.00', wb);
    const wmp = tools.RUN.settings(E, { contains: 'whale_max_px' });
    ok('settings: WHALE_MAX_PX, the price a whale bet is recorded at but not called, can be read', wmp.settings.length === 1 && wmp.settings[0].setting === 'WHALE_MAX_PX' && typeof E.cfg.whaleMaxPx === 'number' && wmp.settings[0].value === E.cfg.whaleMaxPx, wmp.settings);
    ok('docs: four sections of the real README still fit the bound, so the JSON closes', outputs.docs[2].length <= tools.MAX_OUT && !/cut here/.test(outputs.docs[2]), outputs.docs[2].length);
    const d = JSON.parse(outputs.docs[2]);
    ok('docs: finds the flatten and resume section', d.sections.some((s) => /Operating it/.test(s.heading)), d.sections.map((s) => s.heading));
    ok('docs: a single section still gets its full 3500 characters', JSON.parse(await tools.runTool(E, 'docs', { query: 'flatten resume', limit: 1 }, T0)).sections[0].text.length <= 3500, 'limit 1');
    {
      const droot = tmp();
      fs.mkdirSync(path.join(droot, 'ops'));
      fs.writeFileSync(path.join(droot, 'README.md'), '# Operating it\nPress the old button.\n');
      const first = tools.RUN.docs(E, { query: 'operating button' }, T0, droot);
      fs.writeFileSync(path.join(droot, 'README.md'), '# Operating it\nPress the new button.\n');
      fs.utimesSync(path.join(droot, 'README.md'), new Date(T0 + 60e3), new Date(T0 + 60e3));
      const second = tools.RUN.docs(E, { query: 'operating button' }, T0, droot);
      ok('docs: an edited README is read again without a restart', /old button/.test(first.sections[0].text) && /new button/.test(second.sections[0].text), [first.sections, second.sections]);
    }
    {
      // The box's docs are the copies in its image: every file the Dockerfile copies must redeploy
      // the box when it changes, or the docs tool quotes an old README until some code push.
      const root = path.join(__dirname, '..');
      const ship = new RegExp(fs.readFileSync(path.join(root, '.github/workflows/test.yml'), 'utf8').match(/git diff --name-only[^\n]*grep -qE '([^']+)'/)[1]);
      const copied = fs.readFileSync(path.join(root, 'Dockerfile'), 'utf8').split('\n').map((l) => l.match(/^COPY\s+(\S+)\s/)).filter(Boolean)
        .map((m) => m[1].replace('*', '').replace(/^(src|tools|public)$/, '$1/x.js'));
      ok('deploy: a change to any file the image copies ships (README.md and ops/DEPLOY.md included)', copied.includes('README.md') && copied.includes('ops/DEPLOY.md') && copied.every((f) => ship.test(f)), copied.filter((f) => !ship.test(f)));
      ok('deploy: a change to other notes still does not restart the box', !ship.test('ops/NOTES.md') && !ship.test('CLAUDE.md'));
    }
    const ov = JSON.parse(outputs.desk_overview[0]);
    ok('desk_overview: paper, cash, halts, desks', /^paper/.test(ov.account) && ov.takerBook.cash === '$10000.00' && ov.desks.length === 7 && 'riskHalt' in ov.halts, ov.takerBook);
    let threw = null;
    try { await tools.runTool(E, 'journal', { date: '../../../etc/passwd' }, T0); } catch (e) { threw = e.message; }
    ok('a path in a date is refused', /date must be an Eastern date/.test(threw || ''), threw);

    // the scrub backstop: a secret that did get into desk data comes back redacted
    E.state.log.unshift({ t: T0, agent: 'TESS', kind: 'OPS', pnl: null, text: `something printed ${S.flatten} by mistake` });
    const scrubbed = await tools.runTool(E, 'activity_log', { limit: 1 }, T0);
    ok('the scrub catches a secret the whitelist let through', !scrubbed.includes(S.flatten) && scrubbed.includes('[redacted]'), scrubbed.slice(0, 300));
    E.state.log.shift();

    // and end to end: a loop that calls every tool sends nothing secret to the API
    script.push(R.tools(tools.DEFS.map((t, i) => [`toolu_${i}`, t.name, (inputs[t.name] || [{}])[0]])));
    script.push(R.text('All read.'));
    const { job } = await askAndWait(ask, 'read everything');
    ok('a round calling every tool at once finishes', job.status === 'done', job);
    const sentAll = JSON.stringify(calls);
    ok('no request body or header carries a planted secret', planted.every((sec) => !sentAll.includes(sec)), planted.filter((sec) => sentAll.includes(sec)));
    ok('every tool answered without error', calls.at(-1).body.messages.at(-1).content.length === tools.DEFS.length && calls.at(-1).body.messages.at(-1).content.every((b) => b.type === 'tool_result' && !b.is_error), calls.at(-1).body.messages.at(-1).content.filter((b) => b.is_error));
    ok('the dashboard login secret is not in the job either', planted.every((sec) => !JSON.stringify(ask.job(job.id)).includes(sec)));

    for (const k of Object.keys(process.env)) if (!(k in savedEnv)) delete process.env[k];
    Object.assign(process.env, savedEnv);
  }

  for (const d of dirs) { try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* temp */ } }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.log(`  FAIL  suite crashed: ${e.stack}`); console.log(`\n${pass} passed, ${fail + 1} failed`); process.exit(1); });

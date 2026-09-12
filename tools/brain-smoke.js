'use strict';
// A LIVE check of the Claude layer. Unlike tools/brain-test.js this one talks to the network and
// costs money -- a fraction of a cent -- so it is deliberately not part of `npm test`.
//
// It answers the three questions the offline suite structurally cannot:
//   1. does the key authenticate?
//   2. does this account's API accept `output_config.format` with a json_schema, or does the
//      transport have to fall back to asking for JSON in the prompt?
//   3. does a real turn come back parseable, and what did it cost?
//
//   node tools/brain-smoke.js
const path = require('path');
const fs = require('fs');

// Same loader as server.js: the key lives in .env, never in the repo.
const envFile = path.join(__dirname, '..', '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*(#.*)?$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const cfg = require('../src/config');
const { Brain } = require('../src/brain');

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['venue', 'edgeCents', 'reasoning'],
  properties: {
    venue: { type: 'string', enum: ['PM', 'KS'] },
    edgeCents: { type: 'number' },
    reasoning: { type: 'string' },
  },
};

(async () => {
  const b = new Brain(cfg);
  console.log(`status : ${b.status()}`);
  console.log(`model  : ${cfg.brainModel}  effort=${cfg.brainEffort}`);
  if (!b.enabled()) { console.error('\nNot enabled — nothing to smoke test.'); process.exit(1); }

  // A real question in this desk's own domain, small enough to cost almost nothing.
  const spec = {
    system: 'You are a prediction-market trading desk. Answer only with the requested JSON.',
    user: 'Polymarket shows YES at bid 0.40 / ask 0.42 on $100 of 24h volume. Kalshi shows the same event at bid 0.60 / ask 0.62 on $1,000,000 of 24h volume. Kalshi charges roughly 1.75c per contract each way; Polymarket charges nothing. Which venue is the cheap side to buy YES on, and roughly how many cents of edge per contract are there after both fees?',
    schema: SCHEMA,
    effort: 'low',
    maxTokens: 1500,
  };

  const t0 = Date.now();
  try {
    const res = await b._turn('SMOKE', spec);
    const ms = Date.now() - t0;
    console.log(`\nformat : ${b.formatMode === 'schema' ? 'output_config.format accepted (json_schema)' : 'FELL BACK to prompt-mode JSON'}`);
    console.log(`turn   : ${ms}ms`);
    console.log(`answer : ${JSON.stringify(res.data)}`);
    const u = res.usage || {};
    console.log(`tokens : in=${u.input_tokens || 0} out=${u.output_tokens || 0} cacheWrite=${u.cache_creation_input_tokens || 0} cacheRead=${u.cache_read_input_tokens || 0}`);
    console.log(`cost   : $${b.stats.usd.toFixed(4)}`);
    const sane = res.data && res.data.venue === 'PM';
    console.log(`\n${sane ? 'PASS' : 'CHECK'} — the cheap side here is Polymarket; the desk answered ${res.data && res.data.venue}.`);
    process.exit(0);
  } catch (e) {
    console.error(`\nFAILED after ${Date.now() - t0}ms: ${e.message}`);
    if (e.status === 401) console.error('  -> the key in .env was not accepted. Check for a stray space, quote, or a truncated paste.');
    if (e.status === 404) console.error('  -> model not found for this account. Try BRAIN_MODEL=claude-sonnet-5 in .env.');
    process.exit(1);
  }
})();

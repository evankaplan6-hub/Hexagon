'use strict';
// .env, read by hand: this repo has no dependencies, so no dotenv.
//
// KEY=value per line; blank lines and lines starting with # are skipped; a value may sit in single
// or double quotes. A `#` starts a comment only at the start of a line or after whitespace, never
// inside a value: the old one-line regex cut a value at the first `#` wherever it was, so
// `DASH_PASS=abc#123` loaded as `abc`, the operator could not log in with the password they had
// set, and nothing said why. Inside quotes anything goes, `#` included.
// A variable already in the process environment wins, as before.
const fs = require('fs');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text || '').split('\n')) {
    const line = raw.replace(/\r$/, '');
    const m = line.match(/^\s*(?:export\s+)?([A-Z0-9_]+)\s*=(.*)$/);
    if (!m) continue;
    const rest = m[2].trim();
    const q = rest.match(/^(["'])(.*?)\1\s*(?:#.*)?$/);
    out[m[1]] = q ? q[2] : rest.replace(/\s+#.*$/, '').trim();
  }
  return out;
}

function loadEnv(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return {}; }
  const vars = parseEnv(text);
  for (const [k, v] of Object.entries(vars)) if (process.env[k] === undefined) process.env[k] = v;
  return vars;
}

module.exports = { parseEnv, loadEnv };

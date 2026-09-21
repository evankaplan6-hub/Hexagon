'use strict';
// Assertions for src/env.js: the .env reader. One thing above all: a `#` inside a value is part
// of the value. The old regex cut `DASH_PASS=abc#123` to `abc`, and the login page then refused
// the password that was actually in the file.
//
//   node tools/env-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseEnv, loadEnv } = require('../src/env');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

group('a # inside a value is the value, not a comment');
{
  const v = parseEnv('DASH_PASS=abc#123\nFLATTEN_TOKEN="x#y"\nKEY=\'a # b\'\n');
  ok('bare value keeps its #', v.DASH_PASS === 'abc#123', v);
  ok('double-quoted value keeps its #', v.FLATTEN_TOKEN === 'x#y', v);
  ok('single-quoted value keeps a spaced #', v.KEY === 'a # b', v);
}

group('comments are still comments');
{
  const v = parseEnv('# a whole line\n  # indented too\nMODE=paper # trailing\nDEMO=0\t# tabbed\nPORT="8787" # after quotes\nEMPTY=\n');
  ok('a comment line sets nothing', !('a' in v) && Object.keys(v).length === 4, v);
  ok('a trailing comment after a space is dropped', v.MODE === 'paper', v);
  ok('...or after a tab', v.DEMO === '0', v);
  ok('...or after a closing quote', v.PORT === '8787', v);
  ok('an empty value is empty', v.EMPTY === '', v);
}

group('the shapes .env.example uses');
{
  const v = parseEnv('MODE=paper\r\nLIVE_CONFIRM=\r\nexport KALSHI_API_KEY_ID = abc-123 \nlower=ignored\n=nope\nURL=https://x.y/z?a=1#frag\n');
  ok('CRLF line endings are fine', v.MODE === 'paper' && v.LIVE_CONFIRM === '', v);
  ok('an `export` prefix and spaces around = are tolerated', v.KALSHI_API_KEY_ID === 'abc-123', v);
  ok('a lowercase name is not a variable', !('lower' in v), v);
  ok('a fragment glued to a URL is part of it', v.URL === 'https://x.y/z?a=1#frag', v);
}

group('loadEnv: the file fills the environment, and a value already set wins');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-env-'));
  const file = path.join(dir, '.env');
  fs.writeFileSync(file, 'HEX_TEST_A=one#1\nHEX_TEST_B=two\n');
  process.env.HEX_TEST_B = 'already';
  delete process.env.HEX_TEST_A;
  const got = loadEnv(file);
  ok('a new variable lands in process.env whole', process.env.HEX_TEST_A === 'one#1', process.env.HEX_TEST_A);
  ok('an existing one is left alone', process.env.HEX_TEST_B === 'already', process.env.HEX_TEST_B);
  ok('the parsed file is returned', got.HEX_TEST_B === 'two', got);
  ok('a missing file is an empty environment, not a throw', Object.keys(loadEnv(path.join(dir, 'nope'))).length === 0);
  delete process.env.HEX_TEST_A; delete process.env.HEX_TEST_B;
  fs.rmSync(dir, { recursive: true, force: true });
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

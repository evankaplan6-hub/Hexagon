'use strict';
// Assertions for .dockerignore: what `fly deploy` may send to the image builder. `fly deploy` uploads
// the folder it runs in, and the Mac's copy of the repo also holds .env, kalshi-private-key.pem and
// gigabytes of data/, none of which may leave the machine. So .dockerignore is an allowlist of exactly
// what the Dockerfile copies, and this holds the two together both ways: every file a COPY takes gets
// through, nothing gets through that no COPY takes, and no key or env file gets through anywhere.
//
// The matcher follows Docker's rules (moby/patternmatcher, as flyctl and BuildKit read the file):
// patterns apply in order and the last one that matches a path decides, `!` lets a path back in, and a
// pattern that matches a folder matches everything under it. Only `*`, `?` and `**/` are understood
// here; a pattern with any other syntax fails the suite rather than being read wrong.
//
//   node tools/dockerignore-test.js
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);

// One pattern -> a RegExp over slash-separated paths, or null for syntax this file does not model.
function compile(p) {
  if (/[[\]\\{}]/.test(p)) return null;
  let re = '';
  for (let i = 0; i < p.length; i++) {
    const ch = p[i];
    if (ch === '*' && p[i + 1] === '*') {
      if (p[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (ch === '*') re += '[^/]*';
    else if (ch === '?') re += '[^/]';
    else re += ch.replace(/[.+^$()|]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The file's lines -> rules, as Docker reads them: blank lines and # comments skipped, a leading ! for
// a way back in, the pattern cleaned (no leading or trailing slash).
function parse(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#')).map((line) => {
    const back = line.startsWith('!');
    const pattern = path.posix.normalize((back ? line.slice(1) : line).trim()).replace(/^\/+/, '').replace(/\/+$/, '');
    return { line, back, pattern, re: compile(pattern) };
  });
}

// Is `file` (relative, slash-separated) left out of the build? The last rule that matches the path, or
// any folder above it, decides.
function excluded(rules, file) {
  const parts = file.split('/');
  let out = false;
  for (const r of rules) {
    let hit = r.re.test(file);
    for (let i = 1; !hit && i < parts.length; i++) hit = r.re.test(parts.slice(0, i).join('/'));
    if (hit) out = !r.back;
  }
  return out;
}

// Every file under `rel` (a file or a folder), slash-separated, relative to the repo.
function filesUnder(rel) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) return [];
  if (!fs.statSync(abs).isDirectory()) return [rel];
  const out = [];
  for (const e of fs.readdirSync(abs, { withFileTypes: true })) {
    const child = `${rel}/${e.name}`;
    if (e.isDirectory()) out.push(...filesUnder(child));
    else out.push(child);
  }
  return out;
}

// The Dockerfile's COPY sources, in order: `COPY a b ./dest` -> ['a', 'b'].
function copySources(dockerfile) {
  const out = [];
  for (const line of dockerfile.split(/\r?\n/)) {
    const m = line.match(/^\s*COPY\s+(.+)$/i);
    if (!m) continue;
    if (m[1].trim().startsWith('[')) { out.push({ unsupported: line }); continue; }
    const args = m[1].trim().split(/\s+/).filter((a) => !a.startsWith('--'));
    for (const src of args.slice(0, -1)) out.push({ src: src.replace(/^\.\//, '').replace(/\/+$/, '') });
  }
  return out;
}

group("the matcher reads patterns the way Docker does");
{
  const r = (...lines) => parse(lines.join('\n'));
  ok('`*` leaves out a top-level file', excluded(r('*'), '.env'));
  ok('`*` leaves out everything under a top-level folder', excluded(r('*'), 'data/fly/archive/journal.jsonl'));
  ok('`!src` lets the whole folder back in', !excluded(r('*', '!src'), 'src/desk/engine.js'));
  ok('...but not a folder that only starts the same', excluded(r('*', '!src'), 'srcx/a.js'));
  ok('`!ops/DEPLOY.md` lets one file back in from a left-out folder', !excluded(r('*', '!ops/DEPLOY.md'), 'ops/DEPLOY.md'));
  ok('...and nothing else in that folder', excluded(r('*', '!ops/DEPLOY.md'), 'ops/backup-secrets.sh'));
  ok('the last pattern that matches wins', excluded(r('!src', '*'), 'src/a.js') && !excluded(r('*', '!src'), 'src/a.js'));
  ok('`**/.env` reaches the top level and any depth', excluded(r('**/.env'), '.env') && excluded(r('**/.env'), 'src/desk/.env'));
  ok('...and only that name', !excluded(r('**/.env'), 'src/.envrc'));
  ok('`**/.env.*` takes every variant', excluded(r('**/.env.*'), '.env.local') && excluded(r('**/.env.*'), 'tools/.env.prod'));
  ok('`*.pem` without `**/` stops at the top level', excluded(r('*.pem'), 'k.pem') && !excluded(r('*.pem'), 'src/k.pem'));
  ok('a leading slash and a trailing slash are cleaned off', !excluded(r('*', '!/src/'), 'src/a.js'));
  ok('syntax this file does not model is refused, not guessed', compile('[ab]c') === null && compile('a\\*') === null);
}

const text = fs.readFileSync(path.join(ROOT, '.dockerignore'), 'utf8');
const rules = parse(text);
const copies = copySources(fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8'));
const sources = copies.filter((c) => c.src).map((c) => c.src);

group('.dockerignore is an allowlist');
{
  ok('every pattern uses syntax the matcher understands', rules.every((x) => x.re), rules.filter((x) => !x.re).map((x) => x.line));
  ok('the first pattern leaves everything out', rules[0] && rules[0].line === '*', rules[0] && rules[0].line);
  ok('the Dockerfile uses no COPY form this suite cannot read', copies.every((c) => c.src), copies.filter((c) => !c.src));
  ok('the Dockerfile copies something', sources.length >= 5, sources);
}

group('every file a COPY takes gets through');
{
  for (const src of sources) {
    const files = /[*?]/.test(src)
      ? fs.readdirSync(path.join(ROOT, path.posix.dirname(src))).map((f) => path.posix.join(path.posix.dirname(src), f))
        .filter((f) => compile(src).test(f.replace(/^\.\//, '')) && fs.statSync(path.join(ROOT, f)).isFile()).map((f) => f.replace(/^\.\//, ''))
      : filesUnder(src);
    ok(`COPY ${src} finds something to copy`, files.length > 0, src);
    const kept = files.filter((f) => excluded(rules, f));
    ok(`COPY ${src}: all ${files.length} file(s) reach the builder`, kept.length === 0, kept.slice(0, 5));
  }
}

group('nothing gets through that no COPY takes');
{
  const allowed = new Set(['Dockerfile', ...sources]);
  const extra = rules.filter((x) => x.back && !allowed.has(x.pattern)).map((x) => x.line);
  ok("every `!` line names the Dockerfile or one of its COPY sources", extra.length === 0, extra);
  // Whatever sits at the top of this checkout (on the Mac: .env, the .pem, data/), only the COPY
  // sources and the Dockerfile get through.
  const tops = fs.readdirSync(ROOT).filter((f) => !['Dockerfile', ...sources].some((s) => s === f || s.split('/')[0] === f || compile(s).test(f)));
  const leaked = tops.filter((f) => !excluded(rules, f) && !excluded(rules, `${f}/x`));
  ok(`none of the ${tops.length} other top-level entries in this checkout gets through`, leaked.length === 0, leaked);
}

group('the desk runs as node, not root');
{
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  const entry = (dockerfile.match(/^ENTRYPOINT\s+\["\/bin\/sh",\s*"\/app\/([^"]+)"\]/m) || [])[1];
  ok('the ENTRYPOINT runs a script through sh', !!entry, dockerfile.match(/^ENTRYPOINT.*$/m));
  ok('...that the image copies', !!entry && sources.includes(entry), entry);
  const script = entry ? fs.readFileSync(path.join(ROOT, entry), 'utf8') : '';
  ok('the script gives the data folder to node, then runs the command as node', /chown -h node:node/.test(script) && /exec su node /.test(script), entry);
  ok('no USER line puts the image back to root', !/^USER\s+(root|0)\b/m.test(dockerfile));
}

group('no key, env file or data ever gets through');
{
  const never = [
    '.env', '.env.local', 'kalshi-private-key.pem', 'certs/client.key', 'id.p12',
    'data/state.json', 'data/desk/journal-2026-09-26.jsonl', 'data/fly/archive/desk/journal-2026-09-25.jsonl',
    'data-demo/state.json', '.git/config', '.claude/worktrees/x/.env', 'node_modules/pkg/index.js',
    'ops/backup-secrets.sh', 'fly.toml', '.github/workflows/test.yml',
    // a secret dropped inside a folder the Dockerfile does copy is still left out
    'src/.env', 'tools/.env.local', 'public/leaked.pem', 'src/desk/client.p12', 'tools/id.key',
  ];
  const through = never.filter((f) => !excluded(rules, f));
  ok(`all ${never.length} are left out`, through.length === 0, through);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

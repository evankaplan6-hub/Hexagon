'use strict';
// Shared client for the tools that read the running desk.
//
// The dashboard grew a password, and every tool that fetched /api/state kept asking for it
// anonymously -- so on the cloud box they got "authentication required" back and died trying to
// JSON.parse it. Adding a lock without re-keying the things that had to pass through it was the
// mistake; this is the key.
const cfg = require('../src/config');

async function state() {
  const url = `http://localhost:${cfg.port}/api/state`;
  const headers = { accept: 'application/json' };
  if (cfg.dashPass) {
    headers.authorization = 'Basic ' + Buffer.from(`${cfg.dashUser}:${cfg.dashPass}`).toString('base64');
  }
  let r;
  try { r = await fetch(url, { headers }); }
  catch {
    // a raw undici stack trace is not an answer to "is it running?"
    throw new Error(`no desk answering on port ${cfg.port}.\n` +
      '  Locally: it may be stopped (the LaunchAgent was removed when the cloud box took over).\n' +
      '  On Fly:  fly ssh console -C "node tools/maker-report.js" --app hexagon-desk');
  }
  if (r.status === 401) {
    throw new Error(
      'the desk requires a password and this tool did not have it.\n' +
      '  DASH_PASS must be in the environment. On Fly it is a secret and already is;\n' +
      '  locally, set it in .env or unset it to run open on loopback.');
  }
  if (!r.ok) throw new Error(`the desk answered ${r.status} — is it running on port ${cfg.port}?`);
  return r.json();
}

module.exports = { state };

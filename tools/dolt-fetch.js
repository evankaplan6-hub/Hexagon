'use strict';
// Download SPY's end-of-day option chains from DoltHub's free options database, for tools/option-lab.js.
//
//   node tools/dolt-fetch.js                          # SPY, every weekday from 2019-01-02 → data/options/dolt/SPY/
//   node tools/dolt-fetch.js --from 2024-01-01 --to 2024-06-30
//   node tools/dolt-fetch.js --only DIA               # the one other chain-tape ETF it carries
//
// RESEARCH ONLY. A public, keyless SQL endpoint; no broker, no account, no order path: the standing
// of tools/stock-fetch.js.
//
// WHY THIS SOURCE. Checked 2026-09-24 (README.md, the options section): full historical chains are
// sold (Alpha Vantage premium), and the only free one that is still updated is DoltHub's community
// mirror `post-no-preference/options`. It is thin: of the chain tape's six ETFs it has only SPY and
// DIA, three expiries a day (about two, four and seven weeks out), strikes about 2% apart, and no
// open interest, volume or sizes. It has real bid and ask, which is what a first test of selling
// options needs. SPY starts in 2020 (one stray day in May 2019); until mid-2024 only Mondays,
// Wednesdays and Fridays are there, and every market holiday has quotes dated on it, which the lab
// refuses to trade on.
//
// HOW IT ASKS. One query per symbol per weekday, keyed on (date, act_symbol), which the table's
// primary key answers at once. Anything wider (a date range, an aggregate) makes the server scan
// every symbol and answer "context deadline exceeded", so it is never asked. That error, and a
// dropped connection, are retried; a day answered with no rows is a real answer (a holiday, a day
// the mirror skipped) and is written as an empty file so the next run does not ask again, except in
// the last RECENT_DAYS, which the mirror may still be filling in.
//
// One file per symbol per day, data/options/dolt/<SYM>/<YYYY-MM-DD>.json:
//   { v, source, sym, date, fetchedAt, cols, rows: [[expiration, strike, 'C'|'P', bid, ask, iv, delta, gamma, theta, vega, rho], ...] }
// The pull is resumable and skips what is on disk.
const fs = require('fs');
const path = require('path');

const API = 'https://www.dolthub.com/api/v1alpha1/post-no-preference/options/master';
const COLS = ['exp', 'strike', 'cp', 'bid', 'ask', 'iv', 'delta', 'gamma', 'theta', 'vega', 'rho'];
const RECENT_DAYS = 5;
const ROW_CAP = 1000;             // the API's page size: a day at the cap may be truncated, so it is refused

function weekdays(from, to) {
  const out = [];
  for (let t = Date.parse(from + 'T00:00:00Z'); t <= Date.parse(to + 'T00:00:00Z'); t += 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

function query(sym, date) {
  if (!/^[A-Z]{1,6}$/.test(sym) || !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error(`bad symbol or date: ${sym} ${date}`);
  return `SELECT expiration, strike, call_put, bid, ask, vol, delta, gamma, theta, vega, rho FROM option_chain `
    + `WHERE date='${date}' AND act_symbol='${sym}' ORDER BY expiration, call_put, strike`;
}

const num = (x) => (x === null || x === undefined || x === '' ? null : Number(x));

// One API answer → the file's rows. Throws on anything that is not a clean, complete answer.
function parse(j) {
  if (!j || j.query_execution_status !== 'Success') {
    throw new Error(`DoltHub: ${(j && (j.query_execution_message || j.query_execution_status)) || 'no answer'}`);
  }
  const rows = j.rows || [];
  if (rows.length >= ROW_CAP) throw new Error(`DoltHub: ${rows.length} rows, at the page cap; the day may be truncated`);
  return rows.map((r) => [r.expiration, num(r.strike), r.call_put === 'Put' ? 'P' : 'C',
    num(r.bid), num(r.ask), num(r.vol), num(r.delta), num(r.gamma), num(r.theta), num(r.vega), num(r.rho)]);
}

async function fetchDay(sym, date, { tries = 4, pause = (ms) => new Promise((r) => setTimeout(r, ms)), get = fetch } = {}) {
  let last;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await get(`${API}?q=${encodeURIComponent(query(sym, date))}`, { signal: AbortSignal.timeout(90000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return parse(await res.json());
    } catch (e) {
      last = e;
      if (i < tries - 1) await pause(2000 * 2 ** i);
    }
  }
  throw last;
}

async function main() {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const today = new Date().toISOString().slice(0, 10);
  const sym = flag('only', 'SPY').toUpperCase();
  const from = flag('from', '2019-01-02');
  const to = flag('to', new Date(Date.now() - 86400000).toISOString().slice(0, 10));
  const workers = Math.max(1, parseInt(flag('workers', '3'), 10));
  const dir = path.join(flag('out', 'data/options/dolt'), sym);
  fs.mkdirSync(dir, { recursive: true });
  const recent = new Date(Date.parse(today) - RECENT_DAYS * 86400000).toISOString().slice(0, 10);

  const todo = weekdays(from, to).filter((d) => !fs.existsSync(path.join(dir, `${d}.json`)));
  console.log(`${sym}: ${todo.length} weekdays to ask for, ${from} → ${to}, ${workers} at a time → ${dir}`);
  let done = 0, withData = 0, failed = 0;
  const queue = todo.slice();
  async function worker() {
    while (queue.length) {
      const date = queue.shift();
      try {
        const rows = await fetchDay(sym, date);
        if (rows.length || date < recent) {
          const file = path.join(dir, `${date}.json`);
          const body = { v: 1, source: API, sym, date, fetchedAt: new Date().toISOString(), cols: COLS, rows };
          fs.writeFileSync(file + '.tmp', JSON.stringify(body));
          fs.renameSync(file + '.tmp', file);
        }
        if (rows.length) withData++;
      } catch (e) {
        failed++;
        console.log(`  ${date}: ${e.message} (not written; the next run asks again)`);
      }
      if (++done % 50 === 0) console.log(`  ${done}/${todo.length} asked, ${withData} with quotes, ${failed} failed`);
    }
  }
  await Promise.all(Array.from({ length: workers }, worker));
  console.log(`${sym}: ${done} asked, ${withData} with quotes, ${failed} failed${failed ? ' — run it again for those' : ''}`);
  if (failed) process.exitCode = 1;
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });

module.exports = { weekdays, query, parse, fetchDay, COLS, ROW_CAP };

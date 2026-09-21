'use strict';
// Does the ledger add up? The journal is the append-only truth (CLAUDE.md) and state.json is the
// working copy the desk trades from. If the two disagree, some number on the dashboard is wrong
// and nothing built on it can be trusted. This rebuilds both books from the journals alone and
// compares them with the state file, line by line:
//
//   TAKER   cash after every open, close, partial close and settlement (each journal line carries
//           the cash it left behind, so a drift is pinned to the line it appeared on), fees,
//           realised P&L, every open leg and its size, and the groups-closed / wins / losses tally
//   MAKER   cash and inventory per market, replayed through maker.applyFill from every fill,
//           settlement and flatten; realised profit, with the known caveat below
//   VENUES  (--venues) every settlement the desk booked against what the venue itself reports
//           now: Kalshi's result or settlement value, Polymarket's resolved outcome prices
//
//   node tools/ledger-check.js                         the local desk: data/journal-*.jsonl vs data/state.json
//   node tools/ledger-check.js --box                   the Fly box: its state.json and its unarchived
//                                                      journals are copied down first (fly ssh sftp),
//                                                      then checked with data/fly/archive
//   node tools/ledger-check.js --venues                also check the settlements against the venues
//   node tools/ledger-check.js --journals DIR --state FILE
//
// The maker's realised total is allowed to differ from the replay by the cents the pre-2026-09-12
// accounting bug left in it (cash was always right; the split between realised and unrealised on
// some early partial closes was not, README "Replaying the maker"). It is reported, never hidden.
// Exit code 1 on any drift, so a daily run can be trusted to shout.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const maker = require('../src/maker');
const { ET_DAY } = require('../src/recorder');

const r2 = (x) => Math.round(x * 100) / 100;
const money = (x) => `${x < 0 ? '-' : ''}$${Math.abs(x).toFixed(2)}`;
const JOURNAL = /^journal-(\d{4}-\d{2}-\d{2})\.jsonl$/;

// ---------------------------------------------------------------- reading
function readJournals(dirs) {
  const byDay = new Map();   // a later directory's copy of a day replaces an earlier one's
  for (const dir of dirs) {
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const name of names) { const m = JOURNAL.exec(name); if (m) byDay.set(m[1], path.join(dir, name)); }
  }
  const events = [];
  let torn = 0;
  for (const [, file] of [...byDay].sort()) {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      if (!line) continue;
      try { events.push(JSON.parse(line)); } catch { torn++; }
    }
  }
  events.sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
  return { events, days: [...byDay.keys()].sort(), torn };
}

// ---------------------------------------------------------------- pure: the rebuild
// `until` and `makerFills` cut the journal where the STATE stops: state.json is saved every ten
// seconds and the journal is appended at every event, so a copy of the two taken seconds apart has
// events the state has not absorbed yet. The maker's fill counter in the state says exactly how many
// of the journal's fills it holds; everything else is cut at the newest moment the state vouches
// for (stateTime). Without them the whole journal is compared, which is right for a stopped desk.
function rebuild(events, initial, { until = Infinity, makerFills = Infinity } = {}) {
  const t = { cash: initial, fees: 0, realized: 0, positions: new Map(), drifts: [], groups: new Map(), events: 0 };
  // The line's own cash is compared with the arithmetic and the arithmetic goes on: a state that
  // went wrong at one line then disagrees on every later line too, and says so.
  const chain = (e) => {
    if (e.cash == null) return;
    if (Math.abs(t.cash - e.cash) > 0.011) t.drifts.push(`${e.t} ${e.kind} ${e.id}: cash rebuilt ${money(t.cash)}, the line says ${money(e.cash)}`);
  };
  events = events.filter((e) => Date.parse(e.t) <= until);
  for (const e of events) {
    if (e.kind === 'OPEN') {
      t.events++; t.cash = r2(t.cash - e.cost); t.fees = r2(t.fees + (e.fee || 0));
      t.positions.set(e.id, { qty: e.qty, group: e.group }); chain(e);
    } else if (e.kind === 'CLOSE_PARTIAL') {
      t.events++; t.cash = r2(t.cash + e.proceeds); t.fees = r2(t.fees + (e.fee || 0)); t.realized = r2(t.realized + e.pnl);
      const p = t.positions.get(e.id);
      if (p) p.qty = e.remaining; else t.drifts.push(`${e.t} CLOSE_PARTIAL of ${e.id}, which the journal never opened`);
      chain(e);
    } else if (e.kind === 'CLOSE' || e.kind === 'SETTLE') {
      t.events++; t.cash = r2(t.cash + e.proceeds); t.fees = r2(t.fees + (e.fee || 0)); t.realized = r2(t.realized + e.pnl);
      if (!t.positions.delete(e.id)) t.drifts.push(`${e.t} ${e.kind} of ${e.id}, which the journal never opened`);
      const g = t.groups.get(e.group) || { pnl: 0 };
      g.pnl = r2(g.pnl + (e.legPnl != null ? e.legPnl : e.pnl)); t.groups.set(e.group, g);
      chain(e);
    }
  }
  const stillOpen = new Set([...t.positions.values()].map((p) => p.group));
  let closed = 0, wins = 0, losses = 0;
  for (const [g, x] of t.groups) { if (stillOpen.has(g)) continue; closed++; if (x.pnl >= -0.005) wins++; else losses++; }
  t.tally = { closed, wins, losses };

  const m = { cash: initial, realized: 0, fills: 0, markets: new Map(), drifts: [] };
  const mk = (ticker) => m.markets.get(ticker) || (m.markets.set(ticker, { inv: 0, cost: 0, realized: 0 }), m.markets.get(ticker));
  for (const e of events) {
    if (e.kind === 'MAKER_FILL') {
      if (m.fills >= makerFills) continue;   // the state has not seen this fill yet
      const x = mk(e.ticker), r = maker.applyFill(x, { side: e.side, qty: e.qty, px: e.px });
      m.cash = r2(m.cash + r.cashDelta); m.realized = r2(m.realized + r.pnl); m.fills++;
      Object.assign(x, { inv: r.inv, cost: r.cost, realized: r.realized });
      if (e.inv != null && Math.abs(e.inv - r.inv) > 1e-6) m.drifts.push(`${e.t} MAKER_FILL ${e.ticker}: inventory rebuilt ${r.inv}, the line says ${e.inv}`);
    } else if (e.kind === 'MAKER_SETTLE') {
      const x = mk(e.ticker);
      m.cash = r2(m.cash + e.cashDelta); m.realized = r2(m.realized + e.pnl);
      Object.assign(x, { inv: 0, cost: 0, realized: r2(x.realized + e.pnl) });
    } else if (e.kind === 'MAKER_FLATTEN') {
      const x = mk(e.ticker), r = maker.applyFill(x, { side: e.qty > 0 ? 'sell' : 'buy', qty: Math.abs(e.qty), px: e.px });
      m.cash = r2(m.cash + r.cashDelta - (e.fee || 0)); m.realized = r2(m.realized + r.pnl - (e.fee || 0));
      Object.assign(x, { inv: r.inv, cost: r.cost, realized: r2(r.realized - (e.fee || 0)) });
    }
  }
  return { taker: t, maker: m };
}

// The newest moment the state vouches for: its log's newest line, its last balance sample, the
// maker's last fill and last history sample, whichever is latest. The save came after all of them.
function stateTime(S) {
  const times = [
    ((S.log || [])[0] || {}).t,
    ((S.balanceHistory || []).slice(-1)[0] || {}).t,
    ((S.maker || {}).lastFill || {}).at,
    (((S.maker || {}).hist || []).slice(-1)[0] || {}).t,
    // every taker event the state holds happened no later than the save
    ...(S.positions || []).map((p) => p.openedAt),
    ...(S.closed || []).map((c) => c.exitAt),
  ].filter(Number.isFinite);
  return times.length ? Math.max(...times) : Infinity;
}

// ---------------------------------------------------------------- pure: the comparison
// Returns the problems found, in words. `state` is state.json as the desk saves it.
function compare(built, state) {
  const problems = [];
  const near = (a, b, tol = 0.011) => Math.abs((a || 0) - (b || 0)) <= tol;
  const t = built.taker, s = state;
  if (!near(t.cash, s.cash)) problems.push(`taker cash: journal ${money(t.cash)}, state ${money(s.cash)}`);
  if (!near(t.fees, s.stats.fees)) problems.push(`taker fees: journal ${money(t.fees)}, state ${money(s.stats.fees)}`);
  if (!near(t.realized, s.stats.realized)) problems.push(`taker realised: journal ${money(t.realized)}, state ${money(s.stats.realized)}`);
  const stateIds = new Map((s.positions || []).map((p) => [p.id, p]));
  for (const [id, p] of t.positions) {
    const sp = stateIds.get(id);
    if (!sp) problems.push(`leg ${id} is open in the journal and not in the state`);
    else if (sp.qty !== p.qty) problems.push(`leg ${id}: ${p.qty} contracts in the journal, ${sp.qty} in the state`);
  }
  for (const id of stateIds.keys()) if (!t.positions.has(id)) problems.push(`leg ${id} is open in the state and not in the journal`);
  const tally = t.tally, st = s.stats;
  if (tally.closed !== st.groupsClosed || tally.wins !== st.wins || tally.losses !== st.losses) {
    problems.push(`groups: journal ${tally.closed} closed (${tally.wins} won, ${tally.losses} lost), state ${st.groupsClosed} (${st.wins}, ${st.losses})`);
  }
  for (const d of t.drifts) problems.push(d);

  const m = built.maker, sm = s.maker || {};
  if (!near(m.cash, sm.cash)) problems.push(`maker cash: journal ${money(m.cash)}, state ${money(sm.cash)}`);
  if (m.fills !== (sm.fills || 0)) problems.push(`maker fills: journal ${m.fills}, state ${sm.fills}`);
  const smk = sm.markets || {};
  for (const [ticker, x] of m.markets) {
    const sx = smk[ticker];
    if (!sx) { if (x.inv) problems.push(`maker ${ticker}: ${x.inv} contracts in the journal, no such market in the state`); continue; }
    if (Math.abs((sx.inv || 0) - x.inv) > 1e-6) problems.push(`maker ${ticker}: inventory ${x.inv} in the journal, ${sx.inv} in the state`);
  }
  for (const [ticker, sx] of Object.entries(smk)) if (!m.markets.has(ticker) && sx.inv) problems.push(`maker ${ticker}: ${sx.inv} contracts in the state with no fill in the journal`);
  for (const d of m.drifts) problems.push(d);
  // the one number allowed to differ, by the cents the old arithmetic left behind: reported as a note
  const skew = r2((sm.realized || 0) - m.realized);
  return { problems, makerRealizedSkew: skew };
}

// ---------------------------------------------------------------- the venues (network)
const get = async (url) => {
  const r = await fetch(url, { headers: { accept: 'application/json', 'user-agent': 'the-hexagon/ledger-check' } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ksYes = (m) => (m.result === 'yes' ? 1 : m.result === 'no' ? 0 : m.settlement_value_dollars != null ? +m.settlement_value_dollars : null);

// Every settlement against the venue. A Kalshi leg is looked up by ticker; a Polymarket leg by
// its market id (from the pair id on the settlement, or on its OPEN line for older journals).
async function checkVenues(events, log) {
  const opens = new Map(events.filter((e) => e.kind === 'OPEN').map((e) => [e.id, e]));
  const ks = new Map(), pm = new Map();
  const ksMarket = async (t) => { if (!ks.has(t)) { ks.set(t, (await get(`https://api.elections.kalshi.com/trade-api/v2/markets/${t}`)).market); await sleep(120); } return ks.get(t); };
  const pmMarket = async (id) => { if (!pm.has(id)) { pm.set(id, await get(`https://gamma-api.polymarket.com/markets/${id}`)); await sleep(120); } return pm.get(id); };
  const out = { checked: 0, agree: 0, differ: [], unknown: [] };
  for (const e of events.filter((x) => x.kind === 'SETTLE')) {
    const o = opens.get(e.id) || {};
    const pairId = e.pairId || o.pairId || '';
    const [pmPart, ticker] = String(pairId).split('|');
    const [pmId, tok] = String(pmPart || '').split(':');
    try {
      let expect;
      if (e.venue === 'KS') {
        const yes = ksYes(await ksMarket(ticker || o.ref));
        if (yes == null) { out.unknown.push(`${e.label}: Kalshi has not settled ${ticker || o.ref}`); continue; }
        expect = e.side === 'yes' ? yes : 1 - yes;
      } else {
        // The pair id names the market and the pair's YES token; the leg's side then says which
        // way it pays. An older journal names the leg only by the token it HELD (OPEN.ref: the NO
        // token for a NO leg), and Gamma can find the market by it -- but only among closed markets
        // when asked for them -- and that token's own price is then what the leg was paid.
        let m, expectOf;
        if (pmId) { m = await pmMarket(pmId); expectOf = (prices) => (e.side === 'yes' ? prices[+tok || 0] : 1 - prices[+tok || 0]); }
        else if (o.ref) {
          const list = await get(`https://gamma-api.polymarket.com/markets?clob_token_ids=${o.ref}&closed=true`); await sleep(120);
          m = Array.isArray(list) ? list[0] : null;
          if (m) { const held = Math.max(0, JSON.parse(m.clobTokenIds || '[]').indexOf(String(o.ref))); expectOf = (prices) => prices[held]; }
        }
        if (!m) { out.unknown.push(`${e.label}: no Polymarket market id on the line`); continue; }
        if (!m.closed || m.umaResolutionStatus !== 'resolved') { out.unknown.push(`${e.label}: Polymarket ${m.id} not resolved`); continue; }
        expect = expectOf(JSON.parse(m.outcomePrices || '[]').map(Number));
      }
      out.checked++;
      if (Math.abs(expect - e.exit) <= 0.0011) out.agree++;
      else out.differ.push(`${e.t.slice(0, 16)} ${e.venue} ${e.side.toUpperCase()} ${e.label}: booked ${e.exit}, the venue says ${expect}`);
    } catch (err) { out.unknown.push(`${e.label}: ${err.message}`); }
  }
  for (const e of events.filter((x) => x.kind === 'MAKER_SETTLE')) {
    try {
      const yes = ksYes(await ksMarket(e.ticker));
      if (yes == null) { out.unknown.push(`maker ${e.ticker}: Kalshi has not settled it`); continue; }
      out.checked++;
      if (Math.abs(yes - e.yesPx) <= 0.0011) out.agree++;
      else out.differ.push(`${e.t.slice(0, 16)} maker ${e.ticker}: booked ${e.yesPx}, the venue says ${yes} (${e.qty} contracts)`);
    } catch (err) { out.unknown.push(`maker ${e.ticker}: ${err.message}`); }
  }
  log(`VENUES  ${out.checked} settlements checked · ${out.agree} agree · ${out.differ.length} differ · ${out.unknown.length} could not be checked`);
  for (const d of out.differ) log(`  DIFFER  ${d}`);
  for (const u of out.unknown.slice(0, 6)) log(`  ?       ${u}`);
  return out;
}

// ---------------------------------------------------------------- the box
// Copies the box's state.json and the journals the archive does not have yet (today's, and any
// day the pull has not run for) into DEST/box-now, read-only on the box side.
function pullBox(app, archive, dest, log) {
  const fly = process.env.FLY_BIN || (fs.existsSync(path.join(process.env.HOME || '', '.fly', 'bin', 'fly')) ? path.join(process.env.HOME, '.fly', 'bin', 'fly') : 'fly');
  fs.mkdirSync(dest, { recursive: true });
  const have = new Set();
  try { for (const n of fs.readdirSync(archive)) { const m = JOURNAL.exec(n); if (m) have.add(m[1]); } } catch { /* no archive yet */ }
  const listing = execFileSync(fly, ['ssh', 'console', '-q', '-a', app, '-C', 'ls /data'], { encoding: 'utf8', timeout: 120000 });
  const want = listing.split('\n').map((s) => s.trim()).filter((n) => { const m = JOURNAL.exec(n); return m && !have.has(m[1]); });
  for (const name of ['state.json', ...want]) {
    const to = path.join(dest, name);
    try { fs.unlinkSync(to); } catch { /* fresh copy */ }
    execFileSync(fly, ['ssh', 'sftp', 'get', '-q', '-a', app, `/data/${name}`, to], { stdio: 'ignore', timeout: 600000 });
  }
  log(`box     copied state.json and ${want.length} journal(s) not yet in the archive (${want.map((n) => n.slice(8, 18)).join(', ') || 'none'})`);
  return { state: path.join(dest, 'state.json'), journals: dest };
}

// ---------------------------------------------------------------- main
function run(argv, { log = console.log } = {}) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? (argv[i + 1] || true) : null; };
  const root = path.join(__dirname, '..');
  const archive = path.join(root, 'data', 'fly', 'archive');
  let journals = [flag('journals') || path.join(root, 'data')];
  let state = flag('state') || path.join(root, 'data', 'state.json');
  if (argv.includes('--box')) {
    const got = pullBox(flag('app') || 'hexagon-desk', archive, path.join(root, 'data', 'fly', 'box-now'), log);
    journals = [archive, got.journals];
    state = got.state;
  }
  const { events, days, torn } = readJournals(journals);
  let S;
  try { S = JSON.parse(fs.readFileSync(state, 'utf8')); } catch (e) { log(`ledger-check: cannot read ${state}: ${e.message}`); return 2; }
  const built = rebuild(events, S.initial, { until: stateTime(S), makerFills: (S.maker || {}).fills });
  const { problems, makerRealizedSkew } = compare(built, S);
  log(`journal ${days[0] || '?'} → ${days[days.length - 1] || '?'} · ${events.length} events${torn ? ` · ${torn} torn line(s) skipped` : ''} · state as of ${new Date(stateTime(S)).toISOString().slice(0, 19)}Z (${ET_DAY.format(new Date(stateTime(S)))} ET)`);
  log(`TAKER   cash ${money(built.taker.cash)} · fees ${money(built.taker.fees)} · realised ${money(built.taker.realized)} · ${built.taker.positions.size} legs open · ${built.taker.tally.closed} groups closed (${built.taker.tally.wins} won, ${built.taker.tally.losses} lost)`);
  log(`MAKER   cash ${money(built.maker.cash)} · ${built.maker.fills} fills · realised ${money(built.maker.realized)} by replay, ${money((S.maker || {}).realized || 0)} in the state (${Math.abs(makerRealizedSkew) < 0.005 ? 'agree' : `${money(makerRealizedSkew)} apart: the pre-2026-09-12 arithmetic, cash is exact`})`);
  if (problems.length) { log(`\n${problems.length} PROBLEM(S): the state does not match the journal`); for (const p of problems) log(`  ${p}`); }
  else log('OK      every number in the state is what the journal says it should be');
  const done = argv.includes('--venues') ? checkVenues(events, log) : Promise.resolve(null);
  return done.then((v) => (problems.length || (v && v.differ.length) ? 1 : 0));
}

module.exports = { readJournals, rebuild, compare, stateTime, checkVenues, run };

if (require.main === module) {
  Promise.resolve(run(process.argv.slice(2))).then((code) => { process.exitCode = code; });
}

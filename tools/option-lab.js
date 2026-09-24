'use strict';
// Option lab: does selling options on SPY beat simply owning SPY, after the real bid/ask spread, on
// years the settings never saw? A first answer from DoltHub's free chains (tools/dolt-fetch.js),
// ahead of the year the chain tape (tools/chain-record.js) needs. RESEARCH ONLY: nothing here talks
// to a broker, reads a key, or places an order.
//
//   node tools/dolt-fetch.js                    # once: data/options/dolt/SPY/*.json (a free pull, ~an hour)
//   node tools/stock-fetch.js --only 'SPY,SHY,^BXM,^PUT' --refresh    # SPY's closes, SHY for cash, the Cboe indexes
//   node tools/option-lab.js                    # both strategies, tuned on the older 60%, scored on the newer 40%
//   node tools/option-lab.js --detail covered-call    # every setting, both halves
//   node tools/option-lab.js --fee 0.65 --cash none --pick cagr
//
// THE TWO STRATEGIES, fixed before any result was seen (they are the two Cboe indexes the ETF lab
// could only stand in for, with the knobs a person would actually turn):
//   covered-call  own SPY and sell one call per share against it (Cboe's BXM, when 30 days / delta 0.5)
//   put-write     keep the money in SHY and sell puts on as much SPY as it could buy at the strike
//                 (Cboe's PUT, which holds T-bills rather than SHY)
// Each takes two settings: how far out to sell (the expiry nearest 14, 30 or 45 days) and how far from
// the money (the strike whose delta is nearest 0.5, 0.4, 0.3 or 0.2). 12 settings each.
//
// THE FILL MODEL, and what it gets wrong:
//   - A round starts on a day DoltHub has quotes, sells at that day's BID (so the whole spread is
//     paid going in) less --fee dollars a contract, and holds to expiry. The next round starts on the
//     first day with quotes on or after that expiry, the way BXM rolls on expiry day.
//   - At expiry the option is settled at what it is worth against SPY's close that day (the last
//     trading day on or before it, if the expiry is a holiday). An option that finishes in the money
//     pays BPS on the stock it puts to or takes from the book (assignment, then the rebuy or sale).
//   - SPY options are American and are sometimes assigned early, most often a covered call the day
//     before SPY goes ex-dividend. That is ignored, and it flatters the covered call a little.
//   - The stock leg earns SPY's dividends (Yahoo's adjusted close). Cash earns SHY's total return
//     (--cash none for nothing); SHY is 1-3 year Treasuries, which lost money in 2022 where the
//     T-bills Cboe's PUT holds did not. Premium received sits idle until expiry.
//   - DoltHub's chains are thin: three expiries a day, strikes about 2% apart, and before 2023 only
//     Mondays, Wednesdays and Fridays. So "delta 0.3" means the nearest strike on that grid, and a
//     round can start a day or two after the expiry it follows.
//   - Returns are measured round to round, so drawdown and Sharpe are sampled at the rolls, for SPY
//     as well as the strategy (both on the same dates). A drawdown inside a round is not seen by
//     either. Sharpe uses a zero risk-free rate, as the ETF lab's does.
//   - Taxes are ignored. Every round's premium is a short-term gain in a taxable account.
const fs = require('fs');
const path = require('path');

const DEV_SHARE = 0.6;
const BPS = 5;                    // per side on stock moved by an assignment
const FEE = 0.10;                 // dollars per contract (commission-free brokers still pass on regulatory fees)
const MIN_DTE = 5;                // an expiry closer than this is never sold
const MAX_GAP = 7;                // calendar days from an expiry to the next quote day before it counts as a hole

const STRATEGIES = {
  'covered-call': { cp: 'C', plain: 'own SPY, sell one call per share against it (BXM at 30 days / delta 0.5)' },
  'put-write': { cp: 'P', plain: 'hold SHY, sell puts on what it could buy at the strike (PUT at 30 days / delta 0.5)' },
};
const PARAMS = [14, 30, 45].flatMap((dte) => [0.5, 0.4, 0.3, 0.2].map((delta) => ({ dte, delta })));

// ------------------------------------------------------------------ data
const dayDiff = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / 86400000);

// data/options/dolt/SPY/*.json → { dates: [...days with quotes, sorted], byDate: Map(date → contracts) }
function loadChains(dir) {
  const byDate = new Map();
  for (const f of fs.readdirSync(dir).filter((x) => /^\d{4}-\d{2}-\d{2}\.json$/.test(x))) {
    const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!j.rows || !j.rows.length) continue;
    byDate.set(j.date, j.rows.map((r) => ({ exp: r[0], strike: r[1], cp: r[2], bid: r[3], ask: r[4], iv: r[5], delta: r[6] })));
  }
  return { dates: [...byDate.keys()].sort(), byDate };
}

// Yahoo bar files → per-date raw close (what a strike is compared with) and adjusted close (what a holder earns)
function series(bars) {
  const dates = [], raw = new Map(), tr = new Map();
  for (const b of bars) {
    if (!(b.c > 0)) continue;
    dates.push(b.d); raw.set(b.d, b.c); tr.set(b.d, b.ac > 0 ? b.ac : b.c);
  }
  return { dates, raw, tr };
}
// the last trading day on or before d (an expiry on a holiday settles on the day before)
function onOrBefore(s, d) {
  let lo = 0, hi = s.dates.length - 1, best = null;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (s.dates[m] <= d) { best = s.dates[m]; lo = m + 1; } else hi = m - 1; }
  return best;
}
const growth = (s, a, b) => { const x = onOrBefore(s, a), y = onOrBefore(s, b); return x && y ? s.tr.get(y) / s.tr.get(x) : NaN; };

// ------------------------------------------------------------------ the pick
// On day `date`, the contract a setting sells: the expiry nearest p.dte days out (at least MIN_DTE),
// then the strike of that side whose |delta| is nearest p.delta, among quotes a seller could hit.
function pick(contracts, date, cp, p) {
  const live = contracts.filter((c) => c.cp === cp && c.bid > 0 && c.ask >= c.bid && Number.isFinite(c.delta) && dayDiff(date, c.exp) >= MIN_DTE);
  if (!live.length) return null;
  const exps = [...new Set(live.map((c) => c.exp))];
  const exp = exps.reduce((a, e) => (Math.abs(dayDiff(date, e) - p.dte) < Math.abs(dayDiff(date, a) - p.dte) ? e : a));
  return live.filter((c) => c.exp === exp)
    .reduce((a, c) => (Math.abs(Math.abs(c.delta) - p.delta) < Math.abs(Math.abs(a.delta) - p.delta) ? c : a));
}
const intrinsic = (cp, strike, s) => Math.max(0, cp === 'C' ? s - strike : strike - s);

// ------------------------------------------------------------------ engine
// Rounds from the first quote day on or after `from` whose expiry settles on or before `to`. Nothing
// after `to` is read: a round that would settle later is not started, so a dev run cannot see test data.
// Each round spans [start, next start] (the last one ends at its settlement) and carries the
// strategy's return and SPY's buy-and-hold return over exactly those dates.
function simulate(M, name, p, { from, to, fee = FEE, bps = BPS, cash = 'SHY' } = {}) {
  const { cp } = STRATEGIES[name];
  // only days SPY traded: the mirror also has quotes dated on every market holiday (55 of them,
  // 2020-2026, not copies of the day before), and nobody can sell at a price quoted while it is closed
  const days = M.chains.dates.filter((d) => d >= from && d <= to && M.spy.raw.has(d));
  const rounds = [];
  let skipped = 0, i = 0;
  while (i < days.length) {
    const start = days[i];
    const c = pick(M.chains.byDate.get(start), start, cp, p);
    if (!c) { skipped++; i++; continue; }
    const settleDay = onOrBefore(M.spy, c.exp);
    if (c.exp > to || !settleDay || settleDay < start || c.exp > M.spy.dates[M.spy.dates.length - 1]) break;
    let j = i + 1;
    while (j < days.length && days[j] < c.exp) j++;
    // the next round starts on the next quote day; when the mirror has a hole after this expiry, the
    // round ends at settlement instead and the hole is sat out by the strategy and SPY alike
    const end = j < days.length && dayDiff(c.exp, days[j]) <= MAX_GAP ? days[j] : settleDay;
    const s0 = M.spy.raw.get(onOrBefore(M.spy, start)), sT = M.spy.raw.get(settleDay);
    const owed = intrinsic(cp, c.strike, sT);
    const assignCost = owed > 0 ? (sT * bps) / 1e4 : 0;
    const spyR = growth(M.spy, start, end) - 1;
    const cashR = cash && M.cash ? growth(M.cash, start, end) - 1 : 0;
    const optPnl = c.bid - fee / 100 - owed - assignCost;         // dollars per share of underlying
    const r = name === 'covered-call' ? spyR + optPnl / s0 : cashR + optPnl / c.strike;
    rounds.push({ start, exp: c.exp, end, strike: c.strike, delta: c.delta, bid: c.bid, ask: c.ask, s0, sT, owed, r, spyR });
    i = j;
  }
  return { rounds, skipped };
}

function stats(rounds, key = 'r') {
  const n = rounds.length;
  if (!n) return { cagr: 0, total: 0, maxDD: 0, sharpe: 0, n: 0, years: 0 };
  let eq = 1, peak = 1, maxDD = 0;
  const r = rounds.map((x) => x[key]);
  for (const x of r) { eq *= 1 + x; if (eq > peak) peak = eq; maxDD = Math.max(maxDD, 1 - eq / peak); }
  const years = rounds.reduce((a, x) => a + dayDiff(x.start, x.end), 0) / 365.25;   // time in a round; a hole in the data is not a year
  const mean = r.reduce((a, x) => a + x, 0) / n;
  const sd = n > 1 ? Math.sqrt(r.reduce((a, x) => a + (x - mean) ** 2, 0) / (n - 1)) : 0;
  return {
    cagr: years > 0 && eq > 0 ? eq ** (1 / years) - 1 : 0,
    total: eq - 1,
    maxDD,
    sharpe: sd > 0 && years > 0 ? (mean / sd) * Math.sqrt(n / years) : 0,
    n, years,
  };
}

// the first quote day with another one within MAX_GAP after it: a stray day before a long hole (SPY
// has one in May 2019, then nothing until 2020) is not the start of the history
function firstDay(chains) {
  const d = chains.dates;
  for (let i = 0; i + 1 < d.length; i++) if (dayDiff(d[i], d[i + 1]) <= MAX_GAP) return d[i];
  return d[0];
}
// the calendar cut: DEV_SHARE of the way from the first quote day to the last
function cutDate(chains, share = DEV_SHARE) {
  const a = Date.parse(firstDay(chains)), b = Date.parse(chains.dates[chains.dates.length - 1]);
  return new Date(a + (b - a) * share).toISOString().slice(0, 10);
}

// Pick the setting on [first, cut] only, then score it on [cut, last].
function walkForward(M, name, { cut, pick: metric = 'sharpe', ...opts }) {
  const first = firstDay(M.chains), last = M.chains.dates[M.chains.dates.length - 1];
  const rows = PARAMS.map((p) => {
    const dev = simulate(M, name, p, { ...opts, from: first, to: cut });
    const test = simulate(M, name, p, { ...opts, from: cut, to: last });
    return { p, dev: stats(dev.rounds), devSpy: stats(dev.rounds, 'spyR'), test: stats(test.rounds), testSpy: stats(test.rounds, 'spyR'), testRounds: test.rounds, skipped: dev.skipped + test.skipped };
  });
  const best = rows.reduce((a, r) => (r.dev[metric] > a.dev[metric] ? r : a));
  return { rows, best };
}

module.exports = { loadChains, series, onOrBefore, growth, pick, intrinsic, simulate, stats, firstDay, cutDate, walkForward, STRATEGIES, PARAMS, FEE, BPS, MIN_DTE, MAX_GAP, DEV_SHARE };

// ------------------------------------------------------------------ go
if (require.main === module) {
  const args = process.argv.slice(2);
  const flag = (n, d) => { const i = args.indexOf(`--${n}`); return i >= 0 && args[i + 1] !== undefined ? args[i + 1] : d; };
  const dir = flag('dir', 'data/options/dolt/SPY'), bars = flag('bars', 'data/stocks/bars');
  if (!fs.existsSync(dir)) { console.error(`no ${dir}: run node tools/dolt-fetch.js first`); process.exit(1); }
  const load = (s) => { const f = path.join(bars, `${s}.json`); return fs.existsSync(f) ? series(JSON.parse(fs.readFileSync(f, 'utf8')).bars) : null; };
  const cashSym = flag('cash', 'SHY');
  const M = { chains: loadChains(dir), spy: load('SPY'), cash: cashSym === 'none' ? null : load(cashSym) };
  if (!M.spy) { console.error(`no ${bars}/SPY.json: run node tools/stock-fetch.js first`); process.exit(1); }
  if (cashSym !== 'none' && !M.cash) { console.error(`no ${bars}/${cashSym}.json`); process.exit(1); }
  const opts = { fee: parseFloat(flag('fee', FEE)), bps: parseFloat(flag('bps', BPS)), cash: cashSym === 'none' ? null : cashSym, pick: flag('pick', 'sharpe') };
  const first = firstDay(M.chains), last = M.chains.dates[M.chains.dates.length - 1];
  const cut = flag('cut', cutDate(M.chains));
  const pct = (x, w = 6) => `${(x * 100).toFixed(1)}%`.padStart(w);
  const pp = (x) => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}`.padStart(6);
  const lbl = (p) => `${p.dte}d / delta ${p.delta.toFixed(2)}`;
  const perYear = (y) => M.chains.dates.filter((d) => d.startsWith(y)).length;
  const years = [...new Set(M.chains.dates.map((d) => d.slice(0, 4)))];

  console.log(`SPY chains from DoltHub: ${M.chains.dates.length} days with quotes, ${first} → ${last} (${years.map((y) => `${y}: ${perYear(y)}`).join(', ')})`);
  console.log(`SPY closes to ${M.spy.dates[M.spy.dates.length - 1]} · sell at the bid, $${opts.fee.toFixed(2)} a contract, ${opts.bps}bp on assigned stock · cash earns ${opts.cash || 'nothing'} · picked on dev ${opts.pick}`);
  console.log(`tune ${first} → ${cut} · test ${cut} → ${last}`);

  const only = flag('detail');
  for (const name of only ? [only] : Object.keys(STRATEGIES)) {
    if (!STRATEGIES[name]) { console.error(`unknown strategy ${name}: ${Object.keys(STRATEGIES).join(', ')}`); process.exit(1); }
    const wf = walkForward(M, name, { ...opts, cut });
    const b = wf.best;
    const beatCagr = wf.rows.filter((r) => r.dev.cagr > r.devSpy.cagr && r.test.cagr > r.testSpy.cagr).length;
    const beatSharpe = wf.rows.filter((r) => r.dev.sharpe > r.devSpy.sharpe && r.test.sharpe > r.testSpy.sharpe).length;
    console.log(`\n${name}: ${STRATEGIES[name].plain}`);
    console.log(`  picked on the older years: ${lbl(b.p)} (dev CAGR ${pct(b.dev.cagr, 0)} vs SPY ${pct(b.devSpy.cagr, 0)}, Sharpe ${b.dev.sharpe.toFixed(2)} vs ${b.devSpy.sharpe.toFixed(2)})`);
    console.log(`  TEST ${cut} → ${last}: CAGR ${pct(b.test.cagr, 0)} vs SPY ${pct(b.testSpy.cagr, 0)} (${pp(b.test.cagr - b.testSpy.cagr).trim()} points) · max drawdown ${pct(b.test.maxDD, 0)} vs ${pct(b.testSpy.maxDD, 0)} · Sharpe ${b.test.sharpe.toFixed(2)} vs ${b.testSpy.sharpe.toFixed(2)} · ${b.test.n} rounds`);
    console.log(`  settings that beat SPY in both halves: CAGR ${beatCagr}/${wf.rows.length} · Sharpe ${beatSharpe}/${wf.rows.length}`);
    // roll-day luck: the same rule started 0-3 weeks later rolls on other days; in 2020 that alone
    // moved a 30-day covered call by 17 points a year against Cboe's BXM
    const luck = [0, 7, 14, 21].map((off) => {
      const from = new Date(Date.parse(cut) + off * 86400000).toISOString().slice(0, 10);
      const rs = simulate(M, name, b.p, { ...opts, from, to: last }).rounds;
      return stats(rs).cagr - stats(rs, 'spyR').cagr;
    });
    console.log(`  the same setting started 0/1/2/3 weeks later (other roll days), test CAGR minus SPY's: ${luck.map((x) => pp(x).trim()).join(' / ')} points`);
    if (only) {
      console.log(`\n  ${'setting'.padEnd(20)} ${'dev CAGR'.padStart(8)} ${'SPY'.padStart(6)} ${'Shp'.padStart(5)} ${'SPY'.padStart(5)} │ ${'test CAGR'.padStart(9)} ${'SPY'.padStart(6)} ${'maxDD'.padStart(6)} ${'SPY'.padStart(6)} ${'Shp'.padStart(5)} ${'SPY'.padStart(5)} ${'rounds'.padStart(6)}`);
      for (const r of wf.rows) {
        console.log(`  ${lbl(r.p).padEnd(20)} ${pct(r.dev.cagr, 8)} ${pct(r.devSpy.cagr)} ${r.dev.sharpe.toFixed(2).padStart(5)} ${r.devSpy.sharpe.toFixed(2).padStart(5)} │ ${pct(r.test.cagr, 9)} ${pct(r.testSpy.cagr)} ${pct(r.test.maxDD)} ${pct(r.testSpy.maxDD)} ${r.test.sharpe.toFixed(2).padStart(5)} ${r.testSpy.sharpe.toFixed(2).padStart(5)} ${String(r.test.n).padStart(6)}`);
      }
    }
  }

  // the check on the data itself: the BXM-shaped setting against Cboe's own index over the same rounds
  const bxm = load('_BXM'), put = load('_PUT');
  if (bxm && put) {
    console.log(`\nDATA CHECK: the Cboe-shaped setting (30 days, delta 0.5) against Cboe's own index, ${first} → ${last}`);
    for (const [name, idx, sym] of [['covered-call', bxm, 'BXM'], ['put-write', put, 'PUT']]) {
      const sim = simulate(M, name, { dte: 30, delta: 0.5 }, { ...opts, from: first, to: last });
      const s = stats(sim.rounds);
      const idxRounds = sim.rounds.map((x) => ({ ...x, r: growth(idx, x.start, x.end) - 1 }));
      const i = stats(idxRounds);
      const a = sim.rounds.map((x) => x.r), bb = idxRounds.map((x) => x.r);
      const ma = a.reduce((u, x) => u + x, 0) / a.length, mb = bb.reduce((u, x) => u + x, 0) / bb.length;
      const cov = a.reduce((u, x, k) => u + (x - ma) * (bb[k] - mb), 0);
      const corr = cov / Math.sqrt(a.reduce((u, x) => u + (x - ma) ** 2, 0) * bb.reduce((u, x) => u + (x - mb) ** 2, 0));
      console.log(`  ${name.padEnd(13)} CAGR ${pct(s.cagr, 0)} · ${sym} ${pct(i.cagr, 0)} · round-by-round correlation ${corr.toFixed(2)} · ${s.n} rounds, ${sim.skipped} quote days with nothing to sell`);
    }
  }
}

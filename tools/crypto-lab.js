'use strict';
// The crypto lab: which simple rule, if any, beats just holding a coin -- the question behind the
// stocks, crypto and options desk's crypto book (src/desk/books.js).
//
//   node tools/crypto-lab.js --fetch                 once: Coinbase daily candles -> data/crypto/bars/
//   node tools/crypto-lab.js                         the table, 2022-01-01 to the last bar, 0.40% a side
//   node tools/crypto-lab.js --bps 80 --from 2024-01-01
//
// RESEARCH ONLY. It reads Coinbase's public candles and nothing else: no key, no account, no order.
//
// THE FILL MODEL, the ETF lab's (tools/stock-lab.js) applied to a market that never closes: a rule
// decides on a day's close (00:00 UTC) and trades at the next day's open, which for crypto is the
// same minute. Every trade pays --bps of what it trades (40 = 0.40%, the desk's own default; the
// desk's fill model, src/desk/broker.js, adds the real spread on top). Weights run from 0 (cash,
// earning nothing) to 1 (the whole slot in the coin): no borrowing, no shorting.
//
// THE RULES are fixed here, before the numbers: holding; volatility targeting at 40% and 60% a year
// (the desk's rule, called through the desk's own code); a moving-average filter at 50 and 100 days;
// time-series momentum over 56 and 112 days; and the last two each sized by volatility too. The
// same settings on every coin -- a rule tuned per coin is a rule fitted to its history.
//
// WHAT IT FOUND (2026-09-25, bars to 2026-09-24): volatility targeting at 40% beat holding on all
// four coins from 2022, at 0.40% and at 0.80% a side, with smaller drawdowns; the trend rules won big
// on one coin and lost big on the next (a 50-day filter made SOL +31% a year and cost LTC 39%). From
// 2024, in bitcoin's strong run, holding BTC beat it (28.7% vs 25.8% a year).
// README, "The crypto book", has the table.
const fs = require('fs');
const path = require('path');
const books = require('../src/desk/books');

const DIR = path.join(__dirname, '..', 'data', 'crypto', 'bars');
const COINS = [['BTC-USD', '2015-07-20'], ['ETH-USD', '2016-05-18'], ['SOL-USD', '2021-06-17'], ['LTC-USD', '2016-08-17']];
const WARM = 200;   // days of history every rule may need before its first decision

// ------------------------------------------------------------------ the rules (pure)
const sma = (c, j, n) => { if (j + 1 < n) return NaN; let s = 0; for (let k = j - n + 1; k <= j; k++) s += c[k]; return s / n; };
const volW = (c, j, target) => { const v = books.volTargetWeight(c.slice(0, j + 1), { target, lookback: 30, perYear: 365 }); return v ? v.w : 0; };
// Each rule sees the closes up to and including day j and nothing after: w(c, j) -> weight for day j+1.
const RULES = [
  { name: 'hold', w: () => 1 },
  { name: 'volTarget 40%', vol: true, w: (c, j) => volW(c, j, 0.40) },
  { name: 'volTarget 60%', vol: true, w: (c, j) => volW(c, j, 0.60) },
  { name: 'sma 50', w: (c, j) => (c[j] > sma(c, j, 50) ? 1 : 0) },
  { name: 'sma 100', w: (c, j) => (c[j] > sma(c, j, 100) ? 1 : 0) },
  { name: 'momentum 56d', w: (c, j) => (j >= 56 && c[j] > c[j - 56] ? 1 : 0) },
  { name: 'momentum 112d', w: (c, j) => (j >= 112 && c[j] > c[j - 112] ? 1 : 0) },
  { name: 'sma 50 + vol 60%', w: (c, j) => (c[j] > sma(c, j, 50) ? volW(c, j, 0.60) : 0) },
  { name: 'momentum 56d + vol 60%', w: (c, j) => (j >= 56 && c[j] > c[j - 56] ? volW(c, j, 0.60) : 0) },
];

// One coin, one rule, from `from` to `to` (ms). The weight moves only when the rule's new weight is
// 10 points from the last one it traded to, or goes to full size or to cash -- for the volatility
// rule that is exactly the desk's books.needsRebalance.
function simulate(bars, rule, { from = -Infinity, to = Infinity, bps = 40, band = 0.1 } = {}) {
  const c = bars.map((b) => b.c), o = bars.map((b) => b.o);
  let eq = 1, w = 0, last = null, peak = 1, dd = 0, trades = 0, days = 0;
  const rets = [];
  for (let j = WARM; j < bars.length - 1; j++) {
    let want = rule.w(c, j);
    if (!Number.isFinite(want)) want = 0;
    const move = rule.vol ? books.needsRebalance(want, last, band) : (last == null || Math.abs(want - last) >= band || (want === 0 && last > 0) || (want === 1 && last < 1));
    if (!move) want = w;
    const t = bars[j + 1].t;
    if (t < from || t >= to) { w = want; last = want; continue; }
    const traded = Math.abs(want - w);
    if (traded > 1e-9) trades++;
    const cut = traded * bps / 10000;
    // the old weight from yesterday's close to today's open, the new one from the open to the close
    const r1 = o[j + 1] / c[j] - 1, r2 = c[j + 1] / o[j + 1] - 1;
    const day = (1 - cut) * (1 + w * r1) * (1 + want * r2) - 1;
    eq *= 1 + day; rets.push(day); days++;
    w = want; last = want;
    peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1);
  }
  const years = days / 365;
  const m = rets.reduce((a, x) => a + x, 0) / (rets.length || 1);
  const sd = Math.sqrt(rets.reduce((a, x) => a + (x - m) ** 2, 0) / (rets.length || 1));
  return { cagr: years > 0 ? Math.pow(eq, 1 / years) - 1 : 0, maxDD: dd, sharpe: sd > 0 ? (m / sd) * Math.sqrt(365) : 0, trades, days, growth: eq };
}

// ------------------------------------------------------------------ the fetch
async function fetchCoin(id, from) {
  const out = new Map();
  const now = Date.now();
  for (let start = Date.parse(from); start < now;) {
    const end = Math.min(now, start + 299 * 86400000);
    const url = `https://api.exchange.coinbase.com/products/${id}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', connection: 'close' } });
    if (r.status !== 200) throw new Error(`${id}: HTTP ${r.status}`);
    // [time, low, high, open, close, volume]; only finished days
    for (const [t, l, h, op, cl, v] of await r.json()) if ((t + 86400) * 1000 <= now) out.set(t, { t: t * 1000, o: op, h, l, c: cl, v });
    start = end + 86400000;
    await new Promise((ok) => setTimeout(ok, 250));
  }
  return [...out.values()].sort((a, b) => a.t - b.t);
}

// ------------------------------------------------------------------ the table
const pct = (x) => `${(x * 100).toFixed(1)}%`.padStart(7);
function table({ from, bps }) {
  const have = COINS.map(([id]) => id).filter((id) => fs.existsSync(path.join(DIR, `${id}.json`)));
  if (!have.length) { console.log('no bars yet: run node tools/crypto-lab.js --fetch'); return 1; }
  const data = Object.fromEntries(have.map((id) => [id, JSON.parse(fs.readFileSync(path.join(DIR, `${id}.json`), 'utf8'))]));
  const last = Math.min(...have.map((id) => data[id][data[id].length - 1].t));
  console.log(`crypto lab · ${new Date(from).toISOString().slice(0, 10)} to ${new Date(last).toISOString().slice(0, 10)} · ${bps / 100}% a side · a year a row, then drawdown and Sharpe`);
  console.log('rule'.padEnd(24) + have.map((id) => id.padEnd(30)).join(''));
  for (const rule of RULES) {
    const cells = have.map((id) => { const r = simulate(data[id], rule, { from, bps }); return `${pct(r.cagr)} dd${pct(r.maxDD)} sh${r.sharpe.toFixed(2).padStart(5)}`.padEnd(30); });
    console.log(rule.name.padEnd(24) + cells.join(''));
  }
  return 0;
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  if (argv.includes('--fetch')) {
    fs.mkdirSync(DIR, { recursive: true });
    for (const [id, from] of COINS) {
      const bars = await fetchCoin(id, from);
      fs.writeFileSync(path.join(DIR, `${id}.json`), JSON.stringify(bars));
      console.log(`${id}: ${bars.length} days, ${new Date(bars[0].t).toISOString().slice(0, 10)} to ${new Date(bars[bars.length - 1].t).toISOString().slice(0, 10)}`);
    }
    return 0;
  }
  return table({ from: Date.parse(`${arg('--from', '2022-01-01')}T00:00:00Z`), bps: +arg('--bps', 40) });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { simulate, RULES, WARM };

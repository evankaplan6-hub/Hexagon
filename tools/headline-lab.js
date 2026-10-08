'use strict';
// The headline lab: after a market headline, does a coin move in a way a bot that reads the headline
// a few seconds late could trade? The question behind wiring the X feed (the investment stack's
// xfeed.py, which logs the posts of a few headline accounts as X publishes them) into the stocks,
// crypto and options desk.
//
//   node tools/headline-lab.js --fetch       Coinbase one-minute candles for the log's span -> data/crypto/minutes/
//                                            (again whenever the log has grown; it fetches only what is missing)
//   node tools/headline-lab.js               the table: the crypto book's five coins; held 5, 15, 30, 60 minutes; 0.40% a side
//   node tools/headline-lab.js --bps 10 --log path/to/x.jsonl
//
// RESEARCH ONLY. It reads the feed's log on this Mac (~/.local/share/xfeed/x.jsonl) and Coinbase's public
// candles. It calls no X server, copies no post into data/, and places no order.
//
// WHY CRYPTO ONLY. The desk's SPY and option prices are Cboe's, about 15 minutes late. A headline arrives
// in about 5 seconds, so a SPY bot would fill at prices from before the news, and its paper would show
// profits no one could take. Coinbase's prices are live, so crypto is the one place to test it honestly.
//
// THE FILL MODEL. Coinbase's finest candle is one minute, so time here is in whole minutes: a post at
// 10:03:20 falls in the 10:03 minute.
//   - The move after: from the open of the post's minute to the open H minutes later, against the same
//     stretch at the same clock time on the other days in the candles, weekdays against weekdays (a coin
//     moves more in New York's hours, when most headlines land, so an all-day average would flatter them).
//   - The ceiling: a bot that guessed the direction right every time and got in at the open of the post's
//     minute, up to a minute BEFORE the post, which no real bot can. If this does not clear the fee, no
//     rule on these headlines can.
//   - Follow the first minute: the bot has the post LAG_S after it went out; it watches the first whole
//     minute after that, and if the coin is then above the open of the post's minute it buys at the next
//     minute's open and sells H minutes later. Long only, as the desk (no shorting). --bps each way.
// A bot holds one position per coin, so a headline while it is still holding is not a new trade, and
// every figure uses the same headlines: a burst of posts on one story counts once.
//
// WHAT IT FOUND (2026-09-30, 274 posts from four headline accounts, 2026-09-28 03:48 to 09-30 18:11 ET): the
// coins moved no more after a post than at the same time on other days (x 0.8 to 1.1); the ceiling lost to
// the fee on average on all five coins at every hold; following the first minute earned nothing before fees
// (BTC 15m -0.02%) and -0.82% after. The 24 crypto-or-Fed posts moved BTC up to twice as much, too few to
// judge. Not wired in. README, "Headlines: tested, not wired in". Three days is a first look: rerun it.
// RERUN 2026-10-08, 894 posts, 2026-09-28 03:48 to 10-07 22:43 ET (ten days, three times the first look): the same
// answer. x 0.9 to 1.0 on every coin and hold; the ceiling lost to the fee on average everywhere (best: DOGE 60m
// -0.30%); following the first minute grossed -0.10% to +0.06% and netted -0.74% to -0.89%. The 76 crypto-or-Fed
// posts: x 1.0 to 1.3, follow still -0.67% or worse after fees. Still not wired in.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { et, etToUtc } = require('../src/desk/clock');

const DIR = path.join(__dirname, '..', 'data', 'crypto', 'minutes');
const LOG = path.join(os.homedir(), '.local', 'share', 'xfeed', 'x.jsonl');
const COINS = ['BTC-USD', 'ETH-USD', 'SOL-USD', 'XRP-USD', 'DOGE-USD'];   // the crypto book's coins
const HOLDS = [5, 15, 30, 60];
const LAG_S = 5;          // the live stream's delay from posting: a median of 4.8 s over its first 111 live posts
const MATCH_DAYS = 5;     // the same clock time up to this many days either side is the "any other day" baseline
const MIN = 60000;
// Headlines about crypto or the Fed, the likeliest to move a coin. Fixed here, before the numbers.
const CRYPTO = /bitcoin|\bbtc\b|crypto|\bether\b|\beth\b|solana|\bfed\b|powell|fomc|\bcpi\b|tariff|rate cut/i;

// ------------------------------------------------------------------ the inputs (pure)
// The feed's log, one JSON post a line -> [{ t (the instant it was posted), id, account, text }], oldest
// first, each post once. time_et is Eastern wall-clock time with no offset, as the feed writes it.
function parseLog(text) {
  const seen = new Set(), out = [];
  for (const line of String(text).split('\n')) {
    if (!line.trim()) continue;
    let r;
    try { r = JSON.parse(line); } catch { continue; }
    const t = etToUtc(r && r.time_et);
    if (!t || !r.id || seen.has(r.id)) continue;
    seen.add(r.id);
    out.push({ t, id: String(r.id), account: String(r.account || ''), text: String(r.text || '') });
  }
  return out.sort((a, b) => a.t - b.t);
}

// Candles [{ t, o, c }] -> one open and one close per minute from the first to the last. A minute with no
// trade has no candle; it opens and closes at the last close.
function series(candles) {
  const cs = [...candles].sort((a, b) => a.t - b.t);
  if (!cs.length) return { t0: 0, o: [], c: [] };
  const t0 = cs[0].t, n = (cs[cs.length - 1].t - t0) / MIN + 1, o = new Array(n), c = new Array(n);
  let j = 0, last = cs[0].o;
  for (let i = 0; i < n; i++) {
    while (j < cs.length && cs[j].t < t0 + i * MIN) j++;
    if (j < cs.length && cs[j].t === t0 + i * MIN) { o[i] = cs[j].o; c[i] = cs[j].c; last = cs[j].c; } else { o[i] = last; c[i] = last; }
  }
  return { t0, o, c };
}

// One position at a time: a post while the bot is still busy with an earlier one is skipped. Busy runs
// from the post's minute to the follow rule's exit at the latest (two minutes to decide, then the hold).
function pick(posts, hold) {
  const out = [];
  let free = -Infinity;
  for (const p of posts) {
    const m = Math.floor(p.t / MIN) * MIN;
    if (m < free) continue;
    out.push(p);
    free = m + (hold + 2) * MIN;
  }
  return out;
}

// ------------------------------------------------------------------ the measure (pure)
// One coin, one hold -> the row, and each trade for a closer look.
function measure(posts, s, { hold, bps = 40, lag = LAG_S }) {
  const f = bps / 10000, n = s.o.length;
  const idx = (t) => Math.floor(t / MIN) - Math.floor(s.t0 / MIN);
  const ret = (i, h) => s.o[i + h] / s.o[i] - 1;
  const net = (entry, exit) => (exit * (1 - f)) / (entry * (1 + f)) - 1;
  const trades = [];
  for (const p of pick(posts, hold)) {
    const i0 = idx(p.t);
    const i1 = Math.ceil((p.t + lag * 1000) / MIN) - Math.floor(s.t0 / MIN);   // the first whole minute the bot watches
    if (i0 < 0 || i1 + 1 + hold >= n || i0 + hold >= n) continue;
    const move = ret(i0, hold);
    // the same clock time on other days of the same kind (weekday against weekday)
    const weekend = (t) => { const wd = et(t).wd; return wd === 0 || wd === 6; };
    const base = [];
    for (let k = -MATCH_DAYS; k <= MATCH_DAYS; k++) {
      const j = i0 + k * 1440;
      if (k === 0 || j < 0 || j + hold >= n || weekend(s.t0 + j * MIN) !== weekend(p.t)) continue;
      base.push(Math.abs(ret(j, hold)));
    }
    const up = s.c[i1] > s.o[i0];
    trades.push({
      post: p, move, base: base.length ? base.reduce((a, x) => a + x, 0) / base.length : null,
      ceiling: net(1, 1 + Math.abs(move)),
      follow: up ? { gross: ret(i1 + 1, hold), net: net(s.o[i1 + 1], s.o[i1 + 1 + hold]) } : null,
    });
  }
  const avg = (xs) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : NaN);
  const based = trades.filter((x) => x.base != null);
  const fol = trades.filter((x) => x.follow);
  return {
    hold, n: trades.length,
    move: avg(trades.map((x) => Math.abs(x.move))),
    matched: based.length ? avg(based.map((x) => Math.abs(x.move))) / avg(based.map((x) => x.base)) : NaN,
    base: avg(based.map((x) => x.base)),
    ceiling: avg(trades.map((x) => x.ceiling)),
    clears: trades.length ? trades.filter((x) => x.ceiling > 0).length / trades.length : NaN,
    follow: {
      n: fol.length, won: fol.length ? fol.filter((x) => x.follow.net > 0).length / fol.length : NaN,
      gross: avg(fol.map((x) => x.follow.gross)), net: avg(fol.map((x) => x.follow.net)),
      total: fol.reduce((a, x) => a * (1 + x.follow.net), 1) - 1,
    },
    trades,
  };
}

// ------------------------------------------------------------------ the fetch
const file = (id) => path.join(DIR, `${id}.json`);
const load = (id) => (fs.existsSync(file(id)) ? JSON.parse(fs.readFileSync(file(id), 'utf8')) : []);

async function fetchRange(id, from, to) {
  const out = [];
  for (let start = from; start < to;) {
    const end = Math.min(to, start + 300 * MIN);
    const url = `https://api.exchange.coinbase.com/products/${id}/candles?granularity=60&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`;
    const r = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0', connection: 'close' } });
    if (r.status !== 200) throw new Error(`${id}: HTTP ${r.status}`);
    // [time, low, high, open, close, volume], newest first; only finished minutes
    for (const [t, , , o, c] of await r.json()) if ((t + 60) * 1000 <= Date.now()) out.push({ t: t * 1000, o, c });
    start = end;
    await new Promise((ok) => setTimeout(ok, 150));
  }
  return out;
}

// Only what the cache lacks: before its first minute and after its last.
async function fetchCoin(id, from, to) {
  const have = load(id), got = new Map(have.map((x) => [x.t, x]));
  const first = have.length ? have[0].t : to, last = have.length ? have[have.length - 1].t + MIN : from;
  if (from < first) for (const x of await fetchRange(id, from, first)) got.set(x.t, x);
  if (last < to) for (const x of await fetchRange(id, Math.max(from, last), to)) got.set(x.t, x);
  const all = [...got.values()].sort((a, b) => a.t - b.t);
  fs.writeFileSync(file(id), JSON.stringify(all));
  return all;
}

// ------------------------------------------------------------------ the table
const pc = (x, d = 2) => (Number.isFinite(x) ? `${x >= 0 && x !== 0 ? '+' : ''}${(x * 100).toFixed(d)}%` : '-');
const ab = (x) => (Number.isFinite(x) ? `${(x * 100).toFixed(2)}%` : '-');
const stamp = (t) => { const e = et(t); return `${e.day} ${String(Math.floor(e.min / 60)).padStart(2, '0')}:${String(e.min % 60).padStart(2, '0')}`; };

function table(posts, { bps }) {
  const have = COINS.filter((id) => fs.existsSync(file(id)));
  if (!have.length) { console.log('no candles yet: run node tools/headline-lab.js --fetch'); return 1; }
  console.log(`headline lab · ${posts.length} posts, ${stamp(posts[0].t)} to ${stamp(posts[posts.length - 1].t)} ET · Coinbase one-minute candles · ${(bps / 100).toFixed(2)}% a side`);
  console.log('move after: the average size of the move, either way, from the post\'s minute; x: that against the same clock time on other days');
  console.log('ceiling: the direction guessed right every time, from up to a minute BEFORE the post, after the fee; clears: how often that beat the fee');
  console.log(`follow: buy if the coin is up after the first whole minute the bot has the post (${LAG_S} s late), sell after the hold\n`);
  const cut = { 'every post': posts, 'crypto or Fed posts': posts.filter((p) => CRYPTO.test(p.text)) };
  const S = Object.fromEntries(have.map((id) => [id, series(load(id))]));
  for (const [name, ps] of Object.entries(cut)) {
    console.log(`${name} (${ps.length})`);
    console.log('coin      hold  posts  move after  other days     x   ceiling  clears   follow: trades    won   gross     net   all together');
    for (const id of have) {
      for (const hold of HOLDS) {
        const r = measure(ps, S[id], { hold, bps });
        console.log(`${id.padEnd(9)}${`${hold}m`.padStart(5)}${String(r.n).padStart(7)}${ab(r.move).padStart(12)}${ab(r.base).padStart(12)}${(Number.isFinite(r.matched) ? r.matched.toFixed(1) : '-').padStart(6)}${pc(r.ceiling).padStart(10)}${ab(r.clears).replace(/\.00%/, '%').padStart(8)}${String(r.follow.n).padStart(17)}${ab(r.follow.won).replace(/\.00%/, '%').padStart(7)}${pc(r.follow.gross).padStart(8)}${pc(r.follow.net).padStart(8)}${pc(r.follow.total, 1).padStart(15)}`);
      }
    }
    console.log('');
  }
  // the biggest moves after a post, to read what moved it
  if (S['BTC-USD']) {
    const r = measure(posts, S['BTC-USD'], { hold: 15, bps });
    console.log('BTC\'s five biggest 15-minute moves after a post:');
    for (const x of [...r.trades].sort((a, b) => Math.abs(b.move) - Math.abs(a.move)).slice(0, 5)) {
      console.log(`  ${stamp(x.post.t)}  ${pc(x.move)}  (other days ${ab(x.base)})  @${x.post.account}: ${x.post.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }
  return 0;
}

async function main(argv) {
  const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
  const logPath = arg('--log', LOG);
  if (!fs.existsSync(logPath)) { console.log(`no feed log at ${logPath}`); return 1; }
  const posts = parseLog(fs.readFileSync(logPath, 'utf8'));
  if (!posts.length) { console.log('the feed log has no posts'); return 1; }
  if (argv.includes('--fetch')) {
    fs.mkdirSync(DIR, { recursive: true });
    const from = Math.floor((posts[0].t - MATCH_DAYS * 86400000) / MIN) * MIN;
    const to = Math.floor(Date.now() / MIN) * MIN;
    for (const id of COINS) {
      const all = await fetchCoin(id, from, to);
      console.log(`${id}: ${all.length} minutes, ${stamp(all[0].t)} to ${stamp(all[all.length - 1].t)} ET`);
    }
    return 0;
  }
  return table(posts, { bps: +arg('--bps', 40) });
}

if (require.main === module) main(process.argv.slice(2)).then((code) => process.exit(code || 0)).catch((e) => { console.error(e.message); process.exit(1); });

module.exports = { parseLog, series, pick, measure, CRYPTO, LAG_S };

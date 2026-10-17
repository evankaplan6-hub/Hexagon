'use strict';
// The crypto note: what the crypto book's rule holds, what it would hold at today's prices, what changed, and how
// it stands against simply holding the same coins. The one rule on the desk with evidence behind it (README,
// "Every coin (2026-10-08): it cuts losses, it does not make money"), in a dozen lines a person reads in the
// morning. Evan, 2026-10-16, agreeing to the plan: "build the crypto note".
//
//   node tools/crypto-note.js --box     the Fly box's desk (copied into data/fly/desk-now/ by desk-check's own pull)
//   node tools/crypto-note.js --dir D   a folder holding a desk's state.json
//
// It is about the paper desk and nothing else: it is not advice, the desk has no broker, and the note says so.
// The figures are the desk's own: the real engine is loaded on a copy of the state (in a temporary folder, so
// nothing is written back), its prices fetched from Coinbase's public API as the desk does, and its snapshot read.
const fs = require('fs');
const os = require('os');
const path = require('path');

const COIN = { 'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ether', 'SOL-USD': 'Solana', 'XRP-USD': 'XRP', 'DOGE-USD': 'Dogecoin' };
const r2 = (x) => Math.round(x * 100) / 100;
const money = (x) => `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const signed = (x) => `${x >= 0 ? '+' : '−'}${money(x)}`;
const pct = (x) => `${Math.round(x * 100)}%`;
const ET = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// The note from a desk snapshot (`snap`, the engine's), the state's minute history (`hist`, [{ t, c, bc }]) and its
// fills (`fills`), at `now`. Pure, so the tests can feed it a fixture. `band` is the rule's rebalancing band.
function note(snap, hist, fills, now, { band = 0.10 } = {}) {
  const book = (snap.books || []).find((b) => b.key === 'crypto');
  if (!book) return 'No crypto book in the desk.';
  const L = [];
  L.push(`Crypto note · ${ET.format(new Date(now))} ET · paper desk, not advice`);
  L.push('');
  // where it stands: since the start and over the last seven days, against holding the same coins
  const since = r2(book.pnl), hold = book.benchPnl;
  L.push(`Since ${new Date(book.startedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/New_York' })}: ${signed(since)} on ${money(book.initial)}` +
    (hold != null ? `; just holding the same coins ${signed(hold)}, so the rule is ${since >= hold ? 'ahead' : 'behind'} by ${money(since - hold)}.` : '.'));
  const last = hist[hist.length - 1], wk = [...hist].reverse().find((h) => h.t <= now - 7 * 864e5);
  if (last && wk && Number.isFinite(wk.c) && Number.isFinite(wk.bc)) {
    const a = r2(last.c - wk.c), b = r2(last.bc - wk.bc);
    L.push(`Last 7 days: ${signed(a)}; holding ${signed(b)} (${a >= b ? 'ahead' : 'behind'} by ${money(a - b)}).`);
  }
  L.push('');
  // each coin: how much of its slot is in the coin, what the rule wants at today's swings, and whether that is a trade
  L.push('Coin       held   rule now   swings   next check');
  const moves = [];
  for (const r of book.rows) {
    const worth = r.worth > 0 ? r.worth : r.initial, held = worth > 0 ? r.value / worth : 0;
    const want = Number.isFinite(r.want) ? r.want : null, last = Number.isFinite(r.target) ? r.target : null;
    const trade = want != null && (last == null || Math.abs(want - last) >= band - 1e-12 || (want === 1 && last !== 1));
    const what = want == null ? 'no price history yet' : !trade ? 'no trade (inside the 10-point band)'
      : want > (last ?? 0) ? `would buy, to ${pct(want)}` : `would sell, to ${pct(want)}`;
    if (trade) moves.push(`${COIN[r.sym] || r.name} ${want > (last ?? 0) ? 'up' : 'down'} to ${pct(want)}`);
    L.push(`${(COIN[r.sym] || r.name).padEnd(10)} ${pct(held).padStart(4)}   ${want == null ? '  —' : pct(want).padStart(4)}       ${Number.isFinite(r.vol) ? pct(r.vol).padStart(4) : '  —'}     ${what}`);
  }
  L.push(`(The rule aims each coin at 40% swings a year: a coin swinging 80% gets half its slot. It trades at the 8 PM ET check, and only when the aim has moved 10 points from what it last traded to.)`);
  L.push('');
  // what changed: the book's fills in the last day
  const day = (fills || []).filter((f) => f.book === 'crypto' && f.at >= now - 864e5);
  L.push(day.length ? `Last 24 hours: ${day.map((f) => `${f.side === 'buy' ? 'bought' : 'sold'} ${COIN[f.sym] || f.sym} (${money(f.value)})`).join(', ')}.` : 'Last 24 hours: no trades.');
  L.push(moves.length ? `At the next 8 PM ET check, if prices hold: ${moves.join(', ')}.` : 'At the next 8 PM ET check, if prices hold: nothing to do.');
  return L.join('\n');
}

async function build(dir) {
  const { Desk } = require('../src/desk/engine');
  const cfg = require('../src/config');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crypto-note-'));
  fs.mkdirSync(path.join(tmp, 'desk'));
  fs.copyFileSync(path.join(dir, 'state.json'), path.join(tmp, 'desk', 'state.json'));
  try {
    const desk = new Desk({ ...cfg, dataDir: tmp }, {});
    desk.quiet = true;
    await desk.holt();
    desk.ilsa();
    return { snap: desk.snapshot(), hist: desk.state.history || [], fills: desk.state.fills || [], band: desk.D.rebalBand };
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

if (require.main === module) (async () => {
  const argv = process.argv.slice(2), at = argv.indexOf('--dir');
  let dir = at >= 0 ? argv[at + 1] : path.join(__dirname, '..', 'data', 'desk');
  if (argv.includes('--box')) {
    const check = require('./desk-check');
    // desk-check's own pull (read-only on the box); its report goes nowhere, only its copy is wanted
    check.run(['--box'], { log: () => {} });
    dir = path.join(__dirname, '..', 'data', 'fly', 'desk-now');
  }
  const { snap, hist, fills, band } = await build(dir);
  console.log(note(snap, hist, fills, Date.now(), { band }));
})().catch((e) => { console.error(e.stack || e.message); process.exit(1); });

module.exports = { note };

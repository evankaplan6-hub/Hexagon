'use strict';
// Golden-output harness for the decision refactor.
//
// Drives BRAM and RIGO over a FIXED set of synthetic pairs and positions and prints every
// decision they make. Run it before a refactor and after; the output must be byte-identical.
// Deterministic on purpose: no network, no clock, no randomness.
const agents = require('../src/agents');
const base = require('../src/config');
const cfg = { ...base, demo: false, mode: 'paper' };

const T0 = 1788900000000; // fixed clock
const mk = (id, label, kind, pmBid, pmAsk, ksBid, ksAsk, pmVol, ksVol, opts = {}) => ({
  id, label, kind, series: opts.series || 'KXTEST', inPlay: !!opts.inPlay,
  startsAt: opts.startsAt || null,
  pm: { id: `pm${id}`, tokenIndex: 0, tokenId: `tok${id}`, url: '' },
  ks: { ticker: `KXTEST-${id}`, title: label, eventTicker: `KXTEST-${id}`, url: '' },
  q: {
    pmBid, pmAsk, ksBid, ksAsk,
    pmMid: (pmBid + pmAsk) / 2, ksMid: (ksBid + ksAsk) / 2,
    pmSpread: pmAsk - pmBid, ksSpread: ksAsk - ksBid,
    pmVol, ksVol, t: opts.t === undefined ? T0 : opts.t,
  },
});

// deliberately spans the interesting cases: no gap, small gap, wide gap, tail prices, wide
// spread, in-play, stale quote, locked-arb candidate
const PAIRS = [
  mk('a', 'flat, no gap',            'fed',  0.50, 0.51, 0.50, 0.51, 500000, 400000),
  mk('b', 'small gap 2c',            'fed',  0.45, 0.46, 0.47, 0.48, 500000, 400000),
  mk('c', 'wide gap 8c',             'fed',  0.40, 0.41, 0.48, 0.49, 900000, 100000),
  mk('d', 'wide gap thin side',      'fed',  0.20, 0.21, 0.48, 0.49, 5000,   900000),
  mk('e', 'tail price 2c',           'fed',  0.01, 0.02, 0.06, 0.07, 500000, 400000),
  mk('f', 'wide spread 8c',          'fed',  0.40, 0.48, 0.50, 0.51, 500000, 400000),
  mk('g', 'in-play game',            'game', 0.30, 0.31, 0.45, 0.46, 500000, 400000, { inPlay: true }),
  mk('h', 'stale quote',             'fed',  0.30, 0.31, 0.45, 0.46, 500000, 400000, { t: T0 - 600000 }),
  mk('i', 'locked arb candidate',    'fed',  0.40, 0.41, 0.62, 0.63, 500000, 400000),
  mk('j', 'gap clears, edge thin',   'fed',  0.50, 0.51, 0.54, 0.55, 500000, 400000),
];

const POSITIONS = [
  { id: 'p1', group: 'g1', pairId: 'a', label: 'flat, no gap', venue: 'KS', ref: 'KXTEST-a', pmId: 'pma', tokenIndex: 0, side: 'yes', qty: 100, entry: 0.45, mark: 0.50, cost: 45, fee: 0, openedAt: T0 - 60 * 60000, strategy: 'converge' },
  { id: 'p2', group: 'g2', pairId: 'c', label: 'wide gap 8c',  venue: 'KS', ref: 'KXTEST-c', pmId: 'pmc', tokenIndex: 0, side: 'yes', qty: 100, entry: 0.60, mark: 0.48, cost: 60, fee: 0, openedAt: T0 - 60 * 60000, strategy: 'converge' },
  { id: 'p3', group: 'g3', pairId: 'b', label: 'small gap 2c', venue: 'KS', ref: 'KXTEST-b', pmId: 'pmb', tokenIndex: 0, side: 'yes', qty: 100, entry: 0.45, mark: 0.47, cost: 45, fee: 0, openedAt: T0 - 500 * 60000, strategy: 'converge' },
  { id: 'p4', group: 'g4', pairId: 'g', label: 'in-play game',  venue: 'KS', ref: 'KXTEST-g', pmId: 'pmg', tokenIndex: 0, side: 'yes', qty: 100, entry: 0.40, mark: 0.45, cost: 40, fee: 0, openedAt: T0 - 10 * 60000, strategy: 'converge' },
  { id: 'p5', group: 'g5', pairId: 'zz', label: 'orphaned pair gone', venue: 'KS', ref: 'KXTEST-zz', pmId: 'pmzz', tokenIndex: 0, side: 'yes', qty: 100, entry: 0.40, mark: 0.42, cost: 40, fee: 0, openedAt: T0 - 500 * 60000, strategy: 'converge' },
];

function fakeEngine() {
  const out = [];
  const E = {
    cfg, cycle: 1, pairs: PAIRS.map((p) => ({ ...p })), signals: [], halt: null,
    bias: new Map(), history: new Map(), quotes: { pm: new Map(), ks: new Map() },
    lastQuoteAt: T0, operatorHalt: null, liveReady: true,
    state: { positions: POSITIONS.map((p) => ({ ...p })), closed: [], log: [], cash: 10000, stats: { realized: 0, fees: 0, wins: 0, losses: 0, groupsClosed: 0 }, dayKey: 'x', dayStartEquity: 10000 },
    agentStatus: {}, out,
    touch: (a, n) => out.push(`TOUCH ${a}: ${n}`),
    log: (a, k, p, t) => out.push(`LOG   ${a} ${k} ${p == null ? '-' : p} ${t}`),
    due: () => true,
    markPrice: (pos, q) => (pos.side === 'yes' ? q.ksBid : Math.round((1 - q.ksAsk) * 1000) / 1000),
    close: async (pos, px, reason) => out.push(`CLOSE ${pos.id} @${px} :: ${reason}`),
    resolution: async () => null,
    equity: () => 10000, budget: () => 200,
  };
  for (const k of ['BRAM', 'KETT', 'RIGO', 'TESS', 'HOLT', 'ILSA']) E.agentStatus[k] = { lastActive: 0, runs: 0, note: '' };
  return E;
}

(async () => {
  const RealNow = Date.now;
  Date.now = () => T0;                       // freeze the clock so held-time decisions are stable
  try {
    const E = fakeEngine();
    await agents.RIGO(E);
    agents.BRAM(E);
    console.log('--- SIGNALS ---');
    for (const s of E.signals) {
      console.log(`${s.type} ${s.pair.label.padEnd(24)} edge=${s.edge.toFixed(5)} gap=${s.gap == null ? '-' : s.gap.toFixed(4)} legs=${s.legs.map((l) => `${l.venue}/${l.side}@${l.px.toFixed(4)}`).join('+')}`);
    }
    console.log('--- FAIR / BEST PER PAIR ---');
    for (const p of E.pairs) {
      console.log(`${p.label.padEnd(24)} fair=${p.fair == null ? '-' : p.fair.toFixed(5)} best=${p.best ? `${p.best.venue}/${p.best.side}@${p.best.px.toFixed(4)} edge=${p.best.edge.toFixed(5)}` : '-'}`);
    }
    console.log('--- SIDE EFFECTS ---');
    for (const line of E.out) console.log(line);
  } finally { Date.now = RealNow; }
})();

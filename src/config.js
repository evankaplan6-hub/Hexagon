'use strict';
const path = require('path');
const env = (k, d) => (process.env[k] === undefined || process.env[k] === '' ? d : process.env[k]);
const num = (k, d) => { const v = parseFloat(env(k, d)); return Number.isFinite(v) ? v : d; };

module.exports = {
  port: num('PORT', 8787),
  mode: env('MODE', 'paper') === 'live' ? 'live' : 'paper',
  demo: env('DEMO', '0') === '1',
  initialBalance: num('INITIAL_BALANCE', 10000),
  dataDir: env('DATA_DIR', path.join(__dirname, '..', 'data')),
  record: env('RECORD', '1') !== '0', // append a tick line per priced pair per cycle under dataDir
  // Thin-market probe (src/probe.js): when the venues disagree by this much, dump BOTH full order
  // books. A gap this wide is either a real opportunity or a price with no size behind it, and
  // only the book can tell the difference. Read-only: probing never signals or trades.
  probeGap: num('PROBE_GAP', 0.10),
  probeEverySec: num('PROBE_EVERY_SEC', 600),   // per-pair cooldown, so one wide pair cannot spam
  probesPerCycle: num('PROBES_PER_CYCLE', 2),   // bound the extra API calls per cycle

  // serving. Default to loopback: /api/positions and the full activity log are unauthenticated,
  // and on a live account that is not something to expose to the local network by default.
  bindHost: env('BIND_HOST', '127.0.0.1'),
  // Shared secret for POST /api/flatten, the manual kill switch. Empty disables the endpoint
  // entirely -- there is no default token, because a guessable one is worse than no switch.
  flattenToken: env('FLATTEN_TOKEN', ''),

  // risk
  maxPositionPct: num('MAX_POSITION_PCT', 0.02),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 12),
  maxDailyDrawdownPct: num('MAX_DAILY_DRAWDOWN_PCT', 0.03),
  maxDataAgeSec: num('MAX_DATA_AGE_SEC', 90),

  // strategy
  minArbEdge: num('MIN_ARB_EDGE', 0.01),
  minGap: num('MIN_GAP', 0.03),
  // Required profit per contract on a convergence trade, NET of the spread paid on the way
  // out and a taker fee on BOTH sides. Deliberately separate from minGap: a venue gap of G
  // puts fair value only part of the way from the cheap venue, so the realisable edge is
  // always well under G. Testing edge against minGap (the old behaviour) demanded 6-10c
  // gaps to clear a nominal "3c" threshold and made the convergence book unreachable.
  minEdge: num('MIN_EDGE', 0.005),
  exitGap: num('EXIT_GAP', 0.01),
  stopLoss: num('STOP_LOSS', 0.06),
  maxHoldMin: num('MAX_HOLD_MIN', 240),
  minMid: 0.03, // ignore convergence signals on near-certain outcomes (tick noise dominates)
  maxMid: 0.97,
  maxSpread: 0.05, // do not chase into illiquid books

  // cadence (seconds)
  priceEvery: num('PRICE_EVERY_SEC', 15),
  sentimentEveryCycles: 4,

  // fees
  pmTakerFee: num('PM_TAKER_FEE', 0),
  ksFeeRate: num('KS_FEE_RATE', 0.07),

  // universe
  pmUniverse: num('PM_UNIVERSE', 300),
  ksSeries: env('KS_SERIES', 'KXFEDDECISION,KXATPMATCH,KXWTAMATCH,KXMLBGAME,KXNFLGAME,KXNBAGAME,KXNCAAFGAME,KXMLSGAME,KXEPLGAME,KXUCLGAME,KXLALIGAGAME').split(',').map((s) => s.trim()).filter(Boolean),

  // live
  kalshiKeyId: env('KALSHI_API_KEY_ID', ''),
  kalshiKeyPath: env('KALSHI_PRIVATE_KEY_PATH', ''),
  liveConfirm: env('LIVE_CONFIRM', '') === 'I_UNDERSTAND_REAL_MONEY',
};

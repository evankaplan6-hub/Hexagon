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
  //
  // This was 0.10 and it never fired once. Replaying probe.js's own selection over the recorded
  // tape, the threshold is a cliff: 10c, 5c and 4c all take ZERO probes, because the widest
  // pre-game gap in 17,649 non-in-play ticks is 3.00c. Every probe on disk predates the in-play
  // filter. The instrument was dark for its whole life.
  //
  // 0.03 is not a tuned number, it is minGap -- the bar at which the desk itself calls a pair
  // interesting. A gap under minGap cannot produce a trade, so probing it answers a question
  // nobody asked; a gap over it is exactly the case the probe exists to validate. Measured cost
  // at this bar: ~6 probes/day, 13 API calls. The next step down is not a small one -- 0.02 takes
  // 136 probes/day, a 20x jump, all of it on gaps the desk would refuse anyway.
  probeGap: num('PROBE_GAP', 0.03),
  probeEverySec: num('PROBE_EVERY_SEC', 600),   // per-pair cooldown, so one wide pair cannot spam
  probesPerCycle: num('PROBES_PER_CYCLE', 2),   // bound the extra API calls per cycle

  // ---- MAKER desk (src/maker.js) ----
  // Resting quotes instead of crossing. Only on series whose fee_type is plain `quadratic`, which
  // charge makers nothing -- on series that DO charge makers the fee is ~73% of the profit, so the
  // filter is hard rather than a preference. Candidates are screened for that at startup.
  makerEnabled: env('MAKER', '1') !== '0',
  // Every liquid plain-`quadratic` series found by an exchange-wide screen: 38 series carrying 91
  // markets that clear the desk's own volume and mid filters. Candidates only -- the desk ranks
  // them by 24h volume and quotes the top makerMarkets, because flow is the revenue.
  makerSeries: env('MAKER_SERIES', 'CONTROLH,SENATEME,KXNFLWINS,KXBALANCEPOWERCOMBO,SENATETX,SENATEOHS,KXHOUSERACE,SENATENE,SENATEMN,KXPRESNOMD,KXGOVBAL,SENATEMI,SENATEIA,KXNFLPLAYOFF,KXMOBILETEU,SENATENC,KXPRIMARYTURNOUT,SENATENH,KXRECORDNFLBEST,CONTROLS,KXOSCARNOMPIC,KXRECORDNFLWORST,KXPRESPERSON,KXNEXTPRESSEC,KXNFLLASTTOLOSE,KXNFL1SEED,KXBOND,KXNECORNYIELD,GOVPARTYIA,KXPRESNOMR,KXTRUMPADMINLEAVE,KXOSCARPIC,GOVPARTYOH,KXVOTEPRIMARY,KXBLUETSUNAMICOMBO,KXMLBDEBUT,GOVPARTYFL,KXNHMAPLE').split(',').map((s) => s.trim()).filter(Boolean),
  // More markets is more flow and therefore faster evidence, and the risk is capped PER market by
  // makerCap, so widening the book does not widen the per-name exposure. The binding constraint is
  // Kalshi's rate limit: each quoted market costs two calls per maker cycle.
  // Capital is not the constraint and it is not close: the held-out backtest peaked at $2.5k of
  // inventory against a $10k book. Absolute dollars is what matters, so quote wider rather than
  // bigger -- on the held-out pool the top 12 markets by trade rate returned +$454 and the top 24
  // returned +$515, on the same participation and the same cap. The real limit is the tick budget:
  // each quoted market costs two calls and ~80ms of pacing per maker cycle.
  makerMarkets: num('MAKER_MARKETS', 24),
  makerCap: num('MAKER_CAP', 100),              // inventory cap per market, in contracts
  makerParticipation: num('MAKER_PARTICIPATION', 0.10), // share of crossing volume we expect to win
  // One tick IS the target, not a fallback. Measured across 34 markets, P&L correlates -0.33 with
  // median spread and +0.82 with trade count: the earners all sit at a 1c spread with 7,000-15,000
  // trades, and every wide-spread market lost money. A wide book on Kalshi means an illiquid one,
  // and when an illiquid market trades it is usually because the taker knows something.
  makerMinSpread: num('MAKER_MIN_SPREAD', 0.01),
  makerMinVol24: num('MAKER_MIN_VOL24', 5000),  // cheap prefilter only; the real rail is the rate below
  // Flow, measured properly. `volume_24h` is a snapshot that a single block trade can inflate, and
  // ranking on it picks the wrong markets: over 48 markets never used in development, the top 12 by
  // 24h volume returned +$259 while the top 12 by observed trades-per-day returned +$454 on the same
  // pool. The floor matters as much as the ranking -- below roughly 20 trades a day the edge does not
  // survive a realistic queue, because the queue only clears if the market actually trades.
  makerMinTradesPerDay: num('MAKER_MIN_TPD', 10),
  // The number that decides everything. Joining the touch means joining the BACK of the queue at
  // that price, and the median quoted market has ~15,700 contracts already resting there. Feeding
  // every backtested market its OWN measured top-of-book depth cut the headline result from +$2187
  // to +$210 -- a 90% haircut, and the single largest correction this project has made. Split by
  // how fast that queue trades through, the whole edge is in one bucket: markets whose queue clears
  // inside a day returned +$357, everything slower returned about zero. So this is the primary
  // filter and the primary ranking, ahead of spread, volume and trade rate alike.
  makerMaxClearDays: num('MAKER_MAX_CLEAR_DAYS', 1),
  // Inventory held into resolution is not a spread capture, it is a coin flip settled at 0 or 1.
  // Nothing currently quoted resolves inside 114 days, so this costs nothing today -- which is
  // exactly when to put it in, rather than after the universe rotates into something expiring.
  makerMinDaysToClose: num('MAKER_MIN_DAYS_TO_CLOSE', 7),
  // Doubled once the probe stopped making a second call per candidate for depth it already had.
  // How many markets QUALIFY is what limits this desk -- widening the search is the only lever
  // that is not just leverage.
  makerRateProbe: num('MAKER_RATE_PROBE', 80),
  makerMinMid: num('MAKER_MIN_MID', 0.08),
  makerMaxMid: num('MAKER_MAX_MID', 0.92),
  // How often the maker requotes, in seconds. This is THE number: a quote resting unattended is
  // run over on 69% of its fills against 5% in the backtest, because the only fills a stale quote
  // wins are the ones that have already moved through it. It ran on the engine's 15s cycle every
  // other tick -- 30 seconds -- because per-market fetching cost 48 calls a round. Batched
  // (src/tape.js) the same round costs about 11, so it can run on its own timer instead.
  // Two seconds, not five. A round costs two calls and takes about 100ms, so the limit is not
  // compute -- it is the tape: /markets/trades returns 1000 prints and the exchange runs at ~160
  // a second, so a page covers roughly six seconds. Polling every five left no margin and dropped
  // trades during busy stretches. At two seconds a page holds three times what we need.
  makerEverySec: num('MAKER_EVERY_SEC', 2),
  // The maker keeps its own drawdown rail. TESS's watches the TAKER book's equity and would never
  // notice this desk bleeding, because the two ledgers are deliberately separate.
  makerMaxDrawdownPct: num('MAKER_MAX_DRAWDOWN_PCT', 0.10),

  // serving. Default to loopback: /api/positions and the full activity log are unauthenticated,
  // and on a live account that is not something to expose to the local network by default.
  bindHost: env('BIND_HOST', '127.0.0.1'),
  // Dashboard password. Empty is fine on loopback; binding anywhere else without one is refused at
  // startup. /api/positions and the whole activity log are unauthenticated otherwise, and a desk
  // with live-trading code in it is not something to leave open on a public address.
  dashUser: env('DASH_USER', 'hexagon'),
  dashPass: env('DASH_PASS', ''),
  // Shared secret for POST /api/flatten, the manual kill switch. Empty disables the endpoint
  // entirely -- there is no default token, because a guessable one is worse than no switch.
  flattenToken: env('FLATTEN_TOKEN', ''),

  // risk
  maxPositionPct: num('MAX_POSITION_PCT', 0.02),
  // ILSA's conviction read expressed as a FRACTION of the per-position cap, never a boost on top
  // of it. A neutral convergence signal sizes at this fraction and a converging one at the full
  // cap, so "sized up on ILSA flow" is a real 25% more contracts while `maxPositionPct` stays a
  // ceiling nothing can lift. The old `budget * 1.25` put a high-conviction position at 2.5% of
  // equity against a documented 2%; clamping that multiplier instead made it a silent no-op,
  // because the budget handed to sizePlan already IS the cap. Locked arbs are unaffected -- they
  // are hedged, and always size to the full cap.
  baseSizeMult: num('BASE_SIZE_MULT', 0.8),
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 12),
  maxDailyDrawdownPct: num('MAX_DAILY_DRAWDOWN_PCT', 0.03),
  maxDataAgeSec: num('MAX_DATA_AGE_SEC', 90),
  // API errors in a 5m window before TESS halts new risk. Was hardcoded as `errs >= 25` inside
  // riskState while every other rail it checks was a knob -- the one number you cannot tune from
  // .env is the one that fires during exactly the venue outage you would want to tune it for.
  // Capped at 200 because that is how many timestamps src/http.js keeps: `recentErrors()` can
  // never return more, so a threshold above it would silently disable the halt during exactly the
  // outage it exists for. Exposing the knob is what makes that ceiling reachable.
  maxApiErrors: Math.min(200, num('MAX_API_ERRORS', 25)),

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
  // How far past the signalled price a fill may walk when sizing to depth. This is the difference
  // between the edge the signal was priced on and the edge actually taken: at a MIN_EDGE of 0.5c
  // a 1c slip allowance can spend twice the edge, so it is a knob, not a constant.
  slipLimit: num('SLIP_LIMIT', 0.01),
  // Samples back ILSA looks to call the gap converging or diverging. Eight at a 15s cadence is
  // two minutes, which is short enough that one wide print flips the read.
  // Floored at 2 and forced to an integer: `history[length - 0]` is undefined and the next line
  // reads `.ksMid` off it, which throws inside ILSA's per-pair loop and aborts the whole cycle.
  biasLookback: Math.max(2, Math.round(num('BIAS_LOOKBACK', 8))),

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

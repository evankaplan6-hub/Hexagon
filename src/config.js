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
  // The fraction of makerCap at which the GROWING side is withdrawn. The hard cap is where a fill
  // is refused; this is where the desk stops inviting one. The live book carried 1,344 contracts
  // of net one-sided inventory across 33 markets against 3,590 filled, with the spread captured
  // on the 1,123 contracts that did round-trip at -$1.72 -- inventory was building, not turning
  // over. README rejected price SKEW as an overfit; this is withdrawal, the mechanism the desk
  // already uses at the cap, applied earlier.
  //
  // Replayed against the same 2.25 days of prints (tools/maker-replay.js), on top of the tail and
  // toxicity changes: 0.5 takes 30% off net one-sided inventory (1,643 to 1,152 contracts) and 17%
  // off at-touch fills, leaves run-over contracts where they were (2,102 to 2,161 -- a sweep runs
  // over the reducing side as readily as the growing one), and costs $6 of realized on a +$59
  // base. 0.25 costs $8, 0.75 costs $3. So this buys less inventory, not less run-over, and it is
  // not free; 1 switches it off.
  makerSoftCap: num('MAKER_SOFT_CAP', 0.5),
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
  // How many pages of the exchange-wide tape one poll may read before giving up and counting a
  // gap. One page is 1000 prints. At two-second polling the page should hold three times what is
  // needed, and still the first two days on the cloud box counted 145 polls where the oldest print
  // on the page was newer than the last one seen -- bursts, not the average rate. Every one of
  // those was a window in which a resting quote could have filled unseen, so the fill model and
  // fillcheck both undercounted. Five pages is thirty seconds of the whole exchange; a poll that
  // far behind has a bigger problem than pagination, and is still counted as a gap.
  makerTapePages: Math.max(1, Math.round(num('MAKER_TAPE_PAGES', 5))),
  // Read the exchange-wide tape over Kalshi's WebSocket trade channel instead of polling it
  // (src/kalshi-ws.js), where a key is configured -- the handshake has to be signed, so a box
  // without KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY_PATH polls exactly as before. The poll is
  // the fallback either way: any round the socket cannot vouch for is polled and paged back.
  // The key signs the handshake and nothing else; this is read-only market data in paper mode.
  makerStream: env('MAKER_STREAM', '1') !== '0',
  // Kalshi's AsyncAPI spec names external-api-ws.kalshi.com as the production socket; the REST
  // host also answers on the same path. Both were checked on 2026-09-12.
  kalshiWsUrl: env('KALSHI_WS_URL', 'wss://external-api-ws.kalshi.com/trade-api/ws/v2'),
  // The run-over toxicity gate. A run-over fill is one where the tape traded THROUGH a resting
  // quote -- we sold below the print, or bought above it -- and it is where this desk's money
  // went: over the first 2.25 days on the cloud box, 43% of fills and 59% of filled contracts were
  // run-over, costing $55.57 against the tape, on a book that captured -$1.72 of spread across
  // every round trip it completed. Requoting every 2s instead of every 30s only moved that share
  // from 69% to 59%, so latency is not the cause: some markets are simply ones whose touch gets
  // swept, and the only defence is to stop resting there. The gate measures it PER MARKET, as the
  // run-over share of the last 30 fills, and withdraws both quotes for a cooling period once it
  // passes the bar. 0.40 sits just under the live book-wide share, so it names the markets that
  // are worse than the book as a whole; 0.30 and 0.50 land within 2% of it on every number.
  //
  // Replayed against the same 2.25 days of Kalshi prints (tools/maker-replay.js) the gate trips
  // ten times, takes 10% off run-over FILLS, nothing off run-over CONTRACTS (2,075 to 2,102), and
  // adds $15 of realized on a +$44 base. The contracts it cannot reach are the sweeps -- one fill
  // of several hundred contracts -- which a fill-counted share barely registers. A share counted
  // in contracts is the obvious next thing to score; it is not what this is.
  makerMaxRunOver: num('MAKER_MAX_RUNOVER', 0.40),
  // Sixty minutes as planned. In the same replay 120 minutes took 9% off run-over contracts and
  // was $7 better on realized plus mark ($6 worse on realized alone), and 240 added nothing over
  // 120 -- one tape, so noted, not set.
  makerToxCooldownMin: num('MAKER_TOX_COOLDOWN_MIN', 60),
  // Fills before the share means anything. One run-over fill out of one is a 100% share, which
  // would cool every market on its first adverse print. 5, 10 and 15 replay within 2% of each
  // other on run-over contracts and within $4 on realized.
  makerToxMinFills: Math.max(1, Math.round(num('MAKER_TOX_MIN_FILLS', 10))),
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
  // A convergence trade is a bet that the THIN venue is the wrong one, and fair value only sits
  // near the thick venue when there is a thick venue. The desk's single largest taker loss was a
  // convergence trade on a Fed pair whose two venues carried near-equal volume: fair sat in the
  // middle, the realisable move was half the gap, and that was inside the 1c slip allowance.
  // Require the thick venue to carry this many times the thin venue's 24h volume, or the pair is
  // vetoed as `venues too even` and BRAM's gate ledger says so.
  convMinVolRatio: num('CONV_MIN_VOL_RATIO', 3),
  // A locked arb pays $1 a pair at resolution for free. Selling both legs early at their bids pays
  // bidSum a pair, minus a Kalshi taker fee on the Kalshi leg -- which the old `bidSum > 1.005`
  // test ignored, so the three early unwinds on the cloud box netted $1-3 where holding would have
  // netted $2-6. Unwind only when the gain over holding, net of the modelled exit fee, clears
  // this much per contract. 0.005 is the old threshold's margin, now applied after the fee.
  arbUnwindMargin: num('ARB_UNWIND_MARGIN', 0.005),
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
  // How long a pair is untouchable after an exit. Was hardcoded in KETT; it is a real knob now
  // because src/minds.js has to honour the same bar -- a mind that could re-enter a pair the
  // moment RIGO closed it would churn the book and pay the fee twice for one idea.
  reentryCooldownMs: num('REENTRY_COOLDOWN_MIN', 10) * 60000,

  // ---- the minds (src/brain.js, src/minds.js) ----
  // The seven desks reason with Claude. Off without a key: every desk falls back to the
  // deterministic path it had before, which is a complete trading system on its own.
  brainEnabled: env('BRAIN', '1') !== '0',
  // Two models, because the desks do two different jobs. BRAM prices and KETT executes -- those
  // turns decide whether money moves, and are worth the better model. Scanning, sentiment, ops,
  // settlement and making are summarising and noticing, which the cheaper model does well.
  //
  // Measured on a realistic 12-pair board: Opus ~$0.04-0.067/turn, Sonnet ~$0.013-0.030.
  brainModelDeep: env('BRAIN_MODEL_DEEP', 'claude-opus-5'),
  brainModelFast: env('BRAIN_MODEL_FAST', 'claude-sonnet-5'),
  brainDeepAgents: env('BRAIN_DEEP_AGENTS', 'BRAM,KETT').split(',').map((s) => s.trim()).filter(Boolean),
  // low | medium | high | xhigh | max.
  brainEffort: env('BRAIN_EFFORT', 'medium'),
  // THE COST RAIL. A hard ceiling on what the minds may spend in one Eastern day. When it is
  // reached the brain stops calling entirely and every desk falls back to its deterministic path
  // -- the desk keeps trading, it just stops reasoning out loud.
  //
  // This exists because the failure mode is not a slow leak, it is a stuck trigger: a condition
  // that evaluates true every cycle turns a $5 day into a $400 one overnight with nothing on the
  // dashboard to say so. Measured worst case at a 15s cycle is roughly $380/day PER DESK.
  brainDailyUsd: num('BRAIN_DAILY_USD', 1),
  // Floor between two turns for one desk, whatever its trigger says. The trigger decides IF a
  // turn is worth buying; this stops a flapping quote from buying the same turn ten times a
  // minute. Turns are event-driven, not scheduled -- there is deliberately no "every N seconds".
  brainMinGapSec: num('BRAIN_MIN_GAP_SEC', 45),
  // The gap at which a pair is worth an OPINION. Deliberately lower than minGap, which is the bar
  // for a trade: this repo's own tape says the widest pre-game gap across 17,649 non-in-play ticks
  // was 3.00c, so gating reasoning on minGap (3c) would leave the desks dormant for days. A cent
  // is where a pair stops being noise and starts being a thing a trader would look at twice.
  brainGapFloor: num('BRAIN_GAP_FLOOR', 0.01),
  brainTimeoutMs: num('BRAIN_TIMEOUT_MS', 90000),
  // Operator research (src/research.js): one deep dive when a person clicks "Research" on an
  // alert. Separate from the desks' paced budget because it only ever runs on a click, and a
  // person deciding whether to sell should not be told the desks spent the day's allowance.
  // Opus 5 with web search runs roughly $0.10-0.50 a report.
  researchEnabled: env('RESEARCH', '1') !== '0',
  researchModel: env('RESEARCH_MODEL', 'claude-opus-5'),
  researchDailyUsd: num('RESEARCH_DAILY_USD', 3),
  researchTimeoutMs: num('RESEARCH_TIMEOUT_MS', 240000),
  // Pairs per view. The whole board is usually 20-40 matched pairs; sending all of them every
  // cycle is mostly cost, since the tail never moves.
  brainPairs: Math.max(1, Math.round(num('BRAIN_PAIRS', 12))),
  // The floor under a mind-originated trade. `edge` is already net of the spread crossed both
  // ways and BOTH taker fees, so 0 is exact break-even -- a mind may take a thin trade on a
  // thesis, but never one that is arithmetically certain to lose. This is the one threshold in
  // the file a mind is not allowed to argue with.
  llmMinEdge: num('LLM_MIN_EDGE', 0),

  // Whale watch (src/whales.js): the top Polymarket sports wallets and what they just bought.
  // Advisory only -- it logs and records, it never trades. Read-only public data, no key.
  whaleWatch: env('WHALE_WATCH', '1') !== '0',
  whaleTop: Math.max(1, Math.round(num('WHALE_TOP', 25))),          // wallets followed, by profit
  whalePeriod: ['DAY', 'WEEK', 'MONTH', 'ALL'].includes(env('WHALE_PERIOD', 'MONTH')) ? env('WHALE_PERIOD', 'MONTH') : 'MONTH',
  whaleMinUsd: num('WHALE_MIN_USD', 10000),       // a wallet's net buying on one outcome that counts as a bet
  whaleWindowMin: num('WHALE_WINDOW_MIN', 360),   // ...summed over this trailing window
  whaleFreshMin: num('WHALE_FRESH_MIN', 20),      // older bets are noted as seen, not announced
  whaleEverySec: num('WHALE_EVERY_SEC', 15),
  whalePerPoll: Math.max(1, Math.round(num('WHALE_PER_POLL', 5))),  // wallets read per poll: 25 wallets every 75s
  whaleBoardMin: num('WHALE_BOARD_MIN', 30),      // leaderboard refresh

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

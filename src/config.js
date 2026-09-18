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
  // Any-market pairs are recorded on change plus this heartbeat (src/recorder.js says why).
  recordHeartbeatMin: num('RECORD_HEARTBEAT_MIN', 15),
  // The tape's emergency brake (src/recorder.js). When free space under dataDir falls below this,
  // the recorder deletes the OLDEST ticks-*.jsonl files -- never today's, never a journal -- until
  // it is back above. On the Fly box's 1GB volume the tape fills the disk in about two weeks, and
  // a full disk stops the journal too. The normal route off the box is the Mac's daily
  // tools/fly-pull.js, which deletes only what it has copied and verified; this fires only if that
  // has stopped running, so what it deletes may never have reached the Mac. 0 turns it off.
  // On by default only on a Fly machine (Fly sets FLY_MACHINE_ID in every one): on the Mac the
  // tapes under data/ exist nowhere else and no pull archives them, so there it stays off unless
  // TAPE_MIN_FREE_MB is set on purpose.
  tapeMinFreeMb: Math.max(0, num('TAPE_MIN_FREE_MB', process.env.FLY_MACHINE_ID ? 200 : 0)),
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
  // Where the candidate list comes from. 1: every fee-free market in the any-market crawl (which
  // runs anyway, so this costs no call of its own) -- 123 quotable markets across 73 series on
  // 2026-09-16 against 39 from MAKER_SERIES, all of which the crawl finds too. 0: the MAKER_SERIES
  // list only, one listing call each, which is also the automatic fallback whenever the crawl is
  // off, older than two DISCOVER_EVERY_MIN, or failed. Widening the POOL is not widening the BOOK:
  // MAKER_MARKETS still caps what is quoted, and the trade-rate probe still picks it.
  makerWiden: env('MAKER_WIDEN', '1') !== '0',
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
  // Minimum milliseconds between the starts of any two Kalshi REST calls (src/http.js makePacer).
  // 80ms is 12.5 calls a second: the taker's eleven-listing burst spreads over under a second, and
  // the maker's two calls a round still go first. The desk's steady load is under three a second,
  // so the line is almost always empty. If refused calls (TESS's "api errs/5m") persist, raise it;
  // 0 turns pacing off.
  kalshiGapMs: Math.max(0, num('KALSHI_GAP_MS', 80)),
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
  // Which share trips the gate: run-over FILLS (0, as replayed above) or run-over CONTRACTS (1).
  //
  // The live journal said the bad markets stay bad: across 12 markets with 50+ contracts on both
  // sides of 2026-09-12 12:00Z, a market's run-over share before and after correlated at 0.62, and
  // the worst third before ran 63% after against 40% for the rest. So the gate was re-scored on a
  // fresh tape (2026-09-10 → 09-15, 46 markets), days 10-12 and 13-14 separately, soft cap off as
  // on the box. realized + mark, change against the gate switched off:
  //
  //                           queue 0            queue 500
  //                         10-12   13-14      10-12   13-14
  //   fills,     60 min     +$13    -$2        +$2     +$0
  //   fills,    240 min     +$26    +$5        +$7     -$0
  //   fills,    720 min     +$28    +$3        +$7     -$0
  //   contracts, 60 min     +$11    +$9        +$1     -$0
  //   contracts,240 min     +$19   +$21        +$6     +$2
  //   contracts,720 min     +$9    +$14        +$16    +$2
  //
  // Counting contracts with a rest of 240 or 720 minutes are the only rows better in all four cells;
  // 240 is better in total (+$48 against +$41) and halves run-over cost on days 13-14 at queue 0 (-$79
  // to -$40), the setting that reproduces the live run-over count. Counting fills looks best on days
  // 10-12 and gives almost all of it back on 13-14. At queue 2000 the gate trips 1-4 times a period
  // and moves run-over cost by under $2. Both halves were looked at to pick the row, so it is a
  // choice, not an out-of-sample result. fly.toml turns it on for the box.
  makerToxByContracts: env('MAKER_TOX_BY_CONTRACTS', '0') === '1',
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
  // Unhedged convergence positions held at once. Locked arbs have their own limit below: this used
  // to count every LEG of everything, so on 2026-09-15 six hedged Fed arbs (two legs each, about
  // $1,000 of a $9,800 book) filled all twelve slots and the desk could take nothing else.
  maxOpenPositions: num('MAX_OPEN_POSITIONS', 12),
  // Locked arbs held at once, counted as arbs (one per pair of legs), not legs. Each is sized to
  // maxPositionPct of equity like any trade, so twelve is at most ~24% of the book, and it is hedged.
  maxArbGroups: num('MAX_ARB_GROUPS', 12),
  // ...of which at most this many may settle more than LONG_DAYS out. Outside games most arbs are
  // long: politics pairs settle in 2027-2028, and a book of them would be full for a year.
  maxLongArbGroups: num('MAX_LONG_ARB_GROUPS', 3),
  longDays: num('LONG_DAYS', 30),
  // The annualised return a locked arb must beat for the time its money is tied up (decide.arbReturn).
  // Above cash, deliberately: a 1c arb settling in 85 days is 4.3% a year, and the same 1c settling
  // tonight is the kind of trade this desk exists for. J.D. Vance 2028 crossed 2.46c after fees and
  // settles in 785 days -- 1.2% a year.
  arbMinApr: num('ARB_MIN_APR', 0.05),
  // Cycles a signal on an any-market pair must persist before KETT acts (15s each, so a minute).
  // LA mayor crossed 4c at 01:25Z on 2026-09-15 and was 0.8c three hours later; a one-cycle gap is
  // far more often a listing that has not caught up with its book.
  entryPersistCycles: Math.max(1, Math.round(num('ENTRY_PERSIST_CYCLES', 4))),
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
  minEdge: num('MIN_EDGE', 0.02),
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
  // A pair stops being tradeable this many minutes before its KALSHI market closes, and a
  // convergence position on it is flattened. Games already had a rule (2 minutes before start);
  // nothing else did. KXFEDDECISION-26SEP closes 2026-09-16 17:59Z, one minute before the 18:00Z
  // statement, while the Polymarket leg trades straight through it -- so a convergence position
  // could lose its Kalshi quote at 17:59 and ride the announcement on the Polymarket leg until max
  // hold. KXCPI closes 12:25Z for a 12:30Z print; the same shape. Close time is an ADDITIONAL rule
  // for games, never a replacement: Kalshi game markets close days after the game is played.
  closeGuardMin: num('CLOSE_GUARD_MIN', 60),
  exitGap: num('EXIT_GAP', 0.01),
  stopLoss: num('STOP_LOSS', 0.06),
  // Paper positions also use a percentage stop so a cheap contract cannot lose nearly all of
  // its value before the flat-dollar STOP_LOSS fires. The tighter of the two stops wins. Keep
  // this paper-only: changing a funded account's exits requires a separate live review.
  paperStopLossPct: num('PAPER_STOP_LOSS_PCT', 0.20),
  // Paper-only gain lock: once a directional position is meaningfully ahead, retain a runner
  // while protecting part of the peak. The engine applies this as a partial close; maker inventory
  // uses the same trigger to become reduce-only, avoiding a taker fee just to bank spread.
  gainLockTriggerPct: num('GAIN_LOCK_TRIGGER_PCT', 0.10),
  gainLockGivebackPct: num('GAIN_LOCK_GIVEBACK_PCT', 0.35),
  gainLockRetainPct: num('GAIN_LOCK_RETAIN_PCT', 0.50),
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
  reentryCooldownMs: num('REENTRY_COOLDOWN_MIN', 240) * 60000,

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
  // The Ask panel (src/ask.js): the operator types a question about the desk and Claude answers
  // from read-only tools -- positions, trades, the log, the journal, markets, the maker, whales,
  // settings and the docs. It can never trade or change anything. On by default, but it does
  // nothing without ANTHROPIC_API_KEY, and it only spends when someone asks.
  askEnabled: env('ASK', '1') !== '0',
  askModel: env('ASK_MODEL', 'claude-opus-5'),
  // low | medium | high | xhigh | max. Medium: the questions are lookups and short explanations,
  // and on Opus 5 medium is strong at a fraction of high's thinking.
  askEffort: env('ASK_EFFORT', 'medium'),
  // Its own cap per Eastern day, separate from the desks' and Research's, because it only runs
  // when a person asks. A ceiling: the most each call could cost is held before it goes out, a call
  // the day cannot cover is not made, and a restart adds the day's spend back up from the journal.
  askDailyUsd: num('ASK_DAILY_USD', 3),
  // Tool rounds per question. At the cap the model is told to answer with what it has, so a
  // question that keeps looking things up still ends with an answer, never a loop.
  askMaxRounds: Math.max(1, Math.round(num('ASK_MAX_ROUNDS', 8))),
  askTimeoutMs: num('ASK_TIMEOUT_MS', 240000),     // per API call, not per question; as RESEARCH_TIMEOUT_MS, since a timed-out call is charged its worst case with no answer
  // Pairs per view. The whole board is usually 20-40 matched pairs; sending all of them every
  // cycle is mostly cost, since the tail never moves.
  brainPairs: Math.max(1, Math.round(num('BRAIN_PAIRS', 12))),
  // The floor under a mind-originated trade. `edge` is already net of the spread crossed both
  // ways and BOTH taker fees, so 0 is exact break-even -- a mind may take a thin trade on a
  // thesis, but never one that is arithmetically certain to lose. This is the one threshold in
  // the file a mind is not allowed to argue with.
  llmMinEdge: num('LLM_MIN_EDGE', 0),

  // Whale watch (src/whales.js): the top Polymarket wallets on the chosen leaderboards and what they
  // just bought.
  // Advisory only -- it logs and records, it never trades. Read-only public data, no key.
  whaleWatch: env('WHALE_WATCH', '1') !== '0',
  // Polymarket leaderboards followed. Weather and mentions are off by default: their best wallets
  // made no $10K bet in a day and almost none at $1K. OVERALL is mostly the sports board again.
  whaleCategories: env('WHALE_CATEGORIES', 'SPORTS,POLITICS,ECONOMICS,CRYPTO,CULTURE,TECH,FINANCE').split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
  whaleTop: Math.max(1, Math.round(num('WHALE_TOP', 25))),          // sports wallets followed, by profit
  whaleTopOther: Math.max(1, Math.round(num('WHALE_TOP_OTHER', 10))), // wallets followed on each other board
  whalePeriod: ['DAY', 'WEEK', 'MONTH', 'ALL'].includes(env('WHALE_PERIOD', 'MONTH')) ? env('WHALE_PERIOD', 'MONTH') : 'MONTH',
  whaleMinUsd: num('WHALE_MIN_USD', 10000),       // a sports wallet's net buying on one outcome that counts as a bet
  whaleMinUsdOther: num('WHALE_MIN_USD_OTHER', 5000), // ...for a wallet on the other boards, which bet smaller
  whaleWindowMin: num('WHALE_WINDOW_MIN', 360),   // ...summed over this trailing window
  whaleFreshMin: num('WHALE_FRESH_MIN', 20),      // older bets are noted as seen, not announced
  whaleEverySec: num('WHALE_EVERY_SEC', 15),
  whalePerPoll: Math.max(1, Math.round(num('WHALE_PER_POLL', 5))),  // wallets read per poll: 25 wallets every 75s
  whaleBoardMin: num('WHALE_BOARD_MIN', 30),      // leaderboard refresh

  // fees
  // Polymarket's taker fee is read PER MARKET from its feeSchedule (src/venues/polymarket.js
  // feeRateOf): shares x rate x p x (1-p), rate 0.03-0.07 by category, 0 on geopolitics. This was
  // PM_TAKER_FEE, a flat rate per dollar of notional defaulting to 0 -- wrong in shape and, on 99% of
  // markets, wrong in level. What is left is the rate for a market that does not say, and it is the
  // highest category rate (crypto) so that not knowing can never make a trade look cheaper.
  pmFeeFallback: num('PM_FEE_FALLBACK', 0.07),
  ksFeeRate: num('KS_FEE_RATE', 0.07),

  // universe
  // The any-market scanner (src/anymarket.js): every category on both venues, not just the games and
  // Fed brackets below. Discovery crawls both venues every DISCOVER_EVERY_MIN off the 15s cycle
  // (~65 Kalshi calls, ~20 Polymarket), and every cycle reprices only the matched markets. A pair
  // trades only once its resolution rules are verified to match (src/rules.js); the rest are
  // priced and recorded as watch-only.
  anyMarkets: env('ANY_MARKETS', '1') !== '0',
  discoverEveryMin: Math.max(5, num('DISCOVER_EVERY_MIN', 20)),
  // Matched pairs kept and repriced. Each 100 costs one Kalshi call and half a Polymarket call a cycle.
  anyMaxPairs: Math.max(1, Math.round(num('ANY_MAX_PAIRS', 300))),
  // Everything on the desk shares one Kalshi rate limit, and the maker already spends most of it. On
  // the Fly box the day these shipped, the crawl's 65 pages back to back and a reprice of 150 pairs
  // every 15 seconds pushed refused calls from 3-8 to 25-38 per 5 minutes, and TESS halted new
  // trades on them again and again. So the crawl spaces its Kalshi pages DISCOVER_GAP_MS apart (a
  // crawl takes ~2 minutes instead of 25 seconds, which costs nothing), and matched pairs -- almost
  // all months from settling -- are repriced every ANY_REFRESH_SEC, inside MAX_DATA_AGE_SEC.
  discoverGapMs: Math.max(0, num('DISCOVER_GAP_MS', 1500)),
  anyRefreshSec: Math.max(15, num('ANY_REFRESH_SEC', 60)),
  // Polymarket events under this 24h volume are not crawled. $500 keeps ~1,200 events (every one
  // traded at least $1k on 2026-09-14 but a handful) and stops well inside Gamma's offset cap of 2,000.
  pmDiscoverMinVol: num('PM_DISCOVER_MIN_VOL', 500),
  // The rules gate's Claude check (src/rules.js): a matched pair with no verified rule family is
  // watch-only, and when one shows an edge its two rules texts can be put to Claude ONCE (the answer
  // is cached in DATA_DIR/rules-verdicts.jsonl, keyed by both texts). Nothing is asked without
  // ANTHROPIC_API_KEY; a Claude "same" never overrides a conflict the deterministic check found.
  rulesCheck: env('RULES_CHECK', '1') !== '0',
  rulesModel: env('RULES_MODEL', 'claude-opus-5'),
  rulesEffort: env('RULES_EFFORT', 'medium'),
  rulesDailyUsd: num('RULES_DAILY_USD', 1),
  rulesTimeoutMs: num('RULES_TIMEOUT_MS', 120000),
  pmUniverse: num('PM_UNIVERSE', 300),
  ksSeries: env('KS_SERIES', 'KXFEDDECISION,KXATPMATCH,KXWTAMATCH,KXMLBGAME,KXNFLGAME,KXNBAGAME,KXNCAAFGAME,KXMLSGAME,KXEPLGAME,KXUCLGAME,KXLALIGAGAME').split(',').map((s) => s.trim()).filter(Boolean),

  // live
  kalshiKeyId: env('KALSHI_API_KEY_ID', ''),
  kalshiKeyPath: env('KALSHI_PRIVATE_KEY_PATH', ''),
  liveConfirm: env('LIVE_CONFIRM', '') === 'I_UNDERSTAND_REAL_MONEY',
};

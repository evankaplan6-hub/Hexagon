'use strict';
// The rules gate: do two matched contracts resolve the same way?
//
// This is the whole safety case for trading outside games. A matched pair is only a "locked arb" if
// every real-world outcome settles both legs identically, and research on 2026-09-15 found that
// look-alike markets very often do not, while trading within a few cents of each other:
//   - Netanyahu out by 2026: Polymarket counts death ("ceases to be Prime Minister for any period of
//     time"); Kalshi KXLEADERSOUT says "Death does NOT satisfy the Payout Criterion". 0.525 vs 0.455.
//   - McConnell: Polymarket runs to the end of his term, any vacancy; KXRETIREMM ends before Election
//     Day and needs a voluntary exit. 0.11 vs 0.035.
//   - Temperature: identical brackets, different weather stations (LaGuardia vs Central Park). On Sep
//     14 Polymarket settled NYC 76-77F while Kalshi settled 74-75F.
//   - Every crypto price pair: Binance candles or Chainlink on Polymarket, CF Benchmarks on Kalshi.
// Of 76 politics pairs whose rules were read, 23 differed; 16 of 38 culture pairs; every crypto one.
//
// So each candidate gets a verdict, and only `same` trades:
//   1. DENYLIST   families verified to differ                          -> different
//   2. FEATURES   a rule dimension both texts speak on, and disagree   -> different
//   3. ALLOWLIST  families verified to match (and no feature conflict) -> same
//   4. otherwise                                                        -> unclear (watch-only)
// An `unclear` pair that shows an edge can be put to Claude once per pair of rules texts
// (makeRulesJudge), cached on disk. A Claude `same` is honoured only when step 2 finds nothing, and a
// Claude `different` is always honoured.
const fs = require('fs');
const path = require('path');

const low = (s) => String(s || '').toLowerCase();
const pmText = (c) => `${c.pm.description || ''}\n${c.pm.resolutionSource || ''}`;
const ksText = (c) => `${c.ks.rulesPrimary || ''}\n${c.ks.rulesSecondary || ''}`;
const pmTitle = (c) => `${c.pm.eventTitle || ''} | ${c.pm.question || ''} | ${c.pm.groupItemTitle || ''}`;

// ---------------------------------------------------------------- 1. denylist
// Each entry: Kalshi series prefix, optionally narrowed by the Polymarket title, and the evidence.
const DENY = [
  { ks: /^KX(HIGH|LOWT|RAIN)/, why: 'weather: Polymarket reads NOAA hourly station data (LaGuardia, O\'Hare), Kalshi the NWS daily climate report (Central Park, Midway); NYC split 76-77F vs 74-75F on 2026-09-14' },
  { ks: /^KX(BTC|ETH|SOL|XRP|DOGE|BNB|HYPE|SHIB|LTC|AVAX|LINK|ADA)/, why: 'crypto price: Polymarket settles on Binance candles or Chainlink, Kalshi on CF Benchmarks BRTI averages, often at a different time of day' },
  { ks: /^KX(INX|NASDAQ|DJI|RUT|WTI|BRENT|GOLD|SILVER|COPPER|NATGAS|EURUSD|USDJPY|GBPUSD|B200)/, why: 'index, commodity or FX price: Polymarket settles on Pyth/Yahoo/WSJ, Kalshi on its own index values or ICE settles' },
  { ks: /^KX(LEADERSOUT|TRUMPOUT|TRUMPADMINLEAVE|HEGSETHOUT|RETIREMM|DIAZOUT|WARSHOUT|LEAVEPOWELLGOV|TRYFIREPOWELL|DEMORAESOUT|G7LEADEROUT|CABOUT)/, why: 'leaving office: Kalshi excludes death or needs an actual departure where Polymarket counts an announcement or any vacancy (Netanyahu 0.525 vs 0.455, McConnell 0.11 vs 0.035)' },
  { ks: /^KX(RONI|HMONTHRANGE|MEASLES|RT-|TRUMPSAY|TRUMPMENTION|PAHLAVIHEAD|TOPMODEL|VENEZDEFACTO|REDISTRICTING|APRPOTUS|TRUMPAPPROVE)/, why: 'verified different: season window, inclusive vs strict thresholds, spoken vs written, formal vs actual power, eligibility window, or a different poll source' },
  { ks: /^(FEDHIKE|KXFEDHIKE|KXRECSSNBER|KXGDP|KXU3MAX|KXLCPIMAXYOY|KXAAAGAS|KXMORTGAGERATE|KXPAYROLLS|KXJOLTS|KXTRADEDEFICIT|KXTARIFFCHECKS|KXCANADAUSTARIFFLOWER|KXFEDCHGCOUNT)/, why: 'economics verified different: window ends at the meeting vs the date, an NBER leg on one side, bracket tie rules, or at-least vs above on a one-decimal series' },
  { ks: /^KX(IPO|ACQ|COMPANYACTION|TAKEOVER|TOKENLAUNCH|FDV)/, why: 'corporate events: Kalshi pays on an S-1 or a definitive agreement, Polymarket on trading or any announcement (Anthropic IPO 0.855 vs 0.775)' },
  { ks: /^KX(LLM1|CHINAAI)/, pm: /model/i, why: 'AI boards: Kalshi ranks companies, Polymarket ladders rank individual models' },
  { ks: /^KXPUTINZELENSKYYLOCATION/, why: 'window runs to 2028 on Kalshi against before 2027 on Polymarket' },
  { ks: /^KXTRILATERAL/, pm: /seen together/i, why: '"seen together" (a photo) is not "meet together" (one in-person meeting)' },
  { ks: /^KXCBD(ECISION)?(ISRAEL|RUSSIA|SA)\b/, pm: /\b(decrease|increase)\b/i, why: 'Polymarket\'s three-way Decrease/Increase spans two Kalshi buckets' },
];

// ---------------------------------------------------------------- 3. allowlist
// Verified same by reading both venues' full rules on 2026-09-15. The matcher has already required
// the same outcome (person, party, bracket, deadline); these say the settlement mechanics match too.
const ALLOW = [
  { ks: /^CONTROL[SH]-/, pm: /(senate|house)/i, why: 'chamber control: majority of voting seats on both, VP breaks a Senate tie' },
  { ks: /^(SENATE[A-Z]{2}|GOVPARTY[A-Z]{2}|HOUSE[A-Z]{2}\d+|KXHOUSERACE)-/, pm: /\b(democrat|republican)/i, why: 'party races: the winning party\'s nominee on both (Iowa Senate R 0.565 vs 0.615, same rules)' },
  { ks: /^KXBALANCEPOWERCOMBO-/, why: 'balance of power: Kalshi runs the two chamber-control rulesets' },
  { ks: /^KXPRESNOM[DR]-/, pm: /nominat/i, why: 'nominee: wins and accepts the nomination on both' },
  { ks: /^KXPRESPERSON-/, pm: /presidential election/i, why: 'next president: the person inaugurated for the 2029 term' },
  { ks: /^KXMAYORLA-/, why: 'LA mayor: the election winner, runoff included' },
  { ks: /^KXXIUSA-/, why: 'Xi visits the US: physical entry, same cutoff instant' },
  { ks: /^KXALIENS-/, why: 'aliens confirmed: identical wording, same deadline' },
  { ks: /^KXZELENSKYPUTIN-/, pm: /\b(talk|meet)\b/i, why: 'Zelenskyy-Putin: meetings include phone calls on both' },
  { ks: /^KXSATOSHIBTCYEAR-/, why: 'Satoshi coins: the same Arkham entity page on both' },
  { ks: /^KXSPACEXCOUNT-/, why: 'SpaceX launch count: whole launches, same month window (the matcher pairs N+ with Above N-1 only)' },
  { ks: /^KXTIME-/, why: 'TIME Person of the Year: named or pictured, all named resolve Yes on both' },
  { ks: /^KXTOPSONG-/, why: 'Billboard Hot 100 #1 for the dated chart week' },
  { ks: /^KXTOPARTIST-/, pm: /spotify|top artist/i, why: 'Spotify\'s most-streamed artist of the year (not the US chart)' },
  { ks: /^KX(BIGBROTHER|DANCINGWITHTHESTARS)-/, why: 'reality show winner of the named season' },
  { ks: /^KXARCTICICEMIN-/, why: 'Arctic sea ice minimum, same NSIDC figure' },
  { ks: /^KXFEDDECISION-/, why: 'Fed decision: change in the upper bound at the named meeting' },
  { ks: /^KXRATECUTCOUNT-/, why: 'Fed cuts in the year, counted in 25bp units on both' },
  { ks: /^KXFED-/, pm: /fed/i, why: 'upper bound of the fed funds target after the named meeting' },
  { ks: /^KXFOMCDISSENTCOUNT-/, pm: /dissent/i, why: 'dissenting votes at the meeting (0-3 map one to one)' },
  { ks: /^KXCBDECISION(ENGLAND|CANADA|AUSTRALIA|NZ|INDIA|KOREA)-/, why: 'central bank decision: the policy rate, moves rounded to 25bp on both' },
  { ks: /^KXCBDSWISS-/, why: 'SNB decision: the policy rate' },
  { ks: /^KXCBRATEHIKE-/, why: 'any hike before the year end, dated by announcement' },
  { ks: /^KX(CPIYOY|CPI|CPICORE|CPICOREYOY|PCECORE|USPPIYOY|U3|ISMPMI|HIGHINFLATION|ECONPATH)-/, why: 'official release to its published precision, first print, same statistic' },
  { ks: /^KXECONSTAT(CPIYOY|CPI|CPICORE|CORECPIYOY|U3)-/, why: 'exact value of the official release to one decimal' },
  { ks: /^KX(10|30)YRDIR(HM|LM)-/, why: 'Treasury daily par yield, any business day in the window (exact tick only)' },
];

// ---------------------------------------------------------------- 2. rule features
function has(re, s) { return re.test(s); }
function setOf(re, s) { return new Set((String(s).match(re) || []).map((x) => x.toLowerCase())); }
const disjoint = (a, b) => a.size && b.size && ![...a].some((x) => b.has(x));

// Features of one venue's rules text. Every field is null when the text does not speak to it, so a
// silent side is never read as a disagreement.
function ruleFeatures(text) {
  const t = String(text || '');
  const f = {};
  if (has(/death (does|will) not|excluding death|death[^.]{0,40}not (satisfy|count)|last (fair|traded) price/i, t)) f.death = 'excluded';
  else if (has(/for any period of time|ceases to (be|hold)|death[^.]{0,40}(count|resolve[^.]{0,20}yes)/i, t)) f.death = 'counts';
  const announce = has(/announce[^.]{0,80}(resign|depart|step|leav|retire|remov)|(resign|removal|departure)[^.]{0,40}announc[^.]{0,60}(resolve|count)|immediately resolve/i, t);
  const vacate = has(/actual departure|(vacate|vacates|vacating) (the|his|her|their) (role|office|seat|position)|must (actually )?(leave|depart|vacate)|departure date/i, t);
  if (announce && !vacate) f.trigger = 'announcement';
  else if (vacate && !announce) f.trigger = 'departure';
  if (has(/(acting|interim)[^.]{0,80}(will not|do not|does not|shall not|excluded|not count|not qualify)/i, t)) f.acting = 'excluded';
  else if (has(/(acting|interim)[^.]{0,80}(will count|counts|included|qualif|does count)/i, t)) f.acting = 'counts';
  if (has(/de facto|primarily exercises|exercises? [^.]{0,30}authority|actual(ly)? (hold|exercise)s? power/i, t)) f.power = 'de facto';
  else if (has(/officially (holds|recognized)|formally (appointed|named|designated)|official head of state/i, t)) f.power = 'official';
  // ICAO codes as written in prose (KLGA, CLINYC) and as they appear in a NOAA timeseries link (site=klga)
  const stations = new Set([...setOf(/\b(K[A-Z]{3}|CLI[A-Z]{3})\b/g, t), ...[...String(t).matchAll(/site=(k[a-z]{3})\b/gi)].map((m) => m[1].toLowerCase())]);
  if (stations.size) f.stations = stations;
  const price = setOf(/\b(binance|chainlink|cf benchmarks|brti|pyth|ice futures|coingecko|coinbase|yahoo finance|wall street journal|kraken)\b/gi, t);
  if (price.size) f.priceSources = price;
  const polls = setOf(/\b(realclearpolitics|silver bulletin|fivethirtyeight|538|nate silver)\b/gi, t);
  if (polls.size) f.pollSources = polls;
  if (has(/split (the )?payout|paid out equally|divided equally|1\/n/i, t)) f.ties = 'split';
  else if (has(/alphabetical|resolve to a single winner|precedence/i, t)) f.ties = 'single';
  if (has(/caucus/i, t)) f.caucus = true;
  if (has(/style control/i, t)) f.styleControl = has(/(remove|without|off)[^.]{0,20}style control|style control[^.]{0,10}(off|removed)/i, t) ? 'off' : 'on';
  return f;
}

// Where both sides speak on a dimension and disagree, one short reason each.
function featureConflicts(a, b) {
  const out = [];
  if (a.death && b.death && a.death !== b.death) out.push(`death ${a.death} on one venue, ${b.death} on the other`);
  if (a.trigger && b.trigger && a.trigger !== b.trigger) out.push(`resolves on ${a.trigger} on one venue, ${b.trigger} on the other`);
  if (a.acting && b.acting && a.acting !== b.acting) out.push(`acting or interim ${a.acting} on one venue, ${b.acting} on the other`);
  if (a.power && b.power && a.power !== b.power) out.push(`${a.power} power on one venue, ${b.power} on the other`);
  if (disjoint(a.stations || new Set(), b.stations || new Set())) out.push(`different weather stations (${[...a.stations].join(',')} vs ${[...b.stations].join(',')})`);
  if (disjoint(a.priceSources || new Set(), b.priceSources || new Set())) out.push(`different price sources (${[...a.priceSources].join(',')} vs ${[...b.priceSources].join(',')})`);
  if (disjoint(a.pollSources || new Set(), b.pollSources || new Set())) out.push(`different poll sources (${[...a.pollSources].join(',')} vs ${[...b.pollSources].join(',')})`);
  if (a.ties && b.ties && a.ties !== b.ties) out.push(`ties ${a.ties} on one venue, ${b.ties} on the other`);
  if (a.caucus !== b.caucus && (a.caucus || b.caucus) && (a.trigger || b.trigger || a.power || b.power)) out.push('caucus membership counts on one venue only');
  if (a.styleControl && b.styleControl && a.styleControl !== b.styleControl) out.push('leaderboard style control differs');
  return out;
}

function conflictsOf(c) {
  return featureConflicts(ruleFeatures(pmText(c)), ruleFeatures(ksText(c)));
}

function staticVerdict(c) {
  const series = String(c.ks.seriesTicker || c.series || c.ks.ticker || '');
  const ticker = String(c.ks.ticker || '');
  const title = pmTitle(c);
  for (const d of DENY) {
    if ((d.ks.test(series) || d.ks.test(ticker)) && (!d.pm || d.pm.test(title))) return { verdict: 'different', source: 'denylist', reason: d.why };
  }
  const conflicts = conflictsOf(c);
  if (conflicts.length) return { verdict: 'different', source: 'features', reason: conflicts.join('; ') };
  for (const a of ALLOW) {
    if (a.ks.test(ticker) && (!a.pm || a.pm.test(title))) return { verdict: 'same', source: 'allowlist', reason: a.why };
  }
  return { verdict: 'unclear', source: 'none', reason: 'no verified rule family for this pair' };
}

// ---------------------------------------------------------------- 4. the lazy Claude check
const API_URL = 'https://api.anthropic.com/v1/messages';
const PRICE = { 'claude-opus-5': { input: 5 / 1e6, output: 25 / 1e6 }, 'claude-sonnet-5': { input: 2 / 1e6, output: 10 / 1e6 } };
const priceOf = (m) => PRICE[m] || PRICE['claude-opus-5'];
const { ET_DAY } = require('./recorder');   // the Eastern day, one definition for every file that names one
const MAX_TOKENS = 2000;

const SYSTEM = `You compare the resolution rules of two prediction-market contracts, one on Polymarket and one on Kalshi, that a matcher believes are the same outcome. A trading desk will buy YES on one and NO on the other as a "locked" arbitrage, which only works if EVERY possible real-world outcome settles both contracts the same way.

Answer "same" only if you are confident that every resolvable outcome -- including edge cases -- settles both identically. Answer "different" if any of these differ in a way that could split them: the data source or measuring station, the time or timezone of a snapshot, the start or end of the window, inclusive vs strict thresholds, what triggers resolution (announcement vs actual event, agreement vs completion), how death, acting or interim holders, ties, joint winners, cancellations, delays or "Other" are handled, or which office, entity or chart is meant. Answer "unclear" if the texts do not say enough to decide.

Reply with JSON only, no prose and no code fences: {"verdict":"same"|"different"|"unclear","reasons":["short reason", ...]}`;

function parseVerdict(text) {
  const s = String(text || '');
  const m = s.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const j = JSON.parse(m[0]);
    if (!['same', 'different', 'unclear'].includes(j.verdict)) return null;
    return { verdict: j.verdict, reasons: (Array.isArray(j.reasons) ? j.reasons : []).map((r) => String(r).slice(0, 200)).slice(0, 5) };
  } catch { return null; }
}

// `post(body)` is the Messages API call (injected for tests); `appendFile`/`readFile` the cache's I/O.
function makeRulesJudge(cfg, { post = null, now = Date.now, readFile = (f) => fs.readFileSync(f, 'utf8'), appendFile = (f, s) => fs.appendFileSync(f, s) } = {}) {
  const key = String(process.env.ANTHROPIC_API_KEY || '').trim();
  const file = path.join(cfg.dataDir, 'rules-verdicts.jsonl');
  const cache = new Map();          // rulesKey -> { verdict, reasons }
  const spend = new Map();          // ET day -> dollars
  const inflight = new Set();
  let asked = 0, failed = 0;
  try {
    for (const line of readFile(file).split('\n')) {
      if (!line.trim()) continue;
      try {
        const r = JSON.parse(line);
        if (r.rulesKey && r.verdict) cache.set(r.rulesKey, { verdict: r.verdict, reasons: r.reasons || [] });
        if (Number.isFinite(r.costUsd) && r.at) { const d = ET_DAY.format(new Date(r.at)); spend.set(d, (spend.get(d) || 0) + r.costUsd); }
      } catch { /* a torn last line is skipped */ }
    }
  } catch { /* no cache yet */ }

  const doPost = post || (async (body) => {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), cfg.rulesTimeoutMs || 120000);
    try {
      const res = await fetch(API_URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' }, body: JSON.stringify(body), signal: ac.signal });
      const text = await res.text();
      if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 160)}`);
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  });

  const enabled = () => !!(cfg.rulesCheck && (key || post));
  const today = () => ET_DAY.format(new Date(now()));

  function verdictFor(c) { return cache.get(c.rulesKey) || null; }

  function request(c) {
    if (!enabled() || !c || !c.rulesKey || cache.has(c.rulesKey) || inflight.has(c.rulesKey)) return false;
    if (staticVerdict(c).verdict !== 'unclear') return false;   // never ask about a settled question
    const user = JSON.stringify({
      polymarket: { event: c.pm.eventTitle, question: c.pm.question, outcome: c.pm.groupItemTitle || null, rules: String(c.pm.description || ''), resolutionSource: c.pm.resolutionSource || null, endDate: c.pm.endDate || null },
      kalshi: { event: c.ks.eventTitle, title: c.ks.title, outcome: c.ks.yesSubTitle || c.ks.subTitle || null, rulesPrimary: c.ks.rulesPrimary || '', rulesSecondary: c.ks.rulesSecondary || '', closeTime: c.ks.closeTime || null },
    });
    // The most this call can cost, held against the day's allowance before it is made.
    const p = priceOf(cfg.rulesModel);
    const worst = ((SYSTEM.length + user.length) / 3) * p.input + MAX_TOKENS * p.output;
    if ((spend.get(today()) || 0) + worst > cfg.rulesDailyUsd) return false;
    inflight.add(c.rulesKey);
    asked++;
    const body = { model: cfg.rulesModel, max_tokens: MAX_TOKENS, output_config: { effort: cfg.rulesEffort || 'medium' }, system: SYSTEM, messages: [{ role: 'user', content: user }] };
    Promise.resolve().then(() => doPost(body)).then((res) => {
      const text = (res && Array.isArray(res.content) ? res.content : []).filter((b) => b.type === 'text').map((b) => b.text).join('');
      const u = (res && res.usage) || {};
      const cost = (u.input_tokens || 0) * p.input + (u.output_tokens || 0) * p.output;
      const d = today();
      spend.set(d, (spend.get(d) || 0) + cost);
      const v = parseVerdict(text) || { verdict: 'unclear', reasons: ['the reply could not be read'] };
      cache.set(c.rulesKey, v);
      try { appendFile(file, JSON.stringify({ rulesKey: c.rulesKey, pair: c.id, verdict: v.verdict, reasons: v.reasons, model: cfg.rulesModel, at: now(), costUsd: Math.round(cost * 1e6) / 1e6 }) + '\n'); } catch { /* cached in memory regardless */ }
    }).catch(() => { failed++; }).finally(() => inflight.delete(c.rulesKey));
    return true;
  }

  function snapshot() {
    let same = 0, different = 0, unclear = 0;
    for (const v of cache.values()) { if (v.verdict === 'same') same++; else if (v.verdict === 'different') different++; else unclear++; }
    return { enabled: enabled(), cached: cache.size, same, different, unclear, asked, failed, inflight: inflight.size, spentTodayUsd: Math.round((spend.get(today()) || 0) * 100) / 100, dailyUsd: cfg.rulesDailyUsd };
  }

  return { verdictFor, request, snapshot, enabled };
}

// Static first; a cached Claude answer only moves an `unclear`. Claude's `same` never overrides a
// feature conflict (those return `different` before the allowlist is reached, so an unclear pair has
// none), and its `different` or `unclear` stands.
function finalVerdict(c, judge) {
  const s = staticVerdict(c);
  if (s.verdict !== 'unclear' || !judge) return s;
  const j = judge.verdictFor(c);
  if (!j) return s;
  return { verdict: j.verdict, source: 'claude', reason: (j.reasons || []).join('; ').slice(0, 240) || `Claude: ${j.verdict}` };
}

module.exports = { ruleFeatures, featureConflicts, staticVerdict, finalVerdict, makeRulesJudge, parseVerdict, DENY, ALLOW };

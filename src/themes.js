'use strict';
// What a market is ABOUT, in the words a person would use for it: MLB, UFC, Elections, Weather.
//
// Neither venue answers this on its own. Kalshi's category is one of twenty broad buckets, and
// "Sports" covers 3,697 of its 14,170 series -- every baseball game, every fight, every golf major
// under one word, which is no use to someone who wants to look at the baseball. The league lives in
// the SERIES ticker instead (KXMLBGAME, KXUFCFIGHT, KXNFLGAME), and that is what this reads first.
// The category is the better answer for everything that is not a sport: Elections, Climate and
// Weather, Crypto and the rest are already the word you would say.
//
// A ticker prefix on its own is not enough, because Kalshi's tickers collide: KXNFLXAPP is Netflix
// app downloads, KXWTAX is a wealth tax, KXBOXOFFICE is a film, KXUSOPENAIANTH is a stake in
// OpenAI, KXPGAAWARDS is the Producers Guild, KXLIVENATIONUS is Live Nation, and KXFEDERALCHARGE
// is a criminal charge. Every one of them matches a league or Fed prefix and none of them is what
// it looks like. So a ticker rule also names the categories it is allowed in (`in`), and an
// unknown category -- which is what a game pair from src/matcher.js carries -- is always allowed.
// Measured over all 14,170 Kalshi series on 2026-09-20: this leaves the 35 collisions classified
// by what Kalshi says they are, not by what their first six letters look like.
//
// Pure: records in, a theme key out. No I/O, no clock, no venue calls.

// Order is priority: the first rule that matches wins, so the league rules sit above the broad
// `sports` bucket that would otherwise swallow them. `ks` matches the Kalshi SERIES ticker
// (KXMLBGAME, not KXMLBGAME-26SEP08COLNYY); `cats` matches the Kalshi category outright.
const THEMES = [
  { key: 'mlb', name: 'MLB', glyph: '⚾', ks: /^KX(MLB|WORLDSERIES|ALCS|NLCS|ALDS|NLDS)/, in: ['Sports'] },
  { key: 'nfl', name: 'NFL', glyph: '🏈', ks: /^KX(NFL|SUPERBOWL)/, in: ['Sports'] },
  { key: 'ncaaf', name: 'College football', glyph: '🏈', ks: /^KX(NCAAF|CFP|HEISMAN)/, in: ['Sports'] },
  { key: 'nba', name: 'NBA', glyph: '🏀', ks: /^KX(NBA|WNBA)/, in: ['Sports'] },
  { key: 'ncaab', name: 'College basketball', glyph: '🏀', ks: /^KX(NCAA[MW]?B|MARMAD)/, in: ['Sports'] },
  { key: 'nhl', name: 'NHL', glyph: '🏒', ks: /^KX(NHL|STANLEYCUP)/, in: ['Sports'] },
  // Fights. UFC and boxing are listed on both venues and settle on one unambiguous result, which is
  // the reason the crawl was opened to sports at all (see src/config.js discoverExcludeKs).
  { key: 'ufc', name: 'UFC & boxing', glyph: '🥊', ks: /^KX(UFC|MMA|BOXING)/, in: ['Sports'] },
  { key: 'soccer', name: 'Soccer', glyph: '⚽', ks: /^KX(EPL|UCL|UEFA|LALIGA|MLS|SERIE[AC]|BUNDES|LIGUE1|LIGAMX|LIGAPO|PREMIERLEAGUE|CLUBWC|CONMEB|CONCACAF|EREDIV|WCTEAM|WORLDCUP|FIFA|COPA|COUPED|COPPAI|DFBPOK|EFL|SOCCER|BALLONDOR|SAUDIP|JLEAGU|KLEAGU|BRASIL|SCOTTI|FRASUP|ITASUP|ESPSUP|INTLFR|TACAPO|FINALI|SIXNATIONS)/, in: ['Sports'] },
  { key: 'tennis', name: 'Tennis', glyph: '🎾', ks: /^KX(ATP|WTA|USOPEN|WIMBLEDON|AUSOPEN|FRENCHOPEN|DAVISCUP|LAVERCUP|TENNIS)/, in: ['Sports'] },
  { key: 'golf', name: 'Golf', glyph: '⛳', ks: /^KX(PGA|LIV|MASTERS|RYDER|GOLF)/, in: ['Sports'] },
  { key: 'racing', name: 'Motorsport', glyph: '🏁', ks: /^KX(F1|NASCAR|INDY|MOTOGP)/, in: ['Sports'] },
  // The Fed is an Economics series, but the desk has traded it since its first day and it is the one
  // economic question anybody names by itself. Only the rate-policy series: KXFEDCHAIRNOM is a
  // nomination and belongs with Politics, KXFEDMENTION with Mentions.
  { key: 'fed', name: 'Fed', glyph: '🏦', ks: /^KX(FED(DECISION|FUNDS|RATE|HIKE|CUT|CHG|COMBO|DISSENT|MEET|FACILITY|FREQ)?$|FED(DECISION|FUNDS|RATE|HIKE|CUT|CHG|COMBO)|FOMC)/, in: ['Economics'] },
  { key: 'sports', name: 'Other sports', glyph: '🏅', cats: ['Sports'] },
  { key: 'elections', name: 'Elections', glyph: '🗳️', cats: ['Elections'] },
  { key: 'politics', name: 'Politics', glyph: '🏛️', cats: ['Politics', 'World', 'Social'] },
  { key: 'weather', name: 'Weather', glyph: '🌦️', cats: ['Climate and Weather'] },
  { key: 'crypto', name: 'Crypto', glyph: '🪙', cats: ['Crypto'] },
  { key: 'economics', name: 'Economics', glyph: '📊', cats: ['Economics', 'Financials', 'Commodities', 'Companies', 'Business'] },
  { key: 'culture', name: 'Culture', glyph: '🎬', cats: ['Entertainment', 'Exotics'] },
  { key: 'tech', name: 'Tech & science', glyph: '🔬', cats: ['Science and Technology', 'AI', 'Education'] },
  { key: 'mentions', name: 'Mentions', glyph: '💬', cats: ['Mentions'] },
  { key: 'health', name: 'Health', glyph: '🏥', cats: ['Health'] },
  { key: 'transport', name: 'Transport', glyph: '✈️', cats: ['Transportation'] },
  // Nothing matched. Never hidden: a market with no theme is still a market the desk is watching,
  // and a bucket that quietly dropped them would make the counts lie.
  { key: 'other', name: 'Other', glyph: '🗂️' },
];
const BY_KEY = new Map(THEMES.map((t) => [t.key, t]));
const ORDER = new Map(THEMES.map((t, i) => [t.key, i]));

// "KXMLBGAME-26SEP081905COLNYY" -> "KXMLBGAME". Kalshi's own convention, and the same split
// src/matcher.js uses when it stamps a pair's series.
const seriesOf = (ticker) => String(ticker || '').split('-')[0];

// A pair id is "<polymarketId>:<tokenIndex>|<kalshiTicker>" everywhere one is built (matcher.js and
// match-any.js), so a position that carries only its pair id can still say what it is about.
const tickerOfPairId = (id) => { const s = String(id || ''); const i = s.indexOf('|'); return i < 0 ? '' : s.slice(i + 1); };

// { series, ticker, category } -> theme key. `series` wins; `ticker` supplies it when absent.
function themeOf(m) {
  if (!m) return 'other';
  const ser = String(m.series || seriesOf(m.ticker) || '').toUpperCase();
  const cat = m.category == null ? '' : String(m.category);
  for (const t of THEMES) {
    // An unknown category never blocks a ticker rule: a game pair from the fast path has no
    // category at all, and KXMLBGAME is not ambiguous.
    if (ser && t.ks && t.ks.test(ser) && (!t.in || !cat || t.in.includes(cat))) return t.key;
    if (cat && t.cats && t.cats.includes(cat)) return t.key;
  }
  return 'other';
}

const themeOfPairId = (id, category) => themeOf({ ticker: tickerOfPairId(id), category });
const themeMeta = (key) => BY_KEY.get(key) || BY_KEY.get('other');

// Where a theme sits in the list above, for ordering a bar whose main sort is how many markets
// each theme has. Two themes with the same count then come out in a fixed order rather than
// whichever one the Map happened to see first.
const themeRank = (key) => (ORDER.has(key) ? ORDER.get(key) : THEMES.length);

module.exports = { THEMES, themeOf, themeOfPairId, themeMeta, themeRank, seriesOf, tickerOfPairId };

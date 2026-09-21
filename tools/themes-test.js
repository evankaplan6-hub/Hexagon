'use strict';
// What a market is about, and the dashboard filter built on it.
//
// Two halves. The first is src/themes.js itself, which is pure: a Kalshi series ticker and category
// in, one word out. Most of these cases are real series taken from Kalshi's own /series listing on
// 2026-09-20, and the ones that matter most are the collisions -- KXNFLXAPP is Netflix, KXWTAX is a
// wealth tax, KXBOXOFFICE is a film. A classifier that reads the first six letters and stops gets
// every one of them wrong, so each is pinned here by name.
//
// The second is a static contract for the page. The filter is only worth having if it is actually
// applied, and "applied" is spread across six places in public/app.js -- the book, the fills, the
// status board, the feed, the phone card and the market list. Losing one of those is silent in the
// source and invisible on a quiet desk, so each is asserted by the line that does it.
//
//   node tools/themes-test.js
const fs = require('fs');
const path = require('path');
const { THEMES, themeOf, themeOfPairId, themeMeta, themeRank, seriesOf, tickerOfPairId } = require('../src/themes');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const eq = (name, got, want) => ok(`${name}\n        want: ${JSON.stringify(want)}`, got === want, got);
const group = (n) => console.log(`\n${n}`);

// ---- the leagues, from the series ticker --------------------------------------------------------
group('a league is read off the Kalshi series, not the category');
const league = [
  ['KXMLBGAME', 'Sports', 'mlb'],
  ['KXNFLGAME', 'Sports', 'nfl'],
  ['KXNBAGAME', 'Sports', 'nba'],
  ['KXNHLGAME', 'Sports', 'nhl'],
  ['KXNCAAFGAME', 'Sports', 'ncaaf'],
  ['KXNCAAMBGAME', 'Sports', 'ncaab'],
  ['KXUFCFIGHT', 'Sports', 'ufc'],
  ['KXBOXINGFIGHT', 'Sports', 'ufc'],
  ['KXMMAFIGHT', 'Sports', 'ufc'],
  ['KXEPLGAME', 'Sports', 'soccer'],
  ['KXUCLGAME', 'Sports', 'soccer'],
  ['KXLALIGAGAME', 'Sports', 'soccer'],
  ['KXMLSGAME', 'Sports', 'soccer'],
  ['KXATPMATCH', 'Sports', 'tennis'],
  ['KXWTAMATCH', 'Sports', 'tennis'],
  ['KXPGAMAJOR', 'Sports', 'golf'],
  ['KXLIVH2H', 'Sports', 'golf'],
  ['KXF1RACE', 'Sports', 'racing'],
  ['KXNASCARRACE', 'Sports', 'racing'],
  // a sport with no rule of its own still lands somewhere a person would look
  ['KXNCAAHOCKEYGAME', 'Sports', 'sports'],
  ['KXSSHIELDMATCH', 'Sports', 'sports'],
];
for (const [ser, cat, want] of league) eq(`${ser} is ${want}`, themeOf({ series: ser, category: cat }), want);

group('the fast path stamps no category, and a game still knows its league');
// src/matcher.js builds game and Fed pairs without ever reading a category. Every one of them has
// to classify on the ticker alone or half the board lands in Other.
for (const [ser, , want] of league.filter(([, , w]) => w !== 'sports')) {
  eq(`${ser} with no category is still ${want}`, themeOf({ series: ser }), want);
}
eq('a Fed pair with no category is the Fed', themeOf({ series: 'KXFEDDECISION' }), 'fed');

group('the series comes out of a full market ticker when it is not given');
eq('KXMLBGAME-26SEP081905COLNYY', themeOf({ ticker: 'KXMLBGAME-26SEP081905COLNYY' }), 'mlb');
eq('KXUFCFIGHT-26SEP20VANPAN-PAN', themeOf({ ticker: 'KXUFCFIGHT-26SEP20VANPAN-PAN' }), 'ufc');
eq('seriesOf splits at the first hyphen', seriesOf('KXMLBGAME-26SEP08COLNYY'), 'KXMLBGAME');
eq('seriesOf on a bare series is that series', seriesOf('KXMLBGAME'), 'KXMLBGAME');
eq('seriesOf on nothing is empty', seriesOf(null), '');

// ---- the collisions -----------------------------------------------------------------------------
// Every one of these matches a league or Fed prefix and is not that thing. The category is what
// settles it, which is the whole reason a ticker rule carries the categories it is allowed in.
group('a ticker that looks like a league but is not');
const collisions = [
  ['KXNFLXAPP', 'Financials', 'economics', 'Netflix app downloads'],
  ['KXNFLXINCREASE', 'Financials', 'economics', 'Netflix price increase'],
  ['KXWTAX', 'Politics', 'politics', 'wealth tax'],
  ['KXBOXOFFICE', 'Entertainment', 'culture', 'a film, not a fight'],
  ['KXUSOPENAIANTH', 'Politics', 'politics', 'a stake in OpenAI, not the US Open'],
  ['KXUSOPENPRICE', 'Financials', 'economics', 'US Open ticket prices'],
  ['KXPGAAWARDS', 'Entertainment', 'culture', 'the Producers Guild, not the PGA'],
  ['KXLIVENATIONUS', 'Companies', 'economics', 'Live Nation, not LIV Golf'],
  ['KXMLBMENTION', 'Mentions', 'mentions', 'what the announcers say'],
  ['KXNFLMENTION', 'Mentions', 'mentions', 'what the announcers say'],
  ['KXSUPERBOWLHEADLINE', 'Entertainment', 'culture', 'the halftime act'],
  ['KXFEDERALCHARGE', 'Politics', 'politics', 'a criminal charge, not the Fed'],
  ['KXFEDCHAIRNOM', 'Politics', 'politics', 'a nomination, not a rate decision'],
  ['KXFEDMENTION', 'Mentions', 'mentions', 'what was said about the Fed'],
  ['KXFEDEMPLOYEES', 'Economics', 'economics', 'the federal headcount, not the rate'],
];
for (const [ser, cat, want, why] of collisions) eq(`${ser} is ${want} (${why})`, themeOf({ series: ser, category: cat }), want);

group('the rate-policy series are the Fed');
for (const ser of ['KXFED', 'KXFEDDECISION', 'KXFEDFUNDSYEAR', 'KXFEDRATEMIN', 'KXFEDHIKE', 'KXFEDCHGCOUNT', 'KXFOMCGUIDE']) {
  eq(`${ser} is the Fed`, themeOf({ series: ser, category: 'Economics' }), 'fed');
}

// ---- everything that is not a sport -------------------------------------------------------------
group('outside sport the category is already the word a person would use');
const byCat = [
  ['Elections', 'elections'], ['Politics', 'politics'], ['World', 'politics'], ['Social', 'politics'],
  ['Climate and Weather', 'weather'], ['Crypto', 'crypto'], ['Economics', 'economics'],
  ['Financials', 'economics'], ['Commodities', 'economics'], ['Companies', 'economics'],
  ['Entertainment', 'culture'], ['Science and Technology', 'tech'], ['AI', 'tech'],
  ['Mentions', 'mentions'], ['Health', 'health'], ['Transportation', 'transport'], ['Sports', 'sports'],
];
for (const [cat, want] of byCat) eq(`${cat} is ${want}`, themeOf({ series: 'SENATETX', category: cat }), want);
eq('a weather market by ticker and category', themeOf({ ticker: 'KXHIGHNY-26SEP20-B82', category: 'Climate and Weather' }), 'weather');

group('nothing known is Other, and Other is never an error');
eq('an unknown category', themeOf({ series: 'WHATEVER', category: 'Nonesuch' }), 'other');
eq('nothing at all', themeOf({}), 'other');
eq('null', themeOf(null), 'other');
eq('undefined', themeOf(undefined), 'other');
eq('an unknown theme still has a name', themeMeta('nonesuch').key, 'other');

// ---- pair ids -----------------------------------------------------------------------------------
// A position carries its pair id and nothing else, and a pair id is built the same way in both
// matchers: "<polymarketId>:<tokenIndex>|<kalshiTicker>".
group('a position knows its subject from its pair id alone');
eq('a UFC pair id', themeOfPairId('562828:0|KXUFCFIGHT-26SEP20VANPAN-PAN'), 'ufc');
eq('an MLB pair id', themeOfPairId('12345:1|KXMLBGAME-26SEP081905COLNYY'), 'mlb');
eq('a weather pair id needs its category', themeOfPairId('9:0|KXHIGHNY-26SEP20-B82', 'Climate and Weather'), 'weather');
eq('a pair id with no Kalshi half', themeOfPairId('12345:1'), 'other');
eq('an empty pair id', themeOfPairId(''), 'other');
eq('tickerOfPairId keeps every hyphen in the ticker', tickerOfPairId('1:0|KXUFCFIGHT-26SEP20VANPAN-PAN'), 'KXUFCFIGHT-26SEP20VANPAN-PAN');
eq('tickerOfPairId on a string with no bar', tickerOfPairId('nope'), '');

// ---- the table itself ---------------------------------------------------------------------------
group('the theme table is well formed');
{
  const keys = THEMES.map((t) => t.key);
  ok('every key is unique', new Set(keys).size === keys.length, keys.length - new Set(keys).size);
  ok('every theme has a name and a glyph', THEMES.every((t) => t.name && t.glyph));
  ok('the last theme is the catch-all and matches nothing itself', THEMES[THEMES.length - 1].key === 'other' && !THEMES[THEMES.length - 1].ks && !THEMES[THEMES.length - 1].cats);
  ok('every theme but the catch-all matches on something', THEMES.slice(0, -1).every((t) => t.ks || t.cats));
  ok('the leagues are ranked above the broad sports bucket', THEMES.findIndex((t) => t.key === 'mlb') < THEMES.findIndex((t) => t.key === 'sports'));
  ok('every ticker rule names the categories it is allowed in', THEMES.filter((t) => t.ks).every((t) => Array.isArray(t.in) && t.in.length));
  ok('ranks are in table order', themeRank('mlb') === 0 && themeRank('other') === THEMES.length - 1);
  ok('an unknown key ranks last', themeRank('nonesuch') === THEMES.length);
}

// ---- which log lines are about one market -------------------------------------------------------
// The desk narrates itself in sentences, and the filter has to tell "this is about the baseball"
// from "this is about the whole desk, and mentions the baseball at the end". Getting that wrong in
// the loose direction hides a summary the desk meant everyone to read, so the rule is about WHERE
// the name sits, not whether it appears at all.
group('a log line is about a market only when it leads with one');
{
  const { Engine } = require('../src/engine');
  const E = Object.create(Engine.prototype);
  E.pairs = [
    { id: '1:0|KXNFLGAME-26SEP20WASDAL', label: 'NFL Commanders v Cowboys · Commanders', series: 'KXNFLGAME' },
    { id: '2:0|KXPRESPERSON-28', label: 'Republican Presidential Nominee 2028 - J.D. Vance', series: 'KXPRESPERSON', category: 'Elections' },
  ];
  E.state = { maker: { markets: { 'KXNFLLASTTOLOSE-26-KC': { series: 'KXNFLLASTTOLOSE', title: 'Last undefeated team, 2026-27 Pro Football', sub: 'Kansas City' } } } };
  const line = (text, refs) => Engine.prototype.lineTheme.call(E, text, refs);
  eq('a line that opens with the market', line('NFL Commanders v Cowboys · Commanders: PM +2.5c, KS +5.5c over 1m'), 'nfl');
  eq('a gap notice, where the market hangs off the @', line('venue gap 5.7c: Polymarket over Kalshi @ Republican Presidential Nominee 2028 - J.D. Vance · PM 0.50/0.52'), 'elections');
  eq("a maker market's own title", line('Last undefeated team, 2026-27 Pro Football: quoting both sides'), 'nfl');
  eq('a position named in the refs rather than the words', line('holding to settlement', [{ label: 'NFL Commanders v Cowboys · Commanders' }]), 'nfl');
  // the one that matters: HOLT's scan summary ends by naming the newest pair it found
  eq('a desk-wide summary that happens to name a market is not about it', line('313 pairs live (137 elections, 114 sports) · +15 new: NFL Commanders v Cowboys · Commanders'), null);
  eq('a desk-wide all-clear', line('All clear: prices are fresh, account +0.21% today'), null);
  eq('a desk-wide gate ledger', line('gate ledger over 313 pairs · 206 rules unclear'), null);
  eq('no text at all', line(''), null);
  eq('a name too short to be one', line('KC: something'), null);
}

// ---- the page actually applies it ---------------------------------------------------------------
// Static, because the alternative is a browser. Each assertion names the one line that does the
// filtering somewhere on the page: a marker-to-marker edit that swallows one of them leaves the
// button working, the count right, and the board it is meant to narrow showing everything.
group('the dashboard applies the filter everywhere a market is shown');
const root = path.join(__dirname, '..');
const app = fs.readFileSync(path.join(root, 'public/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'public/index.html'), 'utf8');
const css = fs.readFileSync(path.join(root, 'public/style.css'), 'utf8');
const engine = fs.readFileSync(path.join(root, 'src/engine.js'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server.js'), 'utf8');

ok('the bar and the market list have somewhere to render', /id="themebar"/.test(html) && /id="marketlist"/.test(html) && /data-tab="markets"/.test(html));
ok('the bar is built from the desk\'s own counts, never a fixed list', /S\.themes/.test(app) && !/const THEMES/.test(app));
ok('the fills board is filtered', /\.filter\(inTheme\)\.sort\(\(a, b\) => b\.at - a\.at\)/.test(app));
ok('the book on the wall is filtered, maker and cross-venue both', /m\.inv && inTheme\(m\)/.test(app) && /takerRows\(\)\.filter\(inTheme\)/.test(app));
ok('the status board picks its widest gap inside the theme', /const tr = theme \? themeRow\(\) : null;/.test(app) && /const closest = widestOf\(\(p\) => p\.tradeable\);/.test(app));
ok('a themed board that is all watch-only says so instead of "nothing is priced"', /none tradeable: their venues' rules are unverified/.test(app));
ok('the signals count is filtered', /\(S\.signals \|\| \[\]\)\.filter\(inTheme\)/.test(app));
ok('the feed and the bubbles over the floor are filtered', /if \(!feedKeeps\(e\)\) \{ hidden\+\+; continue; \}/.test(app) && /!seenKeys\.has\(logKey\(e\)\) && feedKeeps\(e\)/.test(app));
ok('a line that names no market is never hidden by a filter', /const feedKeeps = \(e\) => !theme \|\| !e\.theme \|\| e\.theme === theme;/.test(app));
ok('the page does not classify anything itself: the desk stamps each line as it writes it', /lineTheme\(text, refs\)/.test(engine) && /if \(theme\) entry\.theme = theme;/.test(engine));
ok('a line is classified once, at write time, not on every snapshot', engine.indexOf('lineTheme(text, refs)') < engine.indexOf('snapshot() {'));
ok('the phone card is filtered', /m\.quoting && inTheme\(m\)/.test(app));
ok('an unstamped market is only ever hidden by a filter, never by default', /const inTheme = \(x\) => !theme \|\| \(x && x\.theme\) === theme;/.test(app));
ok('the feed says how many lines the filter took out', /other line\$\{hidden === 1 \? '' : 's'\} hidden/.test(app));
ok('the choice survives a reload, and so does the word for it', /localStorage\.setItem\(THEME_KEY, JSON\.stringify\(\{ key, name/.test(app) && /localStorage\.getItem\(THEME_KEY\)/.test(app));
ok('a theme whose last market has gone keeps its chip, so the filter can be turned off', /const gone = theme && !rows\.some\(\(t\) => t\.key === theme\)/.test(app));
ok('a filter change invalidates every board cache', /statusHtml = ''; wallKey = ''; tapeKey = ''; tapeHtml = ''; feedHead = '';/.test(app));
ok('the market list is fetched rather than streamed', /fetch\(`\/api\/markets\?theme=/.test(app));
// The bar is counted over every pair, but the stream must not start CARRYING every pair: the box
// pushes this object to every open dashboard every two seconds.
ok('the stream still sends only the forty widest gaps', /pairs: pairs\.slice\(0, 40\)/.test(engine));
ok('an answer for a theme the user has moved off is thrown away', /if \(markets\.want !== want\) return;/.test(app));
ok('nothing is fetched while the tab is shut', /if \(markets\.tab !== 'markets'\) return;/.test(app));
ok('a repricing list keeps its scroll: three hundred markets is a list somebody scrolls', /const top = el\.scrollTop;[\s\S]{0,120}el\.scrollTop = top;/.test(app));
ok('the theme bar has styles of its own', /#themebar \.th/.test(css) && /#marketlist \.mlist/.test(css));

group('the server stamps a theme on everything the page can filter');
for (const what of ['theme: this.themeFor(p), inPlay', 'theme: this.themeFor(p), venue', 'theme: this.themeFor(x.pair)', 'theme: this.themeFor(m)', 'theme: this.themeFor(f)']) {
  ok(`snapshot carries ${what.split(',')[0]}`, engine.includes(what));
}
ok('the theme bar counts every pair, not the forty that are sent', /for \(const p of this\.pairs\) \{\n\s+const r = themeRow\(this\.themeFor\(p\)\);\n\s+r\.watching\+\+; r\.n\+\+;/.test(engine));
ok('held is counted once per position group, not once per leg', /new Map\(s\.positions\.map\(\(p\) => \[p\.group \|\| p\.id, p\]\)\)/.test(engine));
ok('the maker book is counted into the same bar', /r\.n\+\+; r\.making\+\+/.test(engine));
ok('each theme carries its own widest gap, so a quiet subject is not judged by the top forty', /r\.priced\+\+;/.test(engine) && /pairScore\(p, gap\) > r\.best\.score/.test(engine));
ok('a pair the desk could act on outranks a wider one it may not', /const pairScore = \(p, gap\) => \(p\.watchOnly \? 0 : 1e6\)/.test(engine));
ok('/api/markets exists and reads every pair', /p === '\/api\/markets'/.test(server) && /engine\.pairs/.test(server));
ok('/api/markets is read-only: no trade, no sell, no state change', !/sellGroup|openPosition|engine\.state\.positions\s*=/.test(server.slice(server.indexOf("'/api/markets'"), server.indexOf("'/api/trades'"))));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

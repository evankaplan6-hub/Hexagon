'use strict';
// Static contract for the floor at / (public/desk.*): since 2026-11-11 five views of the whole Hexagon: Today, one for
// each of its three parts (Crypto & SPY, Games, Arbs & maker), and Activity. Every view has its link and its panel and only Today shows at load, no element's id is a
// view's name (a link to #games would otherwise scroll to it), every element desk.js reads is in desk.html, the old
// links land, the page only reads, everything with more behind it opens it, and on a phone the views are a tab bar
// at the foot of the screen. tools/tokens-test.js holds the colours, the type floor and the app icons.
const fs = require('fs'), path = require('path');
let pass = 0, fail = 0;
const ok = (n, c, got) => { if (c) pass++; else { fail++; console.log(`  FAIL  ${n}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`); } };
const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');
const html = read('public/desk.html'), js = read('public/desk.js'), css = read('public/desk.css').replace(/\/\*[\s\S]*?\*\//g, '');

// ---- the views: a link and a panel each, in the same order desk.js knows them
const VIEWS = ['today', 'crypto', 'games', 'arbs', 'activity'];
const jsViews = ((js.match(/const VIEWS = \[([^\]]*)\]/) || [])[1] || '').match(/'([\w-]+)'/g) || [];
ok('desk.js knows the five views', JSON.stringify(jsViews.map((v) => v.slice(1, -1))) === JSON.stringify(VIEWS), jsViews);
const nav = (html.match(/<nav class="views"[\s\S]*?<\/nav>/) || [''])[0];
const links = [...nav.matchAll(/<a href="#([\w-]+)" data-view="([\w-]+)"/g)].map((m) => [m[1], m[2]]);
ok('the bar has a link to each view, its hash its name', JSON.stringify(links) === JSON.stringify(VIEWS.map((v) => [v, v])), links);
ok('each tab has its icon, for the phone\'s tab bar', (nav.match(/<svg viewBox="0 0 24 24" aria-hidden="true">/g) || []).length === 5);
const panels = [...html.matchAll(/<section class="view[^"]*" id="v-([\w-]+)" data-view="([\w-]+)"[^>]*>/g)].map((m) => ({ id: m[1], view: m[2], hidden: /\shidden\b/.test(m[0]) }));
ok('each view has its panel', JSON.stringify(panels.map((p) => p.view)) === JSON.stringify(VIEWS) && panels.every((p) => p.id === p.view), panels);
ok('only Today shows before the first frame', panels.every((p) => p.hidden === (p.view !== 'today')), panels);
const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
ok('no element is named for a view, so a view\'s link never scrolls the page to one', !ids.some((i) => VIEWS.includes(i)), ids.filter((i) => VIEWS.includes(i)));
ok('ids are unique', new Set(ids).size === ids.length, ids.filter((i, k) => ids.indexOf(i) !== k));
const read$ = [...new Set([...js.matchAll(/\$\('([\w-]+)'\)/g)].map((m) => m[1]))];
ok('every element desk.js reads is in desk.html', read$.every((i) => ids.includes(i)), read$.filter((i) => !ids.includes(i)));
ok('a card\'s own link (#crypto/stocks, #arbs/pm-maker) opens its view and lights the card', /let raw = location\.hash\.slice\(1\)/.test(js) && /let \[v, k\] = raw\.split\('\/'\)/.test(js)
  && /data-anchor="\$\{b\.key\}"/.test(js) && /data-anchor="\$\{k\}"/.test(js) && /\[data-anchor="\$\{CSS\.escape\(pendingAnchor\)\}"\]/.test(js));
ok('the old links land: #overview on Today, #desk and #markets on Crypto & SPY, #pm and #markets/side on Arbs & maker, #pm/bets on Games, a retired book on its line',
  /const OLD_VIEWS = \{ overview: 'today', desk: 'crypto', markets: 'crypto' \}/.test(js) && /if \(k === 'bets'\) \{ v = 'games'; k = null; \} else \{ v = 'arbs';/.test(js)
  && /else if \(v === 'markets' && ARB_CARDS\.includes\(k\)\) \{ v = 'arbs';/.test(js) && /RETIRED\.includes\(k\)\) k = 'retired'/.test(js) && /data-anchor="retired"/.test(html));
ok('the h1 is the view showing, a phone\'s large title, and the app\'s name stays in the bar on a wide screen',
  /<h1 id="viewtitle">Today<\/h1>/.test(html) && /\$\('viewtitle'\)\.textContent = TITLES\[v\]/.test(js) && /\.brandname \{ display: none; \}/.test(css) && /aria-labelledby="viewtitle"/.test(html));
ok('the views follow the back button', /addEventListener\('hashchange', route\)/.test(js));
// A hash cut short inside an escape (#%E0%A4%A) makes decodeURIComponent throw, and route() runs at load before
// the stream is opened: the floor stayed blank for good (found 2026-10-07, in the browser).
ok('a malformed hash cannot stop the floor: decodeURIComponent is only ever called inside a try', /try \{ raw = decodeURIComponent\(raw\); \} catch/.test(js) && [...js.matchAll(/decodeURIComponent\(/g)].length === 1);
// The Home Screen app: iOS suspends the page and drops the stream's socket without an `error`, and there is no
// reload button, so the page watches its own stream (a frame is due every two seconds) and opens a new one.
ok('the page reopens a stream that has gone quiet, on a timer and the moment it is shown again', /const quiet = \(\) => Date\.now\(\) - Math\.max\(lastFrameAt, lastTry\) > STALE_MS/.test(js) && /setInterval\(\(\) => \{ if \(quiet\(\) && !retry && !paused\) connect\(\);/.test(js) && /document\.addEventListener\('visibilitychange', wake\)/.test(js) && /window\.addEventListener\('pageshow', wake\)/.test(js));
ok('one stream at a time: a new one closes the old, and a closed one cannot schedule another', /if \(es\) es\.close\(\)/.test(js) && /if \(es !== mine\) return/.test(js) && /clearTimeout\(retry\)/.test(js));
ok('only the view showing is drawn each frame, and a view is drawn whole as it opens', /if \(view === 'today'\) renderToday\(\);\s*else if \(view === 'games'\) renderGames\(\);\s*else if \(view === 'crypto'\) renderCrypto\(\);\s*else if \(view === 'arbs'\) renderArbs\(\);/.test(js) && /if \(S && draw\) render\(\);/.test(js));

// ---- read-only: the stream, the history, nothing else
const fetches = [...js.matchAll(/fetch\('([^']+)'/g)].map((m) => m[1]);
// ...and one probe, when the stream errors: GET / and do not follow its redirect to /login, so a signed-out page reloads into the form
ok('it fetches only the P&L history, and the front page to see whether it is still signed in', JSON.stringify(fetches) === JSON.stringify(['/api/desk/history', '/']) && /fetch\('\/', \{ cache: 'no-store', redirect: 'manual' \}\)/.test(js), fetches);
ok('it reads only the desk\'s stream', [...js.matchAll(/new EventSource\('([^']+)'\)/g)].map((m) => m[1]).join() === '/api/desk/stream');
ok('it sends nothing: no POST, no form, no socket', !/(method:|POST|XMLHttpRequest|WebSocket|sendBeacon)/.test(js) && !/<form\b/.test(html));

// ---- on a phone, a tab bar at the foot of the screen
const phone = (css.match(/@media \(max-width: 640px\) \{([\s\S]*?)\n\}\n/) || [])[1] || '';
ok('on a phone the views are a tab bar fixed to the foot of the screen, over the home indicator',
  /\.views \{[^}]*position: fixed;[^}]*bottom: 0;/.test(phone) && /\.views \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('...and the page leaves room under its last card for it', /\.wrap \{[^}]*env\(safe-area-inset-bottom\)/.test(phone));
ok('the bar\'s blur is drawn behind it, not on it, so the tab bar inside it is held to the screen', !/\.top \{[^}]*backdrop-filter/.test(css) && /\.top::before \{[^}]*backdrop-filter/.test(css));
ok('a hidden view, tab or tile is gone whatever its own display', /\[hidden\] \{ display: none !important; \}/.test(css));
ok('the five tab names are short enough for a fifth of a 375px screen', [...nav.matchAll(/<span>([^<]+)<\/span>/g)].every((m) => m[1].length <= 8), [...nav.matchAll(/<span>([^<]+)<\/span>/g)].map((m) => m[1]));

// ---- Today (2026-10-17): the date and all the paper, its parts, then the games, the crypto rule, what comes next,
// the lab, the arbs and the maker. Its health card and its chart went on 2026-11-11: the health is the light and its
// sheet, the chart is on Crypto & SPY.
const tv = (html.match(/<section class="view tv" id="v-today"[\s\S]*?\n    <\/section>\n/) || [''])[0];
const at = (id) => tv.indexOf(`id="${id}"`);
ok('Today reads in order: the paper, the games, the crypto rule, next up, the lab, the arbs',
  ['tdhero', 'tdgames', 'tdrule', 'tdnext', 'tdlab', 'tdside'].every((id, i, a) => at(id) > 0 && (i === 0 || at(a[i - 1]) < at(id))), ['tdhero', 'tdgames', 'tdrule', 'tdnext', 'tdlab', 'tdside'].map(at));
ok('the crypto rule carries the bars of what it wants and leads to Crypto & SPY, where the one chart is', at('aims') > at('tdrule') && /id="tdr-h">The crypto rule<\/h2><a class="seeall" href="#crypto">/.test(tv)
  && !/id="chart"/.test(html) && /id="chart2"/.test((html.match(/id="v-crypto"[\s\S]*?\n    <\/section>\n/) || [''])[0]));
ok('the health is the light and its sheet, and nowhere else: no Health card, no desk card', !/id="health"/.test(html) && !/deskcard/.test(html + js + css) && !/function deskHtml/.test(js));
ok('the main column takes 7 of the 12 and the side 5; on a tablet or a phone both are full width',
  /\.tdmain \{ grid-column: span 7; \}/.test(css) && /\.tdaside \{ grid-column: span 5; \}/.test(css) && /\.tdmain, \.tdaside \{ grid-column: 1 \/ -1; \}/.test(css));
ok('all the paper is both desks\' together, and its three parts add up to it: the games\' figure and the rest of their desk\'s',
  /const equity = r2\(\(S\.equity \|\| 0\) \+ le\), initial = r2\(\(S\.initial \|\| 0\) \+ li\)/.test(js) && /pnl: r2\(\(L\.pnl \|\| 0\) - gp\)/.test(js));
ok('the Crypto & SPY part says how much of its figure is the retired books\'', /of it retired books/.test(js));
ok('the total opens the whole Hexagon, each part its view', /class="tdtotal" data-sheet="desk"/.test(js) && /href: '#games'/.test(js) && /href: '#crypto'/.test(js) && /href: '#arbs'/.test(js));
ok('what comes next spans all of it: the bets, the two rules\' checks, the tapes and the re-test dates',
  /k: `bet-\$\{st\}`/.test(js) && /k: 'crypto', sheet: 'book:crypto'/.test(js) && /k: 'spy', sheet: 'book:stocks'/.test(js) && /k: `tape-\$\{tp\.key\}`/.test(js) && /for \(const r of RETESTS\.filter/.test(js));
ok('the re-test dates are the plan\'s: Nov 9, Dec 7, Jan 25, Mar 22', /2026-11-09T/.test(js) && /2026-12-07T/.test(js) && /2027-01-25T/.test(js) && /2027-03-22T/.test(js));
ok('a passed re-test date reads Done only once it records when it ran; otherwise it reads as due and late',
  /why: r\.done \? `Done \$\{/.test(js) && /: `Due, \$\{nOf\(/.test(js) && !/: 'done' \}\)/.test(js) && /k: 'rt-odds', [^\n]*done: Date\.parse\('2026-11-13/.test(js));
ok('the odds tape is graded again after the NFL regular season', /k: 'rt-nfl', t: Date\.parse\('2027-01-11T/.test(js));
ok('the lab counts the ideas tested and kept from one list, and one on test says so', /const TESTS = \[/.test(js) && /kept: 'testing'/.test(js) && (js.match(/kept: true/g) || []).length === 2);
ok('a tape that has gone quiet says so, by how often it runs', /const TAPE_QUIET_H = \{ odds: 0\.5, td: 1, chains: 80 \}/.test(js) && /word: 'Quiet'/.test(js));

// ---- the games: every game a tile, at whatever stage
ok('a tile is up next, bet, live, under way unbet, waiting on the result, left alone, won or lost', ['next', 'bet', 'live', 'late', 'wait', 'skip', 'won', 'lost'].every((st) => new RegExp(`'${st}'`).test(js)));
ok('a bet whose game has no start on record waits on its result, not "up next"', /stage: !known \? 'wait' : started \? 'live' : 'bet'/.test(js));
// the audit of 2026-10-17
ok('a tile and its sheet follow a game from up next to the bet and the final: keyed by its pair, found by it', /return \{ k: r\.pairId \|\| r\.id, stage:/.test(js) && /const fin = g\.finals\.map\(\(f\) => \(\{ k: f\.id, stage:/.test(js) && /x\.id === id \|\| x\.pairId === id/.test(js));
ok('a game under way and not bet is "late", in progress, never up next or "Bets this round"', /stage: begun \? 'late' :/.test(js) && /B\.next\.filter\(\(t\) => t\.stage !== 'late'\)/.test(js));
ok('a game under way and not bet says it is too late: since 2026-10-18 a game is bet only before its start, never "not bet yet"', /'Under way, too late to bet'/.test(js) && !/'Under way, not bet yet'/.test(js));
ok('Today\'s games card counts only today\'s games to come; its foot still names the next group, today\'s or not (audit 2026-10-20)', /const soon = coming\.filter\(\(t\) => dayKey\(t\.start\) === td\)/.test(js) && /startGroups\(coming\)/.test(js));
ok('switched off, Up next says so once, not in every group\'s heading', /if \(!B\.g\.on\) return '';/.test(js) && /' · not bet: the game bets are switched off'/.test(js));
// named in the page itself, so it has a name before the first frame and when a frame carries no games
ok('the record has its heading and its name', /<h2 class="label">The record<\/h2>/.test(js) && /id="ghero" aria-label="The record"/.test(html));
ok('until 4 AM "today" is still the evening before, for the finals as for the games', /td = playedDay\(S\.now\)/.test(js) && /k === playedDay\(S\.now\) \? 'Today'/.test(js));
ok('every tile opens its game', /class="gt st-\$\{t\.stage\}" data-sheet="game:\$\{esc\(t\.k\)\}"/.test(js) && /kind === 'game' \? gameSheet\(arg\)/.test(js));
ok('a sheet\'s id splits at its first colon only: a game pair\'s id has colons of its own', /const s = String\(id\), i = s\.indexOf\(':'\)/.test(js));
ok('the pick is marked by more than its colour', /<span class="sr">, the pick<\/span>/.test(js));
ok('a final belongs to the day its game was played, not the day it settled', /const playedDay = \(at\) => dayKey\(at - 4 \* 3600e3\)/.test(js));
ok('the record is set against what the prices said, with chance\'s spread beside it', /the prices said/.test(js) && /one standard deviation is/.test(js) && /should lose about the fee over many games/.test(js));
ok('a team\'s whole name, and on a phone the price at the tile\'s foot', !/\.gtn \{[^}]*text-overflow: ellipsis/.test(css) && /\.gtp \{ display: none; \}/.test(phone) && /\.gtsp \{ display: inline;/.test(phone));
ok('the league picked is remembered here, and only here', /localStorage\.setItem\('desk-games'/.test(js));

// the design-stack audit of 2026-11-19: Today's tiles stop at six and say how many more there are
ok('Today draws six tiles at most and says how many more, as a link to Games',
  /const TD_TILES = 6;/.test(js) && /const all = \[\.\.\.live, \.\.\.soon, \.\.\.finals\], show = all\.slice\(0, TD_TILES\), more = all\.length - show\.length;/.test(js)
  && /more > 0 \? `<p class="ovnote"><a class="seeall" href="#games">\$\{nOf\(more, 'more game'\)\}<\/a><\/p>` : ''/.test(js));

// Today and Games count the same games: run desk.js's own two lists on a board with one of every stage
{
  const src = (js.match(/  const byStart = [^\n]*\n/) || [''])[0] + (js.match(/  const inPlay = [^\n]*\n  const toCome = [^\n]*\n/) || [''])[0];
  let L = null;
  try { L = new Function(`${src}; return { inPlay, toCome };`)(); } catch { /* reported below */ }
  ok('inPlay and toCome are found and run', !!L && typeof L.inPlay === 'function' && typeof L.toCome === 'function');
  if (L) {
    const B = { open: [{ k: 'live', stage: 'live', start: 5, league: 'NFL' }, { k: 'bet', stage: 'bet', start: 30, league: 'NBA' }, { k: 'wait', stage: 'wait', league: 'NFL' }],
      next: [{ k: 'late', stage: 'late', start: 6, league: 'NBA' }, { k: 'skip', stage: 'skip', start: 20, league: 'NFL' }, { k: 'next', stage: 'next', start: 10, league: 'NBA' }] };
    const ks = (ts) => ts.map((t) => t.k).join();
    ok('in progress: the bets under way, the games under way that were not bet, and the bets waiting on a result', ks(L.inPlay(B)) === 'live,late,wait', ks(L.inPlay(B)));
    ok('to come: the bets not started, the games still to bet and the ones left alone, by start', ks(L.toCome(B)) === 'next,skip,bet', ks(L.toCome(B)));
    ok('a league picks from both', ks(L.inPlay(B, (t) => t.league === 'NBA')) === 'late' && ks(L.toCome(B, (t) => t.league === 'NFL')) === 'skip');
  }
  ok('Today\'s card and the Games view read the same two lists',
    /const live = inPlay\(B\);/.test(js) && /const coming = toCome\(B\);/.test(js) && /const live = inPlay\(B, mine\);/.test(js) && /const soon = toCome\(B, mine\);/.test(js));
}
// a time inside a sentence, and a day the code writes as 2026-10-17: run on desk.js's own helpers, with the clock set
{
  const line = (name) => (js.match(new RegExp(`  const ${name} = [^\\n]*\\n`)) || [''])[0];
  const src = ['ET_HM', 'ET_DAY', 'ET_YMD', 'ET_DATE', 'dayKey', 'addDay', 'dayBefore', 'dayName', 'whenTxt', 'whenAt', 'ET_DAY_Y', 'yearOf', 'settleDay', 'ymd', 'ymdIn'].map(line).join('');
  const NOW = Date.parse('2026-11-19T23:30:00Z'), H = 3600e3, N = '\u00A0';   // 6:30 PM ET on Thursday, Nov 19
  let D = null;
  try { D = new Function('nowT', `const today = () => dayKey(nowT());\n${src}; return { whenTxt, whenAt, ymd, ymdIn };`); } catch { /* reported below */ }
  const at = (now) => { try { return D(() => now); } catch { return null; } };
  const d = D && at(NOW);
  ok('the date helpers are found and run', !!d && typeof d.whenAt === 'function' && typeof d.ymdIn === 'function');
  if (d) {
    ok('today: "at 8:00 PM"', d.whenAt(NOW + 1.5 * H) === 'at 8:00 PM', d.whenAt(NOW + 1.5 * H));
    ok('tomorrow, in a sentence: "tomorrow at 7:00 PM", not "at Tomorrow 7:00 PM"', d.whenAt(NOW + 24.5 * H) === 'tomorrow at 7:00 PM', d.whenAt(NOW + 24.5 * H));
    ok('a later day keeps its capitals: "Sat, Nov 21 at 12:00 PM"', d.whenAt(Date.parse('2026-11-21T17:00:00Z')) === 'Sat, Nov 21 at 12:00 PM', d.whenAt(Date.parse('2026-11-21T17:00:00Z')));
    // midnight UTC is 7:00 PM Eastern in November: before it the check is today's, after it tomorrow's
    const check = (now) => at(now).whenTxt(Math.floor(now / 864e5 + 1) * 864e5);
    ok('the crypto rule\'s next check has no day before it, and "Tomorrow" after it', check(NOW) === '7:00 PM' && check(NOW + 2 * H) === 'Tomorrow 7:00 PM', [check(NOW), check(NOW + 2 * H)]);
    ok('a typed day reads as a day', d.ymd('2026-10-17') === `Oct${N}17` && d.ymd('2026-10-08') === `Oct${N}8`, d.ymd('2026-10-17'));
    ok('...with its year once that is not this year', at(Date.parse('2027-02-01T17:00:00Z')).ymd('2026-10-17') === `Oct${N}17, 2026`, at(Date.parse('2027-02-01T17:00:00Z')).ymd('2026-10-17'));
    ok('a sentence keeps its words and loses its typed days', d.ymdIn('Lost on paper; convergence was switched off (2026-09-21)') === `Lost on paper; convergence was switched off (Sep${N}21)`
      && d.ymdIn('0 of 24 settings') === '0 of 24 settings', d.ymdIn('Lost on paper; convergence was switched off (2026-09-21)'));
  }
  ok('the crypto rule\'s next check is written with its day, not "after midnight UTC"', /`Checks again: <b>\$\{esc\(whenTxt\(Math\.floor\(S\.now \/ 864e5 \+ 1\) \* 864e5\)\)\} ET<\/b>`/.test(js) && !/after midnight UTC:/.test(js));
  ok('Today\'s foot names the next games in a sentence', /`<p class="ovnote">Next: \$\{nOf\(grp\[1\]\.length, 'game'\)\} \$\{esc\(whenAt\(grp\[0\]\)\)\} · /.test(js));
  // every string the page draws: no day typed as 2026-10-17 outside the lists that are passed through ymdIn (TESTS,
  // the books' rules) and the dates the code computes with (Date.parse, RETIRED_ON, comments)
  const drawn = js.split('\n').filter((l) => /\d{4}-\d\d-\d\d/.test(l) && !/^\s*(\/\/|\*|\/\*)/.test(l) && !/Date\.parse\('/.test(l) && !/RETIRED_ON = /.test(l) && !/^\s*\{ idea: /.test(l))
    .map((l) => l.replace(/\/\/[^\n]*$/, '')).filter((l) => /\d{4}-\d\d-\d\d/.test(l));
  ok('no day is typed as 2026-10-17 in what the page draws', drawn.length === 0, drawn.map((l) => l.trim().slice(0, 90)));
  ok('the lab\'s verdicts and the books\' rules are passed through', /why: esc\(ymdIn\(t\.verdict\)\)/.test(js) && (js.match(/esc\(ymdIn\(/g) || []).length >= 5);
}
// a coin's line in its book's sheet: the coin's own figure, and where it stands against holding in words
{
  const src = ['money', 'isZero', 'holdTxt'].map((n) => (js.match(new RegExp(`  const ${n} = [^\\n]*\\n`)) || [''])[0]).join('');
  let holdTxt = null;
  try { holdTxt = new Function(`${src}; return holdTxt;`)(); } catch { /* reported below */ }
  ok('holdTxt is found and runs', typeof holdTxt === 'function');
  ok('ahead, behind and level, in words', !!holdTxt && holdTxt(0.84) === 'ahead of holding by $0.84' && holdTxt(-1234.5) === 'behind holding by $1,234.50' && holdTxt(0.004) === 'level with holding');
  ok('the line\'s figure is the coin\'s own since its start, with holding said beside it, and no sentence under the list to explain it',
    /name: esc\(mktName\(b, r\)\), fig: since,/.test(js) && /const vs = hold == null \? '' : ` · \$\{holdTxt\(r2\(since - hold\)\)\}`;/.test(js) && !/Each line's figure is/.test(js));
}
// the look (design-stack audit, 2026-11-19)
ok('Today\'s date is not in the link colour: it is not a link', /\.tddate \{[^}]*color: var\(--ink-3\); \}/.test(css) && !/\.tddate \{[^}]*var\(--accent\)/.test(css));
ok('every chevron is drawn, none typed', !/[›»→]/.test(js + html) && /\.seeall::after, \.pmold::after \{ content: ''; display: inline-block;/.test(css));
ok('the disclosure\'s chevron turns only when the device allows motion',
  !/\.rule summary::after \{[^}]*transition/.test(css.replace(/@media \(prefers-reduced-motion: no-preference\) \{ \.rule summary::after \{[^}]*\} \}/, ''))
  && /@media \(prefers-reduced-motion: no-preference\) \{ \.rule summary::after \{ transition: transform \.2s; \} \}/.test(css));
ok('a part on Today has its chevron on a phone too, after its figure',
  /<span class="ps">\$\{esc\(p\.sub\)\}<\/span><i class="chev" aria-hidden="true"><\/i><\/a>/.test(js) && !/\.part [^{]*\.chev \{ display: none; \}/.test(css)
  && /\.part \{ grid-template-columns: minmax\(0, 1fr\) auto 8px; grid-template-areas: "n f c" "s f c";/.test(phone) && /\.part > \.chev \{ grid-area: c; align-self: center; \}/.test(css));

// ---- Crypto & SPY, Arbs & maker, and the retired books
ok('Crypto & SPY holds the crypto and SPY books and one line for the retired; Arbs & maker the arbs, maker, snipe and convergence',
  /\['crypto', 'stocks'\]\.map\(bookOf\)/.test(js) && /const SIDE = \['arbs', 'maker', 'snipe', 'converge'\]/.test(js) && /Retired on \$\{ymd\(RETIRED_ON\)\}/.test(js) && /RETIRED_ON = '2026-10-17'/.test(js));
ok('the retired books have no card and no colour: four of six used to outnumber the two that trade', !/var\(--book-(options|scalps|dips|runners)\)/.test(js + css) && !/GROUPS/.test(js));
ok('an arb past its settle date says so', /was to settle \$\{settleDay\(r\.settlesAt\)\}, still open/.test(js));
ok('arbs over their cap are not "19 of 12 open"', /const over = b\.rows\.length > b\.max/.test(js) && /more than its \$\{b\.max\} slots/.test(js));
ok('a game bet is named by the team it is on, with what it pays', /Bet on \$\{g\.pick\} over \$\{g\.foe\}/.test(js) && /pays \$\{money\(f\.qty\)\} if they win/.test(js) && /Won on \$\{g\.pick\} over \$\{g\.foe\}/.test(js));
ok('a book has bought in by its rows, not by its holding figure, which is null until the first price',
  /const boughtIn = \(b\) => \(b\.key === 'crypto' \|\| b\.key === 'stocks'\) && b\.rows\.some\(\(r\) => r\.qty > 0 \|\| r\.benchPx > 0\)/.test(js) && !/heldBooks = [^\n]*bench != null/.test(js));
ok('...and with no price yet the crypto rule says it is waiting on prices', /if \(bs\.some\(\(b\) => b\.bench == null\)\) return \{ bs, waiting: true \}/.test(js) && /verdict zero">Waiting on prices</.test(js));
ok('a held slot with no price is worth what it cost, as the book counts it, not its cash alone',
  /if \(r\.qty > 0 && !\(r\.px > 0\)\) \{ r\.value = r2\(r\.cost\); r\.worth = r2\(r\.cash \+ r\.cost\); r\.pnl = null; \}/.test(js) && /S = atCost\(JSON\.parse\(ev\.data\)\)/.test(js));
ok('the chart is crypto and SPY against holding them', /const HOLD_FIELDS = \{ crypto: \['c', 'bc'\], stocks: \['s', 'bs'\] \}/.test(js));

// ---- one name for each part, everywhere (2026-11-11): Today's summary, the view titles and the Activity filter
// which part a prediction-market log line is: run desk.js's own pmLogTag on the lines the engine writes
{
  const src = (js.match(/const PM_GAME_LINE = [^\n]*\n\s*const pmLogTag = [\s\S]*?'Predictions'\);/) || [''])[0];
  let tag = null;
  try { tag = new Function(`${src}; return pmLogTag;`)(); } catch { /* reported below */ }
  const T = (e) => (tag ? tag(e) : null);
  ok('pmLogTag is found and runs', typeof tag === 'function');
  ok('a game bet is the games\'', T({ agent: 'KETT', text: 'Game bet on Missouri at 61¢' }) === 'Games');
  ok('a late game, not bet, is the games\'', T({ agent: 'BRAM', text: 'NFL Bills v Jets: not bet', sub: 'it had started' }) === 'Games');
  ok('the bets going on again is the games\'', T({ agent: 'TESS', text: 'The game bets go on again', sub: 'daily drawdown' }) === 'Games');
  ok('the bets stopping too is the games\'', T({ agent: 'TESS', text: 'Prediction markets stopped taking new risk', sub: 'the game bets stop too · stale data' }) === 'Games');
  ok('a passed game bet is the games\'', T({ agent: 'KETT', text: 'Passed on NCAAF Ohio State v Michigan', sub: 'game bet on Ohio State, but Kalshi\'s live book has nothing offered' }) === 'Games');
  ok('the desk\'s halt is the arbs\' and maker\'s, though the bets go on', T({ agent: 'TESS', text: 'Prediction markets stopped taking new risk', sub: 'daily drawdown 3.1% · no new risk until clear, but the game bets go on' }) === 'Predictions');
  ok('the desk coming online is not the games\'', T({ agent: 'TESS', text: 'Desk online', sub: 'paper + every game of 4 leagues' }) === 'Predictions');
  ok('an arb is the arbs\'', T({ agent: 'KETT', text: 'Bought 209 Yes on NBA Bucks v Heat' }) === 'Predictions');
  ok('the maker is the maker\'s', T({ agent: 'MAKR', text: 'game bets' }) === 'Maker');
}
// the light in the bar, run on desk.js's own deskState: the Health sheet says amber "when prices are stale or the desk
// is not buying" and red "when the desk stops or this page loses its signal", and the light does each of them. Until
// 2026-11-19 stale SPY prices left it green.
{
  const src = (js.match(/  const pricesStale = [^\n]*\n  const deskState = [\s\S]*?\['Working', 'good'\]\);/) || [''])[0];
  const light = (S, o = {}) => { try { return new Function('S', 'stale', 'stalled', `${src}; return deskState();`)(S, () => !!o.gone, () => !!o.stuck).join(); } catch (e) { return e.message; } };
  const mk = (crypto, stocks) => ({ halt: null, market: { stale: { crypto, stocks } } });
  ok('deskState is found and runs', !!src && light(mk(false, false)) === 'Working,good', light(mk(false, false)));
  ok('stale crypto prices turn the light amber', light(mk(true, false)) === 'Waiting on prices,warn', light(mk(true, false)));
  ok('stale SPY prices turn the light amber too', light(mk(false, true)) === 'Waiting on prices,warn', light(mk(false, true)));
  ok('not buying is amber, and comes before stale prices', light({ ...mk(false, true), halt: 'daily loss limit' }) === 'Not buying,warn');
  ok('a stalled desk and a lost signal are red, whatever the prices', light(mk(false, false), { stuck: true }) === 'Stalled,bad' && light(mk(true, true), { gone: true }) === 'No signal,bad');
  ok('a frame with no market reads as working, not as an error', light({ halt: null }) === 'Working,good', light({ halt: null }));
  ok('the Health sheet says what the light does', /The light in the bar turns amber when prices are stale or the desk is not buying, and red when the desk stops or this page loses its signal\./.test(js));
  ok('the sheet\'s SPY line and the light read the same flag', /spyOk = !\(mk\.stale && mk\.stale\.stocks\)/.test(js) && /S\.market\.stale\.crypto \|\| S\.market\.stale\.stocks/.test(js));
}
// a name that wraps: its " · " stays with the word before it, and a settle day stays whole
{
  const src = (js.match(/  const esc = [^\n]*\n/) || [''])[0] + (js.match(/  const joined = [^\n]*\n/) || [''])[0];
  let joined = null;
  try { joined = new Function(`${src}; return joined;`)(); } catch { /* reported below */ }
  ok('joined is found and runs', typeof joined === 'function');
  ok('a name\'s dot is held to the word before it', !!joined && joined('NCAAF Indiana v Washington · Indiana') === 'NCAAF Indiana v Washington\u00A0· Indiana');
  ok('...and the name is still escaped', !!joined && joined('A&M v <b> · A&M') === 'A&amp;M v &lt;b&gt;\u00A0· A&amp;M');
  ok('an arb\'s name, a leg\'s name and an Activity line are drawn with it', (js.match(/<span class="nm">\$\{joined\(r\.label\)\}<\/span>/g) || []).length === 2 && /<span class="what">\$\{joined\(r\.text\)\}/.test(js));
  ok('a settle day is one word: its space is a no-break space, written as an escape', /\.format\(new Date\(t\)\)\.replace\(' ', '\\u00A0'\);/.test(js));
}
ok('the Activity filter is the same three parts Today counts', /const DESKS = \[\['both', 'All of it'\], \['desk', 'Crypto & SPY'\], \['games', 'Games'\], \['side', 'Arbs & maker'\]\]/.test(js)
  && /name: 'Crypto & SPY'/.test(js) && /name: 'Games'/.test(js) && /name: 'Arbs & maker'/.test(js)
  && /crypto: 'Crypto & SPY', games: 'Games', arbs: 'Arbs & maker'/.test(js));

// ---- sheets: everything with more behind it opens it ("Make it so everything is interactive if it leads to something else", 2026-10-12)
const sheets = [...new Set([...(html + js).matchAll(/data-sheet="([a-z]+)(?::|")/g)].map((m) => m[1]))];
const known = ((js.match(/function sheetOf\(id\) \{[\s\S]*?\n  \}/) || [''])[0].match(/kind === '(\w+)'/g) || []).map((m) => m.slice(10, -1));
ok('every sheet the page opens is one sheetOf draws', sheets.length >= 6 && sheets.every((k) => known.includes(k)), { sheets, known });
ok('the light opens the health, and the sheet lists each check', /id="deskstate" data-sheet="health"/.test(html) && /healthChecks\(\)\.map\(line\)/.test(js));
ok('each market\'s bar opens its sheet, and the lab its own', /class="aim" data-sheet="mkt:/.test(js) && /class="labsum" data-sheet="lab"/.test(js) && /data-sheet="lab">Every test</.test(html));
ok('a sheet is a dialog with Back and Done, and a change of view or Escape closes it',
  /<div id="sheet" hidden>\s*<div class="shbox" role="dialog" aria-modal="true"/.test(html) && /id="sheetback"/.test(html) && /class="shdone" data-close="1"/.test(html)
  && /closeBigChart\(\);[^\n]*\n\s*closeSheet\(\);/.test(js) && /if \(ev\.key === 'Escape'\) \{ closeBigChart\(\); closeSheet\(\); \}/.test(js));
ok('an open sheet is drawn again from every frame', /renderSheet\(\);\n\s*\$\('floor'\)\.removeAttribute\('aria-busy'\)/.test(js));
ok('a line that opens nothing is not a button: only a sheet or a link makes one', /const tag = o\.sheet \? `button type="button" class="\$\{cls\}"[^`]*` : o\.href \? `a class="\$\{cls\}"[^`]*` : `div class="\$\{cls\}"`/.test(js));

// ---- motion (2026-10-10): a view opens at once, as an app's tab does; what moves answers an action
ok('no card animates in when a view opens', !/animation: rise/.test(css) && !/@keyframes rise/.test(css));
ok('the sheets still open as sheets, and a card still lights when a link led to it', /\[data-anchor\]\.flash \{ animation: flash/.test(css) && /@keyframes sheetin/.test(css) && /@keyframes sheetup/.test(css));
ok('...and both only when the device allows motion', (css.match(/@media \(prefers-reduced-motion: no-preference\)/g) || []).length >= 4);

// ---- the audits that carry over (2026-10-15, 10-16): a hidden page rests, a failed stream backs off, stale figures
// say so everywhere, the page behind a dialog is inert
ok('a page hidden for a minute closes its stream, and opens it when shown', /paused = true; clearTimeout\(retry\); retry = null; if \(es\) \{ es\.close\(\); es = null; \}/.test(js) && /\} else if \(paused\) \{ paused = false; resumedAt = Date\.now\(\); fails = 0; connect\(\); \}/.test(js) && /\}, 60000\);/.test(js));
ok('...and is not "No signal" while it rests', /const stale = \(\) => !paused && lastFrameAt && Date\.now\(\) - Math\.max\(lastFrameAt, resumedAt\) > STALE_MS/.test(js));
ok('a failed stream waits 3s, then twice as long each time, at most a minute', /retry = setTimeout\(connect, Math\.min\(60000, 3000 \* 2 \*\* fails\+\+\)\)/.test(js));
ok('when the stream goes quiet everything is drawn again, the open sheet with it, and the sheet says so', /if \(!!stale\(\) !== shownGone\) render\(\);/.test(js) && /class="shstale"/.test(js) && /body\.offline #sheetbody/.test(css));
ok('the page behind a sheet or the large chart is inert', /el\.inert = on/.test(js) && (js.match(/behind\(\);/g) || []).length >= 4);
ok('the small links are at least 24px tall', /\.seeall, \.pmold, \.rule summary \{ display: inline-flex; align-items: center; min-height: 24px; \}/.test(css));
ok('a cent down is nothing lost, not "down 0.00%"', (js.match(/>= 0\.00005/g) || []).length >= 1);
ok('"1 second ago", not "1 seconds ago"', /\$\{s\} second\$\{s === 1 \? '' : 's'\} ago/.test(js));
ok('the health line says what the 5% is: a loss limit', /`Loss limit: \$\{down \?/.test(js));
ok('Back keeps the focus in the sheet: on Back while there is one to go back to, else on Done',
  /if \(!sheet\.hidden\) \(sheetback\.hidden \? sheet\.querySelector\('\.shdone'\) : sheetback\)\.focus\(/.test(js));
ok('a link in a sheet closes it, and the same address as the one showing goes to its card again',
  /const go = ev\.target\.closest\('#sheet a\[href\^="#"\]'\);\s*if \(go\) \{ closeSheet\(\); if \(go\.hash === location\.hash\) route\(\); return; \}/.test(js));
ok('a verdict is a sentence and wraps, though a figure\'s colour keeps a figure whole', /\.verdict\.pos, \.verdict\.neg, \.verdict\.zero \{ white-space: normal; \}/.test(css));

// morph's patch, run on a small stand-in for the DOM: a line that is still wanted stays the same element when a
// new one comes in on top, one goes, or two swap. Until 2026-10-15 a new fill replaced every line under it.
{
  const src = (js.match(/  const sameNode = [\s\S]*?\n  function patch\(a, b\) \{[\s\S]*?\n  \}\n/) || [''])[0];
  class N {
    constructor(name, k, text) { this.nodeName = name; this.nodeType = name === '#text' ? 3 : 1; this.nodeValue = text ?? null; this.attrs = new Map(k == null ? [] : [['data-k', k]]); this.childNodes = []; this.parentNode = null; }
    get attributes() { return [...this.attrs].map(([name, value]) => ({ name, value })); }
    getAttribute(n) { return this.attrs.has(n) ? this.attrs.get(n) : null; }
    setAttribute(n, v) { this.attrs.set(n, String(v)); } removeAttribute(n) { this.attrs.delete(n); } hasAttribute(n) { return this.attrs.has(n); }
    get nextSibling() { const p = this.parentNode; return p ? p.childNodes[p.childNodes.indexOf(this) + 1] || null : null; }
    get lastChild() { return this.childNodes[this.childNodes.length - 1] || null; }
    get isConnected() { return true; }
    removeChild(c) { this.childNodes.splice(this.childNodes.indexOf(c), 1); c.parentNode = null; return c; }
    insertBefore(c, ref) { if (c.parentNode) c.parentNode.removeChild(c); this.childNodes.splice(ref ? this.childNodes.indexOf(ref) : this.childNodes.length, 0, c); c.parentNode = this; return c; }
    appendChild(c) { return this.insertBefore(c, null); }
    replaceChild(c, old) { this.insertBefore(c, old); return this.removeChild(old); }
  }
  const li = (k) => { const n = new N('LI', k); n.appendChild(new N('#text', null, `line ${k}`)); return n; };
  const list = (ks) => { const u = new N('UL'); for (const k of ks) u.appendChild(li(k)); return u; };
  let patch = null;
  try { patch = new Function(`${src}; return patch;`)(); } catch (e) { ok('patch can be read out of desk.js', false, e.message); }
  if (patch) {
    const run = (from, to) => { const a = list(from), was = new Map(a.childNodes.map((c) => [c.getAttribute('data-k'), c])); patch(a, list(to)); return { a, was }; };
    const kept = ({ a, was }, ks) => ks.every((k) => a.childNodes.find((c) => c.getAttribute('data-k') === k) === was.get(k));
    const order = ({ a }) => a.childNodes.map((c) => c.getAttribute('data-k')).join();
    let r = run(['a', 'b', 'c'], ['n', 'a', 'b', 'c']);
    ok('patch: a new line on top leaves every line under it the same element', order(r) === 'n,a,b,c' && kept(r, ['a', 'b', 'c']), order(r));
    r = run(['a', 'b', 'c'], ['b', 'c']);
    ok('patch: a line that goes takes no other with it', order(r) === 'b,c' && kept(r, ['b', 'c']), order(r));
    r = run(['a', 'b', 'c', 'd'], ['b', 'a', 'd', 'x']);
    ok('patch: lines that swap are moved, not drawn again', order(r) === 'b,a,d,x' && kept(r, ['a', 'b', 'd']), order(r));
    r = run(['a', 'b'], ['a', 'b']);
    ok('patch: a frame that changes nothing keeps everything', order(r) === 'a,b' && kept(r, ['a', 'b']) && r.a.childNodes[1].childNodes[0].nodeValue === 'line b');
  }
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail ? 1 : 0);

'use strict';
// Matches the same real-world outcome across Polymarket and Kalshi.
// A pair means: "YES on PM outcome[tokenIndex]" resolves identically to "YES on Kalshi ticker".

const MON = { january: 'JAN', february: 'FEB', march: 'MAR', april: 'APR', may: 'MAY', june: 'JUN', july: 'JUL', august: 'AUG', september: 'SEP', october: 'OCT', november: 'NOV', december: 'DEC' };
const MONNUM = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' };

const norm = (s) => String(s || '')
  .normalize('NFD').replace(/[̀-ͯ]/g, '')
  .toLowerCase()
  .replace(/\bst\.?(?=\s|$)/g, 'state')
  .replace(/\b(fc|sc|cf|afc)\b/g, ' ')
  .replace(/[^a-z0-9 ]+/g, ' ')
  .replace(/\s+/g, ' ').trim();
const toks = (s) => norm(s).split(' ').filter(Boolean);

// Kalshi names are often abbreviated ("New York Y", "Los Angeles A", "Appalachian St.").
// Every Kalshi token must be a prefix of a Polymarket token, in order.
function nameMatch(ksName, pmName, people = false) {
  const a = toks(ksName), b = toks(pmName);
  if (!a.length || !b.length) return false;
  let j = 0;
  let ok = true;
  for (const t of a) {
    while (j < b.length && !b[j].startsWith(t)) j++;
    if (j >= b.length) { ok = false; break; }
    j++;
  }
  if (ok) return true;
  if (!people) return false; // "Kansas City" must never match "Orlando City"
  // surname fallback for people ("D. Medvedev" vs "Daniil Medvedev")
  const la = a[a.length - 1], lb = b[b.length - 1];
  return a.length >= 2 && b.length >= 2 && la.length >= 4 && la === lb;
}

// "KXMLBGAME-26SEP081905COLNYY" -> "2026-09-08" (Kalshi game tickers carry the US/Eastern date)
function tickerDate(ticker) {
  const m = String(ticker).match(/-(\d{2})([A-Z]{3})(\d{2})/);
  if (!m || !MONNUM[m[2]]) return null;
  return `20${m[1]}-${MONNUM[m[2]]}-${m[3]}`;
}

const ET = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });
function etDate(gameStart) {
  const d = new Date(String(gameStart).replace(' ', 'T').replace(/\+00$/, 'Z'));
  return isNaN(d) ? null : ET.format(d);
}
// The ET day before a "YYYY-MM-DD" day.
const prevDay = (d) => new Date(Date.parse(`${d}T12:00:00Z`) - 86400e3).toISOString().slice(0, 10);

// "KXMLBGAME-26SEP221905TBNYYG2" -> 2026-09-22 19:05 US/Eastern, as epoch ms. MLB tickers carry the
// first pitch after the date; NFL, college, soccer and tennis tickers do not, and get null. The
// clock is New York's, so the offset is read for that instant (EDT -4h, EST -5h) rather than assumed:
// the wall time is first read as UTC, then moved by the zone's offset, twice so a guess on the wrong
// side of a DST change corrects itself.
const ET_CLOCK = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' });
function nyOffsetMs(t) {
  const p = Object.fromEntries(ET_CLOCK.formatToParts(new Date(t)).map((x) => [x.type, +x.value]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute) - Math.floor(t / 60000) * 60000;
}
function tickerStartMs(ticker) {
  const m = String(ticker).match(/-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/);
  if (!m || !MONNUM[m[2]] || +m[4] > 23 || +m[5] > 59) return null;
  const wall = Date.UTC(2000 + +m[1], +MONNUM[m[2]] - 1, +m[3], +m[4], +m[5]);
  let t = wall + 5 * 3600e3;
  for (let i = 0; i < 2; i++) t = wall - nyOffsetMs(t);
  return t;
}

const GENERIC = new Set(['state', 'st.', 'st', 'tech', 'united', 'city', 'sox', 'jays', 'a&m', 'college', 'international', 'southern', 'northern']);
function short(name) {
  const t = String(name).trim().split(/\s+/).filter((w) => !/^(fc|sc|cf|afc)$/i.test(w));
  if (t.length <= 1) return t[0] || String(name);
  const last = t[t.length - 1];
  if (GENERIC.has(last.toLowerCase())) return t.slice(-2).join(' ');
  return last;
}
function startMs(gameStart) {
  const ms = Date.parse(String(gameStart || '').replace(' ', 'T').replace(/\+00$/, 'Z'));
  return Number.isFinite(ms) ? ms : null;
}

function series(ticker) { return String(ticker).split('-')[0]; }

// ---------------------------------------------------------------- figures
// The numbers in a question ARE the outcome. "CPI above 3.0%" and "CPI above 3.1%" share every
// word and resolve differently; so do "by September 30" and "by October 1", "2026" and "2027",
// "Game 1" and "Game 2" of a doubleheader. Name matching cannot see that, and the price guard
// below cannot either: two brackets a tenth apart price within a cent of each other, which is
// exactly the case it is blind to. So the figures on each side are pulled out BY KIND -- years,
// month-day dates, percentages, basis points, dollar amounts, bare numbers -- and compared kind by
// kind. Where both sides carry a figure of the same kind and the sets differ, the pair is wrong.
// One side saying nothing is not a conflict: a Kalshi title rarely repeats the date its ticker
// carries. A number glued to letters ("76ers", "49ers", "B53.5") is a name, not a figure.
const MONTHS = 'jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec';
const MONNUM2 = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
const SCALE = { '': 1, k: 1e3, thousand: 1e3, m: 1e6, mm: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 };
// built once: figures() runs twice per candidate pair, every scan
const MONTH_DAY = new RegExp(`\\b(${MONTHS})[a-z]*\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?![\\d.:%])`, 'g');
const DAY_MONTH = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTHS})[a-z]*\\b`, 'g');
function figures(text) {
  let s = ` ${String(text || '')} `.toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1');   // "1,000" -> "1000"
  const out = { years: new Set(), dates: new Set(), pct: new Set(), bps: new Set(), money: new Set(), nums: new Set() };
  // each kind consumes what it matched, so a figure is counted once and under its most specific kind
  const take = (re, f) => { s = s.replace(re, (...m) => { f(m); return ' '; }); };
  take(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m) => { out.years.add(+m[1]); out.dates.add(`${+m[2]}/${+m[3]}`); });
  take(MONTH_DAY, (m) => out.dates.add(`${MONNUM2[m[1]]}/${+m[2]}`));
  take(DAY_MONTH, (m) => out.dates.add(`${MONNUM2[m[2]]}/${+m[1]}`));
  take(/(?<!\w|\d\.)(\d+(?:\.\d+)?)\s*(?:%|percent)(?!\w)/g, (m) => out.pct.add(+m[1]));
  take(/(?<!\w|\d\.)(\d+(?:\.\d+)?)\s*(?:bps?|basis\s+points?)(?!\w)/g, (m) => out.bps.add(+m[1]));
  take(/\$\s*(\d+(?:\.\d+)?)\s*(k|thousand|mm|m|million|bn|b|billion|t|trillion)?(?!\w)/g, (m) => out.money.add(+m[1] * SCALE[m[2] || '']));
  take(/(?<!\w|\d\.)((?:19|20)\d{2})(?!\w|\.\d)/g, (m) => out.years.add(+m[1]));
  take(/(?<!\w|\d\.)(\d+(?:\.\d+)?)(?!\w|\.\d)/g, (m) => out.nums.add(+m[1]));
  return out;
}
// The first kind on which both sides speak and disagree, described; null when nothing conflicts.
function figuresConflict(a, b) {
  const A = figures(a), B = figures(b);
  for (const k of Object.keys(A)) {
    if (!A[k].size || !B[k].size) continue;
    if (A[k].size !== B[k].size || [...A[k]].some((x) => !B[k].has(x))) return `${k}: ${[...A[k]].join(',')} vs ${[...B[k]].join(',')}`;
  }
  return null;
}

// How far apart two venues' prices for the SAME outcome can be before the pairing itself is the
// likelier explanation. Used at match time (below) and on every held arb (engine.arbScorecard), so
// "we matched the wrong thing" has one definition rather than one per file.
const MAX_VENUE_DISAGREE = 0.30;

// A doubleheader is two Kalshi events for the same two teams on the same ET date, and neither venue
// says "Game 1" or "Game 2" anywhere the matcher reads: Kalshi's market title is "Tampa Bay wins",
// Polymarket's question is "Tampa Bay Rays vs. New York Yankees" for both games. The one thing that
// tells them apart is the start. On 2026-09-22 the first name match won instead: Polymarket's game 1
// (17:05Z) paired with Kalshi's game 2 (...221905TBNYYG2), and the desk booked a $183 "locked" arb on
// two different games -- Rays YES on game 1 at 0.42 and Rays NO on game 2 at 0.55, which both lose
// when the Rays drop game 1 and take game 2, as they did. An early unwind (+$5.17) was all that saved
// it, and the real game 2 went unpaired for a day behind it. So every candidate event is collected,
// and with two or more the one whose ticker start is nearest Polymarket's gameStart wins -- if it is
// within START_NEAREST_MIN, and if any ticker carries a time at all; otherwise nothing pairs. A single
// candidate pairs as before, with only a looser START_SANITY_MIN bound: a start one venue has moved
// and the other has not should not unpair the right game. It is still shorter than the gap between
// two games of a doubleheader (a game takes about three hours; 09-22's were six apart), because once
// Kalshi's game 1 closes and leaves the listing, Polymarket's game 1 -- still open until it settles --
// finds game 2 as its only candidate, and that is exactly the pair the settlement snipe would buy.
const START_NEAREST_MIN = 120;
const START_SANITY_MIN = 150;
function pickByStart(found, pmStart) {
  if (!found.length) return {};
  const at = (c) => tickerStartMs(c.ks.eventTicker || c.ks.ticker);
  const off = (c) => (at(c) == null || pmStart == null ? null : Math.abs(at(c) - pmStart) / 60000);
  const hm = (ms) => new Date(ms).toISOString().slice(11, 16);
  if (found.length === 1) {
    const o = off(found[0]);
    if (o != null && o > START_SANITY_MIN) return { rej: { ...found[0], detail: `Kalshi starts ${hm(at(found[0]))}Z, Polymarket ${hm(pmStart)}Z` } };
    return { hit: found[0] };
  }
  const timed = found.filter((c) => off(c) != null).sort((a, b) => off(a) - off(b));
  if (!timed.length) return { rej: { ...found[0], detail: `${found.length} games on one date and no start time to tell them apart` } };
  const best = timed[0];
  if (off(best) > START_NEAREST_MIN) return { rej: { ...best, detail: `${found.length} games on one date, the nearest starts ${hm(at(best))}Z against Polymarket ${hm(pmStart)}Z` } };
  return { hit: best };
}

// Sport classification so "Seattle" (Sounders) can never match "Seattle" (Mariners).
const SPORT_SERIES = {
  mlb: ['KXMLBGAME'], nfl: ['KXNFLGAME'], nba: ['KXNBAGAME'], tennis: ['KXATPMATCH', 'KXWTAMATCH'],
  college: ['KXNCAAFGAME'], soccer: ['KXMLSGAME', 'KXEPLGAME', 'KXUCLGAME', 'KXLALIGAGAME'],
};
const SPORT_KEY = Object.fromEntries(Object.entries(SPORT_SERIES).flatMap(([sport, list]) => list.map((ser) => [ser, sport])));
const TAG = { KXMLBGAME: 'MLB', KXNFLGAME: 'NFL', KXNBAGAME: 'NBA', KXATPMATCH: 'ATP', KXWTAMATCH: 'WTA', KXNCAAFGAME: 'NCAAF', KXMLSGAME: 'MLS', KXEPLGAME: 'EPL', KXUCLGAME: 'UCL', KXLALIGAGAME: 'LaLiga', KXFEDDECISION: 'Fed' };
const MLB = new Set(['diamondbacks', 'braves', 'orioles', 'red sox', 'cubs', 'white sox', 'reds', 'guardians', 'rockies', 'tigers', 'astros', 'royals', 'angels', 'dodgers', 'marlins', 'brewers', 'twins', 'mets', 'yankees', 'athletics', 'phillies', 'pirates', 'padres', 'giants', 'mariners', 'cardinals', 'rays', 'rangers', 'blue jays', 'nationals']);
const NFL = new Set(['cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals', 'browns', 'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts', 'jaguars', 'chiefs', 'raiders', 'chargers', 'rams', 'dolphins', 'vikings', 'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders']);
// Polymarket names an NFL side by nickname alone ("Vikings"); Kalshi names it by city ("Minnesota",
// "New York J"). No other league splits the name this way -- MLB and NBA carry the city on
// Polymarket, college and soccer use the club on both -- so nameMatch, which walks Kalshi's tokens
// as prefixes of Polymarket's, could never pair a single NFL game: 0 of 14 on Sunday 2026-09-20,
// silently, all season. Putting the city back in front of the nickname is the whole fix:
// "New York J" then prefixes "New York Jets" and not "New York Giants", exactly as MLB's
// "New York Y" already does.
const NFL_CITY = { cardinals: 'Arizona', falcons: 'Atlanta', ravens: 'Baltimore', bills: 'Buffalo', panthers: 'Carolina',
  bears: 'Chicago', bengals: 'Cincinnati', browns: 'Cleveland', cowboys: 'Dallas', broncos: 'Denver', lions: 'Detroit',
  packers: 'Green Bay', texans: 'Houston', colts: 'Indianapolis', jaguars: 'Jacksonville', chiefs: 'Kansas City',
  raiders: 'Las Vegas', chargers: 'Los Angeles', rams: 'Los Angeles', dolphins: 'Miami', vikings: 'Minnesota',
  patriots: 'New England', saints: 'New Orleans', giants: 'New York', jets: 'New York', eagles: 'Philadelphia',
  steelers: 'Pittsburgh', '49ers': 'San Francisco', seahawks: 'Seattle', buccaneers: 'Tampa Bay', titans: 'Tennessee',
  commanders: 'Washington' };
const nflFull = (name) => { const c = NFL_CITY[norm(name)]; return c ? `${c} ${name}` : name; };
const NBA = new Set(['hawks', 'celtics', 'nets', 'hornets', 'bulls', 'cavaliers', 'mavericks', 'nuggets', 'pistons', 'warriors', 'rockets', 'pacers', 'clippers', 'lakers', 'grizzlies', 'heat', 'bucks', 'timberwolves', 'pelicans', 'knicks', 'thunder', 'magic', '76ers', 'suns', 'trail blazers', 'kings', 'spurs', 'raptors', 'jazz', 'wizards']);
function nick(name) { const t = toks(name); return [t.slice(-2).join(' '), t[t.length - 1]]; }
function inLeague(set, name) { return nick(name).some((n) => set.has(n)); }
// Kalshi's MLB names that are not a prefix of any Polymarket name, keyed on norm() so a changed
// apostrophe or spacing still lands. "Chicago WS" and "A's" never matched "Chicago White Sox" and
// "Athletics": none of the 154 KXMLBGAME pairs on the 09-10..09-24 tapes was either team's, about one game
// in seven on a full slate, and the coverage alarm cannot see two games missing out of fifteen.
const KS_MLB_ALIAS = { 'chicago ws': 'Chicago White Sox', 'a s': 'Athletics' };
const mlbName = (name) => KS_MLB_ALIAS[norm(name)] || name;

// Polymarket's slug names the league outright ("mlb-tb-nyy-2026-09-22", "cfb-clmsn-cah-...",
// "wta-mertens-chwalin-..."), so it is read first. Guessing from the team names filed every two-way
// moneyline it did not recognise as college -- Valorant, League of Legends, Asian Games cricket -- so
// Polymarket looked to be "listing" NCAAF on 2026-09-25, and HOLT's renamed-team alarm fired eight
// times on 09-24 whenever the one real game dropped out of the top 500. Any other prefix (cs2-, val-,
// lol-, crint-, ufc-, nhl-, itf-, euroleague-) is a sport Kalshi's game series do not list: null,
// nothing counted, nothing matched. And Polymarket stopped writing "ATP"/"WTA" in tennis questions
// ("Korea Open: Anna Bondar vs Gabriela Ruse"), which is why the fast matcher paired no tennis after
// 09-13; the prefix is how it is found now, with the old text test kept behind it.
const SLUG_SPORT = { mlb: 'mlb', nfl: 'nfl', nba: 'nba', cfb: 'college', atp: 'tennis', wta: 'tennis', epl: 'soccer', ucl: 'soccer', mls: 'soccer', lal: 'soccer' };
function classify(m, A, B) {
  const question = m.question || '';
  const prefix = m.slug ? String(m.slug).split('-')[0].toLowerCase() : null;
  if (prefix && SLUG_SPORT[prefix]) return SLUG_SPORT[prefix];
  if (/\b(ATP|WTA)\b/.test(question)) return 'tennis';
  if (prefix) return null;
  // no slug (a hand-built fixture): the name guess below
  if (inLeague(MLB, A) && inLeague(MLB, B)) return 'mlb';
  if (inLeague(NFL, A) && inLeague(NFL, B)) return 'nfl';
  if (inLeague(NBA, A) && inLeague(NBA, B)) return 'nba';
  if (/\b(FC|SC|CF|United|City|Real|Athletic|Sporting)\b/.test(`${A} ${B}`)) return 'soccer';
  return 'college';
}

function matchPairs(pmList, ksList) {
  const pairs = [], rejected = [];
  const usedKs = new Set();
  // What Polymarket is LISTING, as `sport|ET date`, whether or not it paired. Coverage (below)
  // needs the denominator: a Kalshi event days out with no Polymarket counterpart yet is normal,
  // a Kalshi event on a date Polymarket is actively listing that sport for is not.
  const pmListing = new Set();
  const ksByTicker = new Map(ksList.map((k) => [k.ticker, k]));
  const events = new Map();
  for (const k of ksList) {
    if (!events.has(k.eventTicker)) events.set(k.eventTicker, []);
    events.get(k.eventTicker).push(k);
  }
  const byDate = new Map();
  for (const [ev, ms] of events) {
    const d = tickerDate(ev);
    if (!d) continue;
    if (!byDate.has(d)) byDate.set(d, []);
    byDate.get(d).push(ms);
  }

  for (const m of pmList) {
    let hit = null;
    const q = m.question || '';

    // 1) Fed decision brackets
    let r = q.match(/^Will the Fed (decrease|increase) interest rates by (\d+)(\+?) bps after the (\w+) (\d{4}) meeting\?/i);
    let code = null, mon = null, yr = null;
    if (r) {
      const dir = r[1].toLowerCase() === 'decrease' ? 'C' : 'H';
      const bps = +r[2], plus = r[3] === '+';
      // Kalshi's two brackets are "25bps" and ">25bps" -- the second EXCLUDES 25. Polymarket's
      // "25+ bps" includes it, so it spans both and matches neither. It used to map to the >25
      // bracket, which resolves differently at exactly 25bps: the two legs of a "locked" arb would
      // then settle opposite ways on the single most likely outcome of a Fed meeting. A question
      // that spans two brackets has no counterpart here, and no pair is the right answer.
      //
      // "50+ bps" is the other way round, and it is the wording Polymarket actually lists: its rules
      // round any move UP to the nearest 25, so "50+" is every move over 25 -- exactly Kalshi's
      // ">25bps". Mapping it to nothing left the two biggest September legs unpaired ($4.0M and
      // $0.78M a day on 2026-09-15). An EXACT "50 bps" used to map to >25 and must not: a 75bp move
      // is Yes on Kalshi and No on Polymarket.
      code = bps === 25 && !plus ? `${dir}25` : bps === 50 && plus ? `${dir}26` : null;
      mon = r[4]; yr = r[5];
    } else if ((r = q.match(/no change in Fed interest rates after the (\w+) (\d{4}) meeting/i))) {
      code = 'H0'; mon = r[1]; yr = r[2];
    }
    if (code && mon && MON[mon.toLowerCase()]) {
      const mon3 = MON[mon.toLowerCase()];
      const k = ksByTicker.get(`KXFEDDECISION-${yr.slice(2)}${mon3}-${code}`);
      if (k) hit = { ks: k, tokenIndex: 0, kind: 'fed', label: `Fed ${mon3} ${yr.slice(2)} · ${k.subTitle}` };
    }

    // The figure guard, applied to each CANDIDATE rather than to the winner: a doubleheader lists
    // two Kalshi events for the same teams on the same date, and if game 1 is listed first, a
    // guard that ran only on the first name match would reject it and leave game 2 -- the right
    // row, sitting next to it -- unpaired for the whole scan. A candidate whose figures conflict is
    // skipped and the search goes on; the conflict is reported only if nothing else pairs. Fed
    // brackets are matched by CODE and Kalshi's label for a code is a range (">25bps" backs
    // Polymarket's "50 bps"), so the figures legitimately differ there and it is not checked.
    const conflictWith = (k) => figuresConflict(q, `${k.title} ${k.subTitle}`);
    let figRej = null, timeRej = null;

    // 2) Two-way moneylines: "A vs B" on PM  <->  Kalshi game/match event on the same ET date, same sport
    if (!hit && m.sport === 'moneyline' && m.outcomes.length === 2 && m.gameStart) {
      const d = etDate(m.gameStart);
      const [A, B] = m.outcomes;
      const sport = classify(m, A, B);
      const allowed = SPORT_SERIES[sport] || [];
      if (sport && d) pmListing.add(`${sport}|${d}`);
      // Kalshi dates a tennis match by the day it was scheduled, and the Asian swing plays overnight:
      // KXWTAMATCH-26SEP24BONRUS against a Polymarket start of 2026-09-25 04:30Z, which is 09-25 in
      // New York. So tennis also looks one ET day back; the name, figure and price guards still apply.
      const days = sport === 'tennis' && d ? [d, prevDay(d)] : [d];
      const found = [];
      for (const ms of days.flatMap((x) => byDate.get(x) || [])) {
        const ser = series(ms[0].ticker);
        if (!allowed.includes(ser)) continue;
        const sides = ms.filter((x) => !/^tie\b/i.test(x.subTitle) && !/^tie\b/i.test(x.title));
        if (sides.length !== 2) continue;
        const people = /MATCH/.test(ser); // tennis-style series carry player names
        const [pa, pb] = ser === 'KXNFLGAME' ? [nflFull(A), nflFull(B)] : [A, B];
        const ksName = (x) => (ser === 'KXMLBGAME' ? mlbName(x.subTitle) : x.subTitle);
        const ia = sides.findIndex((x) => nameMatch(ksName(x), pa, people));
        const ib = sides.findIndex((x) => nameMatch(ksName(x), pb, people));
        if (ia < 0 || ib < 0 || ia === ib) continue;
        const label = `${TAG[ser] || ser} ${short(A)} v ${short(B)} · ${short(A)}`;
        const conflict = conflictWith(sides[ia]);
        if (conflict) { figRej = { label, detail: conflict, ks: sides[ia].title }; continue; }
        found.push({ ks: sides[ia], label });
      }
      // Chosen here, before the one-ticker-one-pair check below, so each game of a doubleheader
      // reaches its own event whichever order either venue lists them in (see pickByStart).
      const pick = pickByStart(found, startMs(m.gameStart));
      if (pick.hit) hit = { ks: pick.hit.ks, tokenIndex: 0, kind: 'game', label: pick.hit.label };
      else if (pick.rej) timeRej = { label: pick.rej.label, detail: pick.rej.detail, ks: pick.rej.ks.title };
    }

    // 3) "Will X win on YYYY-MM-DD?" (PM soccer style)  <->  Kalshi 3-way soccer market (event has a Tie leg)
    if (!hit && (r = q.match(/^Will (.+?) win on (\d{4}-\d{2}-\d{2})\?$/))) {
      pmListing.add(`soccer|${r[2]}`);
      for (const ms of byDate.get(r[2]) || []) {
        const ser = series(ms[0].ticker);
        if (!SPORT_SERIES.soccer.includes(ser)) continue;
        if (!ms.some((x) => /^tie\b/i.test(x.subTitle) || /^tie\b/i.test(x.title))) continue;
        const k = ms.find((x) => !/^tie\b/i.test(x.subTitle) && nameMatch(x.subTitle, r[1]));
        if (!k) continue;
        // The OPPONENT has to match too. A PM question names one club, and one club name is not
        // an identity: "Everton" is a prefix of "Everton de Viña del Mar", so on 2026-09-12 a
        // Chilean Primera match paired with Kalshi's Tottenham v Everton (EPL). Booked as a locked
        // arb, it was two unrelated bets that both lost -- ~$198 on a 224-lot -- and because this
        // loop takes the first PM market to claim a Kalshi ticker, it also blocked the real
        // "Will Everton FC win" market from pairing. The event title carries both sides ("A vs.
        // B"), so require each non-tie Kalshi leg to name a DIFFERENT side of it.
        const sides = String(m.eventTitle || '').split(/\s+vs\.?\s+/i);
        const other = ms.find((x) => x !== k && !/^tie\b/i.test(x.subTitle));
        const sideK = sides.length === 2 ? sides.findIndex((s) => nameMatch(k.subTitle, s)) : -1;
        const sideO = other && sideK >= 0 ? sides.findIndex((s, i) => i !== sideK && nameMatch(other.subTitle, s)) : -1;
        if (sideK < 0 || sideO < 0) continue;
        const label = `${TAG[ser] || ser} ${short(r[1])} win ${r[2].slice(5)}`;
        const conflict = conflictWith(k);
        if (conflict) { figRej = { label, detail: conflict, ks: k.title }; continue; }
        hit = { ks: k, tokenIndex: 0, kind: 'game', label };
        break;
      }
    }

    if (!hit) {
      if (timeRej) rejected.push({ ...timeRej, why: 'start time', pm: q });
      else if (figRej) rejected.push({ ...figRej, why: 'figures', pm: q });
      continue;
    }
    if (usedKs.has(hit.ks.ticker)) continue;
    // An empty Kalshi book is not a price. It comes back as bid 0 / ask 1 -- a mid of exactly 50c --
    // and the 30c agreement guard below would pair that with any Polymarket market priced 20-80c.
    if (!(hit.ks.yesBid > 0 && hit.ks.yesAsk < 1)) continue;

    // sanity: venues should roughly agree; a 30c+ disagreement means we matched the wrong thing
    // Validate the LEGS, not the average. `null + null` is 0 in JS and Number.isFinite(0) is true,
    // so an entirely unpriced market used to arrive here as a confident mid of zero and pair with
    // anything Kalshi priced under 30c -- the one correctness guard in this file, passing on a
    // market that had no price at all.
    const legs = [m.bestBid, m.bestAsk, hit.ks.yesBid, hit.ks.yesAsk];
    if (!legs.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const pmMid = (m.bestBid + m.bestAsk) / 2;
    const ksMid = (hit.ks.yesBid + hit.ks.yesAsk) / 2;
    if (Math.abs(pmMid - ksMid) > MAX_VENUE_DISAGREE) { rejected.push({ label: hit.label, why: 'price', pm: m.question, ks: hit.ks.title, pmMid, ksMid }); continue; }

    usedKs.add(hit.ks.ticker);
    pairs.push({
      id: `${m.id}:${hit.tokenIndex}|${hit.ks.ticker}`,
      label: hit.label,
      kind: hit.kind,
      series: series(hit.ks.ticker),
      startsAt: hit.kind === 'game' ? startMs(m.gameStart) : null,
      // When the Kalshi market stops trading, and when its answer is expected (decide.liveWindow,
      // the close-guard exit, and the arb's lock-up all read these)
      closesAt: startMs(hit.ks.closeTime),
      settlesAt: startMs(hit.ks.expectedExpiration) ?? startMs(hit.ks.closeTime),
      pm: { id: m.id, tokenIndex: hit.tokenIndex, tokenId: m.tokenIds[hit.tokenIndex], question: m.question, url: m.url },
      ks: { ticker: hit.ks.ticker, title: hit.ks.title, eventTicker: hit.ks.eventTicker, url: hit.ks.url },
    });
  }
  // ---------------------------------------------------------------- coverage
  // A name that does not match is not a rejection -- almost every comparison in the loop above is
  // between two unrelated markets, and logging those would bury the scan. But a whole LEAGUE that
  // pairs nothing, on a date Polymarket is listing that sport for, is the shape of a naming change,
  // and that has no voice at all: when Kalshi said "Minnesota" and Polymarket said "Vikings", the
  // NFL paired zero games for a season and produced no reject, no log line and no number anywhere.
  // Counted per series per date, so the caller can say which league went quiet rather than only
  // that the total moved.
  const coverage = new Map();
  for (const [ev, ms] of events) {
    const ser = series(ms[0].ticker);
    const sport = SPORT_KEY[ser];
    const d = tickerDate(ev);
    if (!sport || !d || !pmListing.has(`${sport}|${d}`)) continue;
    const key = `${ser}|${d}`;
    if (!coverage.has(key)) coverage.set(key, { series: ser, league: TAG[ser] || ser, date: d, events: 0, matched: 0 });
    const c = coverage.get(key);
    c.events++;
    if (ms.some((x) => usedKs.has(x.ticker))) c.matched++;
  }
  return { pairs, rejected, coverage: [...coverage.values()] };
}

module.exports = { matchPairs, nameMatch, tickerDate, tickerStartMs, etDate, figures, figuresConflict, MAX_VENUE_DISAGREE };

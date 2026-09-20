'use strict';
// The same outcome on Polymarket and Kalshi, in any category. Pure: records in, candidates out.
//
// src/matcher.js knows three shapes (Fed brackets, moneylines, soccer). Everything else is paired
// here, from the records src/discovery.js crawls, in four steps:
//   1. recall   score every Polymarket event against Kalshi events by shared rare words
//   2. gates    reject event pairs that differ in kind: a different year or month, highest vs lowest
//               temperature, nominee vs winner, #1 vs runner-up, core vs headline, US vs global ...
//   3. align    pair individual outcomes inside a surviving event pair, by one of
//                 interval  the same numeric range on the statistic's tick ("4.0% or more" = Above 3.9%)
//                 deadline  the same last day ("by September 30" = "Before Oct 1, 2026")
//                 names     the same person, party, team or title ("Ashley Hinson (R)" = "Ashley Hinson")
//                 binary    one live market on each side
//   4. dedupe   one Polymarket market per Kalshi ticker and back, best score wins
//
// Precision over recall, always. A wrong pair that clears the rules gate books a "locked arb" that
// is two unrelated bets -- the desk already paid for that once (Everton v Everton de Vina del Mar,
// 2026-09-12). A one-tick difference on a threshold ("dip below 4.67%" vs "4.67% or below") is a
// rejection, not a pair: 33 such Treasury near-misses priced within 3.5c of the real ones.
// Whether the two contracts' RULES settle the same is src/rules.js's question, not this file's.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MON3 = MONTHS.map((m) => m.slice(0, 3));
const STOP = new Set(('will the a an of in on by to for and or be is at as with from this that who what which when how than than ' +
  'win wins winner market markets price yes no before after end year next new top vs versus between above below over under more less least most ' +
  'kalshi polymarket question event outcome resolve resolves happen does do did any').split(/\s+/));
// Cyrillic letters that print like Latin ones ("Аndrey Gyurov" arrived with a Cyrillic A).
const HOMO = { 'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'к': 'k', 'м': 'm', 'т': 't', 'в': 'b', 'н': 'h', 'і': 'i' };
const STATES = { alabama: 'al', alaska: 'ak', arizona: 'az', arkansas: 'ar', california: 'ca', colorado: 'co', connecticut: 'ct', delaware: 'de', florida: 'fl', georgia: 'ga', hawaii: 'hi', idaho: 'id', illinois: 'il', indiana: 'in', iowa: 'ia', kansas: 'ks', kentucky: 'ky', louisiana: 'la', maine: 'me', maryland: 'md', massachusetts: 'ma', michigan: 'mi', minnesota: 'mn', mississippi: 'ms', missouri: 'mo', montana: 'mt', nebraska: 'ne', nevada: 'nv', 'new hampshire': 'nh', 'new jersey': 'nj', 'new mexico': 'nm', 'new york': 'ny', 'north carolina': 'nc', 'north dakota': 'nd', ohio: 'oh', oklahoma: 'ok', oregon: 'or', pennsylvania: 'pa', 'rhode island': 'ri', 'south carolina': 'sc', 'south dakota': 'sd', tennessee: 'tn', texas: 'tx', utah: 'ut', vermont: 'vt', virginia: 'va', washington: 'wa', 'west virginia': 'wv', wisconsin: 'wi', wyoming: 'wy' };

function norm(s) {
  let t = String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
  t = t.replace(/[аеорсухкмтвні]/g, (c) => HOMO[c] || c);
  t = t.replace(/&/g, ' and ').replace(/\bu\.s\.a?\b|\bunited states( of america)?\b|\busa\b/g, ' us ')
    .replace(/\bnyc\b|\bnew york city\b/g, ' new york ').replace(/\bzelenskyy\b/g, 'zelensky')
    .replace(/\bacademy awards?\b|\bacademy\b/g, ' oscars ').replace(/\bgop\b/g, ' republican ').replace(/\bfed(eral reserve)?\b/g, ' fed ')
    .replace(/\bpmqs?\b/g, ' prime minister questions ').replace(/['\u2019]/g, '')
    // the same statistic in each venue's words: "CPI YoY" is "annual inflation"
    .replace(/\byoy\b|year[- ]over[- ]year|12-month|twelve months/g, ' annual ').replace(/\bmom\b|month[- ]over[- ]month/g, ' monthly ')
    .replace(/\bcpi\b|consumer price index/g, ' inflation ').replace(/\bu-?3\b/g, ' unemployment ')
    .replace(new RegExp(`\\b(${MON3.join('|')})\\.?(?=\\s|\\d|$)`, 'g'), (m0, mo) => MONTHS[MON3.indexOf(mo)])
    .replace(/\bdemocrat(ic|s)?\b/g, 'democrat').replace(/\brepublican(s)?\b|\bgop\b/g, 'republican')
    .replace(/(\w)\.(?=\w\.)/g, '$1').replace(/\b(\w)\.(\w)\.?/g, '$1$2');   // J.D. -> jd
  return t;
}
const toks = (s) => norm(s).replace(/[^a-z0-9%.\- ]+/g, ' ').replace(/(?<![\d])[.\-]|[.\-](?![\d])/g, ' ').split(/\s+/)
  .map((w) => (w.length > 4 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w))
  .filter((w) => w && !STOP.has(w) && !/^\d+(\.\d+)?%?$/.test(w));

// ---------------------------------------------------------------- numbers and intervals
const numOf = (s) => {
  const m = String(s).replace(/,/g, '').match(/(-?\d+(?:\.\d+)?)\s*(k|m|b|t|bn|million|billion|thousand|trillion)?\b/i);
  if (!m) return null;
  const mult = { k: 1e3, thousand: 1e3, m: 1e6, million: 1e6, b: 1e9, bn: 1e9, billion: 1e9, t: 1e12, trillion: 1e12 }[String(m[2] || '').toLowerCase()] || 1;
  return { v: +m[1] * mult, dec: mult === 1 && m[1].includes('.') ? m[1].split('.')[1].length : 0 };
};
// A Kalshi floor written one tick under a round number (77999.99, 4.99 for "5% or above") is that
// round number, inclusive. Anything else is itself.
function roundish(x) {
  const r = Math.round(x);
  return Math.abs(x - r) > 0 && Math.abs(x - r) <= 0.0101 ? r : null;
}
// Inclusive bounds on a tick lattice, as integers of ticks, so equality is exact.
const onTick = (v, tick) => Math.round(v / tick);

// A Polymarket outcome label (or question) as { lo, hi, dec } in real units, inclusive, or null.
function pmInterval(label, tieHigher) {
  const s = String(label || '').replace(/,/g, '').replace(/–|—/g, '-').trim();
  if (!/\d/.test(s)) return null;
  let m;
  const n = (x) => numOf(x);
  if ((m = s.match(/^[<≤]\s*\$?(-?[\d.]+\s*[kmbt]?)|^(?:under|below|less than|lower than)\s+\$?(-?[\d.]+\s*[kmbt]?)|\$?(-?[\d.]+\s*[kmbt]?)[%°a-z]*\s+or (?:less|below|lower|fewer)/i))) {
    const x = n(m[1] || m[2] || m[3]); if (!x) return null;
    const strict = /^</.test(s) || /^(under|below|less than|lower than)/i.test(s);
    return { lo: -Infinity, hi: x.v, hiStrict: strict, dec: x.dec };
  }
  if ((m = s.match(/^[>≥↑]\s*\$?(-?[\d.]+\s*[kmbt]?)|^(?:at least|over|above|more than|higher than)\s+\$?(-?[\d.]+\s*[kmbt]?)|\$?(-?[\d.]+\s*[kmbt]?)[%°a-z]*\s*(?:\+|or (?:more|above|higher|greater))/i))) {
    const x = n(m[1] || m[2] || m[3]); if (!x) return null;
    const strict = /^>/.test(s) || /^(over|above|more than|higher than)/i.test(s);
    return { lo: x.v, loStrict: strict, hi: Infinity, dec: x.dec };
  }
  if ((m = s.match(/^\$?(-?[\d.]+\s*[kmbt]?)[%°a-z]*\s*(?:-|to)\s*\$?(-?[\d.]+\s*[kmbt]?)[%°a-z]*$/i))) {
    const a = n(m[1]), b = n(m[2]); if (!a || !b) return null;
    return { lo: a.v, hi: b.v, hiStrict: !!tieHigher, dec: Math.max(a.dec, b.dec) };
  }
  if ((m = s.match(/^\$?(-?[\d.]+\s*[kmbt]?)\s*(%|°[fc]?|bps?)?$/i))) {
    const x = n(m[1]); if (!x) return null;
    return { lo: x.v, hi: x.v, dec: x.dec, exact: true };
  }
  return null;
}

// A Kalshi market as the same inclusive interval, from its strike fields where they exist.
function ksInterval(k) {
  const t = String(k.strikeType || '');
  const f = Number.isFinite(k.floorStrike) ? k.floorStrike : null, c = Number.isFinite(k.capStrike) ? k.capStrike : null;
  const dec = (x) => (x == null ? 0 : (String(x).split('.')[1] || '').replace(/9+$/, '').length);
  const rules = String(k.rulesPrimary || '');
  // Kalshi's strike_type can contradict its own rules ("at least" with type greater): the rules win --
  // but only words about THIS number. "more than 7 hurricanes of category 1 or above" is strict about
  // the 7; reading its "or above" as inclusive paired it with Polymarket's "7+".
  const aboutFloor = (x) => { const v = parseFloat(String(x).replace(/,/g, '')); return Number.isFinite(v) && f != null && Math.abs(v - f) < 1e-9; };
  let inclusiveWords = false;
  for (const m of rules.matchAll(/\b(?:at least|no less than|greater than or equal to|equal to or (?:greater than|above))\s*\$?(-?[\d,]*\.?\d+)/gi)) if (aboutFloor(m[1])) inclusiveWords = true;
  for (const m of rules.matchAll(/\$?(-?[\d,]*\.?\d+)\s*%?\s*(?:or more|or above|or higher|or greater)\b/gi)) if (aboutFloor(m[1])) inclusiveWords = true;
  if (t === 'between' && f != null && c != null) return { lo: f, hi: c, dec: Math.max(dec(f), dec(c)) };
  if ((t === 'greater' || t === 'greater_or_equal') && f != null) {
    const r = roundish(f);
    if (r != null && t === 'greater') return { lo: r, hi: Infinity, dec: 0 };
    return { lo: f, loStrict: t === 'greater' && !inclusiveWords, hi: Infinity, dec: dec(f) };
  }
  if ((t === 'less' || t === 'less_or_equal') && c != null) return { lo: -Infinity, hi: c, hiStrict: t === 'less', dec: dec(c) };
  const label = String(k.yesSubTitle || k.subTitle || '');
  const ex = label.match(/^exactly\s+(-?[\d.,]+)/i);
  if (ex) { const x = numOf(ex[1]); return x && { lo: x.v, hi: x.v, dec: x.dec, exact: true }; }
  const i = pmInterval(label.replace(/^above\s/i, '> ').replace(/^below\s/i, '< '));
  return i;
}

// Two intervals on one lattice; the tick is the finer of the two sides' published precision.
function sameInterval(a, b) {
  const dec = Math.max(a.dec || 0, b.dec || 0, 0);
  const tick = Math.pow(10, -Math.min(dec, 4));
  const bound = (v, strict, dir) => (Number.isFinite(v) ? onTick(v, tick) + (strict ? dir : 0) : v);
  const A = [bound(a.lo, a.loStrict, 1), bound(a.hi, a.hiStrict, -1)];
  const B = [bound(b.lo, b.loStrict, 1), bound(b.hi, b.hiStrict, -1)];
  if (A[0] === B[0] && A[1] === B[1]) return 'same';
  const off = (x, y) => Number.isFinite(x) && Number.isFinite(y) && Math.abs(x - y) === 1;
  if ((A[0] === B[0] && off(A[1], B[1])) || (A[1] === B[1] && off(A[0], B[0]))) return 'tick';
  // complements: (-inf, x] against [x+1, inf)
  if ((A[0] === -Infinity && B[1] === Infinity && B[0] === A[1] + 1) || (B[0] === -Infinity && A[1] === Infinity && A[0] === B[1] + 1)) return 'complement';
  return null;
}

// ---------------------------------------------------------------- deadlines
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
function addDays(s, n) { const t = new Date(`${s}T12:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); }
const monthIdx = (w) => { const i = MON3.indexOf(String(w).slice(0, 3).toLowerCase()); return i < 0 ? null : i + 1; };
// The last included day of a deadline, as YYYY-MM-DD, or null.
function pmDeadline(label, question, endDate) {
  const s = `${label || ''}`.trim() || String(question || '').replace(/^.*\bby\s+/i, '');
  // The year of a bare "September 30": "before 2027" in the question means 2026; otherwise the
  // market's own end date (less half a day, since 04:59Z on Jan 1 is still Dec 31 in New York); a year
  // written in the question last. Reading "before 2027" as 2027 paired "aliens confirmed before 2027"
  // with Kalshi's "Before 2028".
  const before = String(question || '').match(/\bbefore (20\d{2})\b/i);
  const endYear = endDate && Number.isFinite(Date.parse(endDate)) ? new Date(Date.parse(endDate) - 12 * 3600000).getUTCFullYear() : null;
  const yearHint = before ? +before[1] - 1 : endYear || Number((String(question || '').match(/\b(20\d{2})\b/) || [])[1]) || null;
  let m = s.match(/^(?:by\s+)?(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s*(20\d{2}))?\??$/i);
  if (m) { const y = +m[3] || yearHint; return y ? ymd(y, monthIdx(m[1]), +m[2]) : null; }
  if (!label) {
    // "before 2027" ends on Dec 31 2026; "by the end of 2026" and "in 2026" end on Dec 31 2026
    const q = String(question || '');
    if ((m = q.match(/\bbefore (20\d{2})\b/i))) return ymd(+m[1] - 1, 12, 31);
    if ((m = q.match(/\bby (?:the )?end of (20\d{2})\b|\bin (20\d{2})\?$/i))) return ymd(+(m[1] || m[2]), 12, 31);
  }
  return null;
}
function ksDeadline(label) {
  const s = String(label || '').trim();
  let m = s.match(/^before\s+(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s*(20\d{2})$/i);
  if (m) return addDays(ymd(+m[3], monthIdx(m[1]), +m[2]), -1);
  m = s.match(/^before\s+(20\d{2})$/i);
  if (m) return ymd(+m[1] - 1, 12, 31);
  return null;
}

// ---------------------------------------------------------------- names
function nameToks(s) {
  return norm(String(s || '').replace(/\([^)]*\)/g, ' ').replace(/\s+-\s+.*$/, ' '))
    .replace(/\b(sen|rep|gov|dr|mr|mrs|ms|president|senator|governor)\b\.?/g, ' ')
    .replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !['the', 'of', 'and', 'party'].includes(w));
}
function lev(a, b) {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
function namesMatch(a, b) {
  const A = nameToks(a).filter((w) => w.length > 1 || /^[a-z]$/.test(w)), B = nameToks(b).filter((w) => w.length > 1 || /^[a-z]$/.test(w));
  if (!A.length || !B.length) return false;
  const drop1 = (x) => (x.length >= 3 ? x.filter((w, i) => !(w.length === 1 && i > 0 && i < x.length - 1)) : x);   // middle initials
  const X = drop1(A), Y = drop1(B);
  if (X.length === 1 || Y.length === 1) return X.length === Y.length && X[0] === Y[0];
  const cover = (P, Q) => P.every((p) => Q.some((q) => q === p || (p.length >= 3 && q.startsWith(p)) || (q.length >= 3 && p.startsWith(q))));
  if (cover(X, Y) && cover(Y, X)) return true;
  // transliteration: the same first name and a surname one edit apart (Iotova / Yotova)
  return X.length === Y.length && X.length >= 2 && X[0] === Y[0] && X.slice(1, -1).join(' ') === Y.slice(1, -1).join(' ')
    && X[X.length - 1].length >= 5 && lev(X[X.length - 1], Y[Y.length - 1]) === 1;
}
// ---------------------------------------------------------------- two named outcomes (fights)
// Everything else in this file pairs one Kalshi market to one Polymarket YES, on token 0. A fight
// is not that shape: Polymarket lists it as ONE market whose two OUTCOMES are the fighters
// ("Alexandre Pantoja" / "Joshua Van"), and Kalshi lists it as TWO markets, "Alexandre Pantoja
// wins" and "Joshua Van wins". So the generic path cannot see it twice over -- the Polymarket side
// has no groupItemTitle to match a name against, and the loser's leg lives on token 1, which no
// candidate was ever built for. UFC 331 on 2026-09-19 was eight fights on both venues and matched
// nothing at all.
// A pair of outcomes qualifies only when BOTH are real names: Yes/No, Over/Under and Draw/Tie are
// the ordinary binary shapes and belong to the generic path, which already knows their polarity.
const YESNO = /^(yes|no|over|under|draw|tie|none|other)$/i;
function namedOutcomes(p) {
  const o = Array.isArray(p && p.outcomes) ? p.outcomes : null;
  if (!o || o.length !== 2) return null;
  if (o.some((x) => !x || YESNO.test(String(x).trim()))) return null;
  return o.map((x) => String(x));
}

// "R Senate, D House" and "D-House, R-Senate" are the same combination.
function combo(s) {
  const t = norm(s);
  const parts = [...t.matchAll(/\b(d|r|democrat|republican)\b[\s-]*(house|senate)|\b(house|senate)[\s-]*(d|r|democrat|republican)\b/g)]
    .map((m) => `${(m[1] || m[4])[0]}-${m[2] || m[3]}`);
  return parts.length >= 2 ? parts.sort().join(',') : null;
}

// ---------------------------------------------------------------- event gates
const FAMILIES = [
  ['high temperature', /\b(highest|high|max(imum)?) temp/], ['low temperature', /\b(lowest|low|min(imum)?) temp/],
  ['tweets', /\btweet|\bposts? on x\b|# ?of posts/], ['nominee', /\bnomin/], ['vice president', /\bvice president|\bvp\b/],
  // the same leaderboard or person, a different question about it
  ['supporting', /\bsupporting\b/], ['coding', /\bcoding\b/], ['image', /\bimage\b/], ['video', /\bvideo\b/], ['open source', /open[- ]source/], ['weekly', /\bthis week\b|\bweekly\b/],
  ['visit', /\bvisit|\benter\b|\btravel to\b/], ['recognize', /\brecogni/],
  ['run for office', /\brun for\b|\bwill run\b|\bdeclare|announce (a|their|his|her) (presidential )?(run|candidacy)/], ['first of a list', /\bbe first\b|\bfirst (on this list|of these|to)\b/],
  ['release', /\breleas/], ['leave office', /\bout (as|by|before)\b|\bout\?|\bleave (office|as)\b|\bresign|\bstep(s)? down|\bdepart/],
  ['state legislature', /\bstate (senate|house|legislat)|\bassembly\b/], ['first round', /\bfirst round\b/], ['runoff', /\brunoff|run-off|second round/],
  ['margin', /\bmargin\b/], ['turnout', /\bturnout\b/], ['vote share', /\bvote share|% of (the )?(popular )?vote|valid (second )?votes/], ['seats', /\bseats?\b/],
  ['core', /\bcore\b/], ['monthly change', /month[- ]over[- ]month|\bmom\b|\bmonthly\b/], ['annual change', /year[- ]over[- ]year|\byoy\b|\bannual\b|12-month/],
  ['pce', /\bpce\b/], ['ppi', /\bppi\b|producer price/], ['unemployment', /unemploy|\bu-?3\b/], ['payrolls', /payroll|jobs added|nonfarm/],
  ['gdp', /\bgdp\b/], ['dissent', /\bdissent/], ['mentions', /\bsay\b|\bmention/], ['count', /how many|number of|# of/],
  ['hit', /\bhit\b|\breach\b|\bdip\b|how high|how low/], ['close', /\bclose[sd]?\b|\bsettle/], ['up or down', /up or down/],
  ['ipo', /\bipo\b/], ['acquire', /acquir|merger/], ['approval', /\bapproval\b/], ['popular vote', /popular vote/],
  ['electoral college', /electoral/], ['party switch', /\bleave the (democrat|republican)|switch part/], ['pardon', /\bpardon/], ['arrest', /\barrest|indict/],
];
// A rank other than first, normalized to a word so "third-place", "3rd" and "3 place" agree.
const RANK_WORD = { 2: 'second', 3: 'third', 4: 'fourth', 5: 'fifth', 6: 'sixth', second: 'second', third: 'third', fourth: 'fourth', fifth: 'fifth', sixth: 'sixth', 'runner-up': 'second', 'runner up': 'second' };
function rankOf(t) {
  const m = t.match(/#\s*([2-9])\b|\b([2-9])(?:st|nd|rd|th)?[- ]place\b|\bfinish(?:es)?(?: in)? ([2-9])(?:st|nd|rd|th)?\b|\b([2-9])(?:nd|rd|th)\b|\b(second|third|fourth|fifth|sixth|runner[- ]up)\b|\btop[- ]?(\d+|three|five|ten)\b/);
  if (!m) return null;
  if (m[6]) return `top ${m[6]}`;
  return RANK_WORD[m[1] || m[2] || m[3] || m[4] || m[5]] || null;
}
const SCOPE = /\b(global|worldwide)\b/;
const yearsOf = (s) => new Set((String(s).match(/\b20\d{2}\b/g) || []));
const monthsOf = (s) => new Set((norm(s).match(new RegExp(`\\b(${MONTHS.join('|')}|${MON3.join('|')})\\b`, 'g')) || []).map((m) => m.slice(0, 3)));
const disjoint = (a, b) => a.size && b.size && ![...a].some((x) => b.has(x));

function eventGate(pmText, ksText) {
  const a = norm(pmText), b = norm(ksText);
  for (const [name, re] of FAMILIES) if (re.test(a) !== re.test(b)) return { why: 'family', detail: name };
  const ra = rankOf(a), rb = rankOf(b);
  if (ra !== rb) return { why: 'rank', detail: `${ra || 'first'} vs ${rb || 'first'}` };
  if (SCOPE.test(a) !== SCOPE.test(b) && /\b(spotify|netflix|google|youtube|billboard|chart|search)\b/.test(`${a} ${b}`)) return { why: 'scope', detail: 'global vs US' };
  if (disjoint(yearsOf(pmText), yearsOf(ksText))) return { why: 'figures', detail: `years ${[...yearsOf(pmText)]} vs ${[...yearsOf(ksText)]}` };
  return null;
}

// Proper nouns in the Polymarket question that the Kalshi side never mentions: "the highest score by
// an OpenAI model" is not "any model", and "Xi out" is not "Xi visits Taiwan". Capitalised words
// only, not the outcome itself (that was matched on its own), not the first word, and not the words
// every market uses.
const COMMON_CAPS = new Set(('will who what which when how the a an us u.s senate house president presidential election elections party ' +
  'democrat democrats democratic republican republicans governor mayor prime minister midterm midterms time person year award awards ' +
  'best winner nominee yes no market official officially january february march april may june july august september october november ' +
  'december jan feb mar apr jun jul aug sep sept oct nov dec et est edt pm am north south east west new city season final ' +
  'u.s. america american united states kalshi polymarket federal reserve inc inc. corp die der la le los the and or control').split(/\s+/));
function missingEntity(question, label, ksText) {
  const labelToks = new Set(nameToks(label));
  const ks = new Set(norm(ksText).replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter(Boolean));
  const words = String(question || '').replace(/["\u201c\u201d]/g, ' ').split(/\s+/).slice(1);
  for (const raw of words) {
    if (!/^[A-Z\u00c0-\u024f][\w\u00c0-\u024f'.-]{2,}/.test(raw)) continue;
    const w = norm(raw).replace(/[^a-z0-9]+/g, '');
    if (w.length < 3 || COMMON_CAPS.has(w) || labelToks.has(w) || /^\d/.test(w)) continue;
    const stem = w.replace(/s$/, '');
    // same word, a plural, or a shared stem of six letters (Argentina / Argentine, Presidency / Presidential)
    const shared = (x, y) => { let i = 0; while (i < x.length && i < y.length && x[i] === y[i]) i++; return i; };
    if (![...ks].some((k) => k === w || k === stem || (stem.length >= 4 && k.startsWith(stem)) || (k.length >= 4 && stem.startsWith(k)) || shared(k, w) >= 6)) return raw;
  }
  return null;
}

// ---------------------------------------------------------------- the matcher
const OTHER = /^(other|others|none|no one|nobody|-?no qualifying event-?|someone else|any other|no new|not listed)\b/i;

// Bare numbers that name a thing ("iPhone 18", "Starship Flight Test 14", "UFC 331"), with years,
// month-day dates, percentages and money taken out first. A pair whose titles carry different ones
// is two different things, however alike the rest reads.
function nameNumbers(s) {
  const t = norm(s).replace(new RegExp(`\\b(${MONTHS.join('|')})\\s+\\d{1,2}(st|nd|rd|th)?\\b`, 'g'), ' ')
    .replace(/\b20\d{2}\b/g, ' ').replace(/\$?\d[\d,.]*\s*(%|k|m|bn|b|million|billion|bps?|°f?|degrees)/g, ' ')
    .replace(/#\s*\d+|\b\d+(st|nd|rd|th)?[- ]place\b/g, ' ');   // ranks are the rank gate's business
  return new Set((t.match(/(?<![\w.$-])\d{1,4}(?![\w.%-])/g) || []));
}

function matchAny(pmMarkets, ksMarkets, opts = {}) {
  const t0 = Date.now();
  const minScore = opts.minScore ?? 0.34;
  const topEvents = opts.topEvents ?? 6;
  const maxDf = opts.maxDf ?? 400;

  // group into events
  const ksEv = new Map();
  for (const k of ksMarkets) {
    if (!k || !k.ticker) continue;
    let e = ksEv.get(k.eventTicker);
    if (!e) { e = { key: k.eventTicker, text: `${k.eventTitle || ''} ${k.eventSubTitle || ''}`, markets: [] }; ksEv.set(k.eventTicker, e); }
    e.markets.push(k);
  }
  const pmEv = new Map();
  for (const p of pmMarkets) {
    if (!p || !p.id || p.negRiskOther) continue;
    const key = p.eventId || p.id;
    let e = pmEv.get(key);
    if (!e) { e = { key, text: p.eventTitle || p.question, markets: [] }; pmEv.set(key, e); }
    e.markets.push(p);
  }
  // Kalshi event text: its title plus the first market's title, because event titles are terse
  // ("Iowa Senate winner?") where the market says what is actually asked.
  const ksList = [...ksEv.values()];
  const df = new Map();
  for (const e of ksList) {
    e.fullText = `${e.text} ${e.markets[0].title || ''}`;
    e.toks = new Set(toks(e.fullText));
    for (const w of e.toks) df.set(w, (df.get(w) || 0) + 1);
  }
  const N = ksList.length || 1;
  const idf = (w) => Math.log(1 + N / (1 + (df.get(w) || 0)));
  const index = new Map();
  ksList.forEach((e, i) => { for (const w of e.toks) if ((df.get(w) || 0) <= maxDf) (index.get(w) || index.set(w, []).get(w)).push(i); });

  const candidates = [], rejected = [];
  const stats = { pmEvents: pmEv.size, ksEvents: ksEv.size, eventPairs: 0, byHow: {}, byCategory: {}, rejects: {} };
  const reject = (pm, ks, why, detail) => { rejected.push({ pmId: pm.id, ksTicker: ks.ticker, why, detail }); stats.rejects[why] = (stats.rejects[why] || 0) + 1; };

  for (const pe of pmEv.values()) {
    const single = pe.markets.length === 1;
    // Scored two ways, keeping the better: the event title alone (a multi-outcome event's questions each
    // name a different candidate, which only dilutes it), and the title with one question (Polymarket
    // titles can be as terse as Kalshi's: "September Inflation US - Annual").
    const pText = single ? `${pe.text} ${pe.markets[0].question || ''}` : pe.text;
    const variants = [new Set(toks(pe.text)), new Set(toks(`${pe.text} ${pe.markets[0].question || ''}`))].filter((x) => x.size);
    if (!variants.length) continue;
    const best = new Map();
    for (const pt of variants) {
      const scores = new Map();
      for (const w of pt) for (const i of index.get(w) || []) scores.set(i, (scores.get(i) || 0) + idf(w));
      const pw = [...pt].reduce((a, w) => a + idf(w), 0);
      for (const [i, shared] of scores) {
        const e = ksList[i];
        if (e.weight == null) e.weight = [...e.toks].reduce((a, w) => a + idf(w), 0);
        const sc = shared / (pw + e.weight - shared);
        if (!best.has(i) || sc > best.get(i)) best.set(i, sc);
      }
    }
    const ranked = [...best.entries()].map(([i, score]) => ({ e: ksList[i], score }))
      .filter((x) => x.score >= minScore).sort((a, b) => b.score - a.score).slice(0, topEvents);

    for (const { e: ke, score } of ranked) {
      const gate = eventGate(`${pText} ${pe.markets[0].question || ''}`, ke.fullText);
      if (gate) { reject(pe.markets[0], ke.markets[0], gate.why, gate.detail); continue; }
      stats.eventPairs++;
      const tieHigher = /exactly between two brackets[^.]*higher/i.test(pe.markets[0].description || '');
      for (const p of pe.markets) {
        const pLabel = p.groupItemTitle || '';
        if (OTHER.test(pLabel.trim())) { if (ke.markets.length) reject(p, ke.markets[0], 'other-bucket', pLabel); continue; }

        // The fight shape: two named Polymarket outcomes against the Kalshi event's two legs. Each
        // leg becomes its own candidate on its own token, so both sides of the fight are priced.
        // The gate is deliberately narrow and needs no help from missingEntity: BOTH Kalshi legs
        // must name a fighter, and they must name DIFFERENT ones. That rules out an event whose
        // legs are not the two sides of one contest, and it is stronger than the generic proper-noun
        // check would be here -- which would fail this shape anyway, rejecting "Flyweight" and "Main
        // Card" as entities Kalshi never mentions, when they describe the bout and not the outcome.
        const named = namedOutcomes(p);
        if (named && ke.markets.length === 2) {
          const legs = [];
          for (const k of ke.markets) {
            const kLabel = k.yesSubTitle || k.subTitle || '';
            const i = named.findIndex((o) => namesMatch(o, kLabel));
            if (i >= 0) legs.push({ k, i });
          }
          if (legs.length === 2 && legs[0].i !== legs[1].i) {
            // "UFC 331" must not pair with "UFC 332": the card number is on both event titles.
            const pn = nameNumbers(`${pe.text} ${p.question || ''}`), kn = nameNumbers(ke.fullText);
            const onlyOne = [...pn].filter((x) => !kn.has(x)).concat([...kn].filter((x) => !pn.has(x)));
            if (onlyOne.length) { reject(p, legs[0].k, 'figures', `numbers ${[...pn]} vs ${[...kn]}`); continue; }
            for (const { k, i } of legs) {
              candidates.push({
                id: `${p.id}:${i}|${k.ticker}`, pm: p, ks: k, tokenIndex: i, how: 'outcomes',
                score: Math.round((score + 0.5) * 1000) / 1000,
                label: makeLabel(pe.text, p, k), category: k.category || null, series: k.seriesTicker || null,
                rulesKey: `${p.rulesHash || ''}:${k.rulesHash || ''}`,
              });
            }
            continue;
          }
        }

        let best = null;
        for (const k of ke.markets) {
          const kLabel = k.yesSubTitle || k.subTitle || '';
          let how = null;
          // month named on each side must agree (September CPI is not October CPI)
          const pm = monthsOf(`${p.question} ${pe.text}`), km = monthsOf(`${ke.text} ${k.title}`);
          const pi = pmInterval(pLabel, tieHigher) || (single ? pmInterval((p.question || '').replace(/^.*?\b(be|at|reach|hit|above|below|over|under)\b\s*/i, '').replace(/\s+(in|on|by|for|during)\s.*$/i, '').replace(/\?$/, ''), tieHigher) : null);
          const ki = ksInterval(k);
          const pd = pmDeadline(pLabel, p.question, p.endDate), kd = ksDeadline(kLabel);
          if (pd && kd) {
            if (pd !== kd) continue;
            how = 'deadline';
          } else if (pi && ki && !pd && !kd) {
            if (disjoint(pm, km)) continue;
            const r = sameInterval(pi, ki);
            if (r === 'tick') { reject(p, k, 'tick', `${pLabel} vs ${kLabel}`); continue; }
            if (r === 'complement') { reject(p, k, 'polarity', `${pLabel} vs ${kLabel}`); continue; }
            if (r !== 'same') continue;
            how = 'interval';
          } else if (pd || kd || pi || ki) {
            continue;   // one side is a date or a number and the other is not the same kind of thing
          } else {
            const pc = combo(pLabel || p.question), kc = combo(kLabel);
            if (pc || kc) { if (pc !== kc) continue; how = 'names'; }
            else if (pLabel && kLabel && namesMatch(pLabel, kLabel)) how = 'names';
            else if (single && ke.markets.length === 1 && !pLabel) how = 'binary';
            else continue;
            if (disjoint(pm, km)) { reject(p, k, 'figures', `months ${[...pm]} vs ${[...km]}`); continue; }
            // a party named on both sides must be the same party
            const pp = norm(`${p.question} ${pLabel}`).match(/\b(democrat|republican)\b/), kp = norm(`${k.title} ${kLabel}`).match(/\b(democrat|republican)\b/);
            if (pp && kp && pp[1] !== kp[1]) { reject(p, k, 'entity', 'different party'); continue; }
          }
          const s = score + (how === 'binary' ? 0 : 0.5);
          if (!best || s > best.s) best = { k, how, s };
        }
        if (!best) continue;
        const k = best.k;
        if (best.how !== 'interval') {
          const pn = nameNumbers(`${pe.text} ${p.question || ''}`), kn = nameNumbers(`${ke.text} ${k.title || ''}`);
          const onlyOne = [...pn].filter((x) => !kn.has(x)).concat([...kn].filter((x) => !pn.has(x)));
          if (onlyOne.length) { reject(p, k, 'figures', `numbers ${[...pn]} vs ${[...kn]}`); continue; }
        }
        // both ways: a proper noun on either side that the other side never mentions
        const missing = missingEntity(p.question, p.groupItemTitle || k.yesSubTitle || '', `${ke.fullText} ${k.title || ''} ${k.yesSubTitle || ''} ${k.rulesPrimary || ''}`)
          || missingEntity(k.title, k.yesSubTitle || p.groupItemTitle || '', `${pe.text} ${p.question || ''} ${p.groupItemTitle || ''} ${String(p.description || '').slice(0, 600)}`);
        if (missing) { reject(p, k, 'entity', `"${missing}" only on Polymarket`); continue; }
        const label = makeLabel(pe.text, p, k);
        candidates.push({
          id: `${p.id}:0|${k.ticker}`, pm: p, ks: k, tokenIndex: 0, how: best.how, score: Math.round(best.s * 1000) / 1000,
          label, category: k.category || null, series: k.seriesTicker || null, rulesKey: `${p.rulesHash || ''}:${k.rulesHash || ''}`,
        });
      }
    }
  }

  // one Polymarket TOKEN per Kalshi ticker and back: best score wins. The key is the token, not the
  // market: a fight is one Polymarket market whose two tokens are two different things to hold, and
  // keying on the market id alone would throw the second fighter away as a duplicate of the first.
  candidates.sort((a, b) => b.score - a.score);
  const usedK = new Set(), usedP = new Set(), out = [];
  for (const c of candidates) {
    const pKey = `${c.pm.id}:${c.tokenIndex || 0}`;
    if (usedK.has(c.ks.ticker) || usedP.has(pKey)) { reject(c.pm, c.ks, 'duplicate', c.label); continue; }
    usedK.add(c.ks.ticker); usedP.add(pKey); out.push(c);
    stats.byHow[c.how] = (stats.byHow[c.how] || 0) + 1;
    stats.byCategory[c.category || 'Other'] = (stats.byCategory[c.category || 'Other'] || 0) + 1;
  }
  stats.candidates = out.length;
  stats.ms = Date.now() - t0;
  return { candidates: out, rejected, stats };
}

// Short and readable, and free of ' · ' and ': ', which the dashboard splits log lines on.
function makeLabel(eventTitle, p, k) {
  const clean = (s) => String(s || '').replace(/\s*[·:]\s*/g, ' ').replace(/\?+$/, '').replace(/\s+/g, ' ').trim();
  const outcome = clean(p.groupItemTitle || k.yesSubTitle || '');
  const ev = clean(eventTitle).replace(/_{2,}|\.{3}|\u2026/g, ' ').replace(/(?<![-\w])(election )?winner\b/i, '').replace(/^will /i, '')
    .replace(/\s+(by|before|in|on|at|of)\s*$/i, '').replace(/\s+/g, ' ').trim();
  const cut = (x, n) => (x.length > n ? `${x.slice(0, Math.max(0, n - 3)).replace(/\s+\S*$/, '')}...` : x);
  if (!outcome || norm(ev).includes(norm(outcome))) return cut(ev || outcome, 60);
  // the outcome is the part that tells two rungs apart, so it is the event title that gets shortened
  const o = cut(outcome, 36);
  return `${cut(ev, 60 - o.length - 3)} - ${o}`;
}

module.exports = { matchAny, pmInterval, ksInterval, sameInterval, pmDeadline, ksDeadline, namesMatch, combo, eventGate, norm, makeLabel };

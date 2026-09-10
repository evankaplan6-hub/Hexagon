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

// Sport classification so "Seattle" (Sounders) can never match "Seattle" (Mariners).
const SPORT_SERIES = {
  mlb: ['KXMLBGAME'], nfl: ['KXNFLGAME'], nba: ['KXNBAGAME'], tennis: ['KXATPMATCH', 'KXWTAMATCH'],
  college: ['KXNCAAFGAME'], soccer: ['KXMLSGAME', 'KXEPLGAME', 'KXUCLGAME', 'KXLALIGAGAME'],
};
const TAG = { KXMLBGAME: 'MLB', KXNFLGAME: 'NFL', KXNBAGAME: 'NBA', KXATPMATCH: 'ATP', KXWTAMATCH: 'WTA', KXNCAAFGAME: 'NCAAF', KXMLSGAME: 'MLS', KXEPLGAME: 'EPL', KXUCLGAME: 'UCL', KXLALIGAGAME: 'LaLiga', KXFEDDECISION: 'Fed' };
const MLB = new Set(['diamondbacks', 'braves', 'orioles', 'red sox', 'cubs', 'white sox', 'reds', 'guardians', 'rockies', 'tigers', 'astros', 'royals', 'angels', 'dodgers', 'marlins', 'brewers', 'twins', 'mets', 'yankees', 'athletics', 'phillies', 'pirates', 'padres', 'giants', 'mariners', 'cardinals', 'rays', 'rangers', 'blue jays', 'nationals']);
const NFL = new Set(['cardinals', 'falcons', 'ravens', 'bills', 'panthers', 'bears', 'bengals', 'browns', 'cowboys', 'broncos', 'lions', 'packers', 'texans', 'colts', 'jaguars', 'chiefs', 'raiders', 'chargers', 'rams', 'dolphins', 'vikings', 'patriots', 'saints', 'giants', 'jets', 'eagles', 'steelers', '49ers', 'seahawks', 'buccaneers', 'titans', 'commanders']);
const NBA = new Set(['hawks', 'celtics', 'nets', 'hornets', 'bulls', 'cavaliers', 'mavericks', 'nuggets', 'pistons', 'warriors', 'rockets', 'pacers', 'clippers', 'lakers', 'grizzlies', 'heat', 'bucks', 'timberwolves', 'pelicans', 'knicks', 'thunder', 'magic', '76ers', 'suns', 'trail blazers', 'kings', 'spurs', 'raptors', 'jazz', 'wizards']);
function nick(name) { const t = toks(name); return [t.slice(-2).join(' '), t[t.length - 1]]; }
function inLeague(set, name) { return nick(name).some((n) => set.has(n)); }
function classify(question, A, B) {
  if (/\b(ATP|WTA)\b/.test(question)) return 'tennis';
  if (inLeague(MLB, A) && inLeague(MLB, B)) return 'mlb';
  if (inLeague(NFL, A) && inLeague(NFL, B)) return 'nfl';
  if (inLeague(NBA, A) && inLeague(NBA, B)) return 'nba';
  if (/\b(FC|SC|CF|United|City|Real|Athletic|Sporting)\b/.test(`${A} ${B}`)) return 'soccer';
  return 'college';
}

function matchPairs(pmList, ksList) {
  const pairs = [], rejected = [];
  const usedKs = new Set();
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
      code = bps === 25 && !plus ? `${dir}25` : (bps >= 50 && !plus) ? `${dir}26` : null;
      mon = r[4]; yr = r[5];
    } else if ((r = q.match(/no change in Fed interest rates after the (\w+) (\d{4}) meeting/i))) {
      code = 'H0'; mon = r[1]; yr = r[2];
    }
    if (code && mon && MON[mon.toLowerCase()]) {
      const mon3 = MON[mon.toLowerCase()];
      const k = ksByTicker.get(`KXFEDDECISION-${yr.slice(2)}${mon3}-${code}`);
      if (k) hit = { ks: k, tokenIndex: 0, kind: 'fed', label: `Fed ${mon3} ${yr.slice(2)} · ${k.subTitle}` };
    }

    // 2) Two-way moneylines: "A vs B" on PM  <->  Kalshi game/match event on the same ET date, same sport
    if (!hit && m.sport === 'moneyline' && m.outcomes.length === 2 && m.gameStart) {
      const d = etDate(m.gameStart);
      const [A, B] = m.outcomes;
      const allowed = SPORT_SERIES[classify(q, A, B)] || [];
      for (const ms of byDate.get(d) || []) {
        const ser = series(ms[0].ticker);
        if (!allowed.includes(ser)) continue;
        const sides = ms.filter((x) => !/^tie\b/i.test(x.subTitle) && !/^tie\b/i.test(x.title));
        if (sides.length !== 2) continue;
        const people = /MATCH/.test(ser); // tennis-style series carry player names
        const ia = sides.findIndex((x) => nameMatch(x.subTitle, A, people));
        const ib = sides.findIndex((x) => nameMatch(x.subTitle, B, people));
        if (ia < 0 || ib < 0 || ia === ib) continue;
        hit = { ks: sides[ia], tokenIndex: 0, kind: 'game', label: `${TAG[ser] || ser} ${short(A)} v ${short(B)} · ${short(A)}` };
        break;
      }
    }

    // 3) "Will X win on YYYY-MM-DD?" (PM soccer style)  <->  Kalshi 3-way soccer market (event has a Tie leg)
    if (!hit && (r = q.match(/^Will (.+?) win on (\d{4}-\d{2}-\d{2})\?$/))) {
      for (const ms of byDate.get(r[2]) || []) {
        const ser = series(ms[0].ticker);
        if (!SPORT_SERIES.soccer.includes(ser)) continue;
        if (!ms.some((x) => /^tie\b/i.test(x.subTitle) || /^tie\b/i.test(x.title))) continue;
        const k = ms.find((x) => !/^tie\b/i.test(x.subTitle) && nameMatch(x.subTitle, r[1]));
        if (k) { hit = { ks: k, tokenIndex: 0, kind: 'game', label: `${TAG[ser] || ser} ${short(r[1])} win ${r[2].slice(5)}` }; break; }
      }
    }

    if (!hit || usedKs.has(hit.ks.ticker)) continue;

    // sanity: venues should roughly agree; a 30c+ disagreement means we matched the wrong thing
    // Validate the LEGS, not the average. `null + null` is 0 in JS and Number.isFinite(0) is true,
    // so an entirely unpriced market used to arrive here as a confident mid of zero and pair with
    // anything Kalshi priced under 30c -- the one correctness guard in this file, passing on a
    // market that had no price at all.
    const legs = [m.bestBid, m.bestAsk, hit.ks.yesBid, hit.ks.yesAsk];
    if (!legs.every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const pmMid = (m.bestBid + m.bestAsk) / 2;
    const ksMid = (hit.ks.yesBid + hit.ks.yesAsk) / 2;
    if (Math.abs(pmMid - ksMid) > 0.30) { rejected.push({ label: hit.label, pm: m.question, ks: hit.ks.title, pmMid, ksMid }); continue; }

    usedKs.add(hit.ks.ticker);
    pairs.push({
      id: `${m.id}:${hit.tokenIndex}|${hit.ks.ticker}`,
      label: hit.label,
      kind: hit.kind,
      series: series(hit.ks.ticker),
      startsAt: hit.kind === 'game' ? startMs(m.gameStart) : null,
      pm: { id: m.id, tokenIndex: hit.tokenIndex, tokenId: m.tokenIds[hit.tokenIndex], question: m.question, url: m.url },
      ks: { ticker: hit.ks.ticker, title: hit.ks.title, eventTicker: hit.ks.eventTicker, url: hit.ks.url },
    });
  }
  return { pairs, rejected };
}

module.exports = { matchPairs, nameMatch, tickerDate, etDate };

'use strict';
// The prediction-market desk on the floor at / (2026-09-29, Evan: "Merge the desk to the new screen.
// It's data, not its look."). Until then the floor gave this desk one line and a link to its own page
// at /pm. Now its five books are cards on the same wall as the stocks, crypto and options books, drawn
// the floor's way, and what its bots do is in the same activity list.
//
// This builds what the floor is sent, from the engine's own ledger. Nothing here trades, and nothing is
// worked out differently from /pm: the arbs come from engine.arbScorecard() and the maker from its own
// snapshot, the same calls /pm's scorecard reads, so the two pages agree to the cent. The frame carries
// it as `legacy` (src/desk/engine.js snapshot), the name it has had since the floor was built, and the
// fields the new desk's PRED line reads (note, lastCycleAt) are the ones they always were.

const r2 = (x) => Math.round(x * 100) / 100;
const sum = (xs, f) => r2(xs.reduce((a, x) => a + (Number(f(x)) || 0), 0));
const VENUE = { PM: 'Polymarket', KS: 'Kalshi' };
// a contract's price the way these markets quote it: cents, and a dollar at par
const cc = (p) => (!Number.isFinite(p) ? '—' : Math.abs(p) >= 0.9995 ? `$${(+p).toFixed(2)}` : `${+(p * 100).toFixed(1)}¢`);
const cap = (s) => { const t = String(s || '').trim(); return t.charAt(0).toUpperCase() + t.slice(1); };
const money = (x) => `$${Math.abs(x).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
// Polymarket cuts a long question short with three dots, often after a dash ("Sint Maarten -... - Both
// Teams to Score", "news outlets from... - Before Oct 1"): one ellipsis, against the word it cut
const unellipsis = (s) => String(s || '').replace(/\s*-?\s*(?:\.{3}|…)/g, '…').replace(/\s{2,}/g, ' ').trim();
// Kalshi writes its questions in full ("Will Marco Rubio be the nominee ...?", some with **bold**); the
// outcome goes after it, so the question is kept without its "Will" and its question mark
// (Kalshi's Senate series say "Will Democratics win..." in every state: the venue's typo, not a party)
const question = (s) => unellipsis(String(s || '').replace(/\*\*/g, '').replace(/\bDemocratics\b/g, 'Democrats').replace(/^Will\s+/i, '').replace(/\?$/, ''));

// Every book's positions are one of four: a locked arb (two legs, one per venue), a settlement snipe, a
// game bet (every game, since 2026-09-30), or a convergence bet (any other signal the taker opened; the
// book has been off since 2026-09-21).
const kindOf = (p) => (p.strategy === 'arb' || p.strategy === 'snipe' || p.strategy === 'bet' ? p.strategy : 'converge');
// A game bet, by the team it is on. The matcher's label names the game and its YES side ("NCAAF Texas A&M v
// Missouri · Texas A&M"), so a NO leg is a bet on the other team, and until 2026-10-10 every line about it
// read "No on ... · Texas A&M" and left the reader to turn it round. decide.betPick is the one reading of
// that label (the engine's own log line says "game bet on Missouri" from it); the opponent is the other name.
const { betPick } = require('./decide');
function gameOf(p) {
  if (kindOf(p) !== 'bet') return null;
  const m = String(p.label || '').match(/^(\S+)\s+(.+?) v (.+?) · (.+)$/);
  if (!m) return null;
  const pick = betPick(p.label, p.side);
  if (pick !== m[2] && pick !== m[3]) return null;
  return { league: m[1], pick, foe: pick === m[2] ? m[3] : m[2] };
}

// ------------------------------------------------------------------ the log, in the floor's words
// The engine writes its log for itself ("venue gap 9.5c: Polymarket over Kalshi @ ..."), and /pm turns
// each line into a sentence as it draws it (public/app.js say()). The floor does that here instead, on
// the server, so the page only draws. Each line gets one of the floor's four levels (src/desk/engine.js
// logLevel):  trade  money moved      warn   needs a look
//             info   a decision       quiet  the desk doing its rounds
// FILL and SETTLE lines are left out (skip()): the floor's trades come from the ledger's own fills below,
// as the new desk's do, so a busy hour of routine lines cannot push a trade out of the frame.
function pmLine(e, titles = null) {
  const t = String(e.text || ''), parts = t.split(' · '), first = parts[0], rest = parts.slice(1).join(' · ');
  const line = (text, sub, level) => ({ text: cap(text), sub: sub || '', level });
  // The maker names a market by its Kalshi ticker ("GOVPARTYFL-26-R cooled 60m: ..."); the floor is for reading,
  // so a line that starts with a ticker the maker's snapshot knows starts with the market's name instead.
  const named = (s) => s.replace(/^[A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*(?=[:\s]|$)/, (k) => (titles && titles.get(k)) || k);
  const span = (m) => (m === 60 ? 'an hour' : m % 60 === 0 ? `${m / 60} hours` : `${m} minutes`);
  switch (`${e.agent} ${e.kind}`) {
    case 'TESS OPS':
      if (/^HALT\b/.test(first)) return line('Prediction markets stopped taking new risk', rest, 'warn');
      if (/window is clean/.test(t)) {
        const d = (t.match(/day ([−+-]?[\d.]+%)/) || [])[1];
        return line(`All clear: prices are fresh${d ? `, the account ${d.replace('-', '−')} today` : ''}`, '', 'quiet');
      }
      if (/^(new session day|desk online|reconciled ·|operator halt cleared)/.test(t)) return line(first, rest, 'quiet');
      return line(first, rest, 'warn');
    case 'ILSA RESEARCH': {
      const m = t.match(/^(.+?): PM ([−+-]?[\d.]+)c, KS ([−+-]?[\d.]+)c over \S+ · gap ([\d.]+)c (\w+)/);
      const mv = (x) => (+x.replace('−', '-') === 0 ? 'held' : `moved ${x.replace('-', '−').replace(/\.0$/, '')}¢`);
      if (m) return line(`${unellipsis(m[1])}: price ${mv(m[2])} on Polymarket, ${mv(m[3])} on Kalshi`, `venues ${+m[4]}¢ apart, ${m[5]}`, 'quiet');
      return line(first, rest, 'quiet');
    }
    // whale watch is advisory and never trades (src/whales.js), and it calls a bet every few minutes: routine
    // here, so the floor's signals stay the decisions
    case 'ILSA WHALE': return line(`Big bet: ${first.replace(/(\d+)c\b/g, '$1¢')}`, rest.replace(/(\d+)c\b/g, '$1¢'), 'quiet');
    case 'ILSA OPS':
      // whale watch's feed errors quote the URL they hit, wallet address and all
      if (/^whale watch could not reach/i.test(t)) { const code = (t.match(/HTTP (\d+)/) || [])[1]; return line("Whale watch could not reach Polymarket's trade feed", code ? `HTTP ${code} · it tries again on its next round` : '', 'warn'); }
      return line(first, rest, 'warn');
    case 'BRAM RESEARCH': {
      // the snipe's watch: a finished game Polymarket has settled, proposed or closed, and what Kalshi offers the
      // winner (a game's label can carry " · " itself, "MLB Phillies v Braves · Phillies", so it is cut at the colon)
      if (/: Polymarket has (settled|proposed|closed)/.test(t)) {
        const i = t.indexOf(': Polymarket has'), [what, ...more] = t.slice(i + 2).replace(/(\d+(?:\.\d+)?)c\b/g, '$1¢').split(' · ');
        return line(`${unellipsis(t.slice(0, i))}: ${what}`, more.join(' · '), 'info');
      }
      const g = t.match(/^venue gap ([\d.]+)c: (\w+) over (\w+) @ (.+?) · PM ([\d.]+)\/([\d.]+) · KS ([\d.]+)\/([\d.]+)/);
      if (g) return line(`Widest gap ${+g[1]}¢, ${g[2]} over ${g[3]}: ${unellipsis(g[4])}`, `Polymarket ${cc(+g[5])} to ${cc(+g[6])}, Kalshi ${cc(+g[7])} to ${cc(+g[8])}`, 'quiet');
      return line(first, rest, 'quiet');
    }
    case 'HOLT SCAN': {
      const m = t.match(/\+\d+ new: (.+?)(?: · −\d+ closed| · \d+ rejected|$)/);
      // a newly matched pair is the scan doing its rounds too (several an hour on a sports evening)
      if (m) return line(`Found a new market on both venues: ${unellipsis(m[1])}`, '', 'quiet');
      const n = (t.match(/^(\d+) pairs live \(([^)]*)\)/) || []);
      return n[1] ? line(`Watching ${n[1]} markets listed on both venues: ${n[2]}`, '', 'quiet') : line(first, rest, 'quiet');
    }
    case 'KETT PASS': { const m = t.match(/^(.+?): (.+)$/); return m ? line(`Passed on ${unellipsis(m[1])}`, m[2], 'info') : line(t, '', 'info'); }
    case 'MAKR OPS': {
      // The floor tags every maker line "Maker" (desk.js pmTag), so since 2026-10-10 the line does not say it again.
      // an event's markets crossed out ahead of it (MAKER_EVENT_DATES) carry the money they made or lost
      if (Number.isFinite(e.pnl)) return line(named(first), rest, 'trade');
      // a market whose fills were being run over, its quotes pulled for a while (src/maker.js's toxicity gate)
      const c = first.match(/^(\S+) cooled (\d+)m: (\d+)% of (the contracts in )?its last (\d+) fills were run over \(limit (\d+)%\)$/);
      if (c) return line(`${named(c[1])}: quotes pulled for ${span(+c[2])}`, `${c[3]}% of ${c[4] || ''}its last ${c[5]} fills were run over, the limit is ${c[6]}%${rest ? ` · ${rest.replace(/^quotes withdrawn, /, '')}` : ''}`, 'info');
      if (/^(trade stream (connected|reconnected)|\d+\/\d+ candidate series|quoting off \(MAKER_QUOTE)/.test(t)) return line(first, rest, 'quiet');
      return line(named(first), rest, /stale|fail|error|halt|stop|refused|dropped|gap|skipped/i.test(t) ? 'warn' : 'info');
    }
    case 'MAKR RESEARCH': {
      const m = t.match(/book: (\d+) contracts.*marked \$([\d.]+) from \$([\d.]+)/);
      if (m) { const net = +m[2] - +m[3]; return line(`Maker holding ${Number(m[1]).toLocaleString('en-US')} contracts, ${net >= 0 ? 'up' : 'down'} ${money(net)} if closed now`, '', 'quiet'); }
      return line(named(first), rest, 'quiet');
    }
    case 'MAKR SCAN': {
      const m = t.match(/quoting (\d+) of/);
      return m ? line(`Maker offering to buy and sell in ${m[1]} markets`, '', 'quiet') : line(named(first), rest, 'quiet');
    }
    case 'MAKR SETTLE': return line(named(first), rest, 'trade');
    case 'RIGO RESEARCH': {
      const m = t.match(/(\d+) open/), al = +((t.match(/(\d+) integrity alert/) || [])[1] || 0);
      if (m) return line(`Checked ${m[1]} open positions${al ? `: ${al} broken arb${al > 1 ? 's' : ''}` : ', all fine'}`, '', al ? 'warn' : 'quiet');
      return line(first, rest, 'quiet');
    }
    default: break;
  }
  if (e.kind === 'HALT') return line(`Stopped: ${first}`, rest, 'warn');
  if (e.kind === 'OPS') return line(first, rest, /^(researching |research on |.*sized to the )/.test(t) ? 'info' : 'warn');
  if (e.kind === 'SCAN' || e.kind === 'RESEARCH') return line(first, rest, 'quiet');
  return line(first, rest, 'info');   // PASS: a trade looked at and not taken, and why
}
// The ledger's fills say these better (see pmLine), and the maker's one-line round summary ("2 fills this
// cycle") is its fills again. A maker settlement is only in the log, so it stays.
const skip = (e) => e.kind === 'FILL' || (e.kind === 'SETTLE' && e.agent !== 'MAKR');

// ------------------------------------------------------------------ the books and the frame
// `engine` is src/engine.js's Engine; `cfg` its config. Pure over what it is handed, apart from reading
// the clock for "now".
function pmFloor(engine, cfg, now = Date.now()) {
  const s = engine.state, closed = s.closed || [];
  const M = engine.maker && engine.maker.snapshot ? engine.maker.snapshot(engine, { hist: false }) : {};
  const groups = engine.arbScorecard();
  const open = (k) => s.positions.filter((p) => kindOf(p) === k);
  const shut = (k) => closed.filter((c) => kindOf(c) === k);
  const marked = (ps) => sum(ps, (p) => p.qty * (p.mark ?? p.entry) - p.cost);
  const posRow = (p) => ({ id: p.id, label: unellipsis(p.label), game: gameOf(p), venue: VENUE[p.venue] || p.venue, side: p.side, qty: p.qty, entry: p.entry, mark: p.mark ?? null,
    cost: r2(p.cost), worth: r2(p.qty * (p.mark ?? p.entry)), pnl: r2(p.qty * (p.mark ?? p.entry) - p.cost), settlesAt: Number.isFinite(p.settlesAt) ? p.settlesAt : null });

  // Banked, per book, from the closed legs. The ledger keeps its newest 2,000 closes, and its realised
  // total counts every one ever: were the oldest to go, they would be convergence's (the first book, off
  // since 2026-09-21), so convergence takes the difference and the books still add up to the account.
  const bankedArb = sum(shut('arb'), (c) => c.pnl), bankedSnipe = sum(shut('snipe'), (c) => c.pnl), bankedBet = sum(shut('bet'), (c) => c.pnl);
  const bankedConv = r2(s.stats.realized - bankedArb - bankedSnipe - bankedBet);

  // A group /pm's scorecard cannot vouch for has no settlement figure and counts at what it would sell
  // for now (engine.pnlScorecard's arbUnvouched), so "at settlement" never reads a broken hedge as $0.
  const arbRows = groups.map((g) => ({
    id: g.id, label: unellipsis(g.label), settlesAt: g.settlesAt ?? null, qty: g.qty, cost: g.entryCost, worth: g.liquidationValue,
    pays: g.settlementValue, locked: g.lockedPnl, pnl: g.liquidationPnl, integrity: g.integrity,
  })).sort((a, b) => (a.settlesAt ?? Infinity) - (b.settlesAt ?? Infinity) || String(a.label).localeCompare(String(b.label)));
  const arbs = {
    key: 'arbs', name: 'Arbs', on: cfg.arbsEnabled !== false,
    pnl: r2(bankedArb + sum(groups, (g) => g.liquidationPnl)),
    atSettle: r2(bankedArb + sum(groups, (g) => (g.lockedPnl == null ? g.liquidationPnl : g.lockedPnl))),
    realized: bankedArb, closed: new Set(shut('arb').map((c) => c.group || c.id)).size,
    max: cfg.maxArbGroups, maxLong: cfg.maxLongArbGroups, longDays: cfg.longDays,
    cost: sum(groups, (g) => g.entryCost), worth: sum(groups, (g) => g.liquidationValue),
    alerts: groups.filter((g) => g.integrity !== 'valid' && g.integrity !== 'half_settled').length,
    rows: arbRows,
    rule: `Buys YES on one venue and NO on the other for the same outcome when the two together cost less than the $1 they are sure to pay, after both venues' fees, and holds both to settlement. Only pairs whose two venues' resolution rules match are traded. At most ${cfg.maxArbGroups} open at once, ${cfg.maxLongArbGroups} of them settling more than ${cfg.longDays} days out.`,
  };

  // The maker holds hundreds of markets: the frame carries the ones moving its book the most.
  const held = (M.markets || []).filter((m) => m.inv);
  const makerPnl = Number.isFinite(M.equity) && Number.isFinite(M.initial) ? r2(M.equity - M.initial) : 0;
  const maker = {
    key: 'maker', name: 'Maker', on: cfg.makerQuoting !== false && M.enabled !== false,
    pnl: makerPnl, initial: M.initial ?? null, equity: M.equity ?? null, cash: M.cash ?? null, realized: r2(M.realized || 0),
    open: sum(held, (m) => m.mark - m.cost),
    fills: M.fills || 0, quoting: M.quoting || 0, markets: held.length, contracts: M.inv || 0,
    halted: M.halted || null, lastFillAt: M.lastFill ? M.lastFill.at || null : null,
    rows: held.map((m) => ({ ticker: m.ticker, title: cap(question(m.title)), sub: String(m.sub || '').replace(/\*\*/g, ''), inv: m.inv, cost: r2(m.cost), worth: r2(Math.abs(m.mark)), pnl: r2(m.mark - m.cost) }))
      .sort((a, b) => Math.abs(b.pnl) - Math.abs(a.pnl) || b.worth - a.worth).slice(0, 6),
    rule: 'Rests bids and offers on Kalshi markets that charge makers no fee, and is paid the spread when both sides fill. A market holding too much quotes only the side that brings it back to flat, election markets are left before election night, and each event has its own loss limit.',
  };

  // The snipe's watch keeps the finished games it asked Polymarket about for six hours (agents.watchCloses);
  // a live game the listing dropped for a cycle is asked about too, and is not a finished game
  const closes = engine.pmCloses ? [...engine.pmCloses.values()].filter((w) => w.readAt || w.proposedAt || w.closedAt) : [];
  const snipeOpen = open('snipe');
  const snipe = {
    key: 'snipe', name: 'Snipe', on: !!cfg.snipe, watching: !!cfg.snipeWatch,
    pnl: r2(bankedSnipe + marked(snipeOpen)), realized: bankedSnipe,
    bought: shut('snipe').length + snipeOpen.length, watched: closes.length, closedGames: closes.filter((w) => w.closedAt).length,
    rows: snipeOpen.map(posRow),
    seen: (s.log || []).filter((e) => e.agent === 'BRAM' && /: Polymarket has (settled|proposed|closed)/.test(String(e.text))).slice(0, 3)
      .map((e) => ({ t: e.t, ...pmLine(e) })),
  };
  snipe.rule = "When a game ends, Polymarket's book goes to 99¢ on the winner while Kalshi can still be selling it under $1. Once Polymarket's own record says the result is in (its resolver proposes it about 20 seconds after the final), this buys the winner on Kalshi if the price clears the fee, and holds it to settlement." +
    (snipe.bought ? '' : " It has never fired. Until 2026-09-30 it waited for Polymarket to close the market, which comes half an hour after Kalshi has closed and paid out; Kalshi closes a finished game about four minutes after the final, so the window is short.");

  const convOpen = open('converge');
  const converge = {
    key: 'converge', name: 'Convergence', on: cfg.convergeEnabled !== false,
    pnl: r2(bankedConv + marked(convOpen)), realized: bankedConv,
    trades: shut('converge').length, wins: shut('converge').filter((c) => c.pnl > 0).length,
    rows: convOpen.map(posRow),
  };
  converge.rule = `Bet that two venues disagreeing on the same outcome by ${Math.round((cfg.minGap || 0.03) * 100)}¢ or more would come back together, and sold when they did.` +
    (converge.on ? '' : ` Switched off on 2026-09-21 after losing on paper: ${converge.wins} of ${converge.trades} made money.`);

  // Every game (decide.betSignal): one bet a game on the favourite, held to the final
  const betOpen = open('bet'), betShut = shut('bet');
  const league = (cfg.betSeries || []).map((x) => ({ KXMLBGAME: 'MLB', KXNFLGAME: 'NFL', KXNBAGAME: 'NBA', KXNCAAFGAME: 'college football' }[x] || x)).join(', ') || 'no';
  const bets = {
    key: 'bets', name: 'Every game', on: !!cfg.bets,
    pnl: r2(bankedBet + marked(betOpen)), realized: bankedBet,
    games: betShut.length + betOpen.length, settled: betShut.length, wins: betShut.filter((c) => c.pnl > 0).length, stake: cfg.betUsd,
    rows: betOpen.map(posRow),
    rule: `Bets every ${league} game once: $${cfg.betUsd} on the favourite, bought at whichever venue sells it cheaper after its fee, and held to the final. ` +
      `A game already all but decided (the favourite over ${Math.round((cfg.betMaxPx || 0.9) * 100)}¢) is left alone. It claims no edge: bought at the market's own price, ` +
      'it should lose about the fee over many games. Evan, on the Wild Card\'s second night: "every game should be bet".',
  };

  // The ledger's own fills, newest first: the taker's legs as they opened and closed, and the maker's.
  const fills = [];
  for (const p of [...s.positions, ...closed.slice(-80)]) {
    const base = { book: kindOf(p), label: unellipsis(p.label), game: gameOf(p), qty: p.qty, venue: VENUE[p.venue] || p.venue, side: p.side };
    if (Number.isFinite(p.openedAt)) fills.push({ ...base, id: `${p.id}:open`, at: p.openedAt, action: 'bought', px: p.entry, pnl: null });
    if (Number.isFinite(p.exitAt)) fills.push({ ...base, id: `${p.id}:close`, at: p.exitAt, action: /^resolved/.test(String(p.reason || '')) ? 'settled' : 'sold', px: p.exit, pnl: Number.isFinite(p.exitPnl) ? p.exitPnl : p.pnl ?? null });
  }
  // A resting quote is taken a few contracts at a time: twelve fills at one price inside a minute on 2026-10-08,
  // and each was a line on the floor. The same market, side and price within one minute is one fill here, its
  // contracts added up and the count kept (`n`), under the minute's own key so the row stays the same row as
  // more of it arrives.
  const folded = new Map();
  for (const f of M.recent || []) {
    const k = `mk:${f.ticker}:${Math.floor(f.at / 60000)}:${f.side}:${f.px}`, pnl = Number.isFinite(f.pnl) ? f.pnl : 0;
    const prev = folded.get(k);
    if (prev) { prev.qty += f.qty; prev.n++; prev.at = Math.max(prev.at, f.at); prev.pnl = r2(prev.pnl + pnl); continue; }
    folded.set(k, { book: 'maker', id: k, at: f.at, action: f.side === 'sell' ? 'sold' : 'bought',
      label: f.title ? `${cap(question(f.title))}${f.sub ? ` · ${String(f.sub).replace(/\*\*/g, '')}` : ''}` : f.ticker, qty: f.qty, n: 1, px: f.px, venue: 'Kalshi', side: 'yes', pnl });
  }
  for (const f of folded.values()) fills.push({ ...f, pnl: f.pnl !== 0 ? f.pnl : null });
  fills.sort((a, b) => b.at - a.at);

  // The log: everything that is not routine from the engine's ring, and the newest routine lines, so a
  // busy hour of rounds (the ring holds about three) does not push a warning out.
  // the maker's markets by ticker, for the lines that name one by its ticker (pmLine's `named`)
  const titles = new Map((M.markets || []).filter((m) => m.ticker && m.title).map((m) => [m.ticker, `${cap(question(m.title))}${m.sub ? ` · ${String(m.sub).replace(/\*\*/g, '')}` : ''}`]));
  const lines = (s.log || []).filter((e) => !skip(e)).map((e) => ({ t: e.t, agent: e.agent, kind: e.kind, pnl: Number.isFinite(e.pnl) ? e.pnl : null, ...pmLine(e, titles) }));
  let quiet = 0;
  const log = lines.filter((e) => e.level !== 'quiet' || quiet++ < 30).slice(0, 120);

  const takerEq = engine.equity();
  const pnl = r2((takerEq - s.initial) + makerPnl);
  const initial = r2(s.initial + (Number.isFinite(M.initial) ? M.initial : 0));
  // Trading again in paper since 2026-09-27 (any of ARBS, MAKER_QUOTE, SNIPE on); winding down only with all off
  const trading = cfg.arbsEnabled !== false || cfg.makerQuoting !== false || !!cfg.snipe || !!cfg.bets;
  const nextSettle = s.positions.map((p) => p.settlesAt).filter((t) => Number.isFinite(t) && t > now).sort((a, b) => a - b)[0] || null;
  const openTxt = `${groups.length} arb${groups.length === 1 ? '' : 's'}, ${Number(M.inv || 0).toLocaleString()} held`;
  return {
    // the summary the floor has read since it was built
    pnl, groups: groups.length, held: held.length, contracts: M.inv || 0, nextSettle, lastCycleAt: engine.beat ? engine.beat.taker : null, url: '/pm', trading,
    note: trading ? `trading in paper: ${openTxt}` : groups.length || M.inv ? `winding down: ${openTxt}` : 'all settled',
    // and since 2026-09-29, the desk itself
    now, initial, equity: r2(takerEq + (Number.isFinite(M.equity) ? M.equity : 0)),
    beat: engine.beat ? { taker: engine.beat.taker, maker: engine.beat.maker } : null, every: { taker: cfg.priceEvery, maker: cfg.makerEverySec },
    halt: engine.halt || null,
    books: [arbs, maker, snipe, converge, bets],
    fills: fills.slice(0, 40),
    log,
  };
}

module.exports = { pmFloor, pmLine, kindOf, gameOf };

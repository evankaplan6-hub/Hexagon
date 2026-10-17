'use strict';
// The crypto note: the book against holding, since the start and over seven days, each coin's aim against the
// band, the day's trades, and what the next check would do. Fed a fixture: no network, no desk.
const { note } = require('./crypto-note');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const NOW = Date.UTC(2026, 9, 17, 12), D = 864e5;
const row = (sym, value, worth, target, want, vol) => ({ sym, name: sym.replace('-USD', ''), value, worth, initial: 3333.33, target, want, vol });
const snap = (rows) => ({ books: [{ key: 'crypto', initial: 10000, startedAt: Date.UTC(2026, 8, 25), pnl: -500, benchPnl: -900, rows }] });
const hist = [{ t: NOW - 8 * D, c: 9800, bc: 9600 }, { t: NOW - 7 * D, c: 9900, bc: 9700 }, { t: NOW, c: 9500, bc: 9100 }];

{
  const txt = note(snap([row('BTC-USD', 3000, 3000, 1, 1, 0.38), row('ETH-USD', 2000, 2600, 0.8, 0.82, 0.49), row('SOL-USD', 1500, 2400, 0.6, 0.45, 0.89)]), hist, [], NOW);
  ok('it says what it is: the paper desk, not advice', /paper desk, not advice/.test(txt), txt);
  ok('since the start against holding, and by how much', /−\$500\.00 on \$10,000\.00; just holding the same coins −\$900\.00, so the rule is ahead by \$400\.00/.test(txt), txt);
  ok('the last seven days, from the minute seven days back', /Last 7 days: −\$400\.00; holding −\$600\.00 \(ahead by \$200\.00\)/.test(txt), txt);
  ok('a coin at full size and aimed there: no trade', /Bitcoin\s+100%\s+100%\s+38%\s+no trade/.test(txt), txt);
  ok('two points off its last aim is inside the band', /Ether\s+77%\s+82%\s+49%\s+no trade/.test(txt), txt);
  ok('fifteen points down is a sale at the next check', /Solana\s+63%\s+45%\s+89%\s+would sell, to 45%/.test(txt) && /next 8 PM ET check, if prices hold: Solana down to 45%/.test(txt), txt);
  ok('no fills in the last day says so', /Last 24 hours: no trades\./.test(txt));
}
{
  const fills = [{ book: 'crypto', sym: 'XRP-USD', side: 'buy', value: 575.33, at: NOW - 3600e3 }, { book: 'crypto', sym: 'BTC-USD', side: 'sell', value: 100, at: NOW - 2 * D }, { book: 'stocks', sym: 'SPY', side: 'buy', value: 10, at: NOW - 60e3 }];
  const txt = note(snap([row('XRP-USD', 700, 1000, 0.7, 0.7, 0.57)]), hist, fills, NOW);
  ok('the day\'s crypto fills only: not two days back, not SPY', /Last 24 hours: bought XRP \(\$575\.33\)\./.test(txt), txt);
  ok('a coin never traded is a trade at its first check', /would buy/.test(note(snap([row('DOGE-USD', 0, 3333.33, null, 0.5, 0.8)]), hist, [], NOW)));
  ok('going back to full size is a trade even inside the band', /would buy, to 100%/.test(note(snap([row('BTC-USD', 2900, 3000, 0.95, 1, 0.3)]), hist, [], NOW)));
  ok('a coin with no price history yet', /no price history yet/.test(note(snap([row('BTC-USD', 0, 3333.33, null, null, null)]), hist, [], NOW)));
}

console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

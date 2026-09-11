'use strict';
// Assertions for src/broker.js -- the code that turns a decision into a fill.
//
// PaperBroker runs constantly. LiveKalshiBroker extends it and, per CLAUDE.md, has NEVER been
// exercised against a funded account: it is the least-tested code in the repo and the only code
// that can lose real money. None of this touches the network. The live adapter is driven with a
// throwaway RSA key and a stubbed `request`, which is enough to assert the two things that
// actually matter about an order -- what is in it, and whether a retry can duplicate it.
//
//   node tools/broker-test.js
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Stubbed BEFORE broker -> venues/kalshi is loaded, so the per-series fee multipliers can be
// populated without a network call. Kalshi's taker fee is scaled per series (MLB is 0.5, fourteen
// series are 0), and that table is normally fetched at startup.
const httpPath = require.resolve('../src/http');
require.cache[httpPath] = {
  id: httpPath, filename: httpPath, loaded: true, children: [], paths: [],
  exports: { getJSON: async (url) => ({ series: { fee_multiplier: /KXMLBGAME/.test(url) ? 0.5 : 1 } }), recentErrors: () => 0, stats: {} },
};

const { walk, makeBroker } = require('../src/broker');
const ks = require('../src/venues/kalshi');
const base = require('../src/config');

let pass = 0, fail = 0;
const ok = (name, cond, got) => {
  if (cond) { pass++; return; }
  fail++;
  console.log(`  FAIL  ${name}${got === undefined ? '' : `\n        got: ${JSON.stringify(got)}`}`);
};
const group = (n) => console.log(`\n${n}`);
const L = (...pairs) => pairs.map(([price, size]) => ({ price, size }));

group('walk() takes the ladder in order and stops at the limit');
{
  const ladder = L([0.40, 10], [0.41, 20], [0.45, 100]);
  const all = walk(ladder, 25, 0.45);
  ok('fills across levels', all.filled === 25, all);
  ok('at the blended price', Math.abs(all.avg - (10 * 0.40 + 15 * 0.41) / 25) < 1e-9, all);

  const capped = walk(ladder, 100, 0.41);
  ok('never pays above the limit', capped.filled === 30, capped);
  ok('...and prices only what it took', Math.abs(capped.avg - (10 * 0.40 + 20 * 0.41) / 30) < 1e-9, capped);

  ok('a limit under the touch fills nothing', walk(ladder, 10, 0.39).filled === 0);
  ok('an empty ladder fills nothing', walk([], 10, 0.99).filled === 0);
  ok('a missing ladder is a no-fill, not a throw', walk(undefined, 10, 0.99).filled === 0);
  ok('zero quantity fills nothing', walk(ladder, 0, 0.99).filled === 0);
  ok('exact depth fills exactly', walk(L([0.40, 7]), 7, 0.40).filled === 7);
  ok('short depth fills partially', walk(L([0.40, 7]), 20, 0.40).filled === 7);
  ok('avg is 0 when nothing filled', walk([], 10, 0.99).avg === 0);
  // the epsilon exists because 0.45 - 0.44 lands at 0.010000000000000009
  ok('a level exactly AT the limit is taken', walk(L([0.45, 5]), 5, 0.45).filled === 5);
}

group('PaperBroker reports fills net of the venue fee');
{
  const E = { state: { positions: [] }, log: () => {} };
  const b = makeBroker({ ...base, mode: 'paper' }, E);
  ok('paper mode selects the paper broker', b.kind === 'paper', b.kind);

  return (async () => {
    const kb = await b.buy({ venue: 'KS', ref: 'KXTEST-A', qty: 10, limit: 0.50, book: L([0.50, 100]) });
    ok('a Kalshi buy fills', kb.filled === 10, kb);
    ok('and is charged a Kalshi fee', kb.fee > 0, kb);
    ok('cost = contracts + fee', Math.abs(kb.cost - (10 * 0.50 + kb.fee)) < 0.005, kb);

    const pb = await b.buy({ venue: 'PM', ref: null, qty: 10, limit: 0.50, book: L([0.50, 100]) });
    ok('a Polymarket buy is charged PM_TAKER_FEE (0 by default)', pb.fee === 0, pb);

    const none = await b.buy({ venue: 'KS', ref: 'KXTEST-A', qty: 10, limit: 0.20, book: L([0.50, 100]) });
    ok('no depth inside the limit is refused by name', none.filled === 0 && /no depth/.test(none.reason), none);

    const s = await b.sell({ venue: 'KS', ref: 'KXTEST-A', qty: 10, px: 0.60 });
    ok('a sell reports proceeds NET of fee', Math.abs(s.proceeds - (10 * 0.60 - s.fee)) < 0.005, s);
    ok('...which is less than the gross', s.proceeds < 10 * 0.60, s);

    await live();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
  })();
}

async function live() {
  // a throwaway key: this exercises the signing path without any real credential
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hexagon-broker-'));
  const keyPath = path.join(dir, 'test-key.pem');
  const { privateKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
  fs.writeFileSync(keyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }));

  const E = {
    state: { positions: [], pendingOrders: [] }, liveReady: false, logs: [], journals: [], saves: 0,
    log(a, k, p, t) { this.logs.push(t); },
    journal(e, kind, payload) { this.journals.push({ kind, payload }); },
    save() { this.saves++; },
  };
  const cfg = { ...base, mode: 'live', kalshiKeyId: 'test-key-id', kalshiKeyPath: keyPath };
  const b = makeBroker(cfg, E);

  group('LiveKalshiBroker signs what Kalshi expects');
  ok('live mode selects the live broker', b.kind === 'live', b.kind);
  const h = b.headers('POST', '/trade-api/v2/portfolio/orders');
  ok('sends the key id', h['KALSHI-ACCESS-KEY'] === 'test-key-id', h['KALSHI-ACCESS-KEY']);
  ok('sends a timestamp', /^\d+$/.test(h['KALSHI-ACCESS-TIMESTAMP']), h['KALSHI-ACCESS-TIMESTAMP']);
  // the signature must verify over EXACTLY ts + method + path, or every live call 401s
  const verified = crypto.verify('sha256',
    Buffer.from(h['KALSHI-ACCESS-TIMESTAMP'] + 'POST' + '/trade-api/v2/portfolio/orders'),
    { key: crypto.createPublicKey(privateKey), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
    Buffer.from(h['KALSHI-ACCESS-SIGNATURE'], 'base64'));
  ok('the signature verifies over ts + method + path', verified === true);

  // The cursor must travel over HTTP but must NOT be part of Kalshi's signature payload.
  const realRequest = b.request.bind(b);
  const priorFetch = global.fetch;
  let request, requestError;
  global.fetch = async (url, opts) => {
    request = { url: String(url), opts };
    return { ok: true, json: async () => ({}) };
  };
  try { await realRequest('GET', '/portfolio/positions?cursor=page-two'); }
  catch (e) { requestError = e; }
  finally { global.fetch = priorFetch; }
  const qh = request && request.opts.headers;
  const pathOnlyVerifies = qh && crypto.verify('sha256',
    Buffer.from(qh['KALSHI-ACCESS-TIMESTAMP'] + 'GET' + '/trade-api/v2/portfolio/positions'),
    { key: crypto.createPublicKey(privateKey), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
    Buffer.from(qh['KALSHI-ACCESS-SIGNATURE'], 'base64'));
  const queryAlsoVerifies = qh && crypto.verify('sha256',
    Buffer.from(qh['KALSHI-ACCESS-TIMESTAMP'] + 'GET' + '/trade-api/v2/portfolio/positions?cursor=page-two'),
    { key: crypto.createPublicKey(privateKey), padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST },
    Buffer.from(qh['KALSHI-ACCESS-SIGNATURE'], 'base64'));
  ok('the cursor remains in the request URL', !requestError && /positions\?cursor=page-two$/.test(request && request.url), request);
  ok('the signature omits the request query', pathOnlyVerifies === true && queryAlsoVerifies === false);

  group('a retried order cannot open a second position');
  {
    const sent = [];
    b.request = async (m, p, body) => { sent.push({ m, p, body }); return { order: { order_id: 'o1', fill_count: body.count, taker_fill_cost_dollars: body.count * 0.50, taker_fees_dollars: 0.07 } }; };

    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 10, limit: 0.50, key: 'grp-KSy-in' });
    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 10, limit: 0.50, key: 'grp-KSy-in' });
    ok('the same key yields the same client_order_id', sent[0].body.client_order_id === sent[1].body.client_order_id, sent.map((s) => s.body.client_order_id));
    ok('a different key yields a different one', await (async () => {
      await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 10, limit: 0.50, key: 'grp-KSy-OUT' });
      return sent[2].body.client_order_id !== sent[0].body.client_order_id;
    })());
    ok('the id is UUID-shaped', /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(sent[0].body.client_order_id), sent[0].body.client_order_id);
    ok('a definite exchange response clears the persisted intent', E.state.pendingOrders.length === 0, E.state.pendingOrders);
  }

  group('the order body says what it should');
  {
    const sent = [];
    b.request = async (m, p, body) => { sent.push({ m, p, body }); return { order: { order_id: 'o', fill_count: body.count, taker_fill_cost_dollars: body.count * 0.5, taker_fees_dollars: 0 } }; };

    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 7, limit: 0.53, key: 'k1' });
    const y = sent[0].body;
    ok('posts to /portfolio/orders', sent[0].m === 'POST' && sent[0].p === '/portfolio/orders', sent[0]);
    ok('a YES order carries yes_price in CENTS', y.yes_price === 53, y);
    ok('and no no_price', y.no_price === undefined, y);
    ok('immediate-or-cancel, never resting', y.time_in_force === 'immediate_or_cancel', y);
    ok('carries the count and ticker', y.count === 7 && y.ticker === 'KXTEST-A', y);

    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'no', qty: 7, limit: 0.47, key: 'k2' });
    ok('a NO order carries no_price instead', sent[1].body.no_price === 47 && sent[1].body.yes_price === undefined, sent[1].body);

    // Kalshi prices are integer cents in 1..99; an unclamped 0 or 100 is rejected by the exchange
    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, limit: 0.004, key: 'k3' });
    ok('a sub-cent limit clamps up to 1', sent[2].body.yes_price === 1, sent[2].body);
    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, limit: 0.999, key: 'k4' });
    ok('a limit at par clamps down to 99', sent[3].body.yes_price === 99, sent[3].body);

    // ROUNDING must never cross the caller's limit. A buy at 50.5c rounded to 51c pays a cent more
    // than the edge was priced at -- and MIN_EDGE is 0.5c, so that cent is the entire trade.
    await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, limit: 0.505, key: 'k5' });
    ok('a buy rounds DOWN, never above its limit', sent[4].body.yes_price === 50, sent[4].body);
    await b.sell({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, px: 0.505, key: 'k6' });
    ok('a sell rounds UP, never below its limit', sent[5].body.yes_price === 51, sent[5].body);
    ok('an exact cent is unchanged either way', await (async () => {
      await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, limit: 0.53, key: 'k7' });
      await b.sell({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 1, px: 0.53, key: 'k8' });
      return sent[6].body.yes_price === 53 && sent[7].body.yes_price === 53;
    })(), [sent[6] && sent[6].body.yes_price, sent[7] && sent[7].body.yes_price]);
  }

  group('the fee fallback bills the right series');
  {
    // The taker multiplier is per-series: MLB is 0.5 and fourteen series are 0. Dropping `ref`
    // billed everything at the full rate. Only reached when the exchange does not report fees.
    await ks.loadFeeMultipliers(['KXMLBGAME', 'KXTEST']);
    ok('the multiplier table loaded', ks.multFor('KXMLBGAME-26SEP08NYY') === 0.5 && ks.multFor('KXTEST-A') === 1, [ks.multFor('KXMLBGAME-x'), ks.multFor('KXTEST-A')]);
    b.request = async (m, p, body) => ({ order: { order_id: 'o', fill_count: body.count, taker_fill_cost_dollars: body.count * 0.50 } });
    const mlb = await b.buy({ venue: 'KS', ref: 'KXMLBGAME-26SEP08NYY', side: 'yes', qty: 100, limit: 0.50, key: 'f1' });
    const plain = await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 100, limit: 0.50, key: 'f2' });
    ok('a half-rate series is billed half', Math.abs(mlb.fee - plain.fee / 2) < 0.02, { mlb: mlb.fee, plain: plain.fee });
    ok('...which only happens because ref is forwarded', mlb.fee < plain.fee, { mlb: mlb.fee, plain: plain.fee });
  }

  group('live mode refuses Polymarket legs rather than pretending');
  {
    const r = await b.buy({ venue: 'PM', ref: null, side: 'yes', qty: 10, limit: 0.5, key: 'k' });
    ok('a PM buy is refused', r.filled === 0 && /not implemented/.test(r.reason), r);
    const s = await b.sell({ venue: 'PM', ref: null, side: 'yes', qty: 10, px: 0.5, key: 'k' });
    ok('a PM sell is refused', s.filled === 0 && /not implemented/.test(s.reason), s);
  }

  group('reconciliation refuses to trade against an unverified book');
  {
    // The rail: kill the process between a fill and a save and there are contracts at the exchange
    // the desk does not know it owns -- invisible to every risk control.
    E.liveReady = false;
    E.state.positions = [{ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 10 }];
    b.request = async () => ({ market_positions: [{ ticker: 'KXTEST-A', position: 10 }] });
    await b.reconcile();
    ok('agreement enables trading', E.liveReady === true, E.logs.slice(-1));

    E.liveReady = false;
    b.request = async () => ({ market_positions: [{ ticker: 'KXTEST-A', position: 25 }] });
    await b.reconcile();
    ok('a quantity mismatch stays halted', E.liveReady === false, E.logs.slice(-1));
    ok('...and says so', /MISMATCH/.test(E.logs[E.logs.length - 1]), E.logs.slice(-1));

    // Kalshi signs NO positions negative; a desk that got that backwards would "reconcile" a
    // short against a long and trade on a book that is inverted.
    E.liveReady = false;
    E.state.positions = [{ venue: 'KS', ref: 'KXTEST-B', side: 'no', qty: 4 }];
    b.request = async () => ({ market_positions: [{ ticker: 'KXTEST-B', position: -4 }] });
    await b.reconcile();
    ok('a NO position reconciles as negative', E.liveReady === true, E.logs.slice(-1));

    // Reading ONE page and calling it the whole account is unsafe in exactly the direction that
    // matters: an empty first page against an empty local book reconciles clean and enables
    // trading while real contracts sit unmanaged on a later page.
    E.liveReady = false;
    E.state.positions = [];
    let page = 0;
    b.request = async () => (page++ === 0
      ? { market_positions: [], cursor: 'p2' }
      : { market_positions: [{ ticker: 'KXGHOST', position: 40 }] });
    await b.reconcile();
    ok('a position on page two is not missed', E.liveReady === false, E.logs.slice(-1));
    ok('...and is named in the mismatch', /KXGHOST/.test(E.logs[E.logs.length - 1]), E.logs.slice(-1));

    // A capped walk that still has a cursor has not verified the whole remote book. Enabling live
    // trading here would recreate the one-page bug at a larger account size.
    E.liveReady = false;
    E.state.positions = [];
    let pages = 0;
    b.request = async () => { pages++; return { market_positions: [], cursor: 'still-more' }; };
    await b.reconcile();
    ok('a remaining cursor at the page cap stays halted', E.liveReady === false, E.logs.slice(-1));
    ok('the cap makes exactly 50 requests, never a quiet partial reconcile', pages === 50, pages);
    ok('...and reports the pagination failure', /pagination reached 50 pages/.test(E.logs[E.logs.length - 1]), E.logs.slice(-1));

    E.liveReady = false;
    b.request = async () => { throw new Error('network down'); };
    await b.reconcile();
    ok('an unreachable exchange stays halted', E.liveReady === false);
    ok('...rather than assuming the book is right', /staying halted/.test(E.logs[E.logs.length - 1]), E.logs.slice(-1));
  }

  group('an ambiguous live POST stops both entry and exit retries');
  {
    E.state.pendingOrders = [];
    E.liveReady = true;
    E.journals = [];
    E.saves = 0;
    let posts = 0, intentWasPersisted = false;
    b.request = async (m, p, body) => {
      posts++;
      intentWasPersisted = m === 'POST' && E.saves > 0 && E.state.pendingOrders.length === 1
        && E.state.pendingOrders[0].clientOrderId === body.client_order_id
        && E.journals.some((x) => x.kind === 'ORDER_INTENT');
      throw new Error('socket closed after write');
    };
    let entryError;
    try { await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 3, limit: 0.50, key: 'unknown-entry' }); }
    catch (e) { entryError = e; }
    ok('entry intent is persisted before its POST', intentWasPersisted && posts === 1, { intentWasPersisted, posts });
    ok('an unknown entry is typed for the engine', entryError && entryError.code === 'KALSHI_ORDER_UNKNOWN' && entryError.ambiguousOrder === true, entryError && { code: entryError.code, intent: entryError.intent });
    ok('an unknown entry disables live readiness and leaves its intent', E.liveReady === false && E.state.pendingOrders.length === 1 && E.journals.some((x) => x.kind === 'ORDER_UNKNOWN'), { liveReady: E.liveReady, pending: E.state.pendingOrders, journals: E.journals });

    let blockedPosts = 0, blockedError;
    b.request = async () => { blockedPosts++; return { order: { order_id: 'must-not-send', fill_count: 0 } }; };
    try { await b.buy({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 3, limit: 0.50, key: 'new-key-must-not-send' }); }
    catch (e) { blockedError = e; }
    ok('a later entry cannot send a new client id while outcome is unknown', blockedError && blockedError.code === 'KALSHI_ORDER_UNKNOWN' && blockedPosts === 0, { code: blockedError && blockedError.code, blockedPosts });

    // A restart calls reconcile; an unresolved persisted intent must block that path before a
    // positions request can quietly declare the account clean.
    let reconcileRequests = 0;
    b.request = async () => { reconcileRequests++; return { market_positions: [] }; };
    await b.reconcile();
    ok('startup reconciliation refuses an unresolved intent without querying positions', E.liveReady === false && reconcileRequests === 0 && /unresolved Kalshi order intent/.test(E.logs[E.logs.length - 1]), E.logs.slice(-1));

    // Simulate the operator having reconciled and cleared the previous intent, then verify that
    // the same rail covers an exit -- the dangerous case because RIGO otherwise keeps retrying.
    E.state.pendingOrders = [];
    E.liveReady = true;
    let exitError;
    b.request = async () => { throw new Error('connection reset after exit write'); };
    try { await b.sell({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 3, px: 0.50, key: 'unknown-exit' }); }
    catch (e) { exitError = e; }
    ok('an unknown exit carries the same typed rail and saved sell intent', exitError && exitError.code === 'KALSHI_ORDER_UNKNOWN' && exitError.intent.action === 'sell' && E.state.pendingOrders.length === 1, exitError && exitError.intent);

    let afterExitPosts = 0;
    b.request = async () => { afterExitPosts++; return { order: { order_id: 'must-not-send', fill_count: 0 } }; };
    try { await b.sell({ venue: 'KS', ref: 'KXTEST-A', side: 'yes', qty: 3, px: 0.50, key: 'new-exit-must-not-send' }); }
    catch {}
    ok('an unknown exit blocks a later automatic sell retry', afterExitPosts === 0, afterExitPosts);
  }

  fs.rmSync(dir, { recursive: true, force: true });
}

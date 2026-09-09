'use strict';
// Brokers only report fills. The engine owns cash and positions.
const fs = require('fs');
const crypto = require('crypto');
const ks = require('./venues/kalshi');

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;

// Walk an ask ladder (best first) up to a limit price.
function walk(asks, qty, limit) {
  let filled = 0, cost = 0;
  for (const l of asks) {
    if (l.price > limit + 1e-9) break;
    const take = Math.min(qty - filled, l.size);
    filled += take; cost += take * l.price;
    if (filled >= qty - 1e-9) break;
  }
  return { filled: Math.floor(filled), avg: filled ? cost / filled : 0 };
}

class PaperBroker {
  constructor(cfg, engine) { this.cfg = cfg; this.E = engine; this.kind = 'paper'; }
  async init() {}
  feeFor(venue, qty, px, ref) { return venue === 'KS' ? ks.fee(qty, px, this.cfg.ksFeeRate, ref) : r2(this.cfg.pmTakerFee * qty * px); }
  // book: asks for the side being bought (already oriented: YES asks or NO asks)
  async buy({ venue, ref, qty, limit, book }) { // `key` accepted and ignored: paper fills cannot double-send
    const { filled, avg } = walk(book, qty, limit);
    if (filled < 1) return { filled: 0, reason: 'no depth inside limit' };
    const fee = this.feeFor(venue, filled, avg, ref);
    return { filled, avg: r4(avg), fee, cost: r2(filled * avg + fee) };
  }
  async sell({ venue, ref, qty, px }) {
    const fee = this.feeFor(venue, qty, px, ref);
    return { filled: qty, avg: r4(px), fee, proceeds: r2(qty * px - fee) };
  }
}

// Live Kalshi adapter: RSA-PSS signed REST calls. Polymarket live execution is intentionally
// not implemented (needs EIP-712 wallet signing); in live mode only Kalshi legs are traded.
class LiveKalshiBroker extends PaperBroker {
  constructor(cfg, engine) {
    super(cfg, engine);
    this.kind = 'live';
    this.keyId = cfg.kalshiKeyId;
    this.key = crypto.createPrivateKey(fs.readFileSync(cfg.kalshiKeyPath, 'utf8'));
    this.host = 'https://api.elections.kalshi.com';
  }
  headers(method, fullPath) {
    const ts = Date.now().toString();
    const sig = crypto.sign('sha256', Buffer.from(ts + method + fullPath), {
      key: this.key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
    return { 'KALSHI-ACCESS-KEY': this.keyId, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts, 'content-type': 'application/json', accept: 'application/json' };
  }
  async request(method, p, body) {
    const fullPath = '/trade-api/v2' + p;
    const r = await fetch(this.host + fullPath, { method, headers: this.headers(method, fullPath), body: body ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(`Kalshi ${r.status}: ${JSON.stringify(j).slice(0, 200)}`);
    return j;
  }
  async init() {
    const b = await this.request('GET', '/portfolio/balance');
    const dollars = (b.balance_dollars != null) ? +b.balance_dollars : (+b.balance || 0) / 100;
    this.E.liveBalance = dollars;
    this.E.log('TESS', 'OPS', null, `Kalshi live session authenticated · exchange balance $${dollars.toFixed(2)} · Polymarket legs disabled (read-only)`);
    await this.reconcile();
  }

  // The local ledger is a file saved every 10s. Kill the process between a fill and a save and
  // there are real contracts at the exchange this desk does not know it owns -- invisible to
  // every risk control, marked at nothing, exited never. Trading resumes only once what the
  // exchange reports matches what the book says, so a mismatch surfaces before it costs money
  // rather than after.
  async reconcile() {
    let remote;
    try {
      const r = await this.request('GET', '/portfolio/positions');
      remote = new Map();
      for (const p of (r.market_positions || [])) {
        const n = Math.round(+(p.position_fp ?? p.position ?? 0));
        if (n !== 0) remote.set(p.ticker, n);
      }
    } catch (e) {
      this.E.log('TESS', 'OPS', null, `reconciliation failed (${String(e.message).slice(0, 90)}) · staying halted rather than trading against an unverified book`);
      return; // liveReady stays false: TESS halts on 'live venue not authenticated'
    }
    // local view, signed the way Kalshi reports it: YES positive, NO negative
    const local = new Map();
    for (const p of this.E.state.positions) {
      if (p.venue !== 'KS') continue;
      local.set(p.ref, (local.get(p.ref) || 0) + (p.side === 'yes' ? p.qty : -p.qty));
    }
    const diffs = [];
    for (const t of new Set([...remote.keys(), ...local.keys()])) {
      const r = remote.get(t) || 0, l = local.get(t) || 0;
      if (r !== l) diffs.push(`${t}: exchange ${r}, book ${l}`);
    }
    if (diffs.length) {
      this.E.log('TESS', 'OPS', null, `RECONCILIATION MISMATCH · ${diffs.length} ticker(s) · ${diffs.slice(0, 3).join(' | ')}${diffs.length > 3 ? ' | …' : ''} · refusing to trade until the book matches the exchange`);
      return; // liveReady stays false
    }
    this.E.liveReady = true;
    this.E.log('TESS', 'OPS', null, `reconciled · exchange and local book agree on ${remote.size} open Kalshi position(s)`);
  }
  // `key` is the caller's idempotency key, derived from the group and leg rather than random.
  // A fresh UUID per attempt -- the old behaviour -- means a request retried after a timeout
  // opens a SECOND position, because the exchange has no way to recognise it as the same order.
  async place({ ref, action, side, qty, limit, key }) {
    const clientId = key ? crypto.createHash('sha256').update(String(key)).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5') : crypto.randomUUID();
    const body = { ticker: ref, action, side, type: 'limit', count: qty, time_in_force: 'immediate_or_cancel', client_order_id: clientId };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = Math.max(1, Math.min(99, Math.round(limit * 100)));
    const res = await this.request('POST', '/portfolio/orders', body);
    const o = res.order || {};
    const filled = Math.floor(+(o.fill_count_fp ?? o.fill_count ?? 0));
    const fillCost = o.taker_fill_cost_dollars != null ? +o.taker_fill_cost_dollars : null;
    const fee = o.taker_fees_dollars != null ? +o.taker_fees_dollars : null;
    return { o, filled, fillCost, fee };
  }
  async buy({ venue, ref, side, qty, limit, key }) {
    if (venue !== 'KS') return { filled: 0, reason: 'Polymarket live execution not implemented' };
    const { o, filled, fillCost, fee } = await this.place({ ref, action: 'buy', side, qty, limit, key });
    if (filled < 1) return { filled: 0, reason: `order ${o.status || 'unfilled'}` };
    const avg = fillCost != null ? fillCost / filled : limit;
    const f = fee != null ? fee : this.feeFor('KS', filled, avg);
    return { filled, avg: r4(avg), fee: f, cost: r2(filled * avg + f), orderId: o.order_id };
  }
  async sell({ venue, ref, side, qty, px, key }) {
    if (venue !== 'KS') return { filled: 0, reason: 'Polymarket live execution not implemented' };
    const { o, filled, fillCost, fee } = await this.place({ ref, action: 'sell', side, qty, limit: px, key });
    if (filled < 1) return { filled: 0, reason: `order ${o.status || 'unfilled'}` };
    const avg = fillCost != null ? fillCost / filled : px;
    const f = fee != null ? fee : this.feeFor('KS', filled, avg);
    return { filled, avg: r4(avg), fee: f, proceeds: r2(filled * avg - f), orderId: o.order_id };
  }
}

function makeBroker(cfg, engine) {
  return cfg.mode === 'live' ? new LiveKalshiBroker(cfg, engine) : new PaperBroker(cfg, engine);
}

module.exports = { makeBroker, walk };

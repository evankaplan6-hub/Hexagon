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
  feeFor(venue, qty, px) { return venue === 'KS' ? ks.fee(qty, px, this.cfg.ksFeeRate) : r2(this.cfg.pmTakerFee * qty * px); }
  // book: asks for the side being bought (already oriented: YES asks or NO asks)
  async buy({ venue, qty, limit, book }) {
    const { filled, avg } = walk(book, qty, limit);
    if (filled < 1) return { filled: 0, reason: 'no depth inside limit' };
    const fee = this.feeFor(venue, filled, avg);
    return { filled, avg: r4(avg), fee, cost: r2(filled * avg + fee) };
  }
  async sell({ venue, qty, px }) {
    const fee = this.feeFor(venue, qty, px);
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
    this.E.liveReady = true;
    this.E.log('TESS', 'OPS', null, `Kalshi live session authenticated · exchange balance $${dollars.toFixed(2)} · Polymarket legs disabled (read-only)`);
  }
  async place({ ref, action, side, qty, limit }) {
    const body = { ticker: ref, action, side, type: 'limit', count: qty, time_in_force: 'immediate_or_cancel', client_order_id: crypto.randomUUID() };
    body[side === 'yes' ? 'yes_price' : 'no_price'] = Math.max(1, Math.min(99, Math.round(limit * 100)));
    const res = await this.request('POST', '/portfolio/orders', body);
    const o = res.order || {};
    const filled = Math.floor(+(o.fill_count_fp ?? o.fill_count ?? 0));
    const fillCost = o.taker_fill_cost_dollars != null ? +o.taker_fill_cost_dollars : null;
    const fee = o.taker_fees_dollars != null ? +o.taker_fees_dollars : null;
    return { o, filled, fillCost, fee };
  }
  async buy({ venue, ref, side, qty, limit }) {
    if (venue !== 'KS') return { filled: 0, reason: 'Polymarket live execution not implemented' };
    const { o, filled, fillCost, fee } = await this.place({ ref, action: 'buy', side, qty, limit });
    if (filled < 1) return { filled: 0, reason: `order ${o.status || 'unfilled'}` };
    const avg = fillCost != null ? fillCost / filled : limit;
    const f = fee != null ? fee : this.feeFor('KS', filled, avg);
    return { filled, avg: r4(avg), fee: f, cost: r2(filled * avg + f), orderId: o.order_id };
  }
  async sell({ venue, ref, side, qty, px }) {
    if (venue !== 'KS') return { filled: 0, reason: 'Polymarket live execution not implemented' };
    const { o, filled, fillCost, fee } = await this.place({ ref, action: 'sell', side, qty, limit: px });
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

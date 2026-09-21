'use strict';
// Brokers only report fills. The engine owns cash and positions.
const fs = require('fs');
const crypto = require('crypto');
const ks = require('./venues/kalshi');
const pm = require('./venues/polymarket');

const r2 = (x) => Math.round(x * 100) / 100;
const r4 = (x) => Math.round(x * 10000) / 10000;
const MAX_RECONCILE_PAGES = 50;

// A POST whose response is lost is not an ordinary failed order: the exchange may have accepted
// and filled it. Callers must stop rather than mint a new client id and accidentally double it.
class AmbiguousOrderError extends Error {
  constructor(intent, cause) {
    super(`Kalshi ${intent.action} outcome unknown for ${intent.clientOrderId} · refusing further live orders until reconciliation`);
    this.name = 'AmbiguousOrderError';
    this.code = 'KALSHI_ORDER_UNKNOWN';
    this.ambiguousOrder = true;
    this.clientOrderId = intent.clientOrderId;
    this.intent = { ...intent };
    if (cause) this.cause = cause;
  }
}

// Walk an ask ladder (best first) up to a limit price.
function walk(asks, qty, limit) {
  let filled = 0, cost = 0;
  // `|| []` because the sizing path already guards the same value that way (decide.sizePlan) and
  // this is the side of it that spends money -- a one-sided book must be a no-fill, not a throw.
  for (const l of asks || []) {
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
  // `feeRate` is the Polymarket market's own taker rate (shares x rate x p x (1-p)); a caller that
  // does not know it is billed at cfg.pmFeeFallback, the highest category rate.
  feeFor(venue, qty, px, ref, feeRate) {
    if (venue === 'KS') return ks.fee(qty, px, this.cfg.ksFeeRate, ref);
    return r2(pm.fee(qty, px, Number.isFinite(feeRate) ? feeRate : this.cfg.pmFeeFallback));
  }
  // book: asks for the side being bought (already oriented: YES asks or NO asks)
  async buy({ venue, ref, qty, limit, book, feeRate }) { // `key` accepted and ignored: paper fills cannot double-send
    const { filled, avg } = walk(book, qty, limit);
    if (filled < 1) return { filled: 0, reason: 'no depth inside limit' };
    const fee = this.feeFor(venue, filled, avg, ref, feeRate);
    return { filled, avg: r4(avg), fee, cost: r2(filled * avg + fee) };
  }
  // `book`, when the engine could fetch one, is the OTHER side's ask ladder (engine.exitLadder):
  // selling YES at p is buying NO at 1-p, so those asks are this side's bids, mirrored. Walked
  // down to `px - slipLimit`, exactly as a buy walks up to its limit. Without a ladder the sale
  // fills at `px` in full, which is what every sale did before: unlimited depth at the bid, a
  // 207-lot exit priced like a 5-lot. The live broker never sees this; the exchange has the book.
  async sell({ venue, ref, qty, px, feeRate, book }) {
    let filled = qty, avg = px;
    if (Array.isArray(book)) {
      const w = walk(book, qty, 1 - (px - this.cfg.slipLimit));
      if (w.filled < 1) return { filled: 0, reason: 'no bids inside limit' };
      filled = w.filled; avg = 1 - w.avg;
    }
    const fee = this.feeFor(venue, filled, avg, ref, feeRate);
    return { filled, avg: r4(avg), fee, proceeds: r2(filled * avg - fee) };
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
  headers(method, signingPath) {
    const ts = Date.now().toString();
    const sig = crypto.sign('sha256', Buffer.from(ts + method + signingPath), {
      key: this.key, padding: crypto.constants.RSA_PKCS1_PSS_PADDING, saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    }).toString('base64');
    return { 'KALSHI-ACCESS-KEY': this.keyId, 'KALSHI-ACCESS-SIGNATURE': sig, 'KALSHI-ACCESS-TIMESTAMP': ts, 'content-type': 'application/json', accept: 'application/json' };
  }
  async request(method, p, body) {
    const requestPath = '/trade-api/v2' + p;
    // Kalshi signs the pathname from the API root, specifically excluding query parameters. The
    // cursor still belongs in the URL -- only the signature omits it.
    const signingPath = requestPath.split('?')[0];
    const r = await fetch(this.host + requestPath, { method, headers: this.headers(method, signingPath), body: body ? JSON.stringify(body) : undefined });
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
    // A failed re-check must never leave a formerly-ready live session trading. This is also the
    // latch an ambiguous order uses until an operator has reconciled its persisted intent.
    this.E.liveReady = false;
    let remote;
    try {
      const pending = this.pendingOrders();
      if (pending.length) {
        const ids = pending.slice(0, 3).map((o) => o.clientOrderId).join(', ');
        this.E.log('TESS', 'OPS', null, `unresolved Kalshi order intent${pending.length === 1 ? '' : 's'} (${ids}${pending.length > 3 ? ', …' : ''}) · staying halted until reconciled`);
        return;
      }
      // FOLLOW THE CURSOR. Reading one page and treating it as the whole account is only safe in
      // the direction that finds too FEW remote positions -- and that is the dangerous one: an
      // empty first page against an empty local book reconciles clean and enables trading while
      // real contracts sit unmanaged on a later page. Bounded so a broken cursor cannot spin.
      remote = new Map();
      let cursor = null, pages = 0;
      do {
        if (pages >= MAX_RECONCILE_PAGES) throw new Error(`position pagination reached ${MAX_RECONCILE_PAGES} pages with a cursor still remaining`);
        const r = await this.request('GET', `/portfolio/positions${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`);
        pages++;
        for (const p of (r.market_positions || [])) {
          const n = Math.round(+(p.position_fp ?? p.position ?? 0));
          if (n !== 0) remote.set(p.ticker, n);
        }
        cursor = r.cursor || null;
      } while (cursor);
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

  // Persist intent before a live POST. If the response disappears, state.json survives the
  // restart and blocks every later order until the operator reconciles the exchange outcome.
  pendingOrders() {
    if (!this.E || !this.E.state) throw new Error('live broker has no engine ledger for order intent');
    if (this.E.state.pendingOrders == null) this.E.state.pendingOrders = [];
    if (!Array.isArray(this.E.state.pendingOrders)) throw new Error('pending order ledger is malformed');
    return this.E.state.pendingOrders;
  }
  persist() {
    this.E.dirty = true;
    if (typeof this.E.save === 'function') this.E.save();
  }
  audit(kind, payload) {
    if (typeof this.E.journal === 'function') this.E.journal(this.E, kind, payload);
  }
  assertNoPendingOrder() {
    const pending = this.pendingOrders();
    if (!pending.length) return;
    this.E.liveReady = false;
    throw new AmbiguousOrderError(pending[0]);
  }
  recordIntent(intent) {
    this.pendingOrders().push(intent);
    this.audit('ORDER_INTENT', intent);
    this.persist();
  }
  clearIntent(clientOrderId, orderId) {
    const pending = this.pendingOrders();
    const at = pending.findIndex((o) => o.clientOrderId === clientOrderId);
    if (at < 0) throw new Error(`missing persisted intent for acknowledged Kalshi order ${clientOrderId}`);
    pending.splice(at, 1);
    this.audit('ORDER_ACK', { clientOrderId, orderId });
    this.persist();
  }
  markUnknown(intent, cause) {
    const saved = this.pendingOrders().find((o) => o.clientOrderId === intent.clientOrderId) || intent;
    saved.unknownAt = new Date().toISOString();
    saved.error = String(cause && cause.message || cause || 'unknown order outcome').slice(0, 180);
    this.E.liveReady = false;
    this.audit('ORDER_UNKNOWN', { clientOrderId: saved.clientOrderId, action: saved.action, ref: saved.ref, side: saved.side, qty: saved.qty, error: saved.error });
    this.persist();
    return new AmbiguousOrderError(saved, cause);
  }

  // `key` is the caller's idempotency key, derived from the group and leg rather than random.
  // A fresh UUID per attempt -- the old behaviour -- means a request retried after a timeout
  // opens a SECOND position, because the exchange has no way to recognise it as the same order.
  async place({ ref, action, side, qty, limit, key }) {
    this.assertNoPendingOrder();
    const clientId = key ? crypto.createHash('sha256').update(String(key)).digest('hex').replace(/(.{8})(.{4})(.{4})(.{4})(.{12}).*/, '$1-$2-$3-$4-$5') : crypto.randomUUID();
    const body = { ticker: ref, action, side, type: 'limit', count: qty, time_in_force: 'immediate_or_cancel', client_order_id: clientId };
    // Kalshi prices are integer cents. ROUNDING can cross the caller's limit -- a buy limit of
    // 50.5c rounds to 51c and pays a cent more than the edge was priced at, which on a MIN_EDGE of
    // 0.5c is the whole trade. Round in the direction that respects the limit: down for a buy, up
    // for a sell. The 1..99 clamp stays; the exchange rejects 0 and 100.
    const cents = action === 'buy' ? Math.floor(limit * 100 + 1e-9) : Math.ceil(limit * 100 - 1e-9);
    body[side === 'yes' ? 'yes_price' : 'no_price'] = Math.max(1, Math.min(99, cents));
    const intent = {
      clientOrderId: clientId, action, ref, side, qty,
      limitCents: body[side === 'yes' ? 'yes_price' : 'no_price'], submittedAt: new Date().toISOString(),
    };
    this.recordIntent(intent);
    let res;
    try {
      res = await this.request('POST', '/portfolio/orders', body);
      // An OK status with no order is no proof that the POST did not reach the matching engine.
      // Treat it exactly like a lost response rather than returning a fake zero fill.
      if (!res || !res.order || !res.order.order_id) throw new Error('Kalshi POST response did not include an order id');
    } catch (e) {
      throw this.markUnknown(intent, e);
    }
    const o = res.order;
    this.clearIntent(clientId, o.order_id);
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
    // `ref` matters: the taker multiplier is per-series (MLB is 0.5, fourteen series are 0).
    // Dropping it billed every series at the full rate -- the safe direction, but still wrong.
    const f = fee != null ? fee : this.feeFor('KS', filled, avg, ref);
    return { filled, avg: r4(avg), fee: f, cost: r2(filled * avg + f), orderId: o.order_id };
  }
  async sell({ venue, ref, side, qty, px, key }) {
    if (venue !== 'KS') return { filled: 0, reason: 'Polymarket live execution not implemented' };
    const { o, filled, fillCost, fee } = await this.place({ ref, action: 'sell', side, qty, limit: px, key });
    if (filled < 1) return { filled: 0, reason: `order ${o.status || 'unfilled'}` };
    const avg = fillCost != null ? fillCost / filled : px;
    const f = fee != null ? fee : this.feeFor('KS', filled, avg, ref);
    return { filled, avg: r4(avg), fee: f, proceeds: r2(filled * avg - f), orderId: o.order_id };
  }
}

function makeBroker(cfg, engine) {
  return cfg.mode === 'live' ? new LiveKalshiBroker(cfg, engine) : new PaperBroker(cfg, engine);
}

module.exports = { makeBroker, walk };

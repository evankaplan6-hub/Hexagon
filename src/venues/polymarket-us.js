'use strict';
// Polymarket US (polymarket.us) — the CFTC-regulated, US-persons exchange. A separate product from
// polymarket.com: its own market catalog (slugs like "tec-mlb-nlchamp-2026-09-27-nym"), its own
// Ed25519-signed REST API, no relation to the Gamma/CLOB endpoints in polymarket.js.
//
// Signing, verified live against a real account on 2026-09-09:
//   message   = `${timestampMs}${method}${pathname}`   (no query string, no body)
//   signature = base64(Ed25519_sign(message, seed))    where seed = base64decode(secretKey).slice(0, 32)
//   headers   = X-PM-Access-Key, X-PM-Timestamp, X-PM-Signature
// Confirmed working: GET /v1/portfolio/positions, /v1/account/balances, /v1/orders/open,
// /v1/markets (?closed=false is the live-market filter; ?active=true is not), /v1/markets/{slug}/book,
// /v1/markets/{slug}/bbo. POST /v1/orders (create) matches the published schema but has NOT been
// exercised — the account had $0.81 buying power at write time, so a real order was never sent.
//
// NOT wired into the trading engine: as of 2026-09-09 Polymarket US's entire open catalog is
// season-long futures (championship winners, election winners). It carries none of the daily game
// or Fed-decision markets this desk matches against Kalshi, so there is currently nothing for
// KETT to execute here. This module is verified, standalone infrastructure for whenever that
// changes (or for a separate futures-matching strategy) — see README "Polymarket US" section.

const BASE = 'https://api.polymarket.us';
const PKCS8_ED25519_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function keyFromSecret(secretB64) {
  const seed = Buffer.from(secretB64, 'base64').slice(0, 32);
  if (seed.length !== 32) throw new Error('Polymarket US secret key did not decode to >=32 bytes');
  return require('crypto').createPrivateKey({ key: Buffer.concat([PKCS8_ED25519_PREFIX, seed]), format: 'der', type: 'pkcs8' });
}

class PolymarketUSClient {
  constructor({ keyId, secretKey }) {
    this.keyId = keyId;
    this.privateKey = keyFromSecret(secretKey);
  }
  sign(method, pathname) {
    const crypto = require('crypto');
    const ts = Date.now().toString();
    const sig = crypto.sign(null, Buffer.from(ts + method + pathname), this.privateKey).toString('base64');
    return { 'X-PM-Access-Key': this.keyId, 'X-PM-Timestamp': ts, 'X-PM-Signature': sig, 'content-type': 'application/json' };
  }
  async request(method, path, body) {
    const pathname = path.split('?')[0];
    const r = await fetch(BASE + path, { method, headers: this.sign(method, pathname), body: body ? JSON.stringify(body) : undefined });
    const json = await r.json().catch(() => null);
    if (!r.ok) throw new Error(`Polymarket US ${r.status} ${path}: ${JSON.stringify(json).slice(0, 200)}`);
    return json;
  }

  fetchBalance() { return this.request('GET', '/v1/account/balances'); }
  fetchPositions() { return this.request('GET', '/v1/portfolio/positions'); }
  fetchOpenOrders() { return this.request('GET', '/v1/orders/open'); }

  // closed=false is the live-market filter (active=true is accepted but ignored server-side).
  async fetchOpenMarkets({ limit = 500, maxPages = 10 } = {}) {
    const out = [];
    for (let p = 0; p < maxPages; p++) {
      const page = await this.request('GET', `/v1/markets?limit=${limit}&offset=${p * limit}&closed=false`);
      const ms = (page && page.markets) || [];
      out.push(...ms);
      if (ms.length < limit) break;
    }
    return out;
  }
  fetchBook(slug) { return this.request('GET', `/v1/markets/${encodeURIComponent(slug)}/book`); }
  fetchBBO(slug) { return this.request('GET', `/v1/markets/${encodeURIComponent(slug)}/bbo`); }

  // side: 'yes' | 'no'; price: dollars (string or number); quantity: contracts.
  createOrder({ marketSlug, side, price, quantity, tif = 'TIME_IN_FORCE_GOOD_TILL_CANCEL' }) {
    return this.request('POST', '/v1/orders', {
      marketSlug,
      type: 'ORDER_TYPE_LIMIT',
      price: { value: String(price), currency: 'USD' },
      quantity,
      tif,
      intent: 'ORDER_INTENT_BUY_LONG',
      outcomeSide: side === 'yes' ? 'OUTCOME_SIDE_YES' : 'OUTCOME_SIDE_NO',
      manualOrderIndicator: 'MANUAL_ORDER_INDICATOR_AUTOMATIC',
    });
  }
}

module.exports = { PolymarketUSClient };

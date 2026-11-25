// Shared helpers of the payments tests (import AFTER one of the ./payments.env*.js files).
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { get } from '../src/db/index.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as catalog from '../src/services/catalog.js';
import * as paymentsRepo from '../src/services/payments.js';
import { makeCatalog, makePlan, CUSTOMER, DELIVERY } from './helpers/fixtures.js';
import { PAYME_KEY, CLICK_SECRET_KEY, CLICK_SERVICE_ID } from './payments.env.js';

export const HOUR = 60 * 60 * 1000;

/** A fresh unpaid product order (one product, `qty` pieces). Returns { order, product }. */
export function makeOrder({ qty = 2, price = 120000, stock = 10, channel = 'site', tgUserId } = {}) {
  const { products } = makeCatalog(1, { price, stock });
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, qty);
  const order = orders.createFromCart(ref, { customer: CUSTOMER, delivery: DELIVERY, channel, tgUserId });
  return { order, product: products[0] };
}

/** Another unpaid order for `qty` pieces of an existing product (a rival for the same stock). */
export function makeOrderFor(product, qty = 1) {
  const ref = { token: cart.newToken() };
  cart.addItem(ref, product.id, qty);
  return orders.createFromCart(ref, { customer: { ...CUSTOMER, phone: '+998 90 765 43 21' }, delivery: DELIVERY });
}

/** A fresh unpaid subscription order. Returns { order, plan }. */
export function makeSubscriptionOrder({ price = 189000 } = {}) {
  const plan = makePlan({ price });
  const order = orders.createSubscriptionOrder({ planId: plan.id, customer: CUSTOMER });
  return { order, plan };
}

export const stockOf = (product) => catalog.getProduct(product.id).stock;
export const purchaseEvents = (orderId) => get(`SELECT COUNT(*) AS n FROM events WHERE name = 'purchase' AND order_id = ?`, orderId).n;
export const paidRows = (orderId) => paymentsRepo.listByOrder(orderId).filter((p) => p.status === 'paid');

// ─────────────────────────────── Payme

export const paymeAuth = (key = PAYME_KEY, login = 'Paycom') => `Basic ${Buffer.from(`${login}:${key}`).toString('base64')}`;
export const paymeTxId = () => crypto.randomBytes(12).toString('hex');

/**
 * JSON-RPC client of POST /pay/payme. rpc(method, params, { auth, id, rawBody, contentType, httpMethod })
 * resolves with the parsed JSON-RPC answer and asserts the transport rules (HTTP 200, id echoed).
 */
export function paymeClient(baseUrl) {
  let seq = 100;
  return async function rpc(method, params, { auth = paymeAuth(), id = ++seq, rawBody, contentType = 'application/json', httpMethod = 'POST' } = {}) {
    const res = await fetch(`${baseUrl}/pay/payme`, {
      method: httpMethod,
      headers: { ...(httpMethod === 'POST' ? { 'content-type': contentType } : {}), ...(auth ? { authorization: auth } : {}) },
      body: httpMethod === 'POST' ? rawBody ?? JSON.stringify({ jsonrpc: '2.0', id, method, params }) : undefined,
    });
    assert.equal(res.status, 200, 'Payme answers are always HTTP 200');
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('set-cookie'), null, 'callbacks never receive cookies');
    const json = await res.json();
    assert.equal(json.jsonrpc, '2.0');
    assert.ok(('result' in json) !== ('error' in json), 'exactly one of result / error');
    if (rawBody === undefined && httpMethod === 'POST') assert.equal(json.id, id, 'request id is echoed');
    if (json.error) {
      assert.equal(typeof json.error.code, 'number');
      for (const lang of ['ru', 'uz', 'en']) assert.ok(json.error.message[lang], `error message has "${lang}"`);
    }
    return json;
  };
}

// ─────────────────────────────── Click

/** md5 signature exactly as the Click SHOP API documents it (independent of the provider code). */
export function clickSign(f, { complete = false, secret = CLICK_SECRET_KEY } = {}) {
  const s = `${f.click_trans_id}${f.service_id}${secret}${f.merchant_trans_id}${complete ? f.merchant_prepare_id : ''}${f.amount}${f.action}${f.sign_time}`;
  return crypto.createHash('md5').update(s).digest('hex');
}

let clickSeq = 7_000_000;
export const clickTransId = () => String(++clickSeq);

/** Fields of a Prepare (action 0) / Complete (action 1) callback for an order. */
export function clickFields(order, { clickTransId: id = clickTransId(), prepareId, amount = order.total, error = '0', errorNote = 'Success' } = {}) {
  return {
    click_trans_id: id,
    service_id: CLICK_SERVICE_ID,
    click_paydoc_id: String(Number(id) + 500),
    merchant_trans_id: String(order.id),
    ...(prepareId !== undefined ? { merchant_prepare_id: String(prepareId) } : {}),
    amount: String(amount),
    action: prepareId !== undefined ? '1' : '0',
    error: String(error),
    error_note: errorNote,
    sign_time: '2026-03-01 12:30:45',
  };
}

/**
 * Client of POST /pay/click/{prepare,complete}: call(step, fields, { sign, secret }) signs the
 * fields (unless sign_string is given or sign=false) and resolves with the JSON answer.
 */
export function clickClient(baseUrl) {
  return async function call(step, fields, { sign = true, secret } = {}) {
    const body = { ...fields };
    if (sign && body.sign_string === undefined) body.sign_string = clickSign(body, { complete: step === 'complete', secret });
    const res = await fetch(`${baseUrl}/pay/click/${step}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    });
    assert.equal(res.status, 200, 'Click answers are always HTTP 200');
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('set-cookie'), null, 'callbacks never receive cookies');
    const json = await res.json();
    assert.equal(typeof json.error, 'number');
    assert.equal(typeof json.error_note, 'string');
    return json;
  };
}

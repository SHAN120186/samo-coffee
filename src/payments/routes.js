// Mounted at /pay.
//   GET  /pay/order/:token        hosted payment entry: starts a payment with the active provider and redirects
//   GET  /pay/mock/:tx            demo checkout page
//   POST /pay/mock/:tx            demo checkout result (action=success|fail|cancel)
// PAYMENTS module adds: POST /pay/payme (JSON-RPC), POST /pay/click/prepare, POST /pay/click/complete
// (those paths are excluded from CSRF in app.js; req.rawBody holds the raw request body).
import { Router } from 'express';
import * as orders from '../services/orders.js';
import * as paymentsRepo from '../services/payments.js';
import { rateLimit } from '../lib/ratelimit.js';
import { startPayment, safeReturnUrl, orderStatusUrl } from './index.js';

const router = Router();
const view = (name) => `payments/views/${name}`;

router.get('/order/:token', rateLimit({ windowMs: 60_000, max: 30 }), async (req, res, next) => {
  try {
    const order = orders.getOrderByToken(req.params.token);
    if (!order) return next();
    const returnUrl = safeReturnUrl(req.query.return, order);
    if (!order.can_pay) return res.redirect(returnUrl);
    const result = await startPayment(order, { returnUrl, channel: order.channel });
    return res.redirect(result.redirectUrl || result.invoiceLink || returnUrl);
  } catch (err) {
    return next(err);
  }
});

function loadMockPayment(req) {
  const payment = /^mock_[0-9a-f]{24}$/.test(req.params.tx) ? paymentsRepo.findByProviderTx('mock', req.params.tx) : null;
  if (!payment) return null;
  const order = orders.getOrder(payment.order_id);
  return order ? { payment, order, returnUrl: safeReturnUrl(payment.raw?.returnUrl, order) } : null;
}

router.get('/mock/:tx', (req, res, next) => {
  const ctx = loadMockPayment(req);
  if (!ctx) return next();
  if (ctx.payment.status !== 'pending' || !ctx.order.can_pay) return res.redirect(ctx.returnUrl);
  res.set('Cache-Control', 'no-store');
  return res.render(view('mock-checkout'), { order: ctx.order, payment: ctx.payment, returnUrl: ctx.returnUrl, title: `Оплата заказа ${ctx.order.number}` });
});

router.post('/mock/:tx', (req, res, next) => {
  try {
    const ctx = loadMockPayment(req);
    if (!ctx) return next();
    const { payment, order, returnUrl } = ctx;
    const action = String(req.body?.action || '');
    if (payment.status === 'pending' && order.can_pay) {
      if (action === 'success') {
        orders.markPaid(order.id, { provider: 'mock', txId: payment.provider_tx_id, amount: payment.amount, raw: { simulated: true } });
      } else if (action === 'fail') {
        orders.markPaymentFailed(order.id, { provider: 'mock', txId: payment.provider_tx_id, reason: 'Банк отклонил операцию (демо)' });
      }
      // action === 'cancel' → nothing changes, the customer just goes back
    }
    return res.redirect(303, returnUrl || orderStatusUrl(order));
  } catch (err) {
    return next(err);
  }
});

export default router;

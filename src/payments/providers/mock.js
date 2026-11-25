// "mock" provider: a built-in hosted checkout page that simulates success / failure.
// Default for demos and tests. Flow:
//   createPayment → payments row (status 'pending', provider_tx_id = random token)
//                 → redirect to /pay/mock/<token>  (page + POST handled in ../routes.js)
//
// SAFETY: this provider lets anybody "pay" without money, so in production it is switched off
// (isConfigured() → false, /pay/mock/* → 404) unless ALLOW_MOCK_PAYMENTS=1 is set on purpose.
import crypto from 'node:crypto';
import { config } from '../../config.js';
import * as paymentsRepo from '../../services/payments.js';

export const MOCK_TX_PATTERN = /^mock_[0-9a-f]{24}$/;

/** May the demo checkout be used in this process? */
export const mockEnabled = () => Boolean(config.payments.allowMock);

export default {
  id: 'mock',
  title: 'Демо-оплата',
  isConfigured: mockEnabled,

  async createPayment(order, ctx) {
    // Reuse the pending attempt so page reloads do not pile up rows.
    let payment = paymentsRepo.findActiveForOrder(order.id, 'mock');
    if (!payment || payment.amount !== order.total || !MOCK_TX_PATTERN.test(payment.provider_tx_id || '')) {
      payment = paymentsRepo.createPayment({
        orderId: order.id,
        provider: 'mock',
        providerTxId: `mock_${crypto.randomBytes(12).toString('hex')}`,
        amount: order.total,
        status: 'pending',
        raw: { returnUrl: ctx.returnUrl, channel: ctx.channel },
      });
    } else {
      payment = paymentsRepo.updatePayment(payment.id, { raw: { returnUrl: ctx.returnUrl, channel: ctx.channel } });
    }
    return { redirectUrl: `${config.baseUrl}/pay/mock/${payment.provider_tx_id}` };
  },
};

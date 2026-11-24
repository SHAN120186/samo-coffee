// "mock" provider: a built-in hosted checkout page that simulates success / failure.
// Default for demos and tests. Flow:
//   createPayment → payments row (status 'pending', provider_tx_id = random token)
//                 → redirect to /pay/mock/<token>  (page + POST handled in ../routes.js)
import crypto from 'node:crypto';
import { config } from '../../config.js';
import * as paymentsRepo from '../../services/payments.js';

export default {
  id: 'mock',
  title: 'Демо-оплата',
  isConfigured: () => true,

  async createPayment(order, ctx) {
    // Reuse the pending attempt so page reloads do not pile up rows.
    let payment = paymentsRepo.findActiveForOrder(order.id, 'mock');
    if (!payment || payment.amount !== order.total) {
      payment = paymentsRepo.createPayment({
        orderId: order.id,
        provider: 'mock',
        providerTxId: `mock_${crypto.randomBytes(12).toString('hex')}`,
        amount: order.total,
        status: 'pending',
        raw: { returnUrl: ctx.returnUrl },
      });
    } else {
      payment = paymentsRepo.updatePayment(payment.id, { raw: { returnUrl: ctx.returnUrl } });
    }
    return { redirectUrl: `${config.baseUrl}/pay/mock/${payment.provider_tx_id}` };
  },
};

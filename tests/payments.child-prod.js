// Child process used by payments.mock.test.js: boots the app with the environment it was given
// (NODE_ENV=production with or without ALLOW_MOCK_PAYMENTS=1) and reports how the demo checkout
// behaves there. Not a test file itself.
import { createApp } from '../src/app.js';
import { config } from '../src/config.js';
import * as cart from '../src/services/cart.js';
import * as orders from '../src/services/orders.js';
import * as catalog from '../src/services/catalog.js';
import * as paymentsRepo from '../src/services/payments.js';
import { listProviders, startPayment } from '../src/payments/index.js';

const out = { isProd: config.isProd };
const category = catalog.createCategory({ title: 'Кофе' });
const product = catalog.createProduct({ title: 'Тест', price: 100000, stock: 5, category_id: category.id });
const ref = { token: cart.newToken() };
cart.addItem(ref, product.id, 1);
const order = orders.createFromCart(ref, { customer: { name: 'Тест', phone: '+998901234567' }, delivery: { method: 'pickup' } });
// a mock attempt that exists in the database no matter what the configuration says
const TX = 'mock_0123456789abcdef01234567';
paymentsRepo.createPayment({ orderId: order.id, provider: 'mock', providerTxId: TX, amount: order.total, status: 'pending' });

out.mock = listProviders().find((p) => p.id === 'mock');
try {
  out.start = await startPayment(order);
} catch (err) {
  out.startError = err.code || String(err);
}

const app = await createApp({ bot: false });
const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const entry = await fetch(`${base}/pay/order/${order.public_token}`, { redirect: 'manual' });
    out.entryStatus = entry.status;
    out.entryLocation = entry.headers.get('location');
    const page = await fetch(`${base}/pay/mock/${TX}`, { redirect: 'manual' });
    out.pageStatus = page.status;
    const html = await page.text();
    const csrf = /name="_csrf" value="([^"]+)"/.exec(html)?.[1] || '';
    const cookie = (page.headers.getSetCookie?.() || []).map((c) => c.split(';')[0]).join('; ');
    const post = await fetch(`${base}/pay/mock/${TX}`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded', cookie },
      body: new URLSearchParams({ _csrf: csrf, action: 'success' }).toString(),
    });
    out.postStatus = post.status;
    out.paid = orders.getOrder(order.id).is_paid;
  } catch (err) {
    out.error = String(err);
  } finally {
    process.stdout.write(`${JSON.stringify(out)}\n`);
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  }
});

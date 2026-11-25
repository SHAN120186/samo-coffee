// Child process used by tma.auth.test.js: boots the app with the environment it was given
// (e.g. NODE_ENV=production + TMA_DEV_AUTH=1) and reports how the Mini App API answers a request
// WITHOUT initData. Not a test file itself.
import { createApp } from '../src/app.js';

const app = await createApp({ bot: false });
const server = app.listen(0, '127.0.0.1', async () => {
  const base = `http://127.0.0.1:${server.address().port}/api/tma`;
  try {
    const bootstrap = await fetch(`${base}/bootstrap`);
    const cart = await fetch(`${base}/cart/items`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"productId":1}' });
    const ping = await (await fetch(`${base}/ping`)).json();
    const bootstrapBody = await bootstrap.json();
    process.stdout.write(`${JSON.stringify({ bootstrapStatus: bootstrap.status, bootstrapBody, cartStatus: cart.status, ping })}\n`);
  } catch (err) {
    process.stdout.write(`${JSON.stringify({ error: String(err) })}\n`);
  } finally {
    server.closeAllConnections?.();
    server.close(() => process.exit(0));
  }
});

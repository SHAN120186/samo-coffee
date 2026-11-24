// Minimal fake Telegram Bot API server for tests (api.telegram.org is not reachable from CI).
//   const fake = await startFakeTelegram(port);
//   fake.calls                      → [{ method, params, token }]
//   fake.callsTo('sendMessage')     → params[] of every sendMessage
//   fake.on('sendMessage', (params) => ({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }))
//   fake.pushUpdate({ message: {...} })   → delivered to the next getUpdates (long polling bots)
//   fake.reset(); await fake.close();
import http from 'node:http';

export async function startFakeTelegram(port) {
  const calls = [];
  const handlers = new Map();
  const updates = [];
  let waiters = [];
  let nextMessageId = 1000;
  let nextUpdateId = 1;

  const defaults = {
    getMe: () => ({ id: 123456, is_bot: true, first_name: 'Samo Test', username: 'samo_test_bot', can_join_groups: true, can_read_all_group_messages: false, supports_inline_queries: false }),
    sendMessage: (p) => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' }, text: p.text }),
    sendPhoto: (p) => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' }, caption: p.caption }),
    forwardMessage: (p) => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' } }),
    copyMessage: () => ({ message_id: nextMessageId++ }),
    sendInvoice: (p) => ({ message_id: nextMessageId++, date: Math.floor(Date.now() / 1000), chat: { id: Number(p.chat_id), type: 'private' } }),
    createInvoiceLink: () => 'https://t.me/$fake_invoice_link',
    getUpdates: async (p) => {
      const offset = Number(p.offset) || 0;
      const ready = () => updates.filter((u) => u.update_id >= offset);
      if (!ready().length) {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, Math.min(1000, (Number(p.timeout) || 0) * 1000 || 50));
          waiters.push(() => { clearTimeout(timer); resolve(); });
        });
      }
      return ready();
    },
  };

  const server = http.createServer((req, res) => {
    const match = /^\/bot([^/]+)\/(\w+)/.exec(req.url || '');
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', async () => {
      const send = (status, payload) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(payload));
      };
      if (!match) return send(404, { ok: false, error_code: 404, description: 'Not Found' });
      const [, token, method] = match;
      let params = {};
      try {
        if (body) params = (req.headers['content-type'] || '').includes('json') ? JSON.parse(body) : Object.fromEntries(new URLSearchParams(body));
      } catch { /* keep {} */ }
      if (method !== 'getUpdates') calls.push({ method, params, token });
      try {
        const handler = handlers.get(method) || defaults[method] || (() => true);
        const result = await handler(params);
        if (result && typeof result === 'object' && result.error_code) {
          return send(result.error_code, { ok: false, error_code: result.error_code, description: result.description || 'error', parameters: result.parameters });
        }
        return send(200, { ok: true, result });
      } catch (err) {
        return send(500, { ok: false, error_code: 500, description: String(err) });
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    callsTo: (method) => calls.filter((c) => c.method === method).map((c) => c.params),
    /** Override a method: handler(params) → result | { error_code, description }. */
    on: (method, handler) => handlers.set(method, handler),
    off: (method) => handlers.delete(method),
    /** Queue an update for long-polling bots. update_id is assigned automatically. */
    pushUpdate: (update) => {
      const u = { update_id: nextUpdateId++, ...update };
      updates.push(u);
      const w = waiters;
      waiters = [];
      w.forEach((fn) => fn());
      return u;
    },
    reset: () => {
      calls.length = 0;
      handlers.clear();
    },
    close: () => new Promise((resolve) => {
      waiters.forEach((fn) => fn());
      server.closeAllConnections?.();
      server.close(() => resolve());
    }),
  };
}

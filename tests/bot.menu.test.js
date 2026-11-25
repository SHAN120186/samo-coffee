import { FAKE_TG_PORT, ADMIN_CHAT_ID } from './bot.env.js';
import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { startFakeTelegram } from './helpers/fakeTelegram.js';
import { makeCatalog, makePlan } from './helpers/fixtures.js';
import { BOT_INFO, makeUser, message, callback, callsToChat, lastText, buttons, buttonData, enablePhotoIds } from './bot.helpers.js';
import { createBot } from '../src/bot/bot.js';
import { parseStartParam } from '../src/bot/deeplink.js';
import { isButtonUrl, urlButton, inline } from '../src/bot/keyboards.js';
import { resetPhotoCache } from '../src/bot/photos.js';
import * as texts from '../src/bot/texts.js';
import { all, get } from '../src/db/index.js';
import * as catalog from '../src/services/catalog.js';
import * as customers from '../src/services/customers.js';
import * as orders from '../src/services/orders.js';
import * as cart from '../src/services/cart.js';
import * as tgUsers from '../src/services/tgUsers.js';
import * as notify from '../src/services/notify.js';
import * as feedback from '../src/services/feedback.js';
import { getState, FLOW_TTL_MS } from '../src/bot/state.js';

let fake;
let bot;
let shop;
let plan;

const send = async (update) => {
  await bot.handleUpdate(update);
  await notify.flush();
};

before(async () => {
  fake = await startFakeTelegram(FAKE_TG_PORT);
  bot = createBot({ botInfo: BOT_INFO });
  shop = makeCatalog(8, { description: 'Яркая кислотность, чёрная смородина и <b>грейпфрут</b> & карамель.' });
  plan = makePlan({ title: 'Эспрессо-клуб', price: 249000 });
});
after(async () => {
  await fake.close();
});
beforeEach(() => {
  fake.reset();
  resetPhotoCache();
});

test('deep-link payloads are parsed', () => {
  assert.deepEqual(parseStartParam('order_sc-100042'), { kind: 'order', value: 'SC-100042', raw: 'order_sc-100042', source: 'order_link' });
  assert.equal(parseStartParam('plan_3').kind, 'plan');
  assert.equal(parseStartParam('plan_3').value, '3');
  assert.equal(parseStartParam('utm_insta').source, 'insta');
  assert.equal(parseStartParam('qr_cafe').source, 'qr_cafe');
  assert.equal(parseStartParam('').source, 'direct');
  assert.equal(parseStartParam('bad payload!').kind, 'none');
});

test('URL buttons are only built for addresses Telegram can open', () => {
  assert.equal(isButtonUrl('https://samo.coffee/tma/'), true);
  assert.equal(isButtonUrl('http://shop.example.uz/order/abc'), true);
  assert.equal(isButtonUrl('http://localhost:3000/tma/'), false);
  assert.equal(isButtonUrl('http://127.0.0.1:3000/'), false);
  assert.equal(isButtonUrl('javascript:alert(1)'), false);
  assert.equal(urlButton('Сайт', 'http://localhost:3000/'), null);
  assert.deepEqual(inline([[null], [urlButton('Сайт', 'https://samo.coffee/')], []]), { inline_keyboard: [[{ text: 'Сайт', url: 'https://samo.coffee/' }]] });
  assert.equal(inline([[null]]), undefined);
});

test('/start registers the Telegram user and the customer, records bot_start and shows the menu', async () => {
  const user = makeUser(7001, { first_name: 'Зу<х>ра' });
  await send(message(user, '/start utm_insta'));

  const tgUser = tgUsers.getTgUser(user.id);
  assert.equal(tgUser.username, user.username);
  assert.equal(tgUser.start_param, 'utm_insta');
  assert.equal(tgUser.chat_id, user.id);
  const customer = customers.getCustomerByTgUserId(user.id);
  assert.ok(customer, 'customer row is created');
  assert.equal(customer.source, 'bot');
  assert.equal(customer.tg_username, user.username);

  const event = get(`SELECT * FROM events WHERE name = 'bot_start' AND tg_user_id = ?`, user.id);
  assert.equal(event.channel, 'bot');
  assert.deepEqual(JSON.parse(event.meta), { start_param: 'utm_insta', source: 'insta', new_user: true });

  const [welcome] = callsToChat(fake, 'sendMessage', user.id);
  assert.match(welcome.text, /Здравствуйте, Зу&lt;х&gt;ра!/, 'the name is escaped for HTML parse mode');
  assert.equal(welcome.parse_mode, 'HTML');
  const keyboard = welcome.reply_markup.keyboard.flat().map((b) => b.text);
  assert.deepEqual(keyboard, ['☕ Каталог', '📦 Мои заказы', '🔁 Моя подписка', '💬 Поддержка', '🛍 Открыть магазин']);
  assert.equal(welcome.reply_markup.is_persistent, true);
  // BASE_URL is http://localhost in tests: no web_app / URL button can be sent, the shop card has chat buttons only
  assert.equal(fake.callsTo('sendPhoto').length, 1, 'the shop card is sent with the banner');

  // a second /start does not duplicate anything and keeps the first payload
  await send(message(user, '/start'));
  assert.equal(all('SELECT id FROM customers WHERE tg_user_id = ?', user.id).length, 1);
  assert.equal(tgUsers.getTgUser(user.id).start_param, 'utm_insta');
  assert.equal(all(`SELECT id FROM events WHERE name = 'bot_start' AND tg_user_id = ?`, user.id).length, 2);
});

test('catalog: categories → products (paged) → product card with a "Купить" button', async () => {
  const user = makeUser(7002);
  await send(message(user, '☕ Каталог'));
  const list = lastText(fake, user.id);
  assert.match(list.text, /Каталог Samo Coffee/);
  const categoryButton = buttons(list).find((b) => b.callback_data === `cat:${shop.category.id}:0`);
  assert.ok(categoryButton, 'the category is listed');
  assert.match(categoryButton.text, /· 8$/);

  // page 1: six products, pager
  fake.reset();
  await send(callback(user, `cat:${shop.category.id}:0`));
  const [page1] = fake.callsTo('editMessageText');
  assert.ok(page1, 'menus are edited in place');
  assert.match(page1.text, /стр\. 1 из 2/);
  assert.equal(buttonData(page1).filter((d) => d.startsWith('p:')).length, 6);
  assert.ok(buttonData(page1).includes(`cat:${shop.category.id}:1`));
  assert.equal(fake.callsTo('answerCallbackQuery').length, 1);

  fake.reset();
  await send(callback(user, `cat:${shop.category.id}:1`));
  const [page2] = fake.callsTo('editMessageText');
  assert.equal(buttonData(page2).filter((d) => d.startsWith('p:')).length, 2);

  // product card (fixtures have no raster picture → a text card)
  fake.reset();
  const product = shop.products[0];
  await send(callback(user, `p:${product.id}`));
  const card = lastText(fake, user.id);
  assert.ok(card.text.includes(product.title));
  assert.ok(card.text.includes('&lt;b&gt;грейпфрут&lt;/b&gt; &amp; карамель'), 'DB text is escaped');
  assert.ok(card.text.includes('100 000 сум'));
  assert.ok(buttonData(card).includes(`buy:${product.id}`));
  assert.ok(get(`SELECT id FROM events WHERE name = 'view_product' AND channel = 'bot' AND product_id = ?`, product.id));
});

test('product pictures: the SVG artwork is sent as a pre-rendered photo and the file_id is reused', async () => {
  const user = makeUser(7003);
  const withPhoto = catalog.createProduct({ title: 'Кения Ньери', price: 139000, stock: 4, category_id: shop.category.id, images: ['/img/products/kenya-nyeri.svg'] });
  enablePhotoIds(fake);
  await send(callback(user, `p:${withPhoto.id}`));
  assert.equal(fake.callsTo('sendPhoto').length, 1, 'uploaded as multipart the first time');
  await send(callback(user, `p:${withPhoto.id}`));
  const second = fake.callsTo('sendPhoto')[1];
  assert.equal(second.photo, 'PHOTO_1', 'the cached file_id is sent the second time');
  assert.ok(second.caption.includes('Кения Ньери'));
  assert.ok(second.caption.includes('⚡️ Осталось 4 шт.'));
  assert.ok(buttonData(second).includes(`buy:${withPhoto.id}`));

  // Telegram refuses the picture → the card is still shown, as text
  resetPhotoCache();
  fake.reset();
  fake.on('sendPhoto', () => ({ error_code: 400, description: 'Bad Request: IMAGE_PROCESS_FAILED' }));
  await send(callback(user, `p:${withPhoto.id}`));
  assert.ok(lastText(fake, user.id).text.includes('Кения Ньери'));
});

test('buying a product: phone → delivery → address → confirmation → order + link to the hosted payment page', async () => {
  const user = makeUser(7004);
  const product = shop.products[1];
  await send(message(user, '/start'));
  // the Mini App cart of the same user must stay untouched by a purchase in the chat
  cart.addItem({ tgUserId: user.id }, shop.products[2].id, 2);

  fake.reset();
  await send(callback(user, `buy:${product.id}`));
  const askPhone = lastText(fake, user.id);
  assert.match(askPhone.text, /Оставьте номер телефона/);
  assert.equal(askPhone.reply_markup.keyboard[0][0].request_contact, true);

  // something that is not an attempt to type a number is a message for the team — it is passed on,
  // not answered with "cannot parse the number" (see the support tests); a wrong number is
  await send(message(user, 'не номер'));
  assert.match(lastText(fake, user.id).text, /Передали ваше сообщение команде/);
  assert.equal(lastText(fake, user.id).reply_markup.keyboard[0][0].request_contact, true, 'the phone keyboard stays');
  await send(message(user, '+998 90 12'));
  assert.match(lastText(fake, user.id).text, /Не получилось разобрать номер/);

  fake.reset();
  await send(message(user, null, { contact: { phone_number: '998901112233', first_name: 'Алишер', user_id: user.id } }));
  const texts = callsToChat(fake, 'sendMessage', user.id);
  assert.match(texts[0].text, /\+998 90 111 22 33 сохранён/);
  assert.ok(texts[0].reply_markup.keyboard, 'the main menu comes back after the contact keyboard');
  assert.match(texts[1].text, /Как получить заказ/);
  assert.deepEqual(buttonData(texts[1]), ['co:courier', 'co:pickup', 'co:cancel']);

  fake.reset();
  await send(callback(user, 'co:courier'));
  assert.match(fake.callsTo('editMessageText')[0].text, /Напишите адрес доставки/);

  fake.reset();
  await send(message(user, 'Ташкент, ул. Навои, 10, кв. 5'));
  const summary = lastText(fake, user.id);
  assert.match(summary.text, /Проверьте заказ/);
  assert.ok(summary.text.includes('Ташкент, ул. Навои, 10, кв. 5'));
  assert.ok(summary.text.includes('Доставка: 25 000 сум'));
  assert.ok(summary.text.includes('Итого: 145 000 сум'));
  assert.deepEqual(buttonData(summary), ['co:qty:-', 'noop', 'co:qty:+', 'co:ok', 'co:delivery', 'co:cancel']);

  fake.reset();
  await send(callback(user, 'co:qty:+'));
  assert.ok(fake.callsTo('editMessageText')[0].text.includes('× 2 — 240 000 сум'));

  fake.reset();
  await send(callback(user, 'co:ok'));
  const [order] = orders.listForTgUser(user.id);
  assert.ok(order, 'the order is created through the orders service');
  assert.equal(order.channel, 'bot');
  assert.equal(order.customer_phone, '+998901112233');
  assert.equal(order.delivery_address, 'Ташкент, ул. Навои, 10, кв. 5');
  assert.equal(order.items[0].qty, 2);
  assert.equal(order.total, 240000 + 25000);
  assert.equal(order.payment_status, 'unpaid');
  assert.equal(tgUsers.getTgUser(user.id).state, '', 'the checkout state is cleared');
  assert.equal(cart.getCart({ tgUserId: user.id }).count, 2, 'the Mini App cart is untouched');

  // no TELEGRAM_PAYMENT_TOKEN → the hosted payment page; localhost cannot be a URL button, so the link is in the text
  assert.equal(fake.callsTo('sendInvoice').length, 0);
  const pay = lastText(fake, user.id);
  assert.ok(pay.text.includes(order.number));
  assert.ok(pay.text.includes(`http://localhost:3000/pay/order/${order.public_token}`));
  // admins are told about the new order by the notify service
  assert.ok(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).some((p) => p.text.includes(order.number)));

  // a returning customer is not asked for the phone again and can reuse the address
  fake.reset();
  await send(callback(user, `buy:${product.id}`));
  assert.match(lastText(fake, user.id).text, /Как получить заказ/);
  await send(callback(user, 'co:courier'));
  const addressScreen = fake.callsTo('editMessageText').at(-1);
  assert.ok(buttonData(addressScreen).includes('co:addr'));
  await send(callback(user, 'co:addr'));
  assert.match(fake.callsTo('editMessageText').at(-1).text, /Проверьте заказ/);
  await send(message(user, '✖️ Отмена'));
  assert.equal(tgUsers.getTgUser(user.id).state, '');
  assert.equal(orders.listForTgUser(user.id).length, 1, 'a cancelled checkout creates nothing');
});

test('cards keep one fact per line (product: origin / roast, plan: perks)', () => {
  const product = catalog.hydrateProduct({
    id: 1, title: 'Кения Ньери', subtitle: 'Смородина, грейпфрут', description: 'Яркий лот.', price: 139000, old_price: 159000, stock: 12,
    origin: 'Кения', process: 'Мытая', roast: 'Светлая', weight_g: 250, images: '[]', attributes: '{}', slug: 'kenya',
  });
  assert.deepEqual(texts.productCard(product).split('\n'), [
    '<b>Кения Ньери</b>', '<i>Смородина, грейпфрут</i>', '', 'Яркий лот.', '',
    '🌍 Кения · мытая', '🔥 Обжарка светлая · 250 г', '',
    '<b>139 000 сум</b>  <s>159 000 сум</s>', '✅ В наличии',
  ]);
  const card = texts.planCard({ title: 'Для двоих', badge: 'Выбирают чаще', description: 'Четыре пачки.', perks: ['4 доставки', 'Любой лот'], price: 379000, period_days: 30 });
  assert.deepEqual(card.split('\n'), [
    '🌿 <b>Подписка «Для двоих»</b>', '<i>Выбирают чаще</i>', '', 'Четыре пачки.', '',
    '• 4 доставки', '• Любой лот', '', '<b>379 000 сум</b> за месяц · доставка бесплатно',
  ]);
  assert.equal(texts.periodLabel(7), 'неделю');
  assert.equal(texts.periodLabel(90), '3 месяца');
  assert.equal(texts.periodLabel(10), '10 дней');
  // a long description is cut so that the card still fits into a photo caption
  const long = texts.productCard({ ...product, description: 'Очень длинное описание. '.repeat(200) });
  assert.ok(long.length <= 1024);
});

test('stock changes during the checkout: the quantity is corrected, a sold-out product cannot be ordered', async () => {
  const user = makeUser(7012);
  const rare = catalog.createProduct({ title: 'Микролот <Гейша>', price: 250000, stock: 3, category_id: shop.category.id, images: [] });
  await send(callback(user, `buy:${rare.id}`));
  await send(message(user, '+998 95 000 70 12'));
  await send(callback(user, 'co:pickup'));
  await send(callback(user, 'co:qty:+'));
  await send(callback(user, 'co:qty:+'));
  fake.reset();
  await send(callback(user, 'co:qty:+'));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /В наличии только 3 шт\./);
  assert.equal(fake.callsTo('editMessageText').length, 0);

  // two bags are bought by someone else while this customer is looking at the summary
  catalog.adjustStock(rare.id, -2);
  fake.reset();
  await send(callback(user, 'co:ok'));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /осталось 1 шт\./);
  assert.ok(fake.callsTo('editMessageText')[0].text.includes('Микролот &lt;Гейша&gt; — 250 000 сум'), 'the summary is shown again with one bag');
  assert.equal(orders.listForTgUser(user.id).length, 0);

  catalog.adjustStock(rare.id, -1);
  fake.reset();
  await send(callback(user, 'co:ok'));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /больше недоступно/);
  assert.equal(orders.listForTgUser(user.id).length, 0);
  assert.equal(tgUsers.getTgUser(user.id).state, '');

  fake.reset();
  await send(callback(user, `buy:${rare.id}`));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /закончился/);
});

test('"Мои заказы": list, card, paying an unpaid order; other people\'s orders are not shown', async () => {
  const user = makeUser(7004); // the buyer from the previous test
  const stranger = makeUser(7005);
  const [order] = orders.listForTgUser(user.id);

  await send(message(user, '📦 Мои заказы'));
  const list = lastText(fake, user.id);
  assert.ok(list.text.includes(order.number));
  assert.deepEqual(buttonData(list), [`o:${order.id}`]);

  fake.reset();
  await send(callback(user, `o:${order.id}`));
  const card = fake.callsTo('editMessageText')[0];
  assert.ok(card.text.includes('Итого: 265 000 сум'));
  assert.ok(card.text.includes('Ждёт оплаты'));
  assert.ok(buttonData(card).includes(`pay:${order.id}`));

  fake.reset();
  await send(callback(user, `pay:${order.id}`));
  assert.ok(lastText(fake, user.id).text.includes(`/pay/order/${order.public_token}`));

  fake.reset();
  await send(message(stranger, '/orders'));
  assert.match(lastText(fake, stranger.id).text, /пока нет заказов/);
  await send(callback(stranger, `o:${order.id}`));
  assert.equal(fake.callsTo('editMessageText').length, 0);
  assert.match(fake.callsTo('answerCallbackQuery').at(-1).text, /не найден/);

  // paid by any provider → the customer hears about it in the chat (notify service)
  fake.reset();
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  await notify.flush();
  const paid = lastText(fake, user.id);
  assert.match(paid.text, /Оплата получена/);
  assert.ok(paid.text.includes(order.number));
  orders.setStatus(order.id, 'processing', { actor: 'admin:1' });
  orders.setStatus(order.id, 'shipped', { actor: 'admin:1' });
  await notify.flush();
  assert.match(lastText(fake, user.id).text, /передан курьеру/);
});

test('deep link to a site order: status only until the phone is confirmed, then the order is linked', async () => {
  const { products } = makeCatalog(1);
  const ref = { token: cart.newToken() };
  cart.addItem(ref, products[0].id, 1);
  const order = orders.createFromCart(ref, {
    customer: { name: 'Дильноза Site', phone: '+998 93 555 66 77' },
    delivery: { method: 'courier', address: 'Ташкент, Чиланзар, 7' },
  });
  await notify.flush();
  const user = makeUser(7006);
  fake.reset();

  await send(message(user, `/start order_${order.number}`));
  const teaser = lastText(fake, user.id);
  assert.ok(teaser.text.includes(order.number));
  assert.ok(!teaser.text.includes('Чиланзар'), 'no personal data before the phone is confirmed');
  assert.equal(teaser.reply_markup.keyboard[0][0].request_contact, true);
  assert.equal(customers.getCustomerByTgUserId(user.id), undefined, 'no second customer is created for a site buyer');

  // someone else's phone does not open the order
  fake.reset();
  await send(message(user, null, { contact: { phone_number: '+998935556677', first_name: 'X', user_id: 999 } }));
  assert.match(lastText(fake, user.id).text, /собственный номер/);
  assert.equal(orders.getOrder(order.id).tg_user_id, null);

  fake.reset();
  await send(message(user, null, { contact: { phone_number: '+998935556677', first_name: 'Дильноза', user_id: user.id } }));
  assert.equal(orders.getOrder(order.id).tg_user_id, user.id);
  const linked = customers.getCustomerByTgUserId(user.id);
  assert.equal(linked.id, order.customer_id, 'the Telegram account is attached to the customer of the order');
  assert.equal(linked.name, 'Дильноза Site');
  assert.ok(lastText(fake, user.id).text.includes('Чиланзар'));

  // a stranger with the same link sees the status only
  const stranger = makeUser(7007);
  fake.reset();
  await send(message(stranger, `/start order_${order.number}`));
  const forStranger = lastText(fake, stranger.id);
  assert.ok(forStranger.text.includes(order.number));
  assert.ok(!forStranger.text.includes('Чиланзар'));
  assert.equal(tgUsers.getTgUser(stranger.id).state, '');
});

test('subscription: plan list, plan card, checkout of a plan, "Моя подписка" with renewal', async () => {
  const user = makeUser(7008);
  enablePhotoIds(fake);
  await send(message(user, `/start plan_${plan.id}`));
  assert.equal(fake.callsTo('sendPhoto').length, 1, 'the deep link opens the plan card (picture uploaded)');
  await send(callback(user, `plan:${plan.id}`));
  const card = fake.callsTo('sendPhoto')[1];
  assert.match(card.photo, /^PHOTO_/);
  assert.ok(card.caption.includes('Подписка «Эспрессо-клуб»'));
  assert.ok(card.caption.includes('249 000 сум</b> за месяц'));
  assert.ok(buttonData(card).includes(`sub:${plan.id}`));

  fake.reset();
  await send(message(user, '🔁 Моя подписка'));
  const none = lastText(fake, user.id);
  assert.match(none.text, /пока нет подписки/);
  assert.ok(buttonData(none).includes(`plan:${plan.id}`));

  await send(callback(user, `sub:${plan.id}`));
  await send(message(user, '+998 94 123 45 67'));
  await send(callback(user, 'co:pickup'));
  fake.reset();
  await send(callback(user, 'co:ok'));
  const [order] = orders.listForTgUser(user.id);
  assert.equal(order.kind, 'subscription');
  assert.equal(order.plan_id, plan.id);
  assert.equal(order.total, 249000);
  assert.equal(order.delivery_method, 'pickup');

  fake.reset();
  orders.markPaid(order.id, { provider: 'mock', amount: order.total });
  await notify.flush();
  assert.ok(callsToChat(fake, 'sendMessage', user.id).some((p) => /Подписка оформлена/.test(p.text)));

  fake.reset();
  await send(message(user, '/subscription'));
  const mine = lastText(fake, user.id);
  assert.ok(mine.text.includes('Статус: <b>Активна</b>'));
  assert.match(mine.text, /Оплачена до <b>\d+ [а-я]+ \d{4}<\/b> — ещё 30 дней/);
  assert.ok(buttonData(mine).includes('renew'));

  // renewal: no questions, a new order for the same plan and the payment link right away
  fake.reset();
  await send(callback(user, 'renew'));
  const list = orders.listForTgUser(user.id);
  assert.equal(list.length, 2);
  assert.equal(list[0].plan_id, plan.id);
  assert.ok(lastText(fake, user.id).text.includes(`/pay/order/${list[0].public_token}`));
});

test('/help, unknown commands and stale buttons', async () => {
  const user = makeUser(7009);
  await send(message(user, '/help'));
  assert.match(lastText(fake, user.id).text, /Что умеет бот/);
  await send(message(user, '/nosuchcommand'));
  assert.match(lastText(fake, user.id).text, /Не знаю такой команды/);
  fake.reset();
  await send(callback(user, 'co:ok'));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /неактуален/);
  await send(callback(user, 'whatever:1'));
  assert.match(fake.callsTo('answerCallbackQuery').at(-1).text, /устарела/);
  await send(callback(user, `buy:999999`));
  assert.match(fake.callsTo('answerCallbackQuery').at(-1).text, /больше не продаётся/);
});

test('a user who blocked the bot is marked inactive and unmarked when they come back', async () => {
  const user = makeUser(7010);
  await send(message(user, '/start'));
  fake.on('sendMessage', () => ({ error_code: 403, description: 'Forbidden: bot was blocked by the user' }));
  await assert.rejects(bot.handleUpdate(message(user, '/help')), /blocked by the user/);
  assert.equal(tgUsers.getTgUser(user.id).is_blocked, 1);
  fake.off('sendMessage');

  await send(message(user, '/help'));
  assert.equal(tgUsers.getTgUser(user.id).is_blocked, 0, 'writing to the bot again clears the flag');

  const chat = { id: user.id, type: 'private' };
  const member = (status) => ({
    update_id: 1, my_chat_member: { chat, from: user, date: 1, old_chat_member: { user: BOT_INFO, status: 'member' }, new_chat_member: { user: BOT_INFO, status } },
  });
  await send(member('kicked'));
  assert.equal(tgUsers.getTgUser(user.id).is_blocked, 1);
  await send(member('member'));
  assert.equal(tgUsers.getTgUser(user.id).is_blocked, 0);
});

test('messages in unrelated group chats are ignored', async () => {
  const user = makeUser(7011);
  const chat = { id: -100555, type: 'supergroup', title: 'Чужой чат' };
  await send({ update_id: 2, message: { message_id: 1, date: 1, chat, from: user, text: '/start', entities: [{ type: 'bot_command', offset: 0, length: 6 }] } });
  await send({ update_id: 3, message: { message_id: 2, date: 1, chat, from: user, text: 'привет' } });
  assert.equal(fake.calls.length, 0);
  assert.equal(tgUsers.getTgUser(user.id), null);
});

test('"Продлить" pressed again and again offers the same unpaid renewal instead of creating new orders', async () => {
  const user = makeUser(7020);
  await send(message(user, '/start'));
  const first = orders.createSubscriptionOrder({
    planId: plan.id, customer: { name: 'Подписчик', phone: '+998 94 700 20 20' }, delivery: { method: 'courier', address: 'Ташкент, Юнусабад, 4' },
    channel: 'bot', tgUserId: user.id,
  });
  orders.markPaid(first.id, { provider: 'mock', amount: first.total });
  await notify.flush();

  fake.reset();
  await send(callback(user, 'renew!'));
  await send(callback(user, 'renew!'));
  await send(callback(user, 'renew'));
  const renewals = orders.listForTgUser(user.id).filter((o) => o.id !== first.id);
  assert.equal(renewals.length, 1, 'one renewal order however many times the button is pressed');
  assert.equal(renewals[0].can_pay, true);
  assert.equal(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).filter((p) => /Новый заказ/.test(p.text)).length, 1, 'the staff hears about it once');
  const offers = callsToChat(fake, 'sendMessage', user.id).filter((p) => p.text.includes(renewals[0].number));
  assert.equal(offers.length, 3, 'every tap shows the way to pay that order');

  // once it is paid, the next "Продлить" is a new period → a new order
  orders.markPaid(renewals[0].id, { provider: 'mock', amount: renewals[0].total });
  await notify.flush();
  await send(callback(user, 'renew'));
  assert.equal(orders.listForTgUser(user.id).length, 3);

  // a cancelled renewal is not offered again either
  const [open] = orders.listForTgUser(user.id);
  orders.cancel(open.id, { actor: 'customer' });
  await send(callback(user, 'renew'));
  assert.equal(orders.listForTgUser(user.id).length, 4);
});

test('an abandoned checkout or phone confirmation expires: later messages go to support, not into the order', async () => {
  const user = makeUser(7021);
  const [product] = shop.products;
  const age = (ms) => {
    const row = tgUsers.getTgUser(user.id);
    tgUsers.setTgState(user.id, row.state, { ...row.state_data, _at: Date.now() - ms });
  };
  const threads = () => feedback.listThreads({ tgUserId: user.id }).total;

  // address step, left for a week
  await send(callback(user, `buy:${product.id}`));
  await send(message(user, '+998 90 702 10 21'));
  await send(callback(user, 'co:courier'));
  assert.equal(getState(user.id).data.step, 'address');
  assert.ok(getState(user.id).at > 0, 'the state remembers when it was last touched');
  age(7 * 86_400_000);
  fake.reset();
  await send(message(user, 'Здравствуйте! Когда будет новая обжарка Эфиопии?'));
  assert.equal(tgUsers.getTgUser(user.id).state, '', 'the stale checkout is gone');
  assert.equal(threads(), 1, 'the question became a support request');
  assert.ok(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).some((p) => p.text.includes('Когда будет новая обжарка Эфиопии?')), 'forwarded to the team');
  assert.ok(!callsToChat(fake, 'sendMessage', user.id).some((p) => /Проверьте заказ/.test(p.text)), 'not taken for a delivery address');
  assert.equal(orders.listForTgUser(user.id).length, 0);

  // a stale button of that checkout no longer places anything
  await send(callback(user, `buy:${product.id}`));
  await send(message(user, '+998 90 702 10 21'));
  await send(callback(user, 'co:pickup'));
  assert.equal(getState(user.id).data.step, 'confirm');
  age(FLOW_TTL_MS + 60_000);
  fake.reset();
  await send(callback(user, 'co:ok'));
  assert.match(fake.callsTo('answerCallbackQuery')[0].text, /неактуален/);
  assert.equal(orders.listForTgUser(user.id).length, 0);

  // a flow that is still fresh keeps working (the timer restarts with every step)…
  await send(callback(user, `buy:${product.id}`));
  await send(message(user, '+998 90 702 10 21'));
  age(FLOW_TTL_MS - 60_000);
  await send(callback(user, 'co:pickup'));
  assert.equal(getState(user.id).data.step, 'confirm');
  assert.ok(Date.now() - getState(user.id).at < 5000);
  // …and a question typed in the middle of it reaches the team while the order stays open
  fake.reset();
  await send(message(user, 'А можно оплатить при получении?'));
  assert.equal(threads(), 1);
  assert.equal(feedback.listThreads({ tgUserId: user.id }).items[0].messages_count, 2);
  assert.ok(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).some((p) => p.text.includes('оплатить при получении')));
  assert.equal(getState(user.id).state, 'checkout');
  await send(callback(user, 'co:cancel'));

  // phone step of a new user: the reply keyboard has no "Поддержка" button — a question must not be lost
  const newcomer = makeUser(7022);
  await send(callback(newcomer, `buy:${product.id}`));
  assert.equal(getState(newcomer.id).data.step, 'phone');
  fake.reset();
  await send(message(newcomer, 'зачем вам мой номер?'));
  assert.equal(feedback.listThreads({ tgUserId: newcomer.id }).total, 1);
  assert.ok(callsToChat(fake, 'sendMessage', ADMIN_CHAT_ID).some((p) => p.text.includes('зачем вам мой номер?')));
  assert.equal(getState(newcomer.id).state, 'checkout', 'the order still waits for the phone');
  // …and after a month of silence the next message is just a message
  const row = tgUsers.getTgUser(newcomer.id);
  tgUsers.setTgState(newcomer.id, row.state, { ...row.state_data, _at: Date.now() - 30 * 86_400_000 });
  fake.reset();
  await send(message(newcomer, 'Добрый день'));
  assert.equal(getState(newcomer.id).state, '');
  assert.ok(!callsToChat(fake, 'sendMessage', newcomer.id).some((p) => /разобрать номер/.test(p.text)));

  // link_order (phone confirmation of a site order) expires the same way
  const ref = { token: cart.newToken() };
  cart.addItem(ref, product.id, 1);
  const siteOrder = orders.createFromCart(ref, { customer: { name: 'Сайт', phone: '+998 93 702 10 23' }, delivery: { method: 'pickup' } });
  await notify.flush();
  const linker = makeUser(7023);
  await send(message(linker, `/start order_${siteOrder.number}`));
  assert.equal(getState(linker.id).state, 'link_order');
  const linkRow = tgUsers.getTgUser(linker.id);
  tgUsers.setTgState(linker.id, linkRow.state, { ...linkRow.state_data, _at: Date.now() - FLOW_TTL_MS - 1000 });
  fake.reset();
  await send(message(linker, 'Подскажите, до скольки вы работаете?'));
  assert.equal(getState(linker.id).state, '');
  assert.equal(feedback.listThreads({ tgUserId: linker.id }).total, 1);
  assert.ok(!callsToChat(fake, 'sendMessage', linker.id).some((p) => /Отправить мой номер/.test(p.text)));
});

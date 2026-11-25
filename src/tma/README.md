# Telegram Mini App

Мини-приложение магазина: каталог, корзина, оформление, оплата, подписка, заказы и поддержка.
Сервер — JSON API `/api/tma` (`src/tma`), клиент — SPA без сборки (`public/tma`, отдаётся по `/tma/`).

## Файлы

| Путь | Назначение |
|---|---|
| `src/tma/api.js` | роутер `/api/tma`: все эндпоинты, валидация, лимиты, единый формат ошибок |
| `src/tma/auth.js` | проверка `initData`, регистрация Telegram-пользователя и клиента |
| `src/tma/payment.js` | старт оплаты: инвойс Telegram или страница оплаты провайдера |
| `src/tma/serialize.js` | DTO — наружу уходят только нужные клиенту поля |
| `public/tma/index.html`, `app.css` | оболочка и стили (токены из `/css/tokens.css`) |
| `public/tma/js/main.js` | запуск, нижняя панель вкладок, маршруты |
| `public/tma/js/tg.js` | обёртка над `Telegram.WebApp` с запасными вариантами для браузера |
| `public/tma/js/router.js`, `api.js`, `store.js`, `ui.js`, `forms.js` | роутер по hash, клиент API, состояние, шаблоны и компоненты |
| `public/tma/js/screens/*.js` | экраны: `home`, `product`, `cart`, `checkout`, `pay`, `plans`, `subscribe`, `orders`, `order`, `support` |

## Авторизация

Клиент передаёт сырой `Telegram.WebApp.initData` в заголовке `Authorization: tma <initData>`.
Сервер проверяет подпись HMAC-SHA256 токеном бота и свежесть `auth_date` (`TMA_INITDATA_MAX_AGE`, по умолчанию 24 часа).
Cookie не используются. Ошибка авторизации — `401 { ok: false, error: "unauthorized", details: { reason } }`.

**Предпросмотр в браузере.** При `TMA_DEV_AUTH=1` и `NODE_ENV` не `production` запросы без `initData`
выполняются от имени демо-пользователя (id `700000001`). В production флаг игнорируется.
Открыть: `http://localhost:3000/tma/`. Тему Telegram можно сымитировать: `/tma/?theme=dark` или `/tma/?theme=light`.

## API

Ответ: `{ ok: true, ... }` либо `{ ok: false, error, message, details? }` (тексты на русском).

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/ping` | проверка связи, без авторизации |
| GET | `/bootstrap` | пользователь, данные для автозаполнения, настройки, тексты, категории, корзина, подписка |
| POST | `/events` | события аналитики: `tma_open`, `view_product`, `begin_checkout` |
| GET | `/categories`, `/products`, `/products/:id` | каталог (`category`, `search`, `sort`, `featured`, `limit`, `offset`) |
| GET, DELETE | `/cart` | корзина пользователя |
| POST | `/cart/items` | добавить товар (пишет событие `add_to_cart`) |
| PUT, DELETE | `/cart/items/:productId` | изменить количество, убрать товар |
| POST | `/checkout` | создать заказ (канал `tma`) и начать оплату → `invoiceLink` или `redirectUrl` |
| GET | `/plans`, `/subscription` | планы и текущая подписка |
| POST | `/subscribe` | заказ на подписку + оплата |
| POST | `/subscription/:action` | `pause`, `resume`, `cancel` |
| GET | `/orders`, `/orders/:id` | мои заказы; второй используется и для опроса статуса оплаты |
| POST | `/orders/:id/pay`, `/cancel`, `/repeat` | оплатить ещё раз, отменить неоплаченный, повторить заказ |
| GET, POST | `/feedback` | переписка с поддержкой (обращение канала `tma`) |

Изменяющие запросы ограничены по частоте на пользователя (`429 rate_limited`).

## Оплата

1. Если заданы `BOT_TOKEN` и `TELEGRAM_PAYMENT_TOKEN` и клиент умеет `WebApp.openInvoice` — API возвращает `invoiceLink`
   (payload `order:<id>`). Заказ становится оплаченным, когда бот получает `successful_payment`.
2. Иначе возвращается `redirectUrl` — страница оплаты активного провайдера. В Telegram она открывается через
   `WebApp.openLink`, приложение ждёт и опрашивает статус заказа. В браузере страница возвращает на `/tma/#/pay/<id>`.

Статус заказа меняет только `orders.markPaid()`.

## Ссылки на экраны

- параметр запуска Telegram (`startapp`) или `?screen=` в адресе: `cart`, `orders`, `support`, `plans`,
  `product_<slug или id>`, `order_<id>`;
- прямой маршрут: `/tma/#/plans`, `/tma/#/product/<id>`.

## Редактируемые тексты

Страница «Мини-приложение Telegram» в редакторе контента: `home_title`, `home_text`, `banner_image`,
`support_intro`, `subscription_empty`. Контакты, стоимость и условия доставки берутся из настроек.

## Тесты

`tests/tma.*.test.js`: авторизация, каталог и корзина, оформление и оплата, подписка, поддержка, инвойсы,
статика. `tests/tma.e2e.test.js` запускает приложение в Chromium с подменённым мостом Telegram
и пропускается, если Playwright не установлен.

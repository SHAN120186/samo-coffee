// Extra editable content blocks used by the public site in addition to the foundation defaults
// (services/contentDefaults.js). They are inserted additively at boot (existing rows are never
// touched), so the admin can edit them in Admin → Контент together with the default ones.
import * as content from '../services/content.js';

const b = (page, key, type, label, value) => ({ page, key, type, label, value });

export const SITE_BLOCKS = [
  // ───────────── global
  b('global', 'logo_footer', 'image', 'Логотип для тёмного фона (подвал)', '/img/logo-light.svg'),
  b('global', 'tg_title', 'text', 'Блок Telegram: заголовок', 'Samo в Telegram'),
  b('global', 'tg_text', 'text', 'Блок Telegram: текст', 'Заказывайте кофе в мини-приложении, следите за статусом заказа и пишите бариста напрямую.'),
  b('global', 'tg_button_text', 'text', 'Блок Telegram: кнопка', 'Открыть в Telegram'),
  b('global', 'footer_payments_note', 'text', 'Подвал: способы оплаты', 'Принимаем Uzcard, Humo, Visa и Mastercard через Payme и Click'),

  // ───────────── home
  b('home', 'hero_badge_text', 'text', 'Первый экран: текст на круглой печати', 'Свежая обжарка · каждую неделю ·'),
  b('home', 'featured_cta_text', 'text', 'Блок «Хиты»: ссылка на каталог', 'Весь каталог'),
  b('home', 'categories_text', 'text', 'Блок категорий: текст', 'Четыре раздела — от плотного эспрессо до набора для первого знакомства.'),
  b('home', 'reviews_title', 'text', 'Отзывы: заголовок', 'Говорят те, кто уже пьёт'),
  b('home', 'review1_text', 'text', 'Отзыв 1: текст', 'Перешла на подписку полгода назад и перестала покупать кофе в супермаркете. Иргачефф в воронке — отдельная причина вставать по утрам.'),
  b('home', 'review1_author', 'text', 'Отзыв 1: автор', 'Камила Рахимова'),
  b('home', 'review1_role', 'text', 'Отзыв 1: подпись', 'подписка «Для себя»'),
  b('home', 'review2_text', 'text', 'Отзыв 2: текст', 'Берём «Ташкент» для кофейни третий год. Вкус стабильный от партии к партии, а ребята всегда на связи, если нужно подстроить помол.'),
  b('home', 'review2_author', 'text', 'Отзыв 2: автор', 'Азиз Каримов'),
  b('home', 'review2_role', 'text', 'Отзыв 2: подпись', 'владелец кофейни'),
  b('home', 'review3_text', 'text', 'Отзыв 3: текст', 'Заказал в обед — вечером уже заваривал. На пачке дата обжарки: три дня назад. Так в городе больше никто не делает.'),
  b('home', 'review3_author', 'text', 'Отзыв 3: автор', 'Санжар Юлдашев'),
  b('home', 'review3_role', 'text', 'Отзыв 3: подпись', 'покупает с 2021 года'),
  b('home', 'blog_text', 'text', 'Блок блога: текст', 'Рецепты и заметки из цеха — чтобы дома получалось как у нас на каппинге.'),
  b('home', 'blog_cta_text', 'text', 'Блок блога: ссылка', 'Все статьи'),

  // ───────────── catalog + product page
  b('catalog', 'product_perk1', 'text', 'Карточка товара: преимущество 1', 'Обжарено на этой неделе — дата на каждой пачке'),
  b('catalog', 'product_perk2', 'text', 'Карточка товара: преимущество 2', 'Привезём по Ташкенту в день заказа'),
  b('catalog', 'product_perk3', 'text', 'Карточка товара: преимущество 3', 'Бесплатно перемелем под ваш способ заваривания'),
  b('catalog', 'product_help_title', 'text', 'Карточка товара: блок помощи — заголовок', 'Сомневаетесь в выборе?'),
  b('catalog', 'product_help_text', 'text', 'Карточка товара: блок помощи — текст', 'Расскажите, как завариваете и что любите — подберём лот и пришлём рецепт.'),
  b('catalog', 'related_title', 'text', 'Карточка товара: заголовок «Похожие»', 'С этим берут'),

  // ───────────── subscriptions
  b('subscriptions', 'eyebrow', 'text', 'Надзаголовок', 'Свежий кофе по расписанию'),
  b('subscriptions', 'plans_title', 'text', 'Планы: заголовок', 'Выберите свой объём'),
  b('subscriptions', 'faq_title', 'text', 'Вопросы о подписке: заголовок', 'Частые вопросы о подписке'),
  b('subscriptions', 'checkout_title', 'text', 'Оформление подписки: заголовок', 'Оформление подписки'),
  b('subscriptions', 'checkout_text', 'text', 'Оформление подписки: пояснение', 'Оставьте контакты — после оплаты менеджер свяжется с вами, чтобы согласовать лот, помол и день первой доставки.'),

  // ───────────── about
  b('about', 'cta_title', 'text', 'Финальный блок: заголовок', 'Заходите в гости'),
  b('about', 'cta_text', 'text', 'Финальный блок: текст', 'Цех на Шота Руставели открыт каждый день. Покажем ростер, заварим фильтр и поможем выбрать кофе домой.'),
  b('about', 'cta_button_text', 'text', 'Финальный блок: кнопка', 'Как нас найти'),
  b('about', 'cta_button_link', 'link', 'Финальный блок: ссылка', '/contacts'),

  // ───────────── blog
  b('blog', 'more_title', 'text', 'Статья: заголовок «Читайте также»', 'Читайте также'),
  b('blog', 'post_cta_title', 'text', 'Статья: финальный блок — заголовок', 'Заварите то, о чём прочитали'),
  b('blog', 'post_cta_text', 'text', 'Статья: финальный блок — текст', 'Всё, о чём мы пишем, можно попробовать дома: свежие лоты ждут в каталоге.'),
  b('blog', 'post_cta_button_text', 'text', 'Статья: финальный блок — кнопка', 'Перейти в каталог'),

  // ───────────── delivery
  b('delivery', 'card1_label', 'text', 'Карточка 1: подпись (стоимость доставки)', 'Курьером по Ташкенту'),
  b('delivery', 'card2_label', 'text', 'Карточка 2: подпись (бесплатная доставка)', 'Бесплатно при заказе от'),
  b('delivery', 'card3_label', 'text', 'Карточка 3: подпись (самовывоз)', 'Самовывоз из цеха'),
  b('delivery', 'card3_value', 'text', 'Карточка 3: значение', 'Бесплатно'),
  b('delivery', 'delivery_title', 'text', 'Раздел «Доставка»: заголовок', 'Доставка'),
  b('delivery', 'payment_title', 'text', 'Раздел «Оплата»: заголовок', 'Оплата'),

  // ───────────── faq
  b('faq', 'cta_title', 'text', 'Финальный блок: заголовок', 'Не нашли ответ?'),
  b('faq', 'cta_text', 'text', 'Финальный блок: текст', 'Напишите нам — бариста на связи каждый день и ответит в течение часа.'),
  b('faq', 'cta_button_text', 'text', 'Финальный блок: кнопка', 'Задать вопрос'),

  // ───────────── contacts
  b('contacts', 'info_title', 'text', 'Блок контактов: заголовок', 'Обжарочный цех и шоурум'),
  b('contacts', 'map_button_text', 'text', 'Кнопка карты', 'Открыть на карте'),

  // ───────────── cart / order / errors
  b('cart', 'note', 'text', 'Примечание под итогом', 'Перемелем кофе под ваш способ заваривания — укажите его в комментарии на следующем шаге.'),
  b('order', 'processing_title', 'text', 'Собирается: заголовок', 'Собираем ваш заказ'),
  b('order', 'processing_text', 'text', 'Собирается: текст', 'Кофе уже упаковывают. Совсем скоро передадим заказ курьеру.'),
  b('order', 'shipped_title', 'text', 'Передан курьеру: заголовок', 'Заказ в пути'),
  b('order', 'shipped_text', 'text', 'Передан курьеру: текст', 'Курьер выехал и позвонит перед приездом.'),
  b('order', 'delivered_title', 'text', 'Доставлен: заголовок', 'Заказ доставлен'),
  b('order', 'delivered_text', 'text', 'Доставлен: текст', 'Приятного кофе! Будем рады, если расскажете, как он вам.'),
  b('order', 'refunded_title', 'text', 'Возврат: заголовок', 'Оформлен возврат'),
  b('order', 'refunded_text', 'text', 'Возврат: текст', 'Деньги вернутся на карту в течение нескольких рабочих дней.'),
  b('order', 'subscription_paid_text', 'text', 'Подписка оплачена: текст', 'Подписка активна. Менеджер свяжется с вами, чтобы согласовать лот, помол и день первой доставки.'),
  b('order', 'help_text', 'text', 'Подсказка внизу страницы', 'Вопросы по заказу? Позвоните или напишите нам — поможем.'),
  b('notfound', 'error_title', 'text', 'Ошибка сервера: заголовок', 'Кажется, мы что-то пролили'),
  b('notfound', 'error_text', 'text', 'Ошибка сервера: текст', 'На нашей стороне произошла ошибка. Уже вытираем — попробуйте обновить страницу через минуту.'),
];

const defaultsByPage = new Map();
for (const block of SITE_BLOCKS) {
  if (!defaultsByPage.has(block.page)) defaultsByPage.set(block.page, {});
  defaultsByPage.get(block.page)[block.key] = block.value;
}

/** Sort value that places the site blocks after the foundation defaults of the same page. */
const SORT_BASE = 1000;

/**
 * Insert the site blocks that are missing in the DB. Never overwrites existing rows, safe to call
 * any number of times. Returns the number of inserted blocks.
 */
export function ensureSiteBlocks() {
  let inserted = 0;
  for (const page of defaultsByPage.keys()) {
    const existing = new Set(content.listBlocks(page).map((row) => row.key));
    SITE_BLOCKS.forEach((block, index) => {
      if (block.page !== page || existing.has(block.key)) return;
      content.upsertBlock({ ...block, sort: SORT_BASE + index });
      inserted += 1;
    });
  }
  return inserted;
}

/**
 * Content of a page for the views: DB values on top of the site defaults, so a view never
 * breaks when a block row is missing (e.g. right after `npm run seed` without a restart).
 * A block the admin cleared stays an empty string — views hide empty elements.
 */
export function pageContent(page) {
  return { ...(defaultsByPage.get(page) || {}), ...content.getPage(page) };
}

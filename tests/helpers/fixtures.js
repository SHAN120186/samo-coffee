// Small fixtures for service-level tests (import after ./env.js).
import * as catalog from '../../src/services/catalog.js';
import * as subscriptions from '../../src/services/subscriptions.js';

let n = 0;

/** Create a category + N products. Returns { category, products }. */
export function makeCatalog(count = 2, overrides = {}) {
  n += 1;
  const category = catalog.createCategory({ title: `Тестовая категория ${n}` });
  const products = Array.from({ length: count }, (_, i) =>
    catalog.createProduct({
      title: `Тестовый кофе ${n}-${i + 1}`,
      price: 100000 + i * 20000,
      stock: 10,
      category_id: category.id,
      images: ['/img/placeholder.svg'],
      ...overrides,
    }));
  return { category, products };
}

export function makePlan(overrides = {}) {
  n += 1;
  return subscriptions.createPlan({ title: `Тестовый план ${n}`, price: 199000, period_days: 30, perks: ['Раз', 'Два'], ...overrides });
}

export const CUSTOMER = { name: 'Тест Тестов', phone: '+998 90 123 45 67', email: 'test@example.com' };
export const DELIVERY = { method: 'courier', address: 'Ташкент, ул. Тестовая, 1' };

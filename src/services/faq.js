// FAQ entries.
import { all, get, run } from '../db/index.js';
import { sanitizeRichText } from '../lib/sanitize.js';
import { AppError, notFound } from '../lib/errors.js';

const flag = (v) => (v === true || v === 1 || v === '1' || v === 'on' || v === 'true' ? 1 : 0);
const toInt = (v, d = 0) => (Number.isFinite(Number.parseInt(v, 10)) ? Number.parseInt(v, 10) : d);

/** FAQ items ordered by sort. activeOnly defaults to true. */
export function listFaq({ activeOnly = true } = {}) {
  return all(`SELECT * FROM faq ${activeOnly ? 'WHERE active = 1' : ''} ORDER BY sort, id`);
}

/** Active items grouped by topic: [{ topic, items: [...] }] (items without a topic go to ''). */
export function listFaqGrouped() {
  const groups = new Map();
  for (const item of listFaq()) {
    if (!groups.has(item.topic)) groups.set(item.topic, []);
    groups.get(item.topic).push(item);
  }
  return [...groups.entries()].map(([topic, items]) => ({ topic, items }));
}

export function getFaq(id) {
  return get('SELECT * FROM faq WHERE id = ?', Number(id));
}

function fields(data, current = null) {
  const pick = (k, def) => (data[k] !== undefined ? data[k] : current ? current[k] : def);
  const question = String(pick('question', '')).trim();
  if (!question) throw new AppError('validation', 'Укажите вопрос', 422);
  return {
    question,
    answer: data.answer !== undefined ? sanitizeRichText(data.answer) : (current?.answer ?? ''),
    topic: String(pick('topic', '')).trim(),
    sort: toInt(pick('sort', 0)),
    active: data.active === undefined ? (current?.active ?? 1) : flag(data.active),
  };
}

/** data: { question*, answer (rich text), topic, sort, active } */
export function createFaq(data) {
  const f = fields(data);
  const { lastInsertRowid } = run('INSERT INTO faq (question, answer, topic, sort, active) VALUES (?, ?, ?, ?, ?)',
    f.question, f.answer, f.topic, f.sort, f.active);
  return getFaq(Number(lastInsertRowid));
}

export function updateFaq(id, data) {
  const row = getFaq(id);
  if (!row) throw notFound('Запись');
  const f = fields(data, row);
  run('UPDATE faq SET question = ?, answer = ?, topic = ?, sort = ?, active = ? WHERE id = ?',
    f.question, f.answer, f.topic, f.sort, f.active, row.id);
  return getFaq(row.id);
}

export function deleteFaq(id) {
  return run('DELETE FROM faq WHERE id = ?', Number(id)).changes > 0;
}

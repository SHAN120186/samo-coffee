// Broadcasts: compose a message, send it to every bot user (throttled by the service), keep history.
import { Router } from 'express';
import * as broadcasts from '../../services/broadcasts.js';
import * as tgUsers from '../../services/tgUsers.js';
import * as tg from '../../lib/telegramApi.js';
import { config } from '../../config.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, wrap, intParam, isUserError } from '../lib.js';

const router = Router();

/** Telegram accepts only a small HTML subset; anything else makes sendMessage fail for every user. */
const TG_TAGS = /<\/?(b|strong|i|em|u|s|a|code|pre|tg-spoiler|blockquote)(\s[^<>]*)?>/gi;

function validate(data) {
  const fields = {};
  if (!data.text) fields.text = 'Напишите текст рассылки';
  else if (/[<>]/.test(data.text.replace(TG_TAGS, ''))) {
    fields.text = 'В тексте есть неподдерживаемые теги. Разрешены: <b>, <i>, <u>, <s>, <a href="…">, <code>';
  } else if (broadcasts.htmlProblem(data.text)) {
    // an unclosed tag would be refused by Telegram for every single recipient
    fields.text = broadcasts.htmlProblem(data.text);
  }
  if (data.image && !/^https:\/\/\S+$/.test(data.image)) fields.image = 'Нужна публичная ссылка на картинку, начинающаяся с https://';
  if (data.image && data.text.length > 1000) fields.text = 'С картинкой текст должен быть не длиннее 1000 символов';
  if (data.button_url && !/^https:\/\/\S+$/.test(data.button_url)) fields.button_url = 'Ссылка кнопки должна начинаться с https://';
  if (Boolean(data.button_text) !== Boolean(data.button_url)) {
    fields[data.button_text ? 'button_url' : 'button_text'] = 'Для кнопки нужны и текст, и ссылка';
  }
  return fields;
}

function render(req, res, { status = 200, form = null, fields = {}, error = null } = {}) {
  const history = broadcasts.listBroadcasts(30);
  res.status(status).render(view('broadcasts/index'), {
    title: 'Рассылки',
    section: 'broadcasts',
    history,
    statuses: broadcasts.BROADCAST_STATUS_LABELS,
    audience: tgUsers.countTgUsers(),
    botEnabled: tg.isConfigured(),
    botUsername: config.bot.username,
    // poll for progress only while THIS process is really sending something
    sending: history.some((b) => broadcasts.isSending(b.id)),
    /** stopped or interrupted broadcasts that can be continued from the last recipient */
    canResume: (b) => b.status !== 'draft' && broadcasts.canSend(b),
    form: form || { text: '', image: '', button_text: '', button_url: '' },
    fields,
    error,
  });
}

router.get('/', (req, res) => render(req, res));

/** Progress feed for the history table while a broadcast is being sent. */
router.get('/status.json', (req, res) => {
  res.json({
    ok: true,
    items: broadcasts.listBroadcasts(30).map((b) => ({
      id: b.id, status: b.status, status_label: broadcasts.BROADCAST_STATUS_LABELS[b.status] || b.status, total: b.total, sent: b.sent, failed: b.failed,
      error: b.error || '',
    })),
  });
});

function start(req, broadcast) {
  // Runs in the background: the service saves progress in the row; the page polls status.json.
  broadcasts.sendBroadcast(broadcast.id).catch((err) => {
    console.error(`[admin] broadcast ${broadcast.id} failed:`, err?.message || err);
  });
}

router.post('/', wrap((req, res, next) => {
  const form = {
    text: String(req.body.text ?? '').replace(/\r\n/g, '\n').trim().slice(0, 3500),
    image: clean(req.body.image, 500),
    button_text: clean(req.body.button_text, 60),
    button_url: clean(req.body.button_url, 500),
  };
  const fields = validate(form);
  if (Object.keys(fields).length) return render(req, res, { status: 422, form, fields, error: 'Проверьте отмеченные поля' });
  const sendNow = req.body.action === 'send';
  if (sendNow && !tg.isConfigured()) {
    return render(req, res, { status: 409, form, error: 'Бот не подключён (BOT_TOKEN не задан) — отправка недоступна. Можно сохранить черновик.' });
  }
  let broadcast;
  try {
    broadcast = broadcasts.createBroadcast(form, req.admin.id);
  } catch (err) {
    if (isUserError(err)) return render(req, res, { status: 422, form, error: err.message });
    return next(err);
  }
  if (sendNow) {
    start(req, broadcast);
    req.flash('success', `Рассылка #${broadcast.id} запущена. Прогресс отображается в истории.`);
  } else {
    req.flash('success', `Черновик рассылки #${broadcast.id} сохранён`);
  }
  return res.redirect('/admin/broadcasts');
}));

router.post('/:id/send', (req, res, next) => {
  const id = intParam(req.params.id);
  const broadcast = id ? broadcasts.getBroadcast(id) : null;
  if (!broadcast) return next(notFound('Рассылка'));
  if (!tg.isConfigured()) {
    req.flash('error', 'Бот не подключён (BOT_TOKEN не задан) — отправка недоступна');
  } else if (!broadcasts.canSend(broadcast)) {
    req.flash('error', broadcasts.isSending(broadcast.id) ? 'Эта рассылка уже отправляется' : 'Эта рассылка уже отправлялась');
  } else {
    // a draft starts from the first recipient; a stopped / interrupted one continues where it stopped
    const resumed = broadcast.status !== 'draft';
    start(req, broadcast);
    req.flash('success', resumed ? `Рассылка #${broadcast.id} продолжена с того места, где остановилась` : `Рассылка #${broadcast.id} запущена`);
  }
  return res.redirect('/admin/broadcasts');
});

export default router;

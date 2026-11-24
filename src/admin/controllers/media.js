// Media library: validated image uploads, a JSON feed for the image picker, alt text, delete.
// Multipart requests carry the CSRF token in the query string or the X-CSRF-Token header
// (the body is not parsed yet when the global CSRF check runs).
import { Router } from 'express';
import * as media from '../../services/media.js';
import { config } from '../../config.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, intParam, paginate, pageOffset, backUrl } from '../lib.js';

const router = Router();
const PER_PAGE = 36;

const wantsJson = (req) => req.xhr || req.accepts(['html', 'json']) === 'json';

router.get('/', (req, res) => {
  const { items, total } = media.listMedia({ limit: PER_PAGE, offset: pageOffset(req, PER_PAGE) });
  res.render(view('media/index'), {
    title: 'Медиатека',
    section: 'media',
    items,
    pager: paginate(req, total, PER_PAGE),
    accept: media.ACCEPT_ATTR,
    maxMb: Math.round(config.uploads.maxBytes / 1024 / 1024),
  });
});

/** Feed for the image picker dialog. */
router.get('/list.json', (req, res) => {
  const { items, total } = media.listMedia({ limit: 60, offset: pageOffset(req, 60) });
  res.json({
    ok: true,
    total,
    items: items.map((m) => ({ id: m.id, url: m.url, name: m.original_name || m.filename, alt: m.alt, size: m.size })),
  });
});

/**
 * Upload one or many images (field "files"). Answers JSON for fetch() uploads from the editors
 * and redirects back for the plain form of the library page.
 */
router.post('/upload', media.upload.array('files', 10), (req, res) => {
  const files = req.files || [];
  const saved = [];
  const errors = [];
  for (const file of files) {
    try {
      saved.push(media.registerUpload(file, { adminId: req.admin.id }));
    } catch (err) {
      errors.push(`${Buffer.from(file.originalname || '', 'latin1').toString('utf8') || 'файл'}: ${media.uploadErrorMessage(err)}`);
    }
  }
  if (!files.length) errors.push('Выберите хотя бы один файл');

  if (wantsJson(req)) {
    if (!saved.length) return res.status(422).json({ ok: false, error: 'upload_failed', message: errors.join('; ') });
    return res.json({
      ok: true,
      items: saved.map((m) => ({ id: m.id, url: m.url, name: m.original_name || m.filename, alt: m.alt, size: m.size })),
      ...(errors.length ? { warnings: errors } : {}),
    });
  }
  if (saved.length) req.flash('success', saved.length === 1 ? 'Изображение загружено' : `Загружено изображений: ${saved.length}`);
  for (const message of errors.slice(0, 3)) req.flash('error', message);
  return res.redirect(backUrl(req, '/admin/media'));
});

function loadMedia(req) {
  const id = intParam(req.params.id);
  const item = id ? media.getMedia(id) : null;
  if (!item) throw notFound('Изображение');
  return item;
}

router.post('/:id', (req, res) => {
  const item = loadMedia(req);
  media.updateMedia(item.id, { alt: clean(req.body.alt, 200) });
  req.flash('success', 'Описание изображения сохранено');
  res.redirect(backUrl(req, '/admin/media'));
});

router.post('/:id/delete', (req, res) => {
  const item = loadMedia(req);
  media.deleteMedia(item.id);
  req.flash('success', 'Изображение удалено. Проверьте, что оно не использовалось на страницах сайта.');
  res.redirect(backUrl(req, '/admin/media'));
});

export default router;

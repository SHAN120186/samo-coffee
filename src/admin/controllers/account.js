// Own account (profile + password) and admin user management (owners only).
import { Router } from 'express';
import * as auth from '../../services/auth.js';
import { notFound } from '../../lib/errors.js';
import { clean } from '../../lib/escape.js';
import { view, intParam, flag, isUserError } from '../lib.js';

const router = Router();

// ─────────────────────────────── own account

function renderAccount(req, res, { status = 200, error = null, errorForm = '', profile = null } = {}) {
  res.status(status).render(view('account/index'), {
    title: 'Мой аккаунт',
    section: 'account',
    profile: profile || { name: req.admin.name, email: req.admin.email },
    minPassword: auth.MIN_PASSWORD_LENGTH,
    error,
    errorForm,
  });
}

router.get('/account', (req, res) => renderAccount(req, res));

router.post('/account/profile', (req, res, next) => {
  const profile = { name: clean(req.body.name, 120), email: clean(req.body.email, 160).toLowerCase() };
  try {
    auth.updateAdmin(req.admin.id, profile);
  } catch (err) {
    if (isUserError(err)) return renderAccount(req, res, { status: 422, error: err.message, errorForm: 'profile', profile });
    return next(err);
  }
  req.flash('success', 'Профиль сохранён');
  return res.redirect('/admin/account');
});

router.post('/account/password', (req, res, next) => {
  const current = String(req.body.current_password || '');
  const next1 = String(req.body.new_password || '');
  const next2 = String(req.body.new_password_confirm || '');
  if (next1 !== next2) {
    return renderAccount(req, res, { status: 422, error: 'Новый пароль и подтверждение не совпадают', errorForm: 'password' });
  }
  try {
    // Other sessions of this admin are closed; the current one stays.
    auth.changePassword(req.admin.id, current, next1, { keepToken: req.adminToken });
  } catch (err) {
    if (isUserError(err)) return renderAccount(req, res, { status: 422, error: err.message, errorForm: 'password' });
    return next(err);
  }
  req.flash('success', 'Пароль изменён. Остальные сеансы завершены.');
  return res.redirect('/admin/account');
});

// ─────────────────────────────── admins (owner only)

const owner = auth.requireRole('owner');

router.get('/admins', owner, (req, res) => {
  res.render(view('admins/index'), { title: 'Администраторы', section: 'admins', admins: auth.listAdmins(), roles: auth.ADMIN_ROLES });
});

function renderAdminForm(req, res, { item, isNew, status = 200, error = null }) {
  res.status(status).render(view('admins/form'), {
    title: isNew ? 'Новый администратор' : item.name || item.email,
    section: 'admins',
    item,
    isNew,
    roles: auth.ADMIN_ROLES,
    minPassword: auth.MIN_PASSWORD_LENGTH,
    isSelf: !isNew && item.id === req.admin.id,
    error,
  });
}

router.get('/admins/new', owner, (req, res) => {
  renderAdminForm(req, res, { item: { name: '', email: '', role: 'manager', active: 1 }, isNew: true });
});

router.post('/admins', owner, (req, res, next) => {
  const data = {
    name: clean(req.body.name, 120),
    email: clean(req.body.email, 160).toLowerCase(),
    role: clean(req.body.role, 20),
    password: String(req.body.password || ''),
  };
  try {
    const created = auth.createAdmin(data);
    req.flash('success', `Администратор ${created.email} добавлен`);
    return res.redirect('/admin/admins');
  } catch (err) {
    if (isUserError(err)) return renderAdminForm(req, res, { item: { ...data, password: undefined, active: 1 }, isNew: true, status: 422, error: err.message });
    return next(err);
  }
});

function loadAdminUser(req) {
  const id = intParam(req.params.id);
  const item = id ? auth.getAdmin(id) : null;
  if (!item) throw notFound('Администратор');
  return item;
}

router.get('/admins/:id', owner, (req, res) => {
  renderAdminForm(req, res, { item: loadAdminUser(req), isNew: false });
});

router.post('/admins/:id', owner, (req, res, next) => {
  const item = loadAdminUser(req);
  const isSelf = item.id === req.admin.id;
  const data = {
    name: clean(req.body.name, 120),
    email: clean(req.body.email, 160).toLowerCase(),
    // An owner cannot lock themselves out by accident: own role / active flag are not editable here.
    ...(isSelf ? {} : { role: clean(req.body.role, 20), active: flag(req.body.active) }),
  };
  const password = String(req.body.password || '');
  if (password && !isSelf && password.length < auth.MIN_PASSWORD_LENGTH) {
    return renderAdminForm(req, res, {
      item: { ...item, ...data }, isNew: false, status: 422, error: `Пароль должен быть не короче ${auth.MIN_PASSWORD_LENGTH} символов`,
    });
  }
  try {
    auth.updateAdmin(item.id, data);
    if (password) {
      if (isSelf) {
        req.flash('warning', 'Свой пароль меняйте в разделе «Мой аккаунт»');
      } else {
        auth.setPassword(item.id, password);
      }
    }
  } catch (err) {
    if (isUserError(err)) return renderAdminForm(req, res, { item: { ...item, ...data }, isNew: false, status: 422, error: err.message });
    return next(err);
  }
  req.flash('success', `Данные ${data.email} сохранены${password && !isSelf ? ', пароль обновлён' : ''}`);
  return res.redirect('/admin/admins');
});

router.post('/admins/:id/delete', owner, (req, res) => {
  const item = loadAdminUser(req);
  if (item.id === req.admin.id) {
    req.flash('error', 'Нельзя удалить собственную учётную запись');
    return res.redirect('/admin/admins');
  }
  auth.deleteAdmin(item.id); // throws 'validation' for the last owner → flash via the router error handler
  req.flash('success', `Администратор ${item.email} удалён`);
  return res.redirect('/admin/admins');
});

export default router;

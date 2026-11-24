// MINI APP module: JSON API mounted at /api/tma (STUB — replaced by the MINI APP module).
// Auth: `Authorization: tma <initData>` validated with lib/initData.js → resolveTmaUser(req).
// This prefix is CSRF-exempt (no cookies are used) — every mutating route MUST require a valid user.
import { Router } from 'express';
import { resolveTmaUser } from '../lib/initData.js';

const router = Router();

router.get('/ping', (req, res) => {
  const auth = resolveTmaUser(req);
  res.json({ ok: true, stub: true, user: auth.user ? { id: auth.user.id, first_name: auth.user.first_name } : null, dev: Boolean(auth.dev) });
});

export default router;

const express = require('express');
const { env } = require('../../config/env');
const { validateBody } = require('../../middleware/validate');
const { requireStaff, staffWith } = require('../../middleware/session');
const { setSessionCookie, clearSessionCookie } = require('../../lib/cookies');
const { loginSchema, changePasswordSchema, recoverSchema, recoveryCodesSchema } = require('./schemas');
const service = require('./service');

const router = express.Router();

const clientInfo = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 255) });

router.post('/login', validateBody(loginSchema), async (req, res) => {
  const { token, expiresAt } = await service.login({ ...req.body, ...clientInfo(req) });
  setSessionCookie(res, env.SESSION_COOKIE_NAME, token, expiresAt);
  res.json({ ok: true });
});

router.post('/logout', requireStaff, async (req, res) => {
  await service.logout(req.sessionId);
  clearSessionCookie(res, env.SESSION_COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireStaff, (req, res) => {
  res.json({ user: req.user });
});

router.post('/change-password', requireStaff, validateBody(changePasswordSchema), async (req, res) => {
  await service.changePassword({ userId: req.user.id, sessionId: req.sessionId, ...req.body, ip: req.ip });
  res.json({ ok: true });
});

// Recovery codes belong to Owners (users.manage): staff passwords are reset by an Owner.
router.get('/recovery-codes', staffWith('users.manage'), async (req, res) => {
  res.json(await service.recoveryCodeStatus(req.user.id));
});

router.post('/recovery-codes', staffWith('users.manage'), validateBody(recoveryCodesSchema), async (req, res) => {
  const codes = await service.newRecoveryCodes({ userId: req.user.id, currentPassword: req.body.currentPassword, ip: req.ip });
  res.status(201).json({ codes });
});

// From the login page, with no session.
router.post('/recover', validateBody(recoverSchema), async (req, res) => {
  await service.recoverWithCode({ ...req.body, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;

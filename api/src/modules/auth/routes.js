const express = require('express');
const { env } = require('../../config/env');
const { validateBody } = require('../../middleware/validate');
const { requireStaff } = require('../../middleware/session');
const { setSessionCookie, clearSessionCookie } = require('../../lib/cookies');
const { loginSchema, changePasswordSchema } = require('./schemas');
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

module.exports = router;

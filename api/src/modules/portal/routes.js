const express = require('express');
const { env } = require('../../config/env');
const { validateBody } = require('../../middleware/validate');
const { requireCustomer } = require('../../middleware/session');
const { setSessionCookie, clearSessionCookie } = require('../../lib/cookies');
const { portalLoginSchema, changePinSchema } = require('./schemas');
const service = require('./service');

// Customer portal. Nothing in this router may use requireStaff or read data
// that is not filtered by req.customer.id.
const router = express.Router();

const clientInfo = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 255) });

router.post('/login', validateBody(portalLoginSchema), async (req, res) => {
  const { token, expiresAt } = await service.login({ ...req.body, ...clientInfo(req) });
  setSessionCookie(res, env.PORTAL_COOKIE_NAME, token, expiresAt);
  res.json({ ok: true });
});

router.post('/logout', requireCustomer, async (req, res) => {
  await service.logout(req.customerSessionId);
  clearSessionCookie(res, env.PORTAL_COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireCustomer, (req, res) => {
  res.json({ customer: req.customer });
});

router.post('/change-pin', requireCustomer, validateBody(changePinSchema), async (req, res) => {
  await service.changePin({ customerId: req.customer.id, sessionId: req.customerSessionId, ...req.body, ip: req.ip });
  res.json({ ok: true });
});

module.exports = router;

const { env } = require('../../config/env');
const { query, transaction } = require('../../db/pool');
const { newToken, hashToken, hashSecret, verifySecret } = require('../../lib/crypto');
const { assertNotLocked, recordAttempt } = require('../../lib/loginGuard');
const { normalizePhone } = require('../../lib/phone');
const { writeAudit } = require('../../lib/audit');
const { unauthenticated, badRequest } = require('../../lib/errors');

const INVALID = 'Incorrect mobile number or PIN.';

/**
 * Portal login with mobile number + 6-digit PIN.
 *
 * The PIN is always checked against customers.portal_password_hash (bcrypt).
 * customers.portal_pin holds the shop-issued PIN in readable form only so that
 * staff can tell it to the customer; it is cleared when the customer chooses
 * their own PIN (see changePin).
 *
 * A 6-digit PIN has only a million possibilities, so the lockout in
 * loginGuard is what actually protects the account.
 */
async function login({ phone, pin, ip, userAgent }) {
  const normalized = normalizePhone(phone);
  // Lock on what was typed even if it is not a valid number, so garbage input
  // still counts against the IP.
  const identifier = `portal:${normalized || phone.replace(/\s+/g, '').slice(0, 40)}`;
  await assertNotLocked(identifier, ip);

  const rows = normalized
    ? await query('SELECT id, portal_password_hash, portal_enabled, is_active FROM customers WHERE phone = ?', [normalized])
    : [];
  const customer = rows[0];
  const pinOk = await verifySecret(pin, customer && customer.portal_password_hash);

  if (!customer || !pinOk || !customer.portal_enabled || !customer.is_active) {
    await recordAttempt(identifier, ip, false);
    throw unauthenticated(INVALID);
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + env.PORTAL_SESSION_DAYS * 24 * 3600 * 1000);
  await query('INSERT INTO customer_sessions (customer_id, token_hash, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)', [
    customer.id,
    hashToken(token),
    ip,
    userAgent,
    expiresAt,
  ]);
  await query('UPDATE customers SET last_portal_login_at = UTC_TIMESTAMP() WHERE id = ?', [customer.id]);
  await recordAttempt(identifier, ip, true);

  return { token, expiresAt };
}

async function logout(sessionId) {
  await query('DELETE FROM customer_sessions WHERE id = ?', [sessionId]);
}

/** Customer chooses their own PIN. Other devices are logged out. */
async function changePin({ customerId, sessionId, currentPin, newPin, ip }) {
  const rows = await query('SELECT portal_password_hash FROM customers WHERE id = ?', [customerId]);
  if (!(await verifySecret(currentPin, rows[0] && rows[0].portal_password_hash))) {
    throw badRequest('Please check the highlighted fields.', { fields: { currentPin: 'Current PIN is incorrect.' } });
  }
  if (currentPin === newPin) {
    throw badRequest('Please check the highlighted fields.', { fields: { newPin: 'Choose a PIN different from the current one.' } });
  }

  const pinHash = await hashSecret(newPin);
  await transaction(async (conn) => {
    // portal_pin = NULL: a PIN the customer chose is never stored readably.
    await conn.execute('UPDATE customers SET portal_password_hash = ?, portal_pin = NULL WHERE id = ?', [pinHash, customerId]);
    await conn.execute('DELETE FROM customer_sessions WHERE customer_id = ? AND id <> ?', [customerId, sessionId]);
    await writeAudit({ conn, action: 'customer.change_pin', entityType: 'customer', entityId: customerId, ip });
  });
}

module.exports = { login, logout, changePin };

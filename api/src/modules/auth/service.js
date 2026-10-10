const { env } = require('../../config/env');
const { query, transaction } = require('../../db/pool');
const { newToken, hashToken, hashSecret, verifySecret } = require('../../lib/crypto');
const { assertNotLocked, recordAttempt } = require('../../lib/loginGuard');
const { writeAudit } = require('../../lib/audit');
const { unauthenticated, badRequest } = require('../../lib/errors');

// One message for every failure, so the response never reveals whether the
// username exists.
const INVALID = 'Incorrect username or password.';

async function login({ username, password, ip, userAgent }) {
  const identifier = `staff:${username}`;
  await assertNotLocked(identifier, ip);

  const rows = await query('SELECT id, password_hash, status FROM users WHERE username = ?', [username]);
  const user = rows[0];
  const passwordOk = await verifySecret(password, user && user.password_hash);

  if (!user || !passwordOk || user.status !== 'active') {
    await recordAttempt(identifier, ip, false);
    throw unauthenticated(INVALID);
  }

  const token = newToken();
  const expiresAt = new Date(Date.now() + env.SESSION_HOURS * 3600 * 1000);
  await query('INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES (?, ?, ?, ?, ?)', [
    user.id,
    hashToken(token),
    ip,
    userAgent,
    expiresAt,
  ]);
  await query('UPDATE users SET last_login_at = UTC_TIMESTAMP() WHERE id = ?', [user.id]);
  await recordAttempt(identifier, ip, true);

  return { token, expiresAt };
}

async function logout(sessionId) {
  await query('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE id = ? AND revoked_at IS NULL', [sessionId]);
}

/**
 * Change the logged-in user's password. Every other session of that user is
 * revoked, so a stolen session does not survive a password change.
 */
async function changePassword({ userId, sessionId, currentPassword, newPassword, ip }) {
  const rows = await query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!(await verifySecret(currentPassword, rows[0] && rows[0].password_hash))) {
    throw badRequest('Please check the highlighted fields.', { fields: { currentPassword: 'Current password is incorrect.' } });
  }
  if (currentPassword === newPassword) {
    throw badRequest('Please check the highlighted fields.', { fields: { newPassword: 'Choose a password different from the current one.' } });
  }

  const passwordHash = await hashSecret(newPassword);
  await transaction(async (conn) => {
    await conn.execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [passwordHash, userId]);
    await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND id <> ? AND revoked_at IS NULL', [userId, sessionId]);
    await writeAudit({ conn, actorUserId: userId, action: 'user.change_password', entityType: 'user', entityId: userId, ip });
  });
}

module.exports = { login, logout, changePassword };

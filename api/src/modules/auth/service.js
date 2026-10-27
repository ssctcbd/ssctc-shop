const { env } = require('../../config/env');
const { query, transaction } = require('../../db/pool');
const { newToken, hashToken, hashSecret, verifySecret, newRecoveryCode, hashRecoveryCode } = require('../../lib/crypto');
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

// --- Owner recovery codes (an Owner who forgot the password) -----------------

const RECOVERY_CODE_COUNT = 10;
const RECOVERY_INVALID = 'The username or recovery code is not right.';

/**
 * Make a new set of recovery codes for an Owner, replacing any earlier set.
 * The current password is asked again, so a session left open cannot be used
 * to take over the account later. The codes are returned once and never again.
 */
async function newRecoveryCodes({ userId, currentPassword, ip }) {
  const rows = await query('SELECT password_hash FROM users WHERE id = ?', [userId]);
  if (!(await verifySecret(currentPassword, rows[0] && rows[0].password_hash))) {
    throw badRequest('Please check the highlighted fields.', { fields: { currentPassword: 'Current password is incorrect.' } });
  }
  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, newRecoveryCode);
  await transaction(async (conn) => {
    await conn.execute('DELETE FROM owner_recovery_codes WHERE user_id = ?', [userId]);
    for (const code of codes) await conn.execute('INSERT INTO owner_recovery_codes (user_id, code_hash) VALUES (?, ?)', [userId, hashRecoveryCode(code)]);
    await writeAudit({ conn, actorUserId: userId, action: 'user.recovery_codes', entityType: 'user', entityId: userId, newValues: { codes: RECOVERY_CODE_COUNT }, ip });
  });
  return codes;
}

async function recoveryCodeStatus(userId) {
  const rows = await query('SELECT COUNT(*) AS total, COALESCE(SUM(used_at IS NULL), 0) AS unused, MIN(created_at) AS created_at FROM owner_recovery_codes WHERE user_id = ?', [userId]);
  return { total: Number(rows[0].total), unused: Number(rows[0].unused), createdAt: rows[0].created_at };
}

/**
 * Set a new password with a recovery code, from the login page. Only an active
 * Owner has codes. The code is used up, every session of that user ends and
 * any login lockout is lifted. Failures count toward the same lockout as
 * logins, and every failure gets the same message.
 */
async function recoverWithCode({ username, code, newPassword, ip }) {
  const identifier = `recover:${username}`;
  await assertNotLocked(identifier, ip);

  const rows = await query(
    `SELECT u.id, c.id AS code_id FROM users u JOIN roles r ON r.id = u.role_id
       JOIN owner_recovery_codes c ON c.user_id = u.id AND c.code_hash = ? AND c.used_at IS NULL
      WHERE u.username = ? AND u.status = 'active' AND r.code = 'owner'`,
    [hashRecoveryCode(code), username],
  );
  const found = rows[0];
  if (!found || code.length !== 10) {
    await recordAttempt(identifier, ip, false);
    throw badRequest(RECOVERY_INVALID, { fields: { code: RECOVERY_INVALID } });
  }

  const passwordHash = await hashSecret(newPassword);
  await transaction(async (conn) => {
    const [used] = await conn.execute('UPDATE owner_recovery_codes SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [found.code_id]);
    if (used.affectedRows !== 1) throw badRequest(RECOVERY_INVALID, { fields: { code: RECOVERY_INVALID } });
    await conn.execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [passwordHash, found.id]);
    await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [found.id]);
    await conn.execute('DELETE FROM login_attempts WHERE identifier IN (?, ?)', [`staff:${username}`, identifier]);
    await writeAudit({ conn, actorUserId: found.id, action: 'user.recover_password', entityType: 'user', entityId: found.id, ip });
  });
}

module.exports = { login, logout, changePassword, newRecoveryCodes, recoveryCodeStatus, recoverWithCode };

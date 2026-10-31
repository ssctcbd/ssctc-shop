const { env } = require('../../config/env');
const { query, transaction } = require('../../db/pool');
const { newToken, hashToken, hashSecret, verifySecret, newPin, newRecoveryCode, hashRecoveryCode } = require('../../lib/crypto');
const { mailConfigured, sendMail } = require('../../lib/mail');
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

// --- Owner password code by email ----------------------------------------------

const OTP_MINUTES = 10;
const OTP_MAX_TRIES = 5;
const OTP_RESEND_SECONDS = 60;
const OTP_MAX_PER_HOUR = 5;
const OTP_INVALID = 'That code is not right, or it has expired. Ask for a new one.';

const otpHash = (userId, code) => hashToken(`${userId}:${code}`);

/** Mail sent without waiting: a slow mail server must not show who is an Owner, or hold up the reset. */
function sendInBackground(message) {
  sendMail(message).catch((err) => console.error(`[mail] ${message.subject}: ${err.message}`));
}

async function recoveryEmailStatus(userId) {
  const rows = await query('SELECT email FROM users WHERE id = ?', [userId]);
  return { email: rows[0] ? rows[0].email : null, mailReady: mailConfigured() };
}

/**
 * Set or clear the address an Owner's password codes go to. The password is
 * asked again, because whoever controls this address can reset the password.
 * A test message goes out at once and any failure is reported, so a mistake in
 * the address or the mail setup is found now and not on the day it is needed.
 */
async function setRecoveryEmail({ userId, currentPassword, email, ip }) {
  const rows = await query('SELECT password_hash, email FROM users WHERE id = ?', [userId]);
  if (!(await verifySecret(currentPassword, rows[0] && rows[0].password_hash))) {
    throw badRequest('Please check the highlighted fields.', { fields: { currentPassword: 'Current password is incorrect.' } });
  }
  await query('UPDATE users SET email = ? WHERE id = ?', [email, userId]);
  await writeAudit({ actorUserId: userId, action: 'user.recovery_email', entityType: 'user', entityId: userId, oldValues: { email: rows[0].email }, newValues: { email }, ip });
  if (!email) return { email: null, mailReady: mailConfigured(), test: null };
  try {
    await sendMail({ to: email, subject: 'SSCTC Shop: this address can now reset your password', text: 'This address will receive the code if you use "Forgot password?" on the shop login page.\n\nIf you did not set this, change your shop password now.' });
    return { email, mailReady: true, test: { sent: true } };
  } catch (err) {
    return { email, mailReady: mailConfigured(), test: { sent: false, error: String(err.message).slice(0, 200) } };
  }
}

/**
 * Send a six-digit code to an Owner's email. Quietly does nothing for anyone
 * else, for an Owner with no address, and when codes are being asked for too
 * often (so nobody can flood the mailbox or use this to find usernames). A new
 * code cancels the earlier one.
 */
async function requestPasswordOtp({ username, ip }) {
  await assertNotLocked(`otp:${username}`, ip);
  const rows = await query(
    `SELECT u.id, u.email,
            (SELECT COUNT(*) FROM owner_password_otps o WHERE o.user_id = u.id AND o.created_at > UTC_TIMESTAMP() - INTERVAL 1 HOUR) AS last_hour,
            (SELECT COUNT(*) FROM owner_password_otps o WHERE o.user_id = u.id AND o.created_at > UTC_TIMESTAMP() - INTERVAL ${OTP_RESEND_SECONDS} SECOND) AS just_now
       FROM users u JOIN roles r ON r.id = u.role_id
      WHERE u.username = ? AND u.status = 'active' AND r.code = 'owner' AND u.email IS NOT NULL`,
    [username],
  );
  const owner = rows[0];
  if (!owner || !mailConfigured() || Number(owner.just_now) > 0 || Number(owner.last_hour) >= OTP_MAX_PER_HOUR) return;

  const code = newPin();
  await transaction(async (conn) => {
    await conn.execute('UPDATE owner_password_otps SET used_at = UTC_TIMESTAMP() WHERE user_id = ? AND used_at IS NULL', [owner.id]);
    await conn.execute(`INSERT INTO owner_password_otps (user_id, code_hash, expires_at, ip) VALUES (?, ?, UTC_TIMESTAMP() + INTERVAL ${OTP_MINUTES} MINUTE, ?)`, [owner.id, otpHash(owner.id, code), ip]);
    await writeAudit({ conn, actorUserId: owner.id, action: 'user.password_otp_sent', entityType: 'user', entityId: owner.id, ip });
  });
  sendInBackground({
    to: owner.email,
    subject: `SSCTC Shop password code: ${code}`,
    text: `Your code to set a new shop password is: ${code}\n\nIt works once, for ${OTP_MINUTES} minutes.\n\nIf you did not ask for this, ignore this email. Your password has not changed.`,
  });
}

/**
 * Set a new password with the emailed code. Only the newest code counts; five
 * wrong tries cancel it, and failures count toward the same lockout as logins.
 * Every failure gets the same message. On success the code is used up, every
 * session of that user ends, and a notice goes to the same address.
 */
async function resetPasswordWithOtp({ username, code, newPassword, ip }) {
  const identifier = `otp:${username}`;
  await assertNotLocked(identifier, ip);

  const rows = await query(
    `SELECT u.id, u.email, o.id AS otp_id, o.code_hash
       FROM users u JOIN roles r ON r.id = u.role_id
       JOIN owner_password_otps o ON o.user_id = u.id AND o.used_at IS NULL AND o.expires_at > UTC_TIMESTAMP()
      WHERE u.username = ? AND u.status = 'active' AND r.code = 'owner'
      ORDER BY o.id DESC LIMIT 1`,
    [username],
  );
  const found = rows[0];
  if (!found || found.code_hash !== otpHash(found.id, code)) {
    // used_at first: MySQL applies these left to right, so `attempts` here is still the old count.
    if (found) await query(`UPDATE owner_password_otps SET used_at = IF(attempts + 1 >= ${OTP_MAX_TRIES}, UTC_TIMESTAMP(), used_at), attempts = attempts + 1 WHERE id = ?`, [found.otp_id]);
    await recordAttempt(identifier, ip, false);
    throw badRequest(OTP_INVALID, { fields: { code: OTP_INVALID } });
  }

  const passwordHash = await hashSecret(newPassword);
  await transaction(async (conn) => {
    const [used] = await conn.execute('UPDATE owner_password_otps SET used_at = UTC_TIMESTAMP() WHERE id = ? AND used_at IS NULL', [found.otp_id]);
    if (used.affectedRows !== 1) throw badRequest(OTP_INVALID, { fields: { code: OTP_INVALID } });
    await conn.execute('UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?', [passwordHash, found.id]);
    await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [found.id]);
    await conn.execute('DELETE FROM login_attempts WHERE identifier IN (?, ?)', [`staff:${username}`, identifier]);
    await writeAudit({ conn, actorUserId: found.id, action: 'user.reset_password_otp', entityType: 'user', entityId: found.id, ip });
  });
  sendInBackground({ to: found.email, subject: 'SSCTC Shop: your password was changed', text: 'Your shop password was just changed with an emailed code. If this was not you, contact whoever manages the hosting at once.' });
}

module.exports = { login, logout, changePassword, newRecoveryCodes, recoveryCodeStatus, recoverWithCode, recoveryEmailStatus, setRecoveryEmail, requestPasswordOtp, resetPasswordWithOtp };

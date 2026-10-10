const { query } = require('../db/pool');
const { tooManyRequests } = require('./errors');

// PROJECT_PLAN.md §6: 5 failures per account in 15 minutes locks it for 15
// minutes; 20 failures per IP blocks the IP. Counted in MySQL because the Node
// process may be restarted or run as several instances.
const WINDOW_MINUTES = 15;
const MAX_PER_IDENTIFIER = 5;
const MAX_PER_IP = 20;

async function failuresFor(column, value) {
  // Failures inside the window, counted from the last successful login.
  const rows = await query(
    `SELECT COUNT(*) AS failures, MAX(created_at) AS last_failure
       FROM login_attempts
      WHERE ${column} = ? AND success = 0
        AND created_at > UTC_TIMESTAMP() - INTERVAL ${WINDOW_MINUTES} MINUTE
        AND created_at > COALESCE(
              (SELECT MAX(created_at) FROM login_attempts WHERE ${column} = ? AND success = 1),
              '1970-01-01')`,
    [value, value],
  );
  return rows[0];
}

/** Throws 429 if this identifier or IP is currently locked out. */
async function assertNotLocked(identifier, ip) {
  const [byId, byIp] = await Promise.all([failuresFor('identifier', identifier), failuresFor('ip', ip)]);
  if (Number(byId.failures) >= MAX_PER_IDENTIFIER || Number(byIp.failures) >= MAX_PER_IP) {
    throw tooManyRequests(`Too many failed attempts. Try again in ${WINDOW_MINUTES} minutes.`, {
      retryAfterMinutes: WINDOW_MINUTES,
    });
  }
}

async function recordAttempt(identifier, ip, success) {
  await query('INSERT INTO login_attempts (identifier, ip, success) VALUES (?, ?, ?)', [
    identifier.slice(0, 60),
    ip,
    success ? 1 : 0,
  ]);
}

module.exports = { assertNotLocked, recordAttempt, WINDOW_MINUTES, MAX_PER_IDENTIFIER, MAX_PER_IP };

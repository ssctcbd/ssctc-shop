const { env } = require('../config/env');
const { query } = require('../db/pool');
const { hashToken } = require('../lib/crypto');
const { readCookie } = require('../lib/cookies');
const { unauthenticated, forbidden } = require('../lib/errors');

// last_seen_at is refreshed at most this often, to avoid a write per request.
const TOUCH_INTERVAL_SECONDS = 60;

/**
 * Staff session. Loads the user, role and permissions for the cookie's token.
 * A session is valid while it is not revoked, not past its absolute expiry and
 * not idle for longer than SESSION_IDLE_HOURS.
 */
async function loadStaffSession(req) {
  const token = readCookie(req, env.SESSION_COOKIE_NAME);
  if (!token) return null;

  const rows = await query(
    `SELECT s.id AS session_id,
            TIMESTAMPDIFF(SECOND, s.last_seen_at, UTC_TIMESTAMP()) AS idle_seconds,
            u.id, u.name, u.username, u.must_change_password, u.status,
            r.id AS role_id, r.code AS role_code, r.name AS role_name
       FROM sessions s
       JOIN users u ON u.id = s.user_id
       JOIN roles r ON r.id = u.role_id
      WHERE s.token_hash = ? AND s.revoked_at IS NULL AND s.expires_at > UTC_TIMESTAMP()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || row.status !== 'active') return null;
  if (row.idle_seconds > env.SESSION_IDLE_HOURS * 3600) return null;

  if (row.idle_seconds >= TOUCH_INTERVAL_SECONDS) {
    await query('UPDATE sessions SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [row.session_id]);
  }

  const perms = await query('SELECT permission FROM role_permissions WHERE role_id = ?', [row.role_id]);
  return {
    sessionId: row.session_id,
    user: {
      id: row.id,
      name: row.name,
      username: row.username,
      role: { code: row.role_code, name: row.role_name },
      mustChangePassword: Boolean(row.must_change_password),
      permissions: perms.map((p) => p.permission),
    },
  };
}

/** Require a logged-in staff user. Sets req.user and req.sessionId. */
async function requireStaff(req, _res, next) {
  const session = await loadStaffSession(req);
  if (!session) throw unauthenticated();
  req.user = session.user;
  req.sessionId = session.sessionId;
  next();
}

/** Require one permission. Use after requireStaff. */
function requirePermission(permission) {
  return (req, _res, next) => {
    if (!req.user) return next(unauthenticated());
    if (!req.user.permissions.includes(permission)) return next(forbidden());
    next();
  };
}

/** Route guard: a logged-in staff user holding `permission`. */
const staffWith = (permission) => [requireStaff, requirePermission(permission)];

/**
 * Customer portal session. Entirely separate from staff sessions: a different
 * cookie, a different table, and it only ever yields a customer id.
 */
async function loadCustomerSession(req) {
  const token = readCookie(req, env.PORTAL_COOKIE_NAME);
  if (!token) return null;

  const rows = await query(
    `SELECT cs.id AS session_id,
            TIMESTAMPDIFF(SECOND, cs.last_seen_at, UTC_TIMESTAMP()) AS idle_seconds,
            c.id, c.name, c.phone, c.current_due, c.advance_balance,
            c.portal_enabled, c.is_active, (c.portal_pin IS NOT NULL) AS pin_is_shop_issued
       FROM customer_sessions cs
       JOIN customers c ON c.id = cs.customer_id
      WHERE cs.token_hash = ? AND cs.expires_at > UTC_TIMESTAMP()`,
    [hashToken(token)],
  );
  const row = rows[0];
  if (!row || !row.portal_enabled || !row.is_active) return null;

  if (row.idle_seconds >= TOUCH_INTERVAL_SECONDS) {
    await query('UPDATE customer_sessions SET last_seen_at = UTC_TIMESTAMP() WHERE id = ?', [row.session_id]);
  }

  return {
    sessionId: row.session_id,
    customer: {
      id: row.id,
      name: row.name,
      phone: row.phone,
      currentDue: row.current_due,
      advanceBalance: row.advance_balance,
      // True while the customer still uses the PIN the shop generated.
      shouldChangePin: Boolean(row.pin_is_shop_issued),
    },
  };
}

/** Require a logged-in customer. Sets req.customer and req.customerSessionId. */
async function requireCustomer(req, _res, next) {
  const session = await loadCustomerSession(req);
  if (!session) throw unauthenticated();
  req.customer = session.customer;
  req.customerSessionId = session.sessionId;
  next();
}

module.exports = { requireStaff, requirePermission, staffWith, requireCustomer, loadStaffSession, loadCustomerSession };

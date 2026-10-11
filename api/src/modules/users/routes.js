const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db/pool');
const { validateBody, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { hashSecret } = require('../../lib/crypto');
const { writeAudit } = require('../../lib/audit');
const { conflict, badRequest, notFound } = require('../../lib/errors');
const { username, newPassword } = require('../auth/schemas');

// Staff accounts. Owner only (permission users.manage).
const router = express.Router();
// Guarded per route. A router-wide `router.use(guard)` would also run for
// every other module's paths that pass through this router.
const ownerOnly = staffWith('users.manage');

const createUserSchema = z.strictObject({
  name: z.string().trim().min(2).max(120),
  username,
  phone: z.string().trim().max(15).optional(),
  password: newPassword,
  role: z.enum(['owner', 'staff']),
});

router.get('/roles', ownerOnly, async (_req, res) => {
  const roles = await query('SELECT id, code, name FROM roles ORDER BY id');
  const perms = await query('SELECT role_id, permission FROM role_permissions ORDER BY permission');
  res.json({
    roles: roles.map((r) => ({ code: r.code, name: r.name, permissions: perms.filter((p) => p.role_id === r.id).map((p) => p.permission) })),
  });
});

router.get('/users', ownerOnly, async (_req, res) => {
  const users = await query(
    `SELECT u.id, u.name, u.username, u.phone, u.status, u.must_change_password AS mustChangePassword,
            u.last_login_at AS lastLoginAt, u.created_at AS createdAt, r.code AS role
       FROM users u JOIN roles r ON r.id = u.role_id
      ORDER BY u.id`,
  );
  res.json({ users: users.map((u) => ({ ...u, mustChangePassword: Boolean(u.mustChangePassword) })) });
});

router.post('/users', ownerOnly, validateBody(createUserSchema), async (req, res) => {
  const { name, username: uname, phone = null, password, role } = req.body;

  const roles = await query('SELECT id FROM roles WHERE code = ?', [role]);
  if (!roles[0]) throw badRequest('Unknown role.');
  const passwordHash = await hashSecret(password);

  const id = await transaction(async (conn) => {
    let result;
    try {
      // The new user is given the password by the Owner, so must change it on first login.
      [result] = await conn.execute(
        'INSERT INTO users (role_id, name, username, phone, password_hash, must_change_password) VALUES (?, ?, ?, ?, ?, 1)',
        [roles[0].id, name, uname, phone, passwordHash],
      );
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw conflict('Please check the highlighted fields.', { fields: { username: 'This username is already taken.' } });
      throw err;
    }
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'user.create',
      entityType: 'user',
      entityId: result.insertId,
      newValues: { name, username: uname, role },
      ip: req.ip,
    });
    return result.insertId;
  });

  res.status(201).json({ user: { id, name, username: uname, role } });
});

const updateUserSchema = z.strictObject({
  name: z.string().trim().min(2).max(120).optional(),
  phone: z.string().trim().max(15).nullable().optional(),
  role: z.enum(['owner', 'staff']).optional(),
  status: z.enum(['active', 'blocked']).optional(),
});

const resetPasswordSchema = z.strictObject({ password: newPassword });

/**
 * Change a user's name, phone, role or standing. Two things are never allowed,
 * because either could leave the shop with nobody able to manage it: changing
 * your own role or blocking yourself, and removing the last active Owner.
 * Blocking ends that user's sessions at once.
 */
router.put('/users/:id', ownerOnly, idParam, validateBody(updateUserSchema), async (req, res) => {
  const b = req.body;
  await transaction(async (conn) => {
    // Every Owner row is locked, so two changes cannot each remove "the other" Owner.
    await conn.execute("SELECT u.id FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' FOR UPDATE");
    const [rows] = await conn.execute('SELECT u.id, u.name, u.phone, u.status, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('User not found.');

    const next = { name: b.name ?? current.name, phone: b.phone === undefined ? current.phone : b.phone || null, role: b.role ?? current.role, status: b.status ?? current.status };
    const changed = Object.keys(next).filter((k) => next[k] !== current[k]);
    if (changed.length === 0) return;

    if (req.id === req.user.id && (changed.includes('role') || changed.includes('status'))) {
      throw conflict('You cannot change your own role or block yourself. Ask another Owner.');
    }
    const wasActiveOwner = current.role === 'owner' && current.status === 'active';
    const staysActiveOwner = next.role === 'owner' && next.status === 'active';
    if (wasActiveOwner && !staysActiveOwner) {
      const [owners] = await conn.execute("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' AND u.status = 'active' AND u.id <> ?", [req.id]);
      if (Number(owners[0].n) === 0) throw conflict('This is the only active Owner. Make someone else an Owner first.');
    }

    const [roles] = await conn.execute('SELECT id FROM roles WHERE code = ?', [next.role]);
    await conn.execute('UPDATE users SET name = ?, phone = ?, role_id = ?, status = ? WHERE id = ?', [next.name, next.phone, roles[0].id, next.status, req.id]);
    if (next.status === 'blocked') await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.id]);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'user.update',
      entityType: 'user',
      entityId: req.id,
      oldValues: Object.fromEntries(changed.map((k) => [k, current[k]])),
      newValues: Object.fromEntries(changed.map((k) => [k, next[k]])),
      ip: req.ip,
    });
  });
  const rows = await query('SELECT u.id, u.name, u.username, u.phone, u.status, r.code AS role FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = ?', [req.id]);
  res.json({ user: rows[0] });
});

/**
 * Give a user a new password, for one who forgot theirs. They must replace it
 * at the next login, every session of theirs ends, and any login lockout is
 * lifted. The password is never written to the audit log.
 */
router.post('/users/:id/reset-password', ownerOnly, idParam, validateBody(resetPasswordSchema), async (req, res) => {
  if (req.id === req.user.id) throw conflict('Change your own password from the Password screen.');
  const passwordHash = await hashSecret(req.body.password);
  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT username FROM users WHERE id = ? FOR UPDATE', [req.id]);
    if (!rows[0]) throw notFound('User not found.');
    await conn.execute('UPDATE users SET password_hash = ?, must_change_password = 1 WHERE id = ?', [passwordHash, req.id]);
    await conn.execute('UPDATE sessions SET revoked_at = UTC_TIMESTAMP() WHERE user_id = ? AND revoked_at IS NULL', [req.id]);
    await conn.execute('DELETE FROM login_attempts WHERE identifier = ?', [`staff:${rows[0].username}`]);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'user.reset_password', entityType: 'user', entityId: req.id, ip: req.ip });
  });
  res.json({ ok: true });
});

module.exports = router;

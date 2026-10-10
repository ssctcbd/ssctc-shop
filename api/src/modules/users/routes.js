const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../db/pool');
const { validateBody } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { hashSecret } = require('../../lib/crypto');
const { writeAudit } = require('../../lib/audit');
const { conflict, badRequest } = require('../../lib/errors');
const { username, newPassword } = require('../auth/schemas');

// Staff accounts. Owner only (permission users.manage). Edit, block and
// password reset arrive with the Users screen; Milestone 1 needs list + create.
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

module.exports = router;

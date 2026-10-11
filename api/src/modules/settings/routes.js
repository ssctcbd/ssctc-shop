const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { dayStart, dayEnd } = require('../../lib/dates');
const { badRequest } = require('../../lib/errors');
const { z, id, day, paging } = require('../../lib/schemas');

// Shop settings and the audit log: Owner only. The few settings every staff
// screen needs for a bill header are served by GET /settings/shop.
const router = express.Router();

const text = (max) => z.string().trim().max(max);

// The settings that can be changed from the screen, and what each may hold.
// Anything not listed here cannot be written through the API.
const EDITABLE = {
  'shop.name': z.string().trim().min(2, 'Enter the shop name.').max(120),
  'shop.tagline': text(150),
  'shop.address': text(255),
  'shop.phone': text(40),
  'shop.email': z.union([z.literal(''), z.string().trim().email('Not a valid email address.').max(120)]),
  'invoice.footer': text(255),
  'invoice.default_layout': z.enum(['a4', 'thermal80', 'thermal58']),
  'payment.bkash_number': text(20),
  'payment.nagad_number': text(20),
  'portal.enabled': z.boolean(),
};

const updateSchema = z.strictObject({
  values: z.strictObject(Object.fromEntries(Object.entries(EDITABLE).map(([key, schema]) => [key, schema.optional()]))),
});

router.get('/settings', staffWith('settings.manage'), async (_req, res) => {
  // The application's own notes (when the last backup ran) are not settings a person edits.
  const rows = await query("SELECT s.setting_key, s.value, s.description, s.updated_at, u.name AS user_name FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.setting_key NOT LIKE 'backup.%' ORDER BY s.setting_key");
  res.json({
    settings: rows.map((r) => ({ key: r.setting_key, value: r.value, description: r.description, editable: r.setting_key in EDITABLE, updatedAt: r.updated_at, updatedByName: r.user_name })),
  });
});

router.put('/settings', staffWith('settings.manage'), validateBody(updateSchema), async (req, res) => {
  const wanted = Object.entries(req.body.values).filter(([, value]) => value !== undefined);
  if (wanted.length === 0) throw badRequest('Nothing to change.');

  const changed = await transaction(async (conn) => {
    const [rows] = await conn.query('SELECT setting_key, value FROM settings WHERE setting_key IN (?) FOR UPDATE', [wanted.map(([key]) => key)]);
    const current = new Map(rows.map((r) => [r.setting_key, r.value]));
    const changes = wanted.filter(([key, value]) => current.get(key) !== value);
    for (const [key, value] of changes) {
      // The value column is JSON: a string is stored quoted, a flag as true/false.
      await conn.execute('INSERT INTO settings (setting_key, value, updated_by) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', [key, JSON.stringify(value), req.user.id]);
    }
    if (changes.length > 0) {
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'settings.update',
        entityType: 'settings',
        oldValues: Object.fromEntries(changes.map(([key]) => [key, current.get(key) ?? null])),
        newValues: Object.fromEntries(changes),
        ip: req.ip,
      });
    }
    return changes.map(([key]) => key);
  });
  res.json({ changed });
});

// --- audit log ----------------------------------------------------------------
// Read-only. Nothing in the application updates or deletes these rows.

const auditSchema = z.strictObject({
  // The part before the dot: sale, payment, expense, user, settings …
  area: z.string().trim().regex(/^[a-z_]{1,40}$/).optional(),
  userId: id.optional(),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

router.get('/audit-logs', staffWith('audit.view'), validateQuery(auditSchema), async (req, res) => {
  const { area, userId, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (area) (where.push('a.action LIKE ?'), params.push(`${area.replace(/_/g, '\\_')}.%`));
  if (userId) (where.push('a.actor_user_id = ?'), params.push(userId));
  if (from) (where.push('a.created_at >= ?'), params.push(dayStart(from)));
  if (to) (where.push('a.created_at < ?'), params.push(dayEnd(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totals] = await query(`SELECT COUNT(*) AS total FROM audit_logs a ${whereSql}`, params);
  const rows = await query(
    `SELECT a.id, a.action, a.entity_type, a.entity_id, a.old_values, a.new_values, a.ip, a.created_at, u.name AS user_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_user_id ${whereSql}
      ORDER BY a.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const areas = await query("SELECT DISTINCT SUBSTRING_INDEX(action, '.', 1) AS area FROM audit_logs ORDER BY area");
  res.json({
    items: rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, oldValues: r.old_values, newValues: r.new_values, ip: r.ip, createdAt: r.created_at, userName: r.user_name })),
    areas: areas.map((a) => a.area),
    page,
    pageSize,
    total: Number(totals.total),
  });
});

module.exports = router;

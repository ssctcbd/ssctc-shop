const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { conflict, notFound, badRequest } = require('../../lib/errors');
const { z, id, requiredText, flag } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });

const toApi = (row) => ({
  id: row.id,
  parentId: row.parent_id,
  name: row.name,
  sortOrder: row.sort_order,
  isActive: Boolean(row.is_active),
  productCount: row.product_count === undefined ? undefined : Number(row.product_count),
});

const createSchema = z.strictObject({
  name: requiredText(1, 100),
  parentId: id.nullish().transform((v) => v ?? null),
  sortOrder: z.coerce.number().int().min(0).max(9999).default(0),
});

const updateSchema = z.strictObject({
  name: requiredText(1, 100).optional(),
  parentId: id.nullable().optional(),
  sortOrder: z.coerce.number().int().min(0).max(9999).optional(),
  isActive: flag.optional(),
});

/**
 * Categories are two levels deep (PROJECT_PLAN.md §4.3): a parent must itself
 * be a top-level category.
 */
async function assertValidParent(conn, parentId, selfId = null) {
  if (parentId === null) return;
  if (parentId === selfId) throw fieldError('parentId', 'A category cannot be its own parent.');
  const [rows] = await conn.execute('SELECT parent_id FROM categories WHERE id = ?', [parentId]);
  if (!rows[0]) throw fieldError('parentId', 'Parent category not found.');
  if (rows[0].parent_id !== null) throw fieldError('parentId', 'Choose a top-level category as the parent.');
}

/**
 * Names are unique among siblings. The table's UNIQUE (parent_id, name) cannot
 * enforce this for top-level rows, because MySQL treats NULL parents as distinct.
 */
async function assertUniqueName(conn, name, parentId, selfId = null) {
  const [rows] = await conn.execute('SELECT id FROM categories WHERE name = ? AND parent_id <=> ? AND id <> ? LIMIT 1', [name, parentId, selfId ?? 0]);
  if (rows[0]) throw conflict('Please check the highlighted fields.', { fields: { name: 'A category with this name already exists here.' } });
}

router.get('/categories', staffWith('catalog.view'), async (_req, res) => {
  const rows = await query(
    `SELECT c.*, (SELECT COUNT(*) FROM products p WHERE p.category_id = c.id AND p.status = 'active') AS product_count
       FROM categories c
      ORDER BY c.parent_id IS NOT NULL, c.sort_order, c.name`,
  );
  res.json({ categories: rows.map(toApi) });
});

router.post('/categories', staffWith('catalog.manage'), validateBody(createSchema), async (req, res) => {
  const { name, parentId, sortOrder } = req.body;
  const category = await transaction(async (conn) => {
    await assertValidParent(conn, parentId);
    await assertUniqueName(conn, name, parentId);
    const [result] = await conn.execute('INSERT INTO categories (parent_id, name, sort_order) VALUES (?, ?, ?)', [parentId, name, sortOrder]);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'category.create', entityType: 'category', entityId: result.insertId, newValues: { name, parentId }, ip: req.ip });
    return { id: result.insertId, parentId, name, sortOrder, isActive: true };
  });
  res.status(201).json({ category });
});

router.put('/categories/:id', staffWith('catalog.manage'), idParam, validateBody(updateSchema), async (req, res) => {
  const category = await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM categories WHERE id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('Category not found.');

    const next = {
      name: req.body.name ?? current.name,
      parent_id: req.body.parentId === undefined ? current.parent_id : req.body.parentId,
      sort_order: req.body.sortOrder ?? current.sort_order,
      is_active: req.body.isActive === undefined ? current.is_active : Number(req.body.isActive),
    };

    if (next.parent_id !== current.parent_id) {
      await assertValidParent(conn, next.parent_id, req.id);
      if (next.parent_id !== null) {
        const [children] = await conn.execute('SELECT id FROM categories WHERE parent_id = ? LIMIT 1', [req.id]);
        if (children[0]) throw fieldError('parentId', 'This category has sub-categories, so it must stay top-level.');
      }
    }
    if (next.name !== current.name || next.parent_id !== current.parent_id) await assertUniqueName(conn, next.name, next.parent_id, req.id);

    await conn.execute('UPDATE categories SET name = ?, parent_id = ?, sort_order = ?, is_active = ? WHERE id = ?', [next.name, next.parent_id, next.sort_order, next.is_active, req.id]);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'category.update',
      entityType: 'category',
      entityId: req.id,
      oldValues: { name: current.name, parentId: current.parent_id, isActive: Boolean(current.is_active) },
      newValues: { name: next.name, parentId: next.parent_id, isActive: Boolean(next.is_active) },
      ip: req.ip,
    });
    return toApi({ id: req.id, ...next });
  });
  res.json({ category });
});

module.exports = router;

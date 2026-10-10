const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { applyStockMovement } = require('../../lib/stock');
const { dayStart, dayEnd } = require('../../lib/dates');
const { z, id, money, quantity, optionalText, requiredText, day, paging } = require('../../lib/schemas');

const router = express.Router();

const MOVEMENT_TYPES = ['opening', 'stock_in', 'purchase', 'sale', 'sale_void', 'sale_return', 'adjustment_in', 'adjustment_out'];

const stockInSchema = z.strictObject({
  productId: id,
  quantity,
  // When given, it also becomes the product's latest cost price.
  unitCost: money.nullish().transform((v) => v ?? null),
  note: optionalText(255),
});

const adjustmentSchema = z.strictObject({
  productId: id,
  direction: z.enum(['in', 'out']),
  quantity,
  // Mandatory: an adjustment with no reason cannot be explained later.
  note: requiredText(3, 255),
});

const movementsSchema = z.strictObject({
  productId: id.optional(),
  type: z.enum(MOVEMENT_TYPES).optional(),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

// Stock received outside a purchase bill (found stock, a gift, a correction with a known cost).
router.post('/inventory/stock-in', staffWith('inventory.adjust'), validateBody(stockInSchema), async (req, res) => {
  const { productId, quantity: qty, unitCost, note } = req.body;
  const movement = await transaction(async (conn) => {
    const result = await applyStockMovement(conn, { productId, delta: qty, movementType: 'stock_in', unitCost, referenceType: 'manual', note, userId: req.user.id });
    if (unitCost !== null) await conn.execute('UPDATE products SET cost_price = ? WHERE id = ?', [unitCost, productId]);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'inventory.stock_in', entityType: 'product', entityId: productId, newValues: { quantity: qty, unitCost, note, balanceAfter: result.balanceAfter }, ip: req.ip });
    return result;
  });
  res.status(201).json(movement);
});

router.post('/inventory/adjustments', staffWith('inventory.adjust'), validateBody(adjustmentSchema), async (req, res) => {
  const { productId, direction, quantity: qty, note } = req.body;
  const movement = await transaction(async (conn) => {
    const result = await applyStockMovement(conn, {
      productId,
      delta: direction === 'in' ? qty : -qty,
      movementType: direction === 'in' ? 'adjustment_in' : 'adjustment_out',
      referenceType: 'manual',
      note,
      userId: req.user.id,
    });
    await writeAudit({ conn, actorUserId: req.user.id, action: 'inventory.adjust', entityType: 'product', entityId: productId, newValues: { direction, quantity: qty, note, balanceAfter: result.balanceAfter }, ip: req.ip });
    return result;
  });
  res.status(201).json(movement);
});

router.get('/inventory/movements', staffWith('inventory.view'), validateQuery(movementsSchema), async (req, res) => {
  const { productId, type, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (productId) (where.push('m.product_id = ?'), params.push(productId));
  if (type) (where.push('m.movement_type = ?'), params.push(type));
  if (from) (where.push('m.created_at >= ?'), params.push(dayStart(from)));
  if (to) (where.push('m.created_at < ?'), params.push(dayEnd(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [count] = await query(`SELECT COUNT(*) AS total FROM inventory_movements m ${whereSql}`, params);
  const rows = await query(
    `SELECT m.id, m.product_id, p.sku, p.name AS product_name, m.movement_type, m.quantity, m.balance_after, m.unit_cost,
            m.reference_type, m.reference_id, m.note, m.created_at, u.name AS user_name
       FROM inventory_movements m
       JOIN products p ON p.id = m.product_id
       JOIN users u ON u.id = m.created_by
       ${whereSql}
      ORDER BY m.id DESC
      LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`,
    params,
  );
  const withCost = req.user.permissions.includes('catalog.manage');
  res.json({
    items: rows.map((r) => ({
      id: r.id,
      productId: r.product_id,
      sku: r.sku,
      productName: r.product_name,
      type: r.movement_type,
      quantity: r.quantity,
      balanceAfter: r.balance_after,
      ...(withCost ? { unitCost: r.unit_cost } : {}),
      referenceType: r.reference_type,
      referenceId: r.reference_id,
      note: r.note,
      createdAt: r.created_at,
      userName: r.user_name,
    })),
    page,
    pageSize,
    total: Number(count.total),
  });
});

router.get('/inventory/low-stock', staffWith('inventory.view'), async (_req, res) => {
  const rows = await query(
    `SELECT p.id, p.sku, p.name, p.unit, p.stock_qty, p.low_stock_threshold, c.name AS category_name
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.track_stock = 1 AND p.stock_qty <= p.low_stock_threshold
      ORDER BY p.stock_qty - p.low_stock_threshold, p.name`,
  );
  res.json({
    products: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, unit: r.unit, stockQty: r.stock_qty, lowStockThreshold: r.low_stock_threshold, categoryName: r.category_name })),
  });
});

// The ledger must add up to the balance for every product. A row here is a bug
// to investigate, never a number to overwrite (DATABASE_SCHEMA.md §5.1).
router.get('/inventory/reconcile', staffWith('inventory.adjust'), async (_req, res) => {
  const rows = await query(
    `SELECT p.id, p.sku, p.name, p.stock_qty, COALESCE(SUM(m.quantity), 0) AS ledger_total
       FROM products p LEFT JOIN inventory_movements m ON m.product_id = p.id
      GROUP BY p.id
     HAVING p.stock_qty <> ledger_total
      ORDER BY p.name`,
  );
  const [count] = await query('SELECT COUNT(*) AS n FROM products');
  res.json({
    productsChecked: Number(count.n),
    differences: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, stockQty: r.stock_qty, ledgerTotal: Number(r.ledger_total) })),
  });
});

module.exports = router;

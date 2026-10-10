const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { applyStockMovement } = require('../../lib/stock');
const { conflict, notFound, forbidden, badRequest } = require('../../lib/errors');
const { z, id, money, optionalText, optionalTextUpdate, requiredText, flag, queryFlag, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const sku = z.string().trim().toUpperCase().min(1).max(50).regex(/^[A-Z0-9][A-Z0-9._/-]*$/, 'Use letters, numbers, dot, dash, slash or underscore.');
const unit = z.string().trim().min(1).max(20);
const threshold = z.coerce.number().int().min(0).max(1_000_000);

const createSchema = z.strictObject({
  categoryId: id,
  sku: sku.nullish().transform((v) => v || null), // generated when left empty
  name: requiredText(1, 200),
  brand: optionalText(100),
  unit: unit.default('pcs'),
  price: money,
  costPrice: money.default('0.00'),
  trackStock: flag.default(true),
  lowStockThreshold: threshold.default(5),
  note: optionalText(255),
  // Stock already on the shelf when the product is first entered.
  openingStock: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const updateSchema = z.strictObject({
  categoryId: id.optional(),
  sku: sku.optional(),
  name: requiredText(1, 200).optional(),
  brand: optionalTextUpdate(100),
  unit: unit.optional(),
  price: money.optional(),
  costPrice: money.optional(),
  trackStock: flag.optional(),
  lowStockThreshold: threshold.optional(),
  status: z.enum(['active', 'archived']).optional(),
  note: optionalTextUpdate(255),
});

const listSchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  categoryId: id.optional(),
  status: z.enum(['active', 'archived', 'all']).default('active'),
  lowStock: queryFlag.optional(),
  ...paging,
});

// Cost prices show the shop's margin; only users who manage the catalog see them.
const canSeeCost = (user) => user.permissions.includes('catalog.manage');

const toApi = (row, withCost) => ({
  id: row.id,
  categoryId: row.category_id,
  categoryName: row.category_name,
  sku: row.sku,
  name: row.name,
  brand: row.brand,
  unit: row.unit,
  price: row.price,
  ...(withCost ? { costPrice: row.cost_price } : {}),
  trackStock: Boolean(row.track_stock),
  stockQty: row.stock_qty,
  lowStockThreshold: row.low_stock_threshold,
  isLowStock: Boolean(row.track_stock) && row.status === 'active' && row.stock_qty <= row.low_stock_threshold,
  status: row.status,
  note: row.note,
});

const SELECT = `SELECT p.*, c.name AS category_name FROM products p JOIN categories c ON c.id = p.category_id`;
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

async function assertCategory(conn, categoryId) {
  const [rows] = await conn.execute('SELECT is_active FROM categories WHERE id = ?', [categoryId]);
  if (!rows[0]) throw fieldError('categoryId', 'Category not found.');
  if (!rows[0].is_active) throw fieldError('categoryId', 'This category is inactive.');
}

const duplicateSku = () => conflict('Please check the highlighted fields.', { fields: { sku: 'Another product already uses this code.' } });

router.get('/products', staffWith('catalog.view'), validateQuery(listSchema), async (req, res) => {
  const { search, categoryId, status, lowStock, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (status !== 'all') (where.push('p.status = ?'), params.push(status));
  if (categoryId) (where.push('(p.category_id = ? OR c.parent_id = ?)'), params.push(categoryId, categoryId));
  if (search) {
    where.push('(p.name LIKE ? OR p.sku LIKE ? OR p.brand LIKE ?)');
    params.push(likePattern(search), likePattern(search), likePattern(search));
  }
  if (lowStock) where.push("p.track_stock = 1 AND p.status = 'active' AND p.stock_qty <= p.low_stock_threshold");
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [count] = await query(`SELECT COUNT(*) AS total FROM products p JOIN categories c ON c.id = p.category_id ${whereSql}`, params);
  // page and pageSize are validated integers, so they are safe to place in the SQL text.
  const rows = await query(`${SELECT} ${whereSql} ORDER BY p.name, p.id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map((r) => toApi(r, canSeeCost(req.user))), page, pageSize, total: Number(count.total) });
});

// Compact list of active products for pickers (purchase lines, stock forms).
router.get('/products/options', staffWith('catalog.view'), async (req, res) => {
  const rows = await query("SELECT id, sku, name, unit, price, cost_price, track_stock, stock_qty FROM products WHERE status = 'active' ORDER BY name, id");
  const withCost = canSeeCost(req.user);
  res.json({
    products: rows.map((r) => ({ id: r.id, sku: r.sku, name: r.name, unit: r.unit, price: r.price, ...(withCost ? { costPrice: r.cost_price } : {}), trackStock: Boolean(r.track_stock), stockQty: r.stock_qty })),
  });
});

router.get('/products/:id', staffWith('catalog.view'), idParam, async (req, res) => {
  const rows = await query(`${SELECT} WHERE p.id = ?`, [req.id]);
  if (!rows[0]) throw notFound('Product not found.');
  res.json({ product: toApi(rows[0], canSeeCost(req.user)) });
});

router.post('/products', staffWith('catalog.manage'), validateBody(createSchema), async (req, res) => {
  const b = req.body;
  if (b.openingStock > 0 && !b.trackStock) throw fieldError('openingStock', 'Turn on stock tracking to enter opening stock.');

  const productId = await transaction(async (conn) => {
    await assertCategory(conn, b.categoryId);
    let result;
    try {
      // A placeholder code keeps the UNIQUE index satisfied until the generated one is set below.
      [result] = await conn.execute(
        `INSERT INTO products (category_id, sku, name, brand, unit, price, cost_price, track_stock, low_stock_threshold, note)
         VALUES (?, COALESCE(?, CONCAT('TMP-', UUID_SHORT())), ?, ?, ?, ?, ?, ?, ?, ?)`,
        [b.categoryId, b.sku, b.name, b.brand, b.unit, b.price, b.costPrice, Number(b.trackStock), b.lowStockThreshold, b.note],
      );
      if (!b.sku) await conn.execute('UPDATE products SET sku = ? WHERE id = ?', [`P-${String(result.insertId).padStart(5, '0')}`, result.insertId]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicateSku();
      throw err;
    }

    if (b.openingStock > 0) {
      await applyStockMovement(conn, {
        productId: result.insertId,
        delta: b.openingStock,
        movementType: 'opening',
        unitCost: b.costPrice,
        referenceType: 'manual',
        note: 'Opening stock',
        userId: req.user.id,
      });
    }
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'product.create',
      entityType: 'product',
      entityId: result.insertId,
      newValues: { name: b.name, price: b.price, costPrice: b.costPrice, openingStock: b.openingStock },
      ip: req.ip,
    });
    return result.insertId;
  });

  const rows = await query(`${SELECT} WHERE p.id = ?`, [productId]);
  res.status(201).json({ product: toApi(rows[0], true) });
});

// Stock is never edited here: it changes only through inventory movements.
router.put('/products/:id', staffWith('catalog.manage'), idParam, validateBody(updateSchema), async (req, res) => {
  const b = req.body;
  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM products WHERE id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('Product not found.');

    const columns = {
      category_id: b.categoryId,
      sku: b.sku,
      name: b.name,
      brand: b.brand,
      unit: b.unit,
      price: b.price,
      cost_price: b.costPrice,
      track_stock: b.trackStock === undefined ? undefined : Number(b.trackStock),
      low_stock_threshold: b.lowStockThreshold,
      status: b.status,
      note: b.note,
    };
    const changed = Object.entries(columns).filter(([column, value]) => value !== undefined && String(value) !== String(current[column]));
    if (changed.length === 0) return;
    const changes = Object.fromEntries(changed);

    if (('price' in changes || 'cost_price' in changes) && !req.user.permissions.includes('catalog.edit_price')) {
      throw forbidden('You do not have permission to change prices.');
    }
    if ('category_id' in changes) await assertCategory(conn, changes.category_id);
    if (changes.track_stock === 0 && current.stock_qty > 0) {
      throw fieldError('trackStock', `This product still has ${current.stock_qty} in stock. Adjust the stock to zero before turning tracking off.`);
    }

    try {
      await conn.execute(`UPDATE products SET ${changed.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`, [...changed.map(([, value]) => value), req.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicateSku();
      throw err;
    }
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'price' in changes || 'cost_price' in changes ? 'product.price_change' : 'product.update',
      entityType: 'product',
      entityId: req.id,
      oldValues: Object.fromEntries(changed.map(([column]) => [column, current[column]])),
      newValues: changes,
      ip: req.ip,
    });
  });

  const rows = await query(`${SELECT} WHERE p.id = ?`, [req.id]);
  res.json({ product: toApi(rows[0], true) });
});

module.exports = router;

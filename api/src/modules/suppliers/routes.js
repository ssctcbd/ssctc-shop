const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { applyStockMovement } = require('../../lib/stock');
const { nextDocumentNumber } = require('../../lib/documents');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { dayStart, dayEnd, documentDate } = require('../../lib/dates');
const { notFound, badRequest, conflict } = require('../../lib/errors');
const { z, id, money, positiveMoney, quantity, optionalText, optionalTextUpdate, requiredText, flag, day, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const OPENING_MEMO = 'OPENING BALANCE';

// --- suppliers --------------------------------------------------------------

const supplierCreateSchema = z.strictObject({
  name: requiredText(2, 120),
  company: optionalText(150),
  phone: optionalText(15),
  address: optionalText(255),
  note: optionalText(255),
});

const supplierUpdateSchema = z.strictObject({
  name: requiredText(2, 120).optional(),
  company: optionalTextUpdate(150),
  phone: optionalTextUpdate(15),
  address: optionalTextUpdate(255),
  note: optionalTextUpdate(255),
  isActive: flag.optional(),
});

const openingPayableSchema = z.strictObject({
  amount: positiveMoney,
  date: day.optional(),
  note: optionalText(500),
});

const supplierToApi = (row) => ({
  id: row.id,
  name: row.name,
  company: row.company,
  phone: row.phone,
  address: row.address,
  note: row.note,
  currentPayable: row.current_payable,
  isActive: Boolean(row.is_active),
});

/**
 * suppliers.current_payable is derived, never typed in: the sum of what is
 * still owed on that supplier's purchases (DATABASE_SCHEMA.md §5.4). Called
 * inside every transaction that changes a purchase.
 */
async function recalculatePayable(conn, supplierId) {
  await conn.execute('UPDATE suppliers SET current_payable = (SELECT COALESCE(SUM(due_amount), 0) FROM purchases WHERE supplier_id = ?) WHERE id = ?', [supplierId, supplierId]);
}

/** Lock the supplier row first; every purchase transaction starts here, so they queue instead of deadlocking. */
async function lockSupplier(conn, supplierId, field = 'supplierId') {
  const [rows] = await conn.execute('SELECT id, is_active FROM suppliers WHERE id = ? FOR UPDATE', [supplierId]);
  if (!rows[0]) throw field ? fieldError(field, 'Supplier not found.') : notFound('Supplier not found.');
  return rows[0];
}

router.get('/suppliers', staffWith('suppliers.view'), async (_req, res) => {
  const rows = await query('SELECT * FROM suppliers ORDER BY is_active DESC, name');
  res.json({ suppliers: rows.map(supplierToApi) });
});

router.get('/suppliers/:id', staffWith('suppliers.view'), idParam, async (req, res) => {
  const rows = await query('SELECT * FROM suppliers WHERE id = ?', [req.id]);
  if (!rows[0]) throw notFound('Supplier not found.');
  res.json({ supplier: supplierToApi(rows[0]) });
});

router.post('/suppliers', staffWith('suppliers.manage'), validateBody(supplierCreateSchema), async (req, res) => {
  const b = req.body;
  const supplierId = await transaction(async (conn) => {
    const [result] = await conn.execute('INSERT INTO suppliers (name, company, phone, address, note, created_by) VALUES (?, ?, ?, ?, ?, ?)', [b.name, b.company, b.phone, b.address, b.note, req.user.id]);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'supplier.create', entityType: 'supplier', entityId: result.insertId, newValues: { name: b.name, company: b.company }, ip: req.ip });
    return result.insertId;
  });
  const rows = await query('SELECT * FROM suppliers WHERE id = ?', [supplierId]);
  res.status(201).json({ supplier: supplierToApi(rows[0]) });
});

router.put('/suppliers/:id', staffWith('suppliers.manage'), idParam, validateBody(supplierUpdateSchema), async (req, res) => {
  const b = req.body;
  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM suppliers WHERE id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('Supplier not found.');
    const columns = { name: b.name, company: b.company, phone: b.phone, address: b.address, note: b.note, is_active: b.isActive === undefined ? undefined : Number(b.isActive) };
    const changed = Object.entries(columns).filter(([column, value]) => value !== undefined && String(value) !== String(current[column]));
    if (changed.length === 0) return;
    await conn.execute(`UPDATE suppliers SET ${changed.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`, [...changed.map(([, value]) => value), req.id]);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'supplier.update',
      entityType: 'supplier',
      entityId: req.id,
      oldValues: Object.fromEntries(changed.map(([column]) => [column, current[column]])),
      newValues: Object.fromEntries(changed),
      ip: req.ip,
    });
  });
  const rows = await query('SELECT * FROM suppliers WHERE id = ?', [req.id]);
  res.json({ supplier: supplierToApi(rows[0]) });
});

// What the shop already owed this supplier before the system started. Recorded
// as a purchase with no lines, so it is paid off exactly like any other bill.
router.post('/suppliers/:id/opening-payable', staffWith('suppliers.manage'), idParam, validateBody(openingPayableSchema), async (req, res) => {
  const { amount, date, note } = req.body;
  const purchase = await transaction(async (conn) => {
    await lockSupplier(conn, req.id, null);
    const [existing] = await conn.execute('SELECT id FROM purchases WHERE supplier_id = ? AND supplier_memo_no = ? LIMIT 1', [req.id, OPENING_MEMO]);
    if (existing[0]) throw conflict('An opening payable has already been recorded for this supplier.');

    const purchaseNo = await nextDocumentNumber(conn, 'purchase');
    const [result] = await conn.execute(
      `INSERT INTO purchases (purchase_no, supplier_id, purchase_date, supplier_memo_no, total_amount, paid_amount, due_amount, payment_status, note, created_by)
       VALUES (?, ?, ?, ?, ?, 0, ?, 'unpaid', ?, ?)`,
      [purchaseNo, req.id, documentDate(date), OPENING_MEMO, amount, amount, note, req.user.id],
    );
    await recalculatePayable(conn, req.id);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'supplier.opening_payable', entityType: 'supplier', entityId: req.id, newValues: { purchaseNo, amount }, ip: req.ip });
    return { id: result.insertId, purchaseNo };
  });
  res.status(201).json({ purchase });
});

// --- purchases --------------------------------------------------------------

const purchaseSchema = z.strictObject({
  supplierId: id,
  date: day.optional(),
  supplierMemoNo: optionalText(60),
  note: optionalText(500),
  items: z
    .array(z.strictObject({ productId: id, quantity, unitCost: money }))
    .min(1, 'Add at least one product.')
    .max(200),
  // Money handed to the supplier with this bill. Later payments are a separate entry.
  paidAmount: money.default('0.00'),
  paymentMethod: z.enum(['cash', 'bkash', 'nagad', 'bank_transfer', 'other']).default('cash'),
  paymentReference: optionalText(60),
});

const purchaseListSchema = z.strictObject({
  supplierId: id.optional(),
  status: z.enum(['unpaid', 'partial', 'paid']).optional(),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

const purchaseToApi = (row) => ({
  id: row.id,
  purchaseNo: row.purchase_no,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  purchaseDate: row.purchase_date,
  supplierMemoNo: row.supplier_memo_no,
  isOpeningBalance: row.supplier_memo_no === OPENING_MEMO && Number(row.item_count ?? 0) === 0,
  totalAmount: row.total_amount,
  paidAmount: row.paid_amount,
  dueAmount: row.due_amount,
  paymentStatus: row.payment_status,
  note: row.note,
  createdByName: row.user_name,
});

const PURCHASE_SELECT = `SELECT pu.*, s.name AS supplier_name, u.name AS user_name,
         (SELECT COUNT(*) FROM purchase_items pi WHERE pi.purchase_id = pu.id) AS item_count
    FROM purchases pu
    JOIN suppliers s ON s.id = pu.supplier_id
    JOIN users u ON u.id = pu.created_by`;

router.get('/purchases', staffWith('suppliers.view'), validateQuery(purchaseListSchema), async (req, res) => {
  const { supplierId, status, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (supplierId) (where.push('pu.supplier_id = ?'), params.push(supplierId));
  if (status) (where.push('pu.payment_status = ?'), params.push(status));
  if (from) (where.push('pu.purchase_date >= ?'), params.push(dayStart(from)));
  if (to) (where.push('pu.purchase_date < ?'), params.push(dayEnd(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const [totals] = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(pu.total_amount), 0) AS amount, COALESCE(SUM(pu.due_amount), 0) AS due FROM purchases pu ${whereSql}`, params);
  const rows = await query(`${PURCHASE_SELECT} ${whereSql} ORDER BY pu.purchase_date DESC, pu.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(purchaseToApi), page, pageSize, total: Number(totals.total), totalAmount: totals.amount, totalDue: totals.due });
});

router.get('/purchases/:id', staffWith('suppliers.view'), idParam, async (req, res) => {
  const rows = await query(`${PURCHASE_SELECT} WHERE pu.id = ?`, [req.id]);
  if (!rows[0]) throw notFound('Purchase not found.');
  const items = await query(
    `SELECT pi.id, pi.product_id, p.sku, p.name, p.unit, pi.quantity, pi.unit_cost, pi.line_total
       FROM purchase_items pi JOIN products p ON p.id = pi.product_id
      WHERE pi.purchase_id = ? ORDER BY pi.id`,
    [req.id],
  );
  const payments = await query('SELECT voucher_no, payment_date, amount, method, reference FROM supplier_payments WHERE purchase_id = ? ORDER BY id', [req.id]);
  res.json({
    purchase: {
      ...purchaseToApi(rows[0]),
      items: items.map((i) => ({ id: i.id, productId: i.product_id, sku: i.sku, name: i.name, unit: i.unit, quantity: i.quantity, unitCost: i.unit_cost, lineTotal: i.line_total })),
      payments: payments.map((p) => ({ voucherNo: p.voucher_no, paymentDate: p.payment_date, amount: p.amount, method: p.method, reference: p.reference })),
    },
  });
});

/**
 * Record a purchase bill. One transaction (DATABASE_SCHEMA.md §5.4):
 * lock supplier → take purchase number → insert bill and lines → add stock with
 * a ledger row per product and update its latest cost → record money paid with
 * the bill → recalculate the supplier's payable → audit.
 */
router.post('/purchases', staffWith('purchases.manage'), validateBody(purchaseSchema), async (req, res) => {
  const b = req.body;

  const seen = new Set();
  for (const [index, item] of b.items.entries()) {
    if (seen.has(item.productId)) throw fieldError(`items.${index}.productId`, 'This product is listed twice. Put it on one line.');
    seen.add(item.productId);
  }
  const lines = b.items.map((item) => ({ ...item, lineTotalPaisa: toPaisa(item.unitCost) * item.quantity }));
  const totalPaisa = lines.reduce((sum, line) => sum + line.lineTotalPaisa, 0);
  if (totalPaisa > 999_999_999_999) throw badRequest('The bill total is too large.');
  const paidPaisa = toPaisa(b.paidAmount);
  if (paidPaisa > totalPaisa) throw fieldError('paidAmount', `The amount paid cannot be more than the bill total (${fromPaisa(totalPaisa)}).`);

  const purchase = await transaction(async (conn) => {
    const supplier = await lockSupplier(conn, b.supplierId);
    if (!supplier.is_active) throw fieldError('supplierId', 'This supplier is inactive.');

    // Every line must be an active product whose stock is tracked.
    const ids = lines.map((line) => line.productId);
    const [products] = await conn.query('SELECT id, name, status, track_stock FROM products WHERE id IN (?)', [ids]);
    const byId = new Map(products.map((p) => [p.id, p]));
    for (const [index, item] of b.items.entries()) {
      const product = byId.get(item.productId);
      if (!product) throw fieldError(`items.${index}.productId`, 'Product not found.');
      if (product.status !== 'active') throw fieldError(`items.${index}.productId`, `"${product.name}" is archived.`);
      if (!product.track_stock) throw fieldError(`items.${index}.productId`, `Stock is not tracked for "${product.name}".`);
    }

    const purchaseNo = await nextDocumentNumber(conn, 'purchase');
    const when = documentDate(b.date);
    const duePaisa = totalPaisa - paidPaisa;
    const status = duePaisa === 0 ? 'paid' : paidPaisa > 0 ? 'partial' : 'unpaid';

    const [result] = await conn.execute(
      `INSERT INTO purchases (purchase_no, supplier_id, purchase_date, supplier_memo_no, total_amount, paid_amount, due_amount, payment_status, note, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [purchaseNo, b.supplierId, when, b.supplierMemoNo, fromPaisa(totalPaisa), fromPaisa(paidPaisa), fromPaisa(duePaisa), status, b.note, req.user.id],
    );
    const purchaseId = result.insertId;

    // Ascending product id: two bills saved at once take their row locks in the same order.
    for (const line of [...lines].sort((a, z) => a.productId - z.productId)) {
      await conn.execute('INSERT INTO purchase_items (purchase_id, product_id, quantity, unit_cost, line_total) VALUES (?, ?, ?, ?, ?)', [purchaseId, line.productId, line.quantity, line.unitCost, fromPaisa(line.lineTotalPaisa)]);
      await applyStockMovement(conn, { productId: line.productId, delta: line.quantity, movementType: 'purchase', unitCost: line.unitCost, referenceType: 'purchase', referenceId: purchaseId, note: purchaseNo, userId: req.user.id });
      await conn.execute('UPDATE products SET cost_price = ? WHERE id = ?', [line.unitCost, line.productId]);
    }

    if (paidPaisa > 0) {
      const voucherNo = await nextDocumentNumber(conn, 'supplier_payment');
      await conn.execute('INSERT INTO supplier_payments (voucher_no, supplier_id, purchase_id, payment_date, amount, method, reference, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        voucherNo,
        b.supplierId,
        purchaseId,
        when,
        fromPaisa(paidPaisa),
        b.paymentMethod,
        b.paymentReference,
        req.user.id,
      ]);
    }

    await recalculatePayable(conn, b.supplierId);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'purchase.create',
      entityType: 'purchase',
      entityId: purchaseId,
      newValues: { purchaseNo, supplierId: b.supplierId, total: fromPaisa(totalPaisa), paid: fromPaisa(paidPaisa), lines: lines.length },
      ip: req.ip,
    });
    return { id: purchaseId, purchaseNo, totalAmount: fromPaisa(totalPaisa), paidAmount: fromPaisa(paidPaisa), dueAmount: fromPaisa(duePaisa), paymentStatus: status };
  });

  res.status(201).json({ purchase });
});

module.exports = router;

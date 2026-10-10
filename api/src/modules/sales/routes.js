const express = require('express');
const crypto = require('node:crypto');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { applyStockMovement } = require('../../lib/stock');
const { nextDocumentNumber } = require('../../lib/documents');
const { recalculateSale, recalculateCustomer } = require('../../lib/ledger');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { dayStart, dayEnd, documentDate, today } = require('../../lib/dates');
const { conflict, notFound, forbidden, badRequest } = require('../../lib/errors');
const { z, id, money, positiveMoney, quantity, optionalText, requiredText, flag, day, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const METHODS = ['cash', 'bkash', 'nagad', 'bank_transfer', 'other'];

const itemSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('product'),
    productId: id,
    quantity,
    unitPrice: money.optional(), // omitted = the product's listed price
    warranty: optionalText(50),
    serialNo: optionalText(100),
  }),
  z.strictObject({
    type: z.literal('service'),
    serviceId: id,
    quantity,
    unitPrice: money.optional(), // omitted = the service's listed rate
  }),
]);

const paymentSchema = z.strictObject({
  method: z.enum(METHODS),
  amount: positiveMoney,
  reference: optionalText(60).transform((v) => (v ? v.toUpperCase() : null)),
  // Cash is always verified. For other methods this is honoured only from a
  // user allowed to verify payments; typing a transaction ID never verifies.
  verified: flag.default(false),
});

const saleSchema = z.strictObject({
  // UUID made once by the POS screen: a repeated save returns the first sale.
  idempotencyKey: z.string().uuid('Not a valid key.'),
  customerId: id.nullish().transform((v) => v ?? null),
  walkInName: optionalText(120),
  walkInPhone: optionalText(15),
  date: day.optional(),
  note: optionalText(500),
  discountAmount: money.default('0.00'),
  items: z.array(itemSchema).min(1, 'Add at least one item.').max(200),
  payments: z.array(paymentSchema).max(5).default([]),
});

const listSchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  customerId: id.optional(),
  status: z.enum(['completed', 'void', 'all']).default('all'),
  paymentStatus: z.enum(['unpaid', 'partial', 'paid']).optional(),
  method: z.enum(METHODS).optional(),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

const voidSchema = z.strictObject({
  reason: requiredText(3, 255),
  // Must be true to void a sale that has payments: they are voided with it,
  // in the same step, and the money goes back to the customer.
  voidPayments: flag.default(false),
});

const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
const can = (req, permission) => req.user.permissions.includes(permission);

const summary = (row) => ({
  id: row.id,
  invoiceNo: row.invoice_no,
  saleType: row.sale_type,
  customerId: row.customer_id,
  customerName: row.customer_name,
  customerPhone: row.customer_phone,
  saleDate: row.sale_date,
  status: row.status,
  subtotal: row.subtotal,
  discountAmount: row.discount_amount,
  totalAmount: row.total_amount,
  paidAmount: row.paid_amount,
  unverifiedAmount: row.unverified_amount,
  dueAmount: row.due_amount,
  paymentStatus: row.payment_status,
  note: row.note,
  voidReason: row.void_reason,
  voidedAt: row.voided_at,
  voidedByName: row.voided_by_name ?? null,
  createdByName: row.user_name,
});

const SALE_SELECT = `SELECT s.*, u.name AS user_name, vu.name AS voided_by_name
    FROM sales s JOIN users u ON u.id = s.created_by LEFT JOIN users vu ON vu.id = s.voided_by`;

async function savedSale(idempotencyKey) {
  const rows = await query('SELECT id, invoice_no, total_amount, paid_amount, due_amount, payment_status FROM sales WHERE idempotency_key = ?', [idempotencyKey]);
  const r = rows[0];
  return r ? { id: r.id, invoiceNo: r.invoice_no, totalAmount: r.total_amount, paidAmount: r.paid_amount, dueAmount: r.due_amount, paymentStatus: r.payment_status } : null;
}

router.get('/sales', staffWith('sales.view'), validateQuery(listSchema), async (req, res) => {
  const { search, customerId, status, paymentStatus, method, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (status !== 'all') (where.push('s.status = ?'), params.push(status));
  if (customerId) (where.push('s.customer_id = ?'), params.push(customerId));
  if (paymentStatus) (where.push("s.payment_status = ? AND s.status = 'completed'"), params.push(paymentStatus));
  if (from) (where.push('s.sale_date >= ?'), params.push(dayStart(from)));
  if (to) (where.push('s.sale_date < ?'), params.push(dayEnd(to)));
  if (search) {
    where.push('(s.invoice_no LIKE ? OR s.customer_name LIKE ? OR s.customer_phone LIKE ?)');
    params.push(likePattern(search), likePattern(search), likePattern(search));
  }
  if (method) {
    where.push("EXISTS (SELECT 1 FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE a.sale_id = s.id AND p.status = 'active' AND p.method = ?)");
    params.push(method);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Voided sales are listed but never counted in the money totals.
  const [totals] = await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(IF(s.status = 'completed', s.total_amount, 0)), 0) AS amount,
            COALESCE(SUM(IF(s.status = 'completed', s.paid_amount, 0)), 0) AS paid,
            COALESCE(SUM(IF(s.status = 'completed', s.due_amount, 0)), 0) AS due
       FROM sales s ${whereSql}`,
    params,
  );
  const rows = await query(`${SALE_SELECT} ${whereSql} ORDER BY s.sale_date DESC, s.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(summary), page, pageSize, total: Number(totals.total), totalAmount: totals.amount, totalPaid: totals.paid, totalDue: totals.due });
});

router.get('/sales/:id', staffWith('sales.view'), idParam, async (req, res) => {
  const rows = await query(`${SALE_SELECT} WHERE s.id = ?`, [req.id]);
  if (!rows[0]) throw notFound('Sale not found.');
  const items = await query('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', [req.id]);
  const payments = await query(
    `SELECT p.id, p.receipt_no, p.payment_date, p.method, p.amount AS payment_amount, a.amount, p.reference, p.is_verified, p.status, p.void_reason, u.name AS user_name
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN users u ON u.id = p.created_by
      WHERE a.sale_id = ? ORDER BY p.id`,
    [req.id],
  );
  // Cost shows the shop's margin: only for users who see financial reports.
  const withCost = can(req, 'reports.financial');
  res.json({
    sale: {
      ...summary(rows[0]),
      items: items.map((i) => ({
        id: i.id,
        type: i.item_type,
        productId: i.product_id,
        serviceId: i.service_id,
        name: i.name_snapshot,
        sku: i.sku_snapshot,
        unit: i.unit_snapshot,
        unitPrice: i.unit_price,
        quantity: i.quantity,
        warranty: i.warranty,
        serialNo: i.serial_no,
        lineTotal: i.line_total,
        ...(withCost ? { costPrice: i.cost_price_snapshot } : {}),
      })),
      payments: payments.map((p) => ({
        id: p.id,
        receiptNo: p.receipt_no,
        paymentDate: p.payment_date,
        method: p.method,
        amount: p.amount, // the part of the payment applied to this sale
        paymentAmount: p.payment_amount,
        reference: p.reference,
        isVerified: Boolean(p.is_verified),
        status: p.status,
        voidReason: p.void_reason,
        recordedByName: p.user_name,
      })),
    },
  });
});

/**
 * Complete a sale (DATABASE_SCHEMA.md §5.1–5.3). One transaction:
 * lock customer → price every line from the current catalog → take invoice
 * number → insert sale and lines (names, prices and cost copied in) → reduce
 * stock with a ledger row per product line → record payments and their
 * allocation → recalculate the sale and the customer's balance → audit.
 * The browser sends what was sold and what was paid; every amount is computed here.
 */
router.post('/sales', staffWith('sales.create'), validateBody(saleSchema), async (req, res) => {
  const b = req.body;

  const existing = await savedSale(b.idempotencyKey);
  if (existing) return res.status(200).json({ sale: existing, duplicate: true });

  if (b.date && b.date !== today() && !can(req, 'sales.backdate')) throw forbidden('You do not have permission to change the sale date.');
  if (b.date && b.date > today()) throw fieldError('date', 'The sale date cannot be in the future.');

  let sale;
  try {
    sale = await transaction(createSale);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      const message = String(err.message);
      if (message.includes('uq_sales_idempotency')) {
        // The same save arrived twice at once; the unique key let one through.
        const stored = await savedSale(b.idempotencyKey);
        if (stored) return res.status(200).json({ sale: stored, duplicate: true });
      }
      if (message.includes('uq_payments_active_ref')) throw conflict('This bKash/Nagad transaction ID has already been recorded on another payment.', { fields: { 'payments.reference': 'Already recorded.' } });
    }
    throw err;
  }
  res.status(201).json({ sale });

  async function createSale(conn) {
    // --- customer -----------------------------------------------------------
    let customer = null;
    if (b.customerId) {
      const [rows] = await conn.execute('SELECT id, name, phone, is_active FROM customers WHERE id = ? FOR UPDATE', [b.customerId]);
      customer = rows[0];
      if (!customer) throw fieldError('customerId', 'Customer not found.');
      if (!customer.is_active) throw fieldError('customerId', 'This customer is inactive.');
    }

    // --- price the lines from the catalog -----------------------------------
    const productIds = [...new Set(b.items.filter((i) => i.type === 'product').map((i) => i.productId))];
    const serviceIds = [...new Set(b.items.filter((i) => i.type === 'service').map((i) => i.serviceId))];
    const [products] = productIds.length ? await conn.query('SELECT id, sku, name, unit, price, cost_price, track_stock, status FROM products WHERE id IN (?)', [productIds]) : [[]];
    const [services] = serviceIds.length ? await conn.query('SELECT id, name, unit, default_price, price_editable, is_active FROM services WHERE id IN (?)', [serviceIds]) : [[]];
    const productById = new Map(products.map((p) => [p.id, p]));
    const serviceById = new Map(services.map((s) => [s.id, s]));
    const mayEditPrice = can(req, 'sales.edit_price');
    const priceChanges = [];

    const lines = b.items.map((item, index) => {
      const at = (field) => `items.${index}.${field}`;
      let line;
      if (item.type === 'product') {
        const p = productById.get(item.productId);
        if (!p) throw fieldError(at('productId'), 'Product not found.');
        if (p.status !== 'active') throw fieldError(at('productId'), `"${p.name}" is archived.`);
        const unitPrice = item.unitPrice ?? p.price;
        if (toPaisa(unitPrice) !== toPaisa(p.price)) {
          if (!mayEditPrice) throw fieldError(at('unitPrice'), `You do not have permission to change the price of "${p.name}" (${p.price}).`);
          priceChanges.push({ name: p.name, listed: p.price, charged: unitPrice });
        }
        line = { itemType: 'product', productId: p.id, serviceId: null, name: p.name, sku: p.sku, unit: p.unit, unitPrice, cost: p.cost_price, trackStock: Boolean(p.track_stock), warranty: item.warranty, serialNo: item.serialNo };
      } else {
        const s = serviceById.get(item.serviceId);
        if (!s) throw fieldError(at('serviceId'), 'Service not found.');
        if (!s.is_active) throw fieldError(at('serviceId'), `"${s.name}" is inactive.`);
        const unitPrice = item.unitPrice ?? s.default_price;
        if (toPaisa(unitPrice) !== toPaisa(s.default_price)) {
          // A service marked "price can be changed at the counter" may be re-priced by any seller.
          if (!s.price_editable && !mayEditPrice) throw fieldError(at('unitPrice'), `"${s.name}" has a fixed rate (${s.default_price}).`);
          priceChanges.push({ name: s.name, listed: s.default_price, charged: unitPrice });
        }
        line = { itemType: 'service', productId: null, serviceId: s.id, name: s.name, sku: null, unit: s.unit, unitPrice, cost: null, trackStock: false, warranty: null, serialNo: null };
      }
      return { ...line, quantity: item.quantity, totalPaisa: toPaisa(line.unitPrice) * item.quantity };
    });

    // --- totals -------------------------------------------------------------
    const subtotal = lines.reduce((sum, l) => sum + l.totalPaisa, 0);
    const discount = toPaisa(b.discountAmount);
    if (discount > subtotal) throw fieldError('discountAmount', `The discount cannot be more than the subtotal (${fromPaisa(subtotal)}).`);
    const total = subtotal - discount;
    if (total > 999_999_999_999) throw badRequest('The sale total is too large.');

    const mayVerify = can(req, 'payments.verify');
    const payments = b.payments.map((p) => ({ ...p, paisa: toPaisa(p.amount), isVerified: p.method === 'cash' || (p.verified && mayVerify) }));
    const tendered = payments.reduce((sum, p) => sum + p.paisa, 0);
    if (tendered > total) throw fieldError('payments', `The payments (${fromPaisa(tendered)}) are more than the sale total (${fromPaisa(total)}). Customer advances are not supported yet.`);
    const paid = payments.filter((p) => p.isVerified).reduce((sum, p) => sum + p.paisa, 0);
    const due = total - paid;

    // Decisions D2 and D3: only verified money counts as paid, and a due needs a saved customer.
    if (due > 0 && !customer) {
      throw fieldError(
        'customerId',
        tendered === total
          ? 'A walk-in sale must be fully paid with verified money. Verify the payment now, or choose a saved customer.'
          : `This sale leaves a due of ${fromPaisa(due)}. Choose a saved customer, or take full payment.`,
      );
    }

    // --- sale ---------------------------------------------------------------
    const invoiceNo = await nextDocumentNumber(conn, 'invoice');
    const when = documentDate(b.date);
    const [result] = await conn.execute(
      `INSERT INTO sales (invoice_no, customer_id, customer_name, customer_phone, qr_token, sale_date, subtotal, discount_amount, total_amount,
                          paid_amount, unverified_amount, due_amount, payment_status, note, idempotency_key, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        invoiceNo,
        customer ? customer.id : null,
        customer ? customer.name : b.walkInName,
        customer ? customer.phone : b.walkInPhone,
        crypto.randomBytes(16).toString('hex'),
        when,
        fromPaisa(subtotal),
        fromPaisa(discount),
        fromPaisa(total),
        fromPaisa(paid),
        fromPaisa(tendered - paid),
        fromPaisa(due),
        due === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
        b.note,
        b.idempotencyKey,
        req.user.id,
      ],
    );
    const saleId = result.insertId;

    for (const l of lines) {
      await conn.execute(
        `INSERT INTO sale_items (sale_id, item_type, product_id, service_id, name_snapshot, sku_snapshot, unit_snapshot, unit_price, cost_price_snapshot, quantity, warranty, serial_no, line_total)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [saleId, l.itemType, l.productId, l.serviceId, l.name, l.sku, l.unit, l.unitPrice, l.cost, l.quantity, l.warranty, l.serialNo, fromPaisa(l.totalPaisa)],
      );
    }

    // --- stock: ascending product id, so two tills cannot deadlock -----------
    for (const l of lines.filter((x) => x.trackStock).sort((a, z) => a.productId - z.productId)) {
      await applyStockMovement(conn, { productId: l.productId, delta: -l.quantity, movementType: 'sale', unitCost: l.cost, referenceType: 'sale', referenceId: saleId, note: invoiceNo, userId: req.user.id });
    }

    // --- payments -----------------------------------------------------------
    for (const p of payments) {
      const receiptNo = await nextDocumentNumber(conn, 'receipt');
      const [payment] = await conn.execute(
        `INSERT INTO payments (receipt_no, customer_id, payment_date, method, amount, reference, is_verified, verified_by, verified_at, idempotency_key, created_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptNo, customer ? customer.id : null, when, p.method, p.amount, p.reference, Number(p.isVerified), p.isVerified ? req.user.id : null, p.isVerified ? new Date() : null, crypto.randomUUID(), req.user.id],
      );
      await conn.execute('INSERT INTO payment_allocations (payment_id, sale_id, amount) VALUES (?, ?, ?)', [payment.insertId, saleId, p.amount]);
    }

    await recalculateSale(conn, saleId);
    await recalculateCustomer(conn, customer ? customer.id : null);

    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'sale.create',
      entityType: 'sale',
      entityId: saleId,
      newValues: { invoiceNo, total: fromPaisa(total), paid: fromPaisa(paid), due: fromPaisa(due), ...(discount ? { discount: fromPaisa(discount) } : {}), ...(priceChanges.length ? { priceChanges } : {}), ...(b.date ? { date: b.date } : {}) },
      ip: req.ip,
    });
    return { id: saleId, invoiceNo, totalAmount: fromPaisa(total), paidAmount: fromPaisa(paid), dueAmount: fromPaisa(due), paymentStatus: due === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid' };
  }
});

/**
 * Void a sale. Nothing is deleted. One transaction:
 * lock customer → lock the sale → mark it void (a conditional update, so it
 * happens once) → put its products back in stock → void its payments, if the
 * caller explicitly asked for that → recalculate → audit.
 *
 * A sale with active payments is refused unless `voidPayments` is true, so
 * money is never detached from a sale by accident. A payment that also covers
 * another sale is never voided here; void that payment on its own first.
 */
router.post('/sales/:id/void', staffWith('sales.void'), idParam, validateBody(voidSchema), async (req, res) => {
  const { reason, voidPayments } = req.body;

  await transaction(async (conn) => {
    const [found] = await conn.execute('SELECT customer_id FROM sales WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Sale not found.');
    const customerId = found[0].customer_id;
    if (customerId) await conn.execute('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);

    const [rows] = await conn.execute('SELECT * FROM sales WHERE id = ? FOR UPDATE', [req.id]);
    const sale = rows[0];
    if (sale.status !== 'completed') throw conflict('This sale has already been voided.');

    const [payments] = await conn.execute(
      `SELECT p.id, p.receipt_no, p.amount, (SELECT COUNT(*) FROM payment_allocations x WHERE x.payment_id = p.id) AS sales_covered
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
        WHERE a.sale_id = ? AND p.status = 'active' ORDER BY p.id FOR UPDATE`,
      [req.id],
    );
    if (payments.length > 0) {
      const amount = fromPaisa(payments.reduce((sum, p) => sum + toPaisa(p.amount), 0));
      if (!voidPayments) throw conflict(`${sale.invoice_no} has ${payments.length} payment(s) totalling ${amount}. Confirm that they are to be voided with the sale and the money returned.`, { payments: payments.length, amount });
      if (!can(req, 'payments.void')) throw forbidden('You do not have permission to void payments.');
      const shared = payments.find((p) => Number(p.sales_covered) > 1);
      if (shared) throw conflict(`Receipt ${shared.receipt_no} also covers another sale. Void that payment on its own first.`);
    }

    const [updated] = await conn.execute("UPDATE sales SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'completed'", [reason, req.user.id, req.id]);
    if (updated.affectedRows !== 1) throw conflict('This sale has already been voided.');

    const [items] = await conn.execute(
      `SELECT i.product_id, i.quantity, i.cost_price_snapshot FROM sale_items i JOIN products p ON p.id = i.product_id
        WHERE i.sale_id = ? AND i.item_type = 'product' AND p.track_stock = 1 ORDER BY i.product_id, i.id`,
      [req.id],
    );
    for (const item of items) {
      await applyStockMovement(conn, { productId: item.product_id, delta: item.quantity, movementType: 'sale_void', unitCost: item.cost_price_snapshot, referenceType: 'sale', referenceId: req.id, note: `Void ${sale.invoice_no}: ${reason}`.slice(0, 255), userId: req.user.id });
    }

    for (const p of payments) {
      await conn.execute("UPDATE payments SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [`Sale ${sale.invoice_no} voided: ${reason}`.slice(0, 255), req.user.id, p.id]);
      await writeAudit({ conn, actorUserId: req.user.id, action: 'payment.void', entityType: 'payment', entityId: p.id, oldValues: { status: 'active', amount: p.amount }, newValues: { status: 'void', withSale: sale.invoice_no }, ip: req.ip });
    }

    await recalculateSale(conn, req.id);
    await recalculateCustomer(conn, customerId);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'sale.void',
      entityType: 'sale',
      entityId: req.id,
      oldValues: { status: 'completed', total: sale.total_amount, paid: sale.paid_amount },
      newValues: { status: 'void', reason, paymentsVoided: payments.length, productLinesReturned: items.length },
      ip: req.ip,
    });
  });

  const rows = await query(`${SALE_SELECT} WHERE s.id = ?`, [req.id]);
  res.json({ sale: summary(rows[0]) });
});

module.exports = router;

const express = require('express');
const crypto = require('node:crypto');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { applyStockMovement } = require('../../lib/stock');
const { nextDocumentNumber } = require('../../lib/documents');
const { recalculateSale, recalculateCustomer } = require('../../lib/ledger');
const { applyAdvanceMovement } = require('../../lib/advance');
const { productRates, lineCommission, addCommissionEntry, earnsCommission, reverseSaleCommission, returnedShare } = require('../../lib/commission');
const { lockOpenDrawer } = require('../../lib/cash');
const { loadSale } = require('./detail');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { dayStart, dayEnd, documentDate, today } = require('../../lib/dates');
const { conflict, notFound, forbidden, badRequest } = require('../../lib/errors');
const { z, id, money, positiveMoney, quantity, optionalText, requiredText, flag, day, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
// 'customer_advance' spends money the customer deposited earlier.
const METHODS = ['cash', 'bkash', 'nagad', 'bank_transfer', 'customer_advance', 'other'];

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
  returnedAmount: row.returned_amount,
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
  // Cost shows the shop's margin: only for users who see financial reports.
  const sale = await loadSale('s.id = ?', [req.id], { audience: 'staff', withCost: can(req, 'reports.financial') });
  if (!sale) throw notFound('Sale not found.');
  res.json({ sale });
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
    await lockOpenDrawer(conn);
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
    const [services] = serviceIds.length ? await conn.query('SELECT id, name, unit, default_price, price_editable, is_active, commission_type, commission_value FROM services WHERE id IN (?)', [serviceIds]) : [[]];
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
        line = { itemType: 'service', productId: null, serviceId: s.id, name: s.name, sku: null, unit: s.unit, unitPrice, cost: null, trackStock: false, warranty: null, serialNo: null, rate: s.commission_type ? { type: s.commission_type, value: s.commission_value } : null };
      }
      return { ...line, quantity: item.quantity, totalPaisa: toPaisa(line.unitPrice) * item.quantity };
    });

    // --- totals -------------------------------------------------------------
    const subtotal = lines.reduce((sum, l) => sum + l.totalPaisa, 0);
    const discount = toPaisa(b.discountAmount);
    if (discount > subtotal) throw fieldError('discountAmount', `The discount cannot be more than the subtotal (${fromPaisa(subtotal)}).`);
    const total = subtotal - discount;
    if (total > 999_999_999_999) throw badRequest('The sale total is too large.');

    // --- commission: earned by the seller, fixed on each line now -----------
    const earns = await earnsCommission(conn, req.user.id);
    const rateOfProduct = earns ? await productRates(conn, productIds) : new Map();
    for (const l of lines) {
      // What the line sold for after its share of the discount, as for a return.
      const valuePaisa = subtotal === 0 ? 0 : Math.round((l.totalPaisa * total) / subtotal);
      l.commissionPaisa = earns ? lineCommission(l.itemType === 'product' ? rateOfProduct.get(l.productId) : l.rate, { valuePaisa, quantity: l.quantity }) : 0;
    }
    const commission = lines.reduce((sum, l) => sum + l.commissionPaisa, 0);

    const mayVerify = can(req, 'payments.verify');
    // Cash is in hand, and advance is money the shop already holds: both are
    // verified by nature. Anything else needs someone allowed to verify.
    const payments = b.payments.map((p) => ({
      ...p,
      reference: p.method === 'customer_advance' ? null : p.reference,
      paisa: toPaisa(p.amount),
      isVerified: p.method === 'cash' || p.method === 'customer_advance' || (p.verified && mayVerify),
    }));
    if (!customer && payments.some((p) => p.method === 'customer_advance')) throw fieldError('customerId', 'Paying from an advance balance needs a saved customer.');
    const tendered = payments.reduce((sum, p) => sum + p.paisa, 0);
    if (tendered > total) throw fieldError('payments', `The payments (${fromPaisa(tendered)}) are more than the sale total (${fromPaisa(total)}). Extra money can be kept as an advance from the customer's page.`);
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
        `INSERT INTO sale_items (sale_id, item_type, product_id, service_id, name_snapshot, sku_snapshot, unit_snapshot, unit_price, cost_price_snapshot, quantity, warranty, serial_no, line_total, commission_amount)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [saleId, l.itemType, l.productId, l.serviceId, l.name, l.sku, l.unit, l.unitPrice, l.cost, l.quantity, l.warranty, l.serialNo, fromPaisa(l.totalPaisa), fromPaisa(l.commissionPaisa)],
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
      // Refused, and the whole sale rolled back, if the balance does not cover it.
      if (p.method === 'customer_advance') {
        await applyAdvanceMovement(conn, { customerId: customer.id, deltaPaisa: -p.paisa, movementType: 'sale_payment', paymentId: payment.insertId, note: invoiceNo, userId: req.user.id });
      }
    }

    if (commission > 0) await addCommissionEntry(conn, { userId: req.user.id, deltaPaisa: commission, entryType: 'sale', saleId, note: invoiceNo, createdBy: req.user.id });

    await recalculateSale(conn, saleId);
    await recalculateCustomer(conn, customer ? customer.id : null);

    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'sale.create',
      entityType: 'sale',
      entityId: saleId,
      newValues: { invoiceNo, total: fromPaisa(total), paid: fromPaisa(paid), due: fromPaisa(due), ...(discount ? { discount: fromPaisa(discount) } : {}), ...(commission ? { commission: fromPaisa(commission) } : {}), ...(priceChanges.length ? { priceChanges } : {}), ...(b.date ? { date: b.date } : {}) },
      ip: req.ip,
    });
    return { id: saleId, invoiceNo, totalAmount: fromPaisa(total), paidAmount: fromPaisa(paid), dueAmount: fromPaisa(due), paymentStatus: due === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid', commission: fromPaisa(commission) };
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
    await lockOpenDrawer(conn);
    const [found] = await conn.execute('SELECT customer_id FROM sales WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Sale not found.');
    const customerId = found[0].customer_id;
    if (customerId) await conn.execute('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);

    const [rows] = await conn.execute('SELECT * FROM sales WHERE id = ? FOR UPDATE', [req.id]);
    const sale = rows[0];
    if (sale.status !== 'completed') throw conflict('This sale has already been voided.');
    if (toPaisa(sale.returned_amount) > 0) throw conflict(`${sale.invoice_no} has a return recorded against it, so it cannot be voided.`);

    const [payments] = await conn.execute(
      `SELECT p.id, p.receipt_no, p.amount, p.method, (SELECT COUNT(*) FROM payment_allocations x WHERE x.payment_id = p.id) AS sales_covered
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
      // Advance spent on this sale goes back to the customer's balance.
      if (p.method === 'customer_advance') {
        await applyAdvanceMovement(conn, { customerId, deltaPaisa: toPaisa(p.amount), movementType: 'payment_void', paymentId: p.id, note: `Sale ${sale.invoice_no} voided`, userId: req.user.id });
      }
      await writeAudit({ conn, actorUserId: req.user.id, action: 'payment.void', entityType: 'payment', entityId: p.id, oldValues: { status: 'active', amount: p.amount }, newValues: { status: 'void', withSale: sale.invoice_no }, ip: req.ip });
    }

    await reverseSaleCommission(conn, { saleId: req.id, note: `Void ${sale.invoice_no}: ${reason}`, createdBy: req.user.id });

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

// --- returns ----------------------------------------------------------------

const returnSchema = z.strictObject({
  idempotencyKey: z.string().uuid('Not a valid key.'),
  reason: requiredText(3, 255),
  // How any money owed back to the customer is given: in cash, or added to
  // their advance balance to spend later.
  refundMethod: z.enum(['cash', 'advance_credit']).default('cash'),
  items: z.array(z.strictObject({ saleItemId: id, quantity })).min(1, 'Choose at least one item to return.').max(200),
});

async function savedReturn(idempotencyKey) {
  const rows = await query('SELECT id, return_no, return_amount, total_refund, refund_method FROM sale_returns WHERE idempotency_key = ?', [idempotencyKey]);
  const r = rows[0];
  return r ? { id: r.id, returnNo: r.return_no, returnAmount: r.return_amount, refundAmount: r.total_refund, refundMethod: r.refund_method } : null;
}

/**
 * Take products back from a completed sale (DATABASE_SCHEMA.md §5.7).
 *
 * The value of what comes back is the line price, less the sale's discount in
 * proportion. That value first cancels whatever is still due on the sale; only
 * the rest is given back, in cash or as advance credit:
 *
 *   value returned 450, sale still owes 250  →  due falls to 0, refund 200
 *   value returned 450, sale fully paid      →  refund 450
 *   value returned 450, sale still owes 900  →  due falls to 450, no refund
 *
 * One transaction: lock customer → lock sale → check quantities against what
 * was sold less what was already returned → take return number → insert the
 * return and its lines → put the products back in stock → credit the advance
 * balance if chosen → recalculate the sale and the customer → audit.
 */
router.post('/sales/:id/returns', staffWith('sales.return'), idParam, validateBody(returnSchema), async (req, res) => {
  const b = req.body;

  const existing = await savedReturn(b.idempotencyKey);
  if (existing) return res.status(200).json({ return: existing, duplicate: true });

  const seen = new Set();
  for (const [index, item] of b.items.entries()) {
    if (seen.has(item.saleItemId)) throw fieldError(`items.${index}.saleItemId`, 'This line is listed twice.');
    seen.add(item.saleItemId);
  }

  let result;
  try {
    result = await transaction(createReturn);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_sale_returns_idempotency')) {
      const stored = await savedReturn(b.idempotencyKey);
      if (stored) return res.status(200).json({ return: stored, duplicate: true });
    }
    throw err;
  }
  res.status(201).json({ return: result });

  async function createReturn(conn) {
    await lockOpenDrawer(conn);
    const [found] = await conn.execute('SELECT customer_id FROM sales WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Sale not found.');
    const customerId = found[0].customer_id;
    if (customerId) await conn.execute('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);

    const [rows] = await conn.execute('SELECT * FROM sales WHERE id = ? FOR UPDATE', [req.id]);
    const sale = rows[0];
    if (sale.status !== 'completed') throw conflict('A voided sale cannot have a return.');
    if (sale.sale_type !== 'sale') throw conflict('An opening due has no items to return.');
    // An unverified payment makes "how much is still due" uncertain. Settle it first.
    if (toPaisa(sale.unverified_amount) > 0) throw conflict(`${sale.invoice_no} has a payment awaiting verification. Verify or void it before recording a return.`);

    const [soldRows] = await conn.execute(
      `SELECT i.id, i.item_type, i.product_id, i.name_snapshot, i.unit_price, i.cost_price_snapshot, i.quantity, i.commission_amount,
              COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri WHERE ri.sale_item_id = i.id), 0) AS returned
         FROM sale_items i WHERE i.sale_id = ?`,
      [req.id],
    );
    const sold = new Map(soldRows.map((i) => [i.id, i]));
    const subtotal = toPaisa(sale.subtotal);
    const total = toPaisa(sale.total_amount);

    const lines = b.items.map((item, index) => {
      const line = sold.get(item.saleItemId);
      if (!line) throw fieldError(`items.${index}.saleItemId`, 'This line is not part of the sale.');
      if (line.item_type !== 'product') throw fieldError(`items.${index}.saleItemId`, `"${line.name_snapshot}" is a service and cannot be returned.`);
      const left = line.quantity - Number(line.returned);
      if (item.quantity > left) throw fieldError(`items.${index}.quantity`, left === 0 ? `"${line.name_snapshot}" has already been returned in full.` : `Only ${left} of "${line.name_snapshot}" can still be returned.`);
      // Line price, less this line's share of the sale-level discount.
      const valuePaisa = subtotal === 0 ? 0 : Math.round((toPaisa(line.unit_price) * item.quantity * total) / subtotal);
      // The commission this line earned on the units coming back.
      const commissionPaisa = returnedShare(toPaisa(line.commission_amount), line.quantity, Number(line.returned), item.quantity);
      return { saleItemId: line.id, productId: line.product_id, name: line.name_snapshot, unitPrice: line.unit_price, cost: line.cost_price_snapshot, quantity: item.quantity, valuePaisa, commissionPaisa };
    });

    // Rounding must never return more than the sale was worth.
    const room = total - toPaisa(sale.returned_amount);
    let value = lines.reduce((sum, l) => sum + l.valuePaisa, 0);
    if (value > room) {
      lines[lines.length - 1].valuePaisa -= value - room;
      value = room;
    }

    const dueNow = toPaisa(sale.due_amount);
    const offset = Math.min(value, dueNow); // cancels what is still owed
    const refund = value - offset; // goes back to the customer
    if (refund > 0 && b.refundMethod === 'advance_credit' && !customerId) throw fieldError('refundMethod', 'A walk-in sale can only be refunded in cash.');

    const returnNo = await nextDocumentNumber(conn, 'return');
    const [inserted] = await conn.execute(
      `INSERT INTO sale_returns (return_no, sale_id, customer_id, return_date, return_amount, total_refund, refund_method, reason, idempotency_key, created_by)
       VALUES (?, ?, ?, UTC_TIMESTAMP(), ?, ?, ?, ?, ?, ?)`,
      [returnNo, req.id, customerId, fromPaisa(value), fromPaisa(refund), b.refundMethod, b.reason, b.idempotencyKey, req.user.id],
    );
    const returnId = inserted.insertId;

    const [tracked] = await conn.query('SELECT id FROM products WHERE id IN (?) AND track_stock = 1', [lines.map((l) => l.productId)]);
    const trackedIds = new Set(tracked.map((p) => p.id));
    for (const l of [...lines].sort((a, z) => a.productId - z.productId)) {
      await conn.execute('INSERT INTO sale_return_items (return_id, sale_item_id, product_id, quantity, unit_price, line_total) VALUES (?, ?, ?, ?, ?, ?)', [returnId, l.saleItemId, l.productId, l.quantity, l.unitPrice, fromPaisa(l.valuePaisa)]);
      if (trackedIds.has(l.productId)) {
        await applyStockMovement(conn, { productId: l.productId, delta: l.quantity, movementType: 'sale_return', unitCost: l.cost, referenceType: 'return', referenceId: returnId, note: `${returnNo} · ${sale.invoice_no}`, userId: req.user.id });
      }
    }

    const commissionBack = lines.reduce((sum, l) => sum + l.commissionPaisa, 0);
    if (commissionBack > 0) {
      const [earner] = await conn.execute("SELECT user_id FROM staff_commission_entries WHERE sale_id = ? AND entry_type = 'sale' ORDER BY id LIMIT 1", [req.id]);
      await addCommissionEntry(conn, { userId: earner[0].user_id, deltaPaisa: -commissionBack, entryType: 'sale_return', saleId: req.id, saleReturnId: returnId, note: `${returnNo} · ${sale.invoice_no}`, createdBy: req.user.id });
    }

    if (refund > 0 && b.refundMethod === 'advance_credit') {
      await applyAdvanceMovement(conn, { customerId, deltaPaisa: refund, movementType: 'return_credit', saleReturnId: returnId, note: `${returnNo} · ${sale.invoice_no}`, userId: req.user.id });
    }

    await recalculateSale(conn, req.id);
    await recalculateCustomer(conn, customerId);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'sale.return',
      entityType: 'sale',
      entityId: req.id,
      newValues: { returnNo, invoiceNo: sale.invoice_no, value: fromPaisa(value), dueReduced: fromPaisa(offset), refund: fromPaisa(refund), refundMethod: b.refundMethod, reason: b.reason, lines: lines.map((l) => ({ name: l.name, quantity: l.quantity })) },
      ip: req.ip,
    });
    return { id: returnId, returnNo, returnAmount: fromPaisa(value), dueReduced: fromPaisa(offset), refundAmount: fromPaisa(refund), refundMethod: b.refundMethod };
  }
});

module.exports = router;

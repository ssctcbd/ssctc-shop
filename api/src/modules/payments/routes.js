const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith, requireStaff, enforceMustChangePassword } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { recalculateSale, recalculateCustomer } = require('../../lib/ledger');
const { applyAdvanceMovement } = require('../../lib/advance');
const { lockCashDrawer } = require('../../lib/cash');
const { nextDocumentNumber } = require('../../lib/documents');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { dayStart, dayEnd, documentDate, today } = require('../../lib/dates');
const { conflict, notFound, badRequest, forbidden } = require('../../lib/errors');
const { z, id, positiveMoney, optionalText, requiredText, flag, day, queryFlag, paging } = require('../../lib/schemas');

// Payments: the list, the receipt, collecting a due after the sale, and
// changing a payment's standing (verify, unverify, void). Money taken together
// with a sale is recorded by POST /sales.
const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const METHODS = ['cash', 'bkash', 'nagad', 'bank_transfer', 'customer_advance', 'other'];
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;
const can = (req, permission) => req.user.permissions.includes(permission);

// --- list and receipt ---------------------------------------------------------

const listSchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  customerId: id.optional(),
  method: z.enum(METHODS).optional(),
  kind: z.enum(['sale', 'due_collection']).optional(),
  verified: queryFlag.optional(),
  status: z.enum(['active', 'void', 'all']).default('all'),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

// A walk-in payment has no customer row; the name comes from the sale it paid.
const PAYMENT_SELECT = `SELECT p.*, u.name AS user_name, vu.name AS verified_by_name,
         COALESCE(c.name, (SELECT s.customer_name FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = p.id ORDER BY s.id LIMIT 1)) AS customer_name,
         (SELECT GROUP_CONCAT(s.invoice_no ORDER BY s.id SEPARATOR ', ') FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = p.id) AS invoices
    FROM payments p
    JOIN users u ON u.id = p.created_by
    LEFT JOIN users vu ON vu.id = p.verified_by
    LEFT JOIN customers c ON c.id = p.customer_id`;

const toApi = (row) => ({
  id: row.id,
  receiptNo: row.receipt_no,
  customerId: row.customer_id,
  customerName: row.customer_name,
  paymentDate: row.payment_date,
  method: row.method,
  kind: row.kind,
  amount: row.amount,
  reference: row.reference,
  isVerified: Boolean(row.is_verified),
  verifiedByName: row.verified_by_name ?? null,
  verifiedAt: row.verified_at,
  status: row.status,
  voidReason: row.void_reason,
  voidedAt: row.voided_at,
  note: row.note,
  invoices: row.invoices,
  recordedByName: row.user_name,
});

router.get('/payments', staffWith('payments.view'), validateQuery(listSchema), async (req, res) => {
  const { search, customerId, method, kind, verified, status, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (status !== 'all') (where.push('p.status = ?'), params.push(status));
  if (customerId) (where.push('p.customer_id = ?'), params.push(customerId));
  if (method) (where.push('p.method = ?'), params.push(method));
  if (kind) (where.push('p.kind = ?'), params.push(kind));
  if (verified !== undefined) (where.push("p.is_verified = ? AND p.status = 'active'"), params.push(Number(verified)));
  if (from) (where.push('p.payment_date >= ?'), params.push(dayStart(from)));
  if (to) (where.push('p.payment_date < ?'), params.push(dayEnd(to)));
  if (search) {
    where.push('(p.receipt_no LIKE ? OR p.reference LIKE ? OR c.name LIKE ? OR c.phone LIKE ?)');
    params.push(likePattern(search), likePattern(search), likePattern(search), likePattern(search));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Voided payments are listed but never counted in the money totals.
  const [totals] = await query(
    `SELECT COUNT(*) AS total,
            COALESCE(SUM(IF(p.status = 'active' AND p.is_verified = 1, p.amount, 0)), 0) AS verified,
            COALESCE(SUM(IF(p.status = 'active' AND p.is_verified = 0, p.amount, 0)), 0) AS unverified
       FROM payments p LEFT JOIN customers c ON c.id = p.customer_id ${whereSql}`,
    params,
  );
  const rows = await query(`${PAYMENT_SELECT} ${whereSql} ORDER BY p.payment_date DESC, p.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(toApi), page, pageSize, total: Number(totals.total), totalVerified: totals.verified, totalUnverified: totals.unverified });
});

/** One payment with the bills it was applied to: what a receipt prints. */
async function loadPayment(where, params) {
  const rows = await query(`${PAYMENT_SELECT} WHERE ${where}`, params);
  const p = rows[0];
  if (!p) return null;
  const allocations = await query(
    `SELECT a.amount, s.id AS sale_id, s.invoice_no, s.sale_type, s.sale_date, s.total_amount, s.due_amount, s.status
       FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = ? ORDER BY s.sale_date, s.id`,
    [p.id],
  );
  const customer = p.customer_id ? (await query('SELECT phone, current_due, advance_balance FROM customers WHERE id = ?', [p.customer_id]))[0] : null;
  return {
    ...toApi(p),
    customerPhone: customer ? customer.phone : null,
    // The balance as it stands now, not as it stood when the receipt was made.
    customerDue: customer ? customer.current_due : null,
    customerAdvance: customer ? customer.advance_balance : null,
    allocations: allocations.map((a) => ({ saleId: a.sale_id, invoiceNo: a.invoice_no, saleType: a.sale_type, saleDate: a.sale_date, saleTotal: a.total_amount, amount: a.amount, saleDue: a.due_amount, saleStatus: a.status })),
  };
}

router.get('/payments/:id', staffWith('payments.view'), idParam, async (req, res) => {
  const payment = await loadPayment('p.id = ?', [req.id]);
  if (!payment) throw notFound('Payment not found.');
  res.json({ payment });
});

// --- collecting a due ---------------------------------------------------------

const collectSchema = z.strictObject({
  // UUID made once by the form: a repeated save returns the first receipt.
  idempotencyKey: z.string().uuid('Not a valid key.'),
  customerId: id,
  amount: positiveMoney,
  method: z.enum(METHODS).default('cash'),
  reference: optionalText(60).transform((v) => (v ? v.toUpperCase() : null)),
  // Cash is always verified. For other methods this is honoured only from a
  // user allowed to verify payments; typing a transaction ID never verifies.
  verified: flag.default(false),
  date: day.optional(),
  note: optionalText(255),
  // Which bills the money goes to. Left out = oldest bill first.
  allocations: z.array(z.strictObject({ saleId: id, amount: positiveMoney })).max(100).optional(),
});

/**
 * Take money against what a customer owes (DATABASE_SCHEMA.md §5.3). One
 * transaction: lock the cash drawer → lock customer → lock their unpaid sales
 * → split the money (as given, or oldest bill first) → take receipt number →
 * insert the payment and its allocations → spend the advance balance if that
 * is the method → recalculate each sale and the customer → audit.
 *
 * What can be collected on a sale is its due less money already claimed by a
 * payment awaiting verification, so the same due cannot be collected twice.
 * Money beyond that is refused; keeping extra is an advance deposit.
 */
router.post('/payments', staffWith('payments.create'), validateBody(collectSchema), async (req, res) => {
  const b = req.body;

  const saved = async () => loadPayment('p.idempotency_key = ?', [b.idempotencyKey]);
  const existing = await saved();
  if (existing) return res.status(200).json({ payment: existing, duplicate: true });

  if (b.date && b.date > today()) throw fieldError('date', 'The payment date cannot be in the future.');
  if (b.date && b.date !== today() && !can(req, 'sales.backdate')) throw forbidden('You do not have permission to change the payment date.');

  try {
    await transaction(async (conn) => {
      await lockCashDrawer(conn);
      const [customers] = await conn.execute('SELECT id, name FROM customers WHERE id = ? FOR UPDATE', [b.customerId]);
      const customer = customers[0];
      if (!customer) throw fieldError('customerId', 'Customer not found.');

      const [open] = await conn.execute("SELECT id, invoice_no, sale_date, due_amount, unverified_amount FROM sales WHERE customer_id = ? AND status = 'completed' AND due_amount > 0 ORDER BY id FOR UPDATE", [b.customerId]);
      const collectable = (sale) => Math.max(0, toPaisa(sale.due_amount) - toPaisa(sale.unverified_amount));
      const byId = new Map(open.map((sale) => [sale.id, sale]));
      const amount = toPaisa(b.amount);
      let split;

      if (b.allocations) {
        const seen = new Set();
        split = b.allocations.map((a, index) => {
          const sale = byId.get(a.saleId);
          if (!sale || seen.has(a.saleId)) throw fieldError(`allocations.${index}.saleId`, sale ? 'This bill is listed twice.' : 'This bill has no due.');
          seen.add(a.saleId);
          if (toPaisa(a.amount) > collectable(sale)) throw fieldError(`allocations.${index}.amount`, `Only ${fromPaisa(collectable(sale))} can be collected on ${sale.invoice_no}.`);
          return { saleId: sale.id, invoiceNo: sale.invoice_no, paisa: toPaisa(a.amount) };
        });
        const allocated = split.reduce((sum, a) => sum + a.paisa, 0);
        if (allocated !== amount) throw fieldError('amount', `The bills add up to ${fromPaisa(allocated)}, not ${b.amount}.`);
      } else {
        let left = amount;
        split = [];
        for (const sale of [...open].sort((x, y) => x.sale_date - y.sale_date || x.id - y.id)) {
          if (left === 0) break;
          const paisa = Math.min(left, collectable(sale));
          if (paisa === 0) continue;
          split.push({ saleId: sale.id, invoiceNo: sale.invoice_no, paisa });
          left -= paisa;
        }
        if (left > 0) {
          const most = amount - left;
          throw fieldError('amount', most === 0 ? `${customer.name} has no due to collect.` : `Only ${fromPaisa(most)} can be collected from ${customer.name}. Extra money can be kept as an advance.`);
        }
      }

      // Cash is in hand, and advance is money the shop already holds: both are
      // verified by nature. Anything else needs someone allowed to verify.
      const isVerified = b.method === 'cash' || b.method === 'customer_advance' || (b.verified && can(req, 'payments.verify'));
      const receiptNo = await nextDocumentNumber(conn, 'receipt');
      const [payment] = await conn.execute(
        `INSERT INTO payments (receipt_no, customer_id, payment_date, method, kind, amount, reference, is_verified, verified_by, verified_at, note, idempotency_key, created_by)
         VALUES (?, ?, ?, ?, 'due_collection', ?, ?, ?, ?, ?, ?, ?, ?)`,
        [receiptNo, customer.id, documentDate(b.date), b.method, b.amount, b.method === 'customer_advance' ? null : b.reference, Number(isVerified), isVerified ? req.user.id : null, isVerified ? new Date() : null, b.note, b.idempotencyKey, req.user.id],
      );
      // Refused, and everything rolled back, if the balance does not cover it.
      if (b.method === 'customer_advance') {
        await applyAdvanceMovement(conn, { customerId: customer.id, deltaPaisa: -amount, movementType: 'sale_payment', paymentId: payment.insertId, note: `Due collection ${receiptNo}`, userId: req.user.id });
      }
      for (const a of [...split].sort((x, y) => x.saleId - y.saleId)) {
        await conn.execute('INSERT INTO payment_allocations (payment_id, sale_id, amount) VALUES (?, ?, ?)', [payment.insertId, a.saleId, fromPaisa(a.paisa)]);
        await recalculateSale(conn, a.saleId);
      }
      await recalculateCustomer(conn, customer.id);
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'payment.collect',
        entityType: 'payment',
        entityId: payment.insertId,
        newValues: { receiptNo, customerId: customer.id, amount: b.amount, method: b.method, reference: b.reference, isVerified, bills: split.map((a) => ({ invoiceNo: a.invoiceNo, amount: fromPaisa(a.paisa) })), ...(b.date ? { date: b.date } : {}) },
        ip: req.ip,
      });
    });
  } catch (err) {
    if (err.code !== 'ER_DUP_ENTRY') throw err;
    const message = String(err.message);
    if (message.includes('uq_payments_active_ref')) throw conflict('This bKash/Nagad transaction ID has already been recorded on another payment.', { fields: { reference: 'Already recorded.' } });
    // The same save arrived twice at once; the unique key let one through.
    if (!message.includes('uq_payments_idempotency')) throw err;
    return res.status(200).json({ payment: await saved(), duplicate: true });
  }
  res.status(201).json({ payment: await saved() });
});

// --- verify, unverify, void ---------------------------------------------------

const voidSchema = z.strictObject({ reason: requiredText(3, 255) });

/**
 * Run `change` on one payment with everything it touches locked, then
 * recalculate. Lock order as everywhere: customer → sales (ascending) → payment.
 * `change(conn, payment)` must make a conditional UPDATE and return its
 * affectedRows, so that two people acting at once produce one change.
 */
async function changePayment(req, { action, change, alreadyDone }) {
  await transaction(async (conn) => {
    await lockCashDrawer(conn);
    const [found] = await conn.execute('SELECT customer_id FROM payments WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Payment not found.');
    const customerId = found[0].customer_id;
    if (customerId) await conn.execute('SELECT id FROM customers WHERE id = ? FOR UPDATE', [customerId]);

    const [sales] = await conn.execute('SELECT s.id FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = ? ORDER BY s.id FOR UPDATE', [req.id]);
    const [rows] = await conn.execute('SELECT * FROM payments WHERE id = ? FOR UPDATE', [req.id]);
    const payment = rows[0];
    if (payment.status !== 'active') throw conflict('This payment has been voided.');

    if ((await change(conn, payment)) !== 1) throw conflict(alreadyDone);

    // recalculateSale refuses to leave a walk-in sale with a due, which rolls
    // the whole change back with an explanation.
    for (const sale of sales) await recalculateSale(conn, sale.id);
    await recalculateCustomer(conn, customerId);

    const [after] = await conn.execute('SELECT is_verified, status FROM payments WHERE id = ?', [req.id]);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action,
      entityType: 'payment',
      entityId: req.id,
      oldValues: { isVerified: Boolean(payment.is_verified), status: payment.status, amount: payment.amount, method: payment.method, reference: payment.reference },
      newValues: { isVerified: Boolean(after[0].is_verified), status: after[0].status, ...(req.body && req.body.reason ? { reason: req.body.reason } : {}) },
      ip: req.ip,
    });
  });
  const rows = await query('SELECT id, receipt_no, is_verified, status FROM payments WHERE id = ?', [req.id]);
  return { id: rows[0].id, receiptNo: rows[0].receipt_no, isVerified: Boolean(rows[0].is_verified), status: rows[0].status };
}

// The money has been seen to arrive. Until then it does not reduce the due.
router.post('/payments/:id/verify', staffWith('payments.verify'), idParam, async (req, res) => {
  const payment = await changePayment(req, {
    action: 'payment.verify',
    alreadyDone: 'This payment is already verified.',
    change: async (conn) => (await conn.execute("UPDATE payments SET is_verified = 1, verified_by = ?, verified_at = UTC_TIMESTAMP() WHERE id = ? AND is_verified = 0 AND status = 'active'", [req.user.id, req.id]))[0].affectedRows,
  });
  res.json({ payment });
});

// Verified by mistake: the due goes back up.
router.post('/payments/:id/unverify', staffWith('payments.verify'), idParam, async (req, res) => {
  const payment = await changePayment(req, {
    action: 'payment.unverify',
    alreadyDone: 'This payment is not verified.',
    change: async (conn, current) => {
      // Advance is money the shop already holds; there is nothing to un-verify.
      if (current.method === 'customer_advance') throw conflict('A payment from the advance balance is always verified. Void it instead.');
      // Cash was in hand when it was recorded, and the cash drawer counts on that.
      if (current.method === 'cash') throw conflict('A cash payment is always verified. If it was entered wrongly, void it instead.');
      return (await conn.execute("UPDATE payments SET is_verified = 0, verified_by = NULL, verified_at = NULL WHERE id = ? AND is_verified = 1 AND status = 'active'", [req.id]))[0].affectedRows;
    },
  });
  res.json({ payment });
});

// A payment entered wrongly. It stays in the history, marked void, and frees
// its bKash/Nagad transaction ID to be recorded correctly.
router.post('/payments/:id/void', staffWith('payments.void'), idParam, validateBody(voidSchema), async (req, res) => {
  const payment = await changePayment(req, {
    action: 'payment.void',
    alreadyDone: 'This payment has been voided.',
    change: async (conn, current) => {
      const [updated] = await conn.execute("UPDATE payments SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [req.body.reason, req.user.id, req.id]);
      // Advance that was spent goes back to the customer's balance.
      if (updated.affectedRows === 1 && current.method === 'customer_advance') {
        await applyAdvanceMovement(conn, { customerId: current.customer_id, deltaPaisa: toPaisa(current.amount), movementType: 'payment_void', paymentId: current.id, note: `Receipt ${current.receipt_no} voided`, userId: req.user.id });
      }
      return updated.affectedRows;
    },
  });
  res.json({ payment });
});

// Shop details for invoice and receipt headers. Any logged-in staff user.
router.get('/settings/shop', requireStaff, enforceMustChangePassword, async (_req, res) => {
  const rows = await query("SELECT setting_key, value FROM settings WHERE setting_key LIKE 'shop.%' OR setting_key LIKE 'invoice.%' OR setting_key LIKE 'payment.%'");
  res.json({ settings: Object.fromEntries(rows.map((r) => [r.setting_key, r.value])) });
});

module.exports = router;

const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { nextDocumentNumber } = require('../../lib/documents');
const { lockOpenDrawer } = require('../../lib/cash');
const { recalculatePurchase, recalculatePayable } = require('../../lib/payables');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { dayStart, dayEnd, documentDate, today } = require('../../lib/dates');
const { notFound, badRequest, conflict } = require('../../lib/errors');
const { z, id, positiveMoney, optionalText, requiredText, day, paging } = require('../../lib/schemas');
const { lockSupplier } = require('./routes');

// Paying a supplier after the bill was entered. Money handed over together
// with a bill is recorded by POST /purchases.
const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });

const paymentSchema = z.strictObject({
  // UUID made once by the form: a repeated save returns the first payment.
  idempotencyKey: z.string().uuid('Not a valid key.'),
  supplierId: id,
  amount: positiveMoney,
  method: z.enum(['cash', 'bkash', 'nagad', 'bank_transfer', 'other']).default('cash'),
  reference: optionalText(60),
  date: day.optional(),
  note: optionalText(255),
  // Which bills the money goes to. Left out = oldest bill first.
  allocations: z.array(z.strictObject({ purchaseId: id, amount: positiveMoney })).max(100).optional(),
});

const listSchema = z.strictObject({
  supplierId: id.optional(),
  status: z.enum(['active', 'void', 'all']).default('all'),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

const voidSchema = z.strictObject({ reason: requiredText(3, 255) });

const toApi = (row) => ({
  id: row.id,
  voucherNo: row.voucher_no,
  supplierId: row.supplier_id,
  supplierName: row.supplier_name,
  paymentDate: row.payment_date,
  amount: row.amount,
  method: row.method,
  reference: row.reference,
  note: row.note,
  status: row.status,
  voidReason: row.void_reason,
  voidedAt: row.voided_at,
  purchases: row.purchases,
  recordedByName: row.user_name,
});

const SELECT = `SELECT sp.*, s.name AS supplier_name, u.name AS user_name,
         (SELECT GROUP_CONCAT(pu.purchase_no ORDER BY pu.id SEPARATOR ', ')
            FROM supplier_payment_allocations a JOIN purchases pu ON pu.id = a.purchase_id WHERE a.payment_id = sp.id) AS purchases
    FROM supplier_payments sp JOIN suppliers s ON s.id = sp.supplier_id JOIN users u ON u.id = sp.created_by`;

async function savedPayment(idempotencyKey) {
  const rows = await query(`${SELECT} WHERE sp.idempotency_key = ?`, [idempotencyKey]);
  return rows[0] ? toApi(rows[0]) : null;
}

router.get('/supplier-payments', staffWith('suppliers.view'), validateQuery(listSchema), async (req, res) => {
  const { supplierId, status, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (supplierId) (where.push('sp.supplier_id = ?'), params.push(supplierId));
  if (status !== 'all') (where.push('sp.status = ?'), params.push(status));
  if (from) (where.push('sp.payment_date >= ?'), params.push(dayStart(from)));
  if (to) (where.push('sp.payment_date < ?'), params.push(dayEnd(to)));
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Voided payments are listed but never counted.
  const [totals] = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(IF(sp.status = 'active', sp.amount, 0)), 0) AS amount FROM supplier_payments sp ${whereSql}`, params);
  const rows = await query(`${SELECT} ${whereSql} ORDER BY sp.payment_date DESC, sp.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(toApi), page, pageSize, total: Number(totals.total), totalAmount: totals.amount });
});

// Bills of one supplier that still have something owed, oldest first.
router.get('/suppliers/:id/open-purchases', staffWith('suppliers.view'), idParam, async (req, res) => {
  const rows = await query(
    `SELECT id, purchase_no, purchase_date, supplier_memo_no, total_amount, paid_amount, due_amount
       FROM purchases WHERE supplier_id = ? AND status = 'active' AND due_amount > 0 ORDER BY purchase_date, id`,
    [req.id],
  );
  res.json({ purchases: rows.map((p) => ({ id: p.id, purchaseNo: p.purchase_no, purchaseDate: p.purchase_date, supplierMemoNo: p.supplier_memo_no, totalAmount: p.total_amount, paidAmount: p.paid_amount, dueAmount: p.due_amount })) });
});

/**
 * Pay a supplier. One transaction:
 * lock the cash drawer → lock supplier → lock their unpaid bills → split the
 * money (as given, or oldest bill first) → take voucher number → insert the
 * payment and its allocations → recalculate each bill and the payable → audit.
 * A payment can never be more than what is owed.
 */
router.post('/supplier-payments', staffWith('purchases.manage'), validateBody(paymentSchema), async (req, res) => {
  const b = req.body;

  const existing = await savedPayment(b.idempotencyKey);
  if (existing) return res.status(200).json({ payment: existing, duplicate: true });
  if (b.date && b.date > today()) throw fieldError('date', 'The payment date cannot be in the future.');

  try {
    await transaction(async (conn) => {
      await lockOpenDrawer(conn);
      await lockSupplier(conn, b.supplierId);

      const [open] = await conn.execute("SELECT id, purchase_no, purchase_date, due_amount FROM purchases WHERE supplier_id = ? AND status = 'active' AND due_amount > 0 ORDER BY id FOR UPDATE", [b.supplierId]);
      const byId = new Map(open.map((p) => [p.id, p]));
      const amount = toPaisa(b.amount);
      let split;

      if (b.allocations) {
        const seen = new Set();
        split = b.allocations.map((a, index) => {
          const bill = byId.get(a.purchaseId);
          if (!bill || seen.has(a.purchaseId)) throw fieldError(`allocations.${index}.purchaseId`, bill ? 'This bill is listed twice.' : 'This bill has nothing owed on it.');
          seen.add(a.purchaseId);
          if (toPaisa(a.amount) > toPaisa(bill.due_amount)) throw fieldError(`allocations.${index}.amount`, `Only ${bill.due_amount} is owed on ${bill.purchase_no}.`);
          return { purchaseId: bill.id, purchaseNo: bill.purchase_no, paisa: toPaisa(a.amount) };
        });
        const allocated = split.reduce((sum, a) => sum + a.paisa, 0);
        if (allocated !== amount) throw fieldError('amount', `The bills add up to ${fromPaisa(allocated)}, not ${b.amount}.`);
      } else {
        let left = amount;
        split = [];
        for (const bill of [...open].sort((x, y) => x.purchase_date - y.purchase_date || x.id - y.id)) {
          if (left === 0) break;
          const paisa = Math.min(left, toPaisa(bill.due_amount));
          split.push({ purchaseId: bill.id, purchaseNo: bill.purchase_no, paisa });
          left -= paisa;
        }
        if (left > 0) throw fieldError('amount', `Only ${fromPaisa(amount - left)} is owed to this supplier.`);
      }

      const voucherNo = await nextDocumentNumber(conn, 'supplier_payment');
      const [payment] = await conn.execute(
        'INSERT INTO supplier_payments (voucher_no, supplier_id, payment_date, amount, method, reference, note, idempotency_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [voucherNo, b.supplierId, documentDate(b.date), b.amount, b.method, b.reference, b.note, b.idempotencyKey, req.user.id],
      );
      for (const a of [...split].sort((x, y) => x.purchaseId - y.purchaseId)) {
        await conn.execute('INSERT INTO supplier_payment_allocations (payment_id, purchase_id, amount) VALUES (?, ?, ?)', [payment.insertId, a.purchaseId, fromPaisa(a.paisa)]);
        await recalculatePurchase(conn, a.purchaseId);
      }
      await recalculatePayable(conn, b.supplierId);
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'supplier_payment.create',
        entityType: 'supplier_payment',
        entityId: payment.insertId,
        newValues: { voucherNo, supplierId: b.supplierId, amount: b.amount, method: b.method, reference: b.reference, bills: split.map((a) => ({ purchaseNo: a.purchaseNo, amount: fromPaisa(a.paisa) })), ...(b.date ? { date: b.date } : {}) },
        ip: req.ip,
      });
    });
  } catch (err) {
    // The same save arrived twice at once; the unique key let one through.
    if (!(err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_supplier_payments_idempotency'))) throw err;
    return res.status(200).json({ payment: await savedPayment(b.idempotencyKey), duplicate: true });
  }
  res.status(201).json({ payment: await savedPayment(b.idempotencyKey) });
});

// A payment entered wrongly. It stays in the history, marked void, and the
// bills it covered are owed again.
router.post('/supplier-payments/:id/void', staffWith('purchases.manage'), idParam, validateBody(voidSchema), async (req, res) => {
  await transaction(async (conn) => {
    await lockOpenDrawer(conn);
    const [found] = await conn.execute('SELECT supplier_id FROM supplier_payments WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Payment not found.');
    await lockSupplier(conn, found[0].supplier_id, null);

    const [bills] = await conn.execute('SELECT pu.id FROM supplier_payment_allocations a JOIN purchases pu ON pu.id = a.purchase_id WHERE a.payment_id = ? ORDER BY pu.id FOR UPDATE', [req.id]);
    const [rows] = await conn.execute('SELECT * FROM supplier_payments WHERE id = ? FOR UPDATE', [req.id]);
    const payment = rows[0];
    const [updated] = await conn.execute("UPDATE supplier_payments SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [req.body.reason, req.user.id, req.id]);
    if (updated.affectedRows !== 1) throw conflict('This payment has already been voided.');

    for (const bill of bills) await recalculatePurchase(conn, bill.id);
    await recalculatePayable(conn, payment.supplier_id);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'supplier_payment.void',
      entityType: 'supplier_payment',
      entityId: req.id,
      oldValues: { status: 'active', voucherNo: payment.voucher_no, amount: payment.amount, method: payment.method },
      newValues: { status: 'void', reason: req.body.reason },
      ip: req.ip,
    });
  });
  const rows = await query(`${SELECT} WHERE sp.id = ?`, [req.id]);
  res.json({ payment: toApi(rows[0]) });
});

module.exports = router;

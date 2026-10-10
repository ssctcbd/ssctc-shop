const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, idParam } = require('../../middleware/validate');
const { staffWith, requireStaff, enforceMustChangePassword } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { recalculateSale, recalculateCustomer } = require('../../lib/ledger');
const { applyAdvanceMovement } = require('../../lib/advance');
const { toPaisa } = require('../../lib/money');
const { conflict, notFound } = require('../../lib/errors');
const { z, requiredText } = require('../../lib/schemas');

// Changing a payment's standing: verify, unverify, void. Recording payments
// after a sale (due collection) and the payments list arrive in Milestone 4.
const router = express.Router();

const voidSchema = z.strictObject({ reason: requiredText(3, 255) });

/**
 * Run `change` on one payment with everything it touches locked, then
 * recalculate. Lock order as everywhere: customer → sales (ascending) → payment.
 * `change(conn, payment)` must make a conditional UPDATE and return its
 * affectedRows, so that two people acting at once produce one change.
 */
async function changePayment(req, { action, change, alreadyDone }) {
  await transaction(async (conn) => {
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

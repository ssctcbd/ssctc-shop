const { toPaisa, fromPaisa } = require('./money');
const { conflict } = require('./errors');

/**
 * What the shop owes is derived, never typed in (DATABASE_SCHEMA.md §5.4).
 * These two functions are the only code that writes the money columns of a
 * purchase bill and a supplier's payable; they run inside every transaction
 * that touches a purchase or a supplier payment.
 *
 *   paid = Σ allocations of active supplier payments
 *   due  = total − paid
 *
 * Lock order: supplier row → purchases in ascending id.
 */

/** Recalculate one purchase bill from the payments allocated to it. */
async function recalculatePurchase(conn, purchaseId) {
  const [rows] = await conn.execute('SELECT purchase_no, total_amount FROM purchases WHERE id = ?', [purchaseId]);
  const [sums] = await conn.execute(
    `SELECT COALESCE(SUM(a.amount), 0) AS paid
       FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id
      WHERE a.purchase_id = ? AND p.status = 'active'`,
    [purchaseId],
  );
  const total = toPaisa(rows[0].total_amount);
  const paid = toPaisa(sums[0].paid);
  const due = total - paid;
  if (due < 0) throw conflict(`${rows[0].purchase_no} would be overpaid by ${fromPaisa(-due)}.`);
  await conn.execute('UPDATE purchases SET paid_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?', [fromPaisa(paid), fromPaisa(due), due === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid', purchaseId]);
  return { paid, due };
}

/** A supplier's payable is the sum of what is still owed on their active bills. */
async function recalculatePayable(conn, supplierId) {
  await conn.execute("UPDATE suppliers SET current_payable = (SELECT COALESCE(SUM(due_amount), 0) FROM purchases WHERE supplier_id = ? AND status = 'active') WHERE id = ?", [supplierId, supplierId]);
}

module.exports = { recalculatePurchase, recalculatePayable };

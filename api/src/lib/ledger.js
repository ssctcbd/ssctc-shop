const { toPaisa, fromPaisa } = require('./money');
const { conflict } = require('./errors');

/**
 * Money figures on sales and customers are derived, never typed in
 * (DATABASE_SCHEMA.md §5.3). These two functions are the only code that writes
 * them, and they run inside every transaction that touches a sale or a payment.
 *
 * Lock order, the same everywhere: customer row → sales in ascending id → payment.
 */

/** Recalculate paid / unverified / due / payment status of one sale from its payments. */
async function recalculateSale(conn, saleId) {
  const [sales] = await conn.execute('SELECT invoice_no, customer_id, status, total_amount FROM sales WHERE id = ?', [saleId]);
  const sale = sales[0];
  const [sums] = await conn.execute(
    `SELECT COALESCE(SUM(IF(p.is_verified = 1, a.amount, 0)), 0) AS paid,
            COALESCE(SUM(IF(p.is_verified = 0, a.amount, 0)), 0) AS unverified
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.sale_id = ? AND p.status = 'active'`,
    [saleId],
  );
  const total = toPaisa(sale.total_amount);
  const paid = toPaisa(sums[0].paid);
  const due = total - paid;

  // Only verified money counts as paid (Decision D2). A walk-in sale has no
  // customer to owe the difference, so it can never be left with a due (D3).
  if (sale.status === 'completed' && due > 0 && sale.customer_id === null) {
    throw conflict(`${sale.invoice_no} is a walk-in sale and cannot carry a due. Verify the payment, or void the sale.`);
  }

  await conn.execute('UPDATE sales SET paid_amount = ?, unverified_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?', [
    fromPaisa(paid),
    sums[0].unverified,
    fromPaisa(due),
    due === 0 ? 'paid' : paid > 0 ? 'partial' : 'unpaid',
    saleId,
  ]);
  return { paid, due };
}

/** A customer's balance is the sum of what is still due on their completed sales. */
async function recalculateCustomer(conn, customerId) {
  if (customerId === null || customerId === undefined) return;
  await conn.execute("UPDATE customers SET current_due = (SELECT COALESCE(SUM(due_amount), 0) FROM sales WHERE customer_id = ? AND status = 'completed') WHERE id = ?", [customerId, customerId]);
}

module.exports = { recalculateSale, recalculateCustomer };

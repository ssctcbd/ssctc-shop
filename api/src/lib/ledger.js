const { toPaisa, fromPaisa } = require('./money');
const { conflict } = require('./errors');

/**
 * Money figures on sales and customers are derived, never typed in
 * (DATABASE_SCHEMA.md §5.3). These two functions are the only code that writes
 * them, and they run inside every transaction that touches a sale, a payment
 * or a return.
 *
 *   returned  = value of goods returned on the sale
 *   refunded  = the part of that value given back (cash or advance credit)
 *   paid      = verified payments − refunded
 *   due       = total − returned − paid
 *
 * Lock order, the same everywhere: customer row → sales in ascending id → payment.
 */

/** Recalculate the derived money columns of one sale from its payments and returns. */
async function recalculateSale(conn, saleId) {
  const [sales] = await conn.execute('SELECT invoice_no, customer_id, status, total_amount FROM sales WHERE id = ?', [saleId]);
  const sale = sales[0];
  const [sums] = await conn.execute(
    `SELECT COALESCE(SUM(IF(p.is_verified = 1, a.amount, 0)), 0) AS verified,
            COALESCE(SUM(IF(p.is_verified = 0, a.amount, 0)), 0) AS unverified
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id
      WHERE a.sale_id = ? AND p.status = 'active'`,
    [saleId],
  );
  const [returns] = await conn.execute('SELECT COALESCE(SUM(return_amount), 0) AS returned, COALESCE(SUM(total_refund), 0) AS refunded FROM sale_returns WHERE sale_id = ?', [saleId]);

  const total = toPaisa(sale.total_amount);
  const returned = toPaisa(returns[0].returned);
  const refunded = toPaisa(returns[0].refunded);
  const paid = toPaisa(sums[0].verified) - refunded;
  const due = total - returned - paid;

  // Money already handed back for a return cannot be un-received by removing
  // the payment it came out of.
  if (paid < 0) throw conflict(`${sale.invoice_no} has a refund of ${fromPaisa(refunded)} paid out against it, so this payment cannot be removed.`);
  if (due < 0) throw conflict(`${sale.invoice_no} would be overpaid by ${fromPaisa(-due)}.`);

  // Only verified money counts as paid (Decision D2). A walk-in sale has no
  // customer to owe the difference, so it can never be left with a due (D3).
  if (sale.status === 'completed' && due > 0 && sale.customer_id === null) {
    throw conflict(`${sale.invoice_no} is a walk-in sale and cannot carry a due. Verify the payment, or void the sale.`);
  }

  await conn.execute('UPDATE sales SET returned_amount = ?, refunded_amount = ?, paid_amount = ?, unverified_amount = ?, due_amount = ?, payment_status = ? WHERE id = ?', [
    fromPaisa(returned),
    fromPaisa(refunded),
    fromPaisa(paid),
    sums[0].unverified,
    fromPaisa(due),
    due === 0 ? 'paid' : paid > 0 || returned > 0 ? 'partial' : 'unpaid',
    saleId,
  ]);
  return { paid, due, returned, refunded };
}

/** A customer's balance is the sum of what is still due on their completed sales. */
async function recalculateCustomer(conn, customerId) {
  if (customerId === null || customerId === undefined) return;
  await conn.execute("UPDATE customers SET current_due = (SELECT COALESCE(SUM(due_amount), 0) FROM sales WHERE customer_id = ? AND status = 'completed') WHERE id = ?", [customerId, customerId]);
}

module.exports = { recalculateSale, recalculateCustomer };

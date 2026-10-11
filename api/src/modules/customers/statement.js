const express = require('express');
const { query } = require('../../db/pool');
const { validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { toPaisa, fromPaisa, fromSignedPaisa } = require('../../lib/money');
const { dayStart, dayEnd } = require('../../lib/dates');
const { notFound, badRequest } = require('../../lib/errors');
const { z, day } = require('../../lib/schemas');

const router = express.Router();

/**
 * A customer's statement: every entry that changed what they owe, in date
 * order, with the balance after each.
 *
 *   a bill                      + its total
 *   a verified payment          − the amount applied to a bill
 *   returned goods              − the part of their value that came off the due
 *                                 (the rest was refunded, and changes nothing owed)
 *
 * These are exactly the terms of  due = total − returned − (verified − refunded),
 * so the last balance of a statement with no end date is the customer's
 * current due. Voided bills and voided or unverified payments are not shown.
 * With `from`, everything earlier is folded into the opening balance.
 * A payment or return is never listed before the bill it belongs to, even if
 * it was dated earlier or the two clocks disagree by a second.
 */
router.get('/customers/:id/statement', staffWith('customers.view'), idParam, validateQuery(z.strictObject({ from: day.optional(), to: day.optional() })), async (req, res) => {
  const { from, to } = req.q;
  if (from && to && from > to) throw badRequest('The "from" date is after the "to" date.');
  const customers = await query('SELECT id, name, phone, address, current_due, advance_balance FROM customers WHERE id = ?', [req.id]);
  const c = customers[0];
  if (!c) throw notFound('Customer not found.');

  const rows = await query(
    `SELECT at, kind, reference, detail, amount FROM (
       SELECT s.sale_date AS at, IF(s.sale_type = 'opening_due', 'opening_due', 'bill') AS kind, s.invoice_no AS reference, NULL AS detail, s.total_amount AS amount, 1 AS seq, s.id AS id
         FROM sales s WHERE s.customer_id = ? AND s.status = 'completed'
       UNION ALL
       SELECT GREATEST(p.payment_date, s.sale_date), 'payment', p.receipt_no, CONCAT(p.method, ' · ', s.invoice_no), -a.amount, 2, a.id
         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN sales s ON s.id = a.sale_id
        WHERE s.customer_id = ? AND s.status = 'completed' AND p.status = 'active' AND p.is_verified = 1
       UNION ALL
       SELECT GREATEST(r.return_date, s.sale_date), 'return', r.return_no, s.invoice_no, -(r.return_amount - r.total_refund), 3, r.id
         FROM sale_returns r JOIN sales s ON s.id = r.sale_id
        WHERE s.customer_id = ? AND s.status = 'completed' AND r.return_amount > r.total_refund
     ) entries ORDER BY at, seq, id`,
    [req.id, req.id, req.id],
  );

  const start = from ? dayStart(from) : null;
  const end = to ? dayEnd(to) : null;
  let balance = 0;
  let opening = 0;
  let billed = 0;
  let paid = 0;
  const entries = [];
  for (const row of rows) {
    const amount = String(row.amount).startsWith('-') ? -toPaisa(String(row.amount).slice(1)) : toPaisa(row.amount);
    if (end && row.at >= end) break;
    balance += amount;
    if (start && row.at < start) {
      opening = balance;
      continue;
    }
    if (amount > 0) billed += amount;
    else paid += -amount;
    entries.push({ date: row.at, kind: row.kind, reference: row.reference, detail: row.detail, debit: amount > 0 ? fromPaisa(amount) : null, credit: amount < 0 ? fromPaisa(-amount) : null, balance: fromSignedPaisa(balance) });
  }

  res.json({
    customer: { id: c.id, name: c.name, phone: c.phone, address: c.address, currentDue: c.current_due, advanceBalance: c.advance_balance },
    from: from || null,
    to: to || null,
    openingBalance: fromSignedPaisa(opening),
    entries,
    totalBilled: fromPaisa(billed),
    totalPaid: fromPaisa(paid),
    closingBalance: fromSignedPaisa(balance),
  });
});

module.exports = router;

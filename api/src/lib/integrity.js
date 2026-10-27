/**
 * Checks that the stored balances still agree with the records behind them.
 * Every figure the system keeps (stock, dues, advance, payables, commission) is derived
 * from a ledger; a difference here is a bug to investigate, never a number to
 * overwrite. Used by the System screen, the launch check and the restore drill.
 *
 * `run(sql)` must resolve to the rows of a query: `query` from db/pool, or a
 * wrapper around a script connection.
 */
const CHECKS = [
  {
    key: 'stock',
    label: 'Stock equals its movement history',
    sql: `SELECT COUNT(*) AS n FROM products p
           WHERE p.track_stock = 1 AND p.stock_qty <> (SELECT COALESCE(SUM(m.quantity), 0) FROM inventory_movements m WHERE m.product_id = p.id)`,
  },
  {
    key: 'sales',
    label: 'Every bill equals its payments and returns',
    sql: `SELECT COUNT(*) AS n FROM sales s
            LEFT JOIN (SELECT a.sale_id, SUM(IF(p.is_verified = 1, a.amount, 0)) AS paid, SUM(IF(p.is_verified = 0, a.amount, 0)) AS unverified
                         FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.status = 'active' GROUP BY a.sale_id) x ON x.sale_id = s.id
           WHERE s.paid_amount <> COALESCE(x.paid, 0) - s.refunded_amount
              OR s.unverified_amount <> COALESCE(x.unverified, 0)
              OR s.due_amount <> s.total_amount - s.returned_amount - s.paid_amount`,
  },
  {
    key: 'payments',
    label: 'Every payment is fully applied to bills',
    sql: `SELECT COUNT(*) AS n FROM (SELECT p.id FROM payments p LEFT JOIN payment_allocations a ON a.payment_id = p.id
                                      GROUP BY p.id, p.amount HAVING COALESCE(SUM(a.amount), 0) <> p.amount) x`,
  },
  {
    key: 'customers',
    label: "Every customer's due equals their unpaid bills",
    sql: `SELECT COUNT(*) AS n FROM customers c
           WHERE c.current_due <> (SELECT COALESCE(SUM(s.due_amount), 0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed')`,
  },
  {
    key: 'advance',
    label: 'Every advance balance equals its history',
    sql: `SELECT COUNT(*) AS n FROM customers c
           WHERE c.advance_balance <> (SELECT COALESCE(SUM(m.amount), 0) FROM customer_advance_movements m WHERE m.customer_id = c.id)`,
  },
  {
    key: 'purchases',
    label: 'Every purchase bill equals its payments',
    sql: `SELECT COUNT(*) AS n FROM purchases pu
            LEFT JOIN (SELECT a.purchase_id, SUM(a.amount) AS paid FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id
                        WHERE p.status = 'active' GROUP BY a.purchase_id) x ON x.purchase_id = pu.id
           WHERE pu.paid_amount <> COALESCE(x.paid, 0) OR pu.due_amount <> pu.total_amount - pu.paid_amount`,
  },
  {
    key: 'suppliers',
    label: "Every supplier's payable equals their unpaid bills",
    sql: `SELECT COUNT(*) AS n FROM suppliers s
           WHERE s.current_payable <> (SELECT COALESCE(SUM(pu.due_amount), 0) FROM purchases pu WHERE pu.supplier_id = s.id AND pu.status = 'active')`,
  },
  {
    key: 'commission',
    label: "Every bill's commission equals what its lines earned",
    sql: `SELECT COUNT(*) AS n FROM sales s
           WHERE (SELECT COALESCE(SUM(i.commission_amount), 0) FROM sale_items i WHERE i.sale_id = s.id)
              <> (SELECT COALESCE(SUM(e.amount), 0) FROM staff_commission_entries e WHERE e.sale_id = s.id AND e.entry_type = 'sale')`,
  },
];

/** Returns [{ key, label, problems }]: problems = number of records that do not agree. */
async function runIntegrityChecks(run) {
  const results = [];
  for (const check of CHECKS) {
    const rows = await run(check.sql);
    results.push({ key: check.key, label: check.label, problems: Number(rows[0].n) });
  }
  return results;
}

module.exports = { runIntegrityChecks };

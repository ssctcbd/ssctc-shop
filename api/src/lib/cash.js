const { toPaisa } = require('./money');

/**
 * Every transaction that records, verifies or voids money calls this FIRST,
 * before any other lock. It locks one fixed row, so such transactions run one
 * at a time and a cash closing sees each of them either wholly or not at all.
 * Taking it first, everywhere, is what keeps the lock order consistent.
 */
async function lockCashDrawer(conn) {
  await conn.execute("SELECT doc_type FROM document_counters WHERE doc_type = 'cash_drawer' FOR UPDATE");
}

/**
 * Cash that moved between two moments (DATABASE_SCHEMA.md §5.6).
 *
 * The period is (start, end]: after the previous closing (null = from the very
 * beginning) up to and including `end`. Timestamps are whole seconds, so the
 * closing holds the drawer lock until the second has passed (see cash/routes).
 * Rows are placed by when they were recorded (created_at), not by the date
 * written on them: a bill back-dated to last week still put its cash in the
 * drawer today.
 *
 * Something recorded and voided inside the same period counts for nothing.
 * Something counted by an earlier closing and voided in this period is cash
 * that went the other way now: a voided cash payment was handed back, a voided
 * cash expense or supplier payment came back in.
 *
 * Call with the cash drawer locked when the result is going to be stored.
 * Returns whole paisa.
 */
async function drawerMovements(conn, start, end) {
  const during = (column) => `${start ? `${column} > ? AND ` : ''}${column} <= ?`;
  const window = start ? [start, end] : [end];
  const sum = async (sql, params) => toPaisa((await conn.query(sql, params))[0][0].total);

  const payments = (kind) =>
    sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM payments WHERE method = 'cash' AND kind = ? AND status = 'active' AND ${during('created_at')}`, [kind, ...window]);

  const figures = {
    cashSales: await payments('sale'),
    cashDuesCollected: await payments('due_collection'),
    cashAdvanceDeposits: await sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM customer_advance_movements WHERE movement_type = 'deposit' AND method = 'cash' AND ${during('created_at')}`, window),
    cashExpenses: await sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE payment_method = 'cash' AND status = 'active' AND ${during('created_at')}`, window),
    cashSupplierPaid: await sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM supplier_payments WHERE method = 'cash' AND status = 'active' AND ${during('created_at')}`, window),
    cashVoidsIn: 0,
    cashRefunds:
      (await sum(`SELECT COALESCE(SUM(total_refund), 0) AS total FROM sale_returns WHERE refund_method = 'cash' AND ${during('created_at')}`, window)) +
      (await sum(`SELECT COALESCE(SUM(-amount), 0) AS total FROM customer_advance_movements WHERE movement_type = 'refund' AND ${during('created_at')}`, window)),
  };

  if (start) {
    const reversed = (table, method) =>
      sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM ${table} WHERE ${method} = 'cash' AND status = 'void' AND created_at <= ? AND voided_at > ? AND voided_at <= ?`, [start, start, end]);
    figures.cashRefunds += await reversed('payments', 'method');
    figures.cashVoidsIn = (await reversed('expenses', 'payment_method')) + (await reversed('supplier_payments', 'method'));
  }

  figures.cashIn = figures.cashSales + figures.cashDuesCollected + figures.cashAdvanceDeposits + figures.cashVoidsIn;
  figures.cashOut = figures.cashExpenses + figures.cashSupplierPaid + figures.cashRefunds;
  return figures;
}

/** expected = opening + everything in − everything out. May be negative if entries are missing. */
const expectedCash = (openingPaisa, figures) => openingPaisa + figures.cashIn - figures.cashOut;

module.exports = { lockCashDrawer, drawerMovements, expectedCash };

const { query } = require('../db/pool');
const { toPaisa } = require('./money');

/**
 * Sales and profit for a period, used by the dashboard and the profit report
 * so both always agree. `start` inclusive, `end` exclusive, as UTC Dates.
 *
 *   net sales    = Σ total − Σ returned         completed sales, by sale date
 *   cost         = Σ cost at the time of sale × (quantity sold − returned)
 *   gross profit = net sales − cost
 *   commission   = Σ staff commission earned on those sales, less what returns took back
 *
 * A return is counted against the sale it belongs to, whenever it happened,
 * so a bill's profit is the same in every report. Opening dues are not sales.
 * Services have no cost. Returns whole paisa.
 */
async function salesFigures(start, end) {
  const [s] = await query(
    `SELECT COUNT(*) AS bills, COALESCE(SUM(subtotal), 0) AS subtotal, COALESCE(SUM(discount_amount), 0) AS discount,
            COALESCE(SUM(total_amount), 0) AS total, COALESCE(SUM(returned_amount), 0) AS returned, COALESCE(SUM(due_amount), 0) AS due
       FROM sales WHERE status = 'completed' AND sale_type = 'sale' AND sale_date >= ? AND sale_date < ?`,
    [start, end],
  );
  const [c] = await query(
    `SELECT COALESCE(SUM(COALESCE(i.cost_price_snapshot, 0) * (i.quantity - COALESCE(r.quantity, 0))), 0) AS cost,
            COALESCE(SUM(i.cost_price_snapshot IS NULL OR i.cost_price_snapshot = 0), 0) AS uncosted
       FROM sale_items i
       JOIN sales s ON s.id = i.sale_id
       LEFT JOIN (SELECT sale_item_id, SUM(quantity) AS quantity FROM sale_return_items GROUP BY sale_item_id) r ON r.sale_item_id = i.id
      WHERE i.item_type = 'product' AND s.status = 'completed' AND s.sale_type = 'sale' AND s.sale_date >= ? AND s.sale_date < ?`,
    [start, end],
  );
  // A voided sale's commission is cancelled by its own sale_void entry; it is left out with the sale.
  const [k] = await query(
    `SELECT COALESCE(SUM(e.amount), 0) AS commission FROM staff_commission_entries e JOIN sales s ON s.id = e.sale_id
      WHERE e.entry_type IN ('sale', 'sale_return') AND s.status = 'completed' AND s.sale_type = 'sale' AND s.sale_date >= ? AND s.sale_date < ?`,
    [start, end],
  );
  const total = toPaisa(s.total);
  const returned = toPaisa(s.returned);
  const cost = toPaisa(c.cost);
  return {
    bills: Number(s.bills),
    subtotal: toPaisa(s.subtotal),
    discount: toPaisa(s.discount),
    total,
    returned,
    netSales: total - returned,
    due: toPaisa(s.due),
    cost,
    grossProfit: total - returned - cost,
    commission: toPaisa(k.commission),
    // Product lines sold with no cost price recorded: their profit is overstated.
    uncostedLines: Number(c.uncosted),
  };
}

/** Expenses that still stand, by the date written on them. Whole paisa. */
async function expensesTotal(start, end) {
  const [e] = await query("SELECT COALESCE(SUM(amount), 0) AS total FROM expenses WHERE status = 'active' AND expense_date >= ? AND expense_date < ?", [start, end]);
  return toPaisa(e.total);
}

module.exports = { salesFigures, expensesTotal };

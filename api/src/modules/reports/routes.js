const express = require('express');
const { query } = require('../../db/pool');
const { validateQuery } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { salesFigures, expensesTotal } = require('../../lib/figures');
const { toPaisa, fromPaisa, fromSignedPaisa } = require('../../lib/money');
const { dayStart, dayEnd, today } = require('../../lib/dates');
const { badRequest } = require('../../lib/errors');
const { z, day } = require('../../lib/schemas');

/**
 * Reports (PROJECT_PLAN.md §4.11). Every report answers in one shape:
 *
 *   { title, from, to, columns: [{ key, label, type }], rows: [...], totals, notes }
 *
 * `type` is text | number | money | date. The screen draws a table from it and
 * `?format=csv` sends the same columns and rows as a file, so what is on
 * screen and what is exported can never differ. Reports only read.
 */
const router = express.Router();

// Dates are stored in UTC; the shop's day is Asia/Dhaka (UTC+6, no daylight saving).
const local = (column) => `CONVERT_TZ(${column}, '+00:00', '+06:00')`;
const PERIODS = { day: '%Y-%m-%d', month: '%Y-%m' };
const period = (column, groupBy) => `DATE_FORMAT(${local(column)}, '${PERIODS[groupBy]}')`;

const range = { from: day.optional(), to: day.optional(), format: z.enum(['json', 'csv']).default('json') };

/** The period asked for; this month so far when nothing is given. */
function resolveRange(q) {
  const to = q.to || today();
  const from = q.from || `${to.slice(0, 8)}01`;
  if (from > to) throw badRequest('The "from" date is after the "to" date.');
  return { from, to, start: dayStart(from), end: dayEnd(to) };
}

const sumColumn = (rows, key) => fromSignedPaisa(rows.reduce((sum, r) => sum + signedPaisa(r[key]), 0));
const signedPaisa = (value) => (String(value).startsWith('-') ? -toPaisa(String(value).slice(1)) : toPaisa(value));
/** Totals row: the given text in the first column, sums under every money and number column named. */
function totalsOf(columns, rows, keys, label = 'Total') {
  const totals = { [columns[0].key]: label };
  for (const key of keys) {
    const column = columns.find((c) => c.key === key);
    totals[key] = column.type === 'money' ? sumColumn(rows, key) : rows.reduce((sum, r) => sum + Number(r[key]), 0);
  }
  return totals;
}

// --- CSV ---------------------------------------------------------------------

/** A text cell that a spreadsheet would run as a formula is made plain text. */
const csvCell = (value, type) => {
  let text = value === null || value === undefined ? '' : String(value);
  if (type === 'text' && /^[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

function toCsv(report) {
  const line = (row) => report.columns.map((c) => csvCell(row[c.key], c.type)).join(',');
  const lines = [report.columns.map((c) => csvCell(c.label, 'label')).join(','), ...report.rows.map(line)];
  if (report.totals) lines.push(line(report.totals));
  // The byte-order mark makes Excel read the file as UTF-8.
  return `﻿${lines.join('\r\n')}\r\n`;
}

function send(req, res, name, report) {
  if (req.q.format !== 'csv') return res.json(report);
  const span = report.from ? `-${report.from}-to-${report.to}` : `-${today()}`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}${span}.csv"`);
  res.send(toCsv(report));
}

// --- sales -------------------------------------------------------------------

const SALE = "s.status = 'completed' AND s.sale_type = 'sale' AND s.sale_date >= ? AND s.sale_date < ?";

router.get('/reports/sales', staffWith('reports.view'), validateQuery(z.strictObject({ ...range, groupBy: z.enum(['day', 'month', 'item', 'category']).default('day') })), async (req, res) => {
  const r = resolveRange(req.q);
  const { groupBy } = req.q;
  let report;

  if (groupBy === 'day' || groupBy === 'month') {
    const rows = await query(
      `SELECT ${period('s.sale_date', groupBy)} AS period, COUNT(*) AS bills, SUM(s.subtotal) AS subtotal, SUM(s.discount_amount) AS discount,
              SUM(s.total_amount) AS total, SUM(s.returned_amount) AS returned, SUM(s.total_amount - s.returned_amount) AS net, SUM(s.due_amount) AS due
         FROM sales s WHERE ${SALE} GROUP BY period ORDER BY period`,
      [r.start, r.end],
    );
    const columns = [
      { key: 'period', label: groupBy === 'day' ? 'Date' : 'Month', type: groupBy === 'day' ? 'date' : 'text' },
      { key: 'bills', label: 'Bills', type: 'number' },
      { key: 'subtotal', label: 'Subtotal', type: 'money' },
      { key: 'discount', label: 'Discount', type: 'money' },
      { key: 'total', label: 'Bill total', type: 'money' },
      { key: 'returned', label: 'Returned', type: 'money' },
      { key: 'net', label: 'Net sales', type: 'money' },
      { key: 'due', label: 'Still due', type: 'money' },
    ];
    const data = rows.map((x) => ({ ...x, bills: Number(x.bills) }));
    report = { title: groupBy === 'day' ? 'Sales by day' : 'Sales by month', columns, rows: data, totals: totalsOf(columns, data, ['bills', 'subtotal', 'discount', 'total', 'returned', 'net', 'due']) };
  } else {
    // Line amounts are before any discount given on the whole bill.
    const returned = '(SELECT sale_item_id, SUM(quantity) AS quantity, SUM(line_total) AS amount FROM sale_return_items GROUP BY sale_item_id) r';
    const rows =
      groupBy === 'item'
        ? await query(
            `SELECT i.name_snapshot AS label, IF(i.item_type = 'product', 'Product', 'Service') AS kind, SUM(i.quantity) AS quantity,
                    COALESCE(SUM(r.quantity), 0) AS returned, SUM(i.line_total) AS amount
               FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN ${returned} ON r.sale_item_id = i.id
              WHERE ${SALE} GROUP BY i.item_type, i.product_id, i.service_id, i.name_snapshot ORDER BY amount DESC, label`,
            [r.start, r.end],
          )
        : await query(
            `SELECT COALESCE(c.name, CONCAT('Service: ', sv.service_type)) AS label, IF(i.item_type = 'product', 'Product', 'Service') AS kind,
                    SUM(i.quantity) AS quantity, COALESCE(SUM(r.quantity), 0) AS returned, SUM(i.line_total) AS amount
               FROM sale_items i JOIN sales s ON s.id = i.sale_id
               LEFT JOIN products p ON p.id = i.product_id LEFT JOIN categories c ON c.id = p.category_id
               LEFT JOIN services sv ON sv.id = i.service_id
               LEFT JOIN ${returned} ON r.sale_item_id = i.id
              WHERE ${SALE} GROUP BY label, kind ORDER BY amount DESC, label`,
            [r.start, r.end],
          );
    const columns = [
      { key: 'name', label: groupBy === 'item' ? 'Product or service' : 'Category', type: 'text' },
      { key: 'kind', label: 'Type', type: 'text' },
      { key: 'quantity', label: 'Quantity sold', type: 'number' },
      { key: 'returned', label: 'Returned', type: 'number' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ];
    const data = rows.map((x) => ({ name: x.label, kind: x.kind, quantity: Number(x.quantity), returned: Number(x.returned), amount: x.amount }));
    report = {
      title: groupBy === 'item' ? 'Sales by product and service' : 'Sales by category',
      columns,
      rows: data,
      totals: totalsOf(columns, data, ['quantity', 'returned', 'amount']),
      notes: ['Amounts are price × quantity, before any discount given on the whole bill and before returns.'],
    };
  }
  send(req, res, `sales-by-${groupBy}`, { ...report, from: r.from, to: r.to });
});

// --- profit and loss ---------------------------------------------------------

router.get('/reports/profit-loss', staffWith('reports.financial'), validateQuery(z.strictObject(range)), async (req, res) => {
  const r = resolveRange(req.q);
  const f = await salesFigures(r.start, r.end);
  const expenses = await query(
    `SELECT c.name, SUM(e.amount) AS amount FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.status = 'active' AND e.expense_date >= ? AND e.expense_date < ? GROUP BY c.id, c.name ORDER BY amount DESC, c.name`,
    [r.start, r.end],
  );
  const totalExpenses = await expensesTotal(r.start, r.end);
  const line = (label, paisa, kind = '') => ({ label, amount: fromSignedPaisa(paisa), kind });

  const rows = [
    line('Sales before discount', f.subtotal),
    line('Discounts given', -f.discount),
    line('Returned goods', -f.returned),
    line('Net sales', f.netSales, 'subtotal'),
    line('Cost of the goods sold', -f.cost),
    line('Gross profit', f.grossProfit, 'subtotal'),
    line('Staff commission', -f.commission),
    ...expenses.map((e) => line(`Expense: ${e.name}`, -toPaisa(e.amount))),
    line('Total expenses', -totalExpenses, 'subtotal'),
  ];
  send(req, res, 'profit-and-loss', {
    title: 'Profit and loss',
    from: r.from,
    to: r.to,
    columns: [
      { key: 'label', label: 'Line', type: 'text' },
      { key: 'amount', label: 'Amount', type: 'money' },
    ],
    rows,
    totals: { label: 'Net profit', amount: fromSignedPaisa(f.grossProfit - f.commission - totalExpenses) },
    notes: [
      'Gross profit = net sales − cost of the goods sold. Net profit = gross profit − staff commission − expenses.',
      'Staff commission is what the sales in this period earned, whether or not it has been paid out yet.',
      'Sales are counted by the date of the bill, whether or not the money has been collected. A return is taken off the bill it belongs to.',
      'Cost is the cost price recorded when each item was sold. Services have no cost.',
      ...(f.uncostedLines > 0 ? [`${f.uncostedLines} product line(s) in this period were sold with no cost price recorded, so the profit shown is too high. Enter cost prices on the Products screen.`] : []),
    ],
  });
});

// --- expenses ----------------------------------------------------------------

router.get('/reports/expenses', staffWith('reports.view'), validateQuery(z.strictObject({ ...range, groupBy: z.enum(['day', 'month', 'category']).default('category') })), async (req, res) => {
  const r = resolveRange(req.q);
  const { groupBy } = req.q;
  const group = groupBy === 'category' ? 'c.name' : period('e.expense_date', groupBy);
  const rows = await query(
    `SELECT ${group} AS label, COUNT(*) AS vouchers, SUM(e.amount) AS amount,
            SUM(IF(e.payment_method = 'cash', e.amount, 0)) AS cash, SUM(IF(e.payment_method <> 'cash', e.amount, 0)) AS other
       FROM expenses e JOIN expense_categories c ON c.id = e.category_id
      WHERE e.status = 'active' AND e.expense_date >= ? AND e.expense_date < ?
      GROUP BY label ORDER BY ${groupBy === 'category' ? 'amount DESC, label' : 'label'}`,
    [r.start, r.end],
  );
  const columns = [
    { key: 'name', label: { day: 'Date', month: 'Month', category: 'Category' }[groupBy], type: groupBy === 'day' ? 'date' : 'text' },
    { key: 'vouchers', label: 'Vouchers', type: 'number' },
    { key: 'cash', label: 'Paid in cash', type: 'money' },
    { key: 'other', label: 'Paid by other means', type: 'money' },
    { key: 'amount', label: 'Total', type: 'money' },
  ];
  const data = rows.map((x) => ({ name: x.label, vouchers: Number(x.vouchers), cash: x.cash, other: x.other, amount: x.amount }));
  send(req, res, `expenses-by-${groupBy}`, { title: `Expenses by ${groupBy}`, from: r.from, to: r.to, columns, rows: data, totals: totalsOf(columns, data, ['vouchers', 'cash', 'other', 'amount']), notes: ['Voided expenses are left out.'] });
});

// --- payments collected ------------------------------------------------------

router.get('/reports/payments', staffWith('reports.view'), validateQuery(z.strictObject({ ...range, groupBy: z.enum(['day', 'month']).default('day') })), async (req, res) => {
  const r = resolveRange(req.q);
  const { groupBy } = req.q;
  const method = (name) => `SUM(IF(method = '${name}', amount, 0)) AS ${name}`;
  // Money that came in: verified payments, and advance deposits. Spending an
  // advance balance is shown apart, because that money was counted when deposited.
  const rows = await query(
    `SELECT period, ${['cash', 'bkash', 'nagad', 'bank_transfer', 'other'].map(method).join(', ')},
            SUM(IF(method <> 'customer_advance', amount, 0)) AS received, SUM(IF(method = 'customer_advance', amount, 0)) AS from_advance
       FROM (
         SELECT ${period('payment_date', groupBy)} AS period, method, amount FROM payments
          WHERE status = 'active' AND is_verified = 1 AND payment_date >= ? AND payment_date < ?
         UNION ALL
         SELECT ${period('created_at', groupBy)} AS period, method, amount FROM customer_advance_movements
          WHERE movement_type = 'deposit' AND created_at >= ? AND created_at < ?
       ) money GROUP BY period ORDER BY period`,
    [r.start, r.end, r.start, r.end],
  );
  const columns = [
    { key: 'period', label: groupBy === 'day' ? 'Date' : 'Month', type: groupBy === 'day' ? 'date' : 'text' },
    { key: 'cash', label: 'Cash', type: 'money' },
    { key: 'bkash', label: 'bKash', type: 'money' },
    { key: 'nagad', label: 'Nagad', type: 'money' },
    { key: 'bank_transfer', label: 'Bank', type: 'money' },
    { key: 'other', label: 'Other', type: 'money' },
    { key: 'received', label: 'Total received', type: 'money' },
    { key: 'from_advance', label: 'Paid from advance', type: 'money' },
  ];
  send(req, res, `payments-by-${groupBy}`, {
    title: `Payments collected by ${groupBy}`,
    from: r.from,
    to: r.to,
    columns,
    rows,
    totals: totalsOf(columns, rows, ['cash', 'bkash', 'nagad', 'bank_transfer', 'other', 'received', 'from_advance']),
    notes: ['Verified payments and advance deposits. Voided and unverified payments are left out. "Paid from advance" is not new money: it was counted on the day it was deposited.'],
  });
});

// --- customer dues with aging ------------------------------------------------

router.get('/reports/dues', staffWith('reports.view'), validateQuery(z.strictObject({ format: range.format })), async (req, res) => {
  const age = `DATEDIFF(${local('UTC_TIMESTAMP()')}, ${local('s.sale_date')})`;
  const bucket = (condition) => `COALESCE(SUM(IF(${condition}, s.due_amount, 0)), 0)`;
  const rows = await query(
    `SELECT c.name, c.phone, COUNT(*) AS bills, DATE_FORMAT(${local('MIN(s.sale_date)')}, '%Y-%m-%d') AS oldest,
            ${bucket(`${age} <= 30`)} AS d30, ${bucket(`${age} BETWEEN 31 AND 60`)} AS d60, ${bucket(`${age} BETWEEN 61 AND 90`)} AS d90, ${bucket(`${age} > 90`)} AS older,
            SUM(s.due_amount) AS due
       FROM sales s JOIN customers c ON c.id = s.customer_id
      WHERE s.status = 'completed' AND s.due_amount > 0
      GROUP BY c.id, c.name, c.phone ORDER BY due DESC, c.name`,
  );
  const columns = [
    { key: 'name', label: 'Customer', type: 'text' },
    { key: 'phone', label: 'Mobile', type: 'text' },
    { key: 'bills', label: 'Unpaid bills', type: 'number' },
    { key: 'oldest', label: 'Oldest unpaid', type: 'date' },
    { key: 'd30', label: '0–30 days', type: 'money' },
    { key: 'd60', label: '31–60 days', type: 'money' },
    { key: 'd90', label: '61–90 days', type: 'money' },
    { key: 'older', label: 'Over 90 days', type: 'money' },
    { key: 'due', label: 'Total due', type: 'money' },
  ];
  const data = rows.map((x) => ({ ...x, bills: Number(x.bills) }));
  send(req, res, 'customer-dues', { title: 'Customer dues and their age', columns, rows: data, totals: totalsOf(columns, data, ['bills', 'd30', 'd60', 'd90', 'older', 'due']), notes: ['As of now. Age is counted from the date of each unpaid bill.'] });
});

// --- supplier payables -------------------------------------------------------

router.get('/reports/suppliers', staffWith('reports.view'), validateQuery(z.strictObject({ format: range.format })), async (req, res) => {
  const rows = await query(
    `SELECT s.name, s.company, s.phone, COUNT(*) AS bills, DATE_FORMAT(${local('MIN(pu.purchase_date)')}, '%Y-%m-%d') AS oldest, SUM(pu.due_amount) AS payable
       FROM purchases pu JOIN suppliers s ON s.id = pu.supplier_id
      WHERE pu.status = 'active' AND pu.due_amount > 0
      GROUP BY s.id, s.name, s.company, s.phone ORDER BY payable DESC, s.name`,
  );
  const columns = [
    { key: 'name', label: 'Supplier', type: 'text' },
    { key: 'company', label: 'Company', type: 'text' },
    { key: 'phone', label: 'Mobile', type: 'text' },
    { key: 'bills', label: 'Unpaid bills', type: 'number' },
    { key: 'oldest', label: 'Oldest unpaid', type: 'date' },
    { key: 'payable', label: 'Owed', type: 'money' },
  ];
  const data = rows.map((x) => ({ ...x, bills: Number(x.bills) }));
  send(req, res, 'supplier-payables', { title: 'Supplier payables', columns, rows: data, totals: totalsOf(columns, data, ['bills', 'payable']), notes: ['As of now.'] });
});

// --- cash closings -----------------------------------------------------------

router.get('/reports/cash-closings', staffWith('reports.view'), validateQuery(z.strictObject(range)), async (req, res) => {
  const r = resolveRange(req.q);
  const rows = await query(
    `SELECT DATE_FORMAT(c.closing_date, '%Y-%m-%d') AS date, c.opening_cash AS opening,
            c.cash_sales + c.cash_dues_collected + c.cash_advance_deposits + c.cash_voids_in AS cash_in,
            c.cash_expenses + c.cash_supplier_paid + c.cash_commission_paid + c.cash_refunds AS cash_out,
            c.expected_closing_cash AS expected, c.actual_closing_cash AS counted, c.difference, c.cash_withdrawn AS withdrawn,
            c.actual_closing_cash - c.cash_withdrawn AS left_in, u.name AS closed_by, c.note
       FROM daily_cash_closings c JOIN users u ON u.id = c.closed_by
      WHERE c.closing_date >= ? AND c.closing_date <= ? ORDER BY c.id`,
    [r.from, r.to],
  );
  const columns = [
    { key: 'date', label: 'Date', type: 'date' },
    { key: 'opening', label: 'Opening cash', type: 'money' },
    { key: 'cash_in', label: 'Cash in', type: 'money' },
    { key: 'cash_out', label: 'Cash out', type: 'money' },
    { key: 'expected', label: 'Expected', type: 'money' },
    { key: 'counted', label: 'Counted', type: 'money' },
    { key: 'difference', label: 'Difference', type: 'money' },
    { key: 'withdrawn', label: 'Owner took', type: 'money' },
    { key: 'left_in', label: 'Left in drawer', type: 'money' },
    { key: 'closed_by', label: 'Closed by', type: 'text' },
    { key: 'note', label: 'Note', type: 'text' },
  ];
  send(req, res, 'cash-closings', { title: 'Cash closings', from: r.from, to: r.to, columns, rows, totals: totalsOf(columns, rows, ['cash_in', 'cash_out', 'difference', 'withdrawn']), notes: ['A negative difference means the drawer was short.'] });
});

// --- stock -------------------------------------------------------------------

router.get('/reports/stock', staffWith('reports.view'), validateQuery(z.strictObject({ ...range, view: z.enum(['levels', 'low', 'movements']).default('levels') })), async (req, res) => {
  const { view } = req.q;

  if (view === 'movements') {
    const r = resolveRange(req.q);
    const qty = (types, sign = 1) => `COALESCE(SUM(IF(m.movement_type IN (${types.map((t) => `'${t}'`).join(',')}), ${sign} * m.quantity, 0)), 0)`;
    const rows = await query(
      `SELECT p.sku, p.name, ${qty(['opening', 'stock_in', 'purchase'])} AS received, ${qty(['sale'], -1)} AS sold,
              ${qty(['sale_return', 'sale_void'])} AS came_back, ${qty(['adjustment_in', 'adjustment_out'])} AS adjusted,
              SUM(m.quantity) AS net, p.stock_qty AS stock
         FROM inventory_movements m JOIN products p ON p.id = m.product_id
        WHERE m.created_at >= ? AND m.created_at < ?
        GROUP BY p.id, p.sku, p.name, p.stock_qty ORDER BY p.name`,
      [r.start, r.end],
    );
    const columns = [
      { key: 'sku', label: 'Code', type: 'text' },
      { key: 'name', label: 'Product', type: 'text' },
      { key: 'received', label: 'Received', type: 'number' },
      { key: 'sold', label: 'Sold', type: 'number' },
      { key: 'came_back', label: 'Returned or voided', type: 'number' },
      { key: 'adjusted', label: 'Adjusted', type: 'number' },
      { key: 'net', label: 'Net change', type: 'number' },
      { key: 'stock', label: 'In stock now', type: 'number' },
    ];
    const data = rows.map((x) => Object.fromEntries(Object.entries(x).map(([k, v]) => [k, k === 'sku' || k === 'name' ? v : Number(v)])));
    return send(req, res, 'stock-movements', { title: 'Stock movements', from: r.from, to: r.to, columns, rows: data, totals: totalsOf(columns, data, ['received', 'sold', 'came_back', 'adjusted', 'net']), notes: ['"Adjusted" includes stock taken back out when a purchase bill is voided.'] });
  }

  const rows = await query(
    `SELECT p.sku, p.name, c.name AS category, p.stock_qty AS stock, p.low_stock_threshold AS threshold, p.cost_price AS cost, p.price,
            p.stock_qty * p.cost_price AS value
       FROM products p JOIN categories c ON c.id = p.category_id
      WHERE p.status = 'active' AND p.track_stock = 1 ${view === 'low' ? 'AND p.stock_qty <= p.low_stock_threshold' : ''}
      ORDER BY ${view === 'low' ? 'p.stock_qty - p.low_stock_threshold, ' : ''}p.name`,
  );
  const columns = [
    { key: 'sku', label: 'Code', type: 'text' },
    { key: 'name', label: 'Product', type: 'text' },
    { key: 'category', label: 'Category', type: 'text' },
    { key: 'stock', label: 'In stock', type: 'number' },
    { key: 'threshold', label: 'Low-stock level', type: 'number' },
    { key: 'cost', label: 'Cost price', type: 'money' },
    { key: 'price', label: 'Selling price', type: 'money' },
    { key: 'value', label: 'Stock value at cost', type: 'money' },
  ];
  send(req, res, view === 'low' ? 'low-stock' : 'stock-levels', { title: view === 'low' ? 'Low stock' : 'Stock levels', columns, rows, totals: totalsOf(columns, rows, ['stock', 'value']), notes: ['As of now. Archived products and products whose stock is not tracked are left out.'] });
});

module.exports = router;
module.exports.toCsv = toCsv;

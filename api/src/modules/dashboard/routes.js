const express = require('express');
const { pool, query } = require('../../db/pool');
const { staffWith } = require('../../middleware/session');
const { salesFigures, expensesTotal } = require('../../lib/figures');
const { cashDay, cashDate, drawerMovements, expectedCash } = require('../../lib/cash');
const { toPaisa, fromPaisa, fromSignedPaisa } = require('../../lib/money');
const { dayStart, dayEnd, today } = require('../../lib/dates');
const { getSetting } = require('../../lib/settings');

// The dashboard (PROJECT_PLAN.md §4.1). One request; each block is included
// only for a user whose permissions cover the screen it summarises, so the
// dashboard never shows more than the menu would.
const router = express.Router();

router.get('/dashboard', staffWith('dashboard.view'), async (req, res) => {
  const can = (permission) => req.user.permissions.includes(permission);
  const day = today();
  const start = dayStart(day);
  const end = dayEnd(day);
  const out = { date: day };

  if (can('sales.view')) {
    const f = await salesFigures(start, end);
    out.sales = { bills: f.bills, netSales: fromPaisa(f.netSales), newDues: fromPaisa(f.due) };
    if (can('reports.financial')) {
      const expenses = await expensesTotal(start, end);
      out.profit = { grossProfit: fromSignedPaisa(f.grossProfit), commission: fromPaisa(f.commission), expenses: fromPaisa(expenses), netProfit: fromSignedPaisa(f.grossProfit - f.commission - expenses), uncostedLines: f.uncostedLines };
    }
    const recent = await query(
      `SELECT id, invoice_no, customer_name, sale_date, total_amount, due_amount, payment_status, status
         FROM sales WHERE sale_type = 'sale' ORDER BY sale_date DESC, id DESC LIMIT 8`,
    );
    out.recentSales = recent.map((s) => ({ id: s.id, invoiceNo: s.invoice_no, customerName: s.customer_name, saleDate: s.sale_date, totalAmount: s.total_amount, dueAmount: s.due_amount, paymentStatus: s.payment_status, status: s.status }));
  }

  if (can('payments.view')) {
    // Money that came in today: verified payments (not spending of an advance
    // balance, which was counted when deposited) and advance deposits.
    const [collected] = await query(
      `SELECT (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'active' AND is_verified = 1 AND method <> 'customer_advance' AND payment_date >= ? AND payment_date < ?)
            + (SELECT COALESCE(SUM(amount), 0) FROM customer_advance_movements WHERE movement_type = 'deposit' AND created_at >= ? AND created_at < ?) AS total`,
      [start, end, start, end],
    );
    const [waiting] = await query("SELECT COUNT(*) AS payments, COALESCE(SUM(amount), 0) AS amount FROM payments WHERE status = 'active' AND is_verified = 0");
    out.payments = { collectedToday: collected.total, unverifiedCount: Number(waiting.payments), unverifiedAmount: waiting.amount };
  }

  if (can('expenses.view')) out.expensesToday = fromPaisa(await expensesTotal(start, end));

  if (can('customers.view')) {
    const [dues] = await query('SELECT COUNT(*) AS customers, COALESCE(SUM(current_due), 0) AS total FROM customers WHERE current_due > 0');
    const top = await query('SELECT id, name, phone, current_due FROM customers WHERE current_due > 0 ORDER BY current_due DESC, id LIMIT 5');
    out.dues = { customers: Number(dues.customers), total: dues.total, top: top.map((c) => ({ id: c.id, name: c.name, phone: c.phone, currentDue: c.current_due })) };
  }

  if (can('suppliers.view')) {
    const [payables] = await query('SELECT COUNT(*) AS suppliers, COALESCE(SUM(current_payable), 0) AS total FROM suppliers WHERE current_payable > 0');
    out.payables = { suppliers: Number(payables.suppliers), total: payables.total };
  }

  if (can('inventory.view')) {
    const [low] = await query("SELECT COUNT(*) AS products FROM products WHERE status = 'active' AND track_stock = 1 AND stock_qty <= low_stock_threshold");
    out.lowStock = Number(low.products);
  }

  if (can('cash.view')) {
    const d = await cashDay(pool);
    out.cash = { status: d.isOpen ? 'open' : 'closed', carried: d.carried === null ? null : fromPaisa(d.carried), lastClosingDate: d.lastClosing ? d.lastClosing.closing_day : null };
    if (d.isOpen) {
      const [clock] = await pool.query('SELECT UTC_TIMESTAMP() AS now');
      const figures = await drawerMovements(pool, d.opening.opened_at, clock[0].now);
      Object.assign(out.cash, { openingDate: d.opening.opening_day, stale: d.opening.opening_day < cashDate(), expected: fromSignedPaisa(expectedCash(toPaisa(d.opening.counted_cash), figures)) });
    }
  }

  if (can('commission.view_own')) {
    const [mine] = await query(
      `SELECT COALESCE(SUM(amount), 0) AS balance,
              COALESCE(SUM(IF(entry_type IN ('sale', 'sale_void', 'sale_return') AND created_at >= ? AND created_at < ?, amount, 0)), 0) AS today
         FROM staff_commission_entries WHERE user_id = ?`,
      [start, end, req.user.id],
    );
    out.myCommission = { earnedToday: mine.today, balance: mine.balance };
  }

  if (can('system.backup')) {
    const download = await getSetting('backup.last_download');
    const run = await getSetting('backup.last_run');
    out.backup = { lastDownloadAt: download ? download.at : null, lastRunAt: run ? run.at : null, lastRunOk: run ? Boolean(run.ok) : null };
  }

  res.json(out);
});

module.exports = router;

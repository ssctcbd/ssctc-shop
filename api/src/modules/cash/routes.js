const express = require('express');
const { pool, query, transaction } = require('../../db/pool');
const { validateBody, validateQuery } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { lockCashDrawer, drawerMovements, expectedCash } = require('../../lib/cash');
const { toPaisa, fromPaisa } = require('../../lib/money');
const { today } = require('../../lib/dates');
const { badRequest, conflict } = require('../../lib/errors');
const { z, money, optionalText, day, paging } = require('../../lib/schemas');

// The cash drawer (DATABASE_SCHEMA.md §5.6). A closing covers everything
// recorded since the previous closing; what is left in the drawer afterwards
// is the next period's opening cash.
const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
/** Expected cash and the difference can be negative; the other figures cannot. */
const signed = (paisa) => (paisa < 0 ? `-${fromPaisa(-paisa)}` : fromPaisa(paisa));
const signedPaisa = (text) => (String(text).startsWith('-') ? -toPaisa(String(text).slice(1)) : toPaisa(text));

const CLOSING_SELECT = "SELECT c.*, DATE_FORMAT(c.closing_date, '%Y-%m-%d') AS closing_day, u.name AS user_name FROM daily_cash_closings c JOIN users u ON u.id = c.closed_by";

const closingToApi = (row) => ({
  id: row.id,
  closingDate: row.closing_day,
  periodStart: row.period_start,
  closedAt: row.closed_at,
  openingCash: row.opening_cash,
  cashSales: row.cash_sales,
  cashDuesCollected: row.cash_dues_collected,
  cashAdvanceDeposits: row.cash_advance_deposits,
  cashVoidsIn: row.cash_voids_in,
  cashExpenses: row.cash_expenses,
  cashSupplierPaid: row.cash_supplier_paid,
  cashRefunds: row.cash_refunds,
  expectedCash: row.expected_closing_cash,
  actualCash: row.actual_closing_cash,
  difference: row.difference,
  cashWithdrawn: row.cash_withdrawn,
  // What stayed in the drawer: the next period's opening cash.
  carriedForward: fromPaisa(toPaisa(row.actual_closing_cash) - toPaisa(row.cash_withdrawn)),
  note: row.note,
  closedByName: row.user_name,
});

const figuresToApi = (f) => ({
  cashSales: fromPaisa(f.cashSales),
  cashDuesCollected: fromPaisa(f.cashDuesCollected),
  cashAdvanceDeposits: fromPaisa(f.cashAdvanceDeposits),
  cashVoidsIn: fromPaisa(f.cashVoidsIn),
  cashExpenses: fromPaisa(f.cashExpenses),
  cashSupplierPaid: fromPaisa(f.cashSupplierPaid),
  cashRefunds: fromPaisa(f.cashRefunds),
});

/** The drawer as it stands at this moment, read on `conn`. */
async function currentDrawer(conn) {
  const [last] = await conn.query(`${CLOSING_SELECT} ORDER BY c.id DESC LIMIT 1`);
  const [clock] = await conn.query('SELECT UTC_TIMESTAMP() AS now');
  const previous = last[0] || null;
  const start = previous ? previous.closed_at : null;
  const end = clock[0].now;
  const figures = await drawerMovements(conn, start, end);
  // Before the first closing there is no known opening cash: it is typed in then.
  const opening = previous ? toPaisa(previous.actual_closing_cash) - toPaisa(previous.cash_withdrawn) : null;
  return { previous, start, end, figures, opening };
}

router.get('/cash-register/current', staffWith('cash.view'), async (_req, res) => {
  const d = await currentDrawer(pool);
  // Money that arrived by other means in the same period: not in the drawer,
  // shown so the day's takings can be read in one place.
  const during = `${d.start ? 'created_at > ? AND ' : ''}created_at <= ?`;
  const window = d.start ? [d.start, d.end] : [d.end];
  const [others] = await pool.query(
    `SELECT method, COALESCE(SUM(amount), 0) AS total FROM (
       SELECT method, amount FROM payments WHERE status = 'active' AND is_verified = 1 AND method NOT IN ('cash', 'customer_advance') AND ${during}
       UNION ALL
       SELECT method, amount FROM customer_advance_movements WHERE movement_type = 'deposit' AND method <> 'cash' AND ${during}
     ) received GROUP BY method`,
    [...window, ...window],
  );
  res.json({
    periodStart: d.start,
    asOf: d.end,
    today: today(),
    closedToday: Boolean(d.previous && d.previous.closing_day === today()),
    lastClosing: d.previous ? closingToApi(d.previous) : null,
    openingCash: d.opening === null ? null : fromPaisa(d.opening),
    ...figuresToApi(d.figures),
    // With no opening cash yet, this is the movement alone.
    expectedCash: signed(expectedCash(d.opening ?? 0, d.figures)),
    otherMethods: Object.fromEntries(others.map((o) => [o.method, o.total])),
  });
});

router.get('/cash-register/history', staffWith('cash.view'), validateQuery(z.strictObject({ ...paging })), async (req, res) => {
  const { page, pageSize } = req.q;
  const [totals] = await query('SELECT COUNT(*) AS total FROM daily_cash_closings');
  const rows = await query(`${CLOSING_SELECT} ORDER BY c.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  res.json({ items: rows.map(closingToApi), page, pageSize, total: Number(totals.total) });
});

const closeSchema = z.strictObject({
  // The cash counted in the drawer.
  actualCash: money,
  // Taken out of the drawer after counting (to the bank, or home). The rest
  // stays as the next opening cash.
  withdrawn: money.default('0.00'),
  // Only for the very first closing; afterwards it is carried from the last one.
  openingCash: money.optional(),
  // The expected cash the screen showed. If a sale was saved in between, the
  // closing is refused so the count is made against the right figure.
  expectedCash: z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Not a valid amount.'),
  date: day.optional(),
  note: optionalText(500),
});

/**
 * Close the cash drawer. One transaction: lock the cash drawer (so no sale,
 * payment or expense is half-way through) → read the previous closing → add
 * up the cash that moved since → compare with the count → store the figures,
 * the difference and who closed → audit. A closing is never edited or deleted.
 */
router.post('/cash-register/close', staffWith('cash.close'), validateBody(closeSchema), async (req, res) => {
  const b = req.body;
  const closingDate = b.date || today();
  if (closingDate > today()) throw fieldError('date', 'The closing date cannot be in the future.');
  if (toPaisa(b.withdrawn) > toPaisa(b.actualCash)) throw fieldError('withdrawn', 'More than the cash counted in the drawer.');

  let closingId;
  try {
    closingId = await transaction(async (conn) => {
      await lockCashDrawer(conn);
      const d = await currentDrawer(conn);

      if (d.previous && closingDate <= d.previous.closing_day) {
        throw conflict(
          d.previous.closing_day === today()
            ? "Today's cash has already been closed. Anything recorded since then will be in tomorrow's closing."
            : `The cash was already closed for ${d.previous.closing_day}. Choose a later date.`,
        );
      }
      if (d.previous && b.openingCash !== undefined && toPaisa(b.openingCash) !== d.opening) throw fieldError('openingCash', `The opening cash is ${fromPaisa(d.opening)}, carried from the last closing.`);
      if (!d.previous && b.openingCash === undefined) throw fieldError('openingCash', 'Enter the cash that was in the drawer before the first sale.');

      const opening = d.previous ? d.opening : toPaisa(b.openingCash);
      const expected = expectedCash(opening, d.figures);
      if (expected !== signedPaisa(b.expectedCash)) {
        throw conflict(`The expected cash is now ${signed(expected)}: something was recorded while this screen was open. Check the figures and count again.`, { expectedCash: signed(expected) });
      }
      const actual = toPaisa(b.actualCash);
      const difference = actual - expected;
      if (difference !== 0 && !b.note) throw fieldError('note', `The count is ${difference < 0 ? 'short' : 'over'} by ${fromPaisa(Math.abs(difference))}. Write a note explaining it.`);

      const f = figuresToApi(d.figures);
      const [result] = await conn.execute(
        `INSERT INTO daily_cash_closings
           (closing_date, period_start, opening_cash, cash_sales, cash_dues_collected, cash_advance_deposits, cash_voids_in, cash_expenses, cash_supplier_paid, cash_refunds,
            expected_closing_cash, actual_closing_cash, difference, cash_withdrawn, note, closed_by, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [closingDate, d.start, fromPaisa(opening), f.cashSales, f.cashDuesCollected, f.cashAdvanceDeposits, f.cashVoidsIn, f.cashExpenses, f.cashSupplierPaid, f.cashRefunds, signed(expected), b.actualCash, signed(difference), b.withdrawn, b.note, req.user.id, d.end],
      );
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'cash.close',
        entityType: 'cash_closing',
        entityId: result.insertId,
        newValues: { date: closingDate, opening: fromPaisa(opening), expected: signed(expected), actual: b.actualCash, difference: signed(difference), withdrawn: b.withdrawn, note: b.note },
        ip: req.ip,
      });
      // Rows are stamped in whole seconds. Keep the drawer locked until this
      // second is over, so whatever is recorded next is stamped after closed_at
      // and falls in the next period.
      await conn.query('DO SLEEP(1)');
      return result.insertId;
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('The cash has already been closed for that date.');
    throw err;
  }
  const rows = await query(`${CLOSING_SELECT} WHERE c.id = ?`, [closingId]);
  res.status(201).json({ closing: closingToApi(rows[0]) });
});

module.exports = router;

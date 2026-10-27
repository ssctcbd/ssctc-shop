const express = require('express');
const { pool, query, transaction } = require('../../db/pool');
const { validateBody, validateQuery } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { lockCashDrawer, cashDay, cashDate, drawerMovements, expectedCash, OPENING_SELECT, CLOSING_SELECT } = require('../../lib/cash');
const { toPaisa, fromPaisa, fromSignedPaisa: signed } = require('../../lib/money');
const { badRequest, conflict } = require('../../lib/errors');
const { z, money, positiveMoney, optionalText, paging } = require('../../lib/schemas');

// The cash day (DATABASE_SCHEMA.md §5.6). In the morning the drawer is counted
// against what the last closing left in it, and the day is opened. Through the
// day every sale, payment and expense is recorded against it. At night the
// drawer is counted again and handed over: the closing. The Owner then takes
// what they want out of it; what stays is what the next morning should find.
const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const signedPaisa = (text) => (String(text).startsWith('-') ? -toPaisa(String(text).slice(1)) : toPaisa(text));
const signedAmount = z.string().regex(/^-?\d{1,10}(\.\d{1,2})?$/, 'Not a valid amount.');

const openingToApi = (row) => ({
  id: row.id,
  openingDate: row.opening_day,
  openedAt: row.opened_at,
  carriedCash: row.carried_cash,
  countedCash: row.counted_cash,
  difference: row.difference,
  note: row.note,
  openedByName: row.user_name,
});

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
  cashCommissionPaid: row.cash_commission_paid,
  cashRefunds: row.cash_refunds,
  expectedCash: row.expected_closing_cash,
  actualCash: row.actual_closing_cash,
  difference: row.difference,
  // Taken by the Owner after the closing (a running total of the receipts).
  cashWithdrawn: row.cash_withdrawn,
  // What stayed in the drawer: what the next morning should find.
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
  cashCommissionPaid: fromPaisa(f.cashCommissionPaid),
  cashRefunds: fromPaisa(f.cashRefunds),
});

/** The drawer as it stands at this moment, read on `conn`. */
async function currentDrawer(conn) {
  const day = await cashDay(conn);
  const [clock] = await conn.query('SELECT UTC_TIMESTAMP() AS now');
  const end = clock[0].now;
  if (!day.isOpen) return { ...day, end };
  const start = day.opening.opened_at;
  const figures = await drawerMovements(conn, start, end);
  const opening = toPaisa(day.opening.counted_cash);
  return { ...day, start, end, figures, openingPaisa: opening, expected: expectedCash(opening, figures) };
}

/** Receipts the Owner took from the drawer after `closingId`. */
async function receiptsFor(conn, closingIds) {
  if (closingIds.length === 0) return new Map();
  const [rows] = await conn.query(
    'SELECT r.id, r.closing_id, r.amount, r.note, r.received_at, u.name AS user_name FROM owner_cash_receipts r JOIN users u ON u.id = r.received_by WHERE r.closing_id IN (?) ORDER BY r.id',
    [closingIds],
  );
  const byClosing = new Map();
  for (const r of rows) {
    if (!byClosing.has(r.closing_id)) byClosing.set(r.closing_id, []);
    byClosing.get(r.closing_id).push({ id: r.id, amount: r.amount, note: r.note, receivedAt: r.received_at, receivedByName: r.user_name });
  }
  return byClosing;
}

router.get('/cash-register/current', staffWith('cash.view'), async (req, res) => {
  const d = await currentDrawer(pool);
  const lastClosing = d.lastClosing ? { ...closingToApi(d.lastClosing), receipts: (await receiptsFor(pool, [d.lastClosing.id])).get(d.lastClosing.id) || [] } : null;
  const out = {
    status: d.isOpen ? 'open' : 'closed',
    cashDate: cashDate(),
    asOf: d.end,
    lastClosing,
    // What the next opening should find in the drawer (null before the very first day).
    carriedCash: d.carried === null ? null : fromPaisa(d.carried),
  };
  if (!d.isOpen) return res.json(out);

  // Money that arrived by other means in the same period: not in the drawer,
  // shown so the day's takings can be read in one place.
  const window = [d.start, d.end];
  const [others] = await pool.query(
    `SELECT method, COALESCE(SUM(amount), 0) AS total FROM (
       SELECT method, amount FROM payments WHERE status = 'active' AND is_verified = 1 AND method NOT IN ('cash', 'customer_advance') AND created_at > ? AND created_at <= ?
       UNION ALL
       SELECT method, amount FROM customer_advance_movements WHERE movement_type = 'deposit' AND method <> 'cash' AND created_at > ? AND created_at <= ?
     ) received GROUP BY method`,
    [...window, ...window],
  );
  Object.assign(out, {
    opening: openingToApi(d.opening),
    periodStart: d.start,
    // Opened on an earlier day and never closed: it must be closed before today's work.
    stale: d.opening.opening_day < cashDate(),
    openingCash: fromPaisa(d.openingPaisa),
    ...figuresToApi(d.figures),
    expectedCash: signed(d.expected),
    otherMethods: Object.fromEntries(others.map((o) => [o.method, o.total])),
  });

  // Who did what today, for the Owner reading the hand-over.
  if (req.user.permissions.includes('commission.manage')) {
    const [staff] = await pool.query(
      `SELECT u.id, u.name,
              (SELECT COUNT(*) FROM sales s WHERE s.created_by = u.id AND s.status = 'completed' AND s.sale_type = 'sale' AND s.created_at > ? AND s.created_at <= ?) AS bills,
              (SELECT COALESCE(SUM(s.total_amount), 0) FROM sales s WHERE s.created_by = u.id AND s.status = 'completed' AND s.sale_type = 'sale' AND s.created_at > ? AND s.created_at <= ?) AS sold,
              (SELECT COALESCE(SUM(e.amount), 0) FROM staff_commission_entries e WHERE e.user_id = u.id AND e.entry_type IN ('sale', 'sale_void', 'sale_return') AND e.created_at > ? AND e.created_at <= ?) AS commission
         FROM users u ORDER BY u.name`,
      [...window, ...window, ...window],
    );
    // Commission entries are signed: a day can end below zero if older bills were voided in it.
    out.byStaff = staff.filter((s) => Number(s.bills) > 0 || Number(s.commission) !== 0).map((s) => ({ userId: s.id, name: s.name, bills: Number(s.bills), sold: s.sold, commission: s.commission }));
  }
  res.json(out);
});

router.get('/cash-register/history', staffWith('cash.view'), validateQuery(z.strictObject({ ...paging })), async (req, res) => {
  const { page, pageSize } = req.q;
  const [totals] = await query('SELECT COUNT(*) AS total FROM daily_cash_closings');
  const rows = await query(`${CLOSING_SELECT} ORDER BY c.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`);
  const openingIds = rows.map((r) => r.opening_id).filter(Boolean);
  const openings = openingIds.length ? (await pool.query(`${OPENING_SELECT} WHERE o.id IN (?)`, [openingIds]))[0] : [];
  const openingById = new Map(openings.map((o) => [o.id, openingToApi(o)]));
  const receipts = await receiptsFor(pool, rows.map((r) => r.id));
  res.json({
    items: rows.map((r) => ({ ...closingToApi(r), opening: openingById.get(r.opening_id) || null, receipts: receipts.get(r.id) || [] })),
    page,
    pageSize,
    total: Number(totals.total),
  });
});

/**
 * Hold the drawer lock until the current second is over. Rows are stamped in
 * whole seconds: whatever is recorded next is then stamped after the moment
 * just stored, and falls on the right side of it.
 */
const waitOutTheSecond = (conn) => conn.query('DO SLEEP(1)');

const openSchema = z.strictObject({
  // The cash counted in the drawer this morning.
  countedCash: money,
  // What the screen said should be there. If the Owner took cash in between,
  // the opening is refused so the count is made against the right figure.
  carriedCash: money.nullable(),
  note: optionalText(500),
});

/**
 * Open the cash day. One transaction: lock the cash drawer → check it is closed
 * → compare the count with what the last closing left in it → store → audit.
 * From this moment sales, payments and expenses can be recorded.
 */
router.post('/cash-register/open', staffWith('cash.open'), validateBody(openSchema), async (req, res) => {
  const b = req.body;
  const date = cashDate();

  let openingId;
  try {
    openingId = await transaction(async (conn) => {
      await lockCashDrawer(conn);
      const day = await cashDay(conn);
      if (day.isOpen) throw conflict(day.opening.opening_day === date ? "Today's cash is already open." : `The cash day of ${day.opening.opening_day} is still open. Close it first.`);
      if (day.lastClosing && day.lastClosing.closing_day >= date) throw conflict(`The cash for ${day.lastClosing.closing_day} has already been handed over. The next day can be opened tomorrow morning.`);
      if (day.lastOpening && day.lastOpening.opening_day >= date) throw conflict('The cash has already been opened and closed today. The next day can be opened tomorrow morning.');

      const carried = day.carried;
      if ((carried === null) !== (b.carriedCash === null) || (carried !== null && carried !== toPaisa(b.carriedCash))) {
        throw conflict(`The cash left in the drawer is now ${carried === null ? 'not known' : fromPaisa(carried)}: it changed while this screen was open. Check the figure and count again.`, {
          carriedCash: carried === null ? null : fromPaisa(carried),
        });
      }
      const counted = toPaisa(b.countedCash);
      const difference = carried === null ? null : counted - carried;
      if (difference && !b.note) throw fieldError('note', `The count is ${difference < 0 ? 'short' : 'over'} by ${fromPaisa(Math.abs(difference))}. Write a note explaining it.`);

      const [clock] = await conn.query('SELECT UTC_TIMESTAMP() AS now');
      const [result] = await conn.execute(
        'INSERT INTO daily_cash_openings (opening_date, previous_closing_id, carried_cash, counted_cash, difference, note, opened_by, opened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        [date, day.lastClosing ? day.lastClosing.id : null, carried === null ? null : fromPaisa(carried), b.countedCash, difference === null ? null : signed(difference), b.note, req.user.id, clock[0].now],
      );
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'cash.open',
        entityType: 'cash_opening',
        entityId: result.insertId,
        newValues: { date, carried: carried === null ? null : fromPaisa(carried), counted: b.countedCash, difference: difference === null ? null : signed(difference), note: b.note },
        ip: req.ip,
      });
      await waitOutTheSecond(conn);
      return result.insertId;
    });
  } catch (err) {
    // Two people opened at once: the unique keys let one through.
    if (err.code === 'ER_DUP_ENTRY') throw conflict("Today's cash has just been opened by someone else.");
    throw err;
  }
  const rows = await query(`${OPENING_SELECT} WHERE o.id = ?`, [openingId]);
  res.status(201).json({ opening: openingToApi(rows[0]) });
});

const closeSchema = z.strictObject({
  // The cash counted in the drawer.
  actualCash: money,
  // The expected cash the screen showed. If a sale was saved in between, the
  // closing is refused so the count is made against the right figure.
  expectedCash: signedAmount,
  note: optionalText(500),
});

/**
 * Close the cash day: the hand-over. One transaction: lock the cash drawer (so
 * no sale, payment or expense is half-way through) → check the day is open →
 * add up the cash that moved since it was opened → compare with the count →
 * store the figures, the difference and who closed → audit. A closing is never
 * edited or deleted. Afterwards nothing that moves money can be recorded until
 * the next opening.
 */
router.post('/cash-register/close', staffWith('cash.close'), validateBody(closeSchema), async (req, res) => {
  const b = req.body;

  let closingId;
  try {
    closingId = await transaction(async (conn) => {
      await lockCashDrawer(conn);
      const d = await currentDrawer(conn);
      if (!d.isOpen) throw conflict(d.lastClosing ? `The cash for ${d.lastClosing.closing_day} has already been handed over.` : 'The cash has not been opened yet.');

      if (d.expected !== signedPaisa(b.expectedCash)) {
        throw conflict(`The expected cash is now ${signed(d.expected)}: something was recorded while this screen was open. Check the figures and count again.`, { expectedCash: signed(d.expected) });
      }
      const actual = toPaisa(b.actualCash);
      const difference = actual - d.expected;
      if (difference !== 0 && !b.note) throw fieldError('note', `The count is ${difference < 0 ? 'short' : 'over'} by ${fromPaisa(Math.abs(difference))}. Write a note explaining it.`);

      // The day the drawer was opened, even when it is closed after midnight.
      const closingDate = d.opening.opening_day;
      const f = figuresToApi(d.figures);
      const [result] = await conn.execute(
        `INSERT INTO daily_cash_closings
           (closing_date, period_start, opening_id, opening_cash, cash_sales, cash_dues_collected, cash_advance_deposits, cash_voids_in, cash_expenses, cash_supplier_paid, cash_commission_paid, cash_refunds,
            expected_closing_cash, actual_closing_cash, difference, cash_withdrawn, note, closed_by, closed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
        [closingDate, d.start, d.opening.id, fromPaisa(d.openingPaisa), f.cashSales, f.cashDuesCollected, f.cashAdvanceDeposits, f.cashVoidsIn, f.cashExpenses, f.cashSupplierPaid, f.cashCommissionPaid, f.cashRefunds, signed(d.expected), b.actualCash, signed(difference), b.note, req.user.id, d.end],
      );
      await writeAudit({
        conn,
        actorUserId: req.user.id,
        action: 'cash.close',
        entityType: 'cash_closing',
        entityId: result.insertId,
        newValues: { date: closingDate, opening: fromPaisa(d.openingPaisa), expected: signed(d.expected), actual: b.actualCash, difference: signed(difference), note: b.note },
        ip: req.ip,
      });
      await waitOutTheSecond(conn);
      return result.insertId;
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('The cash has already been closed for that date.');
    throw err;
  }
  const rows = await query(`${CLOSING_SELECT} WHERE c.id = ?`, [closingId]);
  res.status(201).json({ closing: { ...closingToApi(rows[0]), receipts: [] } });
});

const receiveSchema = z.strictObject({
  amount: positiveMoney,
  note: optionalText(255),
});

/**
 * The Owner takes cash from the drawer that was handed over. Only between a
 * closing and the next opening, so it never disturbs a day being counted; it
 * may be done more than once, or not at all, and whatever stays is what the
 * next morning starts from.
 */
router.post('/cash-register/receive', staffWith('cash.receive'), validateBody(receiveSchema), async (req, res) => {
  const b = req.body;
  const receiptId = await transaction(async (conn) => {
    await lockCashDrawer(conn);
    const day = await cashDay(conn);
    if (day.isOpen) throw conflict('Cash can be received only after the cash day has been closed (handed over), and before the next one is opened.');
    if (!day.lastClosing) throw conflict('The cash has never been closed, so there is nothing handed over to receive.');
    if (toPaisa(b.amount) > day.carried) throw fieldError('amount', `Only ${fromPaisa(day.carried)} is left in the drawer.`);

    const closing = day.lastClosing;
    const [result] = await conn.execute('INSERT INTO owner_cash_receipts (closing_id, amount, note, received_by) VALUES (?, ?, ?, ?)', [closing.id, b.amount, b.note, req.user.id]);
    await conn.execute('UPDATE daily_cash_closings SET cash_withdrawn = cash_withdrawn + ? WHERE id = ?', [b.amount, closing.id]);
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'cash.receive',
      entityType: 'cash_closing',
      entityId: closing.id,
      newValues: { date: closing.closing_day, amount: b.amount, leftInDrawer: fromPaisa(day.carried - toPaisa(b.amount)), note: b.note },
      ip: req.ip,
    });
    return result.insertId;
  });
  const day = await cashDay(pool);
  res.status(201).json({ receipt: { id: receiptId, amount: b.amount }, closing: closingToApi(day.lastClosing), carriedCash: fromPaisa(day.carried) });
});

module.exports = router;

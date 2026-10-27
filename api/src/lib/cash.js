const { toPaisa } = require('./money');
const { AppError } = require('./errors');

/**
 * Every transaction that records, verifies or voids money calls this FIRST,
 * before any other lock. It locks one fixed row, so such transactions run one
 * at a time and a cash closing sees each of them either wholly or not at all.
 * Taking it first, everywhere, is what keeps the lock order consistent.
 */
async function lockCashDrawer(conn) {
  await conn.execute("SELECT doc_type FROM document_counters WHERE doc_type = 'cash_drawer' FOR UPDATE");
}

// A shop day runs until 4 in the morning, so work done shortly after midnight
// still belongs to the day that was opened the evening before.
const DAY_ENDS_AT_HOUR = 4;

/** The shop day it is now, "YYYY-MM-DD" in Dhaka time. */
function cashDate() {
  return new Date(Date.now() + (6 - DAY_ENDS_AT_HOUR) * 3600 * 1000).toISOString().slice(0, 10);
}

const OPENING_SELECT = "SELECT o.*, DATE_FORMAT(o.opening_date, '%Y-%m-%d') AS opening_day, u.name AS user_name FROM daily_cash_openings o JOIN users u ON u.id = o.opened_by";
const CLOSING_SELECT = "SELECT c.*, DATE_FORMAT(c.closing_date, '%Y-%m-%d') AS closing_day, u.name AS user_name FROM daily_cash_closings c JOIN users u ON u.id = c.closed_by";

/**
 * Where the cash day stands, read on `conn`:
 *
 *   open     the latest opening follows the latest closing (or, the very first
 *            day, there is no closing): work is being recorded against it.
 *   closed   the latest closing is newer than the latest opening, or nothing
 *            has ever been opened. Only the Owner's receipt from the drawer is
 *            possible until the next opening.
 *
 * `carried` is what the last closing left in the drawer: the cash counted then,
 * less what the Owner has taken since. It is what the next morning should find.
 */
async function cashDay(conn) {
  const [closings] = await conn.query(`${CLOSING_SELECT} ORDER BY c.id DESC LIMIT 1`);
  const [openings] = await conn.query(`${OPENING_SELECT} ORDER BY o.id DESC LIMIT 1`);
  const lastClosing = closings[0] || null;
  const lastOpening = openings[0] || null;
  const isOpen = Boolean(lastOpening) && (lastOpening.previous_closing_id ?? null) === (lastClosing ? lastClosing.id : null);
  return {
    lastClosing,
    lastOpening,
    isOpen,
    opening: isOpen ? lastOpening : null,
    carried: lastClosing ? toPaisa(lastClosing.actual_closing_cash) - toPaisa(lastClosing.cash_withdrawn) : null,
  };
}

/**
 * lockCashDrawer for anything that moves money: also refuses unless today's
 * cash day is open. Returns the cash day.
 */
async function lockOpenDrawer(conn) {
  await lockCashDrawer(conn);
  const day = await cashDay(conn);
  if (!day.isOpen) {
    throw new AppError(
      409,
      'cash_day_closed',
      day.lastClosing
        ? `The cash was handed over for ${day.lastClosing.closing_day}. Open the cash for today (count the drawer) on the Cash screen before recording anything.`
        : 'Open the cash for today first: count the drawer on the Cash screen.',
    );
  }
  if (day.opening.opening_day < cashDate()) {
    throw new AppError(409, 'cash_day_stale', `The cash day of ${day.opening.opening_day} was never closed. Close it on the Cash screen (count the drawer), then open today.`);
  }
  return day;
}

/**
 * Cash that moved between two moments (DATABASE_SCHEMA.md §5.6).
 *
 * The period is (start, end]: after the cash day was opened (null = from the
 * very beginning) up to and including `end`. Timestamps are whole seconds, so
 * opening and closing hold the drawer lock until the second has passed (see
 * cash/routes). Rows are placed by when they were recorded (created_at), not by
 * the date written on them: a bill back-dated to last week still put its cash
 * in the drawer today.
 *
 * Something recorded and voided inside the same period counts for nothing.
 * Something counted by an earlier closing and voided in this period is cash
 * that went the other way now: a voided cash payment was handed back, a voided
 * cash expense, supplier payment or commission payout came back in.
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
    cashCommissionPaid: await sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM commission_payouts WHERE method = 'cash' AND status = 'active' AND ${during('created_at')}`, window),
    cashVoidsIn: 0,
    cashRefunds:
      (await sum(`SELECT COALESCE(SUM(total_refund), 0) AS total FROM sale_returns WHERE refund_method = 'cash' AND ${during('created_at')}`, window)) +
      (await sum(`SELECT COALESCE(SUM(-amount), 0) AS total FROM customer_advance_movements WHERE movement_type = 'refund' AND ${during('created_at')}`, window)),
  };

  if (start) {
    const reversed = (table, method) =>
      sum(`SELECT COALESCE(SUM(amount), 0) AS total FROM ${table} WHERE ${method} = 'cash' AND status = 'void' AND created_at <= ? AND voided_at > ? AND voided_at <= ?`, [start, start, end]);
    figures.cashRefunds += await reversed('payments', 'method');
    figures.cashVoidsIn = (await reversed('expenses', 'payment_method')) + (await reversed('supplier_payments', 'method')) + (await reversed('commission_payouts', 'method'));
  }

  figures.cashIn = figures.cashSales + figures.cashDuesCollected + figures.cashAdvanceDeposits + figures.cashVoidsIn;
  figures.cashOut = figures.cashExpenses + figures.cashSupplierPaid + figures.cashCommissionPaid + figures.cashRefunds;
  return figures;
}

/** expected = opening + everything in − everything out. May be negative if entries are missing. */
const expectedCash = (openingPaisa, figures) => openingPaisa + figures.cashIn - figures.cashOut;

module.exports = { lockCashDrawer, lockOpenDrawer, cashDay, cashDate, drawerMovements, expectedCash, OPENING_SELECT, CLOSING_SELECT };

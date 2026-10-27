const { toPaisa, fromPaisa } = require('./money');

/**
 * Staff commission. A rate is set by the Owner on each service and on product
 * categories: a percentage of what the line sold for, or a fixed amount per
 * unit. A product earns at its category's rate; a sub-category with no rate of
 * its own uses its parent's. No rate set = no commission.
 *
 * Commission is earned when the sale is recorded, by the user who recorded it
 * (if that user earns commission), and fixed on each line then: changing a rate
 * later never changes what was already earned. Voiding the sale takes it all
 * back; a return takes back the share of the returned units.
 */

/** { type, value } in force for a category row with its parent's columns joined in as parent_*. */
const categoryRate = (row) =>
  row.commission_type ? { type: row.commission_type, value: row.commission_value } : row.parent_commission_type ? { type: row.parent_commission_type, value: row.parent_commission_value } : null;

/** Rates for the categories of these products: Map(productId → rate | null). */
async function productRates(conn, productIds) {
  if (productIds.length === 0) return new Map();
  const [rows] = await conn.query(
    `SELECT p.id, c.commission_type, c.commission_value, pc.commission_type AS parent_commission_type, pc.commission_value AS parent_commission_value
       FROM products p JOIN categories c ON c.id = p.category_id LEFT JOIN categories pc ON pc.id = c.parent_id
      WHERE p.id IN (?)`,
    [productIds],
  );
  return new Map(rows.map((r) => [r.id, categoryRate(r)]));
}

/**
 * What one line earns, in paisa. `valuePaisa` is what the line sold for after
 * its share of the sale's discount. A percentage is of that value; a fixed
 * rate is per unit. Never more than the line brought in.
 */
function lineCommission(rate, { valuePaisa, quantity }) {
  if (!rate) return 0;
  const raw = rate.type === 'percent' ? Math.round((valuePaisa * toPaisa(rate.value)) / 10000) : toPaisa(rate.value) * quantity;
  return Math.max(0, Math.min(raw, valuePaisa));
}

/** Append one signed row to a user's commission ledger. */
async function addCommissionEntry(conn, { userId, deltaPaisa, entryType, saleId = null, saleReturnId = null, payoutId = null, note = null, createdBy }) {
  if (!Number.isSafeInteger(deltaPaisa) || deltaPaisa === 0) throw new TypeError('deltaPaisa must be a non-zero integer');
  const amount = deltaPaisa > 0 ? fromPaisa(deltaPaisa) : `-${fromPaisa(-deltaPaisa)}`;
  await conn.execute(
    'INSERT INTO staff_commission_entries (user_id, entry_type, amount, sale_id, sale_return_id, payout_id, note, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [userId, entryType, amount, saleId, saleReturnId, payoutId, note ? note.slice(0, 255) : null, createdBy],
  );
}

/** Does this user earn commission on the sales they record? */
async function earnsCommission(conn, userId) {
  const [rows] = await conn.execute('SELECT commission_enabled FROM users WHERE id = ?', [userId]);
  return Boolean(rows[0] && rows[0].commission_enabled);
}

/** A user's commission balance, in paisa (signed: it can fall below zero after a void). */
async function commissionBalance(conn, userId) {
  const [rows] = await conn.execute('SELECT COALESCE(SUM(amount), 0) AS total FROM staff_commission_entries WHERE user_id = ?', [userId]);
  const text = String(rows[0].total);
  return text.startsWith('-') ? -toPaisa(text.slice(1)) : toPaisa(text);
}

/** Take back everything a sale earned, for whoever earned it. */
async function reverseSaleCommission(conn, { saleId, note, createdBy }) {
  const [rows] = await conn.execute('SELECT user_id, SUM(amount) AS total FROM staff_commission_entries WHERE sale_id = ? GROUP BY user_id ORDER BY user_id', [saleId]);
  for (const r of rows) {
    const text = String(r.total);
    const paisa = text.startsWith('-') ? -toPaisa(text.slice(1)) : toPaisa(text);
    if (paisa !== 0) await addCommissionEntry(conn, { userId: r.user_id, deltaPaisa: -paisa, entryType: 'sale_void', saleId, note, createdBy });
  }
}

/**
 * The commission share of `quantity` units returned from a line that earned
 * `linePaisa` on `soldQuantity` units, of which `returnedBefore` were already
 * returned. Computed as a difference of running totals, so returning a line in
 * several parts takes back exactly what it earned, to the paisa.
 */
function returnedShare(linePaisa, soldQuantity, returnedBefore, quantity) {
  const upTo = (n) => Math.round((linePaisa * n) / soldQuantity);
  return upTo(returnedBefore + quantity) - upTo(returnedBefore);
}

module.exports = { productRates, lineCommission, addCommissionEntry, earnsCommission, commissionBalance, reverseSaleCommission, returnedShare };

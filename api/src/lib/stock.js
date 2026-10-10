const { conflict, notFound } = require('./errors');

/**
 * The ONLY code that changes products.stock_qty (DATABASE_SCHEMA.md §5.1).
 *
 * It updates the balance and appends the inventory_movements row on the caller's
 * transaction connection, so the two always commit or roll back together.
 * `delta` is signed: positive adds stock, negative removes it.
 *
 * Removal is a conditional UPDATE (… AND stock_qty >= ?): if two requests race
 * for the last units, exactly one changes a row and the other is refused.
 * CHECK (stock_qty >= 0) in the table is the backstop.
 *
 * Callers that move several products in one transaction must do so in
 * ascending product id, so concurrent transactions cannot deadlock.
 */
async function applyStockMovement(conn, { productId, delta, movementType, unitCost = null, referenceType, referenceId = null, note = null, userId }) {
  if (!Number.isInteger(delta) || delta === 0) throw new TypeError('delta must be a non-zero integer');

  const [result] =
    delta > 0
      ? await conn.execute('UPDATE products SET stock_qty = stock_qty + ? WHERE id = ? AND track_stock = 1', [delta, productId])
      : await conn.execute('UPDATE products SET stock_qty = stock_qty - ? WHERE id = ? AND track_stock = 1 AND stock_qty >= ?', [-delta, productId, -delta]);

  // The UPDATE above locked the row (or it does not exist), so this read is stable.
  const [rows] = await conn.execute('SELECT name, track_stock, stock_qty FROM products WHERE id = ?', [productId]);
  const product = rows[0];

  if (result.affectedRows !== 1) {
    if (!product) throw notFound('Product not found.');
    if (!product.track_stock) throw conflict(`Stock is not tracked for "${product.name}".`);
    throw conflict(`Not enough stock of "${product.name}": ${product.stock_qty} available.`, { productId, available: product.stock_qty });
  }

  const [movement] = await conn.execute(
    `INSERT INTO inventory_movements
       (product_id, movement_type, quantity, balance_after, unit_cost, reference_type, reference_id, note, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [productId, movementType, delta, product.stock_qty, unitCost, referenceType, referenceId, note, userId],
  );
  return { movementId: movement.insertId, balanceAfter: product.stock_qty };
}

module.exports = { applyStockMovement };

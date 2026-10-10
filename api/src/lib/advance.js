const { fromPaisa } = require('./money');
const { conflict, notFound } = require('./errors');

/**
 * The ONLY code that changes customers.advance_balance.
 *
 * Works like applyStockMovement: it updates the balance and appends the
 * customer_advance_movements row on the caller's transaction connection, so
 * the balance always equals the sum of its ledger. `deltaPaisa` is signed.
 * Spending is a conditional UPDATE (… AND advance_balance >= ?), so two tills
 * cannot both spend the same money.
 */
async function applyAdvanceMovement(conn, { customerId, deltaPaisa, movementType, method = null, reference = null, receiptNo = null, paymentId = null, saleReturnId = null, note = null, idempotencyKey = null, userId }) {
  if (!Number.isSafeInteger(deltaPaisa) || deltaPaisa === 0) throw new TypeError('deltaPaisa must be a non-zero integer');
  const amount = fromPaisa(Math.abs(deltaPaisa));

  const [result] =
    deltaPaisa > 0
      ? await conn.execute('UPDATE customers SET advance_balance = advance_balance + ? WHERE id = ?', [amount, customerId])
      : await conn.execute('UPDATE customers SET advance_balance = advance_balance - ? WHERE id = ? AND advance_balance >= ?', [amount, customerId, amount]);

  const [rows] = await conn.execute('SELECT name, advance_balance FROM customers WHERE id = ?', [customerId]);
  const customer = rows[0];
  if (result.affectedRows !== 1) {
    if (!customer) throw notFound('Customer not found.');
    throw conflict(`Not enough advance balance for ${customer.name}: ${customer.advance_balance} available.`, { available: customer.advance_balance });
  }

  const [movement] = await conn.execute(
    `INSERT INTO customer_advance_movements
       (customer_id, movement_type, amount, balance_after, method, reference, receipt_no, payment_id, sale_return_id, note, idempotency_key, created_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [customerId, movementType, deltaPaisa > 0 ? amount : `-${amount}`, customer.advance_balance, method, reference, receiptNo, paymentId, saleReturnId, note, idempotencyKey, userId],
  );
  return { movementId: movement.insertId, balanceAfter: customer.advance_balance };
}

module.exports = { applyAdvanceMovement };

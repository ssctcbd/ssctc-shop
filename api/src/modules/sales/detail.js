const { query } = require('../../db/pool');

/**
 * One sale with its lines, payments and returns, shaped for a reader.
 *
 * `audience` decides what is left out:
 *   'staff'     everything except cost (cost only when `withCost`)
 *   'customer'  the customer's own bill: no cost, no internal note, no void
 *               reason, no staff names on payments, no QR token
 * Both the staff screens and the customer portal read through this one
 * function, so the portal can never show a field the rule here withholds.
 */
async function loadSale(where, params, { audience = 'staff', withCost = false } = {}) {
  const rows = await query(
    `SELECT s.*, u.name AS user_name, vu.name AS voided_by_name
       FROM sales s JOIN users u ON u.id = s.created_by LEFT JOIN users vu ON vu.id = s.voided_by
      WHERE ${where}`,
    params,
  );
  const s = rows[0];
  if (!s) return null;
  const staff = audience === 'staff';

  const items = await query(
    `SELECT i.*, COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri WHERE ri.sale_item_id = i.id), 0) AS returned_quantity
       FROM sale_items i WHERE i.sale_id = ? ORDER BY i.id`,
    [s.id],
  );
  const payments = await query(
    `SELECT p.id, p.receipt_no, p.payment_date, p.method, p.amount AS payment_amount, a.amount, p.reference, p.is_verified, p.status, p.void_reason, u.name AS user_name
       FROM payment_allocations a JOIN payments p ON p.id = a.payment_id JOIN users u ON u.id = p.created_by
      WHERE a.sale_id = ? ORDER BY p.id`,
    [s.id],
  );
  const returns = await query('SELECT r.*, u.name AS user_name FROM sale_returns r JOIN users u ON u.id = r.created_by WHERE r.sale_id = ? ORDER BY r.id', [s.id]);
  const returnItems = returns.length
    ? await query(
        `SELECT ri.return_id, ri.quantity, ri.line_total, i.name_snapshot, i.unit_snapshot
           FROM sale_return_items ri JOIN sale_items i ON i.id = ri.sale_item_id
          WHERE ri.return_id IN (${returns.map(() => '?').join(',')}) ORDER BY ri.id`,
        returns.map((r) => r.id),
      )
    : [];

  return {
    id: s.id,
    invoiceNo: s.invoice_no,
    saleType: s.sale_type,
    customerId: s.customer_id,
    customerName: s.customer_name,
    customerPhone: s.customer_phone,
    saleDate: s.sale_date,
    status: s.status,
    subtotal: s.subtotal,
    discountAmount: s.discount_amount,
    totalAmount: s.total_amount,
    returnedAmount: s.returned_amount,
    refundedAmount: s.refunded_amount,
    paidAmount: s.paid_amount,
    unverifiedAmount: s.unverified_amount,
    dueAmount: s.due_amount,
    paymentStatus: s.payment_status,
    createdByName: s.user_name,
    voidedAt: s.voided_at,
    ...(staff ? { note: s.note, voidReason: s.void_reason, voidedByName: s.voided_by_name ?? null, qrToken: s.qr_token } : {}),
    items: items.map((i) => ({
      id: i.id,
      type: i.item_type,
      name: i.name_snapshot,
      sku: i.sku_snapshot,
      unit: i.unit_snapshot,
      unitPrice: i.unit_price,
      quantity: i.quantity,
      returnedQuantity: Number(i.returned_quantity),
      warranty: i.warranty,
      serialNo: i.serial_no,
      lineTotal: i.line_total,
      ...(staff ? { productId: i.product_id, serviceId: i.service_id } : {}),
      ...(staff && withCost ? { costPrice: i.cost_price_snapshot } : {}),
    })),
    payments: payments
      // A customer sees their payments, not the shop's corrected mistakes.
      .filter((p) => staff || p.status === 'active')
      .map((p) => ({
        id: p.id,
        receiptNo: p.receipt_no,
        paymentDate: p.payment_date,
        method: p.method,
        amount: p.amount, // the part of the payment applied to this sale
        reference: p.reference,
        isVerified: Boolean(p.is_verified),
        status: p.status,
        ...(staff ? { paymentAmount: p.payment_amount, voidReason: p.void_reason, recordedByName: p.user_name } : {}),
      })),
    returns: returns.map((r) => ({
      id: r.id,
      returnNo: r.return_no,
      returnDate: r.return_date,
      returnAmount: r.return_amount,
      refundAmount: r.total_refund,
      refundMethod: r.refund_method,
      reason: r.reason,
      ...(staff ? { recordedByName: r.user_name } : {}),
      items: returnItems.filter((ri) => ri.return_id === r.id).map((ri) => ({ name: ri.name_snapshot, unit: ri.unit_snapshot, quantity: ri.quantity, lineTotal: ri.line_total })),
    })),
  };
}

module.exports = { loadSale };

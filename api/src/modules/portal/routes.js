const express = require('express');
const { env } = require('../../config/env');
const { validateBody } = require('../../middleware/validate');
const { requireCustomer } = require('../../middleware/session');
const { setSessionCookie, clearSessionCookie } = require('../../lib/cookies');
const { portalLoginSchema, changePinSchema } = require('./schemas');
const service = require('./service');
const { query } = require('../../db/pool');
const { notFound } = require('../../lib/errors');
const { loadSale } = require('../sales/detail');

// Customer portal. Nothing in this router may use requireStaff or read data
// that is not filtered by req.customer.id.
const router = express.Router();

const clientInfo = (req) => ({ ip: req.ip, userAgent: String(req.headers['user-agent'] || '').slice(0, 255) });

router.post('/login', validateBody(portalLoginSchema), async (req, res) => {
  const { token, expiresAt } = await service.login({ ...req.body, ...clientInfo(req) });
  setSessionCookie(res, env.PORTAL_COOKIE_NAME, token, expiresAt);
  res.json({ ok: true });
});

router.post('/logout', requireCustomer, async (req, res) => {
  await service.logout(req.customerSessionId);
  clearSessionCookie(res, env.PORTAL_COOKIE_NAME);
  res.json({ ok: true });
});

router.get('/me', requireCustomer, (req, res) => {
  res.json({ customer: req.customer });
});

router.post('/change-pin', requireCustomer, validateBody(changePinSchema), async (req, res) => {
  await service.changePin({ customerId: req.customer.id, sessionId: req.customerSessionId, ...req.body, ip: req.ip });
  res.json({ ok: true });
});

// --- the customer's own records (read-only) ---------------------------------
// Every query below is filtered by req.customer.id, which comes from the
// session and never from the request. Bills are read through loadSale with
// audience 'customer', which withholds cost, internal notes and staff details.

const numericId = (value) => (/^\d{1,15}$/.test(value) ? Number(value) : null);

// Shop name and contact lines for the bill header. Public: it is what is
// printed on every invoice.
router.get('/shop', async (_req, res) => {
  const rows = await query("SELECT setting_key, value FROM settings WHERE setting_key IN ('shop.name', 'shop.tagline', 'shop.address', 'shop.phone', 'invoice.footer', 'payment.bkash_number', 'payment.nagad_number')");
  res.json({ shop: Object.fromEntries(rows.map((r) => [r.setting_key, r.value])) });
});

// The QR code on an invoice opens this: that one bill, without logging in.
// The token is 128 random bits and is not derivable from the invoice number.
router.get('/view/:token', async (req, res) => {
  if (!/^[0-9a-f]{32}$/.test(req.params.token)) throw notFound('This bill link is not valid.');
  const bill = await loadSale("s.qr_token = ? AND s.sale_type = 'sale'", [req.params.token], { audience: 'customer' });
  if (!bill) throw notFound('This bill link is not valid.');
  // A link shows one bill. It never reveals which customer account it belongs to.
  delete bill.customerId;
  res.json({ bill });
});

router.get('/invoices', requireCustomer, async (req, res) => {
  const rows = await query(
    `SELECT id, invoice_no, sale_type, sale_date, status, total_amount, returned_amount, paid_amount, unverified_amount, due_amount, payment_status
       FROM sales WHERE customer_id = ? ORDER BY sale_date DESC, id DESC LIMIT 200`,
    [req.customer.id],
  );
  res.json({
    invoices: rows.map((s) => ({
      id: s.id,
      invoiceNo: s.invoice_no,
      saleType: s.sale_type,
      saleDate: s.sale_date,
      status: s.status,
      totalAmount: s.total_amount,
      returnedAmount: s.returned_amount,
      paidAmount: s.paid_amount,
      unverifiedAmount: s.unverified_amount,
      dueAmount: s.due_amount,
      paymentStatus: s.payment_status,
    })),
  });
});

router.get('/invoices/:id', requireCustomer, async (req, res) => {
  const id = numericId(req.params.id);
  // Someone else's bill and a bill that does not exist look exactly the same.
  const bill = id && (await loadSale('s.id = ? AND s.customer_id = ?', [id, req.customer.id], { audience: 'customer' }));
  if (!bill) throw notFound('Bill not found.');
  res.json({ bill });
});

// Receipts: payments the shop has confirmed.
router.get('/payments', requireCustomer, async (req, res) => {
  const rows = await query(
    `SELECT p.id, p.receipt_no, p.payment_date, p.method, p.amount, p.reference,
            (SELECT GROUP_CONCAT(s.invoice_no ORDER BY s.id SEPARATOR ', ') FROM payment_allocations a JOIN sales s ON s.id = a.sale_id WHERE a.payment_id = p.id) AS invoices
       FROM payments p
      WHERE p.customer_id = ? AND p.status = 'active' AND p.is_verified = 1
      ORDER BY p.payment_date DESC, p.id DESC LIMIT 200`,
    [req.customer.id],
  );
  res.json({ payments: rows.map((p) => ({ id: p.id, receiptNo: p.receipt_no, paymentDate: p.payment_date, method: p.method, amount: p.amount, reference: p.reference, invoices: p.invoices })) });
});

router.get('/advance', requireCustomer, async (req, res) => {
  const rows = await query('SELECT id, movement_type, amount, balance_after, method, receipt_no, note, created_at FROM customer_advance_movements WHERE customer_id = ? ORDER BY id DESC LIMIT 200', [req.customer.id]);
  res.json({
    advanceBalance: req.customer.advanceBalance,
    movements: rows.map((m) => ({ id: m.id, type: m.movement_type, amount: m.amount, balanceAfter: m.balance_after, method: m.method, receiptNo: m.receipt_no, note: m.note, createdAt: m.created_at })),
  });
});

// Products bought with a warranty or serial number, on sales that still stand.
router.get('/warranties', requireCustomer, async (req, res) => {
  const rows = await query(
    `SELECT i.id, i.name_snapshot, i.warranty, i.serial_no, i.quantity, s.id AS sale_id, s.invoice_no, s.sale_date,
            COALESCE((SELECT SUM(ri.quantity) FROM sale_return_items ri WHERE ri.sale_item_id = i.id), 0) AS returned
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
      WHERE s.customer_id = ? AND s.status = 'completed' AND i.item_type = 'product' AND (i.warranty IS NOT NULL OR i.serial_no IS NOT NULL)
      ORDER BY s.sale_date DESC, i.id DESC LIMIT 200`,
    [req.customer.id],
  );
  res.json({
    warranties: rows
      .filter((r) => r.quantity > Number(r.returned)) // returned goods carry no warranty
      .map((r) => ({ id: r.id, name: r.name_snapshot, warranty: r.warranty, serialNo: r.serial_no, quantity: r.quantity - Number(r.returned), saleId: r.sale_id, invoiceNo: r.invoice_no, purchasedAt: r.sale_date })),
  });
});

module.exports = router;

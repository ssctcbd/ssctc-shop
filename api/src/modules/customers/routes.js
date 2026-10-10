const express = require('express');
const crypto = require('node:crypto');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { hashSecret, newPin } = require('../../lib/crypto');
const { normalizePhone } = require('../../lib/phone');
const { nextDocumentNumber } = require('../../lib/documents');
const { recalculateCustomer } = require('../../lib/ledger');
const { applyAdvanceMovement } = require('../../lib/advance');
const { toPaisa } = require('../../lib/money');
const { documentDate } = require('../../lib/dates');
const { conflict, notFound, badRequest } = require('../../lib/errors');
const { z, positiveMoney, optionalText, optionalTextUpdate, requiredText, flag, day, queryFlag, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const duplicatePhone = () => conflict('Please check the highlighted fields.', { fields: { phone: 'Another customer already has this mobile number.' } });

const createSchema = z.strictObject({
  name: requiredText(2, 120),
  phone: optionalText(25),
  address: optionalText(255),
  note: optionalText(255),
});

const updateSchema = z.strictObject({
  name: requiredText(2, 120).optional(),
  phone: optionalTextUpdate(25),
  address: optionalTextUpdate(255),
  note: optionalTextUpdate(255),
  isActive: flag.optional(),
  portalEnabled: flag.optional(),
});

const listSchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  hasDue: queryFlag.optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  ...paging,
});

const openingDueSchema = z.strictObject({
  amount: positiveMoney,
  date: day.optional(),
  note: optionalText(500),
});

const toApi = (row) => ({
  id: row.id,
  name: row.name,
  phone: row.phone,
  address: row.address,
  note: row.note,
  currentDue: row.current_due,
  advanceBalance: row.advance_balance,
  isActive: Boolean(row.is_active),
  portalEnabled: Boolean(row.portal_enabled),
  hasPortalAccess: Boolean(row.phone && row.portal_password_hash),
});

const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

/** Mobile numbers are stored as 01XXXXXXXXX. Returns null for "no number". */
function phoneOrError(input) {
  if (input === null || input === undefined) return null;
  const phone = normalizePhone(input);
  if (!phone) throw fieldError('phone', 'Enter a valid mobile number, like 01712345678.');
  return phone;
}

/** A fresh shop-issued portal PIN: readable copy for staff, bcrypt hash for login. */
async function issuePin() {
  const pin = newPin();
  return { pin, hash: await hashSecret(pin) };
}

router.get('/customers', staffWith('customers.view'), validateQuery(listSchema), async (req, res) => {
  const { search, hasDue, status, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (status !== 'all') (where.push('is_active = ?'), params.push(status === 'active' ? 1 : 0));
  if (hasDue) where.push('current_due > 0');
  if (search) {
    where.push('(name LIKE ? OR phone LIKE ?)');
    params.push(likePattern(search), likePattern(search));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [totals] = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(current_due), 0) AS due FROM customers ${whereSql}`, params);
  const rows = await query(`SELECT * FROM customers ${whereSql} ORDER BY ${hasDue ? 'current_due DESC,' : ''} name, id LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(toApi), page, pageSize, total: Number(totals.total), totalDue: totals.due });
});

// Compact list for the POS customer picker.
router.get('/customers/options', staffWith('customers.view'), async (_req, res) => {
  const rows = await query('SELECT id, name, phone, current_due, advance_balance FROM customers WHERE is_active = 1 ORDER BY name, id');
  res.json({ customers: rows.map((r) => ({ id: r.id, name: r.name, phone: r.phone, currentDue: r.current_due, advanceBalance: r.advance_balance })) });
});

router.get('/customers/:id', staffWith('customers.view'), idParam, async (req, res) => {
  const rows = await query('SELECT * FROM customers WHERE id = ?', [req.id]);
  if (!rows[0]) throw notFound('Customer not found.');
  const sales = await query(
    `SELECT id, invoice_no, sale_type, sale_date, status, total_amount, paid_amount, unverified_amount, due_amount, payment_status
       FROM sales WHERE customer_id = ? ORDER BY sale_date DESC, id DESC LIMIT 100`,
    [req.id],
  );
  res.json({
    customer: {
      ...toApi(rows[0]),
      // The PIN the shop issued, shown so staff can tell the customer. It is
      // null once the customer has chosen their own.
      ...(req.user.permissions.includes('customers.manage') ? { portalPin: rows[0].portal_pin } : {}),
      lastPortalLoginAt: rows[0].last_portal_login_at,
    },
    sales: sales.map((s) => ({
      id: s.id,
      invoiceNo: s.invoice_no,
      saleType: s.sale_type,
      saleDate: s.sale_date,
      status: s.status,
      totalAmount: s.total_amount,
      paidAmount: s.paid_amount,
      unverifiedAmount: s.unverified_amount,
      dueAmount: s.due_amount,
      paymentStatus: s.payment_status,
    })),
  });
});

router.post('/customers', staffWith('customers.manage'), validateBody(createSchema), async (req, res) => {
  const b = req.body;
  const phone = phoneOrError(b.phone);
  // Portal login needs a mobile number, so a PIN is issued only when there is one.
  const issued = phone ? await issuePin() : null;

  const customerId = await transaction(async (conn) => {
    let result;
    try {
      [result] = await conn.execute('INSERT INTO customers (name, phone, address, note, portal_pin, portal_password_hash, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)', [
        b.name,
        phone,
        b.address,
        b.note,
        issued && issued.pin,
        issued && issued.hash,
        req.user.id,
      ]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicatePhone();
      throw err;
    }
    await writeAudit({ conn, actorUserId: req.user.id, action: 'customer.create', entityType: 'customer', entityId: result.insertId, newValues: { name: b.name, phone }, ip: req.ip });
    return result.insertId;
  });

  const rows = await query('SELECT * FROM customers WHERE id = ?', [customerId]);
  res.status(201).json({ customer: { ...toApi(rows[0]), portalPin: rows[0].portal_pin } });
});

router.put('/customers/:id', staffWith('customers.manage'), idParam, validateBody(updateSchema), async (req, res) => {
  const b = req.body;
  const phone = b.phone === undefined ? undefined : phoneOrError(b.phone);

  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM customers WHERE id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('Customer not found.');

    const columns = {
      name: b.name,
      phone,
      address: b.address,
      note: b.note,
      is_active: b.isActive === undefined ? undefined : Number(b.isActive),
      portal_enabled: b.portalEnabled === undefined ? undefined : Number(b.portalEnabled),
    };
    const changed = Object.entries(columns).filter(([column, value]) => value !== undefined && String(value) !== String(current[column]));
    if (changed.length === 0) return;
    const changes = Object.fromEntries(changed);

    if (changes.is_active === 0 && Number(current.current_due) > 0) throw fieldError('isActive', `This customer still owes ${current.current_due}. Collect or settle it before deactivating.`);
    if ('phone' in changes && changes.phone === null && Number(current.current_due) > 0) throw fieldError('phone', 'A customer with a due needs a mobile number.');

    // A customer who gets a mobile number for the first time also gets a PIN.
    if (changes.phone && !current.portal_password_hash) {
      const issued = await issuePin();
      changed.push(['portal_pin', issued.pin], ['portal_password_hash', issued.hash]);
    }
    // The number is the portal login: changing it, or switching the portal or the
    // customer off, ends that customer's portal sessions.
    if ('phone' in changes || changes.is_active === 0 || changes.portal_enabled === 0) await conn.execute('DELETE FROM customer_sessions WHERE customer_id = ?', [req.id]);

    try {
      await conn.execute(`UPDATE customers SET ${changed.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`, [...changed.map(([, value]) => value), req.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicatePhone();
      throw err;
    }
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'customer.update',
      entityType: 'customer',
      entityId: req.id,
      oldValues: Object.fromEntries(Object.keys(changes).map((column) => [column, current[column]])),
      newValues: changes, // never the PIN or its hash
      ip: req.ip,
    });
  });

  const rows = await query('SELECT * FROM customers WHERE id = ?', [req.id]);
  res.json({ customer: toApi(rows[0]) });
});

// Issue a new PIN, for a customer who forgot theirs. Every portal session of
// that customer ends. The PIN itself is never written to the audit log.
router.post('/customers/:id/reset-pin', staffWith('customers.reset_pin'), idParam, async (req, res) => {
  const issued = await issuePin();
  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT phone FROM customers WHERE id = ? FOR UPDATE', [req.id]);
    if (!rows[0]) throw notFound('Customer not found.');
    if (!rows[0].phone) throw conflict('Add a mobile number first. The portal login is the mobile number and the PIN.');
    await conn.execute('UPDATE customers SET portal_pin = ?, portal_password_hash = ? WHERE id = ?', [issued.pin, issued.hash, req.id]);
    await conn.execute('DELETE FROM customer_sessions WHERE customer_id = ?', [req.id]);
    await conn.execute("DELETE FROM login_attempts WHERE identifier = ?", [`portal:${rows[0].phone}`]); // lift any lockout
    await writeAudit({ conn, actorUserId: req.user.id, action: 'customer.reset_pin', entityType: 'customer', entityId: req.id, ip: req.ip });
  });
  res.json({ portalPin: issued.pin });
});

// What the customer already owed before the system started. Stored as a sale
// with no lines (sale_type = 'opening_due'), so it is collected like any other due.
router.post('/customers/:id/opening-balance', staffWith('customers.manage'), idParam, validateBody(openingDueSchema), async (req, res) => {
  const { amount, date, note } = req.body;
  const sale = await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT name, phone, is_active FROM customers WHERE id = ? FOR UPDATE', [req.id]);
    const customer = rows[0];
    if (!customer) throw notFound('Customer not found.');
    if (!customer.is_active) throw conflict('This customer is inactive.');
    const [existing] = await conn.execute("SELECT id FROM sales WHERE customer_id = ? AND sale_type = 'opening_due' AND status = 'completed' LIMIT 1", [req.id]);
    if (existing[0]) throw conflict('An opening due has already been recorded for this customer.');

    const invoiceNo = await nextDocumentNumber(conn, 'invoice');
    const [result] = await conn.execute(
      `INSERT INTO sales (invoice_no, sale_type, customer_id, customer_name, customer_phone, sale_date, subtotal, total_amount, due_amount, payment_status, note, idempotency_key, created_by)
       VALUES (?, 'opening_due', ?, ?, ?, ?, ?, ?, ?, 'unpaid', ?, ?, ?)`,
      [invoiceNo, req.id, customer.name, customer.phone, documentDate(date), amount, amount, amount, note, crypto.randomUUID(), req.user.id],
    );
    await recalculateCustomer(conn, req.id);
    await writeAudit({ conn, actorUserId: req.user.id, action: 'customer.opening_due', entityType: 'customer', entityId: req.id, newValues: { invoiceNo, amount }, ip: req.ip });
    return { id: result.insertId, invoiceNo };
  });
  res.status(201).json({ sale });
});

// --- advance balance --------------------------------------------------------

const depositSchema = z.strictObject({
  idempotencyKey: z.string().uuid('Not a valid key.'),
  amount: positiveMoney,
  method: z.enum(['cash', 'bkash', 'nagad', 'bank_transfer', 'other']).default('cash'),
  reference: optionalText(60).transform((v) => (v ? v.toUpperCase() : null)),
  note: optionalText(255),
});

const movementToApi = (m) => ({
  id: m.id,
  type: m.movement_type,
  amount: m.amount, // signed: positive in, negative out
  balanceAfter: m.balance_after,
  method: m.method,
  reference: m.reference,
  receiptNo: m.receipt_no,
  note: m.note,
  createdAt: m.created_at,
  recordedByName: m.user_name,
});

/**
 * Money a customer leaves with the shop to spend later. It joins the balance
 * at once, so it must be money the shop is sure of: cash, or a transfer
 * recorded by someone allowed to verify payments.
 */
router.post('/customers/:id/advance-deposit', staffWith('payments.create'), idParam, validateBody(depositSchema), async (req, res) => {
  const b = req.body;
  const receipt = async () => (await query('SELECT receipt_no, amount, balance_after FROM customer_advance_movements WHERE idempotency_key = ?', [b.idempotencyKey]))[0];
  const shape = (row) => ({ receiptNo: row.receipt_no, amount: row.amount, balanceAfter: row.balance_after });

  const existing = await receipt();
  if (existing) return res.status(200).json({ deposit: shape(existing), duplicate: true });
  if (b.method !== 'cash' && !req.user.permissions.includes('payments.verify')) {
    throw fieldError('method', 'Only someone who can verify payments may record an advance received by bKash, Nagad or bank. Take cash, or ask the Owner.');
  }

  try {
    await transaction(async (conn) => {
      const [rows] = await conn.execute('SELECT is_active FROM customers WHERE id = ? FOR UPDATE', [req.id]);
      if (!rows[0]) throw notFound('Customer not found.');
      if (!rows[0].is_active) throw conflict('This customer is inactive.');
      const receiptNo = await nextDocumentNumber(conn, 'receipt');
      const moved = await applyAdvanceMovement(conn, { customerId: req.id, deltaPaisa: toPaisa(b.amount), movementType: 'deposit', method: b.method, reference: b.reference, receiptNo, note: b.note, idempotencyKey: b.idempotencyKey, userId: req.user.id });
      await writeAudit({ conn, actorUserId: req.user.id, action: 'customer.advance_deposit', entityType: 'customer', entityId: req.id, newValues: { receiptNo, amount: b.amount, method: b.method, reference: b.reference, balanceAfter: moved.balanceAfter }, ip: req.ip });
    });
  } catch (err) {
    if (!(err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_advance_idempotency'))) throw err;
  }
  const saved = await receipt();
  res.status(201).json({ deposit: shape(saved) });
});

router.get('/customers/:id/advance', staffWith('customers.view'), idParam, async (req, res) => {
  const rows = await query('SELECT advance_balance FROM customers WHERE id = ?', [req.id]);
  if (!rows[0]) throw notFound('Customer not found.');
  const movements = await query('SELECT m.*, u.name AS user_name FROM customer_advance_movements m JOIN users u ON u.id = m.created_by WHERE m.customer_id = ? ORDER BY m.id DESC LIMIT 200', [req.id]);
  res.json({ advanceBalance: rows[0].advance_balance, movements: movements.map(movementToApi) });
});

module.exports = router;

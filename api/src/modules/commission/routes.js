const express = require('express');
const { pool, query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { lockCashDrawer, lockOpenDrawer } = require('../../lib/cash');
const { addCommissionEntry, commissionBalance, categoryRate } = require('../../lib/commission');
const { toPaisa, fromPaisa, fromSignedPaisa } = require('../../lib/money');
const { dayStart, dayEnd, today } = require('../../lib/dates');
const { badRequest, conflict, notFound } = require('../../lib/errors');
const { z, id, positiveMoney, optionalText, requiredText, day, paging, commissionType, commissionValue } = require('../../lib/schemas');

// Staff commission (lib/commission.js). Every staff member sees their own
// earnings and what they have been paid; the Owner sees everyone's and pays it.
const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const METHODS = ['cash', 'bkash', 'nagad', 'bank_transfer', 'other'];
const EARNING_TYPES = "('sale', 'sale_void', 'sale_return')";

const ENTRY_SELECT = `SELECT e.*, s.invoice_no, r.return_no, p.method AS payout_method, u.name AS created_by_name
    FROM staff_commission_entries e
    LEFT JOIN sales s ON s.id = e.sale_id
    LEFT JOIN sale_returns r ON r.id = e.sale_return_id
    LEFT JOIN commission_payouts p ON p.id = e.payout_id
    JOIN users u ON u.id = e.created_by`;

const entryToApi = (row) => ({
  id: row.id,
  type: row.entry_type,
  amount: row.amount,
  saleId: row.sale_id,
  invoiceNo: row.invoice_no,
  returnNo: row.return_no,
  payoutId: row.payout_id,
  payoutMethod: row.payout_method,
  note: row.note,
  createdAt: row.created_at,
  createdByName: row.created_by_name,
});

const signedSum = (text) => (String(text).startsWith('-') ? -toPaisa(String(text).slice(1)) : toPaisa(text));

/** Earned (net of voids and returns) and paid (net of voided payouts) between two moments. */
async function totalsBetween(userId, start, end) {
  const [row] = await query(
    `SELECT COALESCE(SUM(IF(entry_type IN ${EARNING_TYPES}, amount, 0)), 0) AS earned,
            COALESCE(SUM(IF(entry_type IN ('payout', 'payout_void'), -amount, 0)), 0) AS paid
       FROM staff_commission_entries WHERE user_id = ? AND created_at >= ? AND created_at < ?`,
    [userId, start, end],
  );
  return { earned: fromSignedPaisa(signedSum(row.earned)), paid: fromSignedPaisa(signedSum(row.paid)) };
}

const monthStart = (d) => `${d.slice(0, 8)}01`;

const historySchema = z.strictObject({
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

/** One person's commission: balance, today, this month, a chosen period, and the entries behind it. */
async function statement(userId, { from, to, page, pageSize }) {
  const [user] = await query('SELECT id, name, username, commission_enabled FROM users WHERE id = ?', [userId]);
  if (!user) throw notFound('User not found.');
  const d = today();
  const where = ['e.user_id = ?'];
  const params = [userId];
  if (from) (where.push('e.created_at >= ?'), params.push(dayStart(from)));
  if (to) (where.push('e.created_at < ?'), params.push(dayEnd(to)));
  const [count] = await query(`SELECT COUNT(*) AS total FROM staff_commission_entries e WHERE ${where.join(' AND ')}`, params);
  const rows = await query(`${ENTRY_SELECT} WHERE ${where.join(' AND ')} ORDER BY e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  const payouts = await query(
    `SELECT p.id, p.amount, p.method, p.note, p.status, p.void_reason, p.created_at, u.name AS paid_by_name
       FROM commission_payouts p JOIN users u ON u.id = p.paid_by WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 20`,
    [userId],
  );
  return {
    user: { id: user.id, name: user.name, username: user.username, commissionEnabled: Boolean(user.commission_enabled) },
    balance: fromSignedPaisa(await commissionBalance(pool, userId)),
    today: await totalsBetween(userId, dayStart(d), dayEnd(d)),
    thisMonth: await totalsBetween(userId, dayStart(monthStart(d)), dayEnd(d)),
    ...(from || to ? { period: await totalsBetween(userId, from ? dayStart(from) : new Date(0), to ? dayEnd(to) : dayEnd(d)) } : {}),
    payouts: payouts.map((p) => ({ id: p.id, amount: p.amount, method: p.method, note: p.note, status: p.status, voidReason: p.void_reason, createdAt: p.created_at, paidByName: p.paid_by_name })),
    entries: { items: rows.map(entryToApi), page, pageSize, total: Number(count.total) },
  };
}

router.get('/commission/me', staffWith('commission.view_own'), validateQuery(historySchema), async (req, res) => {
  res.json(await statement(req.user.id, req.q));
});

router.get('/commission/staff', staffWith('commission.manage'), async (_req, res) => {
  const d = today();
  const rows = await query(
    `SELECT u.id, u.name, u.username, u.status, u.commission_enabled,
            COALESCE(SUM(e.amount), 0) AS balance,
            COALESCE(SUM(IF(e.entry_type IN ${EARNING_TYPES} AND e.created_at >= ? AND e.created_at < ?, e.amount, 0)), 0) AS earned_today,
            COALESCE(SUM(IF(e.entry_type IN ${EARNING_TYPES} AND e.created_at >= ? AND e.created_at < ?, e.amount, 0)), 0) AS earned_month,
            COALESCE(SUM(IF(e.entry_type IN ('payout', 'payout_void') AND e.created_at >= ? AND e.created_at < ?, -e.amount, 0)), 0) AS paid_month
       FROM users u LEFT JOIN staff_commission_entries e ON e.user_id = u.id
      GROUP BY u.id, u.name, u.username, u.status, u.commission_enabled
     HAVING u.commission_enabled = 1 OR COUNT(e.id) > 0
      ORDER BY u.name`,
    [dayStart(d), dayEnd(d), dayStart(monthStart(d)), dayEnd(d), dayStart(monthStart(d)), dayEnd(d)],
  );
  const n = (text) => fromSignedPaisa(signedSum(text));
  res.json({
    staff: rows.map((r) => ({
      id: r.id,
      name: r.name,
      username: r.username,
      status: r.status,
      commissionEnabled: Boolean(r.commission_enabled),
      balance: n(r.balance),
      earnedToday: n(r.earned_today),
      earnedThisMonth: n(r.earned_month),
      paidThisMonth: n(r.paid_month),
    })),
  });
});

router.get('/commission/staff/:id', staffWith('commission.manage'), idParam, validateQuery(historySchema), async (req, res) => {
  res.json(await statement(req.id, req.q));
});

// --- a staff member's own rates ----------------------------------------------

const toRate = (type, value) => (type ? { type, value } : null);

/**
 * Every active service and category with its general rate, this person's own
 * rate if any, and the rate that applies to them (own rate first, as at a sale).
 */
async function ratesFor(userId) {
  const services = await query(
    `SELECT s.id, s.name, s.unit, s.commission_type, s.commission_value, own.commission_type AS own_type, own.commission_value AS own_value
       FROM services s LEFT JOIN staff_commission_rates own ON own.user_id = ? AND own.service_id = s.id
      WHERE s.is_active = 1 ORDER BY s.service_type, s.sort_order, s.name`,
    [userId],
  );
  const categories = await query(
    `SELECT c.id, c.name, c.parent_id, pc.name AS parent_name, c.commission_type, c.commission_value,
            pc.commission_type AS parent_commission_type, pc.commission_value AS parent_commission_value,
            own.commission_type AS own_type, own.commission_value AS own_value, pown.commission_type AS parent_own_type, pown.commission_value AS parent_own_value
       FROM categories c LEFT JOIN categories pc ON pc.id = c.parent_id
       LEFT JOIN staff_commission_rates own ON own.user_id = ? AND own.category_id = c.id
       LEFT JOIN staff_commission_rates pown ON pown.user_id = ? AND pown.category_id = pc.id
      WHERE c.is_active = 1 ORDER BY COALESCE(pc.sort_order, c.sort_order), COALESCE(pc.name, c.name), c.parent_id IS NOT NULL, c.sort_order, c.name`,
    [userId, userId],
  );
  return {
    services: services.map((s) => ({
      id: s.id,
      name: s.name,
      unit: s.unit,
      general: toRate(s.commission_type, s.commission_value),
      own: toRate(s.own_type, s.own_value),
      applies: toRate(s.own_type, s.own_value) || toRate(s.commission_type, s.commission_value),
    })),
    categories: categories.map((c) => ({
      id: c.id,
      name: c.name,
      parentName: c.parent_name,
      general: toRate(c.commission_type, c.commission_value) || toRate(c.parent_commission_type, c.parent_commission_value),
      own: toRate(c.own_type, c.own_value),
      applies: categoryRate(c),
    })),
  };
}

// Staff see only their own rates; only the Owner can ask about anyone else's.
router.get('/commission/me/rates', staffWith('commission.view_own'), async (req, res) => {
  res.json(await ratesFor(req.user.id));
});

router.get('/commission/staff/:id/rates', staffWith('commission.manage'), idParam, async (req, res) => {
  const [user] = await query('SELECT id, name FROM users WHERE id = ?', [req.id]);
  if (!user) throw notFound('User not found.');
  res.json({ user, ...(await ratesFor(req.id)) });
});

const staffRateSchema = z.strictObject({
  target: z.enum(['service', 'category']),
  targetId: id,
  // null removes this person's own rate: the general rate applies again.
  commissionType,
  // Zero is allowed here: this person earns nothing on this item.
  commissionValue: commissionValue.default('0.00'),
});

/** Set or remove one person's own rate. Past sales keep what they earned; audited. */
router.put('/commission/staff/:id/rates', staffWith('commission.manage'), idParam, validateBody(staffRateSchema), async (req, res) => {
  const { target, targetId, commissionType: type, commissionValue: value } = req.body;
  if (type === 'percent' && toPaisa(value) > 10000) throw fieldError('commissionValue', 'A percentage cannot be more than 100.');
  const column = target === 'service' ? 'service_id' : 'category_id';
  const table = target === 'service' ? 'services' : 'categories';

  await transaction(async (conn) => {
    const [users] = await conn.execute('SELECT name FROM users WHERE id = ?', [req.id]);
    if (!users[0]) throw notFound('User not found.');
    const [items] = await conn.execute(`SELECT name FROM ${table} WHERE id = ?`, [targetId]);
    if (!items[0]) throw fieldError('targetId', 'Not found.');
    const [current] = await conn.execute(`SELECT commission_type, commission_value FROM staff_commission_rates WHERE user_id = ? AND ${column} = ?`, [req.id, targetId]);
    if (type) {
      await conn.execute(
        `INSERT INTO staff_commission_rates (user_id, ${column}, commission_type, commission_value, updated_by) VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE commission_type = VALUES(commission_type), commission_value = VALUES(commission_value), updated_by = VALUES(updated_by)`,
        [req.id, targetId, type, value, req.user.id],
      );
    } else {
      await conn.execute(`DELETE FROM staff_commission_rates WHERE user_id = ? AND ${column} = ?`, [req.id, targetId]);
    }
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'commission.staff_rate',
      entityType: 'user',
      entityId: req.id,
      oldValues: current[0] ? { type: current[0].commission_type, value: current[0].commission_value } : null,
      newValues: { staff: users[0].name, [target]: items[0].name, ...(type ? { type, value } : { removed: true }) },
      ip: req.ip,
    });
  });
  res.json({ own: type ? { type, value } : null });
});

const payoutSchema = z.strictObject({
  idempotencyKey: z.string().uuid('Not a valid key.'),
  userId: id,
  amount: positiveMoney,
  method: z.enum(METHODS).default('cash'),
  note: optionalText(255),
});

async function savedPayout(idempotencyKey) {
  const rows = await query('SELECT id, user_id, amount, method, status FROM commission_payouts WHERE idempotency_key = ?', [idempotencyKey]);
  const r = rows[0];
  return r ? { id: r.id, userId: r.user_id, amount: r.amount, method: r.method, status: r.status } : null;
}

/**
 * Pay commission to a staff member. One transaction: lock the cash drawer (a
 * cash payout comes out of it, so the cash day must be open) → check the
 * balance covers it → insert the payout and its ledger row → audit.
 */
router.post('/commission/payouts', staffWith('commission.manage'), validateBody(payoutSchema), async (req, res) => {
  const b = req.body;
  const existing = await savedPayout(b.idempotencyKey);
  if (existing) return res.status(200).json({ payout: existing, duplicate: true });

  let payout;
  try {
    payout = await transaction(async (conn) => {
      await (b.method === 'cash' ? lockOpenDrawer(conn) : lockCashDrawer(conn));
      const [users] = await conn.execute('SELECT id, name FROM users WHERE id = ? FOR UPDATE', [b.userId]);
      if (!users[0]) throw fieldError('userId', 'User not found.');
      const balance = await commissionBalance(conn, b.userId);
      if (toPaisa(b.amount) > balance) throw fieldError('amount', balance > 0 ? `${users[0].name} has ${fromPaisa(balance)} of commission to be paid.` : `${users[0].name} has no commission to be paid.`);

      const [result] = await conn.execute('INSERT INTO commission_payouts (user_id, amount, method, note, idempotency_key, paid_by) VALUES (?, ?, ?, ?, ?, ?)', [b.userId, b.amount, b.method, b.note, b.idempotencyKey, req.user.id]);
      await addCommissionEntry(conn, { userId: b.userId, deltaPaisa: -toPaisa(b.amount), entryType: 'payout', payoutId: result.insertId, note: b.note, createdBy: req.user.id });
      await writeAudit({ conn, actorUserId: req.user.id, action: 'commission.payout', entityType: 'commission_payout', entityId: result.insertId, newValues: { to: users[0].name, amount: b.amount, method: b.method, note: b.note }, ip: req.ip });
      return { id: result.insertId, userId: b.userId, amount: b.amount, method: b.method, status: 'active', balanceAfter: fromSignedPaisa(balance - toPaisa(b.amount)) };
    });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_commission_payouts_idempotency')) return res.status(200).json({ payout: await savedPayout(b.idempotencyKey), duplicate: true });
    throw err;
  }
  res.status(201).json({ payout });
});

/** A payout entered wrongly. It stays in the history, marked void, and the balance goes back up. */
router.post('/commission/payouts/:id/void', staffWith('commission.manage'), idParam, validateBody(z.strictObject({ reason: requiredText(3, 255) })), async (req, res) => {
  await transaction(async (conn) => {
    const [found] = await conn.execute('SELECT method FROM commission_payouts WHERE id = ?', [req.id]);
    if (!found[0]) throw notFound('Payout not found.');
    // Cash comes back into the drawer: that needs the cash day open.
    await (found[0].method === 'cash' ? lockOpenDrawer(conn) : lockCashDrawer(conn));
    const [rows] = await conn.execute('SELECT * FROM commission_payouts WHERE id = ? FOR UPDATE', [req.id]);
    const p = rows[0];
    const [updated] = await conn.execute("UPDATE commission_payouts SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [req.body.reason, req.user.id, req.id]);
    if (updated.affectedRows !== 1) throw conflict('This payout has already been voided.');
    await addCommissionEntry(conn, { userId: p.user_id, deltaPaisa: toPaisa(p.amount), entryType: 'payout_void', payoutId: p.id, note: req.body.reason, createdBy: req.user.id });
    await writeAudit({ conn, actorUserId: req.user.id, action: 'commission.payout_void', entityType: 'commission_payout', entityId: p.id, oldValues: { status: 'active', amount: p.amount, method: p.method }, newValues: { status: 'void', reason: req.body.reason }, ip: req.ip });
  });
  const rows = await query('SELECT id, user_id, amount, method, status, void_reason FROM commission_payouts WHERE id = ?', [req.id]);
  const p = rows[0];
  res.json({ payout: { id: p.id, userId: p.user_id, amount: p.amount, method: p.method, status: p.status, voidReason: p.void_reason } });
});

module.exports = router;

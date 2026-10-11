const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, validateQuery, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { nextDocumentNumber } = require('../../lib/documents');
const { lockCashDrawer } = require('../../lib/cash');
const { dayStart, dayEnd, documentDate, today } = require('../../lib/dates');
const { notFound, badRequest, conflict, forbidden } = require('../../lib/errors');
const { z, id, positiveMoney, optionalText, requiredText, flag, day, paging } = require('../../lib/schemas');

const router = express.Router();

const fieldError = (field, message) => badRequest('Please check the highlighted fields.', { fields: { [field]: message } });
const METHODS = ['cash', 'bkash', 'nagad', 'bank_transfer', 'other'];
const likePattern = (text) => `%${text.replace(/[\\%_]/g, '\\$&')}%`;

// --- categories -------------------------------------------------------------

const categorySchema = z.strictObject({ name: requiredText(2, 100) });
const categoryUpdateSchema = z.strictObject({ name: requiredText(2, 100).optional(), isActive: flag.optional() });
const categoryToApi = (row) => ({ id: row.id, name: row.name, isActive: Boolean(row.is_active) });
const duplicateName = () => conflict('Please check the highlighted fields.', { fields: { name: 'There is already a category with this name.' } });

router.get('/expense-categories', staffWith('expenses.view'), async (_req, res) => {
  const rows = await query('SELECT * FROM expense_categories ORDER BY is_active DESC, name');
  res.json({ categories: rows.map(categoryToApi) });
});

router.post('/expense-categories', staffWith('expenses.manage'), validateBody(categorySchema), async (req, res) => {
  let result;
  try {
    result = await query('INSERT INTO expense_categories (name) VALUES (?)', [req.body.name]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw duplicateName();
    throw err;
  }
  await writeAudit({ actorUserId: req.user.id, action: 'expense_category.create', entityType: 'expense_category', entityId: result.insertId, newValues: { name: req.body.name }, ip: req.ip });
  res.status(201).json({ category: { id: result.insertId, name: req.body.name, isActive: true } });
});

router.put('/expense-categories/:id', staffWith('expenses.manage'), idParam, validateBody(categoryUpdateSchema), async (req, res) => {
  const b = req.body;
  const rows = await query('SELECT * FROM expense_categories WHERE id = ?', [req.id]);
  if (!rows[0]) throw notFound('Category not found.');
  const name = b.name ?? rows[0].name;
  const isActive = b.isActive === undefined ? rows[0].is_active : Number(b.isActive);
  try {
    await query('UPDATE expense_categories SET name = ?, is_active = ? WHERE id = ?', [name, isActive, req.id]);
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw duplicateName();
    throw err;
  }
  await writeAudit({ actorUserId: req.user.id, action: 'expense_category.update', entityType: 'expense_category', entityId: req.id, oldValues: { name: rows[0].name, isActive: Boolean(rows[0].is_active) }, newValues: { name, isActive: Boolean(isActive) }, ip: req.ip });
  res.json({ category: { id: req.id, name, isActive: Boolean(isActive) } });
});

// --- expenses ---------------------------------------------------------------

const expenseSchema = z.strictObject({
  // UUID made once by the form: a repeated save returns the first voucher.
  idempotencyKey: z.string().uuid('Not a valid key.'),
  categoryId: id,
  title: requiredText(2, 200),
  amount: positiveMoney,
  method: z.enum(METHODS).default('cash'),
  date: day.optional(),
  note: optionalText(500),
});

const listSchema = z.strictObject({
  search: z.string().trim().max(100).optional(),
  categoryId: id.optional(),
  method: z.enum(METHODS).optional(),
  status: z.enum(['active', 'void', 'all']).default('all'),
  from: day.optional(),
  to: day.optional(),
  ...paging,
});

const voidSchema = z.strictObject({ reason: requiredText(3, 255) });

const toApi = (row) => ({
  id: row.id,
  voucherNo: row.voucher_no,
  categoryId: row.category_id,
  categoryName: row.category_name,
  expenseDate: row.expense_date,
  title: row.title,
  amount: row.amount,
  method: row.payment_method,
  note: row.note,
  status: row.status,
  voidReason: row.void_reason,
  voidedAt: row.voided_at,
  recordedByName: row.user_name,
});

const SELECT = 'SELECT e.*, c.name AS category_name, u.name AS user_name FROM expenses e JOIN expense_categories c ON c.id = e.category_id JOIN users u ON u.id = e.created_by';

async function savedExpense(idempotencyKey) {
  const rows = await query(`${SELECT} WHERE e.idempotency_key = ?`, [idempotencyKey]);
  return rows[0] ? toApi(rows[0]) : null;
}

router.get('/expenses', staffWith('expenses.view'), validateQuery(listSchema), async (req, res) => {
  const { search, categoryId, method, status, from, to, page, pageSize } = req.q;
  const where = [];
  const params = [];
  if (status !== 'all') (where.push('e.status = ?'), params.push(status));
  if (categoryId) (where.push('e.category_id = ?'), params.push(categoryId));
  if (method) (where.push('e.payment_method = ?'), params.push(method));
  if (from) (where.push('e.expense_date >= ?'), params.push(dayStart(from)));
  if (to) (where.push('e.expense_date < ?'), params.push(dayEnd(to)));
  if (search) {
    where.push('(e.title LIKE ? OR e.voucher_no LIKE ?)');
    params.push(likePattern(search), likePattern(search));
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  // Voided vouchers are listed but never counted.
  const [totals] = await query(`SELECT COUNT(*) AS total, COALESCE(SUM(IF(e.status = 'active', e.amount, 0)), 0) AS amount FROM expenses e ${whereSql}`, params);
  const rows = await query(`${SELECT} ${whereSql} ORDER BY e.expense_date DESC, e.id DESC LIMIT ${pageSize} OFFSET ${(page - 1) * pageSize}`, params);
  res.json({ items: rows.map(toApi), page, pageSize, total: Number(totals.total), totalAmount: totals.amount });
});

/**
 * Record money the shop spent. One transaction: lock the cash drawer → check
 * the category → take voucher number → insert → audit. A cash expense comes
 * out of the drawer and so out of the next cash closing.
 */
router.post('/expenses', staffWith('expenses.create'), validateBody(expenseSchema), async (req, res) => {
  const b = req.body;

  const existing = await savedExpense(b.idempotencyKey);
  if (existing) return res.status(200).json({ expense: existing, duplicate: true });
  if (b.date && b.date > today()) throw fieldError('date', 'The expense date cannot be in the future.');
  if (b.date && b.date !== today() && !req.user.permissions.includes('expenses.manage')) throw forbidden('You do not have permission to change the expense date.');

  try {
    await transaction(async (conn) => {
      await lockCashDrawer(conn);
      const [categories] = await conn.execute('SELECT name, is_active FROM expense_categories WHERE id = ?', [b.categoryId]);
      if (!categories[0]) throw fieldError('categoryId', 'Category not found.');
      if (!categories[0].is_active) throw fieldError('categoryId', `"${categories[0].name}" is no longer used.`);

      const voucherNo = await nextDocumentNumber(conn, 'expense');
      const [result] = await conn.execute('INSERT INTO expenses (voucher_no, category_id, expense_date, amount, payment_method, title, note, idempotency_key, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        voucherNo,
        b.categoryId,
        documentDate(b.date),
        b.amount,
        b.method,
        b.title,
        b.note,
        b.idempotencyKey,
        req.user.id,
      ]);
      await writeAudit({ conn, actorUserId: req.user.id, action: 'expense.create', entityType: 'expense', entityId: result.insertId, newValues: { voucherNo, category: categories[0].name, title: b.title, amount: b.amount, method: b.method, ...(b.date ? { date: b.date } : {}) }, ip: req.ip });
    });
  } catch (err) {
    if (!(err.code === 'ER_DUP_ENTRY' && String(err.message).includes('uq_expenses_idempotency'))) throw err;
    return res.status(200).json({ expense: await savedExpense(b.idempotencyKey), duplicate: true });
  }
  res.status(201).json({ expense: await savedExpense(b.idempotencyKey) });
});

// An expense entered wrongly. It stays in the history, marked void.
router.post('/expenses/:id/void', staffWith('expenses.manage'), idParam, validateBody(voidSchema), async (req, res) => {
  await transaction(async (conn) => {
    await lockCashDrawer(conn);
    const [rows] = await conn.execute('SELECT * FROM expenses WHERE id = ? FOR UPDATE', [req.id]);
    const expense = rows[0];
    if (!expense) throw notFound('Expense not found.');
    const [updated] = await conn.execute("UPDATE expenses SET status = 'void', void_reason = ?, voided_by = ?, voided_at = UTC_TIMESTAMP() WHERE id = ? AND status = 'active'", [req.body.reason, req.user.id, req.id]);
    if (updated.affectedRows !== 1) throw conflict('This expense has already been voided.');
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: 'expense.void',
      entityType: 'expense',
      entityId: req.id,
      oldValues: { status: 'active', voucherNo: expense.voucher_no, amount: expense.amount, method: expense.payment_method },
      newValues: { status: 'void', reason: req.body.reason },
      ip: req.ip,
    });
  });
  const rows = await query(`${SELECT} WHERE e.id = ?`, [req.id]);
  res.json({ expense: toApi(rows[0]) });
});

module.exports = router;

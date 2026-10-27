const express = require('express');
const { query, transaction } = require('../../db/pool');
const { validateBody, idParam } = require('../../middleware/validate');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { conflict, notFound, badRequest } = require('../../lib/errors');
const { z, money, requiredText, flag, commissionType, commissionValue, commissionProblem } = require('../../lib/schemas');

// Services are the shop's rate list: printing, photocopy, online applications
// and anything else sold by the page, copy or job. The Owner adds new ones freely.
const router = express.Router();

const serviceType = z.enum(['print', 'photocopy', 'online', 'other']);
const unit = z.string().trim().min(1).max(20);
const sortOrder = z.coerce.number().int().min(0).max(9999);

const createSchema = z.strictObject({
  serviceType,
  name: requiredText(1, 150),
  unit: unit.default('pcs'),
  defaultPrice: money,
  priceEditable: flag.default(true),
  sortOrder: sortOrder.default(0),
  // Staff commission on each sale of this service.
  commissionType: commissionType.default(null),
  commissionValue: commissionValue.default('0.00'),
});

const updateSchema = z.strictObject({
  serviceType: serviceType.optional(),
  name: requiredText(1, 150).optional(),
  unit: unit.optional(),
  defaultPrice: money.optional(),
  priceEditable: flag.optional(),
  isActive: flag.optional(),
  sortOrder: sortOrder.optional(),
  commissionType: commissionType.optional(),
  commissionValue: commissionValue.optional(),
});

const toApi = (row) => ({
  id: row.id,
  serviceType: row.service_type,
  name: row.name,
  unit: row.unit,
  defaultPrice: row.default_price,
  priceEditable: Boolean(row.price_editable),
  isActive: Boolean(row.is_active),
  sortOrder: row.sort_order,
  commissionType: row.commission_type,
  commissionValue: row.commission_value,
});

const rateError = (fields) => badRequest('Please check the highlighted fields.', { fields });

const duplicateName = () => conflict('Please check the highlighted fields.', { fields: { name: 'A service with this name already exists.' } });

router.get('/services', staffWith('catalog.view'), async (_req, res) => {
  const rows = await query('SELECT * FROM services ORDER BY service_type, sort_order, name');
  res.json({ services: rows.map(toApi) });
});

router.post('/services', staffWith('catalog.manage'), validateBody(createSchema), async (req, res) => {
  const b = req.body;
  const problem = commissionProblem(b.commissionType, b.commissionValue);
  if (problem) throw rateError(problem);
  const serviceId = await transaction(async (conn) => {
    let result;
    try {
      [result] = await conn.execute('INSERT INTO services (service_type, name, unit, default_price, price_editable, sort_order, commission_type, commission_value) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
        b.serviceType,
        b.name,
        b.unit,
        b.defaultPrice,
        Number(b.priceEditable),
        b.sortOrder,
        b.commissionType,
        b.commissionType ? b.commissionValue : '0.00',
      ]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicateName();
      throw err;
    }
    await writeAudit({ conn, actorUserId: req.user.id, action: 'service.create', entityType: 'service', entityId: result.insertId, newValues: { name: b.name, defaultPrice: b.defaultPrice, ...(b.commissionType ? { commission: { type: b.commissionType, value: b.commissionValue } } : {}) }, ip: req.ip });
    return result.insertId;
  });
  const rows = await query('SELECT * FROM services WHERE id = ?', [serviceId]);
  res.status(201).json({ service: toApi(rows[0]) });
});

router.put('/services/:id', staffWith('catalog.manage'), idParam, validateBody(updateSchema), async (req, res) => {
  const b = req.body;
  await transaction(async (conn) => {
    const [rows] = await conn.execute('SELECT * FROM services WHERE id = ? FOR UPDATE', [req.id]);
    const current = rows[0];
    if (!current) throw notFound('Service not found.');

    // No rate means a value of zero, so switching the rate off clears it.
    const rateType = b.commissionType === undefined ? current.commission_type : b.commissionType;
    const rateValue = rateType ? (b.commissionValue ?? current.commission_value) : '0.00';
    const problem = commissionProblem(rateType, rateValue);
    if (problem) throw rateError(problem);

    const columns = {
      service_type: b.serviceType,
      name: b.name,
      unit: b.unit,
      default_price: b.defaultPrice,
      price_editable: b.priceEditable === undefined ? undefined : Number(b.priceEditable),
      is_active: b.isActive === undefined ? undefined : Number(b.isActive),
      sort_order: b.sortOrder,
      commission_type: b.commissionType,
      commission_value: b.commissionType === undefined && b.commissionValue === undefined ? undefined : rateValue,
    };
    // undefined = left out; null (no commission rate) is a real value.
    const changed = Object.entries(columns).filter(([column, value]) => value !== undefined && String(value) !== String(current[column]));
    if (changed.length === 0) return;

    try {
      await conn.execute(`UPDATE services SET ${changed.map(([column]) => `${column} = ?`).join(', ')} WHERE id = ?`, [...changed.map(([, value]) => value), req.id]);
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw duplicateName();
      throw err;
    }
    // Rate changes are audited; past sales keep the price copied at sale time.
    await writeAudit({
      conn,
      actorUserId: req.user.id,
      action: changed.some(([column]) => column === 'default_price' || column.startsWith('commission_')) ? 'service.rate_change' : 'service.update',
      entityType: 'service',
      entityId: req.id,
      oldValues: Object.fromEntries(changed.map(([column]) => [column, current[column]])),
      newValues: Object.fromEntries(changed),
      ip: req.ip,
    });
  });
  const rows = await query('SELECT * FROM services WHERE id = ?', [req.id]);
  res.json({ service: toApi(rows[0]) });
});

module.exports = router;

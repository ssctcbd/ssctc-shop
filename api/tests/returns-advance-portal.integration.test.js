const { resetDatabase, startApp } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };

let app;
let db;
let owner;
let staff;
let skipReason = false;
const ids = {};

test.before(async () => {
  try {
    await resetDatabase();
  } catch (err) {
    skipReason = `MySQL test database not reachable (${err.code || err.message}); see tests/helpers/setup.js`;
    return;
  }
  app = await startApp();
  db = require('../src/db/pool');
  const { hashSecret } = require('../src/lib/crypto');
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (1, 'Owner', ?, ?)", [OWNER.username, await hashSecret(OWNER.password)]);
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (2, 'Rahim', ?, ?)", [STAFF.username, await hashSecret(STAFF.password)]);
  owner = app.client();
  staff = app.client();
  await owner.post('/auth/login', OWNER);
  await staff.post('/auth/login', STAFF);

  ids.category = (await owner.post('/categories', { name: 'Gadgets' })).body.category.id;
  ids.pendrive = (await owner.post('/products', { categoryId: ids.category, sku: 'PD32', name: 'Pendrive 32GB', price: 450, costPrice: 380, openingStock: 50 })).body.product.id;
  ids.mouse = (await owner.post('/products', { categoryId: ids.category, sku: 'MOUSE', name: 'USB Mouse', price: 500, costPrice: 300, openingStock: 50 })).body.product.id;
  ids.photocopy = (await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4 B/W', unit: 'page', defaultPrice: 2 })).body.service.id;

  const karim = (await owner.post('/customers', { name: 'Karim Mia', phone: '01711111111' })).body.customer;
  const salma = (await owner.post('/customers', { name: 'Salma Begum', phone: '01722222222' })).body.customer;
  ids.karim = karim.id;
  ids.karimPin = karim.portalPin;
  ids.salma = salma.id;
  ids.salmaPin = salma.portalPin;
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const key = () => crypto.randomUUID();
const one = async (sql, params = []) => (await db.query(sql, params))[0];
const stockOf = async (id) => (await one('SELECT stock_qty FROM products WHERE id = ?', [id])).stock_qty;
const customerRow = (id) => one('SELECT current_due, advance_balance FROM customers WHERE id = ?', [id]);
const count = async (table) => Number((await one(`SELECT COUNT(*) AS n FROM ${table}`)).n);
const product = (productId, quantity, extra = {}) => ({ type: 'product', productId, quantity, ...extra });
const cash = (amount) => ({ method: 'cash', amount });
const sell = (client, body) => client.post('/sales', { idempotencyKey: key(), ...body });
const saleOf = async (id) => (await owner.get(`/sales/${id}`)).body.sale;
const giveBack = (client, saleId, items, extra = {}) => client.post(`/sales/${saleId}/returns`, { idempotencyKey: key(), reason: 'Customer changed mind', items, ...extra });
const money = (sale) => [sale.totalAmount, sale.returnedAmount, sale.paidAmount, sale.dueAmount, sale.paymentStatus];

// --- migration 003 ----------------------------------------------------------

it('migration 003 can be run again, and the new sale checks are enforced by the database', async () => {
  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '003_returns_and_customer_advance.sql'), 'utf8');
    await conn.query(sql);
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  const checks = (await db.query("SELECT constraint_name AS c FROM information_schema.table_constraints WHERE constraint_schema = DATABASE() AND table_name = 'sales' AND constraint_type = 'CHECK'")).map((r) => r.c);
  assert.ok(checks.includes('ck_sales_due_net') && checks.includes('ck_sales_paid_net') && checks.includes('ck_sales_returned'));
  assert.ok(!checks.includes('ck_sales_due') && !checks.includes('ck_sales_paid'));
  // due must equal total − returned − paid
  await assert.rejects(
    db.query(
      `INSERT INTO sales (invoice_no, customer_id, sale_date, subtotal, total_amount, returned_amount, paid_amount, due_amount, payment_status, idempotency_key, created_by)
       VALUES ('INV-BAD', ?, UTC_TIMESTAMP(), 100, 100, 30, 20, 80, 'partial', UUID(), 1)`,
      [ids.karim],
    ),
    /ck_sales_due_net/,
  );
});

// --- advance balance --------------------------------------------------------

it('a cash advance deposit raises the balance, gets a receipt, and is stored once per form', async () => {
  const body = { idempotencyKey: key(), amount: '1000', note: 'For next month' };
  const res = await staff.post(`/customers/${ids.karim}/advance-deposit`, body);
  assert.equal(res.status, 201);
  assert.match(res.body.deposit.receiptNo, /^RCP-\d{6}$/);
  assert.equal(res.body.deposit.balanceAfter, '1000.00');

  const again = await staff.post(`/customers/${ids.karim}/advance-deposit`, body);
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.equal((await customerRow(ids.karim)).advance_balance, '1000.00');
  assert.equal(await count('customer_advance_movements'), 1);
  assert.equal((await one("SELECT new_values FROM audit_logs WHERE action = 'customer.advance_deposit'")).new_values.amount, '1000.00');
});

it('a non-cash advance deposit needs someone who can verify payments', async () => {
  const body = { idempotencyKey: key(), amount: '500', method: 'bkash', reference: 'adv123' };
  assert.equal((await staff.post(`/customers/${ids.karim}/advance-deposit`, body)).status, 400);
  assert.equal((await customerRow(ids.karim)).advance_balance, '1000.00');
  const res = await owner.post(`/customers/${ids.karim}/advance-deposit`, body);
  assert.equal(res.status, 201);
  assert.equal(res.body.deposit.balanceAfter, '1500.00');
  for (const bad of [{ amount: '0' }, { amount: '-5' }, { amount: '1.999' }, { amount: '10', method: 'cheque' }]) {
    assert.equal((await owner.post(`/customers/${ids.karim}/advance-deposit`, { idempotencyKey: key(), ...bad })).status, 400, JSON.stringify(bad));
  }
  assert.equal((await owner.post('/customers/99999/advance-deposit', { idempotencyKey: key(), amount: '10' })).status, 404);
});

it('paying a sale from the advance balance: verified at once, balance falls, and it cannot overdraw', async () => {
  const res = await sell(staff, { customerId: ids.karim, items: [product(ids.pendrive, 2)], payments: [{ method: 'customer_advance', amount: '600' }, cash('300')] });
  assert.equal(res.status, 201);
  ids.advanceSale = res.body.sale.id;
  assert.deepEqual([res.body.sale.paidAmount, res.body.sale.dueAmount, res.body.sale.paymentStatus], ['900.00', '0.00', 'paid']);
  assert.equal((await customerRow(ids.karim)).advance_balance, '900.00');
  const payment = (await saleOf(ids.advanceSale)).payments.find((p) => p.method === 'customer_advance');
  assert.equal(payment.isVerified, true);
  ids.advancePayment = payment.id;

  // More than the balance: the whole sale is refused.
  const before = [await count('sales'), await stockOf(ids.pendrive)];
  const over = await sell(staff, { customerId: ids.karim, items: [product(ids.pendrive, 3)], payments: [{ method: 'customer_advance', amount: '1350' }] });
  assert.equal(over.status, 409);
  assert.match(over.body.error.message, /Not enough advance balance for Karim Mia: 900\.00 available/);
  assert.deepEqual([await count('sales'), await stockOf(ids.pendrive)], before);
  // A walk-in has no advance to spend; another customer's balance is their own.
  assert.equal((await sell(staff, { items: [product(ids.pendrive, 1)], payments: [{ method: 'customer_advance', amount: '450' }] })).status, 400);
  assert.equal((await sell(staff, { customerId: ids.salma, items: [product(ids.pendrive, 1)], payments: [{ method: 'customer_advance', amount: '450' }] })).status, 409);
});

it('ten tills spending one advance balance at once cannot spend more than it holds', async () => {
  // Balance 900; each sale wants 450 from it. Exactly two can succeed.
  const results = await Promise.all(Array.from({ length: 10 }, () => sell(staff, { customerId: ids.karim, items: [product(ids.pendrive, 1)], payments: [{ method: 'customer_advance', amount: '450' }] })));
  assert.equal(results.filter((r) => r.status === 201).length, 2);
  assert.equal(results.filter((r) => r.status === 409).length, 8);
  assert.equal((await customerRow(ids.karim)).advance_balance, '0.00');
  ids.spentSale = results.find((r) => r.status === 201).body.sale.id;
});

it('voiding an advance payment, or a sale paid from advance, puts the money back', async () => {
  assert.equal((await owner.post(`/payments/${ids.advancePayment}/unverify`)).status, 409);
  assert.equal((await owner.post(`/payments/${ids.advancePayment}/void`, { reason: 'Should have been cash' })).status, 200);
  assert.equal((await customerRow(ids.karim)).advance_balance, '600.00');
  assert.deepEqual(money(await saleOf(ids.advanceSale)), ['900.00', '0.00', '300.00', '600.00', 'partial']);

  assert.equal((await owner.post(`/sales/${ids.spentSale}/void`, { reason: 'Wrong customer', voidPayments: true })).status, 200);
  assert.equal((await customerRow(ids.karim)).advance_balance, '1050.00');
});

it('the advance balance always equals the sum of its ledger', async () => {
  const history = (await owner.get(`/customers/${ids.karim}/advance`)).body;
  assert.equal(history.advanceBalance, '1050.00');
  assert.equal(history.movements[0].balanceAfter, '1050.00');
  assert.deepEqual([...new Set(history.movements.map((m) => m.type))].sort(), ['deposit', 'payment_void', 'sale_payment']);
  const bad = await db.query('SELECT c.id FROM customers c WHERE c.advance_balance <> (SELECT COALESCE(SUM(m.amount), 0) FROM customer_advance_movements m WHERE m.customer_id = c.id)');
  assert.deepEqual(bad, []);
});

// --- returns ----------------------------------------------------------------

it('returning goods from a fully paid sale refunds their value in cash and restocks them', async () => {
  const sale = (await sell(staff, { items: [product(ids.mouse, 3), { type: 'service', serviceId: ids.photocopy, quantity: 50 }], payments: [cash('1600')] })).body.sale;
  ids.paidSale = sale.id;
  const detail = await saleOf(sale.id);
  ids.paidMouseLine = detail.items[0].id;
  ids.paidServiceLine = detail.items[1].id;
  const stock = await stockOf(ids.mouse);

  assert.equal((await giveBack(staff, sale.id, [{ saleItemId: ids.paidMouseLine, quantity: 1 }])).status, 403); // staff may not
  const res = await giveBack(owner, sale.id, [{ saleItemId: ids.paidMouseLine, quantity: 1 }]);
  assert.equal(res.status, 201);
  assert.deepEqual(res.body.return, { id: res.body.return.id, returnNo: 'RET-000001', returnAmount: '500.00', dueReduced: '0.00', refundAmount: '500.00', refundMethod: 'cash' });

  assert.equal(await stockOf(ids.mouse), stock + 1);
  const move = await one("SELECT quantity, reference_type, reference_id FROM inventory_movements WHERE movement_type = 'sale_return'");
  assert.deepEqual([move.quantity, move.reference_type, move.reference_id], [1, 'return', res.body.return.id]);

  const after = await saleOf(sale.id);
  // total 1600, returned 500, paid 1600 − 500 refunded = 1100, due 0
  assert.deepEqual(money(after), ['1600.00', '500.00', '1100.00', '0.00', 'paid']);
  assert.equal(after.refundedAmount, '500.00');
  assert.equal(after.items[0].returnedQuantity, 1);
  assert.deepEqual(after.returns.map((r) => [r.returnNo, r.returnAmount, r.refundAmount, r.items[0].name, r.items[0].quantity]), [['RET-000001', '500.00', '500.00', 'USB Mouse', 1]]);
  assert.equal((await one("SELECT new_values FROM audit_logs WHERE action = 'sale.return'")).new_values.refund, '500.00');
});

it('a return cannot exceed what was sold, cannot include a service, and needs a reason', async () => {
  const before = [await count('sale_returns'), await stockOf(ids.mouse)];
  const tooMany = await giveBack(owner, ids.paidSale, [{ saleItemId: ids.paidMouseLine, quantity: 3 }]);
  assert.equal(tooMany.status, 400);
  assert.match(tooMany.body.error.details.fields['items.0.quantity'], /Only 2 of "USB Mouse"/);
  assert.equal((await giveBack(owner, ids.paidSale, [{ saleItemId: ids.paidServiceLine, quantity: 1 }])).status, 400);
  assert.equal((await giveBack(owner, ids.paidSale, [{ saleItemId: 999999, quantity: 1 }])).status, 400);
  assert.equal((await giveBack(owner, ids.paidSale, [{ saleItemId: ids.paidMouseLine, quantity: 1 }, { saleItemId: ids.paidMouseLine, quantity: 1 }])).status, 400);
  assert.equal((await giveBack(owner, ids.paidSale, [])).status, 400);
  assert.equal((await owner.post(`/sales/${ids.paidSale}/returns`, { idempotencyKey: key(), items: [{ saleItemId: ids.paidMouseLine, quantity: 1 }] })).status, 400);
  assert.equal((await giveBack(owner, ids.paidSale, [{ saleItemId: ids.paidMouseLine, quantity: 1 }], { refundMethod: 'advance_credit' })).status, 400); // walk-in
  assert.equal((await giveBack(owner, 99999, [{ saleItemId: 1, quantity: 1 }])).status, 404);
  assert.deepEqual([await count('sale_returns'), await stockOf(ids.mouse)], before);
});

it('on a credit sale the returned value first cancels the due; only the rest is refunded', async () => {
  // 2 mice = 1000, paid 400, due 600.
  const sale = (await sell(staff, { customerId: ids.salma, items: [product(ids.mouse, 2)], payments: [cash('400')] })).body.sale;
  ids.creditSale = sale.id;
  const line = (await saleOf(sale.id)).items[0].id;
  assert.equal((await customerRow(ids.salma)).current_due, '600.00');

  // Return one (500): due 600 → 100, nothing refunded.
  const first = await giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }]);
  assert.deepEqual([first.body.return.returnAmount, first.body.return.dueReduced, first.body.return.refundAmount], ['500.00', '500.00', '0.00']);
  assert.deepEqual(money(await saleOf(sale.id)), ['1000.00', '500.00', '400.00', '100.00', 'partial']);
  assert.equal((await customerRow(ids.salma)).current_due, '100.00');

  // Return the other (500): cancels the last 100 of due, 400 goes to her advance balance.
  const second = await giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }], { refundMethod: 'advance_credit' });
  assert.deepEqual([second.body.return.dueReduced, second.body.return.refundAmount, second.body.return.refundMethod], ['100.00', '400.00', 'advance_credit']);
  assert.deepEqual(money(await saleOf(sale.id)), ['1000.00', '1000.00', '0.00', '0.00', 'paid']);
  assert.deepEqual(await customerRow(ids.salma), { current_due: '0.00', advance_balance: '400.00' });
  assert.equal((await one("SELECT movement_type, amount FROM customer_advance_movements WHERE customer_id = ?", [ids.salma])).movement_type, 'return_credit');

  assert.equal((await giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }])).status, 400); // nothing left to return
});

it('a sale-level discount is taken off the returned value in proportion', async () => {
  // 2 pendrives = 900, discount 90 → total 810. One returned is worth 405, not 450.
  const sale = (await sell(owner, { items: [product(ids.pendrive, 2)], discountAmount: '90', payments: [cash('810')] })).body.sale;
  const line = (await saleOf(sale.id)).items[0].id;
  const first = await giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }]);
  assert.equal(first.body.return.refundAmount, '405.00');
  const second = await giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }]);
  assert.equal(second.body.return.refundAmount, '405.00');
  // Everything returned: exactly the 810 that was paid went back, never more.
  assert.deepEqual(money(await saleOf(sale.id)), ['810.00', '810.00', '0.00', '0.00', 'paid']);

  // Awkward rounding: 3 items at 33.33 with a discount; the returns still add up to the total.
  const odd = (await owner.post('/products', { categoryId: ids.category, sku: 'ODD', name: 'Odd Price', price: '33.33', openingStock: 9 })).body.product.id;
  const oddSale = (await sell(owner, { items: [product(odd, 3)], discountAmount: '10', payments: [cash('89.99')] })).body.sale;
  const oddLine = (await saleOf(oddSale.id)).items[0].id;
  for (let i = 0; i < 3; i++) assert.equal((await giveBack(owner, oddSale.id, [{ saleItemId: oddLine, quantity: 1 }])).status, 201);
  const end = await saleOf(oddSale.id);
  assert.deepEqual([end.returnedAmount, end.refundedAmount, end.paidAmount, end.dueAmount], ['89.99', '89.99', '0.00', '0.00']);
});

it('one return submitted six times at once is stored once and restocks once', async () => {
  const sale = (await sell(staff, { items: [product(ids.pendrive, 2)], payments: [cash('900')] })).body.sale;
  const line = (await saleOf(sale.id)).items[0].id;
  const stock = await stockOf(ids.pendrive);
  const body = { idempotencyKey: key(), reason: 'Faulty', items: [{ saleItemId: line, quantity: 1 }] };
  const results = await Promise.all(Array.from({ length: 6 }, () => owner.post(`/sales/${sale.id}/returns`, body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200 && r.body.duplicate).length, 5);
  assert.equal(await stockOf(ids.pendrive), stock + 1);
  assert.equal((await saleOf(sale.id)).returnedAmount, '450.00');
  ids.returnedSale = sale.id;

  // Different returns racing for the last unit: only one can have it.
  const race = await Promise.all(Array.from({ length: 5 }, () => giveBack(owner, sale.id, [{ saleItemId: line, quantity: 1 }])));
  assert.equal(race.filter((r) => r.status === 201).length, 1);
  assert.equal(race.filter((r) => r.status === 400).length, 4);
  assert.equal(await stockOf(ids.pendrive), stock + 2);
});

it('a sale with a return cannot be voided, and a refunded payment cannot be removed', async () => {
  assert.equal((await owner.post(`/sales/${ids.returnedSale}/void`, { reason: 'Try', voidPayments: true })).status, 409);
  const payment = (await saleOf(ids.paidSale)).payments[0].id;
  const res = await owner.post(`/payments/${payment}/void`, { reason: 'Try' });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /refund of 500\.00 paid out/);
  assert.deepEqual(money(await saleOf(ids.paidSale)), ['1600.00', '500.00', '1100.00', '0.00', 'paid']);
});

it('a return is refused while a payment on the sale is still unverified', async () => {
  const sale = (await sell(staff, { customerId: ids.salma, items: [product(ids.mouse, 1)], payments: [{ method: 'bkash', amount: '500', reference: 'RET-BK-1' }] })).body.sale;
  const detail = await saleOf(sale.id);
  const res = await giveBack(owner, sale.id, [{ saleItemId: detail.items[0].id, quantity: 1 }]);
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /awaiting verification/);
  await owner.post(`/payments/${detail.payments[0].id}/verify`);
  assert.equal((await giveBack(owner, sale.id, [{ saleItemId: detail.items[0].id, quantity: 1 }])).status, 201);
  ids.salmaLastSale = sale.id;
});

it('after all of the above: stock, sales, customers and advance all reconcile', async () => {
  assert.deepEqual((await owner.get('/inventory/reconcile')).body.differences, []);
  const sales = await db.query(
    `SELECT s.id FROM sales s
      LEFT JOIN (SELECT a.sale_id, SUM(IF(p.is_verified = 1, a.amount, 0)) AS verified FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.status = 'active' GROUP BY a.sale_id) x ON x.sale_id = s.id
      LEFT JOIN (SELECT sale_id, SUM(return_amount) AS returned, SUM(total_refund) AS refunded FROM sale_returns GROUP BY sale_id) r ON r.sale_id = s.id
     WHERE s.returned_amount <> COALESCE(r.returned, 0) OR s.refunded_amount <> COALESCE(r.refunded, 0)
        OR s.paid_amount <> COALESCE(x.verified, 0) - COALESCE(r.refunded, 0)
        OR s.due_amount <> s.total_amount - s.returned_amount - s.paid_amount`,
  );
  assert.deepEqual(sales, []);
  assert.deepEqual(await db.query("SELECT c.id FROM customers c WHERE c.current_due <> (SELECT COALESCE(SUM(s.due_amount), 0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed')"), []);
  assert.deepEqual(await db.query('SELECT c.id FROM customers c WHERE c.advance_balance <> (SELECT COALESCE(SUM(m.amount), 0) FROM customer_advance_movements m WHERE m.customer_id = c.id)'), []);
});

// --- customer portal --------------------------------------------------------

it('a customer sees their own bills, receipts, advance history and warranties in the portal', async () => {
  const warranty = (await sell(staff, { customerId: ids.salma, items: [product(ids.pendrive, 1, { warranty: '1 Year', serialNo: 'SN-900' })], payments: [cash('450')] })).body.sale;
  ids.warrantySale = warranty.id;

  const salma = app.client();
  assert.equal((await salma.post('/portal/login', { phone: '01722222222', pin: ids.salmaPin })).status, 200);

  const invoices = (await salma.get('/portal/invoices')).body.invoices;
  assert.equal(invoices.length, 3);
  assert.ok(invoices.every((i) => /^INV-\d{6}$/.test(i.invoiceNo)));
  assert.deepEqual(Object.keys(invoices[0]).sort(), ['dueAmount', 'id', 'invoiceNo', 'paidAmount', 'paymentStatus', 'returnedAmount', 'saleDate', 'saleType', 'status', 'totalAmount', 'unverifiedAmount']);

  const bill = (await salma.get(`/portal/invoices/${ids.creditSale}`)).body.bill;
  assert.deepEqual(money(bill), ['1000.00', '1000.00', '0.00', '0.00', 'paid']);
  assert.equal(bill.returns.length, 2);
  assert.equal(bill.items[0].name, 'USB Mouse');

  const payments = (await salma.get('/portal/payments')).body.payments;
  assert.ok(payments.length >= 2);
  assert.ok(payments.every((p) => /^RCP-\d{6}$/.test(p.receiptNo) && p.invoices));

  const advance = (await salma.get('/portal/advance')).body;
  assert.equal(advance.advanceBalance, '400.00');
  assert.deepEqual(advance.movements.map((m) => [m.type, m.amount]), [['return_credit', '400.00']]);

  const warranties = (await salma.get('/portal/warranties')).body.warranties;
  assert.deepEqual(warranties.map((w) => [w.name, w.warranty, w.serialNo, w.quantity]), [['Pendrive 32GB', '1 Year', 'SN-900', 1]]);
  assert.equal((await salma.get('/portal/me')).body.customer.advanceBalance, '400.00');
});

it('the portal never shows cost, internal notes, staff details or another customer’s records', async () => {
  await owner.post(`/sales/${ids.warrantySale}/void`, { reason: 'Internal reason: staff mistake', voidPayments: true });
  const salma = app.client();
  await salma.post('/portal/login', { phone: '01722222222', pin: ids.salmaPin });

  const bill = (await salma.get(`/portal/invoices/${ids.warrantySale}`)).body.bill;
  const text = JSON.stringify(bill);
  for (const secret of ['costPrice', 'cost_price', '380', 'voidReason', 'Internal reason', 'qrToken', 'recordedByName', 'productId', 'note']) assert.equal(text.includes(secret), false, secret);
  assert.equal(bill.status, 'void');
  assert.deepEqual(bill.payments, []); // voided payments are not shown as receipts
  assert.deepEqual((await salma.get('/portal/warranties')).body.warranties, []); // a voided sale carries no warranty

  // Karim's bill: looks exactly like a bill that does not exist.
  const other = await salma.get(`/portal/invoices/${ids.advanceSale}`);
  const missing = await salma.get('/portal/invoices/999999');
  assert.equal(other.status, 404);
  assert.deepEqual(other.body, missing.body);
  for (const bad of ['abc', '1 OR 1=1', '-1', '1e3']) assert.equal((await salma.get(`/portal/invoices/${encodeURIComponent(bad)}`)).status, 404, bad);

  const karimInvoices = (await db.query('SELECT invoice_no FROM sales WHERE customer_id = ?', [ids.karim])).map((r) => r.invoice_no);
  const mine = JSON.stringify([(await salma.get('/portal/invoices')).body, (await salma.get('/portal/payments')).body, (await salma.get('/portal/advance')).body]);
  for (const invoiceNo of karimInvoices) assert.equal(mine.includes(invoiceNo), false, invoiceNo);

  // The portal is read-only: there is nothing to post to, and staff endpoints refuse a customer.
  assert.equal((await salma.post(`/customers/${ids.salma}/advance-deposit`, { idempotencyKey: key(), amount: '99999' })).status, 401);
  assert.equal((await salma.post(`/sales/${ids.creditSale}/returns`, { idempotencyKey: key(), reason: 'x', items: [] })).status, 401);
  assert.equal((await salma.get(`/sales/${ids.creditSale}`)).status, 401);
  for (const url of ['/portal/invoices', '/portal/payments', '/portal/advance', '/portal/warranties']) assert.equal((await app.client().get(url)).status, 401, url);
});

it('the QR link on an invoice opens that one bill without logging in, and nothing else', async () => {
  const token = (await saleOf(ids.creditSale)).qrToken;
  assert.match(token, /^[0-9a-f]{32}$/);
  assert.ok(!('qrToken' in (await staff.get(`/sales/${ids.creditSale}`)).body.sale) === false); // staff see it, to print the code

  const anon = app.client();
  const res = await anon.get(`/portal/view/${token}`);
  assert.equal(res.status, 200);
  assert.equal(res.body.bill.id, ids.creditSale);
  assert.equal(res.body.bill.items[0].name, 'USB Mouse');
  const text = JSON.stringify(res.body);
  for (const secret of ['costPrice', 'qrToken', 'customerId', 'recordedByName', 'voidReason']) assert.equal(text.includes(secret), false, secret);

  // It grants no session and no way to other bills.
  assert.equal(res.setCookie.length, 0);
  assert.equal((await anon.get('/portal/invoices')).status, 401);
  assert.equal((await anon.get(`/portal/invoices/${ids.creditSale}`)).status, 401);
  for (const bad of ['0'.repeat(32), token.slice(0, 31), `${token}0`, token.toUpperCase(), 'not-a-token', '%27%20OR%201%3D1']) assert.equal((await anon.get(`/portal/view/${bad}`)).status, 404, bad);
  // Every sale has its own token.
  assert.equal(Number((await one('SELECT COUNT(DISTINCT qr_token) AS n FROM sales WHERE sale_type = ?', ['sale'])).n), Number((await one("SELECT COUNT(*) AS n FROM sales WHERE sale_type = 'sale'")).n));
});

it('shop details for the bill header are public; nothing else in settings is', async () => {
  const res = await app.client().get('/portal/shop');
  assert.equal(res.status, 200);
  assert.equal(res.body.shop['shop.name'], 'SS Computer Training Centre');
  assert.deepEqual(Object.keys(res.body.shop).filter((k) => !/^(shop\.(name|tagline|address|phone)|invoice\.footer|payment\.(bkash|nagad)_number)$/.test(k)), []);
});

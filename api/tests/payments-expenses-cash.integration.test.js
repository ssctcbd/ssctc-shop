const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { cashDate } = require('../src/lib/cash');
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
  await openCashDay(owner, '1000');

  ids.category = (await owner.post('/categories', { name: 'Gadgets' })).body.category.id;
  ids.pendrive = (await owner.post('/products', { categoryId: ids.category, sku: 'PD32', name: 'Pendrive 32GB', price: 450, costPrice: 380, openingStock: 200 })).body.product.id;
  ids.paper = (await owner.post('/products', { categoryId: ids.category, sku: 'PAPER', name: 'A4 Paper', price: 520, costPrice: 470, openingStock: 5 })).body.product.id;
  ids.supplier = (await owner.post('/suppliers', { name: 'Karim Traders' })).body.supplier.id;
  ids.karim = (await owner.post('/customers', { name: 'Karim Mia', phone: '01711111111' })).body.customer.id;
  ids.salma = (await owner.post('/customers', { name: 'Salma Begum', phone: '01722222222' })).body.customer.id;
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const key = () => crypto.randomUUID();
const one = async (sql, params = []) => (await db.query(sql, params))[0];
const count = async (table, where = '1 = 1') => Number((await one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`)).n);
const dueOf = async (id) => (await one('SELECT current_due FROM customers WHERE id = ?', [id])).current_due;
const advanceOf = async (id) => (await one('SELECT advance_balance FROM customers WHERE id = ?', [id])).advance_balance;
const payable = async () => (await one('SELECT current_payable FROM suppliers WHERE id = ?', [ids.supplier])).current_payable;
const saleRow = (id) => one('SELECT paid_amount, unverified_amount, due_amount, payment_status FROM sales WHERE id = ?', [id]);
/** A Dhaka calendar date `n` days before today. */
const daysAgo = (n) => new Date(Date.now() + 6 * 3600 * 1000 - n * 86400 * 1000).toISOString().slice(0, 10);
const sell = (client, body) => client.post('/sales', { idempotencyKey: key(), ...body });
const pendrives = (quantity) => [{ type: 'product', productId: ids.pendrive, quantity }];
const creditSale = async (customerId, quantity, date) => (await sell(owner, { customerId, items: pendrives(quantity), ...(date ? { date } : {}) })).body.sale.id;
const collect = (client, body) => client.post('/payments', { idempotencyKey: key(), customerId: ids.karim, ...body });
const bill = (extra = {}) => owner.post('/purchases', { supplierId: ids.supplier, idempotencyKey: key(), items: [{ productId: ids.paper, quantity: 2, unitCost: '500' }], ...extra });
const pay = (client, body) => client.post('/supplier-payments', { idempotencyKey: key(), supplierId: ids.supplier, ...body });
const spend = (client, body) => client.post('/expenses', { idempotencyKey: key(), categoryId: ids.tea, title: 'Tea for the shop', amount: 50, ...body });
const drawer = async () => (await owner.get('/cash-register/current')).body;
/** A shop day `n` days before the current one. */
const shopDay = (n) => new Date(Date.parse(`${cashDate()}T00:00:00Z`) - n * 86400 * 1000).toISOString().slice(0, 10);

// --- migration 004 ----------------------------------------------------------

it('migration 004 can be run again, and gives an earlier with-bill payment its allocation', async () => {
  const purchase = (await bill({ paidAmount: '300' })).body.purchase;
  assert.deepEqual([purchase.totalAmount, purchase.paidAmount, purchase.dueAmount, purchase.paymentStatus], ['1000.00', '300.00', '700.00', 'partial']);
  ids.billWithPayment = purchase.id;
  // As the data looked before this migration: a payment row and no allocation.
  await db.query('DELETE FROM supplier_payment_allocations');

  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '004_payments_expenses_cash_closing.sql'), 'utf8');
  const conn = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  try {
    await conn.query(sql);
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  const rows = await db.query('SELECT purchase_id, amount FROM supplier_payment_allocations');
  assert.deepEqual(rows.map((r) => [r.purchase_id, r.amount]), [[ids.billWithPayment, '300.00']]);
  assert.equal(await count('document_counters', "doc_type = 'cash_drawer'"), 1);
});

// --- due collection ---------------------------------------------------------

it('a due collection goes to the oldest bill first and can cover several bills', async () => {
  ids.s1 = await creditSale(ids.karim, 1, daysAgo(10)); // 450
  ids.s2 = await creditSale(ids.karim, 2, daysAgo(5)); // 900
  ids.s3 = await creditSale(ids.karim, 1); // 450
  assert.equal(await dueOf(ids.karim), '1800.00');

  const res = await collect(staff, { amount: 1000, note: 'Paid at the counter' });
  assert.equal(res.status, 201);
  const p = res.body.payment;
  ids.collection1 = p.id;
  assert.match(p.receiptNo, /^RCP-\d{6}$/);
  assert.deepEqual([p.kind, p.method, p.amount, p.isVerified, p.customerName], ['due_collection', 'cash', '1000.00', true, 'Karim Mia']);
  assert.deepEqual(p.allocations.map((a) => [a.saleId, a.amount, a.saleDue]), [[ids.s1, '450.00', '0.00'], [ids.s2, '550.00', '350.00']]);
  assert.equal(p.customerDue, '800.00');

  assert.deepEqual(await saleRow(ids.s1), { paid_amount: '450.00', unverified_amount: '0.00', due_amount: '0.00', payment_status: 'paid' });
  assert.deepEqual(await saleRow(ids.s2), { paid_amount: '550.00', unverified_amount: '0.00', due_amount: '350.00', payment_status: 'partial' });
  assert.equal(await dueOf(ids.karim), '800.00');

  const log = await one("SELECT new_values FROM audit_logs WHERE action = 'payment.collect' ORDER BY id DESC LIMIT 1");
  assert.equal(log.new_values.bills.length, 2);
  // The receipt can be read again later.
  assert.deepEqual((await staff.get(`/payments/${p.id}`)).body.payment.allocations.length, 2);
});

it('the collector can choose the bills; the split must add up and fit each bill', async () => {
  const wrongSum = await collect(staff, { amount: 300, allocations: [{ saleId: ids.s3, amount: 200 }] });
  assert.equal(wrongSum.status, 400);
  assert.ok(wrongSum.body.error.details.fields.amount);
  const tooMuch = await collect(staff, { amount: 400, allocations: [{ saleId: ids.s2, amount: 400 }] });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error.details.fields['allocations.0.amount'], /Only 350\.00/);
  // A bill that is paid, or belongs to someone else, is not collectable.
  assert.equal((await collect(staff, { amount: 10, allocations: [{ saleId: ids.s1, amount: 10 }] })).status, 400);
  const other = await creditSale(ids.salma, 1);
  assert.equal((await collect(staff, { amount: 10, allocations: [{ saleId: other, amount: 10 }] })).status, 400);
  ids.salmaSale = other;

  const ok = await collect(staff, { amount: 300, allocations: [{ saleId: ids.s3, amount: 300 }] });
  assert.equal(ok.status, 201);
  assert.equal((await saleRow(ids.s3)).due_amount, '150.00');
  assert.equal((await saleRow(ids.s2)).due_amount, '350.00');
  assert.equal(await dueOf(ids.karim), '500.00');
});

it('more than the customer owes is refused, and nothing is stored', async () => {
  const before = await count('payments');
  const res = await collect(staff, { amount: 500.01 });
  assert.equal(res.status, 400);
  assert.match(res.body.error.details.fields.amount, /Only 500\.00 can be collected/);
  assert.equal(await count('payments'), before);
  assert.equal(await dueOf(ids.karim), '500.00');
});

it('a bKash collection by staff waits for verification, and that money cannot be collected a second time', async () => {
  // Staff ticking "verified" is not honoured.
  const res = await collect(staff, { amount: 200, method: 'bkash', reference: 'trx777', verified: true });
  assert.equal(res.status, 201);
  ids.bkash = res.body.payment.id;
  assert.deepEqual([res.body.payment.isVerified, res.body.payment.reference], [false, 'TRX777']);
  assert.equal(await dueOf(ids.karim), '500.00');

  // 500 is owed, 200 is already claimed: only 300 more can be taken.
  const again = await collect(staff, { amount: 500 });
  assert.equal(again.status, 400);
  assert.match(again.body.error.details.fields.amount, /Only 300\.00/);
  // The same transaction ID cannot be recorded twice.
  assert.equal((await collect(staff, { amount: 50, method: 'bkash', reference: 'TRX777' })).status, 409);

  assert.equal((await staff.post(`/payments/${ids.bkash}/verify`)).status, 403);
  assert.equal((await owner.post(`/payments/${ids.bkash}/verify`)).status, 200);
  assert.equal(await dueOf(ids.karim), '300.00');
});

it('one collection saved twice, or ten times at once, is stored once', async () => {
  const body = { idempotencyKey: key(), customerId: ids.karim, amount: 50 };
  const first = await staff.post('/payments', body);
  const second = await staff.post('/payments', body);
  assert.deepEqual([first.status, second.status, second.body.duplicate], [201, 200, true]);
  assert.equal(first.body.payment.id, second.body.payment.id);

  const racing = { idempotencyKey: key(), customerId: ids.karim, amount: 50 };
  const results = await Promise.all(Array.from({ length: 10 }, () => staff.post('/payments', racing)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200).length, 9);
  assert.equal(new Set(results.map((r) => r.body.payment.id)).size, 1);
  assert.equal(await dueOf(ids.karim), '200.00');
});

it('five people collecting the same last 200 at the same moment: one succeeds', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => collect(staff, { amount: 200 })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, 4);
  assert.equal(await dueOf(ids.karim), '0.00');
  assert.equal(await count('sales', `customer_id = ${ids.karim} AND due_amount <> 0`), 0);
});

it('a due can be settled from the advance balance, never beyond it', async () => {
  assert.equal((await owner.post(`/customers/${ids.salma}/advance-deposit`, { idempotencyKey: key(), amount: 300 })).status, 201);
  const tooMuch = await collect(staff, { customerId: ids.salma, amount: 450, method: 'customer_advance' });
  assert.equal(tooMuch.status, 409);
  assert.equal(await advanceOf(ids.salma), '300.00');
  assert.equal(await dueOf(ids.salma), '450.00');

  const res = await collect(staff, { customerId: ids.salma, amount: 250, method: 'customer_advance' });
  assert.equal(res.status, 201);
  ids.advanceCollection = res.body.payment.id;
  assert.equal(res.body.payment.isVerified, true);
  assert.equal(await advanceOf(ids.salma), '50.00');
  assert.equal(await dueOf(ids.salma), '200.00');
});

it('voiding a collection puts the dues back, and the advance it spent', async () => {
  assert.equal((await staff.post(`/payments/${ids.advanceCollection}/void`, { reason: 'Wrong customer' })).status, 403);
  assert.equal((await owner.post(`/payments/${ids.advanceCollection}/void`, { reason: 'Wrong customer' })).status, 200);
  assert.equal(await advanceOf(ids.salma), '300.00');
  assert.equal(await dueOf(ids.salma), '450.00');
  // A cash payment is never "unverified"; it is voided.
  assert.equal((await owner.post(`/payments/${ids.collection1}/unverify`)).status, 409);
});

it('only the Owner may back-date a collection, and never into the future', async () => {
  assert.equal((await collect(staff, { customerId: ids.salma, amount: 10, date: daysAgo(1) })).status, 403);
  assert.equal((await collect(owner, { customerId: ids.salma, amount: 10, date: daysAgo(-1) })).status, 400);
  const res = await collect(owner, { customerId: ids.salma, amount: 10, date: daysAgo(1) });
  assert.equal(res.status, 201);
  assert.equal(await dueOf(ids.salma), '440.00');
});

it('the payments list filters by customer, method, kind and verification, and totals leave out voids', async () => {
  const all = (await staff.get(`/payments?customerId=${ids.karim}`)).body;
  assert.equal(all.total, await count('payments', `customer_id = ${ids.karim}`));
  const collections = (await staff.get(`/payments?customerId=${ids.karim}&kind=due_collection`)).body;
  assert.equal(collections.totalVerified, '1800.00');
  assert.ok(collections.items.every((p) => p.kind === 'due_collection' && p.invoices));
  assert.equal((await staff.get('/payments?method=bkash')).body.items.length, 1);
  assert.equal((await staff.get('/payments?verified=0')).body.total, 0);
  assert.equal((await staff.get('/payments?search=TRX777')).body.items[0].id, ids.bkash);
  const voided = (await staff.get(`/payments?customerId=${ids.salma}&status=void`)).body;
  assert.deepEqual([voided.total, voided.totalVerified], [1, '0.00']);
  assert.equal((await app.client().get('/payments')).status, 401);
});

it('the due list shows who owes, how many bills and since when; open bills are oldest first', async () => {
  const dues = (await staff.get('/dues')).body;
  assert.deepEqual(dues.items.map((d) => [d.id, d.currentDue, d.unpaidSales]), [[ids.salma, '440.00', 1]]);
  assert.equal(dues.totalDue, '440.00');
  const open = (await staff.get(`/customers/${ids.salma}/open-sales`)).body.sales;
  assert.deepEqual(open.map((s) => [s.id, s.dueAmount, s.collectableAmount]), [[ids.salmaSale, '440.00', '440.00']]);
});

it('the Owner can pay an advance balance back in cash; it cannot be overdrawn or paid twice', async () => {
  assert.equal((await staff.post(`/customers/${ids.salma}/advance-refund`, { idempotencyKey: key(), amount: 100 })).status, 403);
  assert.equal((await owner.post(`/customers/${ids.salma}/advance-refund`, { idempotencyKey: key(), amount: 300.01 })).status, 409);
  const body = { idempotencyKey: key(), amount: 100, note: 'Asked for it back' };
  const first = await owner.post(`/customers/${ids.salma}/advance-refund`, body);
  const second = await owner.post(`/customers/${ids.salma}/advance-refund`, body);
  assert.deepEqual([first.status, second.status, second.body.duplicate], [201, 200, true]);
  assert.deepEqual([first.body.refund.amount, first.body.refund.balanceAfter], ['100.00', '200.00']);
  assert.equal(await advanceOf(ids.salma), '200.00');
  const ledger = await one('SELECT COALESCE(SUM(amount), 0) AS total FROM customer_advance_movements WHERE customer_id = ?', [ids.salma]);
  assert.equal(ledger.total, '200.00');
});

// --- supplier payments ------------------------------------------------------

it('a supplier payment goes to the oldest bill first and lowers the payable', async () => {
  ids.billOld = (await bill({ date: daysAgo(20) })).body.purchase.id; // 1000
  ids.billNew = (await bill()).body.purchase.id; // 1000
  assert.equal(await payable(), '2700.00'); // 700 left on the first bill + 2000

  assert.equal((await pay(staff, { amount: 100 })).status, 403);
  const res = await pay(owner, { amount: 1200, method: 'bank_transfer', reference: 'CHQ-55' });
  assert.equal(res.status, 201);
  ids.supplierPayment = res.body.payment.id;
  assert.match(res.body.payment.voucherNo, /^SPAY-\d{6}$/);
  const due = async (id) => (await one('SELECT due_amount FROM purchases WHERE id = ?', [id])).due_amount;
  assert.deepEqual([await due(ids.billOld), await due(ids.billWithPayment), await due(ids.billNew)], ['0.00', '500.00', '1000.00']);
  assert.equal(await payable(), '1500.00');
  assert.equal((await owner.get(`/suppliers/${ids.supplier}/open-purchases`)).body.purchases.length, 2);
});

it('a supplier cannot be paid more than is owed, and the chosen bills must add up', async () => {
  assert.equal((await pay(owner, { amount: 1500.01 })).status, 400);
  assert.equal((await pay(owner, { amount: 600, allocations: [{ purchaseId: ids.billWithPayment, amount: 600 }] })).status, 400);
  assert.equal((await pay(owner, { amount: 100, allocations: [{ purchaseId: ids.billOld, amount: 100 }] })).status, 400);
  assert.equal((await pay(owner, { amount: 100, allocations: [{ purchaseId: ids.billNew, amount: 90 }] })).status, 400);
  assert.equal(await payable(), '1500.00');

  const body = { idempotencyKey: key(), supplierId: ids.supplier, amount: 500, allocations: [{ purchaseId: ids.billNew, amount: 500 }] };
  const results = await Promise.all(Array.from({ length: 6 }, () => owner.post('/supplier-payments', body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(new Set(results.map((r) => r.body.payment.id)).size, 1);
  assert.equal(await payable(), '1000.00');
});

it('five payments of the whole payable at the same moment: one succeeds', async () => {
  const results = await Promise.all(Array.from({ length: 5 }, () => pay(owner, { amount: 1000 })));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 400).length, 4);
  assert.equal(await payable(), '0.00');
  ids.lastSupplierPayment = results.find((r) => r.status === 201).body.payment.id;
});

it('voiding a supplier payment makes its bills owed again; a bill can be voided once its payments are', async () => {
  assert.equal((await staff.post(`/supplier-payments/${ids.lastSupplierPayment}/void`, { reason: 'Entered twice' })).status, 403);
  assert.equal((await owner.post(`/supplier-payments/${ids.lastSupplierPayment}/void`, { reason: 'Entered twice' })).status, 200);
  assert.equal((await owner.post(`/supplier-payments/${ids.lastSupplierPayment}/void`, { reason: 'Entered twice' })).status, 409);
  assert.equal(await payable(), '1000.00');

  // A fresh bill paid in part: void is refused until the payment is voided.
  const fresh = (await bill({ paidAmount: '400' })).body.purchase.id;
  const refused = await owner.post(`/purchases/${fresh}/void`, { reason: 'Wrong supplier' });
  assert.equal(refused.status, 409);
  assert.match(refused.body.error.message, /Void the payment first/);
  const payment = (await owner.get(`/purchases/${fresh}`)).body.purchase.payments[0];
  assert.equal((await owner.post(`/supplier-payments/${payment.id}/void`, { reason: 'Wrong supplier' })).status, 200);
  assert.equal((await owner.post(`/purchases/${fresh}/void`, { reason: 'Wrong supplier' })).status, 200);
  assert.equal(await payable(), '1000.00');

  const list = (await owner.get(`/supplier-payments?supplierId=${ids.supplier}`)).body;
  assert.equal(list.total, await count('supplier_payments'));
  const active = await one("SELECT COALESCE(SUM(amount), 0) AS total FROM supplier_payments WHERE status = 'active'");
  assert.equal(list.totalAmount, active.total);
});

it('purchases and payables reconcile with the payments allocated to them', async () => {
  const wrong = await db.query(
    `SELECT pu.id FROM purchases pu
       LEFT JOIN (SELECT a.purchase_id, SUM(a.amount) AS paid FROM supplier_payment_allocations a JOIN supplier_payments p ON p.id = a.payment_id WHERE p.status = 'active' GROUP BY a.purchase_id) x ON x.purchase_id = pu.id
      WHERE pu.paid_amount <> COALESCE(x.paid, 0) OR pu.due_amount <> pu.total_amount - COALESCE(x.paid, 0)`,
  );
  assert.deepEqual(wrong, []);
  const split = await db.query('SELECT p.id FROM supplier_payments p JOIN supplier_payment_allocations a ON a.payment_id = p.id GROUP BY p.id, p.amount HAVING SUM(a.amount) <> p.amount');
  assert.deepEqual(split, []);
});

// --- expenses ---------------------------------------------------------------

it('expense categories: the seeded list, a new one, and no duplicates', async () => {
  const categories = (await staff.get('/expense-categories')).body.categories;
  assert.equal(categories.length, 7);
  ids.tea = categories.find((c) => c.name === 'Tea/Snacks').id;
  assert.equal((await staff.post('/expense-categories', { name: 'Transport' })).status, 403);
  const created = await owner.post('/expense-categories', { name: 'Transport' });
  assert.equal(created.status, 201);
  ids.transport = created.body.category.id;
  assert.equal((await owner.post('/expense-categories', { name: 'transport' })).status, 409);
  assert.equal((await owner.put(`/expense-categories/${ids.transport}`, { isActive: false })).body.category.isActive, false);
});

it('staff records an expense; it gets a voucher, and one save is stored once', async () => {
  const body = { idempotencyKey: key(), categoryId: ids.tea, title: 'Tea for the shop', amount: '50', note: 'Morning' };
  const first = await staff.post('/expenses', body);
  const second = await staff.post('/expenses', body);
  assert.deepEqual([first.status, second.status, second.body.duplicate], [201, 200, true]);
  ids.expense = first.body.expense.id;
  assert.match(first.body.expense.voucherNo, /^EXP-\d{6}$/);
  assert.deepEqual([first.body.expense.amount, first.body.expense.method, first.body.expense.categoryName, first.body.expense.status], ['50.00', 'cash', 'Tea/Snacks', 'active']);
  assert.equal(await count('expenses'), 1);

  assert.equal((await spend(staff, { amount: 0 })).status, 400);
  assert.equal((await spend(staff, { categoryId: 999999 })).status, 400);
  assert.equal((await spend(staff, { categoryId: ids.transport })).status, 400); // switched off
  assert.equal((await spend(staff, { title: '' })).status, 400);
});

it('only the Owner back-dates or voids an expense; a voided one stays listed and is not counted', async () => {
  assert.equal((await spend(staff, { date: daysAgo(2) })).status, 403);
  assert.equal((await spend(owner, { date: daysAgo(-1) })).status, 400);
  const old = await spend(owner, { date: daysAgo(2), amount: 120, method: 'bkash', title: 'Internet bill' });
  assert.equal(old.status, 201);
  ids.bkashExpense = old.body.expense.id;

  const mistake = (await spend(staff, { amount: 999 })).body.expense.id;
  assert.equal((await staff.post(`/expenses/${mistake}/void`, { reason: 'Typed wrong' })).status, 403);
  assert.equal((await owner.post(`/expenses/${mistake}/void`, {})).status, 400);
  assert.equal((await owner.post(`/expenses/${mistake}/void`, { reason: 'Typed wrong' })).status, 200);
  assert.equal((await owner.post(`/expenses/${mistake}/void`, { reason: 'Typed wrong' })).status, 409);

  const list = (await staff.get('/expenses')).body;
  assert.deepEqual([list.total, list.totalAmount], [3, '170.00']);
  assert.equal((await staff.get('/expenses?method=bkash')).body.totalAmount, '120.00');
  assert.equal((await staff.get(`/expenses?from=${daysAgo(0)}`)).body.totalAmount, '50.00');
  assert.equal((await staff.get('/expenses?status=void')).body.items[0].voidReason, 'Typed wrong');
});

// --- cash closing -----------------------------------------------------------

/** The same figures, added up straight from the tables. */
async function cashFromTables() {
  const total = async (sql) => (await one(sql)).t;
  return {
    cashSales: await total("SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE method = 'cash' AND kind = 'sale' AND status = 'active'"),
    cashDuesCollected: await total("SELECT COALESCE(SUM(amount), 0) AS t FROM payments WHERE method = 'cash' AND kind = 'due_collection' AND status = 'active'"),
    cashAdvanceDeposits: await total("SELECT COALESCE(SUM(amount), 0) AS t FROM customer_advance_movements WHERE movement_type = 'deposit' AND method = 'cash'"),
    cashExpenses: await total("SELECT COALESCE(SUM(amount), 0) AS t FROM expenses WHERE payment_method = 'cash' AND status = 'active'"),
    cashSupplierPaid: await total("SELECT COALESCE(SUM(amount), 0) AS t FROM supplier_payments WHERE method = 'cash' AND status = 'active'"),
    cashRefunds: await total("SELECT COALESCE(SUM(-amount), 0) AS t FROM customer_advance_movements WHERE movement_type = 'refund'"),
  };
}

it('while the day is open the drawer shows every cash movement since the morning count, matching the tables', async () => {
  // A walk-in cash sale, so "cash sales" is not empty.
  const walkIn = await sell(staff, { items: pendrives(2), payments: [{ method: 'cash', amount: 900 }] });
  assert.equal(walkIn.status, 201);
  ids.walkInSale = walkIn.body.sale.id;

  const d = await drawer();
  const t = await cashFromTables();
  // The day was opened with 1000 in the drawer, before anything was recorded.
  assert.deepEqual([d.status, d.openingCash, d.lastClosing, d.carriedCash, d.stale], ['open', '1000.00', null, null, false]);
  assert.equal(d.periodStart, d.opening.openedAt);
  for (const figure of Object.keys(t)) assert.equal(d[figure], t[figure], figure);
  // 900 walk-in · 1000+300+50+50+200 collections (cash only) + 10 · 300 deposit · 50 tea · 1000+500 cash to the supplier is not cash: bank
  assert.deepEqual([d.cashSales, d.cashDuesCollected, d.cashAdvanceDeposits, d.cashExpenses, d.cashRefunds, d.cashVoidsIn, d.cashCommissionPaid], ['900.00', '1610.00', '300.00', '50.00', '100.00', '0.00', '0.00']);
  // bKash money is shown beside the drawer, never inside it.
  assert.equal(d.otherMethods.bkash, '200.00');
  assert.equal((await app.client().get('/cash-register/current')).status, 401);
});

it('the hand-over needs the figure on screen and a note for any difference, and staff can do it', async () => {
  const d = await drawer();
  const expected = d.expectedCash;
  const body = { actualCash: expected, expectedCash: expected };

  // The screen showed a different figure: someone recorded something meanwhile.
  const stale = await staff.post('/cash-register/close', { ...body, expectedCash: '1.00' });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.expectedCash, expected);
  const short = (Number(expected) - 20).toFixed(2);
  const noNote = await staff.post('/cash-register/close', { ...body, actualCash: short });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.error.details.fields.note, /short by 20\.00/);
  // The opening cash and what is taken out are no longer typed at the closing.
  assert.equal((await staff.post('/cash-register/close', { ...body, openingCash: '1000' })).status, 400);
  assert.equal((await staff.post('/cash-register/close', { ...body, withdrawn: '100' })).status, 400);
  assert.equal(await count('daily_cash_closings'), 0);

  const res = await staff.post('/cash-register/close', { ...body, actualCash: short, note: 'Twenty short, to be checked' });
  assert.equal(res.status, 201);
  const c = res.body.closing;
  ids.closing1 = c.id;
  assert.deepEqual(
    [c.closingDate, c.openingCash, c.expectedCash, c.actualCash, c.difference, c.cashWithdrawn, c.carriedForward, c.closedByName],
    [cashDate(), '1000.00', expected, short, '-20.00', '0.00', short, 'Rahim'],
  );
  ids.short = short;
  const log = await one("SELECT new_values FROM audit_logs WHERE action = 'cash.close'");
  assert.equal(log.new_values.difference, '-20.00');
});

it('after the hand-over nothing that moves money is recorded, and only the Owner takes cash from the drawer', async () => {
  for (const res of [
    await sell(staff, { items: pendrives(1), payments: [{ method: 'cash', amount: 450 }] }),
    await spend(staff, { amount: 10 }),
    await collect(staff, { customerId: ids.salma, amount: 10 }),
    await staff.post(`/customers/${ids.salma}/advance-deposit`, { idempotencyKey: key(), amount: 10 }),
    await pay(owner, { amount: 10 }),
  ]) {
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'cash_day_closed');
  }

  const d = await drawer();
  assert.deepEqual([d.status, d.carriedCash, d.lastClosing.id, d.expectedCash], ['closed', ids.short, ids.closing1, undefined]);
  const again = await staff.post('/cash-register/close', { actualCash: '0', expectedCash: '0' });
  assert.equal(again.status, 409);
  assert.match(again.body.error.message, /already been handed over/);

  assert.equal((await staff.post('/cash-register/receive', { amount: '100' })).status, 403);
  assert.equal((await owner.post('/cash-register/receive', { amount: (Number(ids.short) + 1).toFixed(2) })).status, 400);
  const first = await owner.post('/cash-register/receive', { amount: '1000', note: 'Taken home' });
  assert.equal(first.status, 201);
  assert.equal(first.body.carriedCash, (Number(ids.short) - 1000).toFixed(2));
  // Received in two goes; the closing keeps the running total.
  assert.equal((await owner.post('/cash-register/receive', { amount: '100' })).status, 201);
  ids.carried = (Number(ids.short) - 1100).toFixed(2);
  const after = await drawer();
  assert.deepEqual([after.carriedCash, after.lastClosing.cashWithdrawn, after.lastClosing.carriedForward, after.lastClosing.receipts.length], [ids.carried, '1100.00', ids.carried, 2]);

  // The same shop day cannot be opened a second time.
  const reopen = await staff.post('/cash-register/open', { countedCash: ids.carried, carriedCash: ids.carried });
  assert.equal(reopen.status, 409);
});

it('next morning the count is checked against what was left, a difference needs a note, and then work goes on', async () => {
  // Pretend the hand-over was yesterday.
  await db.query('UPDATE daily_cash_openings SET opening_date = ?', [shopDay(1)]);
  await db.query('UPDATE daily_cash_closings SET closing_date = ?', [shopDay(1)]);
  assert.equal((await owner.post('/cash-register/receive', { amount: '1' })).status, 201); // still before the opening
  ids.carried = (Number(ids.carried) - 1).toFixed(2);

  // The Owner took cash while the screen was open: the figure on it is out of date.
  const stale = await staff.post('/cash-register/open', { countedCash: ids.carried, carriedCash: (Number(ids.carried) + 1).toFixed(2) });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.details.carriedCash, ids.carried);
  const counted = (Number(ids.carried) - 10).toFixed(2);
  const noNote = await staff.post('/cash-register/open', { countedCash: counted, carriedCash: ids.carried });
  assert.equal(noNote.status, 400);
  assert.match(noNote.body.error.details.fields.note, /short by 10\.00/);

  const res = await staff.post('/cash-register/open', { countedCash: counted, carriedCash: ids.carried, note: 'Ten taka missing' });
  assert.equal(res.status, 201);
  const o = res.body.opening;
  assert.deepEqual([o.openingDate, o.carriedCash, o.countedCash, o.difference, o.openedByName], [cashDate(), ids.carried, counted, '-10.00', 'Rahim']);
  ids.opening2 = counted;
  assert.equal((await owner.post('/cash-register/receive', { amount: '1' })).status, 409); // only between a closing and the next opening
  assert.equal((await staff.post('/cash-register/open', { countedCash: counted, carriedCash: ids.carried })).status, 409);

  const d = await drawer();
  assert.deepEqual([d.status, d.openingCash, d.expectedCash, d.cashSales], ['open', counted, counted, '0.00']);
});

it('the next period counts new cash, hands back what is voided from before, and ignores what is made and voided inside it', async () => {
  // In: a cash sale 450, a cash deposit 100, a collection 40.
  const sale = await sell(staff, { items: pendrives(1), payments: [{ method: 'cash', amount: 450 }] });
  assert.equal(sale.status, 201);
  assert.equal((await staff.post(`/customers/${ids.salma}/advance-deposit`, { idempotencyKey: key(), amount: 100 })).status, 201);
  assert.equal((await collect(staff, { customerId: ids.salma, amount: 40 })).status, 201);
  // Out: an expense 30, a cash supplier payment 250, a cash refund for a return 450, an advance paid back 60.
  assert.equal((await spend(staff, { amount: 30 })).status, 201);
  assert.equal((await pay(owner, { amount: 250 })).status, 201);
  const item = (await owner.get(`/sales/${sale.body.sale.id}`)).body.sale.items[0].id;
  assert.equal((await owner.post(`/sales/${sale.body.sale.id}/returns`, { idempotencyKey: key(), reason: 'Did not work', items: [{ saleItemId: item, quantity: 1 }] })).status, 201);
  assert.equal((await owner.post(`/customers/${ids.salma}/advance-refund`, { idempotencyKey: key(), amount: 60 })).status, 201);
  // Counted by the first closing, voided now: the tea expense (50 comes back),
  // and the walk-in sale with its 900 cash payment (900 goes back out).
  assert.equal((await owner.post(`/expenses/${ids.expense}/void`, { reason: 'Was not shop money' })).status, 200);
  assert.equal((await owner.post(`/sales/${ids.walkInSale}/void`, { reason: 'Customer changed mind', voidPayments: true })).status, 200);
  // Made and voided inside this period: counts for nothing.
  const blip = (await spend(staff, { amount: 77 })).body.expense.id;
  assert.equal((await owner.post(`/expenses/${blip}/void`, { reason: 'Typed twice' })).status, 200);
  // Not cash: never in the drawer.
  assert.equal((await spend(staff, { amount: 500, method: 'bank_transfer', title: 'Rent' })).status, 201);

  const d = await drawer();
  assert.deepEqual(
    { sales: d.cashSales, dues: d.cashDuesCollected, deposits: d.cashAdvanceDeposits, voidsIn: d.cashVoidsIn, expenses: d.cashExpenses, supplier: d.cashSupplierPaid, refunds: d.cashRefunds },
    { sales: '450.00', dues: '40.00', deposits: '100.00', voidsIn: '50.00', expenses: '30.00', supplier: '250.00', refunds: '1410.00' },
  );
  // opening + 640 in − 1690 out
  assert.equal(Number(d.expectedCash).toFixed(2), (Number(ids.opening2) + 640 - 1690).toFixed(2));

  const res = await owner.post('/cash-register/close', { actualCash: d.expectedCash, expectedCash: d.expectedCash });
  assert.equal(res.status, 201, JSON.stringify([res.body, d.expectedCash]));
  const c = res.body.closing;
  assert.deepEqual([c.closingDate, c.openingCash, c.difference, c.cashRefunds, c.cashVoidsIn, c.note], [cashDate(), ids.opening2, '0.00', '1410.00', '50.00', null]);
  assert.equal(c.carriedForward, d.expectedCash);

  const history = (await staff.get('/cash-register/history')).body;
  assert.deepEqual(history.items.map((h) => h.id), [c.id, ids.closing1]);
  assert.equal(history.items[0].periodStart, history.items[0].opening.openedAt);
  assert.deepEqual([history.items[0].opening.difference, history.items[0].receipts.length], ['-10.00', 0]);
  assert.deepEqual([history.items[1].cashWithdrawn, history.items[1].receipts.map((r) => r.amount)], ['1101.00', ['1000.00', '100.00', '1.00']]);
});

it('a day left open overnight must be closed before the next day starts', async () => {
  // Both earlier days moved back, so today is free to be opened.
  await db.query('UPDATE daily_cash_openings SET opening_date = DATE_SUB(opening_date, INTERVAL 2 DAY) ORDER BY id');
  await db.query('UPDATE daily_cash_closings SET closing_date = DATE_SUB(closing_date, INTERVAL 2 DAY) ORDER BY id');
  await openCashDay(staff);
  // ...and this one was opened yesterday and never handed over.
  await db.query('UPDATE daily_cash_openings SET opening_date = ? ORDER BY id DESC LIMIT 1', [shopDay(1)]);
  const d = await drawer();
  assert.deepEqual([d.status, d.stale], ['open', true]);
  const refused = await sell(staff, { items: pendrives(1), payments: [{ method: 'cash', amount: 450 }] });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.error.code, 'cash_day_stale');
  // Closing it is still allowed, and is dated the day it was opened.
  const closed = await staff.post('/cash-register/close', { actualCash: d.expectedCash, expectedCash: d.expectedCash });
  assert.equal(closed.status, 201);
  assert.equal(closed.body.closing.closingDate, shopDay(1));
  await openCashDay(staff);
});

it('sales recorded while the cash is being closed land in exactly one period, none lost and none counted twice', async () => {
  const sale = () => sell(staff, { items: pendrives(1), payments: [{ method: 'cash', amount: 450 }] });
  const early = await Promise.all([sale(), sale()]);
  const d = await drawer();
  const [closing, ...late] = await Promise.all([staff.post('/cash-register/close', { actualCash: d.expectedCash, expectedCash: d.expectedCash }), sale(), sale(), sale()]);
  assert.ok(early.every((r) => r.status === 201));
  // Either the closing went first and the later sales were refused (the day is
  // handed over), or a sale slipped in and the closing was refused as stale.
  assert.ok([201, 409].includes(closing.status));
  const saved = [...early, ...late].filter((r) => r.status === 201).length;
  for (const r of late.filter((x) => x.status !== 201)) assert.deepEqual([r.status, r.body.error.code], [409, 'cash_day_closed']);
  const after = await drawer();
  if (closing.status === 201) {
    assert.equal(Number(closing.body.closing.cashSales), saved * 450);
    assert.equal(after.status, 'closed');
    assert.equal(after.carriedCash, closing.body.closing.carriedForward);
  } else {
    assert.equal(saved, 5);
    assert.equal(Number(after.cashSales), 5 * 450);
  }
});

it('after all of the above: sales, customers and the advance ledger still reconcile', async () => {
  const wrongSales = await db.query(
    `SELECT s.id FROM sales s
       LEFT JOIN (SELECT a.sale_id, SUM(IF(p.is_verified = 1, a.amount, 0)) AS paid, SUM(IF(p.is_verified = 0, a.amount, 0)) AS unverified
                    FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.status = 'active' GROUP BY a.sale_id) x ON x.sale_id = s.id
      WHERE s.paid_amount <> COALESCE(x.paid, 0) - s.refunded_amount OR s.unverified_amount <> COALESCE(x.unverified, 0)
         OR s.due_amount <> s.total_amount - s.returned_amount - s.paid_amount`,
  );
  assert.deepEqual(wrongSales, []);
  const wrongCustomers = await db.query(
    `SELECT c.id FROM customers c
      WHERE c.current_due <> (SELECT COALESCE(SUM(due_amount), 0) FROM sales WHERE customer_id = c.id AND status = 'completed')
         OR c.advance_balance <> (SELECT COALESCE(SUM(amount), 0) FROM customer_advance_movements WHERE customer_id = c.id)`,
  );
  assert.deepEqual(wrongCustomers, []);
  const split = await db.query('SELECT p.id FROM payments p JOIN payment_allocations a ON a.payment_id = p.id GROUP BY p.id, p.amount HAVING SUM(a.amount) <> p.amount');
  assert.deepEqual(split, []);
});

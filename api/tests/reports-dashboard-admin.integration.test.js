const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const { cashDate } = require('../src/lib/cash');
const crypto = require('node:crypto');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };

let app;
let db;
let owner;
let staff;
let skipReason = false;
const ids = {};

const key = () => crypto.randomUUID();
/** A Dhaka calendar date `n` days before today. */
const daysAgo = (n) => new Date(Date.now() + 6 * 3600 * 1000 - n * 86400 * 1000).toISOString().slice(0, 10);
const TODAY = daysAgo(0);
const sell = (client, body) => client.post('/sales', { idempotencyKey: key(), ...body });
const mice = (quantity) => ({ type: 'product', productId: ids.mouse, quantity });
const cash = (amount) => ({ method: 'cash', amount });

// One scripted trading day, with every figure worked out by hand in the tests below.
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
  await openCashDay(owner);

  ids.category = (await owner.post('/categories', { name: 'Gadgets' })).body.category.id;
  ids.mouse = (await owner.post('/products', { categoryId: ids.category, sku: 'MOUSE', name: 'USB Mouse', price: 500, costPrice: 300, openingStock: 20 })).body.product.id;
  ids.pen = (await owner.post('/products', { categoryId: ids.category, sku: 'PEN', name: 'Ball Pen', price: 10, openingStock: 100 })).body.product.id; // no cost price
  ids.toner = (await owner.post('/products', { categoryId: ids.category, sku: 'TONER', name: 'Toner', price: 900, costPrice: 700, openingStock: 2 })).body.product.id; // low stock
  ids.copy = (await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4', unit: 'page', defaultPrice: 2 })).body.service.id;
  ids.karim = (await owner.post('/customers', { name: 'Karim Mia', phone: '01711111111' })).body.customer.id;
  const salma = (await owner.post('/customers', { name: 'Salma Begum', phone: '01722222222' })).body.customer;
  ids.salma = salma.id;
  ids.salmaPin = salma.portalPin;
  ids.supplier = (await owner.post('/suppliers', { name: 'Hasan Traders' })).body.supplier.id;

  // Ten days ago: Karim takes two mice on credit (1000).
  ids.s1 = (await sell(owner, { customerId: ids.karim, date: daysAgo(10), items: [mice(2)] })).body.sale.id;
  // Today: walk-in, a mouse and 100 copies, 50 off, paid in cash (650).
  ids.s2 = (await sell(staff, { items: [mice(1), { type: 'service', serviceId: ids.copy, quantity: 100 }], discountAmount: 50, payments: [cash(650)] })).body.sale.id;
  // Today: Salma takes two mice (1000), pays 400; one mouse comes back, which takes 500 off her due.
  ids.s3 = (await sell(staff, { customerId: ids.salma, items: [mice(2)], payments: [cash(400)] })).body.sale.id;
  const line = (await owner.get(`/sales/${ids.s3}`)).body.sale.items[0].id;
  await owner.post(`/sales/${ids.s3}/returns`, { idempotencyKey: key(), reason: 'Faulty', items: [{ saleItemId: line, quantity: 1 }] });
  // Today: five pens for cash (50); pens have no cost price.
  await sell(staff, { items: [{ type: 'product', productId: ids.pen, quantity: 5 }], payments: [cash(50)] });
  // Today: a sale that is voided with its payment. It must appear nowhere.
  const voided = (await sell(staff, { items: [mice(1)], payments: [cash(500)] })).body.sale.id;
  await owner.post(`/sales/${voided}/void`, { reason: 'Rung up twice', voidPayments: true });
  // Today: Karim pays 300 in cash, and 200 by bKash that nobody has verified.
  await staff.post('/payments', { idempotencyKey: key(), customerId: ids.karim, amount: 300 });
  await staff.post('/payments', { idempotencyKey: key(), customerId: ids.karim, amount: 200, method: 'bkash', reference: 'TRX1' });
  // Expenses: tea today in cash (50), rent five days ago by bank (500).
  const categories = (await owner.get('/expense-categories')).body.categories;
  const category = (name) => categories.find((c) => c.name === name).id;
  await staff.post('/expenses', { idempotencyKey: key(), categoryId: category('Tea/Snacks'), title: 'Tea', amount: 50 });
  await owner.post('/expenses', { idempotencyKey: key(), categoryId: category('Rent'), title: 'Shop rent', amount: 500, method: 'bank_transfer', date: daysAgo(5) });
  // A purchase bill, unpaid: ten mice at 300 (3000 owed).
  await owner.post('/purchases', { idempotencyKey: key(), supplierId: ids.supplier, items: [{ productId: ids.mouse, quantity: 10, unitCost: '300' }] });
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const report = async (client, url) => (await client.get(`/reports/${url}`)).body;
const month = `from=${daysAgo(30)}&to=${TODAY}`;
const row = (r, first) => r.rows.find((x) => Object.values(x)[0] === first);

// --- dashboard --------------------------------------------------------------

it("the Owner's dashboard shows today's sales, money in, profit, dues, payables, stock and cash", async () => {
  const d = (await owner.get('/dashboard')).body;
  assert.equal(d.date, TODAY);
  // 650 + 1000 + 50, less the 500 returned. The voided sale and the old bill are not today's.
  assert.deepEqual(d.sales, { bills: 3, netSales: '1200.00', newDues: '100.00' });
  // Cost: one mouse (300) + one mouse kept (300) + pens (0).
  assert.deepEqual(d.profit, { grossProfit: '600.00', commission: '0.00', expenses: '50.00', netProfit: '550.00', uncostedLines: 1 });
  // 650 + 400 + 50 at the counter, 300 collected. Unverified bKash is not money in yet.
  assert.deepEqual(d.payments, { collectedToday: '1400.00', unverifiedCount: 1, unverifiedAmount: '200.00' });
  assert.equal(d.expensesToday, '50.00');
  assert.equal(d.dues.total, '800.00');
  assert.deepEqual(d.dues.top.map((c) => [c.name, c.currentDue]), [['Karim Mia', '700.00'], ['Salma Begum', '100.00']]);
  assert.deepEqual(d.payables, { suppliers: 1, total: '3000.00' });
  assert.equal(d.lowStock, 1);
  // The day was opened with an empty drawer.
  assert.deepEqual(d.cash, { status: 'open', carried: null, lastClosingDate: null, openingDate: cashDate(), stale: false, expected: '1350.00' });
  assert.equal(d.recentSales.length, 5);
  assert.equal(d.recentSales.filter((s) => s.status === 'void').length, 1);
});

it("staff's dashboard leaves out profit and what the shop owes", async () => {
  const d = (await staff.get('/dashboard')).body;
  assert.equal(d.sales.netSales, '1200.00');
  assert.equal(d.profit, undefined);
  assert.equal(d.payables, undefined);
  assert.equal(d.dues.total, '800.00');
  assert.equal((await app.client().get('/dashboard')).status, 401);
});

// --- reports ----------------------------------------------------------------

it('reports are for the Owner only', async () => {
  for (const url of ['sales', 'profit-loss', 'expenses', 'payments', 'dues', 'suppliers', 'cash-closings', 'stock']) {
    assert.equal((await staff.get(`/reports/${url}`)).status, 403, url);
    assert.equal((await owner.get(`/reports/${url}`)).status, 200, url);
  }
  assert.equal((await owner.get(`/reports/sales?from=${TODAY}&to=${daysAgo(3)}`)).status, 400);
});

it('sales by day and by month add up to the bills', async () => {
  const byDay = await report(owner, `sales?${month}`);
  assert.deepEqual(byDay.rows.map((r) => r.period), [daysAgo(10), TODAY]);
  assert.deepEqual(row(byDay, TODAY), { period: TODAY, bills: 3, subtotal: '1750.00', discount: '50.00', total: '1700.00', returned: '500.00', net: '1200.00', due: '100.00' });
  assert.deepEqual([byDay.totals.period, byDay.totals.bills, byDay.totals.net, byDay.totals.due], ['Total', 4, '2200.00', '800.00']);
  // The same figures straight from the table.
  const [check] = await db.query("SELECT SUM(total_amount - returned_amount) AS net FROM sales WHERE status = 'completed' AND sale_type = 'sale'");
  assert.equal(byDay.totals.net, check.net);

  // With no dates the report covers this month so far.
  const today = await report(owner, `sales?from=${TODAY}&to=${TODAY}`);
  assert.equal(today.totals.net, '1200.00');
  const byMonth = await report(owner, `sales?${month}&groupBy=month`);
  assert.equal(byMonth.totals.net, '2200.00');
});

it('sales by item and by category count what was sold and what came back', async () => {
  const byItem = await report(owner, `sales?${month}&groupBy=item`);
  assert.deepEqual(byItem.rows, [
    { name: 'USB Mouse', kind: 'Product', quantity: 5, returned: 1, amount: '2500.00' },
    { name: 'Photocopy A4', kind: 'Service', quantity: 100, returned: 0, amount: '200.00' },
    { name: 'Ball Pen', kind: 'Product', quantity: 5, returned: 0, amount: '50.00' },
  ]);
  const byCategory = await report(owner, `sales?${month}&groupBy=category`);
  assert.deepEqual(byCategory.rows.map((r) => [r.name, r.quantity, r.amount]), [['Gadgets', 10, '2550.00'], ['Service: photocopy', 100, '200.00']]);
  // Item amounts are before the bill discount: they add up to the subtotals.
  assert.equal(byItem.totals.amount, '2750.00');
});

it('profit and loss: net profit is gross profit less expenses, and missing cost prices are pointed out', async () => {
  const r = await report(owner, `profit-loss?${month}`);
  const amount = (label) => r.rows.find((x) => x.label === label).amount;
  assert.equal(amount('Sales before discount'), '2750.00');
  assert.equal(amount('Discounts given'), '-50.00');
  assert.equal(amount('Returned goods'), '-500.00');
  assert.equal(amount('Net sales'), '2200.00');
  assert.equal(amount('Cost of the goods sold'), '-1200.00'); // four mice kept, at 300
  assert.equal(amount('Gross profit'), '1000.00');
  assert.equal(amount('Staff commission'), '0.00'); // no rates set in this file
  assert.equal(amount('Expense: Rent'), '-500.00');
  assert.equal(amount('Expense: Tea/Snacks'), '-50.00');
  assert.equal(amount('Total expenses'), '-550.00');
  assert.deepEqual(r.totals, { label: 'Net profit', amount: '450.00' });
  assert.ok(r.notes.some((n) => /1 product line\(s\).*no cost price/.test(n)));

  // A period with expenses and no sales is a loss, shown as a negative figure.
  const quiet = await report(owner, `profit-loss?from=${daysAgo(5)}&to=${daysAgo(5)}`);
  assert.equal(quiet.totals.amount, '-500.00');
});

it('expenses, payments collected, dues with their age, and supplier payables', async () => {
  const expenses = await report(owner, `expenses?${month}`);
  assert.deepEqual(expenses.rows, [
    { name: 'Rent', vouchers: 1, cash: '0.00', other: '500.00', amount: '500.00' },
    { name: 'Tea/Snacks', vouchers: 1, cash: '50.00', other: '0.00', amount: '50.00' },
  ]);
  assert.equal(expenses.totals.amount, '550.00');
  assert.deepEqual((await report(owner, `expenses?${month}&groupBy=day`)).rows.map((r) => [r.name, r.amount]), [[daysAgo(5), '500.00'], [TODAY, '50.00']]);

  const payments = await report(owner, `payments?${month}`);
  assert.deepEqual(payments.rows, [{ period: TODAY, cash: '1400.00', bkash: '0.00', nagad: '0.00', bank_transfer: '0.00', other: '0.00', received: '1400.00', from_advance: '0.00' }]);

  const dues = await report(owner, 'dues');
  assert.deepEqual(dues.rows.map((r) => [r.name, r.bills, r.oldest, r.d30, r.older, r.due]), [['Karim Mia', 1, daysAgo(10), '700.00', '0.00', '700.00'], ['Salma Begum', 1, TODAY, '100.00', '0.00', '100.00']]);
  assert.equal(dues.totals.due, '800.00');
  // An old bill moves to the older columns.
  await db.query('UPDATE sales SET sale_date = DATE_SUB(sale_date, INTERVAL 100 DAY) WHERE id = ?', [ids.s1]);
  const aged = await report(owner, 'dues');
  assert.deepEqual([aged.rows[0].d30, aged.rows[0].older], ['0.00', '700.00']);
  await db.query('UPDATE sales SET sale_date = DATE_ADD(sale_date, INTERVAL 100 DAY) WHERE id = ?', [ids.s1]);

  const suppliers = await report(owner, 'suppliers');
  assert.deepEqual(suppliers.rows.map((r) => [r.name, r.bills, r.payable]), [['Hasan Traders', 1, '3000.00']]);
});

it('stock levels, low stock and movements agree with the products and the ledger', async () => {
  const levels = await report(owner, 'stock');
  // 20 − 2 − 1 − 2 + 1 returned − 1 + 1 voided + 10 bought = 26
  assert.deepEqual(levels.rows.map((r) => [r.sku, r.stock, r.value]), [['PEN', 95, '0.00'], ['TONER', 2, '1400.00'], ['MOUSE', 26, '7800.00']]);
  assert.equal(levels.totals.value, '9200.00');
  assert.deepEqual((await report(owner, 'stock?view=low')).rows.map((r) => r.sku), ['TONER']);

  const moves = await report(owner, `stock?view=movements&from=${TODAY}&to=${TODAY}`);
  assert.deepEqual(row({ rows: moves.rows.map((r) => ({ sku: r.sku, ...r })) }, 'MOUSE'), { sku: 'MOUSE', name: 'USB Mouse', received: 30, sold: 6, came_back: 2, adjusted: 0, net: 26, stock: 26 });
});

it('cash closings appear in their report', async () => {
  const d = (await owner.get('/cash-register/current')).body;
  assert.equal(d.expectedCash, '1350.00');
  assert.equal((await staff.post('/cash-register/close', { expectedCash: '1350.00', actualCash: '1350' })).status, 201);
  assert.equal((await owner.post('/cash-register/receive', { amount: '1000' })).status, 201);
  const r = await report(owner, `cash-closings?${month}`);
  assert.deepEqual(r.rows.map((x) => [x.date, x.opening, x.cash_in, x.cash_out, x.expected, x.counted, x.difference, x.withdrawn, x.left_in, x.closed_by]), [[cashDate(), '0.00', '1400.00', '50.00', '1350.00', '1350.00', '0.00', '1000.00', '350.00', 'Rahim']]);
  const dash = (await owner.get('/dashboard')).body.cash;
  assert.deepEqual(dash, { status: 'closed', carried: '350.00', lastClosingDate: cashDate() });
});

it('every report downloads as CSV with the same rows and a totals line', async () => {
  const cookie = [...owner.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  const res = await fetch(`${app.base}/reports/sales?${month}&groupBy=item&format=csv`, { headers: { Cookie: cookie } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type'), /^text\/csv/);
  assert.match(res.headers.get('content-disposition'), /attachment; filename="sales-by-item-\d{4}-\d{2}-\d{2}-to-\d{4}-\d{2}-\d{2}\.csv"/);
  const bytes = Buffer.from(await res.arrayBuffer());
  // A UTF-8 byte-order mark first, so Excel reads Bangla and the taka sign correctly.
  assert.deepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.deepEqual(bytes.subarray(3).toString('utf8').trimEnd().split('\r\n'), [
    'Product or service,Type,Quantity sold,Returned,Amount',
    'USB Mouse,Product,5,1,2500.00',
    'Photocopy A4,Service,100,0,200.00',
    'Ball Pen,Product,5,0,50.00',
    'Total,,110,1,2750.00',
  ]);
  assert.equal((await fetch(`${app.base}/reports/dues?format=csv`)).status, 401);

  // Text that a spreadsheet would run as a formula is neutralised; commas and quotes are escaped.
  const { toCsv } = require('../src/modules/reports/routes');
  const csv = toCsv({ columns: [{ key: 'name', label: 'Name', type: 'text' }, { key: 'amount', label: 'Amount', type: 'money' }], rows: [{ name: '=SUM(A1:A9)', amount: '-5.00' }, { name: 'Rahim, "Boss"', amount: '1.00' }], totals: null });
  assert.deepEqual(csv.slice(1).trimEnd().split('\r\n'), ['Name,Amount', "'=SUM(A1:A9),-5.00", '"Rahim, ""Boss""",1.00']);
});

// --- customer statement -----------------------------------------------------

it("a statement's last balance is the customer's due; unverified money and voids are not in it", async () => {
  const karim = (await staff.get(`/customers/${ids.karim}/statement`)).body;
  assert.deepEqual(karim.entries.map((e) => [e.kind, e.debit, e.credit, e.balance]), [['bill', '1000.00', null, '1000.00'], ['payment', null, '300.00', '700.00']]);
  assert.deepEqual([karim.openingBalance, karim.totalBilled, karim.totalPaid, karim.closingBalance, karim.customer.currentDue], ['0.00', '1000.00', '300.00', '700.00', '700.00']);

  // A return takes off only what it took off the due.
  const salma = (await staff.get(`/customers/${ids.salma}/statement`)).body;
  assert.deepEqual(salma.entries.map((e) => [e.kind, e.debit, e.credit, e.balance]), [['bill', '1000.00', null, '1000.00'], ['payment', null, '400.00', '600.00'], ['return', null, '500.00', '100.00']]);
  assert.equal(salma.closingBalance, salma.customer.currentDue);

  // From a date: everything earlier becomes the opening balance.
  const recent = (await staff.get(`/customers/${ids.karim}/statement?from=${TODAY}`)).body;
  assert.deepEqual([recent.openingBalance, recent.entries.length, recent.closingBalance], ['1000.00', 1, '700.00']);
  const early = (await staff.get(`/customers/${ids.karim}/statement?to=${daysAgo(1)}`)).body;
  assert.deepEqual([early.entries.length, early.closingBalance], [1, '1000.00']);
  assert.equal((await staff.get('/customers/999999/statement')).status, 404);
  assert.equal((await app.client().get(`/customers/${ids.karim}/statement`)).status, 401);
});

// --- users ------------------------------------------------------------------

it('the Owner edits a user, and blocking ends their session at once', async () => {
  const created = await owner.post('/users', { name: 'Sumi Akter', username: 'sumi', password: 'first-password-1', role: 'staff' });
  ids.sumi = created.body.user.id;
  assert.equal((await staff.put(`/users/${ids.sumi}`, { name: 'X Y' })).status, 403);

  const edited = await owner.put(`/users/${ids.sumi}`, { name: 'Sumi Rahman', phone: '01733333333' });
  assert.deepEqual([edited.status, edited.body.user.name, edited.body.user.phone, edited.body.user.role], [200, 'Sumi Rahman', '01733333333', 'staff']);
  const log = (await db.query("SELECT old_values, new_values FROM audit_logs WHERE action = 'user.update' ORDER BY id DESC LIMIT 1"))[0];
  assert.deepEqual(log.new_values, { name: 'Sumi Rahman', phone: '01733333333' });

  const rahimId = (await db.query("SELECT id FROM users WHERE username = 'rahim'"))[0].id;
  assert.equal((await staff.get('/auth/me')).status, 200);
  assert.equal((await owner.put(`/users/${rahimId}`, { status: 'blocked' })).status, 200);
  assert.equal((await staff.get('/auth/me')).status, 401);
  assert.equal((await app.client().post('/auth/login', STAFF)).status, 401);
  assert.equal((await owner.put(`/users/${rahimId}`, { status: 'active' })).status, 200);
  assert.equal((await staff.post('/auth/login', STAFF)).status, 200);
  assert.equal((await owner.put('/users/999999', { name: 'No One' })).status, 404);
});

it('nobody can block or demote themselves, so the shop always has an Owner', async () => {
  const me = (await owner.get('/auth/me')).body.user.id;
  assert.equal((await owner.put(`/users/${me}`, { role: 'staff' })).status, 409);
  assert.equal((await owner.put(`/users/${me}`, { status: 'blocked' })).status, 409);
  assert.equal((await owner.put(`/users/${me}`, { name: 'Shop Owner' })).status, 200); // their own name is fine
  assert.equal((await owner.get('/auth/me')).body.user.role.code, 'owner');
});

it('a reset password must be changed at first login, and ends the old sessions', async () => {
  const sumi = app.client();
  assert.equal((await sumi.post('/auth/login', { username: 'sumi', password: 'first-password-1' })).status, 200);
  assert.equal((await staff.post(`/users/${ids.sumi}/reset-password`, { password: 'second-password-2' })).status, 403);
  assert.equal((await owner.post(`/users/${ids.sumi}/reset-password`, { password: 'short' })).status, 400);
  assert.equal((await owner.post(`/users/${ids.sumi}/reset-password`, { password: 'second-password-2' })).status, 200);

  assert.equal((await sumi.get('/auth/me')).status, 401);
  assert.equal((await sumi.post('/auth/login', { username: 'sumi', password: 'first-password-1' })).status, 401);
  assert.equal((await sumi.post('/auth/login', { username: 'sumi', password: 'second-password-2' })).status, 200);
  assert.equal((await sumi.get('/auth/me')).body.user.mustChangePassword, true);
  assert.equal((await sumi.get('/products')).body.error.code, 'password_change_required');

  const me = (await owner.get('/auth/me')).body.user.id;
  assert.equal((await owner.post(`/users/${me}/reset-password`, { password: 'another-password-3' })).status, 409);
  const log = (await db.query("SELECT new_values FROM audit_logs WHERE action = 'user.reset_password'"))[0];
  assert.equal(log.new_values, null); // the password is never logged
});

// --- settings and audit log -------------------------------------------------

it('the Owner changes shop settings; only listed keys with valid values are accepted', async () => {
  assert.equal((await staff.get('/settings')).status, 403);
  const list = (await owner.get('/settings')).body.settings;
  assert.equal(list.length, 14);
  assert.equal(list.find((s) => s.key === 'shop.name').editable, true);
  assert.equal(list.find((s) => s.key === 'shop.logo_url').editable, false);

  assert.equal((await staff.put('/settings', { values: { 'shop.name': 'X Shop' } })).status, 403);
  assert.equal((await owner.put('/settings', { values: { 'shop.logo_url': 'http://evil.test/x.png' } })).status, 400);
  assert.equal((await owner.put('/settings', { values: { 'shop.email': 'not-an-email' } })).status, 400);
  assert.equal((await owner.put('/settings', { values: { 'invoice.default_layout': 'a3' } })).status, 400);
  assert.equal((await owner.put('/settings', { values: {} })).status, 400);

  const res = await owner.put('/settings', { values: { 'shop.name': 'SS Computer', 'shop.phone': '01700000000', 'payment.bkash_number': '01700000001', 'invoice.default_layout': 'thermal80', 'shop.tagline': 'Computer, Printing, Photocopy & Online Services' } });
  // The tagline was already that: it is not reported, or logged, as a change.
  assert.deepEqual(res.body.changed.sort(), ['invoice.default_layout', 'payment.bkash_number', 'shop.name', 'shop.phone']);
  const shop = (await staff.get('/settings/shop')).body.settings;
  assert.deepEqual([shop['shop.name'], shop['shop.phone'], shop['invoice.default_layout']], ['SS Computer', '01700000000', 'thermal80']);
  assert.equal((await app.client().get('/portal/shop')).body.shop['payment.bkash_number'], '01700000001');
  const log = (await db.query("SELECT old_values, new_values FROM audit_logs WHERE action = 'settings.update'"))[0];
  assert.equal(log.old_values['shop.name'], 'SS Computer Training Centre');
  assert.equal(log.new_values['shop.name'], 'SS Computer');
});

it('switching the customer portal off stops logins and existing sessions; switching it on restores them', async () => {
  const portal = app.client();
  assert.equal((await portal.post('/portal/login', { phone: '01722222222', pin: ids.salmaPin })).status, 200);
  assert.equal((await portal.get('/portal/me')).status, 200);
  const token = (await db.query('SELECT qr_token FROM sales WHERE id = ?', [ids.s3]))[0].qr_token;

  assert.equal((await owner.put('/settings', { values: { 'portal.enabled': false } })).status, 200);
  assert.equal((await portal.get('/portal/me')).status, 401);
  assert.equal((await app.client().post('/portal/login', { phone: '01722222222', pin: ids.salmaPin })).status, 403);
  // The QR link printed on a bill keeps working: it is the bill itself.
  assert.equal((await app.client().get(`/portal/view/${token}`)).status, 200);

  assert.equal((await owner.put('/settings', { values: { 'portal.enabled': true } })).status, 200);
  assert.equal((await portal.get('/portal/me')).status, 200);
});

it('the audit log lists who did what, newest first, and can be filtered', async () => {
  assert.equal((await staff.get('/audit-logs')).status, 403);
  const all = (await owner.get('/audit-logs?pageSize=5')).body;
  assert.equal(all.items.length, 5);
  assert.ok(all.total > 20);
  assert.ok(all.items[0].id > all.items[4].id);
  assert.ok(all.areas.includes('sale') && all.areas.includes('settings') && all.areas.includes('user'));

  const settings = (await owner.get('/audit-logs?area=settings')).body;
  assert.equal(settings.total, 3);
  assert.ok(settings.items.every((i) => i.action === 'settings.update' && i.userName === 'Shop Owner'));
  const staffId = (await db.query("SELECT id FROM users WHERE username = 'rahim'"))[0].id;
  const byStaff = (await owner.get(`/audit-logs?userId=${staffId}&area=sale`)).body;
  assert.equal(byStaff.total, 4); // the four sales staff rang up
  assert.equal((await owner.get(`/audit-logs?to=${daysAgo(1)}`)).body.total, 0);
  // No secret ever reaches the log.
  const rows = await db.query('SELECT old_values, new_values FROM audit_logs');
  const text = JSON.stringify(rows);
  for (const secret of ['second-password-2', 'first-password-1', ids.salmaPin]) assert.equal(text.includes(secret), false);
});

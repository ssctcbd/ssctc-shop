const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

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
  await openCashDay(owner);

  ids.category = (await owner.post('/categories', { name: 'Gadgets' })).body.category.id;
  ids.pendrive = (await owner.post('/products', { categoryId: ids.category, sku: 'PD32', name: 'Pendrive 32GB', price: 450, costPrice: 380, openingStock: 10 })).body.product.id;
  ids.mouse = (await owner.post('/products', { categoryId: ids.category, sku: 'MOUSE', name: 'USB Mouse', price: 380, costPrice: 230, openingStock: 5 })).body.product.id;
  ids.photocopy = (await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4 B/W', unit: 'page', defaultPrice: 2 })).body.service.id;
  ids.nid = (await owner.post('/services', { serviceType: 'online', name: 'NID Application', unit: 'application', defaultPrice: 100, priceEditable: false })).body.service.id;
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const key = () => crypto.randomUUID();
const one = async (sql, params = []) => (await db.query(sql, params))[0];
const stockOf = async (id) => (await one('SELECT stock_qty FROM products WHERE id = ?', [id])).stock_qty;
const dueOf = async (id) => (await one('SELECT current_due FROM customers WHERE id = ?', [id])).current_due;
const count = async (table) => Number((await one(`SELECT COUNT(*) AS n FROM ${table}`)).n);
const pendrive = (quantity = 1, extra = {}) => ({ type: 'product', productId: ids.pendrive, quantity, ...extra });
const copies = (quantity, extra = {}) => ({ type: 'service', serviceId: ids.photocopy, quantity, ...extra });
const cash = (amount) => ({ method: 'cash', amount });
const sell = (client, body) => client.post('/sales', { idempotencyKey: key(), ...body });

// --- customers --------------------------------------------------------------

it('staff creates a customer: the number is normalised and a 6-digit portal PIN is issued', async () => {
  const res = await staff.post('/customers', { name: 'Rahim Uddin', phone: '+880 1712-345678', address: 'Baunia' });
  assert.equal(res.status, 201);
  ids.rahim = res.body.customer.id;
  assert.equal(res.body.customer.phone, '01712345678');
  assert.match(res.body.customer.portalPin, /^\d{6}$/);
  ids.rahimPin = res.body.customer.portalPin;

  const row = await one('SELECT portal_pin, portal_password_hash FROM customers WHERE id = ?', [ids.rahim]);
  assert.match(row.portal_password_hash, /^\$2[aby]\$/);
  assert.equal(JSON.stringify((await one("SELECT new_values FROM audit_logs WHERE action = 'customer.create'")).new_values).includes(ids.rahimPin), false);

  // The customer can log in to the portal with exactly that PIN.
  const portal = app.client();
  assert.equal((await portal.post('/portal/login', { phone: '01712345678', pin: ids.rahimPin })).status, 200);
  assert.equal((await portal.get('/portal/me')).body.customer.name, 'Rahim Uddin');
});

it('customer mobile numbers are unique and validated; a customer without a number gets no PIN', async () => {
  assert.equal((await staff.post('/customers', { name: 'Twin', phone: '01712345678' })).status, 409);
  assert.equal((await staff.post('/customers', { name: 'Bad', phone: '12345' })).status, 400);
  const noPhone = await staff.post('/customers', { name: 'No Phone' });
  assert.equal(noPhone.status, 201);
  assert.equal(noPhone.body.customer.portalPin, null);
  assert.equal(noPhone.body.customer.hasPortalAccess, false);
  ids.noPhone = noPhone.body.customer.id;
  // Adding a number later issues a PIN.
  await staff.put(`/customers/${ids.noPhone}`, { phone: '01812345678' });
  assert.match((await owner.get(`/customers/${ids.noPhone}`)).body.customer.portalPin, /^\d{6}$/);
});

it('only the Owner resets a PIN; the old PIN and old sessions stop working', async () => {
  const portal = app.client();
  await portal.post('/portal/login', { phone: '01712345678', pin: ids.rahimPin });
  assert.equal((await staff.post(`/customers/${ids.rahim}/reset-pin`)).status, 403);

  const res = await owner.post(`/customers/${ids.rahim}/reset-pin`);
  assert.equal(res.status, 200);
  assert.match(res.body.portalPin, /^\d{6}$/);
  assert.equal((await portal.get('/portal/me')).status, 401);
  if (res.body.portalPin !== ids.rahimPin) assert.equal((await app.client().post('/portal/login', { phone: '01712345678', pin: ids.rahimPin })).status, 401);
  assert.equal((await app.client().post('/portal/login', { phone: '01712345678', pin: res.body.portalPin })).status, 200);
  await db.query('DELETE FROM login_attempts');
});

it('customer list: search, due filter, and the POS picker list', async () => {
  assert.equal((await staff.get('/customers?search=rahim')).body.total, 1);
  assert.equal((await staff.get('/customers?search=0171234')).body.total, 1);
  assert.equal((await staff.get('/customers?hasDue=1')).body.total, 0);
  const options = (await staff.get('/customers/options')).body.customers;
  assert.deepEqual(Object.keys(options[0]).sort(), ['advanceBalance', 'currentDue', 'id', 'name', 'phone']);
});

// --- selling ----------------------------------------------------------------

it('a walk-in cash sale of a product and a service: totals, snapshots, stock and receipt', async () => {
  const res = await sell(staff, { walkInName: 'Walk-in', items: [pendrive(2, { warranty: '1 Year', serialNo: 'SN-001' }), copies(40)], payments: [cash('980')] });
  assert.equal(res.status, 201);
  const s = res.body.sale;
  ids.walkIn = s.id;
  assert.equal(s.invoiceNo, 'INV-000001');
  assert.deepEqual([s.totalAmount, s.paidAmount, s.dueAmount, s.paymentStatus], ['980.00', '980.00', '0.00', 'paid']); // 2 × 450 + 40 × 2

  assert.equal(await stockOf(ids.pendrive), 8);
  const move = await one("SELECT quantity, balance_after, reference_id FROM inventory_movements WHERE movement_type = 'sale'");
  assert.deepEqual([move.quantity, move.balance_after, move.reference_id], [-2, 8, s.id]);

  const detail = (await owner.get(`/sales/${s.id}`)).body.sale;
  assert.deepEqual(detail.items.map((i) => [i.type, i.name, i.unitPrice, i.quantity, i.lineTotal, i.warranty, i.serialNo]), [
    ['product', 'Pendrive 32GB', '450.00', 2, '900.00', '1 Year', 'SN-001'],
    ['service', 'Photocopy A4 B/W', '2.00', 40, '80.00', null, null],
  ]);
  assert.equal(detail.items[0].costPrice, '380.00');
  assert.deepEqual(detail.payments.map((p) => [p.receiptNo, p.method, p.amount, p.isVerified]), [['RCP-000001', 'cash', '980.00', true]]);
  // Staff does not see cost prices on a sale.
  assert.ok(!('costPrice' in (await staff.get(`/sales/${s.id}`)).body.sale.items[0]));
});

it('the price sent by the browser is not trusted: an invoice keeps the catalog price even after it changes', async () => {
  await owner.put(`/products/${ids.pendrive}`, { price: '500.00' });
  const old = (await owner.get(`/sales/${ids.walkIn}`)).body.sale;
  assert.equal(old.items[0].unitPrice, '450.00');
  assert.equal(old.totalAmount, '980.00');
  const fresh = await sell(staff, { items: [pendrive(1)], payments: [cash('500')] });
  assert.equal(fresh.body.sale.totalAmount, '500.00');
  await owner.put(`/products/${ids.pendrive}`, { price: '450.00' });
});

it('staff cannot change a product price or a fixed service rate; an editable service can be re-priced; the Owner can change anything', async () => {
  assert.equal((await sell(staff, { items: [pendrive(1, { unitPrice: '1.00' })], payments: [cash('1')] })).status, 400);
  assert.equal((await sell(staff, { items: [{ type: 'service', serviceId: ids.nid, quantity: 1, unitPrice: '10' }], payments: [cash('10')] })).status, 400);
  assert.equal(await stockOf(ids.pendrive), 7);

  const editable = await sell(staff, { items: [copies(100, { unitPrice: '1.50' })], payments: [cash('150')] });
  assert.equal(editable.status, 201);
  assert.equal(editable.body.sale.totalAmount, '150.00');

  const byOwner = await sell(owner, { items: [pendrive(1, { unitPrice: '430' })], discountAmount: '30', payments: [cash('400')] });
  assert.equal(byOwner.status, 201);
  assert.equal(byOwner.body.sale.totalAmount, '400.00');
  const log = await one("SELECT new_values FROM audit_logs WHERE action = 'sale.create' ORDER BY id DESC LIMIT 1");
  assert.deepEqual(log.new_values.priceChanges, [{ name: 'Pendrive 32GB', listed: '450.00', charged: '430.00' }]);
  assert.equal(log.new_values.discount, '30.00');
});

it('a sale that leaves a due needs a saved customer', async () => {
  const before = [await count('sales'), await stockOf(ids.pendrive), (await one("SELECT last_number AS n FROM document_counters WHERE doc_type = 'invoice'")).n];
  const walkIn = await sell(staff, { items: [pendrive(1)], payments: [cash('200')] });
  assert.equal(walkIn.status, 400);
  assert.match(walkIn.body.error.details.fields.customerId, /due of 250\.00/);
  assert.equal((await sell(staff, { items: [pendrive(1)] })).status, 400);
  assert.deepEqual([await count('sales'), await stockOf(ids.pendrive), (await one("SELECT last_number AS n FROM document_counters WHERE doc_type = 'invoice'")).n], before);

  const res = await sell(staff, { customerId: ids.rahim, items: [pendrive(1)], payments: [cash('200')] });
  assert.equal(res.status, 201);
  ids.partial = res.body.sale.id;
  assert.deepEqual([res.body.sale.paidAmount, res.body.sale.dueAmount, res.body.sale.paymentStatus], ['200.00', '250.00', 'partial']);
  assert.equal(await dueOf(ids.rahim), '250.00');
});

it('a bKash payment is unverified until someone verifies it; a transaction ID alone never counts as paid', async () => {
  // Walk-in + unverified bKash would leave a due with nobody to owe it.
  const walkIn = await sell(staff, { items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: '9xk2abcd41' }] });
  assert.equal(walkIn.status, 400);
  assert.match(walkIn.body.error.details.fields.customerId, /fully paid with verified money/);
  // Staff ticking "verified" is ignored: staff may not verify.
  assert.equal((await sell(staff, { items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: '9XK2ABCD41', verified: true }] })).status, 400);

  const res = await sell(staff, { customerId: ids.rahim, items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: '9xk2abcd41' }] });
  assert.equal(res.status, 201);
  ids.bkashSale = res.body.sale.id;
  assert.deepEqual([res.body.sale.paidAmount, res.body.sale.dueAmount, res.body.sale.paymentStatus], ['0.00', '450.00', 'unpaid']);
  const detail = (await owner.get(`/sales/${ids.bkashSale}`)).body.sale;
  assert.equal(detail.unverifiedAmount, '450.00');
  assert.deepEqual([detail.payments[0].reference, detail.payments[0].isVerified], ['9XK2ABCD41', false]);
  ids.bkashPayment = detail.payments[0].id;
  assert.equal(await dueOf(ids.rahim), '700.00'); // 250 + 450

  // The same transaction ID cannot be recorded on another payment.
  const dup = await sell(staff, { customerId: ids.rahim, items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: '9XK2ABCD41' }] });
  assert.equal(dup.status, 409);
  assert.equal(await dueOf(ids.rahim), '700.00');
});

it('verifying lowers the due; unverifying raises it again; staff can do neither; it happens once', async () => {
  assert.equal((await staff.post(`/payments/${ids.bkashPayment}/verify`)).status, 403);

  const results = await Promise.all(Array.from({ length: 5 }, () => owner.post(`/payments/${ids.bkashPayment}/verify`)));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 4);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'payment.verify'")).n), 1);
  let sale = (await owner.get(`/sales/${ids.bkashSale}`)).body.sale;
  assert.deepEqual([sale.paidAmount, sale.unverifiedAmount, sale.dueAmount, sale.paymentStatus], ['450.00', '0.00', '0.00', 'paid']);
  assert.equal(await dueOf(ids.rahim), '250.00');

  assert.equal((await owner.post(`/payments/${ids.bkashPayment}/unverify`)).status, 200);
  sale = (await owner.get(`/sales/${ids.bkashSale}`)).body.sale;
  assert.deepEqual([sale.paidAmount, sale.unverifiedAmount, sale.dueAmount], ['0.00', '450.00', '450.00']);
  assert.equal(await dueOf(ids.rahim), '700.00');
  const log = await one("SELECT old_values, new_values FROM audit_logs WHERE action = 'payment.unverify'");
  assert.deepEqual([log.old_values.isVerified, log.new_values.isVerified], [true, false]);
  await owner.post(`/payments/${ids.bkashPayment}/verify`);
});

it('an Owner may record a non-cash payment as verified on the spot, so a walk-in can pay by bKash', async () => {
  const res = await sell(owner, { items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: 'TRX777', verified: true }] });
  assert.equal(res.status, 201);
  assert.equal(res.body.sale.paymentStatus, 'paid');
  ids.walkInBkash = res.body.sale.id;
  // …and it cannot later be unverified or voided on its own, which would leave a walk-in due.
  const payment = (await owner.get(`/sales/${ids.walkInBkash}`)).body.sale.payments[0].id;
  assert.equal((await owner.post(`/payments/${payment}/unverify`)).status, 409);
  assert.equal((await owner.post(`/payments/${payment}/void`, { reason: 'Wrong entry' })).status, 409);
  assert.equal((await owner.get(`/sales/${ids.walkInBkash}`)).body.sale.paymentStatus, 'paid');
});

it('split payment, over-payment and bad input', async () => {
  const split = await sell(owner, { customerId: ids.rahim, items: [pendrive(1)], payments: [cash('200'), { method: 'nagad', amount: '250', reference: 'NG1', verified: true }] });
  assert.equal(split.status, 201);
  assert.equal(split.body.sale.paymentStatus, 'paid');

  const before = await count('sales');
  const bad = [
    { items: [pendrive(1)], payments: [cash('451')] }, // more than the total
    { items: [pendrive(1)], payments: [cash('0')] },
    { items: [], payments: [] },
    { items: [pendrive(0)], payments: [] },
    { items: [pendrive(1.5)], payments: [] },
    { items: [{ type: 'product', productId: 99999, quantity: 1 }], payments: [] },
    { items: [{ type: 'gift', productId: ids.pendrive, quantity: 1 }], payments: [] },
    { items: [pendrive(1)], discountAmount: '451', payments: [] },
    { items: [pendrive(1)], payments: [{ method: 'cheque', amount: '450' }] },
    { items: [pendrive(1)], customerId: 99999, payments: [cash('450')] },
    { items: [pendrive(1)], payments: [cash('450')], totalAmount: '1' }, // unknown field
  ];
  for (const body of bad) assert.equal((await sell(owner, body)).status, 400, JSON.stringify(body));
  assert.equal((await owner.post('/sales', { items: [pendrive(1)], payments: [cash('450')] })).status, 400); // no idempotency key
  assert.equal(await count('sales'), before);
});

it('back-dating a sale needs permission; a future date is refused', async () => {
  assert.equal((await sell(staff, { date: '2026-01-05', items: [copies(1)], payments: [cash('2')] })).status, 403);
  assert.equal((await sell(owner, { date: '2099-01-01', items: [copies(1)], payments: [cash('2')] })).status, 400);
  const res = await sell(owner, { date: '2026-01-05', items: [copies(1)], payments: [cash('2')] });
  assert.equal(res.status, 201);
  const row = await one('SELECT sale_date FROM sales WHERE id = ?', [res.body.sale.id]);
  assert.equal(new Date(row.sale_date).toISOString(), '2026-01-05T06:00:00.000Z'); // noon in Dhaka
});

it('selling more than the stock is refused and changes nothing', async () => {
  const before = [await count('sales'), await count('payments'), await stockOf(ids.mouse)];
  const res = await sell(staff, { items: [{ type: 'product', productId: ids.mouse, quantity: 6 }, copies(10)], payments: [cash('2300')] });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /Not enough stock of "USB Mouse": 5 available/);
  assert.deepEqual([await count('sales'), await count('payments'), await stockOf(ids.mouse)], before);
});

it('twenty tills selling the last five at the same moment: exactly five sales', async () => {
  const results = await Promise.all(Array.from({ length: 20 }, () => sell(staff, { items: [{ type: 'product', productId: ids.mouse, quantity: 1 }], payments: [cash('380')] })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 15);
  assert.equal(await stockOf(ids.mouse), 0);
  const invoices = results.filter((r) => r.status === 201).map((r) => r.body.sale.invoiceNo);
  assert.equal(new Set(invoices).size, 5);
  // Refused sales used no invoice or receipt numbers.
  const last = (await one("SELECT last_number AS n FROM document_counters WHERE doc_type = 'invoice'")).n;
  assert.equal(await count('sales'), last);
});

it('one sale submitted ten times at once is stored once', async () => {
  const body = { idempotencyKey: key(), customerId: ids.rahim, items: [pendrive(1)], payments: [cash('100')] };
  const before = [await count('sales'), await count('payments'), await stockOf(ids.pendrive)];
  const results = await Promise.all(Array.from({ length: 10 }, () => staff.post('/sales', body)));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200 && r.body.duplicate).length, 9);
  assert.equal(new Set(results.map((r) => r.body.sale.invoiceNo)).size, 1);
  assert.deepEqual([await count('sales'), await count('payments'), await stockOf(ids.pendrive)], [before[0] + 1, before[1] + 1, before[2] - 1]);
  ids.repeated = results[0].body.sale.id;
  // Rahim: 250 + 350 from this sale.
  assert.equal(await dueOf(ids.rahim), '600.00');
});

// --- opening due ------------------------------------------------------------

it('an opening due is recorded once, only by the Owner, and adds to the customer balance', async () => {
  // Staff may add and edit customers, but never put a due on someone without a sale.
  assert.equal((await staff.post(`/customers/${ids.noPhone}/opening-balance`, { amount: '1200' })).status, 403);
  const res = await owner.post(`/customers/${ids.noPhone}/opening-balance`, { amount: '1200', note: 'From the old khata' });
  assert.equal(res.status, 201);
  assert.match(res.body.sale.invoiceNo, /^INV-\d{6}$/);
  assert.equal(await dueOf(ids.noPhone), '1200.00');
  assert.equal((await owner.post(`/customers/${ids.noPhone}/opening-balance`, { amount: '5' })).status, 409);
  const detail = (await owner.get(`/customers/${ids.noPhone}`)).body;
  assert.deepEqual([detail.sales[0].saleType, detail.sales[0].dueAmount], ['opening_due', '1200.00']);
  assert.equal((await staff.get('/customers?hasDue=1')).body.totalDue, '1800.00');
  // A customer who owes money cannot be deactivated.
  assert.equal((await staff.put(`/customers/${ids.noPhone}`, { isActive: false })).status, 400);
});

// --- void -------------------------------------------------------------------

it('voiding a sale: staff cannot; a paid sale needs explicit confirmation; stock and balance come back', async () => {
  assert.equal((await staff.post(`/sales/${ids.repeated}/void`, { reason: 'Customer returned it' })).status, 403);
  assert.equal((await owner.post(`/sales/${ids.repeated}/void`, {})).status, 400);

  const unconfirmed = await owner.post(`/sales/${ids.repeated}/void`, { reason: 'Customer returned it' });
  assert.equal(unconfirmed.status, 409);
  assert.deepEqual(unconfirmed.body.error.details, { payments: 1, amount: '100.00' });
  assert.equal((await one('SELECT status FROM sales WHERE id = ?', [ids.repeated])).status, 'completed');

  const stock = await stockOf(ids.pendrive);
  const res = await owner.post(`/sales/${ids.repeated}/void`, { reason: 'Customer returned it', voidPayments: true });
  assert.equal(res.status, 200);
  assert.deepEqual([res.body.sale.status, res.body.sale.voidReason, res.body.sale.voidedByName], ['void', 'Customer returned it', 'Owner']);
  assert.equal(await stockOf(ids.pendrive), stock + 1);
  assert.equal(await dueOf(ids.rahim), '250.00');
  const payment = (await owner.get(`/sales/${ids.repeated}`)).body.sale.payments[0];
  assert.equal(payment.status, 'void');
  const move = await one("SELECT quantity, movement_type FROM inventory_movements WHERE reference_type = 'sale' AND reference_id = ? AND movement_type = 'sale_void'", [ids.repeated]);
  assert.equal(move.quantity, 1);
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'sale.void'")).n), 1);
  assert.equal((await owner.post(`/sales/${ids.repeated}/void`, { reason: 'Again', voidPayments: true })).status, 409);
});

it('a walk-in sale is voided together with its payment, and frees its transaction ID', async () => {
  const res = await owner.post(`/sales/${ids.walkInBkash}/void`, { reason: 'Rung up by mistake', voidPayments: true });
  assert.equal(res.status, 200);
  // The ID can now be recorded on a correct sale.
  assert.equal((await sell(owner, { items: [pendrive(1)], payments: [{ method: 'bkash', amount: '450', reference: 'TRX777', verified: true }] })).status, 201);
});

it('six people voiding one sale at once: it is voided once and stock returns once', async () => {
  const id = (await sell(staff, { items: [pendrive(1)], payments: [cash('450')] })).body.sale.id;
  const stock = await stockOf(ids.pendrive);
  const results = await Promise.all(Array.from({ length: 6 }, () => owner.post(`/sales/${id}/void`, { reason: 'Race', voidPayments: true })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  assert.equal(await stockOf(ids.pendrive), stock + 1);
});

it('voiding a wrongly entered payment on a customer sale raises the due again', async () => {
  const sale = (await owner.get(`/sales/${ids.partial}`)).body.sale;
  assert.equal(sale.dueAmount, '250.00');
  assert.equal((await staff.post(`/payments/${sale.payments[0].id}/void`, { reason: 'Typed 200, was 20' })).status, 403);
  assert.equal((await owner.post(`/payments/${sale.payments[0].id}/void`, {})).status, 400);
  assert.equal((await owner.post(`/payments/${sale.payments[0].id}/void`, { reason: 'Typed 200, was 20' })).status, 200);
  const after = (await owner.get(`/sales/${ids.partial}`)).body.sale;
  assert.deepEqual([after.paidAmount, after.dueAmount, after.paymentStatus, after.payments[0].status], ['0.00', '450.00', 'unpaid', 'void']);
  assert.equal(await dueOf(ids.rahim), '450.00');
  assert.equal((await owner.post(`/payments/${sale.payments[0].id}/void`, { reason: 'Again' })).status, 409);
  assert.equal((await owner.post(`/payments/${sale.payments[0].id}/verify`)).status, 409);
});

// --- lists and consistency --------------------------------------------------

it('sales list: filters and totals that leave out voided sales', async () => {
  const all = (await staff.get('/sales?pageSize=200')).body;
  const completed = all.items.filter((s) => s.status === 'completed');
  const sum = (rows, field) => rows.reduce((total, s) => total + Number(s[field]), 0);
  assert.ok(all.items.some((s) => s.status === 'void'));
  assert.equal(Number(all.totalAmount), sum(completed, 'totalAmount'));
  assert.equal(Number(all.totalDue), sum(completed, 'dueAmount'));

  assert.equal((await staff.get(`/sales?customerId=${ids.rahim}&status=completed&paymentStatus=unpaid`)).body.total, 1);
  assert.equal((await staff.get('/sales?search=INV-000001')).body.total, 1);
  assert.equal((await staff.get('/sales?search=rahim uddin')).body.items.every((s) => s.customerId === ids.rahim), true);
  assert.ok((await staff.get('/sales?method=nagad')).body.total >= 1);
  assert.equal((await staff.get('/sales?from=2026-01-05&to=2026-01-05')).body.total, 1);
  assert.equal((await staff.get('/sales?status=void')).body.items.every((s) => s.status === 'void'), true);
});

it('after everything: stock equals its ledger, every sale and customer equals its payments', async () => {
  assert.deepEqual((await owner.get('/inventory/reconcile')).body.differences, []);

  const sales = await db.query(
    `SELECT s.id FROM sales s
      LEFT JOIN (SELECT a.sale_id, SUM(IF(p.is_verified = 1, a.amount, 0)) AS paid, SUM(IF(p.is_verified = 0, a.amount, 0)) AS unverified
                   FROM payment_allocations a JOIN payments p ON p.id = a.payment_id WHERE p.status = 'active' GROUP BY a.sale_id) x ON x.sale_id = s.id
     WHERE s.paid_amount <> COALESCE(x.paid, 0) OR s.unverified_amount <> COALESCE(x.unverified, 0) OR s.due_amount <> s.total_amount - COALESCE(x.paid, 0)`,
  );
  assert.deepEqual(sales, []);

  const customers = await db.query(
    `SELECT c.id FROM customers c
     WHERE c.current_due <> (SELECT COALESCE(SUM(s.due_amount), 0) FROM sales s WHERE s.customer_id = c.id AND s.status = 'completed')`,
  );
  assert.deepEqual(customers, []);
  // No completed walk-in sale carries a due.
  assert.equal(Number((await one("SELECT COUNT(*) AS n FROM sales WHERE status = 'completed' AND customer_id IS NULL AND due_amount > 0")).n), 0);
});

// --- access -----------------------------------------------------------------

it('nothing here works without a staff session; a customer session is not one', async () => {
  const anon = app.client();
  for (const url of ['/customers', '/customers/options', `/customers/${ids.rahim}`, '/sales', `/sales/${ids.walkIn}`, '/settings/shop']) assert.equal((await anon.get(url)).status, 401, url);
  assert.equal((await sell(anon, { items: [copies(1)], payments: [cash('2')] })).status, 401);

  const pin = (await owner.post(`/customers/${ids.rahim}/reset-pin`)).body.portalPin;
  const customer = app.client();
  assert.equal((await customer.post('/portal/login', { phone: '01712345678', pin })).status, 200);
  for (const url of ['/customers', `/customers/${ids.rahim}`, '/sales', `/sales/${ids.partial}`]) assert.equal((await customer.get(url)).status, 401, url);
  // The portal shows the customer their own balance, straight from the same figures.
  assert.equal((await customer.get('/portal/me')).body.customer.currentDue, await dueOf(ids.rahim));
});

it('shop settings for the invoice header are readable by staff', async () => {
  const res = await staff.get('/settings/shop');
  assert.equal(res.status, 200);
  assert.equal(res.body.settings['shop.name'], 'SS Computer Training Centre');
  assert.ok('invoice.footer' in res.body.settings);
});

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

  ids.category = (await owner.post('/categories', { name: 'Stationery' })).body.category.id;
  ids.paper = (await owner.post('/products', { categoryId: ids.category, sku: 'PAPER', name: 'A4 Paper', price: 520, costPrice: 470, openingStock: 5 })).body.product.id;
  ids.pen = (await owner.post('/products', { categoryId: ids.category, sku: 'PEN', name: 'Ball Pen', price: 10, costPrice: 6 })).body.product.id;
  ids.supplier = (await owner.post('/suppliers', { name: 'Karim Traders' })).body.supplier.id;
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const stockOf = async (id) => (await db.query('SELECT stock_qty FROM products WHERE id = ?', [id]))[0].stock_qty;
const payable = async () => (await db.query('SELECT current_payable FROM suppliers WHERE id = ?', [ids.supplier]))[0].current_payable;
const count = async (table) => Number((await db.query(`SELECT COUNT(*) AS n FROM ${table}`))[0].n);
const bill = (extra = {}) => ({
  supplierId: ids.supplier,
  items: [
    { productId: ids.paper, quantity: 10, unitCost: '460' },
    { productId: ids.pen, quantity: 100, unitCost: '5.50' },
  ],
  ...extra,
});

// --- migration 002 ----------------------------------------------------------

it('migration 002 adds the purchase columns and can be run again without error', async () => {
  const columns = (await db.query("SELECT column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'purchases'")).map((r) => r.c);
  for (const column of ['idempotency_key', 'status', 'void_reason', 'voided_by', 'voided_at']) assert.ok(columns.includes(column), column);

  const mysql = require('mysql2/promise');
  const conn = await mysql.createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  try {
    const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '002_purchase_idempotency_and_void.sql'), 'utf8');
    await conn.query(sql);
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  const [status] = await db.query("SELECT column_default AS d, is_nullable AS n FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'purchases' AND column_name = 'status'");
  assert.equal(status.d, 'active');
  assert.equal(status.n, 'NO');
});

// --- the stock ledger keeps signed quantities -------------------------------

it('stock removals are stored as negative quantities; the database accepts them and reconciliation depends on the sign', async () => {
  await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 2, note: 'Damaged' });
  const [row] = await db.query("SELECT quantity, balance_after FROM inventory_movements WHERE product_id = ? AND movement_type = 'adjustment_out'", [ids.paper]);
  assert.equal(row.quantity, -2); // CHECK (quantity <> 0) refuses only zero
  assert.equal(row.balance_after, 3);
  await assert.rejects(db.query("INSERT INTO inventory_movements (product_id, movement_type, quantity, balance_after, reference_type, created_by) VALUES (?, 'adjustment_in', 0, 3, 'manual', 1)", [ids.paper]), /ck_inv_quantity/);
  // opening +5, adjustment −2 → 3. With unsigned quantities this sum would be 7.
  assert.deepEqual((await owner.get('/inventory/reconcile')).body.differences, []);
  await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'in', quantity: 2, note: 'Found again' });
});

// --- idempotency ------------------------------------------------------------

it('saving the same bill twice with one key stores it once', async () => {
  const key = crypto.randomUUID();
  const first = await owner.post('/purchases', bill({ idempotencyKey: key }));
  assert.equal(first.status, 201);
  ids.unpaid = first.body.purchase.id;

  const snapshot = async () => [await count('purchases'), await count('purchase_items'), await stockOf(ids.paper), await stockOf(ids.pen), await payable(), (await db.query("SELECT last_number AS n FROM document_counters WHERE doc_type = 'purchase'"))[0].n];
  const before = await snapshot();

  const again = await owner.post('/purchases', bill({ idempotencyKey: key }));
  assert.equal(again.status, 200);
  assert.equal(again.body.duplicate, true);
  assert.deepEqual(again.body.purchase, first.body.purchase);
  assert.deepEqual(await snapshot(), before);
  assert.equal(before[2], 15);
  assert.equal(before[4], '5150.00'); // 10 × 460 + 100 × 5.50
});

it('ten copies of one save arriving together store one bill', async () => {
  const key = crypto.randomUUID();
  const before = { purchases: await count('purchases'), paper: await stockOf(ids.paper) };
  const results = await Promise.all(Array.from({ length: 10 }, () => owner.post('/purchases', bill({ idempotencyKey: key, paidAmount: '5150' }))));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 200 && r.body.duplicate).length, 9);
  assert.equal(new Set(results.map((r) => r.body.purchase.purchaseNo)).size, 1);
  assert.equal(await count('purchases'), before.purchases + 1);
  assert.equal(await stockOf(ids.paper), before.paper + 10);
  ids.paid = results[0].body.purchase.id;
});

it('different keys, or no key, are separate bills; a malformed key is rejected', async () => {
  const before = await count('purchases');
  assert.equal((await owner.post('/purchases', bill({ idempotencyKey: crypto.randomUUID() }))).status, 201);
  assert.equal((await owner.post('/purchases', bill())).status, 201);
  assert.equal((await owner.post('/purchases', bill())).status, 201);
  assert.equal(await count('purchases'), before + 3);
  assert.equal((await owner.post('/purchases', bill({ idempotencyKey: 'not-a-uuid' }))).status, 400);
  assert.equal(await count('purchases'), before + 3);
});

// --- void -------------------------------------------------------------------

it('voiding needs a reason, the permission, and an existing bill', async () => {
  assert.equal((await owner.post(`/purchases/${ids.unpaid}/void`, {})).status, 400);
  assert.equal((await owner.post(`/purchases/${ids.unpaid}/void`, { reason: 'x' })).status, 400);
  assert.equal((await staff.post(`/purchases/${ids.unpaid}/void`, { reason: 'Wrong supplier' })).status, 403);
  assert.equal((await owner.post('/purchases/99999/void', { reason: 'Wrong supplier' })).status, 404);
  assert.equal((await db.query('SELECT status FROM purchases WHERE id = ?', [ids.unpaid]))[0].status, 'active');
});

it('voiding a bill takes its products back out of stock, marks it void and lowers the payable', async () => {
  const before = { paper: await stockOf(ids.paper), pen: await stockOf(ids.pen), payable: await payable(), purchases: await count('purchases') };
  const res = await owner.post(`/purchases/${ids.unpaid}/void`, { reason: 'Entered against the wrong supplier' });
  assert.equal(res.status, 200);
  assert.equal(res.body.purchase.status, 'void');
  assert.equal(res.body.purchase.voidReason, 'Entered against the wrong supplier');
  assert.equal(res.body.purchase.voidedByName, 'Owner');
  assert.ok(res.body.purchase.voidedAt);

  assert.equal(await stockOf(ids.paper), before.paper - 10);
  assert.equal(await stockOf(ids.pen), before.pen - 100);
  assert.equal(Number(await payable()), Number(before.payable) - 5150);
  assert.equal(await count('purchases'), before.purchases); // nothing deleted

  const movements = await db.query("SELECT product_id, movement_type, quantity, reference_type, reference_id, note FROM inventory_movements WHERE reference_id = ? AND movement_type = 'adjustment_out' ORDER BY product_id", [ids.unpaid]);
  assert.deepEqual(movements.map((m) => [m.product_id, m.quantity, m.reference_type]), [[ids.paper, -10, 'purchase'], [ids.pen, -100, 'purchase']]);
  assert.match(movements[0].note, /^Void PUR-\d{6}: Entered against/);

  const [log] = await db.query("SELECT * FROM audit_logs WHERE action = 'purchase.void' ORDER BY id DESC LIMIT 1");
  assert.equal(log.entity_id, ids.unpaid);
  assert.equal(log.new_values.reason, 'Entered against the wrong supplier');
  assert.deepEqual((await owner.get('/inventory/reconcile')).body.differences, []);
});

it('voiding a bill with a mistyped cost puts the previous cost price back, unless it was changed since', async () => {
  const cost = async (id) => (await db.query('SELECT cost_price FROM products WHERE id = ?', [id]))[0].cost_price;
  const a = (await owner.post('/products', { categoryId: ids.category, sku: 'COST-A', name: 'Cost A', price: 200, costPrice: '100', openingStock: 1 })).body.product.id;
  const b = (await owner.post('/products', { categoryId: ids.category, sku: 'COST-B', name: 'Cost B', price: 200, costPrice: '100', openingStock: 1 })).body.product.id;
  const typo = (await owner.post('/purchases', { supplierId: ids.supplier, items: [{ productId: a, quantity: 2, unitCost: '999' }, { productId: b, quantity: 2, unitCost: '999' }] })).body.purchase.id;
  assert.equal(await cost(a), '999.00');
  await owner.put(`/products/${b}`, { costPrice: '120.00' }); // corrected by hand after the bill

  assert.equal((await owner.post(`/purchases/${typo}/void`, { reason: 'Cost typed wrong' })).status, 200);
  assert.equal(await cost(a), '100.00'); // back to the opening-stock cost
  assert.equal(await cost(b), '120.00'); // the later manual change is kept
});

it('a bill can be voided only once, even when two people try at the same moment', async () => {
  assert.equal((await owner.post(`/purchases/${ids.unpaid}/void`, { reason: 'Again' })).status, 409);

  const fresh = (await owner.post('/purchases', bill())).body.purchase.id;
  const before = await stockOf(ids.paper);
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => owner.post(`/purchases/${fresh}/void`, { reason: `Race ${i}` })));
  assert.equal(results.filter((r) => r.status === 200).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 5);
  assert.equal(await stockOf(ids.paper), before - 10); // taken out once, not six times
});

it('a bill with a payment recorded cannot be voided', async () => {
  const before = { paper: await stockOf(ids.paper), payable: await payable() };
  const res = await owner.post(`/purchases/${ids.paid}/void`, { reason: 'Mistake' });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /payment/);
  assert.equal((await db.query('SELECT status FROM purchases WHERE id = ?', [ids.paid]))[0].status, 'active');
  assert.deepEqual({ paper: await stockOf(ids.paper), payable: await payable() }, before);
});

it('a bill whose products have since left the shelf cannot be voided, and nothing changes', async () => {
  const mouse = (await owner.post('/products', { categoryId: ids.category, sku: 'MOUSE', name: 'USB Mouse', price: 380 })).body.product.id;
  const purchase = (await owner.post('/purchases', { supplierId: ids.supplier, items: [{ productId: ids.pen, quantity: 5, unitCost: '5' }, { productId: mouse, quantity: 4, unitCost: '230' }] })).body.purchase.id;
  await owner.post('/inventory/adjustments', { productId: mouse, direction: 'out', quantity: 3, note: 'Sold before the system' });

  const before = { pen: await stockOf(ids.pen), mouse: await stockOf(mouse), payable: await payable(), movements: await count('inventory_movements') };
  const res = await owner.post(`/purchases/${purchase}/void`, { reason: 'Wrong bill' });
  assert.equal(res.status, 409);
  assert.match(res.body.error.message, /Not enough stock of "USB Mouse": 1 available/);
  // The pens were processed first and must have been rolled back with the rest.
  assert.deepEqual({ pen: await stockOf(ids.pen), mouse: await stockOf(mouse), payable: await payable(), movements: await count('inventory_movements') }, before);
  assert.equal((await db.query('SELECT status FROM purchases WHERE id = ?', [purchase]))[0].status, 'active');
});

it('an opening payable cannot be voided', async () => {
  const other = (await owner.post('/suppliers', { name: 'Nilkhet Paper House' })).body.supplier.id;
  const opening = (await owner.post(`/suppliers/${other}/opening-payable`, { amount: '900' })).body.purchase.id;
  assert.equal((await owner.post(`/purchases/${opening}/void`, { reason: 'Wrong amount' })).status, 409);
  assert.equal((await owner.get(`/suppliers/${other}`)).body.supplier.currentPayable, '900.00');
});

it('voided bills stay in the list with their status, and are left out of the totals', async () => {
  const list = (await owner.get(`/purchases?supplierId=${ids.supplier}&pageSize=200`)).body;
  const voided = list.items.filter((p) => p.status === 'void');
  const active = list.items.filter((p) => p.status === 'active');
  assert.equal(voided.length, 3); // the unpaid bill, the mistyped-cost bill and the raced one
  assert.equal(list.total, voided.length + active.length);
  const sum = (rows, field) => rows.reduce((total, p) => total + Number(p[field]), 0);
  assert.equal(Number(list.totalAmount), sum(active, 'totalAmount'));
  assert.equal(Number(list.totalDue), sum(active, 'dueAmount'));
  assert.equal(Number(await payable()), sum(active, 'dueAmount'));

  const detail = (await owner.get(`/purchases/${ids.unpaid}`)).body.purchase;
  assert.equal(detail.status, 'void');
  assert.equal(detail.items.length, 2); // the lines are kept
});

// --- must change password ---------------------------------------------------

it('a user with a password set by the Owner can do nothing but change it', async () => {
  await owner.post('/users', { name: 'Salma Begum', username: 'salma', password: 'salma-password-1', role: 'owner' });
  const salma = app.client();
  assert.equal((await salma.post('/auth/login', { username: 'salma', password: 'salma-password-1' })).status, 200);

  const me = await salma.get('/auth/me');
  assert.equal(me.status, 200);
  assert.equal(me.body.user.mustChangePassword, true);

  for (const url of ['/products', '/categories', '/services', '/inventory/movements', '/suppliers', '/purchases', '/users', '/roles']) {
    const res = await salma.get(url);
    assert.equal(res.status, 403, url);
    assert.equal(res.body.error.code, 'password_change_required', url);
  }
  const blocked = [
    ['/products', { categoryId: ids.category, name: 'Nope', price: 1 }],
    ['/purchases', bill()],
    [`/purchases/${ids.paid}/void`, { reason: 'Nope nope' }],
    ['/users', { name: 'Evil Twin', username: 'twin', password: 'twin-password-1', role: 'owner' }],
  ];
  const before = [await count('products'), await count('purchases'), await count('users')];
  for (const [url, body] of blocked) assert.equal((await salma.post(url, body)).body.error.code, 'password_change_required', url);
  assert.deepEqual([await count('products'), await count('purchases'), await count('users')], before);

  // Changing the password lifts the restriction on the same session.
  assert.equal((await salma.post('/auth/change-password', { currentPassword: 'salma-password-1', newPassword: 'my-own-password-9' })).status, 200);
  assert.equal((await salma.get('/auth/me')).body.user.mustChangePassword, false);
  assert.equal((await salma.get('/products')).status, 200);
  assert.equal((await salma.post('/auth/logout')).status, 200);
});

it('logout still works for a user who has not changed their password', async () => {
  await owner.post('/users', { name: 'Jamal Uddin', username: 'jamal', password: 'jamal-password-1', role: 'staff' });
  const jamal = app.client();
  await jamal.post('/auth/login', { username: 'jamal', password: 'jamal-password-1' });
  assert.equal((await jamal.get('/products')).status, 403);
  assert.equal((await jamal.post('/auth/logout')).status, 200);
  assert.equal((await jamal.get('/auth/me')).status, 401);
});

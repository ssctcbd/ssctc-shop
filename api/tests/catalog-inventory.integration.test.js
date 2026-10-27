const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };

let app;
let db;
let owner;
let staff;
let skipReason = false;

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
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const stockOf = async (id) => (await db.query('SELECT stock_qty FROM products WHERE id = ?', [id]))[0].stock_qty;
const ledgerOf = async (id) => Number((await db.query('SELECT COALESCE(SUM(quantity), 0) AS s FROM inventory_movements WHERE product_id = ?', [id]))[0].s);
const lastAudit = async (action) => (await db.query('SELECT * FROM audit_logs WHERE action = ? ORDER BY id DESC LIMIT 1', [action]))[0];

// Shared fixtures created by the first tests and used by later ones.
const ids = {};

// --- categories -------------------------------------------------------------

it('owner creates categories two levels deep; a third level is refused', async () => {
  const top = await owner.post('/categories', { name: 'Accessories' });
  assert.equal(top.status, 201);
  ids.accessories = top.body.category.id;

  const child = await owner.post('/categories', { name: 'Mouse', parentId: ids.accessories });
  assert.equal(child.status, 201);
  ids.mouse = child.body.category.id;

  const grandchild = await owner.post('/categories', { name: 'Wireless', parentId: ids.mouse });
  assert.equal(grandchild.status, 400);
  assert.ok(grandchild.body.error.details.fields.parentId);

  ids.stationery = (await owner.post('/categories', { name: 'Stationery' })).body.category.id;
});

it('category names are unique among siblings, including at the top level', async () => {
  assert.equal((await owner.post('/categories', { name: 'Accessories' })).status, 409);
  assert.equal((await owner.post('/categories', { name: 'Mouse', parentId: ids.accessories })).status, 409);
  // The same name under a different parent is fine.
  assert.equal((await owner.post('/categories', { name: 'Mouse', parentId: ids.stationery })).status, 201);
});

it('a category with sub-categories cannot be moved under another; a category cannot be its own parent', async () => {
  assert.equal((await owner.put(`/categories/${ids.accessories}`, { parentId: ids.stationery })).status, 400);
  assert.equal((await owner.put(`/categories/${ids.stationery}`, { parentId: ids.stationery })).status, 400);
  const renamed = await owner.put(`/categories/${ids.stationery}`, { name: 'Stationery & Paper' });
  assert.equal(renamed.status, 200);
  assert.equal(renamed.body.category.name, 'Stationery & Paper');
  assert.equal((await owner.put('/categories/99999', { name: 'x' })).status, 404);
});

// --- products ---------------------------------------------------------------

it('owner creates a product; a code is generated when none is given; opening stock goes through the ledger', async () => {
  const res = await owner.post('/products', { categoryId: ids.mouse, name: 'USB Mouse', price: '350', costPrice: 220.5, openingStock: 10, lowStockThreshold: 3 });
  assert.equal(res.status, 201);
  const p = res.body.product;
  ids.mouseProduct = p.id;
  assert.match(p.sku, /^P-\d{5}$/);
  assert.equal(p.price, '350.00');
  assert.equal(p.costPrice, '220.50');
  assert.equal(p.stockQty, 10);
  assert.equal(p.categoryName, 'Mouse');

  const [m] = await db.query('SELECT * FROM inventory_movements WHERE product_id = ?', [p.id]);
  assert.equal(m.movement_type, 'opening');
  assert.equal(m.quantity, 10);
  assert.equal(m.balance_after, 10);
  assert.equal(m.unit_cost, '220.50');
});

it('product codes are upper-cased and unique', async () => {
  const res = await owner.post('/products', { categoryId: ids.stationery, sku: 'a4-paper', name: 'A4 Paper 80gsm', unit: 'rim', price: 520, costPrice: 470 });
  assert.equal(res.status, 201);
  assert.equal(res.body.product.sku, 'A4-PAPER');
  assert.equal(res.body.product.stockQty, 0);
  ids.paper = res.body.product.id;

  const dup = await owner.post('/products', { categoryId: ids.stationery, sku: 'A4-PAPER', name: 'Other', price: 1 });
  assert.equal(dup.status, 409);
  assert.ok(dup.body.error.details.fields.sku);
  assert.equal((await owner.put(`/products/${ids.mouseProduct}`, { sku: 'a4-paper' })).status, 409);
});

it('invalid product input is rejected with field messages', async () => {
  const cases = [
    { categoryId: ids.mouse, name: 'X', price: '12.345' },
    { categoryId: ids.mouse, name: 'X', price: -5 },
    { categoryId: ids.mouse, name: 'X', price: 'abc' },
    { categoryId: ids.mouse, name: '', price: 10 },
    { categoryId: 99999, name: 'X', price: 10 },
    { categoryId: ids.mouse, name: 'X', price: 10, openingStock: 1.5 },
    { categoryId: ids.mouse, name: 'X', price: 10, trackStock: false, openingStock: 5 },
    { categoryId: ids.mouse, name: 'X', price: 10, stockQty: 500 },
  ];
  for (const body of cases) assert.equal((await owner.post('/products', body)).status, 400, JSON.stringify(body));
  const [count] = await db.query('SELECT COUNT(*) AS n FROM products');
  assert.equal(count.n, 2);
});

it('editing a product never changes its stock; a partial update leaves other fields alone', async () => {
  await owner.put(`/products/${ids.mouseProduct}`, { brand: 'A4Tech', note: 'Black' });
  assert.equal((await owner.put(`/products/${ids.mouseProduct}`, { stockQty: 999 })).status, 400);
  const res = await owner.put(`/products/${ids.mouseProduct}`, { name: 'USB Optical Mouse' });
  assert.equal(res.status, 200);
  assert.equal(res.body.product.name, 'USB Optical Mouse');
  assert.equal(res.body.product.brand, 'A4Tech');
  assert.equal(res.body.product.note, 'Black');
  assert.equal(res.body.product.stockQty, 10);
});

it('a price change is audited with the old and new price', async () => {
  const res = await owner.put(`/products/${ids.mouseProduct}`, { price: '380.00' });
  assert.equal(res.body.product.price, '380.00');
  const log = await lastAudit('product.price_change');
  assert.equal(log.entity_id, ids.mouseProduct);
  assert.equal(log.old_values.price, '350.00');
  assert.equal(log.new_values.price, '380.00');
  assert.equal(log.actor_user_id, 1);
});

it('product list: search, category (including sub-categories), status and low-stock filters', async () => {
  const names = async (qs) => (await owner.get(`/products?${qs}`)).body.items.map((p) => p.name);
  assert.deepEqual(await names(''), ['A4 Paper 80gsm', 'USB Optical Mouse']);
  assert.deepEqual(await names('search=optical'), ['USB Optical Mouse']);
  assert.deepEqual(await names('search=a4-pap'), ['A4 Paper 80gsm']);
  assert.deepEqual(await names('search=a4tech'), ['USB Optical Mouse']);
  assert.deepEqual(await names('search=100%25'), []); // "%" is text, not a wildcard
  assert.deepEqual(await names(`categoryId=${ids.accessories}`), ['USB Optical Mouse']); // parent includes child category
  assert.deepEqual(await names('lowStock=1'), ['A4 Paper 80gsm']); // 0 in stock, threshold 5

  await owner.put(`/products/${ids.paper}`, { status: 'archived' });
  assert.deepEqual(await names(''), ['USB Optical Mouse']);
  assert.deepEqual(await names('status=archived'), ['A4 Paper 80gsm']);
  assert.equal((await owner.get('/products?status=all')).body.total, 2);
  await owner.put(`/products/${ids.paper}`, { status: 'active' });

  assert.equal((await owner.get('/products?page=0')).status, 400);
  assert.equal((await owner.get('/products?sort=price')).status, 400);
});

// --- services ---------------------------------------------------------------

it('owner manages the service rate list; rate changes are audited', async () => {
  const res = await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4 B/W', unit: 'page', defaultPrice: 2 });
  assert.equal(res.status, 201);
  assert.equal(res.body.service.defaultPrice, '2.00');
  assert.equal(res.body.service.priceEditable, true);
  ids.photocopy = res.body.service.id;

  assert.equal((await owner.post('/services', { serviceType: 'print', name: 'Photocopy A4 B/W', defaultPrice: 3 })).status, 409);
  assert.equal((await owner.post('/services', { serviceType: 'scanning', name: 'Scan', defaultPrice: 3 })).status, 400);

  const changed = await owner.put(`/services/${ids.photocopy}`, { defaultPrice: '2.50', priceEditable: false });
  assert.equal(changed.body.service.defaultPrice, '2.50');
  assert.equal(changed.body.service.priceEditable, false);
  const log = await lastAudit('service.rate_change');
  assert.equal(log.old_values.default_price, '2.00');
  assert.equal(log.new_values.default_price, '2.50');

  await owner.post('/services', { serviceType: 'online', name: 'NID Online Application', unit: 'application', defaultPrice: 100 });
  const off = await owner.put(`/services/${ids.photocopy}`, { isActive: false });
  assert.equal(off.body.service.isActive, false);
  assert.equal((await owner.get('/services')).body.services.length, 2);
});

// --- inventory --------------------------------------------------------------

it('stock-in adds stock, writes the ledger and updates the latest cost', async () => {
  const res = await owner.post('/inventory/stock-in', { productId: ids.paper, quantity: 20, unitCost: '465.00', note: 'From old store room' });
  assert.equal(res.status, 201);
  assert.equal(res.body.balanceAfter, 20);
  const [p] = await db.query('SELECT stock_qty, cost_price FROM products WHERE id = ?', [ids.paper]);
  assert.equal(p.stock_qty, 20);
  assert.equal(p.cost_price, '465.00');
});

it('an adjustment needs a reason, and cannot take stock below zero', async () => {
  assert.equal((await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 2 })).status, 400);
  assert.equal((await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 0, note: 'Damaged' })).status, 400);

  const out = await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 2, note: 'Water damaged' });
  assert.equal(out.status, 201);
  assert.equal(out.body.balanceAfter, 18);

  const tooMany = await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 19, note: 'Count correction' });
  assert.equal(tooMany.status, 409);
  assert.equal(tooMany.body.error.details.available, 18);
  assert.equal(await stockOf(ids.paper), 18);

  const back = await owner.post('/inventory/adjustments', { productId: ids.paper, direction: 'in', quantity: 1, note: 'Found one more' });
  assert.equal(back.body.balanceAfter, 19);
  assert.equal((await lastAudit('inventory.adjust')).new_values.note, 'Found one more');
});

it('stock cannot be moved for an untracked or unknown product; tracking cannot be turned off while stock remains', async () => {
  const service = await owner.post('/products', { categoryId: ids.stationery, name: 'Gift wrap (untracked)', price: 20, trackStock: false });
  ids.untracked = service.body.product.id;
  assert.equal((await owner.post('/inventory/stock-in', { productId: ids.untracked, quantity: 5 })).status, 409);
  assert.equal((await owner.post('/inventory/stock-in', { productId: 99999, quantity: 5 })).status, 404);
  assert.equal((await owner.put(`/products/${ids.paper}`, { trackStock: false })).status, 400);
});

it('movement history shows every change, newest first, with a running balance', async () => {
  const res = await owner.get(`/inventory/movements?productId=${ids.paper}`);
  assert.equal(res.body.total, 3);
  assert.deepEqual(res.body.items.map((m) => [m.type, m.quantity, m.balanceAfter]), [
    ['adjustment_in', 1, 19],
    ['adjustment_out', -2, 18],
    ['stock_in', 20, 20],
  ]);
  assert.equal(res.body.items[0].userName, 'Owner');
  assert.equal((await owner.get('/inventory/movements?type=opening')).body.total, 1);
  assert.equal((await owner.get('/inventory/movements?from=2000-01-01&to=2000-01-02')).body.total, 0);
  assert.equal((await owner.get('/inventory/movements?from=yesterday')).status, 400);
});

it('low-stock list shows active tracked products at or below their threshold', async () => {
  const before = (await owner.get('/inventory/low-stock')).body.products.map((p) => p.name);
  assert.deepEqual(before, []);
  await owner.put(`/products/${ids.mouseProduct}`, { lowStockThreshold: 10 });
  const after = (await owner.get('/inventory/low-stock')).body.products;
  assert.deepEqual(after.map((p) => [p.name, p.stockQty, p.lowStockThreshold]), [['USB Optical Mouse', 10, 10]]);
  await owner.put(`/products/${ids.mouseProduct}`, { lowStockThreshold: 3 });
});

it('twenty simultaneous removals of one unit from a stock of five: exactly five succeed', async () => {
  const p = (await owner.post('/products', { categoryId: ids.mouse, name: 'Last Five', price: 100, openingStock: 5 })).body.product;
  const results = await Promise.all(Array.from({ length: 20 }, (_, i) => owner.post('/inventory/adjustments', { productId: p.id, direction: 'out', quantity: 1, note: `Race ${i}` })));
  assert.equal(results.filter((r) => r.status === 201).length, 5);
  assert.equal(results.filter((r) => r.status === 409).length, 15);
  assert.equal(await stockOf(p.id), 0);
  assert.equal(await ledgerOf(p.id), 0);
  const balances = (await db.query("SELECT balance_after FROM inventory_movements WHERE product_id = ? AND movement_type = 'adjustment_out' ORDER BY id", [p.id])).map((r) => r.balance_after);
  assert.deepEqual(balances, [4, 3, 2, 1, 0]);
});

// --- suppliers and purchases ------------------------------------------------

it('owner creates and edits a supplier', async () => {
  const res = await owner.post('/suppliers', { name: 'Karim Traders', company: 'Karim Traders Ltd', phone: '01711111111' });
  assert.equal(res.status, 201);
  assert.equal(res.body.supplier.currentPayable, '0.00');
  ids.supplier = res.body.supplier.id;

  const updated = await owner.put(`/suppliers/${ids.supplier}`, { address: 'Nilkhet, Dhaka' });
  assert.equal(updated.body.supplier.address, 'Nilkhet, Dhaka');
  assert.equal(updated.body.supplier.company, 'Karim Traders Ltd');
  assert.equal((await owner.post('/suppliers', { name: '' })).status, 400);
});

it('an opening payable can be recorded once and becomes the supplier’s balance', async () => {
  const res = await owner.post(`/suppliers/${ids.supplier}/opening-payable`, { amount: '1500', note: 'Owed before the system' });
  assert.equal(res.status, 201);
  assert.equal(res.body.purchase.purchaseNo, 'PUR-000001');
  assert.equal((await owner.post(`/suppliers/${ids.supplier}/opening-payable`, { amount: '10' })).status, 409);
  assert.equal((await owner.post(`/suppliers/${ids.supplier}/opening-payable`, { amount: '0' })).status, 400);
  assert.equal((await owner.get(`/suppliers/${ids.supplier}`)).body.supplier.currentPayable, '1500.00');
});

it('a purchase bill adds stock, updates cost, records the payment and the payable — in one step', async () => {
  const stockBefore = { mouse: await stockOf(ids.mouseProduct), paper: await stockOf(ids.paper) };
  const res = await owner.post('/purchases', {
    supplierId: ids.supplier,
    supplierMemoNo: 'KT-778',
    items: [
      { productId: ids.paper, quantity: 10, unitCost: '460.50' },
      { productId: ids.mouseProduct, quantity: 4, unitCost: 230 },
    ],
    paidAmount: '2000',
    paymentMethod: 'bkash',
    paymentReference: '9XK2ABCD41',
  });
  assert.equal(res.status, 201);
  const pu = res.body.purchase;
  ids.purchase = pu.id;
  assert.equal(pu.purchaseNo, 'PUR-000002');
  assert.equal(pu.totalAmount, '5525.00'); // 10 × 460.50 + 4 × 230
  assert.equal(pu.paidAmount, '2000.00');
  assert.equal(pu.dueAmount, '3525.00');
  assert.equal(pu.paymentStatus, 'partial');

  assert.equal(await stockOf(ids.paper), stockBefore.paper + 10);
  assert.equal(await stockOf(ids.mouseProduct), stockBefore.mouse + 4);
  const [paper] = await db.query('SELECT cost_price FROM products WHERE id = ?', [ids.paper]);
  assert.equal(paper.cost_price, '460.50');

  const movements = await db.query("SELECT product_id, quantity, unit_cost, reference_id FROM inventory_movements WHERE reference_type = 'purchase' ORDER BY product_id");
  assert.equal(movements.length, 2);
  assert.ok(movements.every((m) => m.reference_id === pu.id));

  const [payment] = await db.query('SELECT * FROM supplier_payments WHERE purchase_id = ?', [pu.id]);
  assert.equal(payment.voucher_no, 'SPAY-000001');
  assert.equal(payment.amount, '2000.00');
  assert.equal(payment.method, 'bkash');

  // Opening 1500 + this bill's due 3525.
  assert.equal((await owner.get(`/suppliers/${ids.supplier}`)).body.supplier.currentPayable, '5025.00');
  assert.equal((await lastAudit('purchase.create')).new_values.purchaseNo, 'PUR-000002');
});

it('purchase detail and list show lines, payments and totals', async () => {
  const detail = (await owner.get(`/purchases/${ids.purchase}`)).body.purchase;
  assert.equal(detail.supplierName, 'Karim Traders');
  assert.deepEqual(detail.items.map((i) => [i.name, i.quantity, i.unitCost, i.lineTotal]), [
    ['USB Optical Mouse', 4, '230.00', '920.00'],
    ['A4 Paper 80gsm', 10, '460.50', '4605.00'],
  ]);
  assert.equal(detail.payments[0].voucherNo, 'SPAY-000001');

  const list = (await owner.get(`/purchases?supplierId=${ids.supplier}`)).body;
  assert.equal(list.total, 2);
  assert.equal(list.totalDue, '5025.00');
  assert.equal(list.items.find((p) => p.purchaseNo === 'PUR-000001').isOpeningBalance, true);
  assert.equal((await owner.get('/purchases?status=partial')).body.total, 1);
  assert.equal((await owner.get('/purchases/99999')).status, 404);
});

it('a bad purchase changes nothing: no stock, no bill, no number used', async () => {
  const snapshot = async () => ({
    paper: await stockOf(ids.paper),
    purchases: (await db.query('SELECT COUNT(*) AS n FROM purchases'))[0].n,
    counter: (await db.query("SELECT last_number FROM document_counters WHERE doc_type = 'purchase'"))[0].last_number,
    payable: (await db.query('SELECT current_payable FROM suppliers WHERE id = ?', [ids.supplier]))[0].current_payable,
  });
  const before = await snapshot();
  const line = { productId: ids.paper, quantity: 1, unitCost: '10' };
  const bad = [
    { supplierId: ids.supplier, items: [] },
    { supplierId: 99999, items: [line] },
    { supplierId: ids.supplier, items: [line, line] }, // same product twice
    { supplierId: ids.supplier, items: [line, { productId: 99999, quantity: 1, unitCost: '1' }] },
    { supplierId: ids.supplier, items: [line, { productId: ids.untracked, quantity: 1, unitCost: '1' }] },
    { supplierId: ids.supplier, items: [{ ...line, quantity: 0 }] },
    { supplierId: ids.supplier, items: [{ ...line, unitCost: '1.999' }] },
    { supplierId: ids.supplier, items: [line], paidAmount: '10.01' }, // paid more than the total
    { supplierId: ids.supplier, items: [line], paymentMethod: 'cheque' },
  ];
  for (const body of bad) assert.equal((await owner.post('/purchases', body)).status, 400, JSON.stringify(body));
  assert.deepEqual(await snapshot(), before);
});

it('an archived product or an inactive supplier cannot be purchased', async () => {
  await owner.put(`/products/${ids.paper}`, { status: 'archived' });
  assert.equal((await owner.post('/purchases', { supplierId: ids.supplier, items: [{ productId: ids.paper, quantity: 1, unitCost: '1' }] })).status, 400);
  await owner.put(`/products/${ids.paper}`, { status: 'active' });

  await owner.put(`/suppliers/${ids.supplier}`, { isActive: false });
  assert.equal((await owner.post('/purchases', { supplierId: ids.supplier, items: [{ productId: ids.paper, quantity: 1, unitCost: '1' }] })).status, 400);
  await owner.put(`/suppliers/${ids.supplier}`, { isActive: true });
});

it('ten purchases saved at the same moment get ten consecutive numbers and all their stock', async () => {
  const before = await stockOf(ids.paper);
  const results = await Promise.all(
    Array.from({ length: 10 }, () =>
      owner.post('/purchases', { supplierId: ids.supplier, items: [{ productId: ids.paper, quantity: 3, unitCost: '460.50' }, { productId: ids.mouseProduct, quantity: 1, unitCost: '230' }], paidAmount: '1611.50' }),
    ),
  );
  assert.ok(results.every((r) => r.status === 201), JSON.stringify(results.find((r) => r.status !== 201)?.body));
  const numbers = results.map((r) => r.body.purchase.purchaseNo).sort();
  assert.deepEqual(numbers, Array.from({ length: 10 }, (_, i) => `PUR-${String(i + 3).padStart(6, '0')}`));
  assert.equal(await stockOf(ids.paper), before + 30);
  // All ten were paid in full, so the payable is unchanged.
  assert.equal((await owner.get(`/suppliers/${ids.supplier}`)).body.supplier.currentPayable, '5025.00');
  assert.equal((await db.query('SELECT COUNT(DISTINCT voucher_no) AS n FROM supplier_payments'))[0].n, 11);
});

it('after everything above, the ledger adds up to the stock of every product', async () => {
  const res = await owner.get('/inventory/reconcile');
  assert.equal(res.status, 200);
  assert.ok(res.body.productsChecked >= 4);
  assert.deepEqual(res.body.differences, []);

  // If stock is ever changed behind the ledger's back, reconciliation reports it.
  await db.query('UPDATE products SET stock_qty = stock_qty + 7 WHERE id = ?', [ids.paper]);
  const broken = (await owner.get('/inventory/reconcile')).body.differences;
  assert.equal(broken.length, 1);
  assert.equal(broken[0].stockQty - broken[0].ledgerTotal, 7);
  await db.query('UPDATE products SET stock_qty = stock_qty - 7 WHERE id = ?', [ids.paper]);
});

// --- roles ------------------------------------------------------------------

it('staff can view the catalog and stock but cannot change anything, and never sees cost prices', async () => {
  for (const url of ['/categories', '/products', '/products/options', `/products/${ids.paper}`, '/services', '/inventory/movements', '/inventory/low-stock']) {
    assert.equal((await staff.get(url)).status, 200, url);
  }
  const list = await staff.get('/products');
  assert.ok(list.body.items.length > 0);
  assert.ok(list.body.items.every((p) => !('costPrice' in p)));
  assert.ok(!('costPrice' in (await staff.get(`/products/${ids.paper}`)).body.product));
  assert.ok((await staff.get('/products/options')).body.products.every((p) => !('costPrice' in p)));
  assert.ok((await staff.get('/inventory/movements')).body.items.every((m) => !('unitCost' in m)));

  const line = { productId: ids.paper, quantity: 1, unitCost: '1' };
  const denied = [
    ['post', '/categories', { name: 'Nope' }],
    ['put', `/categories/${ids.mouse}`, { name: 'Nope' }],
    ['post', '/products', { categoryId: ids.mouse, name: 'Nope', price: 1 }],
    ['put', `/products/${ids.paper}`, { price: '1.00' }],
    ['post', '/services', { serviceType: 'other', name: 'Nope', defaultPrice: 1 }],
    ['put', `/services/${ids.photocopy}`, { defaultPrice: '0.10' }],
    ['post', '/inventory/stock-in', { productId: ids.paper, quantity: 100 }],
    ['post', '/inventory/adjustments', { productId: ids.paper, direction: 'out', quantity: 1, note: 'Nope nope' }],
    ['post', '/suppliers', { name: 'Nope Traders' }],
    ['put', `/suppliers/${ids.supplier}`, { name: 'Nope Traders' }],
    ['post', `/suppliers/${ids.supplier}/opening-payable`, { amount: '5' }],
    ['post', '/purchases', { supplierId: ids.supplier, items: [line] }],
  ];
  for (const [method, url, body] of denied) assert.equal((await staff[method](url, body)).status, 403, `${method} ${url}`);
  for (const url of ['/suppliers', `/suppliers/${ids.supplier}`, '/purchases', `/purchases/${ids.purchase}`, '/inventory/reconcile']) {
    assert.equal((await staff.get(url)).status, 403, url);
  }
});

it('a user who may manage the catalog but not edit prices cannot change a price', async () => {
  await db.query("INSERT INTO roles (id, code, name) VALUES (3, 'stockkeeper', 'Stock keeper')");
  await db.query("INSERT INTO role_permissions (role_id, permission) VALUES (3, 'catalog.view'), (3, 'catalog.manage')");
  const { hashSecret } = require('../src/lib/crypto');
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (3, 'Keeper', 'keeper', ?)", [await hashSecret('keeper-password-1')]);
  const keeper = app.client();
  await keeper.post('/auth/login', { username: 'keeper', password: 'keeper-password-1' });

  assert.equal((await keeper.put(`/products/${ids.paper}`, { note: 'Shelf B' })).status, 200);
  assert.equal((await keeper.put(`/products/${ids.paper}`, { price: '1.00' })).status, 403);
  assert.equal((await keeper.put(`/products/${ids.paper}`, { costPrice: '1.00' })).status, 403);
  assert.equal((await db.query('SELECT price FROM products WHERE id = ?', [ids.paper]))[0].price, '520.00');
});

it('nothing here works without a session, or with a customer session', async () => {
  const anon = app.client();
  for (const url of ['/categories', '/products', '/services', '/inventory/movements', '/suppliers', '/purchases']) assert.equal((await anon.get(url)).status, 401, url);
  assert.equal((await anon.post('/products', { categoryId: ids.mouse, name: 'X', price: 1 })).status, 401);

  const { hashSecret } = require('../src/lib/crypto');
  await db.query("INSERT INTO customers (name, phone, portal_pin, portal_password_hash, created_by) VALUES ('Karim', '01712345678', '482913', ?, 1)", [await hashSecret('482913')]);
  const customer = app.client();
  assert.equal((await customer.post('/portal/login', { phone: '01712345678', pin: '482913' })).status, 200);
  for (const url of ['/products', '/suppliers', '/purchases', '/inventory/movements']) assert.equal((await customer.get(url)).status, 401, url);
});

const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };
const STAFF2 = { username: 'karim', password: 'staff-password-2' };

let app;
let db;
let owner;
let staff;
let staff2;
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
  await db.query("INSERT INTO users (role_id, name, username, password_hash, commission_enabled) VALUES (2, 'Rahim', ?, ?, 1)", [STAFF.username, await hashSecret(STAFF.password)]);
  // A staff member on a salary: records sales, earns no commission.
  await db.query("INSERT INTO users (role_id, name, username, password_hash, commission_enabled) VALUES (2, 'Karim', ?, ?, 0)", [STAFF2.username, await hashSecret(STAFF2.password)]);
  owner = app.client();
  staff = app.client();
  staff2 = app.client();
  await owner.post('/auth/login', OWNER);
  await staff.post('/auth/login', STAFF);
  await staff2.post('/auth/login', STAFF2);
  ids.rahim = (await db.query("SELECT id FROM users WHERE username = 'rahim'"))[0].id;
  ids.karim = (await db.query("SELECT id FROM users WHERE username = 'karim'"))[0].id;
  await openCashDay(owner);
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const key = () => crypto.randomUUID();
const sell = (client, body) => client.post('/sales', { idempotencyKey: key(), ...body });
const mine = async () => (await staff.get('/commission/me')).body;
const cash = (amount) => [{ method: 'cash', amount }];

// --- migration 005 ----------------------------------------------------------

it('migration 005 can be run again without changing anything', async () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'migrations', '005_commission_cash_day_recovery.sql'), 'utf8');
  const conn = await require('mysql2/promise').createConnection({ host: process.env.DB_HOST, port: Number(process.env.DB_PORT), user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, multipleStatements: true });
  try {
    await conn.query(sql);
    await conn.query(sql);
  } finally {
    await conn.end();
  }
  // Re-running it does not switch commission back on for someone it was switched off for.
  assert.equal((await db.query('SELECT commission_enabled FROM users WHERE id = ?', [ids.karim]))[0].commission_enabled, 0);
  const staffPermissions = (await db.query('SELECT permission FROM role_permissions WHERE role_id = 2')).map((r) => r.permission);
  for (const p of ['cash.open', 'cash.close', 'commission.view_own']) assert.ok(staffPermissions.includes(p), p);
  for (const p of ['cash.receive', 'commission.manage', 'customers.opening_due']) assert.ok(!staffPermissions.includes(p), p);
});

// --- rates ------------------------------------------------------------------

it('the Owner sets rates on services and categories; a sub-category without one uses its parent', async () => {
  const bad = await owner.post('/services', { serviceType: 'photocopy', name: 'Bad', defaultPrice: 2, commissionType: 'percent', commissionValue: '101' });
  assert.equal(bad.status, 400);
  assert.ok(bad.body.error.details.fields.commissionValue);
  assert.equal((await owner.post('/services', { serviceType: 'photocopy', name: 'Bad', defaultPrice: 2, commissionType: 'fixed', commissionValue: '0' })).status, 400);
  assert.equal((await staff.post('/services', { serviceType: 'photocopy', name: 'Mine', defaultPrice: 2, commissionType: 'fixed', commissionValue: '1' })).status, 403);

  // Photocopy: 0.50 a page. Typing: 20% of the price. Scanning: no commission.
  const copy = (await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4', unit: 'page', defaultPrice: 2, commissionType: 'fixed', commissionValue: '0.50' })).body.service;
  assert.deepEqual([copy.commissionType, copy.commissionValue], ['fixed', '0.50']);
  ids.copy = copy.id;
  ids.typing = (await owner.post('/services', { serviceType: 'other', name: 'Typing', unit: 'page', defaultPrice: 50, commissionType: 'percent', commissionValue: '20' })).body.service.id;
  ids.scan = (await owner.post('/services', { serviceType: 'other', name: 'Scanning', unit: 'page', defaultPrice: 10 })).body.service.id;

  // Stationery: 5% on everything in it, including the Pens sub-category. Gadgets: none.
  const stationery = (await owner.post('/categories', { name: 'Stationery', commissionType: 'percent', commissionValue: '5' })).body.category;
  assert.deepEqual([stationery.commissionType, stationery.commissionValue], ['percent', '5.00']);
  const pens = (await owner.post('/categories', { name: 'Pens', parentId: stationery.id })).body.category;
  const gadgets = (await owner.post('/categories', { name: 'Gadgets' })).body.category;
  ids.stationery = stationery.id;
  ids.paper = (await owner.post('/products', { categoryId: stationery.id, sku: 'PAPER', name: 'A4 Paper', price: 500, costPrice: 450, openingStock: 50 })).body.product.id;
  ids.pen = (await owner.post('/products', { categoryId: pens.id, sku: 'PEN', name: 'Ball Pen', price: 10, costPrice: 7, openingStock: 500 })).body.product.id;
  ids.mouse = (await owner.post('/products', { categoryId: gadgets.id, sku: 'MOUSE', name: 'USB Mouse', price: 400, costPrice: 300, openingStock: 20 })).body.product.id;

  // Editing: switching the rate off clears its value.
  const off = (await owner.put(`/services/${ids.scan}`, { commissionType: 'fixed', commissionValue: '1' })).body.service;
  assert.deepEqual([off.commissionType, off.commissionValue], ['fixed', '1.00']);
  const cleared = (await owner.put(`/services/${ids.scan}`, { commissionType: null })).body.service;
  assert.deepEqual([cleared.commissionType, cleared.commissionValue], [null, '0.00']);
  assert.equal((await owner.put(`/categories/${gadgets.id}`, { commissionType: 'percent', commissionValue: '150' })).status, 400);
  const log = (await db.query("SELECT action FROM audit_logs WHERE entity_type = 'service' AND entity_id = ? ORDER BY id DESC LIMIT 1", [ids.scan]))[0];
  assert.equal(log.action, 'service.rate_change');
});

// --- earning ----------------------------------------------------------------

it("a staff member's sale earns commission line by line, after the discount, and they see it in their account", async () => {
  // 100 copies (50.00 fixed) · typing 2 × 50 = 100 → 20% = 20.00 · paper 2 × 500 = 1000 → 5% · pens 10 × 10 = 100 → 5% · mouse: none · scan: none
  // Subtotal 1200 + 400 + 10 = 1610 + 200 (copies) = 1810, less a 181 discount (10%): every line is worth 90% of its price.
  const res = await sell(staff, {
    items: [
      { type: 'service', serviceId: ids.copy, quantity: 100 },
      { type: 'service', serviceId: ids.typing, quantity: 2 },
      { type: 'product', productId: ids.paper, quantity: 2 },
      { type: 'product', productId: ids.pen, quantity: 10 },
      { type: 'product', productId: ids.mouse, quantity: 1 },
      { type: 'service', serviceId: ids.scan, quantity: 1 },
    ],
    discountAmount: '181',
    payments: cash('1629'),
  });
  assert.equal(res.status, 201, JSON.stringify(res.body));
  // 50.00 (fixed is per copy, not cut by the discount) + 18.00 (20% of 90) + 45.00 (5% of 900) + 4.50 (5% of 90)
  assert.equal(res.body.sale.commission, '117.50');
  ids.sale1 = res.body.sale.id;
  const lines = await db.query('SELECT name_snapshot AS name, commission_amount AS c FROM sale_items WHERE sale_id = ? ORDER BY id', [ids.sale1]);
  assert.deepEqual(lines.map((l) => [l.name, l.c]), [['Photocopy A4', '50.00'], ['Typing', '18.00'], ['A4 Paper', '45.00'], ['Ball Pen', '4.50'], ['USB Mouse', '0.00'], ['Scanning', '0.00']]);

  const me = await mine();
  assert.deepEqual([me.user.name, me.balance, me.today.earned, me.today.paid, me.thisMonth.earned], ['Rahim', '117.50', '117.50', '0.00', '117.50']);
  assert.deepEqual(me.entries.items.map((e) => [e.type, e.amount, e.invoiceNo]), [['sale', '117.50', res.body.sale.invoiceNo]]);
  assert.deepEqual((await staff.get('/dashboard')).body.myCommission, { earnedToday: '117.50', balance: '117.50' });

  // Changing a rate later never changes what was already earned.
  await owner.put(`/services/${ids.copy}`, { commissionValue: '1' });
  assert.equal((await mine()).balance, '117.50');
  await owner.put(`/services/${ids.copy}`, { commissionValue: '0.50' });
});

it('the Owner and a staff member without commission earn nothing; staff see only their own account', async () => {
  const byOwner = await sell(owner, { items: [{ type: 'service', serviceId: ids.copy, quantity: 10 }], payments: cash('20') });
  const byKarim = await sell(staff2, { items: [{ type: 'service', serviceId: ids.copy, quantity: 10 }], payments: cash('20') });
  assert.deepEqual([byOwner.body.sale.commission, byKarim.body.sale.commission], ['0.00', '0.00']);
  assert.equal((await owner.get('/commission/me')).status, 403);
  assert.equal((await staff.get('/commission/staff')).status, 403);
  assert.equal((await staff.get(`/commission/staff/${ids.karim}`)).status, 403);
  assert.equal((await staff.post('/commission/payouts', { idempotencyKey: key(), userId: ids.rahim, amount: '1' })).status, 403);
  assert.equal((await mine()).balance, '117.50');
});

it('a return takes back the commission on the units returned, to the paisa; a void takes back the rest', async () => {
  const sale = await sell(staff, { items: [{ type: 'product', productId: ids.pen, quantity: 3 }], payments: cash('30') });
  // 5% of 30.00 = 1.50
  assert.equal(sale.body.sale.commission, '1.50');
  const item = (await owner.get(`/sales/${sale.body.sale.id}`)).body.sale.items[0].id;
  for (let i = 0; i < 3; i += 1) {
    assert.equal((await owner.post(`/sales/${sale.body.sale.id}/returns`, { idempotencyKey: key(), reason: 'Ink dried', items: [{ saleItemId: item, quantity: 1 }] })).status, 201);
  }
  const entries = (await mine()).entries.items.filter((e) => e.saleId === sale.body.sale.id);
  assert.deepEqual(entries.map((e) => [e.type, e.amount]), [['sale_return', '-0.50'], ['sale_return', '-0.50'], ['sale_return', '-0.50'], ['sale', '1.50']]);
  assert.ok(entries[0].returnNo);

  // A sale voided by the Owner: Rahim's 117.50 from the first bill goes.
  assert.equal((await owner.post(`/sales/${ids.sale1}/void`, { reason: 'Entered twice', voidPayments: true })).status, 200);
  const me = await mine();
  assert.equal(me.balance, '0.00');
  assert.equal(me.today.earned, '0.00');
});

it('the Owner pays commission: never more than is owed, cash comes out of the drawer, and a void puts it back', async () => {
  const sale = await sell(staff, { items: [{ type: 'product', productId: ids.paper, quantity: 4 }], payments: cash('2000') });
  assert.equal(sale.body.sale.commission, '100.00');

  const list = (await owner.get('/commission/staff')).body.staff;
  assert.deepEqual(list.map((s) => [s.name, s.balance, s.commissionEnabled]), [['Rahim', '100.00', true]]);
  const tooMuch = await owner.post('/commission/payouts', { idempotencyKey: key(), userId: ids.rahim, amount: '100.01' });
  assert.equal(tooMuch.status, 400);
  assert.match(tooMuch.body.error.details.fields.amount, /100\.00/);

  const before = (await owner.get('/cash-register/current')).body;
  const body = { idempotencyKey: key(), userId: ids.rahim, amount: '60', note: 'This week' };
  const paid = await owner.post('/commission/payouts', body);
  assert.equal(paid.status, 201);
  assert.equal(paid.body.payout.balanceAfter, '40.00');
  // Saved twice: stored once.
  assert.equal((await owner.post('/commission/payouts', body)).body.duplicate, true);
  ids.payout = paid.body.payout.id;
  // By bKash: not from the drawer.
  assert.equal((await owner.post('/commission/payouts', { idempotencyKey: key(), userId: ids.rahim, amount: '10', method: 'bkash' })).status, 201);

  const after = (await owner.get('/cash-register/current')).body;
  assert.equal(after.cashCommissionPaid, '60.00');
  assert.equal((Number(before.expectedCash) - Number(after.expectedCash)).toFixed(2), '60.00');
  const me = await mine();
  assert.deepEqual([me.balance, me.today.paid, me.payouts.length], ['30.00', '70.00', 2]);
  // The hand-over shows who earned what today.
  // Rahim's standing bills today: the pens (all returned) and the paper; the first bill was voided.
  const rahim = after.byStaff.find((s) => s.name === 'Rahim');
  assert.deepEqual([rahim.bills, rahim.commission], [2, '100.00']);

  assert.equal((await owner.post(`/commission/payouts/${ids.payout}/void`, { reason: 'Wrong amount' })).status, 200);
  assert.equal((await owner.post(`/commission/payouts/${ids.payout}/void`, { reason: 'Wrong amount' })).status, 409);
  assert.equal((await mine()).balance, '90.00');
  assert.equal((await owner.get('/cash-register/current')).body.cashCommissionPaid, '0.00');
});

it('profit and loss takes commission off as a cost of the sales that earned it', async () => {
  const today = (await owner.get('/dashboard')).body.date;
  const r = (await owner.get(`/reports/profit-loss?from=${today}&to=${today}`)).body;
  const amount = (label) => r.rows.find((x) => x.label === label).amount;
  // Earned on sales still standing: 100.00 on the paper bill (the pen bill was fully returned, the first bill voided).
  assert.equal(amount('Staff commission'), '-100.00');
  const d = (await owner.get('/dashboard')).body.profit;
  assert.equal(d.commission, '100.00');
  assert.equal(d.netProfit, (Number(d.grossProfit) - 100 - Number(d.expenses)).toFixed(2));
});

it('the Owner switches commission off for someone; their later sales earn nothing, their balance stays', async () => {
  assert.equal((await owner.put(`/users/${ids.rahim}`, { commissionEnabled: false })).body.user.commissionEnabled, false);
  const sale = await sell(staff, { items: [{ type: 'product', productId: ids.paper, quantity: 1 }], payments: cash('500') });
  assert.equal(sale.body.sale.commission, '0.00');
  assert.equal((await mine()).balance, '90.00');
  await owner.put(`/users/${ids.rahim}`, { commissionEnabled: true });
  // A new staff account earns by default; a new Owner does not.
  const users = (await owner.get('/users')).body.users;
  assert.deepEqual(users.map((u) => [u.username, u.commissionEnabled]), [['owner', false], ['rahim', true], ['karim', false]]);
  const created = await owner.post('/users', { name: 'Sumi Akter', username: 'sumi', password: 'first-password-1', role: 'staff' });
  assert.equal(created.body.user.commissionEnabled, true);
});

// --- Owner recovery codes ---------------------------------------------------

it('an Owner makes recovery codes with their password; staff cannot', async () => {
  assert.equal((await staff.post('/auth/recovery-codes', { currentPassword: STAFF.password })).status, 403);
  const wrong = await owner.post('/auth/recovery-codes', { currentPassword: 'not-my-password' });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.body.error.details.fields.currentPassword);
  assert.deepEqual((await owner.get('/auth/recovery-codes')).body, { total: 0, unused: 0, createdAt: null });

  const first = (await owner.post('/auth/recovery-codes', { currentPassword: OWNER.password })).body.codes;
  const res = await owner.post('/auth/recovery-codes', { currentPassword: OWNER.password });
  assert.equal(res.status, 201);
  ids.codes = res.body.codes;
  assert.equal(ids.codes.length, 10);
  assert.equal(new Set(ids.codes).size, 10);
  // A new set replaces the old one.
  assert.equal((await app.client().post('/auth/recover', { username: 'owner', code: first[0], newPassword: 'never-used-1' })).status, 400);
  const status = (await owner.get('/auth/recovery-codes')).body;
  assert.deepEqual([status.total, status.unused], [10, 10]);
  // Only hashes are stored.
  const stored = await db.query('SELECT code_hash FROM owner_recovery_codes');
  assert.ok(stored.every((r) => !ids.codes.some((c) => r.code_hash.includes(c.replace('-', '')))));
});

it('a recovery code sets a new password once, ends every session, and works for nobody but that Owner', async () => {
  const visitor = app.client();
  const code = ids.codes[0];
  assert.equal((await visitor.post('/auth/recover', { username: 'rahim', code, newPassword: 'taken-over-1' })).status, 400);
  assert.equal((await visitor.post('/auth/recover', { username: 'owner', code: 'AAAAA-AAAAA', newPassword: 'taken-over-1' })).status, 400);
  assert.equal((await visitor.post('/auth/recover', { username: 'owner', code, newPassword: 'short' })).status, 400);

  // Typed in lower case with a space: still the same code.
  const ok = await visitor.post('/auth/recover', { username: 'owner', code: code.toLowerCase().replace('-', ' '), newPassword: 'brand-new-password-1' });
  assert.equal(ok.status, 200);
  assert.equal((await owner.get('/auth/me')).status, 401);
  assert.equal((await app.client().post('/auth/login', OWNER)).status, 401);
  assert.equal((await owner.post('/auth/login', { username: 'owner', password: 'brand-new-password-1' })).status, 200);
  // Used once, never again.
  assert.equal((await visitor.post('/auth/recover', { username: 'owner', code, newPassword: 'another-password-1' })).status, 400);
  assert.equal((await owner.get('/auth/recovery-codes')).body.unused, 9);
  const log = await db.query("SELECT actor_user_id FROM audit_logs WHERE action = 'user.recover_password'");
  assert.equal(log.length, 1);
});

it('guessing recovery codes is locked out like guessing passwords', async () => {
  await db.query('DELETE FROM login_attempts');
  const visitor = app.client();
  for (let i = 0; i < 5; i += 1) assert.equal((await visitor.post('/auth/recover', { username: 'owner', code: `WRONG-${i}AAAA`, newPassword: 'guessing-pass-1' })).status, 400);
  const locked = await visitor.post('/auth/recover', { username: 'owner', code: ids.codes[1], newPassword: 'guessing-pass-1' });
  assert.equal(locked.status, 429);
});

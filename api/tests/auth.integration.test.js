const { resetDatabase, runSeeds, startApp } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };
const CUSTOMER = { phone: '01712345678', pin: '482913' };

let app;
let db;
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
  await db.query("INSERT INTO customers (name, phone, portal_pin, portal_password_hash, current_due, created_by) VALUES ('Karim', ?, ?, ?, 230.00, 1)", [
    CUSTOMER.phone,
    CUSTOMER.pin,
    await hashSecret(CUSTOMER.pin),
  ]);
  await db.query("INSERT INTO customers (name, phone, portal_pin, portal_password_hash, created_by) VALUES ('Other', '01812345678', '111222', ?, 1)", [await hashSecret('111222')]);
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const clearAttempts = () => db.query('DELETE FROM login_attempts');

// --- schema -----------------------------------------------------------------

it('migration creates every table in DATABASE_SCHEMA.md', async () => {
  const rows = await db.query('SELECT table_name AS t FROM information_schema.tables WHERE table_schema = DATABASE()');
  const tables = rows.map((r) => r.t).sort();
  assert.deepEqual(tables, [
    'audit_logs', 'categories', 'commission_payouts', 'customer_advance_movements', 'customer_sessions', 'customers', 'daily_cash_closings', 'daily_cash_openings',
    'document_counters', 'expense_categories', 'expenses', 'inventory_movements', 'login_attempts', 'owner_cash_receipts', 'owner_password_otps', 'owner_recovery_codes',
    'payment_allocations', 'payments', 'products', 'purchase_items', 'purchases', 'role_permissions', 'roles', 'sale_items', 'sale_return_items',
    'sale_returns', 'sales', 'services', 'sessions', 'settings', 'staff_commission_entries', 'staff_commission_rates', 'supplier_payment_allocations', 'supplier_payments', 'suppliers', 'users',
  ]);
});

it('seed is repeatable and loads roles, settings, categories and counters', async () => {
  await db.query("UPDATE settings SET value = '\"My Shop\"' WHERE setting_key = 'shop.name'");
  await runSeeds();
  await runSeeds();
  // A value the Owner changed is not overwritten by re-seeding.
  const [name] = await db.query("SELECT value FROM settings WHERE setting_key = 'shop.name'");
  assert.equal(name.value, 'My Shop');
  const [roles] = await db.query('SELECT COUNT(*) AS n FROM roles');
  const [settings] = await db.query('SELECT COUNT(*) AS n FROM settings');
  const [counters] = await db.query('SELECT COUNT(*) AS n FROM document_counters');
  const [cats] = await db.query('SELECT COUNT(*) AS n FROM expense_categories');
  assert.equal(roles.n, 2);
  assert.equal(settings.n, 14);
  assert.equal(counters.n, 7); // six document types and the cash drawer lock row
  assert.equal(cats.n, 7);
});

it('database constraints reject impossible rows', async () => {
  await db.query("INSERT INTO categories (id, name) VALUES (1, 'Accessories')");
  await assert.rejects(db.query("INSERT INTO products (category_id, sku, name, price, stock_qty) VALUES (1, 'X1', 'Mouse', 100, -1)"), /ck_products_stock/);
  // A sale with a due and no customer.
  await assert.rejects(
    db.query(
      `INSERT INTO sales (invoice_no, sale_date, subtotal, total_amount, paid_amount, due_amount, payment_status, idempotency_key, created_by)
       VALUES ('INV-T1', UTC_TIMESTAMP(), 100, 100, 40, 60, 'partial', UUID(), 1)`,
    ),
    /ck_sales_due_needs_customer/,
  );
  // due_amount that does not equal total − paid.
  await assert.rejects(
    db.query(
      `INSERT INTO sales (invoice_no, customer_id, sale_date, subtotal, total_amount, paid_amount, due_amount, payment_status, idempotency_key, created_by)
       VALUES ('INV-T2', 1, UTC_TIMESTAMP(), 100, 100, 40, 10, 'partial', UUID(), 1)`,
    ),
    /ck_sales_due/,
  );
});

it('a bKash transaction ID can be active only once, and is freed when the payment is voided', async () => {
  const insert = (key) =>
    db.query(
      `INSERT INTO payments (receipt_no, payment_date, method, amount, reference, idempotency_key, created_by)
       VALUES (?, UTC_TIMESTAMP(), 'bkash', 100, '9XK2ABCD41', UUID(), 1)`,
      [key],
    );
  await insert('RCP-T1');
  await assert.rejects(insert('RCP-T2'), /uq_payments_active_ref/);
  await db.query("UPDATE payments SET status = 'void' WHERE receipt_no = 'RCP-T1'");
  await insert('RCP-T3');
});

// --- staff login ------------------------------------------------------------

it('health reports the database', async () => {
  const res = await app.client().get('/health');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'ok', database: 'ok' });
});

it('everything except login and health needs a session', async () => {
  const c = app.client();
  for (const url of ['/auth/me', '/users', '/roles', '/portal/me']) assert.equal((await c.get(url)).status, 401, url);
});

it('owner logs in, gets an HttpOnly SameSite cookie, and sees their permissions', async () => {
  const c = app.client();
  const res = await c.post('/auth/login', OWNER);
  assert.equal(res.status, 200);
  assert.match(res.setCookie[0], /^ssctc_sid=[\w-]{43};/);
  assert.match(res.setCookie[0], /HttpOnly/);
  assert.match(res.setCookie[0], /SameSite=Lax/);

  const me = await c.get('/auth/me');
  assert.equal(me.body.user.username, 'owner');
  assert.equal(me.body.user.role.code, 'owner');
  assert.ok(me.body.user.permissions.includes('users.manage'));
  assert.equal(me.body.user.password_hash, undefined);

  // Only the hash of the token is stored.
  const [row] = await db.query('SELECT token_hash FROM sessions ORDER BY id DESC LIMIT 1');
  assert.notEqual(row.token_hash, c.jar.get('ssctc_sid'));
});

it('the username is not case-sensitive; a wrong password and an unknown user get the same answer', async () => {
  await clearAttempts();
  assert.equal((await app.client().post('/auth/login', { username: 'OWNER', password: OWNER.password })).status, 200);
  const wrong = await app.client().post('/auth/login', { username: 'owner', password: 'nope' });
  const unknown = await app.client().post('/auth/login', { username: 'nobody', password: 'nope' });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  await clearAttempts();
});

it('staff is refused owner-only endpoints; owner is allowed', async () => {
  const staff = app.client();
  await staff.post('/auth/login', STAFF);
  assert.equal((await staff.get('/users')).status, 403);
  assert.equal((await staff.post('/users', { name: 'X Y', username: 'xy1', password: 'long-enough-1', role: 'owner' })).status, 403);

  const owner = app.client();
  await owner.post('/auth/login', OWNER);
  const list = await owner.get('/users');
  assert.equal(list.status, 200);
  assert.equal(list.body.users.length, 2);
  assert.equal(list.body.users[0].password_hash, undefined);
});

it('owner creates a staff account; the action is audited; duplicates are refused', async () => {
  const owner = app.client();
  await owner.post('/auth/login', OWNER);
  const body = { name: 'Salma Begum', username: 'Salma', password: 'salma-password-1', role: 'staff' };
  const created = await owner.post('/users', body);
  assert.equal(created.status, 201);
  assert.equal(created.body.user.username, 'salma');
  assert.equal((await owner.post('/users', body)).status, 409);

  const [log] = await db.query("SELECT actor_user_id, new_values FROM audit_logs WHERE action = 'user.create' ORDER BY id DESC LIMIT 1");
  assert.equal(log.actor_user_id, 1);
  assert.equal(log.new_values.username, 'salma');
  assert.equal(JSON.stringify(log.new_values).includes('password'), false);

  // The new account works and is told to change its password.
  const salma = app.client();
  await salma.post('/auth/login', { username: 'salma', password: body.password });
  assert.equal((await salma.get('/auth/me')).body.user.mustChangePassword, true);
});

it('logout ends the session on the server, not just in the browser', async () => {
  const c = app.client();
  await c.post('/auth/login', OWNER);
  const token = c.jar.get('ssctc_sid');
  assert.equal((await c.post('/auth/logout')).status, 200);
  assert.equal(c.jar.has('ssctc_sid'), false);
  assert.equal((await app.client().get('/auth/me', { Cookie: `ssctc_sid=${token}` })).status, 401);
});

it('a session idle for longer than the limit, or past its expiry, stops working', async () => {
  const c = app.client();
  await c.post('/auth/login', STAFF);
  await db.query('UPDATE sessions SET last_seen_at = UTC_TIMESTAMP() - INTERVAL 121 MINUTE ORDER BY id DESC LIMIT 1');
  assert.equal((await c.get('/auth/me')).status, 401);

  const d = app.client();
  await d.post('/auth/login', STAFF);
  await db.query('UPDATE sessions SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND ORDER BY id DESC LIMIT 1');
  assert.equal((await d.get('/auth/me')).status, 401);
});

it('a blocked user cannot log in and loses existing sessions', async () => {
  const c = app.client();
  await c.post('/auth/login', STAFF);
  await db.query("UPDATE users SET status = 'blocked' WHERE username = ?", [STAFF.username]);
  assert.equal((await c.get('/auth/me')).status, 401);
  assert.equal((await app.client().post('/auth/login', STAFF)).status, 401);
  await db.query("UPDATE users SET status = 'active' WHERE username = ?", [STAFF.username]);
  await clearAttempts();
});

it('five wrong passwords lock the account, even for the right password', async () => {
  await clearAttempts();
  for (let i = 0; i < 5; i++) assert.equal((await app.client().post('/auth/login', { ...STAFF, password: 'wrong' })).status, 401);
  const locked = await app.client().post('/auth/login', STAFF);
  assert.equal(locked.status, 429);
  // The lock is per account: another account from another address is unaffected.
  await db.query("UPDATE login_attempts SET ip = '203.0.113.9'");
  assert.equal((await app.client().post('/auth/login', OWNER)).status, 200);
  // It lifts once the failures are older than the window.
  await db.query('UPDATE login_attempts SET created_at = created_at - INTERVAL 16 MINUTE');
  assert.equal((await app.client().post('/auth/login', STAFF)).status, 200);
  await clearAttempts();
});

it('twenty failures from one address block that address', async () => {
  await clearAttempts();
  for (let i = 0; i < 20; i++) await app.client().post('/auth/login', { username: `ghost${i}`, password: 'wrong' });
  assert.equal((await app.client().post('/auth/login', OWNER)).status, 429);
  await clearAttempts();
});

it('changing the password needs the current one, enforces length, and logs out other devices', async () => {
  const a = app.client();
  const b = app.client();
  await a.post('/auth/login', STAFF);
  await b.post('/auth/login', STAFF);

  assert.equal((await a.post('/auth/change-password', { currentPassword: 'wrong', newPassword: 'brand-new-pass-1' })).status, 400);
  assert.equal((await a.post('/auth/change-password', { currentPassword: STAFF.password, newPassword: 'short' })).status, 400);
  assert.equal((await a.post('/auth/change-password', { currentPassword: STAFF.password, newPassword: 'brand-new-pass-1' })).status, 200);

  assert.equal((await a.get('/auth/me')).status, 200);
  assert.equal((await b.get('/auth/me')).status, 401);
  assert.equal((await app.client().post('/auth/login', STAFF)).status, 401);
  assert.equal((await app.client().post('/auth/login', { ...STAFF, password: 'brand-new-pass-1' })).status, 200);
  await clearAttempts();
});

// --- request hardening ------------------------------------------------------

it('state-changing requests from another origin are refused', async () => {
  const res = await app.client().post('/auth/login', OWNER, { Origin: 'https://evil.example' });
  assert.equal(res.status, 403);
  assert.equal(res.setCookie.length, 0);
});

it('unknown fields, non-JSON bodies and broken JSON are rejected', async () => {
  assert.equal((await app.client().post('/auth/login', { ...OWNER, admin: true })).status, 400);
  const form = await fetch(`${app.base}/auth/login`, { method: 'POST', headers: { Origin: 'http://shop.test', 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'username=owner&password=x' });
  assert.equal(form.status, 400);
  const broken = await fetch(`${app.base}/auth/login`, { method: 'POST', headers: { Origin: 'http://shop.test', 'Content-Type': 'application/json' }, body: '{"username":' });
  assert.equal(broken.status, 400);
});

it('SQL injection attempts in the login fields are treated as plain text', async () => {
  await clearAttempts();
  const res = await app.client().post('/auth/login', { username: "owner' OR '1'='1", password: "' OR '1'='1" });
  assert.equal(res.status, 401);
  const [count] = await db.query('SELECT COUNT(*) AS n FROM users');
  assert.equal(count.n, 3);
  await clearAttempts();
});

it('responses are never cacheable and carry security headers', async () => {
  const res = await fetch(`${app.base}/health`);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-powered-by'), null);
});

// --- customer portal --------------------------------------------------------

it('customer logs in with mobile number + PIN, in any common number format', async () => {
  await clearAttempts();
  for (const phone of ['01712345678', '+880 1712-345678', '8801712345678']) {
    const c = app.client();
    const res = await c.post('/portal/login', { phone, pin: CUSTOMER.pin });
    assert.equal(res.status, 200, phone);
    assert.match(res.setCookie[0], /^ssctc_cid=/);
    const me = await c.get('/portal/me');
    assert.deepEqual(me.body.customer, { id: 1, name: 'Karim', phone: '01712345678', currentDue: '230.00', advanceBalance: '0.00', shouldChangePin: true });
  }
});

it('a wrong PIN, an unknown number and a malformed number get the same answer', async () => {
  await clearAttempts();
  const wrong = await app.client().post('/portal/login', { phone: CUSTOMER.phone, pin: '000000' });
  const unknown = await app.client().post('/portal/login', { phone: '01999999999', pin: CUSTOMER.pin });
  const malformed = await app.client().post('/portal/login', { phone: 'hello', pin: CUSTOMER.pin });
  assert.equal(wrong.status, 401);
  assert.deepEqual(wrong.body, unknown.body);
  assert.deepEqual(wrong.body, malformed.body);
  await clearAttempts();
});

it('five wrong PINs lock that mobile number', async () => {
  await clearAttempts();
  for (let i = 0; i < 5; i++) await app.client().post('/portal/login', { phone: CUSTOMER.phone, pin: `00000${i}` });
  assert.equal((await app.client().post('/portal/login', CUSTOMER)).status, 429);
  await clearAttempts();
});

it('customer and staff sessions never work on each other’s endpoints', async () => {
  const customer = app.client();
  await customer.post('/portal/login', CUSTOMER);
  for (const url of ['/auth/me', '/users', '/roles']) assert.equal((await customer.get(url)).status, 401, url);
  // A customer token presented as a staff cookie is not a staff session.
  assert.equal((await app.client().get('/users', { Cookie: `ssctc_sid=${customer.jar.get('ssctc_cid')}` })).status, 401);

  const owner = app.client();
  await owner.post('/auth/login', OWNER);
  assert.equal((await owner.get('/portal/me')).status, 401);
  assert.equal((await app.client().get('/portal/me', { Cookie: `ssctc_cid=${owner.jar.get('ssctc_sid')}` })).status, 401);
});

it('a customer with the portal disabled, or deactivated, cannot log in or keep a session', async () => {
  const c = app.client();
  await c.post('/portal/login', CUSTOMER);
  await db.query('UPDATE customers SET portal_enabled = 0 WHERE id = 1');
  assert.equal((await c.get('/portal/me')).status, 401);
  assert.equal((await app.client().post('/portal/login', CUSTOMER)).status, 401);
  await db.query('UPDATE customers SET portal_enabled = 1, is_active = 0 WHERE id = 1');
  assert.equal((await app.client().post('/portal/login', CUSTOMER)).status, 401);
  await db.query('UPDATE customers SET is_active = 1 WHERE id = 1');
  await clearAttempts();
});

it('customer changes their PIN: the readable copy is erased and other devices are logged out', async () => {
  const a = app.client();
  const b = app.client();
  await a.post('/portal/login', CUSTOMER);
  await b.post('/portal/login', CUSTOMER);

  assert.equal((await a.post('/portal/change-pin', { currentPin: '999999', newPin: '739105' })).status, 400);
  assert.equal((await a.post('/portal/change-pin', { currentPin: CUSTOMER.pin, newPin: '123456' })).status, 400);
  assert.equal((await a.post('/portal/change-pin', { currentPin: CUSTOMER.pin, newPin: '739105' })).status, 200);

  const [row] = await db.query('SELECT portal_pin, portal_password_hash FROM customers WHERE id = 1');
  assert.equal(row.portal_pin, null);
  assert.match(row.portal_password_hash, /^\$2[aby]\$/);

  assert.equal((await a.get('/portal/me')).body.customer.shouldChangePin, false);
  assert.equal((await b.get('/portal/me')).status, 401);
  assert.equal((await app.client().post('/portal/login', CUSTOMER)).status, 401);
  assert.equal((await app.client().post('/portal/login', { phone: CUSTOMER.phone, pin: '739105' })).status, 200);

  // The other customer is untouched.
  const [other] = await db.query('SELECT portal_pin FROM customers WHERE id = 2');
  assert.equal(other.portal_pin, '111222');
  await clearAttempts();
});

it('portal logout removes the session', async () => {
  const c = app.client();
  await c.post('/portal/login', { phone: CUSTOMER.phone, pin: '739105' });
  const token = c.jar.get('ssctc_cid');
  assert.equal((await c.post('/portal/logout')).status, 200);
  assert.equal((await app.client().get('/portal/me', { Cookie: `ssctc_cid=${token}` })).status, 401);
});

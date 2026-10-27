const { resetDatabase, startApp, openCashDay } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { execFileSync, spawnSync } = require('node:child_process');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };
const RESTORE_DB = 'ssctc_shop_restore_test';
// Text that breaks naive dumps: quotes, a backslash, a newline, Bangla, an emoji,
// and U+2028, which some line readers take for a line break.
const AWKWARD = 'O\'Brien "Boss" \\ back\nnew line করিম 😀 a b';

let app;
let db;
let owner;
let staff;
let skipReason = false;
const ids = {};
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ssctc-backup-test-'));
const key = () => crypto.randomUUID();
const script = (name) => path.join(__dirname, '..', 'scripts', name);

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
  await db.query(`DROP DATABASE IF EXISTS \`${RESTORE_DB}\``);

  // A little of everything, so every table has rows.
  const category = (await owner.post('/categories', { name: 'Gadgets' })).body.category.id;
  ids.mouse = (await owner.post('/products', { categoryId: category, sku: 'MOUSE', name: 'USB Mouse', price: 500, costPrice: 300, openingStock: 20 })).body.product.id;
  const copy = (await owner.post('/services', { serviceType: 'photocopy', name: 'Photocopy A4', unit: 'page', defaultPrice: 2 })).body.service.id;
  ids.customer = (await owner.post('/customers', { name: 'Karim Mia', phone: '01711111111', note: AWKWARD.replace(/\n/g, ' ') })).body.customer.id;
  const supplier = (await owner.post('/suppliers', { name: 'Hasan Traders' })).body.supplier.id;
  await owner.post('/purchases', { idempotencyKey: key(), supplierId: supplier, items: [{ productId: ids.mouse, quantity: 5, unitCost: '300' }], paidAmount: '500' });
  const sale = (await owner.post('/sales', { idempotencyKey: key(), customerId: ids.customer, note: AWKWARD, items: [{ type: 'product', productId: ids.mouse, quantity: 2 }, { type: 'service', serviceId: copy, quantity: 10 }], payments: [{ method: 'cash', amount: 400 }] })).body.sale.id;
  const line = (await owner.get(`/sales/${sale}`)).body.sale.items[0].id;
  await owner.post(`/sales/${sale}/returns`, { idempotencyKey: key(), reason: 'Faulty', items: [{ saleItemId: line, quantity: 1 }] });
  await owner.post('/payments', { idempotencyKey: key(), customerId: ids.customer, amount: 50, method: 'bkash', reference: 'TRX1', verified: true });
  await owner.post(`/customers/${ids.customer}/advance-deposit`, { idempotencyKey: key(), amount: 200 });
  const tea = (await owner.get('/expense-categories')).body.categories[0].id;
  await owner.post('/expenses', { idempotencyKey: key(), categoryId: tea, title: 'Tea', amount: 50 });
  const expected = (await owner.get('/cash-register/current')).body.expectedCash;
  await owner.post('/cash-register/close', { expectedCash: expected, actualCash: expected });
});

test.after(async () => {
  if (app) {
    await db.query(`DROP DATABASE IF EXISTS \`${RESTORE_DB}\``);
    await app.stop();
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const cookie = (client) => [...client.jar].map(([k, v]) => `${k}=${v}`).join('; ');

/** Row count and checksum of every table of a database: equal means the same contents. */
async function fingerprint(database) {
  const tables = await db.query('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [database]);
  const out = {};
  for (const { name } of tables) {
    const [count] = await db.query(`SELECT COUNT(*) AS n FROM \`${database}\`.\`${name}\``);
    const sum = (await db.pool.query(`CHECKSUM TABLE \`${database}\`.\`${name}\``))[0][0];
    out[name] = `${count.n} rows, checksum ${sum.Checksum}`;
  }
  return out;
}

// --- the restore drill ------------------------------------------------------

it('only the Owner can download a backup, and each download is logged', async () => {
  assert.equal((await fetch(`${app.base}/system/backup`)).status, 401);
  assert.equal((await fetch(`${app.base}/system/backup`, { headers: { Cookie: cookie(staff) } })).status, 403);
  assert.equal((await staff.get('/system/status')).status, 403);

  ids.before = await fingerprint(process.env.DB_NAME);
  const res = await fetch(`${app.base}/system/backup`, { headers: { Cookie: cookie(owner) } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/gzip');
  assert.match(res.headers.get('content-disposition'), /attachment; filename="ssctc-shop-\d{8}-\d{6}\.sql\.gz"/);
  ids.file = path.join(tmp, 'download.sql.gz');
  fs.writeFileSync(ids.file, Buffer.from(await res.arrayBuffer()));

  const sql = zlib.gunzipSync(fs.readFileSync(ids.file)).toString('utf8');
  assert.match(sql.trimEnd().split('\n').pop(), /^-- SSCTC-DUMP-COMPLETE tables=\d+ rows=\d+$/);
  // The generated column is never written by the dump; MySQL recomputes it.
  assert.equal(/INSERT INTO `payments` \([^)]*active_ref_key/.test(sql), false);

  const log = (await db.query("SELECT new_values FROM audit_logs WHERE action = 'system.backup_download'"))[0];
  assert.match(log.new_values.file, /^ssctc-shop-/);
});

it('a downloaded backup restores into an empty database with every table identical', async () => {
  const { restore } = require('../scripts/restore');
  const result = await restore(ids.file, RESTORE_DB);
  assert.ok(result.rows > 100);
  assert.ok(result.checks.every((c) => c.problems === 0));

  assert.deepEqual(await fingerprint(RESTORE_DB), ids.before);

  // Spot checks on what is easiest to lose: awkward text, a generated column, money.
  const [sale] = await db.query(`SELECT note, due_amount FROM \`${RESTORE_DB}\`.sales WHERE note IS NOT NULL`);
  assert.equal(sale.note, AWKWARD);
  const [payment] = await db.query(`SELECT active_ref_key FROM \`${RESTORE_DB}\`.payments WHERE method = 'bkash'`);
  assert.equal(payment.active_ref_key, 'bkash:TRX1');
  const [live] = await db.query('SELECT current_due, advance_balance FROM customers WHERE id = ?', [ids.customer]);
  const [copy] = await db.query(`SELECT current_due, advance_balance FROM \`${RESTORE_DB}\`.customers WHERE id = ?`, [ids.customer]);
  assert.deepEqual(copy, live);
  // New rows continue from where the numbering stopped.
  const [next] = await db.query("SELECT auto_increment AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'sales'", [RESTORE_DB]);
  assert.equal(Number(next.n), 2);
});

it('restore never writes over data, and refuses a file that was cut short', async () => {
  const { restore } = require('../scripts/restore');
  await assert.rejects(restore(ids.file, RESTORE_DB), /already has \d+ table\(s\)/);
  await assert.rejects(restore(ids.file, process.env.DB_NAME), /already has/);
  await assert.rejects(restore(ids.file, 'bad-name;drop'), /only letters, numbers and underscores/);
  await assert.rejects(restore(path.join(tmp, 'nothing.sql.gz'), 'ssctc_shop_other_test'), /File not found/);

  const sql = zlib.gunzipSync(fs.readFileSync(ids.file)).toString('utf8');
  const cut = path.join(tmp, 'cut.sql');
  fs.writeFileSync(cut, sql.slice(0, Math.floor(sql.length / 2)));
  await assert.rejects(restore(cut, 'ssctc_shop_cut_test'), /not a complete backup/);
  const [made] = await db.query("SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = 'ssctc_shop_cut_test'");
  assert.equal(Number(made.n), 0); // refused before anything was created
});

// --- scheduled jobs ---------------------------------------------------------

it('the backup job writes a complete file, logs it, and records the result for the dashboard', async () => {
  const out = execFileSync(process.execPath, [script('backup.js'), '--dir', tmp], { env: process.env, encoding: 'utf8' });
  assert.match(out, /Backup written: .*ssctc-shop-\d{8}-\d{6}\.sql\.gz/);
  const files = fs.readdirSync(tmp).filter((f) => /^ssctc-shop-.*\.sql\.gz$/.test(f));
  assert.equal(files.length, 1);
  assert.equal(fs.readdirSync(tmp).some((f) => f.endsWith('.part')), false);
  assert.match(zlib.gunzipSync(fs.readFileSync(path.join(tmp, files[0]))).toString('utf8').trimEnd().split('\n').pop(), /^-- SSCTC-DUMP-COMPLETE/);
  assert.match(fs.readFileSync(path.join(tmp, 'backup.log'), 'utf8'), / OK ssctc-shop-/);

  const status = (await owner.get('/system/status')).body;
  assert.equal(status.backup.lastRun.ok, true);
  assert.equal(status.backup.lastRun.file, files[0]);
  assert.match(status.backup.lastDownload.file, /^ssctc-shop-/);
  const dash = (await owner.get('/dashboard')).body.backup;
  assert.equal(dash.lastRunOk, true);
  assert.ok(dash.lastDownloadAt);
  assert.equal((await staff.get('/dashboard')).body.backup, undefined);
  // These notes are the application's own; the Settings screen does not list them.
  assert.equal((await owner.get('/settings')).body.settings.length, 14);

  // A missing folder is an error, recorded, not a silent success.
  const failed = spawnSync(process.execPath, [script('backup.js'), '--dir', path.join(tmp, 'missing')], { env: process.env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.match(failed.stderr, /Backup folder not found/);
});

it('old backups are thinned to 14 daily and 8 weekly, and other files are never touched', () => {
  const { filesToDelete } = require('../src/lib/backup');
  const name = (date, time = '180000') => `ssctc-shop-${date.toISOString().slice(0, 10).replace(/-/g, '')}-${time}.sql.gz`;
  const day = (n) => new Date(Date.UTC(2026, 9, 11) - n * 86400000);
  const names = [];
  for (let n = 0; n < 120; n++) names.push(name(day(n)));
  names.push(name(day(0), '090000'), 'backup.log', 'notes.txt', 'ssctc-shop-20260101.sql'); // an earlier file today, and strangers

  const removed = new Set(filesToDelete(names));
  const kept = names.filter((n) => !removed.has(n));
  assert.equal(kept.filter((n) => /\.sql\.gz$/.test(n)).length, 14 + 8);
  for (let n = 0; n < 14; n++) assert.ok(kept.includes(name(day(n))), `day ${n} kept`);
  assert.ok(removed.has(name(day(0), '090000'))); // only the newest of a day is kept
  assert.ok(removed.has(name(day(119))));
  for (const stranger of ['backup.log', 'notes.txt', 'ssctc-shop-20260101.sql']) assert.ok(kept.includes(stranger));
  // The weekly ones are a week apart.
  const weekly = kept.filter((n) => /\.sql\.gz$/.test(n)).sort().slice(0, 8);
  assert.equal(new Set(weekly.map((n) => n.slice(11, 19))).size, 8);
  assert.deepEqual(filesToDelete(['ssctc-shop-20261011-180000.sql.gz']), []);
});

it('the housekeeping job removes only long-expired sessions and old login attempts', async () => {
  const me = (await owner.get('/auth/me')).body.user.id;
  await db.query("INSERT INTO sessions (user_id, token_hash, ip, user_agent, expires_at) VALUES (?, REPEAT('a', 64), '::1', 'old', UTC_TIMESTAMP() - INTERVAL 30 DAY)", [me]);
  await db.query("INSERT INTO customer_sessions (customer_id, token_hash, ip, user_agent, expires_at) VALUES (?, REPEAT('b', 64), '::1', 'old', UTC_TIMESTAMP() - INTERVAL 30 DAY)", [ids.customer]);
  await db.query("INSERT INTO login_attempts (identifier, ip, success, created_at) VALUES ('staff:x', '::1', 0, UTC_TIMESTAMP() - INTERVAL 60 DAY), ('staff:y', '::1', 0, UTC_TIMESTAMP())");
  const sales = (await db.query('SELECT COUNT(*) AS n FROM sales'))[0].n;
  const audit = (await db.query('SELECT COUNT(*) AS n FROM audit_logs'))[0].n;

  const out = execFileSync(process.execPath, [script('prune.js')], { env: process.env, encoding: 'utf8' });
  assert.match(out, /pruned: 1 staff session\(s\), 1 customer session\(s\), 1 login attempt\(s\)/);
  assert.equal((await owner.get('/auth/me')).status, 200); // live sessions untouched
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM login_attempts WHERE identifier = 'staff:y'"))[0].n, 1);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM sales'))[0].n, sales);
  assert.equal((await db.query('SELECT COUNT(*) AS n FROM audit_logs'))[0].n, audit);
});

// --- health -----------------------------------------------------------------

it('the System screen reports that every balance agrees with its records, and notices when one does not', async () => {
  const status = (await owner.get('/system/status')).body;
  assert.equal(status.checks.length, 8);
  // How the database is being used, and the address the server sees: both matter on shared hosting.
  assert.match(status.server.mysql, /^8./);
  assert.ok(['READ-COMMITTED', 'REPEATABLE-READ'].includes(status.server.isolation));
  assert.equal(status.server.isolationFallback, status.server.isolation !== 'READ-COMMITTED');
  assert.ok(status.server.clientIp);
  assert.ok(status.checks.every((c) => c.problems === 0), JSON.stringify(status.checks));
  assert.ok(status.database.tables >= 29 && status.database.sales === 1 && status.database.customers === 1);
  // Built from the SQL files without the migration runner, as on phpMyAdmin.
  assert.equal(status.migrations.tracked, false);

  await db.query('UPDATE products SET stock_qty = stock_qty + 1 WHERE id = ?', [ids.mouse]);
  await db.query('UPDATE customers SET current_due = current_due + 5 WHERE id = ?', [ids.customer]);
  const broken = Object.fromEntries((await owner.get('/system/status')).body.checks.map((c) => [c.key, c.problems]));
  assert.deepEqual([broken.stock, broken.customers, broken.sales, broken.advance], [1, 1, 0, 0]);
  await db.query('UPDATE products SET stock_qty = stock_qty - 1 WHERE id = ?', [ids.mouse]);
  await db.query('UPDATE customers SET current_due = current_due - 5 WHERE id = ?', [ids.customer]);
});

it('the launch check passes the data checks and fails loudly on an unsafe configuration', async () => {
  const run = spawnSync(process.execPath, [script('launch-check.js')], { env: { ...process.env, BACKUP_DIR: tmp }, encoding: 'utf8' });
  // The test environment is deliberately not production: plain HTTP, quick hashing.
  assert.equal(run.status, 1);
  assert.match(run.stdout, /FAIL  NODE_ENV is "production"/);
  assert.match(run.stdout, /FAIL  The site address uses HTTPS/);
  assert.match(run.stdout, /PASS  All 5 migrations have been run/);
  assert.match(run.stdout, /PASS  There is an active Owner account/);
  assert.match(run.stdout, /PASS  Stock equals its movement history/);
  assert.match(run.stdout, /PASS  Every customer's due equals their unpaid bills/);
  assert.match(run.stdout, /PASS  The backup folder exists and can be written to/);
  assert.match(run.stdout, /PASS  A scheduled backup succeeded in the last 2 days/);
  assert.match(run.stdout, /\d+ passed, \d+ warning\(s\), \d+ failed\./);
  // It only reads.
  assert.equal((await db.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'launch%'"))[0].n, 0);
});

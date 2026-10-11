// Read-only checks before going live, and any time after (DEPLOYMENT_PLAN.md §8).
//
//   npm run launch-check
//
// Changes nothing. Prints PASS, WARN or FAIL for each line and exits with an
// error if anything FAILs. It checks what a program can check; the rest of the
// launch checklist (real products entered, a restore drill done, the owner's
// trial day) is for a person.
const fs = require('node:fs');
const path = require('node:path');
const { env, isProduction } = require('../src/config/env');
const { runIntegrityChecks } = require('../src/lib/integrity');
const { connect } = require('./lib/connect');

const results = [];
const add = (level, label, detail = '') => results.push({ level, label, detail });
const pass = (ok, label, detail, level = 'FAIL') => add(ok ? 'PASS' : level, label, ok ? '' : detail);

async function main() {
  const conn = await connect();
  const rows = async (sql, params) => (await conn.query(sql, params))[0];
  try {
    // --- configuration ---------------------------------------------------------
    pass(isProduction, 'NODE_ENV is "production"', `It is "${env.NODE_ENV}".`);
    pass(env.APP_BASE_URL.startsWith('https://'), 'The site address uses HTTPS', `APP_BASE_URL is ${env.APP_BASE_URL}. Login cookies are only marked Secure over HTTPS.`);
    pass(env.BCRYPT_COST >= 12, 'Passwords are hashed at cost 12 or more', `BCRYPT_COST is ${env.BCRYPT_COST}.`);
    pass(!(process.env.OWNER_USERNAME || process.env.OWNER_PASSWORD), 'The first-Owner variables have been removed', 'OWNER_USERNAME / OWNER_PASSWORD are still set. Remove them from the environment and restart.');
    pass(env.DB_USER !== 'root', 'The application does not connect as root', 'Create a database user for the application.', 'WARN');

    // --- database --------------------------------------------------------------
    const [server] = await rows('SELECT VERSION() AS version, @@log_bin AS log_bin, @@binlog_format AS binlog_format, @@sql_mode AS sql_mode');
    pass(/^8\./.test(server.version) && !/mariadb/i.test(server.version), 'The database is MySQL 8', `It reports "${server.version}". The application needs MySQL 8.0.16 or newer, not MariaDB.`);
    pass(!(Number(server.log_bin) === 1 && server.binlog_format === 'STATEMENT'), 'The server allows READ COMMITTED transactions', 'Its binary log format is STATEMENT, so the application falls back to REPEATABLE READ. It works, but ask the host whether binlog_format can be ROW or MIXED.', 'WARN');

    const files = fs.readdirSync(path.join(__dirname, '..', 'migrations')).filter((f) => f.endsWith('.sql')).sort();
    const columns = await rows("SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE() AND (table_name, column_name) IN (('sales', 'returned_amount'), ('purchases', 'idempotency_key'), ('payments', 'kind'), ('daily_cash_closings', 'period_start'))");
    pass(columns.length === 4, `All ${files.length} migrations have been run`, `Only ${columns.length} of 4 marker columns exist. Run the missing migration files in number order.`);
    if (columns.length !== 4) return; // the rest would only produce errors

    const counters = await rows('SELECT doc_type FROM document_counters');
    pass(counters.length >= 7, 'Base data is loaded (document counters, cash drawer lock)', 'Run api/seeds/001_base_data.sql.');
    const [roles] = await rows('SELECT (SELECT COUNT(*) FROM role_permissions WHERE role_id = 1) AS owner, (SELECT COUNT(*) FROM role_permissions WHERE role_id = 2) AS staff');
    pass(Number(roles.owner) >= 30 && Number(roles.staff) >= 10, 'Roles and permissions are loaded', 'Run api/seeds/001_base_data.sql.');

    // --- accounts ----------------------------------------------------------------
    const [owners] = await rows("SELECT COUNT(*) AS n FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' AND u.status = 'active'");
    pass(Number(owners.n) >= 1, 'There is an active Owner account', 'Create one with `npm run seed`.');
    const suspicious = await rows("SELECT username FROM users WHERE status = 'active' AND (username REGEXP '^(test|demo|admin|user)[0-9]*$' OR name REGEXP '^(test|demo)')");
    pass(suspicious.length === 0, 'No test or demo user accounts are active', `Block or rename: ${suspicious.map((u) => u.username).join(', ')}.`, 'WARN');
    const demo = await rows("SELECT name FROM customers WHERE name LIKE 'Demo %' OR name LIKE 'Test %' LIMIT 5");
    pass(demo.length === 0, 'No demo customers are left', `Found: ${demo.map((c) => c.name).join(', ')}. Test sales cannot be deleted; start the live system on a fresh database.`, 'WARN');

    // --- shop details --------------------------------------------------------------
    const settings = Object.fromEntries((await rows('SELECT setting_key, value FROM settings')).map((s) => [s.setting_key, s.value]));
    pass(Boolean(settings['shop.phone']), 'The shop phone number is set (it is printed on invoices)', 'Enter it on the Settings screen.', 'WARN');
    const [catalog] = await rows("SELECT (SELECT COUNT(*) FROM products WHERE status = 'active') AS products, (SELECT COUNT(*) FROM services WHERE is_active = 1) AS services, (SELECT COUNT(*) FROM products WHERE status = 'active' AND cost_price = 0) AS uncosted");
    pass(Number(catalog.products) + Number(catalog.services) > 0, 'Products or services have been entered', 'Nothing can be sold yet.', 'WARN');
    pass(Number(catalog.uncosted) === 0, 'Every product has a cost price', `${catalog.uncosted} product(s) have none, so profit will be overstated.`, 'WARN');

    // --- records agree -----------------------------------------------------------------
    for (const check of await runIntegrityChecks(rows)) pass(check.problems === 0, check.label, `${check.problems} record(s) disagree. Do not go live until this is understood.`);

    // --- backups ---------------------------------------------------------------------------
    if (!env.BACKUP_DIR) add('WARN', 'A backup folder is configured', 'BACKUP_DIR is empty, so the daily backup job cannot run. The System screen download still works.');
    else {
      let writable = true;
      try {
        fs.accessSync(env.BACKUP_DIR, fs.constants.W_OK);
      } catch {
        writable = false;
      }
      pass(writable, 'The backup folder exists and can be written to', `${env.BACKUP_DIR} is missing or read-only.`);
    }
    const ageDays = (stamp) => (stamp && stamp.at ? (Date.now() - Date.parse(stamp.at)) / 86400000 : Infinity);
    const lastRun = settings['backup.last_run'];
    pass(Boolean(lastRun && lastRun.ok) && ageDays(lastRun) <= 2, 'A scheduled backup succeeded in the last 2 days', lastRun ? (lastRun.ok ? 'The last one is older than 2 days. Check the cron job.' : `The last one failed: ${lastRun.error}`) : 'None has run yet. Add the cron job.', 'WARN');
    pass(ageDays(settings['backup.last_download']) <= 8, 'A backup was downloaded off the server in the last 8 days', 'Download one from the System screen and keep it on the shop PC or a cloud drive.', 'WARN');
  } finally {
    await conn.end();
  }
}

main()
  .catch((err) => add('FAIL', 'The check could run', err.message))
  .finally(() => {
    for (const r of results) console.log(`${r.level.padEnd(4)}  ${r.label}${r.detail ? `\n      ${r.detail}` : ''}`);
    const count = (level) => results.filter((r) => r.level === level).length;
    console.log(`\n${count('PASS')} passed, ${count('WARN')} warning(s), ${count('FAIL')} failed.`);
    if (count('FAIL') > 0) process.exitCode = 1;
  });

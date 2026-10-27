const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const crypto = require('node:crypto');
const { env } = require('../../config/env');
const { query } = require('../../db/pool');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { writeDump, dumpFileName } = require('../../lib/backup');
const { runIntegrityChecks } = require('../../lib/integrity');
const { getSetting, setSetting } = require('../../lib/settings');
const { runScheduledBackup } = require('../../lib/scheduledBackup');
const { driveConfigured } = require('../../lib/gdrive');
const { AppError, notFound, forbidden, conflict } = require('../../lib/errors');

// Backup and health: Owner only (permission system.backup).
const router = express.Router();

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', '..', 'migrations');

/** Migration files shipped with this code that the database has not recorded. */
async function pendingMigrations() {
  const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  let applied;
  try {
    applied = new Set((await query('SELECT filename FROM schema_migrations')).map((r) => r.filename));
  } catch {
    // Migrations pasted into phpMyAdmin are not recorded; that cannot be told apart from "not run".
    return { tracked: false, files };
  }
  return { tracked: true, files: files.filter((f) => !applied.has(f)) };
}

router.get('/system/status', staffWith('system.backup'), async (req, res) => {
  const [size] = await query('SELECT COUNT(*) AS tables, COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()');
  const [counts] = await query(
    `SELECT (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM audit_logs) AS audit`,
  );
  const [server] = await query('SELECT VERSION() AS version, @@session.transaction_isolation AS isolation, @@log_bin AS log_bin, @@binlog_format AS binlog_format');
  res.json({
    server: {
      mysql: server.version,
      isolation: server.isolation,
      // READ COMMITTED is what the application is designed for; see db/pool.js.
      isolationFallback: server.isolation !== 'READ-COMMITTED',
      // The address this request appears to come from. If it is 127.0.0.1 or
      // the same for every visitor, TRUST_PROXY is wrong and one person's
      // failed logins can lock everyone out (DEPLOYMENT_PLAN.md T15).
      clientIp: req.ip,
    },
    checks: await runIntegrityChecks(query),
    backup: { lastDownload: await getSetting('backup.last_download'), lastRun: await getSetting('backup.last_run'), scheduled: Boolean(env.BACKUP_CRON_KEY), drive: driveConfigured() },
    database: { tables: Number(size.tables), bytes: Number(size.bytes), sales: Number(counts.sales), customers: Number(counts.customers), products: Number(counts.products), payments: Number(counts.payments), auditEntries: Number(counts.audit) },
    migrations: await pendingMigrations(),
  });
});

/**
 * Download a fresh backup of the whole database (DEPLOYMENT_PLAN.md §6: the
 * copy kept away from the hosting account). The file holds every customer's
 * name, number and balance and every password hash: it is for the Owner only
 * and each download is written to the audit log.
 */
router.get('/system/backup', staffWith('system.backup'), async (req, res) => {
  const at = new Date();
  const name = dumpFileName(at);
  res.setHeader('Content-Type', 'application/gzip');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);

  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(res);
  try {
    const done = await writeDump(gzip);
    // Recorded before the download is allowed to finish, so a completed
    // download is always one that was logged.
    await setSetting('backup.last_download', { at: at.toISOString(), file: name, rows: done.rows, by: req.user.name }, 'When the Owner last downloaded a backup');
    await writeAudit({ actorUserId: req.user.id, action: 'system.backup_download', entityType: 'system', newValues: { file: name, rows: done.rows }, ip: req.ip });
    gzip.end();
  } catch (err) {
    // The headers have gone, so the only honest signal left is a broken
    // download. The file lacks its completion line and cannot be restored.
    console.error(`Backup download failed: ${err.message}`);
    res.destroy(err);
  }
});

const sameSecret = (given, expected) => {
  const a = crypto.createHash('sha256').update(String(given)).digest();
  const b = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(a, b);
};
let backupRunning = false;

/**
 * The nightly backup, started by a cPanel cron job with curl (DEPLOYMENT_PLAN.md
 * §5): a cron job cannot see the environment variables set on the Node.js
 * page, but the running application can. No login: the job proves itself with
 * the BACKUP_CRON_KEY secret in the X-Backup-Key header. Without that variable
 * set, this address does not exist.
 */
router.post('/system/scheduled-backup', async (req, res) => {
  if (!env.BACKUP_CRON_KEY) throw notFound();
  if (!sameSecret(req.headers['x-backup-key'] || '', env.BACKUP_CRON_KEY)) throw forbidden('Wrong backup key.');
  if (backupRunning) throw conflict('A backup is already running.');
  backupRunning = true;
  try {
    let result;
    try {
      result = await runScheduledBackup({ record: (r) => setSetting('backup.last_run', r, 'Result of the last scheduled backup') });
    } catch (err) {
      // Told to the cron job, so its log says why. The details are recorded for the System screen.
      throw new AppError(502, 'backup_failed', `Backup failed: ${err.message}`);
    }
    await writeAudit({ action: 'system.backup_scheduled', entityType: 'system', newValues: { file: result.file, rows: result.rows, drive: Boolean(result.drive) }, ip: req.ip });
    res.json({ ok: true, file: result.file, bytes: result.bytes, drive: result.drive || null });
  } finally {
    backupRunning = false;
  }
});

module.exports = router;

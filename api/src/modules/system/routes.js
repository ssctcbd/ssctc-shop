const express = require('express');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { query } = require('../../db/pool');
const { staffWith } = require('../../middleware/session');
const { writeAudit } = require('../../lib/audit');
const { writeDump, dumpFileName } = require('../../lib/backup');
const { runIntegrityChecks } = require('../../lib/integrity');
const { getSetting, setSetting } = require('../../lib/settings');

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

router.get('/system/status', staffWith('system.backup'), async (_req, res) => {
  const [size] = await query('SELECT COUNT(*) AS tables, COALESCE(SUM(data_length + index_length), 0) AS bytes FROM information_schema.tables WHERE table_schema = DATABASE()');
  const [counts] = await query(
    `SELECT (SELECT COUNT(*) FROM sales) AS sales, (SELECT COUNT(*) FROM customers) AS customers, (SELECT COUNT(*) FROM products) AS products,
            (SELECT COUNT(*) FROM payments) AS payments, (SELECT COUNT(*) FROM audit_logs) AS audit`,
  );
  res.json({
    checks: await runIntegrityChecks(query),
    backup: { lastDownload: await getSetting('backup.last_download'), lastRun: await getSetting('backup.last_run') },
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

module.exports = router;

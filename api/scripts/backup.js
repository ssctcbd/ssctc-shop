// Back up the database to a compressed file, then delete backups that are no
// longer needed. Meant for a daily cPanel cron job (DEPLOYMENT_PLAN.md §5):
//
//   npm run backup                  writes BACKUP_DIR/ssctc-shop-YYYYMMDD-HHMMSS.sql.gz
//   npm run backup -- --dir <path>  use another folder (it must already exist)
//
// Keeps the newest file of each of the last 14 days, and beyond those the
// newest of each of the last 8 weeks. The result is appended to backup.log in
// the same folder and stored in the database, where the System screen and the
// dashboard read it. The folder must be OUTSIDE the website's public folder.
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../src/config/env');
const { writeCompressedDump, dumpFileName, filesToDelete } = require('../src/lib/backup');
const { connect } = require('./lib/connect');

async function record(result) {
  const conn = await connect();
  try {
    await conn.query("INSERT INTO settings (setting_key, value, description) VALUES ('backup.last_run', ?, 'Result of the last scheduled backup') ON DUPLICATE KEY UPDATE value = VALUES(value)", [JSON.stringify(result)]);
  } finally {
    await conn.end();
  }
}

async function main() {
  const flag = process.argv.indexOf('--dir');
  const dir = flag > -1 ? process.argv[flag + 1] : env.BACKUP_DIR;
  if (!dir) throw new Error('No backup folder. Set BACKUP_DIR, or pass --dir <path>.');
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) throw new Error(`Backup folder not found: ${dir}`);

  const at = new Date();
  const name = dumpFileName(at);
  const file = path.join(dir, name);
  const partial = `${file}.part`;
  const log = (line) => fs.appendFileSync(path.join(dir, 'backup.log'), `${new Date().toISOString()} ${line}\n`);

  try {
    // Written under a temporary name: a file called *.sql.gz is always complete.
    const done = await writeCompressedDump(fs.createWriteStream(partial, { mode: 0o600 }));
    fs.renameSync(partial, file);
    const bytes = fs.statSync(file).size;

    const removed = filesToDelete(fs.readdirSync(dir));
    for (const old of removed) fs.unlinkSync(path.join(dir, old));

    log(`OK ${name} ${bytes} bytes, ${done.tables} tables, ${done.rows} rows, removed ${removed.length} old file(s)`);
    await record({ ok: true, at: at.toISOString(), file: name, bytes, rows: done.rows });
    console.log(`Backup written: ${file} (${bytes} bytes, ${done.rows} rows). Removed ${removed.length} old file(s).`);
  } catch (err) {
    fs.rmSync(partial, { force: true });
    log(`FAILED ${err.message}`);
    await record({ ok: false, at: at.toISOString(), error: String(err.message).slice(0, 200) }).catch(() => {});
    throw err;
  }
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
});

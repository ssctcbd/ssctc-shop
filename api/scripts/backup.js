// Back up the database, copy it to Google Drive if that is set up, and delete
// backups that are no longer needed (lib/scheduledBackup.js):
//
//   npm run backup                  writes BACKUP_DIR/ssctc-shop-YYYYMMDD-HHMMSS.sql.gz
//   npm run backup -- --dir <path>  use another folder (it must already exist)
//
// Needs the application's environment variables (a .env file, or the shell).
// On cPanel a cron job cannot see the variables set on the Node.js page, so
// there the nightly backup is started through the scheduled-backup endpoint
// instead (DEPLOYMENT_PLAN.md §5). The result is appended to backup.log in the
// backup folder and stored in the database, where the System screen and the
// dashboard read it. The folder must be OUTSIDE the website's public folder.
const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../src/config/env');
const { runScheduledBackup } = require('../src/lib/scheduledBackup');
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
  const log = (line) => dir && fs.appendFileSync(path.join(dir, 'backup.log'), `${new Date().toISOString()} ${line}\n`);
  const result = await runScheduledBackup({ dir, record, log });
  console.log(`Backup written: ${result.file} (${result.bytes} bytes, ${result.rows} rows).${result.drive ? ' Copied to Google Drive.' : ''}`);
}

main().catch((err) => {
  console.error(`Backup failed: ${err.message}`);
  process.exitCode = 1;
});

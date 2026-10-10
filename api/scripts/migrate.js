// Apply pending migrations from api/migrations in file-name order.
//   npm run migrate            apply what has not been applied
//   npm run migrate -- --status   list applied and pending files, change nothing
//
// A migration that has run on the live database is never edited; corrections
// are new files. Take a database backup before running this on live.
const fs = require('node:fs');
const path = require('node:path');
const { connect } = require('./lib/connect');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function main() {
  const statusOnly = process.argv.includes('--status');
  const conn = await connect();
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         filename    VARCHAR(255) NOT NULL,
         applied_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
         PRIMARY KEY (filename)
       ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
    );
    const [appliedRows] = await conn.query('SELECT filename FROM schema_migrations');
    const applied = new Set(appliedRows.map((r) => r.filename));
    const files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
    const pending = files.filter((f) => !applied.has(f));

    if (statusOnly) {
      for (const f of files) console.log(`${applied.has(f) ? 'applied' : 'PENDING'}  ${f}`);
      return;
    }
    if (pending.length === 0) {
      console.log('Database is up to date. Nothing to apply.');
      return;
    }

    for (const file of pending) {
      process.stdout.write(`Applying ${file} ... `);
      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
      try {
        await conn.query(sql);
      } catch (err) {
        console.log('FAILED');
        // MySQL cannot roll back CREATE/ALTER TABLE, so part of this file may
        // have been applied. It is not recorded; fix the cause before re-running.
        console.error(`\n${file} failed: ${err.message}`);
        console.error('Statements before the failing one have already taken effect. Restore the backup or remove the partial changes before running again.');
        process.exitCode = 1;
        return;
      }
      await conn.query('INSERT INTO schema_migrations (filename) VALUES (?)', [file]);
      console.log('done');
    }
    console.log(`Applied ${pending.length} migration(s).`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Migration could not run: ${err.message}`);
  process.exitCode = 1;
});

// Daily housekeeping, for a cPanel cron job (DEPLOYMENT_PLAN.md §5):
//
//   npm run prune
//
// Deletes login sessions that ended more than 7 days ago and login attempts
// older than 30 days. Nothing else is ever deleted: sales, payments, stock
// history and the audit log are permanent.
const { connect } = require('./lib/connect');

async function main() {
  const conn = await connect();
  try {
    const run = async (sql) => (await conn.query(sql))[0].affectedRows;
    const staff = await run('DELETE FROM sessions WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY OR revoked_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
    const customers = await run('DELETE FROM customer_sessions WHERE expires_at < UTC_TIMESTAMP() - INTERVAL 7 DAY');
    const attempts = await run('DELETE FROM login_attempts WHERE created_at < UTC_TIMESTAMP() - INTERVAL 30 DAY');
    console.log(`${new Date().toISOString()} pruned: ${staff} staff session(s), ${customers} customer session(s), ${attempts} login attempt(s)`);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Prune failed: ${err.message}`);
  process.exitCode = 1;
});

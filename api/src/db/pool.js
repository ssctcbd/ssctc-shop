const mysql = require('mysql2/promise');
const { env } = require('../config/env');

const pool = mysql.createPool({
  host: env.DB_HOST,
  port: env.DB_PORT,
  database: env.DB_NAME,
  user: env.DB_USER,
  password: env.DB_PASSWORD,
  connectionLimit: env.DB_POOL_MAX,
  waitForConnections: true,
  charset: 'utf8mb4',
  // All DATETIME values are UTC, both in MySQL and when converted to JS dates.
  timezone: 'Z',
  decimalNumbers: false, // money stays a string; never a float
  namedPlaceholders: false,
});

// Each new connection speaks UTC, so CURRENT_TIMESTAMP and NOW() are UTC too.
//
// READ COMMITTED, not MySQL's default REPEATABLE READ. Under REPEATABLE READ a
// transaction's plain SELECTs all see the database as it was at its first read,
// which here happens *before* it has waited for its row locks. A transaction
// that queued behind another would then lock the sale, yet still count returns
// or payments from before the other one committed, and act on stale numbers.
// With READ COMMITTED every statement sees what is committed when it runs, so
// "take the lock, then read" is always reading the truth.
//
// One exception. A server that writes its binary log in STATEMENT format
// refuses every InnoDB write made at READ COMMITTED, which would stop the
// whole application. There the session stays at REPEATABLE READ. That is still
// correct for money, because every transaction that touches money begins with
// a locking read (lib/cash.js lockCashDrawer): a locking read does not open
// the snapshot, so the snapshot is taken only after the transaction has the
// lock, when nothing it depends on can still be changing.
//
// sql_mode is fixed here rather than left to the hosting default, so a value
// that does not fit a column is an error, never silently cut to fit.
const SQL_MODE = 'ONLY_FULL_GROUP_BY,STRICT_TRANS_TABLES,NO_ZERO_IN_DATE,NO_ZERO_DATE,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION';
const ISOLATION = "SET SESSION transaction_isolation = IF(@@log_bin = 1 AND @@binlog_format = 'STATEMENT', 'REPEATABLE-READ', 'READ-COMMITTED')";

pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
  conn.query(`SET SESSION sql_mode = '${SQL_MODE}'`);
  conn.query(ISOLATION);
});

async function query(sql, params = []) {
  const [rows] = await pool.execute(sql, params);
  return rows;
}

const ER_LOCK_DEADLOCK = 1213;

/**
 * Run `fn(conn)` inside one transaction. Commits on success, rolls back on any
 * error. A deadlock is retried once (DATABASE_SCHEMA.md §5.1).
 */
async function transaction(fn, { retryOnDeadlock = true } = {}) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const result = await fn(conn);
    await conn.commit();
    return result;
  } catch (err) {
    await conn.rollback().catch(() => {});
    if (retryOnDeadlock && err && err.errno === ER_LOCK_DEADLOCK) {
      conn.release();
      return transaction(fn, { retryOnDeadlock: false });
    }
    throw err;
  } finally {
    // release() is a no-op if the connection was already released above.
    try { conn.release(); } catch { /* already released */ }
  }
}

module.exports = { pool, query, transaction };

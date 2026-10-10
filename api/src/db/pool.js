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
pool.pool.on('connection', (conn) => {
  conn.query("SET time_zone = '+00:00'");
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

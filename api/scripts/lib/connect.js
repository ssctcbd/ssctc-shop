const mysql = require('mysql2/promise');
const { env } = require('../../src/config/env');

/** A single connection for scripts. Allows several statements per query so whole .sql files can be run. */
async function connect() {
  const conn = await mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database: env.DB_NAME,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4',
    timezone: 'Z',
    multipleStatements: true,
  });
  await conn.query("SET time_zone = '+00:00'");
  return conn;
}

module.exports = { connect };

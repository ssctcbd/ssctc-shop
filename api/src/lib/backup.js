const zlib = require('node:zlib');
const { once } = require('node:events');
const mysql = require('mysql2/promise');
const { env } = require('../config/env');

/**
 * Database backup written by the application itself, so it does not depend on
 * `mysqldump` being available on the hosting account (DEPLOYMENT_PLAN.md T17).
 *
 * The dump is plain SQL, one statement per line, gzip-compressed. It can be
 * restored with `npm run restore`, or un-zipped and imported in phpMyAdmin.
 * It is taken inside one read-only transaction with a consistent snapshot, so
 * a sale saved half-way through the dump is either wholly in it or not at all.
 */

const ROWS_PER_READ = 1000;
const ROWS_PER_INSERT = 100;
const COMPLETE_MARK = '-- SSCTC-DUMP-COMPLETE';

const ident = (name) => `\`${String(name).replace(/`/g, '``')}\``;

/** A connection that returns every value as text (or null), exactly as stored. */
function dumpConnection(database = env.DB_NAME) {
  return mysql.createConnection({
    host: env.DB_HOST,
    port: env.DB_PORT,
    database,
    user: env.DB_USER,
    password: env.DB_PASSWORD,
    charset: 'utf8mb4',
    timezone: 'Z',
    typeCast: (field) => field.string('utf8'),
  });
}

/**
 * Write a full dump of the database as SQL text to `out` (any writable
 * stream). Returns { tables, rows }. Generated columns are left out of the
 * INSERTs; MySQL recomputes them.
 */
async function writeDump(out, { database = env.DB_NAME } = {}) {
  const conn = await dumpConnection(database);
  const write = async (line) => {
    if (!out.write(`${line}\n`)) await once(out, 'drain');
  };
  let totalRows = 0;
  try {
    await conn.query("SET time_zone = '+00:00'");
    await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');

    const [tables] = await conn.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE' ORDER BY table_name");
    await write(`-- SSCTC Shop database backup. Database: ${database}. Taken (UTC): ${new Date().toISOString()}`);
    await write('-- Restore into an EMPTY database: npm run restore -- <this file> --database <name>');
    await write('SET NAMES utf8mb4;');
    await write("SET time_zone = '+00:00';");
    await write('SET FOREIGN_KEY_CHECKS = 0;');

    for (const { name } of tables) {
      const [[created]] = await conn.query(`SHOW CREATE TABLE ${ident(name)}`);
      await write(`DROP TABLE IF EXISTS ${ident(name)};`);
      await write(`${created['Create Table'].replace(/\s*\n\s*/g, ' ')};`);

      const [columns] = await conn.query("SELECT column_name AS name, column_key AS col_key, generation_expression AS gen_expr FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? ORDER BY ordinal_position", [name]);
      const stored = columns.filter((c) => !c.gen_expr).map((c) => ident(c.name));
      const key = columns.filter((c) => c.col_key === 'PRI').map((c) => ident(c.name));
      const order = key.length ? ` ORDER BY ${key.join(', ')}` : '';

      for (let offset = 0; ; offset += ROWS_PER_READ) {
        const [rows] = await conn.query({ sql: `SELECT ${stored.join(', ')} FROM ${ident(name)}${order} LIMIT ${ROWS_PER_READ} OFFSET ${offset}`, rowsAsArray: true });
        for (let i = 0; i < rows.length; i += ROWS_PER_INSERT) {
          const values = rows.slice(i, i + ROWS_PER_INSERT).map((row) => `(${row.map((v) => mysql.escape(v)).join(',')})`);
          await write(`INSERT INTO ${ident(name)} (${stored.join(', ')}) VALUES ${values.join(',')};`);
        }
        totalRows += rows.length;
        if (rows.length < ROWS_PER_READ) break;
      }
    }

    await write('SET FOREIGN_KEY_CHECKS = 1;');
    // The last line. A file without it was cut short and must not be trusted.
    await write(`${COMPLETE_MARK} tables=${tables.length} rows=${totalRows}`);
    await conn.query('COMMIT');
    return { tables: tables.length, rows: totalRows };
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Pipe a gzip-compressed dump into `destination`. Resolves when it is fully written. */
async function writeCompressedDump(destination, options) {
  const gzip = zlib.createGzip({ level: 6 });
  gzip.pipe(destination);
  const finished = once(destination, 'finish');
  const result = await writeDump(gzip, options);
  gzip.end();
  await finished;
  return result;
}

/** "ssctc-shop-20261011-183000.sql.gz", named in UTC so names sort by time. */
function dumpFileName(at = new Date()) {
  const stamp = at.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  return `ssctc-shop-${stamp}.sql.gz`;
}

const FILE_RE = /^ssctc-shop-(\d{4})(\d{2})(\d{2})-(\d{6})\.sql\.gz$/;

/**
 * Which backup files to delete (DEPLOYMENT_PLAN.md §6): keep the newest file
 * of each of the last `daily` days that have one, and beyond those the newest
 * file of each of the last `weekly` weeks. Files with other names are never touched.
 */
function filesToDelete(names, { daily = 14, weekly = 8 } = {}) {
  const files = names
    .map((name) => ({ name, m: FILE_RE.exec(name) }))
    .filter((f) => f.m)
    .map((f) => ({ name: f.name, day: `${f.m[1]}-${f.m[2]}-${f.m[3]}` }))
    .sort((a, z) => (a.name < z.name ? 1 : -1)); // newest first
  const weekOf = (day) => {
    const date = new Date(`${day}T00:00:00Z`);
    // Monday of that week.
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
    return date.toISOString().slice(0, 10);
  };

  const keep = new Set();
  const days = new Set();
  const weeks = new Set();
  for (const f of files) {
    if (days.has(f.day)) continue; // an older file of a day already kept
    if (days.size < daily) {
      days.add(f.day);
      keep.add(f.name);
    } else if (!weeks.has(weekOf(f.day)) && weeks.size < weekly) {
      weeks.add(weekOf(f.day));
      keep.add(f.name);
    }
  }
  return files.filter((f) => !keep.has(f.name)).map((f) => f.name);
}

module.exports = { writeDump, writeCompressedDump, dumpFileName, filesToDelete, COMPLETE_MARK };

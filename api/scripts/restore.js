// Restore a backup made by `npm run backup` or downloaded from the System screen.
//
//   npm run restore -- <file.sql.gz> --database <name>
//
// The database is always named explicitly, and must be EMPTY: this script
// never writes over data. To go back to a backup, restore it into a new
// database, check it, then point DB_NAME at that database and restart the app
// (DEPLOYMENT_PLAN.md §6). After restoring it runs the same consistency checks
// as the System screen and reports the number of rows restored.
const fs = require('node:fs');
const zlib = require('node:zlib');
const { StringDecoder } = require('node:string_decoder');
const mysql = require('mysql2/promise');
const { env } = require('../src/config/env');
const { COMPLETE_MARK } = require('../src/lib/backup');
const { runIntegrityChecks } = require('../src/lib/integrity');

/** Read a dump and call `each(statement)` for every SQL statement. Returns the completion line, if present. */
async function readStatements(file, each) {
  const input = fs.createReadStream(file);
  const text = file.endsWith('.gz') ? input.pipe(zlib.createGunzip()) : input;
  // Split on "\n" only. Every newline inside a value is escaped by the dump, but
  // other characters that some tools treat as line breaks are not.
  const decoder = new StringDecoder('utf8');
  let complete = null;
  let rest = '';
  const handle = async (line) => {
    if (line.startsWith(COMPLETE_MARK)) complete = line;
    if (line === '' || line.startsWith('--')) return;
    await each(line);
  };
  for await (const chunk of text) {
    const lines = (rest + decoder.write(chunk)).split('\n');
    rest = lines.pop();
    for (const line of lines) await handle(line);
  }
  await handle(rest + decoder.end());
  return complete;
}

async function restore(file, database) {
  if (!/^[A-Za-z0-9_]+$/.test(database)) throw new Error('The database name may contain only letters, numbers and underscores.');
  if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);

  // First pass, touching nothing: a file that was cut short has no completion line.
  const complete = await readStatements(file, async () => {});
  if (!complete) throw new Error('This file is not a complete backup (its last line is missing). Nothing was changed.');
  const expected = Number(/rows=(\d+)/.exec(complete)[1]);

  const conn = await mysql.createConnection({ host: env.DB_HOST, port: env.DB_PORT, user: env.DB_USER, password: env.DB_PASSWORD, charset: 'utf8mb4', timezone: 'Z' });
  try {
    try {
      await conn.query(`USE \`${database}\``);
    } catch {
      // Not there (or not ours). Creating it works on a PC; on cPanel a
      // database is made in the "MySQL Databases" screen and the user added to it.
      try {
        await conn.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        await conn.query(`USE \`${database}\``);
      } catch (err) {
        throw new Error(`Cannot open or create database "${database}" (${err.code}). On cPanel, create it in "MySQL Databases", add the application's user to it with all privileges, then run this again.`);
      }
    }
    const [[existing]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.tables WHERE table_schema = DATABASE()');
    if (Number(existing.n) > 0) throw new Error(`Database "${database}" already has ${existing.n} table(s). Restore into an empty database; nothing was changed.`);

    await readStatements(file, (statement) => conn.query(statement));
    await conn.query('SET FOREIGN_KEY_CHECKS = 1');

    const [tables] = await conn.query("SELECT table_name AS name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    let rows = 0;
    for (const t of tables) rows += Number((await conn.query(`SELECT COUNT(*) AS n FROM \`${t.name}\``))[0][0].n);
    if (rows !== expected) throw new Error(`Restored ${rows} rows but the backup says ${expected}. Do not use this database.`);

    const checks = await runIntegrityChecks(async (sql) => (await conn.query(sql))[0]);
    return { tables: tables.length, rows, checks };
  } finally {
    await conn.end().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--database');
  const database = flag > -1 ? args[flag + 1] : null;
  const file = args.find((a, i) => !a.startsWith('--') && i !== flag + 1);
  if (!file || !database) throw new Error('Usage: npm run restore -- <file.sql.gz> --database <name>');

  const result = await restore(file, database);
  console.log(`Restored ${result.tables} tables, ${result.rows} rows into "${database}".`);
  for (const c of result.checks) console.log(`  ${c.problems === 0 ? 'OK  ' : 'FAIL'}  ${c.label}${c.problems ? ` (${c.problems} record(s) disagree)` : ''}`);
  if (result.checks.some((c) => c.problems > 0)) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((err) => {
    console.error(`Restore failed: ${err.message}`);
    process.exitCode = 1;
  });
}

module.exports = { restore };

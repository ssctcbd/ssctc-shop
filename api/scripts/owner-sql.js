// Make the SQL that creates the first Owner account, for hosting where the
// seed script cannot be run (no SSH). Run this on your own PC:
//
//   node scripts/owner-sql.js
//
// It asks for a name, a username and a password, and prints one INSERT
// statement to paste into phpMyAdmin's SQL tab. Only the bcrypt hash of the
// password is in that statement; the password itself goes nowhere. It does
// not connect to any database.
const readline = require('node:readline');
const bcrypt = require('bcryptjs');

const COST = 12; // the same as production (BCRYPT_COST)

async function main() {
  // Lines are read as they arrive, so this works typed at a keyboard or piped in.
  const rl = readline.createInterface({ input: process.stdin });
  const lines = rl[Symbol.asyncIterator]();
  const ask = async (question) => {
    process.stderr.write(question);
    const { value } = await lines.next();
    return String(value ?? '').trim();
  };

  console.error('Create the first Owner account. (What you type is visible on screen.)\n');
  const name = await ask('Full name: ');
  const username = (await ask('Username (small letters and numbers, no spaces): ')).toLowerCase();
  const password = await ask('Password (at least 10 characters): ');
  rl.close();

  if (name.length < 2 || name.length > 120) throw new Error('The name must be 2 to 120 characters.');
  if (!/^[a-z0-9._-]{3,60}$/.test(username)) throw new Error('The username must be 3 to 60 characters: letters, numbers, dot, dash or underscore.');
  if (password.length < 10 || password.length > 72) throw new Error('The password must be 10 to 72 characters.');

  const hash = await bcrypt.hash(password, COST);
  const quote = (text) => `'${text.replace(/\\/g, '\\\\').replace(/'/g, "''")}'`;

  console.error('\nCopy the line below into phpMyAdmin (your shop database -> SQL tab -> Go):\n');
  console.log(`INSERT INTO users (role_id, name, username, password_hash) SELECT id, ${quote(name)}, ${quote(username)}, ${quote(hash)} FROM roles WHERE code = 'owner';`);
  console.error('\nIt must say "1 row inserted". If it says 0 rows, run the base data file (seeds/001_base_data.sql) first.');
}

main().catch((err) => {
  console.error(`\nNot created: ${err.message}`);
  process.exitCode = 1;
});

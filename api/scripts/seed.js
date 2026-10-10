// Load base data and create the first Owner account. Safe to run repeatedly.
//   npm run seed
//
// The Owner's details come from OWNER_NAME, OWNER_USERNAME and OWNER_PASSWORD,
// or are asked for when run in a terminal. The password is hashed and is never
// written to a file. If an Owner already exists, none is created.
//
//   npm run seed -- --demo-customer
// also creates a customer for trying the portal login. Refused in production.
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline/promises');
const { isProduction } = require('../src/config/env');
const { connect } = require('./lib/connect');
const { hashSecret, newPin } = require('../src/lib/crypto');
const { username: usernameSchema, newPassword: passwordSchema } = require('../src/modules/auth/schemas');

const SEEDS_DIR = path.join(__dirname, '..', 'seeds');

async function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(question)).trim();
  } finally {
    rl.close();
  }
}

async function ownerDetails() {
  let { OWNER_NAME: name, OWNER_USERNAME: username, OWNER_PASSWORD: password } = process.env;
  if (!(username && password)) {
    if (!process.stdin.isTTY) return null;
    console.log('\nCreate the first Owner account.');
    name = name || (await ask('  Full name: '));
    username = username || (await ask('  Username: '));
    // Note: the password is visible while typing.
    password = password || (await ask('  Password (at least 10 characters): '));
  }
  const parsedUsername = usernameSchema.safeParse(username);
  const parsedPassword = passwordSchema.safeParse(password);
  if (!parsedUsername.success) throw new Error(`Owner username: ${parsedUsername.error.issues[0].message}`);
  if (!parsedPassword.success) throw new Error(`Owner password: ${parsedPassword.error.issues[0].message}`);
  return { name: (name || 'Owner').slice(0, 120), username: parsedUsername.data, password: parsedPassword.data };
}

async function ensureOwner(conn) {
  const [owners] = await conn.query("SELECT u.username FROM users u JOIN roles r ON r.id = u.role_id WHERE r.code = 'owner' LIMIT 1");
  if (owners.length > 0) {
    console.log(`Owner account already exists (${owners[0].username}); not creating another.`);
    return;
  }
  const details = await ownerDetails();
  if (!details) {
    console.log('No Owner account created: set OWNER_USERNAME and OWNER_PASSWORD, then run the seed again.');
    process.exitCode = 1;
    return;
  }
  const hash = await hashSecret(details.password);
  const [result] = await conn.query(
    "INSERT INTO users (role_id, name, username, password_hash) SELECT id, ?, ?, ? FROM roles WHERE code = 'owner'",
    [details.name, details.username, hash],
  );
  await conn.query(
    "INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, new_values) VALUES (NULL, 'user.create', 'user', ?, ?)",
    [result.insertId, JSON.stringify({ username: details.username, role: 'owner', via: 'seed' })],
  );
  console.log(`Owner account created: ${details.username}`);
}

async function ensureDemoCustomer(conn) {
  if (isProduction) throw new Error('--demo-customer is refused when NODE_ENV=production.');
  const phone = '01700000000';
  const [existing] = await conn.query('SELECT id, portal_pin FROM customers WHERE phone = ?', [phone]);
  if (existing.length > 0) {
    console.log(`Demo customer already exists: phone ${phone}, PIN ${existing[0].portal_pin || '(changed by the customer)'}`);
    return;
  }
  const pin = newPin();
  await conn.query(
    `INSERT INTO customers (name, phone, portal_pin, portal_password_hash, created_by)
     SELECT 'Demo Customer', ?, ?, ?, MIN(id) FROM users`,
    [phone, pin, await hashSecret(pin)],
  );
  console.log(`Demo customer created: phone ${phone}, PIN ${pin}`);
}

async function main() {
  const conn = await connect();
  try {
    for (const file of fs.readdirSync(SEEDS_DIR).filter((f) => f.endsWith('.sql')).sort()) {
      process.stdout.write(`Seeding ${file} ... `);
      await conn.query(fs.readFileSync(path.join(SEEDS_DIR, file), 'utf8'));
      console.log('done');
    }
    await ensureOwner(conn);
    if (process.argv.includes('--demo-customer')) await ensureDemoCustomer(conn);
  } finally {
    await conn.end();
  }
}

main().catch((err) => {
  console.error(`Seed failed: ${err.message}`);
  process.exitCode = 1;
});

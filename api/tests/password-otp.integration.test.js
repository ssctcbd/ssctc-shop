// Forgot password by a code sent to the Owner's email. Mail goes to a fake
// transport, so the tests read the code from the message that would have gone out.
Object.assign(process.env, { SMTP_HOST: 'mail.test', SMTP_FROM: 'SSCTC Shop <noreply@shop.test>' });

const { resetDatabase, startApp } = require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const OWNER = { username: 'owner', password: 'owner-password-1' };
const STAFF = { username: 'rahim', password: 'staff-password-1' };
const NEW_PASSWORD = 'brand-new-password-1';

let app;
let db;
let owner;
let staff;
let skipReason = false;
let ownerId;
const sent = [];
let mailFails = false;

test.before(async () => {
  try {
    await resetDatabase();
  } catch (err) {
    skipReason = `MySQL test database not reachable (${err.code || err.message}); see tests/helpers/setup.js`;
    return;
  }
  app = await startApp();
  db = require('../src/db/pool');
  require('../src/lib/mail').useTransport({
    sendMail: async (message) => {
      if (mailFails) throw new Error('connection refused');
      sent.push(message);
    },
  });
  const { hashSecret } = require('../src/lib/crypto');
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (1, 'Owner', ?, ?)", [OWNER.username, await hashSecret(OWNER.password)]);
  await db.query("INSERT INTO users (role_id, name, username, password_hash) VALUES (2, 'Rahim', ?, ?)", [STAFF.username, await hashSecret(STAFF.password)]);
  owner = app.client();
  staff = app.client();
  await owner.post('/auth/login', OWNER);
  await staff.post('/auth/login', STAFF);
  ownerId = (await db.query("SELECT id FROM users WHERE username = 'owner'"))[0].id;
});

test.after(async () => {
  if (app) await app.stop();
});

const it = (name, fn) => test(name, async (t) => (skipReason ? t.skip(skipReason) : fn(t)));
const visitor = () => app.client();
/** Mail is sent in the background: wait for it to arrive. */
async function nextMail(count) {
  for (let i = 0; i < 100 && sent.length < count; i += 1) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.ok(sent.length >= count, 'no mail arrived');
  return sent[count - 1];
}
const codeIn = (mail) => /\b(\d{6})\b/.exec(mail.text)[1];
/** As if the last code was asked for long ago, so the one-a-minute limit does not apply. */
const ageCodes = () => db.query('UPDATE owner_password_otps SET created_at = created_at - INTERVAL 2 HOUR');

it('an Owner saves the address with their password, and a test email tells them it works', async () => {
  assert.equal((await staff.get('/auth/recovery-email')).status, 403);
  assert.equal((await staff.post('/auth/recovery-email', { email: 'x@y.com', currentPassword: STAFF.password })).status, 403);
  const wrong = await owner.post('/auth/recovery-email', { email: 'owner@shop.test', currentPassword: 'not-my-password' });
  assert.equal(wrong.status, 400);
  assert.ok(wrong.body.error.details.fields.currentPassword);
  assert.equal((await owner.post('/auth/recovery-email', { email: 'not an email', currentPassword: OWNER.password })).status, 400);
  assert.deepEqual((await owner.get('/auth/recovery-email')).body, { email: null, mailReady: true });

  // Before an address is saved, asking sends nothing and looks the same.
  assert.equal((await visitor().post('/auth/forgot-password', { username: 'owner' })).status, 200);
  assert.equal(sent.length, 0);

  // A mail failure is reported to the Owner, not hidden.
  mailFails = true;
  const failed = await owner.post('/auth/recovery-email', { email: 'Owner@Shop.test', currentPassword: OWNER.password });
  assert.deepEqual(failed.body.test, { sent: false, error: 'connection refused' });
  mailFails = false;

  const res = await owner.post('/auth/recovery-email', { email: 'owner@shop.test', currentPassword: OWNER.password });
  assert.deepEqual([res.status, res.body.email, res.body.test], [200, 'owner@shop.test', { sent: true }]);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to, 'owner@shop.test');
});

it('asking for a code answers the same for anyone, and mails only an active Owner', async () => {
  const before = sent.length;
  for (const username of ['nobody', 'rahim']) {
    const res = await visitor().post('/auth/forgot-password', { username });
    assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  }
  const res = await visitor().post('/auth/forgot-password', { username: 'owner' });
  assert.deepEqual([res.status, res.body], [200, { ok: true }]);
  const mail = await nextMail(before + 1);
  assert.equal(sent.length, before + 1);
  assert.equal(mail.to, 'owner@shop.test');
  // Only the hash is stored.
  const [row] = await db.query('SELECT code_hash FROM owner_password_otps ORDER BY id DESC LIMIT 1');
  assert.ok(!row.code_hash.includes(codeIn(mail)));
});

it('codes cannot be asked for more than once a minute, or five times an hour', async () => {
  const before = sent.length;
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  assert.equal(sent.length, before);
  await ageCodes();
  await db.query('DELETE FROM owner_password_otps');
  // Five recent ones, none in the last minute.
  for (let i = 0; i < 5; i += 1) await db.query("INSERT INTO owner_password_otps (user_id, code_hash, expires_at, used_at, created_at) VALUES (?, 'x', UTC_TIMESTAMP(), UTC_TIMESTAMP(), UTC_TIMESTAMP() - INTERVAL 10 MINUTE)", [ownerId]);
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(sent.length, before);
  await db.query('DELETE FROM owner_password_otps');
});

it('a wrong code fails with one message; five wrong tries cancel the code', async () => {
  await db.query('DELETE FROM login_attempts');
  const count = sent.length + 1;
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  const code = codeIn(await nextMail(count));
  const wrongCode = code === '000000' ? '000001' : '000000';
  const body = { username: 'owner', code: wrongCode, newPassword: NEW_PASSWORD };

  const wrong = await visitor().post('/auth/reset-password', body);
  assert.equal(wrong.status, 400);
  const unknown = await visitor().post('/auth/reset-password', { ...body, username: 'nobody' });
  assert.equal(unknown.body.error.message, wrong.body.error.message);
  assert.equal((await visitor().post('/auth/reset-password', { ...body, username: 'rahim' })).status, 400);
  assert.equal((await visitor().post('/auth/reset-password', { ...body, code, newPassword: 'short' })).status, 400);

  for (let i = 0; i < 4; i += 1) await visitor().post('/auth/reset-password', body);
  const [row] = await db.query('SELECT attempts, used_at FROM owner_password_otps ORDER BY id DESC LIMIT 1');
  assert.equal(row.attempts, 5);
  assert.ok(row.used_at);
  await db.query('DELETE FROM login_attempts');
  // Now the right code no longer works either.
  assert.equal((await visitor().post('/auth/reset-password', { ...body, code })).status, 400);
  assert.equal((await visitor().post('/auth/login', OWNER)).status, 200);
});

it('guessing is locked out like guessing passwords', async () => {
  await db.query('DELETE FROM login_attempts');
  const body = { username: 'owner', code: '123456', newPassword: NEW_PASSWORD };
  for (let i = 0; i < 5; i += 1) assert.equal((await visitor().post('/auth/reset-password', body)).status, 400);
  assert.equal((await visitor().post('/auth/reset-password', body)).status, 429);
  await db.query('DELETE FROM login_attempts');
});

it('an expired code does not work, and a new code cancels the one before', async () => {
  await ageCodes();
  let count = sent.length + 1;
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  const first = codeIn(await nextMail(count));
  await db.query('UPDATE owner_password_otps SET expires_at = UTC_TIMESTAMP() - INTERVAL 1 SECOND WHERE used_at IS NULL');
  assert.equal((await visitor().post('/auth/reset-password', { username: 'owner', code: first, newPassword: NEW_PASSWORD })).status, 400);

  await ageCodes();
  count = sent.length + 1;
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  await nextMail(count);
  const live = await db.query('SELECT id FROM owner_password_otps WHERE used_at IS NULL');
  assert.equal(live.length, 1);
  await db.query('DELETE FROM login_attempts');
});

it('the right code sets the password once, ends every session, and sends a notice', async () => {
  await ageCodes();
  let count = sent.length + 1;
  await visitor().post('/auth/forgot-password', { username: 'owner' });
  const code = codeIn(await nextMail(count));

  count = sent.length + 1;
  // Typed with a space: still the same code.
  const res = await visitor().post('/auth/reset-password', { username: 'owner', code: `${code.slice(0, 3)} ${code.slice(3)}`, newPassword: NEW_PASSWORD });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  assert.match((await nextMail(count)).subject, /password was changed/);

  assert.equal((await owner.get('/auth/me')).status, 401);
  assert.equal((await visitor().post('/auth/login', OWNER)).status, 401);
  assert.equal((await visitor().post('/auth/login', { username: 'owner', password: NEW_PASSWORD })).status, 200);
  // Used once, never again.
  assert.equal((await visitor().post('/auth/reset-password', { username: 'owner', code, newPassword: 'another-password-1' })).status, 400);
  const log = await db.query("SELECT actor_user_id FROM audit_logs WHERE action = 'user.reset_password_otp'");
  assert.deepEqual(log.map((l) => Number(l.actor_user_id)), [Number(ownerId)]);
});

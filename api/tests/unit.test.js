require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone } = require('../src/lib/phone');
const { newToken, hashToken, newPin, hashSecret, verifySecret } = require('../src/lib/crypto');
const { loginSchema, changePasswordSchema } = require('../src/modules/auth/schemas');
const { changePinSchema } = require('../src/modules/portal/schemas');

test('normalizePhone accepts the common ways a Bangladeshi mobile is written', () => {
  assert.equal(normalizePhone('01712345678'), '01712345678');
  assert.equal(normalizePhone('+880 1712-345678'), '01712345678');
  assert.equal(normalizePhone('8801712345678'), '01712345678');
  assert.equal(normalizePhone('1712345678'), '01712345678');
  assert.equal(normalizePhone('০১৭১২৩৪৫৬৭৮'), '01712345678');
});

test('normalizePhone rejects anything that is not a mobile number', () => {
  for (const bad of ['', '0171234567', '017123456789', '01212345678', 'abc', '02712345678', null, 123]) {
    assert.equal(normalizePhone(bad), null, String(bad));
  }
});

test('session tokens are long, unique, and stored only as a SHA-256 hash', () => {
  const a = newToken();
  const b = newToken();
  assert.notEqual(a, b);
  assert.ok(a.length >= 43);
  assert.match(hashToken(a), /^[0-9a-f]{64}$/);
  assert.equal(hashToken(a), hashToken(a));
});

test('newPin is always exactly six digits', () => {
  for (let i = 0; i < 500; i++) assert.match(newPin(), /^\d{6}$/);
});

test('verifySecret is false for a wrong secret and for a missing account', async () => {
  const hash = await hashSecret('correct horse battery');
  assert.equal(await verifySecret('correct horse battery', hash), true);
  assert.equal(await verifySecret('wrong', hash), false);
  assert.equal(await verifySecret('not-a-real-password', undefined), false);
  assert.equal(await verifySecret('anything', null), false);
});

test('login schema lower-cases the username and rejects unknown fields', () => {
  assert.deepEqual(loginSchema.parse({ username: '  Admin ', password: 'x' }), { username: 'admin', password: 'x' });
  assert.equal(loginSchema.safeParse({ username: 'a', password: 'x', role: 'owner' }).success, false);
});

test('new passwords need at least 10 characters', () => {
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'short' }).success, false);
  assert.equal(changePasswordSchema.safeParse({ currentPassword: 'x', newPassword: 'long-enough-1' }).success, true);
});

test('a chosen PIN must be six digits and not trivially guessable', () => {
  assert.equal(changePinSchema.safeParse({ currentPin: '123456', newPin: '48213' }).success, false);
  assert.equal(changePinSchema.safeParse({ currentPin: '123456', newPin: '4821a3' }).success, false);
  assert.equal(changePinSchema.safeParse({ currentPin: '482139', newPin: '123456' }).success, false);
  assert.equal(changePinSchema.safeParse({ currentPin: '123456', newPin: '482139' }).success, true);
});

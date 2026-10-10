require('./helpers/setup');
const test = require('node:test');
const assert = require('node:assert/strict');

const { normalizePhone } = require('../src/lib/phone');
const { newToken, hashToken, newPin, hashSecret, verifySecret } = require('../src/lib/crypto');
const { loginSchema, changePasswordSchema } = require('../src/modules/auth/schemas');
const { changePinSchema } = require('../src/modules/portal/schemas');

test('money is converted to whole paisa and back without floating-point drift', () => {
  const { toPaisa, fromPaisa, isMoney } = require('../src/lib/money');
  assert.equal(toPaisa('460.50'), 46050);
  assert.equal(toPaisa('460.5'), 46050);
  assert.equal(toPaisa('0'), 0);
  assert.equal(fromPaisa(46050 * 10 + 23000 * 4), '5525.00');
  assert.equal(fromPaisa(toPaisa('0.10') + toPaisa('0.20')), '0.30'); // 0.1 + 0.2 in floats is 0.30000000000000004
  assert.equal(fromPaisa(5), '0.05');
  for (const bad of ['12.345', '-1', 'abc', '', '1e3', '1,000', ' 5']) assert.equal(isMoney(bad), false, bad);
  assert.throws(() => toPaisa('12.345'));
  assert.throws(() => fromPaisa(-1));
});

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

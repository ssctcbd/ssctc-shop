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

test('every route module loads, so a typo cannot hide behind skipped integration tests', () => {
  const { createApp } = require('../src/app');
  assert.equal(typeof createApp(), 'function');
});

test('commission: a percentage of what the line sold for, or a fixed amount per unit, never more than the line', () => {
  const { lineCommission } = require('../src/lib/commission');
  assert.equal(lineCommission(null, { valuePaisa: 50000, quantity: 1 }), 0);
  // 10% of 450.00 = 45.00; 12.5% of 99.99 = 12.49875 → 12.50
  assert.equal(lineCommission({ type: 'percent', value: '10.00' }, { valuePaisa: 45000, quantity: 1 }), 4500);
  assert.equal(lineCommission({ type: 'percent', value: '12.50' }, { valuePaisa: 9999, quantity: 3 }), 1250);
  // 0.50 a copy × 100 copies = 50.00
  assert.equal(lineCommission({ type: 'fixed', value: '0.50' }, { valuePaisa: 20000, quantity: 100 }), 5000);
  // A fixed rate on a line given away for almost nothing earns no more than the line brought in.
  assert.equal(lineCommission({ type: 'fixed', value: '5.00' }, { valuePaisa: 300, quantity: 2 }), 300);
});

test('commission: returning a line in parts takes back exactly what it earned, to the paisa', () => {
  const { returnedShare } = require('../src/lib/commission');
  // 1.00 earned on 3 units: 0.33 + 0.34 + 0.33 = 1.00
  const parts = [returnedShare(100, 3, 0, 1), returnedShare(100, 3, 1, 1), returnedShare(100, 3, 2, 1)];
  assert.equal(parts.reduce((a, b) => a + b, 0), 100);
  assert.equal(returnedShare(100, 3, 0, 3), 100);
  assert.equal(returnedShare(0, 5, 0, 2), 0);
});

test('commission rates: a percentage above 100 or a rate of zero is refused', () => {
  const { commissionProblem } = require('../src/lib/schemas');
  assert.equal(commissionProblem(null, '0.00'), null);
  assert.equal(commissionProblem('percent', '100.00'), null);
  assert.ok(commissionProblem('percent', '100.01').commissionValue);
  assert.ok(commissionProblem('fixed', '0.00').commissionValue);
  assert.equal(commissionProblem('fixed', '1000.00'), null);
});

test('the shop day runs until 4 in the morning, Dhaka time', (t) => {
  const { cashDate } = require('../src/lib/cash');
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-27T21:30:00Z') }); // 03:30 on the 28th in Dhaka
  assert.equal(cashDate(), '2026-10-27');
  t.mock.timers.setTime(Date.parse('2026-10-27T22:00:00Z')); // 04:00 on the 28th
  assert.equal(cashDate(), '2026-10-28');
  t.mock.timers.setTime(Date.parse('2026-10-28T17:59:00Z')); // 23:59 on the 28th
  assert.equal(cashDate(), '2026-10-28');
});

test('recovery codes are XXXXX-XXXXX, unambiguous, and matched ignoring case, spaces and dashes', () => {
  const { newRecoveryCode, hashRecoveryCode } = require('../src/lib/crypto');
  const { recoverSchema } = require('../src/modules/auth/schemas');
  const codes = new Set(Array.from({ length: 200 }, newRecoveryCode));
  assert.equal(codes.size, 200);
  for (const code of codes) assert.match(code, /^[A-HJ-NP-Z2-9]{5}-[A-HJ-NP-Z2-9]{5}$/);
  const [code] = codes;
  assert.equal(hashRecoveryCode(code.toLowerCase().replace('-', ' ')), hashRecoveryCode(code));
  const parsed = recoverSchema.parse({ username: 'Owner', code: ` ${code.toLowerCase()} `, newPassword: 'a-new-password-1' });
  assert.equal(parsed.code, code.replace('-', ''));
  assert.equal(recoverSchema.safeParse({ username: 'owner', code, newPassword: 'short' }).success, false);
});

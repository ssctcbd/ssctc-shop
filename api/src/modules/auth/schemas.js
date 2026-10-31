const { z } = require('zod');

const username = z.string().trim().toLowerCase().min(3).max(60).regex(/^[a-z0-9._-]+$/, 'Use letters, numbers, dot, dash or underscore.');

// PROJECT_PLAN.md §6: minimum 10 characters. bcrypt ignores input past 72 bytes.
const newPassword = z.string().min(10, 'Use at least 10 characters.').max(72, 'Use at most 72 characters.');

const loginSchema = z.strictObject({
  // Not validated against the username pattern: a malformed name is simply a failed login.
  username: z.string().trim().toLowerCase().min(1).max(60),
  password: z.string().min(1).max(200),
});

const changePasswordSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  newPassword,
});

// Recovery codes are shown as XXXXX-XXXXX; spaces, dashes and case are ignored.
const recoveryCode = z
  .string()
  .trim()
  .max(40)
  .transform((v) => v.toUpperCase().replace(/[^A-Z0-9]/g, ''));

const recoverSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(60),
  code: recoveryCode,
  newPassword,
});

const recoveryCodesSchema = z.strictObject({ currentPassword: z.string().min(1).max(200) });

const otpRequestSchema = z.strictObject({ username: z.string().trim().toLowerCase().min(1).max(60) });

const otpResetSchema = z.strictObject({
  username: z.string().trim().toLowerCase().min(1).max(60),
  // Six digits; a space typed in the middle is ignored.
  code: z.string().trim().max(20).transform((v) => v.replace(/\s/g, '')),
  newPassword,
});

const recoveryEmailSchema = z.strictObject({
  currentPassword: z.string().min(1).max(200),
  email: z.string().trim().toLowerCase().email('Enter a valid email address.').max(190).nullable(),
});

module.exports = { username, newPassword, loginSchema, changePasswordSchema, recoverSchema, recoveryCodesSchema, otpRequestSchema, otpResetSchema, recoveryEmailSchema };

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

module.exports = { username, newPassword, loginSchema, changePasswordSchema };

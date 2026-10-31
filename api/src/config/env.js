const path = require('node:path');
const { z } = require('zod');

// .env is for local development; on cPanel the variables come from the app form.
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), quiet: true });

const schema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  // Passenger may pass a named pipe instead of a number, so keep it a string.
  PORT: z.string().default('4000'),

  APP_BASE_URL: z.string().url(),
  API_BASE_PATH: z.string().regex(/^(\/[A-Za-z0-9_-]+)*$/, 'must be empty or start with "/"').default('/api'),
  CORS_ORIGIN: z.string().default(''),
  TRUST_PROXY: z.coerce.number().int().min(0).max(5).default(0),

  DB_HOST: z.string().default('127.0.0.1'),
  DB_PORT: z.coerce.number().int().default(3306),
  DB_NAME: z.string().min(1),
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string().default(''),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(20).default(5),

  SESSION_COOKIE_NAME: z.string().default('ssctc_sid'),
  SESSION_COOKIE_DOMAIN: z.string().default(''),
  SESSION_HOURS: z.coerce.number().positive().default(12),
  SESSION_IDLE_HOURS: z.coerce.number().positive().default(2),

  PORTAL_COOKIE_NAME: z.string().default('ssctc_cid'),
  PORTAL_SESSION_DAYS: z.coerce.number().positive().default(7),

  BCRYPT_COST: z.coerce.number().int().min(4).max(14).default(12),
  BACKUP_DIR: z.string().default(''),
  // The secret a cPanel cron job sends to start the nightly backup (empty = that endpoint is off).
  BACKUP_CRON_KEY: z.string().refine((v) => v === '' || v.length >= 32, 'must be at least 32 characters').default(''),
  // Google Drive copy of the nightly backup, made by `npm run gdrive-setup` (all four, or none).
  GDRIVE_CLIENT_ID: z.string().default(''),
  GDRIVE_CLIENT_SECRET: z.string().default(''),
  GDRIVE_REFRESH_TOKEN: z.string().default(''),
  GDRIVE_FOLDER_ID: z.string().default(''),
  // The mailbox that sends the Owner's password codes.
  SMTP_HOST: z.string().default(''),
  SMTP_PORT: z.coerce.number().int().default(465),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().default(''),
});

const parsed = schema.safeParse(process.env);
if (!parsed.success) {
  const problems = parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n');
  // Fail at startup, loudly, rather than run half-configured.
  throw new Error(`Invalid environment configuration:\n${problems}`);
}

const env = parsed.data;

const origins = new Set(
  [env.APP_BASE_URL, ...env.CORS_ORIGIN.split(',')]
    .map((o) => o.trim())
    .filter(Boolean)
    .map((o) => new URL(o).origin),
);

module.exports = {
  env,
  allowedOrigins: origins,
  isProduction: env.NODE_ENV === 'production',
};

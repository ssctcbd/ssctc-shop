const crypto = require('node:crypto');
const bcrypt = require('bcryptjs');
const { env } = require('../config/env');

/** A new session token: 256 random bits, URL-safe. Only its hash is stored. */
function newToken() {
  return crypto.randomBytes(32).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function hashSecret(plain) {
  return bcrypt.hash(plain, env.BCRYPT_COST);
}

// Compared against when the account does not exist, so a wrong username and a
// wrong password take the same time.
const DUMMY_HASH = bcrypt.hashSync('not-a-real-password', env.BCRYPT_COST);

function verifySecret(plain, hash) {
  return bcrypt.compare(plain, hash || DUMMY_HASH).then((ok) => ok && Boolean(hash));
}

/** Uniformly random 6-digit PIN, leading zeros allowed. */
function newPin() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
}

module.exports = { newToken, hashToken, hashSecret, verifySecret, newPin };

const { env, isProduction } = require('../config/env');

function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    if (part.slice(0, eq).trim() === name) {
      try {
        return decodeURIComponent(part.slice(eq + 1).trim());
      } catch {
        return null;
      }
    }
  }
  return null;
}

function baseOptions() {
  const options = {
    httpOnly: true,
    secure: isProduction, // browsers accept non-Secure cookies only on http://localhost
    sameSite: 'lax',
    path: '/',
  };
  if (env.SESSION_COOKIE_DOMAIN) options.domain = env.SESSION_COOKIE_DOMAIN;
  return options;
}

function setSessionCookie(res, name, token, expiresAt) {
  res.cookie(name, token, { ...baseOptions(), expires: expiresAt });
}

function clearSessionCookie(res, name) {
  res.clearCookie(name, baseOptions());
}

module.exports = { readCookie, setSessionCookie, clearSessionCookie };

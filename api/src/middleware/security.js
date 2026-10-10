const { allowedOrigins } = require('../config/env');
const { forbidden, badRequest } = require('../lib/errors');

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CORS for the configured origins only. Needed in development (web on :3000,
 * API on :4000) and in the fallback layout where the API has its own subdomain.
 * In the primary same-origin layout browsers send no cross-origin requests.
 */
function cors(req, res, next) {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    res.setHeader('Vary', 'Origin');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
      return res.status(204).end();
    }
  }
  next();
}

/**
 * CSRF defence alongside SameSite=Lax cookies: a state-changing request must
 * come from one of our own origins and carry a JSON body.
 */
function csrfGuard(req, _res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.headers.origin;
  if (origin) {
    if (!allowedOrigins.has(origin)) return next(forbidden('Request origin not allowed.'));
  } else if (req.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(req.headers['sec-fetch-site'])) {
    // A browser that omitted Origin but says the request is cross-site.
    return next(forbidden('Request origin not allowed.'));
  }

  const hasBody = Number(req.headers['content-length'] || 0) > 0 || req.headers['transfer-encoding'];
  if (hasBody && !req.is('application/json')) {
    return next(badRequest('Content-Type must be application/json.'));
  }
  next();
}

/** API responses are private and must never be cached by browsers or proxies. */
function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store');
  next();
}

module.exports = { cors, csrfGuard, noStore };

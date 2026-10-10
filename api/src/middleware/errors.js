const { AppError, notFound } = require('../lib/errors');
const { isProduction } = require('../config/env');

function notFoundHandler(_req, _res, next) {
  next(notFound('No such endpoint.'));
}

// eslint-disable-next-line no-unused-vars
function errorHandler(err, req, res, _next) {
  if (err instanceof AppError) {
    return res.status(err.status).json({ error: { code: err.code, message: err.message, ...(err.details ? { details: err.details } : {}) } });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'bad_request', message: 'Request body is not valid JSON.' } });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'too_large', message: 'Request body is too large.' } });
  }

  // Unexpected: log for the developer, tell the client nothing about internals.
  console.error(`[error] ${req.method} ${req.originalUrl}:`, err);
  res.status(500).json({
    error: { code: 'internal_error', message: 'Something went wrong. Please try again.', ...(isProduction ? {} : { debug: String(err && err.message) }) },
  });
}

module.exports = { notFoundHandler, errorHandler };

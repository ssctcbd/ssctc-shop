const { badRequest, notFound } = require('../lib/errors');

/**
 * Validate req.body against a zod schema. Schemas are strict, so unknown fields
 * are rejected. The parsed value replaces req.body.
 */
function validateBody(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body ?? {});
    if (!result.success) {
      const fields = {};
      for (const issue of result.error.issues) {
        const key = issue.path.join('.') || '_';
        if (!fields[key]) fields[key] = issue.message;
      }
      return next(badRequest('Please check the highlighted fields.', { fields }));
    }
    req.body = result.data;
    next();
  };
}

/**
 * Validate the query string. The parsed value is put on req.q (Express 5 makes
 * req.query read-only).
 */
function validateQuery(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.query);
    if (!result.success) {
      const issue = result.error.issues[0];
      return next(badRequest(`Invalid filter "${issue.path.join('.')}": ${issue.message}`));
    }
    req.q = result.data;
    next();
  };
}

/** Validate a numeric :id route parameter and put it on req.id. */
function idParam(req, _res, next) {
  const value = Number(req.params.id);
  if (!Number.isSafeInteger(value) || value < 1) return next(notFound());
  req.id = value;
  next();
}

module.exports = { validateBody, validateQuery, idParam };

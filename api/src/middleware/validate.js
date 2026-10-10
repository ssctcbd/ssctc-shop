const { badRequest } = require('../lib/errors');

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

module.exports = { validateBody };

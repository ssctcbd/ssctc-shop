class AppError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

const badRequest = (message, details) => new AppError(400, 'bad_request', message, details);
const unauthenticated = (message = 'Please log in.') => new AppError(401, 'unauthenticated', message);
const forbidden = (message = 'You do not have permission to do this.') => new AppError(403, 'forbidden', message);
const notFound = (message = 'Not found.') => new AppError(404, 'not_found', message);
const conflict = (message, details) => new AppError(409, 'conflict', message, details);
const tooManyRequests = (message, details) => new AppError(429, 'too_many_requests', message, details);

module.exports = { AppError, badRequest, unauthenticated, forbidden, notFound, conflict, tooManyRequests };

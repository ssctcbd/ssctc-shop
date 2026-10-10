// Thin client for the Express API. Cookies carry the session, so every request
// sends credentials; the browser never sees or stores the session token itself.

const BASE = process.env.NEXT_PUBLIC_API_URL || '/api/v1';

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }

  /** Field-level messages from validation, keyed by field name. */
  get fields() {
    return (this.details && this.details.fields) || {};
  }
}

async function request(method, path, body) {
  let res;
  try {
    res = await fetch(BASE + path, {
      method,
      credentials: 'include',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Cannot reach the server. Check the internet connection and try again.');
  }

  let data = null;
  try {
    data = await res.json();
  } catch {
    // A non-JSON reply (for example the host's own error page).
  }

  if (!res.ok) {
    const err = (data && data.error) || {};
    throw new ApiError(res.status, err.code || 'error', err.message || 'Something went wrong. Please try again.', err.details);
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body = {}) => request('POST', path, body),
  put: (path, body = {}) => request('PUT', path, body),
};

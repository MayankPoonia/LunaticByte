// Small fetch wrapper. The session token lives in sessionStorage, so each browser tab can be signed
// in as a different demo user (for example analyst in one tab, cardholder in another).
const KEY = 'fraudshield.session';

export function getSession() {
  try {
    return JSON.parse(sessionStorage.getItem(KEY) || 'null');
  } catch {
    return null;
  }
}

export function setSession(session) {
  if (session) sessionStorage.setItem(KEY, JSON.stringify(session));
  else sessionStorage.removeItem(KEY);
}

export class ApiError extends Error {
  constructor(status, body) {
    super((body && body.message) || `Request failed (${status})`);
    this.status = status;
    this.body = body || {};
  }
}

export async function api(path, { method = 'GET', body, raw = false } = {}) {
  const session = getSession();
  const headers = { 'content-type': 'application/json' };
  if (session) headers.authorization = `Bearer ${session.token}`;
  const res = await fetch(`/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (raw) return res;
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { message: text };
  }
  if (res.status === 401 && session && !path.startsWith('/auth/login')) {
    setSession(null);
    window.location.assign('/login');
  }
  if (!res.ok) throw new ApiError(res.status, data);
  return { data, status: res.status, headers: res.headers };
}

// Human-readable message for an API error, with field details when present.
export function errorText(err) {
  if (!err) return '';
  if (err.body && Array.isArray(err.body.fields) && err.body.fields.length) {
    return err.body.fields.map((f) => `${f.field}: ${f.message}`).join('; ');
  }
  if (err.status === 0 || err.message === 'Failed to fetch') return 'The server could not be reached. Check that the services are running and try again.';
  return err.message;
}

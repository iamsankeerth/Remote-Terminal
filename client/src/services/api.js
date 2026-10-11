const BASE_URL = '';

let csrfToken = null;

/**
 * Obtains the double-submit token. The server echoes the value it also stores in a non HttpOnly
 * cookie, so a mutation carries the same value in the `x-csrf-token` header.
 */
export async function ensureCsrf(force = false) {
  if (csrfToken && !force) return csrfToken;
  try {
    const response = await fetch(`${BASE_URL}/api/auth/csrf`, {
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
    });
    const data = await response.json().catch(() => ({}));
    if (typeof data?.csrfToken === 'string' && data.csrfToken.length > 0) {
      csrfToken = data.csrfToken;
    }
  } catch {
    /* the server may be unreachable; the retry below will fetch again */
  }
  return csrfToken;
}

/** Kept for callers that receive a token from the server (login response, status payload). */
export function setCsrfToken(token) {
  csrfToken = typeof token === 'string' && token.length > 0 ? token : null;
}

export function clearCsrfToken() {
  csrfToken = null;
}

async function request(path, { method = 'GET', body, headers = {}, retryOnCsrfFailure = true } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
    // A mutation needs the token; fetch it on first use if the caller has not yet.
    const token = csrfToken ?? (await ensureCsrf());
    if (token) init.headers['x-csrf-token'] = token;
  }
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};

  // A stale token (server restarted) is refreshed once and the request retried.
  if (response.status === 403 && json?.error?.code === 'forbidden' && retryOnCsrfFailure && body !== undefined) {
    await ensureCsrf(true);
    return request(path, { method, body, headers, retryOnCsrfFailure: false });
  }

  if (!response.ok) {
    const error = new Error(json?.error?.message ?? `Request failed with ${response.status}`);
    error.code = json?.error?.code ?? 'http_error';
    error.status = response.status;
    throw error;
  }
  if (typeof json?.csrfToken === 'string') {
    csrfToken = json.csrfToken;
  }
  return json;
}

export const api = {
  ensureCsrf,
  setCsrfToken,
  clearCsrfToken,
  login: (username, password) => request('/api/auth/login', { method: 'POST', body: { username, password } }),
  logout: () => request('/api/auth/logout', { method: 'POST', body: {} }),
  me: () => request('/api/auth/me'),
  listSessions: () => request('/api/sessions'),
  createSession: (label, cols = 80, rows = 24) => request('/api/sessions', { method: 'POST', body: { label, cols, rows } }),
  renameSession: (id, label) => request(`/api/sessions/${id}`, { method: 'PATCH', body: { label } }),
  terminateSession: (id) => request(`/api/sessions/${id}`, { method: 'DELETE', body: { confirm: true } }),
  systemStatus: () => request('/api/system/status'),
};

export default api;

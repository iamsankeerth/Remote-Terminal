const BASE_URL = '';

let csrfToken = null;

export function setCsrfToken(token) {
  csrfToken = token;
}

async function request(path, { method = 'GET', body, headers = {} } = {}) {
  const init = {
    method,
    credentials: 'same-origin',
    headers: { accept: 'application/json', ...headers },
  };
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
    if (csrfToken) init.headers['x-csrf-token'] = csrfToken;
  }
  const response = await fetch(`${BASE_URL}${path}`, init);
  const text = await response.text();
  const json = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const error = new Error(json?.error?.message ?? `Request failed with ${response.status}`);
    error.code = json?.error?.code ?? 'http_error';
    error.status = response.status;
    throw error;
  }
  if (json.csrfToken) {
    csrfToken = json.csrfToken;
  }
  return json;
}

export const api = {
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

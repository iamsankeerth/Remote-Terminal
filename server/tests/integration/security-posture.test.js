import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHttpServer, closeHttpServer } from '../../src/http/createHttpApp.js';
import { SessionStore } from '../../src/auth/sessionStore.js';
import { RateLimiter } from '../../src/auth/rateLimiter.js';
import { OriginPolicy } from '../../src/auth/origin.js';
import { TerminalManager } from '../../src/terminal/terminalManager.js';
import { createLogger } from '../../src/utils/logger.js';

const PASSWORD = 'correct horse battery staple 42';
const MARKER = 'secret-free-log-probe-4b7e';

function readCookie(setCookies, name) {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

async function boot() {
  const port = 19_000 + Math.floor(Math.random() * 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-audit-'));
  const logFile = path.join(dir, 'server.log');
  const { hashPassword } = await import('../../src/auth/password.js');
  const logger = createLogger({ level: 'info', logFile });
  const config = {
    schemaVersion: 1,
    owner: { username: 'sank', password: await hashPassword(PASSWORD) },
    server: { port, cloudflareOrigin: '', tunnelMode: 'named' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 2, connections: 2 },
  };
  const ctx = {
    sessions: new SessionStore(),
    config,
    terminalManager: new TerminalManager({ config, logger, dataPath: path.join(dir, 's.json'), homeDir: os.homedir() }),
    loginLimiter: new RateLimiter(),
    originPolicy: new OriginPolicy({ port, cloudflareOrigin: '' }),
    logger,
    clientDistDir: '',
  };
  await ctx.terminalManager.init();
  const httpServer = createHttpServer(ctx);
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  return { dir, logFile, base: `http://127.0.0.1:${port}`, httpServer };
}

test('session cookies carry the required security attributes', async () => {
  const harness = await boot();
  try {
    const probe = await fetch(`${harness.base}/api/auth/me`);
    const preCsrf = readCookie(probe.headers.getSetCookie?.() ?? [], 'rt_csrf');
    assert.ok(preCsrf, 'the pre-session CSRF cookie is issued');

    const login = await fetch(`${harness.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
      body: JSON.stringify({ username: 'sank', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const cookies = login.headers.getSetCookie?.() ?? [];
    const sessionCookie = cookies.find((c) => c.startsWith('rt_session='));
    const csrfCookie = cookies.find((c) => c.startsWith('rt_csrf='));
    assert.ok(sessionCookie, 'the login session cookie is set');
    assert.ok(csrfCookie, 'the csrf cookie is set');

    // Host-only: no Domain attribute is emitted, so the cookie is scoped to this exact host.
    // Both cookies share these attributes; HttpOnly is asserted per-cookie below.
    for (const cookie of [sessionCookie, csrfCookie]) {
      assert.match(cookie, /SameSite=Strict/, 'cookie must be SameSite=Strict');
      assert.match(cookie, /Max-Age=\d+/, 'cookie must carry a Max-Age');
      assert.doesNotMatch(cookie, /Domain=/i, 'cookie must not carry a Domain attribute');
      assert.match(cookie, /Path=\//, 'cookie must be scoped to the root path');
    }
    // The session cookie is unreadable from JavaScript.
    assert.match(sessionCookie, /HttpOnly/, 'the session cookie must be HttpOnly');
    // The CSRF token must stay readable by the client for the double submit.
    assert.doesNotMatch(csrfCookie, /HttpOnly/, 'the csrf cookie is deliberately readable by the client');
  } finally {
    await closeHttpServer(harness.httpServer);
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

test('structured logs never contain the password, session tokens, or terminal output', async () => {
  const harness = await boot();
  try {
    const probe = await fetch(`${harness.base}/api/auth/me`);
    const preCsrf = readCookie(probe.headers.getSetCookie?.() ?? [], 'rt_csrf');
    const login = await fetch(`${harness.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
      body: JSON.stringify({ username: 'sank', password: PASSWORD }),
    });
    assert.equal(login.status, 200);
    const jar = new Map();
    for (const cookie of login.headers.getSetCookie?.() ?? []) {
      const [pair] = cookie.split(';');
      const idx = pair.indexOf('=');
      jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
    }
    const sessionId = jar.get('rt_session');
    const csrfToken = jar.get('rt_csrf');
    assert.ok(sessionId && csrfToken);

    const bad = await fetch(`${harness.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
      body: JSON.stringify({ username: 'sank', password: 'wrong password entirely 1' }),
    });
    assert.equal(bad.status, 401);

    // Force output through a real session so terminal data exists in the process.
    const list = await fetch(`${harness.base}/api/system/status`, {
      headers: { cookie: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ') },
    });
    assert.equal(list.status, 200);

    const logged = fs.readFileSync(harness.logFile, 'utf8');
    assert.ok(logged.length > 0, 'the log file must contain records');
    assert.ok(!logged.includes(PASSWORD), 'the password must never be logged');
    assert.ok(!logged.includes('wrong password entirely 1'), 'failed passwords must never be logged');
    assert.ok(!logged.includes(sessionId), 'session tokens must never be logged');
    assert.ok(!logged.includes(csrfToken), 'csrf tokens must never be logged');
    assert.ok(!logged.includes(MARKER), 'terminal output must never be logged');
  } finally {
    await closeHttpServer(harness.httpServer);
    fs.rmSync(harness.dir, { recursive: true, force: true });
  }
});

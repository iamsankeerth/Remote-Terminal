import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Locks in the tunnel access rules from docs/adr/0004-quick-tunnel-by-default.md:
 *
 *  - tunnel mode ON  : a request that arrived through Cloudflare (cf-ray header) is allowed with a
 *                      valid Login Session, and is rejected without one.
 *  - tunnel mode OFF : the same request still fails closed with a Cloudflare 403.
 *
 * The application login, CSRF, and cookie validation are never skipped in either mode.
 */

function readCookie(setCookies, name) {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

async function loginAndGetCookies(base) {
  const probe = await fetch(`${base}/api/auth/me`);
  assert.equal(probe.status, 401);
  const preCsrf = readCookie(probe.headers.getSetCookie?.() ?? [], 'rt_csrf');
  assert.ok(preCsrf);

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
    body: JSON.stringify({ username: 'sank', password: 'correct horse battery staple 42' }),
  });
  assert.equal(login.status, 200);
  const jar = new Map();
  for (const cookie of login.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  return { cookieHeader, csrfToken: jar.get('rt_csrf') };
}

async function withServer(t, { assertionRequired, tunnelActive }, body) {
  const port = 19_000 + Math.floor(Math.random() * 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-tunnel-'));
  const { hashPassword } = await import('../../src/auth/password.js');
  const passwordRecord = await hashPassword('correct horse battery staple 42');
  const config = {
    schemaVersion: 1,
    owner: { username: 'sank', password: passwordRecord },
    server: { port, cloudflareOrigin: '', tunnelMode: 'quick' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 1, connections: 1 },
  };
  const { createHttpServer, closeHttpServer } = await import('../../src/http/createHttpApp.js');
  const { SessionStore } = await import('../../src/auth/sessionStore.js');
  const { RateLimiter } = await import('../../src/auth/rateLimiter.js');
  const { OriginPolicy } = await import('../../src/auth/origin.js');
  const { CloudflareAssertionValidator } = await import('../../src/auth/cloudflare.js');
  const { TerminalManager } = await import('../../src/terminal/terminalManager.js');
  const { createLogger } = await import('../../src/utils/logger.js');

  const logger = createLogger({ level: 'error' });
  const ctx = {
    sessions: new SessionStore(),
    config,
    terminalManager: new TerminalManager({ config, logger, dataPath: path.join(dir, 's.json'), homeDir: os.homedir() }),
    loginLimiter: new RateLimiter(),
    originPolicy: new OriginPolicy({ port, cloudflareOrigin: '' }),
    logger,
    clientDistDir: '',
    assertionValidator: new CloudflareAssertionValidator({ teamDomain: '', aud: 'aud-test', ownerEmail: 'you@example.com', logger }),
  };
  await ctx.terminalManager.init();
  if (assertionRequired !== undefined) ctx.assertionRequired = assertionRequired;
  if (tunnelActive !== undefined) ctx.tunnelActive = tunnelActive;
  const httpServer = createHttpServer(ctx);
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  try {
    await body({ base: `http://127.0.0.1:${port}` });
  } finally {
    await closeHttpServer(httpServer);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Cloudflare headers that only a request arriving through the edge would carry.
const CLOUDFLARE_HEADERS = { 'cf-ray': 'abcdef0123456789-LAX', 'cf-connecting-ip': '203.0.113.9' };

test('tunnel mode ON: browser requests without an Origin header are accepted', async (t) => {
  // Regression: a phone browser loading https://<tunnel> sends no Origin header and a Host of the
  // tunnel hostname, so the loopback-only origin rule must not reject it.
  await withServer(t, { assertionRequired: () => false, tunnelActive: () => true }, async ({ base }) => {
    const unauthenticated = await fetch(`${base}/api/auth/me`, { headers: CLOUDFLARE_HEADERS });
    assert.equal(unauthenticated.status, 401, 'no Origin header must not become an origin rejection');
    assert.ok(readCookie(unauthenticated.headers.getSetCookie?.() ?? [], 'rt_csrf'), 'the pre-session CSRF cookie is issued');

    const { cookieHeader } = await loginAndGetCookies(base);
    const me = await fetch(`${base}/api/auth/me`, { headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader } });
    assert.equal(me.status, 200);
  });
});

test('tunnel mode ON: a foreign Origin header is still rejected through the tunnel', async (t) => {
  await withServer(t, { assertionRequired: () => false, tunnelActive: () => true }, async ({ base }) => {
    const { cookieHeader, csrfToken } = await loginAndGetCookies(base);
    const hostile = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        origin: 'https://evil.example.com',
        ...CLOUDFLARE_HEADERS,
      },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    assert.equal(hostile.status, 403, 'a present but foreign Origin is still rejected');
  });
});

test('tunnel mode ON: Cloudflare traffic needs a valid Login Session and nothing more', async (t) => {
  await withServer(t, { assertionRequired: () => false }, async ({ base }) => {
    const unauthenticated = await fetch(`${base}/api/auth/me`, { headers: CLOUDFLARE_HEADERS });
    assert.equal(unauthenticated.status, 401, 'an unauthenticated tunnel request is still rejected');

    const { cookieHeader } = await loginAndGetCookies(base);
    const me = await fetch(`${base}/api/auth/me`, { headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader } });
    assert.equal(me.status, 200, 'a logged-in owner may use the tunnel without an Access assertion');
    const body = await me.json();
    assert.equal(body.authenticated, true);
  });
});

test('tunnel mode ON: CSRF is still enforced on mutations', async (t) => {
  await withServer(t, { assertionRequired: () => false }, async ({ base }) => {
    const { cookieHeader, csrfToken } = await loginAndGetCookies(base);
    const forged = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': 'wrong', ...CLOUDFLARE_HEADERS },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    assert.equal(forged.status, 403, 'tunnel mode must not weaken CSRF protection');

    // A malformed body with the correct CSRF token still fails validation.
    const badBody = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken, ...CLOUDFLARE_HEADERS },
      body: JSON.stringify({ cols: -5, rows: 24 }),
    });
    assert.equal(badBody.status, 400);
  });
});

test('tunnel mode OFF: Cloudflare traffic without an Access assertion still fails closed', async (t) => {
  // Default context: no assertionRequired callback, which means Access is required.
  await withServer(t, {}, async ({ base }) => {
    const { cookieHeader } = await loginAndGetCookies(base);
    const me = await fetch(`${base}/api/auth/me`, { headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader } });
    assert.equal(me.status, 403, 'the Access assertion requirement is never silently dropped');

    // The same request without Cloudflare headers is served normally.
    const plain = await fetch(`${base}/api/auth/me`, { headers: { cookie: cookieHeader } });
    assert.equal(plain.status, 200);
  });
});

test('tunnel mode ON: a foreign Origin is still rejected even with a valid session', async (t) => {
  await withServer(t, { assertionRequired: () => false }, async ({ base }) => {
    const { cookieHeader, csrfToken } = await loginAndGetCookies(base);
    const hostile = await fetch(`${base}/api/sessions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        cookie: cookieHeader,
        'x-csrf-token': csrfToken,
        origin: 'https://evil.example.com',
        ...CLOUDFLARE_HEADERS,
      },
      body: JSON.stringify({ cols: 80, rows: 24 }),
    });
    assert.equal(hostile.status, 403, 'the strict Origin policy applies in tunnel mode too');
  });
});

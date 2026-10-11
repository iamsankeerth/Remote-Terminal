import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, sign } from 'node:crypto';
import { hashPassword } from '../../src/auth/password.js';

/**
 * Cloudflare Access assertion behaviour.
 *
 * The rejection paths are exercised with an empty validator; the acceptance path is exercised
 * against a real RSA key and a local JWKS endpoint, because a quick tunnel cannot be used in a
 * unit test.
 */

const MARKER_PASSWORD = 'correct horse battery staple 42';

function readCookie(setCookies, name) {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

async function startHarness(t, { tokens }) {
  const port = 19_000 + Math.floor(Math.random() * 900);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-jwt-'));
  const { createHttpServer, closeHttpServer } = await import('../../src/http/createHttpApp.js');
  const { SessionStore } = await import('../../src/auth/sessionStore.js');
  const { RateLimiter } = await import('../../src/auth/rateLimiter.js');
  const { OriginPolicy } = await import('../../src/auth/origin.js');
  const { CloudflareAssertionValidator } = await import('../../src/auth/cloudflare.js');
  const { TerminalManager } = await import('../../src/terminal/terminalManager.js');
  const { createLogger } = await import('../../src/utils/logger.js');

  const logger = createLogger({ level: 'error' });
  const config = {
    schemaVersion: 1,
    owner: { username: 'sank', password: await hashPassword(MARKER_PASSWORD) },
    server: { port, cloudflareOrigin: '', tunnelMode: 'named' },
    cloudflare: { hostname: 'terminal.example.com', teamDomain: 'myteam', aud: 'aud-test', ownerEmail: 'you@example.com' },
    limits: { sessions: 1, connections: 1 },
  };

  const ctx = {
    sessions: new SessionStore(),
    config,
    terminalManager: new TerminalManager({ config, logger, dataPath: path.join(dir, 's.json'), homeDir: os.homedir() }),
    loginLimiter: new RateLimiter(),
    originPolicy: new OriginPolicy({ port, cloudflareOrigin: '' }),
    logger,
    clientDistDir: '',
    assertionValidator: new CloudflareAssertionValidator({
      teamDomain: 'myteam',
      aud: 'aud-test',
      ownerEmail: 'you@example.com',
      fetchImpl: tokens.jwksFetch,
      logger,
    }),
  };
  await ctx.terminalManager.init();
  const httpServer = createHttpServer(ctx);
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));
  return {
    base: `http://127.0.0.1:${port}`,
    async close() {
      await closeHttpServer(httpServer);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function loginAndCookies(base) {
  const probe = await fetch(`${base}/api/auth/me`);
  const preCsrf = readCookie(probe.headers.getSetCookie?.() ?? [], 'rt_csrf');
  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
    body: JSON.stringify({ username: 'sank', password: MARKER_PASSWORD }),
  });
  assert.equal(login.status, 200);
  const jar = new Map();
  for (const cookie of login.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  return { cookieHeader: [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; '), jar };
}

const CLOUDFLARE_HEADERS = { 'cf-ray': 'abcdef0123456789-LAX', 'cf-connecting-ip': '203.0.113.9' };

test('a valid Access assertion is accepted and the request is served', async (t) => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const kid = 'test-key-1';
  // Node's JWK export omits kid, so it is added explicitly the way Cloudflare's JWKS does.
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid };

  const nowSeconds = Math.floor(Date.now() / 1000);
  const mint = (claims) => {
    const header = { alg: 'RS256', typ: 'JWT', kid };
    const payload = {
      iss: 'https://myteam.cloudflareaccess.com',
      aud: ['aud-test'],
      exp: nowSeconds + 600,
      type: 'app',
      email: 'you@example.com',
      ...claims,
    };
    const signed = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`;
    const signature = sign('RSA-SHA256', Buffer.from(signed), privateKey);
    return `${signed}.${signature.toString('base64url')}`;
  };

  const harness = await startHarness(t, {
    tokens: { jwksFetch: async () => ({ ok: true, json: async () => ({ keys: [jwk] }) }) },
  });

  try {
    const { cookieHeader } = await loginAndCookies(harness.base);
    const accepted = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': mint({}) },
    });
    assert.equal(accepted.status, 200, 'a correctly signed assertion with the pinned email must be accepted');

    const wrongEmail = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': mint({ email: 'attacker@example.com' }) },
    });
    assert.equal(wrongEmail.status, 403, 'a different email must be rejected');

    const expired = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': mint({ exp: nowSeconds - 10 }) },
    });
    assert.equal(expired.status, 403, 'an expired assertion must be rejected');

    const wrongAud = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': mint({ aud: ['other-aud'] }) },
    });
    assert.equal(wrongAud.status, 403, 'a wrong audience must be rejected');

    const wrongIssuer = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assrtion': '', 'cf-access-jwt-assertion': mint({ iss: 'https://evil.example.com' }) },
    });
    assert.equal(wrongIssuer.status, 403, 'a wrong issuer must be rejected');

    const malformed = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': 'not-a-jwt' },
    });
    assert.equal(malformed.status, 403, 'a malformed assertion must be rejected');

    const missing = await fetch(`${harness.base}/api/auth/me`, { headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader } });
    assert.equal(missing.status, 403, 'a missing assertion must be rejected');
  } finally {
    await harness.close();
  }
});

test('an unavailable JWKS with no cache fails closed', async (t) => {
  const harness = await startHarness(t, {
    tokens: {
      jwksFetch: async () => {
        throw new Error('network down');
      },
    },
  });

  try {
    const { cookieHeader } = await loginAndCookies(harness.base);
    const response = await fetch(`${harness.base}/api/auth/me`, {
      headers: { ...CLOUDFLARE_HEADERS, cookie: cookieHeader, 'cf-access-jwt-assertion': 'a.b.c' },
    });
    assert.equal(response.status, 403, 'a JWKS outage must deny rather than allow');
  } finally {
    await harness.close();
  }
});

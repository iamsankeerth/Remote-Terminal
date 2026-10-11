import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword, assertArgon2Available } from '../../src/auth/password.js';
import { assertValidPassword } from '../../../shared/src/protocol.js';
import { SessionStore } from '../../src/auth/sessionStore.js';
import { RateLimiter } from '../../src/auth/rateLimiter.js';
import { OriginPolicy, isLoopbackOrigin } from '../../src/auth/origin.js';

test('native argon2id is available', () => {
  assert.doesNotThrow(() => assertArgon2Available());
});

test('passwords hash and verify with argon2id using a random salt', async () => {
  const password = 'correct horse battery staple 42';
  assertValidPassword(password);
  const record = await hashPassword(password);
  assert.equal(record.algorithm, 'argon2id');
  assert.equal(Buffer.from(record.saltBase64, 'base64').length, 16);
  assert.ok(record.params.memoryCost >= 19456);
  assert.ok(!JSON.stringify(record).includes(password));
  const second = await hashPassword(password);
  assert.notEqual(second.saltBase64, record.saltBase64, 'salts must be random');
  assert.ok(await verifyPassword(password, record));
  assert.ok(await verifyPassword(password, second));
  assert.ok(!(await verifyPassword('wrong password entirely 1', record)));
    assert.ok(!(await verifyPassword(password, { algorithm: 'bcrypt' })));
  assert.ok(!(await verifyPassword(password, null)));
});

test('login sessions are opaque, sliding, and revocable', () => {
  let now = 1_000_000;
  const store = new SessionStore({ slidingMs: 30 * 24 * 60 * 60 * 1000, now: () => now });
  const session = store.create();
  assert.equal(session.id.length >= 40, true);
  assert.equal(store.get(session.id).id, session.id);
  now += 40 * 24 * 60 * 60 * 1000;
  assert.equal(store.get(session.id), null, 'sessions expire after the sliding window');
  const live = store.create();
  store.revoke(live.id);
  assert.equal(store.get(live.id), null);
});

test('restart revokes all sessions', () => {
  const store = new SessionStore();
  store.create();
  store.create();
  assert.equal(store.size(), 2);
  assert.equal(store.revokeAll(), 2);
  assert.equal(store.size(), 0);
});

test('csrf token rotation is per session', () => {
  const store = new SessionStore();
  const session = store.create();
  const first = store.rotateCsrf(session.id);
  const second = store.rotateCsrf(session.id);
  assert.notEqual(first, second);
});

test('login rate limiting blocks the sixth attempt', () => {
  let now = 0;
  const limiter = new RateLimiter({ attempts: 5, windowMs: 60_000, now: () => now });
  for (let i = 0; i < 5; i += 1) assert.equal(limiter.hit('client').blocked, false);
  const blocked = limiter.hit('client');
  assert.equal(blocked.blocked, true);
  assert.ok(blocked.retryAfterMs > 0);
  now += 61_000;
  assert.equal(limiter.hit('client').blocked, false);
});

test('origin policy rejects non-loopback and wrong-port origins', () => {
  const policy = new OriginPolicy({ port: 8080, cloudflareOrigin: 'https://terminal.example.com' });
  assert.ok(isLoopbackOrigin('http://127.0.0.1:8080', 8080));
  assert.ok(!isLoopbackOrigin('http://127.0.0.1:9090', 8080));
  assert.ok(!isLoopbackOrigin('http://evil.example.com', 8080));
  assert.ok(policy.isAllowedRequest({ origin: undefined, host: '127.0.0.1:8080' }));
  assert.ok(!policy.isAllowedRequest({ origin: 'https://evil.example.com', host: 'terminal.example.com' }));
});

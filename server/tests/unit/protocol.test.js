import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  codePointLength,
  assertValidPassword,
  assertValidLabel,
  assertSafeLabelForShell,
  parseClientEnvelope,
  serverEnvelope,
  assertValidPort,
  assertValidHostname,
  assertValidEmail,
  ValidationError,
} from '../../../shared/src/protocol.js';
import { ARGON2_PARAMS, PROTOCOL_VERSION, SESSION_MIN } from '../../../shared/src/constants.js';

test('codePointLength counts code points, not UTF-16 units', () => {
  assert.equal(codePointLength('hello'), 5);
  assert.equal(codePointLength('\u{1F600}'), 1);
});

test('password length is 15 to 128 code points', () => {
  assert.throws(() => assertValidPassword('short'), ValidationError);
  assert.doesNotThrow(() => assertValidPassword('a'.repeat(15)));
  assert.throws(() => assertValidPassword('a'.repeat(129)), ValidationError);
  assert.throws(() => assertValidPassword(12345), ValidationError);
});

test('labels are 1 to 64 code points and reject NUL', () => {
  assert.throws(() => assertValidLabel(''), ValidationError);
  assert.doesNotThrow(() => assertValidLabel('Terminal 1'));
  assert.throws(() => assertValidLabel('a'.repeat(65)), ValidationError);
  assert.throws(() => assertValidLabel('bad\u0000label'), ValidationError);
});

test('labels are never interpolated into shell or tmux commands', () => {
  assert.throws(() => assertSafeLabelForShell('x; rm -rf /'), ValidationError);
  assert.throws(() => assertSafeLabelForShell('a$(whoami)'), ValidationError);
  assert.throws(() => assertSafeLabelForShell('a|b'), ValidationError);
  assert.doesNotThrow(() => assertSafeLabelForShell('Terminal 1'));
});

test('validators reject bad setup input', () => {
  assert.throws(() => assertValidPort(80), ValidationError);
  assert.equal(assertValidPort(8080), 8080);
  assert.throws(() => assertValidPort(70000), ValidationError);
  assert.throws(() => assertValidHostname('not a hostname'), ValidationError);
  assert.doesNotThrow(() => assertValidHostname('terminal.example.com'));
  assert.throws(() => assertValidEmail('nope'), ValidationError);
  assert.doesNotThrow(() => assertValidEmail('you@example.com'));
});

test('webSocket envelopes are validated strictly', () => {
  const ok = parseClientEnvelope(JSON.stringify({ v: 1, type: 'attach', sessionId: 'abc' }), 65536);
  assert.equal(ok.type, 'attach');

  assert.throws(() => parseClientEnvelope('{oops', 65536), ValidationError);
  assert.throws(() => parseClientEnvelope(JSON.stringify({ v: 2, type: 'attach', sessionId: 'a' }), 65536), ValidationError);
  assert.throws(() => parseClientEnvelope(JSON.stringify({ v: 1, type: 'evil', sessionId: 'a' }), 65536), ValidationError);
  assert.throws(() => parseClientEnvelope(JSON.stringify({ v: 1, type: 'attach' }), 65536), ValidationError);
  assert.throws(() => parseClientEnvelope(JSON.stringify({ v: 1, type: 'input', sessionId: 'a', payload: {} }), 65536), ValidationError);
  assert.doesNotThrow(() =>
    parseClientEnvelope(JSON.stringify({ v: 1, type: 'resize', sessionId: 'a', payload: { cols: 80, rows: 24 } }), 65536),
  );
  assert.throws(
    () => parseClientEnvelope(JSON.stringify({ v: 1, type: 'resize', sessionId: 'a', payload: { cols: 0, rows: 24 } }), 65536),
    ValidationError,
  );
  assert.throws(
    () => parseClientEnvelope(JSON.stringify({ v: 1, type: 'resize', sessionId: 'a', payload: { cols: 80, rows: 5000 } }), 65536),
    ValidationError,
  );
});

test('oversized webSocket messages are rejected', () => {
  const big = 'x'.repeat(70000);
  assert.throws(() => parseClientEnvelope(JSON.stringify({ v: 1, type: 'input', sessionId: 'a', payload: { data: big } }), 65536), ValidationError);
});

test('server envelopes carry protocol version', () => {
  const env = serverEnvelope('output', { sessionId: 'abc', payload: { data: 'hi' } });
  assert.deepEqual(env, { v: PROTOCOL_VERSION, type: 'output', sessionId: 'abc', payload: { data: 'hi' } });
});

test('argon2 params are pinned', () => {
  assert.equal(ARGON2_PARAMS.algorithm, 'argon2id');
  assert.ok(ARGON2_PARAMS.memoryCost >= 19456);
  assert.ok(ARGON2_PARAMS.timeCost >= 2);
  assert.equal(SESSION_MIN, 1);
});

test('atomic json writes produce 0600 files', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-fs-'));
  const file = path.join(dir, 'nested', 'config.json');
  const { writeJsonFileAtomic, setFileMode } = await import('../../src/utils/fsPaths.js');
  writeJsonFileAtomic(file, { a: 1 }, { mode: 0o600 });
  const mode = fs.statSync(file).mode & 0o777;
  assert.equal(mode, 0o600);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('origin policy allows loopback and the single Cloudflare origin only', async () => {
  const { OriginPolicy } = await import('../../src/auth/origin.js');
  const policy = new OriginPolicy({ port: 8080, cloudflareOrigin: 'https://terminal.example.com' });
  assert.ok(policy.allow('http://127.0.0.1:8080'));
  assert.ok(policy.allow('http://localhost:8080'));
  assert.ok(policy.allow('https://terminal.example.com'));
  assert.ok(!policy.allow('https://evil.example.com'));
  assert.ok(!policy.allow('http://127.0.0.1:9999'));
});

test('csrf double submit is compared in constant time', async () => {
  const { csrfMatches } = await import('../../src/auth/origin.js');
  assert.ok(csrfMatches({ cookieValue: 'abc', headerValue: 'abc' }));
  assert.ok(!csrfMatches({ cookieValue: 'abc', headerValue: 'abd' }));
  assert.ok(!csrfMatches({ cookieValue: 'abc', headerValue: undefined }));
});

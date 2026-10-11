import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hashPassword } from '../../src/auth/password.js';

/**
 * The server must refuse to start when the owner password is missing.
 *
 * A configuration with `password: null` would boot, reject every login with "Invalid
 * credentials", and in tunnel mode would publish that dead end to the internet. The guard turns
 * that into an actionable error instead.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '../..');
const entry = path.join(serverRoot, 'src/index.js');
const PORT = 18_912;

/** Writes a configuration the way the setup CLI does, into an isolated XDG home. */
function writeIsolatedConfig(base, password) {
  const xdgConfigHome = path.join(base, 'config');
  const configDir = path.join(xdgConfigHome, 'remote-terminal');
  fs.mkdirSync(configDir, { recursive: true });
  const config = {
    schemaVersion: 1,
    owner: { username: 'sank', password },
    server: { port: PORT, cloudflareOrigin: '', tunnelMode: 'named' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 2, connections: 2 },
  };
  fs.writeFileSync(path.join(configDir, 'config.json'), JSON.stringify(config, null, 2));
  return xdgConfigHome;
}

function isolatedEnv(xdgConfigHome) {
  return {
    ...process.env,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_DATA_HOME: path.join(xdgConfigHome, '..', 'data'),
    XDG_STATE_HOME: path.join(xdgConfigHome, '..', 'state'),
    LOG_LEVEL: 'error',
  };
}

test('the server refuses to start without an owner password', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-guard-'));
  const xdgConfigHome = writeIsolatedConfig(base, null);

  const child = spawn(process.execPath, [entry, '--no-tunnel'], {
    cwd: serverRoot,
    env: isolatedEnv(xdgConfigHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  let stdout = '';
  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });
  const code = await new Promise((resolve) => child.on('exit', (exitCode) => resolve(exitCode)));

  assert.equal(code, 2, 'a configuration with no password must fail closed');
  assert.match(stderr, /No owner password is configured/, 'the guard message must be the one shown');
  assert.match(stderr, /npm run setup/, 'the error must name the fix');
  assert.ok(!stdout.includes('listening'), 'nothing may start listening');

  fs.rmSync(base, { recursive: true, force: true });
});

test('the server starts normally when an owner password is present', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-guard-ok-'));
  const xdgConfigHome = writeIsolatedConfig(base, await hashPassword('correct horse battery staple 42'));

  const child = spawn(process.execPath, [entry, '--no-tunnel'], {
    cwd: serverRoot,
    env: isolatedEnv(xdgConfigHome),
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  try {
    let ready = false;
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`http://127.0.0.1:${PORT}/api/auth/me`);
        if (response.status === 401) {
          ready = true;
          break;
        }
      } catch {
        /* keep waiting */
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    assert.ok(ready, 'a valid configuration must reach the listening state');
  } finally {
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    try {
      child.kill('SIGKILL');
    } catch {
      /* already gone */
    }
    fs.rmSync(base, { recursive: true, force: true });
  }
});

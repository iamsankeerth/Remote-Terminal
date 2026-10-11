#!/usr/bin/env node
/**
 * Boots an isolated server for the Playwright suite.
 *
 * Writes its own XDG directories and configuration so browser tests never touch the owner's real
 * account, starts the server on a fixed port with the tunnel disabled, and prints the URL. Used
 * as the Playwright `webServer` command.
 */
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');
const serverRoot = path.resolve(here, '../..');

const PORT = Number(process.env.E2E_PORT ?? 8080);
const USERNAME = 'sank';
const PASSWORD = process.env.RT_TEST_PASSWORD ?? 'correct horse battery staple 42';

const base = path.join(os.tmpdir(), 'remote-terminal-e2e');
const env = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(base, 'config'),
  XDG_DATA_HOME: path.join(base, 'data'),
  XDG_STATE_HOME: path.join(base, 'state'),
  HOME: process.env.HOME ?? os.homedir(),
  LOG_LEVEL: 'error',
};

fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(env.XDG_CONFIG_HOME, { recursive: true });
fs.mkdirSync(env.XDG_DATA_HOME, { recursive: true });
fs.mkdirSync(env.XDG_STATE_HOME, { recursive: true });

/**
 * A server left behind by an interrupted run would hold the port and make this boot flaky, so
 * stale instances are cleared first. Our own process and the child we are about to spawn are never
 * targets, and failures are ignored because there may legitimately be nothing to kill.
 */
function killStale(pattern) {
  let pids = '';
  try {
    pids = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8' });
  } catch {
    return;
  }
  for (const raw of pids.split('\n')) {
    const pid = Number.parseInt(raw.trim(), 10);
    if (!Number.isInteger(pid) || pid === process.pid) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
  }
}
killStale('node src/index.js');
killStale('node boot-test-server.js');
await new Promise((resolve) => setTimeout(resolve, 500));

/**
 * Writes the config by importing the project's own config store and password hasher, so the test
 * account is produced by exactly the same code path as `npm run setup`.
 */
const { ConfigStore } = await import(path.join(serverRoot, 'src/utils/config.js'));
const { hashPassword } = await import(path.join(serverRoot, 'src/auth/password.js'));

const config = {
  schemaVersion: 1,
  owner: { username: USERNAME, password: await hashPassword(PASSWORD) },
  server: { port: PORT, cloudflareOrigin: '', tunnelMode: 'named' },
  cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
  limits: { sessions: 5, connections: 5 },
};
new ConfigStore({ path: path.join(env.XDG_CONFIG_HOME, 'remote-terminal', 'config.json') }).save(config);

const bootLog = path.join(base, 'boot.log');
const log = (line) => {
  try {
    fs.appendFileSync(bootLog, `${new Date().toISOString()} ${line}\n`);
  } catch {
    /* logging must never break the boot */
  }
};
log('boot starting');

const child = spawn(process.execPath, [path.join(serverRoot, 'src/index.js'), '--no-tunnel'], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
log(`child spawned pid=${child.pid}`);
child.stdout?.on('data', (chunk) => {
  process.stdout.write(chunk);
  log(`child stdout: ${String(chunk).trim()}`);
});
child.stderr?.on('data', (chunk) => {
  process.stderr.write(chunk);
  log(`child stderr: ${String(chunk).trim()}`);
});
child.on('error', (error) => log(`child error: ${error.message}`));
child.on('exit', (code, signal) => log(`child exit code=${code} signal=${signal}`));

const url = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 60_000;
let ready = false;
let lastError = 'none';
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${url}/api/auth/me`);
    log(`fetch status ${response.status}`);
    if (response.status === 401) {
      ready = true;
      break;
    }
    lastError = `unexpected status ${response.status}`;
  } catch (error) {
    lastError = String(error?.message ?? error);
    log(`fetch error ${lastError}`);
  }
  await new Promise((resolve) => setTimeout(resolve, 250));
}
if (!ready) {
  process.stderr.write(`e2e server did not become ready on ${url} (last error: ${lastError})\n`);
  child.kill('SIGTERM');
  process.exit(1);
}
process.stdout.write(`e2e server ready on ${url}\n`);
child.on('exit', (code, signal) => {
  process.stderr.write(`e2e server child exited: code=${code} signal=${signal}\n`);
});

const shutdown = () => {
  child.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
child.on('exit', (code) => process.exit(code ?? 0));

#!/usr/bin/env node
/**
 * Local echo latency benchmark for PRD v1.2 section 10.5.
 *
 * Boots an isolated server on loopback, creates a Terminal Session, sends a trivial command over
 * the WebSocket, and measures the time until its output comes back. Reports P50, P95, and the
 * worst case, and fails when P95 exceeds the 150 ms gate.
 *
 * Usage: npm run benchmark --workspace @remote-terminal/server
 *   RT_BENCH_SAMPLES=200 RT_BENCH_PORT=18990 node scripts/benchmark-echo.js
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const serverRoot = path.resolve(here, '..');
const repoRoot = path.resolve(here, '../../..');
const PORT = Number(process.env.RT_BENCH_PORT ?? 18_990);
const SAMPLES = Number(process.env.RT_BENCH_SAMPLES ?? 100);
const GATE_MS = Number(process.env.RT_BENCH_GATE_MS ?? 150);
const PASSWORD = 'correct horse battery staple 42';
const USERNAME = 'sank';

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-bench-'));
const configDir = path.join(base, 'config');
const dataDir = path.join(base, 'data');
const stateDir = path.join(base, 'state');

// The XDG variables must be set BEFORE importing any project module, because fsPaths resolves its
// directories at import time. Without this the benchmark would write to the owner's real config.
process.env.XDG_CONFIG_HOME = configDir;
process.env.XDG_DATA_HOME = dataDir;
process.env.XDG_STATE_HOME = stateDir;
process.env.LOG_LEVEL = 'error';

for (const dir of [configDir, dataDir, stateDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

const env = { ...process.env };

const { ConfigStore } = await import(path.join(serverRoot, 'src/utils/config.js'));
const { hashPassword } = await import(path.join(serverRoot, 'src/auth/password.js'));
new ConfigStore({ path: path.join(configDir, 'remote-terminal', 'config.json') }).save({
  schemaVersion: 1,
  owner: { username: USERNAME, password: await hashPassword(PASSWORD) },
  server: { port: PORT, cloudflareOrigin: '', tunnelMode: 'named' },
  cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
  limits: { sessions: 5, connections: 5 },
});

const child = spawn(process.execPath, [path.join(serverRoot, 'src/index.js'), '--no-tunnel'], {
  cwd: repoRoot,
  env,
  stdio: ['ignore', 'pipe', 'pipe'],
});
// Surface the server's own output so a startup failure is diagnosable instead of silent.
child.stdout?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
child.stderr?.on('data', (chunk) => process.stderr.write(`[server] ${chunk}`));
child.on('exit', (code, signal) => process.stderr.write(`[server] exited code=${code} signal=${signal}\n`));

function shutdown(code) {
  child.kill('SIGTERM');
  setTimeout(() => {
    fs.rmSync(base, { recursive: true, force: true });
    process.exit(code);
  }, 400);
}

process.on('SIGINT', () => shutdown(130));

const url = `http://127.0.0.1:${PORT}`;
const deadline = Date.now() + 30_000;
let ready = false;
while (Date.now() < deadline) {
  try {
    const response = await fetch(`${url}/api/auth/me`);
    if (response.status === 401) {
      ready = true;
      break;
    }
  } catch {
    /* keep waiting */
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
}
if (!ready) {
  process.stderr.write('benchmark server did not start\n');
  shutdown(1);
}

// Log in over HTTP so the socket carries a real session cookie.
const probe = await fetch(`${url}/api/auth/me`);
const preCsrf = (probe.headers.getSetCookie?.() ?? [])
  .find((c) => c.startsWith('rt_csrf='))
  ?.split(';')[0]
  .split('=')
  .slice(1)
  .join('=');
const login = await fetch(`${url}/api/auth/login`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrftoken': preCsrf, 'x-csrf-token': preCsrf },
  body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
});
if (login.status !== 200) {
  process.stderr.write(`benchmark login failed with ${login.status}\n`);
  shutdown(1);
}
const cookieHeader = (login.headers.getSetCookie?.() ?? [])
  .map((c) => c.split(';')[0])
  .join('; ');
const csrfToken = cookieHeader.split('; ').find((c) => c.startsWith('rt_csrf='))?.slice('rt_csrf='.length) ?? '';

const created = await fetch(`${url}/api/sessions`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
  body: JSON.stringify({ cols: 80, rows: 24 }),
});
const { session } = await created.json();

const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws/terminal`, { headers: { cookie: cookieHeader } });
const frames = [];
ws.on('message', (raw) => frames.push(JSON.parse(raw.toString())));
await new Promise((resolve, reject) => {
  ws.once('open', resolve);
  ws.once('error', reject);
});
const waitFor = (predicate, timeoutMs = 5000) =>
  new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const found = frames.find(predicate);
      if (found) return resolve(found);
      if (Date.now() - started > timeoutMs) return reject(new Error('timeout'));
      setTimeout(tick, 10);
    };
    tick();
  });

ws.send(JSON.stringify({ v: 1, type: 'attach', sessionId: session.id }));
await waitFor((m) => m.type === 'attached');
// Let the shell settle so the timing loop measures echo, not startup.
await new Promise((resolve) => setTimeout(resolve, 500));

const samples = [];
let marker = 0;
for (let i = 0; i < SAMPLES; i += 1) {
  marker += 1;
  const token = `bench-${marker}-${process.pid}`;
  const started = process.hrtime.bigint();
  ws.send(JSON.stringify({ v: 1, type: 'input', sessionId: session.id, payload: { data: `echo ${token}\n` } }));
  try {
    await waitFor((m) => m.type === 'output' && (m.payload.data ?? '').includes(token));
    samples.push(Number(process.hrtime.bigint() - started) / 1e6);
  } catch {
    process.stderr.write(`sample ${i} timed out\n`);
  }
}

ws.send(JSON.stringify({ v: 1, type: 'detach', sessionId: session.id }));
ws.close();
await fetch(`${url}/api/sessions/${session.id}`, {
  method: 'DELETE',
  headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
  body: JSON.stringify({ confirm: true }),
});

if (samples.length === 0) {
  process.stderr.write('no samples collected\n');
  shutdown(1);
}
samples.sort((a, b) => a - b);
const percentile = (p) => samples[Math.min(samples.length - 1, Math.floor((p / 100) * samples.length))];

process.stdout.write('\nRemote Terminal local echo benchmark\n');
process.stdout.write(`  samples:  ${samples.length}\n`);
process.stdout.write(`  min:      ${samples[0].toFixed(1)} ms\n`);
process.stdout.write(`  p50:      ${percentile(50).toFixed(1)} ms\n`);
process.stdout.write(`  p95:      ${percentile(95).toFixed(1)} ms\n`);
process.stdout.write(`  max:      ${samples[samples.length - 1].toFixed(1)} ms\n`);
process.stdout.write(`  gate:     p95 < ${GATE_MS} ms\n\n`);

const passed = percentile(95) < GATE_MS;
process.stdout.write(passed ? '  RESULT: PASS\n\n' : '  RESULT: FAIL\n\n');
shutdown(passed ? 0 : 1);

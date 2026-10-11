import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';
import { TmuxManager, makeInternalName, tmuxExec } from '../../src/terminal/tmuxManager.js';
import { TerminalManager } from '../../src/terminal/terminalManager.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger({ level: 'error' });

/** Removes every application-owned tmux session so tests do not leak state into each other. */
async function cleanupNamespace() {
  const tmux = new TmuxManager({ namespace: 'rt1' });
  const listed = await tmux.listManaged();
  for (const entry of listed) {
    await tmux.kill(entry.name.slice('rt1'.length));
  }
}

function harborHasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function readCookie(setCookies, name) {
  for (const cookie of setCookies) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    if (idx > 0 && pair.slice(0, idx).trim() === name) return pair.slice(idx + 1).trim();
  }
  return null;
}

test('tmux manager creates, lists, and kills namespaced sessions', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const tmux = new TmuxManager({ namespace: 'rt-test-' });
  const id = makeInternalName().replace(/^rt1/, 'x');
  const created = await tmux.create({ id, cwd: os.tmpdir(), cols: 80, rows: 24 });
  assert.equal(created, `${tmux.namespace}${id}`);
  const listed = await tmux.listManaged();
  assert.ok(listed.some((s) => s.name === created));
  const size = await tmux.displaySize(id);
  assert.deepEqual(size, { cols: 80, rows: 24 });
  const visible = await tmux.captureVisible(id);
  assert.equal(typeof visible, 'string');
  assert.equal(await tmux.kill(id), true);
  assert.equal(await tmux.exists(id), false);
});

test('external tmux sessions are never managed', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  execFileSync('tmux', ['new-session', '-d', '-s', 'rt-external-probe']);
  const tmux = new TmuxManager({ namespace: 'rt1' });
  const listed = await tmux.listManaged();
  assert.ok(!listed.some((s) => s.name === 'rt-external-probe'));
  execFileSync('tmux', ['kill-session', '-t', 'rt-external-probe']);
});

test('terminal manager creates, renames, terminates, and persists', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-int-'));
  const manager = new TerminalManager({
    config: { limits: { sessions: 3 } },
    logger,
    dataPath: path.join(dir, 'sessions.json'),
    homeDir: os.homedir(),
  });
  await manager.init();
  const created = await manager.create({ label: 'build', cols: 80, rows: 24 });
  assert.equal(created.label, 'build');
  assert.ok(created.internalName.startsWith('rt1'));

  await assert.rejects(() => manager.create({ label: 'BUILD' }), /already exists/i);
  assert.equal(created.labelLength, 5);

  const renamed = await manager.rename(created.id, 'tests');
  assert.equal(renamed.label, 'tests');
  await assert.rejects(() => manager.rename(created.id, 'bad;rm'), /metachar/);

  const list = manager.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].label, 'tests');

  await manager.terminate(created.id);
  assert.equal(manager.list().length, 0);
  const persisted = JSON.parse(fs.readFileSync(path.join(dir, 'sessions.json'), 'utf8'));
  assert.equal(persisted.sessions.length, 0);
  assert.equal(fs.statSync(path.join(dir, 'sessions.json')).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('natural shell exit removes the session', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-int-'));
  const manager = new TerminalManager({
    config: { limits: { sessions: 2 } },
    logger,
    dataPath: path.join(dir, 'sessions.json'),
    homeDir: os.homedir(),
  });
  await manager.init();
  const created = await manager.create({ cols: 80, rows: 24 });

  // End the shell the way a user typing `exit` would: the process inside the pane goes away and
  // tmux removes the session by itself. Driving this with send-keys was unreliable, because the
  // keystroke is lost when the shell has not started reading input yet, which made the test flaky.
  const pidResult = await tmuxExec([
    'display-message',
    '-p',
    '-t',
    created.internalName,
    '#{pane_pid}',
  ]);
  assert.equal(pidResult.ok, true, 'the pane pid must be readable');
  const shellPid = Number.parseInt(pidResult.stdout.trim(), 10);
  assert.ok(Number.isInteger(shellPid) && shellPid > 0, 'the pane must have a running shell');

  process.kill(shellPid, 'SIGHUP');

  const deadline = Date.now() + 30_000;
  let remaining = manager.list().length;
  while (remaining > 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 200));
    await manager.reconcile();
    remaining = manager.list().length;
  }
  assert.equal(remaining, 0, 'a naturally exited shell must remove the terminal session');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('rediscovery after restart reconciles metadata with live tmux sessions', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-int-'));
  const dataPath = path.join(dir, 'sessions.json');
  const options = { config: { limits: { sessions: 3 } }, logger, dataPath, homeDir: os.homedir() };

  const first = new TerminalManager(options);
  await first.init();
  const created = await first.create({ label: 'keep me', cols: 80, rows: 24 });

  // Simulate a Node restart: construct a brand new manager over the same tmux server and metadata.
  const second = new TerminalManager(options);
  await second.init();
  assert.equal(second.list().length, 1);
  assert.equal(second.list()[0].label, 'keep me');
  assert.equal(second.list()[0].id, created.id);

  await second.terminate(created.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('session and connection limits are enforced', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-int-'));
  const manager = new TerminalManager({
    config: { limits: { sessions: 2 } },
    logger,
    dataPath: path.join(dir, 'sessions.json'),
    homeDir: os.homedir(),
  });
  await manager.init();
  const a = await manager.create({ cols: 80, rows: 24 });
  await manager.create({ cols: 80, rows: 24 });
  await assert.rejects(() => manager.create({ cols: 80, rows: 24 }), /limit/i);
  await manager.terminate(a.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('live end-to-end: login, attach, input, output, takeover, detach, terminate', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const port = 18_000 + Math.floor(Math.random() * 2000);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-e2e-'));
  const { hashPassword } = await import('../../src/auth/password.js');
  const passwordRecord = await hashPassword('correct horse battery staple 42');
  const config = {
    schemaVersion: 1,
    owner: { username: 'sank', password: passwordRecord },
    server: { port, cloudflareOrigin: '' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 2, connections: 2 },
  };
  const { createHttpServer, closeHttpServer } = await import('../../src/http/createHttpApp.js');
  const { createWebSocketGateway } = await import('../../src/websocket/gateway.js');
  const { SessionStore } = await import('../../src/auth/sessionStore.js');
  const { RateLimiter } = await import('../../src/auth/rateLimiter.js');
  const { OriginPolicy } = await import('../../src/auth/origin.js');

  const sessions = new SessionStore();
  const terminalManager = new TerminalManager({
    config,
    logger,
    dataPath: path.join(dir, 's.json'),
    homeDir: os.homedir(),
  });
  await terminalManager.init();
  const httpServer = createHttpServer({
    sessions,
    config,
    terminalManager,
    loginLimiter: new RateLimiter(),
    originPolicy: new OriginPolicy({ port, cloudflareOrigin: '' }),
    logger,
    clientDist: '',
  });
  const gateway = createWebSocketGateway({ server: httpServer, config, sessions, terminalManager, logger });
  await new Promise((resolve) => httpServer.listen(port, '127.0.0.1', resolve));

  try {
    await runLiveFlow({ base: `http://127.0.0.1:${port}`, port, config, dir, wsPort: port, terminalManager });
  } finally {
    try {
      gateway.close();
    } catch {
      /* ignore */
    }
    await closeHttpServer(httpServer);
    await cleanupNamespace();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

async function runLiveFlow({ base, port, dir, terminalManager }) {
  // Pre-session CSRF: an unauthenticated GET issues the double-submit cookie.
  const probe = await fetch(`${base}/api/auth/me`);
  assert.equal(probe.status, 401);
  const preCsrf = readCookie(probe.headers.getSetCookie?.() ?? [], 'rt_csrf');
  assert.ok(preCsrf, 'pre-session CSRF cookie must be issued');

  const login = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
    body: JSON.stringify({ username: 'sank', password: 'correct horse battery staple 42' }),
  });
  assert.equal(login.status, 200);
  const loginJson = await login.json();
  const jar = new Map();
  for (const cookie of login.headers.getSetCookie?.() ?? []) {
    const [pair] = cookie.split(';');
    const idx = pair.indexOf('=');
    jar.set(pair.slice(0, idx).trim(), pair.slice(idx + 1).trim());
  }
  assert.ok(jar.has('rt_session'));
  const cookieHeader = [...jar.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  const csrfToken = loginJson.csrfToken ?? jar.get('rt_csrf');
  assert.equal(csrfToken, jar.get('rt_csrf'), 'returned token must match the cookie');

  const bad = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': preCsrf },
    body: JSON.stringify({ username: 'sank', password: 'wrong password entirely 1' }),
  });
  assert.equal(bad.status, 401);

  const noCsrf = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: `rt_csrf=${preCsrf}`, 'x-csrf-token': 'mismatch' },
    body: JSON.stringify({ username: 'sank', password: 'correct horse battery staple 42' }),
  });
  assert.equal(noCsrf.status, 403);

  const unauthenticated = await fetch(`${base}/api/sessions`);
  assert.equal(unauthenticated.status, 401);

  const created = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  assert.equal(created.status, 201);
  const { session } = await created.json();
  assert.equal(session.label, 'Terminal 1');

  const foreignOrigin = await fetch(`${base}/api/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      cookie: cookieHeader,
      'x-csrf-token': csrfToken,
      origin: 'https://evil.example.com',
    },
    body: JSON.stringify({}),
  });
  assert.equal(foreignOrigin.status, 403);

  // ---- WebSocket protocol ----
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers: { cookie: cookieHeader } });
  const frames = [];
  const waitFor = (predicate, timeoutMs = 6000) =>
    new Promise((resolve, reject) => {
      const started = Date.now();
      const tick = () => {
        const found = frames.find(predicate);
        if (found) return resolve(found);
        if (Date.now() - started > timeoutMs) {
          return reject(new Error(`timed out waiting for frame; received: ${frames.map((m) => m.type).join(',') || 'none'}`));
        }
        setTimeout(tick, 25);
      };
      tick();
    });
  ws.on('message', (raw) => frames.push(JSON.parse(raw.toString('utf8'))));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  await waitFor((m) => m.type === 'ready');

  ws.send(JSON.stringify({ v: 1, type: 'attach', sessionId: session.id }));
  const attached = await waitFor((m) => m.type === 'attached');
  assert.equal(attached.sessionId, session.id);
  assert.equal(attached.payload.cols, 80);
  assert.equal(attached.payload.rows, 24);
  assert.equal(typeof attached.payload.controllerConnectionId, 'string');

  ws.send(JSON.stringify({ v: 1, type: 'input', sessionId: session.id, payload: { data: 'echo rt-marker-9f3a\n' } }));
  const echoed = await waitFor((m) => m.type === 'output' && (m.payload.data ?? '').includes('rt-marker-9f3a'));
  assert.ok(echoed.payload.data.includes('rt-marker-9f3a'));

  ws.send(JSON.stringify({ v: 1, type: 'resize', sessionId: session.id, payload: { cols: 100, rows: 30 } }));
  await new Promise((resolve) => setTimeout(resolve, 400));
  // tmux reserves one line for its status bar, so the window is one row shorter than the client.
  assert.deepEqual(await terminalManager.tmux.displaySize(session.id), { cols: 100, rows: 29 });

  // A second device must take over explicitly.
  const ws2 = new WebSocket(`ws://127.0.0.1:${port}/ws/terminal`, { headers: { cookie: cookieHeader } });
  const frames2 = [];
  const waitForOn = (socket, sink, predicate, timeoutMs = 5000) =>
    new Promise((resolve, reject) => {
      const onMessage = (raw) => {
        const message = JSON.parse(raw.toString('utf8'));
        sink.push(message);
        if (predicate(message)) {
          socket.off('message', onMessage);
          resolve(message);
        }
      };
      socket.on('message', onMessage);
      setTimeout(() => {
        socket.off('message', onMessage);
        reject(
          new Error(
            `timed out waiting for frame; received: ${sink
              .map((m) => `${m.type}:${JSON.stringify(m.payload ?? {}).slice(0, 90)}`)
              .join(' | ') || 'none'}`,
          ),
        );
      }, timeoutMs);
    });
  ws2.on('message', (raw) => frames2.push(JSON.parse(raw.toString('utf8'))));
  await new Promise((resolve, reject) => {
    ws2.once('open', resolve);
    ws2.once('error', reject);
  });

  ws2.send(JSON.stringify({ v: 1, type: 'attach', sessionId: session.id }));
  const blocked = await waitForOn(ws2, frames2, (m) => m.type === 'error' && m.payload.code === 'control_leased', 4000);
  assert.ok(blocked, 'second device must be blocked while a controller is attached');

  ws2.send(JSON.stringify({ v: 1, type: 'takeover', sessionId: session.id }));
  await waitForOn(ws2, frames2, (m) => m.type === 'attached', 6000);
  const takenOver = await waitFor((m) => m.type === 'detached' && m.payload.reason === 'taken_over', 6000);
  assert.ok(takenOver);

  // Detach leaves tmux running.
  ws2.send(JSON.stringify({ v: 1, type: 'detach', sessionId: session.id }));
  await waitForOn(ws2, frames2, (m) => m.type === 'detached', 4000);
  assert.equal(await terminalManager.tmux.exists(session.id), true);

  const terminated = await fetch(`${base}/api/sessions/${session.id}`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
    body: JSON.stringify({ confirm: true }),
  });
  assert.equal(terminated.status, 200);
  assert.equal(await terminalManager.tmux.exists(session.id), false);

  const noConfirm = await fetch(`${base}/api/sessions/whatever`, {
    method: 'DELETE',
    headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
    body: JSON.stringify({}),
  });
  assert.equal(noConfirm.status, 400);

  const logout = await fetch(`${base}/api/auth/logout`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: cookieHeader, 'x-csrf-token': csrfToken },
    body: JSON.stringify({}),
  });
  assert.equal(logout.status, 200);
  const afterLogout = await fetch(`${base}/api/sessions`, { headers: { cookie: cookieHeader } });
  assert.equal(afterLogout.status, 401, 'logout revokes the current device');

  try {
    ws.close();
    ws2.close();
  } catch {
    /* ignore */
  }
  void dir;
}

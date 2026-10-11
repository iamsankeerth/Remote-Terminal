import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { CONTROL_LEASE_SECONDS } from '@remote-terminal/shared';
import { TmuxManager } from '../../src/terminal/tmuxManager.js';
import { TerminalManager } from '../../src/terminal/terminalManager.js';
import { createLogger } from '../../src/utils/logger.js';

const logger = createLogger({ level: 'error' });

function harborHasTmux() {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

async function cleanupNamespace() {
  const tmux = new TmuxManager({ namespace: 'rt1' });
  for (const entry of await tmux.listManaged()) {
    await tmux.kill(entry.name.slice('rt1'.length));
  }
}

test('pausing and detaching a slow client leaves tmux running', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-slow-'));
  const manager = new TerminalManager({
    config: { limits: { sessions: 2 } },
    logger,
    dataPath: path.join(dir, 'sessions.json'),
    homeDir: os.homedir(),
  });
  await manager.init();
  const session = await manager.create({ cols: 200, rows: 50 });

  // Attach, then drive real output through the bridge.
  const { PtyBridge } = await import('../../src/terminal/ptyBridge.js');
  const { file, args } = manager.tmux.attachArgs({ id: session.id, cols: 200, rows: 50 });
  let received = 0;
  const bridge = new PtyBridge({
    file,
    args,
    cols: 200,
    rows: 50,
    cwd: os.homedir(),
    onData: (data) => {
      received += Buffer.byteLength(data, 'utf8');
    },
    onExit: () => {},
  });

  await new Promise((resolve) => setTimeout(resolve, 400));
  execFileSync('tmux', ['send-keys', '-t', session.internalName, 'echo slow-client-burst', 'Enter']);

  const deadline = Date.now() + 15_000;
  while (received === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(received > 0, `the bridge must receive output (received ${received} bytes)`);

  // This is what the gateway does once the socket buffer passes the limit: pause forwarding,
  // detach with a recoverable error, and leave the session running.
  bridge.pause();
  assert.equal(await manager.tmux.exists(session.id), true, 'tmux must survive a paused client');
  bridge.resume();
  bridge.detach();
  assert.equal(bridge.exited, true, 'detaching marks the bridge as exited');
  assert.equal(await manager.tmux.exists(session.id), true, 'detaching the client must not kill tmux');

  await manager.terminate(session.id);
  assert.equal(await manager.tmux.exists(session.id), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('the 30 second control lease expires and another device may then attach', async (t) => {
  await cleanupNamespace();
  if (!harborHasTmux()) {
    t.skip('tmux is not installed');
    return;
  }
  assert.equal(CONTROL_LEASE_SECONDS, 30);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-lease-'));
  const manager = new TerminalManager({
    config: { limits: { sessions: 2 } },
    logger,
    dataPath: path.join(dir, 'sessions.json'),
    homeDir: os.homedir(),
  });
  await manager.init();
  const session = await manager.create({ cols: 80, rows: 24 });

  // Simulate an unexpected disconnect from connection A: control is reserved for it.
  const now = Date.now();
  session.controllerConnectionId = 'connection-a';
  session.controllerId = 'connection-a';
  session.leaseUntil = now + CONTROL_LEASE_SECONDS * 1000;

  // Connection B is blocked while the lease is active.
  assert.equal(manager.leaseActive(session, 'connection-b', now + 1000), true);
  // Connection A itself is never blocked by its own lease.
  assert.equal(manager.leaseActive(session, 'connection-a', now + 1000), false);
  // Once the lease window passes, the reservation is gone.
  assert.equal(manager.leaseActive(session, 'connection-b', now + CONTROL_LEASE_SECONDS * 1000 + 1), false);

  await manager.terminate(session.id);
  fs.rmSync(dir, { recursive: true, force: true });
});

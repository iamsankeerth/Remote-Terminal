import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QuickTunnelManager, parseTunnelUrl, resolveCloudflaredBinary } from '../../src/tunnel/tunnelManager.js';
import {
  setActiveTunnel,
  clearActiveTunnel,
  isTunnelRunning,
  isTunnelOrigin,
  getTunnelOrigin,
} from '../../src/tunnel/tunnelContext.js';

test('finds cloudflared outside PATH when it lives in ~/.local/bin', () => {
  // Regression: cloudflared is commonly installed into ~/.local/bin, which is only on PATH in
  // login shells. A server started from an IDE or a script must still find it.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cf-'));
  const homeBin = path.join(dir, '.local', 'bin');
  fs.mkdirSync(homeBin, { recursive: true });
  const binary = path.join(homeBin, 'cloudflared');
  fs.writeFileSync(binary, '#!/bin/sh\n');
  fs.chmodSync(binary, 0o755);

  const found = resolveCloudflaredBinary({ env: { PATH: '/nonexistent-dir' }, home: dir });
  assert.equal(found, binary, 'the explicit home location must be used when PATH misses');

  // CLOUDFLARED_PATH wins over everything else.
  const overrideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rt-cf-override-'));
  const override = path.join(overrideDir, 'my-cloudflared');
  fs.writeFileSync(override, '#!/bin/sh\n');
  fs.chmodSync(override, 0o755);
  assert.equal(resolveCloudflaredBinary({ env: { PATH: homeBin, CLOUDFLARED_PATH: override }, home: dir }), override);

  // Nothing installed anywhere.
  assert.equal(resolveCloudflaredBinary({ env: { PATH: '/nonexistent-dir' }, home: '/nonexistent-home' }), null);

  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(overrideDir, { recursive: true, force: true });
});

test('tunnel manager uses the resolved binary path', () => {
  const manager = new QuickTunnelManager(8080, { logger: { info() {}, warn() {}, error() {} } });
  assert.ok(manager.binary.length > 0);
  assert.ok(path.isAbsolute(manager.binary) || manager.binary === 'cloudflared');
});

test('parses a quick tunnel URL from cloudflared output', () => {
  assert.equal(
    parseTunnelUrl('2026-01-01T00:00:00Z INF |  https://calm-words-1234.trycloudflare.com  |'),
    'https://calm-words-1234.trycloudflare.com',
  );
  assert.equal(parseTunnelUrl('no url here'), null);
  assert.equal(parseTunnelUrl(''), null);
  assert.equal(parseTunnelUrl(undefined), null);
  assert.equal(parseTunnelUrl('https://not-a-tunnel.example.com'), null);
});

test('ignores lookalike urls that are not quick tunnels', () => {
  assert.equal(parseTunnelUrl('https://evil-trycloudflare.com.evil.example'), null);
  assert.equal(parseTunnelUrl('http://insecure.trycloudflare.com'), null);
});

test('tunnel context tracks running state and origin only while active', () => {
  clearActiveTunnel();
  assert.equal(isTunnelRunning(), false);
  assert.equal(isTunnelOrigin('https://anything.trycloudflare.com'), false);

  const origin = setActiveTunnel('https://Calm-Words-1234.trycloudflare.com');
  assert.equal(origin, 'https://calm-words-1234.trycloudflare.com');
  assert.equal(isTunnelRunning(), true);
  assert.equal(getTunnelOrigin(), 'https://calm-words-1234.trycloudflare.com');
  assert.equal(isTunnelOrigin('https://calm-words-1234.trycloudflare.com'), true);
  assert.equal(isTunnelOrigin('https://calm-words-1234.trycloudflare.com/'), true);
  assert.equal(isTunnelOrigin('https://other.trycloudflare.com'), false);
  assert.equal(isTunnelOrigin('http://127.0.0.1:8080'), false);

  clearActiveTunnel();
  assert.equal(isTunnelRunning(), false);
  assert.equal(isTunnelOrigin('https://calm-words-1234.trycloudflare.com'), false);
});

test('rejects malformed origins when activating a tunnel', () => {
  clearActiveTunnel();
  assert.equal(setActiveTunnel('not-a-url'), null);
  assert.equal(isTunnelRunning(), false);
});

test('a fake cloudflared that prints a URL reaches the running state', async () => {
  const url = 'https://unit-test-tunnel-42.trycloudflare.com';
  const manager = new QuickTunnelManager(8080, {
    logger: { info() {}, warn() {}, error() {} },
    binary: process.execPath,
    args: ['-e', `setTimeout(() => console.log('INF | ${url} |'), 25); setInterval(() => {}, 1000);`],
  });

  const states = [];
  manager.onStateChange((state, reported) => states.push([state, reported]));

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(manager.state, 'running');
  assert.equal(manager.url, url);
  assert.ok(states.some(([state]) => state === 'starting'));
  assert.ok(states.some(([state, reported]) => state === 'running' && reported === url));

  manager.stop();
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(manager.state, 'stopped');
  assert.equal(manager.url, null);
});

test('a tunnel that exits before producing a URL retries and then stops', async () => {
  const manager = new QuickTunnelManager(8080, {
    logger: { info() {}, warn() {}, error() {} },
    binary: process.execPath,
    args: ['-e', 'process.exit(3)'],
    retryDelayMs: 20,
    maxRetries: 1,
  });

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 1200));

  assert.equal(manager.state, 'stopped');
  assert.equal(manager.url, null);
  assert.equal(manager.attempts, 2, 'one retry is expected before giving up');
});

test('a missing binary leaves the tunnel stopped and never throws', async () => {
  const warnings = [];
  const manager = new QuickTunnelManager(8080, {
    logger: { info() {}, warn: (message) => warnings.push(message), error() {} },
    binary: 'cloudflared-does-not-exist-for-this-test',
  });

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 300));

  assert.equal(manager.state, 'stopped');
  assert.equal(manager.isRunning, false);
  assert.ok(warnings.includes('tunnel_binary_missing'), 'the install hint must be logged');
});

test('stop is idempotent and safe when never started', () => {
  const manager = new QuickTunnelManager(8080, { logger: { info() {}, warn() {}, error() {} } });
  assert.doesNotThrow(() => manager.stop());
  assert.equal(manager.state, 'stopped');
  assert.doesNotThrow(() => manager.stop());
});

test('stop does not respawn a tunnel through the retry path', async () => {
  // Regression: stop() must be recognised as intentional, otherwise the close handler treats the
  // killed child as a crash and retries, leaving an orphan cloudflared running.
  const url = 'https://orphan-guard-77.trycloudflare.com';
  const manager = new QuickTunnelManager(8080, {
    logger: { info() {}, warn() {}, error() {} },
    binary: process.execPath,
    args: ['-e', `setTimeout(() => console.log('INF | ${url} |'), 25); setInterval(() => {}, 1000);`],
    retryDelayMs: 20,
    maxRetries: 2,
  });

  const attemptsAtStart = manager.attempts;
  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(manager.state, 'running');

  const pidBeforeStop = manager.child?.pid ?? null;
  assert.ok(pidBeforeStop, 'a child process must be running');

  manager.stop();
  await new Promise((resolve) => setTimeout(resolve, 400));

  assert.equal(manager.state, 'stopped');
  assert.equal(manager.url, null);
  assert.equal(manager.attempts, attemptsAtStart + 1, 'stop must never start another attempt');
  assert.equal(manager.child, null);

  // The original child must actually be gone.
  const alive = await new Promise((resolve) => {
    try {
      process.kill(pidBeforeStop, 0);
      resolve(true);
    } catch {
      resolve(false);
    }
  });
  assert.equal(alive, false, 'the stopped tunnel process must not survive');
});

test('handlers cannot break the tunnel state machine', async () => {
  const manager = new QuickTunnelManager(8080, {
    logger: { info() {}, warn() {}, error() {} },
    binary: process.execPath,
    args: ['-e', 'setTimeout(() => console.log("https://handler-test-1.trycloudflare.com"), 20); setInterval(() => {}, 1000);'],
  });
  manager.onStateChange(() => {
    throw new Error('bad handler');
  });

  manager.start();
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(manager.state, 'running');
  manager.stop();
});

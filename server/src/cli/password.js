#!/usr/bin/env node
/**
 * Local account maintenance CLI: change the owner password, or revoke every Login Session.
 *
 * Both operations signal a running server so it re-reads its configuration and drops every active
 * Login Session immediately, as PRD v1.2 section 6.3 requires. The password is never echoed, never
 * written anywhere in plaintext, and never appears in a log.
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PASSWORD_MIN_CODE_POINTS,
  PASSWORD_MAX_CODE_POINTS,
  codePointLength,
} from '@remote-terminal/shared';
import { hashPassword, verifyPassword } from '../auth/password.js';
import { ConfigStore } from '../utils/config.js';
import { CONFIG_PATH, STATE_DIR } from '../utils/fsPaths.js';

const revokeOnly = process.argv.includes('--revoke-only');
const PID_FILE = path.join(STATE_DIR, 'server.pid');

/**
 * Sequential line reader that works both in a terminal and with piped input, which is what makes
 * this CLI scriptable. readline/promises rejects on a closed stdin, which is the wrong behaviour
 * when answers arrive as a pipe.
 */
function createLineReader() {
  const lines = [];
  let waiting = null;
  let ended = false;

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    const parts = chunk.split('\n');
    for (let i = 0; i < parts.length; i += 1) {
      if (i === parts.length - 1 && parts[i] !== '') continue; // last piece may be partial
      const line = parts[i].endsWith('\r') ? parts[i].slice(0, -1) : parts[i];
      lines.push(line);
    }
    const waiter = waiting;
    waiting = null;
    if (waiter) waiter();
  });
  process.stdin.on('end', () => {
    ended = true;
    const waiter = waiting;
    waiting = null;
    if (waiter) waiter();
  });

  return function ask(question) {
    process.stdout.write(question);
    return new Promise((resolve, reject) => {
      const attempt = () => {
        if (lines.length > 0) {
          resolve(lines.shift());
          return;
        }
        if (ended) {
          reject(new Error('no more input'));
          return;
        }
        waiting = attempt;
      };
      attempt();
    });
  };
}

const ask = createLineReader();

function serverPid() {
  try {
    const pid = Number.parseInt(fs.readFileSync(PID_FILE, 'utf8').trim(), 10);
    if (!Number.isInteger(pid)) return null;
    process.kill(pid, 0); // throws when the process is gone
    return pid;
  } catch {
    return null;
  }
}

/** Ask the running server to reload its configuration and drop every Login Session. */
function signalServer() {
  const pid = serverPid();
  if (!pid) {
    process.stdout.write(`  No running server found (looked for ${PID_FILE}). Changes apply on next start.\n`);
    return false;
  }
  try {
    process.kill(pid, 'SIGHUP');
    process.stdout.write(`  Signalled the running server (pid ${pid}): all login sessions revoked.\n`);
    return true;
  } catch (error) {
    process.stdout.write(`  Could not signal pid ${pid}: ${error.message}\n`);
    return false;
  }
}

async function main() {
  const store = new ConfigStore({ path: CONFIG_PATH });
  const config = store.load();
  if (!config) {
    process.stdout.write('No configuration found. Run: npm run setup\n');
    return;
  }

  if (revokeOnly) {
    process.stdout.write('\nRevoking every login session...\n');
    signalServer();
    return;
  }

  process.stdout.write('\nChange the owner password\n');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = await ask('  Current password: ');
    if (await verifyPassword(current, config.owner.password)) {
      const first = await ask('  New password (15-128 code points): ');
      const len = codePointLength(first);
      if (len < PASSWORD_MIN_CODE_POINTS || len > PASSWORD_MAX_CODE_POINTS) {
        process.stdout.write(`  Password must be ${PASSWORD_MIN_CODE_POINTS} to ${PASSWORD_MAX_CODE_POINTS} code points.\n`);
        process.exitCode = 1;
        return;
      }
      const second = await ask('  Repeat new password: ');
      if (first !== second) {
        process.stdout.write('  Passwords do not match.\n');
        process.exitCode = 1;
        return;
      }
      config.owner.password = await hashPassword(first);
      store.save(config);
      try {
        fs.chmodSync(CONFIG_PATH, 0o600);
      } catch {
        /* permissions are best effort on some filesystems */
      }
      process.stdout.write(`\nPassword updated in ${CONFIG_PATH} (0600).\n`);
      signalServer();
      return;
    }
    process.stdout.write('  Current password is incorrect.\n');
  }
  process.stdout.write('Too many incorrect attempts.\n');
  process.exitCode = 1;
}

main().catch((error) => {
  process.stdout.write(`\nFailed: ${error?.message ?? error}\n`);
  process.exitCode = 1;
});

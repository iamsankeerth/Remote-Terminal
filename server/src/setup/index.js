#!/usr/bin/env node
/**
 * Remote Terminal setup CLI.
 *
 * Interactive, local-only. There is no HTTP setup route. This script validates the host, collects
 * the owner account, the ingress mode, and resource caps, and writes 0600/0700 XDG files with
 * atomic replacement. It never installs packages, elevates privileges, or touches Cloudflare.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import {
  SESSION_MIN,
  SESSION_MAX,
  CONNECTION_MIN,
  CONNECTION_MAX,
  PASSWORD_MIN_CODE_POINTS,
  PASSWORD_MAX_CODE_POINTS,
  ValidationError,
  codePointLength,
} from '@remote-terminal/shared';
import { hashPassword, assertArgon2Available } from '../auth/password.js';
import { ConfigStore, CONFIG_SCHEMA_VERSION } from '../utils/config.js';
import { CONFIG_PATH, DATA_DIR } from '../utils/fsPaths.js';

const rl = readline.createInterface({ input: stdin, output: stdout });

function ok(message) {
  stdout.write(`  ok    ${message}\n`);
}

function warn(message) {
  stdout.write(`  warn  ${message}\n`);
}

function fail(message) {
  stdout.write(`  FAIL  ${message}\n`);
}

function isInsideWsl() {
  try {
    const release = fs.readFileSync('/proc/sys/kernel/osrelease', 'utf8');
    return /microsoft|wsl/i.test(release) || process.env.WSL_DISTRO_NAME !== undefined;
  } catch {
    return process.env.WSL_DISTRO_NAME !== undefined;
  }
}

function nodeVersion() {
  return process.versions.node;
}

function satisfiesNodeRequirement(version, minimum = '24.7.0') {
  const parse = (v) => v.split('.').map((n) => Number.parseInt(n, 10));
  const a = parse(version);
  const b = parse(minimum);
  for (let i = 0; i < 3; i += 1) {
    if ((a[i] ?? 0) > (b[i] ?? 0)) return true;
    if ((a[i] ?? 0) < (b[i] ?? 0)) return false;
  }
  return true;
}

function checkNode() {
  const version = nodeVersion();
  if (satisfiesNodeRequirement(version)) {
    ok(`Node.js ${version} (native Argon2id available)`);
    return true;
  }
  fail(`Node.js ${version} is older than the required 24.7.0`);
  return false;
}

function checkArgon2() {
  try {
    assertArgon2Available();
    ok('crypto.argon2 (async Argon2id) is available');
    return true;
  } catch (error) {
    fail(error.message);
    return false;
  }
}

function checkTmux() {
  try {
    const version = execFileSync('tmux', ['-V'], { encoding: 'utf8' }).trim();
    ok(`tmux ${version}`);
    return true;
  } catch {
    fail('tmux was not found on PATH. Install tmux inside this Linux distribution.');
    return false;
  }
}

function checkNodePtyPrereqs() {
  let hasCompiler = false;
  let hasPython = false;
  try {
    execFileSync('cc', ['--version'], { stdio: 'ignore' });
    hasCompiler = true;
  } catch {
    /* not found */
  }
  try {
    execFileSync('python3', ['--version'], { stdio: 'ignore' });
    hasPython = true;
  } catch {
    /* not found */
  }
  if (hasCompiler && hasPython) {
    ok('node-pty build prerequisites present (C compiler and Python 3)');
    return true;
  }
  warn('node-pty build prerequisites incomplete; run: sudo apt-get install -y build-essential python3');
  return false;
}

function checkNonRoot() {
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    fail('Setup must not run as root. Re-run as the login user that owns the shells.');
    return false;
  }
  ok(`running as non-root user ${os.userInfo().username}`);
  return true;
}

function checkWsl() {
  if (process.platform === 'linux' && isInsideWsl()) {
    ok(`inside WSL2 distro ${process.env.WSL_DISTRO_NAME ?? 'unknown'}`);
    return true;
  }
  if (process.platform === 'linux') {
    ok('native Linux host');
    return true;
  }
  fail('Setup must run inside native Linux or Ubuntu on WSL2. Start the WSL2 distro and re-run.');
  return false;
}

function checkConfigPermissions() {
  if (!fs.existsSync(CONFIG_PATH)) return;
  const mode = fs.statSync(CONFIG_PATH).mode & 0o777;
  if (mode === 0o600) ok(`config file permissions are 0600 (${CONFIG_PATH})`);
  else fail(`config file permissions are ${mode.toString(8)}, expected 600`);
}

async function ask(question, { validate, defaultValue } = {}) {
  for (;;) {
    const suffix = defaultValue ? ` [${defaultValue}]` : '';
    const answer = (await rl.question(`  ${question}${suffix}: `)).trim();
    const value = answer === '' && defaultValue !== undefined ? defaultValue : answer;
    if (value === '') {
      stdout.write('  A value is required. No implicit defaults are accepted.\n');
      continue;
    }
    try {
      return validate ? validate(value) : value;
    } catch (error) {
      stdout.write(`  ${error.message}\n`);
    }
  }
}

async function askPassword() {
  // Passwords are accepted interactively and are never echoed, logged, or stored in plaintext.
  for (;;) {
    const first = await rl.question('  Owner password (input is hidden, 15-128 code points): ');
    if (codePointLength(first) < PASSWORD_MIN_CODE_POINTS || codePointLength(first) > PASSWORD_MAX_CODE_POINTS) {
      stdout.write(`  Password must be ${PASSWORD_MIN_CODE_POINTS} to ${PASSWORD_MAX_CODE_POINTS} code points.\n`);
      continue;
    }
    const second = await rl.question('  Repeat password: ');
    if (first !== second) {
      stdout.write('  Passwords do not match.\n');
      continue;
    }
    return first;
  }
}

async function main() {
  stdout.write('\nRemote Terminal setup\n\n');
  stdout.write('Validating the host environment...\n');
  const checks = [
    checkWsl(),
    checkNode(),
    checkArgon2(),
    checkTmux(),
    checkNodePtyPrereqs(),
    checkNonRoot(),
  ];
  checkConfigPermissions();

  const blocking = checks.filter((c) => c === false);
  if (blocking.length > 0) {
    stdout.write('\nSetup cannot continue until the failed checks above are resolved.\n');
    rl.close();
    process.exitCode = 1;
    return;
  }

  const store = new ConfigStore();
  const existing = store.load();
  if (existing) {
    stdout.write(`\nExisting configuration found at ${CONFIG_PATH}\n`);
    const overwrite = await rl.question('  Replace it? (yes/no): ');
    if (overwrite.trim().toLowerCase() !== 'yes') {
      stdout.write('  Keeping the existing configuration.\n');
      rl.close();
      return;
    }
  }

  const config = {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    owner: { username: '', password: null },
    server: { port: 0, cloudflareOrigin: '', tunnelMode: 'quick' },
    cloudflare: { hostname: '', teamDomain: '', aud: '', ownerEmail: '' },
    limits: { sessions: 1, connections: 1 },
  };

  const username = await ask('Owner username');
  const password = await askPassword();
  const passwordRecord = await hashPassword(password);
  const port = await ask('Server port (loopback only)', {
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < 1024 || n > 65535) throw new ValidationError('Port must be 1024-65535.');
      return n;
    },
  });

  // By default the server deploys a Cloudflare quick tunnel, which needs no Cloudflare account
  // and no Cloudflare settings. Only the named-tunnel path asks for Cloudflare values.
  const useQuickTunnel = await ask('Use a Cloudflare quick tunnel, with no Cloudflare account or settings? (yes/no)', {
    validate: (value) => {
      const normalized = value.toLowerCase();
      if (normalized !== 'yes' && normalized !== 'no') {
        throw new ValidationError('Answer yes or no.');
      }
      return normalized === 'yes';
    },
  });

  let hostname = '';
  let teamDomain = '';
  let aud = '';
  let ownerEmail = '';
  if (useQuickTunnel) {
    config.server.tunnelMode = 'quick';
    stdout.write('  Quick tunnel selected: no Cloudflare account, DNS, or Access setup is needed.\n');
  } else {
    config.server.tunnelMode = 'named';
    hostname = await ask('Cloudflare hostname (exact public HTTPS origin, e.g. terminal.example.com)', {
      validate: (value) => {
        if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) {
          throw new ValidationError('Enter a DNS hostname.');
        }
        return value;
      },
    });
    teamDomain = await ask('Cloudflare Access team domain (the part before .cloudflareaccess.com)');
    aud = await ask('Cloudflare Access Application Audience (AUD)');
    ownerEmail = await ask('Pinned owner email used by Cloudflare Access', {
      validate: (value) => {
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new ValidationError('Enter an email address.');
        return value;
      },
    });
  }
  const sessions = await ask(`Terminal Session limit (${SESSION_MIN}-${SESSION_MAX})`, {
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < SESSION_MIN || n > SESSION_MAX) {
        throw new ValidationError(`Enter an integer ${SESSION_MIN}-${SESSION_MAX}.`);
      }
      return n;
    },
  });
  const connections = await ask(`Active Browser Connection limit (${CONNECTION_MIN}-${CONNECTION_MAX})`, {
    validate: (value) => {
      const n = Number(value);
      if (!Number.isInteger(n) || n < CONNECTION_MIN || n > CONNECTION_MAX) {
        throw new ValidationError(`Enter an integer ${CONNECTION_MIN}-${CONNECTION_MAX}.`);
      }
      return n;
    },
  });

  config.owner.username = username;
  config.owner.password = passwordRecord;
  config.server.port = port;
  config.server.cloudflareOrigin = hostname ? `https://${hostname}` : '';
  config.cloudflare.hostname = hostname;
  config.cloudflare.teamDomain = teamDomain;
  config.cloudflare.aud = aud;
  config.cloudflare.ownerEmail = ownerEmail;
  config.limits.sessions = sessions;
  config.limits.connections = connections;

  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  store.save(config);
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true, mode: 0o700 });
  fs.chmodSync(CONFIG_PATH, 0o600);
  fs.chmodSync(path.dirname(CONFIG_PATH), 0o700);

  stdout.write(`\nConfiguration written to ${CONFIG_PATH} (0600).\n`);
  if (useQuickTunnel) {
    stdout.write('Remote access: a Cloudflare quick tunnel is deployed automatically on every start.\n');
    stdout.write('Start the server with: npm start, then open the printed Phone URL.\n');
  } else {
    stdout.write('Cloudflare Tunnel and Access provisioning is a manual step: see docs/setup.md.\n');
    stdout.write(`Start the server with: npm start\n`);
  }
  stdout.write('\n');
  rl.close();
}

main().catch((error) => {
  stdout.write(`\nSetup failed: ${error?.message ?? error}\n`);
  rl.close();
  process.exitCode = 1;
});

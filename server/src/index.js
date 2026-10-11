/**
 * Remote Terminal server entry point.
 *
 * Binds loopback only. Remote access is a Cloudflare quick tunnel by default; see
 * docs/adr/0004-quick-tunnel-by-default.md. Use --no-tunnel or TUNNEL=0 for loopback only.
 */
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import { LOGIN_SESSION_COOKIE, CSRF_COOKIE } from '@remote-terminal/shared';
import { createLogger } from './utils/logger.js';
import { CONFIG_PATH, STATE_DIR, SESSIONS_PATH, ensureDir } from './utils/fsPaths.js';
import { ConfigStore } from './utils/config.js';
import { SessionStore } from './auth/sessionStore.js';
import { RateLimiter } from './auth/rateLimiter.js';
import { OriginPolicy } from './auth/origin.js';
import { hashClientIdentity, CloudflareAssertionValidator } from './auth/cloudflare.js';
import { TerminalManager } from './terminal/terminalManager.js';
import { createHttpServer, closeHttpServer } from './http/createHttpApp.js';
import { createWebSocketGateway } from './websocket/gateway.js';
import { QuickTunnelManager } from './tunnel/tunnelManager.js';
import * as tunnelContext from './tunnel/tunnelContext.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src -> server -> repo root -> client/dist
const clientDist = path.resolve(here, '../../client/dist');

/** Tunnel is on by default. `--no-tunnel` and `TUNNEL=0` suppress it; `--tunnel` forces it. */
function resolveTunnelPlan(config) {
  const argv = process.argv.slice(2);
  if (argv.includes('--no-tunnel') || process.env.TUNNEL === '0') return { enabled: false, reason: 'suppressed' };
  if (argv.includes('--tunnel') || process.env.TUNNEL === '1') return { enabled: true, reason: 'forced' };
  const mode = config?.server?.tunnelMode ?? 'quick';
  if (mode === 'named') return { enabled: false, reason: 'named-tunnel-configured' };
  return { enabled: true, reason: 'default' };
}

async function main() {
  ensureDir(STATE_DIR);
  const logger = createLogger({ level: process.env.LOG_LEVEL ?? 'info', logFile: path.join(STATE_DIR, 'server.log') });
  logger.info('server_starting', { node: process.version, pid: process.pid });

  if (!fs.existsSync(clientDist)) {
    logger.warn('client_build_missing', { hint: 'run npm run build --workspace @remote-terminal/client' });
  }

  const store = new ConfigStore({ path: CONFIG_PATH });
  const config = store.load();
  if (!config) {
    logger.error('setup_required', { hint: 'run: npm run setup' });
    process.stderr.write('Setup is required. Run: npm run setup\n');
    process.exit(2);
  }
  if (config.server.port === 0) {
    logger.error('config_invalid', { reason: 'port_missing' });
    process.exit(2);
  }
  // A configuration without a password hash would start a server that rejects every login with no
  // explanation, and in tunnel mode would publish that dead end. Refuse to start instead.
  if (!config.owner || !config.owner.password) {
    logger.error('setup_incomplete', { reason: 'owner_password_missing', hint: 'run: npm run setup' });
    process.stderr.write(
      'No owner password is configured, so no one could sign in. Run: npm run setup\n',
    );
    process.exit(2);
  }

  const originPolicy = new OriginPolicy({ port: config.server.port, cloudflareOrigin: config.server.cloudflareOrigin });
  const sessions = new SessionStore();
  sessions.startPruning();

  const loginLimiter = new RateLimiter();
  const terminalManager = new TerminalManager({
    config,
    logger,
    dataPath: SESSIONS_PATH,
    homeDir: process.env.HOME ?? process.env.USERPROFILE ?? os.homedir(),
  });
  await terminalManager.init();

  const assertionValidator = new CloudflareAssertionValidator({
    teamDomain: config.cloudflare.teamDomain,
    aud: config.cloudflare.aud,
    ownerEmail: config.cloudflare.ownerEmail,
    logger,
  });

  const httpServer = createHttpServer({
    sessions,
    config,
    terminalManager,
    loginLimiter,
    originPolicy,
    logger,
    clientDistDir: clientDist,
    assertionValidator,
    hashClientIdentity,
    assertionRequired: () => !tunnelContext.isTunnelRunning(),
    tunnelActive: () => tunnelContext.isTunnelRunning(),
  });

  const gateway = createWebSocketGateway({
    server: httpServer,
    config,
    sessions,
    terminalManager,
    logger,
  });
  gateway.appContext.assertionValidator = assertionValidator;
  gateway.appContext.requireAssertion = () => !tunnelContext.isTunnelRunning();

  // Loopback only. The tunnel connects to this address; no other listener is opened.
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.server.port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  logger.info('server_listening', { host: '127.0.0.1', port: address.port, origin: config.server.cloudflareOrigin });

  // Record the pid so `npm run change-password` and `npm run revoke-sessions` can signal us.
  writePidFile();

  // Cloudflare quick tunnel: deployed by default. Suppress with --no-tunnel or TUNNEL=0.
  const tunnelPlan = resolveTunnelPlan(config);
  let tunnel = null;
  if (tunnelPlan.enabled) {
    tunnel = new QuickTunnelManager(address.port, { logger });
    tunnel.onStateChange((state, url) => {
      if (state === 'running' && url) {
        originPolicy.addRuntimeOrigin(url);
        tunnelContext.setActiveTunnel(url);
        printTunnelBanner(url);
        logger.info('tunnel_ready', { url });
        return;
      }
      const previous = tunnelContext.getTunnelOrigin();
      if (previous) originPolicy.removeRuntimeOrigin(previous);
      tunnelContext.clearActiveTunnel();
      if (state === 'error') {
        logger.warn('tunnel_error', {});
        process.stdout.write('  Tunnel:    failed to start (server still reachable on loopback)\n');
      }
    });
    tunnel.start();
  }

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_stopping', { signal });
    tunnel?.stop();
    sessions.revokeAll();
    gateway.close();
    terminalManager.broadcast = null;
    removePidFile();
    await closeHttpServer(httpServer);
    logger.info('server_stopped', {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  // PRD v1.2 section 6.3: a local password change or global revocation signals the running
  // process, which re-reads its configuration and revokes every Login Session.
  // PRD v1.2 section 6.3: a local password change or global revocation signals the running
  // process, which re-reads its configuration and revokes every Login Session.
  process.on('SIGHUP', () => {
    const reloaded = store.load();
    if (reloaded) {
      // The HTTP layer and gateway hold this object by reference, so mutating it in place takes
      // effect immediately without re-creating the server.
      config.owner.username = reloaded.owner.username;
      config.owner.password = reloaded.owner.password;
      config.limits.sessions = reloaded.limits.sessions;
      config.limits.connections = reloaded.limits.connections;
      config.server.cloudflareOrigin = reloaded.server.cloudflareOrigin;
      config.server.tunnelMode = reloaded.server.tunnelMode;
      logger.info('config_reloaded', {});
    }
    const revoked = sessions.revokeAll();
    logger.info('sessions_revoked', { revoked });
    process.stdout.write(`Reloaded configuration and revoked ${revoked} login session(s).\n`);
  });

  stdoutMessage(config, tunnelPlan);
}

function stdoutMessage(config, tunnelPlan) {
  let out =
    `Remote Terminal listening on http://127.0.0.1:${config.server.port}\n` +
    `Sessions: ${terminalCount(config)}\n`;
  if (tunnelPlan?.enabled) {
    out += '  Tunnel:    starting Cloudflare quick tunnel...\n';
  } else {
    out += '  Tunnel:    disabled (loopback only)\n';
  }
  process.stdout.write(out);
}

/** Prints the phone URL as soon as cloudflared reports it. */
function printTunnelBanner(url) {
  process.stdout.write(
    `\n  Phone URL: ${url}\n` +
      '  Open it on any device and sign in with your owner username and password.\n' +
      '  This URL is temporary and changes every time the server restarts.\n' +
      '  Anyone with this URL can reach the login screen: use a strong password.\n\n',
  );
}

function terminalCount(config) {
  return config.limits?.sessions ?? 0;
}

const PID_PATH = path.join(STATE_DIR, 'server.pid');

function writePidFile() {
  try {
    fs.writeFileSync(PID_PATH, `${process.pid}\n`, { mode: 0o600 });
  } catch {
    /* the CLI falls back to "changes apply on next start" */
  }
}

function removePidFile() {
  try {
    if (fs.readFileSync(PID_PATH, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_PATH);
  } catch {
    /* already gone */
  }
}

main().catch((error) => {
  process.stderr.write(`Server failed: ${error?.message ?? error}\n`);
  process.exit(1);
});

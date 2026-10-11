/**
 * Remote Terminal server entry point.
 *
 * Binds loopback only. Cloudflare provides remote ingress; see docs/setup.md.
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

const here = path.dirname(fileURLToPath(import.meta.url));
// server/src -> server -> repo root -> client/dist
const clientDist = path.resolve(here, '../../client/dist');

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
  });

  const gateway = createWebSocketGateway({
    server: httpServer,
    config,
    sessions,
    terminalManager,
    logger,
  });
  gateway.appContext.assertionValidator = assertionValidator;

  // Loopback only. Cloudflare Tunnel connects to this address; no other listener is opened.
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.server.port, '127.0.0.1', () => {
      httpServer.removeListener('error', reject);
      resolve();
    });
  });
  const address = httpServer.address();
  logger.info('server_listening', { host: '127.0.0.1', port: address.port, origin: config.server.cloudflareOrigin });

  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('server_stopping', { signal });
    sessions.revokeAll();
    gateway.close();
    terminalManager.broadcast = null;
    await closeHttpServer(httpServer);
    logger.info('server_stopped', {});
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  stdoutMessage(config);
}

function stdoutMessage(config) {
  process.stdout.write(
    `Remote Terminal listening on http://127.0.0.1:${config.server.port}\n` +
      `Remote origin: ${config.server.cloudflareOrigin}\n` +
      `Sessions: ${terminalCount(config)}\n`,
  );
}

function terminalCount(config) {
  return config.limits?.sessions ?? 0;
}

main().catch((error) => {
  process.stderr.write(`Server failed: ${error?.message ?? error}\n`);
  process.exit(1);
});

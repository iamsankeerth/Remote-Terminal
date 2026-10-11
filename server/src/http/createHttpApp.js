import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  HTTP_ERROR_CODES,
  HTTP_MAX_BODY_BYTES,
  LOGIN_SESSION_COOKIE,
  CSRF_COOKIE,
  ValidationError,
} from '@remote-terminal/shared';

function sameSiteCookie(name, value, { httpOnly = true, sameSite = 'Strict', maxAgeSeconds } = {}) {
  const parts = [`${name}=${value}`, 'Path=/', 'SameSite=Strict'];
  if (httpOnly) parts.push('HttpOnly');
  // Host-only cookie: no Domain attribute is emitted, so it is scoped to this exact host.
  if (typeof maxAgeSeconds === 'number') parts.push(`Max-Age=${maxAgeSeconds}`);
  return parts.join('; ');
}

function clearCookie(name, { httpOnly = true } = {}) {
  const parts = [`${name}=`, 'Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (httpOnly) parts.push('HttpOnly');
  return parts.join('; ');
}

function sendJson(res, status, body, extraHeaders = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    ...extraHeaders,
  });
  res.end(payload);
}

function sendError(res, status, code, message, details = undefined, extraHeaders = {}) {
  sendJson(res, status, { error: { code, message, ...(details ? { details } : {}) } }, extraHeaders);
}

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (typeof header !== 'string') return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!name) continue;
    out[name] = decodeURIComponent(value);
  }
  return out;
}

async function readJsonBody(req, limitBytes = HTTP_MAX_BODY_BYTES) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) {
      const error = new Error('Request body too large.');
      error.code = 'payload_too_large';
      throw error;
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
    return parsed;
  } catch {
    const error = new Error('Request body is not valid JSON.');
    error.code = 'bad_request';
    throw error;
  }
}

function isUnsafeMethod(method) {
  return method === 'POST' || method === 'PATCH' || method === 'PUT' || method === 'DELETE';
}

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function serveStatic(rootDir, req, res) {
  const url = new URL(req.url, 'http://localhost');
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === '/') pathname = '/index.html';
  const candidate = path.normalize(path.join(rootDir, pathname));
  if (!candidate.startsWith(rootDir + path.sep) || candidate === rootDir) {
    sendError(res, 400, HTTP_ERROR_CODES.BAD_REQUEST, 'Invalid path.');
    return;
  }
  fs.stat(candidate, (err, stats) => {
    if (err || !stats.isFile()) {
      sendError(res, 404, HTTP_ERROR_CODES.NOT_FOUND, 'Not found.');
      return;
    }
    const ext = path.extname(candidate).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
      'content-length': stats.size,
      'cache-control': 'no-store',
    });
    fs.createReadStream(candidate).pipe(res);
  });
}

/**
 * Application context passed to every route.
 * @typedef {Object} AppContext
 * @property {import('./auth/sessionStore.js').SessionStore} sessions
 * @property {any} config
 * @property {any} terminalManager
 * @property {import('./auth/rateLimiter.js').RateLimiter} loginLimiter
 * @property {import('./auth/origin.js').OriginPolicy} originPolicy
 * @property {import('./utils/logger.js')} logger
 * @property {string} clientDistDir
 * @property {any} assertionValidator
 * @property {() => boolean} [assertionRequired] returns false while a quick tunnel is running
 * @property {() => boolean} [tunnelActive] true while a quick tunnel is serving this process
 */
export function createHttpApp(ctx) {
  return async function handler(req, res) {
    const startedAt = Date.now();
    const requestId = randomBytes(8).toString('hex');
    try {
      const url = new URL(req.url, 'http://localhost');
      ctx.logger?.debug?.('http_request', {
        requestId,
        method: req.method,
        path: url.pathname,
        ms: Date.now() - startedAt,
      });
      // A request that arrived through the quick tunnel carries Cloudflare headers. Browsers send
      // no Origin header for top-level navigations and same-origin GETs, and the Host is then the
      // tunnel hostname rather than loopback, so such requests are accepted as long as any Origin
      // that *is* present still matches the allowlist. This is sound because the server binds
      // loopback: only cloudflared can connect, and it forwards nothing but our own tunnel.
      const viaTunnel = isRemoteRequest(req) && ctx.tunnelActive?.() === true;
      const originAllowed =
        viaTunnel && !req.headers.origin
          ? true
          : ctx.originPolicy.isAllowedRequest({
              origin: req.headers.origin,
              host: req.headers.host,
            });
      if (!originAllowed) {
        ctx.logger?.warn('origin_rejected', { requestId, path: url.pathname, viaTunnel: Boolean(viaTunnel) });
        sendError(res, 403, HTTP_ERROR_CODES.ORIGIN_REJECTED, 'Origin not allowed.');
        return;
      }

      if (url.pathname.startsWith('/api/')) {
        await handleApi(ctx, req, res, url);
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        if (ctx.clientDistDir && fs.existsSync(ctx.clientDistDir)) {
          serveStatic(ctx.clientDistDir, req, res);
          return;
        }
        sendJson(res, 200, { status: 'ok', service: 'remote-terminal', client: 'not-built' });
        return;
      }
      sendError(res, 404, HTTP_ERROR_CODES.NOT_FOUND, 'Not found.');
    } catch (error) {
      const code = error?.code ?? HTTP_ERROR_CODES.INTERNAL;
      const known = Object.values(HTTP_ERROR_CODES).includes(code) ? code : HTTP_ERROR_CODES.INTERNAL;
      const status = statusForCode(known);
      ctx.logger?.error('http_unhandled', {
        requestId,
        path: (() => {
          try {
            return new URL(req.url, 'http://localhost').pathname;
          } catch {
            return '';
          }
        })(),
        errorName: error?.name,
      });
      sendError(res, status, known, safeMessage(error));
    } finally {
      ctx.logger?.debug?.('http_response', { requestId, ms: Date.now() - startedAt });
    }
  };
}

function statusForCode(code) {
  switch (code) {
    case HTTP_ERROR_CODES.BAD_REQUEST:
      return 400;
    case HTTP_ERROR_CODES.UNAUTHORIZED:
      return 401;
    case HTTP_ERROR_CODES.FORBIDDEN:
      return 403;
    case HTTP_ERROR_CODES.NOT_FOUND:
      return 404;
    case HTTP_ERROR_CODES.CONFLICT:
      return 409;
    case HTTP_ERROR_CODES.PAYLOAD_TOO_LARGE:
      return 413;
    case HTTP_ERROR_CODES.RATE_LIMITED:
      return 429;
    case HTTP_ERROR_CODES.CF_UNAUTHORIZED:
      return 403;
    default:
      return 500;
  }
}

function safeMessage(error) {
  if (error instanceof ValidationError) return error.message;
  if (error?.code === 'payload_too_large') return 'Request body too large.';
  if (error?.code === 'bad_request') return error.message;
  return 'Internal error.';
}

async function handleApi(ctx, req, res, url) {
  const cookies = parseCookies(req);
  const pathname = url.pathname;

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    await handleLogin(ctx, req, res, cookies);
    return;
  }

  // Everything below requires a valid Login Session, and, for remote requests, a valid
  // Cloudflare Access assertion.
  const session = ctx.sessions.get(cookies[LOGIN_SESSION_COOKIE]);
  if (!session) {
    // Issue a pre-session CSRF cookie so the client can complete the double-submit login
    // without any authenticated state.
    const extraHeaders = cookies[CSRF_COOKIE]
      ? {}
      : { 'set-cookie': [sameSiteCookie(CSRF_COOKIE, randomBytes(32).toString('base64url'), { httpOnly: false })] };
    sendError(res, 401, HTTP_ERROR_CODES.UNAUTHORIZED, 'Authentication required.', undefined, extraHeaders);
    return;
  }

  // Cloudflare Access is required only when no quick tunnel is serving this process. A request
  // that carries Cloudflare headers can only have arrived through the tunnel, because the server
  // binds loopback and nothing else is public. Login, CSRF, and cookies always apply.
  const assertionRequired = typeof ctx.assertionRequired === 'function' ? ctx.assertionRequired() : true;
  if (isRemoteRequest(req) && assertionRequired && ctx.assertionValidator) {
    const assertion = req.headers['cf-access-jwt-assertion'];
    const result = await ctx.assertionValidator.validate(typeof assertion === 'string' ? assertion : '');
    if (!result.ok) {
      ctx.logger.warn('cloudflare_assertion_rejected', { reason: result.reason });
      sendError(res, 403, HTTP_ERROR_CODES.CF_UNAUTHORIZED, 'Access assertion rejected.');
      return;
    }
  }

  if (isUnsafeMethod(req.method)) {
    const csrfOk = timingSafeEqual(cookies[CSRF_COOKIE] ?? '', req.headers['x-csrf-token'] ?? '');
    if (!csrfOk) {
      sendError(res, 403, HTTP_ERROR_CODES.FORBIDDEN, 'CSRF token mismatch.');
      return;
    }
  }

  ctx.sessions.touch(session.id);

  if (req.method === 'POST' && pathname === '/api/auth/logout') {
    ctx.sessions.revoke(session.id);
    sendJson(res, 200, { ok: true }, {
      'set-cookie': [
        clearCookie(LOGIN_SESSION_COOKIE),
        clearCookie(CSRF_COOKIE, { httpOnly: false }),
      ],
    });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/auth/me') {
    sendJson(res, 200, { authenticated: true, session: { createdAt: session.createdAt } });
    return;
  }
  if (req.method === 'GET' && pathname === '/api/system/status') {
    sendJson(res, 200, {
      status: 'ok',
      serverTime: new Date().toISOString(),
      nodeVersion: process.version,
      sessions: ctx.terminalManager.list(),
      limits: ctx.config.limits,
    });
    return;
  }
  if (pathname === '/api/sessions') {
    if (req.method === 'GET') {
      sendJson(res, 200, { sessions: ctx.terminalManager.list() });
      return;
    }
    if (req.method === 'POST') {
      const body = await readJsonBody(req);
      const sessionEntry = await ctx.terminalManager.create({
        label: typeof body.label === 'string' ? body.label : undefined,
        cols: Number(body.cols) || 80,
        rows: Number(body.rows) || 24,
      });
      sendJson(res, 201, { session: publicSession(sessionEntry) });
      return;
    }
  }
  const match = /^\/api\/sessions\/([^/]+)$/.exec(pathname);
  if (match) {
    const id = decodeURIComponent(match[1]);
    if (req.method === 'PATCH') {
      const body = await readJsonBody(req);
      const updated = await ctx.terminalManager.rename(id, String(body.label ?? ''));
      if (!updated) {
        sendError(res, 404, HTTP_ERROR_CODES.NOT_FOUND, 'Terminal session not found.');
        return;
      }
      sendJson(res, 200, { session: publicSession(updated) });
      return;
    }
    if (req.method === 'DELETE') {
      const body = await readJsonBody(req);
      if (body.confirm !== true) {
        sendError(res, 400, HTTP_ERROR_CODES.BAD_REQUEST, 'Explicit confirmation is required to terminate.');
        return;
      }
      const terminated = await ctx.terminalManager.terminate(id);
      if (!terminated) {
        sendError(res, 404, HTTP_ERROR_CODES.NOT_FOUND, 'Terminal session not found.');
        return;
      }
      sendJson(res, 200, { ok: true, session: publicSession(terminated) });
      return;
    }
  }
  sendError(res, 404, HTTP_ERROR_CODES.NOT_FOUND, 'Not found.');
}

function publicSession(session) {
  return {
    id: session.id,
    label: session.label,
    createdAt: session.createdAt,
    attached: session.controllerId !== null,
    controller: session.controllerId !== null,
  };
}

/**
 * A request is remote when it arrived through Cloudflare. cloudflared connects to loopback, so
 * the socket peer is always 127.0.0.1 for remote traffic; the Cloudflare headers are the only
 * reliable signal.
 */
function isRemoteRequest(req) {
  return Boolean(req.headers['cf-ray'] || req.headers['cf-connecting-ip']);
}

function timingSafeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

async function handleLogin(ctx, req, res, cookies) {
  const identity = ctx.hashClientIdentity?.({
    ip: req.socket?.remoteAddress,
    userAgent: req.headers['user-agent'],
  }) ?? 'anonymous';
  const gate = ctx.loginLimiter.hit(`login:${identity}`);
  if (gate.blocked) {
    ctx.logger.warn('login_rate_limited', { identityHash: identity });
    sendError(res, 429, HTTP_ERROR_CODES.RATE_LIMITED, 'Too many login attempts.', undefined, {
      'retry-after': Math.ceil(gate.retryAfterMs / 1000),
    });
    return;
  }
  if (isUnsafeMethod(req.method)) {
    const csrfOk = timingSafeEqual(cookies[CSRF_COOKIE] ?? '', req.headers['x-csrf-token'] ?? '');
    if (!csrfOk) {
      sendError(res, 403, HTTP_ERROR_CODES.FORBIDDEN, 'CSRF token mismatch.');
      return;
    }
  }
  const body = await readJsonBody(req);
  const username = String(body.username ?? '');
  const password = String(body.password ?? '');
  const { verifyPassword } = await import('../auth/password.js');
  const record = ctx.config.owner?.password;
  const ok =
    record && username.length > 0 && password.length > 0 && (await verifyPassword(password, record));

  // Constant-time username comparison so timing does not distinguish missing accounts.
  const usernameOk = timingSafeEqualStr(username, ctx.config.owner?.username ?? '');
  if (!ok || !usernameOk) {
    ctx.logger.warn('login_failed', { identityHash: identity });
    sendError(res, 401, HTTP_ERROR_CODES.UNAUTHORIZED, 'Invalid credentials.');
    return;
  }
  ctx.loginLimiter.clear(`login:${identity}`);
  const session = ctx.sessions.create({
    userAgentHash: identity,
    ipHash: identity,
  });
  ctx.logger.info('login_succeeded', { identityHash: identity });
  sendJson(
    res,
    200,
    { authenticated: true, csrfToken: session.csrfToken },
    {
      'set-cookie': [
        sameSiteCookie(LOGIN_SESSION_COOKIE, session.id, { httpOnly: true, maxAgeSeconds: 30 * 24 * 60 * 60 }),
        sameSiteCookie(CSRF_COOKIE, session.csrfToken, { httpOnly: false, maxAgeSeconds: 30 * 24 * 60 * 60 }),
      ],
    },
  );
}

function timingSafeEqualStr(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  if (bufA.length === 0) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export function createHttpServer(ctx) {
  const server = http.createServer(createHttpApp(ctx));
  server.headersTimeout = 60_000;
  server.requestTimeout = 120_000;
  return server;
}

/** Closes a server and force-drops lingering sockets, for tests and shutdown. */
export function closeHttpServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections?.();
    server.closeAllConnections?.();
  });
}

export {
  sameSiteCookie,
  clearCookie,
  sendJson,
  sendError,
  parseCookies,
  readJsonBody,
  isUnsafeMethod,
  serveStatic,
  statusForCode,
  isRemoteRequest,
  MIME_TYPES,
};

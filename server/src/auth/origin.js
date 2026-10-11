/**
 * Origin and CSRF policy for HTTP mutations and WebSocket upgrades.
 *
 * Allowed origins: loopback origins on the server port, and exactly one configured Cloudflare
 * origin. Everything else is rejected. See PRD v1.2 sections 4.2 and 6.4.
 */

import crypto from 'node:crypto';

function normalizeOrigin(value) {
  if (typeof value !== 'string' || value === 'null' || value === '') return null;
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.host}`;
  } catch {
    return null;
  }
}

export function isLoopbackOrigin(origin, port) {
  try {
    const url = new URL(origin);
    const host = url.hostname;
    const isLoopbackHost =
      host === 'localhost' ||
      host === '127.0.0.1' ||
      host === '[::1]' ||
      host === '::1';
    if (!isLoopbackHost) return false;
    if (port !== undefined && Number(url.port) !== Number(port)) return false;
    return true;
  } catch {
    return false;
  }
}

export class OriginPolicy {
  constructor({ port, cloudflareOrigin }) {
    this.port = port;
    this.cloudflareOrigin = cloudflareOrigin ? normalizeOrigin(cloudflareOrigin) : null;
    this.allowed = new Set();
    if (this.cloudflareOrigin) this.allowed.add(this.cloudflareOrigin);
  }

  allow(origin) {
    const normalized = normalizeOrigin(origin);
    if (!normalized) return false;
    return this.allowed.has(normalized) || isLoopbackOrigin(normalized, this.port);
  }

  /**
   * Requests with no Origin header (curl, tests, same-machine tooling) are only allowed when the
   * Host is loopback. Any request that *does* present an Origin must match the allowlist.
   */
  isAllowedRequest({ origin, host }) {
    if (origin === undefined || origin === '' || origin === 'null') {
      return isLoopbackOrigin(`http://${host ?? '127.0.0.1'}`, this.port);
    }
    return this.allow(origin);
  }
}

/** Double-submit CSRF: the cookie value must equal the header value. */
export function csrfMatches({ cookieValue, headerValue }) {
  if (typeof cookieValue !== 'string' || typeof headerValue !== 'string') return false;
  if (cookieValue.length !== headerValue.length) return false;
  return crypto.timingSafeEqual(Buffer.from(cookieValue), Buffer.from(headerValue));
}

export function requireCsrf(request) {
  const cookieValue = request.cookies?.csrfToken ?? null;
  const headerValue = request.headers?.['x-csrf-token'] ?? null;
  return csrfMatches({ cookieValue, headerValue });
}

export function requireOrigin(request, policy) {
  const origin = request.headers?.origin;
  return policy.isAllowedRequest({ origin, host: request.headers?.host });
}

export default { OriginPolicy, isLoopbackOrigin, csrfMatches, requireCsrf, requireOrigin };

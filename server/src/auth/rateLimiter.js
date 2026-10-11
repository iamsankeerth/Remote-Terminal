import { LOGIN_RATE_LIMIT } from '@remote-terminal/shared';

/**
 * Fixed-window in-memory rate limiter keyed by an opaque string (already hashed client
 * identity), so no raw IPs or user agents are stored.
 */
export class RateLimiter {
  constructor({ attempts = LOGIN_RATE_LIMIT.attempts, windowMs = LOGIN_RATE_LIMIT.windowMs, now = () => Date.now() } = {}) {
    this.attempts = attempts;
    this.windowMs = windowMs;
    this.now = now;
    this.hits = new Map();
  }

  hit(key) {
    const now = this.now();
    const entry = this.hits.get(key);
    if (!entry || now - entry.startedAt >= this.windowMs) {
      this.hits.set(key, { startedAt: now, count: 1 });
      return { blocked: false, retryAfterMs: 0 };
    }
    entry.count += 1;
    if (entry.count > this.attempts) {
      return { blocked: true, retryAfterMs: Math.max(0, entry.startedAt + this.windowMs - now) };
    }
    return { blocked: false, retryAfterMs: 0 };
  }

  clear(key) {
    this.hits.delete(key);
  }

  prune() {
    const now = this.now();
    for (const [key, entry] of this.hits) {
      if (now - entry.startedAt >= this.windowMs) this.hits.delete(key);
    }
  }
}

export default RateLimiter;

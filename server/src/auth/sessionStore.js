import crypto from 'node:crypto';
import { LOGIN_SESSION_SLIDING_MS } from '@remote-terminal/shared';

/**
 * In-memory Login Session store. Sessions are opaque, never persisted, and never appear in
 * browser local storage. A server restart revokes every session because the map is empty.
 */
export class SessionStore {
  constructor({ slidingMs = LOGIN_SESSION_SLIDING_MS, now = () => Date.now() } = {}) {
    this.slidingMs = slidingMs;
    this.now = now;
    this.sessions = new Map();
    this.pruneTimer = null;
  }

  static generateId() {
    return crypto.randomBytes(32).toString('base64url');
  }

  create({ userAgentHash = null, ipHash = null } = {}) {
    const id = SessionStore.generateId();
    const createdAt = this.now();
    const csrfToken = SessionStore.generateId();
    this.sessions.set(id, {
      id,
      createdAt,
      lastSeenAt: createdAt,
      userAgentHash,
      ipHash,
      csrfToken,
    });
    return this.sessions.get(id);
  }

  get(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    if (this.isExpired(session)) {
      this.sessions.delete(id);
      return null;
    }
    return session;
  }

  isExpired(session) {
    return this.now() - session.lastSeenAt > this.slidingMs;
  }

  touch(id) {
    const session = this.get(id);
    if (!session) return null;
    session.lastSeenAt = this.now();
    return session;
  }

  revoke(id) {
    return this.sessions.delete(id);
  }

  revokeAll() {
    const count = this.sessions.size;
    this.sessions.clear();
    return count;
  }

  /** Rotates the CSRF token bound to this session. */
  rotateCsrf(id) {
    const session = this.get(id);
    if (!session) return null;
    session.csrfToken = SessionStore.generateId();
    return session.csrfToken;
  }

  size() {
    return this.sessions.size;
  }

  startPruning(intervalMs = 5 * 60 * 1000) {
    this.stopPruning();
    this.pruneTimer = setInterval(() => {
      const now = this.now();
      for (const [id, session] of this.sessions) {
        if (now - session.lastSeenAt > this.slidingMs) this.sessions.delete(id);
      }
    }, intervalMs);
    if (this.pruneTimer.unref) this.pruneTimer.unref();
  }

  stopPruning() {
    if (this.pruneTimer) clearInterval(this.pruneTimer);
    this.pruneTimer = null;
  }
}

export default SessionStore;

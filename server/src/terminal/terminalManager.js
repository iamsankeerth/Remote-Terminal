import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { randomBytes } from 'node:crypto';
import {
  TMUX_NAMESPACE,
  SESSION_LABEL_MAX_CODE_POINTS,
  SESSION_LABEL_MIN_CODE_POINTS,
  CONTROL_LEASE_SECONDS,
  SESSION_ACTIONS,
} from '@remote-terminal/shared';
import {
  ValidationError,
  assertValidLabel,
  assertSafeLabelForShell,
  normalizeForUniqueLabel,
} from '@remote-terminal/shared';
import { readJsonFile, writeJsonFileAtomic } from '../utils/fsPaths.js';
import TmuxManager, { makeInternalName, tmuxExec } from './tmuxManager.js';
import { PtyBridge, chunkOutput } from './ptyBridge.js';

const LISTENERS = new Set();

function uid() {
  return randomBytes(9).toString('base64url');
}

function defaultLabel(index) {
  return `Terminal ${index}`;
}

function pickLabel(usedKeys, requested) {
  if (requested === undefined) {
    let index = 1;
    while (usedKeys.has(normalizeForUniqueLabel(defaultLabel(index)))) index += 1;
    return defaultLabel(index);
  }
  assertValidLabel(requested);
  const key = normalizeForUniqueLabel(requested);
  if (usedKeys.has(key)) {
    throw new ValidationError('A terminal session with that label already exists.', 'conflict');
  }
  return requested;
}

function validateColsRows(cols, rows) {
  if (!Number.isInteger(cols) || !Number.isInteger(rows)) throw new ValidationError('cols and rows must be integers.');
  if (cols < 20 || cols > 1000 || rows < 5 || rows > 1000) {
    throw new ValidationError('cols must be 20..1000 and rows 5..1000.');
  }
}

/** Single owner of Terminal Session lifecycle and control leases. */
export class TerminalManager {
  constructor({ config, logger, dataPath, homeDir, now = () => Date.now() }) {
    this.config = config;
    this.logger = logger;
    this.homeDir = homeDir;
    this.now = now;
    this.sessions = new Map();
    this.tmux = new TmuxManager({ namespace: TMUX_NAMESPACE });
    this.dataPath = dataPath;
    this.counters = { created: 0 };
    this.broadcast = null; // set by gateway: (session) => void
  }

  async init() {
    const persisted = readJsonFile(this.dataPath, { schemaVersion: 1, sessions: [] });
    const list = Array.isArray(persisted.sessions) ? persisted.sessions : [];
    const live = await this.tmux.listManaged();
    const liveIds = new Set(live.map((s) => s.name.slice(TMUX_NAMESPACE.length)));

    for (const entry of list) {
      const { id, label, createdAt } = entry;
      if (!liveIds.has(id)) continue;
      this.sessions.set(id, {
        id,
        label,
        labelKey: normalizeForUniqueLabel(label),
        createdAt: createdAt ?? this.now(),
        bridge: null,
        controller: null,
        controllerId: null,
        leaseUntil: 0,
        exited: false,
        attached: 0,
      });
    }

    for (const liveEntry of live) {
      const id = liveEntry.name.slice(TMUX_NAMESPACE.length);
      if (this.sessions.has(id)) continue;
      this.sessions.set(id, {
        id,
        label: defaultLabel(++this.counters.created),
        labelKey: normalizeForUniqueLabel(defaultLabel(this.counters.created)),
        createdAt: Number(liveEntry.created) * 1000 || this.now(),
        bridge: null,
        controller: null,
        controllerId: null,
        leaseUntil: 0,
        exited: false,
        attached: 0,
      });
    }

    await this.persist();
    this.logger.info('terminal_sessions_recovered', { count: this.sessions.size });
    return this.sessions.size;
  }

  usedKeys() {
    return new Set([...this.sessions.values()].map((s) => s.labelKey));
  }

  assertCapacity() {
    const max = this.config.limits?.sessions ?? 1;
    if (this.sessions.size >= max) {
      throw new ValidationError(`Terminal session limit of ${max} reached.`, 'terminal_session_limit');
    }
  }

  async create({ label, cols = 80, rows = 24, requestedId } = {}) {
    validateColsRows(cols, rows);
    this.assertCapacity();
    const id = requestedId ?? uid();
    const chosen = pickLabel(this.usedKeys(), label);
    ensureDirectory(this.homeDir);
    const name = await this.tmux.create({ id, cwd: this.homeDir, cols, rows });
    this.counters.created += 1;
    const session = {
      id,
      label: chosen,
      labelKey: normalizeForUniqueLabel(chosen),
      internalName: name,
      createdAt: this.now(),
      bridge: null,
      controller: null,
      controllerId: null,
      leaseUntil: 0,
      exited: false,
      attached: 0,
      labelLength: [...chosen].length,
    };
    this.sessions.set(id, session);
    await this.persist();
    this.emitUpdate(session, 'created');
    this.logger.info('terminal_session_created', { sessionIdHash: hashId(session.id) });
    return session;
  }

  async rename(id, label) {
    const session = this.sessions.get(id);
    if (!session) return null;
    assertValidLabel(label);
    assertSafeLabelForShell(label);
    const others = new Set([...this.sessions.values()].filter((s) => s.id !== id).map((s) => s.labelKey));
    const key = normalizeForUniqueLabel(label);
    if (others.has(key)) throw new ValidationError('A terminal session with that label already exists.', 'conflict');
    session.label = label;
    session.labelKey = key;
    session.labelLength = [...label].length;
    await this.persist();
    this.emitUpdate(session, 'renamed');
    this.logger.info('terminal_session_renamed', { sessionIdHash: hashId(id) });
    return session;
  }

  get(id) {
    return this.sessions.get(id) ?? null;
  }

  list() {
    return [...this.sessions.values()].map((s) => ({
      id: s.id,
      label: s.label,
      createdAt: s.createdAt,
      attached: s.controllerId !== null,
      controller: s.controllerId !== null,
    }));
  }

  /** Detaches the pty client only; the tmux session keeps running. */
  async detach(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    session.bridge?.detach();
    return session;
  }

  /** Terminates the tmux session and forgets it. */
  async terminate(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    await this.tmux.kill(id);
    session.bridge?.detach();
    session.bridge = null;
    this.sessions.delete(id);
    await this.persist();
    this.emitUpdate(session, 'terminated');
    this.logger.info('terminal_session_terminated', { sessionIdHash: hashId(id) });
    return session;
  }

  /** Removes a session that exited naturally. */
  async handleNaturalExit(id) {
    const session = this.sessions.get(id);
    if (!session) return null;
    this.sessions.delete(id);
    await this.persist();
    this.emitUpdate(session, 'exited');
    this.logger.info('terminal_session_exited', { sessionIdHash: hashId(id) });
    return session;
  }

  /** Re-checks tmux after a restart and drops entries that no longer exist. */
  async reconcile() {
    const live = new Set((await this.tmux.listManaged()).map((s) => s.name.slice(TMUX_NAMESPACE.length)));
    for (const [id, session] of [...this.sessions]) {
      if (!live.has(id)) {
        this.sessions.delete(id);
        this.emitUpdate(session, 'exited');
      }
    }
    await this.persist();
  }

  /**
   * Control: exactly one Controller per Terminal Session. An unexpected disconnect reserves
   * control for the same browser client for CONTROL_LEASE_MS.
   */
  leaseActive(session, connectionId, now = this.now()) {
    if (!session.controllerId) return false;
    if (session.controllerId === connectionId) return false;
    const leaseWindow = CONTROL_LEASE_SECONDS * 1000;
    return session.leaseUntil > now && now - session.leaseUntil < leaseWindow + leaseWindow;
  }

  broadcastSessions() {
    for (const session of this.sessions.values()) {
      this.emitUpdate(session, session.exited ? 'exited' : 'created');
    }
  }

  emitUpdate(session, action) {
    if (!SESSION_ACTIONS.includes(action)) return;
    this.broadcast?.({
      type: 'terminal_session_updated',
      payload: {
        session: { id: session.id, label: session.label, createdAt: session.createdAt },
        action,
      },
    });
  }

  async persist() {
    await writeJsonFileAtomic(this.dataPath, {
      schemaVersion: 1,
      sessions: [...this.sessions.values()].map((s) => ({
        id: s.id,
        label: s.label,
        createdAt: s.createdAt,
      })),
    });
  }
}

function ensureDirectory(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* ignore */
  }
}

/** Stable non-reversible short id for logs. Never log raw session ids, labels, or content. */
function hashId(id) {
  return createHash('sha256').update(String(id)).digest('hex').slice(0, 12);
}

export { chunkOutput, makeInternalName };
export default TerminalManager;

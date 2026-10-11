import fs from 'node:fs';
import path from 'node:path';
import { ensureDir } from './fsPaths.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Structured logger. It writes one JSON object per line to stdout/stderr and optionally to a
 * file in the XDG state directory. It never accepts or forwards arbitrary objects that have not
 * been explicitly selected by the caller, and callers must never pass terminal output,
 * keystrokes, passwords, cookies, tokens, or JWTs into it.
 */
export function createLogger({ level = 'info', logFile = null, stream = process.stdout } = {}) {
  const min = LEVELS[level] ?? LEVELS.info;
  let fd = null;
  if (logFile) {
    try {
      ensureDir(path.dirname(logFile));
      fd = fs.openSync(logFile, 'a', 0o600);
    } catch {
      fd = null;
    }
  }

  function emit(lvl, msg, fields) {
    if ((LEVELS[lvl] ?? LEVELS.info) < min) return;
    const record = {
      ts: new Date().toISOString(),
      level: lvl,
      event: msg,
      ...(fields && typeof fields === 'object' ? fields : {}),
    };
    const line = `${JSON.stringify(record)}\n`;
    const target = lvl === 'error' ? process.stderr : stream;
    target.write(line);
    if (fd !== null) fs.writeSync(fd, line);
  }

  return {
    debug: (msg, fields) => emit('debug', msg, fields),
    info: (msg, fields) => emit('info', msg, fields),
    warn: (msg, fields) => emit('warn', msg, fields),
    error: (msg, fields) => emit('error', msg, fields),
    close() {
      if (fd !== null) fs.closeSync(fd);
      fd = null;
    },
  };
}

export default createLogger;

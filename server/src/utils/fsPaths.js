import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

/** XDG resolution with a safe fallback when the variables are unset. */
function xdgDir(envVar, fallback) {
  const value = process.env[envVar];
  if (typeof value === 'string' && path.isAbsolute(value)) return value;
  return path.join(os.homedir(), fallback);
}

export const CONFIG_DIR = path.join(xdgDir('XDG_CONFIG_HOME', '.config'), 'remote-terminal');
export const DATA_DIR = path.join(xdgDir('XDG_DATA_HOME', '.local/share'), 'remote-terminal');
export const STATE_DIR = path.join(xdgDir('XDG_STATE_HOME', '.local/state'), 'remote-terminal');

export const CONFIG_PATH = path.join(CONFIG_DIR, 'config.json');
export const SESSIONS_PATH = path.join(DATA_DIR, 'terminal-sessions.json');
export const LOG_DIR = STATE_DIR;

/** Creates a directory with 0700 if it does not exist. */
export function ensureDir(dir, mode = 0o700) {
  fs.mkdirSync(dir, { recursive: true, mode });
  try {
    fs.chmodSync(dir, mode);
  } catch {
    /* best effort on filesystems that do not support chmod */
  }
}

/** Reads UTF-8 JSON, or returns fallback when absent or unreadable. */
export function readJsonFile(filePath, fallback = null) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

/**
 * Atomic JSON write: write a temp file in the same directory, fsync, then rename.
 * Resulting file permissions are 0600.
 */
export function writeJsonFileAtomic(filePath, value, { mode = 0o600, dirMode = 0o700 } = {}) {
  ensureDir(path.dirname(filePath), dirMode);
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  const fd = fs.openSync(tmp, 'wx', mode);
  try {
    fs.writeFileSync(fd, data, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    fs.chmodSync(tmp, mode);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, filePath);
}

export function setFileMode(filePath, mode) {
  try {
    fs.chmodSync(filePath, mode);
  } catch {
    /* ignore */
  }
}

export default {
  CONFIG_DIR,
  DATA_DIR,
  STATE_DIR,
  CONFIG_PATH,
  SESSIONS_PATH,
  ensureDir,
  readJsonFile,
  writeJsonFileAtomic,
  setFileMode,
};

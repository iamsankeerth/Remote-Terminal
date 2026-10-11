import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import crypto from 'node:crypto';
import { TMUX_NAMESPACE } from '@remote-terminal/shared';

const execFileAsync = promisify(execFile);

/** Runs tmux with arguments. Never uses a shell, so no argument can be interpreted by one. */
async function tmux(args, { timeoutMs = 10_000 } = {}) {
  try {
    const { stdout } = await execFileAsync('tmux', args, {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: process.env,
    });
    return { ok: true, stdout, stderr: '' };
  } catch (error) {
    return {
      ok: false,
      stdout: String(error.stdout ?? ''),
      stderr: String(error.stderr ?? error.message),
      code: typeof error.code === 'number' ? error.code : null,
    };
  }
}

export function assertTmuxAvailable() {
  return tmux(['-V']);
}

/** Internal session identifier: namespace plus opaque random id. */
export function makeInternalName() {
  return `${TMUX_NAMESPACE}${crypto.randomBytes(8).toString('hex')}`;
}

function parseList(text) {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line))
    .filter((entry) => entry && typeof entry.name === 'string');
}

/**
 * tmux session and pane targets. Session names are always used directly (never interpolated into
 * a shell): the application's own namespace makes them unique, so no ambiguous-name resolution
 * or exact-match prefix is required.
 */
export class TmuxManager {
  constructor({ namespace = TMUX_NAMESPACE, captureLines = 200 } = {}) {
    this.namespace = namespace;
    this.captureLines = captureLines;
  }

  internalName(id) {
    return `${this.namespace}${id}`;
  }

  sessionIdOf(internalName) {
    return internalName.slice(this.namespace.length);
  }

  async create({ id, cwd, cols, rows }) {
    const name = this.internalName(id);
    const args = ['new-session', '-d', '-s', name, '-x', String(cols), '-y', String(rows)];
    if (cwd) args.push('-c', cwd);
    const result = await tmux(args);
    if (!result.ok) {
      throw new Error(`tmux new-session failed: ${result.stderr.trim()}`);
    }
    await tmux(['set-option', '-t', name, 'history-limit', '5000']);
    return name;
  }

  async exists(id) {
    return tmux(['has-session', '-t', this.internalName(id)]).then((r) => r.ok);
  }

  async kill(id) {
    return tmux(['kill-session', '-t', this.internalName(id)]).then((r) => r.ok);
  }

  async displaySize(id) {
    const result = await tmux([
      'display-message',
      '-p',
      '-t',
      this.internalName(id),
      '#{window_width} #{window_height}',
    ]);
    if (!result.ok) return null;
    const [cols, rows] = result.stdout.trim().split(/\s+/).map(Number);
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null;
    return { cols, rows };
  }

  async isAlive(id) {
    return (await this.displaySize(id)) !== null;
  }

  /** Captures the current pane viewport, which is all the product promises to restore. */
  async captureVisible(id) {
    const result = await tmux([
      'capture-pane',
      '-p',
      '-t',
      this.internalName(id),
      '-S',
      String(-Math.max(0, this.captureLines)),
    ]);
    if (!result.ok) return '';
    return result.stdout;
  }

  async listManaged() {
    const format =
      '{"name":"#{session_name}","created":"#{session_created}","windows":"#{session_windows}","attached":"#{session_attached}"}';
    const result = await tmux(['list-sessions', '-F', format]);
    if (!result.ok) return [];
    try {
      return parseList(result.stdout).filter((entry) => entry.name.startsWith(this.namespace));
    } catch {
      return [];
    }
  }

  /** Sends literal keys to the session, for tests and operational recovery only. */
  async sendKeys(id, keys) {
    const result = await tmux(['send-keys', '-t', this.internalName(id), ...keys]);
    return result.ok;
  }

  /**
   * Returns the spawn arguments for `tmux attach-session` run under node-pty.
   *
   * The pty's own dimensions are the client size: node-pty creates the pseudo-terminal with the
   * requested cols/rows and tmux follows it, so no size flags are passed (tmux 3.4 rejects them
   * on attach-session).
   */
  attachArgs({ id }) {
    return {
      file: 'tmux',
      args: ['attach-session', '-t', this.internalName(id)],
    };
  }
}

export { tmux as tmuxExec };

export default TmuxManager;

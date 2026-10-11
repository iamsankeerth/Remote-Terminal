import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Cloudflare quick tunnel: a free, ephemeral `*.trycloudflare.com` HTTPS URL that proxies to a
 * local port, with no Cloudflare account, login, DNS, or configuration file. See
 * docs/adr/0004-quick-tunnel-by-default.md.
 *
 * cloudflared dials out to Cloudflare's edge, so no inbound port is opened and the server can
 * keep binding loopback only.
 */

const TUNNEL_URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/**
 * Finds the cloudflared executable.
 *
 * `cloudflared` is frequently installed into `~/.local/bin`, which is only on PATH in login
 * shells. A server started from an IDE terminal, a script, or a service can therefore have a
 * PATH that does not contain it, so the well-known locations are checked explicitly.
 *
 * @returns {string|null} absolute path, or null when no executable was found
 */
export function resolveCloudflaredBinary({ env = process.env, home = os.homedir() } = {}) {
  const override = env.CLOUDFLARED_PATH;
  if (typeof override === 'string' && override.length > 0 && fs.existsSync(override)) return override;

  const candidates = [];
  const pathValue = env.PATH ?? '';
  for (const dir of pathValue.split(path.delimiter)) {
    if (dir) candidates.push(path.join(dir, 'cloudflared'));
  }
  if (home) {
    candidates.push(path.join(home, '.local', 'bin', 'cloudflared'));
    candidates.push(path.join(home, 'bin', 'cloudflared'));
  }
  if (process.platform === 'darwin') {
    candidates.push('/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared');
  }
  if (process.platform === 'win32' && env.LOCALAPPDATA) {
    candidates.push(path.join(env.LOCALAPPDATA, 'Microsoft', 'WinGet', 'Links', 'cloudflared.exe'));
    candidates.push(path.join(env.ProgramFiles, 'cloudflared', 'cloudflared.exe'));
  }
  candidates.push('/usr/local/bin/cloudflared', '/usr/bin/cloudflared', '/snap/bin/cloudflared');

  for (const candidate of candidates) {
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Extracts the quick tunnel URL from cloudflared output. Returns null when absent. */
export function parseTunnelUrl(output) {
  if (typeof output !== 'string') return null;
  const match = output.match(TUNNEL_URL_PATTERN);
  return match ? match[0] : null;
}

function installHint(platform) {
  if (platform === 'darwin') return 'brew install cloudflared';
  if (platform === 'win32') return 'winget install cloudflare.cloudflared';
  return 'curl -fsSL https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64 -o ~/.local/bin/cloudflared && chmod +x ~/.local/bin/cloudflared';
}

export class QuickTunnelManager {
  /**
   * @param {number} port Loopback port cloudflared should proxy to.
   * @param {{logger?: any, binary?: string, args?: string[], maxRetries?: number, retryDelayMs?: number, platform?: string}} [options]
   *   `binary` and `args` overrides exist for tests and troubleshooting; production uses the
   *   default `cloudflared tunnel --url http://127.0.0.1:<port> --no-autoupdate`.
   */
  constructor(port, options = {}) {
    this.port = port;
    this.logger = options.logger ?? console;
    // An explicit `binary` overrides discovery; otherwise the resolved path is used, and a final
    // fallback of "cloudflared" lets PATH resolution happen in the child if all else fails.
    this.binary =
      options.binary ??
      resolveCloudflaredBinary({ env: options.env ?? process.env, home: options.home }) ??
      'cloudflared';
    this.args = options.args ?? ['tunnel', '--url', `http://127.0.0.1:${port}`, '--no-autoupdate'];
    this.maxRetries = options.maxRetries ?? 1;
    this.retryDelayMs = options.retryDelayMs ?? 1500;
    this.platform = options.platform ?? process.platform;

    this.child = null;
    this.attempts = 0;
    this.stopping = false;
    this._state = 'stopped';
    this._url = null;
    this.handlers = [];
    this.retryTimer = null;
  }

  get state() {
    return this._state;
  }

  get url() {
    return this._url;
  }

  get isRunning() {
    return this._state === 'running';
  }

  onStateChange(handler) {
    this.handlers.push(handler);
    return () => {
      const index = this.handlers.indexOf(handler);
      if (index >= 0) this.handlers.splice(index, 1);
    };
  }

  start() {
    if (this._state === 'starting' || this._state === 'running') return;
    this.stopping = false;
    this.attempts += 1;
    this.spawn();
  }

  setState(state, url) {
    this._state = state;
    if (url !== undefined) this._url = url;
    for (const handler of this.handlers) {
      try {
        handler(state, this._url);
      } catch {
        /* a bad handler must never break the tunnel */
      }
    }
  }

  handleOutput(text) {
    if (this._state === 'running') return;
    const url = parseTunnelUrl(text);
    if (!url) return;
    this.logger.info?.('tunnel_running', { url });
    this.setState('running', url);
  }

  spawn() {
    this.setState('starting');

    let child;
    try {
      child = spawn(this.binary, this.args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (error) {
      this.onSpawnFailure(error);
      return;
    }
    this.child = child;

    child.stdout?.on('data', (data) => this.handleOutput(data.toString()));
    child.stderr?.on('data', (data) => this.handleOutput(data.toString()));

    child.on('error', (error) => {
      if (error && error.code === 'ENOENT') {
        this.logger.warn?.('tunnel_binary_missing', { binary: this.binary, install: installHint(this.platform) });
        this.child = null;
        this.setState('stopped');
        return;
      }
      this.onSpawnFailure(error);
    });

    child.on('close', (code) => {
      this.child = null;
      if (this.stopping) {
        // We stopped it on purpose; the child exiting is expected, not a crash.
        this._url = null;
        this.setState('stopped');
        return;
      }
      const wasRunning = this._state === 'running';
      if (wasRunning) {
        this._url = null;
        this.setState('stopped');
        return;
      }
      if (this.attempts <= this.maxRetries) {
        // Return to a clean state so the retry is not treated as a duplicate start().
        this.setState('stopped');
        this.retryTimer = setTimeout(() => {
          this.retryTimer = null;
          this.start();
        }, this.retryDelayMs);
        if (this.retryTimer.unref) this.retryTimer.unref();
        return;
      }
      this._url = null;
      this.logger.warn?.('tunnel_stopped_before_ready', { attempts: this.attempts, code: code ?? null });
      this.setState('stopped');
    });
  }

  onSpawnFailure(error) {
    this.child = null;
    this._url = null;
    this.logger.warn?.('tunnel_failed', { reason: String(error?.message ?? error).slice(0, 200) });
    this.setState('error');
  }

  /** Stops the tunnel. The server keeps running on loopback. */
  stop() {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    const child = this.child;
    this.child = null;
    this.stopping = true;
    if (child) {
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
      try {
        child.kill('SIGTERM');
      } catch {
        /* already gone */
      }
      const hardKill = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, 2000);
      if (hardKill.unref) hardKill.unref();
    }
    this._url = null;
    this.setState('stopped');
  }
}

export default QuickTunnelManager;

import nodePty from 'node-pty';
import { OUTPUT_CHUNK_MAX_BYTES, WS_MAX_OUTPUT_BUFFER_BYTES } from '@remote-terminal/shared';

/**
 * Bridges one browser connection to one tmux client process.
 *
 * node-pty runs `tmux attach-session`. tmux owns process lifetime, so the Terminal Session
 * survives every detach, browser disconnect, Cloudflare socket closure, and Node restart.
 *
 * Output is forwarded in bounded chunks. Backpressure is enforced by the owner of this bridge:
 * when the buffered byte count exceeds the limit, the connection is detached with a recoverable
 * error while tmux keeps running.
 */
export class PtyBridge {
  constructor({ file, args, cols, rows, onData, onExit, env = process.env, cwd }) {
    this.term = null;
    this.paused = false;
    this.exited = false;
    this.detaching = false;
    this.onData = onData;
    this.onExit = onExit;
    try {
      this.term = nodePty.spawn(file, args, {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: cwd || undefined,
        env,
      });
      this.term.onData((data) => {
        if (this.paused) return;
        this.onData?.(data);
      });
      this.term.onExit(({ exitCode, signal }) => {
        if (this.exited) return;
        this.exited = true;
        this.onExit?.({ exitCode, signal, detached: this.detaching });
      });
    } catch (error) {
      this.exited = true;
      this.onExit?.({ exitCode: 1, signal: null, error: String(error?.message ?? error) });
    }
  }

  write(data) {
    if (this.exited) return;
    this.term?.write(data);
  }

  resize({ cols, rows }) {
    if (this.exited) return;
    try {
      this.term?.resize(cols, rows);
    } catch {
      /* resize is best effort */
    }
  }

  /** Pauses forwarding without killing tmux (slow client protection). */
  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
  }

  /** Detaches this client only. The tmux session and its processes keep running. */
  detach() {
    if (this.exited) return;
    this.exited = true;
    this.detaching = true;
    try {
      this.term?.kill();
    } catch {
      /* ignore */
    }
  }

  get maxChunkBytes() {
    return OUTPUT_CHUNK_MAX_BYTES;
  }

  get bufferLimitBytes() {
    return WS_MAX_OUTPUT_BUFFER_BYTES;
  }
}

/** Splits a stream of text into bounded chunks so no single frame is unbounded. */
export function* chunkOutput(data, size = OUTPUT_CHUNK_MAX_BYTES) {
  const text = String(data);
  for (let i = 0; i < text.length; i += size) {
    yield text.slice(i, i + size);
  }
}

export default PtyBridge;

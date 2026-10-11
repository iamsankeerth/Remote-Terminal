import { useEffect, useRef } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

/**
 * Owns one xterm.js instance for one Terminal Session.
 *
 * One retained instance per tab: switching tabs must not destroy and recreate the terminal, so
 * the instance lives in a registry keyed by session id and React only mounts/unmounts its DOM
 * host element.
 */
const registry = new Map();

/**
 * Output that arrives before React has committed the terminal's DOM host is kept here and flushed
 * on mount, so a reconnect or reload never loses the opening snapshot or the first bytes.
 */
const pending = new Map();

const MAX_PENDING_BYTES = 1024 * 1024;

export function getTerminal(sessionId) {
  return registry.get(sessionId) ?? null;
}

export function ensureTerminal(sessionId, host, { fontSize, scrollback, onData, onResize }) {
  let entry = registry.get(sessionId);
  if (!entry) {
    const term = new Terminal({
      fontFamily: 'ui-monospace, "SF Mono", "Cascadia Mono", Menlo, Consolas, monospace',
      fontSize,
      scrollback,
      cursorBlink: true,
      allowProposedApi: true,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    entry = { term, fit, ready: false };
    registry.set(sessionId, entry);
    term.onData((data) => onData?.(data));
    term.onResize(({ cols, rows }) => onResize?.({ cols, rows }));
  }
  if (host) {
    mountTerminal(entry, host);
  }
  flushPending(sessionId);
  scheduleFit(entry);
  return entry;
}

/**
 * Attaches an xterm instance to a DOM host. `open` may only be called once per terminal, so an
 * already-open instance is moved into the new host instead (this is what lets a tab switch keep
 * the same terminal instance alive).
 */
function mountTerminal(entry, host) {
  const element = entry.term.element;
  if (!element) {
    entry.term.open(host);
    entry.ready = true;
    entry.term.focus();
    return;
  }
  if (element.parentElement === host) {
    entry.ready = true;
    entry.term.focus();
    return;
  }
  element.parentElement?.removeChild(element);
  host.appendChild(element);
  entry.ready = true;
  entry.term.focus();
}

function scheduleFit(entry) {
  requestAnimationFrame(() => {
    try {
      entry.fit.fit();
    } catch {
      /* host not yet laid out */
    }
  });
}

export function disposeTerminal(sessionId) {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.term.dispose();
  registry.delete(sessionId);
  pending.delete(sessionId);
}

export function writeOutput(sessionId, data) {
  const entry = registry.get(sessionId);
  if (!entry || !entry.ready) {
    const buffered = (pending.get(sessionId) ?? '') + data;
    // Bound the buffer the same way the server bounds its own output buffer.
    pending.set(sessionId, buffered.slice(-MAX_PENDING_BYTES));
    return;
  }
  entry.term.write(data);
}

/** Writes anything buffered for a session once its terminal is mounted. */
function flushPending(sessionId) {
  const buffered = pending.get(sessionId);
  if (!buffered) return;
  pending.delete(sessionId);
  const entry = registry.get(sessionId);
  if (entry?.ready) entry.term.write(buffered);
}

export function focusTerminal(sessionId) {
  registry.get(sessionId)?.term.focus();
}

/**
 * Fits the terminal to its host and returns its real dimensions, so the client can tell the
 * server its actual size up front instead of attaching at a guess. Returns null when the
 * terminal is not mounted yet; callers then attach without dimensions and the later
 * resize-on-fit syncs the server.
 */
export function getTerminalSize(sessionId) {
  const entry = registry.get(sessionId);
  if (!entry) return null;
  try {
    entry.fit.fit();
  } catch {
    return null;
  }
  const { cols, rows } = entry.term;
  if (!Number.isInteger(cols) || !Number.isInteger(rows) || cols <= 0 || rows <= 0) return null;
  return { cols, rows };
}

/** Refits a single terminal, or all of them when no id is given. */
export function fitAll(sessionId) {
  if (sessionId) {
    const entry = registry.get(sessionId);
    if (entry) {
      try {
        entry.fit.fit();
      } catch {
        /* ignore */
      }
    }
    return;
  }
  for (const entry of registry.values()) {
    try {
      entry.fit.fit();
    } catch {
      /* ignore */
    }
  }
}

export function useResizeHandler(activeSessionId) {
  const ref = useRef(activeSessionId);
  ref.current = activeSessionId;
  useEffect(() => {
    const onResize = () => fitAll(ref.current);
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    const id = setInterval(() => fitAll(ref.current), 1000);
    return () => {
      window.removeEventListener('resize', onResize);
      window.removeEventListener('orientationchange', onResize);
      clearInterval(id);
    };
  }, []);
}

export default {
  getTerminal,
  getTerminalSize,
  ensureTerminal,
  disposeTerminal,
  writeOutput,
  focusTerminal,
  fitAll,
  useResizeHandler,
};

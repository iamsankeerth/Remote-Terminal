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
  if (host && entry.term.element.parentElement !== host) {
    term_attach(entry, host);
  }
  scheduleFit(entry);
  return entry;
}

function term_attach(entry, host) {
  if (entry.term.element.parentElement) {
    entry.term.element.parentElement.removeChild(entry.term.element);
  }
  host.appendChild(entry.term.element);
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
}

export function writeOutput(sessionId, data) {
  const entry = registry.get(sessionId);
  if (!entry) return;
  entry.term.write(data);
}

export function focusTerminal(sessionId) {
  registry.get(sessionId)?.term.focus();
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
  ensureTerminal,
  disposeTerminal,
  writeOutput,
  focusTerminal,
  fitAll,
  useResizeHandler,
};

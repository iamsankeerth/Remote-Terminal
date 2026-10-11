import { useEffect, useRef } from 'react';
import { ensureTerminal } from '../hooks/useTerminal.js';

/**
 * TerminalView hosts one xterm.js instance. React manages the container; xterm owns the bytes.
 */
export function TerminalView({ sessionId, fontSize, scrollback, onData, onResize, active }) {
  const hostRef = useRef(null);
  const dataRef = useRef(onData);
  dataRef.current = onData;
  const resizeRef = useRef(onResize);
  resizeRef.current = onResize;

  useEffect(() => {
    if (!sessionId || !hostRef.current) return undefined;
    ensureTerminal(sessionId, hostRef.current, {
      fontSize,
      scrollback,
      onData: (data) => dataRef.current?.(data),
      onResize: (size) => resizeRef.current?.(size),
    });
    return undefined;
  }, [sessionId, fontSize, scrollback]);

  useEffect(() => {
    if (active) {
      const t = setTimeout(() => hostRef.current?.querySelector('textarea')?.focus(), 30);
      return () => clearTimeout(t);
    }
    return undefined;
  }, [active, sessionId]);

  return <div className="terminal-container" ref={hostRef} data-session={sessionId ?? ''} style={{ fontSize }} />;
}

export default TerminalView;

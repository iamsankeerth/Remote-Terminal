import { useCallback, useEffect, useRef, useState } from 'react';
import { WS_PATH, PROTOCOL_VERSION } from '../services/wsConstants.js';

/**
 * useTerminalSocket owns the browser WebSocket and its reconnection policy.
 *
 * Reconnects use jittered exponential backoff. On reconnect the session list is restored and the
 * previously selected Terminal Session is reattached without creating another tmux session.
 */
export function useTerminalSocket({ enabled, onMessage, onStateChange }) {
  const wsRef = useRef(null);
  const attemptRef = useRef(0);
  const reconnectTimerRef = useRef(null);
  const pendingRef = useRef([]);
  const [state, setState] = useState('connecting');
  const stateRef = useRef(state);
  stateRef.current = state;

  const pushState = useCallback(
    (next) => {
      if (stateRef.current === next) return;
      stateRef.current = next;
      setState(next);
      onStateChange?.(next);
    },
    [onStateChange],
  );

  const send = useCallback((type, sessionId, payload) => {
    const frame = JSON.stringify({ v: PROTOCOL_VERSION, type, sessionId, payload: payload ?? {} });
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(frame);
      return true;
    }
    // Queue protocol actions so a reconnect does not lose a user's intent.
    if (type === 'attach' || type === 'takeover' || type === 'detach' || type === 'input' || type === 'resize') {
      pendingRef.current.push(frame);
      if (pendingRef.current.length > 50) pendingRef.current.shift();
    }
    return false;
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;

    const flushPending = () => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const frames = pendingRef.current;
      pendingRef.current = [];
      for (const frame of frames) {
        try {
          ws.send(frame);
        } catch {
          pendingRef.current.unshift(frame);
          break;
        }
      }
    };

    const connect = () => {
      if (cancelled) return undefined;
      pushState(attemptRef.current === 0 ? 'connecting' : 'reconnecting');
      const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
      const url = `${protocol}//${location.host}${WS_PATH}`;
      const ws = new WebSocket(url);
      wsRef.current = ws;

      ws.onopen = () => {
        attemptRef.current = 0;
        pushState('connected');
        flushPending();
      };
      ws.onmessage = (event) => {
        let message;
        try {
          message = JSON.parse(event.data);
        } catch {
          return;
        }
        if (message?.type === 'error' && message.payload?.code === 'unauthorized') {
          pushState('authentication-expired');
          return;
        }
        onMessage?.(message);
      };
      ws.onclose = () => {
        if (cancelled) return;
        if (stateRef.current === 'authentication-expired') return;
        pushState('reconnecting');
        attemptRef.current += 1;
        const base = Math.min(15000, 500 * 2 ** Math.min(attemptRef.current, 6));
        const jitter = Math.random() * base * 0.3;
        reconnectTimerRef.current = setTimeout(connect, base + jitter);
      };
      ws.onerror = () => {
        try {
          ws.close();
        } catch {
          /* ignore */
        }
      };
      return undefined;
    };

    connect();
    return () => {
      cancelled = true;
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      try {
        wsRef.current?.close();
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    };
  }, [enabled, onMessage, pushState]);

  const retryNow = useCallback(() => {
    if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
    attemptRef.current = 0;
    try {
      wsRef.current?.close();
    } catch {
      /* ignore */
    }
  }, []);

  return { state, send, retryNow, socket: wsRef };
}

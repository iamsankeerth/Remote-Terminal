import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api.js';
import { loadPrefs, savePrefs } from '../services/prefs.js';
import { useTerminalSocket } from '../hooks/useTerminalSocket.js';
import { getTerminal, getTerminalSize, writeOutput, focusTerminal } from '../hooks/useTerminal.js';
import ConnectionStatus from './ConnectionStatus.jsx';
import SessionManager from './SessionManager.jsx';
import TerminalView from './TerminalView.jsx';
import ExtraKeys from './ExtraKeys.jsx';

export function TerminalWorkspace() {
  const prefs = useMemo(() => loadPrefs(), []);
  const [fontSize, setFontSize] = useState(prefs.fontSize);
  const [scrollback, setScrollback] = useState(prefs.scrollback);
  const [toolbarVisible, setToolbarVisible] = useState(prefs.toolbarVisible);
  const [toolbarCollapsed, setToolbarCollapsed] = useState(false);
  const [sessions, setSessions] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [managerOpen, setManagerOpen] = useState(false);
  const [wsState, setWsState] = useState('connecting');
  const [takeoverNotice, setTakeoverNotice] = useState('');
  const activeRef = useRef(null);
  activeRef.current = activeId;

  const persistPrefs = useCallback((next) => {
    savePrefs(next);
  }, []);

  useEffect(() => persistPrefs({ fontSize, scrollback, toolbarVisible }), [fontSize, scrollback, toolbarVisible, persistPrefs]);

  const refresh = useCallback(async () => {
    try {
      const { sessions: list } = await api.listSessions();
      setSessions(list);
      setActiveId((current) => {
        if (current && list.some((s) => s.id === current)) return current;
        return list.length > 0 ? list[0].id : null;
      });
    } catch {
      /* not authenticated or server down */
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const sendRef = useRef(null);

  const handleMessage = useCallback(
    (message) => {
      const type = message?.type;
      const payload = message?.payload ?? {};
      switch (type) {
        case 'output': {
          writeOutput(message.sessionId, payload.data ?? '');
          break;
        }
        case 'attached': {
          // The captured viewport arrives as an ordinary output frame right after this.
          if (payload.snapshot) writeOutput(message.sessionId, payload.snapshot);
          if (Number.isInteger(payload.foreignClients) && payload.foreignClients > 0) {
            setTakeoverNotice(
              'Another terminal is attached to this session — the display follows it. ' +
                'Detach it (Ctrl+b, d) for a clean view.',
            );
          }
          break;
        }
        case 'detached': {
          if (payload.reason === 'taken_over') setTakeoverNotice('Another device took control of this session.');
          if (payload.reason === 'reserved') setTakeoverNotice('Disconnected; control is reserved for this device briefly.');
          break;
        }
        case 'terminal_session_updated': {
          void refresh();
          break;
        }
        case 'error': {
          if (payload.code === 'control_leased') setTakeoverNotice(payload.message);
          break;
        }
        default:
          break;
      }
    },
    [refresh],
  );

  const { state, send, retryNow } = useTerminalSocket({
    enabled: true,
    onMessage: handleMessage,
    onStateChange: setWsState,
  });
  sendRef.current = send;

  // Attach to the active session whenever the socket is open and the selection changes.
  // The terminal is fitted first and its real dimensions travel with the attach, so full-screen
  // TUIs draw a layout that matches the viewport instead of an 80x24 guess. When the terminal is
  // not mounted yet the attach goes without dimensions and the resize-on-fit syncs the server.
  useEffect(() => {
    if (!activeId) return undefined;
    if (state !== 'connected') return undefined;
    const timer = setTimeout(() => {
      const size = getTerminalSize(activeId);
      sendRef.current?.('attach', activeId, size ?? undefined);
      focusTerminal(activeId);
    }, 50);
    return () => clearTimeout(timer);
  }, [activeId, state]);

  const createSession = async () => {
    // New tmux windows start at the current container size when a tab is already open.
    const size = activeId ? getTerminalSize(activeId) : null;
    const cols = size?.cols ?? 80;
    const rows = size?.rows ?? 24;
    try {
      const { session } = await api.createSession(undefined, cols, rows);
      await refresh();
      setActiveId(session.id);
    } catch (err) {
      setTakeoverNotice(err.message);
    }
  };

  const onTerminalData = useCallback(
    (data) => {
      const id = activeRef.current;
      if (!id) return;
      sendRef.current?.('input', id, { data });
    },
    [],
  );

  const onTerminalResize = useCallback(({ cols, rows }) => {
    const id = activeRef.current;
    if (!id) return;
    sendRef.current?.('resize', id, { cols, rows });
  }, []);

  const sendSpecial = useCallback(
    (data) => {
      const id = activeRef.current;
      if (!id) return;
      sendRef.current?.('input', id, { data });
    },
    [],
  );

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      location.reload();
    }
  };

  const activeSession = sessions.find((s) => s.id === activeId) ?? null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <span className="app-title">Remote Terminal</span>
        <ConnectionStatus state={wsState} />
        <span className="spacer" />
        <button type="button" className="primary" onClick={createSession}>
          New session
        </button>
        <button type="button" onClick={() => setManagerOpen(true)}>
          Sessions
        </button>
        <button
          type="button"
          onClick={() => setToolbarVisible((v) => !v)}
          aria-pressed={toolbarVisible}
        >
          Keys
        </button>
        <label className="badge" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Font
          <input
            type="range"
            min={10}
            max={22}
            value={fontSize}
            onChange={(e) => setFontSize(Number(e.target.value))}
            style={{ width: 70 }}
            aria-label="Font size"
          />
        </label>
        <label className="badge" style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          Backscroll
          <select
            value={scrollback}
            onChange={(e) => setScrollback(Number(e.target.value))}
            aria-label="Scrollback"
          >
            <option value={1000}>1k</option>
            <option value={2000}>2k</option>
            <option value={5000}>5k</option>
            <option value={10000}>10k</option>
          </select>
        </label>
        <button type="button" onClick={logout}>
          Logout
        </button>
      </header>

      <nav className="session-tabs" role="tablist" aria-label="Terminal sessions">
        {sessions.map((session) => (
          <button
            key={session.id}
            role="tab"
            className="session-tab"
            aria-selected={session.id === activeId}
            onClick={() => setActiveId(session.id)}
          >
            {session.label}
            {session.controller ? <span className="badge">●</span> : null}
          </button>
        ))}
        {sessions.length === 0 ? <span className="badge">No terminal sessions</span> : null}
      </nav>

      <main className="main">
        {activeSession ? (
          <TerminalView
            key={activeSession.id}
            sessionId={activeSession.id}
            fontSize={fontSize}
            scrollback={scrollback}
            active
            onData={onTerminalData}
            onResize={onTerminalResize}
          />
        ) : (
          <div className="notice" style={{ margin: 12 }}>
            No terminal session selected. Create one to start a shell on this host.
          </div>
        )}
        {takeoverNotice ? (
          <div className="notice" style={{ margin: 12 }} role="status">
            {takeoverNotice}
          </div>
        ) : null}
        {managerOpen ? (
          <SessionManager
            sessions={sessions}
            activeId={activeId}
            onSelect={setActiveId}
            onClose={() => setManagerOpen(false)}
            onChanged={() => void refresh()}
          />
        ) : null}
      </main>

      {toolbarVisible ? (
        <ExtraKeys onSend={sendSpecial} collapsed={toolbarCollapsed} onToggleCollapsed={setToolbarCollapsed} />
      ) : null}

      {wsState === 'reconnecting' ? (
        <div style={{ padding: 8 }} className="notice" role="status">
          Reconnecting… <button type="button" onClick={retryNow}>Retry now</button>
        </div>
      ) : null}
      {wsState === 'authentication-expired' ? (
        <div style={{ padding: 8 }} className="notice" role="status">
          Your login session expired. <button type="button" onClick={() => location.reload()}>Sign in again</button>
        </div>
      ) : null}
    </div>
  );
}

/** Small helper kept for tests: returns whether a terminal instance exists for a session. */
export function hasTerminalInstance(sessionId) {
  return getTerminal(sessionId) !== null;
}

export default TerminalWorkspace;

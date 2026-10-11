import { useState } from 'react';
import { api } from '../services/api.js';

/**
 * Session manager overlay: list, rename, and terminate with named confirmation.
 */
export function SessionManager({ sessions, activeId, onSelect, onClose, onChanged }) {
  const [renamingId, setRenamingId] = useState(null);
  const [draftLabel, setDraftLabel] = useState('');
  const [pendingTerminate, setPendingTerminate] = useState(null);
  const [error, setError] = useState('');

  const startRename = (session) => {
    setRenamingId(session.id);
    setDraftLabel(session.label);
  };

  const commitRename = async (id) => {
    try {
      await api.renameSession(id, draftLabel.trim());
      setRenamingId(null);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  const commitTerminate = async (id) => {
    try {
      await api.terminateSession(id);
      setPendingTerminate(null);
      if (activeId === id) onSelect(null);
      onChanged?.();
    } catch (err) {
      setError(err.message);
    }
  };

  return (
    <>
      <div className="session-manager">
        <div className="manager-row">
          <strong style={{ fontSize: 13 }}>Terminal sessions</strong>
          <span className="spacer" />
          <button type="button" onClick={onClose} aria-label="Close session manager">
            Close
          </button>
        </div>
        {sessions.length === 0 ? <p className="badge">No sessions yet. Create one with “New session”.</p> : null}
        {sessions.map((session) => (
          <div className="manager-row" key={session.id}>
            {renamingId === session.id ? (
              <>
                <input
                  value={draftLabel}
                  maxLength={64}
                  onChange={(e) => setDraftLabel(e.target.value)}
                  aria-label="New label"
                />
                <button type="button" className="primary" onClick={() => commitRename(session.id)}>
                  Save
                </button>
                <button type="button" onClick={() => setRenamingId(null)}>
                  Cancel
                </button>
              </>
            ) : (
              <>
                <span className="grow" title={session.label}>
                  {session.label}
                  {session.controller ? <span className="badge"> · controlled</span> : null}
                </span>
                <button type="button" onClick={() => { onSelect(session.id); onClose(); }}>
                  Attach
                </button>
                <button type="button" onClick={() => startRename(session)}>
                  Rename
                </button>
                <button type="button" className="danger" onClick={() => setPendingTerminate(session)}>
                  Terminate
                </button>
              </>
            )}
          </div>
        ))}
        {error ? <p className="error-text">{error}</p> : null}
      </div>
      {pendingTerminate ? (
        <div className="dialog-backdrop" role="dialog" aria-modal="true">
          <div className="dialog">
            <strong>Terminate “{pendingTerminate.label}”?</strong>
            <p className="badge">
              This kills the tmux session and every process inside it. Detaching keeps it running.
            </p>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button type="button" onClick={() => setPendingTerminate(null)}>
                Cancel
              </button>
              <button type="button" className="danger" onClick={() => commitTerminate(pendingTerminate.id)}>
                Terminate session
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

export default SessionManager;

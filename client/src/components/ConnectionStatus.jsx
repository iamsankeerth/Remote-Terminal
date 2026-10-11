export function ConnectionStatus({ state }) {
  const label = {
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    disconnected: 'Disconnected',
    'authentication-expired': 'Session expired',
    'server-unavailable': 'Server unavailable',
  }[state] ?? state;
  const cls = {
    connecting: 'status-reconnecting',
    connected: 'status-connected',
    reconnecting: 'status-reconnecting',
    disconnected: 'status-disconnected',
    'authentication-expired': 'status-disconnected',
    'server-unavailable': 'status-disconnected',
  }[state] ?? 'status-reconnecting';
  return (
    <span className={`status-pill ${cls}`} role="status" aria-live="polite">
      <span className="dot" />
      {label}
    </span>
  );
}

export default ConnectionStatus;

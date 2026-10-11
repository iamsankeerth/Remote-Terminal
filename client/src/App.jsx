import { useEffect, useState } from 'react';
import api from './services/api.js';
import Login from './components/Login.jsx';
import TerminalWorkspace from './components/TerminalWorkspace.jsx';
import ConnectionStatus from './components/ConnectionStatus.jsx';

export function App() {
  const [authenticated, setAuthenticated] = useState(null);
  const [serverUp, setServerUp] = useState(null);

  useEffect(() => {
    let cancelled = false;
    const check = async () => {
      // Fetch the CSRF token up front so the first mutation never has to wait for it.
      await api.ensureCsrf();
      try {
        const status = await api.systemStatus();
        if (!cancelled) {
          setServerUp(true);
        }
        void status;
      } catch {
        if (!cancelled) setServerUp(false);
      }
      try {
        await api.me();
        if (!cancelled) setAuthenticated(true);
      } catch {
        if (!cancelled) setAuthenticated(false);
      }
    };
    void check();
    const timer = setInterval(check, 5000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (authenticated === null) {
    return (
      <div className="login-screen">
        <div className="login-card">
          <strong>Loading…</strong>
          {serverUp === false ? <p className="error-text">Server unavailable.</p> : null}
        </div>
      </div>
    );
  }

  if (!authenticated) {
    return <Login onAuthenticated={() => setAuthenticated(true)} />;
  }

  return (
    <>
      <TerminalWorkspace />
      <div style={{ position: 'fixed', right: 8, bottom: 8 }}>
        <ConnectionStatus state={serverUp ? 'connected' : 'disconnected'} />
      </div>
    </>
  );
}

export default App;

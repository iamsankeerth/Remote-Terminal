import { useState } from 'react';
import { api } from '../services/api.js';

export function Login({ onAuthenticated }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.login(username, password);
      onAuthenticated();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-screen">
      <form className="login-card" onSubmit={submit}>
        <h1 style={{ margin: 0, fontSize: 18 }}>Remote Terminal</h1>
        <div className="field">
          <label htmlFor="username">Owner username</label>
          <input
            id="username"
            name="username"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck="false"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">Password</label>
          <div style={{ display: 'flex', gap: 6 }}>
            <input
              id="password"
              name="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
            <button type="button" onClick={() => setShowPassword((v) => !v)} aria-label="Show password">
              {showPassword ? 'Hide' : 'Show'}
            </button>
          </div>
        </div>
        {error ? <p className="error-text">{error}</p> : null}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
        <p className="badge">Cloudflare Access protects remote access. Sessions are host-only, HTTP-only, SameSite=Strict cookies.</p>
      </form>
    </div>
  );
}

export default Login;

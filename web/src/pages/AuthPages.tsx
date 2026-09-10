import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { VersoMark } from '../components/icons';

function AuthCard({
  title,
  lede,
  onSubmit,
  submitLabel,
  busy,
  error,
  children,
}: {
  title: string;
  lede: string;
  onSubmit: (e: FormEvent) => void;
  submitLabel: string;
  busy: boolean;
  error: string | null;
  children: React.ReactNode;
}) {
  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={onSubmit}>
        <span className="brand">
          <VersoMark size={34} style={{ color: 'var(--vx-primary)' }} />
          <span className="brand__name">Versovox</span>
        </span>
        <p className="auth-card__tagline">Read and listen in tandem</p>
        <h1>{title}</h1>
        <p className="lede">{lede}</p>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        {children}
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Please wait…' : submitLabel}
        </button>
      </form>
    </main>
  );
}

export function SetupPage() {
  const { setUser } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [setupToken, setSetupToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>('/api/setup', {
        method: 'POST',
        body: { username, password, setupToken: setupToken.trim() },
      });
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'bad-setup-token') {
        setError('Wrong setup token. Find it in the server log or your VX_SETUP_TOKEN setting.');
      } else {
        setError(
          err instanceof ApiError && err.code === 'invalid'
            ? (err.message.replace(/^invalid:?\s*/, '') ?? 'Invalid input.')
            : 'Setup failed. Is the server reachable?',
        );
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Create your admin account"
      lede="First run: enter the one-time setup token from the server log (or your VX_SETUP_TOKEN setting), then choose the administrator credentials. There are no default passwords."
      onSubmit={submit}
      submitLabel="Create account & scan library"
      busy={busy}
      error={error}
    >
      <div className="field">
        <label htmlFor="su-token">Setup token</label>
        <input
          id="su-token"
          className="input"
          autoComplete="off"
          required
          minLength={8}
          value={setupToken}
          onChange={(e) => setSetupToken(e.target.value)}
        />
        <span className="hint">
          Printed in the server log on first start; also at data/setup-token.
        </span>
      </div>
      <div className="field">
        <label htmlFor="su-user">Username</label>
        <input
          id="su-user"
          className="input"
          autoComplete="username"
          required
          minLength={3}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="su-pass">Password</label>
        <input
          id="su-pass"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          minLength={10}
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        <span className="hint">At least 10 characters.</span>
      </div>
      <div className="field">
        <label htmlFor="su-confirm">Confirm password</label>
        <input
          id="su-confirm"
          className="input"
          type="password"
          autoComplete="new-password"
          required
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
        />
      </div>
    </AuthCard>
  );
}

export function LoginPage() {
  const { setUser } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>('/api/auth/login', {
        method: 'POST',
        body: { username, password },
      });
      setUser(res.user);
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        setError('Too many attempts. Try again in a few minutes.');
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Wrong username or password.');
      } else {
        setError('Sign-in failed. Is the server reachable?');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthCard
      title="Welcome back"
      lede="Sign in to your Versovox server."
      onSubmit={submit}
      submitLabel="Sign in"
      busy={busy}
      error={error}
    >
      <div className="field">
        <label htmlFor="li-user">Username</label>
        <input
          id="li-user"
          className="input"
          autoComplete="username"
          required
          value={username}
          onChange={(e) => setUsername(e.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor="li-pass">Password</label>
        <input
          id="li-pass"
          className="input"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
      </div>
    </AuthCard>
  );
}

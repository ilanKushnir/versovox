import { useState, type FormEvent } from 'react';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { ReadPortMark } from '../components/icons';

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
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">ReadPort</span>
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
      lede="Sign in to your ReadPort server."
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

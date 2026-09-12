import { useEffect, useState, type FormEvent } from 'react';
import { ROLE_LABELS, type Role } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { ReadPortMark } from '../components/icons';

interface InvitePeek {
  role: Role;
  displayName: string | null;
  username: string | null;
  invitedBy: string | null;
  expiresAt: string;
}

/** Accept an invitation link: /join/<token>. The only self-service sign-up path. */
export function JoinPage({ token }: { token: string }) {
  const { setUser } = useSession();
  const [peek, setPeek] = useState<InvitePeek | null | 'invalid'>(null);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void api<InvitePeek>(`/api/invites/${encodeURIComponent(token)}`)
      .then((p) => {
        setPeek(p);
        setDisplayName(p.displayName ?? '');
        setUsername(p.username ?? '');
      })
      .catch(() => setPeek('invalid'));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>(`/api/invites/${encodeURIComponent(token)}/accept`, {
        method: 'POST',
        body: { username, password, displayName: displayName.trim() || undefined },
      });
      history.replaceState(null, '', '/');
      setUser(res.user);
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'username-taken'
          ? 'That username is taken — pick another.'
          : err instanceof ApiError && err.code === 'invalid-invite'
            ? 'This invitation is no longer valid.'
            : err instanceof ApiError && err.code === 'invalid'
              ? err.message.replace(/^invalid:?\s*/, '')
              : 'Could not create the account. Is the server reachable?',
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="auth-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <form className="auth-card" onSubmit={submit}>
        <span className="brand">
          <ReadPortMark size={34} style={{ color: 'var(--rp-primary)' }} />
          <span className="brand__name">ReadPort</span>
        </span>
        <p className="auth-card__tagline">Read and listen in tandem</p>
        {peek === null && <p className="lede">Checking your invitation…</p>}
        {peek === 'invalid' && (
          <>
            <h1>This link has expired</h1>
            <p className="lede">
              Invitations are single-use and time-limited. Ask whoever invited you for a fresh link.
            </p>
          </>
        )}
        {peek && peek !== 'invalid' && (
          <>
            <h1>You're invited</h1>
            <p className="lede">
              {peek.invitedBy ? `${peek.invitedBy} invited you` : 'You have been invited'} to join
              as a <strong>{ROLE_LABELS[peek.role].label.toLowerCase()}</strong>.{' '}
              {ROLE_LABELS[peek.role].blurb}
            </p>
            {error && (
              <div className="banner banner--error" role="alert">
                {error}
              </div>
            )}
            <div className="field">
              <label htmlFor="jn-name">Display name</label>
              <input
                id="jn-name"
                className="input"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="field">
              <label htmlFor="jn-user">Username</label>
              <input
                id="jn-user"
                className="input"
                autoComplete="username"
                required
                minLength={3}
                pattern="[a-zA-Z0-9._-]+"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="jn-pass">Password</label>
              <input
                id="jn-pass"
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
              <label htmlFor="jn-confirm">Confirm password</label>
              <input
                id="jn-confirm"
                className="input"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
            <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
              {busy ? 'Creating…' : 'Create my account'}
            </button>
          </>
        )}
      </form>
    </main>
  );
}

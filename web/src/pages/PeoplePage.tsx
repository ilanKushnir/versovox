import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, type InviteDto, type Role, type UserDto } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { Sheet, useToast } from '../components/ui';
import { IconAlert, IconCheck, IconClose, IconLink } from '../components/icons';
import { formatDate } from '../lib/format';

const ROLES: Role[] = ['admin', 'curator', 'reader'];

function ago(iso: string | null): string {
  if (!iso) return 'never';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 86_400 * 14) return `${Math.round(s / 86_400)} d ago`;
  return formatDate(iso);
}

function errorText(err: unknown, fallback: string): string {
  if (!(err instanceof ApiError)) return fallback;
  switch (err.code) {
    case 'username-taken':
      return 'That username is already taken.';
    case 'last-admin':
      return 'This is the last active admin — promote someone else first.';
    case 'self-lockout':
      return 'You cannot remove your own admin access.';
    case 'proxy-managed':
      return 'This account signs in through the reverse proxy; there is no local password.';
    case 'invalid':
      return err.message.replace(/^invalid:?\s*/, '');
    default:
      return fallback;
  }
}

/** Settings → People: accounts, roles, invitations. Admin only. */
export function PeoplePage() {
  const { user: me } = useSession();
  const toast = useToast();
  const [users, setUsers] = useState<UserDto[] | null>(null);
  const [invites, setInvites] = useState<InviteDto[]>([]);
  const [sheet, setSheet] = useState<'none' | 'add' | 'invite'>('none');
  const [editing, setEditing] = useState<UserDto | null>(null);
  const [link, setLink] = useState<{ url: string; role: Role; expiresAt: string } | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await api<{ users: UserDto[]; invites: InviteDto[] }>('/api/users');
      setUsers(res.users);
      setInvites(res.invites);
    } catch {
      setUsers([]);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  if (me?.role !== 'admin') {
    return (
      <main className="app-main" style={{ maxWidth: 820 }}>
        <p>Only admins manage people.</p>
      </main>
    );
  }

  const revokeInvite = async (id: string) => {
    try {
      await api(`/api/invites/${id}`, { method: 'DELETE' });
      toast.show('Invitation revoked');
      await load();
    } catch {
      toast.show('Could not revoke');
    }
  };

  return (
    <main className="app-main settings-page" style={{ maxWidth: 820 }}>
      <header className="page-head page-head--row">
        <div>
          <p className="crumb">
            <Link to="/settings">Settings</Link> / People
          </p>
          <h1>People</h1>
          <p>
            Everyone keeps their own reading position, bookmarks and downloads. There is no open
            sign-up: add someone directly or send them a one-time link.
          </p>
        </div>
        <div className="page-head__actions">
          <button className="btn btn--secondary" onClick={() => setSheet('invite')}>
            <IconLink size={16} /> Invite by link
          </button>
          <button className="btn" onClick={() => setSheet('add')}>
            Add person
          </button>
        </div>
      </header>

      <section className="roles-legend" aria-label="Roles">
        {ROLES.map((r) => (
          <div key={r} className={`roles-legend__item roles-legend__item--${r}`}>
            <strong>{ROLE_LABELS[r].label}</strong>
            <span>{ROLE_LABELS[r].blurb}</span>
          </div>
        ))}
      </section>

      <section className="settings-section" aria-label="Accounts">
        <h2>Accounts {users && <span className="section-title__count">{users.length}</span>}</h2>
        {!users ? (
          <div className="skeleton" style={{ height: 120 }} />
        ) : (
          <ul className="people">
            {users.map((u) => (
              <li key={u.id} className={`person ${u.status === 'disabled' ? 'is-disabled' : ''}`}>
                <span className={`person__avatar person__avatar--${u.role}`} aria-hidden="true">
                  {(u.displayName ?? u.username).slice(0, 1).toUpperCase()}
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {u.displayName ?? u.username}
                    {u.displayName && <span className="person__user"> @{u.username}</span>}
                    {u.id === me.id && <span className="person__you">you</span>}
                  </span>
                  <span className="person__meta">
                    <span className={`badge badge--role-${u.role}`}>
                      {ROLE_LABELS[u.role].label}
                    </span>
                    {u.status === 'disabled' && (
                      <span className="badge badge--muted">Disabled</span>
                    )}
                    {u.proxyManaged && <span className="badge badge--muted">Proxy sign-in</span>}
                    <span>Last seen {ago(u.lastLoginAt)}</span>
                    {u.booksInProgress > 0 && (
                      <span>
                        · {u.booksInProgress} book{u.booksInProgress === 1 ? '' : 's'} in progress
                      </span>
                    )}
                    {u.sessions > 0 && (
                      <span>
                        · {u.sessions} device{u.sessions === 1 ? '' : 's'}
                      </span>
                    )}
                  </span>
                </span>
                <button className="btn btn--ghost btn--sm" onClick={() => setEditing(u)}>
                  Manage
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {invites.length > 0 && (
        <section className="settings-section" aria-label="Pending invitations">
          <h2>
            Pending invitations <span className="section-title__count">{invites.length}</span>
          </h2>
          <ul className="people">
            {invites.map((i) => (
              <li key={i.id} className="person">
                <span className="person__avatar person__avatar--invite" aria-hidden="true">
                  <IconLink size={16} />
                </span>
                <span className="person__body">
                  <span className="person__name">
                    {i.displayName ?? i.username ?? 'Anyone with the link'}
                  </span>
                  <span className="person__meta">
                    <span className={`badge badge--role-${i.role}`}>
                      {ROLE_LABELS[i.role].label}
                    </span>
                    <span>Expires {formatDate(i.expiresAt)}</span>
                    {i.createdBy && <span>· from {i.createdBy}</span>}
                  </span>
                </span>
                <button className="btn btn--ghost btn--sm" onClick={() => void revokeInvite(i.id)}>
                  Revoke
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {sheet === 'add' && (
        <AddPersonSheet
          onClose={() => setSheet('none')}
          onDone={() => {
            setSheet('none');
            void load();
          }}
        />
      )}
      {sheet === 'invite' && (
        <InviteSheet
          onClose={() => setSheet('none')}
          onDone={(l) => {
            setSheet('none');
            setLink(l);
            void load();
          }}
        />
      )}
      {link && (
        <Sheet title="Invitation link" onClose={() => setLink(null)}>
          <p style={{ marginTop: 0 }}>
            Share this once. It creates one {ROLE_LABELS[link.role].label.toLowerCase()} account and
            stops working after use or on {formatDate(link.expiresAt)}.
          </p>
          <div className="linkbox">
            <input
              className="input"
              readOnly
              value={link.url}
              onFocus={(e) => e.currentTarget.select()}
            />
            <button
              className="btn"
              onClick={() => {
                void navigator.clipboard?.writeText(link.url).then(
                  () => toast.show('Link copied'),
                  () => toast.show('Select and copy the link'),
                );
              }}
            >
              Copy
            </button>
          </div>
        </Sheet>
      )}
      {editing && (
        <ManageSheet
          user={editing}
          isSelf={editing.id === me.id}
          onClose={() => setEditing(null)}
          onChanged={(u) => {
            setEditing(u);
            void load();
          }}
          onDeleted={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </main>
  );
}

function RolePicker({
  value,
  onChange,
  disabled,
}: {
  value: Role;
  onChange: (r: Role) => void;
  disabled?: boolean;
}) {
  return (
    <div className="role-picker" role="radiogroup" aria-label="Role">
      {ROLES.map((r) => (
        <button
          key={r}
          type="button"
          role="radio"
          aria-checked={value === r}
          disabled={disabled}
          className={`role-picker__opt ${value === r ? 'is-on' : ''}`}
          onClick={() => onChange(r)}
        >
          <strong>{ROLE_LABELS[r].label}</strong>
          <span>{ROLE_LABELS[r].blurb}</span>
        </button>
      ))}
    </div>
  );
}

function AddPersonSheet({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<Role>('reader');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/users', {
        method: 'POST',
        body: { username, password, role, displayName: displayName.trim() || undefined },
      });
      toast.show(`Added ${displayName.trim() || username}`);
      onDone();
    } catch (err) {
      setError(errorText(err, 'Could not add the account.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Add a person" onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="ap-name">Display name</label>
          <input
            id="ap-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Optional"
          />
        </div>
        <div className="field">
          <label htmlFor="ap-user">Username</label>
          <input
            id="ap-user"
            className="input"
            required
            minLength={3}
            pattern="[a-zA-Z0-9._-]+"
            autoComplete="off"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="ap-pass">Temporary password</label>
          <input
            id="ap-pass"
            className="input"
            type="text"
            required
            minLength={10}
            autoComplete="off"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <span className="hint">
            Tell them in person; they can change it under Settings → Account.
          </span>
        </div>
        <div className="field">
          <label>Role</label>
          <RolePicker value={role} onChange={setRole} />
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Adding…' : 'Add person'}
        </button>
      </form>
    </Sheet>
  );
}

function InviteSheet({
  onClose,
  onDone,
}: {
  onClose: () => void;
  onDone: (l: { url: string; role: Role; expiresAt: string }) => void;
}) {
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<Role>('reader');
  const [days, setDays] = useState(7);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ path: string; invite: { role: Role; expiresAt: string } }>(
        '/api/invites',
        {
          method: 'POST',
          body: { role, displayName: displayName.trim() || undefined, expiresInDays: days },
        },
      );
      onDone({
        url: `${location.origin}${res.path}`,
        role: res.invite.role,
        expiresAt: res.invite.expiresAt,
      });
    } catch (err) {
      setError(errorText(err, 'Could not create the invitation.'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Invite by link" onClose={onClose}>
      <form onSubmit={submit}>
        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}
        <div className="field">
          <label htmlFor="iv-name">Who is it for?</label>
          <input
            id="iv-name"
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            placeholder="Optional — shown on the invite"
          />
        </div>
        <div className="field">
          <label>Role</label>
          <RolePicker value={role} onChange={setRole} />
        </div>
        <div className="field">
          <label htmlFor="iv-days">Valid for</label>
          <select
            id="iv-days"
            className="input input--select"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            <option value={1}>1 day</option>
            <option value={3}>3 days</option>
            <option value={7}>7 days</option>
            <option value={14}>14 days</option>
            <option value={30}>30 days</option>
          </select>
        </div>
        <button className="btn" type="submit" disabled={busy} style={{ width: '100%' }}>
          {busy ? 'Creating…' : 'Create link'}
        </button>
      </form>
    </Sheet>
  );
}

function ManageSheet({
  user,
  isSelf,
  onClose,
  onChanged,
  onDeleted,
}: {
  user: UserDto;
  isSelf: boolean;
  onClose: () => void;
  onChanged: (u: UserDto) => void;
  onDeleted: () => void;
}) {
  const toast = useToast();
  const [displayName, setDisplayName] = useState(user.displayName ?? '');
  const [role, setRole] = useState<Role>(user.role);
  const [newPassword, setNewPassword] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const patch = async (body: Record<string, unknown>, okMsg: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: UserDto }>(`/api/users/${user.id}`, { method: 'PATCH', body });
      onChanged(res.user);
      toast.show(okMsg);
      return true;
    } catch (err) {
      setError(errorText(err, 'Could not save.'));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const dirty = displayName.trim() !== (user.displayName ?? '') || role !== user.role;

  return (
    <Sheet title={user.displayName ?? user.username} onClose={onClose}>
      {error && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="mg-name">Display name</label>
        <input
          id="mg-name"
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
        />
      </div>
      <div className="field">
        <label>Role</label>
        <RolePicker value={role} onChange={setRole} disabled={isSelf} />
        {isSelf && <span className="hint">Ask another admin to change your own role.</span>}
      </div>
      <button
        className="btn"
        disabled={!dirty || busy}
        onClick={() =>
          void patch(
            { displayName: displayName.trim() || null, ...(role !== user.role ? { role } : {}) },
            'Saved',
          )
        }
      >
        Save changes
      </button>

      {!user.proxyManaged && (
        <div className="manage-block">
          <h3>Reset password</h3>
          <p className="hint">Signs them out on every device; they sign back in with this one.</p>
          <div className="linkbox">
            <input
              className="input"
              type="text"
              autoComplete="off"
              minLength={10}
              placeholder="New password (10+ chars)"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
            <button
              className="btn btn--secondary"
              disabled={newPassword.length < 10 || busy}
              onClick={() =>
                void patch({ password: newPassword }, 'Password reset').then(
                  (ok) => ok && setNewPassword(''),
                )
              }
            >
              Reset
            </button>
          </div>
        </div>
      )}

      <div className="manage-block">
        <h3>Access</h3>
        <div className="manage-row">
          <button
            className="btn btn--secondary btn--sm"
            disabled={busy}
            onClick={async () => {
              try {
                const r = await api<{ revoked: number }>(
                  `/api/users/${user.id}/sign-out-everywhere`,
                  { method: 'POST' },
                );
                toast.show(
                  r.revoked
                    ? `Signed out of ${r.revoked} device${r.revoked === 1 ? '' : 's'}`
                    : 'No active sessions',
                );
                onChanged({ ...user, sessions: 0 });
              } catch {
                toast.show('Could not sign out');
              }
            }}
          >
            Sign out everywhere
          </button>
          {!isSelf && (
            <button
              className="btn btn--secondary btn--sm"
              disabled={busy}
              onClick={() =>
                void patch(
                  { status: user.status === 'disabled' ? 'active' : 'disabled' },
                  user.status === 'disabled' ? 'Account enabled' : 'Account disabled',
                )
              }
            >
              {user.status === 'disabled' ? (
                <>
                  <IconCheck size={14} /> Enable account
                </>
              ) : (
                <>
                  <IconClose size={14} /> Disable account
                </>
              )}
            </button>
          )}
        </div>
      </div>

      {!isSelf && (
        <div className="manage-block manage-block--danger">
          <h3>Delete account</h3>
          <p className="hint">
            Removes their progress, bookmarks and sessions. Library files are never touched.
          </p>
          {!confirmDelete ? (
            <button className="btn btn--danger btn--sm" onClick={() => setConfirmDelete(true)}>
              Delete {user.displayName ?? user.username}…
            </button>
          ) : (
            <div className="manage-row">
              <button
                className="btn btn--danger btn--sm"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  try {
                    await api(`/api/users/${user.id}`, { method: 'DELETE' });
                    toast.show('Account deleted');
                    onDeleted();
                  } catch (err) {
                    setError(errorText(err, 'Could not delete.'));
                  } finally {
                    setBusy(false);
                  }
                }}
              >
                Yes, delete permanently
              </button>
              <button className="btn btn--ghost btn--sm" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </div>
          )}
        </div>
      )}
    </Sheet>
  );
}

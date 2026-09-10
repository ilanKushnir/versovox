import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { type Job } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import { IconBookOpen, IconCheck, IconHeadphones, VersoMark } from '../components/icons';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';

/**
 * First-run wizard. Six short steps, each one screen: Welcome (setup token)
 * → Admin account → Libraries (with folder tests) → Language → Review →
 * Initialising (live progress of the first scan). Nothing is written until
 * "Finish" on the review step; every earlier step is just local state.
 */

type StepId = 'welcome' | 'admin' | 'libraries' | 'language' | 'review' | 'init';
const STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'admin', label: 'Admin' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'language', label: 'Language' },
  { id: 'review', label: 'Review' },
  { id: 'init', label: 'Ready' },
];

interface SetupStatus {
  needsSetup: boolean;
  setupTokenSource: string | null;
  libraries: {
    ebookDirs: string[];
    audiobookDirs: string[];
    envPinned: { ebookDirs: boolean; audiobookDirs: boolean };
  } | null;
  languages: { code: string; label: string }[] | null;
  defaultLanguage: string | null;
}

export function SetupWizard() {
  const { setUser } = useSession();
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<StepId>('welcome');
  const [token, setToken] = useState('');
  const [tokenOk, setTokenOk] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ebookDirs, setEbookDirs] = useState<string[]>([]);
  const [audioDirs, setAudioDirs] = useState<string[]>([]);
  const [language, setLanguage] = useState('en');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<User | null>(null);

  useEffect(() => {
    void api<SetupStatus>('/api/setup/status')
      .then((s) => {
        setStatus(s);
        setEbookDirs(s.libraries?.ebookDirs ?? []);
        setAudioDirs(s.libraries?.audiobookDirs ?? []);
        setLanguage(s.defaultLanguage ?? 'en');
      })
      .catch(() => setError('Could not reach the server.'));
  }, []);

  const folders = useMemo(() => folderApi(token.trim()), [token]);
  const stepIdx = STEPS.findIndex((s) => s.id === step);

  const verifyToken = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/setup/verify', { method: 'POST', body: { setupToken: token.trim() } });
      setTokenOk(true);
      setStep('admin');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'bad-setup-token'
          ? 'That token does not match. It is printed in the server log on first start (or set with VX_SETUP_TOKEN).'
          : err instanceof ApiError && err.status === 429
            ? 'Too many attempts — wait a few minutes.'
            : 'Could not verify the token. Is the server reachable?',
      );
    } finally {
      setBusy(false);
    }
  };

  const adminNext = (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setError('Passwords do not match.');
      return;
    }
    setError(null);
    setStep('libraries');
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api<{ user: User }>('/api/setup', {
        method: 'POST',
        body: {
          username,
          password,
          displayName: displayName.trim() || undefined,
          setupToken: token.trim(),
          ebookDirs,
          audiobookDirs: audioDirs,
          defaultLanguage: language,
        },
      });
      setCreatedUser(res.user);
      setStep('init');
    } catch (err) {
      setError(
        err instanceof ApiError && err.code === 'invalid'
          ? err.message.replace(/^invalid:?\s*/, '')
          : err instanceof ApiError && err.code === 'already-configured'
            ? 'This server was already set up — reload to sign in.'
            : 'Setup failed. Is the server reachable?',
      );
    } finally {
      setBusy(false);
    }
  };

  const pinned = status?.libraries?.envPinned ?? { ebookDirs: false, audiobookDirs: false };

  return (
    <main className="auth-page wizard-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <div className="wizard">
        <header className="wizard__head">
          <span className="brand">
            <VersoMark size={30} style={{ color: 'var(--vx-primary)' }} />
            <span className="brand__name">Versovox</span>
          </span>
          <ol className="wizard__steps" aria-label="Setup steps">
            {STEPS.map((s, i) => (
              <li
                key={s.id}
                className={i < stepIdx ? 'is-done' : i === stepIdx ? 'is-current' : ''}
                aria-current={i === stepIdx ? 'step' : undefined}
              >
                <span className="wizard__dot">{i < stepIdx ? <IconCheck size={12} /> : i + 1}</span>
                <span className="wizard__label">{s.label}</span>
              </li>
            ))}
          </ol>
        </header>

        {error && (
          <div className="banner banner--error" role="alert">
            {error}
          </div>
        )}

        {step === 'welcome' && (
          <form className="wizard__body" onSubmit={verifyToken}>
            <h1>Welcome to your reading room</h1>
            <p className="lede">
              Versovox reads the ebook and audiobook folders you already have, never changes them,
              and lets you switch between reading and listening at the exact sentence. Setup takes
              about two minutes.
            </p>
            <div className="field">
              <label htmlFor="wz-token">Setup token</label>
              <input
                id="wz-token"
                className="input"
                autoComplete="off"
                required
                autoFocus
                value={token}
                onChange={(e) => setToken(e.target.value)}
                spellCheck={false}
              />
              <span className="hint">
                Proves you control this server. Printed in the server log on first start
                {status?.setupTokenSource === 'file' ? ' and saved at data/setup-token' : ''}; or
                set VX_SETUP_TOKEN yourself.
              </span>
            </div>
            <div className="wizard__actions">
              <button className="btn" type="submit" disabled={busy || !token.trim()}>
                {busy ? 'Checking…' : 'Continue'}
              </button>
            </div>
          </form>
        )}

        {step === 'admin' && (
          <form className="wizard__body" onSubmit={adminNext}>
            <h1>Your admin account</h1>
            <p className="lede">
              The first account runs the server: it adds people, chooses libraries and manages
              speech models. You can add readers and curators later.
            </p>
            <div className="field">
              <label htmlFor="wz-name">Display name</label>
              <input
                id="wz-name"
                className="input"
                autoComplete="name"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="Optional"
              />
            </div>
            <div className="field">
              <label htmlFor="wz-user">Username</label>
              <input
                id="wz-user"
                className="input"
                autoComplete="username"
                required
                minLength={3}
                pattern="[a-zA-Z0-9._-]+"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
            <div className="wizard__row">
              <div className="field">
                <label htmlFor="wz-pass">Password</label>
                <input
                  id="wz-pass"
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
                <label htmlFor="wz-confirm">Confirm</label>
                <input
                  id="wz-confirm"
                  className="input"
                  type="password"
                  autoComplete="new-password"
                  required
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                />
              </div>
            </div>
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('welcome')}>
                Back
              </button>
              <button className="btn" type="submit">
                Continue
              </button>
            </div>
          </form>
        )}

        {step === 'libraries' && tokenOk && (
          <div className="wizard__body">
            <h1>Where are your books?</h1>
            <p className="lede">
              Point Versovox at the folders that hold your EPUBs and audiobooks, as the server sees
              them. Folders are only ever read; Calibre, Audiobookshelf and plain folders all work.
              Test each one before moving on.
            </p>
            <h2 className="wizard__h2">
              <IconBookOpen size={16} /> Ebook folders
            </h2>
            <LibraryFolders
              kind="ebook"
              value={ebookDirs}
              onChange={setEbookDirs}
              folders={folders}
              disabled={pinned.ebookDirs}
              pinnedNote={
                pinned.ebookDirs ? 'Set by VX_EBOOK_DIRS on the server; change it there.' : null
              }
            />
            <h2 className="wizard__h2">
              <IconHeadphones size={16} /> Audiobook folders
            </h2>
            <LibraryFolders
              kind="audio"
              value={audioDirs}
              onChange={setAudioDirs}
              folders={folders}
              disabled={pinned.audiobookDirs}
              pinnedNote={
                pinned.audiobookDirs
                  ? 'Set by VX_AUDIOBOOK_DIRS on the server; change it there.'
                  : null
              }
            />
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('admin')}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => setStep('language')}>
                {ebookDirs.length + audioDirs.length === 0 ? 'Skip for now' : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 'language' && (
          <div className="wizard__body">
            <h1>Which language are most books in?</h1>
            <p className="lede">
              Narration is transcribed by a speech model so the audiobook can be matched to the
              ebook sentence by sentence. The English-capable default model is fetched
              automatically; other languages use models you choose in Settings.
            </p>
            <div className="lang-grid" role="radiogroup" aria-label="Default language">
              {(status?.languages ?? [{ code: 'en', label: 'English' }]).map((l) => (
                <button
                  key={l.code}
                  type="button"
                  role="radio"
                  aria-checked={language === l.code}
                  className={`lang-chip ${language === l.code ? 'is-on' : ''}`}
                  onClick={() => setLanguage(l.code)}
                >
                  {l.label}
                </button>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              Each book's own language wins when it is known; this is only the fallback.
            </p>
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('libraries')}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => setStep('review')}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'review' && (
          <div className="wizard__body">
            <h1>Ready to go</h1>
            <p className="lede">Here is what will be set up. Nothing has been written yet.</p>
            <dl className="review">
              <div>
                <dt>Admin</dt>
                <dd>
                  {displayName.trim() ? `${displayName.trim()} · ` : ''}
                  <code>{username}</code>
                </dd>
              </div>
              <div>
                <dt>Ebook folders</dt>
                <dd>
                  {ebookDirs.length ? ebookDirs.map((p) => <code key={p}>{p}</code>) : 'None yet'}
                </dd>
              </div>
              <div>
                <dt>Audiobook folders</dt>
                <dd>
                  {audioDirs.length ? audioDirs.map((p) => <code key={p}>{p}</code>) : 'None yet'}
                </dd>
              </div>
              <div>
                <dt>Default language</dt>
                <dd>{status?.languages?.find((l) => l.code === language)?.label ?? language}</dd>
              </div>
            </dl>
            <div className="wizard__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep('language')}
                disabled={busy}
              >
                Back
              </button>
              <button type="button" className="btn" onClick={() => void finish()} disabled={busy}>
                {busy ? 'Setting up…' : 'Finish setup'}
              </button>
            </div>
          </div>
        )}

        {step === 'init' && createdUser && (
          <InitStep
            hasRoots={ebookDirs.length + audioDirs.length > 0}
            onEnter={() => setUser(createdUser)}
          />
        )}
      </div>
    </main>
  );
}

/** Live first-scan progress; the session cookie is already set by /api/setup. */
function InitStep({ hasRoots, onEnter }: { hasRoots: boolean; onEnter: () => void }) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [books, setBooks] = useState<number>(0);
  useEffect(() => {
    if (!hasRoots) return;
    let alive = true;
    const tick = async () => {
      try {
        const j = await api<{ jobs: Job[] }>('/api/jobs');
        const lib = await api<{ books: unknown[] }>('/api/library');
        if (!alive) return;
        setJobs(j.jobs);
        setBooks(lib.books.length);
      } catch {
        /* keep last */
      }
      if (alive) setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [hasRoots]);
  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const scan = jobs.find((j) => j.type === 'scan');
  const done =
    hasRoots && scan && scan.state !== 'queued' && scan.state !== 'running' && active.length === 0;
  const indexing = active.filter((j) => j.type.startsWith('index')).length;
  return (
    <div className="wizard__body">
      <h1>{done ? 'All set' : hasRoots ? 'Reading your shelves' : 'All set'}</h1>
      {!hasRoots ? (
        <p className="lede">
          No folders yet — add them any time under Settings → Libraries. You can already invite
          people and pick speech models.
        </p>
      ) : (
        <>
          <p className="lede">
            {done
              ? `${books} titles are in. Pairing suggestions appear once indexing settles; confirm them on the Pairing page.`
              : `Scanning folders and indexing what they hold. ${books} title${books === 1 ? '' : 's'} so far${indexing ? `, ${indexing} being indexed` : ''}. You can go in now — it keeps running.`}
          </p>
          <div className="progressbar" style={{ height: 6 }}>
            <span
              style={{
                width: `${done ? 100 : Math.max(6, Math.round((scan?.progress ?? 0.05) * 100))}%`,
                transition: 'width .5s ease',
              }}
            />
          </div>
          {scan?.detail && !done && (
            <p className="hint" style={{ marginTop: 8 }}>
              {scan.detail}
            </p>
          )}
        </>
      )}
      <div className="wizard__actions">
        <button type="button" className="btn" onClick={onEnter}>
          Open the library
        </button>
      </div>
    </div>
  );
}

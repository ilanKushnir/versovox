import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LANGUAGES, type Job } from '@readport/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconDownload,
  IconHeadphones,
  IconLink,
  ReadPortMark,
} from '../components/icons';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';
import { formatBytes } from '../lib/format';

/**
 * Setup wizard, in two modes.
 *
 * `first-run` — nobody exists yet: Welcome (bootstrap token) → Admin account
 * → Books → Ready.
 *
 * `libraries` — an admin already exists but no library folders are set. This
 * is the normal path behind reverse-proxy SSO, where the first user is
 * provisioned automatically and never sees a first-run screen: the same
 * wizard resumes at Books, authenticated by the session instead of the token.
 * Nothing is written until "Finish setup" in either mode.
 *
 * That last rule is why the model download is a CHOICE here and a POST inside
 * `finish()`: during first run there is no session yet, and
 * `/api/models/:id/download` is admin-only. Finishing keeps the operator on
 * the Ready screen — it turns into the live scan and download progress rather
 * than advancing to a step of its own.
 */

export type WizardMode = 'first-run' | 'libraries';

type StepId = 'welcome' | 'admin' | 'books' | 'ready';

const ALL_STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'admin', label: 'Admin' },
  { id: 'books', label: 'Books' },
  { id: 'ready', label: 'Ready' },
];

/** Remembered when an admin chooses "Skip for now", so it stops asking. */
const SKIP_KEY = 'rp-setup-libraries-skipped';

/** server/src/alignment/model.ts */
const ALIGNER_ID = 'alignment-model';
/** Catalog size, used only until the server's own report arrives. */
const ALIGNER_BYTES = 317_341_664;

interface SetupStatus {
  needsSetup: boolean;
  setupTokenSource: string | null;
  libraries: {
    ebookDirs: string[];
    audiobookDirs: string[];
    /** Absent on servers whose setup status predates the alignment folder. */
    alignmentDirs?: string[];
    envPinned: {
      ebookDirs: boolean;
      audiobookDirs: boolean;
      /** Absent on servers whose setup status predates the alignment folder. */
      alignmentDirs?: boolean;
      /** Only known once signed in; /api/setup/status does not report it. */
      defaultLanguage?: boolean;
    };
  } | null;
  languages: { code: string; label: string }[] | null;
  defaultLanguage: string | null;
}

/** Mirrors the report from POST /api/preflight (server/src/api/routes/preflight.ts). */
interface PreflightCheck {
  id: string;
  label: string;
  state: 'ok' | 'warn' | 'fail';
  detail: string;
  fix?: string;
}

interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  modelsDir: string;
  aligner: {
    id: string;
    label: string;
    licence: string | null;
    note: string;
    sizeBytes: number;
    installed: boolean;
    installedBytes: number;
    download: { state: string; progress: number; detail: string | null } | null;
    lastError: string | null;
  };
}

export function SetupWizard({
  mode = 'first-run',
  onDone,
}: {
  mode?: WizardMode;
  onDone?: () => void;
} = {}) {
  const { setUser, refresh } = useSession();
  const firstRun = mode === 'first-run';
  const STEPS = firstRun
    ? ALL_STEPS
    : ALL_STEPS.filter((s) => s.id !== 'welcome' && s.id !== 'admin');
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<StepId>(firstRun ? 'welcome' : 'books');
  /** Ready screen, after Finish: same step, now showing what is running. */
  const [initializing, setInitializing] = useState(false);
  const [token, setToken] = useState('');
  const [tokenOk, setTokenOk] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ebookDirs, setEbookDirs] = useState<string[]>([]);
  const [audioDirs, setAudioDirs] = useState<string[]>([]);
  const [alignDirs, setAlignDirs] = useState<string[]>([]);
  const [language, setLanguage] = useState('en');
  const [autoAlign, setAutoAlign] = useState(true);
  const [wantAligner, setWantAligner] = useState(true);
  const [preflight, setPreflight] = useState<PreflightReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [alignerFailed, setAlignerFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdUser, setCreatedUser] = useState<User | null>(null);

  useEffect(() => {
    if (firstRun) {
      void api<SetupStatus>('/api/setup/status')
        .then((s) => {
          setStatus(s);
          setEbookDirs(s.libraries?.ebookDirs ?? []);
          setAudioDirs(s.libraries?.audiobookDirs ?? []);
          setAlignDirs(s.libraries?.alignmentDirs ?? []);
          setLanguage(s.defaultLanguage ?? 'en');
        })
        .catch(() => setError('Could not reach the server.'));
      return;
    }
    // Already signed in: the settings endpoint knows the folders and which of
    // them the environment pins. The stored `alignmentDirs` is read rather
    // than the resolved path, so "unset" stays unset.
    void api<{
      settings: { defaultLanguage: string; alignmentDirs: string[]; autoAlign: boolean };
      envPinned: string[];
      paths: { ebookDirs: string[]; audiobookDirs: string[] };
    }>('/api/settings')
      .then((s) => {
        setStatus({
          needsSetup: false,
          setupTokenSource: null,
          libraries: {
            ebookDirs: s.paths.ebookDirs,
            audiobookDirs: s.paths.audiobookDirs,
            alignmentDirs: s.settings.alignmentDirs,
            envPinned: {
              ebookDirs: s.envPinned.includes('ebookDirs'),
              audiobookDirs: s.envPinned.includes('audiobookDirs'),
              alignmentDirs: s.envPinned.includes('alignmentDirs'),
              defaultLanguage: s.envPinned.includes('defaultLanguage'),
            },
          },
          languages: LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
          defaultLanguage: s.settings.defaultLanguage,
        });
        setEbookDirs(s.paths.ebookDirs);
        setAudioDirs(s.paths.audiobookDirs);
        setAlignDirs(s.settings.alignmentDirs ?? []);
        setLanguage(s.settings.defaultLanguage);
        setAutoAlign(s.settings.autoAlign ?? true);
      })
      .catch(() => setError('Could not reach the server.'));
  }, [firstRun]);

  // First run authorises the folder probes with the bootstrap token; an
  // admin session needs no token.
  const setupHeaders = useMemo(
    () => (firstRun && token.trim() ? { 'x-rp-setup-token': token.trim() } : undefined),
    [firstRun, token],
  );
  const folders = useMemo(() => folderApi(firstRun ? token.trim() : undefined), [firstRun, token]);
  const stepIdx = STEPS.findIndex((s) => s.id === step);
  const pinned = {
    ebookDirs: status?.libraries?.envPinned.ebookDirs ?? false,
    audiobookDirs: status?.libraries?.envPinned.audiobookDirs ?? false,
    alignmentDirs: status?.libraries?.envPinned.alignmentDirs ?? false,
    defaultLanguage: status?.libraries?.envPinned.defaultLanguage ?? false,
  };
  const languages = status?.languages ?? [{ code: 'en', label: 'English' }];
  const languageLabel = languages.find((l) => l.code === language)?.label ?? language;
  const aligner = preflight?.aligner ?? null;

  /**
   * Server self-check. All three folder lists are sent with it because on
   * first run they exist only in this form — the server has not been told
   * about them yet. `alignmentDirs` is the one the app will write to, so the
   * writable probe needs it; a server whose /api/preflight body schema
   * predates that field ignores the key rather than rejecting the request.
   */
  const runPreflight = useCallback(async () => {
    setChecking(true);
    try {
      setPreflight(
        await api<PreflightReport>('/api/preflight', {
          method: 'POST',
          body: { ebookDirs, audiobookDirs: audioDirs, alignmentDirs: alignDirs },
          headers: setupHeaders,
        }),
      );
    } catch {
      // Not fatal: the wizard still works, it just cannot show the ticks.
      setPreflight(null);
    } finally {
      setChecking(false);
    }
  }, [ebookDirs, audioDirs, alignDirs, setupHeaders]);

  // Re-check on entering the screen that shows the result. `runPreflight`
  // only changes identity when the chosen folders do, and those cannot change
  // from here, so this does not re-fire while the operator reads.
  useEffect(() => {
    if (step === 'ready' && !initializing) void runPreflight();
  }, [step, initializing, runPreflight]);

  // Move focus to the new step's heading so a screen reader announces it and
  // the keyboard lands in the right place. Not on the very first render: the
  // token field's autoFocus owns that.
  const rendered = useRef(false);
  useEffect(() => {
    if (!rendered.current) {
      rendered.current = true;
      return;
    }
    document.querySelector<HTMLElement>('.wizard__body h1')?.focus();
  }, [step, initializing]);

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
          ? 'That token does not match the one in the server log.'
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
    setStep('books');
  };

  /**
   * Start the model download, now that a session exists. Deliberately
   * non-fatal: setup has already succeeded by the time this runs, and the
   * model can always be fetched later from Settings → Alignment.
   */
  const startAlignerDownload = async () => {
    if (!wantAligner) return;
    if (preflight?.aligner.installed || preflight?.aligner.download) return;
    try {
      await api(`/api/models/${preflight?.aligner.id ?? ALIGNER_ID}/download`, { method: 'POST' });
    } catch {
      setAlignerFailed(true);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!firstRun) {
        await api('/api/settings', {
          method: 'PUT',
          body: {
            ...(pinned.ebookDirs ? {} : { ebookDirs }),
            ...(pinned.audiobookDirs ? {} : { audiobookDirs: audioDirs }),
            ...(pinned.alignmentDirs ? {} : { alignmentDirs: alignDirs }),
            ...(pinned.defaultLanguage ? {} : { defaultLanguage: language }),
            autoAlign,
          },
        });
        await startAlignerDownload();
        await api('/api/library/rescan', { method: 'POST' }).catch(() => {});
        setInitializing(true);
        return;
      }
      const res = await api<{ user: User }>('/api/setup', {
        method: 'POST',
        body: {
          username,
          password,
          displayName: displayName.trim() || undefined,
          setupToken: token.trim(),
          ebookDirs,
          audiobookDirs: audioDirs,
          ...(alignDirs.length ? { alignmentDirs: alignDirs } : {}),
          defaultLanguage: language,
          autoAlign,
        },
      });
      // The session cookie is set by /api/setup, so the admin-only download
      // endpoint is reachable from here on.
      await startAlignerDownload();
      setCreatedUser(res.user);
      setInitializing(true);
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

  return (
    <main className="auth-page wizard-page">
      <div className="auth-page__glow" aria-hidden="true" />
      <div className="wizard">
        <header className="wizard__head">
          <span className="brand">
            <ReadPortMark size={30} style={{ color: 'var(--rp-primary)' }} />
            <span className="brand__name">ReadPort</span>
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
            <h1 tabIndex={-1}>Welcome to your reading room</h1>
            <p className="lede">
              ReadPort reads the ebook and audiobook folders you already have, never changes them,
              and lets you switch between reading and listening at the exact sentence. Everything
              runs on this server: no cloud account, no upload. Setup takes about three minutes.
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
                Printed in the server log on first start
                {status?.setupTokenSource === 'file' ? ', and saved at data/setup-token' : ''}.
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
            <h1 tabIndex={-1}>Your admin account</h1>
            <p className="lede">
              The first account runs the server: it adds people and chooses the folders. You can add
              readers and curators later.
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

        {step === 'books' && (tokenOk || !firstRun) && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>Where are your books?</h1>
            <p className="lede">
              Point ReadPort at the folders that hold your EPUBs and audiobooks, as the server sees
              them. Calibre, Audiobookshelf and plain folders all work. Test each one before moving
              on.
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
                pinned.ebookDirs ? 'Set by RP_EBOOK_DIRS on the server; change it there.' : null
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
                  ? 'Set by RP_AUDIOBOOK_DIRS on the server; change it there.'
                  : null
              }
            />
            <h2 className="wizard__h2">
              <IconLink size={16} /> Alignment folder
            </h2>
            <p className="hint" style={{ marginBlockEnd: 10 }}>
              Finished alignments are saved here, and this is the only folder ReadPort writes to.
              Leave it empty to keep them inside the app&rsquo;s data volume, where rebuilding the
              container loses them.
            </p>
            <LibraryFolders
              kind="alignment"
              value={alignDirs}
              onChange={setAlignDirs}
              folders={folders}
              disabled={pinned.alignmentDirs}
              pinnedNote={
                pinned.alignmentDirs
                  ? 'Set by RP_ALIGNMENT_DIRS on the server; change it there.'
                  : null
              }
            />
            <div className="field" style={{ maxWidth: 340, marginBlockStart: 'var(--sp-5)' }}>
              <label htmlFor="wz-lang">Most of my books are in</label>
              <select
                id="wz-lang"
                className="input"
                value={language}
                disabled={pinned.defaultLanguage}
                onChange={(e) => setLanguage(e.target.value)}
              >
                {languages.map((l) => (
                  <option key={l.code} value={l.code}>
                    {l.label}
                  </option>
                ))}
              </select>
              <span className="hint">
                {pinned.defaultLanguage
                  ? 'Set by RP_DEFAULT_LANGUAGE on the server; change it there.'
                  : 'Only used when a book doesn’t say.'}
              </span>
            </div>
            <div className="wizard__actions">
              {firstRun ? (
                <button type="button" className="btn btn--ghost" onClick={() => setStep('admin')}>
                  Back
                </button>
              ) : (
                <button
                  type="button"
                  className="btn btn--ghost"
                  onClick={() => {
                    localStorage.setItem(SKIP_KEY, '1');
                    onDone?.();
                  }}
                >
                  Skip for now
                </button>
              )}
              <button
                type="button"
                className="btn"
                onClick={() => setStep('ready')}
                disabled={!firstRun && ebookDirs.length + audioDirs.length === 0}
              >
                {firstRun && ebookDirs.length + audioDirs.length === 0
                  ? 'Skip for now'
                  : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 'ready' && !initializing && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>Ready to go</h1>
            <p className="lede">Here is what will be set up. Nothing has been written yet.</p>
            <dl className="review">
              {firstRun && (
                <div>
                  <dt>Admin</dt>
                  <dd>
                    {displayName.trim() ? `${displayName.trim()} · ` : ''}
                    <code>{username}</code>
                  </dd>
                </div>
              )}
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
                <dt>Alignment folder</dt>
                <dd>
                  {alignDirs.length
                    ? alignDirs.map((p) => <code key={p}>{p}</code>)
                    : 'Inside the app data volume'}
                </dd>
              </div>
              <div>
                <dt>Language</dt>
                <dd>{languageLabel}</dd>
              </div>
            </dl>

            {aligner?.installed ? (
              <p className="hint" style={{ marginBlockStart: 'var(--sp-4)' }}>
                The alignment model is already on this server.
              </p>
            ) : aligner?.download ? (
              <p className="hint" style={{ marginBlockStart: 'var(--sp-4)' }}>
                The alignment model is downloading — {Math.round(aligner.download.progress * 100)}%.
              </p>
            ) : (
              <label className="rs-toggle" style={{ maxWidth: 620 }}>
                <span>
                  Download the alignment model when I finish (
                  {formatBytes(aligner?.sizeBytes ?? ALIGNER_BYTES)})
                  <span className="hint" style={{ display: 'block' }}>
                    Licensed for personal use, not for a paid service.
                  </span>
                </span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={wantAligner}
                  onChange={(e) => setWantAligner(e.target.checked)}
                />
              </label>
            )}
            {aligner?.lastError && !aligner.download && !aligner.installed && (
              <p className="hint" style={{ marginBlockStart: 8, color: 'var(--rp-danger)' }}>
                The last download attempt failed: {aligner.lastError}
              </p>
            )}

            <label className="rs-toggle" style={{ maxWidth: 620 }}>
              <span>
                Align new matches automatically
                <span className="hint" style={{ display: 'block' }}>
                  Off means nothing runs until you press Start on a book.
                </span>
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={autoAlign}
                onChange={(e) => setAutoAlign(e.target.checked)}
              />
            </label>

            <h2 className="wizard__h2" style={{ justifyContent: 'space-between' }}>
              <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <IconCheck size={16} /> Server check
              </span>
              <button
                type="button"
                className="btn btn--ghost"
                style={{ minHeight: 32, fontSize: 13 }}
                onClick={() => void runPreflight()}
                disabled={checking}
              >
                {checking ? 'Checking…' : 'Run again'}
              </button>
            </h2>
            <CheckList report={preflight} checking={checking} />

            <div className="wizard__actions">
              <button
                type="button"
                className="btn btn--ghost"
                onClick={() => setStep('books')}
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

        {step === 'ready' && initializing && (createdUser || !firstRun) && (
          <InitStep
            hasRoots={ebookDirs.length + audioDirs.length > 0}
            watchAligner={wantAligner && !alignerFailed && !aligner?.installed}
            alignerFailed={alignerFailed}
            onEnter={() => {
              // Finishing with no folders is a deliberate skip: don't bounce
              // straight back into the wizard.
              if (ebookDirs.length + audioDirs.length > 0) localStorage.removeItem(SKIP_KEY);
              else localStorage.setItem(SKIP_KEY, '1');
              if (createdUser) setUser(createdUser);
              else void refresh().then(() => onDone?.());
            }}
          />
        )}
      </div>
    </main>
  );
}

/** Green ticks and honest red crosses for the server self-check. */
function CheckList({ report, checking }: { report: PreflightReport | null; checking: boolean }) {
  if (!report) {
    return checking ? (
      <div className="skeleton" style={{ height: 96 }} />
    ) : (
      <p className="folders__empty">
        The server could not be checked from here. That does not block setup.
      </p>
    );
  }
  return (
    <ul className="folders__list">
      {report.checks.map((c) => (
        <li
          key={c.id}
          className={`folders__row ${c.state === 'ok' ? 'is-ok' : c.state === 'fail' ? 'is-bad' : ''}`}
        >
          <span className="folders__icon" aria-hidden="true">
            {c.state === 'ok' ? <IconCheck size={15} /> : <IconAlert size={15} />}
          </span>
          <span className="folders__body">
            <span style={{ fontSize: 13.5 }}>
              {c.label}
              <span className="visually-hidden">
                {c.state === 'ok' ? ': passed' : c.state === 'fail' ? ': failed' : ': warning'}
              </span>
            </span>
            <span className="folders__meta">
              {c.detail}
              {c.fix ? ` — ${c.fix}` : ''}
            </span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Live first-scan progress, plus the model download this wizard just started;
 * the session cookie is already set by /api/setup.
 */
function InitStep({
  hasRoots,
  watchAligner,
  alignerFailed,
  onEnter,
}: {
  hasRoots: boolean;
  watchAligner: boolean;
  alignerFailed: boolean;
  onEnter: () => void;
}) {
  const [jobs, setJobs] = useState<Job[]>([]);
  const [books, setBooks] = useState<number>(0);
  const [aligner, setAligner] = useState<PreflightReport['aligner'] | null>(null);
  useEffect(() => {
    if (!hasRoots && !watchAligner) return;
    let alive = true;
    const tick = async () => {
      try {
        if (hasRoots) {
          const j = await api<{ jobs: Job[] }>('/api/jobs');
          const lib = await api<{ books: unknown[] }>('/api/library');
          if (!alive) return;
          setJobs(j.jobs);
          setBooks(lib.books.length);
        }
        if (watchAligner) {
          const pf = await api<PreflightReport>('/api/preflight', { method: 'POST', body: {} });
          if (!alive) return;
          setAligner(pf.aligner);
        }
      } catch {
        /* keep last */
      }
      if (alive) setTimeout(() => void tick(), 1500);
    };
    void tick();
    return () => {
      alive = false;
    };
  }, [hasRoots, watchAligner]);
  const active = jobs.filter((j) => j.state === 'queued' || j.state === 'running');
  const scan = jobs.find((j) => j.type === 'scan');
  const done =
    hasRoots && scan && scan.state !== 'queued' && scan.state !== 'running' && active.length === 0;
  const indexing = active.filter((j) => j.type.startsWith('index')).length;
  return (
    <div className="wizard__body">
      <h1 tabIndex={-1}>{done ? 'All set' : hasRoots ? 'Reading your shelves' : 'All set'}</h1>
      {!hasRoots ? (
        <p className="lede">No folders yet — add them any time under Settings → Libraries.</p>
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
      {alignerFailed && (
        <p className="hint" style={{ marginTop: 14, color: 'var(--rp-danger)' }}>
          The download could not be started. Fetch the model under Settings → Alignment — everything
          else is set up.
        </p>
      )}
      {watchAligner && aligner && !alignerFailed && (
        <div style={{ marginTop: 18 }}>
          <h2 className="wizard__h2" style={{ marginTop: 0 }}>
            <IconDownload size={16} /> Alignment model
          </h2>
          {aligner.installed ? (
            <p className="hint">Installed — your books can be aligned now.</p>
          ) : aligner.download ? (
            <>
              <div className="progressbar" style={{ height: 6 }}>
                <span
                  style={{
                    width: `${Math.max(3, Math.round(aligner.download.progress * 100))}%`,
                    transition: 'width .5s ease',
                  }}
                />
              </div>
              <p className="hint" style={{ marginTop: 8 }}>
                {aligner.download.detail ??
                  (aligner.download.state === 'queued' ? 'Queued…' : 'Starting…')}{' '}
                — it keeps downloading while you use ReadPort.
              </p>
            </>
          ) : (
            <p className="hint">
              {aligner.lastError
                ? `Download failed: ${aligner.lastError}. Retry under Settings → Alignment.`
                : 'Queued — watch it under Settings → Alignment.'}
            </p>
          )}
        </div>
      )}
      <div className="wizard__actions">
        <button type="button" className="btn" onClick={onEnter}>
          Open the library
        </button>
      </div>
    </div>
  );
}

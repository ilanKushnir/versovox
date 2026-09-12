import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { LANGUAGES, type Job } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession, type User } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconDownload,
  IconHeadphones,
  VersoMark,
} from '../components/icons';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';
import { formatBytes } from '../lib/format';

/**
 * Setup wizard, in two modes.
 *
 * `first-run` — nobody exists yet: Welcome (bootstrap token) → Admin account
 * → Libraries → Language → Alignment → Processing → Review → Ready.
 *
 * `libraries` — an admin already exists but no library folders are set. This
 * is the normal path behind reverse-proxy SSO, where the first user is
 * provisioned automatically and never sees a first-run screen: the same
 * wizard resumes at Libraries, authenticated by the session instead of the
 * token. Nothing is written until the last step in either mode.
 *
 * That last rule is why the 317 MB aligner download is a CHOICE here and a
 * POST in `finish()`: during first run there is no session yet, and
 * `/api/models/:id/download` is admin-only. The Ready step then watches the
 * download it started, so the operator sees it running before they leave.
 */

export type WizardMode = 'first-run' | 'libraries';

type StepId =
  'welcome' | 'admin' | 'libraries' | 'language' | 'alignment' | 'processing' | 'review' | 'init';

const ALL_STEPS: { id: StepId; label: string }[] = [
  { id: 'welcome', label: 'Welcome' },
  { id: 'admin', label: 'Admin' },
  { id: 'libraries', label: 'Libraries' },
  { id: 'language', label: 'Language' },
  { id: 'alignment', label: 'Alignment' },
  { id: 'processing', label: 'Processing' },
  { id: 'review', label: 'Review' },
  { id: 'init', label: 'Ready' },
];

type ProcessingMode = 'auto' | 'verify' | 'manual';

/** Remembered when an admin chooses "Skip for now", so it stops asking. */
const SKIP_KEY = 'vx-setup-libraries-skipped';

/** One model, every language (server/src/transcription/models.ts). */
const ALIGNER_ID = 'mms-forced-aligner';
/** Catalog size, used only until the server's own report arrives. */
const ALIGNER_BYTES = 317_344_156;

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
  const [step, setStep] = useState<StepId>(firstRun ? 'welcome' : 'libraries');
  const [token, setToken] = useState('');
  const [tokenOk, setTokenOk] = useState(false);
  const [displayName, setDisplayName] = useState('');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [ebookDirs, setEbookDirs] = useState<string[]>([]);
  const [audioDirs, setAudioDirs] = useState<string[]>([]);
  const [language, setLanguage] = useState('en');
  const [processingMode, setProcessingMode] = useState<ProcessingMode>('verify');
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
          setLanguage(s.defaultLanguage ?? 'en');
        })
        .catch(() => setError('Could not reach the server.'));
      return;
    }
    // Already signed in: the settings endpoint knows the roots and which of
    // them the environment pins.
    void api<{
      settings: { defaultLanguage: string };
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
            envPinned: {
              ebookDirs: s.envPinned.includes('ebookDirs'),
              audiobookDirs: s.envPinned.includes('audiobookDirs'),
            },
          },
          languages: LANGUAGES.map((l) => ({ code: l.code, label: l.label })),
          defaultLanguage: s.settings.defaultLanguage,
        });
        setEbookDirs(s.paths.ebookDirs);
        setAudioDirs(s.paths.audiobookDirs);
        setLanguage(s.settings.defaultLanguage);
      })
      .catch(() => setError('Could not reach the server.'));
  }, [firstRun]);

  // First run authorises the folder probes with the bootstrap token; an
  // admin session needs no token.
  const setupHeaders = useMemo(
    () => (firstRun && token.trim() ? { 'x-vx-setup-token': token.trim() } : undefined),
    [firstRun, token],
  );
  const folders = useMemo(() => folderApi(firstRun ? token.trim() : undefined), [firstRun, token]);
  const stepIdx = STEPS.findIndex((s) => s.id === step);

  /**
   * Server self-check. The folders are sent with it because on first run they
   * exist only in this form — the server has not been told about them yet.
   */
  const runPreflight = useCallback(async () => {
    setChecking(true);
    try {
      setPreflight(
        await api<PreflightReport>('/api/preflight', {
          method: 'POST',
          body: { ebookDirs, audiobookDirs: audioDirs },
          headers: setupHeaders,
        }),
      );
    } catch {
      // Not fatal: the wizard still works, it just cannot show the ticks.
      setPreflight(null);
    } finally {
      setChecking(false);
    }
  }, [ebookDirs, audioDirs, setupHeaders]);

  // Re-check on entering either screen that shows a result. `runPreflight`
  // only changes identity when the chosen folders do, and those cannot change
  // from these two steps, so this does not re-fire while the operator types.
  useEffect(() => {
    if (step === 'alignment' || step === 'review') void runPreflight();
  }, [step, runPreflight]);

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
  }, [step]);

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

  /**
   * Start the aligner download, now that a session exists. Deliberately
   * non-fatal: setup has already succeeded by the time this runs, and the
   * model can always be fetched later from Settings → Speech models.
   */
  const startAlignerDownload = async () => {
    if (!wantAligner) return;
    if (preflight?.aligner.installed || preflight?.aligner.download) return;
    try {
      await api(`/api/models/${ALIGNER_ID}/download`, { method: 'POST' });
    } catch {
      setAlignerFailed(true);
    }
  };

  const finish = async () => {
    setBusy(true);
    setError(null);
    try {
      if (!firstRun) {
        const pinned = status?.libraries?.envPinned ?? {
          ebookDirs: false,
          audiobookDirs: false,
        };
        await api('/api/settings', {
          method: 'PUT',
          body: {
            ...(pinned.ebookDirs ? {} : { ebookDirs }),
            ...(pinned.audiobookDirs ? {} : { audiobookDirs: audioDirs }),
            defaultLanguage: language,
            processingMode,
          },
        });
        await startAlignerDownload();
        await api('/api/library/rescan', { method: 'POST' }).catch(() => {});
        setStep('init');
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
          defaultLanguage: language,
          processingMode,
        },
      });
      // The session cookie is set by /api/setup, so the admin-only download
      // endpoint is reachable from here on.
      await startAlignerDownload();
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
  const aligner = preflight?.aligner ?? null;
  const alignerReady = Boolean(aligner?.installed) || Boolean(aligner?.download);
  const blocking = (preflight?.checks ?? []).filter((c) => c.state === 'fail');

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
            <h1 tabIndex={-1}>Welcome to your reading room</h1>
            <p className="lede">
              Versovox reads the ebook and audiobook folders you already have, never changes them,
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
            <h1 tabIndex={-1}>Your admin account</h1>
            <p className="lede">
              The first account runs the server: it adds people, chooses libraries and manages the
              alignment model. You can add readers and curators later.
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

        {step === 'libraries' && (tokenOk || !firstRun) && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>Where are your books?</h1>
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
                onClick={() => setStep('language')}
                disabled={!firstRun && ebookDirs.length + audioDirs.length === 0}
              >
                {firstRun && ebookDirs.length + audioDirs.length === 0
                  ? 'Skip for now'
                  : 'Continue'}
              </button>
            </div>
          </div>
        )}

        {step === 'language' && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>Which language are most books in?</h1>
            <p className="lede">
              One alignment model covers all {LANGUAGES.length} supported languages, so this is not
              a download choice — it only tells Versovox how to read the letters of a book whose own
              language tag is missing or wrong.
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
              Each book's own language wins when it is known; this is only the fallback. Hebrew and
              Arabic work unvocalized, and mixed-language shelves need nothing special.
            </p>
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('libraries')}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => setStep('alignment')}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'alignment' && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>How Versovox lines the two editions up</h1>
            <p className="lede">
              To hand you back the <em>same sentence</em> when you switch, Versovox listens to the
              narration and matches what it hears against the ebook text you already have. It does
              not transcribe your books and nothing is ever uploaded. That needs one model —
              {` ${formatBytes(aligner?.sizeBytes ?? ALIGNER_BYTES)}`}, downloaded once from Hugging
              Face, covering every supported language.
            </p>

            <div className={`folders__row ${alignerReady ? 'is-ok' : ''}`} style={{ marginTop: 4 }}>
              <span className="folders__icon" aria-hidden="true">
                {aligner?.installed ? <IconCheck size={15} /> : <IconDownload size={15} />}
              </span>
              <span className="folders__body">
                <strong style={{ fontSize: 14 }}>
                  {aligner?.label ?? 'MMS forced aligner (all languages)'}
                </strong>
                <span className="folders__meta">
                  {aligner?.installed
                    ? `Already installed · ${formatBytes(aligner.installedBytes || aligner.sizeBytes)}`
                    : aligner?.download
                      ? `Downloading — ${Math.round(aligner.download.progress * 100)}%`
                      : `${formatBytes(aligner?.sizeBytes ?? ALIGNER_BYTES)} · one download, all ${LANGUAGES.length} languages`}
                </span>
              </span>
            </div>

            <p className="hint" style={{ marginTop: 10 }}>
              Licence: <strong>{aligner?.licence ?? 'CC-BY-NC-4.0 (non-commercial)'}</strong>. This
              model is Meta's MMS forced aligner, and it is the one non-commercial piece in Versovox
              — fine for your own library, not for a paid service. Everything else is AGPL-3.0.
              Nothing else is downloaded unless you ask for it.
            </p>

            {!aligner?.installed && !aligner?.download && (
              <label className="rs-toggle" style={{ maxWidth: 560, marginTop: 14 }}>
                <span>Download it when I finish setup</span>
                <input
                  type="checkbox"
                  role="switch"
                  checked={wantAligner}
                  onChange={(e) => setWantAligner(e.target.checked)}
                />
              </label>
            )}
            {!wantAligner && !aligner?.installed && (
              <p className="hint" style={{ marginTop: 10 }}>
                Fine — Versovox will still scan, pair and read. Sentence-exact switching stays off
                until you fetch the model from Settings → Speech models.
              </p>
            )}
            {aligner?.lastError && !aligner.download && (
              <p className="hint" style={{ marginTop: 10, color: 'var(--vx-danger)' }}>
                The last download attempt failed: {aligner.lastError}
              </p>
            )}

            <p className="hint" style={{ marginTop: 14 }}>
              How long: roughly <strong>20–30 minutes of computing per hour of audio</strong>, once
              per book, measured on a four-core home server. A six-hour audiobook is done in two to
              three hours and never needs doing again.
            </p>

            {blocking.some((c) => c.id === 'onnx-runtime' || c.id === 'audio-tools') && (
              <div className="banner banner--error" role="alert" style={{ margin: '14px 0 0' }}>
                <IconAlert size={16} /> This server cannot run the aligner yet —{' '}
                {blocking.find((c) => c.id === 'onnx-runtime' || c.id === 'audio-tools')!.detail}.
                The next screen explains it.
              </div>
            )}

            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('language')}>
                Back
              </button>
              <button type="button" className="btn" onClick={() => setStep('processing')}>
                Continue
              </button>
            </div>
          </div>
        )}

        {step === 'processing' && (
          <div className="wizard__body">
            <h1 tabIndex={-1}>How much should run on its own?</h1>
            <p className="lede">
              Aligning a book costs roughly{' '}
              <strong>20–30 minutes of computing per hour of audio</strong>, once. Versovox does it
              one book at a time, in the background, and a pairing that is really a different
              edition produces no match and is dropped rather than guessed. What you choose here is
              how much of that starts without you.
            </p>
            <div className="role-picker" role="radiogroup" aria-label="Processing">
              {(
                [
                  [
                    'verify',
                    'Align strong matches, ask before anything slower',
                    'Books that clearly belong together are aligned on their own. If a pair can only be settled by the old transcription route — hours per book — it waits for you. Recommended.',
                  ],
                  [
                    'auto',
                    'Do everything automatically',
                    'The same, plus the slow transcription fallback runs unattended too, one book at a time. Good for a small library or a server that is idle at night.',
                  ],
                  [
                    'manual',
                    'Do nothing without me',
                    'Nothing is aligned until you press Start on a pair. The quietest option, and the one that uses no CPU by surprise.',
                  ],
                ] as [ProcessingMode, string, string][]
              ).map(([value, label, blurb]) => (
                <button
                  key={value}
                  type="button"
                  role="radio"
                  aria-checked={processingMode === value}
                  className={`role-picker__opt ${processingMode === value ? 'is-on' : ''}`}
                  onClick={() => setProcessingMode(value)}
                >
                  <strong>{label}</strong>
                  <span>{blurb}</span>
                </button>
              ))}
            </div>
            <p className="hint" style={{ marginTop: 12 }}>
              You can change this later, and start, queue or stop any book from the Pairing page.
            </p>
            <div className="wizard__actions">
              <button type="button" className="btn btn--ghost" onClick={() => setStep('alignment')}>
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
                <dt>Default language</dt>
                <dd>{status?.languages?.find((l) => l.code === language)?.label ?? language}</dd>
              </div>
              <div>
                <dt>Aligner model</dt>
                <dd>
                  {aligner?.installed
                    ? 'Already installed'
                    : aligner?.download
                      ? 'Downloading now'
                      : wantAligner
                        ? `Downloads when you finish (${formatBytes(aligner?.sizeBytes ?? ALIGNER_BYTES)})`
                        : 'Skipped — add it later in Settings'}
                </dd>
              </div>
              <div>
                <dt>Processing</dt>
                <dd>
                  {processingMode === 'auto'
                    ? 'Align and transcribe automatically'
                    : processingMode === 'manual'
                      ? 'Nothing without me'
                      : 'Align strong matches, ask before anything slower'}
                </dd>
              </div>
            </dl>

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
                onClick={() => setStep('processing')}
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

        {step === 'init' && (createdUser || !firstRun) && (
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
 * Live first-scan progress, plus the aligner download this wizard just
 * started; the session cookie is already set by /api/setup.
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
        <p className="lede">
          No folders yet — add them any time under Settings → Libraries. You can already invite
          people and manage the alignment model.
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
      {alignerFailed && (
        <p className="hint" style={{ marginTop: 14, color: 'var(--vx-danger)' }}>
          The aligner download could not be started. Fetch it under Settings → Speech models —
          everything else is set up.
        </p>
      )}
      {watchAligner && aligner && !alignerFailed && (
        <div style={{ marginTop: 18 }}>
          <h2 className="wizard__h2" style={{ marginTop: 0 }}>
            <IconDownload size={16} /> Alignment model
          </h2>
          {aligner.installed ? (
            <p className="hint">Installed — sentence-exact switching is available.</p>
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
                — it keeps downloading while you use Versovox.
              </p>
            </>
          ) : (
            <p className="hint">
              {aligner.lastError
                ? `Download failed: ${aligner.lastError}. Retry under Settings → Speech models.`
                : 'Queued — watch it under Settings → Speech models.'}
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

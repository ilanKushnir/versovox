import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Job, type Settings } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import { IconAlert, IconCheck, IconDownload, IconTrash } from '../components/icons';
import { formatBytes, formatDate } from '../lib/format';
import { storageEstimate } from '../offline/downloads';
import { alignerModel, speechModels, type ModelInfo, type ModelsResponse } from '../lib/types';
import { applyAppThemeColor } from '../lib/themeColor';
import { Link } from 'react-router-dom';
import { folderApi, LibraryFolders } from '../components/LibraryFolders';
import { ROLE_LABELS, type Role } from '@versovox/shared';

interface DashboardStats {
  ebooks: number;
  audiobooks: number;
  booksIndexing: number;
  pairsLinked: number;
  pairsCandidate: number;
  pairsAligned: number;
  jobsRunning: number;
  jobsQueued: number;
  jobsFailed: number;
  users: number;
}

interface SettingsResponse {
  settings: Settings;
  envPinned: string[];
  stats?: DashboardStats;
  paths: {
    dataDir: string;
    cacheDir: string;
    modelsDir: string;
    ebookDirs: string[];
    audiobookDirs: string[];
  };
  precedence: string;
}

export function SettingsPage() {
  const { user, via, logout } = useSession();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [appTheme, setAppTheme] = useState<string>(
    () => localStorage.getItem('vx-app-theme') ?? 'auto',
  );
  const isAdmin = user?.role === 'admin';
  const stats = data?.stats ?? null;
  // One catalog for the whole page, so the overview card, the engine-readiness
  // panel and the model cards can never disagree about what is installed.
  const { models, reload: reloadModels } = useModels();
  const aligner = alignerModel(models);
  const speechInstalled = speechModels(models).filter((m) => m.installed).length;

  const load = useCallback(async () => {
    try {
      setData(await api<SettingsResponse>('/api/settings'));
      const j = await api<{ jobs: Job[] }>('/api/jobs');
      setJobs(j.jobs);
    } catch {
      /* handled by empty state below */
    }
    setStorage(await storageEstimate());
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    const root = document.documentElement;
    if (appTheme === 'auto') root.removeAttribute('data-app-theme');
    else root.setAttribute('data-app-theme', appTheme);
    localStorage.setItem('vx-app-theme', appTheme);
    applyAppThemeColor();
  }, [appTheme]);

  // Deep link from the pairing page: /settings#speech-models
  useEffect(() => {
    if (!data || location.hash !== '#speech-models') return;
    document.getElementById('speech-models')?.scrollIntoView({ block: 'start' });
  }, [data]);

  const save = async (patch?: Partial<Settings>) => {
    setSaving(true);
    try {
      const body = patch ?? draft;
      const res = await api<{ settings: Settings }>('/api/settings', {
        method: 'PUT',
        body,
      });
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      if (!patch) setDraft({});
      toast.show('Settings saved');
    } catch {
      toast.show('Saving failed (admin only)');
    } finally {
      setSaving(false);
    }
  };

  const rescan = async () => {
    try {
      await api('/api/library/rescan', { method: 'POST' });
      toast.show('Rescan queued');
      void load();
    } catch {
      toast.show('Rescan failed');
    }
  };

  if (!data) {
    return (
      <main className="app-main" aria-busy="true">
        <div className="skeleton" style={{ height: 200 }} />
      </main>
    );
  }

  const s = { ...data.settings, ...draft };
  const pinned = (k: string) => data.envPinned.includes(k);
  const set = <K extends keyof Settings>(k: K, v: Settings[K]) =>
    setDraft((d) => ({ ...d, [k]: v }));
  const dirty = Object.keys(draft).length > 0;

  return (
    <main className="app-main settings-page" style={{ maxWidth: 900 }}>
      <header className="page-head">
        <h1>Settings</h1>
        <p>Everything this server is doing, and everything you can change about it.</p>
      </header>

      {stats && (
        <section className="dash" aria-label="Overview">
          <DashCard
            to="#libraries"
            label="Library"
            value={`${stats.ebooks + stats.audiobooks}`}
            unit="titles"
            detail={
              stats.booksIndexing > 0
                ? `${stats.booksIndexing} still indexing`
                : `${stats.ebooks} ebooks · ${stats.audiobooks} audiobooks`
            }
            busy={stats.booksIndexing > 0}
          />
          <DashCard
            to="/pairs"
            label="Pairs"
            value={`${stats.pairsLinked}`}
            unit="linked"
            detail={
              stats.pairsCandidate > 0
                ? `${stats.pairsCandidate} awaiting review`
                : `${stats.pairsAligned} aligned`
            }
          />
          <DashCard
            to="/pairs"
            label="Processing"
            value={stats.jobsRunning > 0 ? `${stats.jobsRunning}` : '—'}
            unit={stats.jobsRunning > 0 ? 'running' : 'idle'}
            detail={
              stats.jobsQueued > 0
                ? `${stats.jobsQueued} waiting`
                : stats.jobsFailed > 0
                  ? `${stats.jobsFailed} failed`
                  : (MODE_LABEL[s.processingMode] ?? 'Ready')
            }
            busy={stats.jobsRunning > 0}
            warn={stats.jobsRunning === 0 && stats.jobsFailed > 0}
          />
          <DashCard
            to="#speech-models"
            label="Models"
            value={!models ? '—' : aligner?.installed ? 'Ready' : 'Set up'}
            unit={aligner?.installed ? 'to align' : 'needed'}
            detail={
              !models
                ? 'Catalog unavailable'
                : aligner?.installed
                  ? `Forced aligner · ${speechInstalled} speech model${speechInstalled === 1 ? '' : 's'}`
                  : 'The forced aligner is not installed yet'
            }
            warn={Boolean(models) && !aligner?.installed && s.alignEngine === 'forced-align'}
          />
          {isAdmin && (
            <DashCard
              to="/settings/people"
              label="People"
              value={`${stats.users}`}
              unit={stats.users === 1 ? 'account' : 'accounts'}
              detail="Roles and invitations"
            />
          )}
          <DashCard
            to="#offline"
            label="Offline"
            value={storage ? formatBytes(storage.usage) : '—'}
            unit="on this device"
            detail={storage ? `of about ${formatBytes(storage.quota)}` : 'Not reported'}
          />
        </section>
      )}

      <section className="settings-section" aria-label="Libraries" id="libraries">
        <h2>Libraries</h2>
        <p className="settings-section__lede">
          Folders are only ever read — Versovox never writes into them. New titles are picked up by
          the periodic rescan or right away with the button below.
        </p>
        {isAdmin ? (
          <LibrariesEditor
            data={data}
            onSaved={(paths) => setData((d) => (d ? { ...d, paths: { ...d.paths, ...paths } } : d))}
          />
        ) : (
          <dl style={{ margin: 0 }}>
            <div className="kv">
              <dt>Ebook folders</dt>
              <dd>{data.paths.ebookDirs.join(', ') || 'Not configured'}</dd>
            </div>
            <div className="kv">
              <dt>Audiobook folders</dt>
              <dd>{data.paths.audiobookDirs.join(', ') || 'Not configured'}</dd>
            </div>
          </dl>
        )}
        <dl style={{ margin: 'var(--sp-4) 0 0' }}>
          <div className="kv">
            <dt>App data</dt>
            <dd>{data.paths.dataDir}</dd>
          </div>
          <div className="kv">
            <dt>Cache</dt>
            <dd>{data.paths.cacheDir}</dd>
          </div>
        </dl>
        {isAdmin && (
          <div style={{ marginBlockStart: 'var(--sp-4)' }}>
            <button className="btn btn--secondary" onClick={() => void rescan()}>
              Rescan libraries now
            </button>
          </div>
        )}
      </section>

      <section className="settings-section" aria-label="Appearance">
        <h2>Appearance</h2>
        <div className="field">
          <label htmlFor="set-theme">App theme</label>
          <div className="segmented" role="group" aria-label="App theme" id="set-theme">
            {(['auto', 'light', 'dark'] as const).map((t) => (
              <button key={t} aria-pressed={appTheme === t} onClick={() => setAppTheme(t)}>
                {t === 'auto' ? 'Match system' : t === 'light' ? 'Light' : 'Dark'}
              </button>
            ))}
          </div>
          <span className="hint">Reader pages have their own theme, set inside the reader.</span>
        </div>
      </section>

      <SpeechModelsSection
        settings={s}
        isAdmin={isAdmin}
        pinned={pinned}
        models={models}
        reload={reloadModels}
        onProviderChange={(v) => void save({ transcribeProvider: v })}
        onLanguageModel={(code, modelId) =>
          void save({ languageModels: { ...s.languageModels, [code]: modelId } })
        }
        onAutoDefault={(v) => void save({ autoDownloadDefaultModel: v })}
      />

      <section className="settings-section" aria-label="Processing" id="processing">
        <h2>Processing</h2>
        <p className="settings-section__lede">
          Listening to a whole audiobook is the slow part — hours of computing per book, even with
          forced alignment. Versovox checks that an ebook and an audiobook really are the same work
          before it spends them; this decides what happens once that check passes.
          {s.transcribeSpeedRatio > 0 && (
            <>
              {' '}
              Measured here while transcribing: {(s.transcribeSpeedRatio * 60).toFixed(0)} minutes
              of audio per hour of computing. Forced alignment is several times quicker than that.
            </>
          )}
        </p>
        <div className="role-picker" role="radiogroup" aria-label="Processing mode">
          {(
            [
              [
                'verify',
                'Verify, then ask me',
                'Check and link strong matches automatically; wait before the long run.',
              ],
              [
                'auto',
                'Do everything automatically',
                'Verified matches are aligned on their own, one at a time.',
              ],
              [
                'manual',
                'Do nothing without me',
                'Every check and every alignment is started by hand.',
              ],
            ] as [Settings['processingMode'], string, string][]
          ).map(([value, label, blurb]) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={s.processingMode === value}
              disabled={!isAdmin}
              className={`role-picker__opt ${s.processingMode === value ? 'is-on' : ''}`}
              onClick={() => void save({ processingMode: value })}
            >
              <strong>{label}</strong>
              <span>{blurb}</span>
            </button>
          ))}
        </div>
        <h3 className="settings-h3">Alignment engine</h3>
        <AlignmentEngine
          settings={s}
          isAdmin={isAdmin}
          models={models}
          onEngine={(v) => void save({ alignEngine: v })}
        />
        <h3 className="settings-h3">Languages and limits</h3>
        <div className="field">
          <label htmlFor="set-lang">
            Default language {pinned('defaultLanguage') && <em>(env)</em>}
          </label>
          <input
            id="set-lang"
            className="input"
            disabled={pinned('defaultLanguage') || !isAdmin}
            value={s.defaultLanguage}
            maxLength={8}
            style={{ maxWidth: 120 }}
            onChange={(e) => set('defaultLanguage', e.target.value)}
          />
          <span className="hint">
            Used only when a book has no language metadata and detection fails. Each pair can
            override its narration language on the Pairing page.
          </span>
        </div>
        <div className="field">
          <label htmlFor="set-conc">
            Background job concurrency {pinned('jobConcurrency') && <em>(env)</em>}
          </label>
          <input
            id="set-conc"
            className="input"
            type="number"
            min={1}
            max={8}
            disabled={pinned('jobConcurrency') || !isAdmin}
            value={s.jobConcurrency}
            style={{ maxWidth: 120 }}
            onChange={(e) => set('jobConcurrency', Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="set-thresh">Auto-pair threshold</label>
          <input
            id="set-thresh"
            className="input"
            type="number"
            min={0.5}
            max={1}
            step={0.01}
            disabled={!isAdmin}
            value={s.autoPairThreshold}
            style={{ maxWidth: 120 }}
            onChange={(e) => set('autoPairThreshold', Number(e.target.value))}
          />
          <span className="hint">
            Pairs scoring below this always wait for manual review. Raising it is safer.
          </span>
        </div>
        {(s.alignEngine === 'whisper-cli' || s.transcribeProvider === 'whisper-cli') && (
          <details className="settings-advanced">
            <summary>Advanced: custom whisper paths</summary>
            <div className="field">
              <label htmlFor="set-bin">
                Whisper binary path {pinned('whisperBin') && <em>(env)</em>}
              </label>
              <input
                id="set-bin"
                className="input"
                disabled={pinned('whisperBin') || !isAdmin}
                value={s.whisperBin}
                placeholder="/usr/local/bin/whisper-cli"
                onChange={(e) => set('whisperBin', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="set-model">
                Fallback model path {pinned('whisperModel') && <em>(env)</em>}
              </label>
              <input
                id="set-model"
                className="input"
                disabled={pinned('whisperModel') || !isAdmin}
                value={s.whisperModel}
                placeholder="/models/ggml-custom.bin"
                onChange={(e) => set('whisperModel', e.target.value)}
              />
              <span className="hint">
                Only used when no catalog model is installed for a language. Must live inside the
                models directory.
              </span>
            </div>
          </details>
        )}
        {dirty && (
          <button className="btn" onClick={() => void save()} disabled={saving}>
            <IconCheck size={16} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}
        <p style={{ color: 'var(--vx-text-soft)', fontSize: 13 }}>{data.precedence}</p>
      </section>

      <section className="settings-section" aria-label="Offline storage" id="offline">
        <h2>Offline storage</h2>
        {storage ? (
          <p style={{ fontSize: 14.5 }}>
            This browser is using {formatBytes(storage.usage)} of about {formatBytes(storage.quota)}{' '}
            available for offline books.
          </p>
        ) : (
          <p style={{ fontSize: 14.5, color: 'var(--vx-text-soft)' }}>
            Storage usage is not reported by this browser.
          </p>
        )}
        <p style={{ color: 'var(--vx-text-soft)', fontSize: 13.5 }}>
          Downloads are per-title and explicit — manage them from each book page.
        </p>
      </section>

      <section className="settings-section" aria-label="Background activity">
        <h2>Background activity</h2>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--vx-text-soft)', fontSize: 14.5 }}>No background jobs yet.</p>
        ) : (
          <div className="list-card">
            {jobs.slice(0, 12).map((j) => (
              <div className="list-row" key={j.id} style={{ cursor: 'default' }}>
                {j.state === 'running' ? (
                  <span className="spinner" style={{ width: 15, height: 15 }} />
                ) : j.state === 'failed' ? (
                  <IconAlert size={15} style={{ color: 'var(--vx-danger)' }} />
                ) : (
                  <IconCheck size={15} style={{ opacity: j.state === 'done' ? 1 : 0.4 }} />
                )}
                <span className="grow" style={{ whiteSpace: 'normal' }}>
                  <span style={{ fontWeight: 600 }}>{jobLabel(j.type)}</span>
                  {j.detail ? ` — ${j.detail}` : ''}
                  {j.error ? (
                    <span style={{ display: 'block', color: 'var(--vx-danger)', fontSize: 13 }}>
                      {j.error.replace(/^model-missing:[^|]*\|/, '')}
                    </span>
                  ) : null}
                </span>
                <span className="soft">
                  {j.state} · {formatDate(j.createdAt)}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="settings-section" aria-label="Account">
        <h2>Account</h2>
        <p style={{ fontSize: 14.5 }}>
          Signed in as <strong>{user?.displayName ?? user?.username}</strong>
          {user?.displayName ? ` (@${user.username})` : ''} ·{' '}
          {ROLE_LABELS[(user?.role as Role) ?? 'reader']?.label ?? user?.role}
          {via === 'proxy' ? ', through your identity provider.' : '.'}
        </p>
        <AccountSelfService via={via} />
        {via === 'proxy' ? (
          <p style={{ fontSize: 13.5, color: 'var(--vx-text-soft)' }}>
            Sign-in is handled by the reverse proxy in front of Versovox; sign out from there.
          </p>
        ) : (
          <button className="btn btn--secondary" onClick={() => void logout()}>
            Sign out
          </button>
        )}
      </section>
    </main>
  );
}

function LibrariesEditor({
  data,
  onSaved,
}: {
  data: SettingsResponse;
  onSaved: (paths: { ebookDirs: string[]; audiobookDirs: string[] }) => void;
}) {
  const toast = useToast();
  const [ebookDirs, setEbookDirs] = useState(data.paths.ebookDirs);
  const [audioDirs, setAudioDirs] = useState(data.paths.audiobookDirs);
  const [saving, setSaving] = useState(false);
  const folders = useMemo(() => folderApi(), []);
  const pinnedE = data.envPinned.includes('ebookDirs');
  const pinnedA = data.envPinned.includes('audiobookDirs');
  const dirty =
    ebookDirs.join('\n') !== data.paths.ebookDirs.join('\n') ||
    audioDirs.join('\n') !== data.paths.audiobookDirs.join('\n');
  const save = async () => {
    setSaving(true);
    try {
      await api('/api/settings', {
        method: 'PUT',
        body: {
          ...(pinnedE ? {} : { ebookDirs }),
          ...(pinnedA ? {} : { audiobookDirs: audioDirs }),
        },
      });
      onSaved({ ebookDirs, audiobookDirs: audioDirs });
      await api('/api/library/rescan', { method: 'POST' }).catch(() => {});
      toast.show('Folders saved — rescanning');
    } catch {
      toast.show('Could not save folders');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div>
      <h3 className="settings-h3">Ebook folders</h3>
      <LibraryFolders
        kind="ebook"
        value={ebookDirs}
        onChange={setEbookDirs}
        folders={folders}
        disabled={pinnedE}
        pinnedNote={pinnedE ? 'Pinned by VX_EBOOK_DIRS on the server.' : null}
      />
      <h3 className="settings-h3">Audiobook folders</h3>
      <LibraryFolders
        kind="audio"
        value={audioDirs}
        onChange={setAudioDirs}
        folders={folders}
        disabled={pinnedA}
        pinnedNote={pinnedA ? 'Pinned by VX_AUDIOBOOK_DIRS on the server.' : null}
      />
      {dirty && (
        <button
          className="btn"
          style={{ marginTop: 'var(--sp-3)' }}
          disabled={saving}
          onClick={() => void save()}
        >
          {saving ? 'Saving…' : 'Save folders & rescan'}
        </button>
      )}
    </div>
  );
}

function AccountSelfService({ via }: { via: string }) {
  const { user, refresh } = useSession();
  const toast = useToast();
  const [name, setName] = useState(user?.displayName ?? '');
  const [cur, setCur] = useState('');
  const [next, setNext] = useState('');
  const [busy, setBusy] = useState(false);
  const saveName = async () => {
    setBusy(true);
    try {
      await api('/api/auth/me', { method: 'PATCH', body: { displayName: name.trim() || null } });
      await refresh();
      toast.show('Name saved');
    } catch {
      toast.show('Could not save');
    } finally {
      setBusy(false);
    }
  };
  const changePw = async () => {
    setBusy(true);
    try {
      const r = await api<{ revokedOtherSessions: number }>('/api/auth/password', {
        method: 'POST',
        body: { currentPassword: cur, newPassword: next },
      });
      setCur('');
      setNext('');
      toast.show(
        r.revokedOtherSessions
          ? `Password changed — signed out of ${r.revokedOtherSessions} other device${r.revokedOtherSessions === 1 ? '' : 's'}`
          : 'Password changed',
      );
    } catch (err) {
      toast.show(
        err instanceof ApiError && err.code === 'bad-credentials'
          ? 'Current password is wrong'
          : err instanceof ApiError && err.code === 'invalid'
            ? err.message.replace(/^invalid:?\s*/, '')
            : 'Could not change the password',
      );
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="account-grid">
      <div className="field">
        <label htmlFor="ac-name">Display name</label>
        <div className="linkbox">
          <input
            id="ac-name"
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={user?.username}
          />
          <button
            className="btn btn--secondary"
            disabled={busy || (name.trim() || '') === (user?.displayName ?? '')}
            onClick={() => void saveName()}
          >
            Save
          </button>
        </div>
      </div>
      {via !== 'proxy' && (
        <div className="field">
          <label htmlFor="ac-cur">Change password</label>
          <div className="pw-row">
            <input
              id="ac-cur"
              className="input"
              type="password"
              autoComplete="current-password"
              placeholder="Current"
              value={cur}
              onChange={(e) => setCur(e.target.value)}
            />
            <input
              className="input"
              type="password"
              autoComplete="new-password"
              placeholder="New (10+ chars)"
              minLength={10}
              value={next}
              onChange={(e) => setNext(e.target.value)}
              aria-label="New password"
            />
            <button
              className="btn btn--secondary"
              disabled={busy || !cur || next.length < 10}
              onClick={() => void changePw()}
            >
              Change
            </button>
          </div>
          <span className="hint">Other devices are signed out; this one stays in.</span>
        </div>
      )}
    </div>
  );
}

const MODE_LABEL: Record<string, string> = {
  auto: 'Runs unattended',
  verify: 'Verifies, then asks',
  manual: 'Nothing without you',
};

/**
 * One number with its meaning, linking to the section or page that explains
 * it. Anchors scroll within Settings; paths navigate.
 */
function DashCard({
  to,
  label,
  value,
  unit,
  detail,
  busy,
  warn,
}: {
  to: string;
  label: string;
  value: string;
  unit: string;
  detail: string;
  busy?: boolean;
  warn?: boolean;
}) {
  const body = (
    <>
      <span className="dash__label">
        {label}
        {busy && <span className="dash__pulse" aria-hidden="true" />}
      </span>
      <span className="dash__value">
        {value} <small>{unit}</small>
      </span>
      <span className="dash__detail">{detail}</span>
    </>
  );
  const cls = `dash__card ${warn ? 'is-warn' : ''}`;
  return to.startsWith('#') ? (
    <a className={cls} href={to}>
      {body}
    </a>
  ) : (
    <Link className={cls} to={to}>
      {body}
    </Link>
  );
}

function jobLabel(type: string): string {
  switch (type) {
    case 'scan':
      return 'Library scan';
    case 'index-ebook':
      return 'Index ebook';
    case 'index-audio':
      return 'Index audiobook';
    case 'pair-scan':
      return 'Find pairs';
    case 'align':
      return 'Align to the text';
    case 'model-download':
      return 'Download model';
    default:
      return type;
  }
}

/* ---------------------------------------------------- alignment engine */

/** The engines, in the order someone choosing one should consider them. */
const ENGINES: [Settings['alignEngine'], string, string][] = [
  [
    'forced-align',
    'Forced alignment (recommended)',
    'Listens to the narration and pins it to the words your ebook already contains. One download covers every language, and it is several times faster than transcribing because it never has to work out which words were said.',
  ],
  [
    'whisper-cli',
    'Transcribe with whisper',
    'Writes the whole audiobook out as text first, then matches that text to the book. Needs a speech model per language, is several times slower, and is worth keeping for a book forced alignment cannot handle.',
  ],
  [
    'fixture',
    'Sidecar transcripts',
    'Reads transcript files you place next to the audio and computes nothing on this server. A sidecar wins wherever one exists, whichever engine is selected.',
  ],
  [
    'none',
    'Off',
    'No timings are produced at all. Books stay readable and listenable; only sentence-exact switching is lost.',
  ],
];

/**
 * The primary alignment control, with an honest readiness line underneath it:
 * forced alignment needs its model AND the native ONNX runtime, and a server
 * missing either should say so here rather than at the end of a queued job.
 */
function AlignmentEngine({
  settings,
  isAdmin,
  models,
  onEngine,
}: {
  settings: Settings;
  isAdmin: boolean;
  models: ModelsResponse | null;
  onEngine: (v: Settings['alignEngine']) => void;
}) {
  const aligner = alignerModel(models);
  const runtime = models?.alignerRuntime ?? null;
  return (
    <>
      <div className="role-picker" role="radiogroup" aria-label="Alignment engine">
        {ENGINES.map(([value, label, blurb]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={settings.alignEngine === value}
            disabled={!isAdmin}
            className={`role-picker__opt ${settings.alignEngine === value ? 'is-on' : ''}`}
            onClick={() => onEngine(value)}
          >
            <strong>{label}</strong>
            <span>{blurb}</span>
          </button>
        ))}
      </div>

      {settings.alignEngine === 'forced-align' && models && (
        <>
          {!aligner ? (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} />
              <span className="grow">
                This server&rsquo;s model catalog has no forced aligner. Update Versovox, or pick
                another engine above.
              </span>
            </div>
          ) : !aligner.installed ? (
            <div className="banner banner--action">
              <IconDownload size={16} />
              <span className="grow">
                The aligner model is not installed yet — a single {formatBytes(aligner.sizeBytes)}{' '}
                download that covers every language. Alignment jobs wait for it and start on their
                own once it arrives.
              </span>
              <a className="btn btn--secondary" href="#speech-models">
                Get the aligner
              </a>
            </div>
          ) : runtime && !runtime.available ? (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} />
              <span className="grow">
                The aligner model is installed, but the ONNX runtime did not load, so forced
                alignment cannot run. The Docker image ships it; elsewhere install{' '}
                <code>onnxruntime-node</code> and point <code>VX_ORT_DIR</code> at it.
                {runtime.error ? (
                  <span style={{ display: 'block', fontSize: 12.5, opacity: 0.85 }}>
                    {runtime.error}
                  </span>
                ) : null}
              </span>
            </div>
          ) : (
            <div className="banner">
              <IconCheck size={16} />
              <span className="grow">
                Ready: the aligner model is installed
                {runtime?.available ? ' and the ONNX runtime is loaded' : ''}. Nothing else is
                needed for any language.
              </span>
            </div>
          )}
          {/* A sidecar transcript is exact and free, so the server skips the
              aligner entirely while sidecars are the transcript source. Say so
              where the engine is chosen, not in a failed job. */}
          {settings.transcribeProvider === 'fixture' && (
            <div className="banner banner--action">
              <IconAlert size={16} />
              <span className="grow">
                Transcript source is set to sidecar files, which always win — forced alignment is
                skipped while that is the case.
              </span>
            </div>
          )}
        </>
      )}

      {settings.alignEngine === 'whisper-cli' && models && !models.whisperAvailable && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> whisper-cli was not found on this server. The Docker image bundles
          it; for other installs set VX_WHISPER_BIN.
        </div>
      )}
      {settings.alignEngine === 'whisper-cli' && (
        <p className="settings-section__lede">
          This engine needs a speech model for every language you align, and roughly three to four
          times the computing forced alignment needs for the same book.
        </p>
      )}
      {settings.alignEngine === 'none' && (
        <p className="settings-section__lede">
          Timings that already exist are kept; nothing new is computed.
        </p>
      )}
    </>
  );
}

/* ------------------------------------------------------- speech models */

/**
 * The model catalog, polled while a download is running. Lifted to the page
 * so the overview card, the engine readiness panel and the model cards all
 * read the same answer.
 */
function useModels(): { models: ModelsResponse | null; reload: () => Promise<void> } {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const reload = useCallback(async () => {
    try {
      setModels(await api<ModelsResponse>('/api/models'));
    } catch {
      /* non-fatal: the rest of Settings works without the catalog */
    }
  }, []);
  useEffect(() => {
    void reload();
  }, [reload]);

  const downloading = models?.models.some((m) => m.download) ?? false;
  useEffect(() => {
    if (downloading && !timer.current) timer.current = setInterval(() => void reload(), 2000);
    if (!downloading && timer.current) {
      clearInterval(timer.current);
      timer.current = null;
    }
    return () => {
      if (timer.current) {
        clearInterval(timer.current);
        timer.current = null;
      }
    };
  }, [downloading, reload]);

  return { models, reload };
}

function SpeechModelsSection({
  settings,
  isAdmin,
  pinned,
  models,
  reload,
  onProviderChange,
  onLanguageModel,
  onAutoDefault,
}: {
  settings: Settings;
  isAdmin: boolean;
  pinned: (k: string) => boolean;
  models: ModelsResponse | null;
  reload: () => Promise<void>;
  onProviderChange: (v: Settings['transcribeProvider']) => void;
  onLanguageModel: (code: string, modelId: string) => void;
  onAutoDefault: (v: boolean) => void;
}) {
  const toast = useToast();

  const download = async (m: ModelInfo) => {
    try {
      await api(`/api/models/${m.id}/download`, { method: 'POST' });
      toast.show(`Downloading ${m.label}`);
      await reload();
    } catch {
      toast.show('Could not start the download (admin only)');
    }
  };
  const remove = async (m: ModelInfo) => {
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' });
      toast.show(`Removed ${m.label}`);
      await reload();
    } catch {
      toast.show('Could not remove the model');
    }
  };

  const aligner = alignerModel(models);
  const byId = new Map(speechModels(models).map((m) => [m.id, m]));
  const speechInstalled = speechModels(models).filter((m) => m.installed).length;

  return (
    <section className="settings-section" aria-label="Models" id="speech-models">
      <h2>Models</h2>
      <p className="settings-section__lede">
        Everything runs <strong>on this server</strong> — no audio, text or metadata ever leaves it.
        Models are downloaded once from Hugging Face into{' '}
        <code>{models?.modelsDir ?? 'the models directory'}</code>. There are two kinds, and for
        most people only the first matters.
      </p>

      <h3 className="settings-h3">The aligner — one model, every language</h3>
      {!models ? (
        <div className="skeleton" style={{ height: 150 }} />
      ) : !aligner ? (
        <p className="settings-section__lede">This server&rsquo;s catalog has no forced aligner.</p>
      ) : (
        <AlignerCard
          model={aligner}
          isAdmin={isAdmin}
          inUse={settings.alignEngine === 'forced-align'}
          onDownload={() => void download(aligner)}
          onRemove={() => void remove(aligner)}
        />
      )}

      <h3 className="settings-h3">Speech recognition — one model per language</h3>
      <p className="settings-section__lede">
        Whisper models write narration out as words. Forced alignment does not need them; they are
        used to detect the narration language when a book declares none, to run the older
        transcribe-then-match engine, and for Hebrew, where the ivrit.ai fine-tune is markedly
        better than anything general. Skip this section unless one of those applies to you.
      </p>
      <label className="rs-toggle" style={{ maxWidth: 560 }}>
        <span>Fetch the default speech model automatically on a fresh install</span>
        <input
          type="checkbox"
          role="switch"
          checked={settings.autoDownloadDefaultModel}
          disabled={!isAdmin}
          onChange={(e) => onAutoDefault(e.target.checked)}
        />
      </label>
      <div className="field">
        <label htmlFor="set-provider">
          Transcript source {pinned('transcribeProvider') && <em>(set by environment)</em>}
        </label>
        <div className="segmented" id="set-provider" role="group" aria-label="Transcript source">
          {(
            [
              ['whisper-cli', 'On this server'],
              ['fixture', 'Sidecar transcripts'],
              ['none', 'Off'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={v}
              aria-pressed={settings.transcribeProvider === v}
              disabled={pinned('transcribeProvider') || !isAdmin}
              onClick={() => onProviderChange(v)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="hint">
          Where transcripts come from when one is needed. A sidecar transcript is exact and free, so
          it is always preferred over any engine.
        </span>
      </div>
      {models && !models.whisperAvailable && settings.transcribeProvider === 'whisper-cli' && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} /> whisper-cli was not found on this server. The Docker image bundles
          it; for other installs set VX_WHISPER_BIN.
        </div>
      )}
      {!models ? (
        <div className="skeleton" style={{ height: 120 }} />
      ) : (
        <>
          <div className="model-grid">
            {models.languages.map((lang) => {
              const chosenId = settings.languageModels?.[lang.code] ?? lang.models[0]!;
              const chosen = byId.get(chosenId) ?? byId.get(lang.models[0]!);
              if (!chosen) return null;
              const installedAlt = lang.models
                .map((id) => byId.get(id))
                .find((m) => m?.installed && m.id !== chosen.id);
              const dl = chosen.download;
              return (
                <article
                  className={`model-card ${chosen.installed ? 'is-installed' : ''}`}
                  key={lang.code}
                >
                  <div className="model-card__head">
                    <span className="model-card__native" lang={lang.code}>
                      {lang.native}
                    </span>
                    <span className="model-card__lang">{lang.label}</span>
                    {chosen.installed ? (
                      <span className="badge badge--sync">
                        <IconCheck size={11} /> Ready
                      </span>
                    ) : dl ? (
                      <span className="badge">Downloading</span>
                    ) : installedAlt ? (
                      <span className="badge">Fallback ready</span>
                    ) : (
                      <span className="badge badge--muted">Not installed</span>
                    )}
                  </div>
                  <label className="model-card__select">
                    <span className="visually-hidden">Model for {lang.label}</span>
                    <select
                      className="input"
                      value={chosen.id}
                      disabled={!isAdmin}
                      onChange={(e) => onLanguageModel(lang.code, e.target.value)}
                    >
                      {lang.models.map((id) => {
                        const m = byId.get(id);
                        if (!m) return null;
                        return (
                          <option key={id} value={id}>
                            {m.label} · {formatBytes(m.sizeBytes)}
                            {m.installed ? ' · installed' : ''}
                          </option>
                        );
                      })}
                    </select>
                  </label>
                  <p className="model-card__note">{chosen.note}</p>
                  {dl ? (
                    <div className="model-card__progress">
                      <span className="progressbar" aria-hidden="true">
                        <span style={{ width: `${Math.round(dl.progress * 100)}%` }} />
                      </span>
                      <span className="model-card__progress-text">
                        {dl.detail ?? (dl.state === 'queued' ? 'Queued…' : 'Starting…')}
                      </span>
                    </div>
                  ) : chosen.installed ? (
                    <div className="model-card__actions">
                      <span className="model-card__size">{formatBytes(chosen.installedBytes)}</span>
                      {isAdmin && (
                        <button
                          className="btn btn--ghost"
                          style={{ minHeight: 36 }}
                          onClick={() => void remove(chosen)}
                        >
                          <IconTrash size={15} /> Remove
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="model-card__actions">
                      <span className="model-card__size">{formatBytes(chosen.sizeBytes)}</span>
                      {chosen.lastError && (
                        <span className="model-card__error" title={chosen.lastError}>
                          Last attempt failed
                        </span>
                      )}
                      <button
                        className="btn"
                        style={{ minHeight: 38 }}
                        disabled={!isAdmin}
                        onClick={() => void download(chosen)}
                      >
                        <IconDownload size={15} /> {chosen.lastError ? 'Retry' : 'Download'}
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
          <p style={{ color: 'var(--vx-text-soft)', fontSize: 13 }}>
            {speechInstalled} speech model{speechInstalled === 1 ? '' : 's'} installed. A pair whose
            language has no installed model fails with a clear message and a download link, and the
            alignment runs by itself once the model arrives.
          </p>
        </>
      )}
    </section>
  );
}

/**
 * The aligner gets a card of its own: it is the one model most servers need,
 * and it is the only component of Versovox under a non-permissive licence —
 * which is stated above the download button, never after it.
 */
function AlignerCard({
  model,
  isAdmin,
  inUse,
  onDownload,
  onRemove,
}: {
  model: ModelInfo;
  isAdmin: boolean;
  inUse: boolean;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const dl = model.download;
  return (
    <article
      className={`model-card ${model.installed ? 'is-installed' : ''}`}
      style={{ maxWidth: 620 }}
    >
      <div className="model-card__head">
        <span className="model-card__lang" style={{ fontSize: 15, fontWeight: 650 }}>
          {model.label}
        </span>
        {model.installed ? (
          <span className="badge badge--sync">
            <IconCheck size={11} /> Installed
          </span>
        ) : dl ? (
          <span className="badge">Downloading</span>
        ) : (
          <span className="badge badge--muted">Not installed</span>
        )}
        {inUse && <span className="badge">In use</span>}
      </div>
      <p className="model-card__note" style={{ minHeight: 0 }}>
        {model.note}
      </p>
      {model.licence && (
        <p className="model-card__note" style={{ minHeight: 0 }}>
          <strong>Licence: {model.licence}.</strong> Everything else in Versovox is permissively
          licensed; this model is not, so it is never fetched without the click below.
        </p>
      )}
      {dl ? (
        <div className="model-card__progress">
          <span className="progressbar" aria-hidden="true">
            <span style={{ width: `${Math.round(dl.progress * 100)}%` }} />
          </span>
          <span className="model-card__progress-text">
            {dl.detail ?? (dl.state === 'queued' ? 'Queued…' : 'Starting…')}
          </span>
        </div>
      ) : model.installed ? (
        <div className="model-card__actions">
          <span className="model-card__size">{formatBytes(model.installedBytes)} on disk</span>
          {isAdmin && (
            <button className="btn btn--ghost" style={{ minHeight: 36 }} onClick={onRemove}>
              <IconTrash size={15} /> Remove
            </button>
          )}
        </div>
      ) : (
        <div className="model-card__actions">
          <span className="model-card__size">{formatBytes(model.sizeBytes)} download</span>
          {model.lastError && (
            <span className="model-card__error" title={model.lastError}>
              Last attempt failed
            </span>
          )}
          <button
            className="btn"
            style={{ minHeight: 38 }}
            disabled={!isAdmin}
            onClick={onDownload}
          >
            <IconDownload size={15} /> {model.lastError ? 'Retry download' : 'Download the aligner'}
          </button>
        </div>
      )}
    </article>
  );
}

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { type Job, type Settings } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import { IconAlert, IconCheck, IconDownload, IconTrash } from '../components/icons';
import { formatBytes, formatDate, formatSpan } from '../lib/format';
import { storageEstimate } from '../offline/downloads';
import {
  alignerModel,
  languageIdModel,
  speechModels,
  transcriptionModels,
  type ModelInfo,
  type ModelsResponse,
} from '../lib/types';
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
  // Readiness depends on the engine in force: forced alignment needs only the
  // aligner, and the whisper engine does not care whether the aligner is on
  // disk at all. The other engines compute nothing, so nothing is missing.
  const modelsReady =
    s.alignEngine === 'forced-align'
      ? Boolean(aligner?.installed)
      : s.alignEngine === 'whisper-cli'
        ? speechInstalled > 0
        : true;
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
            value={!models ? '—' : modelsReady ? 'Ready' : 'Set up'}
            unit={modelsReady ? 'to align' : 'needed'}
            detail={
              // A count of speech models is only news to someone running the
              // whisper engine; on the default engine the honest headline is
              // that one model covers every language.
              !models
                ? 'Catalog unavailable'
                : s.alignEngine === 'forced-align'
                  ? aligner?.installed
                    ? 'One aligner, every language'
                    : 'The forced aligner is not installed yet'
                  : s.alignEngine === 'whisper-cli'
                    ? `${speechInstalled} speech model${speechInstalled === 1 ? '' : 's'} installed`
                    : 'This engine downloads nothing'
            }
            warn={Boolean(models) && !modelsReady}
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
          Listening to the narration is the expensive part. Titles are matched on their metadata
          first; with forced alignment the run itself is the edition check, because a different
          edition produces no anchors and the pair is handed back to you undecided. These options
          decide what happens once a pair looks right.
          {s.transcribeSpeedRatio > 0 && (
            <>
              {' '}
              Measured on this server: {formatSpan((6 * 3600_000) / s.transcribeSpeedRatio)} of
              computing for a six-hour audiobook.
            </>
          )}
        </p>
        <div className="role-picker" role="radiogroup" aria-label="Processing mode">
          {
            // Three modes only make sense for the whisper engine, where a cheap
            // two-clip check runs before hours of transcription and there is
            // something to stop between. Forced alignment does the check and
            // the work in one short pass, so "verify then ask" and "do it all"
            // are the same instruction — offering both would be a lie. Under
            // that engine we show two, mapping the automatic one to 'verify'.
            (
              (s.alignEngine === 'forced-align'
                ? [
                    [
                      'verify',
                      'Align strong matches automatically',
                      'A confident metadata match is aligned on its own, one book at a time. Anything less certain waits for you.',
                    ],
                    [
                      'manual',
                      'Do nothing without me',
                      'Nothing is aligned until you press Start on a pair.',
                    ],
                  ]
                : [
                    [
                      'verify',
                      'Verify, then ask me',
                      'Check and link strong matches automatically; wait before the long transcription.',
                    ],
                    [
                      'auto',
                      'Do everything automatically',
                      'Strong matches are transcribed on their own, one at a time.',
                    ],
                    [
                      'manual',
                      'Do nothing without me',
                      'Every check and every alignment is started by hand.',
                    ],
                  ]) as [Settings['processingMode'], string, string][]
            ).map(([value, label, blurb]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={modeMatches(s, value)}
                disabled={!isAdmin}
                className={`role-picker__opt ${modeMatches(s, value) ? 'is-on' : ''}`}
                onClick={() => void save({ processingMode: value })}
              >
                <strong>{label}</strong>
                <span>{blurb}</span>
              </button>
            ))
          }
        </div>
        <h3 className="settings-h3">Alignment engine</h3>
        <AlignmentEngine
          settings={s}
          isAdmin={isAdmin}
          models={models}
          onEngine={(v) => void save({ alignEngine: v })}
          onPrecision={(v) => void save({ alignPrecision: v })}
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
            The last resort: used only when the ebook declares no language, the audio tags carry
            none, and no detection ran or it was unsure. Each pair can override its narration
            language on the Pairing page.
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

/**
 * Which radio is lit. Under forced alignment a stored 'auto' means the same
 * thing as 'verify', so it must light the automatic option rather than
 * silently showing nothing selected.
 */
function modeMatches(s: Settings, value: Settings['processingMode']): boolean {
  if (s.processingMode === value) return true;
  return s.alignEngine === 'forced-align' && s.processingMode === 'auto' && value === 'verify';
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
 * How much of the narration is actually decoded. The timeline is built from
 * points where the audio and the text provably agree, and those are cheap to
 * find in samples — so the honest framing is not "quality" but how often it
 * stops to listen, and what that buys.
 */
const PRECISIONS: [Settings['alignPrecision'], string, string][] = [
  [
    'fast',
    'Sample the narration (recommended)',
    'Listens for a few seconds every couple of minutes, then goes back over anything that looks off. A six-hour audiobook takes minutes instead of an hour, and switching still lands on the right paragraph.',
  ],
  [
    'careful',
    'Sample twice as often',
    'Roughly double the time, for books that are cut up a lot — dense chapter breaks, interviews, verse, or anything with long pauses.',
  ],
  [
    'thorough',
    'Listen to every second',
    'Sentence-perfect timings at around fifteen times the cost — hours per book. Worth it only if you read along with the narration word by word.',
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
  onPrecision,
}: {
  settings: Settings;
  isAdmin: boolean;
  models: ModelsResponse | null;
  onEngine: (v: Settings['alignEngine']) => void;
  onPrecision: (v: Settings['alignPrecision']) => void;
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

      {settings.alignEngine === 'forced-align' && (
        <>
          <h3 className="settings-h3">How closely it listens</h3>
          <div className="role-picker" role="radiogroup" aria-label="Alignment precision">
            {PRECISIONS.map(([value, label, blurb]) => (
              <button
                key={value}
                type="button"
                role="radio"
                aria-checked={settings.alignPrecision === value}
                disabled={!isAdmin}
                className={`role-picker__opt ${settings.alignPrecision === value ? 'is-on' : ''}`}
                onClick={() => onPrecision(value)}
              >
                <strong>{label}</strong>
                <span>{blurb}</span>
              </button>
            ))}
          </div>
          <p className="settings-section__lede">
            Switching from reading to listening always lands a little <em>behind</em> where you
            were, never ahead — the player steps back by however far the aligner says it might be
            wrong, so a switch never plays you a sentence you have not read yet.
          </p>
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
  // Grouped by what each model is FOR, not by language: since 0.7.0 the one
  // aligner covers every language, and the per-language whisper models serve
  // only the engine someone has to pick on purpose.
  const langId = languageIdModel(models);
  const heavy = transcriptionModels(models);
  const heavyInstalled = heavy.filter((m) => m.installed);
  const heavyBytes = heavyInstalled.reduce((n, m) => n + (m.installedBytes || m.sizeBytes), 0);
  const them = heavyInstalled.length === 1 ? 'it' : 'them';
  const they = heavyInstalled.length === 1 ? 'it' : 'they';
  // Sizes come from the catalog, never from a number typed into this page.
  const heavySizes = heavy.map((m) => m.sizeBytes);
  const heavyRange = heavySizes.length
    ? `${formatBytes(Math.min(...heavySizes))}–${formatBytes(Math.max(...heavySizes))}`
    : 'a gigabyte or more';
  const whisperEngine = settings.alignEngine === 'whisper-cli';
  // Language detection is the only reason the default engine ever touches
  // whisper, and even that is gated on the transcript source being this
  // server — worth saying, because it is the difference between "optional"
  // and "never used".
  const canDetectLanguage = settings.transcribeProvider === 'whisper-cli';

  return (
    <section className="settings-section" aria-label="Models" id="speech-models">
      <h2>Models</h2>
      <p className="settings-section__lede">
        Everything runs <strong>on this server</strong> — no audio, text or metadata ever leaves it.
        Models are downloaded once from Hugging Face into{' '}
        <code>{models?.modelsDir ?? 'the models directory'}</code>. Aligning a book needs exactly
        one of them, whatever its language; everything after that is optional.
      </p>

      <h3 className="settings-h3">The aligner — one model, every language</h3>
      {!models ? (
        <div className="skeleton" style={{ height: 150 }} />
      ) : !aligner ? (
        <p className="settings-section__lede">This server&rsquo;s catalog has no forced aligner.</p>
      ) : (
        <SoloModelCard
          model={aligner}
          isAdmin={isAdmin}
          badge={settings.alignEngine === 'forced-align' ? 'In use' : null}
          cta="Download the aligner"
          licenceNote="Everything else in Versovox is permissively licensed; this model is not, so it is never fetched without the click below."
          onDownload={() => void download(aligner)}
          onRemove={() => void remove(aligner)}
        />
      )}

      <h3 className="settings-h3">Speech recognition — optional</h3>
      <p className="settings-section__lede">
        Whisper models write narration out as words, and <strong>alignment never uses them</strong>{' '}
        — the aligner above times the words your ebook already contains. Speech recognition is left
        with two jobs: naming a book&rsquo;s language when neither the ebook nor the audio tags say
        (rare — nearly every book declares one), and the &ldquo;Transcribe with whisper&rdquo;
        rescue engine, which someone has to choose deliberately under Processing.
      </p>
      {langId && (
        <>
          <SoloModelCard
            model={langId}
            isAdmin={isAdmin}
            badge={langId.installed && canDetectLanguage ? 'In use' : null}
            cta="Download"
            onDownload={() => void download(langId)}
            onRemove={() => void remove(langId)}
          />
          <p className="settings-section__lede" style={{ marginBlockStart: 'var(--sp-2)' }}>
            At {formatBytes(langId.sizeBytes)} it is enough for the only job the default engine has
            for speech recognition. It is consulted only while the transcript source below is set to
            &ldquo;On this server&rdquo;
            {canDetectLanguage ? '' : ', which it is not right now'} — and then only for a book that
            declares no language of its own.
          </p>
        </>
      )}
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
          Where transcripts come from when one is needed — which, with forced alignment, is only for
          the language check above. A sidecar transcript is exact and free, so it is always
          preferred over any engine.
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
          {/* Folded away on purpose: these are the 0.5–3 GB downloads, and on
              the default engine not one of them is required. Opened by default
              only when the whisper engine — the thing that needs them — is the
              one selected. */}
          <details className="settings-advanced" open={whisperEngine}>
            <summary>Show per-language models (Whisper engine only)</summary>
            <p className="settings-section__lede">
              One model per language, {heavyRange} each. You need them only if you deliberately run{' '}
              <strong>Transcribe with whisper</strong> as the alignment engine
              {whisperEngine ? ', which is what is selected now' : ''}. Hebrew included: the
              multilingual aligner handles Hebrew as well as English, so the ivrit.ai fine-tune is
              worth its size only for transcribing Hebrew.
            </p>
            <label className="rs-toggle" style={{ maxWidth: 560 }}>
              <span>
                Fetch the default speech model automatically when the whisper engine has none
              </span>
              <input
                type="checkbox"
                role="switch"
                checked={settings.autoDownloadDefaultModel}
                disabled={!isAdmin}
                onChange={(e) => onAutoDefault(e.target.checked)}
              />
            </label>
            {/* The server checks the engine before it acts on this
                (ensureDefaultModel returns early on forced-align), so the
                switch must not read like a promise it will keep today. */}
            <p className="settings-section__lede">
              {settings.alignEngine === 'forced-align'
                ? 'The forced aligner never triggers this, so while it is the engine nothing is downloaded on its own — whatever the switch says.'
                : 'Acts on start-up only, and only while the transcript source is “On this server” with no multilingual model installed.'}
            </p>
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
                        <span className="model-card__size">
                          {formatBytes(chosen.installedBytes)}
                        </span>
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
          </details>
          <p style={{ color: 'var(--vx-text-soft)', fontSize: 13 }}>
            {whisperEngine ? (
              <>
                {speechInstalled} speech model{speechInstalled === 1 ? '' : 's'} installed. With the
                whisper engine a pair whose language has no installed model fails with a clear
                message and a download link, and the alignment runs by itself once the model
                arrives.
              </>
            ) : (
              <>
                Alignment needs none of these: the aligner covers every language on its own.
                {heavyInstalled.length > 0 && (
                  <>
                    {' '}
                    {heavyInstalled.length} transcription model
                    {heavyInstalled.length === 1 ? ' is' : 's are'} installed,{' '}
                    {formatBytes(heavyBytes)} on disk.{' '}
                    {canDetectLanguage && !langId?.installed
                      ? `The only use this engine could make of ${them} is the rare language check above; fetch the small model instead and ${they} can go.`
                      : `The engine you are running never opens ${them}.`}{' '}
                    Open the per-language list above to remove {them} and reclaim that space; a
                    download brings {them} back.
                  </>
                )}
              </>
            )}
          </p>
        </>
      )}
    </section>
  );
}

/**
 * A model that stands on its own rather than in the per-language grid, because
 * what it is for is not a language: the aligner (one model, every language)
 * and the small language detector. The licence is stated above the download
 * button, never after it — the aligner is the only part of Versovox under a
 * non-permissive one.
 */
function SoloModelCard({
  model,
  isAdmin,
  badge,
  cta,
  licenceNote,
  style,
  onDownload,
  onRemove,
}: {
  model: ModelInfo;
  isAdmin: boolean;
  badge?: string | null;
  cta: string;
  licenceNote?: string;
  style?: CSSProperties;
  onDownload: () => void;
  onRemove: () => void;
}) {
  const dl = model.download;
  return (
    <article
      className={`model-card ${model.installed ? 'is-installed' : ''}`}
      style={{ maxWidth: 620, ...style }}
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
        {badge && <span className="badge">{badge}</span>}
      </div>
      <p className="model-card__note" style={{ minHeight: 0 }}>
        {model.note}
      </p>
      {model.licence && (
        <p className="model-card__note" style={{ minHeight: 0 }}>
          <strong>Licence: {model.licence}.</strong>
          {licenceNote ? ` ${licenceNote}` : ''}
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
            <IconDownload size={15} /> {model.lastError ? 'Retry download' : cta}
          </button>
        </div>
      )}
    </article>
  );
}

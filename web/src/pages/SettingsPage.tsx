import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type Job, type Settings } from '@versovox/shared';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import { IconAlert, IconCheck, IconDownload, IconTrash } from '../components/icons';
import { formatBytes, formatDate } from '../lib/format';
import { storageEstimate } from '../offline/downloads';
import { type ModelInfo, type ModelsResponse } from '../lib/types';
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
  /** Installed speech models, for the overview card. */
  const [modelsInstalled, setModelsInstalled] = useState<number | null>(null);

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
    void api<ModelsResponse>('/api/models')
      .then((m) => setModelsInstalled(m.models.filter((x) => x.installed).length))
      .catch(() => setModelsInstalled(null));
  }, []);

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
                : `${stats.pairsAligned} transcribed`
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
            label="Speech models"
            value={`${modelsInstalled ?? '—'}`}
            unit="installed"
            detail={
              modelsInstalled === 0 ? 'None yet — alignment cannot run' : 'Per language, your pick'
            }
            warn={modelsInstalled === 0}
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
        onProviderChange={(v) => set('transcribeProvider', v)}
        onLanguageModel={(code, modelId) =>
          void save({ languageModels: { ...s.languageModels, [code]: modelId } })
        }
        onAutoDefault={(v) => void save({ autoDownloadDefaultModel: v })}
      />

      <section className="settings-section" aria-label="Processing" id="processing">
        <h2>Processing</h2>
        <p className="settings-section__lede">
          Transcribing narration is the slow part: roughly two to three hours of computing per hour
          of audio. A quick two-clip check confirms a match first; this decides what happens after
          it passes.
          {s.transcribeSpeedRatio > 0 && (
            <>
              {' '}
              Measured here: {(s.transcribeSpeedRatio * 60).toFixed(0)} minutes of audio per hour of
              computing.
            </>
          )}
        </p>
        <div className="role-picker" role="radiogroup" aria-label="Processing mode">
          {(
            [
              [
                'verify',
                'Verify, then ask me',
                'Check and link strong matches automatically; wait before transcribing.',
              ],
              [
                'auto',
                'Do everything automatically',
                'Verified matches transcribe on their own, one at a time.',
              ],
              [
                'manual',
                'Do nothing without me',
                'Every check and transcription is started by hand.',
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
        <h3 className="settings-h3">Alignment</h3>
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
        {s.transcribeProvider === 'whisper-cli' && (
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
      return 'Transcribe & align';
    case 'model-download':
      return 'Download speech model';
    default:
      return type;
  }
}

/* ------------------------------------------------------- speech models */

function SpeechModelsSection({
  settings,
  isAdmin,
  pinned,
  onProviderChange,
  onLanguageModel,
  onAutoDefault,
}: {
  settings: Settings;
  isAdmin: boolean;
  pinned: (k: string) => boolean;
  onProviderChange: (v: Settings['transcribeProvider']) => void;
  onLanguageModel: (code: string, modelId: string) => void;
  onAutoDefault: (v: boolean) => void;
}) {
  const toast = useToast();
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const timer = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = useCallback(async () => {
    try {
      setModels(await api<ModelsResponse>('/api/models'));
    } catch {
      /* non-fatal */
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Poll while anything is downloading.
  const downloading = models?.models.some((m) => m.download) ?? false;
  useEffect(() => {
    if (downloading && !timer.current) timer.current = setInterval(() => void load(), 2000);
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
  }, [downloading, load]);

  const download = async (m: ModelInfo) => {
    try {
      await api(`/api/models/${m.id}/download`, { method: 'POST' });
      toast.show(`Downloading ${m.label}`);
      await load();
    } catch {
      toast.show('Could not start the download (admin only)');
    }
  };
  const remove = async (m: ModelInfo) => {
    try {
      await api(`/api/models/${m.id}`, { method: 'DELETE' });
      toast.show(`Removed ${m.label}`);
      await load();
    } catch {
      toast.show('Could not remove the model');
    }
  };

  const byId = new Map((models?.models ?? []).map((m) => [m.id, m]));
  const installedCount = (models?.models ?? []).filter((m) => m.installed).length;

  return (
    <section className="settings-section" aria-label="Speech models" id="speech-models">
      <h2>Speech models</h2>
      <p className="settings-section__lede">
        Sentence-exact switching needs a transcript of the narration. Versovox transcribes
        audiobooks <strong>on this server</strong> with whisper.cpp — nothing is sent anywhere. Pick
        the model per language; Hebrew uses the ivrit.ai fine-tune, everything else the multilingual
        large-v3-turbo unless you choose otherwise. Models are downloaded once from Hugging Face
        into <code>{models?.modelsDir ?? 'the models directory'}</code>.
      </p>
      <p className="settings-section__lede">
        <strong>Nothing downloads on its own except the multilingual default</strong> (it covers
        English) on a fresh install — every other language is your click.
      </p>
      <label className="rs-toggle" style={{ maxWidth: 560 }}>
        <span>Fetch the default model automatically on a fresh install</span>
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
          Transcription {pinned('transcribeProvider') && <em>(set by environment)</em>}
        </label>
        <div
          className="segmented"
          id="set-provider"
          role="group"
          aria-label="Transcription provider"
        >
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
              const chosen = byId.get(chosenId) ?? byId.get(lang.models[0]!)!;
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
            {installedCount} model{installedCount === 1 ? '' : 's'} installed. A pair whose language
            has no installed model fails alignment with a clear message and a download link; the
            alignment runs automatically once the model arrives.
          </p>
        </>
      )}
    </section>
  );
}

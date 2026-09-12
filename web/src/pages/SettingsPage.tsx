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
    alignmentDirs: string[];
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
  const modelsReady = Boolean(aligner?.installed);
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
                  : s.autoAlign
                    ? 'Aligning new matches'
                    : 'Manual'
            }
            busy={stats.jobsRunning > 0}
            warn={stats.jobsRunning === 0 && stats.jobsFailed > 0}
          />
          <DashCard
            to="#alignment"
            label="Alignment"
            value={!models ? '—' : modelsReady ? 'Ready' : 'Set up'}
            unit={modelsReady ? 'to align' : 'needed'}
            detail={
              !models
                ? 'Unavailable'
                : modelsReady
                  ? 'Model installed'
                  : 'Model not installed yet'
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
          Your book folders are only ever read. New titles are picked up by the periodic rescan, or
          right away with the button below.
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
            <div className="kv">
              <dt>Alignment folder</dt>
              <dd>{data.paths.alignmentDirs.join(', ') || 'Not configured'}</dd>
            </div>
          </dl>
        )}
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

      <AlignmentSection
        settings={s}
        isAdmin={isAdmin}
        pinned={pinned}
        models={models}
        reload={reloadModels}
        onSave={(patch) => void save(patch)}
        onDraft={set}
        dirty={dirty}
        saving={saving}
        onCommit={() => void save()}
        speedRatio={s.alignSpeedRatio}
      />

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
/**
 * Alignment: four controls, in the order the questions arise. Is the model
 * here, does it run by itself, how closely does it listen, and what language
 * should it assume when a book does not say.
 *
 * The rule this section is written to: describe a CHOICE and its CONSEQUENCE,
 * never a mechanism the reader cannot choose between.
 */

/** Two outcomes, not two settings. Anything finer is a parameter, not a choice. */
const PRECISIONS: [Settings['alignPrecision'], string, string][] = [
  [
    'standard',
    'Standard',
    'A few minutes for a six-hour audiobook. Switching lands on the right paragraph.',
  ],
  [
    'exact',
    'Sentence-perfect',
    'Hours per book instead of minutes. Worth it only if you follow the narration word by word on the page.',
  ],
];

function AlignmentSection({
  settings,
  isAdmin,
  pinned,
  models,
  reload,
  onSave,
  onDraft,
  dirty,
  saving,
  onCommit,
  speedRatio,
}: {
  settings: Settings;
  isAdmin: boolean;
  pinned: (k: string) => boolean;
  models: ModelsResponse | null;
  reload: () => Promise<void>;
  onSave: (patch: Partial<Settings>) => void;
  onDraft: <K extends keyof Settings>(k: K, v: Settings[K]) => void;
  dirty: boolean;
  saving: boolean;
  onCommit: () => void;
  speedRatio: number;
}) {
  const toast = useToast();
  const model = alignerModel(models);
  const runtime = models?.alignerRuntime ?? null;

  const download = async () => {
    if (!model) return;
    try {
      await api(`/api/models/${model.id}/download`, { method: 'POST' });
      toast.show('Downloading');
      await reload();
    } catch {
      toast.show('Could not start the download (admin only)');
    }
  };
  const remove = async () => {
    if (!model) return;
    try {
      await api(`/api/models/${model.id}`, { method: 'DELETE' });
      toast.show('Removed');
      await reload();
    } catch {
      toast.show('Could not remove it (admin only)');
    }
  };

  return (
    <section className="settings-section" aria-label="Alignment" id="alignment">
      <h2>Alignment</h2>
      <p className="settings-section__lede">
        Lining a book up with its audiobook is what lets you switch between reading and listening
        at the same place. It happens once per book, here on this server — no audio, text or
        metadata ever leaves it.
      </p>

      {model && (
        <SoloModelCard
          model={model}
          isAdmin={isAdmin}
          cta="Download"
          licenceNote="Fine for your own library, not for a paid service. Everything else in Versovox is AGPL-3.0."
          onDownload={() => void download()}
          onRemove={() => void remove()}
        />
      )}
      {models && !model && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} />
          <span className="grow">This server&rsquo;s catalog is out of date — update Versovox.</span>
        </div>
      )}
      {model?.installed && runtime && !runtime.available && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={16} />
          <span className="grow">
            The model is installed but its runtime did not load, so nothing can be aligned. The
            Docker image includes it; on other installs see docs/self-hosting.md.
            {runtime.error ? (
              <span style={{ display: 'block', fontSize: 12.5, opacity: 0.85 }}>
                {runtime.error}
              </span>
            ) : null}
          </span>
        </div>
      )}

      <h3 className="settings-h3">When it runs</h3>
      <label className="rs-toggle" style={{ maxWidth: 620 }}>
        <span>
          Align new matches automatically
          <span className="hint" style={{ display: 'block' }}>
            {speedRatio > 0
              ? `About ${formatSpan((6 * 3600_000) / speedRatio)} for a six-hour audiobook on this server. One book at a time.`
              : 'One book at a time, in the background. Off means nothing runs until you press Start on a book.'}
          </span>
        </span>
        <input
          type="checkbox"
          role="switch"
          disabled={!isAdmin}
          checked={settings.autoAlign}
          onChange={(e) => onSave({ autoAlign: e.target.checked })}
        />
      </label>

      <h3 className="settings-h3">How closely it listens</h3>
      <div className="role-picker" role="radiogroup" aria-label="How closely it listens">
        {PRECISIONS.map(([value, label, blurb]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={settings.alignPrecision === value}
            disabled={!isAdmin}
            className={`role-picker__opt ${settings.alignPrecision === value ? 'is-on' : ''}`}
            onClick={() => onSave({ alignPrecision: value })}
          >
            <strong>{label}</strong>
            <span>{blurb}</span>
          </button>
        ))}
      </div>
      <p className="settings-section__lede">
        Switching from reading to listening always lands a little <em>behind</em> where you were,
        never ahead — so a switch never plays you a sentence you have not read yet.
      </p>

      <h3 className="settings-h3">Language</h3>
      <div className="field">
        <label htmlFor="set-lang">
          Fallback language {pinned('defaultLanguage') && <em>(env)</em>}
        </label>
        <input
          id="set-lang"
          className="input"
          disabled={pinned('defaultLanguage') || !isAdmin}
          value={settings.defaultLanguage}
          maxLength={8}
          style={{ maxWidth: 120 }}
          onChange={(e) => onDraft('defaultLanguage', e.target.value)}
        />
        <span className="hint">
          Used only when a book says nothing about its own language and its text is not enough to
          tell. Any single book can be overridden on the Pairing page.
        </span>
      </div>
      {dirty && (
        <button className="btn" onClick={onCommit} disabled={saving}>
          <IconCheck size={16} /> {saving ? 'Saving…' : 'Save changes'}
        </button>
      )}
    </section>
  );
}

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

import { useCallback, useEffect, useRef, useState } from 'react';
import { type Job, type Settings } from '@versovox/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import { IconAlert, IconCheck, IconDownload, IconTrash } from '../components/icons';
import { formatBytes, formatDate } from '../lib/format';
import { storageEstimate } from '../offline/downloads';
import { type ModelInfo, type ModelsResponse } from '../lib/types';

interface SettingsResponse {
  settings: Settings;
  envPinned: string[];
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
    <main className="app-main settings-page" style={{ maxWidth: 820 }}>
      <header className="page-head">
        <h1>Settings</h1>
        <p>Library, appearance, speech models, and this server's background work.</p>
      </header>

      <section className="settings-section" aria-label="Libraries">
        <h2>Libraries</h2>
        <p className="settings-section__lede">
          Library folders are mounted read-only and configured by the server operator
          (VX_EBOOK_DIRS, VX_AUDIOBOOK_DIRS). Versovox never writes into them.
        </p>
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
      />

      <section className="settings-section" aria-label="Alignment">
        <h2>Alignment</h2>
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

      <section className="settings-section" aria-label="Offline storage">
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
          Signed in as <strong>{user?.username}</strong> ({user?.role})
          {via === 'proxy' ? ' through your identity provider.' : '.'}
        </p>
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
}: {
  settings: Settings;
  isAdmin: boolean;
  pinned: (k: string) => boolean;
  onProviderChange: (v: Settings['transcribeProvider']) => void;
  onLanguageModel: (code: string, modelId: string) => void;
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

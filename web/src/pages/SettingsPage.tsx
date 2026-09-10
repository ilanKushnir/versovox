import { useCallback, useEffect, useState } from 'react';
import { type Job, type Settings } from '@tandemleaf/shared';
import { api } from '../api/client';
import { useSession } from '../state/session';
import { useToast } from '../components/ui';
import { IconAlert, IconCheck } from '../components/icons';
import { formatBytes, formatDate } from '../lib/format';
import { storageEstimate } from '../offline/downloads';

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
  const { user, logout } = useSession();
  const toast = useToast();
  const [data, setData] = useState<SettingsResponse | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [draft, setDraft] = useState<Partial<Settings>>({});
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  const [saving, setSaving] = useState(false);
  const [appTheme, setAppTheme] = useState<string>(
    () => localStorage.getItem('tl-app-theme') ?? 'auto',
  );

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
    localStorage.setItem('tl-app-theme', appTheme);
  }, [appTheme]);

  const save = async () => {
    setSaving(true);
    try {
      const res = await api<{ settings: Settings }>('/api/settings', {
        method: 'PUT',
        body: draft,
      });
      setData((d) => (d ? { ...d, settings: res.settings } : d));
      setDraft({});
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
    <main className="app-main" style={{ maxWidth: 760 }}>
      <h1 className="section-title" style={{ marginBlockStart: 0 }}>
        Settings
      </h1>

      <section className="settings-section" aria-label="Libraries">
        <h2>Libraries</h2>
        <p style={{ color: 'var(--tl-text-soft)', fontSize: 14, marginTop: 0 }}>
          Library folders are mounted read-only and configured by the server operator
          (TL_EBOOK_DIRS, TL_AUDIOBOOK_DIRS). TandemLeaf never writes into them.
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
        <div style={{ marginBlockStart: 'var(--sp-4)' }}>
          <button className="btn btn--secondary" onClick={() => void rescan()}>
            Rescan libraries now
          </button>
        </div>
      </section>

      <section className="settings-section" aria-label="Appearance">
        <h2>Appearance</h2>
        <div className="field">
          <label htmlFor="set-theme">App theme</label>
          <select
            id="set-theme"
            className="input"
            value={appTheme}
            onChange={(e) => setAppTheme(e.target.value)}
          >
            <option value="auto">Match system</option>
            <option value="light">Light</option>
            <option value="dark">Dark</option>
          </select>
          <span className="hint">Reader pages have their own theme, set inside the reader.</span>
        </div>
      </section>

      <section className="settings-section" aria-label="Alignment and transcription">
        <h2>Alignment & transcription</h2>
        <p style={{ color: 'var(--tl-text-soft)', fontSize: 14, marginTop: 0 }}>
          Sentence-exact switching needs a word-timestamped transcript. TandemLeaf bundles no speech
          model and requires no cloud service: use pre-computed transcripts (fixture provider) or
          point the experimental provider at a local whisper-compatible binary.
        </p>
        <div className="field">
          <label htmlFor="set-provider">
            Transcription provider {pinned('transcribeProvider') && <em>(set by environment)</em>}
          </label>
          <select
            id="set-provider"
            className="input"
            disabled={pinned('transcribeProvider')}
            value={s.transcribeProvider}
            onChange={(e) =>
              set('transcribeProvider', e.target.value as Settings['transcribeProvider'])
            }
          >
            <option value="none">Disabled</option>
            <option value="fixture">Sidecar transcripts (deterministic)</option>
            <option value="whisper-cli">whisper-cli (experimental, local binary)</option>
          </select>
        </div>
        {s.transcribeProvider === 'whisper-cli' && (
          <>
            <div className="field">
              <label htmlFor="set-bin">
                Whisper binary path {pinned('whisperBin') && <em>(env)</em>}
              </label>
              <input
                id="set-bin"
                className="input"
                disabled={pinned('whisperBin')}
                value={s.whisperBin}
                placeholder="/models/whisper-cli"
                onChange={(e) => set('whisperBin', e.target.value)}
              />
            </div>
            <div className="field">
              <label htmlFor="set-model">
                Model path {pinned('whisperModel') && <em>(env)</em>}
              </label>
              <input
                id="set-model"
                className="input"
                disabled={pinned('whisperModel')}
                value={s.whisperModel}
                placeholder="/models/ggml-base.bin"
                onChange={(e) => set('whisperModel', e.target.value)}
              />
            </div>
          </>
        )}
        <div className="field">
          <label htmlFor="set-lang">
            Default language {pinned('defaultLanguage') && <em>(env)</em>}
          </label>
          <input
            id="set-lang"
            className="input"
            disabled={pinned('defaultLanguage')}
            value={s.defaultLanguage}
            maxLength={8}
            style={{ maxWidth: 120 }}
            onChange={(e) => set('defaultLanguage', e.target.value)}
          />
          <span className="hint">
            BCP-47 code, e.g. en or he. Used when a book has no language metadata.
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
            disabled={pinned('jobConcurrency')}
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
            value={s.autoPairThreshold}
            style={{ maxWidth: 120 }}
            onChange={(e) => set('autoPairThreshold', Number(e.target.value))}
          />
          <span className="hint">
            Pairs scoring below this always wait for manual review. Raising it is safer.
          </span>
        </div>
        {dirty && (
          <button className="btn" onClick={() => void save()} disabled={saving}>
            <IconCheck size={16} /> {saving ? 'Saving…' : 'Save changes'}
          </button>
        )}
        <p style={{ color: 'var(--tl-text-soft)', fontSize: 13 }}>{data.precedence}</p>
      </section>

      <section className="settings-section" aria-label="Offline storage">
        <h2>Offline storage</h2>
        {storage ? (
          <p style={{ fontSize: 14.5 }}>
            This browser is using {formatBytes(storage.usage)} of about {formatBytes(storage.quota)}{' '}
            available for offline books.
          </p>
        ) : (
          <p style={{ fontSize: 14.5, color: 'var(--tl-text-soft)' }}>
            Storage usage is not reported by this browser.
          </p>
        )}
        <p style={{ color: 'var(--tl-text-soft)', fontSize: 13.5 }}>
          Downloads are per-title and explicit — manage them from each book page.
        </p>
      </section>

      <section className="settings-section" aria-label="Background activity">
        <h2>Background activity</h2>
        {jobs.length === 0 ? (
          <p style={{ color: 'var(--tl-text-soft)', fontSize: 14.5 }}>No background jobs yet.</p>
        ) : (
          <div className="list-card">
            {jobs.slice(0, 12).map((j) => (
              <div className="list-row" key={j.id} style={{ cursor: 'default' }}>
                {j.state === 'running' ? (
                  <span className="spinner" style={{ width: 15, height: 15 }} />
                ) : j.state === 'failed' ? (
                  <IconAlert size={15} style={{ color: 'var(--tl-danger)' }} />
                ) : (
                  <IconCheck size={15} style={{ opacity: j.state === 'done' ? 1 : 0.4 }} />
                )}
                <span className="grow">
                  {j.type}
                  {j.detail ? ` — ${j.detail}` : ''}
                  {j.error ? ` — ${j.error}` : ''}
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
          Signed in as <strong>{user?.username}</strong> ({user?.role}).
        </p>
        <button className="btn btn--secondary" onClick={() => void logout()}>
          Sign out
        </button>
      </section>
    </main>
  );
}

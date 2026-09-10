import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { type Job } from '@versovox/shared';
import { api } from '../api/client';
import { type ModelsResponse } from '../lib/types';
import { IconAlert, IconCheck, IconClose, IconHeadphones, IconBookOpen } from './icons';
import { useToast } from './ui';

const ACTIVE = new Set(['queued', 'running']);

const TYPE_LABEL: Record<string, string> = {
  align: 'Transcribe & align',
  'model-download': 'Model download',
  scan: 'Library scan',
  'index-ebook': 'Index ebook',
  'probe-audio': 'Inspect audiobook',
  'detect-pairs': 'Find pairs',
};

function typeLabel(t: string): string {
  return TYPE_LABEL[t] ?? t.replace(/[-_]/g, ' ');
}

function ago(iso: string | null): string {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86_400)} d ago`;
}

/**
 * Live view of the job queue: what is running right now (with whisper's
 * own progress), what is waiting behind it, and the last few outcomes.
 * Polls quickly while anything is active and slowly otherwise.
 */
export function ProcessingQueue({
  canManage,
  onChange,
}: {
  canManage: boolean;
  onChange?: () => void;
}) {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [showDone, setShowDone] = useState(false);
  const toast = useToast();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const activeCountRef = useRef(0);

  const load = useCallback(async () => {
    try {
      const res = await api<{ jobs: Job[] }>('/api/jobs');
      setJobs(res.jobs);
      const n = res.jobs.filter((j) => ACTIVE.has(j.state)).length;
      if (n !== activeCountRef.current) onChange?.();
      activeCountRef.current = n;
      return n;
    } catch {
      return 0;
    }
  }, [onChange]);

  useEffect(() => {
    let alive = true;
    const tick = async () => {
      const n = await load();
      if (!alive) return;
      timer.current = setTimeout(() => void tick(), n > 0 ? 2500 : 20_000);
    };
    void tick();
    const onVis = () => {
      if (document.visibilityState === 'visible') {
        if (timer.current) clearTimeout(timer.current);
        void tick();
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      alive = false;
      if (timer.current) clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  const act = async (job: Job, what: 'cancel' | 'retry') => {
    try {
      await api(`/api/jobs/${job.id}/${what}`, { method: 'POST' });
      toast.show(what === 'cancel' ? 'Job cancelled' : 'Job queued again');
      await load();
    } catch {
      toast.show('Action failed');
    }
  };

  if (!jobs) return null;
  const running = jobs.filter((j) => j.state === 'running');
  const queued = jobs.filter((j) => j.state === 'queued');
  const done = jobs
    .filter((j) => !ACTIVE.has(j.state))
    .sort(
      (a, b) => Date.parse(b.finishedAt ?? b.createdAt) - Date.parse(a.finishedAt ?? a.createdAt),
    )
    .slice(0, 8);
  const idle = running.length === 0 && queued.length === 0;

  return (
    <section className="queue" aria-label="Processing queue" aria-live="polite">
      <div className="queue__head">
        <div>
          <h2 className="section-title" style={{ margin: 0 }}>
            Processing
            {!idle && (
              <span className="section-title__count">
                {running.length} running · {queued.length} waiting
              </span>
            )}
          </h2>
          <p className="queue__lede">
            {idle
              ? 'Nothing is being processed right now. Confirming a pair or downloading a model adds work here.'
              : 'Transcription runs one book at a time so the server stays responsive; everything else waits its turn.'}
          </p>
        </div>
        <span className={`queue__dot ${idle ? '' : 'is-live'}`} aria-hidden="true" />
      </div>

      {running.map((j) => (
        <JobRow key={j.id} job={j} canManage={canManage} onAct={act} live />
      ))}
      {queued.length > 0 && (
        <ol className="queue__list" aria-label="Waiting">
          {queued.map((j, i) => (
            <JobRow key={j.id} job={j} canManage={canManage} onAct={act} position={i + 1} />
          ))}
        </ol>
      )}
      {done.length > 0 && (
        <>
          <button className="queue__toggle" onClick={() => setShowDone((v) => !v)}>
            {showDone ? 'Hide' : 'Show'} recent results ({done.length})
          </button>
          {showDone && (
            <div className="queue__list queue__list--done">
              {done.map((j) => (
                <JobRow key={j.id} job={j} canManage={canManage} onAct={act} />
              ))}
            </div>
          )}
        </>
      )}
    </section>
  );
}

function JobRow({
  job,
  canManage,
  onAct,
  live,
  position,
}: {
  job: Job;
  canManage: boolean;
  onAct: (job: Job, what: 'cancel' | 'retry') => void;
  live?: boolean;
  position?: number;
}) {
  const pct = Math.round(job.progress * 100);
  const failed = job.state === 'failed';
  const modelMissing = failed && (job.error ?? '').startsWith('model-missing:');
  const errorText = modelMissing ? (job.error ?? '').split('|').slice(1).join('|') : job.error;
  const subject = job.subject;
  const target = subject?.pairId
    ? `#pair-${subject.pairId}`
    : subject?.bookId
      ? `/book/${subject.bookId}`
      : null;
  const Icon =
    job.type === 'align' ? IconHeadphones : job.type === 'model-download' ? IconBookOpen : null;
  return (
    <div className={`jobrow ${live ? 'jobrow--live' : ''} jobrow--${job.state}`}>
      <div className="jobrow__lead">
        {position != null ? (
          <span className="jobrow__pos">{position}</span>
        ) : job.state === 'done' ? (
          <IconCheck size={16} />
        ) : failed ? (
          <IconAlert size={16} />
        ) : job.state === 'cancelled' ? (
          <IconClose size={16} />
        ) : Icon ? (
          <Icon size={16} />
        ) : null}
      </div>
      <div className="jobrow__body">
        <div className="jobrow__title">
          {target && target.startsWith('/') ? (
            <Link to={target}>{subject?.title ?? typeLabel(job.type)}</Link>
          ) : target ? (
            <a href={target}>{subject?.title ?? typeLabel(job.type)}</a>
          ) : (
            (subject?.title ?? typeLabel(job.type))
          )}
          <span className="jobrow__type">{typeLabel(job.type)}</span>
        </div>
        <div className="jobrow__meta">
          {live && job.detail ? job.detail : null}
          {!live && job.state === 'queued' ? (subject?.sub ?? 'Waiting for a free slot') : null}
          {!live && job.state !== 'queued' ? (
            <>
              {job.state === 'done' ? 'Finished' : job.state === 'failed' ? 'Failed' : 'Cancelled'}{' '}
              {ago(job.finishedAt)}
              {errorText ? ` · ${errorText}` : ''}
            </>
          ) : null}
        </div>
        {live && (
          <div
            className="progressbar jobrow__bar"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
          >
            <span style={{ width: `${Math.max(2, pct)}%` }} />
          </div>
        )}
      </div>
      <div className="jobrow__side">
        {live && <span className="jobrow__pct">{pct}%</span>}
        {canManage && (job.state === 'queued' || job.state === 'running') && (
          <button
            className="btn btn--ghost btn--sm"
            onClick={() => onAct(job, 'cancel')}
            aria-label="Cancel job"
          >
            Cancel
          </button>
        )}
        {canManage && failed && !modelMissing && (
          <button className="btn btn--ghost btn--sm" onClick={() => onAct(job, 'retry')}>
            Retry
          </button>
        )}
        {modelMissing && (
          <Link className="btn btn--ghost btn--sm" to="/settings#models">
            Get model
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * The "what actually happens" diagram: audio → ffmpeg → whisper → words →
 * aligned to the ebook's sentences → a sentence↔second map used for switching.
 */
export function PipelineDiagram() {
  const [models, setModels] = useState<ModelsResponse | null>(null);
  useEffect(() => {
    void api<ModelsResponse>('/api/models')
      .then(setModels)
      .catch(() => setModels(null));
  }, []);
  const installed = models?.models.filter((m) => m.installed) ?? [];
  const steps: { n: number; title: string; body: string; tag?: string }[] = [
    {
      n: 1,
      title: 'Audiobook',
      body: 'Each part is decoded to plain 16 kHz mono audio with ffmpeg. Files are only read, never changed.',
      tag: 'ffmpeg',
    },
    {
      n: 2,
      title: 'Speech model',
      body: 'A whisper.cpp model listens to the narration and writes down every word with its timestamp. Better models for a language give cleaner words.',
      tag:
        installed.length === 0 ? 'no model installed' : installed.map((m) => m.label).join(' · '),
    },
    {
      n: 3,
      title: 'Ebook',
      body: 'The EPUB is split into sentences. A quick two-clip check confirms the narration really is this text before a full run starts.',
      tag: 'sentences',
    },
    {
      n: 4,
      title: 'Alignment',
      body: 'Spoken words are matched to the ebook sentences, tolerating skipped intros, renamed chapters and small edition differences.',
      tag: 'anchors',
    },
    {
      n: 5,
      title: 'Switching map',
      body: 'Every sentence now knows its second in the audio and vice versa, so you can jump between reading and listening at the exact line.',
      tag: 'sentence ↔ second',
    },
  ];
  return (
    <div className="pipeline" role="img" aria-label="How alignment works">
      {steps.map((s, i) => (
        <div key={s.n} className={`pipeline__step pipeline__step--${s.n}`}>
          <div className="pipeline__num">{s.n}</div>
          <div className="pipeline__title">{s.title}</div>
          <p className="pipeline__body">{s.body}</p>
          {s.tag && <span className="pipeline__tag">{s.tag}</span>}
          {i < steps.length - 1 && <span className="pipeline__arrow" aria-hidden="true" />}
        </div>
      ))}
      <p className="pipeline__foot">
        Models are chosen per language in{' '}
        <Link to="/settings#models">Settings → Speech models</Link>. Only the English default is
        fetched automatically; the rest are yours to pick.
      </p>
    </div>
  );
}

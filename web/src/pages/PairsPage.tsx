import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { LANGUAGES, languageLabel } from '@readport/shared';
import { api } from '../api/client';
import { type BookSummary, type PairDto, type ProcessingSummary } from '../lib/types';
import { Cover, EmptyState, Sheet, useToast } from '../components/ui';
import { useSession } from '../state/session';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconClose,
  IconDownload,
  IconHeadphones,
  IconLink,
  IconSwitch,
} from '../components/icons';
import { formatDuration, formatPct, formatSpan } from '../lib/format';
import { PipelineDiagram, ProcessingQueue } from '../components/Processing';
import { MANUAL_LINK_NOTE, UNALIGNED_PAIR_NOTE } from '../lib/pairLabel';

type PairAction = 'confirm' | 'reject' | 'unlink' | 'align';

export function PairsPage() {
  const { user } = useSession();
  const [pairs, setPairs] = useState<PairDto[] | null>(null);
  const [summary, setSummary] = useState<ProcessingSummary | null>(null);
  /** Multi-select for bulk "start transcription". */
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [howOpen, setHowOpen] = useState(false);
  const toast = useToast();
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const isAdmin = user?.role === 'admin' || user?.role === 'curator';

  const load = useCallback(async () => {
    try {
      const res = await api<{ pairs: PairDto[]; summary?: ProcessingSummary }>('/api/pairs');
      setPairs(res.pairs);
      setSummary(res.summary ?? null);
      setError(null);
    } catch {
      setError('Could not load pairing data.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  // Live progress while any alignment runs.
  const active = pairs?.some(
    (p) => p.lastAlignJob && ['queued', 'running'].includes(p.lastAlignJob.state),
  );
  useEffect(() => {
    if (active && !pollRef.current) pollRef.current = setInterval(() => void load(), 3000);
    if (!active && pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
    return () => {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    };
  }, [active, load]);

  const act = async (pairId: string, action: PairAction) => {
    setBusyId(pairId);
    try {
      await api(`/api/pairs/${pairId}/${action}`, { method: 'POST' });
      toast.show(
        action === 'confirm'
          ? 'Pair confirmed — alignment queued'
          : action === 'align'
            ? 'Alignment queued'
            : action === 'reject'
              ? 'Suggestion dismissed'
              : 'Pair unlinked',
      );
      await load();
    } catch {
      toast.show('Action failed');
    } finally {
      setBusyId(null);
    }
  };

  const setLanguage = async (pairId: string, language: string | null) => {
    try {
      await api(`/api/pairs/${pairId}/language`, { method: 'POST', body: { language } });
      toast.show(
        language ? `Narration language set to ${languageLabel(language)}` : 'Language reset',
      );
      await load();
    } catch {
      toast.show('Could not change the language (admin only)');
    }
  };

  const downloadModel = async (modelId: string, language: string) => {
    try {
      await api(`/api/models/${modelId}/download`, { method: 'POST' });
      toast.show(
        `Downloading the ${languageLabel(language)} model — alignment resumes when it lands`,
        {
          label: 'Watch progress',
          onClick: () => {
            location.assign('/settings#speech-models');
          },
        },
      );
      await load();
    } catch {
      toast.show('Could not start the download (admin only)');
    }
  };

  if (error) {
    return (
      <main className="app-main">
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {error}
        </div>
      </main>
    );
  }

  const candidates = (pairs ?? []).filter((p) => p.status === 'candidate');
  const linked = (pairs ?? []).filter((p) => p.status === 'auto' || p.status === 'confirmed');
  const rejected = (pairs ?? []).filter((p) => p.status === 'rejected');

  /** Linked, not aligned yet, and not already queued: what Start acts on. */
  const startable = (pairs ?? []).filter(
    (p) =>
      (p.status === 'auto' || p.status === 'confirmed') &&
      !p.alignment &&
      !(p.lastAlignJob && ['queued', 'running'].includes(p.lastAlignJob.state)),
  );
  const toggleSelected = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startMany = async (ids: string[]) => {
    if (ids.length === 0) return;
    try {
      const res = await api<{ queued: number; skipped: number }>('/api/pairs/align-many', {
        method: 'POST',
        body: { pairIds: ids },
      });
      toast.show(
        res.queued > 0
          ? `Queued ${res.queued} book${res.queued === 1 ? '' : 's'} for transcription`
          : 'Nothing new to queue',
      );
      setSelected(new Set());
      await load();
    } catch {
      toast.show('Could not queue those pairs');
    }
  };

  return (
    <main className="app-main">
      <header className="page-head page-head--row">
        <div>
          <h1>Pairing</h1>
          <p>
            Ebook and audiobook editions of the same work. Metadata alone never links anything:
            strong matches are verified against the narration first, uncertain ones wait for you.
          </p>
        </div>
        <div className="page-head__actions">
          <button
            className="btn btn--ghost"
            onClick={() => setHowOpen((v) => !v)}
            aria-expanded={howOpen}
          >
            How it works
          </button>
          <button className="btn btn--secondary" onClick={() => setLinkOpen(true)}>
            <IconLink size={16} /> Link manually
          </button>
        </div>
      </header>
      {howOpen && (
        <section className="panel panel--soft" aria-label="How alignment works">
          <PipelineDiagram />
        </section>
      )}
      <ProcessingQueue canManage={isAdmin} onChange={() => void load()} />

      {isAdmin && summary && startable.length > 0 && (
        <section className="worksum" aria-label="Alignment work">
          <div className="worksum__body">
            <h2 className="worksum__title">
              {startable.length} verified {startable.length === 1 ? 'book is' : 'books are'} ready
              to align
            </h2>
            <p className="worksum__lede">
              {summary.estimatedMs != null ? (
                <>
                  {formatSpan(summary.estimatedMs)} of computing for{' '}
                  {formatDuration(summary.pendingAudioMs)} of audio, measured from this
                  server&rsquo;s own speed. They run one at a time and you can stop any of them.
                </>
              ) : (
                <>
                  {formatDuration(summary.pendingAudioMs)} of audio in total. The first run will
                  measure how fast this server aligns, and the estimate appears here.
                </>
              )}
            </p>
          </div>
          <div className="worksum__actions">
            {selected.size > 0 && (
              <button className="btn btn--ghost" onClick={() => setSelected(new Set())}>
                Clear {selected.size}
              </button>
            )}
            <button
              className="btn"
              onClick={() =>
                void startMany(selected.size > 0 ? [...selected] : startable.map((p) => p.id))
              }
            >
              {selected.size > 0
                ? `Start ${selected.size} selected`
                : `Start all ${startable.length}`}
            </button>
          </div>
        </section>
      )}
      {linkOpen && (
        <ManualLinkSheet
          onClose={() => setLinkOpen(false)}
          onLinked={() => {
            setLinkOpen(false);
            toast.show('Pair linked — alignment queued');
            void load();
          }}
        />
      )}

      {!pairs ? (
        <div aria-busy="true">
          <div className="skeleton" style={{ height: 180, marginBlockEnd: 16 }} />
          <div className="skeleton" style={{ height: 180 }} />
        </div>
      ) : pairs.length === 0 ? (
        <EmptyState icon={<IconLink size={42} />} title="No pair suggestions yet">
          Pair candidates appear after a library scan finds ebook and audiobook editions with
          matching metadata. Nothing is ever linked without strong evidence.
        </EmptyState>
      ) : (
        <>
          {candidates.length > 0 && (
            <section aria-label="Needs review">
              <h2 className="section-title">
                Needs review <span className="section-title__count">{candidates.length}</span>
              </h2>
              {candidates.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
          {linked.length > 0 && (
            <section aria-label="Linked pairs">
              <h2 className="section-title">
                Linked <span className="section-title__count">{linked.length}</span>
              </h2>
              {linked.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
          {rejected.length > 0 && (
            <section aria-label="Dismissed pairs">
              <h2 className="section-title">
                Dismissed <span className="section-title__count">{rejected.length}</span>
              </h2>
              {rejected.map((p) => (
                <PairCard
                  speedRatio={summary?.speedRatio ?? 0}
                  key={p.id}
                  pair={p}
                  busy={busyId === p.id}
                  isAdmin={isAdmin}
                  onAction={act}
                  onLanguage={setLanguage}
                  onDownloadModel={downloadModel}
                  selectable={startable.some((s) => s.id === p.id)}
                  selected={selected.has(p.id)}
                  onSelect={toggleSelected}
                />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ScoreCell({
  label,
  value,
  good,
}: {
  label: string;
  value: string;
  good?: boolean | null;
}) {
  return (
    <div className={`evidence-cell ${good === true ? 'is-good' : good === false ? 'is-bad' : ''}`}>
      {label}
      <b>{value}</b>
    </div>
  );
}

function EditionTile({
  book,
  kind,
  extra,
}: {
  book: { id: string; title: string; author: string | null } | null;
  kind: 'ebook' | 'audio';
  extra?: string;
}) {
  return (
    <Link to={book ? `/book/${book.id}` : '/pairs'} className="edition-tile">
      <span className="edition-tile__cover">
        {book && (
          <Cover
            book={{ id: book.id, title: book.title, author: book.author, hasCover: true, kind }}
            className="edition-tile__img"
          />
        )}
      </span>
      <span className="edition-tile__body">
        <span className="edition-tile__kind">
          {kind === 'ebook' ? <IconBookOpen size={12} /> : <IconHeadphones size={12} />}
          {kind === 'ebook' ? 'Ebook' : 'Audiobook'}
        </span>
        <span className="edition-tile__title">{book?.title ?? 'Unknown'}</span>
        <span className="edition-tile__meta">
          {book?.author ?? '—'}
          {extra ? ` · ${extra}` : ''}
        </span>
      </span>
    </Link>
  );
}

function PairCard({
  pair,
  busy,
  isAdmin,
  onAction,
  onLanguage,
  onDownloadModel,
  selectable,
  selected,
  onSelect,
  speedRatio,
}: {
  pair: PairDto;
  busy: boolean;
  isAdmin: boolean;
  /** Seconds of audio aligned per second of wall clock; 0 = not yet measured. */
  speedRatio: number;
  onAction: (id: string, a: PairAction) => void;
  onLanguage: (id: string, language: string | null) => void;
  onDownloadModel: (modelId: string, language: string) => void;
  /** Verified, not aligned yet: offer it for bulk starting. */
  selectable?: boolean;
  selected?: boolean;
  onSelect?: (id: string) => void;
}) {
  const e = pair.evidence;
  const notes = (e.notes ?? []).flatMap((n): { text: string; done: boolean }[] => {
    if (pair.status === 'candidate' || !n.startsWith('Strong metadata match')) {
      return [{ text: n, done: false }];
    }
    if (pair.status === 'auto') {
      return [
        {
          text: 'Strong metadata match — content verification passed; linked automatically.',
          done: true,
        },
      ];
    }
    return [];
  });
  const statusLabel =
    pair.status === 'auto'
      ? 'Linked automatically'
      : pair.status === 'confirmed'
        ? 'Confirmed by you'
        : pair.status === 'candidate'
          ? 'Suggested'
          : 'Dismissed';
  const job = pair.lastAlignJob;
  const running = job && (job.state === 'queued' || job.state === 'running');
  const lang = pair.language;
  const langSourceLabel =
    lang.source === 'override'
      ? 'set by you'
      : lang.source === 'alignment'
        ? 'detected'
        : lang.source === 'ebook-metadata'
          ? 'from the ebook'
          : lang.source === 'audio-tags'
            ? 'from the audio tags'
            : 'unknown — will be detected';

  return (
    <article
      id={`pair-${pair.id}`}
      className={`pair-card pair-card--${pair.status} ${selected ? 'is-selected' : ''}`}
    >
      {selectable && onSelect && (
        <label className="pair-card__pick">
          <input
            type="checkbox"
            checked={!!selected}
            onChange={() => onSelect(pair.id)}
            aria-label={`Select ${pair.ebook?.title ?? 'this pair'} for transcription`}
          />
          <span>Select</span>
        </label>
      )}
      <div className="pair-card__editions">
        <EditionTile book={pair.ebook} kind="ebook" />
        <span className="pair-card__link" aria-hidden="true">
          <IconSwitch size={18} />
        </span>
        <EditionTile
          book={pair.audio}
          kind="audio"
          extra={pair.audio?.durationMs ? formatDuration(pair.audio.durationMs) : undefined}
        />
      </div>

      <div className="pair-card__status">
        <span
          className={`badge ${pair.status === 'auto' || pair.status === 'confirmed' ? 'badge--paired' : pair.status === 'rejected' ? 'badge--muted' : ''}`}
        >
          {statusLabel}
        </span>
        {pair.handoff?.available && (
          <span className="badge badge--sync">
            <IconSwitch size={11} /> Switch ready · {formatPct(pair.handoff.exactSentenceCoverage)}{' '}
            exact
          </span>
        )}
        {/* What THIS book will cost, beside the button that starts it. The
            queue-wide total answers a different question, and a reader
            comparing one number against one book is how "it took longer than
            you said" happens. */}
        {!pair.alignment && speedRatio > 0 && pair.audio?.durationMs ? (
          <span className="badge badge--muted">
            ≈ {formatSpan(pair.audio.durationMs / speedRatio)} to align
          </span>
        ) : null}
        <span className="pair-card__score">Match {formatPct(pair.score)}</span>
        <label className="lang-pick">
          <span className="lang-pick__label">Narration</span>
          <select
            className="lang-pick__select"
            value={lang.override ?? ''}
            disabled={!isAdmin}
            title={`Language ${langSourceLabel}`}
            onChange={(ev) => onLanguage(pair.id, ev.target.value || null)}
          >
            <option value="">
              {lang.override
                ? 'Auto'
                : `Auto · ${lang.effective ? languageLabel(lang.effective) : 'detect'}`}
            </option>
            {LANGUAGES.map((l) => (
              <option key={l.code} value={l.code}>
                {l.label} · {l.native}
              </option>
            ))}
          </select>
        </label>
      </div>

      <div className="evidence-grid">
        {e.titleScore !== undefined && (
          <ScoreCell label="Title" value={formatPct(e.titleScore)} good={e.titleScore > 0.85} />
        )}
        {e.authorScore !== undefined && (
          <ScoreCell label="Author" value={formatPct(e.authorScore)} good={e.authorScore > 0.85} />
        )}
        <ScoreCell
          label="Identifiers"
          value={e.identifierMatch ? 'Match' : '—'}
          good={e.identifierMatch ? true : null}
        />
        <ScoreCell
          label="Language"
          value={
            e.languageMatch === null || e.languageMatch === undefined
              ? 'Unknown'
              : e.languageMatch
                ? 'Match'
                : 'Mismatch'
          }
          good={e.languageMatch ?? null}
        />
        {e.durationPagesRatio != null && (
          <ScoreCell
            label="Length ratio"
            value={`${e.durationPagesRatio.toFixed(2)}×`}
            good={e.durationPagesRatio > 0.55 && e.durationPagesRatio < 1.9}
          />
        )}
        {e.contentScore != null && (
          <ScoreCell
            label="Content overlap"
            value={formatPct(e.contentScore)}
            good={e.contentScore > 0.6}
          />
        )}
      </div>

      {notes.map((n, i) => (
        <div className="banner" key={i} style={{ marginBlockEnd: 8 }}>
          {n.done ? <IconCheck size={15} /> : <IconAlert size={15} />} {n.text}
        </div>
      ))}
      {pair.compat?.warning && (
        <div className="banner banner--error">
          <IconAlert size={15} /> {pair.compat.warning}
        </div>
      )}

      {running && job && (
        <div className="align-progress" role="status">
          <span className="spinner" style={{ width: 16, height: 16 }} />
          <span className="grow">
            <span style={{ fontWeight: 600 }}>
              {job.state === 'queued' ? 'Alignment queued' : 'Aligning'}
            </span>
            {job.detail ? ` — ${job.detail}` : ''}
            <span className="progressbar" aria-hidden="true">
              <span style={{ width: `${Math.round(job.progress * 100)}%` }} />
            </span>
          </span>
        </div>
      )}
      {job?.state === 'failed' && job.modelMissing && pair.status !== 'rejected' && (
        <div className="banner banner--action" role="alert">
          <IconDownload size={16} />
          <span className="grow">
            {/* The aligner is one model for every language, so naming a
                language here would misdescribe the download. */}
            <strong>
              {job.modelMissing.modelId === 'mms-forced-aligner'
                ? 'Alignment model needed.'
                : `${languageLabel(job.modelMissing.language)} speech model needed.`}
            </strong>{' '}
            {job.modelMissing.message.replace(/[ —-]*(download|get) it in Settings.*$/i, '')}.
            Download it and this alignment runs by itself when it lands.
          </span>
          <button
            className="btn"
            style={{ minHeight: 38 }}
            disabled={!isAdmin}
            onClick={() => onDownloadModel(job.modelMissing!.modelId, job.modelMissing!.language)}
          >
            Download
          </button>
          <Link to="/settings#speech-models" className="btn btn--ghost" style={{ minHeight: 38 }}>
            Models
          </Link>
        </div>
      )}
      {job?.state === 'failed' && !job.modelMissing && pair.status !== 'rejected' && (
        <div className="banner banner--error" role="alert">
          <IconAlert size={15} />
          <span className="grow">Alignment failed: {job.error}</span>
          {isAdmin && (
            <button
              className="btn btn--ghost"
              style={{ minHeight: 36 }}
              onClick={() => onAction(pair.id, 'align')}
            >
              Retry
            </button>
          )}
        </div>
      )}

      {pair.alignment ? (
        <div className="align-summary">
          <div className="align-summary__row">
            <strong>Aligned</strong>
            <span>{formatPct(pair.alignment.exactSentenceCoverage)} sentence-exact</span>
            <span>coverage {formatPct(pair.alignment.coverage)}</span>
            <span>confidence {formatPct(pair.alignment.meanConfidence)}</span>
            <span>{pair.alignment.segmentCount} sentences</span>
            <span className="soft">
              {pair.alignment.model} · {languageLabel(pair.alignment.language)}
            </span>
            {pair.alignment.gaps.length > 0 && (
              <span className="soft">
                {pair.alignment.gaps.length} gap{pair.alignment.gaps.length > 1 ? 's' : ''} (e.g.{' '}
                {pair.alignment.gaps[0]!.reason} {formatDuration(pair.alignment.gaps[0]!.fromMs)}–
                {formatDuration(pair.alignment.gaps[0]!.toMs)})
              </span>
            )}
          </div>
          <CoverageStrip pair={pair} />
        </div>
      ) : (
        pair.status !== 'rejected' &&
        !running &&
        !job?.modelMissing && (
          <div style={{ fontSize: 13.5, color: 'var(--rp-text-soft)' }}>{UNALIGNED_PAIR_NOTE}</div>
        )
      )}

      <div className="pair-actions">
        {pair.status === 'candidate' && (
          <>
            <button
              className="btn"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'confirm')}
            >
              <IconCheck size={16} /> Link editions
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'reject')}
            >
              <IconClose size={16} /> Not a match
            </button>
          </>
        )}
        {(pair.status === 'auto' || pair.status === 'confirmed') && (
          <>
            {!running && (
              <button
                className="btn btn--secondary"
                disabled={busy || !isAdmin}
                onClick={() => onAction(pair.id, 'align')}
              >
                {pair.alignment ? 'Re-run alignment' : 'Run alignment'}
              </button>
            )}
            <button
              className="btn btn--danger"
              disabled={busy || !isAdmin}
              onClick={() => onAction(pair.id, 'unlink')}
            >
              Unlink
            </button>
          </>
        )}
        {pair.status === 'rejected' && (
          <button
            className="btn btn--secondary"
            disabled={busy || !isAdmin}
            onClick={() => onAction(pair.id, 'confirm')}
          >
            Link anyway
          </button>
        )}
      </div>
    </article>
  );
}

/**
 * Manual arbitrary pairing: pick any ebook and any audiobook and link them.
 * Complements automatic suggestions for titles whose metadata never matches.
 */
function ManualLinkSheet({ onClose, onLinked }: { onClose: () => void; onLinked: () => void }) {
  const [books, setBooks] = useState<BookSummary[] | null>(null);
  const [ebookId, setEbookId] = useState('');
  const [audioId, setAudioId] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ books: BookSummary[] }>('/api/library')
      .then((r) => {
        if (alive) setBooks(r.books);
      })
      .catch(() => {
        if (alive) setError('Could not load the library.');
      });
    return () => {
      alive = false;
    };
  }, []);

  const ebooks = (books ?? []).filter((b) => b.kind === 'ebook');
  const audios = (books ?? []).filter((b) => b.kind === 'audio');

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api('/api/pairs/link', { method: 'POST', body: { ebookId, audioId } });
      onLinked();
    } catch {
      setError('Linking failed.');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Sheet title="Link two books manually" onClose={onClose}>
      <p style={{ color: 'var(--rp-text-soft)', fontSize: 13.5, marginBlockStart: 0 }}>
        {MANUAL_LINK_NOTE}
      </p>
      {error && (
        <div className="banner banner--error" role="alert">
          {error}
        </div>
      )}
      <div className="field">
        <label htmlFor="ml-ebook">Ebook</label>
        <select
          id="ml-ebook"
          className="input"
          value={ebookId}
          onChange={(e) => setEbookId(e.target.value)}
        >
          <option value="">Choose an ebook…</option>
          {ebooks.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? ` — ${b.author}` : ''}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="ml-audio">Audiobook</label>
        <select
          id="ml-audio"
          className="input"
          value={audioId}
          onChange={(e) => setAudioId(e.target.value)}
        >
          <option value="">Choose an audiobook…</option>
          {audios.map((b) => (
            <option key={b.id} value={b.id}>
              {b.title}
              {b.author ? ` — ${b.author}` : ''}
            </option>
          ))}
        </select>
      </div>
      <button className="btn" disabled={busy || !ebookId || !audioId} onClick={() => void submit()}>
        <IconLink size={16} /> Link editions
      </button>
    </Sheet>
  );
}

function CoverageStrip({ pair }: { pair: PairDto }) {
  const [bars, setBars] = useState<{ minute: number; confidence: number }[] | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ confidenceByMinute: { minute: number; confidence: number }[] }>(
      `/api/pairs/${pair.id}/alignment`,
    )
      .then((r) => {
        if (alive) setBars(r.confidenceByMinute);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [pair.id]);
  if (!bars || bars.length === 0) return null;
  const avg = bars.reduce((a, b) => a + b.confidence, 0) / bars.length;
  return (
    <div
      className="coverage-strip"
      role="img"
      aria-label={`Alignment confidence per minute across ${bars.length} minutes, average ${formatPct(avg)}`}
    >
      {bars.map((b) => (
        <span
          key={b.minute}
          style={{
            height: `${Math.max(12, b.confidence * 100)}%`,
            opacity: 0.35 + b.confidence * 0.65,
          }}
          title={`Minute ${b.minute}: ${formatPct(b.confidence)}`}
        />
      ))}
    </div>
  );
}

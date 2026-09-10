import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { type BookSummary, type PairDto } from '../lib/types';
import { EmptyState, Sheet, useToast } from '../components/ui';
import {
  IconAlert,
  IconBookOpen,
  IconCheck,
  IconClose,
  IconHeadphones,
  IconLink,
} from '../components/icons';
import { formatDuration, formatPct } from '../lib/format';
import { MANUAL_LINK_NOTE, UNALIGNED_PAIR_NOTE } from '../lib/pairLabel';

export function PairsPage() {
  const [pairs, setPairs] = useState<PairDto[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const res = await api<{ pairs: PairDto[] }>('/api/pairs');
      setPairs(res.pairs);
      setError(null);
    } catch {
      setError('Could not load pairing data.');
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const act = async (pairId: string, action: 'confirm' | 'reject' | 'unlink' | 'align') => {
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

  return (
    <main className="app-main">
      <h1 className="section-title" style={{ marginBlockStart: 0 }}>
        Pairing review
      </h1>
      <p style={{ color: 'var(--vx-text-soft)', maxWidth: '62ch', marginBlockStart: 0 }}>
        Versovox links ebook and audiobook editions of the same work. Metadata alone never links
        anything automatically: strong matches are verified against the actual narration content
        first, uncertain matches wait for your decision, and switching precision is always shown per
        pair — never claimed globally.
      </p>
      <div style={{ marginBlockEnd: 16 }}>
        <button className="btn btn--secondary" onClick={() => setLinkOpen(true)}>
          <IconLink size={16} /> Link two books manually
        </button>
      </div>
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
          <div className="skeleton" style={{ height: 160, marginBlockEnd: 16 }} />
          <div className="skeleton" style={{ height: 160 }} />
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
              <h2 className="section-title">Needs review ({candidates.length})</h2>
              {candidates.map((p) => (
                <PairCard key={p.id} pair={p} busy={busyId === p.id} onAction={act} />
              ))}
            </section>
          )}
          {linked.length > 0 && (
            <section aria-label="Linked pairs">
              <h2 className="section-title">Linked ({linked.length})</h2>
              {linked.map((p) => (
                <PairCard key={p.id} pair={p} busy={busyId === p.id} onAction={act} />
              ))}
            </section>
          )}
          {rejected.length > 0 && (
            <section aria-label="Dismissed pairs">
              <h2 className="section-title">Dismissed ({rejected.length})</h2>
              {rejected.map((p) => (
                <PairCard key={p.id} pair={p} busy={busyId === p.id} onAction={act} />
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}

function ScoreCell({ label, value }: { label: string; value: string }) {
  return (
    <div className="evidence-cell">
      {label}
      <b>{value}</b>
    </div>
  );
}

function PairCard({
  pair,
  busy,
  onAction,
}: {
  pair: PairDto;
  busy: boolean;
  onAction: (id: string, a: 'confirm' | 'reject' | 'unlink' | 'align') => void;
}) {
  const e = pair.evidence;
  // Evidence notes are written while the pair is still a candidate; the
  // "awaits content verification / confirm manually" wording becomes false
  // once the pair is linked (auto status only ever follows a passing content
  // probe), so swap or drop it here while candidates keep the warning.
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
  return (
    <article className="pair-card">
      <div className="pair-card__titles">
        <span className="pair-card__work">{pair.ebook?.title ?? 'Unknown ebook'}</span>
        <IconLink size={16} style={{ color: 'var(--vx-text-soft)' }} />
        <span className="pair-card__work">{pair.audio?.title ?? 'Unknown audiobook'}</span>
        <span
          className={`badge ${pair.status !== 'candidate' && pair.status !== 'rejected' ? 'badge--paired' : ''}`}
        >
          {statusLabel}
        </span>
        {pair.handoff?.available && (
          <span className="badge badge--paired">
            Switch ready · {formatPct(pair.handoff.exactSentenceCoverage)} sentence-exact
          </span>
        )}
      </div>
      <div
        style={{
          display: 'flex',
          gap: 16,
          fontSize: 13.5,
          color: 'var(--vx-text-soft)',
          flexWrap: 'wrap',
        }}
      >
        <span>
          <IconBookOpen size={13} /> {pair.ebook?.author ?? '—'}
        </span>
        <span>
          <IconHeadphones size={13} /> {pair.audio?.author ?? '—'}
          {pair.audio?.durationMs ? ` · ${formatDuration(pair.audio.durationMs)}` : ''}
        </span>
        <span>Match score {formatPct(pair.score)}</span>
      </div>

      <div className="evidence-grid">
        {e.titleScore !== undefined && (
          <ScoreCell label="Title similarity" value={formatPct(e.titleScore)} />
        )}
        {e.authorScore !== undefined && (
          <ScoreCell label="Author similarity" value={formatPct(e.authorScore)} />
        )}
        <ScoreCell label="Identifiers" value={e.identifierMatch ? 'Match' : '—'} />
        <ScoreCell
          label="Language"
          value={
            e.languageMatch === null || e.languageMatch === undefined
              ? 'Unknown'
              : e.languageMatch
                ? 'Match'
                : 'Mismatch'
          }
        />
        {e.durationPagesRatio != null && (
          <ScoreCell label="Length ratio" value={`${e.durationPagesRatio.toFixed(2)}×`} />
        )}
        {e.contentScore != null && (
          <ScoreCell label="Content overlap" value={formatPct(e.contentScore)} />
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

      {pair.alignment ? (
        <div style={{ fontSize: 13.5 }}>
          <strong>Alignment</strong> · v{pair.alignment.version} ({pair.alignment.model}) ·{' '}
          {formatPct(pair.alignment.exactSentenceCoverage)} sentence-exact · coverage{' '}
          {formatPct(pair.alignment.coverage)} · confidence{' '}
          {formatPct(pair.alignment.meanConfidence)} · {pair.alignment.segmentCount} sentences (the
          remainder switches approximately or reports unavailable)
          {pair.alignment.gaps.length > 0 && (
            <span style={{ color: 'var(--vx-text-soft)' }}>
              {' '}
              · {pair.alignment.gaps.length} gap{pair.alignment.gaps.length > 1 ? 's' : ''} (e.g.{' '}
              {pair.alignment.gaps[0]!.reason} {formatDuration(pair.alignment.gaps[0]!.fromMs)}–
              {formatDuration(pair.alignment.gaps[0]!.toMs)})
            </span>
          )}
          <CoverageStrip pair={pair} />
        </div>
      ) : (
        pair.status !== 'rejected' && (
          <div style={{ fontSize: 13.5, color: 'var(--vx-text-soft)' }}>{UNALIGNED_PAIR_NOTE}</div>
        )
      )}

      <div className="pair-actions">
        {pair.status === 'candidate' && (
          <>
            <button className="btn" disabled={busy} onClick={() => onAction(pair.id, 'confirm')}>
              <IconCheck size={16} /> Link editions
            </button>
            <button
              className="btn btn--secondary"
              disabled={busy}
              onClick={() => onAction(pair.id, 'reject')}
            >
              <IconClose size={16} /> Not a match
            </button>
          </>
        )}
        {(pair.status === 'auto' || pair.status === 'confirmed') && (
          <>
            {!pair.alignment && (
              <button
                className="btn btn--secondary"
                disabled={busy}
                onClick={() => onAction(pair.id, 'align')}
              >
                Run alignment
              </button>
            )}
            <button
              className="btn btn--danger"
              disabled={busy}
              onClick={() => onAction(pair.id, 'unlink')}
            >
              Unlink
            </button>
          </>
        )}
        {pair.status === 'rejected' && (
          <button
            className="btn btn--secondary"
            disabled={busy}
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
      <p style={{ color: 'var(--vx-text-soft)', fontSize: 13.5, marginBlockStart: 0 }}>
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
  return (
    <div
      className="coverage-strip"
      role="img"
      aria-label={`Alignment confidence per minute: ${bars.map((b) => Math.round(b.confidence * 100) + '%').join(', ')}`}
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

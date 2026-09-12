import {
  SWITCH_MAX_AUDIO_DRIFT_MS,
  SWITCH_MAX_REWIND_MS,
  SWITCH_MAX_SENTENCE_DISTANCE,
  SWITCH_MIN_CONFIDENCE,
  SWITCH_SENTENCE_CONFIDENCE,
  type AlignmentGap,
  type AlignmentSegment,
  type AlignmentSummary,
  type AudioLocator,
  type EbookLocator,
  type HandoffStatus,
  type Locator,
  type SwitchResolution,
} from '@readport/shared';
import { type DB, nowIso } from '../db/index.js';
import { newId } from '../util/ids.js';
import { type AlignerResult } from './timings.js';

/** Persist an aligner run as a new alignment version for the pair. */
export function storeAlignment(
  db: DB,
  pairId: string,
  language: string,
  model: string,
  result: AlignerResult,
  provenance: Record<string, unknown>,
): string {
  const prev = db
    .prepare('SELECT MAX(version) AS v FROM alignments WHERE pair_id = ?')
    .get(pairId) as { v: number | null };
  const version = (prev?.v ?? 0) + 1;
  const id = newId('align');
  db.exec('BEGIN');
  try {
    db.prepare(
      `INSERT INTO alignments (id, pair_id, version, status, language, model, coverage, mean_confidence, provenance_json, gaps_json, created_at)
       VALUES (?, ?, ?, 'ready', ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      pairId,
      version,
      language,
      model,
      result.coverage,
      result.meanConfidence,
      JSON.stringify(provenance),
      JSON.stringify(result.gaps),
      nowIso(),
    );
    const ins = db.prepare(
      `INSERT INTO alignment_segments (alignment_id, ord, sentence_id, spine_idx, sentence_ord, start_ms, end_ms, confidence, source, uncertainty_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    result.segments.forEach((s, ord) =>
      ins.run(
        id,
        ord,
        s.sentenceId,
        s.spineIdx,
        s.sentenceOrd,
        s.startMs,
        s.endMs,
        s.confidence,
        s.source,
        s.uncertaintyMs,
      ),
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return id;
}

export interface AlignmentHandle {
  alignmentId: string;
  summary: AlignmentSummary;
}

export function latestAlignment(db: DB, pairId: string): AlignmentHandle | null {
  const row = db
    .prepare(
      `SELECT * FROM alignments WHERE pair_id = ? AND status = 'ready' ORDER BY version DESC LIMIT 1`,
    )
    .get(pairId) as Record<string, unknown> | undefined;
  if (!row) return null;
  const count = db
    .prepare('SELECT COUNT(*) AS c FROM alignment_segments WHERE alignment_id = ?')
    .get(String(row.id)) as { c: number };
  const exact = db
    .prepare(
      `SELECT COUNT(*) AS c FROM alignment_segments WHERE alignment_id = ? AND source = 'exact' AND confidence >= ?`,
    )
    .get(String(row.id), SWITCH_SENTENCE_CONFIDENCE) as { c: number };
  const provenance = JSON.parse(String(row.provenance_json ?? '{}')) as {
    sentenceCount?: number;
  };
  const sentenceCount = Math.max(1, Number(provenance.sentenceCount ?? count.c));
  return {
    alignmentId: String(row.id),
    summary: {
      pairId,
      version: Number(row.version),
      language: String(row.language),
      model: String(row.model),
      coverage: Number(row.coverage),
      exactSentenceCoverage: Math.round((Number(exact.c) / sentenceCount) * 1000) / 1000,
      meanConfidence: Number(row.mean_confidence),
      segmentCount: Number(count.c),
      gaps: JSON.parse(String(row.gaps_json ?? '[]')),
      createdAt: String(row.created_at),
    },
  };
}

/** Minimum coverage before a pair offers position handoff at all. */
export const SWITCHABLE_MIN_COVERAGE = 0.5;

/** Handoff availability. This does NOT claim sentence exactness — see handoffStatus(). */
export function isSwitchable(handle: AlignmentHandle | null): boolean {
  if (!handle) return false;
  return (
    handle.summary.coverage >= SWITCHABLE_MIN_COVERAGE &&
    handle.summary.meanConfidence >= SWITCH_MIN_CONFIDENCE
  );
}

/** Honest per-pair switching status for API/UI consumption. */
export function handoffStatus(handle: AlignmentHandle | null): HandoffStatus | null {
  if (!handle) return null;
  return {
    available: isSwitchable(handle),
    exactSentenceCoverage: handle.summary.exactSentenceCoverage,
    coverage: handle.summary.coverage,
    meanConfidence: handle.summary.meanConfidence,
  };
}

function rowToSegment(row: Record<string, unknown>): AlignmentSegment {
  return {
    sentenceId: String(row.sentence_id),
    spineIdx: Number(row.spine_idx),
    sentenceOrd: Number(row.sentence_ord),
    startMs: Number(row.start_ms),
    endMs: Number(row.end_ms),
    confidence: Number(row.confidence),
    source: String(row.source) as AlignmentSegment['source'],
    uncertaintyMs: Number(row.uncertainty_ms ?? 0),
  };
}

export interface ResolveContext {
  db: DB;
  alignmentId: string;
  /** explicit alignment gaps for this version (audio time ranges). */
  gaps: AlignmentGap[];
  /** ordered track absolute start offsets + durations, for audio locators. */
  tracks: { startMsAbsolute: number; durationMs: number }[];
  /** sentence index of the ebook: per spineIdx, ordered sentences. */
  sentences: { id: string; ord: number; start: number; end: number }[][];
  /** chapter cumChars for pct math. */
  chapterCumChars: number[];
  totalChars: number;
}

/** An aligned point near an unresolvable position, offered instead of a silent jump. */
export interface SwitchAnchor {
  sentenceId: string;
  confidence: number;
  to: Locator;
}

export interface SwitchOutcome {
  to: Locator | null;
  resolution: SwitchResolution;
  /** Nearest verified aligned points before/after, when `to` is null or approximate. */
  anchors?: { before?: SwitchAnchor; after?: SwitchAnchor };
}

function segToEbookLocator(ctx: ResolveContext, seg: AlignmentSegment): EbookLocator {
  const chapter = ctx.sentences[seg.spineIdx] ?? [];
  const sentence = chapter.find((s) => s.id === seg.sentenceId) ?? chapter[seg.sentenceOrd] ?? null;
  const charOffset = sentence ? sentence.start : 0;
  const cum = ctx.chapterCumChars[seg.spineIdx] ?? 0;
  const pct = ctx.totalChars > 0 ? Math.min(1, (cum + charOffset) / ctx.totalChars) : 0;
  return {
    medium: 'ebook',
    spineIdx: seg.spineIdx,
    sentenceId: seg.sentenceId,
    charOffset,
    pct: Math.round(pct * 10000) / 10000,
  };
}

function audioAnchor(ctx: ResolveContext, seg: AlignmentSegment): SwitchAnchor {
  return {
    sentenceId: seg.sentenceId,
    confidence: seg.confidence,
    // Offered as somewhere to jump to, so it gets the same backward margin a
    // direct switch would.
    to: bookMsToAudioLocator(ctx, safeStartMs(seg.startMs, seg)),
  };
}

function ebookAnchor(ctx: ResolveContext, seg: AlignmentSegment): SwitchAnchor {
  return {
    sentenceId: seg.sentenceId,
    confidence: seg.confidence,
    to: segToEbookLocator(ctx, seg),
  };
}

function segBefore(
  ctx: ResolveContext,
  spineIdx: number,
  sentenceOrd: number,
): AlignmentSegment | null {
  const row = ctx.db
    .prepare(
      `SELECT * FROM alignment_segments WHERE alignment_id = ?
         AND (spine_idx < ? OR (spine_idx = ? AND sentence_ord <= ?))
       ORDER BY spine_idx DESC, sentence_ord DESC LIMIT 1`,
    )
    .get(ctx.alignmentId, spineIdx, spineIdx, sentenceOrd) as Record<string, unknown> | undefined;
  return row ? rowToSegment(row) : null;
}

function segAfter(
  ctx: ResolveContext,
  spineIdx: number,
  sentenceOrd: number,
): AlignmentSegment | null {
  const row = ctx.db
    .prepare(
      `SELECT * FROM alignment_segments WHERE alignment_id = ?
         AND (spine_idx > ? OR (spine_idx = ? AND sentence_ord >= ?))
       ORDER BY spine_idx, sentence_ord LIMIT 1`,
    )
    .get(ctx.alignmentId, spineIdx, spineIdx, sentenceOrd) as Record<string, unknown> | undefined;
  return row ? rowToSegment(row) : null;
}

/**
 * Step a read-to-listen switch back by the segment's own admitted error.
 *
 * Landing early is a second of narration the reader already knows. Landing
 * late is a spoiler — a sentence, a plot turn, a punchline they had not
 * reached — and no amount of precision elsewhere makes up for it. So the
 * asymmetry is deliberate: the switch always aims behind the reader by however
 * far the aligner says it might be wrong, and never further than
 * {@link SWITCH_MAX_REWIND_MS}, past which it is not a margin but a different
 * scene.
 */
function safeStartMs(bookMs: number, seg: AlignmentSegment): number {
  const rewind = Math.min(Math.max(0, seg.uncertaintyMs), SWITCH_MAX_REWIND_MS);
  return Math.max(0, bookMs - rewind);
}

export function resolveEbookToAudio(ctx: ResolveContext, from: EbookLocator): SwitchOutcome {
  let seg: AlignmentSegment | null = null;
  if (from.sentenceId) {
    const row = ctx.db
      .prepare(
        'SELECT * FROM alignment_segments WHERE alignment_id = ? AND sentence_id = ? LIMIT 1',
      )
      .get(ctx.alignmentId, from.sentenceId) as Record<string, unknown> | undefined;
    if (row) seg = rowToSegment(row);
  }
  // Locate the sentence ord from charOffset for fallback/anchor queries.
  const chapter = ctx.sentences[from.spineIdx] ?? [];
  const offset = from.charOffset ?? 0;
  let sentenceOrd = 0;
  for (const s of chapter) {
    if (s.start <= offset) sentenceOrd = s.ord;
    else break;
  }
  let approximate = false;
  if (!seg) {
    // Nearest aligned sentence at or before this one in the same chapter,
    // but only within a bounded distance: an explicit alignment hole (an
    // omitted passage, a narration-only region) must never silently map to
    // an unrelated earlier sentence.
    const before = segBefore(ctx, from.spineIdx, sentenceOrd);
    const after = segAfter(ctx, from.spineIdx, sentenceOrd + 1);
    const withinBound =
      before !== null &&
      before.spineIdx === from.spineIdx &&
      sentenceOrd - before.sentenceOrd <= SWITCH_MAX_SENTENCE_DISTANCE;
    if (!withinBound) {
      return {
        to: null,
        resolution: {
          granularity: 'none',
          confidence: 0,
          reason:
            'This passage has no verified audio alignment (it may be absent from the narration). Choose a nearby aligned point instead.',
        },
        anchors: {
          before: before ? audioAnchor(ctx, before) : undefined,
          after: after ? audioAnchor(ctx, after) : undefined,
        },
      };
    }
    seg = before;
    approximate = true;
  }
  if (seg.confidence < SWITCH_MIN_CONFIDENCE) {
    const before = segBefore(ctx, from.spineIdx, sentenceOrd);
    const after = segAfter(ctx, from.spineIdx, sentenceOrd + 1);
    return {
      to: null,
      resolution: {
        granularity: 'none',
        confidence: seg.confidence,
        source: seg.source,
        reason: 'Alignment confidence is too low here to switch precisely.',
      },
      anchors: {
        before:
          before && before.confidence >= SWITCH_MIN_CONFIDENCE
            ? audioAnchor(ctx, before)
            : undefined,
        after:
          after && after.confidence >= SWITCH_MIN_CONFIDENCE ? audioAnchor(ctx, after) : undefined,
      },
    };
  }
  const exactSentence =
    !approximate &&
    seg.sentenceId === from.sentenceId &&
    seg.confidence >= SWITCH_SENTENCE_CONFIDENCE &&
    seg.source === 'exact';
  // Within-sentence interpolation only when confidence is high.
  const ratio = exactSentence ? (from.sentenceRatio ?? 0) : 0;
  const bookMs = Math.round(seg.startMs + ratio * Math.max(0, seg.endMs - seg.startMs));
  const safeMs = safeStartMs(bookMs, seg);
  const audio = bookMsToAudioLocator(ctx, safeMs);
  return {
    to: audio,
    resolution: {
      granularity: exactSentence ? 'sentence' : 'paragraph',
      confidence: seg.confidence,
      source: seg.source,
      approximate: approximate || !exactSentence,
      ...(bookMs > safeMs ? { rewindMs: bookMs - safeMs } : {}),
    },
  };
}

export function resolveAudioToEbook(ctx: ResolveContext, from: AudioLocator): SwitchOutcome {
  const bookMs = from.bookMs ?? (ctx.tracks[from.trackIdx]?.startMsAbsolute ?? 0) + from.positionMs;

  const noAlignment: SwitchOutcome = {
    to: null,
    resolution: {
      granularity: 'none',
      confidence: 0,
      reason: 'No alignment data for this pair.',
    },
  };

  const beforeRow = ctx.db
    .prepare(
      `SELECT * FROM alignment_segments WHERE alignment_id = ? AND start_ms <= ?
       ORDER BY start_ms DESC LIMIT 1`,
    )
    .get(ctx.alignmentId, bookMs) as Record<string, unknown> | undefined;
  const afterRow = ctx.db
    .prepare(
      `SELECT * FROM alignment_segments WHERE alignment_id = ? AND start_ms > ?
       ORDER BY start_ms LIMIT 1`,
    )
    .get(ctx.alignmentId, bookMs) as Record<string, unknown> | undefined;
  const before = beforeRow ? rowToSegment(beforeRow) : null;
  const after = afterRow ? rowToSegment(afterRow) : null;
  if (!before && !after) return noAlignment;

  const anchors = {
    before: before ? ebookAnchor(ctx, before) : undefined,
    after: after ? ebookAnchor(ctx, after) : undefined,
  };
  const unavailable = (reason: string): SwitchOutcome => ({
    to: null,
    resolution: { granularity: 'none', confidence: 0, reason },
    anchors,
  });

  // Inside an explicit alignment gap: never snap to an unrelated sentence.
  const gap = ctx.gaps.find((g) => bookMs > g.fromMs && bookMs < g.toMs);
  if (gap) {
    return unavailable(
      gap.reason === 'narration-only'
        ? 'This part of the narration has no matching text (introduction, credits, or an addition in this edition).'
        : 'This region is not aligned with the text. Choose a nearby aligned point instead.',
    );
  }
  if (!before) {
    // Position precedes the first aligned segment.
    if (after && after.startMs - bookMs <= SWITCH_MAX_AUDIO_DRIFT_MS) {
      return {
        to: segToEbookLocator(ctx, after),
        resolution: {
          granularity: 'paragraph',
          confidence: after.confidence,
          source: after.source,
          approximate: true,
        },
        anchors,
      };
    }
    return unavailable('The narration has not reached aligned text yet at this position.');
  }
  // Past the end of the nearest preceding segment by more than the allowed
  // drift: this is an unverified region even if no explicit gap was stored.
  if (bookMs > before.endMs + SWITCH_MAX_AUDIO_DRIFT_MS) {
    return unavailable(
      'This position lies between verified alignments. Choose a nearby aligned point instead.',
    );
  }
  if (before.confidence < SWITCH_MIN_CONFIDENCE) {
    return unavailable('Alignment confidence is too low here to switch precisely.');
  }
  const insideSegment = bookMs >= before.startMs && bookMs <= before.endMs;
  // 'sentence' granularity is claimed ONLY for exact-provenance segments:
  // a fuzzy/interpolated/anchor segment is an approximation regardless of
  // its confidence score, and must be reported as such.
  const exact =
    insideSegment && before.confidence >= SWITCH_SENTENCE_CONFIDENCE && before.source === 'exact';
  return {
    to: segToEbookLocator(ctx, before),
    resolution: {
      granularity: exact ? 'sentence' : 'paragraph',
      confidence: before.confidence,
      source: before.source,
      approximate: !exact,
    },
  };
}

export function bookMsToAudioLocator(ctx: ResolveContext, bookMs: number): AudioLocator {
  let trackIdx = 0;
  for (let i = 0; i < ctx.tracks.length; i++) {
    const t = ctx.tracks[i]!;
    if (bookMs >= t.startMsAbsolute) trackIdx = i;
    else break;
  }
  const t = ctx.tracks[trackIdx]!;
  const positionMs = Math.max(0, Math.min(bookMs - t.startMsAbsolute, t.durationMs));
  const total = ctx.tracks.reduce((a, x) => a + x.durationMs, 0);
  return {
    medium: 'audio',
    trackIdx,
    positionMs,
    bookMs,
    pct: total > 0 ? Math.round((bookMs / total) * 10000) / 10000 : 0,
  };
}

export function resolveSwitch(ctx: ResolveContext, from: Locator): SwitchOutcome {
  if (from.medium === 'ebook') return resolveEbookToAudio(ctx, from);
  return resolveAudioToEbook(ctx, from);
}

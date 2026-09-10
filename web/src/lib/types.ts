import {
  type Annotation,
  type BookSummary,
  type ChapterInfo,
  type SwitchResolution,
  type TrackInfo,
  type Locator,
} from '@versovox/shared';

export interface BookDetail {
  book: BookSummary;
  description: string | null;
  direction: 'ltr' | 'rtl';
  totalChars: number | null;
  chapters: ChapterInfo[];
  tracks: TrackInfo[];
}

export interface ReaderManifest {
  bookId: string;
  title: string;
  author: string | null;
  language: string | null;
  direction: 'ltr' | 'rtl';
  /** False when the OPF declared no page-progression-direction (older indexes omit it). */
  directionDeclared?: boolean;
  totalChars: number;
  chapters: {
    idx: number;
    href: string;
    title: string | null;
    charCount: number;
    sentenceCount: number;
    cumChars: number;
  }[];
  toc: { title: string; spineIdx: number; fragment: string | null; depth: number }[];
}

export interface SentenceIndexEntry {
  id: string;
  ord: number;
  start: number;
  end: number;
}

export interface PairDto {
  id: string;
  status: 'candidate' | 'auto' | 'confirmed' | 'rejected';
  score: number;
  evidence: {
    titleScore?: number;
    authorScore?: number;
    identifierMatch?: boolean;
    languageMatch?: boolean | null;
    seriesMatch?: boolean | null;
    durationPagesRatio?: number | null;
    contentScore?: number | null;
    notes?: string[];
  };
  compat: {
    contentScore?: number;
    coverage?: number;
    meanConfidence?: number;
    warning?: string | null;
  } | null;
  createdAt: string;
  decidedAt: string | null;
  ebook: { id: string; title: string; author: string | null } | null;
  audio: { id: string; title: string; author: string | null; durationMs: number | null } | null;
  alignment: {
    coverage: number;
    exactSentenceCoverage: number;
    meanConfidence: number;
    segmentCount: number;
    version: number;
    model: string;
    language: string;
    gaps: { fromMs: number; toMs: number; reason: string }[];
    createdAt: string;
  } | null;
  language: {
    override: string | null;
    detected: string | null;
    effective: string | null;
    source: 'override' | 'alignment' | 'ebook-metadata' | 'audio-tags' | 'unknown';
  };
  lastAlignJob: {
    state: 'queued' | 'running' | 'done' | 'failed' | 'cancelled';
    progress: number;
    detail: string | null;
    error: string | null;
    modelMissing: { language: string; modelId: string; message: string } | null;
    createdAt: string;
  } | null;
  /** Handoff availability; NOT a claim of sentence exactness (see handoff). */
  switchable: boolean;
  handoff: {
    available: boolean;
    exactSentenceCoverage: number;
    coverage: number;
    meanConfidence: number;
  } | null;
}

/** Outstanding transcription work, with an estimate measured on this server. */
export interface ProcessingSummary {
  pendingPairs: number;
  pendingAudioMs: number;
  candidatePairs: number;
  /** Seconds of audio per second of wall clock; 0 until measured. */
  speedRatio: number;
  estimatedMs: number | null;
  processingMode: 'auto' | 'verify' | 'manual';
}

export interface SwitchAnchorDto {
  sentenceId: string;
  confidence: number;
  to: Locator;
}

export interface ResolveResponse {
  to: Locator | null;
  resolution: SwitchResolution;
  /** Nearest verified aligned points when `to` is null or approximate. */
  anchors?: { before?: SwitchAnchorDto; after?: SwitchAnchorDto };
}

export type { Annotation, BookSummary, Locator };

export interface ModelInfo {
  id: string;
  label: string;
  family: 'openai' | 'ivrit-ai';
  languages: string[] | '*';
  file: string;
  sizeBytes: number;
  note: string;
  cost: number;
  installed: boolean;
  installedBytes: number;
  download: { state: string; progress: number; detail: string | null } | null;
  lastError: string | null;
}

export interface ModelsResponse {
  modelsDir: string;
  whisperAvailable: boolean;
  models: ModelInfo[];
  languages: { code: string; label: string; native: string; models: string[] }[];
}

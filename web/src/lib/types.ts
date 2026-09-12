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

/** Outstanding alignment work, with an estimate measured on this server. */
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
  family: 'openai' | 'ivrit-ai' | 'meta';
  /**
   * Which runtime consumes it: `ctc-onnx` is the forced aligner (one model,
   * every language), `whisper-ggml` is speech recognition. Optional because a
   * server from before forced alignment only ever shipped whisper models.
   */
  kind?: 'whisper-ggml' | 'ctc-onnx';
  /**
   * What the model is FOR (server: ModelSpec.purpose). Since forced alignment
   * became the default engine only the `aligner` is required, so the settings
   * page groups by this rather than by language. Optional: a server from
   * before 0.7.0 sends no purpose at all.
   */
  purpose?: 'aligner' | 'language-id' | 'transcription';
  /** Present when the licence is not permissive; shown BEFORE the download button. */
  licence?: string;
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

/** Result of the server's non-throwing runtime probe (checkCtcEngine). */
export interface EngineStatus {
  available: boolean;
  error?: string | null;
}

export interface ModelsResponse {
  modelsDir: string;
  whisperAvailable: boolean;
  /** Whether onnxruntime-node loaded, i.e. whether forced alignment can run at all. */
  alignerRuntime?: EngineStatus;
  models: ModelInfo[];
  languages: { code: string; label: string; native: string; models: string[] }[];
}

/** Catalog id of the alignment model (server: ALIGNER_MODEL_ID). */
export const ALIGNER_MODEL_ID = 'alignment-model';

export function alignerModel(models: ModelsResponse | null): ModelInfo | null {
  // By id, then by being the only entry: a server one version behind still
  // calls it something else, and the page has to show its model either way.
  return (
    models?.models.find((m) => m.id === ALIGNER_MODEL_ID) ?? models?.models[0] ?? null
  );
}

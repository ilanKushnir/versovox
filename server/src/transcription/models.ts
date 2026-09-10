import fs from 'node:fs';
import path from 'node:path';

/**
 * Speech-model catalog for the bundled whisper.cpp runtime.
 *
 * "Best" here is measured, not marketed: as of 2026 the strongest general
 * whisper.cpp models are still OpenAI's `large-v3` (accuracy) and
 * `large-v3-turbo` (≈4–6× faster for 1–2 WER points); language-specific
 * fine-tunes beat both on their language — Hebrew via ivrit.ai. Every entry
 * is a ggml file downloadable straight from Hugging Face into VX_MODELS_DIR;
 * nothing is bundled in the image and nothing ever leaves the server.
 */

export interface ModelSpec {
  id: string;
  label: string;
  /** Provider / fine-tune family shown in the UI. */
  family: 'openai' | 'ivrit-ai';
  /** BCP-47 base codes this model is meant for; '*' = multilingual. */
  languages: string[] | '*';
  url: string;
  /** Filename inside VX_MODELS_DIR. */
  file: string;
  sizeBytes: number;
  /** One line for the settings card. */
  note: string;
  /** Relative CPU cost, 1 = large-v3-turbo. */
  cost: number;
}

export const MODELS: ModelSpec[] = [
  {
    id: 'large-v3-turbo',
    label: 'Whisper large-v3-turbo',
    family: 'openai',
    languages: '*',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo.bin',
    file: 'ggml-large-v3-turbo.bin',
    sizeBytes: 1_624_555_275,
    note: 'Best general model for the CPU: large-v3 accuracy within 1–2 points at ~5× the speed.',
    cost: 1,
  },
  {
    id: 'large-v3',
    label: 'Whisper large-v3',
    family: 'openai',
    languages: '*',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3.bin',
    file: 'ggml-large-v3.bin',
    sizeBytes: 3_095_033_483,
    note: 'Most accurate general model; several times slower than turbo. Pick it for difficult narration.',
    cost: 5,
  },
  {
    id: 'small',
    label: 'Whisper small',
    family: 'openai',
    languages: '*',
    url: 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
    file: 'ggml-small.bin',
    sizeBytes: 487_601_967,
    note: 'Fast preview quality; fine for clean English narration, weak on other languages.',
    cost: 0.3,
  },
  {
    id: 'ivrit-large-v3-turbo',
    label: 'ivrit.ai Whisper large-v3-turbo (Hebrew)',
    family: 'ivrit-ai',
    languages: ['he'],
    url: 'https://huggingface.co/ivrit-ai/whisper-large-v3-turbo-ggml/resolve/main/ggml-model.bin',
    file: 'ggml-ivrit-large-v3-turbo.bin',
    sizeBytes: 1_624_555_275,
    note: 'Hebrew fine-tune trained on ~390 h of transcribed Hebrew speech — far better than stock Whisper for Hebrew.',
    cost: 1,
  },
  {
    id: 'ivrit-large-v3',
    label: 'ivrit.ai Whisper large-v3 (Hebrew)',
    family: 'ivrit-ai',
    languages: ['he'],
    url: 'https://huggingface.co/ivrit-ai/whisper-large-v3-ggml/resolve/main/ggml-model.bin',
    file: 'ggml-ivrit-large-v3.bin',
    sizeBytes: 3_095_033_483,
    note: 'Hebrew fine-tune of the full large-v3: most accurate Hebrew option, several times slower.',
    cost: 5,
  },
];

import { LANGUAGES, type LanguageSpec } from '@versovox/shared';
export { LANGUAGES, type LanguageSpec };

export function modelById(id: string): ModelSpec | undefined {
  return MODELS.find((m) => m.id === id);
}

export function languageByCode(code: string | null | undefined): LanguageSpec | undefined {
  if (!code) return undefined;
  const base = code.toLowerCase().split(/[-_]/)[0]!;
  return LANGUAGES.find((l) => l.code === base);
}

export function modelPath(modelsDir: string, spec: ModelSpec): string {
  return path.join(modelsDir, spec.file);
}

export function isInstalled(modelsDir: string, spec: ModelSpec): boolean {
  try {
    const st = fs.statSync(modelPath(modelsDir, spec));
    // A model file is an all-or-nothing artifact: anything below ~90% of the
    // published size is a truncated download, never a usable model.
    return st.isFile() && st.size >= spec.sizeBytes * 0.9;
  } catch {
    return false;
  }
}

export class ModelMissingError extends Error {
  readonly code = 'model-missing';
  constructor(
    readonly language: string,
    readonly modelId: string,
  ) {
    const lang = languageByCode(language);
    const model = modelById(modelId);
    super(
      `model-missing:${language}:${modelId}|The ${lang?.label ?? language} speech model (${
        model?.label ?? modelId
      }) is not installed — download it in Settings → Speech models.`,
    );
    this.name = 'ModelMissingError';
  }
}

/**
 * Pick the model for a language: an explicit per-language preference
 * (settings.languageModels), else the language's preference list, else the
 * multilingual default. Returns the FIRST INSTALLED candidate; if none is
 * installed, throws ModelMissingError naming the recommended one.
 */
export function resolveModelForLanguage(
  modelsDir: string,
  language: string,
  preferred: Record<string, string> = {},
): { spec: ModelSpec; path: string } {
  const lang = languageByCode(language);
  const candidates: string[] = [];
  const pref = preferred[lang?.code ?? language.toLowerCase().split(/[-_]/)[0]!];
  if (pref) candidates.push(pref);
  if (lang) candidates.push(...lang.models);
  candidates.push('large-v3-turbo', 'large-v3');
  const seen = new Set<string>();
  for (const id of candidates) {
    if (seen.has(id)) continue;
    seen.add(id);
    const spec = modelById(id);
    if (spec && isInstalled(modelsDir, spec)) return { spec, path: modelPath(modelsDir, spec) };
  }
  throw new ModelMissingError(lang?.code ?? language, candidates[0]!);
}

/** Any installed multilingual model (for language detection). */
export function anyMultilingualModel(modelsDir: string): { spec: ModelSpec; path: string } | null {
  for (const id of ['large-v3-turbo', 'large-v3', 'small']) {
    const spec = modelById(id)!;
    if (isInstalled(modelsDir, spec)) return { spec, path: modelPath(modelsDir, spec) };
  }
  return null;
}

/** Parse the structured prefix of a ModelMissingError message, if any. */
export function parseModelMissing(
  error: string | null | undefined,
): { language: string; modelId: string; message: string } | null {
  if (!error) return null;
  const m = /^model-missing:([a-z-]+):([a-z0-9.-]+)\|(.*)$/i.exec(error);
  return m ? { language: m[1]!, modelId: m[2]!, message: m[3]! } : null;
}

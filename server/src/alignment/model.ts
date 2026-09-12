import fs from 'node:fs';
import path from 'node:path';
import { LANGUAGES, type LanguageSpec } from '@readport/shared';

export { LANGUAGES, type LanguageSpec };

/**
 * The alignment model: what it is, where it comes from, and whether it is here.
 *
 * There is exactly one, and it covers every language. It works on a romanized
 * character stream rather than on words, so the same 317 MB file times a
 * Russian audiobook as happily as an English one, and unvocalized Hebrew costs
 * it nothing extra.
 */

/** One downloadable artefact. The model is a graph plus its vocabulary. */
export interface ModelFile {
  /** Path inside RP_MODELS_DIR; may contain a subdirectory. */
  name: string;
  url: string;
  sizeBytes: number;
}

export interface ModelSpec {
  id: string;
  label: string;
  licence: string;
  url: string;
  file: string;
  sizeBytes: number;
  extraFiles: ModelFile[];
  note: string;
}

const MMS_BASE =
  'https://huggingface.co/onnx-community/mms-300m-1130-forced-aligner-ONNX/resolve/main';

export const ALIGNER_MODEL_ID = 'alignment-model';

export const ALIGNER: ModelSpec = {
  id: ALIGNER_MODEL_ID,
  label: 'Alignment model',
  licence: 'CC-BY-NC-4.0 (non-commercial)',
  url: `${MMS_BASE}/onnx/model_int8.onnx`,
  file: 'mms-fa/model_int8.onnx',
  sizeBytes: 317_341_664,
  extraFiles: [
    { name: 'mms-fa/vocab.json', url: `${MMS_BASE}/vocab.json`, sizeBytes: 351 },
    { name: 'mms-fa/config.json', url: `${MMS_BASE}/config.json`, sizeBytes: 2_141 },
  ],
  note: 'One download, every language. Nothing is uploaded and nothing else is needed.',
};

/** The catalog, as a list, because the download machinery wants one. */
export const MODELS: ModelSpec[] = [ALIGNER];

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

/** Every artefact this model needs, primary first. */
export function modelFiles(spec: ModelSpec): ModelFile[] {
  return [{ name: spec.file, url: spec.url, sizeBytes: spec.sizeBytes }, ...spec.extraFiles];
}

export function isInstalled(modelsDir: string, spec: ModelSpec): boolean {
  // All or nothing: every file present and no smaller than ~90% of its
  // published size, or the download was truncated.
  return modelFiles(spec).every((f) => {
    try {
      const st = fs.statSync(path.join(modelsDir, f.name));
      return st.isFile() && st.size >= f.sizeBytes * 0.9;
    } catch {
      return false;
    }
  });
}

/** Resolve the model's files, or null when it has not been downloaded yet. */
export function resolveAligner(
  modelsDir: string,
): { spec: ModelSpec; modelPath: string; vocabPath: string } | null {
  if (!isInstalled(modelsDir, ALIGNER)) return null;
  return {
    spec: ALIGNER,
    modelPath: path.join(modelsDir, ALIGNER.file),
    vocabPath: path.join(modelsDir, ALIGNER.extraFiles[0]!.name),
  };
}

/**
 * Thrown when a book cannot be aligned because the model is not here yet. The
 * structured prefix lets the Pairing page turn it into a download button
 * instead of a red error, and the job re-runs itself once the file lands.
 */
export class ModelMissingError extends Error {
  readonly code = 'model-missing';
  constructor(readonly modelId: string = ALIGNER_MODEL_ID) {
    super(
      `model-missing:${modelId}|The alignment model is not installed yet. ` +
        `It is one download that covers every language — get it in Settings.`,
    );
    this.name = 'ModelMissingError';
  }
}

/** Parse the structured prefix of a ModelMissingError message, if any. */
export function parseModelMissing(
  error: string | null | undefined,
): { modelId: string; message: string } | null {
  if (!error) return null;
  const m = /^model-missing:([a-z0-9.-]+)\|(.*)$/i.exec(error);
  return m ? { modelId: m[1]!, message: m[2]! } : null;
}

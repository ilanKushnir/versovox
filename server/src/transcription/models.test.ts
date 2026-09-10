import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  anyMultilingualModel,
  LANGUAGES,
  modelById,
  ModelMissingError,
  MODELS,
  parseModelMissing,
  resolveModelForLanguage,
} from './models.js';

let dir: string;
const fake = (id: string) => {
  const spec = modelById(id)!;
  // Sparse file with the published size: "installed" without 1.6 GB on disk.
  const fd = fs.openSync(path.join(dir, spec.file), 'w');
  fs.ftruncateSync(fd, spec.sizeBytes);
  fs.closeSync(fd);
};

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vx-models-'));
});
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe('speech model catalog', () => {
  it('every language preference points at a catalog model', () => {
    for (const l of LANGUAGES) {
      for (const id of l.models) expect(modelById(id), `${l.code} → ${id}`).toBeDefined();
    }
    for (const m of MODELS) expect(m.url).toMatch(/^https:\/\/huggingface\.co\//);
  });

  it('names the recommended model when nothing is installed', () => {
    expect(() => resolveModelForLanguage(dir, 'he')).toThrow(ModelMissingError);
    try {
      resolveModelForLanguage(dir, 'he-IL');
    } catch (err) {
      const parsed = parseModelMissing((err as Error).message);
      expect(parsed).toMatchObject({ language: 'he', modelId: 'ivrit-large-v3-turbo' });
      expect(parsed!.message).toContain('Hebrew');
    }
    expect(anyMultilingualModel(dir)).toBeNull();
  });

  it('prefers the language fine-tune, then falls back to installed multilingual models', () => {
    fake('large-v3-turbo');
    expect(resolveModelForLanguage(dir, 'he').spec.id).toBe('large-v3-turbo');
    expect(resolveModelForLanguage(dir, 'xx').spec.id).toBe('large-v3-turbo');
    expect(anyMultilingualModel(dir)?.spec.id).toBe('large-v3-turbo');
    fake('ivrit-large-v3-turbo');
    expect(resolveModelForLanguage(dir, 'he').spec.id).toBe('ivrit-large-v3-turbo');
    // An explicit per-language preference wins when installed …
    fake('large-v3');
    expect(resolveModelForLanguage(dir, 'he', { he: 'large-v3' }).spec.id).toBe('large-v3');
    // … and is skipped when it is not.
    expect(resolveModelForLanguage(dir, 'en', { en: 'small' }).spec.id).toBe('large-v3-turbo');
  });

  it('treats a truncated file as not installed', () => {
    const spec = modelById('small')!;
    fs.writeFileSync(path.join(dir, spec.file), Buffer.alloc(1024));
    expect(resolveModelForLanguage(dir, 'en', { en: 'small' }).spec.id).not.toBe('small');
  });
});

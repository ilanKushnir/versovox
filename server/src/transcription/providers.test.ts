import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mergeWhisperTokens, WhisperCliProvider } from './providers.js';

/**
 * Whisper output-location safety: source libraries are read-only mounts, so
 * all intermediate output must land in the TandemLeaf work dir and be
 * cleaned up afterwards. Uses a deterministic fake whisper binary.
 */

let tmp: string;
let sourceDir: string;
let workDir: string;
let fakeBin: string;

const FAKE_JSON = {
  transcription: [
    {
      offsets: { from: 0, to: 2000 },
      tokens: [
        { text: ' hello', offsets: { from: 0, to: 900 } },
        { text: ' world', offsets: { from: 1000, to: 1900 } },
      ],
    },
  ],
};

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tl-whisper-'));
  sourceDir = path.join(tmp, 'library');
  workDir = path.join(tmp, 'cache', 'whisper-work');
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, 'track0.mp3'), 'fake-audio');
  // Fake whisper-cli: writes <outprefix>.json; args: [-l lang] [-m model] -ojf -of <prefix> <audio>
  fakeBin = path.join(tmp, 'fake-whisper.sh');
  fs.writeFileSync(
    fakeBin,
    `#!/bin/sh
prefix=""
prev=""
for a in "$@"; do
  if [ "$prev" = "-of" ]; then prefix="$a"; fi
  prev="$a"
done
[ -n "$prefix" ] || exit 2
cat > "$prefix.json" <<'EOF'
${JSON.stringify(FAKE_JSON)}
EOF
`,
    { mode: 0o755 },
  );
  // Read-only source library, like the :ro mount in production.
  fs.chmodSync(sourceDir, 0o555);
});

afterAll(() => {
  fs.chmodSync(sourceDir, 0o755);
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('WhisperCliProvider', () => {
  it('writes only under workDir, succeeds against a read-only source, and cleans up', async () => {
    const provider = new WhisperCliProvider();
    const result = await provider.transcribe({
      trackPaths: [path.join(sourceDir, 'track0.mp3')],
      trackStartMs: [0],
      language: 'en',
      workDir,
      whisperBin: fakeBin,
    });
    expect(result.words.map((w) => w.w)).toEqual(['hello', 'world']);
    expect(result.words[0]!.s).toBe(0);
    // Source library untouched (still exactly one file, no *.tl-whisper).
    expect(fs.readdirSync(sourceDir)).toEqual(['track0.mp3']);
    // Temp output cleaned from the work dir.
    expect(fs.readdirSync(workDir)).toEqual([]);
  });

  it('cleans up the temp dir even when the binary fails', async () => {
    const badBin = path.join(tmp, 'failing-whisper.sh');
    fs.writeFileSync(badBin, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    const provider = new WhisperCliProvider();
    await expect(
      provider.transcribe({
        trackPaths: [path.join(sourceDir, 'track0.mp3')],
        trackStartMs: [0],
        language: 'en',
        workDir,
        whisperBin: badBin,
      }),
    ).rejects.toThrow();
    expect(fs.readdirSync(workDir)).toEqual([]);
    expect(fs.readdirSync(sourceDir)).toEqual(['track0.mp3']);
  });

  it('applies track start offsets to word timestamps', async () => {
    const provider = new WhisperCliProvider();
    const result = await provider.transcribe({
      trackPaths: [path.join(sourceDir, 'track0.mp3')],
      trackStartMs: [60_000],
      language: 'en',
      workDir,
      whisperBin: fakeBin,
    });
    expect(result.words[0]!.s).toBe(60_000);
    expect(result.words[1]!.e).toBe(61_900);
  });
});

describe('mergeWhisperTokens', () => {
  it('glues BPE pieces into words, skips special tokens, spans timings', () => {
    const words = mergeWhisperTokens(
      [
        {
          offsets: { from: 0, to: 3000 },
          tokens: [
            { text: '[_BEG_]', offsets: { from: 0, to: 0 } },
            { text: ' The', offsets: { from: 0, to: 200 } },
            { text: ' light', offsets: { from: 250, to: 500 } },
            { text: 'house', offsets: { from: 500, to: 800 } },
            { text: ',', offsets: { from: 800, to: 820 } },
            { text: ' stood', offsets: { from: 900, to: 1200 } },
            { text: '.', offsets: { from: 1200, to: 1250 } },
            { text: '[_TT_150]', offsets: { from: 3000, to: 3000 } },
          ],
        },
      ],
      10_000,
    );
    expect(words.map((w) => w.w)).toEqual(['the', 'lighthouse', 'stood']);
    expect(words[1]).toEqual({ w: 'lighthouse', s: 10_250, e: 10_820 });
    expect(words[2]!.e).toBe(11_250);
  });
});

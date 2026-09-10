import { createHash } from 'node:crypto';
import fs from 'node:fs';

/**
 * Offline-audio integrity contract (docs/research-and-architecture.md):
 * every track in an offline package carries an immutable source version and
 * a cryptographic digest for EACH fixed-size chunk, so the client can verify
 * every ranged response before storing it and can detect a replaced source
 * file mid-download or across resumes. Hashing is streamed — the file is
 * never buffered whole.
 */

/** Chunk size for offline audio packages (mirrored client-side). */
export const OFFLINE_AUDIO_CHUNK_BYTES = 8 * 1024 * 1024;

/**
 * Immutable identity of a track's source bytes as currently served. Changes
 * whenever the file is replaced (size or mtime moves), matching what the
 * range-serving route reads from disk.
 */
export function trackSourceVersion(
  stat: { size: number; mtimeMs: number },
  relPath: string,
): string {
  return createHash('sha256')
    .update(`${stat.size}:${Math.floor(stat.mtimeMs)}:${relPath}`)
    .digest('hex');
}

/** Streamed per-chunk SHA-256 digests of a file, chunked at `chunkBytes`. */
export async function hashFileChunks(
  filePath: string,
  chunkBytes: number = OFFLINE_AUDIO_CHUNK_BYTES,
): Promise<string[]> {
  const hashes: string[] = [];
  let hash = createHash('sha256');
  let inChunk = 0;
  const stream = fs.createReadStream(filePath, { highWaterMark: 256 * 1024 });
  for await (const piece of stream) {
    let buf = piece as Buffer;
    while (buf.length > 0) {
      const take = Math.min(buf.length, chunkBytes - inChunk);
      hash.update(buf.subarray(0, take));
      inChunk += take;
      buf = buf.subarray(take);
      if (inChunk === chunkBytes) {
        hashes.push(hash.digest('hex'));
        hash = createHash('sha256');
        inChunk = 0;
      }
    }
  }
  if (inChunk > 0) hashes.push(hash.digest('hex'));
  return hashes;
}

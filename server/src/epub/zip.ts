import fs from 'node:fs';
import path from 'node:path';
import posix from 'node:path/posix';
import { Unzip, UnzipInflate } from 'fflate';

/**
 * Bounded, streaming ZIP extraction for EPUBs — to disk, never to memory.
 *
 * The archive is read from disk in small chunks, inflated entry-by-entry,
 * and every decompressed chunk is written straight to a private file under
 * the caller's destination directory. At no point is more than one inflate
 * chunk of any entry held in memory, and the aggregate decompressed output
 * lives on disk only. Every limit is enforced on actual streamed bytes (not
 * on header claims, which a crafted zip can lie about), and a violation
 * aborts extraction — deleting the partial entry — before the next chunk is
 * accepted. Entry names that are absolute or escape upward are dropped at
 * extraction time; stored files use opaque generated names so a hostile
 * entry name can never influence the on-disk path.
 */

export interface ZipLimits {
  /** Max compressed archive size on disk. */
  maxCompressedBytes: number;
  /** Max decompressed size of any single entry. */
  maxEntryBytes: number;
  /** Max total decompressed size across all entries. */
  maxTotalBytes: number;
  /** Max number of entries. */
  maxEntries: number;
  /** Max total decompressed/compressed expansion ratio (bomb heuristic). */
  maxTotalRatio: number;
}

export const EPUB_ZIP_LIMITS: ZipLimits = {
  maxCompressedBytes: 400 * 1024 * 1024,
  maxEntryBytes: 96 * 1024 * 1024,
  maxTotalBytes: 900 * 1024 * 1024,
  maxEntries: 20_000,
  maxTotalRatio: 150,
};

export class ZipLimitError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = 'ZipLimitError';
  }
}

const READ_CHUNK = 256 * 1024;
/** Ratio checks only engage past this output volume to spare tiny archives. */
const RATIO_CHECK_MIN_BYTES = 8 * 1024 * 1024;

export interface ZipEntryInfo {
  /** Normalized zip path of the entry. */
  name: string;
  /** Decompressed size in bytes (actual streamed bytes, not the header claim). */
  size: number;
  /** On-disk file holding the entry's bytes (opaque generated name). */
  filePath: string;
}

export type ZipDirIndex = Map<string, ZipEntryInfo>;

/**
 * Stream-extract a zip file into `destDir` under strict limits. Async so the
 * caller's event loop (worker lease heartbeats included) keeps running; the
 * read loop yields between input chunks. The caller owns `destDir` cleanup.
 */
export async function extractZipToDir(
  filePath: string,
  destDir: string,
  limits: ZipLimits = EPUB_ZIP_LIMITS,
): Promise<ZipDirIndex> {
  const stat = fs.statSync(filePath);
  if (!stat.isFile()) throw new ZipLimitError('Not a regular file');
  if (stat.size > limits.maxCompressedBytes) {
    throw new ZipLimitError(
      `EPUB is ${Math.round(stat.size / 1024 / 1024)}MB; the limit is ${Math.round(
        limits.maxCompressedBytes / 1024 / 1024,
      )}MB`,
    );
  }
  fs.mkdirSync(destDir, { recursive: true });

  const index: ZipDirIndex = new Map();
  let entryCount = 0;
  let fileSeq = 0;
  let totalOut = 0;
  let failure: Error | null = null;
  const openFds = new Map<number, string>(); // fd -> partial file path

  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (failure) return;
    if (file.name.endsWith('/')) return; // directory entry
    entryCount += 1;
    if (entryCount > limits.maxEntries) {
      failure = new ZipLimitError(`EPUB has more than ${limits.maxEntries} entries`);
      return;
    }
    const norm = posix.normalize(file.name);
    if (norm.startsWith('..') || posix.isAbsolute(norm) || norm.includes('\0')) {
      // Hostile or escaping name: never extracted, never indexed.
      return;
    }
    const outPath = path.join(destDir, `e${fileSeq++}.bin`);
    let fd = -1;
    let entryOut = 0;
    const abort = (err: Error) => {
      failure = err;
      if (fd >= 0) {
        try {
          fs.closeSync(fd);
        } catch {
          /* already closed */
        }
        openFds.delete(fd);
        fd = -1;
      }
      fs.rmSync(outPath, { force: true });
      file.terminate();
    };
    file.ondata = (err, chunk, final) => {
      if (failure) return;
      if (err) {
        abort(err);
        return;
      }
      if (fd < 0) {
        try {
          fd = fs.openSync(outPath, 'wx');
          openFds.set(fd, outPath);
        } catch (openErr) {
          abort(openErr as Error);
          return;
        }
      }
      if (chunk && chunk.length > 0) {
        entryOut += chunk.length;
        totalOut += chunk.length;
        if (entryOut > limits.maxEntryBytes) {
          abort(
            new ZipLimitError(
              `EPUB entry "${file.name}" exceeds the ${Math.round(
                limits.maxEntryBytes / 1024 / 1024,
              )}MB per-file limit`,
            ),
          );
          return;
        }
        if (totalOut > limits.maxTotalBytes) {
          abort(new ZipLimitError('EPUB decompressed size limit exceeded'));
          return;
        }
        if (
          totalOut > RATIO_CHECK_MIN_BYTES &&
          totalOut > limits.maxTotalRatio * Math.max(1, stat.size)
        ) {
          abort(new ZipLimitError('EPUB compression ratio is implausibly high (zip bomb?)'));
          return;
        }
        // Straight to disk: the chunk is the only decompressed data in memory.
        fs.writeSync(fd, chunk);
      }
      if (final) {
        fs.closeSync(fd);
        openFds.delete(fd);
        fd = -1;
        // First entry with a given normalized name wins (defense in depth
        // against duplicate-name confusion); later duplicates are dropped.
        if (!index.has(norm)) {
          index.set(norm, { name: norm, size: entryOut, filePath: outPath });
        } else {
          fs.rmSync(outPath, { force: true });
        }
      }
    };
    file.start();
  };

  const inFd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(READ_CHUNK);
    let pos = 0;
    for (;;) {
      const n = fs.readSync(inFd, buf, 0, READ_CHUNK, pos);
      pos += n;
      const last = pos >= stat.size || n === 0;
      // Copy: fflate may retain pushed chunks internally.
      unzip.push(new Uint8Array(buf.subarray(0, n)), last);
      if (failure) throw failure;
      if (last) break;
      // Yield so timers (worker lease heartbeats) run during long extractions.
      await new Promise((r) => setImmediate(r));
    }
  } finally {
    fs.closeSync(inFd);
    for (const [fd, partial] of openFds) {
      try {
        fs.closeSync(fd);
      } catch {
        /* already closed */
      }
      fs.rmSync(partial, { force: true });
    }
  }
  if (failure) throw failure;
  return index;
}

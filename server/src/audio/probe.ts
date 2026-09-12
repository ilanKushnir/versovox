import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/** ffprobe wrapper. ffprobe is required (bundled in the Docker image). */

export interface AudioChapter {
  title: string | null;
  startMs: number;
  endMs: number;
}

export interface AudioProbe {
  durationMs: number;
  title: string | null;
  artist: string | null;
  album: string | null;
  language: string | null;
  chapters: AudioChapter[];
  hasCover: boolean;
  codec: string | null;
  /**
   * Genres, from the `genre` tag. Audiobookshelf writes several separated by
   * a slash or a semicolon; iTunes-produced m4b files write one.
   */
  genres: string[];
  /**
   * Who reads it. There is no standard tag for this: `composer` is the
   * convention Audiobookshelf and Libation use, `narrator` is written by some
   * taggers, and `artist` is the author, not the narrator.
   */
  narrator: string | null;
  /** Publication year from `date`, `year` or `originalyear`, when present. */
  year: number | null;
}

export async function probeAudio(filePath: string): Promise<AudioProbe> {
  const { stdout } = await execFileP(
    'ffprobe',
    [
      '-v',
      'error',
      '-print_format',
      'json',
      '-show_format',
      '-show_chapters',
      '-show_streams',
      filePath,
    ],
    { maxBuffer: 32 * 1024 * 1024, timeout: 60_000, killSignal: 'SIGKILL' },
  );
  const data = JSON.parse(stdout);
  const fmt = data.format ?? {};
  const tags: Record<string, string> = lowerKeys(fmt.tags ?? {});
  const streams: Record<string, unknown>[] = data.streams ?? [];
  const audioStream = streams.find((s) => s.codec_type === 'audio');
  const hasCover = streams.some(
    (s) =>
      s.codec_type === 'video' &&
      (s.disposition as { attached_pic?: number } | undefined)?.attached_pic === 1,
  );
  const chapters: AudioChapter[] = (data.chapters ?? []).map((c: Record<string, unknown>) => ({
    title: lowerKeys((c.tags as Record<string, string>) ?? {})['title'] ?? null,
    startMs: Math.round(parseFloat(String(c.start_time ?? '0')) * 1000),
    endMs: Math.round(parseFloat(String(c.end_time ?? '0')) * 1000),
  }));
  return {
    durationMs: Math.round(parseFloat(fmt.duration ?? '0') * 1000),
    title: tags['title'] ?? null,
    artist: tags['artist'] ?? tags['album_artist'] ?? tags['composer'] ?? null,
    album: tags['album'] ?? null,
    language: tags['language'] ?? null,
    chapters,
    hasCover,
    codec: (audioStream?.codec_name as string | undefined) ?? null,
    genres: splitTagList(tags['genre']),
    narrator: tags['narrator'] ?? tags['composer'] ?? null,
    year: yearFromTag(tags['date'] ?? tags['year'] ?? tags['originalyear']),
  };
}

/** One tag holding several values, as taggers variously write them. */
function splitTagList(value: string | undefined): string[] {
  if (!value) return [];
  return Array.from(
    new Set(
      value
        .split(/\s*[,;/]\s*/)
        .map((t) => t.trim())
        .filter((t) => t.length > 0 && t.length <= 60),
    ),
  );
}

/** A four-digit year out of a tag that may be a year or a full date. */
function yearFromTag(value: string | undefined): number | null {
  const m = value ? /(\d{4})/.exec(value) : null;
  if (!m) return null;
  const year = Number(m[1]);
  return year >= 1000 && year <= new Date().getFullYear() + 2 ? year : null;
}

export interface ExtractCoverOptions {
  /** Kill a hung ffmpeg after this long (default 60s). */
  timeoutMs?: number;
  /** Abort mid-run (e.g. the caller's job lease was lost). */
  signal?: AbortSignal;
}

export async function extractCover(
  filePath: string,
  outPath: string,
  opts: ExtractCoverOptions = {},
): Promise<boolean> {
  try {
    await execFileP(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', filePath, '-an', '-c:v', 'copy', outPath],
      {
        maxBuffer: 1024 * 1024,
        timeout: opts.timeoutMs ?? 60_000,
        killSignal: 'SIGKILL',
        signal: opts.signal,
      },
    );
    return true;
  } catch {
    return false;
  }
}

function lowerKeys(obj: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(obj)) out[k.toLowerCase()] = v;
  return out;
}

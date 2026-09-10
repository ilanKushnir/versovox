/**
 * Honest per-browser audio format support. FLAC/OGG/Opus are detected by the
 * scanner but are NOT universally playable (Safari/iOS notably lacks Ogg
 * containers); the UI must disable Listen with an explanation rather than
 * failing after the player opens.
 */

const FORMAT_MIME: Record<string, string> = {
  m4b: 'audio/mp4',
  m4a: 'audio/mp4',
  mp3: 'audio/mpeg',
  flac: 'audio/flac',
  ogg: 'audio/ogg; codecs="vorbis"',
  opus: 'audio/ogg; codecs="opus"',
};

export interface AudioSupport {
  /** '' | 'maybe' | 'probably' from canPlayType; 'unknown' when untestable. */
  level: 'probably' | 'maybe' | 'unsupported' | 'unknown';
  supported: boolean;
  /** Honest user-facing explanation when unsupported. */
  reason: string | null;
}

export function audioFormatSupport(format: string, probe?: (mime: string) => string): AudioSupport {
  const fmt = format.toLowerCase();
  // Multi-track books report 'multi'; per-track formats decide, so treat the
  // container list as unknown here and let per-track checks refine it.
  const mime = FORMAT_MIME[fmt];
  if (!mime) return { level: 'unknown', supported: true, reason: null };
  let canPlay: string;
  try {
    if (probe) {
      canPlay = probe(mime);
    } else if (typeof Audio !== 'undefined') {
      canPlay = new Audio().canPlayType(mime);
    } else {
      return { level: 'unknown', supported: true, reason: null };
    }
  } catch {
    return { level: 'unknown', supported: true, reason: null };
  }
  if (canPlay === 'probably' || canPlay === 'maybe') {
    return { level: canPlay, supported: true, reason: null };
  }
  return {
    level: 'unsupported',
    supported: false,
    reason: `This browser cannot play ${fmt.toUpperCase()} audio. The file was detected and kept in your library, but listening here needs a browser with ${fmt.toUpperCase()} support.`,
  };
}

/** Support across a book's tracks: unsupported if ANY track format is unplayable. */
export function bookAudioSupport(
  formats: string[],
  probe?: (mime: string) => string,
): AudioSupport {
  for (const f of formats) {
    const s = audioFormatSupport(f, probe);
    if (!s.supported) return s;
  }
  return { level: 'probably', supported: true, reason: null };
}

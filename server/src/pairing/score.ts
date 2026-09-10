import { type PairEvidence } from '@versovox/shared';
import {
  normalizeAuthor,
  normalizeTitle,
  stringSimilarity,
  tokenSimilarity,
  tokenize,
} from '../util/text.js';

/**
 * Conservative pair candidate scoring. Metadata alone can suggest a pair but
 * never authorizes sentence-level switching (that requires alignment).
 * False positives are worse than false negatives: anything ambiguous stays a
 * candidate for human review, and low scores generate nothing at all.
 */

export interface PairInputs {
  ebook: {
    title: string;
    author: string | null;
    language: string | null;
    series: string | null;
    identifiers: Record<string, string>;
    totalChars: number | null;
  };
  audio: {
    title: string;
    author: string | null;
    language: string | null;
    series: string | null;
    identifiers: Record<string, string>;
    durationMs: number | null;
  };
}

/** Typical narration pace, characters per second (empirically ~15–18). */
const NARRATION_CHARS_PER_SEC = 16.5;

export const CANDIDATE_THRESHOLD = 0.55;
export const DEFAULT_AUTO_THRESHOLD = 0.92;

export function scorePair(input: PairInputs): { score: number; evidence: PairEvidence } {
  const notes: string[] = [];
  const et = normalizeTitle(input.ebook.title);
  const at = normalizeTitle(input.audio.title);
  const titleScore = Math.max(
    stringSimilarity(et, at),
    tokenSimilarity(tokenize(et), tokenize(at)),
  );

  let authorScore = 0.5; // unknown
  if (input.ebook.author && input.audio.author) {
    authorScore = stringSimilarity(
      normalizeAuthor(input.ebook.author),
      normalizeAuthor(input.audio.author),
    );
  } else {
    notes.push('Author missing on one side; treated as neutral evidence.');
  }

  const eIds = Object.values(input.ebook.identifiers).map((v) => v.toLowerCase());
  const aIds = Object.values(input.audio.identifiers).map((v) => v.toLowerCase());
  const identifierMatch = eIds.length > 0 && aIds.length > 0 && eIds.some((v) => aIds.includes(v));

  let languageMatch: boolean | null = null;
  const eLang = languageCode(input.ebook.language);
  const aLang = languageCode(input.audio.language);
  if (eLang && aLang) {
    languageMatch = eLang === aLang;
    if (!languageMatch) notes.push('Languages differ — possible translation mismatch.');
  }

  let seriesMatch: boolean | null = null;
  if (input.ebook.series && input.audio.series) {
    seriesMatch =
      stringSimilarity(normalizeTitle(input.ebook.series), normalizeTitle(input.audio.series)) >
      0.85;
  }

  let durationPagesRatio: number | null = null;
  if (input.ebook.totalChars && input.audio.durationMs) {
    const expectedMs = (input.ebook.totalChars / NARRATION_CHARS_PER_SEC) * 1000;
    durationPagesRatio = input.audio.durationMs / expectedMs;
    if (durationPagesRatio < 0.55) {
      notes.push('Audio much shorter than the text suggests — possibly abridged.');
    } else if (durationPagesRatio > 1.9) {
      notes.push('Audio much longer than the text suggests — possibly a different edition.');
    }
  }

  // Weighted score.
  let score = 0;
  score += 0.5 * titleScore;
  score += 0.25 * authorScore;
  score += 0.08 * (languageMatch === null ? 0.5 : languageMatch ? 1 : 0);
  score += 0.07 * (seriesMatch === null ? 0.5 : seriesMatch ? 1 : 0);
  if (durationPagesRatio !== null) {
    const durScore = durationPagesRatio > 0.55 && durationPagesRatio < 1.9 ? 1 : 0.2;
    score += 0.1 * durScore;
  } else {
    score += 0.05;
  }
  if (identifierMatch) score = Math.max(score, 0.96);
  // Contradictory languages are a hard damper regardless of titles.
  if (languageMatch === false) score = Math.min(score, 0.4);

  const evidence: PairEvidence = {
    titleScore: round3(titleScore),
    authorScore: round3(authorScore),
    identifierMatch,
    languageMatch,
    seriesMatch,
    durationPagesRatio: durationPagesRatio === null ? null : round3(durationPagesRatio),
    contentScore: null,
    notes,
  };
  return { score: round3(Math.max(0, Math.min(1, score))), evidence };
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/** ID3/MP4 tags often carry ISO 639-2 codes (`eng`, `heb`); EPUBs carry BCP-47. */
const ISO_639_2_TO_1: Record<string, string> = {
  eng: 'en',
  heb: 'he',
  ger: 'de',
  deu: 'de',
  fre: 'fr',
  fra: 'fr',
  spa: 'es',
  ita: 'it',
  por: 'pt',
  dut: 'nl',
  nld: 'nl',
  rus: 'ru',
  pol: 'pl',
  swe: 'sv',
  nor: 'no',
  dan: 'da',
  fin: 'fi',
  gre: 'el',
  ell: 'el',
  tur: 'tr',
  ara: 'ar',
  jpn: 'ja',
  chi: 'zh',
  zho: 'zh',
  kor: 'ko',
  hun: 'hu',
  cze: 'cs',
  ces: 'cs',
  ukr: 'uk',
  ron: 'ro',
  rum: 'ro',
  hin: 'hi',
};

/** Normalize a language tag to a 2-letter code; `und`/unknown → null. */
export function languageCode(tag: string | null | undefined): string | null {
  if (!tag) return null;
  const lower = tag.trim().toLowerCase();
  if (!lower || lower === 'und' || lower === 'unknown') return null;
  const base = lower.split(/[-_]/)[0]!;
  if (base.length === 3) return ISO_639_2_TO_1[base] ?? null;
  return base.length === 2 ? base : null;
}

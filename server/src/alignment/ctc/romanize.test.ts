import { describe, expect, it } from 'vitest';
import { MODEL_ALPHABET, isModelAlphabet, romanize, romanizeWithMap } from './romanize.js';

/**
 * The contract these tests defend: whatever goes in, what comes out is spellable
 * by the aligner's 27-symbol alphabet, and every output character can name the
 * offset in the original string that produced it. The anchor matcher relies on
 * both — the first to compare against the model's greedy decode at all, the
 * second to turn a matched n-gram back into a position in the ebook.
 */

/** Sample prose per supported language, in its own script. */
const SAMPLES: Record<string, string> = {
  en: 'Mr. Holloway paid $25 for 3 books on the 1st of May — “worth it,” he said.',
  de: 'Dr. Weiß zahlte 25 € für drei Bücher; z.B. über Straßen und Flüsse.',
  nl: 'Mevr. de Vries kocht 25 boeken; bijv. over rivieren en straten.',
  fr: 'M. Lefèvre a payé 25 € pour trois livres, c.-à-d. une affaire.',
  es: 'El Sr. Núñez pagó 25 € por tres libros el 1º de mayo.',
  it: 'Il Sig. Rossi ha pagato 25 € per tre libri il 1º maggio.',
  pt: 'O Sr. Almeida pagou 25 € por três livros no 1º de maio.',
  ru: 'Господин Щербаков заплатил 25 рублей за три книги в мае.',
  he: 'מר כהן שילם 25 שקלים עבור שלושה ספרים בחודש מאי.',
  ar: 'دفع السيد خالد 25 دولارا لثلاثة كتب في مايو.',
};

describe('alphabet safety', () => {
  it('emits only alphabet characters for every supported language', () => {
    for (const [lang, text] of Object.entries(SAMPLES)) {
      const chars = romanize(text, lang);
      expect(chars.length, `${lang} produced nothing`).toBeGreaterThan(10);
      expect(isModelAlphabet(chars), `${lang} -> ${chars}`).toBe(true);
    }
  });

  it('emits only alphabet characters across a wide sweep of code points', () => {
    // Covers Latin-1/Extended, Greek, Cyrillic, Hebrew, Arabic, punctuation,
    // arrows, CJK, Arabic presentation forms and astral emoji.
    const ranges: [number, number][] = [
      [0x20, 0x7f],
      [0xa0, 0x2ff],
      [0x370, 0x5ff],
      [0x600, 0x6ff],
      [0x2000, 0x21ff],
      [0x3000, 0x30ff],
      [0xfb00, 0xfeff],
      [0x1f300, 0x1f3ff],
    ];
    let text = '';
    for (const [lo, hi] of ranges) {
      for (let cp = lo; cp <= hi; cp++) text += String.fromCodePoint(cp);
    }
    for (const lang of Object.keys(SAMPLES)) {
      expect(isModelAlphabet(romanize(text, lang)), lang).toBe(true);
    }
  });

  it('exports the 27 symbols the model vocabulary contains', () => {
    expect(MODEL_ALPHABET).toHaveLength(27);
    expect(new Set(MODEL_ALPHABET).size).toBe(27);
    expect(isModelAlphabet('')).toBe(true);
    expect(isModelAlphabet('a b')).toBe(false);
  });

  it('drops everything from empty and punctuation-only input', () => {
    for (const lang of Object.keys(SAMPLES)) {
      expect(romanize('', lang)).toBe('');
      expect(romanize('   \n\t  ', lang)).toBe('');
      expect(romanize('… — “” «» ‹› ?!.,;:()[]{}/\\*#@^~|', lang)).toBe('');
      expect(romanizeWithMap('...', lang).sourceIndex).toEqual([]);
    }
  });
});

describe('source index', () => {
  it('points every character at the offset it came from', () => {
    const text = 'The quick brown fox.';
    const { chars, sourceIndex } = romanizeWithMap(text, 'en');
    expect(chars).toBe('thequickbrownfox');
    expect(sourceIndex).toHaveLength(chars.length);
    for (let i = 0; i < chars.length; i++) {
      expect(text[sourceIndex[i]!]!.toLowerCase()).toBe(chars[i]);
    }
  });

  it('stays non-decreasing and in range for mixed content', () => {
    const text = 'Dr. Weiß kaufte 1.234 Bücher — und ½ Liter Öl; Щи, שלום, مرحبا.';
    const { chars, sourceIndex } = romanizeWithMap(text, 'de');
    expect(sourceIndex).toHaveLength(chars.length);
    let prev = -1;
    for (const idx of sourceIndex) {
      expect(idx).toBeGreaterThanOrEqual(prev);
      expect(idx).toBeLessThan(text.length);
      prev = idx;
    }
  });

  it('maps multi-character transliterations back to the single source char', () => {
    const text = 'Größe';
    const { chars, sourceIndex } = romanizeWithMap(text, 'de');
    expect(chars).toBe('grosse');
    // Both letters of "ss" come from the single ß at offset 3.
    expect(sourceIndex).toEqual([0, 1, 2, 3, 3, 4]);
  });

  it('spreads an expansion across the span it replaced, never outside it', () => {
    const text = 'over 25 dogs';
    const { chars, sourceIndex } = romanizeWithMap(text, 'en');
    expect(chars).toBe('overtwentyfivedogs');
    const numberStart = chars.indexOf('twenty');
    const numberEnd = chars.indexOf('dogs');
    for (let i = numberStart; i < numberEnd; i++) {
      expect(sourceIndex[i]).toBeGreaterThanOrEqual(5); // '2'
      expect(sourceIndex[i]).toBeLessThanOrEqual(6); // '5'
    }
    expect(sourceIndex[numberStart]).toBe(5);
    expect(text.slice(sourceIndex[numberEnd]!)).toBe('dogs');
  });

  it('survives astral characters without splitting a surrogate pair', () => {
    const text = 'a\u{1F600}b';
    const { chars, sourceIndex } = romanizeWithMap(text, 'en');
    expect(chars).toBe('ab');
    expect(sourceIndex).toEqual([0, 3]);
  });
});

describe('latin normalization', () => {
  it('strips diacritics and case', () => {
    expect(romanize('Élan Vital Ångström', 'en')).toBe('elanvitalangstrom');
    expect(romanize('naïve café résumé', 'fr')).toBe('naivecaferesume');
  });

  it('expands the letters NFKD leaves alone', () => {
    expect(romanize('straße', 'de')).toBe('strasse');
    expect(romanize('Æsc œuvre Ø þorn Ðag łódź', 'en')).toBe('aescoeuvreothorndaglodz');
  });

  it('keeps an apostrophe only between letters', () => {
    expect(romanize("don't", 'en')).toBe("don't");
    expect(romanize('don’t', 'en')).toBe("don't");
    expect(romanize('‘quoted’', 'en')).toBe('quoted');
    expect(romanize("the dogs' bowls", 'en')).toBe('thedogsbowls');
    expect(romanize('l’été', 'fr')).toBe("l'ete");
  });
});

describe('cyrillic transliteration', () => {
  it('follows the documented BGN/PCGN simplification', () => {
    expect(romanize('Щербаков', 'ru')).toBe('shcherbakov');
    expect(romanize('Хорошо', 'ru')).toBe('khorosho');
    expect(romanize('Ёжик', 'ru')).toBe('yozhik');
    // Hard and soft signs are silent and carry no letter.
    expect(romanize('объявление', 'ru')).toBe('obyavlenie');
    expect(romanize('дядя Ваня', 'ru')).toBe('dyadyavanya');
  });
});

describe('hebrew transliteration', () => {
  it('maps final forms to their unambiguous pronunciation', () => {
    expect(romanize('ך', 'he')).toBe('kh');
    expect(romanize('ם', 'he')).toBe('m');
    expect(romanize('ן', 'he')).toBe('n');
    expect(romanize('ף', 'he')).toBe('f');
    expect(romanize('ץ', 'he')).toBe('ts');
  });

  it('romanizes the consonant skeleton of unpointed words', () => {
    expect(romanize('שלום', 'he')).toBe('shlvm');
    expect(romanize('מלך', 'he')).toBe('mlkh');
    expect(romanize('ארץ', 'he')).toBe('rts');
  });

  it('strips niqqud without changing the consonants', () => {
    expect(romanize('שָׁלוֹם', 'he')).toBe(romanize('שלום', 'he'));
  });

  it('reads geresh digraphs as the borrowed consonant', () => {
    expect(romanize('ג׳ירפה', 'he')).toBe('jyrph');
    expect(romanize('צ׳יפס', 'he')).toBe('chyps');
  });
});

describe('arabic transliteration', () => {
  it('maps the consonantal script without diacritics', () => {
    expect(romanize('كتاب', 'ar')).toBe('ktab');
    expect(romanize('مَرْحَبًا', 'ar')).toBe(romanize('مرحبا', 'ar'));
    expect(romanize('شمس', 'ar')).toBe('shms');
    expect(romanize('مدرسة', 'ar')).toBe('mdrsa');
  });

  it('unfolds presentation forms and the lam-alef ligature', () => {
    expect(romanize('ﻻ', 'ar')).toBe(romanize('لا', 'ar'));
  });
});

describe('number expansion', () => {
  const en = (s: string) => romanize(s, 'en');

  it('spells English integers 0-9999', () => {
    expect(en('0')).toBe('zero');
    expect(en('7')).toBe('seven');
    expect(en('13')).toBe('thirteen');
    expect(en('25')).toBe('twentyfive');
    expect(en('40')).toBe('forty');
    expect(en('105')).toBe('onehundredfive');
    expect(en('900')).toBe('ninehundred');
    expect(en('1000')).toBe('onethousand');
    expect(en('1984')).toBe('onethousandninehundredeightyfour');
    expect(en('9999')).toBe('ninethousandninehundredninetynine');
  });

  it('leaves numbers above the spellable range alone rather than guessing', () => {
    expect(en('a 10000 b')).toBe('ab');
    expect(en('1,250,000')).toBe('');
  });

  it('handles group separators per language', () => {
    expect(en('1,234')).toBe('onethousandtwohundredthirtyfour');
    expect(romanize('1.234', 'de')).toBe('eintausendzweihundertvierunddreissig');
    // French typesets its thousands separator as a non-breaking space.
    expect(romanize('1 234', 'fr')).toBe(romanize('1234', 'fr'));
    // A plain space never joins groups, so this reads as two numbers.
    expect(romanize('1 234', 'fr')).toBe(romanize('un', 'fr') + romanize('234', 'fr'));
  });

  it('never joins digit groups across a plain space', () => {
    // A table row "100 200" must not become one hundred million.
    expect(en('100 200')).toBe('onehundredtwohundred');
  });

  it('rejects implausible grouping instead of mis-reading it', () => {
    expect(en('12,34')).toBe('');
  });

  it('reads decimals with the language decimal separator', () => {
    expect(en('3.5')).toBe('threepointfive');
    expect(romanize('3,5', 'de')).toBe('dreikommafunf');
    // In a German book the period groups thousands, so '3.5' is not a decimal
    // and the grouping is implausible: nothing is emitted.
    expect(romanize('3.5', 'de')).toBe('');
  });

  it('spells English ordinals', () => {
    expect(en('1st')).toBe('first');
    expect(en('2nd')).toBe('second');
    expect(en('3rd')).toBe('third');
    expect(en('12th')).toBe('twelfth');
    expect(en('21st')).toBe('twentyfirst');
    expect(en('40th')).toBe('fortieth');
    expect(en('100th')).toBe('onehundredth');
  });

  it('reads currency symbols as a word after the amount', () => {
    expect(en('$25')).toBe('twentyfivedollars');
    expect(en('$1')).toBe('onedollar');
    expect(en('£3')).toBe('threepounds');
    expect(romanize('25 €', 'de')).toBe('funfundzwanzigeuro');
  });

  it('reads percent', () => {
    expect(en('25%')).toBe('twentyfivepercent');
    expect(romanize('1%', 'ru')).toBe(romanize('один процент', 'ru'));
    expect(romanize('3%', 'ru')).toBe(romanize('три процента', 'ru'));
    expect(romanize('11%', 'ru')).toBe(romanize('одиннадцать процентов', 'ru'));
  });

  it('does not expand digits glued to letters', () => {
    expect(en('A4 paper')).toBe('apaper');
    expect(en('MP3')).toBe('mp');
  });

  it('does not swallow sentence-final punctuation into a number', () => {
    const { chars } = romanizeWithMap('It was 1990. Then rain.', 'en');
    expect(chars).toBe('itwasonethousandninehundredninetythenrain');
  });

  it('expands ampersands', () => {
    expect(en('Tom & Jerry')).toBe('tomandjerry');
    expect(romanize('Tom & Jerry', 'de')).toBe('tomundjerry');
  });

  it('expands numbers consistently with spelled-out words in every language', () => {
    const cases: [string, string, string][] = [
      ['en', '25', 'twenty five'],
      ['de', '25', 'fünfundzwanzig'],
      ['nl', '25', 'vijfentwintig'],
      ['fr', '25', 'vingt cinq'],
      ['fr', '71', 'soixante et onze'],
      ['fr', '80', 'quatre-vingts'],
      ['fr', '99', 'quatre-vingt dix-neuf'],
      ['es', '25', 'veinticinco'],
      ['es', '100', 'cien'],
      ['es', '31', 'treinta y uno'],
      ['it', '21', 'ventuno'],
      ['it', '2000', 'duemila'],
      ['pt', '25', 'vinte e cinco'],
      ['pt', '100', 'cem'],
      ['ru', '25', 'двадцать пять'],
      ['ru', '2000', 'две тысячи'],
      ['he', '25', 'עשרים וחמש'],
      ['he', '120', 'מאה ועשרים'],
      ['ar', '25', 'خمسة وعشرون'],
      ['ar', '1200', 'ألف ومئتان'],
    ];
    for (const [lang, digits, words] of cases) {
      expect(romanize(digits, lang), `${lang} ${digits}`).toBe(romanize(words, lang));
    }
  });

  it('reads non-English ordinal markers', () => {
    expect(romanize('1º', 'es')).toBe(romanize('primero', 'es'));
    expect(romanize('3ème', 'fr')).toBe(romanize('troisième', 'fr'));
    expect(romanize('2e', 'nl')).toBe(romanize('tweede', 'nl'));
    // Beyond the ordinal table we fall back to the cardinal, not to nothing.
    expect(romanize('40º', 'es')).toBe(romanize('cuarenta', 'es'));
  });

  it('ignores German ordinal dots, which are ambiguous with sentence ends', () => {
    expect(romanize('am 3. Mai', 'de')).toBe('amdreimai');
  });
});

describe('abbreviations', () => {
  it('expands English titles and common forms', () => {
    expect(romanize('Mr. Smith', 'en')).toBe('mistersmith');
    expect(romanize('Mrs Smith', 'en')).toBe('missussmith');
    expect(romanize('Dr. Who', 'en')).toBe('doctorwho');
    expect(romanize('St. Paul', 'en')).toBe('saintpaul');
    expect(romanize('Smith vs Jones', 'en')).toBe('smithversusjones');
    expect(romanize('apples, etc.', 'en')).toBe('applesetcetera');
    expect(romanize('e.g. this', 'en')).toBe('forexamplethis');
    expect(romanize('i.e. that', 'en')).toBe('thatisthat');
  });

  it('requires the guard conditions before expanding a risky key', () => {
    // "No." only reads as "number" when a number follows.
    expect(romanize('No. 5 Privet Drive', 'en')).toBe('numberfiveprivetdrive');
    expect(romanize('Oh, No.', 'en')).toBe('ohno');
    // "St" without a period is a word fragment, and lowercase "mr" is not a title.
    expect(romanize('St Paul', 'en')).toBe('stpaul');
    expect(romanize('mr smith', 'en')).toBe('mrsmith');
    // An abbreviation must not be found inside a longer word.
    expect(romanize('Mrs.', 'en')).toBe('missus');
    expect(romanize('Drought', 'en')).toBe('drought');
  });

  it('expands the per-language tables', () => {
    expect(romanize('z.B. Hunde', 'de')).toBe('zumbeispielhunde');
    expect(romanize('Dr. Weiß', 'de')).toBe('doktorweiss');
    expect(romanize('M. Dupont', 'fr')).toBe('monsieurdupont');
    expect(romanize('Sr. Núñez', 'es')).toBe('senornunez');
    expect(romanize('Sig. Rossi', 'it')).toBe('signorerossi');
    expect(romanize('Sr. Almeida', 'pt')).toBe('senhoralmeida');
    expect(romanize('enz.', 'nl')).toBe('enzovoort');
  });

  it('keeps the source index inside the abbreviation it replaced', () => {
    const text = 'Mr. Smith';
    const { chars, sourceIndex } = romanizeWithMap(text, 'en');
    expect(chars).toBe('mistersmith');
    for (let i = 0; i < 'mister'.length; i++) {
      expect(sourceIndex[i]).toBeGreaterThanOrEqual(0);
      expect(sourceIndex[i]).toBeLessThan(3);
    }
    expect(text.slice(sourceIndex['mister'.length]!)).toBe('Smith');
  });
});

describe('language resolution', () => {
  it('accepts region subtags', () => {
    expect(romanize('25', 'en-US')).toBe(romanize('25', 'en'));
    expect(romanize('25', 'de_DE')).toBe(romanize('25', 'de'));
    expect(romanize('25', 'PT-br')).toBe(romanize('25', 'pt'));
  });

  it('falls back to English rules but still transliterates every script', () => {
    expect(romanize('25', 'xx')).toBe('twentyfive');
    expect(romanize('25', '')).toBe('twentyfive');
    // Script mapping does not depend on the book language.
    expect(romanize('Щербаков', 'en')).toBe('shcherbakov');
    expect(romanize('שלום', 'en')).toBe('shlvm');
  });
});

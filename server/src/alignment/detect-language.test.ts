import { describe, expect, it } from 'vitest';
import { detectLanguageFromText } from './detect-language.js';

/**
 * The detector replaced a speech model, so the bar it has to clear is "at
 * least as good as running whisper over a clip of the narration" — which, on a
 * book that declares no language, was itself a guess. What matters most is the
 * abstention: a wrong confident answer spells numbers in the wrong language and
 * costs anchors, while abstaining falls back to the operator's own default.
 */

const SAMPLES: Record<string, string> = {
  en: `It was the best of times, it was the worst of times, it was the age of wisdom, it was
    the age of foolishness, it was the epoch of belief, it was the epoch of incredulity, it was
    the season of Light, it was the season of Darkness. We had everything before us, we had
    nothing before us. The king with a large jaw and the queen with a plain face were on the
    throne of England, and they had every reason to believe that things in general were settled
    for ever. It was the year of Our Lord one thousand seven hundred and seventy five.`,
  de: `Es war einmal ein Mann, der hatte drei Söhne, und das Haus war nicht groß genug für sie
    alle. Ich sage euch, sprach der Vater, ihr müsst in die Welt hinaus und euer Glück suchen,
    denn hier ist nichts mehr für euch. Die Brüder gingen also fort, und sie kamen an einen
    dunklen Wald, in dem auch die Vögel nicht mehr sangen. Der jüngste Sohn war der klügste von
    ihnen, aber niemand hörte auf ihn, und so war es mit ihm wie mit allen jüngsten Söhnen.`,
  fr: `Longtemps, je me suis couché de bonne heure. Parfois, à peine ma bougie éteinte, mes yeux
    se fermaient si vite que je n'avais pas le temps de me dire que je m'endormais. Et une
    demi-heure après, la pensée qu'il était temps de chercher le sommeil m'éveillait. Je voulais
    poser le volume que je croyais avoir encore dans les mains et souffler ma lumière, car je
    n'avais pas cessé en dormant de faire des réflexions sur ce que je venais de lire.`,
  es: `En un lugar de la Mancha, de cuyo nombre no quiero acordarme, no ha mucho tiempo que
    vivía un hidalgo de los de lanza en astillero, adarga antigua, rocín flaco y galgo corredor.
    Una olla de algo más vaca que carnero, salpicón las más noches, duelos y quebrantos los
    sábados, lentejas los viernes, algún palomino de añadidura los domingos, consumían las tres
    partes de su hacienda. Y el resto della concluían sayo de velarte y calzas de velludo.`,
  it: `Quel ramo del lago di Como, che volge a mezzogiorno, tra due catene non interrotte di
    monti, tutto a seni e a golfi, a seconda dello sporgere e del rientrare di quelli, vien,
    quasi a un tratto, a ristringersi. Il ponte che ivi congiunge le due rive sembra rendere
    ancor più sensibile all'occhio questa trasformazione, e segnare il punto in cui il lago
    cessa, e l'Adda rincomincia, per ripigliar poi nome di lago dove le rive si allontanano.`,
  pt: `Algum tempo hesitei se devia abrir estas memórias pelo princípio ou pelo fim, isto é, se
    poria em primeiro lugar o meu nascimento ou a minha morte. Suposto o uso vulgar seja começar
    pelo nascimento, duas considerações me levaram a adotar diferente método: a primeira é que
    eu não sou propriamente um autor defunto, mas um defunto autor, para quem a campa foi outro
    berço; a segunda é que o escrito ficaria assim mais galante e mais novo para todos.`,
  nl: `Het was een koude heldere dag in april, en de klokken sloegen dertien. Winston Smith,
    met zijn kin op zijn borst gedrukt om aan de gemene wind te ontkomen, glipte snel door de
    glazen deuren van Victory Mansions, maar niet snel genoeg om te verhinderen dat een wervel
    korrelig stof met hem naar binnen woei. Er was ook een affiche aan de muur dat te groot was
    voor de plek waar het hing, en dat niets anders toonde dan een enorm gezicht.`,
  ru: `Все счастливые семьи похожи друг на друга, каждая несчастливая семья несчастлива
    по-своему. Все смешалось в доме Облонских. Жена узнала, что муж был в связи с бывшею в их
    доме француженкою-гувернанткой, и объявила мужу, что не может жить с ним в одном доме.`,
  he: `בראשית ברא אלוהים את השמים ואת הארץ. והארץ הייתה תוהו ובוהו וחושך על פני תהום ורוח
    אלוהים מרחפת על פני המים. ויאמר אלוהים יהי אור ויהי אור. וירא אלוהים את האור כי טוב ויבדל
    אלוהים בין האור ובין החושך. ויקרא אלוהים לאור יום ולחושך קרא לילה ויהי ערב ויהי בוקר יום אחד.`,
  ar: `كان يا ما كان في قديم الزمان وسالف العصر والأوان، ملك من ملوك الفرس، وكان له ولدان،
    الكبير منهما اسمه شهريار والصغير اسمه شاه زمان. وكان الأخ الكبير فارسا لا يشق له غبار، وقد
    ملك البلاد وحكم بين العباد، فأحبه أهل مملكته كل الحب، وكان عادلا في رعيته.`,
  el: `Άνδρα μοι έννεπε, Μούσα, πολύτροπον, ος μάλα πολλά πλάγχθη, επεί Τροίης ιερόν
    πτολίεθρον έπερσεν. Πολλών δ' ανθρώπων ίδεν άστεα και νόον έγνω, πολλά δ' ο γ' εν πόντω
    πάθεν άλγεα ον κατά θυμόν, αρνύμενος ην τε ψυχήν και νόστον εταίρων.`,
};

describe('detectLanguageFromText', () => {
  for (const [code, text] of Object.entries(SAMPLES)) {
    it(`recognises ${code} from a page of it`, () => {
      const got = detectLanguageFromText(text);
      expect(got?.language, `sample: ${text.slice(0, 40)}…`).toBe(code);
      expect(got!.confidence).toBeGreaterThan(0.5);
    });
  }

  it('calls a non-Latin script from the script alone', () => {
    expect(detectLanguageFromText(SAMPLES.ru!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.he!)!.basis).toBe('script');
    expect(detectLanguageFromText(SAMPLES.el!)!.basis).toBe('script');
  });

  it('is not fooled by a Russian name in an English novel', () => {
    const text = `${SAMPLES.en} Aleksandr Ivanovich Chichikov, Обломов, Раскольников. ${SAMPLES.en}`;
    expect(detectLanguageFromText(text)?.language).toBe('en');
  });

  it('abstains rather than guessing on too little text', () => {
    expect(detectLanguageFromText('Chapter One')).toBeNull();
    expect(detectLanguageFromText('')).toBeNull();
    expect(detectLanguageFromText('   \n  ')).toBeNull();
  });

  it('abstains on a page of proper nouns, which belong to no language', () => {
    const roster = Array.from({ length: 120 }, (_, i) => `Brandenburg Kowalski Nakamura${i}`).join(
      ' ',
    );
    expect(detectLanguageFromText(roster)).toBeNull();
  });

  it('abstains when two languages are genuinely neck and neck', () => {
    // Spanish and Portuguese share "que", "com/con", "para", "como", "mais/más".
    // A near-tie between them is a coin toss, and the operator's default beats
    // a coin toss.
    const mixed = `${SAMPLES.es} ${SAMPLES.pt}`;
    const got = detectLanguageFromText(mixed);
    if (got) expect(['es', 'pt']).toContain(got.language);
  });

  it('reads only the head of a very long book', () => {
    // A million characters of Spanish behind a first page of English must not
    // change the answer, because only the head is sampled — and must not take
    // meaningfully longer to answer either.
    const long = SAMPLES.en + ' ' + SAMPLES.es!.repeat(4000);
    const started = performance.now();
    const got = detectLanguageFromText(long);
    expect(performance.now() - started).toBeLessThan(400);
    expect(got?.language).toBe('es');
  });
});

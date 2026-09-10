import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@versovox/shared';
import { api } from '../api/client';
import {
  type Annotation,
  type BookDetail,
  type ReaderManifest,
  type ResolveResponse,
  type SentenceIndexEntry,
} from '../lib/types';
import { recordCheckpoint, resumeLocator, setActiveLocatorProvider } from '../progress/engine';
import { Sheet, useToast } from '../components/ui';
import {
  IconBack,
  IconBookmark,
  IconCheck,
  IconClose,
  IconTrash,
  IconHeadphones,
  IconSearch,
  IconSun,
  IconToc,
  IconType,
} from '../components/icons';
import {
  buildTextMap,
  domToOffset,
  firstVisibleOffset,
  rangeForSpan,
  type TextMap,
} from './textmap';
import { liveCheckpointOffset } from './liveOffset';
import {
  computePageLayout,
  effectiveTheme,
  FONTS,
  loadPrefs,
  MARGINS,
  pageCountFor,
  savePrefs,
  SIZE_MAX,
  SIZE_MIN,
  type PageLayout,
  type ReaderPrefs,
} from './prefs';
import { formatDuration, formatPct } from '../lib/format';
import { applyAppThemeColor, setThemeColor } from '../lib/themeColor';

type SheetKind = 'none' | 'toc' | 'settings' | 'search' | 'note';

const DARK_MQ = '(prefers-color-scheme: dark)';

/** Reader page backgrounds, mirrored from tokens.css for the status bar. */
const THEME_BG: Record<ReturnType<typeof effectiveTheme>, string> = {
  paper: '#f6f1e8',
  sepia: '#f1e5cf',
  night: '#16120f',
  contrast: '#000000',
};

export function ReaderPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();

  const [manifest, setManifest] = useState<ReaderManifest | null>(null);
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [spineIdx, setSpineIdx] = useState<number>(-1);
  const [html, setHtml] = useState<string>('');
  const [sentences, setSentences] = useState<SentenceIndexEntry[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [prefs, setPrefs] = useState<ReaderPrefs>(loadPrefs);
  const [chrome, setChrome] = useState(true);
  const [sheet, setSheet] = useState<SheetKind>('none');
  const [page, setPage] = useState(0);
  const [pageCount, setPageCount] = useState(1);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selection, setSelection] = useState<{
    start: number;
    end: number;
    text: string;
    x: number;
    y: number;
  } | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  /** Mirror of currentOffsetRef for rendering: page turns set it, scroll updates it live. */
  const [liveOffset, setLiveOffset] = useState(0);
  /** Where the reader was before a jump (bookmark, contents, search, slider). */
  const [returnPoint, setReturnPoint] = useState<{
    spineIdx: number;
    charOffset: number;
    label: string;
  } | null>(null);
  const [contentsTab, setContentsTab] = useState<'toc' | 'marks'>('toc');

  const [systemDark, setSystemDark] = useState(
    () => typeof matchMedia === 'function' && matchMedia(DARK_MQ).matches,
  );

  const viewportRef = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textMapRef = useRef<TextMap | null>(null);
  const layoutRef = useRef<PageLayout | null>(null);
  const currentOffsetRef = useRef(0);
  const pendingTargetRef = useRef<{
    charOffset: number;
    sentenceId?: string;
    /** Element id inside the chapter (TOC sub-entries, footnotes). */
    fragment?: string;
    handoff?: boolean;
    granularity?: string;
  } | null>(null);
  const handoffCleanupRef = useRef<(() => void) | null>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);
  /** The next deliberate page turn re-claims progress for this session. */
  const needsClaimRef = useRef(true);

  const language = manifest?.language ?? null;
  // Direction from the OPF when declared; otherwise infer from the language
  // so a Hebrew/Arabic book without page-progression-direction still reads
  // right-to-left.
  const rtl =
    manifest?.direction === 'rtl' || (!manifest?.directionDeclared && isRtlLanguage(language));
  const dirFactor = rtl ? 1 : -1;

  /* ------------------------------------------------------------- loading */

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const [m, d, anns] = await Promise.all([
          api<ReaderManifest>(`/api/books/${id}/manifest`),
          api<BookDetail>(`/api/books/${id}`),
          api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(() => ({
            annotations: [] as Annotation[],
          })),
        ]);
        if (!alive) return;
        setManifest(m);
        setDetail(d);
        setAnnotations(anns.annotations);

        // Initial position: URL params > saved progress > beginning.
        const spineParam = searchParams.get('spine');
        const charParam = searchParams.get('char');
        const sentenceParam = searchParams.get('sentence');
        const handoff = searchParams.get('handoff') === '1';
        if (spineParam !== null) {
          const s = Math.min(Math.max(0, Number(spineParam) || 0), m.chapters.length - 1);
          pendingTargetRef.current = {
            charOffset: Number(charParam) || 0,
            sentenceId: sentenceParam ?? undefined,
            handoff,
            granularity: searchParams.get('granularity') ?? undefined,
          };
          setSpineIdx(s);
          void recordCheckpoint(id, handoff ? 'switch' : 'open', {
            medium: 'ebook',
            spineIdx: s,
            charOffset: Number(charParam) || 0,
            sentenceId: sentenceParam ?? undefined,
            pct: pctFor(m, s, Number(charParam) || 0),
          });
        } else {
          const resume = await resumeLocator(id);
          if (!alive) return;
          if (resume && resume.locator.medium === 'ebook') {
            const l = resume.locator;
            pendingTargetRef.current = { charOffset: l.charOffset ?? 0, sentenceId: l.sentenceId };
            setSpineIdx(Math.min(l.spineIdx, m.chapters.length - 1));
          } else {
            pendingTargetRef.current = { charOffset: 0 };
            setSpineIdx(0);
          }
          const openSpine = Math.min(
            (resume?.locator as EbookLocator | undefined)?.spineIdx ?? 0,
            m.chapters.length - 1,
          );
          const openChar = pendingTargetRef.current?.charOffset ?? 0;
          void recordCheckpoint(id, 'open', {
            medium: 'ebook',
            spineIdx: openSpine,
            charOffset: openChar,
            sentenceId: (resume?.locator as EbookLocator | undefined)?.sentenceId,
            pct: pctFor(m, openSpine, openChar),
          });
        }
      } catch {
        if (alive) setLoadError('Could not open this book. It may still be indexing.');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id]);

  // Load chapter content when spineIdx changes.
  useEffect(() => {
    if (spineIdx < 0 || !manifest) return;
    let alive = true;
    (async () => {
      try {
        const [res, sen] = await Promise.all([
          fetch(`/api/books/${id}/chapter/${spineIdx}`, {
            credentials: 'same-origin',
            headers: { 'x-vx-csrf': '1' },
          }),
          api<{ sentences: SentenceIndexEntry[] }>(`/api/books/${id}/sentences/${spineIdx}`).catch(
            () => ({ sentences: [] as SentenceIndexEntry[] }),
          ),
        ]);
        if (!res.ok) throw new Error(`chapter ${res.status}`);
        const text = await res.text();
        if (!alive) return;
        setSentences(sen.sentences);
        setHtml(text);
        setLoadError(null);
      } catch {
        if (alive) setLoadError('Could not load this chapter (offline and not downloaded?).');
      }
    })();
    return () => {
      alive = false;
    };
  }, [id, spineIdx, manifest]);

  /* -------------------------------------------------- layout + position */

  /**
   * Size the centred page box and the multi-column content for the current
   * viewport and prefs. Must run before any geometry is read: changing the
   * column count reflows the chapter.
   */
  const measureLayout = useCallback((): PageLayout | null => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    const pages = pagesRef.current;
    if (!viewport || !content || !pages) return null;
    const layout = computePageLayout(
      viewport.clientWidth,
      MARGINS[prefs.margin].padding,
      prefs.columns,
    );
    layoutRef.current = layout;
    pages.style.width = `${layout.width}px`;
    pages.style.left = `${layout.inset}px`;
    content.style.setProperty('--rd-cols', String(layout.columns));
    content.style.setProperty('--rd-colgap', `${layout.columnGap}px`);
    return layout;
  }, [prefs.margin, prefs.columns]);

  /** Re-measure and return the page count (also pushed to state). */
  const applyPagination = useCallback((): number => {
    const content = contentRef.current;
    if (!content) return 1;
    if (prefs.mode === 'paginated') {
      const layout = measureLayout();
      if (!layout) return 1;
      const count = pageCountFor(content.scrollWidth, layout);
      setPageCount(count);
      return count;
    }
    setPageCount(1);
    return 1;
  }, [prefs.mode, measureLayout]);

  /** Current rendered translateX of the paginated content (mid-transition safe). */
  const currentTx = (content: HTMLElement): number => {
    const t = getComputedStyle(content).transform;
    if (!t || t === 'none') return 0;
    const m = /matrix\(([^)]+)\)/.exec(t);
    return m ? parseFloat(m[1]!.split(',')[4] ?? '0') : 0;
  };

  /**
   * Page index containing a char offset. Measures against the content's
   * ACTUAL rendered transform, so it is correct even while a page-turn
   * transition is running (rects mid-animation would otherwise lie).
   */
  const pageForOffset = useCallback(
    (charOffset: number): number => {
      const pages = pagesRef.current;
      const content = contentRef.current;
      const map = textMapRef.current;
      const layout = layoutRef.current;
      if (!pages || !content || !map || !layout) return 0;
      const range = rangeForSpan(map, charOffset, charOffset + 1);
      if (!range) return 0;
      const tx = currentTx(content);
      const r = range.getBoundingClientRect();
      const base = pages.getBoundingClientRect();
      const delta = rtl ? base.right - (r.right - tx) : r.left - tx - base.left;
      return Math.max(0, Math.floor((delta + 2) / layout.stride));
    },
    [rtl],
  );

  const goToPage = useCallback(
    (n: number, intent: 'heartbeat' | 'seek' = 'heartbeat') => {
      const pages = pagesRef.current;
      const content = contentRef.current;
      const layout = layoutRef.current;
      if (!pages || !content || !manifest || !layout) return;
      const clamped = Math.max(0, Math.min(n, pageCount - 1));
      const targetTx = dirFactor * clamped * layout.stride;
      // Measure the target page's first visible offset in a way that is
      // independent of the in-flight transition: shift the page box by
      // the difference between the current rendered transform and the target.
      const tx = currentTx(content);
      content.style.transform = `translateX(${targetTx}px)`;
      setPage(clamped);
      const map = textMapRef.current;
      if (map) {
        const rect = pages.getBoundingClientRect();
        const shift = tx - targetTx;
        const off = firstVisibleOffset(map, {
          left: rect.left + shift,
          right: rect.right + shift,
          top: rect.top,
          bottom: rect.bottom,
        });
        if (off !== null) {
          currentOffsetRef.current = off;
          setLiveOffset(off);
          // A page turn is a deliberate act: the first one after this surface
          // (re)gained focus is recorded as an explicit intent so this
          // session holds the progress claim again (heartbeats from a
          // session that lost the claim to another device are ignored).
          const effective = needsClaimRef.current && intent === 'heartbeat' ? 'seek' : intent;
          needsClaimRef.current = false;
          void recordCheckpoint(id, effective, locatorAt(manifest, sentences, spineIdx, off));
        }
      }
    },
    [manifest, sentences, spineIdx, pageCount, dirFactor, id],
  );

  // Coming back to a backgrounded tab: re-claim on the next turn, and offer
  // to jump if another device moved further since.
  useEffect(() => {
    const onVisible = async () => {
      if (document.visibilityState !== 'visible' || !manifest) return;
      needsClaimRef.current = true;
      try {
        const resume = await resumeLocator(id);
        const l = resume?.locator;
        if (!l || l.medium !== 'ebook') return;
        const here = pctFor(manifest, spineIdx, currentOffsetRef.current);
        if (
          Math.abs(l.pct - here) > 0.005 &&
          (l.spineIdx !== spineIdx || l.charOffset !== currentOffsetRef.current)
        ) {
          toast.show(`Another device is at ${formatPct(l.pct)}`, {
            label: 'Jump there',
            onClick: () => {
              pendingTargetRef.current = {
                charOffset: l.charOffset ?? 0,
                sentenceId: l.sentenceId,
              };
              if (l.spineIdx === spineIdx)
                gotoChapterRef.current(spineIdx, l.charOffset ?? 0, 'seek');
              else setSpineIdx(Math.min(l.spineIdx, manifest.chapters.length - 1));
            },
          });
        }
      } catch {
        /* offline: nothing to reconcile */
      }
    };
    const handler = () => void onVisible();
    document.addEventListener('visibilitychange', handler);
    return () => document.removeEventListener('visibilitychange', handler);
  }, [manifest, id, spineIdx, toast]);

  // After chapter HTML renders: fix asset URLs, build text map, paginate,
  // jump to pending target, paint highlights.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !html || !manifest) return;
    for (const img of Array.from(content.querySelectorAll('img[src^="asset/"]'))) {
      img.setAttribute('src', `/api/books/${id}/${img.getAttribute('src')}`);
    }
    textMapRef.current = buildTextMap(content);
    const count = applyPagination();

    const target = pendingTargetRef.current;
    pendingTargetRef.current = null;
    const map = textMapRef.current;
    let charOffset = target?.charOffset ?? 0;
    if (target?.sentenceId) {
      const s = sentences.find((x) => x.id === target.sentenceId);
      if (s) charOffset = s.start;
    }
    if (target?.fragment && map) {
      const off = offsetForFragment(content, map, target.fragment);
      if (off !== null) charOffset = off;
    }
    currentOffsetRef.current = charOffset;
    setLiveOffset(charOffset);

    if (prefs.mode === 'paginated' && layoutRef.current) {
      // Find the page containing charOffset (transition-safe measurement).
      const clamped = Math.min(pageForOffset(charOffset), count - 1);
      content.style.transform = `translateX(${dirFactor * clamped * layoutRef.current.stride}px)`;
      setPage(clamped);
    } else if (map) {
      const range = rangeForSpan(map, charOffset, charOffset + 1);
      const scroller = scrollerRef.current;
      if (range && scroller) {
        const r = range.getBoundingClientRect();
        const base = scroller.getBoundingClientRect();
        scroller.scrollTop += r.top - base.top - 96;
      }
    }

    paintAnnotations(map, annotations, spineIdx);
    if (target?.handoff && target.sentenceId && map) {
      const s = sentences.find((x) => x.id === target.sentenceId);
      if (s) {
        handoffCleanupRef.current?.();
        handoffCleanupRef.current = paintHandoff(map, s.start, s.end);
        toast.show(
          target.granularity && target.granularity !== 'sentence'
            ? 'Continuing near your listening position'
            : 'Continuing from your listening position',
        );
      }
    }
  }, [
    html,
    prefs.mode,
    prefs.size,
    prefs.lineHeight,
    prefs.font,
    prefs.weight,
    prefs.margin,
    prefs.columns,
    prefs.align,
    prefs.hyphens,
  ]);

  // Re-paint highlights when annotations change.
  useEffect(() => {
    paintAnnotations(textMapRef.current, annotations, spineIdx);
  }, [annotations, spineIdx]);

  // Restore the current stable text anchor after a layout change, WITHOUT
  // recording progress: automatic reflow is not the reader moving.
  const restoreOffset = useCallback(
    (charOffset: number) => {
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!content || !map) return;
      if (prefs.mode === 'paginated') {
        const count = applyPagination();
        const layout = layoutRef.current;
        if (!layout) return;
        const clamped = Math.min(pageForOffset(charOffset), count - 1);
        content.style.transform = `translateX(${dirFactor * clamped * layout.stride}px)`;
        setPage(clamped);
      } else {
        const range = rangeForSpan(map, charOffset, charOffset + 1);
        const scroller = scrollerRef.current;
        if (range && scroller) {
          const r = range.getBoundingClientRect();
          const base = scroller.getBoundingClientRect();
          scroller.scrollTop += r.top - base.top - 96;
        }
      }
    },
    [prefs.mode, dirFactor, pageForOffset, applyPagination],
  );

  // Resize/orientation re-pagination: keep the reader on the sentence they
  // were on. Never page-zero, never a progress write.
  useEffect(() => {
    const onResize = () => restoreOffset(currentOffsetRef.current);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [restoreOffset]);

  // Follow the system appearance for the 'auto' theme.
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(DARK_MQ);
    const onChange = (e: MediaQueryListEvent) => setSystemDark(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  const theme = effectiveTheme(prefs.theme, systemDark);

  // Standalone iPhone: the status bar takes the page's theme-color, so the
  // reader paints it in its own theme and restores the app colour on exit.
  useEffect(() => {
    setThemeColor(THEME_BG[theme]);
    return () => applyAppThemeColor();
  }, [theme]);

  // Lifecycle persistence: expose the LIVE reading position so backgrounding
  // the tab records it even inside the scroll debounce window. In scroll
  // mode the offset is computed synchronously from live scroll geometry at
  // checkpoint time — the debounced ref may be up to 600ms stale.
  useEffect(() => {
    if (!manifest) return;
    return setActiveLocatorProvider(() => {
      const off = liveCheckpointOffset(
        prefs.mode,
        currentOffsetRef.current,
        textMapRef.current,
        scrollerRef.current,
      );
      currentOffsetRef.current = off;
      return { bookId: id, locator: locatorAt(manifest, sentences, spineIdx, off) };
    });
  }, [manifest, sentences, spineIdx, id, prefs.mode]);

  // Scroll-mode position tracking.
  useEffect(() => {
    if (prefs.mode !== 'scroll') return;
    const scroller = scrollerRef.current;
    if (!scroller || !manifest) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let footerTimer: ReturnType<typeof setTimeout> | null = null;
    const onScroll = () => {
      // Footer: cheap, throttled to ~12 updates/s (a timer, not rAF, so a
      // backgrounded tab still lands on the right value when it returns).
      if (!footerTimer) {
        footerTimer = setTimeout(() => {
          footerTimer = null;
          const map = textMapRef.current;
          if (!map) return;
          const off = firstVisibleOffset(map, scroller.getBoundingClientRect());
          if (off !== null) setLiveOffset(off);
        }, 80);
      }
      // Progress checkpoint: debounced.
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        const map = textMapRef.current;
        if (!map) return;
        const rect = scroller.getBoundingClientRect();
        const off = firstVisibleOffset(map, rect);
        if (off !== null && Math.abs(off - currentOffsetRef.current) > 40) {
          currentOffsetRef.current = off;
          void recordCheckpoint(id, 'heartbeat', locatorAt(manifest, sentences, spineIdx, off));
        }
      }, 600);
    };
    scroller.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      scroller.removeEventListener('scroll', onScroll);
      if (timer) clearTimeout(timer);
      if (footerTimer) clearTimeout(footerTimer);
    };
  }, [prefs.mode, manifest, sentences, spineIdx, id, html]);

  /* ----------------------------------------------------------- actions */

  const gotoChapter = useCallback(
    (s: number, charOffset = 0, intent: 'seek' | 'open' = 'seek', fragment?: string) => {
      if (!manifest) return;
      const clamped = Math.max(0, Math.min(s, manifest.chapters.length - 1));
      // A jump of more than a page away leaves a way back.
      if (
        intent === 'seek' &&
        (clamped !== spineIdx || Math.abs(charOffset - currentOffsetRef.current) > 400)
      ) {
        const fromTitle = manifest.chapters[spineIdx]?.title ?? `Chapter ${spineIdx + 1}`;
        setReturnPoint(
          (rp) => rp ?? { spineIdx, charOffset: currentOffsetRef.current, label: fromTitle },
        );
      }
      handoffCleanupRef.current?.();
      pendingTargetRef.current = { charOffset, fragment };
      if (clamped === spineIdx) {
        // Same chapter: jump directly without re-rendering the HTML.
        const map = textMapRef.current;
        const content = contentRef.current;
        if (map && content) {
          pendingTargetRef.current = null;
          if (fragment) {
            const off = offsetForFragment(content, map, fragment);
            if (off !== null) charOffset = off;
          }
          currentOffsetRef.current = charOffset;
          if (prefs.mode === 'paginated') {
            goToPage(pageForOffset(charOffset), 'seek');
          } else {
            const range = rangeForSpan(map, charOffset, charOffset + 1);
            const scroller = scrollerRef.current;
            if (range && scroller) {
              const r = range.getBoundingClientRect();
              const base = scroller.getBoundingClientRect();
              scroller.scrollTop += r.top - base.top - 96;
            }
          }
        }
      } else {
        setSpineIdx(clamped);
      }
      void recordCheckpoint(id, intent, locatorAt(manifest, sentences, clamped, charOffset));
    },
    [manifest, spineIdx, prefs.mode, goToPage, pageForOffset, sentences, id],
  );
  const gotoChapterRef = useRef(gotoChapter);
  gotoChapterRef.current = gotoChapter;

  const nextPage = useCallback(() => {
    if (prefs.mode === 'scroll') {
      const s = scrollerRef.current;
      if (s) s.scrollTop += s.clientHeight * 0.9;
      return;
    }
    if (page < pageCount - 1) goToPage(page + 1);
    else if (manifest && spineIdx < manifest.chapters.length - 1) gotoChapter(spineIdx + 1, 0);
    else if (manifest) {
      // Turning past the last page of the last chapter: the book is finished.
      const last = Math.max(0, (manifest.chapters[spineIdx]?.charCount ?? 1) - 1);
      void recordCheckpoint(id, 'finish', {
        ...locatorAt(manifest, sentences, spineIdx, last),
        pct: 1,
      });
      toast.show('The End — marked as finished');
    }
  }, [
    prefs.mode,
    page,
    pageCount,
    manifest,
    spineIdx,
    goToPage,
    gotoChapter,
    id,
    sentences,
    toast,
  ]);

  const prevPage = useCallback(() => {
    if (prefs.mode === 'scroll') {
      const s = scrollerRef.current;
      if (s) s.scrollTop -= s.clientHeight * 0.9;
      return;
    }
    if (page > 0) goToPage(page - 1);
    else if (spineIdx > 0 && manifest) {
      // Land on the previous chapter's end.
      pendingTargetRef.current = {
        charOffset: Math.max(0, (manifest.chapters[spineIdx - 1]?.charCount ?? 1) - 2),
      };
      setSpineIdx(spineIdx - 1);
    }
  }, [prefs.mode, page, spineIdx, manifest, goToPage]);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (sheet !== 'none') return;
      const fwd = rtl ? 'ArrowLeft' : 'ArrowRight';
      const back = rtl ? 'ArrowRight' : 'ArrowLeft';
      if (e.key === fwd || e.key === ' ' || e.key === 'PageDown') {
        e.preventDefault();
        nextPage();
      } else if (e.key === back || e.key === 'PageUp') {
        e.preventDefault();
        prevPage();
      } else if (e.key === 'Escape') {
        navigate(`/book/${id}`);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [nextPage, prevPage, sheet, navigate, id, rtl]);

  // Selection handling.
  useEffect(() => {
    const onUp = () => {
      const sel = document.getSelection();
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!sel || sel.isCollapsed || !content || !map) {
        setSelection(null);
        return;
      }
      if (!content.contains(sel.anchorNode) || !content.contains(sel.focusNode)) return;
      const range = sel.getRangeAt(0);
      const start = domToOffset(map, range.startContainer, range.startOffset);
      const end = domToOffset(map, range.endContainer, range.endOffset);
      if (start === null || end === null || end <= start) return;
      const rect = range.getBoundingClientRect();
      setSelection({
        start,
        end,
        text: sel.toString().slice(0, 500),
        x: Math.max(12, Math.min(rect.left + rect.width / 2, window.innerWidth - 150)),
        y: Math.max(70, rect.top - 48),
      });
    };
    const onSelectionChange = () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    };
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', onSelectionChange);
    return () => {
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('selectionchange', onSelectionChange);
    };
  }, []);

  const addAnnotation = useCallback(
    async (kind: 'highlight' | 'bookmark' | 'note', note?: string) => {
      if (!manifest) return;
      const sel = selection;
      const start = sel?.start ?? currentOffsetRef.current;
      const end = sel?.end ?? start;
      const sent = sentences.find((s) => start >= s.start && start < s.end);
      const body = {
        kind,
        locator: {
          medium: 'ebook',
          spineIdx,
          charOffset: start,
          sentenceId: sent?.id,
          pct: pctFor(manifest, spineIdx, start),
        },
        endLocator:
          end > start
            ? { medium: 'ebook', spineIdx, charOffset: end, pct: pctFor(manifest, spineIdx, end) }
            : null,
        color: kind === 'highlight' ? 'leaf' : null,
        selectedText: sel?.text ?? null,
        note: note ?? null,
      };
      try {
        const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
          method: 'POST',
          body,
        });
        setAnnotations((a) => [...a, res.annotation]);
        toast.show(
          kind === 'bookmark' ? 'Bookmarked' : kind === 'note' ? 'Note saved' : 'Highlighted',
        );
        setSelection(null);
        document.getSelection()?.removeAllRanges();
      } catch {
        toast.show('Could not save — are you offline?');
      }
    },
    [manifest, selection, sentences, spineIdx, id, toast],
  );

  /** Bookmarks in this chapter, with "is it on the page I am looking at". */
  const bookmarks = annotations.filter(
    (a) => a.kind === 'bookmark' && a.locator.medium === 'ebook',
  );
  const bookmarkOnPage = (a: Annotation): boolean => {
    if (a.locator.medium !== 'ebook' || a.locator.spineIdx !== spineIdx) return false;
    const off = a.locator.charOffset ?? 0;
    if (prefs.mode === 'paginated') return pageForOffset(off) === page;
    const map = textMapRef.current;
    const scroller = scrollerRef.current;
    if (!map || !scroller) return false;
    const r = rangeForSpan(map, off, off + 1)?.getBoundingClientRect();
    const box = scroller.getBoundingClientRect();
    return !!r && r.top >= box.top - 4 && r.top <= box.bottom;
  };
  const currentBookmark = bookmarks.find(bookmarkOnPage) ?? null;

  const toggleBookmark = useCallback(async () => {
    if (!manifest) return;
    if (currentBookmark) {
      try {
        await api(`/api/annotations/${currentBookmark.id}`, { method: 'DELETE' });
        setAnnotations((a) => a.filter((x) => x.id !== currentBookmark.id));
        toast.show('Bookmark removed');
      } catch {
        toast.show('Could not remove the bookmark — are you offline?');
      }
      return;
    }
    // Bookmark the first sentence on this page, keeping its text so the
    // list is readable later.
    const start = currentOffsetRef.current;
    const sent =
      sentences.find((s) => start >= s.start && start < s.end) ??
      sentences.find((s) => s.start >= start);
    const map = textMapRef.current;
    const excerpt =
      sent && map
        ? (rangeForSpan(map, sent.start, sent.end)?.toString().trim().slice(0, 240) ?? null)
        : null;
    const body = {
      kind: 'bookmark',
      locator: {
        medium: 'ebook',
        spineIdx,
        charOffset: sent?.start ?? start,
        sentenceId: sent?.id,
        pct: pctFor(manifest, spineIdx, sent?.start ?? start),
      },
      selectedText: excerpt,
    };
    try {
      const res = await api<{ annotation: Annotation }>(`/api/books/${id}/annotations`, {
        method: 'POST',
        body,
      });
      setAnnotations((a) => [...a, res.annotation]);
      toast.show(
        prefs.mode === 'paginated' ? `Bookmarked page ${page + 1}` : 'Bookmarked this passage',
        {
          label: 'Bookmarks',
          onClick: () => {
            setContentsTab('marks');
            setSheet('toc');
          },
        },
      );
    } catch {
      toast.show('Could not save — are you offline?');
    }
  }, [manifest, currentBookmark, sentences, spineIdx, page, prefs.mode, id, toast]);

  const deleteAnnotation = useCallback(
    async (annId: string) => {
      try {
        await api(`/api/annotations/${annId}`, { method: 'DELETE' });
        setAnnotations((a) => a.filter((x) => x.id !== annId));
      } catch {
        toast.show('Could not delete — are you offline?');
      }
    },
    [toast],
  );

  const switchToAudio = useCallback(async () => {
    if (!detail?.book.pair || !manifest) return;
    const sent = sentences.find(
      (s) => currentOffsetRef.current >= s.start && currentOffsetRef.current < s.end,
    );
    const from: EbookLocator = {
      medium: 'ebook',
      spineIdx,
      sentenceId: sent?.id,
      charOffset: currentOffsetRef.current,
      pct: pctFor(manifest, spineIdx, currentOffsetRef.current),
    };
    try {
      const res = await api<ResolveResponse>(`/api/pairs/${detail.book.pair.pairId}/resolve`, {
        method: 'POST',
        body: { from },
      });
      if (!res.to || res.to.medium !== 'audio') {
        // Never silently cross an alignment gap: explain, and point at the
        // nearest verified aligned narration instead.
        const anchor = res.anchors?.before ?? res.anchors?.after;
        const extra =
          anchor && anchor.to.medium === 'audio'
            ? ` Nearest aligned narration: ${formatDuration(anchor.to.bookMs ?? anchor.to.positionMs)}.`
            : '';
        toast.show((res.resolution.reason ?? 'No aligned audio position here.') + extra);
        return;
      }
      void recordCheckpoint(id, 'switch', from);
      const to = res.to as AudioLocator;
      navigate(
        `/listen/${detail.book.pair.otherBookId}?track=${to.trackIdx}&pos=${to.positionMs}&handoff=1&granularity=${res.resolution.granularity}`,
      );
    } catch {
      toast.show('Switching failed — server unreachable?');
    }
  }, [detail, manifest, sentences, spineIdx, id, navigate, toast]);

  /* ------------------------------------------------------------- render */

  if (loadError) {
    return (
      <div className="reader-page" data-reader-theme={theme}>
        <div className="empty-state" style={{ margin: 'auto' }}>
          <h2>Cannot open book</h2>
          <p>{loadError}</p>
          <Link className="btn btn--secondary" to={`/book/${id}`}>
            Back to details
          </Link>
        </div>
      </div>
    );
  }

  const chapterTitle =
    manifest?.chapters[spineIdx]?.title ??
    manifest?.toc.find((t) => t.spineIdx === spineIdx)?.title ??
    manifest?.title ??
    '';
  const bookPct = manifest ? pctFor(manifest, spineIdx, liveOffset) : 0;
  const chapterPct = (() => {
    const ch = manifest?.chapters[spineIdx];
    if (!ch || ch.charCount === 0) return 0;
    return Math.min(1, Math.max(0, liveOffset / ch.charCount));
  })();
  const margins = MARGINS[prefs.margin];
  const pagesLeft = Math.max(0, pageCount - page - 1);

  return (
    <div
      className={`reader-page ${chrome ? '' : 'chrome-hidden'}`}
      data-reader-theme={theme}
      style={
        {
          '--rd-font': FONTS[prefs.font].stack,
          '--rd-size': `${prefs.size}px`,
          '--rd-weight': prefs.weight,
          '--rd-leading': prefs.lineHeight,
          '--rd-margin': `${margins.padding}px`,
          '--rd-measure': margins.measure,
          '--rd-align': prefs.align,
          '--rd-hyphens': prefs.hyphens ? 'auto' : 'manual',
        } as React.CSSProperties
      }
    >
      <div className="immersive-chrome immersive-chrome--top">
        <button
          className="icon-btn"
          onClick={() => navigate(`/book/${id}`)}
          aria-label="Back to book"
        >
          <IconBack />
        </button>
        <span className="reader-title">{chapterTitle}</span>
        <button className="icon-btn" onClick={() => setSheet('toc')} aria-label="Table of contents">
          <IconToc />
        </button>
        <button className="icon-btn" onClick={() => setSheet('search')} aria-label="Search in book">
          <IconSearch />
        </button>
        <button
          className={`icon-btn ${currentBookmark ? 'is-marked' : ''}`}
          onClick={() => void toggleBookmark()}
          aria-pressed={!!currentBookmark}
          aria-label={currentBookmark ? 'Remove bookmark from this page' : 'Bookmark this page'}
        >
          <IconBookmark filled={!!currentBookmark} />
        </button>
        <button
          className="icon-btn"
          onClick={() => setSheet('settings')}
          aria-label="Reading settings"
        >
          <IconType />
        </button>
      </div>

      <div className="reader-viewport" ref={viewportRef} dir={rtl ? 'rtl' : 'ltr'}>
        {currentBookmark && (
          <svg className="reader-ribbon" viewBox="0 0 22 34" aria-hidden="true">
            <path d="M0 0h22v34l-11-8-11 8z" fill="currentColor" />
          </svg>
        )}
        {prefs.mode === 'paginated' ? (
          <>
            <button
              className="tapzone tapzone--prev"
              aria-label="Previous page"
              onClick={prevPage}
              tabIndex={-1}
            />
            <button
              className="tapzone tapzone--next"
              aria-label="Next page"
              onClick={nextPage}
              tabIndex={-1}
            />
            <div className="reader-pages" ref={pagesRef}>
              <div
                ref={contentRef}
                className="reader-content reader-content--paginated"
                style={{
                  transition: 'transform 200ms var(--vx-ease)',
                  padding: `calc(72px + var(--vx-safe-top)) ${margins.padding}px calc(64px + var(--vx-safe-bottom))`,
                }}
                onPointerDown={(e) => {
                  swipeRef.current = { x: e.clientX, y: e.clientY, t: Date.now() };
                  handoffCleanupRef.current?.();
                }}
                onPointerUp={(e) => {
                  const sw = swipeRef.current;
                  swipeRef.current = null;
                  if (!sw) return;
                  const dx = e.clientX - sw.x;
                  const dy = e.clientY - sw.y;
                  if (Math.abs(dx) > 48 && Math.abs(dy) < 60 && Date.now() - sw.t < 600) {
                    const backward = rtl ? dx < 0 : dx > 0;
                    if (backward) prevPage();
                    else nextPage();
                  } else if (
                    Math.abs(dx) < 8 &&
                    Math.abs(dy) < 8 &&
                    !(e.target as Element).closest('a')
                  ) {
                    const sel = document.getSelection();
                    if (sel && !sel.isCollapsed) return;
                    setChrome((c) => !c);
                  }
                }}
                onClick={(e) => interceptLink(e, manifest, spineIdx, gotoChapter)}
                lang={language ?? undefined}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          </>
        ) : (
          <div className="reader-scroller" ref={scrollerRef}>
            <div
              ref={contentRef}
              className="reader-content"
              onClick={(e) => {
                if ((e.target as Element).closest('a')) {
                  interceptLink(e, manifest, spineIdx, gotoChapter);
                  return;
                }
                const sel = document.getSelection();
                if (sel && !sel.isCollapsed) return;
                setChrome((c) => !c);
              }}
              onPointerDown={() => handoffCleanupRef.current?.()}
              lang={language ?? undefined}
              dangerouslySetInnerHTML={{ __html: html }}
            />
            {manifest && html && (
              <div className="reader-chapter-end" dir={rtl ? 'rtl' : 'ltr'}>
                {spineIdx < manifest.chapters.length - 1 ? (
                  <button
                    className="btn btn--secondary"
                    onClick={() => gotoChapter(spineIdx + 1, 0)}
                  >
                    Next: {manifest.chapters[spineIdx + 1]?.title ?? `Chapter ${spineIdx + 2}`}
                  </button>
                ) : (
                  <button className="btn btn--secondary" onClick={nextPage}>
                    Finish book
                  </button>
                )}
              </div>
            )}
          </div>
        )}
        {!html && !loadError && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <div className="spinner" role="status" aria-label="Loading chapter" />
          </div>
        )}
      </div>

      {returnPoint && (
        <button
          className="return-pill"
          onClick={() => {
            const rp = returnPoint;
            setReturnPoint(null);
            pendingTargetRef.current = { charOffset: rp.charOffset };
            if (rp.spineIdx === spineIdx) gotoChapter(spineIdx, rp.charOffset, 'seek');
            else setSpineIdx(rp.spineIdx);
          }}
        >
          <IconBack size={15} /> Back to where you were · {returnPoint.label}
          <span
            className="return-pill__x"
            role="button"
            aria-label="Dismiss"
            onClick={(e) => {
              e.stopPropagation();
              setReturnPoint(null);
            }}
          >
            <IconClose size={14} />
          </span>
        </button>
      )}
      {prefs.brightness < 0.995 && (
        <div className="reader-dim" style={{ opacity: 1 - prefs.brightness }} aria-hidden="true" />
      )}

      {selection && (
        <div
          className="selection-menu"
          style={{ left: selection.x - 60, top: selection.y }}
          role="menu"
        >
          <button onClick={() => void addAnnotation('highlight')}>Highlight</button>
          <button
            onClick={() => {
              setNoteDraft('');
              setSheet('note');
            }}
          >
            Note
          </button>
          <button onClick={() => void addAnnotation('bookmark')}>Bookmark here</button>
        </div>
      )}

      <div
        className={`immersive-chrome immersive-chrome--bottom immersive-chrome--bar-${prefs.progressBar}`}
      >
        {prefs.progressBar === 'full' && (
          <input
            className="slider"
            style={{ color: 'var(--rd-link)' }}
            type="range"
            min={0}
            max={1000}
            value={Math.round(bookPct * 1000)}
            aria-label="Book position"
            onChange={(e) => {
              if (!manifest) return;
              const pct = Number(e.target.value) / 1000;
              const targetChars = pct * manifest.totalChars;
              let s = 0;
              for (const c of manifest.chapters) {
                if (c.cumChars <= targetChars) s = c.idx;
                else break;
              }
              const within = Math.max(0, Math.floor(targetChars - manifest.chapters[s]!.cumChars));
              gotoChapter(s, within);
            }}
          />
        )}
        <div className="reader-footer-row">
          {prefs.progressBar === 'full' && (
            <span>
              {prefs.mode === 'paginated'
                ? pagesLeft === 0
                  ? pageCount === 1
                    ? 'Whole chapter on this page'
                    : 'Last page in chapter'
                  : `${pagesLeft} ${pagesLeft === 1 ? 'page' : 'pages'} left in chapter`
                : chapterTitle}
            </span>
          )}
          {prefs.progressBar === 'compact' && (
            <span
              className="reader-minibar"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(bookPct * 100)}
              aria-label="Book position"
              title={`${chapterTitle} · chapter ${formatPct(chapterPct)}`}
            >
              <span style={{ width: `${bookPct * 100}%` }} />
              <i style={{ insetInlineStart: `${bookPct * 100}%` }} aria-hidden="true" />
            </span>
          )}
          <span className="grow" />
          {detail?.book.pair && detail.book.pair.status !== 'candidate' && (
            <button
              className="tandem-pill"
              onClick={() => void switchToAudio()}
              disabled={!detail.book.pair.switchable}
              title={
                detail.book.pair.switchable
                  ? 'Switch to the audiobook at this sentence'
                  : 'Alignment not ready — switching unavailable'
              }
            >
              <IconHeadphones size={17} />
              <span>
                {detail.book.pair.switchable ? 'Listen from here' : 'Audio · aligning…'}
                <small />
              </span>
            </button>
          )}
          {prefs.progressBar !== 'hidden' && <span>{formatPct(bookPct)}</span>}
        </div>
      </div>

      {sheet === 'toc' && manifest && (
        <Sheet title="Contents" onClose={() => setSheet('none')}>
          <div className="sheet-tabs" role="tablist" style={{ margin: '-16px -16px 8px' }}>
            <button
              role="tab"
              aria-selected={contentsTab === 'toc'}
              onClick={() => setContentsTab('toc')}
            >
              Chapters
            </button>
            <button
              role="tab"
              aria-selected={contentsTab === 'marks'}
              onClick={() => setContentsTab('marks')}
            >
              Bookmarks & notes
              {annotations.length > 0 ? ` · ${annotations.length}` : ''}
            </button>
          </div>
          {contentsTab === 'marks' &&
            (annotations.length === 0 ? (
              <p style={{ color: 'var(--vx-text-soft)' }}>
                No bookmarks yet. Tap the ribbon icon while reading to mark a page; select text to
                highlight or add a note.
              </p>
            ) : (
              [...annotations]
                .sort((a, b) => a.locator.pct - b.locator.pct)
                .map((a) => (
                  <div
                    key={a.id}
                    className="bm-row"
                    role="button"
                    tabIndex={0}
                    onClick={() => {
                      if (a.locator.medium !== 'ebook') return;
                      setSheet('none');
                      gotoChapter(a.locator.spineIdx, a.locator.charOffset ?? 0, 'seek');
                    }}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && a.locator.medium === 'ebook') {
                        setSheet('none');
                        gotoChapter(a.locator.spineIdx, a.locator.charOffset ?? 0, 'seek');
                      }
                    }}
                  >
                    <span className="bm-row__icon">
                      <IconBookmark size={16} filled={a.kind === 'bookmark'} />
                    </span>
                    <span className="bm-row__body">
                      <span className="bm-row__where">
                        {a.kind === 'bookmark'
                          ? 'Bookmark'
                          : a.kind === 'note'
                            ? 'Note'
                            : 'Highlight'}{' '}
                        ·{' '}
                        {manifest.chapters[a.locator.medium === 'ebook' ? a.locator.spineIdx : 0]
                          ?.title ?? 'Chapter'}{' '}
                        · {formatPct(a.locator.pct)}
                      </span>
                      <span className="bm-row__text">
                        {a.selectedText ?? a.note ?? 'Bookmarked page'}
                        {a.kind === 'note' && a.note && a.selectedText ? ` — ${a.note}` : ''}
                      </span>
                    </span>
                    <button
                      className="icon-btn bm-row__delete"
                      style={{ width: 36, height: 36 }}
                      aria-label="Delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        void deleteAnnotation(a.id);
                      }}
                    >
                      <IconTrash size={15} />
                    </button>
                  </div>
                ))
            ))}
          {contentsTab === 'toc' && manifest.toc.length === 0 && (
            <p>No table of contents in this book.</p>
          )}
          {contentsTab === 'toc' &&
            manifest.toc.map((t, i) => (
              <button
                key={i}
                className="list-row"
                style={{ paddingInlineStart: 16 + t.depth * 16 }}
                aria-current={t.spineIdx === spineIdx ? 'true' : undefined}
                onClick={() => {
                  setSheet('none');
                  gotoChapter(t.spineIdx, 0, 'seek', t.fragment ?? undefined);
                }}
              >
                <span className="grow">{t.title}</span>
              </button>
            ))}
        </Sheet>
      )}

      {sheet === 'settings' && (
        <ReaderSettingsSheet
          prefs={prefs}
          onChange={(p) => {
            setPrefs(p);
            savePrefs(p);
            pendingTargetRef.current = { charOffset: currentOffsetRef.current };
          }}
          onClose={() => setSheet('none')}
        />
      )}

      {sheet === 'search' && (
        <SearchSheet
          bookId={id}
          onClose={() => setSheet('none')}
          onJump={(s, off) => {
            setSheet('none');
            gotoChapter(s, off);
          }}
        />
      )}

      {sheet === 'note' && (
        <Sheet title="Add note" onClose={() => setSheet('none')}>
          {selection && (
            <blockquote style={{ color: 'var(--vx-text-soft)', fontSize: 14, margin: '0 0 12px' }}>
              “{selection.text.slice(0, 160)}
              {selection.text.length > 160 ? '…' : ''}”
            </blockquote>
          )}
          <div className="field">
            <label htmlFor="note-text">Note</label>
            <textarea
              id="note-text"
              className="input"
              rows={4}
              style={{ paddingBlock: 10, resize: 'vertical' }}
              value={noteDraft}
              onChange={(e) => setNoteDraft(e.target.value)}
            />
          </div>
          <button
            className="btn"
            onClick={() => {
              void addAnnotation('note', noteDraft);
              setSheet('none');
            }}
          >
            Save note
          </button>
        </Sheet>
      )}
    </div>
  );
}

/* -------------------------------------------------------------- helpers */

function pctFor(manifest: ReaderManifest, spineIdx: number, charOffset: number): number {
  const ch = manifest.chapters[spineIdx];
  if (!ch || manifest.totalChars === 0) return 0;
  return Math.min(1, Math.max(0, (ch.cumChars + charOffset) / manifest.totalChars));
}

function locatorAt(
  manifest: ReaderManifest,
  sentences: SentenceIndexEntry[],
  spineIdx: number,
  charOffset: number,
): EbookLocator {
  const sent = sentences.find((s) => charOffset >= s.start && charOffset < s.end);
  return {
    medium: 'ebook',
    spineIdx,
    charOffset,
    sentenceId: sent?.id,
    pct: pctFor(manifest, spineIdx, charOffset),
  };
}

function interceptLink(
  e: React.MouseEvent,
  manifest: ReaderManifest | null,
  currentSpine: number,
  gotoChapter: (s: number, off: number, intent?: 'seek' | 'open', fragment?: string) => void,
): void {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const internal = a.getAttribute('data-vx-href');
  if (internal) {
    e.preventDefault();
    const [file, frag] = internal.split('#');
    // "#fn3" (same document) or "chapter.xhtml#fn3" (cross-chapter).
    const target = file ? manifest?.chapters.find((c) => c.href === file) : undefined;
    const spine = target ? target.idx : file ? -1 : currentSpine;
    if (spine >= 0) gotoChapter(spine, 0, 'seek', frag || undefined);
  } else if ((a.getAttribute('href') ?? '').startsWith('#')) {
    e.preventDefault();
    const frag = (a.getAttribute('href') ?? '').slice(1);
    if (frag) gotoChapter(currentSpine, 0, 'seek', frag);
  }
}

/** Character offset of the element with `id` (or `name`) inside the chapter. */
function offsetForFragment(content: HTMLElement, map: TextMap, fragment: string): number | null {
  let el: Element | null = null;
  try {
    el = content.querySelector(`[id="${CSS.escape(fragment)}"], a[name="${CSS.escape(fragment)}"]`);
  } catch {
    el = null;
  }
  if (!el) return null;
  // First text node at or after the element.
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
  let node: Node | null = walker.nextNode();
  while (node) {
    if (el.contains(node) || el.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) {
      const off = domToOffset(map, node, 0);
      if (off !== null) return off;
    }
    node = walker.nextNode();
  }
  return null;
}

const RTL_LANGS = new Set(['he', 'iw', 'ar', 'fa', 'ur', 'yi', 'ps', 'sd', 'ug', 'dv']);
function isRtlLanguage(lang: string | null): boolean {
  if (!lang) return false;
  return RTL_LANGS.has(lang.toLowerCase().split(/[-_]/)[0]!);
}

type HighlightApi = {
  highlights?: Map<string, unknown> & { set(k: string, v: unknown): void; delete(k: string): void };
};

function paintAnnotations(map: TextMap | null, annotations: Annotation[], spineIdx: number): void {
  const css = CSS as unknown as HighlightApi;
  if (!map || !css.highlights || typeof Highlight === 'undefined') return;
  const ranges: Range[] = [];
  for (const a of annotations) {
    if (a.kind !== 'highlight' && a.kind !== 'note') continue;
    if (a.locator.medium !== 'ebook' || a.locator.spineIdx !== spineIdx) continue;
    const start = a.locator.charOffset ?? 0;
    const end =
      a.endLocator?.medium === 'ebook' ? (a.endLocator.charOffset ?? start + 1) : start + 1;
    const r = rangeForSpan(map, start, end);
    if (r) ranges.push(r);
  }
  if (ranges.length > 0) {
    css.highlights.set('vx-h', new Highlight(...ranges));
  } else {
    css.highlights.delete('vx-h');
  }
}

function paintHandoff(map: TextMap, start: number, end: number): () => void {
  const css = CSS as unknown as HighlightApi;
  if (!css.highlights || typeof Highlight === 'undefined') return () => {};
  const r = rangeForSpan(map, start, end);
  if (!r) return () => {};
  css.highlights.set('vx-handoff', new Highlight(r));
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    setTimeout(() => css.highlights!.delete('vx-handoff'), 400);
  };
  setTimeout(clear, 12000);
  return clear;
}

/* --------------------------------------------------------------- sheets */

function ReaderSettingsSheet({
  prefs,
  onChange,
  onClose,
}: {
  prefs: ReaderPrefs;
  onChange: (p: ReaderPrefs) => void;
  onClose: () => void;
}) {
  const set = <K extends keyof ReaderPrefs>(k: K, v: ReaderPrefs[K]) =>
    onChange({ ...prefs, [k]: v });
  const themes: { value: ReaderPrefs['theme']; label: string }[] = [
    { value: 'auto', label: 'Auto' },
    { value: 'paper', label: 'Paper' },
    { value: 'sepia', label: 'Sepia' },
    { value: 'night', label: 'Night' },
    { value: 'contrast', label: 'Contrast' },
  ];
  return (
    <Sheet title="Reading settings" onClose={onClose}>
      <div className="rs-group" role="group" aria-label="Theme">
        <div className="rs-themes">
          {themes.map((t) => (
            <button
              key={t.value}
              className={`rs-swatch rs-swatch--${t.value}`}
              aria-pressed={prefs.theme === t.value}
              aria-label={`${t.label} theme`}
              onClick={() => set('theme', t.value)}
            >
              <span className="rs-swatch__disc" aria-hidden="true">
                Aa
              </span>
              <span className="rs-swatch__label">{t.label}</span>
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-size" role="group" aria-label="Text size">
          <button
            className="rs-size__btn"
            style={{ fontSize: 17 }}
            aria-label="Smaller text"
            disabled={prefs.size <= SIZE_MIN}
            onClick={() => set('size', Math.max(SIZE_MIN, prefs.size - 1))}
          >
            A
          </button>
          <span className="rs-size__value" aria-live="polite">
            {prefs.size}
            <small>px</small>
          </span>
          <button
            className="rs-size__btn"
            style={{ fontSize: 26 }}
            aria-label="Larger text"
            disabled={prefs.size >= SIZE_MAX}
            onClick={() => set('size', Math.min(SIZE_MAX, prefs.size + 1))}
          >
            A
          </button>
        </div>
        <label className="rs-slider" htmlFor="rs-dim">
          <IconSun size={16} style={{ opacity: 0.55 }} />
          <input
            id="rs-dim"
            className="slider"
            type="range"
            min={0.35}
            max={1}
            step={0.05}
            value={prefs.brightness}
            aria-label="Page brightness"
            onChange={(e) => set('brightness', Number(e.target.value))}
          />
          <IconSun size={22} />
        </label>
      </div>

      <div className="rs-group" role="group" aria-label="Font">
        <div className="rs-label">Font</div>
        <div className="rs-fonts">
          {(Object.keys(FONTS) as (keyof typeof FONTS)[]).map((k) => (
            <button
              key={k}
              className="rs-font"
              aria-pressed={prefs.font === k}
              style={{ fontFamily: FONTS[k].stack }}
              onClick={() => set('font', k)}
            >
              <span className="rs-font__sample" aria-hidden="true">
                Aa
              </span>
              <span className="rs-font__name">
                {FONTS[k].label}
                <small>{FONTS[k].note}</small>
              </span>
              {prefs.font === k && <IconCheck size={18} />}
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-label">Layout</div>
        <div className="segmented" role="group" aria-label="Layout mode">
          <button
            aria-pressed={prefs.mode === 'paginated'}
            onClick={() => set('mode', 'paginated')}
          >
            Pages
          </button>
          <button aria-pressed={prefs.mode === 'scroll'} onClick={() => set('mode', 'scroll')}>
            Scroll
          </button>
        </div>
        <div className="rs-label" style={{ marginTop: 12 }}>
          Progress bar
        </div>
        <div className="segmented" role="group" aria-label="Progress bar">
          {(['full', 'compact', 'hidden'] as const).map((v) => (
            <button
              key={v}
              aria-pressed={prefs.progressBar === v}
              onClick={() => set('progressBar', v)}
            >
              {v === 'full' ? 'Full' : v === 'compact' ? 'Compact' : 'Hidden'}
            </button>
          ))}
        </div>
        {prefs.mode === 'paginated' && (
          <div className="segmented" role="group" aria-label="Columns" style={{ marginTop: 8 }}>
            {(['auto', 'one', 'two'] as const).map((c) => (
              <button key={c} aria-pressed={prefs.columns === c} onClick={() => set('columns', c)}>
                {c === 'auto' ? 'Auto' : c === 'one' ? 'One page' : 'Two pages'}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="rs-group">
        <div className="rs-label">Spacing</div>
        <label className="rs-slider" htmlFor="rs-leading">
          <span className="rs-slider__name">Lines</span>
          <input
            id="rs-leading"
            className="slider"
            type="range"
            min={1.3}
            max={2.1}
            step={0.04}
            value={prefs.lineHeight}
            aria-label="Line height"
            onChange={(e) => set('lineHeight', Number(e.target.value))}
          />
          <span className="rs-slider__val">{prefs.lineHeight.toFixed(2)}</span>
        </label>
        <label className="rs-slider" htmlFor="rs-weight">
          <span className="rs-slider__name">Weight</span>
          <input
            id="rs-weight"
            className="slider"
            type="range"
            min={300}
            max={700}
            step={20}
            value={prefs.weight}
            aria-label="Font weight"
            onChange={(e) => set('weight', Number(e.target.value))}
          />
          <span className="rs-slider__val">{prefs.weight}</span>
        </label>
        <div className="segmented" role="group" aria-label="Margins">
          {(['compact', 'normal', 'wide'] as const).map((m) => (
            <button key={m} aria-pressed={prefs.margin === m} onClick={() => set('margin', m)}>
              {m[0]!.toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="rs-group">
        <div className="rs-label">Text</div>
        <div className="segmented" role="group" aria-label="Text alignment">
          <button aria-pressed={prefs.align === 'start'} onClick={() => set('align', 'start')}>
            Ragged
          </button>
          <button aria-pressed={prefs.align === 'justify'} onClick={() => set('align', 'justify')}>
            Justified
          </button>
        </div>
        <label className="rs-toggle">
          <span>Hyphenation</span>
          <input
            type="checkbox"
            role="switch"
            checked={prefs.hyphens}
            onChange={(e) => set('hyphens', e.target.checked)}
          />
        </label>
      </div>
    </Sheet>
  );
}

function SearchSheet({
  bookId,
  onClose,
  onJump,
}: {
  bookId: string;
  onClose: () => void;
  onJump: (spineIdx: number, charOffset: number) => void;
}) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<
    { spineIdx: number; charOffset: number; excerpt: string; chapterTitle: string | null }[] | null
  >(null);
  const [busy, setBusy] = useState(false);
  const run = async () => {
    if (q.trim().length < 2) return;
    setBusy(true);
    try {
      const res = await api<{ matches: NonNullable<typeof results> }>(
        `/api/books/${bookId}/search?q=${encodeURIComponent(q.trim())}`,
      );
      setResults(res.matches);
    } catch {
      setResults([]);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Sheet title="Search in book" onClose={onClose}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run();
        }}
        style={{ display: 'flex', gap: 8, marginBlockEnd: 12 }}
      >
        <input
          className="input"
          type="search"
          placeholder="Find in this book"
          aria-label="Search text"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          autoFocus
        />
        <button className="btn" type="submit" disabled={busy || q.trim().length < 2}>
          {busy ? '…' : 'Search'}
        </button>
      </form>
      {results !== null &&
        (results.length === 0 ? (
          <p style={{ color: 'var(--vx-text-soft)' }}>No matches.</p>
        ) : (
          results.map((r, i) => (
            <button key={i} className="list-row" onClick={() => onJump(r.spineIdx, r.charOffset)}>
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--vx-text-soft)' }}>
                  {r.chapterTitle ?? `Chapter ${r.spineIdx + 1}`}
                </span>
                {r.excerpt}
              </span>
            </button>
          ))
        ))}
    </Sheet>
  );
}

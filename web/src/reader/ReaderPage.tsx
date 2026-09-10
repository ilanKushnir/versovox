import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@tandemleaf/shared';
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
  IconHeadphones,
  IconSearch,
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
import { FONT_STACKS, loadPrefs, MARGINS, savePrefs, type ReaderPrefs } from './prefs';
import { formatDuration, formatPct } from '../lib/format';

const COLUMN_GAP = 48;

type SheetKind = 'none' | 'toc' | 'settings' | 'search' | 'note';

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

  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  const textMapRef = useRef<TextMap | null>(null);
  const currentOffsetRef = useRef(0);
  const pendingTargetRef = useRef<{
    charOffset: number;
    sentenceId?: string;
    handoff?: boolean;
  } | null>(null);
  const handoffCleanupRef = useRef<(() => void) | null>(null);
  const swipeRef = useRef<{ x: number; y: number; t: number } | null>(null);

  const rtl = manifest?.direction === 'rtl';
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
          void recordCheckpoint(id, 'open', {
            medium: 'ebook',
            spineIdx: pendingTargetRef.current
              ? ((resume?.locator as EbookLocator)?.spineIdx ?? 0)
              : 0,
            charOffset: pendingTargetRef.current?.charOffset ?? 0,
            pct: 0,
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
            headers: { 'x-tl-csrf': '1' },
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

  const applyPagination = useCallback(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    if (prefs.mode === 'paginated') {
      const w = viewport.clientWidth;
      content.style.setProperty('--rd-colwidth', `${w}px`);
      content.style.setProperty('--rd-colgap', `${COLUMN_GAP}px`);
      const count = Math.max(1, Math.round((content.scrollWidth + COLUMN_GAP) / (w + COLUMN_GAP)));
      setPageCount(count);
    } else {
      setPageCount(1);
    }
  }, [prefs.mode]);

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
      const viewport = viewportRef.current;
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!viewport || !content || !map) return 0;
      const w = viewport.clientWidth;
      const range = rangeForSpan(map, charOffset, charOffset + 1);
      if (!range) return 0;
      const tx = currentTx(content);
      const r = range.getBoundingClientRect();
      const base = viewport.getBoundingClientRect();
      const delta = rtl ? base.right - (r.right - tx) : r.left - tx - base.left;
      return Math.max(0, Math.floor((delta + 2) / (w + COLUMN_GAP)));
    },
    [rtl],
  );

  const goToPage = useCallback(
    (n: number, intent: 'heartbeat' | 'seek' = 'heartbeat') => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      if (!viewport || !content || !manifest) return;
      const w = viewport.clientWidth;
      const clamped = Math.max(0, Math.min(n, pageCount - 1));
      const targetTx = dirFactor * clamped * (w + COLUMN_GAP);
      // Measure the target page's first visible offset in a way that is
      // independent of the in-flight transition: shift the viewport box by
      // the difference between the current rendered transform and the target.
      const tx = currentTx(content);
      content.style.transform = `translateX(${targetTx}px)`;
      setPage(clamped);
      const map = textMapRef.current;
      if (map) {
        const rect = viewport.getBoundingClientRect();
        const shift = tx - targetTx;
        const off = firstVisibleOffset(map, {
          left: rect.left + shift,
          right: rect.right + shift,
          top: rect.top,
          bottom: rect.bottom,
        });
        if (off !== null) {
          currentOffsetRef.current = off;
          void recordCheckpoint(id, intent, locatorAt(manifest, sentences, spineIdx, off));
        }
      }
    },
    [manifest, sentences, spineIdx, pageCount, dirFactor, id],
  );

  // After chapter HTML renders: fix asset URLs, build text map, paginate,
  // jump to pending target, paint highlights.
  useLayoutEffect(() => {
    const content = contentRef.current;
    if (!content || !html || !manifest) return;
    for (const img of Array.from(content.querySelectorAll('img[src^="asset/"]'))) {
      img.setAttribute('src', `/api/books/${id}/${img.getAttribute('src')}`);
    }
    textMapRef.current = buildTextMap(content);
    applyPagination();

    const target = pendingTargetRef.current;
    pendingTargetRef.current = null;
    const map = textMapRef.current;
    let charOffset = target?.charOffset ?? 0;
    if (target?.sentenceId) {
      const s = sentences.find((x) => x.id === target.sentenceId);
      if (s) charOffset = s.start;
    }
    currentOffsetRef.current = charOffset;

    if (prefs.mode === 'paginated') {
      // Find the page containing charOffset (transition-safe measurement).
      const viewport = viewportRef.current!;
      const w = viewport.clientWidth;
      const count = Math.max(1, Math.round((content.scrollWidth + COLUMN_GAP) / (w + COLUMN_GAP)));
      setPageCount(count);
      const clamped = Math.min(pageForOffset(charOffset), count - 1);
      content.style.transform = `translateX(${dirFactor * clamped * (w + COLUMN_GAP)}px)`;
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
        toast.show('Continuing from your listening position');
      }
    }
  }, [html, prefs.mode, prefs.size, prefs.lineHeight, prefs.font, prefs.weight, prefs.margin]);

  // Re-paint highlights when annotations change.
  useEffect(() => {
    paintAnnotations(textMapRef.current, annotations, spineIdx);
  }, [annotations, spineIdx]);

  // Restore the current stable text anchor after a layout change, WITHOUT
  // recording progress: automatic reflow is not the reader moving.
  const restoreOffset = useCallback(
    (charOffset: number) => {
      const viewport = viewportRef.current;
      const content = contentRef.current;
      const map = textMapRef.current;
      if (!viewport || !content || !map) return;
      if (prefs.mode === 'paginated') {
        const w = viewport.clientWidth;
        const count = Math.max(
          1,
          Math.round((content.scrollWidth + COLUMN_GAP) / (w + COLUMN_GAP)),
        );
        setPageCount(count);
        const clamped = Math.min(pageForOffset(charOffset), count - 1);
        content.style.transform = `translateX(${dirFactor * clamped * (w + COLUMN_GAP)}px)`;
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
    [prefs.mode, dirFactor, pageForOffset],
  );

  // Resize/orientation re-pagination: keep the reader on the sentence they
  // were on. Never page-zero, never a progress write.
  useEffect(() => {
    const onResize = () => {
      applyPagination();
      restoreOffset(currentOffsetRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [applyPagination, restoreOffset]);

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
    const onScroll = () => {
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
    };
  }, [prefs.mode, manifest, sentences, spineIdx, id, html]);

  /* ----------------------------------------------------------- actions */

  const gotoChapter = useCallback(
    (s: number, charOffset = 0, intent: 'seek' | 'open' = 'seek') => {
      if (!manifest) return;
      const clamped = Math.max(0, Math.min(s, manifest.chapters.length - 1));
      handoffCleanupRef.current?.();
      pendingTargetRef.current = { charOffset };
      if (clamped === spineIdx) {
        // Re-trigger layout by resetting html state? Jump directly.
        const map = textMapRef.current;
        if (map) {
          pendingTargetRef.current = null;
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

  const nextPage = useCallback(() => {
    if (prefs.mode === 'scroll') {
      const s = scrollerRef.current;
      if (s) s.scrollTop += s.clientHeight * 0.9;
      return;
    }
    if (page < pageCount - 1) goToPage(page + 1);
    else if (manifest && spineIdx < manifest.chapters.length - 1) gotoChapter(spineIdx + 1, 0);
  }, [prefs.mode, page, pageCount, manifest, spineIdx, goToPage, gotoChapter]);

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
    document.addEventListener('pointerup', onUp);
    document.addEventListener('selectionchange', () => {
      const sel = document.getSelection();
      if (!sel || sel.isCollapsed) setSelection(null);
    });
    return () => document.removeEventListener('pointerup', onUp);
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
      <div className="reader-page" data-reader-theme={prefs.theme}>
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
  const bookPct = manifest ? pctFor(manifest, spineIdx, currentOffsetRef.current) : 0;
  const margins = MARGINS[prefs.margin];

  return (
    <div
      className={`reader-page ${chrome ? '' : 'chrome-hidden'}`}
      data-reader-theme={prefs.theme}
      style={
        {
          '--rd-font': FONT_STACKS[prefs.font],
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
          className="icon-btn"
          onClick={() => void addAnnotation('bookmark')}
          aria-label="Bookmark this position"
        >
          <IconBookmark />
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
            <div
              ref={contentRef}
              className="reader-content reader-content--paginated"
              style={{
                transition: 'transform 200ms var(--tl-ease)',
                padding: `calc(72px + var(--tl-safe-top)) ${margins.padding}px calc(64px + var(--tl-safe-bottom))`,
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
              onClick={(e) => interceptLink(e, manifest, gotoChapter)}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </>
        ) : (
          <div className="reader-scroller" ref={scrollerRef}>
            <div
              ref={contentRef}
              className="reader-content"
              onClick={(e) => {
                if ((e.target as Element).closest('a')) {
                  interceptLink(e, manifest, gotoChapter);
                  return;
                }
                const sel = document.getSelection();
                if (sel && !sel.isCollapsed) return;
                setChrome((c) => !c);
              }}
              onPointerDown={() => handoffCleanupRef.current?.()}
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        )}
        {!html && !loadError && (
          <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center' }}>
            <div className="spinner" role="status" aria-label="Loading chapter" />
          </div>
        )}
      </div>

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
          <button onClick={() => void addAnnotation('bookmark')}>Bookmark</button>
        </div>
      )}

      <div className="immersive-chrome immersive-chrome--bottom">
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
        <div className="reader-footer-row">
          <span>
            {prefs.mode === 'paginated'
              ? `Page ${page + 1} of ${pageCount} in chapter`
              : chapterTitle}
          </span>
          <span className="grow" />
          {detail?.book.pair && detail.book.pair.status !== 'candidate' && (
            <button
              className="icon-btn"
              style={{ width: 'auto', paddingInline: 12, gap: 6, fontSize: 13, fontWeight: 600 }}
              onClick={() => void switchToAudio()}
              disabled={!detail.book.pair.switchable}
              title={
                detail.book.pair.switchable
                  ? 'Switch to the audiobook at this sentence'
                  : 'Alignment not ready — switching unavailable'
              }
            >
              <IconHeadphones size={17} />
              Listen
            </button>
          )}
          <span>{formatPct(bookPct)}</span>
        </div>
      </div>

      {sheet === 'toc' && manifest && (
        <Sheet title="Contents" onClose={() => setSheet('none')}>
          {manifest.toc.length === 0 && <p>No table of contents in this book.</p>}
          {manifest.toc.map((t, i) => (
            <button
              key={i}
              className="list-row"
              style={{ paddingInlineStart: 16 + t.depth * 16 }}
              aria-current={t.spineIdx === spineIdx ? 'true' : undefined}
              onClick={() => {
                setSheet('none');
                gotoChapter(t.spineIdx, 0);
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
            <blockquote style={{ color: 'var(--tl-text-soft)', fontSize: 14, margin: '0 0 12px' }}>
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
  gotoChapter: (s: number, off: number) => void,
): void {
  const a = (e.target as Element).closest('a');
  if (!a) return;
  const internal = a.getAttribute('data-tl-href');
  if (internal) {
    e.preventDefault();
    const [file] = internal.split('#');
    const target = manifest?.chapters.find((c) => c.href === file);
    if (target) gotoChapter(target.idx, 0);
  } else if (a.getAttribute('href') === '#') {
    e.preventDefault();
  }
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
    css.highlights.set('tl-h', new Highlight(...ranges));
  } else {
    css.highlights.delete('tl-h');
  }
}

function paintHandoff(map: TextMap, start: number, end: number): () => void {
  const css = CSS as unknown as HighlightApi;
  if (!css.highlights || typeof Highlight === 'undefined') return () => {};
  const r = rangeForSpan(map, start, end);
  if (!r) return () => {};
  css.highlights.set('tl-handoff', new Highlight(r));
  let cleared = false;
  const clear = () => {
    if (cleared) return;
    cleared = true;
    setTimeout(() => css.highlights!.delete('tl-handoff'), 400);
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
  return (
    <Sheet title="Reading settings" onClose={onClose}>
      <div className="field">
        <label>Theme</label>
        <div className="chip-row" role="group" aria-label="Reader theme">
          {(['paper', 'sepia', 'night', 'contrast'] as const).map((t) => (
            <button
              key={t}
              className="chip"
              aria-pressed={prefs.theme === t}
              onClick={() => set('theme', t)}
            >
              {t === 'paper'
                ? 'Paper'
                : t === 'sepia'
                  ? 'Sepia'
                  : t === 'night'
                    ? 'Night'
                    : 'High contrast'}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Layout</label>
        <div className="chip-row" role="group" aria-label="Layout mode">
          <button
            className="chip"
            aria-pressed={prefs.mode === 'paginated'}
            onClick={() => set('mode', 'paginated')}
          >
            Pages
          </button>
          <button
            className="chip"
            aria-pressed={prefs.mode === 'scroll'}
            onClick={() => set('mode', 'scroll')}
          >
            Continuous scroll
          </button>
        </div>
      </div>
      <div className="field">
        <label>Font</label>
        <div className="chip-row" role="group" aria-label="Reading font">
          <button
            className="chip"
            aria-pressed={prefs.font === 'literata'}
            onClick={() => set('font', 'literata')}
          >
            Literata
          </button>
          <button
            className="chip"
            aria-pressed={prefs.font === 'serif'}
            onClick={() => set('font', 'serif')}
          >
            System serif
          </button>
          <button
            className="chip"
            aria-pressed={prefs.font === 'sans'}
            onClick={() => set('font', 'sans')}
          >
            Sans
          </button>
        </div>
      </div>
      <div className="field">
        <label htmlFor="rs-size">Text size — {prefs.size}px</label>
        <input
          id="rs-size"
          className="slider"
          style={{ color: 'var(--tl-interactive)' }}
          type="range"
          min={14}
          max={30}
          step={1}
          value={prefs.size}
          onChange={(e) => set('size', Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label htmlFor="rs-weight">Weight — {prefs.weight}</label>
        <input
          id="rs-weight"
          className="slider"
          style={{ color: 'var(--tl-interactive)' }}
          type="range"
          min={300}
          max={700}
          step={20}
          value={prefs.weight}
          onChange={(e) => set('weight', Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label htmlFor="rs-leading">Line height — {prefs.lineHeight.toFixed(2)}</label>
        <input
          id="rs-leading"
          className="slider"
          style={{ color: 'var(--tl-interactive)' }}
          type="range"
          min={1.3}
          max={2.1}
          step={0.04}
          value={prefs.lineHeight}
          onChange={(e) => set('lineHeight', Number(e.target.value))}
        />
      </div>
      <div className="field">
        <label>Margins</label>
        <div className="chip-row" role="group" aria-label="Margins">
          {(['compact', 'normal', 'wide'] as const).map((m) => (
            <button
              key={m}
              className="chip"
              aria-pressed={prefs.margin === m}
              onClick={() => set('margin', m)}
            >
              {m[0]!.toUpperCase() + m.slice(1)}
            </button>
          ))}
        </div>
      </div>
      <div className="field">
        <label>Alignment</label>
        <div className="chip-row" role="group" aria-label="Text alignment">
          <button
            className="chip"
            aria-pressed={prefs.align === 'start'}
            onClick={() => set('align', 'start')}
          >
            Ragged
          </button>
          <button
            className="chip"
            aria-pressed={prefs.align === 'justify'}
            onClick={() => set('align', 'justify')}
          >
            Justified
          </button>
          <button
            className="chip"
            aria-pressed={prefs.hyphens}
            onClick={() => set('hyphens', !prefs.hyphens)}
          >
            Hyphenation {prefs.hyphens ? 'on' : 'off'}
          </button>
        </div>
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
          <p style={{ color: 'var(--tl-text-soft)' }}>No matches.</p>
        ) : (
          results.map((r, i) => (
            <button key={i} className="list-row" onClick={() => onJump(r.spineIdx, r.charOffset)}>
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                <span style={{ display: 'block', fontSize: 12, color: 'var(--tl-text-soft)' }}>
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

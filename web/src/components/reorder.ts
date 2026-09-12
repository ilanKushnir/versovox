import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';

/**
 * Re-ordering a list, with the keyboard path as the PRIMARY mechanism and the
 * pointer path built on the same state machine. Drag is the alternative, not
 * the requirement: grab with Space, move with the arrows, drop with Space.
 *
 * The hook owns only order. What a drop means — one PATCH naming the item's
 * new neighbour — is the caller's `onCommit`.
 */

/** Move `id` so that it sits at `to` in the array. Pure, and the unit under test. */
export function moveItem<T>(items: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= items.length) return items;
  const next = items.slice();
  const [moved] = next.splice(from, 1);
  next.splice(Math.max(0, Math.min(next.length, to)), 0, moved!);
  return next;
}

/** The id an item now follows, or null when it is first. This is what the API wants. */
export function afterIdFor(ids: string[], id: string): string | null {
  const i = ids.indexOf(id);
  return i <= 0 ? null : ids[i - 1]!;
}

export interface ReorderApi {
  /** The order to render: the live one while a grab is in progress. */
  ids: string[];
  /** The id being moved, or null. */
  grabbed: string | null;
  /** True while a pointer or touch drag is actually moving. */
  dragging: boolean;
  /** Pixels the grabbed row is offset by during a pointer drag. */
  offset: number;
  /** What a screen reader is told; also rendered in a live region. */
  announcement: string;
  /** Props for the drag handle of one row. */
  handleProps: (id: string) => {
    onKeyDown: (e: ReactKeyboardEvent) => void;
    onPointerDown: (e: ReactPointerEvent) => void;
    'aria-pressed': boolean;
    'aria-label': string;
  };
  /** Long-press anywhere on a row engages the same grab, the phone idiom. */
  rowProps: (id: string) => {
    onPointerDown: (e: ReactPointerEvent) => void;
    onPointerMove: (e: ReactPointerEvent) => void;
    onPointerUp: (e: ReactPointerEvent) => void;
    onPointerCancel: (e: ReactPointerEvent) => void;
  };
  /** The overflow menu's four moves — the fastest route from 20th to 1st. */
  moveTo: (id: string, to: 'top' | 'up' | 'down' | 'bottom') => void;
  /** Register the DOM node of a row so drag distances can be measured. */
  register: (id: string, el: HTMLElement | null) => void;
}

export function useReorder(opts: {
  ids: string[];
  /** What each row is called, for the announcements. */
  labelOf: (id: string) => string;
  /** Persist the new order. `afterId` is null when the item became first. */
  onCommit: (id: string, afterId: string | null, ids: string[]) => void;
  /** Reordering is off while the server is unreachable. */
  disabled?: boolean;
}): ReorderApi {
  const { ids: source, labelOf, onCommit, disabled } = opts;
  const [live, setLive] = useState<string[] | null>(null);
  const [grabbed, setGrabbed] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState(0);
  const [announcement, setAnnouncement] = useState('');
  const original = useRef<string[]>([]);
  const nodes = useRef(new Map<string, HTMLElement>());
  const pointer = useRef<{ id: string; startY: number; fromIndex: number } | null>(null);
  const longPress = useRef<{ id: string; timer: number; x: number; y: number } | null>(null);

  const ids = live ?? source;
  const idsRef = useRef(ids);
  idsRef.current = ids;

  const register = useCallback((id: string, el: HTMLElement | null) => {
    if (el) nodes.current.set(id, el);
    else nodes.current.delete(id);
  }, []);

  const say = useCallback(
    (id: string, verb: string, list: string[]) => {
      const at = list.indexOf(id) + 1;
      setAnnouncement(`${verb} ${labelOf(id)}, position ${at} of ${list.length}.`);
    },
    [labelOf],
  );

  const begin = useCallback(
    (id: string) => {
      if (disabled) return;
      original.current = idsRef.current.slice();
      setLive(idsRef.current.slice());
      setGrabbed(id);
      const at = idsRef.current.indexOf(id) + 1;
      setAnnouncement(
        `Grabbed ${labelOf(id)}, position ${at} of ${idsRef.current.length}. ` +
          'Use the arrow keys to move it, space to drop it, escape to leave it where it was.',
      );
    },
    [disabled, labelOf],
  );

  const drop = useCallback(
    (id: string) => {
      const list = idsRef.current;
      setGrabbed(null);
      setDragging(false);
      setOffset(0);
      setLive(null);
      const before = original.current;
      // A separator no id can contain, written as an ESCAPE. A literal NUL
      // byte in the source makes the file count as binary, so diffs stop
      // rendering and nobody reviews a change to it again.
      const SEP = '\u0000';
      if (before.join(SEP) !== list.join(SEP)) {
        onCommit(id, afterIdFor(list, id), list);
        say(id, 'Dropped at', list);
      } else {
        say(id, 'Left', list);
      }
    },
    [onCommit, say],
  );

  const cancel = useCallback(
    (id: string) => {
      setLive(null);
      setGrabbed(null);
      setDragging(false);
      setOffset(0);
      setAnnouncement(`${labelOf(id)} left where it was.`);
    },
    [labelOf],
  );

  const shift = useCallback((id: string, to: number) => {
    setLive((cur) => {
      const list = cur ?? idsRef.current;
      const next = moveItem(list, list.indexOf(id), to);
      idsRef.current = next;
      return next;
    });
  }, []);

  const moveTo = useCallback(
    (id: string, where: 'top' | 'up' | 'down' | 'bottom') => {
      if (disabled) return;
      const list = idsRef.current;
      const from = list.indexOf(id);
      if (from < 0) return;
      const to =
        where === 'top'
          ? 0
          : where === 'bottom'
            ? list.length - 1
            : where === 'up'
              ? Math.max(0, from - 1)
              : Math.min(list.length - 1, from + 1);
      if (to === from) return;
      const next = moveItem(list, from, to);
      idsRef.current = next;
      onCommit(id, afterIdFor(next, id), next);
      say(id, 'Moved to', next);
    },
    [disabled, onCommit, say],
  );

  const handleProps = useCallback(
    (id: string) => ({
      'aria-pressed': grabbed === id,
      'aria-label': `Reorder ${labelOf(id)}, position ${ids.indexOf(id) + 1} of ${ids.length}`,
      onKeyDown: (e: ReactKeyboardEvent) => {
        if (disabled) return;
        const list = idsRef.current;
        const at = list.indexOf(id);
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault();
          if (grabbed === id) drop(id);
          else begin(id);
          return;
        }
        if (grabbed !== id) return;
        if (e.key === 'Escape') {
          e.preventDefault();
          cancel(id);
        } else if (e.key === 'ArrowUp' && at > 0) {
          e.preventDefault();
          shift(id, at - 1);
          say(id, 'Moved to', moveItem(list, at, at - 1));
        } else if (e.key === 'ArrowDown' && at < list.length - 1) {
          e.preventDefault();
          shift(id, at + 1);
          say(id, 'Moved to', moveItem(list, at, at + 1));
        } else if (e.key === 'Home' && at > 0) {
          e.preventDefault();
          shift(id, 0);
          say(id, 'Moved to', moveItem(list, at, 0));
        } else if (e.key === 'End' && at < list.length - 1) {
          e.preventDefault();
          shift(id, list.length - 1);
          say(id, 'Moved to', moveItem(list, at, list.length - 1));
        }
      },
      onPointerDown: (e: ReactPointerEvent) => {
        if (disabled || e.button !== 0) return;
        (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
        pointer.current = { id, startY: e.clientY, fromIndex: idsRef.current.indexOf(id) };
        begin(id);
        setDragging(true);
      },
    }),
    [begin, cancel, disabled, drop, grabbed, ids, labelOf, say, shift],
  );

  // The pointer drag lives on the document so a fast gesture that leaves the
  // handle keeps working, and so the drop happens even if the row unmounts.
  useEffect(() => {
    if (!dragging) return;
    const onMove = (e: PointerEvent) => {
      const p = pointer.current;
      if (!p) return;
      const dy = e.clientY - p.startY;
      setOffset(dy);
      const list = idsRef.current;
      const at = list.indexOf(p.id);
      const height = nodes.current.get(p.id)?.getBoundingClientRect().height ?? 64;
      const target = Math.max(0, Math.min(list.length - 1, p.fromIndex + Math.round(dy / height)));
      if (target !== at) shift(p.id, target);
      // Auto-scroll near the viewport edges, or a long queue cannot be
      // crossed in one gesture.
      const margin = 64;
      if (e.clientY < margin) window.scrollBy({ top: -12 });
      else if (e.clientY > window.innerHeight - margin) window.scrollBy({ top: 12 });
    };
    const onUp = () => {
      const p = pointer.current;
      pointer.current = null;
      if (p) drop(p.id);
    };
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', onUp);
    document.addEventListener('pointercancel', onUp);
    return () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', onUp);
      document.removeEventListener('pointercancel', onUp);
    };
  }, [dragging, drop, shift]);

  const clearLongPress = useCallback(() => {
    if (longPress.current) {
      window.clearTimeout(longPress.current.timer);
      longPress.current = null;
    }
  }, []);

  const rowProps = useCallback(
    (id: string) => ({
      onPointerDown: (e: ReactPointerEvent) => {
        if (disabled || e.pointerType === 'mouse' || grabbed) return;
        const x = e.clientX;
        const y = e.clientY;
        const timer = window.setTimeout(() => {
          longPress.current = null;
          pointer.current = { id, startY: y, fromIndex: idsRef.current.indexOf(id) };
          begin(id);
          setDragging(true);
          navigator.vibrate?.(10);
        }, 500);
        longPress.current = { id, timer, x, y };
      },
      onPointerMove: (e: ReactPointerEvent) => {
        const lp = longPress.current;
        // A scroll is a move; only a still finger means "pick this up".
        if (lp && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) > 10) clearLongPress();
      },
      onPointerUp: () => clearLongPress(),
      onPointerCancel: () => clearLongPress(),
    }),
    [begin, clearLongPress, disabled, grabbed],
  );

  useEffect(() => clearLongPress, [clearLongPress]);

  return useMemo(
    () => ({
      ids,
      grabbed,
      dragging,
      offset,
      announcement,
      handleProps,
      rowProps,
      moveTo,
      register,
    }),
    [ids, grabbed, dragging, offset, announcement, handleProps, rowProps, moveTo, register],
  );
}

import { firstVisibleOffset, type TextMap } from './textmap';

/**
 * Lifecycle-checkpoint offset for the reader.
 *
 * In scroll mode the tracked offset ref lags behind by a 600ms debounce, so
 * a pagehide/visibilitychange inside that window would persist a stale
 * position. This computes the CURRENT offset synchronously from live DOM
 * geometry instead, falling back to the tracked ref only when the geometry
 * is unavailable (chapter still loading). Paginated mode keeps the tracked
 * ref — page turns update it synchronously already.
 */
export function liveCheckpointOffset(
  mode: 'paginated' | 'scroll',
  trackedOffset: number,
  map: TextMap | null,
  scroller: { getBoundingClientRect: () => DOMRect } | null,
  firstVisible: typeof firstVisibleOffset = firstVisibleOffset,
): number {
  if (mode !== 'scroll' || !map || !scroller) return trackedOffset;
  try {
    const off = firstVisible(map, scroller.getBoundingClientRect());
    return off ?? trackedOffset;
  } catch {
    return trackedOffset;
  }
}

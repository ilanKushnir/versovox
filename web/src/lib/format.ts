export function formatDuration(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms)) return '–';
  const totalSec = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(v)} ${units[u]}`;
}

export function formatPct(pct: number): string {
  return new Intl.NumberFormat(undefined, { style: 'percent', maximumFractionDigits: 0 }).format(
    Math.min(1, Math.max(0, pct)),
  );
}

export function formatDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
  } catch {
    return iso;
  }
}

/**
 * A rough span in words, for time estimates: "about 3 h", "about 2 days".
 * Deliberately coarse — these come from a measured average, not a promise.
 */
export function formatSpan(ms: number | null | undefined): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return 'unknown';
  const mins = ms / 60_000;
  if (mins < 1) return 'under a minute';
  if (mins < 90) return `about ${Math.round(mins)} min`;
  const hours = mins / 60;
  if (hours < 36) return `about ${Math.round(hours)} h`;
  const days = hours / 24;
  return days < 10 ? `about ${days.toFixed(1)} days` : `about ${Math.round(days)} days`;
}

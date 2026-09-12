import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { type AudioLocator, type EbookLocator } from '@readport/shared';
import { api, isOffline } from '../api/client';
import { type Annotation, type BookDetail, type ResolveResponse } from '../lib/types';
import { Cover, EmptyState, Sheet, useToast } from '../components/ui';
import { AddToSheet } from '../components/AddToSheet';
import { useShelves } from '../state/shelves';
import {
  IconAlert,
  IconBookmark,
  IconBookOpen,
  IconDownload,
  IconHeadphones,
  IconLink,
  IconClose,
  IconList,
  IconOffline,
  IconShelf,
  IconSwitch,
  IconTrash,
} from '../components/icons';
import { formatBytes, formatDuration, formatPct } from '../lib/format';
import {
  cachedSwitch,
  cancelDownload,
  getDownloadState,
  removeDownload,
  startDownload,
  type DownloadState,
} from '../offline/downloads';
import { bookAudioSupport } from '../lib/audioSupport';
import { pairStatusLabel } from '../lib/pairLabel';
import { ambientColorFromImage } from '../lib/ambient';
import { recordCheckpoint } from '../progress/engine';

/** The paired edition, as far as the offline sheet needs to describe it. */
interface Companion {
  id: string;
  kind: 'ebook' | 'audio';
  sizeBytes: number;
}

export function BookPage() {
  const { id = '' } = useParams();
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const [detail, setDetail] = useState<BookDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [dl, setDl] = useState<DownloadState | null>(null);
  const [companion, setCompanion] = useState<Companion | null>(null);
  // `undefined` until this device has been asked; null means never downloaded.
  const [companionDl, setCompanionDl] = useState<DownloadState | null | undefined>(undefined);
  const [ambient, setAmbient] = useState<string | null>(null);
  const [switching, setSwitching] = useState(false);
  const [offlineSheet, setOfflineSheet] = useState(false);
  const [addTo, setAddTo] = useState(false);
  const [member, setMember] = useState<{
    shelfIds: string[];
    onReadingList: boolean;
    readingListPosition: number | null;
  } | null>(null);
  const autoSwitched = useRef(false);
  const { overview, refresh: refreshShelves } = useShelves();

  const load = useCallback(async () => {
    try {
      const d = await api<BookDetail>(`/api/books/${id}`);
      setDetail(d);
      setError(null);
      const anns = await api<{ annotations: Annotation[] }>(`/api/books/${id}/annotations`).catch(
        () => ({ annotations: [] as Annotation[] }),
      );
      setAnnotations(anns.annotations);
    } catch {
      setError('Could not load this book.');
    }
    setDl(await getDownloadState(id));
  }, [id]);

  const loadMembership = useCallback(async () => {
    try {
      setMember(
        await api<{
          shelfIds: string[];
          onReadingList: boolean;
          readingListPosition: number | null;
        }>(`/api/books/${id}/shelves`),
      );
    } catch {
      setMember(null);
    }
  }, [id]);

  useEffect(() => {
    void loadMembership();
  }, [loadMembership]);

  useEffect(() => {
    void load();
  }, [load]);

  // Whether the paired edition is on this device decides what the tandem
  // card may promise, so it is read (from local storage only) up front.
  const otherBookId = detail?.book.pair?.otherBookId ?? null;
  useEffect(() => {
    setCompanionDl(undefined);
    if (!otherBookId) return;
    let cancelled = false;
    void getDownloadState(otherBookId).then((s) => {
      if (!cancelled) setCompanionDl(s);
    });
    return () => {
      cancelled = true;
    };
  }, [otherBookId]);

  useEffect(() => {
    if (!detail?.book.hasCover) return;
    let cancelled = false;
    ambientColorFromImage(`/api/books/${id}/cover`).then((c) => {
      if (!cancelled && c) setAmbient(c);
    });
    return () => {
      cancelled = true;
    };
  }, [detail, id]);

  /**
   * Open the other edition AT THE SAME PLACE: resolve this book's saved
   * position through the pair alignment and hand off with a marker. Falls
   * back to plainly opening the other edition (at its own position) when the
   * pair is not aligned or nothing has been read yet.
   */
  const openOtherEdition = useCallback(async () => {
    if (!detail?.book.pair) return;
    const { pair, progress, kind } = detail.book;
    const otherRoute =
      kind === 'ebook' ? `/listen/${pair.otherBookId}` : `/read/${pair.otherBookId}`;
    if (!pair.switchable || !progress || progress.pct <= 0.001) {
      navigate(otherRoute);
      return;
    }
    setSwitching(true);
    try {
      let res: ResolveResponse;
      try {
        res = await api<ResolveResponse>(`/api/pairs/${pair.pairId}/resolve`, {
          method: 'POST',
          body: { from: progress.locator },
        });
      } catch (err) {
        if (!isOffline(err)) throw err;
        // No network. The downloaded package carries the server's own
        // answers for this book, so the handoff lands where it would online.
        const stored = await cachedSwitch(id, progress.locator);
        if (!stored) {
          toast.show('This spot was not stored for offline switching — opening the other edition.');
          navigate(otherRoute);
          return;
        }
        res = stored;
      }
      if (!res.to) {
        toast.show(
          res.resolution.reason ?? 'No aligned position here — opening the other edition.',
        );
        navigate(otherRoute);
        return;
      }
      void recordCheckpoint(id, 'switch', progress.locator);
      if (res.to.medium === 'audio') {
        const to = res.to as AudioLocator;
        navigate(
          `/listen/${pair.otherBookId}?track=${to.trackIdx}&pos=${to.positionMs}&handoff=1&granularity=${res.resolution.granularity}`,
        );
      } else {
        const to = res.to as EbookLocator;
        navigate(
          `/read/${pair.otherBookId}?spine=${to.spineIdx}&char=${to.charOffset ?? 0}${
            to.sentenceId ? `&sentence=${to.sentenceId}` : ''
          }&handoff=1&granularity=${res.resolution.granularity}`,
        );
      }
    } catch {
      toast.show('Could not resolve the position — opening the other edition.');
      navigate(otherRoute);
    } finally {
      setSwitching(false);
    }
  }, [detail, id, navigate, toast]);

  // `?switch=1` (from the library's "Listen/Read instead") switches right away.
  useEffect(() => {
    if (!detail || autoSwitched.current || searchParams.get('switch') !== '1') return;
    autoSwitched.current = true;
    void openOtherEdition();
  }, [detail, searchParams, openOtherEdition]);

  if (error) {
    return (
      <main className="app-main">
        <div className="banner banner--error" role="alert">
          <IconAlert size={18} /> {error}
        </div>
      </main>
    );
  }
  if (!detail) {
    return (
      <main className="app-main" aria-busy="true">
        <div className="book-hero">
          <div className="skeleton book-hero__cover" />
          <div style={{ flex: 1 }}>
            <div className="skeleton" style={{ height: 32, maxWidth: 360 }} />
            <div className="skeleton" style={{ height: 18, maxWidth: 200, marginTop: 12 }} />
          </div>
        </div>
      </main>
    );
  }

  const { book } = detail;
  const isEbook = book.kind === 'ebook';
  const pct = book.progress?.pct ?? 0;
  const pair = book.pair && book.pair.status !== 'candidate' ? book.pair : null;
  const audioSupport = isEbook
    ? null
    : bookAudioSupport(
        detail.tracks.length > 0 ? detail.tracks.map((t) => t.format) : [book.format],
      );

  /**
   * A paired title is two packages. Downloading them one after the other
   * (rather than in parallel) keeps the progress the sheet shows honest and
   * stops a large audiobook from starving the small ebook beside it.
   */
  const download = async (withCompanion: boolean) => {
    const wanted: { id: string; onUpdate: (s: DownloadState) => void }[] = [
      { id, onUpdate: setDl },
    ];
    if (withCompanion && companion) wanted.push({ id: companion.id, onUpdate: setCompanionDl });
    const targets: typeof wanted = [];
    for (const target of wanted) {
      if ((await getDownloadState(target.id))?.status !== 'done') targets.push(target);
    }
    try {
      toast.show(targets.length > 1 ? 'Downloading both editions…' : 'Downloading for offline…');
      for (const target of targets) {
        await startDownload(target.id, target.onUpdate);
        const state = await getDownloadState(target.id);
        if (state?.status === 'done') continue;
        if (state?.status === 'cancelled') toast.show('Download stopped');
        else toast.show(`Download failed: ${state?.error ?? 'unknown'}`);
        return;
      }
      toast.show(wanted.length > 1 ? 'Both editions are available offline' : 'Available offline');
    } catch (err) {
      toast.show(
        (err as Error).message.includes('Cache Storage')
          ? 'Offline downloads need HTTPS (or localhost) — see docs/self-hosting.md.'
          : `Download failed: ${(err as Error).message}`,
      );
    } finally {
      setDl(await getDownloadState(id));
      if (companion) setCompanionDl(await getDownloadState(companion.id));
    }
  };

  /**
   * The paired edition's size is not part of this book's detail, and the
   * sheet must quote it before the user commits — so it is fetched when the
   * sheet opens. Offline the fetch fails and the sheet simply says the
   * edition is not on this device without a number.
   */
  const openOfflineSheet = async () => {
    setOfflineSheet(true);
    const other = book.pair?.otherBookId;
    if (!other || companion?.id === other) return;
    setCompanionDl(await getDownloadState(other));
    try {
      const d = await api<BookDetail>(`/api/books/${other}`);
      setCompanion({ id: other, kind: d.book.kind, sizeBytes: d.book.sizeBytes });
    } catch {
      // Offline: the edition still exists and still needs downloading, so
      // say so without a size rather than pretending there is nothing else.
      setCompanion({ id: other, kind: isEbook ? 'audio' : 'ebook', sizeBytes: 0 });
    }
  };

  return (
    <main
      className="app-main book-page"
      style={ambient ? ({ '--pl-ambient': ambient } as React.CSSProperties) : undefined}
    >
      <div className="book-hero__backdrop" aria-hidden="true" />
      <div className="book-hero">
        <span className="book-hero__coverwrap">
          <Cover book={book} className="book-hero__cover" />
        </span>
        <div className="book-hero__body">
          <div className="book-hero__eyebrow">
            {isEbook ? <IconBookOpen size={14} /> : <IconHeadphones size={14} />}
            {isEbook ? 'Ebook' : 'Audiobook'}
            {book.series && (
              <>
                {' · '}
                {book.series}
                {book.seriesIdx ? ` #${book.seriesIdx}` : ''}
              </>
            )}
          </div>
          <h1>{book.title}</h1>
          {book.author && <div className="book-hero__author">{book.author}</div>}
          <div className="book-hero__meta">
            <span>{isEbook ? 'EPUB' : book.format.toUpperCase()}</span>
            {book.language && <span>{book.language.toUpperCase()}</span>}
            {!isEbook && book.durationMs != null && <span>{formatDuration(book.durationMs)}</span>}
            {detail.chapters.length > 0 && <span>{detail.chapters.length} chapters</span>}
            <span>{formatBytes(book.sizeBytes)}</span>
          </div>
          {audioSupport && !audioSupport.supported && (
            <div className="banner" role="note">
              <IconAlert size={16} /> {audioSupport.reason}
            </div>
          )}
          {book.scanState === 'error' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> Indexing failed: {book.scanError}
            </div>
          )}
          {book.scanState === 'missing' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={16} /> The source files for this book are missing from the library
              mount.
            </div>
          )}
          {book.progress && pct > 0.001 && (
            <div className="book-hero__progress">
              <span className="progressbar" aria-hidden="true">
                <span style={{ width: `${pct * 100}%` }} />
              </span>
              <span>
                {book.progress.finished
                  ? 'Finished'
                  : `${formatPct(pct)} ${isEbook ? 'read' : 'listened'}`}
                {!isEbook && !book.progress.finished && book.durationMs
                  ? ` · ${formatDuration(book.durationMs * (1 - pct))} left`
                  : ''}
              </span>
            </div>
          )}
          <div className="book-hero__actions">
            {isEbook ? (
              <Link className="btn" to={`/read/${book.id}`}>
                <IconBookOpen size={18} /> {pct > 0.001 ? 'Continue reading' : 'Read'}
              </Link>
            ) : audioSupport && !audioSupport.supported ? (
              <button className="btn" disabled title={audioSupport.reason ?? undefined}>
                <IconHeadphones size={18} /> Listen
              </button>
            ) : (
              <Link className="btn" to={`/listen/${book.id}`}>
                <IconHeadphones size={18} /> {pct > 0.001 ? 'Continue listening' : 'Listen'}
              </Link>
            )}
            <button className="btn btn--secondary" onClick={() => setAddTo(true)}>
              <IconShelf size={17} /> Add to…
            </button>
            <OfflineButton dl={dl} onClick={() => void openOfflineSheet()} />
          </div>
          <MembershipChips
            member={member}
            shelfNames={new Map((overview?.shelves ?? []).map((s) => [s.id, s.name]))}
            onRemoveShelf={(shelfId, name) =>
              void (async () => {
                await api(`/api/shelves/${shelfId}/books/${id}`, { method: 'DELETE' }).catch(
                  () => {},
                );
                await loadMembership();
                await refreshShelves();
                toast.show(`Taken off ${name}`);
              })()
            }
            onRemoveQueue={() =>
              void (async () => {
                await api(`/api/reading-list/${id}`, { method: 'DELETE' }).catch(() => {});
                await loadMembership();
                await refreshShelves();
                toast.show('Taken off your reading list');
              })()
            }
          />
        </div>
      </div>

      {pair && (
        <section className="tandem-card" aria-label="Paired edition">
          <div className="tandem-card__icon">
            <IconSwitch size={22} />
          </div>
          <div className="tandem-card__body">
            <div className="tandem-card__title">
              {pair.switchable
                ? `Sync ready — switch to the ${isEbook ? 'audiobook' : 'ebook'} at the same sentence`
                : `${isEbook ? 'Audiobook' : 'Ebook'} edition paired`}
            </div>
            <div className="tandem-card__sub">
              {pairStatusLabel(pair)} <Link to="/pairs">Review pairing</Link>
            </div>
            {dl?.status === 'done' &&
              companionDl !== undefined &&
              companionDl?.status !== 'done' && (
                <div className="tandem-card__sub">
                  The {isEbook ? 'audiobook' : 'ebook'} is not on this device — switching to it
                  needs a connection.
                </div>
              )}
          </div>
          <button
            className="btn btn--secondary"
            onClick={() => void openOtherEdition()}
            disabled={switching}
          >
            {isEbook ? <IconHeadphones size={17} /> : <IconBookOpen size={17} />}
            {switching
              ? 'Resolving…'
              : pair.switchable && pct > 0.001
                ? isEbook
                  ? 'Listen from here'
                  : 'Read from here'
                : isEbook
                  ? 'Open audiobook'
                  : 'Open ebook'}
          </button>
        </section>
      )}
      {book.pair && book.pair.status === 'candidate' && (
        <div className="banner" role="note">
          <IconLink size={16} />
          <span style={{ flex: 1 }}>
            A possible {isEbook ? 'audiobook' : 'ebook'} edition was found and is waiting for
            review.
          </span>
          <Link to="/pairs" className="btn btn--ghost" style={{ minHeight: 36 }}>
            Review
          </Link>
        </div>
      )}

      {detail.chapters.length > 0 && (
        <section className="list-card" aria-label="Chapters">
          <div className="list-card__head">Chapters ({detail.chapters.length})</div>
          {detail.chapters.map((c, i) => (
            <button
              key={c.idx}
              className="list-row"
              onClick={() =>
                isEbook
                  ? navigate(`/read/${book.id}?spine=${c.spineIdx ?? 0}`)
                  : navigate(`/listen/${book.id}?pos=${c.startMs ?? 0}`)
              }
            >
              <span className="soft" style={{ width: 24, textAlign: 'end' }}>
                {i + 1}
              </span>
              <span className="grow">{c.title}</span>
              {c.startMs != null && (
                <span className="soft">
                  {c.endMs != null
                    ? formatDuration(c.endMs - c.startMs)
                    : formatDuration(c.startMs)}
                </span>
              )}
            </button>
          ))}
        </section>
      )}

      {annotations.length > 0 && (
        <section className="list-card" aria-label="Bookmarks and highlights">
          <div className="list-card__head">Bookmarks & highlights ({annotations.length})</div>
          {annotations.map((a) => (
            <button
              key={a.id}
              className="list-row"
              onClick={() => {
                if (a.locator.medium === 'ebook') {
                  navigate(
                    `/read/${book.id}?spine=${a.locator.spineIdx}&char=${a.locator.charOffset ?? 0}`,
                  );
                } else {
                  navigate(
                    `/listen/${book.id}?track=${a.locator.trackIdx}&pos=${a.locator.positionMs}`,
                  );
                }
              }}
            >
              <IconBookmark size={16} filled={a.kind === 'bookmark'} />
              <span className="grow" style={{ whiteSpace: 'normal' }}>
                {a.selectedText ?? a.note ?? (a.kind === 'bookmark' ? 'Bookmark' : a.kind)}
                {a.note && a.selectedText && (
                  <span style={{ display: 'block', fontSize: 13, color: 'var(--rp-text-soft)' }}>
                    {a.note}
                  </span>
                )}
              </span>
              <span className="soft">{formatPct(a.locator.pct)}</span>
            </button>
          ))}
        </section>
      )}

      {detail.description && (
        <section style={{ maxWidth: '65ch' }}>
          <h2 className="section-title">About</h2>
          <p style={{ color: 'var(--rp-text-soft)' }}>{detail.description}</p>
        </section>
      )}
      {detail.chapters.length === 0 && annotations.length === 0 && !detail.description && (
        <EmptyState title="No chapters listed">
          This book has no chapter metadata; you can still {isEbook ? 'read' : 'listen'} normally.
        </EmptyState>
      )}
      {offlineSheet && (
        <OfflineSheet
          book={{ title: book.title, kind: book.kind, sizeBytes: book.sizeBytes }}
          dl={dl}
          companion={book.pair ? companion : null}
          companionDl={book.pair ? (companionDl ?? null) : null}
          onClose={() => setOfflineSheet(false)}
          onDownload={(withCompanion) => {
            setOfflineSheet(false);
            void download(withCompanion);
          }}
          onCancel={() => {
            cancelDownload(id);
            setOfflineSheet(false);
          }}
          onRemove={async () => {
            await removeDownload(id);
            setDl(await getDownloadState(id));
            setOfflineSheet(false);
            toast.show('Offline copy removed');
          }}
        />
      )}
      {addTo && (
        <AddToSheet
          bookId={id}
          title={book.title}
          onClose={() => setAddTo(false)}
          onChanged={() => void loadMembership()}
        />
      )}
    </main>
  );
}

/**
 * Where this book already sits. Removing is one click from here, which is
 * the point: the panel is for adding, the chips are for undoing.
 */
function MembershipChips({
  member,
  shelfNames,
  onRemoveShelf,
  onRemoveQueue,
}: {
  member: { shelfIds: string[]; onReadingList: boolean; readingListPosition: number | null } | null;
  shelfNames: Map<string, string>;
  onRemoveShelf: (shelfId: string, name: string) => void;
  onRemoveQueue: () => void;
}) {
  if (!member || (member.shelfIds.length === 0 && !member.onReadingList)) return null;
  return (
    <div className="membership" role="group" aria-label="Shelves this book is on">
      {member.onReadingList && (
        <span className="membership__chip">
          <IconList size={13} />
          Reading list
          {member.readingListPosition ? ` · ${ordinal(member.readingListPosition)}` : ''}
          <button
            className="membership__x"
            aria-label="Take off the reading list"
            onClick={onRemoveQueue}
          >
            <IconClose size={13} />
          </button>
        </span>
      )}
      {member.shelfIds.map((sid) => {
        const name = shelfNames.get(sid);
        if (!name) return null;
        return (
          <span className="membership__chip" key={sid}>
            <IconShelf size={13} />
            {name}
            <button
              className="membership__x"
              aria-label={`Take off ${name}`}
              onClick={() => onRemoveShelf(sid, name)}
            >
              <IconClose size={13} />
            </button>
          </span>
        );
      })}
    </div>
  );
}

function ordinal(n: number): string {
  const rest = n % 100;
  if (rest >= 11 && rest <= 13) return `${n}th`;
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`;
}

/**
 * The one entry point to offline downloads, so it carries a visible word — an
 * icon alone has no tooltip on touch, which is where most reading and most
 * flights happen.
 */
function OfflineButton({ dl, onClick }: { dl: DownloadState | null; onClick: () => void }) {
  const downloading = dl?.status === 'downloading';
  const done = dl?.status === 'done';
  const failed = dl?.status === 'error';
  const pctDone = downloading && dl.totalUrls ? Math.round((dl.doneUrls / dl.totalUrls) * 100) : 0;
  return (
    <button
      className={`btn btn--secondary offline-btn ${done ? 'is-done' : ''} ${downloading ? 'is-busy' : ''}`}
      onClick={onClick}
      aria-label={
        done
          ? 'Available offline — manage the download'
          : downloading
            ? `Downloading for offline, ${pctDone}%`
            : failed
              ? 'Download for offline — the last attempt failed'
              : 'Download for offline'
      }
    >
      {downloading ? (
        <span className="offline-btn__ring" style={{ '--pct': pctDone } as React.CSSProperties}>
          <span className="offline-btn__pct">{pctDone}</span>
        </span>
      ) : done ? (
        <IconOffline size={18} />
      ) : failed ? (
        <IconAlert size={18} />
      ) : (
        <IconDownload size={18} />
      )}
      {downloading ? 'Downloading' : done ? 'Downloaded' : failed ? 'Retry' : 'Download'}
    </button>
  );
}

/**
 * One sheet for the whole offline lifecycle: explain + confirm the download,
 * show progress with a cancel, or offer removal — of a finished copy or of
 * whatever a stopped attempt left behind.
 */
function OfflineSheet({
  book,
  dl,
  companion,
  companionDl,
  onClose,
  onDownload,
  onCancel,
  onRemove,
}: {
  book: { title: string; kind: 'ebook' | 'audio'; sizeBytes: number };
  dl: DownloadState | null;
  companion: Companion | null;
  companionDl: DownloadState | null;
  onClose: () => void;
  onDownload: (withCompanion: boolean) => void;
  onCancel: () => void;
  onRemove: () => void;
}) {
  const downloading = dl?.status === 'downloading';
  const done = dl?.status === 'done';
  const isEbook = book.kind === 'ebook';
  const otherMedium = isEbook ? 'audiobook' : 'ebook';
  const companionStored = companionDl?.status === 'done';
  // Bytes a stopped or failed attempt left on the device. They are reused by
  // the next attempt, but until then they are silent occupied space.
  const partialBytes = dl && !done && !downloading ? dl.storedBytes : 0;
  return (
    <Sheet
      title={done ? 'Available offline' : downloading ? 'Downloading' : 'Download for offline?'}
      onClose={onClose}
    >
      {done ? (
        <>
          <p className="sheet__lede">
            <strong>{book.title}</strong> is stored on this device ({formatBytes(dl.storedBytes)}).
            You can {isEbook ? 'read' : 'listen to'} it with no connection; progress syncs when you
            are back online.
          </p>
          {companion && !companionStored && (
            <div className="banner" role="note">
              <IconAlert size={15} />
              <span style={{ flex: 1 }}>
                The {otherMedium} edition is not on this device
                {companion.sizeBytes > 0 ? ` (${formatBytes(companion.sizeBytes)})` : ''}. Add it to
                switch between reading and listening offline.
              </span>
            </div>
          )}
          <div className="sheet__actions">
            {companion && !companionStored && (
              <button className="btn" onClick={() => onDownload(true)}>
                <IconDownload size={16} /> Add the {otherMedium}
              </button>
            )}
            <button className="btn btn--danger" onClick={onRemove}>
              <IconTrash size={16} /> Remove offline copy
            </button>
            <button className="btn btn--secondary" onClick={onClose}>
              Keep
            </button>
          </div>
        </>
      ) : downloading ? (
        <>
          <p className="sheet__lede">
            {dl.doneUrls} of {dl.totalUrls} parts · {formatBytes(dl.storedBytes)} so far. You can
            keep using the app meanwhile.
          </p>
          <span className="progressbar" aria-hidden="true" style={{ height: 6 }}>
            <span style={{ width: `${dl.totalUrls ? (dl.doneUrls / dl.totalUrls) * 100 : 0}%` }} />
          </span>
          <div className="sheet__actions">
            <button className="btn btn--secondary" onClick={onCancel}>
              Cancel download
            </button>
            <button className="btn btn--ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </>
      ) : (
        <>
          <p className="sheet__lede">
            Keep <strong>{book.title}</strong> on this device for flights and dead zones — about{' '}
            <strong>{formatBytes(book.sizeBytes)}</strong>
            {isEbook ? ' including images' : ' of audio'}. {isEbook ? 'Reading' : 'Listening'} works
            fully offline and your position syncs back when you reconnect. Signing out removes
            offline copies.
          </p>
          {companion && !companionStored && (
            <p className="sheet__lede">
              The {otherMedium} edition is a separate download
              {companion.sizeBytes > 0 ? ` of about ${formatBytes(companion.sizeBytes)}` : ''}. Take
              only this one and you will have the {isEbook ? 'text' : 'audio'} offline but not the
              other, and no way to switch between them until you reconnect.
            </p>
          )}
          {partialBytes > 0 && (
            <p className="sheet__lede">
              {formatBytes(partialBytes)} from the last attempt is still on this device. Starting
              again continues from there; removing it frees the space now.
            </p>
          )}
          {dl?.status === 'error' && (
            <div className="banner banner--error" role="alert">
              <IconAlert size={15} /> Last attempt failed: {dl.error ?? 'unknown error'}
            </div>
          )}
          <div className="sheet__actions">
            {companion && !companionStored ? (
              <>
                <button className="btn" onClick={() => onDownload(true)}>
                  <IconDownload size={16} /> Download both
                  {companion.sizeBytes > 0
                    ? ` (${formatBytes(book.sizeBytes + companion.sizeBytes)})`
                    : ''}
                </button>
                <button className="btn btn--secondary" onClick={() => onDownload(false)}>
                  {isEbook ? 'Ebook' : 'Audiobook'} only ({formatBytes(book.sizeBytes)})
                </button>
              </>
            ) : (
              <button className="btn" onClick={() => onDownload(false)}>
                <IconDownload size={16} /> {dl?.status === 'error' ? 'Retry download' : 'Download'}
              </button>
            )}
            {partialBytes > 0 && (
              <button className="btn btn--danger" onClick={onRemove}>
                <IconTrash size={16} /> Remove partial download
              </button>
            )}
            <button className="btn btn--ghost" onClick={onClose}>
              Not now
            </button>
          </div>
        </>
      )}
    </Sheet>
  );
}

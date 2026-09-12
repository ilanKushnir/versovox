import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { type BookSummary } from '@readport/shared';
import { IconClose } from './icons';

/* ----------------------------------------------------------------- Sheet */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Dialog focus-trap Tab handling, extracted for direct testing. Wrapping
 * treats the DIALOG CONTAINER ITSELF as a boundary: when initial focus is
 * the container (tabIndex=-1), Shift+Tab wraps to the LAST focusable
 * control and Tab enters at the first — focus can never escape the dialog.
 */
export function trapTabFocus(
  e: { shiftKey: boolean; preventDefault: () => void },
  dialog: { contains: (n: Node | null) => boolean; focus: () => void },
  focusables: { focus: () => void }[],
  active: Node | null,
): void {
  if (focusables.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusables[0]!;
  const last = focusables[focusables.length - 1]!;
  const atContainer = active === (dialog as unknown as Node);
  if (e.shiftKey) {
    if (atContainer || active === (first as unknown as Node) || !dialog.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (atContainer || active === (last as unknown as Node) || !dialog.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

/**
 * Focus trap for a modal surface: Tab cycles inside it, Escape closes, and
 * the control that opened it gets focus back. Shared by the Sheet and the
 * Drawer rather than copied, so the two can never drift apart.
 */
export function useFocusTrap(ref: { current: HTMLElement | null }, onClose: () => void): void {
  // The latest onClose lives in a ref so a parent re-render (the player
  // re-renders on every timeupdate) never re-runs the focus effect and
  // yanks focus away from the control the user is on.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const dialog = ref.current;
      if (!dialog) return;
      const focusables = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      trapTabFocus(e, dialog, focusables, document.activeElement);
    };
    document.addEventListener('keydown', onKey);
    // Move focus into the dialog.
    ref.current?.focus();
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [ref]);
}

export function Sheet({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="sheet"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet__grab" aria-hidden="true" />
        <div className="sheet__header">
          <span className="sheet__title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="sheet__body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/**
 * A panel that slides in from the inline start. Used at tablet widths where
 * the shelf rail does not fit but the book grid still needs its pixels; the
 * same content renders in the rail, in here, and in a Sheet on a phone.
 */
export function Drawer({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, onClose);
  return createPortal(
    <>
      <div className="sheet-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        className="drawer"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="sheet__header">
          <span className="sheet__title">{title}</span>
          <button className="icon-btn" onClick={onClose} aria-label="Close">
            <IconClose />
          </button>
        </div>
        <div className="drawer__body">{children}</div>
      </div>
    </>,
    document.body,
  );
}

/* ----------------------------------------------------------------- Toast */

export interface ToastAction {
  label: string;
  onClick: () => void;
}
interface ToastCtx {
  show: (msg: string, action?: ToastAction) => void;
}
const ToastContext = createContext<ToastCtx>({ show: () => {} });
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<{ msg: string; action?: ToastAction } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const show = useCallback((msg: string, action?: ToastAction) => {
    setToast({ msg, action });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setToast(null), action ? 8000 : 3200);
  }, []);
  return (
    <ToastContext.Provider value={{ show }}>
      {children}
      {toast &&
        createPortal(
          <div className="toast" role="status" aria-live="polite">
            <div>
              {toast.msg}
              {toast.action && (
                <button
                  className="toast__action"
                  onClick={() => {
                    toast.action?.onClick();
                    setToast(null);
                  }}
                >
                  {toast.action.label}
                </button>
              )}
            </div>
          </div>,
          document.body,
        )}
    </ToastContext.Provider>
  );
}

/* ----------------------------------------------------------------- Cover */

const COVER_TINTS = ['#8C3F1F', '#5E4A8A', '#2F4A5C', '#6B3A44', '#4E5A2E', '#8A6A2F'];

export function Cover({
  book,
  className,
}: {
  book: Pick<BookSummary, 'id' | 'title' | 'author' | 'hasCover' | 'kind'>;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  if (book.hasCover && !failed) {
    return (
      <img
        className={className}
        src={`/api/books/${book.id}/cover`}
        alt=""
        loading="lazy"
        onError={() => setFailed(true)}
      />
    );
  }
  let hash = 0;
  for (const c of book.id) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const tint = COVER_TINTS[hash % COVER_TINTS.length];
  return (
    <span
      className={`book-card__fallback ${className ?? ''}`}
      style={{ background: tint, color: '#F8F2E8' }}
      aria-hidden="true"
    >
      <span style={{ fontSize: 13, fontWeight: 650, lineHeight: 1.25 }}>{book.title}</span>
      <span style={{ fontSize: 11, opacity: 0.85 }}>{book.author ?? ''}</span>
    </span>
  );
}

/* ------------------------------------------------------------ EmptyState */

export function EmptyState({
  icon,
  title,
  children,
  action,
}: {
  icon?: ReactNode;
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty-state">
      {icon}
      <h2>{title}</h2>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

/* -------------------------------------------------------------- Segmented */

export function ChipRow<T extends string>({
  options,
  value,
  onChange,
  ariaLabel,
}: {
  options: { value: T; label: string }[];
  value: T;
  onChange: (v: T) => void;
  ariaLabel: string;
}) {
  return (
    <div className="chip-row" role="group" aria-label={ariaLabel}>
      {options.map((o) => (
        <button
          key={o.value}
          className="chip"
          aria-pressed={o.value === value}
          onClick={() => onChange(o.value)}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

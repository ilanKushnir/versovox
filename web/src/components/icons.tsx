/** ReadPort icon set: one consistent 24px / 1.75-stroke hand-drawn family. */

import { type SVGProps } from 'react';

type P = SVGProps<SVGSVGElement> & { size?: number };

function I({ size = 22, children, ...rest }: P) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

/**
 * The ReadPort mark: a bookmark ribbon with a play triangle cut out of it.
 *
 * The triangle is a hole, not a shape on top — `evenodd` on a single path — so
 * the mark works in one colour on any ground, and the hole shows whatever is
 * behind it. Geometry rather than a traced logo, so it stays crisp at 16px.
 */
export const ReadPortMark = ({ size = 24, ...rest }: P) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="currentColor"
    aria-hidden="true"
    {...rest}
  >
    <path
      fillRule="evenodd"
      // Kept byte-for-byte in step with design/logo/mark.mjs by icons.test.tsx.
      d="M5.6 4.1 a2.3 2.3 0 0 1 2.3 -2.3 h8.2 a2.3 2.3 0 0 1 2.3 2.3 V22.2 L12 17.9 L5.6 22.2 Z M9.7 6.8 L15.7 10.775 L9.7 14.75 Z"
    />
  </svg>
);

export const IconLibrary = (p: P) => (
  <I {...p}>
    <path d="M4 4.5h4v15H4zM10 4.5h4v15h-4z" />
    <path d="m16.5 5.5 3.6-.8 3 14.2-3.9.9z" transform="scale(0.92) translate(0.5 0.5)" />
  </I>
);
export const IconLink = (p: P) => (
  <I {...p}>
    <path d="M9.5 14.5 14.5 9.5" />
    <path d="M12.5 7l1.8-1.8a3.5 3.5 0 0 1 5 5L17.5 12" />
    <path d="M11.5 17l-1.8 1.8a3.5 3.5 0 0 1-5-5L6.5 12" />
  </I>
);
export const IconSettings = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="3.2" />
    <path d="M12 2.8v2.4M12 18.8v2.4M2.8 12h2.4M18.8 12h2.4M5.5 5.5l1.7 1.7M16.8 16.8l1.7 1.7M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7" />
  </I>
);
export const IconBack = (p: P) => (
  <I {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </I>
);
export const IconClose = (p: P) => (
  <I {...p}>
    <path d="m6 6 12 12M18 6 6 18" />
  </I>
);
export const IconPlay = (p: P) => (
  <I {...p}>
    <path d="M8 5.5v13l10-6.5z" fill="currentColor" stroke="none" />
  </I>
);
export const IconPause = (p: P) => (
  <I {...p}>
    <rect x="6.5" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
    <rect x="13.9" y="5" width="3.6" height="14" rx="1" fill="currentColor" stroke="none" />
  </I>
);
/**
 * Skip back / skip forward, with the number of seconds inside the ring.
 *
 * Geometry, so it can be adjusted without guessing: the ring is r=9 about
 * (12,12) with a 72-degree gap centred on twelve o'clock, which puts its ends
 * at 36 degrees either side — (6.71, 4.72) and (17.29, 4.72). The arrowhead
 * sits on the end the arc travels towards, pointing along the tangent there,
 * so back turns anticlockwise and forward clockwise and the two are exact
 * mirrors. The digits are centred in the ring rather than sharing space with
 * a stroke: the previous version ran the tail of the arrow straight through
 * them, which is what made the number hard to read at 36px.
 */
const SKIP_RING_BACK = 'M6.71 4.72A9 9 0 1 0 17.29 4.72';
const SKIP_HEAD_BACK = 'M14.13 2.43 19.8 2.96 16.39 7.65Z';
const SKIP_RING_FWD = 'M17.29 4.72A9 9 0 1 1 6.71 4.72';
const SKIP_HEAD_FWD = 'M9.87 2.43 7.61 7.65 4.2 2.96Z';

/** Digits shrink only when there are three of them; the app offers 10-60. */
function skipFontSize(label: string): number {
  if (label.length >= 3) return 7.6;
  if (label.length <= 1) return 10;
  return 9.5;
}

function SkipIcon({ label, ring, head, ...p }: P & { label: string; ring: string; head: string }) {
  const size = skipFontSize(label);
  return (
    <I {...p}>
      <path d={ring} />
      <path d={head} fill="currentColor" stroke="none" />
      <text
        x="12"
        // Baseline, not a centred dominant-baseline: 0.355em below the middle
        // puts the cap height of a digit on the ring's centre in every browser.
        y={12 + 0.355 * size}
        fontSize={size}
        fontFamily="inherit"
        fontWeight="650"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
      >
        {label}
      </text>
    </I>
  );
}

export const IconSkipBack = ({ label = '15', ...p }: P & { label?: string }) => (
  <SkipIcon {...p} label={label} ring={SKIP_RING_BACK} head={SKIP_HEAD_BACK} />
);
export const IconSkipFwd = ({ label = '30', ...p }: P & { label?: string }) => (
  <SkipIcon {...p} label={label} ring={SKIP_RING_FWD} head={SKIP_HEAD_FWD} />
);
export const IconBookmark = ({ filled = false, ...p }: P & { filled?: boolean }) => (
  <I {...p}>
    <path d="M7 4.5h10V20l-5-3.4L7 20z" fill={filled ? 'currentColor' : 'none'} />
  </I>
);
export const IconToc = (p: P) => (
  <I {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <circle cx="4.7" cy="6.5" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4.7" cy="12" r="0.9" fill="currentColor" stroke="none" />
    <circle cx="4.7" cy="17.5" r="0.9" fill="currentColor" stroke="none" />
  </I>
);
export const IconSearch = (p: P) => (
  <I {...p}>
    <circle cx="10.5" cy="10.5" r="6" />
    <path d="m15.5 15.5 4.5 4.5" />
  </I>
);
export const IconType = (p: P) => (
  <I {...p}>
    <path d="M5 18.5 10.2 5h1.1l5.2 13.5M6.8 14h7.9" />
    <path d="M16.5 18.5 18.7 13h.6l2.2 5.5" strokeWidth="1.4" />
  </I>
);
export const IconHeadphones = (p: P) => (
  <I {...p}>
    <path d="M4.5 17v-4a7.5 7.5 0 0 1 15 0v4" />
    <rect x="3.5" y="14" width="4" height="6" rx="1.6" />
    <rect x="16.5" y="14" width="4" height="6" rx="1.6" />
  </I>
);
export const IconBookOpen = (p: P) => (
  <I {...p}>
    <path d="M12 6.5c-1.8-1.6-4.5-2-8-2v13c3.5 0 6.2.4 8 2 1.8-1.6 4.5-2 8-2v-13c-3.5 0-6.2.4-8 2z" />
    <path d="M12 6.5v13" />
  </I>
);
export const IconDownload = (p: P) => (
  <I {...p}>
    <path d="M12 4v10.5M7.5 10.5 12 15l4.5-4.5" />
    <path d="M5 19h14" />
  </I>
);
/** Read along: lines of text with the narration rising off them. */
export const IconReadAlong = (p: P) => (
  <I {...p}>
    <path d="M3.5 6.5h9M3.5 10.5h9M3.5 14.5h6M3.5 18.5h7.5" />
    <path d="M15.5 9.2v5.6M18 7v10M20.5 10.4v3.2" />
  </I>
);
/** Bring the page back to whatever is being spoken. */
export const IconTarget = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="7" />
    <circle cx="12" cy="12" r="2.4" />
    <path d="M12 2.5v2.6M12 18.9v2.6M2.5 12h2.6M18.9 12h2.6" />
  </I>
);
export const IconTrash = (p: P) => (
  <I {...p}>
    <path d="M5 7h14M9.5 7V4.8h5V7M7 7l.8 12.2h8.4L17 7" />
  </I>
);
export const IconCheck = (p: P) => (
  <I {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </I>
);
export const IconChevronRight = (p: P) => (
  <I {...p}>
    <path d="m9.5 5.5 6.5 6.5-6.5 6.5" />
  </I>
);
export const IconChevronDown = (p: P) => (
  <I {...p}>
    <path d="m5.5 9.5 6.5 6.5 6.5-6.5" />
  </I>
);
export const IconChapterPrev = (p: P) => (
  <I {...p}>
    <path d="M6 5.5v13" />
    <path d="m18 5.5-9 6.5 9 6.5z" fill="currentColor" stroke="none" />
  </I>
);
export const IconChapterNext = (p: P) => (
  <I {...p}>
    <path d="M18 5.5v13" />
    <path d="m6 5.5 9 6.5-9 6.5z" fill="currentColor" stroke="none" />
  </I>
);
export const IconSun = (p: P) => (
  <I {...p}>
    <circle cx="12" cy="12" r="4" />
    <path d="M12 2.5v2.5M12 19v2.5M2.5 12H5M19 12h2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8" />
  </I>
);
export const IconMoon = (p: P) => (
  <I {...p}>
    <path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z" />
  </I>
);
export const IconAlert = (p: P) => (
  <I {...p}>
    <path d="M12 4 2.8 19.5h18.4z" />
    <path d="M12 10v4.2" />
    <circle cx="12" cy="16.8" r="0.9" fill="currentColor" stroke="none" />
  </I>
);
export const IconSpeed = (p: P) => (
  <I {...p}>
    <path d="M4.5 17a8 8 0 1 1 15 0" />
    <path d="m12 13.5 3.8-4.2" />
    <circle cx="12" cy="14.5" r="1.4" fill="currentColor" stroke="none" />
  </I>
);
export const IconOffline = (p: P) => (
  <I {...p}>
    <path d="M5 14.5a4.5 4.5 0 0 1 1.2-8.8 6 6 0 0 1 11.4 1.5A4 4 0 0 1 19 15" />
    <path d="m9 17.5 6 .01M12 14.5v6" opacity="0" />
    <path d="M12 12.5V19M9.2 16.2 12 19l2.8-2.8" />
  </I>
);
export const IconSwitch = (p: P) => (
  <I {...p}>
    <path d="M4 8h13M14 4.8 17.5 8 14 11.2" />
    <path d="M20 16H7M10 12.8 6.5 16l3.5 3.2" />
  </I>
);
/** A tag, for the genres a library already carries. */
/** The notes and marks collected out of every book. */
export const IconNotes = (p: P) => (
  <I {...p}>
    <path d="M5.5 3.5h8.6L18.5 8v12.5h-13z" />
    <path d="M14 3.6V8h4.4" />
    <path d="M8.4 12.2h6.5M8.4 15.8h4.4" />
  </I>
);
export const IconTag = (p: P) => (
  <I {...p}>
    <path d="M4.5 11.3V5.2a.7.7 0 0 1 .7-.7h6.1c.2 0 .4.1.5.2l7 7a.7.7 0 0 1 0 1l-6.1 6.1a.7.7 0 0 1-1 0l-7-7a.7.7 0 0 1-.2-.5z" />
    <circle cx="8.4" cy="8.4" r="1.15" />
  </I>
);
/** A star, for ratings a reader gave in Calibre. */
export const IconStar = (p: P) => (
  <I {...p}>
    <path d="m12 4.3 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.5-4.8 2.5.9-5.4L4.2 10l5.4-.8z" />
  </I>
);
/** Two figures, for the people a book is by or read by. */
export const IconPeople = (p: P) => (
  <I {...p}>
    <circle cx="9.3" cy="8.2" r="3.1" />
    <path d="M3.7 19.3c0-2.9 2.5-4.9 5.6-4.9s5.6 2 5.6 4.9" />
    <path d="M16 5.6a3.1 3.1 0 0 1 0 5.9M17.2 14.9c1.9.6 3.1 2.2 3.1 4.4" />
  </I>
);
export const IconShelf = (p: P) => (
  <I {...p}>
    <path d="M4.2 5.2h3.2v11.1H4.2zM9 5.2h3.2v11.1H9z" />
    <path d="m14.7 6.4 3.1-.7 2.1 9.9-3.1.7z" />
    <path d="M3 19.4h18" />
  </I>
);
export const IconList = (p: P) => (
  <I {...p}>
    <path d="M9 6.5h11M9 12h11M9 17.5h11" />
    <path d="M4.4 6.5h.01M4.4 12h.01M4.4 17.5h.01" strokeWidth="2.4" />
  </I>
);
export const IconPlus = (p: P) => (
  <I {...p}>
    <path d="M12 5.5v13M5.5 12h13" />
  </I>
);
export const IconGrip = (p: P) => (
  <I {...p}>
    <path
      d="M9.2 7h.01M14.8 7h.01M9.2 12h.01M14.8 12h.01M9.2 17h.01M14.8 17h.01"
      strokeWidth="2.6"
    />
  </I>
);
export const IconMore = (p: P) => (
  <I {...p}>
    <path d="M6 12h.01M12 12h.01M18 12h.01" strokeWidth="2.6" />
  </I>
);
export const IconChevronLeft = (p: P) => (
  <I {...p}>
    <path d="M14.5 5.5 8 12l6.5 6.5" />
  </I>
);

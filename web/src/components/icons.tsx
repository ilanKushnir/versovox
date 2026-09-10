/** Versovox icon set: one consistent 24px / 1.75-stroke hand-drawn family. */

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
 * The Versovox mark: an open book whose right-hand page rises into a sound
 * wave — text and voice as one object. Single colour, works at 16 px.
 */
export const VersoMark = ({ size = 24, ...rest }: P) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" {...rest}>
    {/* spine + left page */}
    <path
      d="M12 6.2C10.6 4.9 8.6 4.2 6.3 4.2H3.4c-.5 0-.9.4-.9.9v12.6c0 .5.4.9.9.9h2.9c2.3 0 4.3.7 5.7 2V6.2z"
      fill="currentColor"
    />
    <path
      d="M5.4 8.3h4M5.4 11.3h4M5.4 14.3h2.6"
      stroke="var(--vx-bg, #fff)"
      strokeWidth="1.3"
      strokeLinecap="round"
      opacity="0.9"
    />
    {/* right page as a wave of bars */}
    <path
      d="M14.4 12.8v3.6M17 10.2v8.2M19.6 12v4.6M22 13.4v2.2"
      stroke="currentColor"
      strokeWidth="2.1"
      strokeLinecap="round"
    />
    <path
      d="M12 6.2v14.4"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinecap="round"
      opacity="0.5"
    />
  </svg>
);
/** @deprecated use VersoMark */
export const LeafMark = VersoMark;

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
export const IconSkipBack = ({ label = '15', ...p }: P & { label?: string }) => (
  <I {...p}>
    <path d="M12 4.5a7.5 7.5 0 1 1-7.3 5.8" />
    <path d="M4.5 4.5v6h6" fill="none" />
    <text
      x="12.4"
      y="15.6"
      fontSize="7.5"
      fontFamily="inherit"
      fontWeight="700"
      textAnchor="middle"
      fill="currentColor"
      stroke="none"
    >
      {label}
    </text>
  </I>
);
export const IconSkipFwd = ({ label = '30', ...p }: P & { label?: string }) => (
  <I {...p}>
    <path d="M12 4.5a7.5 7.5 0 1 0 7.3 5.8" />
    <path d="M19.5 4.5v6h-6" fill="none" />
    <text
      x="11.6"
      y="15.6"
      fontSize="7.5"
      fontFamily="inherit"
      fontWeight="700"
      textAnchor="middle"
      fill="currentColor"
      stroke="none"
    >
      {label}
    </text>
  </I>
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

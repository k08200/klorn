/** Mail v2 glyphs: 16px, stroke-only, decorative (the control carries the name). */

import type { ReactNode } from "react";

function Glyph({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className={`size-4 shrink-0 ${className}`}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {children}
    </svg>
  );
}

export const ComposeIcon = () => (
  <Glyph>
    <path d="M8 13.5h5.5" />
    <path d="M10.8 2.7a1.4 1.4 0 0 1 2 2L5 12.5l-2.7.7.7-2.7Z" />
  </Glyph>
);

export const SyncIcon = ({ spinning = false }: { spinning?: boolean }) => (
  <Glyph className={spinning ? "motion-safe:animate-spin" : ""}>
    <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9" />
    <path d="M13.5 2.5v3h-3" />
  </Glyph>
);

export const MoreIcon = () => (
  <Glyph>
    <path d="M3.5 8h.01M8 8h.01M12.5 8h.01" strokeWidth="2" />
  </Glyph>
);

export const SearchIcon = ({ className = "" }: { className?: string }) => (
  <Glyph className={className}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="m10.5 10.5 3 3" />
  </Glyph>
);

export const ArchiveIcon = () => (
  <Glyph>
    <path d="M2.5 3.5h11v3h-11z" />
    <path d="M3.5 6.5v6h9v-6M6.5 9h3" />
  </Glyph>
);

export const ReadIcon = () => (
  <Glyph>
    <path d="M2.5 6.5 8 3l5.5 3.5v6h-11z" />
    <path d="m2.5 6.5 5.5 3.5 5.5-3.5" />
  </Glyph>
);

export const UnreadIcon = () => (
  <Glyph>
    <path d="M2.5 4h11v8.5h-11z" />
    <path d="m2.5 4.5 5.5 4 5.5-4" />
  </Glyph>
);

export const InboxIcon = () => (
  <Glyph className="size-5">
    <path d="M2.5 9.5 4 3.5h8l1.5 6v3h-11z" />
    <path d="M2.5 9.5h3l.8 1.5h3.4l.8-1.5h3" />
  </Glyph>
);

export const ClockIcon = () => (
  <Glyph>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M8 5v3l2 1.5" />
  </Glyph>
);

export const ReplyIcon = () => (
  <Glyph>
    <path d="M6.5 4 3 7.5 6.5 11" />
    <path d="M3 7.5h6a4 4 0 0 1 4 4V12" />
  </Glyph>
);

export const BackIcon = () => (
  <Glyph>
    <path d="M13 8H3" />
    <path d="M7 4 3 8l4 4" />
  </Glyph>
);

export const ChevronUpIcon = () => (
  <Glyph>
    <path d="m4 10 4-4 4 4" />
  </Glyph>
);

export const ChevronDownIcon = () => (
  <Glyph>
    <path d="m4 6 4 4 4-4" />
  </Glyph>
);

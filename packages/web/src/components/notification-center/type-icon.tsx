/**
 * Outline glyphs for bell rows that are not mail from a person: 16px,
 * stroke-only, decorative (the row text carries the meaning). No emoji.
 */

import type { ReactNode } from "react";

const PATHS: Record<string, ReactNode> = {
  mail: (
    <>
      <rect x="2" y="3.5" width="12" height="9" rx="1.5" />
      <path d="M2.5 4.5 8 9l5.5-4.5" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="1.5" />
      <path d="M2.5 6.5h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  check: <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />,
  spark: (
    <path d="M8 2.5v2.5M8 11v2.5M2.5 8H5M11 8h2.5M4.2 4.2l1.6 1.6M10.2 10.2l1.6 1.6M4.2 11.8l1.6-1.6M10.2 5.8l1.6-1.6" />
  ),
  doc: (
    <>
      <path d="M4 2.5h5.5L12 5v8.5H4z" />
      <path d="M9.5 2.5V5H12M6 8h4M6 10.5h4" />
    </>
  ),
  bell: (
    <>
      <path d="M4 11.5V7.5a4 4 0 0 1 8 0v4l1 1H3z" />
      <path d="M6.75 13.5a1.4 1.4 0 0 0 2.5 0" />
    </>
  ),
};

const TYPE_GLYPH: Record<string, keyof typeof PATHS> = {
  email: "mail",
  meeting: "calendar",
  calendar: "calendar",
  reminder: "clock",
  task: "check",
  insight: "spark",
  agent_proposal: "spark",
  briefing: "doc",
};

export function typeGlyph(type: string, agent: boolean): string {
  if (agent) return "spark";
  return TYPE_GLYPH[type] ?? "bell";
}

export function TypeIcon({ glyph }: { glyph: string }) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      className="size-4 shrink-0"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      {PATHS[glyph] ?? PATHS.bell}
    </svg>
  );
}

export function MoreGlyph() {
  return (
    <svg aria-hidden="true" viewBox="0 0 16 16" className="size-4 shrink-0" fill="currentColor">
      <circle cx="3.5" cy="8" r="1.25" />
      <circle cx="8" cy="8" r="1.25" />
      <circle cx="12.5" cy="8" r="1.25" />
    </svg>
  );
}

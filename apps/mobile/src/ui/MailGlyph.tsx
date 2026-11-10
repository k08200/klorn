/**
 * Extra stroke glyphs for Mail (paths from the Mail / Reader / Subscriptions
 * artboards). Same contract as ui/Icon: decorative unless `label` is given.
 * Kept apart from Icon's map so screens can add glyphs without touching it.
 */
export const MAIL_GLYPHS = {
  close: "M6 6l12 12M18 6L6 18",
  search: "M11 17.5a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13zM20 20l-4-4",
  chevronUp: "M6 15l6-6 6 6",
  chevronDown: "M6 9l6 6 6-6",
  chevronLeft: "M15 5l-7 7 7 7",
  compose: "M4 20h4L18.5 9.5a2.1 2.1 0 0 0-3-3L5 17zM13.5 8.5l2 2",
  reply: "M9.5 7L4 12l5.5 5M4 12h10a6 6 0 0 1 6 6v1",
  done: "M5 12.5l4.5 4.5L19 7.5",
  lane: "M4 7h10M4 12h16M4 17h7M17 4l3 3-3 3",
  later: "M12 7.5V12l3 2M12 21a9 9 0 1 1 0-18 9 9 0 0 1 0 18z",
  people:
    "M16 19v-1.5a3.5 3.5 0 0 0-3.5-3.5h-5A3.5 3.5 0 0 0 4 17.5V19M10 10.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM20 19v-1.5a3.5 3.5 0 0 0-2.5-3.4M15.5 3.6a3.5 3.5 0 0 1 0 6.8",
  paperclip: "M8 12.5l6.4-6.4a3 3 0 0 1 4.3 4.3l-8 8a5 5 0 0 1-7.1-7.1l7.4-7.4",
  thread: "M4.5 5.5h15v10h-9l-6 4z",
  more: "M5.5 12h.01M12 12h.01M18.5 12h.01",
  image: "M4 5.5h16v13H4zM4 15.5l5-5 4 4 3-3 4 4M15.5 9h.01",
  download: "M12 4v11M7 10l5 5 5-5M5 20h14",
  external: "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5",
  unsubscribe: "M4 6h16M4 12h9M4 18h6M15 15l5 5M20 15l-5 5",
  select: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM8 12.5l3 3 5-6",
  circle: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z",
  send: "M4 12l16-8-6 16-2.5-6.5z",
  spark: "M12 3.5l1.8 5.2 5.2 1.8-5.2 1.8L12 17.5l-1.8-5.2-5.2-1.8 5.2-1.8z",
  inbox: "M4 13.5l2.5-8h11l2.5 8v5H4zM4 13.5h5l1 2h4l1-2h5",
} as const;

export type MailGlyphName = keyof typeof MAIL_GLYPHS;

export function MailGlyph({
  name,
  size = 24,
  strokeWidth = 1.9,
  className,
  label,
  fill = "none",
}: {
  name: MailGlyphName;
  size?: number;
  strokeWidth?: number;
  className?: string;
  label?: string;
  fill?: string;
}) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill={fill}
      stroke="currentColor"
      strokeWidth={name === "more" ? 3 : strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      focusable="false"
    >
      {label ? <title>{label}</title> : null}
      <path d={MAIL_GLYPHS[name]} />
    </svg>
  );
}

/**
 * SourceBadge — the small letter square naming which connected account
 * ("inbox") a row or event came from (docs/product-vocabulary.md). Colour is
 * never the only signal: the letter and the title/label carry it too.
 */
import type { InboxOption, InboxProvider } from "@klorn/contract";

export interface SourceStyle {
  letter: string;
  colorVar: string;
}

export function sourceStyle(
  provider: InboxProvider | string,
  purpose?: string | null,
): SourceStyle {
  switch (provider) {
    case "GOOGLE":
      return purpose === "work"
        ? { letter: "W", colorVar: "var(--source-work)" }
        : { letter: "G", colorVar: "var(--source-gmail)" };
    case "OUTLOOK":
      return { letter: "O", colorVar: "var(--source-outlook)" };
    case "NAVER":
      return { letter: "N", colorVar: "var(--source-naver)" };
    case "ICLOUD":
      return { letter: "i", colorVar: "var(--source-icloud)" };
    default:
      return { letter: "M", colorVar: "var(--source-imap)" };
  }
}

export function SourceBadge({
  inbox,
  size = 18,
  title,
}: {
  inbox: Pick<InboxOption, "provider" | "purpose">;
  size?: number;
  title?: string;
}) {
  const style = sourceStyle(inbox.provider, inbox.purpose);
  return (
    <span
      className="source-badge"
      title={title}
      aria-hidden={title ? undefined : true}
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size / 3),
        background: style.colorVar,
        fontSize: `calc(${Math.round(size * 0.55)} * var(--u))`,
      }}
    >
      {style.letter}
    </span>
  );
}

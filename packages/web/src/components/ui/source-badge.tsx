/**
 * SourceBadge (productization plan §1/§2, P2) — which connected account a
 * row or event came from. Neutral by rule: a raised chip with a 1px line and
 * a monochrome monogram (G, M, N, iC, IMAP, K), never a brand colour or logo,
 * so a unified list stays one calm surface and no provider outranks another.
 *
 * The monogram is decorative to assistive tech; the chip's accessible name is
 * spelled out ("From Google · work@"), so a screen reader never hears "G".
 */

import type { InboxProvider } from "@klorn/contract";
import { sourceGlyph, sourceLabel } from "../../lib/source-provider";

/** Wire providers plus the native Klorn mailbox. Unknown values render as a
 *  generic mail source, per the contract's forward-compat rule. */
export type SourceProvider = InboxProvider | "KLORN";

export interface SourceBadgeProps {
  provider: SourceProvider | (string & {});
  /** Short account nickname shown after the glyph, e.g. "work@". */
  nickname?: string | null;
  className?: string;
}

export function SourceBadge({ provider, nickname, className = "" }: SourceBadgeProps) {
  const { glyph } = sourceGlyph(provider);
  const nick = nickname?.trim();
  return (
    <span
      role="img"
      aria-label={sourceLabel(provider, nick)}
      title={sourceLabel(provider, nick)}
      className={`inline-flex max-w-40 shrink-0 items-center gap-1 rounded-full border border-line bg-surface-raised px-1.5 py-px text-caption text-ink-muted ${className}`}
    >
      <span aria-hidden="true" className="font-semibold tracking-tight text-ink-soft">
        {glyph}
      </span>
      {nick && (
        <span aria-hidden="true" className="truncate">
          {nick}
        </span>
      )}
    </span>
  );
}

export default SourceBadge;

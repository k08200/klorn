"use client";

/**
 * The quieter lists that share the Approvals page (productization plan §1:
 * Screener and Commitments move to Approvals). Both are optional reading next
 * to the approvals themselves, so each renders nothing when it is empty. The
 * Commitments list lives in commitments-section.tsx; the heading is shared.
 */

import { useState } from "react";
import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import { formatRelativeIntl } from "../../../lib/text";
import type { PendingSender, ScreenerVerdict } from "../../../lib/use-screener";

export function SectionHeading({ id, title, count }: { id: string; title: string; count: number }) {
  return (
    <div className="flex min-h-11 items-center gap-2 border-b border-line">
      <h2 id={id} className="text-role-head text-ink">
        {title}
      </h2>
      <span className="flex-1" />
      <p className="text-role-label tabular-nums text-ink-soft">{count}</p>
    </div>
  );
}

/** Rows shown before the list collapses behind "show more". */
const SENDER_LIMIT = 5;

interface ScreenerSectionProps {
  senders: PendingSender[];
  deciding: Readonly<Record<string, ScreenerVerdict>>;
  onDecide: (sender: string, verdict: ScreenerVerdict) => void;
}

/**
 * First-contact senders. Nothing is held: their mail is sorted and delivered
 * whether or not anyone rules here, and the copy says so.
 */
export function ScreenerSection({ senders, deciding, onDecide }: ScreenerSectionProps) {
  const { t, locale } = useT();
  const [showAll, setShowAll] = useState(false);
  if (senders.length === 0) return null;
  const rows = showAll ? senders : senders.slice(0, SENDER_LIMIT);
  const hidden = senders.length - rows.length;
  return (
    <section aria-labelledby="hub-screener">
      <SectionHeading id="hub-screener" title={t("screener.title")} count={senders.length} />
      <p className="pt-2 text-role-caption text-ink-muted [word-break:keep-all]">
        {t("screener.subtitle")}
      </p>
      <ul>
        {rows.map((row) => {
          const busy = Object.hasOwn(deciding, row.sender) ? deciding[row.sender] : null;
          return (
            <li
              key={row.sender}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line-soft py-2 last:border-b-0"
            >
              <div className="min-w-0 flex-1 basis-40">
                <p className="truncate text-role-body font-medium text-ink" title={row.sender}>
                  {row.sender}
                </p>
                <p className="text-role-caption text-ink-muted">
                  {row.lastReceivedAt
                    ? t("screener.meta", {
                        count: String(row.messageCount),
                        when: formatRelativeIntl(row.lastReceivedAt, locale, t("screener.justNow")),
                      })
                    : t("screener.metaNoDate", { count: String(row.messageCount) })}
                </p>
              </div>
              <div className="flex shrink-0 gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  loading={busy === "ALLOW"}
                  disabled={busy !== null}
                  aria-label={t("assistantHub.screener.allowSender", { sender: row.sender })}
                  onClick={() => onDecide(row.sender, "ALLOW")}
                >
                  {t("screener.allow")}
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  className="text-state-danger-ink"
                  loading={busy === "BLOCK"}
                  disabled={busy !== null}
                  aria-label={t("assistantHub.screener.blockSender", { sender: row.sender })}
                  onClick={() => onDecide(row.sender, "BLOCK")}
                >
                  {t("screener.block")}
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
      {hidden > 0 && (
        <Button variant="ghost" size="sm" onClick={() => setShowAll(true)} className="-ml-3">
          {t("screener.showAll", { count: String(hidden) })}
        </Button>
      )}
      <p className="pt-1 text-role-caption text-ink-muted [word-break:keep-all]">
        {t("screener.noHold")}
      </p>
    </section>
  );
}

"use client";

import type { LiveTier } from "@klorn/contract";
import { useT } from "../../lib/i18n";
import { LaneChip } from "../ui/lane-chip";
import { SourceBadge } from "../ui/source-badge";

interface PreviewRow {
  lane: LiveTier;
  source: "GOOGLE" | "NAVER";
  /** Key segment under auth.preview.<key>.{from,subject,reason}. */
  key: string;
  time: string;
}

// Demo data, rendered with the app's own LaneChip and SourceBadge so the panel
// is the product rather than a picture of it. One row per lane, in lane order.
const ROWS: readonly PreviewRow[] = [
  { lane: "PUSH", source: "GOOGLE", key: "push", time: "9:12" },
  { lane: "MEETING", source: "GOOGLE", key: "meeting", time: "8:47" },
  { lane: "QUEUE", source: "NAVER", key: "queue", time: "8:05" },
  { lane: "INFO", source: "GOOGLE", key: "info", time: "7:30" },
  { lane: "SILENT", source: "NAVER", key: "silent", time: "" },
];

/**
 * The sign-in page's wide-screen panel: one message per lane, each with the
 * reason it landed there — the product's core promise, shown rather than
 * claimed. Labelled as demo data; the caption says lanes sort and never act.
 */
export default function LanePreview() {
  const { t } = useT();
  return (
    <figure aria-label={t("auth.preview.label")} className="w-full max-w-lg">
      <div className="overflow-hidden rounded-card border border-line bg-surface-panel shadow-l2">
        <div className="flex h-11 items-center justify-between border-b border-line px-4">
          <span className="text-label text-ink">{t("nav.mail")}</span>
          <span className="rounded-full border border-line px-2 py-0.5 text-caption text-ink-mid">
            {t("auth.preview.demo")}
          </span>
        </div>
        <ul className="divide-y divide-line-soft">
          {ROWS.map((row) => (
            <li key={row.lane} className="grid grid-cols-[5.25rem_minmax(0,1fr)] gap-3 px-4 py-3.5">
              <div className="pt-0.5">
                <LaneChip tier={row.lane} />
              </div>
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <SourceBadge provider={row.source} />
                  <span className="truncate text-label text-ink">
                    {t(`auth.preview.${row.key}.from`)}
                  </span>
                  {row.time && (
                    <span className="ml-auto shrink-0 text-caption tabular-nums text-ink-dim">
                      {row.time}
                    </span>
                  )}
                </div>
                <p className="mt-0.5 truncate text-body text-ink-soft">
                  {t(`auth.preview.${row.key}.subject`)}
                </p>
                <p className="mt-1 text-caption text-ink-mid">
                  {t(`auth.preview.${row.key}.reason`)}
                </p>
              </div>
            </li>
          ))}
        </ul>
      </div>
      <figcaption className="mt-5 max-w-md text-body text-pretty text-ink-mid">
        {t("auth.preview.caption")}
      </figcaption>
    </figure>
  );
}

"use client";

import { LaneChip } from "@/components/ui/lane-chip";
import { useT } from "@/lib/i18n";
import { CORE_TIERS } from "@/lib/tiers";
import { METHODOLOGY_URL } from "./chrome";

/** First visit: what the five lanes mean, before any result exists. */
export function LaneLegend() {
  const { t } = useT();
  return (
    <div className="flex flex-col gap-5">
      <div>
        <h2 className="text-title tracking-tight text-ink">{t("playground.legend.title")}</h2>
        <p className="mt-2 text-body text-ink-soft">{t("playground.legend.sub")}</p>
      </div>
      <ul className="flex flex-col gap-3">
        {CORE_TIERS.map((tier) => (
          <li key={tier} className="flex items-start gap-3">
            <span className="w-22 shrink-0 pt-px">
              <LaneChip tier={tier} />
            </span>
            <span className="text-body text-ink-soft">{t(`playground.legend.${tier}`)}</span>
          </li>
        ))}
      </ul>
      <p className="text-caption text-ink-mid">
        {t("playground.legend.scores")}{" "}
        <a href={METHODOLOGY_URL} className="text-accent-deep underline underline-offset-2">
          {t("playground.legend.link")}
        </a>
      </p>
    </div>
  );
}

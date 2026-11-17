"use client";

/**
 * "N of M interruptions today" (attention engine v3, behind its flag): drawn
 * only from the budget the Today PUSH read already carries (model.ts
 * coverMeter); without it the caller draws no meter at all — never a
 * made-up count. Shown on the phone brief (phone-today.tsx).
 */

import { useT } from "../../lib/i18n";
import type { CoverMeter } from "./model";

export function InterruptMeter({ meter }: { meter: CoverMeter }) {
  const { t, locale } = useT();
  const number = new Intl.NumberFormat(locale);
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-role-caption tabular-nums text-ink-muted">
        {t("today.cover.meter", {
          used: number.format(meter.used),
          limit: number.format(meter.limit),
        })}
      </p>
      <div aria-hidden="true" className="h-1 w-full overflow-hidden rounded-full bg-surface-inset">
        <div
          className="h-full rounded-full bg-tier-push-ink"
          style={{ width: `${meter.ratio * 100}%` }}
        />
      </div>
    </div>
  );
}

/**
 * LaneChip — which lane a message landed in. One spec on every surface
 * (design detail pass X1, Row.dc canvas): Title case, 12/600, height 22,
 * padding 0 8, radius 6, a 6px dot in the lane ink, the label in the chip ink
 * on a 12% wash of the lane ink. Never uppercase: the label is the lane's
 * name ("Push"), localized through `lane.name.*`, not the wire value.
 *
 * The plain lane ink fails 4.5:1 once the wash sits under it, so the label
 * uses `--tier-<lane>-chip-ink`, measured against the composited chip on every
 * row surface in both themes. Pinned by
 * packages/api/src/__tests__/web-lane-chip-contrast.test.ts, which reads the
 * values out of globals.css and the tint out of this file. Retired values
 * never render: AUTO and CALL fold through `toLiveTier`. Callers with no
 * recorded lane render no chip — never a guess.
 */

import type { LiveTier, Tier } from "@klorn/contract";
import { useT } from "../../lib/i18n";
import { toLiveTier } from "../../lib/tiers";

/** Tint strength in percent; must match the `/12` in every class below
 *  (web-lane-chip-contrast.test.ts asserts both, then measures with it). */
export const LANE_CHIP_TINT_PERCENT = 12;

// Static class strings so Tailwind can see them. Record keys are exempt from
// the lane-vocabulary guard; tint and label both ride theme-aware tokens.
const CHIP_CLASS: Record<LiveTier, string> = {
  PUSH: "bg-tier-push-ink/12 text-tier-push-chip-ink",
  MEETING: "bg-tier-meeting-ink/12 text-tier-meeting-chip-ink",
  QUEUE: "bg-tier-queue-ink/12 text-tier-queue-chip-ink",
  INFO: "bg-tier-info-ink/12 text-tier-info-chip-ink",
  SILENT: "bg-tier-silent-ink/12 text-tier-silent-chip-ink",
};

/** The 6px dot: the lane ink itself (a non-text mark, 3:1 is its floor). */
export const LANE_DOT_CLASS: Record<LiveTier, string> = {
  PUSH: "bg-tier-push-ink",
  MEETING: "bg-tier-meeting-ink",
  QUEUE: "bg-tier-queue-ink",
  INFO: "bg-tier-info-ink",
  SILENT: "bg-tier-silent-ink",
};

/** Text in a lane's chip ink, for reason lines and segmented tabs. */
export const LANE_INK_CLASS: Record<LiveTier, string> = {
  PUSH: "text-tier-push-chip-ink",
  MEETING: "text-tier-meeting-chip-ink",
  QUEUE: "text-tier-queue-chip-ink",
  INFO: "text-tier-info-chip-ink",
  SILENT: "text-tier-silent-chip-ink",
};

/** The localized lane name ("Push"), never the uppercase wire value. */
export function useLaneName(): (tier: Tier) => string {
  const { t } = useT();
  return (tier) => t(`lane.name.${toLiveTier(tier)}`);
}

export interface LaneChipProps {
  /** A recorded lane. Retired values (AUTO) are folded, never shown. */
  tier: Tier;
  className?: string;
}

export function LaneChip({ tier, className = "" }: LaneChipProps) {
  const { t } = useT();
  const lane = toLiveTier(tier);
  return (
    <span
      data-lane={lane}
      className={`inline-flex h-5.5 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-control px-2 text-caption font-semibold ${CHIP_CLASS[lane]} ${className}`}
    >
      <span
        aria-hidden="true"
        className={`size-1.5 shrink-0 rounded-full ${LANE_DOT_CLASS[lane]}`}
      />
      <span className="sr-only">{t("mailV2.lanes.label")} </span>
      {t(`lane.name.${lane}`)}
    </span>
  );
}

export default LaneChip;

/**
 * LaneChip v2 (productization plan §2, P2) — which lane a message landed in.
 *
 * Capsule, `text-caption` (12px; the old 10px chip is retired), a 13% tint of
 * the lane's ink under a dedicated chip ink. The plain lane ink fails 4.5:1
 * once the tint sits under it (light queue 3.86, info 4.10; dark meeting
 * 4.00), so the label uses `--tier-<lane>-chip-ink`, measured against the
 * composited chip on every row surface. Worst case, composited 13% tint:
 *
 *   lane      light (#fff/#fafafa/#f8fafc/#f1f5f9)   dark (#0b1120…#1e293b)
 *   PUSH      #9f1239  5.84:1                         #fda4af  6.43:1
 *   MEETING   #4338ca  5.95:1                         #a5b4fc  5.99:1
 *   QUEUE     #92400e  5.45:1                         #fbbf24  6.58:1
 *   INFO      #155e75  5.56:1                         #22d3ee  6.14:1
 *   SILENT    #57534e  5.76:1                         #a8a29e  4.61:1
 *
 * Pinned by packages/api/src/__tests__/web-lane-chip-contrast.test.ts, which
 * reads the values out of globals.css. Retired values never render: AUTO and
 * CALL fold through `toLiveTier`. Callers with no recorded lane render no
 * chip — never a guess.
 */

import type { LiveTier, Tier } from "@klorn/contract";
import { toLiveTier } from "../../lib/tiers";

// Static class strings so Tailwind can see them. Record keys are exempt from
// the lane-vocabulary guard; tint and label both ride theme-aware tokens.
const CHIP_CLASS: Record<LiveTier, string> = {
  PUSH: "bg-tier-push-ink/13 text-tier-push-chip-ink",
  MEETING: "bg-tier-meeting-ink/13 text-tier-meeting-chip-ink",
  QUEUE: "bg-tier-queue-ink/13 text-tier-queue-chip-ink",
  INFO: "bg-tier-info-ink/13 text-tier-info-chip-ink",
  SILENT: "bg-tier-silent-ink/13 text-tier-silent-chip-ink",
};

export interface LaneChipProps {
  /** A recorded lane. Retired values (AUTO) are folded, never shown. */
  tier: Tier;
  className?: string;
}

export function LaneChip({ tier, className = "" }: LaneChipProps) {
  const lane = toLiveTier(tier);
  return (
    <span
      data-lane={lane}
      className={`inline-flex shrink-0 items-center rounded-full px-2 py-0.5 text-caption font-medium tracking-wide tabular-nums ${CHIP_CLASS[lane]} ${className}`}
    >
      <span className="sr-only">Lane </span>
      {lane}
    </span>
  );
}

export default LaneChip;

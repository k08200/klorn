"use client";

/**
 * The phone's lane filter (mobile redesign PR3, MB1 "Editorial Brief",
 * LOCKED 2026-11-14): below 600px Mail opens with a row of chips — Push,
 * Meeting, Queue, Info, Silent, each with its lane dot and count, then All —
 * on ToggleChips (components/ui/toggle-chips.tsx): the current view's chip is
 * filled, the row scrolls sideways and fades at an edge with chips past it,
 * so Silent and All read as there before they are scrolled to.
 *
 * Same view state as the lane control from 600px (mail-header.tsx): a chip
 * changes `view.lane`, which Today's quiet line preselects
 * (today/mail-link.ts). Silent is a chip here — the phone has no room for the
 * desktop's "Show silenced" detour, and the board names all five lanes.
 */

import type { EmailLaneCounts, LiveTier } from "@klorn/contract";
import { useLaneName } from "../../../components/ui/lane-chip";
import { type ToggleChip, ToggleChips } from "../../../components/ui/toggle-chips";
import { useT } from "../../../lib/i18n";
import { CORE_TIERS } from "../../../lib/tiers";
import { LANE_DOT } from "./mail-header";
import type { LaneView } from "./model";

interface LaneChipsProps {
  value: LaneView;
  counts: EmailLaneCounts | null;
  onChange: (lane: LaneView) => void;
  /** Threads are not a lane view: the chips stand down. */
  disabled: boolean;
  className?: string;
}

export function LaneChips({ value, counts, onChange, disabled, className = "" }: LaneChipsProps) {
  const { t, locale } = useT();
  const laneName = useLaneName();
  const number = new Intl.NumberFormat(locale);

  const laneChip = (lane: LiveTier): ToggleChip<LaneView> => {
    const name = laneName(lane);
    const total = counts?.[lane].total ?? null;
    const unread = counts?.[lane].unread ?? 0;
    const spoken =
      total === null ? name : t("mailV2.list.laneCount", { lane: name, count: String(total) });
    const active = value === lane;
    return {
      id: lane,
      ariaLabel:
        unread > 0
          ? `${spoken}, ${t("mailV2.list.laneUnread", { lane: name, count: String(unread) })}`
          : spoken,
      content: (
        <>
          <span
            aria-hidden="true"
            className={`size-1.5 rounded-full ${LANE_DOT[lane]} ${active ? "ring-2 ring-accent-solid-ink/70" : ""}`}
          />
          {name}
          {total !== null && (
            <span className={`tabular-nums ${active ? "" : "text-ink-muted"}`}>
              {number.format(total)}
            </span>
          )}
        </>
      ),
    };
  };

  return (
    <ToggleChips
      label={t("mailV2.lanes.label")}
      testId="lane-chips"
      bleed
      className={className}
      chips={[...CORE_TIERS.map(laneChip), { id: "ALL", content: t("mailV2.lane.all") }]}
      value={value}
      onChange={onChange}
      disabled={disabled}
    />
  );
}

export default LaneChips;

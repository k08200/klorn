"use client";

/**
 * The lane picker a left swipe opens (productization plan §3, P10): the five
 * lanes, the current one marked. Choosing one only reclassifies the mail,
 * through the caller's lane move (use-lane-move: optimistic, with undo); it
 * never touches the mailbox. The same choice is in the row's lane menu, for
 * keyboard and screen-reader users.
 */

import type { LiveTier } from "@klorn/contract";
import Button from "../../../components/ui/button";
import { Sheet } from "../../../components/ui/sheet";
import { useT } from "../../../lib/i18n";
import { CORE_TIERS } from "../../../lib/tiers";
import { LANE_DOT } from "./mail-header";

interface LaneSheetProps {
  /** The mail being moved; null keeps the sheet closed. */
  target: { subject: string; tier: LiveTier | null } | null;
  onPick: (tier: LiveTier) => void;
  onClose: () => void;
}

export function LaneSheet({ target, onPick, onClose }: LaneSheetProps) {
  const { t } = useT();
  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={t("mailV2.reader.moveTo")}
      description={target?.subject}
      closeLabel={t("mailV2.dismiss")}
    >
      <ul className="flex flex-col gap-1">
        {CORE_TIERS.map((lane) => {
          const current = target?.tier === lane;
          return (
            <li key={lane}>
              <Button
                variant="ghost"
                aria-pressed={current}
                onClick={() => {
                  onClose();
                  if (!current) onPick(lane);
                }}
                className="h-12 w-full justify-start gap-3"
              >
                <span aria-hidden="true" className={`size-2.5 rounded-full ${LANE_DOT[lane]}`} />
                <span className="flex-1 text-left">{lane}</span>
                {current && (
                  <span className="text-caption text-ink-muted">{t("mailV2.swipe.current")}</span>
                )}
              </Button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

export default LaneSheet;

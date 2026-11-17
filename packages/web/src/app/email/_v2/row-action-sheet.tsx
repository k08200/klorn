"use client";

/**
 * A row's actions on a touch screen (mobile redesign PR3, MB1): the bottom
 * sheet the row's 44px "More actions" button opens. Every swipe action is
 * here — Later and Done first — then read state, Select, the other reminder
 * times and the five lanes (the current one marked). Each runs the list's own
 * action (use-mail-actions: archive with undo, reminder with a toast; the lane
 * move with undo), so the outcome is announced the same way a swipe's is. A
 * blocked action stays visible, disabled, with its reason.
 */

import type { EmailListItem, LiveTier } from "@klorn/contract";
import type { ReactNode } from "react";
import Button from "../../../components/ui/button";
import { useLaneName } from "../../../components/ui/lane-chip";
import { Sheet } from "../../../components/ui/sheet";
import { useT } from "../../../lib/i18n";
import { CORE_TIERS } from "../../../lib/tiers";
import { ArchiveIcon, ClockIcon, ReadIcon, UnreadIcon } from "./icons";
import { LANE_DOT } from "./mail-header";
import { REMINDER_LABEL_KEYS, type ReminderKey } from "./reminders";

/** A Later from a swipe, the sheet or the reader's phone bar: later today. */
export const QUICK_LATER: ReminderKey = "later-today";
const OTHER_REMINDERS: readonly ReminderKey[] = ["tomorrow", "next-week"];

export interface RowActionTarget {
  email: EmailListItem;
  subject: string;
  /** Translated reasons; null when the action can run. */
  blocked: { archive: string | null; later: string | null; lanes: string | null };
}

interface RowActionSheetProps {
  target: RowActionTarget | null;
  busy: boolean;
  onClose: () => void;
  onArchive: (email: EmailListItem) => void;
  onRemind: (email: EmailListItem, key: ReminderKey) => void;
  onSetRead: (email: EmailListItem, isRead: boolean) => void;
  onSelect: (email: EmailListItem) => void;
  onMoveLane: (email: EmailListItem, tier: LiveTier) => void;
}

interface SheetActionProps {
  icon?: ReactNode;
  label: string;
  reason?: string | null;
  disabled?: boolean;
  pressed?: boolean;
  trailing?: ReactNode;
  onRun: () => void;
}

function SheetAction({
  icon,
  label,
  reason,
  disabled,
  pressed,
  trailing,
  onRun,
}: SheetActionProps) {
  return (
    <li>
      <Button
        variant="ghost"
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onRun}
        className="min-h-12 w-full justify-start gap-3"
      >
        {icon}
        <span className="flex min-w-0 flex-1 flex-col text-left">
          <span>{label}</span>
          {reason && <span className="text-role-caption text-ink-muted">{reason}</span>}
        </span>
        {trailing}
      </Button>
    </li>
  );
}

function SectionHeading({ children }: { children: ReactNode }) {
  return <h3 className="px-3 pb-1 pt-3 text-role-caption text-ink-muted">{children}</h3>;
}

export function RowActionSheet({ target, busy, onClose, ...on }: RowActionSheetProps) {
  const { t } = useT();
  const laneName = useLaneName();
  const email = target?.email ?? null;
  const blocked = target?.blocked ?? { archive: null, later: null, lanes: null };
  // Close first, then act: the sheet's opener may be on a row the action removes.
  const run = (action: (mail: EmailListItem) => void) => () => {
    onClose();
    if (email) action(email);
  };
  return (
    <Sheet
      open={target !== null}
      onClose={onClose}
      title={t("mailV2.reader.actions")}
      description={target?.subject}
      closeLabel={t("mailV2.dismiss")}
    >
      {email && (
        <div className="flex flex-col">
          <ul className="flex flex-col gap-1">
            <SheetAction
              icon={<ClockIcon />}
              label={t("mailV2.reader.later")}
              reason={blocked.later ?? t(REMINDER_LABEL_KEYS[QUICK_LATER])}
              disabled={busy || blocked.later !== null}
              onRun={run((mail) => on.onRemind(mail, QUICK_LATER))}
            />
            <SheetAction
              icon={<ArchiveIcon />}
              label={t("mailV2.reader.done")}
              reason={blocked.archive}
              disabled={busy || blocked.archive !== null}
              onRun={run(on.onArchive)}
            />
            <SheetAction
              icon={email.isRead ? <UnreadIcon /> : <ReadIcon />}
              label={t(email.isRead ? "mailV2.row.markUnread" : "mailV2.row.markRead")}
              disabled={busy}
              onRun={run((mail) => on.onSetRead(mail, !mail.isRead))}
            />
            <SheetAction label={t("mailV2.row.select")} onRun={run(on.onSelect)} />
          </ul>
          <SectionHeading>{t("mailV2.list.remind")}</SectionHeading>
          <ul className="flex flex-col gap-1">
            {OTHER_REMINDERS.map((key) => (
              <SheetAction
                key={key}
                label={t(REMINDER_LABEL_KEYS[key])}
                disabled={busy || blocked.later !== null}
                onRun={run((mail) => on.onRemind(mail, key))}
              />
            ))}
          </ul>
          <SectionHeading>{blocked.lanes ?? t("mailV2.reader.moveTo")}</SectionHeading>
          <ul className="flex flex-col gap-1">
            {CORE_TIERS.map((lane) => {
              const current = email.tier === lane;
              return (
                <SheetAction
                  key={lane}
                  icon={
                    <span
                      aria-hidden="true"
                      className={`size-2.5 rounded-full ${LANE_DOT[lane]}`}
                    />
                  }
                  label={laneName(lane)}
                  pressed={current}
                  disabled={blocked.lanes !== null}
                  trailing={
                    current && (
                      <span className="text-role-caption text-ink-muted">
                        {t("mailV2.swipe.current")}
                      </span>
                    )
                  }
                  onRun={current ? onClose : run((mail) => on.onMoveLane(mail, lane as LiveTier))}
                />
              );
            })}
          </ul>
        </div>
      )}
    </Sheet>
  );
}

export default RowActionSheet;

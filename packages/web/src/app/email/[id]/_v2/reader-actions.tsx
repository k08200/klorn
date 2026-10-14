"use client";

/**
 * Mail v2 reader actions (productization plan §1/§3, P5b). One set of actions,
 * two layouts: a row under the header from 768px, and on a phone a bottom bar
 * (Reply, Archive) whose More menu holds the rest. Every action is one the
 * reader already had; this file only arranges them. An action that cannot run
 * says why (demo mail, a mail with no lane yet, an account that needs
 * reconnecting) instead of silently doing nothing.
 */

import type { LiveTier } from "@klorn/contract";
import Button from "../../../../components/ui/button";
import { Menu, type MenuSection } from "../../../../components/ui/menu";
import { useT } from "../../../../lib/i18n";
import { CORE_TIERS } from "../../../../lib/tiers";
import { ArchiveIcon, ClockIcon, MoreIcon, ReplyIcon } from "../../_v2/icons";
import { LANE_DOT } from "../../_v2/mail-header";
import { REMINDER_KEYS, REMINDER_LABEL_KEYS, type ReminderKey } from "../../_v2/reminders";
import type { EmailDetail } from "../types";

export interface ReaderActionsProps {
  email: EmailDetail;
  /** The recorded lane; null while unsorted or while the context is loading. */
  tier: LiveTier | null;
  /** The legacy reader's busy key ("archive", "read", …); null when idle. */
  busy: string | null;
  reminderBusy: boolean;
  isDemo: boolean;
  accountNeedsReconnect: boolean;
  /** Name the keys in the tooltips (KEYBOARD_TRIAGE). */
  keyboardTriage: boolean;
  onReply: () => void;
  onArchive: () => void;
  onDelete: () => void;
  onToggleRead: () => void;
  onToggleStar: () => void;
  onUnsubscribe: () => void;
  onRemind: (key: ReminderKey) => void;
  onMoveLane: (lane: LiveTier) => void;
}

function useReaderMenus(props: ReaderActionsProps) {
  const { email, tier, isDemo } = props;
  const { t } = useT();
  const idle = props.busy === null;
  const laneBlocked = isDemo ? t("keys.reason.demo") : tier ? null : t("keys.reason.notClassified");

  const lanes: MenuSection = {
    id: "lanes",
    // The heading doubles as the reason when lanes cannot be changed.
    heading: laneBlocked ?? t("mailV2.reader.moveTo"),
    items: CORE_TIERS.map((lane) => ({
      id: lane,
      label: lane,
      leading: <span aria-hidden="true" className={`size-2 rounded-full ${LANE_DOT[lane]}`} />,
      kind: "radio" as const,
      checked: tier === lane,
      disabled: laneBlocked !== null,
      onSelect: () => {
        if (lane !== tier) props.onMoveLane(lane);
      },
    })),
  };

  const remind: MenuSection = {
    id: "remind",
    heading: t("mailV2.list.remind"),
    items: REMINDER_KEYS.map((key) => ({
      id: key,
      label: t(REMINDER_LABEL_KEYS[key]),
      disabled: isDemo || props.reminderBusy,
      onSelect: () => props.onRemind(key),
    })),
  };

  const more: MenuSection = {
    id: "more",
    items: [
      {
        id: "read",
        label: t(email.isRead ? "mailV2.row.markUnread" : "mailV2.row.markRead"),
        disabled: isDemo || !idle,
        onSelect: props.onToggleRead,
      },
      {
        id: "star",
        label: t(
          email.isStarred ? "emailDetail.toolbar.action.unstar" : "emailDetail.toolbar.action.star",
        ),
        disabled: isDemo || !idle,
        onSelect: props.onToggleStar,
      },
      ...(email.unsubscribe
        ? [
            {
              id: "unsubscribe",
              label: t("emailDetail.toolbar.action.unsubscribe"),
              disabled: isDemo || !idle,
              onSelect: props.onUnsubscribe,
            },
          ]
        : []),
      {
        id: "delete",
        label: t("common.delete"),
        disabled: isDemo || !idle,
        onSelect: props.onDelete,
      },
    ],
  };

  const archiveBlocked = isDemo
    ? t("keys.reason.demo")
    : props.accountNeedsReconnect
      ? t("mailV2.reader.reconnectToArchive")
      : null;
  const hint = (label: string, key: string) => (props.keyboardTriage ? `${label} (${key})` : label);

  return { lanes, remind, more, archiveBlocked, idle, hint };
}

const ARCHIVE_REASON_ID = "reader-archive-reason";

/** From 768px: the actions in a row under the header. */
export function ReaderActionsRow(props: ReaderActionsProps) {
  const { t } = useT();
  const { lanes, remind, more, archiveBlocked, idle, hint } = useReaderMenus(props);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar groups actions; <menu>/<fieldset> are not that
    <div
      role="toolbar"
      aria-label={t("mailV2.reader.actions")}
      className="flex flex-wrap items-center gap-2 max-md:hidden"
    >
      <Button
        variant="primary"
        size="sm"
        icon={<ReplyIcon />}
        title={hint(t("keys.reply"), "R")}
        onClick={props.onReply}
      >
        {t("keys.reply")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<ArchiveIcon />}
        title={archiveBlocked ?? hint(t("mailV2.row.archive"), "E")}
        aria-describedby={archiveBlocked ? ARCHIVE_REASON_ID : undefined}
        disabled={archiveBlocked !== null || !idle}
        loading={props.busy === "archive"}
        onClick={props.onArchive}
      >
        {t("mailV2.row.archive")}
      </Button>
      {archiveBlocked && (
        <span id={ARCHIVE_REASON_ID} className="sr-only">
          {archiveBlocked}
        </span>
      )}
      <Menu label={t("mailV2.reader.moveTo")} sections={[lanes]}>
        {t("mailV2.reader.moveTo")}
      </Menu>
      <Menu label={t("mailV2.list.remind")} sections={[remind]}>
        <ClockIcon />
        {t("mailV2.list.remind")}
      </Menu>
      <Menu label={t("mailV2.more.label")} variant="icon" sections={[more]}>
        <MoreIcon />
      </Menu>
    </div>
  );
}

/**
 * Below 768px: Reply and Archive stay in reach above the tab bar; the lane,
 * the reminder and the rest open upward from More. 44px targets throughout.
 * The bar floats on the assistant dock's row (the dock button is fixed at
 * bottom 96px, right 16px, 48px square) and stops short of it, so the two
 * never overlap; the dock itself is untouched.
 */
export function ReaderBottomBar(props: ReaderActionsProps) {
  const { t } = useT();
  const { lanes, remind, more, archiveBlocked, idle } = useReaderMenus(props);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar groups actions; <menu>/<fieldset> are not that
    <div
      role="toolbar"
      aria-label={t("mailV2.reader.actions")}
      className="fixed bottom-23.5 left-4 right-20 z-30 flex items-center gap-1 rounded-card border border-line bg-surface-elevated p-1 shadow-l2 md:hidden"
    >
      <Button
        variant="primary"
        size="sm"
        icon={<ReplyIcon />}
        onClick={props.onReply}
        className="flex-1"
      >
        {t("keys.reply")}
      </Button>
      <Button
        variant="secondary"
        size="sm"
        icon={<ArchiveIcon />}
        title={archiveBlocked ?? undefined}
        disabled={archiveBlocked !== null || !idle}
        loading={props.busy === "archive"}
        onClick={props.onArchive}
        className="flex-1"
      >
        {t("mailV2.row.archive")}
      </Button>
      <Menu
        label={t("mailV2.more.label")}
        variant="icon"
        align="end"
        side="top"
        sections={[lanes, remind, more]}
      >
        <MoreIcon />
      </Menu>
    </div>
  );
}

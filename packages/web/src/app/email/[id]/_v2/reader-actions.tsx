"use client";

/**
 * Mail v2 reader actions (productization plan §1/§3, P5b). One set of actions,
 * two layouts: a row under the header from 600px, and on a phone (mobile
 * redesign PR3, MB1, LOCKED 2026-11-14) a bottom bar — Reply, Later, Done —
 * with the rest (lanes, the other reminders, read state, star, delete) in the
 * top bar's More menu. Every action is one the
 * reader already had; this file only arranges them. An action that cannot run
 * says why (demo mail, a mail with no lane yet, an account that needs
 * reconnecting) instead of silently doing nothing.
 */

import type { LiveTier } from "@klorn/contract";
import Button from "../../../../components/ui/button";
import { useLaneName } from "../../../../components/ui/lane-chip";
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
  onDraft: () => void;
  drafting: boolean;
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
  const laneName = useLaneName();
  const idle = props.busy === null;
  const laneBlocked = isDemo ? t("keys.reason.demo") : tier ? null : t("keys.reason.notClassified");

  const lanes: MenuSection = {
    id: "lanes",
    // The heading doubles as the reason when lanes cannot be changed.
    heading: laneBlocked ?? t("mailV2.reader.moveTo"),
    items: CORE_TIERS.map((lane) => ({
      id: lane,
      label: laneName(lane),
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

/**
 * The lane control for the header's lane line (Reader.dc): a chip that opens
 * the five lanes. "Move to lane" never names the current lane on the chip;
 * the menu marks it.
 */
export function ReaderLaneMenu(props: ReaderActionsProps) {
  const { t } = useT();
  const { lanes } = useReaderMenus(props);
  return (
    <Menu label={t("mailV2.reader.moveTo")} align="end-from-md" tall="phone" sections={[lanes]}>
      {t("mailV2.reader.moveTo")}
    </Menu>
  );
}

function KeyHint({ k, onAccent = false }: { k: string; onAccent?: boolean }) {
  return (
    <span
      aria-hidden="true"
      className={`rounded-chip border px-1 font-sans text-role-caption leading-4 ${
        onAccent ? "border-accent-solid-ink/40" : "border-line-strong text-ink-muted"
      }`}
    >
      {k}
    </span>
  );
}

/**
 * From 768px: the actions in a row under the header (Reader.dc): Reply as the
 * one primary, then Draft with Klorn, Later and Done as secondary, then the
 * overflow. Done is the archive; Later sets a reminder.
 */
export function ReaderActionsRow(props: ReaderActionsProps) {
  const { t } = useT();
  const { remind, more, archiveBlocked, idle, hint } = useReaderMenus(props);
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar groups actions; <menu>/<fieldset> are not that
    <div
      role="toolbar"
      aria-label={t("mailV2.reader.actions")}
      className="flex flex-wrap items-center gap-2 max-rail:hidden"
    >
      <Button variant="primary" title={hint(t("keys.reply"), "R")} onClick={props.onReply}>
        {t("keys.reply")}
        {props.keyboardTriage && <KeyHint k="R" onAccent />}
      </Button>
      <Button
        variant="secondary"
        disabled={props.isDemo}
        loading={props.drafting}
        onClick={props.onDraft}
      >
        {t("mailV2.reader.draftWithKlorn")}
      </Button>
      <Menu label={t("mailV2.list.remind")} variant="secondary" sections={[remind]}>
        {t("mailV2.reader.later")}
      </Menu>
      <Button
        variant="secondary"
        title={archiveBlocked ?? hint(t("mailV2.row.archive"), "E")}
        aria-describedby={archiveBlocked ? ARCHIVE_REASON_ID : undefined}
        disabled={archiveBlocked !== null || !idle}
        loading={props.busy === "archive"}
        onClick={props.onArchive}
      >
        {t("mailV2.reader.done")}
        {props.keyboardTriage && <KeyHint k="E" />}
      </Button>
      {archiveBlocked && (
        <span id={ARCHIVE_REASON_ID} className="sr-only">
          {archiveBlocked}
        </span>
      )}
      <Menu label={t("mailV2.more.label")} variant="secondaryIcon" align="end" sections={[more]}>
        <MoreIcon />
      </Menu>
    </div>
  );
}

/** Later from the phone bar: one tap, the reader's first reminder choice. */
const QUICK_LATER: ReminderKey = "later-today";

/**
 * Below 600px: the reader is full screen (no tab bar, no floating assistant
 * button), so Reply, Later and Done sit on the bottom edge above the
 * home-indicator inset, full width, 44px each. Later is one tap (later
 * today, POST /api/email/:id/later); the other times are in More.
 */
export function ReaderBottomBar(props: ReaderActionsProps) {
  const { t } = useT();
  const { archiveBlocked, idle } = useReaderMenus(props);
  const laterBlocked = props.isDemo ? t("keys.reason.demo") : null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a toolbar groups actions; <menu>/<fieldset> are not that
    <div
      role="toolbar"
      aria-label={t("mailV2.reader.actions")}
      className="fixed inset-x-0 bottom-0 z-30 grid grid-cols-[1.4fr_1fr_1fr] gap-2 border-t border-line bg-surface-panel/95 px-4 pt-2 pb-[calc(0.5rem+env(safe-area-inset-bottom))] shadow-menu rail:hidden backdrop-blur-xl"
    >
      <Button
        variant="primary"
        size="lg"
        icon={<ReplyIcon />}
        onClick={props.onReply}
        className="px-3"
      >
        {t("keys.reply")}
      </Button>
      <Button
        variant="secondary"
        size="lg"
        icon={<ClockIcon />}
        title={laterBlocked ?? t(REMINDER_LABEL_KEYS[QUICK_LATER])}
        disabled={laterBlocked !== null || props.reminderBusy}
        loading={props.reminderBusy}
        onClick={() => props.onRemind(QUICK_LATER)}
        className="px-3"
      >
        {t("mailV2.reader.later")}
      </Button>
      <Button
        variant="secondary"
        size="lg"
        icon={<ArchiveIcon />}
        title={archiveBlocked ?? undefined}
        disabled={archiveBlocked !== null || !idle}
        loading={props.busy === "archive"}
        onClick={props.onArchive}
        className="px-3"
      >
        {t("mailV2.reader.done")}
      </Button>
    </div>
  );
}

/** The phone's More (in the reader's top bar): lanes, every reminder, the rest. */
export function ReaderPhoneMore(props: ReaderActionsProps) {
  const { t } = useT();
  const { lanes, remind, more } = useReaderMenus(props);
  return (
    <Menu
      label={t("mailV2.more.label")}
      variant="icon"
      align="end"
      tall
      scroll
      sections={[remind, lanes, more]}
    >
      <MoreIcon />
    </Menu>
  );
}

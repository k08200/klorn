"use client";

/**
 * One bell row (NC1 A). Top to bottom: who + time, subject, why it rang, then
 * lane · where it was delivered with the row's actions on the right. The row
 * summary is a real <button> stretched over the row; the action buttons sit
 * above it (z-10) so no interactive element nests inside another.
 *
 * Every string from the server renders as a React text node — the reason may
 * be model output and is never parsed as HTML or markdown.
 */

import { useT } from "../../lib/i18n";
import {
  type CenterNotification,
  deliveredToLabel,
  isAgentTitle,
  mailRowParts,
  monogram,
  reasonLine,
  rowLane,
} from "../../lib/notification-center";
import { notificationLinkTarget } from "../../lib/notification-target";
import { formatRelativeIntl } from "../../lib/text";
import { LANE_DOT_CLASS, useLaneName } from "../ui/lane-chip";
import { TypeIcon, typeGlyph } from "./type-icon";

export type RowBusy = "approve" | "reject" | "later" | null;

export interface NotificationRowProps {
  n: CenterNotification;
  busy: RowBusy;
  /** "Mac · Chrome" from the lazy delivery lookup, when it answered. */
  deliveredLabel?: string | null;
  onOpen: (n: CenterNotification) => void;
  onReply: (n: CenterNotification) => void;
  onLater: (n: CenterNotification) => void;
  onJoin: (n: CenterNotification, url: string) => void;
  onApprove: (n: CenterNotification) => void;
  onReject: (n: CenterNotification) => void;
}

// Muted monogram fill. Lightness 34% keeps white initials above 4.5:1 on
// every hue (the brightest, yellow-green, measures about 5.2:1).
const AVATAR_SAT = 28;
const AVATAR_LIGHT = 34;

const ACTION_BASE =
  "focus-ring relative z-10 inline-flex h-6.5 items-center rounded-chip px-2.5 text-role-caption font-medium transition pointer-coarse:min-h-11 pointer-coarse:px-3.5 disabled:cursor-not-allowed disabled:opacity-50";
const ACTION_PRIMARY = `${ACTION_BASE} bg-surface-inset text-ink hover:bg-surface-hover`;
const ACTION_QUIET = `${ACTION_BASE} text-ink-soft hover:bg-surface-hover hover:text-ink`;
const ACTION_SOLID = `${ACTION_BASE} bg-accent-solid text-accent-solid-ink hover:bg-accent-solid-hover`;

function Leading({ n, who, person }: { n: CenterNotification; who: string; person: boolean }) {
  if (person) {
    const { initials, hue } = monogram(who);
    return (
      <span
        aria-hidden="true"
        className="flex size-7.5 shrink-0 items-center justify-center rounded-full text-role-caption font-semibold"
        style={{
          backgroundColor: `hsl(${hue} ${AVATAR_SAT}% ${AVATAR_LIGHT}%)`,
          color: "hsl(0 0% 100%)",
        }}
      >
        {initials}
      </span>
    );
  }
  return (
    <span
      aria-hidden="true"
      className="flex size-7.5 shrink-0 items-center justify-center rounded-full bg-surface-inset text-ink-soft"
    >
      <TypeIcon glyph={typeGlyph(n.type, isAgentTitle(n.title))} />
    </span>
  );
}

function ActionStatus({ status }: { status: string }) {
  const { t } = useT();
  const label =
    status === "EXECUTED"
      ? t("notif.status.done")
      : status === "REJECTED"
        ? t("notif.status.rejected")
        : status;
  return <span className="text-role-caption text-ink-muted">{label}</span>;
}

function RowActions(props: NotificationRowProps) {
  const { n, busy, onReply, onLater, onJoin, onApprove, onReject } = props;
  const { t } = useT();
  if (n.pendingActionId && n.pendingActionStatus === "PENDING") {
    return (
      <>
        <button
          type="button"
          onClick={() => onApprove(n)}
          disabled={busy !== null}
          className={ACTION_SOLID}
        >
          {busy === "approve" ? "…" : t("notif.approve")}
        </button>
        <button
          type="button"
          onClick={() => onReject(n)}
          disabled={busy !== null}
          className={ACTION_QUIET}
        >
          {busy === "reject" ? "…" : t("notif.reject")}
        </button>
      </>
    );
  }
  if (n.pendingActionId && n.pendingActionStatus) {
    return <ActionStatus status={n.pendingActionStatus} />;
  }
  if (n.sourceEmailId) {
    return (
      <>
        <button type="button" onClick={() => onReply(n)} className={ACTION_PRIMARY}>
          {t("notifCenter.reply")}
        </button>
        <button
          type="button"
          onClick={() => onLater(n)}
          disabled={busy !== null}
          className={ACTION_QUIET}
        >
          {busy === "later" ? "…" : t("notifCenter.later")}
        </button>
      </>
    );
  }
  const link =
    n.type === "meeting" || n.type === "calendar" ? notificationLinkTarget(n.link) : null;
  if (link?.kind === "external") {
    return (
      <button type="button" onClick={() => onJoin(n, link.url)} className={ACTION_PRIMARY}>
        {t("notifCenter.join")}
      </button>
    );
  }
  return null;
}

function MetaLine({ n, lazy }: { n: CenterNotification; lazy?: string | null }) {
  const { t } = useT();
  const laneName = useLaneName();
  const lane = rowLane(n.lane);
  const where = deliveredToLabel(n.deliveredTo) ?? lazy ?? null;
  if (!lane && !where) return null;
  return (
    <span className="flex min-w-0 items-center gap-1.5 truncate text-role-caption text-ink-muted">
      {lane && (
        <span className="inline-flex shrink-0 items-center gap-1.5">
          <span aria-hidden="true" className={`size-1.5 rounded-full ${LANE_DOT_CLASS[lane]}`} />
          {laneName(lane)}
        </span>
      )}
      {lane && where && <span aria-hidden="true">·</span>}
      {where && <span className="truncate">{t("notifCenter.deliveredTo", { where })}</span>}
    </span>
  );
}

export function NotificationRow(props: NotificationRowProps) {
  const { n, onOpen } = props;
  const { t, locale } = useT();
  const { who, subject, person } = mailRowParts(n);
  const reason = reasonLine(n.reason);
  const actions = RowActions(props);
  const meta = MetaLine({ n, lazy: props.deliveredLabel });
  return (
    <li className="relative flex gap-3 border-t border-line px-4 py-3 hover:bg-surface-hover">
      {!n.isRead && (
        <span
          aria-hidden="true"
          className="absolute top-[27px] left-1.5 size-1.5 -translate-y-1/2 rounded-full bg-accent"
        />
      )}
      <Leading n={n} who={who} person={person} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <button
          type="button"
          data-nc-row=""
          onClick={() => onOpen(n)}
          className="focus-ring min-w-0 rounded-chip text-left after:absolute after:inset-0 after:content-['']"
        >
          <span className="flex items-baseline justify-between gap-2">
            <span className="truncate text-role-label font-semibold text-ink">
              {!n.isRead && <span className="sr-only">{t("notifCenter.unreadMark")} </span>}
              {who}
            </span>
            <span className="shrink-0 text-role-caption text-ink-muted">
              {formatRelativeIntl(n.createdAt, locale, t("notifCenter.justNow"))}
            </span>
          </span>
          <span className="block truncate text-role-meta text-ink">{subject}</span>
          {reason && (
            <span className="mt-0.5 block line-clamp-2 text-role-meta text-ink-soft">
              {reason.kind === "quote"
                ? reason.text
                : t("notifCenter.judgment", { text: reason.text })}
            </span>
          )}
        </button>
        {(actions || meta) && (
          <div className="mt-1 flex min-h-6.5 items-center gap-2">
            {meta}
            {actions && <span className="ml-auto flex shrink-0 items-center gap-1">{actions}</span>}
          </div>
        )}
      </div>
    </li>
  );
}

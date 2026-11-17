"use client";

/**
 * One PUSH mail on the phone brief (mobile redesign PR2, MB1 "Editorial
 * Brief"): who and when, the PUSH kicker, then WHY it rang as the title — a
 * verified quote in curly quotes, else the judge's text as "Klorn's call · …"
 * in muted ink — the subject under it, and Reply / Later as 44px targets.
 * Reply opens the reader on its reply box; Later is the one-tap reminder
 * (POST /api/email/:id/later), the same as the cover cards had. Mail text and
 * the judge's reason are model or sender output: text nodes only, never HTML.
 */

import type { EmailListItem } from "@klorn/contract";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "../../components/toast";
import Button from "../../components/ui/button";
import { useLaneName } from "../../components/ui/lane-chip";
import { MonogramAvatar } from "../../components/ui/monogram-avatar";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";
import { formatRowTime, senderName } from "../email/_v2/model";
import { postReminder } from "../email/_v2/post-reminder";
import { REMINDER_LABEL_KEYS, type ReminderKey } from "../email/_v2/reminders";
import { pushWhy } from "./brief-model";
import type { TimeContext } from "./mail-column";

const CARD_LATER: ReminderKey = "later-today";

const ACTION_BASE =
  "focus-ring flex min-h-11 items-center justify-center rounded-control px-3 text-role-label font-semibold transition-colors duration-120 ease-fluid";
const REPLY_PRIMARY = `${ACTION_BASE} bg-accent-solid text-accent-solid-ink hover:bg-accent-solid-hover`;
const REPLY_SECONDARY = `${ACTION_BASE} border border-line-strong bg-surface-panel text-ink hover:bg-surface-hover`;

interface PushBriefCardProps {
  email: EmailListItem;
  time: TimeContext;
  isDemo: boolean;
  /** The first card carries the one primary action on the screen. */
  primary: boolean;
  /** Below 360px Later collapses to an icon. */
  compact: boolean;
}

export function PushBriefCard({ email, time, isDemo, primary, compact }: PushBriefCardProps) {
  const { t } = useT();
  const laneName = useLaneName();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const titleId = `brief-why-${email.id}`;
  const sender = senderName(email.from);
  const why = pushWhy(email);
  const subject = email.subject || t("today.mail.noSubject");
  const laterLabel = t("mailV2.reader.later");

  const later = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await postReminder(email.id, CARD_LATER);
      toast(t("mailV2.list.remind.set", { when: t(REMINDER_LABEL_KEYS[CARD_LATER]) }), "success");
    } catch (err) {
      captureClientError(err, { scope: "today.brief.later" });
      toast(t("mailV2.list.remind.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      data-testid="brief-card"
      aria-labelledby={titleId}
      className="flex flex-col gap-2 rounded-card bg-surface-panel p-4 shadow-[0_1px_2px_rgb(10_14_20/0.05)] ring-1 ring-inset ring-line"
    >
      <div className="flex items-center gap-2.5">
        <MonogramAvatar name={sender} />
        <span className="min-w-0 flex-1 truncate text-role-label font-semibold text-ink">
          {sender}
        </span>
        <time
          dateTime={email.date}
          className="shrink-0 text-role-caption tabular-nums text-ink-muted"
        >
          {formatRowTime(email.date, time.now, time.locale, time.timeZone)}
        </time>
        <span className="shrink-0 text-role-caption font-semibold uppercase tracking-[0.08em] text-tier-push-ink">
          {laneName("PUSH")}
        </span>
      </div>
      <h2
        id={titleId}
        data-testid="brief-why"
        className={`line-clamp-3 text-role-head font-semibold [word-break:keep-all] ${why?.kind === "judgment" ? "text-ink-muted" : "text-ink"}`}
      >
        {why === null
          ? subject
          : why.kind === "quote"
            ? why.text
            : t("notifCenter.judgment", { text: why.text })}
      </h2>
      {why !== null && (
        <p className="truncate text-[0.84375rem] leading-[1.35] text-ink-muted">{subject}</p>
      )}
      <div className={`mt-1 grid gap-2 ${compact ? "grid-cols-[1fr_auto]" : "grid-cols-2"}`}>
        <Link
          href={`/email/${encodeURIComponent(email.id)}?markRead=false&queue=all&focus=reply`}
          className={primary ? REPLY_PRIMARY : REPLY_SECONDARY}
        >
          {t("keys.reply")}
        </Link>
        {compact ? (
          <Button
            variant="secondary"
            size="icon"
            aria-label={laterLabel}
            className="size-11"
            disabled={isDemo}
            title={isDemo ? t("keys.reason.demo") : laterLabel}
            loading={busy}
            onClick={() => void later()}
          >
            <ClockGlyph />
          </Button>
        ) : (
          <Button
            variant="secondary"
            size="lg"
            className="min-h-11 w-full px-3"
            disabled={isDemo}
            title={isDemo ? t("keys.reason.demo") : undefined}
            loading={busy}
            onClick={() => void later()}
          >
            {laterLabel}
          </Button>
        )}
      </div>
    </article>
  );
}

function ClockGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 20 20"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="10" cy="10" r="7" />
      <path d="M10 6.5V10l2.5 1.5" />
    </svg>
  );
}

"use client";

/**
 * One mail as a card with Reply and Later — the cover screen's "Needs you
 * now" cards (cover-view.tsx) and Today's "Held back" group (held-back.tsx).
 * Later is one tap: the reader's first choice, later today.
 */

import type { EmailListItem } from "@klorn/contract";
import Link from "next/link";
import { useState } from "react";
import { useToast } from "../../components/toast";
import Button from "../../components/ui/button";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";
import { formatRowTime, senderName } from "../email/_v2/model";
import { postReminder } from "../email/_v2/post-reminder";
import { REMINDER_LABEL_KEYS, type ReminderKey } from "../email/_v2/reminders";
import type { TimeContext } from "./mail-column";

const CARD_LATER: ReminderKey = "later-today";

export function ReplyLaterCard({
  email,
  time,
  isDemo,
  idPrefix,
  headingLevel = "h2",
}: {
  email: EmailListItem;
  time: TimeContext;
  isDemo: boolean;
  /** Keeps the subject id unique when the same mail shows in two groups. */
  idPrefix: string;
  headingLevel?: "h2" | "h3";
}) {
  const { t } = useT();
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const subjectId = `${idPrefix}-subject-${email.id}`;
  const subject = email.subject || t("today.mail.noSubject");
  const reason = email.tierReason?.trim() || null;
  const Heading = headingLevel;

  const later = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await postReminder(email.id, CARD_LATER);
      toast(t("mailV2.list.remind.set", { when: t(REMINDER_LABEL_KEYS[CARD_LATER]) }), "success");
    } catch (err) {
      captureClientError(err, { scope: `today.${idPrefix}.later` });
      toast(t("mailV2.list.remind.failed"), "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <article
      aria-labelledby={subjectId}
      className="flex flex-col gap-1 rounded-card bg-surface-panel p-4 ring-1 ring-line"
    >
      <div className="flex items-baseline gap-2">
        <span className="min-w-0 flex-1 truncate text-role-label font-semibold text-ink">
          {senderName(email.from)}
        </span>
        <time
          dateTime={email.date}
          className="shrink-0 text-role-caption tabular-nums text-ink-muted"
        >
          {formatRowTime(email.date, time.now, time.locale, time.timeZone)}
        </time>
      </div>
      <Heading id={subjectId} className="line-clamp-2 text-role-body text-ink">
        {subject}
      </Heading>
      {reason && <p className="truncate text-role-caption text-tier-push-chip-ink">{reason}</p>}
      <div className="mt-2 grid grid-cols-2 gap-2">
        <Link
          href={`/email/${encodeURIComponent(email.id)}?markRead=false&queue=all&focus=reply`}
          className="focus-ring flex min-h-11 items-center justify-center rounded-control bg-accent-solid px-3 text-role-label font-semibold text-accent-solid-ink transition-colors duration-120 ease-fluid hover:bg-accent-solid-hover"
        >
          {t("keys.reply")}
        </Link>
        <Button
          variant="secondary"
          size="lg"
          className="min-h-11 w-full px-3"
          disabled={isDemo}
          title={isDemo ? t("keys.reason.demo") : undefined}
          loading={busy}
          onClick={() => void later()}
        >
          {t("mailV2.reader.later")}
        </Button>
      </div>
    </article>
  );
}

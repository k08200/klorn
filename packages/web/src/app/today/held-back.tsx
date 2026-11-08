"use client";

/**
 * Today's "Held back · N" group (founder design N2, LOCKED 2026-11-08): mail
 * urgent enough to ring that the daily interrupt budget held, so it waited in
 * Queue without a notification. Collapsed to one line; "Show" opens the same
 * Reply · Later cards as the cover screen. Nothing new is sent from here.
 *
 * Renders nothing unless the PUSH read carries the budget (attention engine
 * v3, behind its flag) and the held read lists at least one thread today.
 */

import { useId, useState } from "react";
import Button from "../../components/ui/button";
import { useLaneName } from "../../components/ui/lane-chip";
import { useT } from "../../lib/i18n";
import { LaneMoreLink } from "./block";
import type { TimeContext } from "./mail-column";
import { MAIL_HREF, preselectMailLane } from "./mail-link";
import { heldBack } from "./model";
import { ReplyLaterCard } from "./reply-later-card";
import { useHeldMail, useLaneMail } from "./use-today-data";

export function HeldBackGroup({
  time,
  idPrefix,
  className = "",
}: {
  time: TimeContext;
  /** Keeps ids unique between the phone layout and the cover screen. */
  idPrefix: string;
  className?: string;
}) {
  const { t, locale } = useT();
  const laneName = useLaneName();
  const [open, setOpen] = useState(false);
  const listId = useId();
  // Shares the PUSH block's query (same key): no extra request.
  const push = useLaneMail("PUSH", true);
  const budget = push.interruptBudget;
  const held = useHeldMail(Boolean(budget));
  const group = heldBack(budget, held.emails, held.total);
  if (!group) return null;
  const headingId = `${idPrefix}-heading`;
  const number = new Intl.NumberFormat(locale);
  return (
    <section aria-labelledby={headingId} className={`flex min-w-0 flex-col gap-2.5 ${className}`}>
      <div className="flex items-center gap-3 rounded-card bg-surface-panel py-2 pl-4 pr-2 ring-1 ring-line">
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-role-head tabular-nums text-ink">
            {t("today.held.title", { count: number.format(group.count) })}
          </h2>
          <p className="text-role-caption text-ink-muted [word-break:keep-all]">
            {t("today.held.caption")}
          </p>
        </div>
        <Button
          variant="ghost"
          size="lg"
          aria-expanded={open}
          aria-controls={listId}
          onClick={() => setOpen((was) => !was)}
          className="shrink-0 px-3 text-accent-deep"
        >
          {open ? t("today.held.hide") : t("today.held.show")}
        </Button>
      </div>
      <div id={listId} hidden={!open}>
        {open && (
          <ul className="flex flex-col gap-3">
            {group.shown.map((email) => (
              <li key={email.id}>
                <ReplyLaterCard
                  email={email}
                  time={time}
                  isDemo={held.isDemo}
                  idPrefix={idPrefix}
                  headingLevel="h3"
                />
              </li>
            ))}
          </ul>
        )}
        {open && group.more > 0 && (
          <LaneMoreLink href={MAIL_HREF} onClick={() => preselectMailLane("QUEUE")}>
            {t("today.mail.moreInLane", {
              count: number.format(group.more),
              lane: laneName("QUEUE"),
            })}
          </LaneMoreLink>
        )}
      </div>
    </section>
  );
}

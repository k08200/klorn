"use client";

/**
 * Meeting prep inside the briefing card (CONTEXT_MEETING_PREP_ENABLED): for
 * each meeting of the next 24 hours, up to three things to review first, each
 * linked to its source. Minimal on purpose — the design session owns the
 * final UI; this renders the server's block as plain text (titles and
 * subjects come from mail and invites, so they are never markup).
 */

import type { MeetingPrep, MeetingPrepBlock } from "@klorn/contract";
import Link from "next/link";
import { useT } from "../../../lib/i18n";
import { PREP_KEYS, prepItemLine } from "./meeting-prep-lines";

const LINK_CLASS =
  "focus-ring inline-flex min-h-11 items-center rounded-control text-role-label text-accent-deep hover:underline";

function format(
  iso: string,
  locale: string,
  timeZone: string,
  options: Intl.DateTimeFormatOptions,
) {
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    // An unknown zone name: the reader's own zone is the next best answer.
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
}

function PrepMeeting({ meeting, timeZone }: { meeting: MeetingPrep; timeZone: string }) {
  const { t, locale } = useT();
  const time = format(meeting.startTime, locale, timeZone, { hour: "numeric", minute: "2-digit" });
  const formatDay = (iso: string) =>
    format(iso, locale, timeZone, { weekday: "short", month: "short", day: "numeric" });
  return (
    <li className="border-b border-line-soft py-3 last:border-b-0">
      <Link href={`/calendar/${encodeURIComponent(meeting.eventId)}`} className={LINK_CLASS}>
        <span className="tabular-nums">{time}</span>
        <span aria-hidden="true">&nbsp;·&nbsp;</span>
        <span className="[word-break:keep-all]">{meeting.title}</span>
      </Link>
      <ul className="mt-1 flex flex-col gap-1">
        {meeting.items.map((item) => {
          const line = prepItemLine(item, t, formatDay);
          const key = item.source.kind === "email" ? item.source.emailId : item.source.commitmentId;
          return (
            <li key={key} className="flex flex-wrap items-center gap-x-3">
              <span className="text-role-body text-ink [word-break:keep-all]">{line.text}</span>
              <Link
                href={line.href}
                className={LINK_CLASS}
                aria-label={`${t(line.linkLabelKey)}: ${line.text}`}
              >
                {t(line.linkLabelKey)}
              </Link>
            </li>
          );
        })}
      </ul>
    </li>
  );
}

export function MeetingPrepSection({
  block,
  timeZone,
}: {
  block: MeetingPrepBlock | null;
  timeZone: string;
}) {
  const { t } = useT();
  if (!block || block.meetings.length === 0) return null;
  return (
    <section
      aria-labelledby="hub-briefing-prep"
      className="rounded-card border border-line p-4 md:p-5"
    >
      <h2 id="hub-briefing-prep" className="text-role-head text-ink">
        {t(PREP_KEYS.title)}
      </h2>
      <ul>
        {block.meetings.map((meeting) => (
          <PrepMeeting key={meeting.eventId} meeting={meeting} timeZone={timeZone} />
        ))}
      </ul>
    </section>
  );
}

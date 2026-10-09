"use client";

/**
 * Mail v2 reader header (productization plan §1, P5b): the subject, who and
 * when, and everything that left the list row — the account, the lane with its
 * reason, and the secondary facts (needs reply, first contact, category,
 * engagement, priority). Only the lane is coloured; the facts are quiet text.
 */

import type { EmailReaderContextResponse } from "@klorn/contract";
import { LaneChip } from "../../../../components/ui/lane-chip";
import { Skeleton } from "../../../../components/ui/skeleton";
import { SourceBadge } from "../../../../components/ui/source-badge";
import { useT } from "../../../../lib/i18n";
import { sourceGlyph } from "../../../../lib/source-provider";
import { type AccountOption, senderName } from "../../_v2/model";
import type { EmailDetail } from "../types";

export interface ReaderFacts {
  /** Localized priority, only when it is not the ordinary one. */
  priority: string | null;
  /** Localized category label. */
  category: string | null;
}

interface ReaderHeaderProps {
  email: EmailDetail;
  context: EmailReaderContextResponse | null;
  /** The context has not answered yet: draw a placeholder, not "unsorted". */
  contextPending: boolean;
  account: AccountOption | null;
  facts: ReaderFacts;
  locale: string;
  timeZone: string;
}

function formatWhen(iso: string, locale: string, timeZone: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

/** The address inside "Name <addr>"; empty when the header is only an address. */
function addressBesideName(from: string): string {
  const match = /<([^>]+)>/.exec(from);
  const address = match?.[1]?.trim() ?? "";
  return address && address !== senderName(from) ? address : "";
}

/** The facts line, in the order a reader needs them. Absent facts claim nothing. */
function useFactLabels({ email, context, facts }: ReaderHeaderProps): string[] {
  const { t } = useT();
  const replied = context?.repliedCount ?? 0;
  return [
    email.isRead === false ? t("mail.filterUnread") : null,
    email.needsReply ? t("mail.filterReplyNeeded") : null,
    context?.firstContact ? t("mailV2.reader.firstContact") : null,
    replied === 1 ? t("mailV2.reader.replied.one") : null,
    replied > 1 ? t("mailV2.reader.replied.many", { count: String(replied) }) : null,
    facts.category,
    facts.priority,
    email.isStarred ? t("mailV2.reader.starred") : null,
  ].filter((label): label is string => Boolean(label));
}

function LaneLine({ context, contextPending }: ReaderHeaderProps) {
  const { t } = useT();
  if (!context) {
    // Still loading, or the context request failed: no lane is claimed.
    return contextPending ? <Skeleton width="w-48" /> : null;
  }
  if (!context.tier) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-body text-ink-mid">
        <span className="shrink-0 rounded-full border border-dashed border-line-strong px-2 py-px text-caption text-ink-muted">
          {t("mailV2.row.sorting")}
        </span>
        {t("mailV2.reader.unsorted")}
      </p>
    );
  }
  return (
    <div className="flex min-w-0 items-start gap-2">
      <LaneChip tier={context.tier} className="mt-0.5" />
      {context.tierReason && (
        // One line until opened: the summary is the reason itself.
        <details className="group min-w-0 flex-1">
          <summary className="focus-ring cursor-pointer list-none truncate rounded-control py-0.5 text-body text-ink-mid group-open:whitespace-normal pointer-coarse:py-3 [&::-webkit-details-marker]:hidden">
            <span className="sr-only">{t("mailV2.reader.whyLane")} </span>
            {context.tierReason}
          </summary>
        </details>
      )}
    </div>
  );
}

export function ReaderHeader(props: ReaderHeaderProps) {
  const { email, account, locale, timeZone } = props;
  const { t } = useT();
  const factLabels = useFactLabels(props);
  const address = addressBesideName(email.from);
  const accountName = account ? (account.email ?? sourceGlyph(account.provider).name) : null;
  const recipients = [
    email.to ? t("mailV2.reader.to", { recipients: email.to }) : null,
    email.cc ? t("mailV2.reader.cc", { recipients: email.cc }) : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <header className="flex flex-col gap-3">
      <h1 className="break-keep text-display text-ink [overflow-wrap:anywhere]">
        {email.subject || t("mailV2.noSubject")}
      </h1>

      <div className="flex flex-col gap-1">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
          <p className="min-w-0 max-w-full truncate text-head text-ink">
            {senderName(email.from)}
            {address && <span className="ml-2 text-body text-ink-muted">{address}</span>}
          </p>
          <time
            dateTime={email.date}
            className="ml-auto shrink-0 text-caption tabular-nums text-ink-muted"
          >
            {formatWhen(email.date, locale, timeZone)}
          </time>
        </div>
        <div className="flex min-w-0 items-center gap-2">
          {account && accountName && (
            <span title={t("mailV2.reader.account", { account: accountName })} className="shrink-0">
              <SourceBadge provider={account.provider} nickname={account.nickname} />
              <span className="sr-only">
                {t("mailV2.reader.account", { account: accountName })}
              </span>
            </span>
          )}
          {recipients && (
            <p title={recipients} className="min-w-0 truncate text-caption text-ink-muted">
              {recipients}
            </p>
          )}
        </div>
      </div>

      <LaneLine {...props} />

      {factLabels.length > 0 && (
        <ul className="flex flex-wrap gap-x-2 gap-y-1 text-caption text-ink-muted">
          {factLabels.map((label, index) => (
            <li key={label} className="flex items-center gap-2">
              {index > 0 && <span aria-hidden="true">·</span>}
              {label}
            </li>
          ))}
        </ul>
      )}
    </header>
  );
}

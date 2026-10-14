"use client";

/**
 * Today, column C — the assistant strip (productization plan §1, P6): the
 * stored briefing as one paragraph, how many approvals are waiting, and an ask
 * box that opens the assistant with the question in its composer. Loading the
 * page calls no model: the briefing is read as stored, and the question is
 * sent only when the user sends it in the assistant.
 */

import type { BriefingStatus } from "@klorn/contract";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import Button from "../../components/ui/button";
import { Skeleton, SkeletonGroup } from "../../components/ui/skeleton";
import { askAssistant } from "../../lib/assistant-ask";
import { ASSISTANT_BRIEFING, assistantHref } from "../../lib/home";
import { useT } from "../../lib/i18n";
import { BlockError, BlockLink, Chevron, LinesSkeleton, TodayBlock } from "./block";
import { useBriefing, usePendingApprovals } from "./use-today-data";

const BRIEFING_SETTINGS_HREF = "/settings/notifications";
const ASK_MAX_LENGTH = 4000;

export function AssistantColumn({ className = "" }: { className?: string }) {
  const { t } = useT();
  return (
    <TodayBlock headingId="today-assistant" title={t("nav.assistant")} className={className}>
      <BriefingSummary />
      <ApprovalsRow />
      <AskBox />
    </TodayBlock>
  );
}

/** "It arrives at 08:00", or how to switch it on — never an empty box. */
function dayOneCopy(
  status: BriefingStatus | null,
  t: (key: string, vars?: Record<string, string>) => string,
) {
  const { enabled, briefingTime } = status?.automation ?? { enabled: false, briefingTime: null };
  if (enabled && briefingTime) return t("today.briefing.arrivesAt", { time: briefingTime });
  if (enabled) return t("today.briefing.arrives");
  return t("today.briefing.off");
}

function BriefingSummary() {
  const { t } = useT();
  const briefing = useBriefing(true);
  const preview = briefing.status?.note?.preview?.trim();
  const scheduled = briefing.status?.automation.enabled === true;
  return (
    <div className="border-b border-line-soft py-3">
      <h3 className="text-caption font-medium text-ink-muted">{t("today.briefing.title")}</h3>
      {briefing.loading && <LinesSkeleton lines={3} label={t("today.briefing.loading")} />}
      {briefing.failed && (
        <BlockError message={t("today.briefing.error")} onRetry={briefing.retry} />
      )}
      {!briefing.loading && !briefing.failed && (
        <>
          <p
            className={`mt-1 line-clamp-6 whitespace-pre-line text-body [word-break:keep-all] ${preview ? "text-ink-strong" : "text-ink-muted"}`}
          >
            {preview || dayOneCopy(briefing.status, t)}
          </p>
          {preview || scheduled ? (
            <BlockLink href={ASSISTANT_BRIEFING}>{t("today.briefing.open")}</BlockLink>
          ) : (
            <BlockLink href={BRIEFING_SETTINGS_HREF}>{t("today.briefing.setUp")}</BlockLink>
          )}
        </>
      )}
    </div>
  );
}

function ApprovalsRow() {
  const { t } = useT();
  const approvals = usePendingApprovals(true);
  if (approvals.failed) {
    return (
      <div className="border-b border-line-soft">
        <BlockError message={t("today.approvals.error")} onRetry={approvals.retry} />
      </div>
    );
  }
  const count = approvals.count ?? 0;
  return (
    <Link
      href={assistantHref()}
      className="focus-ring -mx-3 flex min-h-13 items-center gap-2 rounded-card px-3 text-label text-ink transition-colors duration-120 ease-fluid hover:bg-surface-hover"
    >
      {approvals.loading ? (
        <SkeletonGroup label={t("today.approvals.loading")} className="flex-1">
          <Skeleton width="w-40" />
        </SkeletonGroup>
      ) : (
        <>
          {count > 0 && (
            <span className="min-w-6 rounded-full bg-accent-solid px-1.5 py-px text-center text-caption font-semibold tabular-nums text-accent-solid-ink">
              {count > 99 ? "99+" : count}
            </span>
          )}
          <span className={`flex-1 ${count > 0 ? "" : "font-normal text-ink-muted"}`}>
            {count === 0
              ? t("today.approvals.none")
              : count === 1
                ? t("today.approvals.one")
                : t("today.approvals.many", { count: String(count) })}
          </span>
        </>
      )}
      <span className="text-ink-muted">
        <Chevron />
      </span>
    </Link>
  );
}

function AskBox() {
  const { t } = useT();
  const [text, setText] = useState("");
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const question = text.trim();
    if (!question) return;
    askAssistant(question);
    setText("");
  };
  return (
    <form onSubmit={submit} className="flex items-center gap-2 border-t border-line-soft pt-3">
      <label htmlFor="today-ask" className="sr-only">
        {t("today.ask.label")}
      </label>
      <input
        id="today-ask"
        type="text"
        value={text}
        onChange={(event) => setText(event.target.value)}
        maxLength={ASK_MAX_LENGTH}
        placeholder={t("today.ask.placeholder")}
        autoComplete="off"
        className="focus-ring h-11 min-w-0 flex-1 rounded-control border border-line bg-surface-panel px-3 text-body text-ink placeholder:text-ink-muted"
      />
      <Button type="submit" variant="secondary" disabled={!text.trim()}>
        {t("today.ask.submit")}
      </Button>
    </form>
  );
}

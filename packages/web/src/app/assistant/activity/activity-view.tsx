"use client";

/**
 * Activity (productization plan §1, P7) — the receipt: what Klorn did and
 * decided today, after the fact. One timeline, newest first, grouped by the
 * part of the day. It is read-only history; the one control, "Request undo",
 * does not undo anything by itself — it puts a reversal in Approvals.
 */

import Link from "next/link";
import { useMemo, useState } from "react";
import { useToast } from "../../../components/toast";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { type Segment, SegmentedControl } from "../../../components/ui/segmented-control";
import { Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { useAuth } from "../../../lib/auth";
import { ASSISTANT_APPROVALS } from "../../../lib/home";
import { useT } from "../../../lib/i18n";
import { useReceipt } from "../../inbox/receipt/use-receipt";
import { BlockError } from "../../today/block";
import { HubHeader, RefreshGlyph } from "../hub-frame";
import {
  ACTIVITY_KINDS,
  type ActivityEntry,
  type ActivityKind,
  activityEntries,
  activityReasonKey,
  activitySubjectKey,
  activityTitle,
  type DayPart,
  groupByDayPart,
} from "./model";

const DEFAULT_TIME_ZONE = "Asia/Seoul";

type Filter = "all" | ActivityKind;

const KIND_KEYS: ReadonlyMap<ActivityKind, string> = new Map([
  ["handled", "assistantHub.activity.kind.handled"],
  ["notified", "assistantHub.activity.kind.notified"],
  ["queued", "assistantHub.activity.kind.queued"],
  ["silenced", "assistantHub.activity.kind.silenced"],
]);

const PART_KEYS: ReadonlyMap<DayPart, string> = new Map([
  ["night", "assistantHub.activity.part.night"],
  ["morning", "assistantHub.activity.part.morning"],
  ["afternoon", "assistantHub.activity.part.afternoon"],
  ["evening", "assistantHub.activity.part.evening"],
]);

export function ActivityView() {
  const { t, locale } = useT();
  const { toast } = useToast();
  const timeZone = useAuth().user?.timezone ?? DEFAULT_TIME_ZONE;
  const [filter, setFilter] = useState<Filter>("all");
  const { receiptQuery, isUndoing, requestUndo } = useReceipt({
    onUndoAnswer: (result) =>
      toast(
        t(result.ok ? "assistantHub.activity.undo.requested" : "assistantHub.activity.undo.gone"),
        result.ok ? "success" : "error",
      ),
    onUndoError: () => toast(t("receipt.undo.error"), "error"),
  });
  const receipt = receiptQuery.data ?? null;
  const entries = useMemo(() => (receipt ? activityEntries(receipt) : []), [receipt]);
  const shown = filter === "all" ? entries : entries.filter((entry) => entry.kind === filter);
  const groups = groupByDayPart(shown, timeZone);
  const countOf = (kind: ActivityKind) => entries.filter((entry) => entry.kind === kind).length;

  const segments: Segment<Filter>[] = [
    { id: "all", label: t("assistantHub.activity.all"), count: entries.length },
    ...ACTIVITY_KINDS.map((kind) => ({
      id: kind,
      label: t(KIND_KEYS.get(kind) ?? ""),
      count: countOf(kind),
    })),
  ];

  return (
    <div className="max-w-3xl pb-8">
      <HubHeader
        title={t("nav.v2.activity")}
        subtitle={receipt ? formatDay(receipt.date, locale) : t("assistantHub.activity.subtitle")}
        actions={
          <Button
            variant="secondary"
            size="icon"
            aria-label={t("receipt.refresh")}
            title={t("receipt.refresh")}
            disabled={receiptQuery.isFetching}
            onClick={() => void receiptQuery.refetch()}
          >
            <RefreshGlyph spinning={receiptQuery.isFetching} />
          </Button>
        }
      />

      {receiptQuery.isLoading && <RowsSkeleton label={t("receipt.loading")} />}
      {receiptQuery.isError && !receipt && (
        <BlockError
          message={t("assistantHub.activity.error")}
          onRetry={() => void receiptQuery.refetch()}
        />
      )}

      {receipt && entries.length === 0 && (
        <EmptyState
          headingLevel="h2"
          icon={<ListGlyph />}
          title={t("assistantHub.activity.empty.title")}
          description={t("assistantHub.activity.empty.body")}
          className="rounded-card border border-line"
        />
      )}

      {receipt && entries.length > 0 && (
        <>
          <SegmentedControl
            segments={segments}
            value={filter}
            onChange={setFilter}
            ariaLabel={t("assistantHub.activity.filterLabel")}
            className="-mx-1"
          />
          {shown.length === 0 && (
            <p className="py-6 text-body text-ink-muted [word-break:keep-all]">
              {t("assistantHub.activity.noneOfKind")}
            </p>
          )}
          {groups.map((group, index) => {
            const headingId = `hub-activity-${group.part}-${index}`;
            return (
              <section key={headingId} aria-labelledby={headingId} className="mt-4">
                <h2
                  id={headingId}
                  className="flex min-h-11 items-center border-b border-line text-head text-ink"
                >
                  {t(PART_KEYS.get(group.part) ?? "")}
                </h2>
                <ul>
                  {group.entries.map((entry) => (
                    <ActivityRow
                      key={entry.key}
                      entry={entry}
                      timeZone={timeZone}
                      undoing={isUndoing(entry.item.id)}
                      onUndo={() => requestUndo(entry.item.id)}
                    />
                  ))}
                </ul>
              </section>
            );
          })}
          <p className="pt-4 text-caption text-ink-muted [word-break:keep-all]">
            {t("assistantHub.activity.undo.hint")}{" "}
            <Link
              href={ASSISTANT_APPROVALS}
              className="focus-ring rounded-control text-accent-deep underline"
            >
              {t("nav.v2.openApprovals")}
            </Link>
          </p>
        </>
      )}
    </div>
  );
}

interface ActivityRowProps {
  entry: ActivityEntry;
  timeZone: string;
  undoing: boolean;
  onUndo: () => void;
}

function ActivityRow({ entry, timeZone, undoing, onUndo }: ActivityRowProps) {
  const { t, locale } = useT();
  const { item, kind } = entry;
  const title = activityTitle(item);
  const titleText = "labelKey" in title ? t(title.labelKey) : title.text;
  const subjectKey = activitySubjectKey(item);
  const reasonKey = activityReasonKey(item.tierReason);
  const reason = reasonKey ? t(reasonKey) : item.tierReason;
  const opened = kind === "notified" && Boolean(item.pushClickedAt);
  const meta = [
    subjectKey ? t(subjectKey) : null,
    opened ? t("receipt.status.opened") : null,
    reason,
  ].filter(Boolean);
  return (
    <li className="flex items-start gap-3 border-b border-line-soft py-3 last:border-b-0">
      <time
        dateTime={item.surfacedAt}
        className="w-14 shrink-0 pt-px text-caption tabular-nums text-ink-muted"
      >
        {formatTime(item.surfacedAt, locale, timeZone)}
      </time>
      <div className="min-w-0 flex-1">
        <p className="break-words text-body text-ink">
          <span
            className={`font-medium ${kind === "handled" ? "text-state-ok-ink" : "text-ink-soft"}`}
          >
            {t(KIND_KEYS.get(kind) ?? "")}
          </span>
          <span aria-hidden="true" className="text-ink-muted">
            {" "}
            ·{" "}
          </span>
          <span className="sr-only">: </span>
          {titleText || t("today.mail.noSubject")}
        </p>
        {meta.length > 0 && (
          <p className="mt-0.5 break-words text-caption text-ink-muted">{meta.join(" · ")}</p>
        )}
      </div>
      {kind === "handled" && (
        <Button
          variant="ghost"
          size="sm"
          loading={undoing}
          onClick={onUndo}
          className="-my-2 shrink-0"
        >
          {t("receipt.undo.request")}
        </Button>
      )}
    </li>
  );
}

function formatTime(iso: string, locale: string, timeZone: string): string {
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  const options: Intl.DateTimeFormatOptions = { hour: "2-digit", minute: "2-digit", hour12: false };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(date);
  } catch {
    // An unknown zone name: the reader's own zone is the next best answer.
    return new Intl.DateTimeFormat(locale, options).format(date);
  }
}

/** The receipt's date is a calendar day (YYYY-MM-DD), not an instant. */
function formatDay(day: string, locale: string): string {
  const date = new Date(`${day}T12:00:00`);
  if (!Number.isFinite(date.getTime())) return day;
  return date.toLocaleDateString(locale, { weekday: "long", month: "long", day: "numeric" });
}

function RowsSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup label={label} className="flex flex-col gap-4 py-3">
      {["a", "b", "c", "d"].map((key) => (
        <div key={key} className="flex gap-3">
          <Skeleton width="w-10" />
          <div className="flex flex-1 flex-col gap-2">
            <Skeleton width="w-2/3" />
            <Skeleton width="w-1/3" />
          </div>
        </div>
      ))}
    </SkeletonGroup>
  );
}

function ListGlyph() {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      className="size-5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
    >
      <path d="M8 7h11M8 12h11M8 17h11M4.5 7h.01M4.5 12h.01M4.5 17h.01" />
    </svg>
  );
}

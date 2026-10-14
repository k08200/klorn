"use client";

/**
 * Briefing (productization plan §1, P7): the day's stored briefing in the hub
 * frame. Reading it runs no model; Generate / Regenerate does, on request. On
 * day one — before the first briefing exists — the page says when it will
 * arrive instead of showing an empty box.
 */

import type { BriefingStatus } from "@klorn/contract";
import Link from "next/link";
import { Markdown } from "../../../components/markdown";
import Button from "../../../components/ui/button";
import EmptyState from "../../../components/ui/empty-state";
import { Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import {
  type BriefingFeedbackChoice,
  type TopAction,
  useBriefingPage,
} from "../../briefing/use-briefing";
import { BlockError } from "../../today/block";
import { HubHeader } from "../hub-frame";
import { DayShape } from "./day-shape";

const SETTINGS_HREF = "/settings/notifications";
const DEFAULT_TIME_ZONE = "Asia/Seoul";
const LINK_CLASS =
  "focus-ring inline-flex min-h-11 items-center rounded-control text-label text-accent-deep hover:underline";

type Translate = (key: string, vars?: Record<string, string>) => string;

/** When the briefing arrives, or that it is off. Never a guess. */
function scheduleLine(status: BriefingStatus | null, t: Translate): string | null {
  if (!status) return null;
  const { enabled, briefingTime, timezone } = status.automation;
  if (!enabled) return t("assistantHub.briefing.schedule.off");
  if (!briefingTime) return t("today.briefing.arrives");
  return timezone
    ? t("assistantHub.briefing.schedule.atZone", { time: briefingTime, zone: timezone })
    : t("assistantHub.briefing.schedule.at", { time: briefingTime });
}

/** The one delivery problem worth a line, if there is one. */
const PUSH_REASON_KEYS: ReadonlyMap<string, string> = new Map([
  ["permission_denied", "assistantHub.briefing.delivery.blocked"],
  ["quiet_hours", "assistantHub.briefing.delivery.quiet"],
]);

function deliveryNote(status: BriefingStatus | null, t: Translate): string | null {
  if (!status?.automation.enabled) return null;
  if (status.push.state === "no_subscription") return t("assistantHub.briefing.delivery.noPush");
  if (status.push.state === "failed") return t("assistantHub.briefing.delivery.failed");
  const key = status.push.reason ? PUSH_REASON_KEYS.get(status.push.reason) : undefined;
  return key ? t(key) : null;
}

export function BriefingView() {
  const { t, locale } = useT();
  const timeZone = useAuth().user?.timezone ?? DEFAULT_TIME_ZONE;
  const briefing = useBriefingPage();
  const { content, status, loading, generating } = briefing;
  const time = briefing.createdAt ? formatTime(briefing.createdAt, locale, timeZone) : null;
  const schedule = scheduleLine(status, t);
  const note = deliveryNote(status, t);
  const ready = !loading && !briefing.loadFailed;

  return (
    <div className="max-w-3xl pb-8">
      <HubHeader
        title={t("nav.briefing")}
        subtitle={
          content && time
            ? t("assistantHub.briefing.generatedAt", { time })
            : (schedule ?? undefined)
        }
        actions={
          content ? (
            <Button variant="secondary" loading={generating} onClick={briefing.regenerate}>
              {t("briefing.regenerate")}
            </Button>
          ) : undefined
        }
      />

      <p className="flex flex-wrap items-center gap-x-3 text-body text-ink-muted [word-break:keep-all]">
        {content && schedule}
        <Link href={SETTINGS_HREF} className={LINK_CLASS}>
          {t("assistantHub.briefing.settings")}
        </Link>
      </p>
      {note && <p className="pb-2 text-body text-state-warn-ink [word-break:keep-all]">{note}</p>}

      {briefing.actionError && (
        <p role="alert" className="py-2 text-body text-state-danger-ink [word-break:keep-all]">
          {t(
            briefing.actionError === "generate"
              ? "assistantHub.briefing.generateFailed"
              : "assistantHub.briefing.feedbackFailed",
          )}
        </p>
      )}

      <div className="mt-2 flex flex-col gap-4">
        {loading && <BriefingSkeleton label={t("today.briefing.loading")} />}
        {briefing.loadFailed && (
          <BlockError message={t("today.briefing.error")} onRetry={briefing.retryLoad} />
        )}
        {ready && <BriefingBody briefing={briefing} />}
      </div>
    </div>
  );
}

/** The briefing itself — or, before the first one exists, when it arrives. */
function BriefingBody({ briefing }: { briefing: ReturnType<typeof useBriefingPage> }) {
  const { t } = useT();
  const { content, status, structured, generating } = briefing;
  if (!content) {
    return (
      <EmptyState
        headingLevel="h2"
        icon={<SunGlyph />}
        title={t("assistantHub.briefing.empty.title")}
        description={dayOneBody(status, t)}
        action={
          <Button variant="primary" loading={generating} onClick={briefing.regenerate}>
            {t("briefing.generateNow")}
          </Button>
        }
        className="rounded-card border border-line"
      />
    );
  }
  return (
    <>
      {structured && <DayShape structure={structured} />}
      <article className="rounded-card border border-line p-4 md:p-5">
        <Markdown content={content} />
      </article>
      {briefing.noteId && briefing.topActions.length > 0 && (
        <TopFeedback
          actions={briefing.topActions}
          chosen={briefing.feedback}
          savingRank={briefing.savingRank}
          onChoose={briefing.submitFeedback}
        />
      )}
    </>
  );
}

function formatTime(iso: string, locale: string, timeZone: string): string {
  const options: Intl.DateTimeFormatOptions = { hour: "numeric", minute: "2-digit" };
  try {
    return new Intl.DateTimeFormat(locale, { ...options, timeZone }).format(new Date(iso));
  } catch {
    // An unknown zone name: the reader's own zone is the next best answer.
    return new Intl.DateTimeFormat(locale, options).format(new Date(iso));
  }
}

/** Day one: when the first briefing arrives, or how to switch it on. */
function dayOneBody(status: BriefingStatus | null, t: Translate): string {
  const { enabled, briefingTime } = status?.automation ?? { enabled: false, briefingTime: null };
  if (enabled && briefingTime) return t("assistantHub.briefing.empty.at", { time: briefingTime });
  if (enabled) return t("assistantHub.briefing.empty.scheduled");
  return t("assistantHub.briefing.empty.off");
}

const CHOICES: ReadonlyArray<{ choice: BriefingFeedbackChoice; labelKey: string }> = [
  { choice: "useful", labelKey: "assistantHub.briefing.feedback.useful" },
  { choice: "wrong", labelKey: "assistantHub.briefing.feedback.wrong" },
  { choice: "later", labelKey: "assistantHub.briefing.feedback.later" },
  { choice: "done", labelKey: "assistantHub.briefing.feedback.done" },
];

interface TopFeedbackProps {
  actions: TopAction[];
  chosen: Record<number, BriefingFeedbackChoice>;
  savingRank: number | null;
  onChoose: (action: TopAction, choice: BriefingFeedbackChoice) => void;
}

function TopFeedback({ actions, chosen, savingRank, onChoose }: TopFeedbackProps) {
  const { t } = useT();
  return (
    <section aria-labelledby="hub-briefing-feedback">
      <div className="border-b border-line pb-2">
        <h2 id="hub-briefing-feedback" className="text-head text-ink">
          {t("assistantHub.briefing.feedback.title")}
        </h2>
        <p className="text-caption text-ink-muted [word-break:keep-all]">
          {t("assistantHub.briefing.feedback.hint")}
        </p>
      </div>
      <ul>
        {actions.map((action) => (
          <li key={action.rank} className="border-b border-line-soft py-3 last:border-b-0">
            <p className="text-body text-ink [word-break:keep-all]">
              <span className="tabular-nums text-ink-muted">{action.rank}. </span>
              {action.label}
            </p>
            <fieldset disabled={savingRank === action.rank} className="mt-1 flex flex-wrap gap-2">
              <legend className="sr-only">
                {t("assistantHub.briefing.feedback.legend", { item: action.label })}
              </legend>
              {CHOICES.map(({ choice, labelKey }) => {
                const pressed =
                  Object.hasOwn(chosen, action.rank) && chosen[action.rank] === choice;
                return (
                  <Button
                    key={choice}
                    variant={pressed ? "primary" : "secondary"}
                    size="sm"
                    aria-pressed={pressed}
                    onClick={() => onChoose(action, choice)}
                  >
                    {t(labelKey)}
                  </Button>
                );
              })}
            </fieldset>
          </li>
        ))}
      </ul>
    </section>
  );
}

function BriefingSkeleton({ label }: { label: string }) {
  return (
    <SkeletonGroup
      label={label}
      className="flex flex-col gap-3 rounded-card border border-line p-4 md:p-5"
    >
      <Skeleton width="w-24" />
      <Skeleton width="w-2/3" />
      <Skeleton variant="block" height="h-9" />
      <Skeleton />
      <Skeleton width="w-11/12" />
      <Skeleton width="w-4/5" />
    </SkeletonGroup>
  );
}

function SunGlyph() {
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
      <circle cx="12" cy="12" r="3.5" />
      <path d="M12 3.5v2M12 18.5v2M3.5 12h2M18.5 12h2M6 6l1.4 1.4M16.6 16.6 18 18M18 6l-1.4 1.4M7.4 16.6 6 18" />
    </svg>
  );
}

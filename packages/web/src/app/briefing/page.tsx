"use client";

// Wire shape comes from @klorn/contract — the same type the server builds
// (pim/briefing-status.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { BriefingPushState, BriefingStatus } from "@klorn/contract";
import Link from "next/link";
import AuthGuard from "../../components/auth-guard";
import { HubHandoff } from "../../components/hub-handoff";
import { Markdown } from "../../components/markdown";
import { PAGE_SHELL } from "../../components/page-shell";
import ErrorAlert from "../../components/ui/error-alert";
import LoadingState from "../../components/ui/loading-state";
import { useT } from "../../lib/i18n";
import { TodayActionsCard } from "./today-actions-card";
import {
  type BriefingFeedbackChoice,
  type BriefingStructure,
  useBriefingPage,
} from "./use-briefing";

const FEEDBACK_OPTIONS: Array<{ choice: BriefingFeedbackChoice; label: string }> = [
  { choice: "useful", label: "briefingPage.feedback.useful" },
  { choice: "wrong", label: "briefingPage.feedback.wrong" },
  { choice: "later", label: "briefingPage.feedback.later" },
  { choice: "done", label: "briefingPage.feedback.done" },
];

type Translate = (key: string, vars?: Record<string, string>) => string;

export default function BriefingPage() {
  return (
    <AuthGuard>
      <HubHandoff>
        <BriefingView />
      </HubHandoff>
    </AuthGuard>
  );
}

/** The glanceable day-shape hero (briefing v2): date, one-sentence verdict,
 * intensity sparkline, 2-3 time segments, ranked attention list. All text is
 * server-localized — this component only draws. */
function DayShapeCard({ structure }: { structure: BriefingStructure }) {
  const width = 280;
  const height = 36;
  const maxCount = Math.max(...structure.curve, 1);
  const stepX = width / Math.max(structure.curve.length - 1, 1);
  const points = structure.curve.map((count, i) => ({
    x: i * stepX,
    y: height - (count / maxCount) * (height - 6) - 3,
    busy: count > 0,
  }));
  const path = points.map((p, i) => `${i === 0 ? "M" : "L"}${p.x},${p.y}`).join(" ");

  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5 md:p-6">
      <p className="text-xs text-ink-dim">{structure.dateLabel}</p>
      <h1 className="mt-1 text-xl font-semibold leading-snug text-ink md:text-2xl">
        {structure.headline}
      </h1>
      {structure.curve.some((c) => c > 0) && (
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="mt-3 h-9 w-full"
          role="img"
          aria-hidden="true"
        >
          <path
            d={path}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            className="text-line"
          />
          {points
            .filter((p) => p.busy)
            .map((p) => (
              <circle key={p.x} cx={p.x} cy={p.y} r="2.5" className="fill-accent" />
            ))}
        </svg>
      )}
      <div className="mt-4 grid grid-cols-1 gap-4 md:grid-cols-3">
        {structure.segments.map((seg) => (
          <div
            key={seg.label}
            className="border-l border-line-soft pl-3 first:border-l-0 first:pl-0"
          >
            <p
              className={`text-xs font-semibold ${seg.kind === "busy" ? "text-accent-deep" : "text-ink-dim"}`}
            >
              {seg.label}
            </p>
            <p className="mt-1 text-sm text-ink">{seg.summary}</p>
          </div>
        ))}
      </div>
      {structure.attention.length > 0 && (
        <ol className="mt-4 space-y-1.5 border-t border-line-soft pt-3">
          {structure.attention.map((item) => (
            <li key={item.rank} className="flex gap-2 text-sm text-ink">
              <span className="text-xs font-semibold leading-5 text-ink-dim">{item.rank}</span>
              <span>
                {item.action}
                {item.reason ? <span className="text-ink-mid"> — {item.reason}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function BriefingView() {
  const { t, locale } = useT();
  const briefing = useBriefingPage();
  const { noteId, structured, content, createdAt, status, loading, feedback, savingRank } =
    briefing;
  const { generating, regenerate, submitFeedback, topActions } = briefing;
  const error =
    briefing.actionError === "generate"
      ? t("statePage.briefingGenerateError")
      : briefing.actionError === "feedback"
        ? t("statePage.briefingFeedbackError")
        : null;
  const statusError = briefing.statusFailed ? t("statePage.briefingStatusError") : null;
  const briefingLoadError = briefing.loadFailed ? t("statePage.briefingLoadError") : null;

  const formattedTime = createdAt
    ? new Date(createdAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const todayLabel = formattedTime
    ? t("briefingPage.todayAt", { time: formattedTime })
    : t("briefingPage.today");
  const surfacedLabel = t(
    topActions.length === 1 ? "briefingPage.surfaced.one" : "briefingPage.surfaced.other",
    { count: String(topActions.length) },
  );

  return (
    <div className={PAGE_SHELL}>
      {/* MOBILE — native large-title header (desktop hero below, untouched) */}
      <header className="mb-5 flex items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            {t("nav.briefing")}
          </h1>
          <p className="mt-1.5 text-sm text-ink-mid">
            {content ? todayLabel : t("briefing.notGenerated")}
          </p>
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={generating}
          aria-label={content ? t("briefing.regenerate") : t("briefing.generateNow")}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-surface-raised text-ink-mid transition active:bg-surface-hover disabled:opacity-50 focus-ring min-h-11"
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={generating ? "animate-spin" : ""}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <polyline points="21 3 21 9 15 9" />
          </svg>
        </button>
      </header>

      {/* DESKTOP — flat text header on the canvas, no boxed hero. Regenerate is
          the single filled primary action; the subtitle carries honest counts. */}
      <header className="mb-6 hidden items-start justify-between gap-4 md:flex">
        <div className="min-w-0">
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-ink">
            {t("nav.briefing")}
          </h1>
          <p className="mt-2 text-sm text-ink-mid">
            {content ? (
              <>
                {todayLabel}
                {topActions.length > 0 && (
                  <span className="text-ink-dim">
                    {" "}
                    <span aria-hidden="true" className="mx-0.5 text-line-strong">
                      ·
                    </span>{" "}
                    {surfacedLabel}
                  </span>
                )}
              </>
            ) : (
              t("briefing.notGenerated")
            )}
          </p>
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={generating}
          className="glow-primary ease-strong inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-ring min-h-11"
        >
          <svg
            aria-hidden="true"
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className={generating ? "animate-spin" : undefined}
          >
            <path d="M21 12a9 9 0 1 1-2.64-6.36" />
            <path d="M21 3v6h-6" />
          </svg>
          {generating
            ? t("briefing.generating")
            : content
              ? t("briefing.regenerate")
              : t("briefing.generateNow")}
        </button>
      </header>

      <TodayActionsCard />

      {status && <BriefingDeliveryStatus status={status} />}
      {statusError && (
        <div className="mb-4 rounded-lg border border-state-warn-line bg-state-warn-bg px-4 py-3 text-sm text-state-warn-ink">
          {statusError}
        </div>
      )}

      {loading && <LoadingState rows={3} label={t("statePage.briefingLoading")} />}

      {(error || briefingLoadError) && <ErrorAlert>{error ?? briefingLoadError}</ErrorAlert>}

      {!loading && !error && !briefingLoadError && !content && (
        <div className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-6 text-center">
          <p className="mb-3 text-sm text-ink-mid">{t("briefingPage.empty.title")}</p>
          <p className="mx-auto mb-4 max-w-md text-xs leading-5 text-ink-mid">
            {t("briefing.learningMode")}
          </p>
          <TimeHint t={t} />
          <button
            type="button"
            onClick={regenerate}
            disabled={generating}
            className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-accent-solid px-3.5 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40 focus-ring min-h-11"
          >
            {generating ? t("briefing.generating") : t("briefing.generateNow")}
          </button>
        </div>
      )}

      {structured && !loading && <DayShapeCard structure={structured} />}

      {content && (
        <div className="space-y-4">
          {/* Core: the brief itself, on the single elevated panel. */}
          <article className="panel-elevated relative overflow-hidden rounded-2xl border border-line/70 bg-surface-panel p-5 pl-6 md:p-6 md:pl-7">
            <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-accent-muted via-sky-200/40 to-transparent" />
            <Markdown content={content} />
          </article>

          {/* List: feedback rows inside one panel, not stacked cards. */}
          {noteId && topActions.length > 0 && (
            <section className="panel-elevated overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
              <div className="border-b border-line-soft px-4 py-3">
                <h2 className="text-sm font-semibold text-ink">
                  {t("briefingPage.feedback.title")}
                </h2>
                <p className="mt-1 text-xs text-ink-dim">{t("briefingPage.feedback.body")}</p>
              </div>
              <ul className="divide-y divide-line-soft">
                {topActions.map((action) => (
                  <li key={action.rank} className="row-wash px-4 py-3">
                    <p className="text-sm text-ink-muted">
                      <span className="text-ink-dim">{action.rank}.</span> {action.label}
                    </p>
                    <div className="mt-2.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                      {FEEDBACK_OPTIONS.map((option) => {
                        const selected = feedback[action.rank] === option.choice;
                        return (
                          <button
                            key={option.choice}
                            type="button"
                            onClick={() => submitFeedback(action, option.choice)}
                            aria-pressed={selected}
                            disabled={savingRank === action.rank}
                            className={`ease-strong h-8 rounded-lg border px-2 text-xs transition duration-150 active:scale-[0.97] disabled:opacity-50 focus-ring min-h-9 min-w-9 ${
                              selected
                                ? "border-accent-muted bg-accent/10 font-medium text-accent-deeper"
                                : "border-line bg-surface-panel/70 text-ink-mid shadow-[0_1px_1px_rgba(15,23,42,0.04)] hover:bg-surface-panel hover:text-ink"
                            }`}
                          >
                            {savingRank === action.rank && !selected
                              ? t("briefingPage.feedback.saving")
                              : t(option.label)}
                          </button>
                        );
                      })}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      )}
    </div>
  );
}

function BriefingDeliveryStatus({ status }: { status: BriefingStatus }) {
  const { t, locale } = useT();
  const push = pushStateCopy(status.push.state, status.push.reason);
  const timezone =
    status.automation.timezone ||
    Intl.DateTimeFormat().resolvedOptions().timeZone ||
    t("briefingPage.delivery.localTime");
  const auto = status.automation.enabled
    ? `${status.automation.briefingTime ?? "06:00"} · ${timezone}`
    : status.automation.reason === "no_config"
      ? t("briefingPage.delivery.notSetUp")
      : t("briefingPage.delivery.off");
  const nextLabel = nextBriefingLabel(status.automation, t);
  const notification = status.notification
    ? new Date(status.notification.createdAt).toLocaleTimeString(locale, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : t("briefingPage.delivery.none");
  const guidance = deliveryGuidance(status);

  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-line/70 bg-surface-panel p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-ink">{t("briefingPage.delivery.title")}</h2>
        <Link href="/settings/notifications" className="text-xs text-accent-deep hover:underline">
          {t("briefingPage.delivery.settings")}
        </Link>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-4">
        <DeliveryFact
          label={t("briefingPage.delivery.automation")}
          value={auto}
          tone={status.automation.enabled ? "ok" : "warn"}
        />
        <DeliveryFact
          label={t("briefingPage.delivery.next")}
          value={nextLabel}
          tone={status.automation.enabled ? "ok" : "muted"}
        />
        <DeliveryFact
          label={t("briefingPage.delivery.inApp")}
          value={notification}
          tone={status.notification ? "ok" : "muted"}
        />
        <DeliveryFact
          label={t("briefingPage.delivery.push")}
          value={t(push.label)}
          tone={push.tone}
        />
      </div>
      {guidance && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-state-warn-line bg-state-warn-bg px-3 py-2 text-caption leading-5 text-state-warn-ink">
          <span>{t(guidance.message)}</span>
          {guidance.action && (
            <Link
              href={guidance.action.href}
              className="rounded-md border border-state-warn-line px-2 py-0.5 font-medium text-state-warn-ink transition hover:bg-surface-hover focus-ring"
            >
              {t(guidance.action.label)}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function nextBriefingLabel(automation: BriefingStatus["automation"], t: Translate): string {
  if (!automation.enabled) return "—";
  const time = automation.briefingTime ?? "06:00";
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return time;
  const targetHour = Number(match[1]);
  const targetMinute = Number(match[2]);
  const now = new Date();
  const target = new Date(now);
  target.setHours(targetHour, targetMinute, 0, 0);
  const isToday = target.getTime() > now.getTime();
  return t(isToday ? "briefingPage.delivery.nextToday" : "briefingPage.delivery.nextTomorrow", {
    time,
  });
}

/** "Change the automatic briefing time in {link}." with {link} as the Settings link. */
function TimeHint({ t }: { t: Translate }) {
  const [before, after = ""] = t("briefingPage.empty.timeHint").split("{link}");
  return (
    <p className="mb-4 text-xs text-ink-dim">
      {before}
      <Link href="/settings/notifications" className="text-accent-deep hover:underline">
        {t("briefingPage.delivery.settings")}
      </Link>
      {after}
    </p>
  );
}

/** Message and action label are i18n keys; the caller translates them. */
interface DeliveryGuidance {
  message: string;
  action?: { label: string; href: string };
}

function deliveryGuidance(status: BriefingStatus): DeliveryGuidance | null {
  if (!status.automation.configured || status.automation.reason === "no_config") {
    return {
      message: "briefingPage.guidance.noConfig",
      action: { label: "briefingPage.guidance.noConfigAction", href: "/settings/notifications" },
    };
  }
  if (status.automation.reason === "disabled") {
    return {
      message: "briefingPage.guidance.disabled",
      action: { label: "briefingPage.guidance.disabledAction", href: "/settings/notifications" },
    };
  }
  if (status.push.state === "no_subscription") {
    return {
      message: "briefingPage.guidance.noSubscription",
      action: {
        label: "briefingPage.guidance.noSubscriptionAction",
        href: "/settings/notifications",
      },
    };
  }
  if (status.push.reason === "permission_denied") {
    return {
      message: "briefingPage.guidance.permissionDenied",
    };
  }
  if (status.push.reason === "vapid_missing") {
    return {
      message: "briefingPage.guidance.vapidMissing",
    };
  }
  if (status.push.state === "failed") {
    return {
      message: "briefingPage.guidance.failed",
    };
  }
  if (status.push.state === "skipped" && status.push.reason === "quiet_hours") {
    return {
      message: "briefingPage.guidance.quietHours",
      action: { label: "briefingPage.guidance.quietHoursAction", href: "/settings/notifications" },
    };
  }
  return null;
}

function DeliveryFact({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone: "ok" | "warn" | "muted";
}) {
  const toneClass = {
    ok: "border-state-ok-line bg-state-ok-bg text-state-ok-ink",
    warn: "border-state-warn-line bg-state-warn-bg text-state-warn-ink",
    muted: "border-line bg-surface-raised text-ink-mid",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-caption font-semibold uppercase tracking-[0.12em] opacity-60">{label}</p>
      <p className="mt-1 truncate text-xs font-medium">{value}</p>
    </div>
  );
}

function pushStateCopy(
  state: BriefingPushState,
  reason: string | null,
): { label: string; tone: "ok" | "warn" | "muted"; reason: string | null } {
  switch (state) {
    case "received":
      return { label: "briefingPage.push.received", tone: "ok", reason };
    case "accepted":
      return { label: "briefingPage.push.accepted", tone: "ok", reason };
    case "pending":
      return { label: "briefingPage.push.pending", tone: "warn", reason };
    case "failed":
      return { label: "briefingPage.push.failed", tone: "warn", reason };
    case "skipped":
      return { label: "briefingPage.push.skipped", tone: "warn", reason };
    case "not_sent":
      return { label: "briefingPage.push.notSent", tone: "muted", reason };
    case "no_subscription":
      return {
        label: "briefingPage.push.noSubscription",
        tone: "warn",
        reason: reason ?? "no_subscriptions",
      };
  }
}

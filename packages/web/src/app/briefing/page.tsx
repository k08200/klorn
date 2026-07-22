"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { Markdown } from "../../components/markdown";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { TodayActionsCard } from "./today-actions-card";

interface BriefingResponse {
  briefing: { id: string; content: string; createdAt: string } | null;
}

interface GenerateResponse {
  briefing: string;
  note?: { id: string; createdAt: string };
  notification?: { id: string; createdAt: string } | null;
}

// Wire shape comes from @klorn/contract — the same type the server builds
// (pim/briefing-status.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { BriefingPushState, BriefingStatus } from "@klorn/contract";

type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

interface BriefingFeedbackResponse {
  feedback: Record<
    string,
    {
      id: string;
      rank: number;
      choice: BriefingFeedbackChoice;
      signal: string;
      evidence: string | null;
      createdAt: string;
    }
  >;
}

interface TopAction {
  rank: number;
  label: string;
}

const FEEDBACK_OPTIONS: Array<{ choice: BriefingFeedbackChoice; label: string }> = [
  { choice: "useful", label: "Useful" },
  { choice: "wrong", label: "Wrong" },
  { choice: "later", label: "Later" },
  { choice: "done", label: "Done" },
];

export default function BriefingPage() {
  return (
    <AuthGuard>
      <BriefingView />
    </AuthGuard>
  );
}

function BriefingView() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [savingRank, setSavingRank] = useState<number | null>(null);

  // Parallel fetch: today's briefing + delivery status. Errors on either
  // are handled independently so a flaky status endpoint never blocks the
  // briefing body.
  const briefingQuery = useQuery({
    queryKey: queryKeys.briefing.today(),
    queryFn: () => apiFetch<BriefingResponse>("/api/briefing/today"),
  });
  const statusQuery = useQuery({
    queryKey: queryKeys.briefing.status(),
    queryFn: () => apiFetch<BriefingStatus>("/api/briefing/status"),
  });

  const noteId = briefingQuery.data?.briefing?.id ?? null;
  const content = briefingQuery.data?.briefing?.content ?? null;
  const createdAt = briefingQuery.data?.briefing?.createdAt ?? null;
  const status = statusQuery.data ?? null;
  const loading = briefingQuery.isLoading;
  const statusError = statusQuery.error
    ? "Delivery status is unavailable. The briefing can still load."
    : null;
  const briefingLoadError = briefingQuery.error ? "Could not load today's briefing." : null;

  // Dependent fetch: only call /feedback once we know the briefing id.
  const feedbackQuery = useQuery({
    queryKey: noteId ? queryKeys.briefing.feedback(noteId) : queryKeys.briefing.feedback("none"),
    enabled: Boolean(noteId),
    queryFn: async () => {
      if (!noteId) return {} as Record<number, BriefingFeedbackChoice>;
      const data = await apiFetch<BriefingFeedbackResponse>(
        `/api/briefing/${noteId}/top-actions/feedback`,
      );
      const next: Record<number, BriefingFeedbackChoice> = {};
      for (const [rank, row] of Object.entries(data.feedback)) {
        next[Number(rank)] = row.choice;
      }
      return next;
    },
  });
  const feedback = feedbackQuery.data ?? {};

  useEffect(() => {
    if (briefingQuery.error) {
      captureClientError(briefingQuery.error, { scope: "briefing.load-today" });
    }
    if (statusQuery.error) {
      captureClientError(statusQuery.error, { scope: "briefing.status.load" });
    }
    if (feedbackQuery.error) {
      captureClientError(feedbackQuery.error, {
        scope: "briefing.feedback.load",
        noteId,
      });
    }
  }, [briefingQuery.error, statusQuery.error, feedbackQuery.error, noteId]);

  const regenerateMutation = useMutation({
    mutationFn: () =>
      apiFetch<GenerateResponse>("/api/briefing/generate", {
        method: "POST",
        body: JSON.stringify({}),
      }),
    onMutate: () => setError(null),
    onSuccess: () => {
      // Truth lives on the server — refetch all 3 dependent queries.
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing.all });
    },
    onError: (err) => {
      captureClientError(err, { scope: "briefing.generate" });
      setError("Could not generate the briefing. Please try again.");
    },
  });
  const generating = regenerateMutation.isPending;
  const regenerate = () => regenerateMutation.mutate();

  const feedbackMutation = useMutation({
    mutationFn: async (input: { action: TopAction; choice: BriefingFeedbackChoice }) => {
      if (!noteId) throw new Error("Missing noteId");
      await apiFetch(`/api/briefing/${noteId}/top-actions/${input.action.rank}/feedback`, {
        method: "POST",
        body: JSON.stringify({ choice: input.choice, label: input.action.label }),
      });
      return input;
    },
    onMutate: (input) => {
      setSavingRank(input.action.rank);
      setError(null);
    },
    onSuccess: (input) => {
      // Optimistic local update; cache will refetch on next focus.
      if (!noteId) return;
      queryClient.setQueryData<Record<number, BriefingFeedbackChoice>>(
        queryKeys.briefing.feedback(noteId),
        (prev) => ({ ...(prev ?? {}), [input.action.rank]: input.choice }),
      );
    },
    onError: (err, vars) => {
      captureClientError(err, {
        scope: "briefing.feedback.submit",
        noteId,
        rank: vars.action.rank,
        choice: vars.choice,
      });
      setError("Could not save feedback. Please try again.");
    },
    onSettled: () => setSavingRank(null),
  });
  const submitFeedback = async (action: TopAction, choice: BriefingFeedbackChoice) => {
    if (!noteId || savingRank) return;
    feedbackMutation.mutate({ action, choice });
  };

  const formattedTime = createdAt
    ? new Date(createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;
  const topActions = content ? extractTopActions(content) : [];

  return (
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-3 md:py-10">
      {/* MOBILE — native large-title header (desktop hero below, untouched) */}
      <header className="mb-5 flex items-end justify-between gap-3 md:hidden">
        <div className="min-w-0">
          <h1 className="text-[28px] font-bold leading-none tracking-tight text-slate-900">
            {t("nav.briefing")}
          </h1>
          <p className="mt-1.5 text-sm text-slate-500">
            {content
              ? `Today${formattedTime ? ` · ${formattedTime}` : ""}`
              : t("briefing.notGenerated")}
          </p>
        </div>
        <button
          type="button"
          onClick={regenerate}
          disabled={generating}
          aria-label={content ? "Regenerate briefing" : "Generate briefing"}
          className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-slate-50 text-slate-500 transition active:bg-slate-100 disabled:opacity-50"
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
          <h1 className="text-[28px] font-semibold leading-none tracking-[-0.02em] text-slate-900">
            {t("nav.briefing")}
          </h1>
          <p className="mt-2 text-sm text-slate-500">
            {content ? (
              <>
                Today{formattedTime ? ` · ${formattedTime}` : ""}
                {topActions.length > 0 && (
                  <span className="text-slate-400">
                    {" "}
                    <span className="mx-0.5 text-slate-300">·</span> {topActions.length}{" "}
                    {topActions.length === 1 ? "action" : "actions"} surfaced
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
          className="glow-primary ease-strong inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3.5 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
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
        <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-700">
          {statusError}
        </div>
      )}

      {loading && <p className="text-sm text-slate-400">Loading...</p>}

      {(error || briefingLoadError) && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error ?? briefingLoadError}
        </div>
      )}

      {!loading && !error && !briefingLoadError && !content && (
        <div className="panel-elevated rounded-2xl border border-slate-200/70 bg-white p-6 text-center">
          <p className="mb-3 text-sm text-slate-500">No briefing for today yet.</p>
          <p className="mx-auto mb-4 max-w-md text-xs leading-5 text-slate-500">
            {t("briefing.learningMode")}
          </p>
          <p className="mb-4 text-xs text-slate-400">
            Change the automatic briefing time in{" "}
            <Link href="/settings" className="text-sky-600 hover:underline">
              Settings
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={generating}
            className="glow-primary ease-strong inline-flex h-9 items-center rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3.5 text-sm font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {generating ? "Generating..." : "Generate now"}
          </button>
        </div>
      )}

      {content && (
        <div className="space-y-4">
          {/* Core: the brief itself, on the single elevated panel. */}
          <article className="panel-elevated relative overflow-hidden rounded-2xl border border-slate-200/70 bg-white p-5 pl-6 md:p-6 md:pl-7">
            <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-sky-300 via-sky-200/40 to-transparent" />
            <Markdown content={content} />
          </article>

          {/* List: feedback rows inside one panel, not stacked cards. */}
          {noteId && topActions.length > 0 && (
            <section className="panel-elevated overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
              <div className="border-b border-slate-100 px-4 py-3">
                <h2 className="text-sm font-semibold text-slate-900">Top 3 feedback</h2>
                <p className="mt-1 text-xs text-slate-400">
                  Mark whether today's surfaced items were actually useful.
                </p>
              </div>
              <ul className="divide-y divide-slate-100">
                {topActions.map((action) => (
                  <li key={action.rank} className="row-wash px-4 py-3">
                    <p className="text-sm text-slate-600">
                      <span className="text-slate-400">{action.rank}.</span> {action.label}
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
                            className={`ease-strong h-8 rounded-lg border px-2 text-xs transition duration-150 active:scale-[0.97] disabled:opacity-50 ${
                              selected
                                ? "border-sky-300 bg-sky-500/10 font-medium text-sky-700"
                                : "border-slate-200 bg-white/70 text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] hover:bg-white hover:text-slate-900"
                            }`}
                          >
                            {savingRank === action.rank && !selected ? "Saving" : option.label}
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
  const push = pushStateCopy(status.push.state, status.push.reason);
  const timezone =
    status.automation.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  const auto = status.automation.enabled
    ? `${status.automation.briefingTime ?? "06:00"} · ${timezone}`
    : status.automation.reason === "no_config"
      ? "Not set up"
      : "Off";
  const nextLabel = nextBriefingLabel(status.automation);
  const notification = status.notification
    ? new Date(status.notification.createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "None";
  const guidance = deliveryGuidance(status);

  return (
    <section className="panel-elevated mb-4 rounded-2xl border border-slate-200/70 bg-white p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-slate-900">Briefing delivery</h2>
        <Link href="/settings" className="text-xs text-sky-600 hover:underline">
          Settings
        </Link>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-4">
        <DeliveryFact
          label="Automation"
          value={auto}
          tone={status.automation.enabled ? "ok" : "warn"}
        />
        <DeliveryFact
          label="Next"
          value={nextLabel}
          tone={status.automation.enabled ? "ok" : "muted"}
        />
        <DeliveryFact
          label="In-app"
          value={notification}
          tone={status.notification ? "ok" : "muted"}
        />
        <DeliveryFact label="Push" value={push.label} tone={push.tone} />
      </div>
      {guidance && (
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-[11px] leading-5 text-amber-700">
          <span>{guidance.message}</span>
          {guidance.action && (
            <Link
              href={guidance.action.href}
              className="rounded-md border border-amber-300 px-2 py-0.5 font-medium text-amber-700 transition hover:bg-amber-100"
            >
              {guidance.action.label}
            </Link>
          )}
        </div>
      )}
    </section>
  );
}

function nextBriefingLabel(automation: BriefingStatus["automation"]): string {
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
  const dayLabel = isToday ? "today" : "tomorrow";
  return `${dayLabel} ${time}`;
}

interface DeliveryGuidance {
  message: string;
  action?: { label: string; href: string };
}

function deliveryGuidance(status: BriefingStatus): DeliveryGuidance | null {
  if (!status.automation.configured || status.automation.reason === "no_config") {
    return {
      message: "No briefing time is set. Choose when you want the morning brief to arrive.",
      action: { label: "Set briefing time", href: "/settings" },
    };
  }
  if (status.automation.reason === "disabled") {
    return {
      message: "Daily briefing automation is off. Turn it on to receive a brief every morning.",
      action: { label: "Turn on", href: "/settings" },
    };
  }
  if (status.push.state === "no_subscription") {
    return {
      message:
        "Push isn't set up on this device — install Klorn as an app to receive the morning push.",
      action: { label: "Install instructions", href: "/settings" },
    };
  }
  if (status.push.reason === "permission_denied") {
    return {
      message:
        "Browser notifications are blocked. Allow notifications to receive the morning push.",
    };
  }
  if (status.push.reason === "vapid_missing") {
    return {
      message: "Push keys are not configured for this deployment — ask the operator.",
    };
  }
  if (status.push.state === "failed") {
    return {
      message:
        "Last briefing push failed to deliver. The next scheduled briefing will try again automatically.",
    };
  }
  if (status.push.state === "skipped" && status.push.reason === "quiet_hours") {
    return {
      message: "Push was skipped because quiet hours were active when the briefing fired.",
      action: { label: "Adjust quiet hours", href: "/settings" },
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
    ok: "border-emerald-200 bg-emerald-50 text-emerald-700",
    warn: "border-amber-200 bg-amber-50 text-amber-700",
    muted: "border-slate-200 bg-slate-50 text-slate-500",
  }[tone];
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-[0.12em] opacity-60">{label}</p>
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
      return { label: "Received", tone: "ok", reason };
    case "accepted":
      return { label: "Sent", tone: "ok", reason };
    case "pending":
      return { label: "Pending", tone: "warn", reason };
    case "failed":
      return { label: "Failed", tone: "warn", reason };
    case "skipped":
      return { label: "Skipped", tone: "warn", reason };
    case "not_sent":
      return { label: "Not sent", tone: "muted", reason };
    case "no_subscription":
      return {
        label: "No browser subscription",
        tone: "warn",
        reason: reason ?? "no_subscriptions",
      };
  }
}

function pushReasonLabel(reason: string): string {
  const labels: Record<string, string> = {
    no_subscriptions: "No browser push subscription",
    permission_denied: "Browser notifications are blocked",
    quiet_hours: "Quiet hours are active",
    vapid_missing: "Push keys need configuration",
  };
  return labels[reason] || reason;
}

function extractTopActions(content: string): TopAction[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const sectionIndex = normalized.search(/Today's\s*Top\s*3|Today\s*Top\s*3|Top\s*3/i);
  const target = sectionIndex >= 0 ? normalized.slice(sectionIndex) : normalized;
  const actions: TopAction[] = [];
  const lineRegex = /^\s*(\d+)[.)]\s+(.+)$/gm;
  let match: RegExpExecArray | null;

  while ((match = lineRegex.exec(target)) !== null && actions.length < 3) {
    const rank = Number.parseInt(match[1], 10);
    if (!Number.isInteger(rank) || rank < 1 || rank > 3) continue;
    const label = cleanActionLabel(match[2]);
    if (label) actions.push({ rank, label });
  }

  return actions;
}

function cleanActionLabel(value: string): string {
  return value
    .replace(/\*\*/g, "")
    .replace(/\s+[—-]\s+.+$/, "")
    .trim()
    .slice(0, 160);
}

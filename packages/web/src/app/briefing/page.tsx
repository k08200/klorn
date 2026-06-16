"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { EveSignalField } from "../../components/brand-visuals";
import { Markdown } from "../../components/markdown";
import Button from "../../components/ui/button";
import EmptyState from "../../components/ui/empty-state";
import LoadingState from "../../components/ui/loading-state";
import PageHeader from "../../components/ui/page-header";
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

type BriefingPushState =
  | "received"
  | "accepted"
  | "failed"
  | "skipped"
  | "pending"
  | "not_sent"
  | "no_subscription";

interface BriefingStatus {
  generated: boolean;
  notification: {
    id: string;
    title: string;
    message: string;
    createdAt: string;
  } | null;
  push: {
    state: BriefingPushState;
    reason: string | null;
    deliveryId: string | null;
    acceptedAt: string | null;
    receivedAt: string | null;
    clickedAt: string | null;
  };
  automation: {
    configured: boolean;
    enabled: boolean;
    briefingTime: string | null;
    timezone?: string | null;
    reason: "no_config" | "disabled" | null;
  };
}

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
    <div className="min-h-full px-4 pb-28 pt-6 md:py-10">
      <div className="mx-auto max-w-3xl animate-fade-in">
        <PageHeader
          eyebrow="Klorn · Briefing"
          title="Today's decision brief"
          description="Mail and calendar items that need a call, sorted into approve, hold, and next steps."
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={regenerate}
              loading={generating}
              disabled={generating}
            >
              {generating ? "Generating..." : content ? "Regenerate" : "Generate now"}
            </Button>
          }
        />

        <section className="glass relative mb-4 overflow-hidden rounded-2xl border border-stone-800/70 bg-stone-950/40 p-5">
          <div className="grid gap-5 lg:grid-cols-[1fr_280px] lg:items-center">
            <div className="grid grid-cols-3 gap-2">
              <BriefStat label="Actions" value={topActions.length} />
              <BriefStat label="Feedback" value={Object.keys(feedback).length} />
              <BriefStat label="Status" value={content ? "Ready" : "Empty"} />
            </div>
            <div className="relative min-h-32 overflow-hidden rounded-xl border border-stone-800/70 bg-black/20">
              <EveSignalField className="absolute inset-0 border-0" />
              {formattedTime && (
                <span className="absolute bottom-3 left-3 font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
                  Today {formattedTime}
                </span>
              )}
            </div>
          </div>
        </section>

        <TodayActionsCard />

        {status && <BriefingDeliveryStatus status={status} />}
        {statusError && (
          <div className="mb-4 rounded-xl border border-amber-500/30 bg-amber-500/5 px-4 py-3 text-sm text-amber-200">
            {statusError}
          </div>
        )}

        {loading && <LoadingState rows={4} label="Loading briefing" />}

        {(error || briefingLoadError) && (
          <div className="rounded-xl border border-rose-500/30 bg-rose-500/5 px-4 py-3 text-sm text-rose-300">
            {error ?? briefingLoadError}
          </div>
        )}

        {!loading && !error && !briefingLoadError && !content && (
          <EmptyState
            title="No briefing for today yet"
            description={t("briefing.learningMode")}
            action={
              <div className="flex flex-col items-center gap-3">
                <Button onClick={regenerate} loading={generating} disabled={generating}>
                  {generating ? "Generating..." : "Generate now"}
                </Button>
                <p className="text-xs text-stone-500">
                  Change the automatic briefing time in{" "}
                  <Link href="/settings" className="text-amber-300 hover:underline">
                    Settings
                  </Link>
                  .
                </p>
              </div>
            }
          />
        )}

        {content && (
          <div className="space-y-4 animate-slide-up">
            <article className="glass relative overflow-hidden rounded-2xl border border-stone-800/70 bg-stone-950/40 p-5 pl-6 md:pl-7">
              <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-amber-300 via-amber-300/40 to-stone-700" />
              <Markdown content={content} />
            </article>

            {noteId && topActions.length > 0 && (
              <section className="glass rounded-2xl border border-stone-800/70 bg-stone-950/40 p-5">
                <div className="mb-4">
                  <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
                    Top 3 feedback
                  </p>
                  <p className="mt-1.5 text-sm text-stone-400">
                    Mark whether today's surfaced items were actually useful.
                  </p>
                </div>
                <div className="space-y-3">
                  {topActions.map((action) => (
                    <div
                      key={action.rank}
                      className="rounded-xl border border-stone-800/70 bg-black/20 p-3.5"
                    >
                      <p className="text-sm text-stone-200">
                        <span className="font-mono text-xs text-stone-500">{action.rank}.</span>{" "}
                        {action.label}
                      </p>
                      <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        {FEEDBACK_OPTIONS.map((option) => {
                          const selected = feedback[action.rank] === option.choice;
                          return (
                            <button
                              key={option.choice}
                              type="button"
                              onClick={() => submitFeedback(action, option.choice)}
                              aria-pressed={selected}
                              disabled={savingRank === action.rank}
                              className={`h-9 rounded-xl border px-2 text-xs font-medium transition disabled:opacity-50 ${
                                selected
                                  ? "border-amber-300/60 bg-amber-500/10 text-amber-100"
                                  : "border-stone-700 text-stone-400 hover:border-stone-600 hover:bg-stone-800/60"
                              }`}
                            >
                              {savingRank === action.rank && !selected ? "Saving" : option.label}
                            </button>
                          );
                        })}
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            )}
          </div>
        )}
      </div>
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
    ? new Date(status.notification.createdAt).toLocaleTimeString(undefined, {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "None";
  const guidance = deliveryGuidance(status);

  return (
    <section className="glass mb-4 rounded-2xl border border-stone-800/70 bg-stone-950/40 p-5">
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">
          Briefing delivery
        </p>
        <Link href="/settings" className="text-xs text-amber-300 hover:underline">
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
        <div className="mt-3 flex flex-wrap items-center gap-3 rounded-xl border border-amber-500/20 bg-amber-500/5 px-3 py-2 text-[11px] leading-5 text-amber-100/90">
          <span>{guidance.message}</span>
          {guidance.action && (
            <Link
              href={guidance.action.href}
              className="rounded-lg border border-amber-300/40 px-2 py-0.5 text-amber-200 transition hover:bg-amber-300/10"
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
    ok: "border-emerald-500/20 bg-emerald-500/5 text-emerald-200",
    warn: "border-amber-500/20 bg-amber-500/5 text-amber-200",
    muted: "border-stone-800 bg-black/15 text-stone-400",
  }[tone];
  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] opacity-70">{label}</p>
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

function BriefStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-xl border border-stone-800/70 bg-black/15 px-3 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-[0.16em] text-stone-500">{label}</p>
      <p className="mt-1.5 truncate text-xl font-semibold tracking-tight text-stone-100">{value}</p>
    </div>
  );
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

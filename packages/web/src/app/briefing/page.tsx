"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { EveSignalField } from "../../components/brand-visuals";
import { Markdown } from "../../components/markdown";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

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
    <div className="mx-auto w-full max-w-5xl px-4 pb-28 pt-6 md:py-10">
      <header className="mb-6 overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/55 shadow-2xl shadow-black/10">
        <div className="h-1 bg-gradient-to-r from-amber-300 via-teal-300 to-stone-600" />
        <div className="grid gap-5 p-5 md:p-6 lg:grid-cols-[1fr_300px] lg:items-stretch">
          <div>
            <p className="mb-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300/80">
              Briefing
            </p>
            <h1 className="text-2xl font-semibold tracking-tight text-stone-50">
              Compress today into decisions
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-stone-500">
              Klorn summarizes mail, meetings, and tasks into approvals, deferrals, and next steps.
              {formattedTime && <span className="ml-2 text-stone-400">Today {formattedTime}</span>}
            </p>
          </div>
          <div className="relative min-h-40 overflow-hidden rounded-lg border border-stone-800 bg-black/20">
            <EveSignalField className="absolute inset-0 border-0" />
            <button
              type="button"
              onClick={regenerate}
              disabled={generating}
              className="absolute right-3 top-3 inline-flex min-h-11 items-center rounded-md border border-stone-700 bg-stone-950/75 px-3 py-1.5 text-xs text-stone-300 backdrop-blur transition hover:border-amber-500/40 hover:bg-amber-500/10 hover:text-amber-100 disabled:opacity-50"
            >
              {generating ? "Generating..." : content ? "Regenerate" : "Generate now"}
            </button>
          </div>
          <div className="grid grid-cols-3 gap-2 lg:col-span-2">
            <BriefStat label="Actions" value={topActions.length} />
            <BriefStat label="Feedback" value={Object.keys(feedback).length} />
            <BriefStat label="Status" value={content ? "Ready" : "Empty"} />
          </div>
        </div>
      </header>

      {status && <BriefingDeliveryStatus status={status} />}
      {statusError && (
        <div className="mb-4 rounded-lg border border-amber-900/50 bg-amber-950/20 px-4 py-3 text-sm text-amber-200">
          {statusError}
        </div>
      )}

      {loading && <p className="text-sm text-stone-500">Loading...</p>}

      {(error || briefingLoadError) && (
        <div className="rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          {error ?? briefingLoadError}
        </div>
      )}

      {!loading && !error && !briefingLoadError && !content && (
        <div className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-6 text-center">
          <p className="mb-3 text-sm text-stone-300">No briefing for today yet.</p>
          <p className="mx-auto mb-4 max-w-md text-xs leading-5 text-amber-100/85">
            {t("briefing.learningMode")}
          </p>
          <p className="mb-4 text-xs text-stone-500">
            Change the automatic briefing time in{" "}
            <Link href="/settings" className="text-amber-300 hover:underline">
              Settings
            </Link>
            .
          </p>
          <button
            type="button"
            onClick={regenerate}
            disabled={generating}
            className="rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
          >
            {generating ? "Generating..." : "Generate now"}
          </button>
        </div>
      )}

      {content && (
        <div className="space-y-4">
          <article className="relative overflow-hidden rounded-lg border border-stone-700/45 bg-stone-950/35 p-5 pl-6 md:p-6 md:pl-7">
            <div className="absolute bottom-0 left-0 top-0 w-1 bg-gradient-to-b from-amber-300 via-teal-300 to-stone-700" />
            <Markdown content={content} />
          </article>

          {noteId && topActions.length > 0 && (
            <section className="rounded-lg border border-stone-700/45 bg-stone-950/35 p-4">
              <div className="mb-3">
                <h2 className="text-sm font-semibold text-stone-100">Top 3 feedback</h2>
                <p className="mt-1 text-xs text-stone-500">
                  Mark whether today's selected items were actually useful.
                </p>
              </div>
              <div className="space-y-3">
                {topActions.map((action) => (
                  <div
                    key={action.rank}
                    className="rounded-lg border border-stone-700/45 bg-black/20 p-3"
                  >
                    <p className="text-sm text-stone-300">
                      <span className="text-stone-500">{action.rank}.</span> {action.label}
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
                            className={`h-8 rounded-lg border px-2 text-xs transition disabled:opacity-50 ${
                              selected
                                ? "border-amber-300 bg-amber-500/10 text-amber-100"
                                : "border-stone-700 text-stone-400 hover:bg-stone-800"
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
  );
}

function BriefingDeliveryStatus({ status }: { status: BriefingStatus }) {
  const push = pushStateCopy(status.push.state, status.push.reason);
  const timezone =
    status.automation.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "Local time";
  const auto = status.automation.enabled
    ? `${status.automation.briefingTime ?? "06:00"} · ${timezone}`
    : status.automation.reason === "no_config"
      ? "Not set"
      : "Off";
  const notification = status.notification
    ? new Date(status.notification.createdAt).toLocaleTimeString("en-US", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : "None yet";

  return (
    <section className="mb-4 rounded-xl border border-stone-700/45 bg-stone-950/35 p-4">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-sm font-semibold text-stone-100">Briefing delivery</h2>
        <Link href="/settings" className="text-xs text-amber-300 hover:underline">
          Settings
        </Link>
      </div>
      <div className="grid gap-2 text-xs sm:grid-cols-3">
        <DeliveryFact
          label="Automation"
          value={auto}
          tone={status.automation.enabled ? "ok" : "warn"}
        />
        <DeliveryFact
          label="App alert"
          value={notification}
          tone={status.notification ? "ok" : "muted"}
        />
        <DeliveryFact label="Push" value={push.label} tone={push.tone} />
      </div>
      {push.reason && (
        <p className="mt-3 text-[11px] leading-5 text-stone-500">
          Push status: {pushReasonLabel(push.reason)}. Browser permission, subscription state, VAPID
          keys, or quiet hours may be blocking delivery.
        </p>
      )}
    </section>
  );
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

function BriefStat({ label, value }: { label: string; value: number | string }) {
  return (
    <div className="rounded-lg border border-stone-700/45 bg-black/15 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-600">
        {label}
      </p>
      <p className="mt-1 truncate text-lg font-semibold text-stone-100">{value}</p>
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

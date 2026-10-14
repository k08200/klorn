"use client";

/**
 * The briefing's data and actions: today's stored briefing, its delivery
 * status, the Top-3 feedback, and generate / regenerate. Shared by the legacy
 * /briefing page and the Assistant hub's Briefing page (productization plan
 * P7), so both read the same cache entries and run the same mutations. Errors
 * are reported as codes; each page words them itself.
 */

import type { BriefingStatus } from "@klorn/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

export interface BriefingStructure {
  dateLabel: string;
  headline: string;
  segments: Array<{ label: string; summary: string; kind: "busy" | "free" | "off" }>;
  curve: number[];
  dayStartHour: number;
  attention: Array<{ rank: number; action: string; reason: string }>;
}

interface BriefingResponse {
  briefing: { id: string; content: string; createdAt: string } | null;
  structured?: BriefingStructure | null;
}

interface GenerateResponse {
  briefing: string;
  note?: { id: string; createdAt: string };
  notification?: { id: string; createdAt: string } | null;
}

export type BriefingFeedbackChoice = "useful" | "wrong" | "later" | "done";

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

export interface TopAction {
  rank: number;
  label: string;
}

/** Which action last failed; cleared when the next one starts. */
export type BriefingActionError = "generate" | "feedback" | null;

export function useBriefingPage() {
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<BriefingActionError>(null);
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
    onMutate: () => setActionError(null),
    onSuccess: () => {
      // Truth lives on the server — refetch all 3 dependent queries.
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing.all });
    },
    onError: (err) => {
      captureClientError(err, { scope: "briefing.generate" });
      setActionError("generate");
    },
  });

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
      setActionError(null);
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
      setActionError("feedback");
    },
    onSettled: () => setSavingRank(null),
  });

  return {
    noteId,
    structured: briefingQuery.data?.structured ?? null,
    content,
    createdAt: briefingQuery.data?.briefing?.createdAt ?? null,
    status: statusQuery.data ?? null,
    loading: briefingQuery.isLoading,
    loadFailed: Boolean(briefingQuery.error),
    statusFailed: Boolean(statusQuery.error),
    retryLoad: () => void briefingQuery.refetch(),
    feedback: feedbackQuery.data ?? {},
    actionError,
    savingRank,
    generating: regenerateMutation.isPending,
    regenerate: () => regenerateMutation.mutate(),
    submitFeedback: (action: TopAction, choice: BriefingFeedbackChoice) => {
      if (!noteId || savingRank) return;
      feedbackMutation.mutate({ action, choice });
    },
    topActions: content ? extractTopActions(content) : [],
  };
}

export function extractTopActions(content: string): TopAction[] {
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

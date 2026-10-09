"use client";

/**
 * Today's data (productization plan §1, P6, UNIFIED_HOME). Every block reads
 * through its own query, so one failing block never blanks the page, and all
 * of them start together on mount — there is no waterfall.
 *
 * Requests on load: one list per lane block (PUSH, MEETING, QUEUE), one
 * grouped count for the INFO row, one calendar range, one briefing status and
 * one pending-approvals read. The connected accounts and the approvals count
 * share their cache entries with Mail and the sidebar, so they are not asked
 * for twice. Nothing here calls a model.
 */

import type {
  BriefingStatus,
  EmailLaneCountsResponse,
  EmailListResponse,
  LiveTier,
} from "@klorn/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";
import { ALL_ACCOUNTS, listRequestPath } from "../email/_v2/model";
import { type CalendarEventWire, dayRangeInZone } from "./model";

const MAIL_STALE_MS = 30_000;
/** Safety net behind the WebSocket: refetch while the tab is visible. */
const MAIL_POLL_MS = 60_000;
const CALENDAR_STALE_MS = 60_000;
const BRIEFING_STALE_MS = 60_000;
const APPROVALS_STALE_MS = 30_000;
const APPROVALS_POLL_MS = 60_000;

/**
 * Both keys sit under `queryKeys.email.all`, which is what Mail invalidates
 * after every triage action and on new mail — so a lane move in Mail refreshes
 * Today. The counts key is the one Mail v2 uses for "all accounts", so the two
 * surfaces share that entry outright.
 */
const todayKeys = {
  lane: (lane: LiveTier) => [...queryKeys.email.all, "today", "lane", lane] as const,
  laneCounts: () => [...queryKeys.email.all, "v2", "lane-counts", ALL_ACCOUNTS] as const,
};

export interface BlockState {
  loading: boolean;
  /** The read failed and there is no earlier answer to show. */
  failed: boolean;
  retry: () => void;
}

export function useLaneMail(lane: LiveTier, enabled: boolean) {
  const query = useQuery({
    queryKey: todayKeys.lane(lane),
    queryFn: async () => {
      const view = { lane, account: ALL_ACCOUNTS, filter: "none" as const, search: "" };
      try {
        return await apiFetch<EmailListResponse>(listRequestPath(view, 1));
      } catch (err) {
        captureClientError(err, { scope: "today.lane", lane });
        throw err;
      }
    },
    staleTime: MAIL_STALE_MS,
    refetchInterval: MAIL_POLL_MS,
    enabled,
  });
  return {
    emails: query.data?.emails ?? [],
    total: query.data?.total ?? 0,
    isDemo: query.data?.source === "demo",
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

export function useLaneCounts(enabled: boolean) {
  const query = useQuery({
    queryKey: todayKeys.laneCounts(),
    queryFn: () => apiFetch<EmailLaneCountsResponse>("/api/email/lane-counts"),
    staleTime: MAIL_STALE_MS,
    enabled,
  });
  return {
    counts: query.data?.counts ?? null,
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

/** New mail arrives over the WebSocket (NotificationBell bridges it here). */
export function useRefreshOnNewMail() {
  const queryClient = useQueryClient();
  useEffect(() => {
    const refresh = () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.email.all });
      void queryClient.invalidateQueries({ queryKey: queryKeys.briefing.status() });
    };
    window.addEventListener("conversations-updated", refresh);
    return () => window.removeEventListener("conversations-updated", refresh);
  }, [queryClient]);
}

/** Today's events from every connected calendar, in the user's zone. */
export function useTodayEvents(now: Date, timeZone: string, enabled: boolean) {
  const { start, end } = useMemo(() => dayRangeInZone(now, timeZone), [now, timeZone]);
  const from = start.toISOString();
  const to = end.toISOString();
  const query = useQuery({
    queryKey: queryKeys.calendar.events({ from, to }),
    queryFn: async () => {
      const path = `/api/calendar?start=${encodeURIComponent(from)}&end=${encodeURIComponent(to)}`;
      try {
        const data = await apiFetch<{ events: CalendarEventWire[] }>(path);
        return Array.isArray(data.events) ? data.events : [];
      } catch (err) {
        captureClientError(err, { scope: "today.calendar" });
        throw err;
      }
    },
    staleTime: CALENDAR_STALE_MS,
    enabled,
  });
  return {
    events: query.data ?? [],
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

/** The stored briefing, as written by the scheduler. Reading it runs no model. */
export function useBriefing(enabled: boolean) {
  const query = useQuery({
    queryKey: queryKeys.briefing.status(),
    queryFn: () => apiFetch<BriefingStatus>("/api/briefing/status"),
    staleTime: BRIEFING_STALE_MS,
    enabled,
  });
  return {
    status: query.data ?? null,
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

/**
 * How many approvals are waiting. Same key, request and timing as the
 * sidebar's count, so the two share one cache entry and one request.
 */
export function usePendingApprovals(enabled: boolean) {
  const query = useQuery({
    queryKey: ["sidebar", "pending-decisions"],
    queryFn: async () => {
      const data = await apiFetch<{ actions: unknown[] }>("/api/chat/pending-actions");
      return Array.isArray(data.actions) ? data.actions.length : 0;
    },
    staleTime: APPROVALS_STALE_MS,
    refetchInterval: APPROVALS_POLL_MS,
    enabled,
  });
  return {
    count: query.data ?? null,
    loading: enabled && query.isLoading,
    failed: query.isError && query.data === undefined,
    retry: () => void query.refetch(),
  };
}

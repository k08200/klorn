/**
 * Query keys + hooks for the reads the shell and Today make. Each block reads
 * through its own query so one failing block never blanks the screen.
 */
import type { EmailLaneCounts, FirewallResponse, LiveTier } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { getServices } from "../app/services";
import { isApiError } from "./client";
import type { InboxScope } from "./endpoints";

export const qk = {
  me: ["auth", "me"] as const,
  providers: ["auth", "providers"] as const,
  firewall: (inbox: InboxScope = "all") => ["mail", "firewall", inbox] as const,
  laneCounts: (inbox: InboxScope = "all") => ["mail", "lane-counts", inbox] as const,
  inboxes: ["mail", "inboxes"] as const,
  email: (id: string) => ["mail", "detail", id] as const,
  events: (from: string, to: string) => ["calendar", "events", from, to] as const,
  approvals: ["assistant", "pending-actions"] as const,
  briefing: ["assistant", "briefing"] as const,
};

export function useMe(enabled = true) {
  return useQuery({
    queryKey: qk.me,
    queryFn: ({ signal }) =>
      getServices()
        .ep.auth.me({ signal })
        .then((r) => r.user),
    staleTime: 5 * 60_000,
    enabled,
  });
}

export function useAuthProviders() {
  return useQuery({
    queryKey: qk.providers,
    queryFn: ({ signal }) => getServices().ep.auth.providers({ signal }),
    staleTime: 60 * 60_000,
    meta: { persist: false },
  });
}

export function useFirewall(inbox: InboxScope = "all") {
  return useQuery({
    queryKey: qk.firewall(inbox),
    queryFn: ({ signal }) => getServices().ep.mail.firewall(inbox, { signal }),
    refetchInterval: 60_000,
  });
}

const LANES: readonly LiveTier[] = ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"];

/** Open attention items per lane, AUTO folded to QUEUE (the server's normalizeTier rule). */
export function countsFromFirewall(firewall: FirewallResponse): EmailLaneCounts {
  const out = Object.fromEntries(LANES.map((l) => [l, { total: 0, unread: 0 }])) as EmailLaneCounts;
  for (const lane of LANES) out[lane].total = firewall.summary[lane] ?? 0;
  out.QUEUE.total += firewall.summary.AUTO ?? 0;
  return out;
}

/**
 * Mail per lane. /api/email/lane-counts is dark (404) until MAIL_V2 or
 * UNIFIED_HOME is on; then the firewall's open-item summary stands in, so the
 * lane strip works against today's production defaults too.
 */
export function useLaneCounts(inbox: InboxScope = "all") {
  return useQuery({
    queryKey: qk.laneCounts(inbox),
    queryFn: async ({ signal }) => {
      const { ep } = getServices();
      try {
        const res = await ep.mail.laneCounts(inbox, { signal });
        return { counts: res.counts, needsConnection: res.needsConnection === true, exact: true };
      } catch (err) {
        if (!isApiError(err) || err.status !== 404) throw err;
        const firewall = await ep.mail.firewall(inbox, { signal });
        return { counts: countsFromFirewall(firewall), needsConnection: false, exact: false };
      }
    },
    refetchInterval: 60_000,
  });
}

export function useInboxes() {
  return useQuery({
    queryKey: qk.inboxes,
    queryFn: ({ signal }) => getServices().ep.mail.inboxes({ signal }),
    staleTime: 5 * 60_000,
  });
}

export function useEmail(id: string | undefined) {
  return useQuery({
    queryKey: qk.email(id ?? ""),
    queryFn: ({ signal }) => getServices().ep.mail.detail(id ?? "", { signal }),
    enabled: !!id,
  });
}

export function useEvents(start: Date, end: Date) {
  const from = start.toISOString();
  const to = end.toISOString();
  return useQuery({
    queryKey: qk.events(from, to),
    queryFn: ({ signal }) =>
      getServices()
        .ep.calendar.events(start, end, { signal })
        .then((r) => (Array.isArray(r.events) ? r.events : [])),
    staleTime: 60_000,
  });
}

export function usePendingApprovals() {
  return useQuery({
    queryKey: qk.approvals,
    queryFn: ({ signal }) =>
      getServices()
        .ep.assistant.pendingActions({ signal })
        .then((r) => (Array.isArray(r.actions) ? r.actions : [])),
    refetchInterval: 60_000,
  });
}

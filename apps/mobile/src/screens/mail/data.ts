/**
 * Mail's reads: the paged list (infinite), the reader context, the sender /
 * thread context, Subscriptions. Keys live under ["mail", …] so a lane move or
 * a Done can patch / invalidate every view of the same mail at once.
 */
import type {
  EmailListItem,
  EmailListResponse,
  EmailReaderContextResponse,
  LiveTier,
} from "@klorn/contract";
import { type QueryClient, useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { isApiError } from "../../api/client";
import type { InboxScope, LaneFilter } from "../../api/endpoints";
import { qk } from "../../api/queries";
import type { EmailDetailWire } from "../../api/wire";
import { getServices } from "../../app/services";

export const mailKeys = {
  all: ["mail"] as const,
  feeds: ["mail", "feed"] as const,
  feed: (tier: LaneFilter, inbox: InboxScope, search: string) =>
    ["mail", "feed", tier, inbox, search] as const,
  readerContext: (id: string, tier: LaneFilter, inbox: InboxScope, search: string) =>
    ["mail", "reader-context", id, tier, inbox, search] as const,
  threadBrief: (id: string, lang: string) => ["mail", "thread-brief", id, lang] as const,
  dossier: (id: string, lang: string) => ["mail", "dossier", id, lang] as const,
  subscriptions: ["mail", "subscriptions"] as const,
};

/** A route that answers Fastify's bare 404 is dark (its flag is off), not a missing record. */
export function isDarkRoute(err: unknown): boolean {
  return isApiError(err) && err.status === 404 && err.serverMessage === "Not Found";
}

export function useMailFeed(tier: LaneFilter, inbox: InboxScope, search: string) {
  return useInfiniteQuery({
    queryKey: mailKeys.feed(tier, inbox, search),
    initialPageParam: 1,
    queryFn: ({ pageParam, signal }) =>
      getServices().ep.mail.list({ tier, inbox, page: pageParam, search }, { signal }),
    getNextPageParam: (last: EmailListResponse, pages: EmailListResponse[]) => {
      const loaded = pages.reduce((n, p) => n + p.emails.length, 0);
      return last.emails.length === 0 || loaded >= last.total ? undefined : last.page + 1;
    },
    refetchInterval: 60_000,
    // A search result is not worth keeping offline.
    meta: search ? { persist: false } : undefined,
  });
}

/**
 * The lane filter applied on the client as well: GET /api/email honours
 * `tier` only while MAIL_V2 / UNIFIED_HOME is on, so with the flags off the
 * server answers every lane and Mail narrows it here. QUEUE holds unjudged
 * mail too (the server's own rule). SILENT is recorded, never rendered in 전체.
 */
export function inLane(email: Pick<EmailListItem, "tier">, lane: LaneFilter): boolean {
  if (lane === "ALL") return email.tier !== "SILENT";
  if (lane === "QUEUE") return email.tier === "QUEUE" || email.tier === null;
  return email.tier === lane;
}

export function useReaderContext(
  id: string,
  view: { tier: LaneFilter; inbox: InboxScope; search: string },
) {
  return useQuery({
    queryKey: mailKeys.readerContext(id, view.tier, view.inbox, view.search),
    queryFn: async ({ signal }): Promise<EmailReaderContextResponse | null> => {
      try {
        return await getServices().ep.mail.readerContext(id, view, { signal });
      } catch (err) {
        if (isDarkRoute(err)) return null;
        throw err;
      }
    },
    staleTime: 60_000,
  });
}

/** LLM-backed context: cached server-side; never retried into a rate limit. */
const NO_RETRY = { retry: false, staleTime: 10 * 60_000 } as const;

export function useThreadBrief(id: string, lang: "ko" | "en", enabled: boolean) {
  return useQuery({
    queryKey: mailKeys.threadBrief(id, lang),
    queryFn: ({ signal }) =>
      getServices()
        .ep.mail.threadBrief(id, lang, { signal })
        .then((r) => r.brief),
    enabled,
    ...NO_RETRY,
  });
}

export function useSenderDossier(id: string, lang: "ko" | "en", enabled: boolean) {
  return useQuery({
    queryKey: mailKeys.dossier(id, lang),
    queryFn: ({ signal }) => getServices().ep.mail.senderDossier(id, lang, { signal }),
    enabled,
    ...NO_RETRY,
  });
}

/**
 * Subscriptions — null when the route is dark (BULK_UNSUBSCRIBE_ENABLED off):
 * Mail then hides its entry point.
 */
export function useSubscriptions(enabled = true) {
  return useQuery({
    queryKey: mailKeys.subscriptions,
    queryFn: async ({ signal }) => {
      try {
        return await getServices().ep.subscriptions.list({ signal });
      } catch (err) {
        if (isApiError(err) && err.status === 404) return null;
        throw err;
      }
    },
    enabled,
    staleTime: 5 * 60_000,
  });
}

/** Show `tier` on one mail everywhere it is cached (list pages, detail, reader context). */
export function patchMailTier(qc: QueryClient, emailId: string, tier: LiveTier | null): void {
  qc.setQueriesData<{ pages: EmailListResponse[]; pageParams: unknown[] }>(
    { queryKey: mailKeys.feeds },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              emails: page.emails.map((e) => (e.id === emailId ? { ...e, tier } : e)),
            })),
          }
        : data,
  );
  qc.setQueryData<EmailDetailWire>(qk.email(emailId), (d) => (d ? { ...d, tier } : d));
  qc.setQueriesData<EmailReaderContextResponse | null>(
    { queryKey: ["mail", "reader-context", emailId] },
    (d) => (d ? { ...d, tier } : d),
  );
}

/** Mark rows read in every cached list page (after the reader marks one read). */
export function patchMailRead(qc: QueryClient, emailId: string): void {
  qc.setQueriesData<{ pages: EmailListResponse[]; pageParams: unknown[] }>(
    { queryKey: mailKeys.feeds },
    (data) =>
      data
        ? {
            ...data,
            pages: data.pages.map((page) => ({
              ...page,
              emails: page.emails.map((e) => (e.id === emailId ? { ...e, isRead: true } : e)),
            })),
          }
        : data,
  );
}

/** Every cached list row, newest first (the reader finds a deep-linked mail's row here). */
export function cachedRow(qc: QueryClient, emailId: string): EmailListItem | undefined {
  for (const [, data] of qc.getQueriesData<{ pages: EmailListResponse[] }>({
    queryKey: mailKeys.feeds,
  })) {
    for (const page of data?.pages ?? []) {
      const hit = page.emails.find((e) => e.id === emailId);
      if (hit) return hit;
    }
  }
  return undefined;
}

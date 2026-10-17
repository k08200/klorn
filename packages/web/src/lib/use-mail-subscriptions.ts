"use client";

/**
 * The Subscriptions list (Mail → Subscriptions). One cache entry shared by the
 * page and its entry points, so an entry point only appears once the list has
 * actually loaded.
 *
 * `null` = the surface is unavailable (BULK_UNSUBSCRIBE_ENABLED is off and the
 * server answers 404): the page shows a calm "not available" state and no entry
 * point renders. Any other failure is an error the page can retry.
 */

import type { EmailSubscriptionsResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./api";
import { queryKeys } from "./query-keys";

export function useMailSubscriptions(enabled = true) {
  return useQuery({
    enabled,
    queryKey: queryKeys.email.subscriptions(),
    queryFn: async (): Promise<EmailSubscriptionsResponse | null> => {
      try {
        return await apiFetch<EmailSubscriptionsResponse>("/api/email/subscriptions");
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("API 404")) return null;
        throw err;
      }
    },
    // The list is a 90-day aggregate; there is no reason to refetch on focus.
    staleTime: 5 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });
}

/**
 * True only once the list has loaded — the entry points' condition. Pass
 * `enabled: false` to skip the request (it then stays false until enabled).
 */
export function useMailSubscriptionsAvailable(enabled = true): boolean {
  const { data } = useMailSubscriptions(enabled);
  return data != null;
}

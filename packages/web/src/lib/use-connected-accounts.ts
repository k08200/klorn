"use client";

/**
 * The connected accounts with their health, for Today's accounts strip and the
 * sidebar's Accounts group (productization plan §1, P6). Reads the same
 * GET /api/email/inboxes cache entry as Mail, so the three surfaces cost one
 * request between them.
 */

import type { InboxesResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { apiFetch } from "./api";
import { useAuth } from "./auth";
import { type ConnectedAccount, connectedAccounts } from "./connected-accounts";
import { queryKeys } from "./query-keys";

const INBOXES_STALE_MS = 5 * 60 * 1000;

export interface ConnectedAccountsState {
  accounts: ConnectedAccount[];
  loading: boolean;
  /** The list could not be read and there is no earlier answer to show. */
  failed: boolean;
  retry: () => void;
}

export function useConnectedAccounts(enabled = true): ConnectedAccountsState {
  const { googleConnected, initSync } = useAuth();
  const query = useQuery({
    queryKey: queryKeys.email.inboxes(),
    queryFn: () => apiFetch<InboxesResponse>("/api/email/inboxes"),
    staleTime: INBOXES_STALE_MS,
    enabled,
  });
  const primarySyncing = initSync.status === "syncing";
  const accounts = useMemo(
    () => connectedAccounts(query.data?.inboxes ?? [], { googleConnected, primarySyncing }),
    [query.data, googleConnected, primarySyncing],
  );
  return {
    accounts,
    loading: enabled && query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

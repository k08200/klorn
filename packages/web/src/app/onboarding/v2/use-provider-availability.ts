"use client";

import type { ProvidersAvailableResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../lib/api";

/** Flags change with a deploy-free flip; a first run is short, so one read is enough. */
const AVAILABILITY_STALE_MS = 5 * 60 * 1000;

/**
 * Which providers this deployment can connect (GET /api/providers/available).
 * The grid draws nothing it was not told about: while this is loading or has
 * failed there are no tiles, only the loading or the retry state.
 */
export function useProviderAvailability() {
  const query = useQuery({
    queryKey: ["providers", "available"] as const,
    queryFn: () => apiFetch<ProvidersAvailableResponse>("/api/providers/available"),
    staleTime: AVAILABILITY_STALE_MS,
  });
  return {
    providers: query.data?.providers ?? [],
    loading: query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
  };
}

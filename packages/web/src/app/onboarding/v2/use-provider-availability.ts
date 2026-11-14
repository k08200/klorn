"use client";

import type { ProvidersAvailableResponse } from "@klorn/contract";
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";

/** Flags change with a deploy-free flip; a first run is short, so one read is enough. */
const AVAILABILITY_STALE_MS = 5 * 60 * 1000;

/**
 * Which providers this deployment can connect (GET /api/providers/available).
 * The grid draws nothing it was not told about: while this is loading or has
 * failed there are no tiles, only the loading or the retry state.
 *
 * The answer is per user (the app-password presets follow a rollout cohort), and
 * logout does not clear the query cache: the key carries the signed-in user, so
 * another account on the same tab never reuses this one's list.
 */
export function useProviderAvailability() {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["providers", "available", user?.id ?? null],
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

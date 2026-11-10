"use client";

/**
 * Live numbers for the first run's sync screen (productization plan P8).
 *
 * Every number is read, none is estimated: the primary account's sign-in sync
 * comes from the auth context, and each account's message count is its lane
 * counts (GET /api/email/lane-counts?inbox=), re-read every few seconds while
 * the screen is open. That route exists only while the lane reads are on
 * (MAIL_V2 or UNIFIED_HOME) and answers sample data for a user without a
 * Google grant; in both cases the account simply has no number.
 */

import type { EmailLaneCounts, EmailLaneCountsResponse, LiveTier } from "@klorn/contract";
import { useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import type { ConnectedAccount } from "../../../lib/connected-accounts";
import { queryKeys } from "../../../lib/query-keys";
import { laneTotal, laneTotals, type SyncRow, syncRow } from "./model";

/** Gap between reads: well inside the route's 120-a-minute limit for a handful of accounts. */
const POLL_MS = 3000;

interface Seen {
  total: number;
  updatedAt: number;
  stableReads: number;
}

export interface AccountProgress {
  account: ConnectedAccount;
  row: SyncRow;
}

export interface SyncProgress {
  accounts: AccountProgress[];
  /** Mail per lane across the accounts that reported counts; null when none did. */
  lanes: Record<LiveTier, number> | null;
}

export function useSyncProgress(accounts: readonly ConnectedAccount[]): SyncProgress {
  const { initSync } = useAuth();
  const results = useQueries({
    queries: accounts.map((account) => ({
      queryKey: [...queryKeys.email.all, "onboarding-v2", "lane-counts", account.scope] as const,
      queryFn: () =>
        apiFetch<EmailLaneCountsResponse>(
          `/api/email/lane-counts?inbox=${encodeURIComponent(account.scope)}`,
        ),
      // A failure (the route is dark, or the account is gone) is not retried:
      // the row states that it has no number.
      retry: false,
      refetchInterval: (query: { state: { status: string; data?: EmailLaneCountsResponse } }) =>
        query.state.status === "error" || query.state.data?.source === "demo" ? false : POLL_MS,
    })),
  });

  // How many reads in a row each account's total has held still.
  const seen = useRef(new Map<string, Seen>());
  const [stable, setStable] = useState<ReadonlyMap<string, Seen>>(new Map());
  const stamp = results.map((result) => result.dataUpdatedAt).join(",");
  // biome-ignore lint/correctness/useExhaustiveDependencies: `stamp` is the read clock; results and accounts are read at that tick.
  useEffect(() => {
    const next = new Map<string, Seen>();
    accounts.forEach((account, index) => {
      const result = results[index];
      const counts = realCounts(result?.data);
      if (!counts || !result) return;
      const total = laneTotal(counts);
      const entry = nextSeen(seen.current.get(account.scope), total, result.dataUpdatedAt);
      seen.current.set(account.scope, entry);
      next.set(account.scope, entry);
    });
    setStable(next);
  }, [stamp]);

  const perAccount = accounts.map((account, index) => {
    const result = results[index];
    const counts = realCounts(result?.data);
    const countsUnavailable =
      result !== undefined && (result.isError || (result.data !== undefined && counts === null));
    return {
      account,
      counts,
      row: syncRow(account, {
        initSync,
        counts,
        countsUnavailable,
        stableReads: streakFor(stable.get(account.scope), counts),
      }),
    };
  });

  return {
    accounts: perAccount.map(({ account, row }) => ({ account, row })),
    lanes: laneTotals(perAccount.map((entry) => entry.counts)),
  };
}

/** A streak counts only for the total it was measured on: a new total starts over at once. */
function streakFor(seen: Seen | undefined, counts: EmailLaneCounts | null): number {
  return seen && counts && seen.total === laneTotal(counts) ? seen.stableReads : 0;
}

/** One read later: the streak grows while the total holds, and restarts when it moves. */
function nextSeen(before: Seen | undefined, total: number, updatedAt: number): Seen {
  if (before === undefined) return { total, updatedAt, stableReads: 0 };
  if (before.updatedAt === updatedAt) return before;
  return { total, updatedAt, stableReads: before.total === total ? before.stableReads + 1 : 0 };
}

/** Sample rows are not this user's mail: they are never shown as a count. */
function realCounts(data: EmailLaneCountsResponse | undefined): EmailLaneCounts | null {
  return data && data.source === "gmail" ? data.counts : null;
}

"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useMemo, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import {
  CommitmentCard,
  type CommitmentItem,
  type CommitmentLoadingState,
} from "../../components/commitment-card";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { queryKeys } from "../../lib/query-keys";
import { captureClientError } from "../../lib/sentry";

type StatusFilter = "OPEN" | "ALL";

// Time buckets — keep the ordering here authoritative since both the
// grouping logic and the rendering iterate over BUCKET_ORDER.
const BUCKET_ORDER = ["overdue", "today", "week", "later", "noDue"] as const;
type Bucket = (typeof BUCKET_ORDER)[number];

const BUCKET_LABELS: Record<Bucket, string> = {
  overdue: "Overdue",
  today: "Today",
  week: "This week",
  later: "Later",
  noDue: "No due date",
};

export default function LedgerPage() {
  return (
    <AuthGuard>
      <LedgerView />
    </AuthGuard>
  );
}

function LedgerView() {
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [filter, setFilter] = useState<StatusFilter>("OPEN");
  const [search, setSearch] = useState("");
  const [commitmentLoading, setCommitmentLoading] = useState<
    Record<string, CommitmentLoadingState>
  >({});

  const commitmentsQuery = useQuery({
    queryKey: queryKeys.commitments.list(filter),
    queryFn: async () => {
      const params = filter === "OPEN" ? "?status=OPEN&limit=100" : "?limit=100";
      const data = await apiFetch<{ commitments: CommitmentItem[] }>(`/api/commitments${params}`);
      return Array.isArray(data.commitments) ? data.commitments : [];
    },
  });

  const commitments = commitmentsQuery.data ?? [];
  const loading = commitmentsQuery.isLoading;

  // Search + bucket + sort happens client-side. The API already capped the
  // result at 100, which is fine for the dogfood scale; if the ledger
  // grows past that we'll need server-side filters anyway.
  const groups = useMemo(() => groupCommitments(commitments, search), [commitments, search]);
  const totalShown = useMemo(
    () => BUCKET_ORDER.reduce((sum, key) => sum + groups[key].length, 0),
    [groups],
  );

  const handleStatus = async (commitmentId: string, status: "DONE" | "DISMISSED" | "SNOOZED") => {
    if (commitmentLoading[commitmentId]) return;
    const loadingState: CommitmentLoadingState =
      status === "DONE" ? "done" : status === "SNOOZED" ? "snooze" : "dismiss";
    setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: loadingState }));
    try {
      await apiFetch(`/api/commitments/${commitmentId}`, {
        method: "PATCH",
        body: JSON.stringify({ status }),
      });
      // Optimistic remove from current view + invalidate inbox preview count.
      queryClient.setQueryData<CommitmentItem[]>(queryKeys.commitments.list(filter), (prev) =>
        (prev ?? []).filter((c) => c.id !== commitmentId),
      );
      queryClient.invalidateQueries({ queryKey: queryKeys.inbox.commitments() });
      if (status === "SNOOZED") toast("Snoozed for 24h.", "success");
    } catch (err) {
      captureClientError(err, { scope: "ledger.status", commitmentId, status });
      toast("Could not update the commitment. Please try again soon.", "error");
    } finally {
      setCommitmentLoading((prev) => ({ ...prev, [commitmentId]: null }));
    }
  };

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-6 md:py-8">
      <div className="mb-6 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-amber-300">
            Klorn · Ledger
          </p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight text-stone-50">
            Tracked commitments
          </h1>
          <p className="mt-1 text-xs text-stone-500">
            Commitments Klorn picked up from mail and decision threads. Resolve with Done or
            Dismiss.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1 shrink-0">
          <FilterTab active={filter === "OPEN"} label="Open" onClick={() => setFilter("OPEN")} />
          <FilterTab active={filter === "ALL"} label="All" onClick={() => setFilter("ALL")} />
        </div>
      </div>

      {commitments.length > 0 && <SearchInput value={search} onChange={setSearch} />}

      {commitmentsQuery.error && (
        <div className="mb-4 rounded-lg border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-300">
          Could not load the ledger.
        </div>
      )}

      {loading && (
        <div className="space-y-2 rounded-xl border border-stone-800 bg-stone-900/30 p-4">
          <div className="h-20 animate-pulse rounded-lg bg-stone-800/60" />
          <div className="h-20 animate-pulse rounded-lg bg-stone-800/40" />
          <div className="h-20 animate-pulse rounded-lg bg-stone-800/30" />
        </div>
      )}

      {!loading && commitments.length === 0 && (
        <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-8 text-center">
          <p className="text-base text-stone-200">
            {filter === "OPEN" ? "No commitments being tracked." : "No commitment history yet."}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-stone-500">
            When Klorn detects a commitment in new mail or a decision thread, it appears here.
          </p>
          <Link
            href="/inbox"
            className="mt-5 inline-flex min-h-9 items-center justify-center rounded-md border border-stone-700 px-4 text-xs text-stone-300 transition hover:bg-stone-800"
          >
            Back to decision queue
          </Link>
        </div>
      )}

      {!loading && commitments.length > 0 && totalShown === 0 && (
        <div className="rounded-xl border border-stone-800 bg-stone-900/30 p-6 text-center">
          <p className="text-sm text-stone-300">No matching commitments.</p>
          <p className="mt-1 text-xs text-stone-500">
            Nothing matches "{search}". Clear the search to see everything again.
          </p>
        </div>
      )}

      {totalShown > 0 && (
        <div className="space-y-6">
          {BUCKET_ORDER.map((key) => {
            const items = groups[key];
            if (items.length === 0) return null;
            return (
              <section key={key} aria-label={BUCKET_LABELS[key]}>
                <div className="mb-2 flex items-baseline gap-2 px-1">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-stone-400">
                    {BUCKET_LABELS[key]}
                  </h2>
                  <span className="text-[11px] text-stone-600">{items.length}</span>
                </div>
                <ul className="space-y-2">
                  {items.map((commitment) => (
                    <li key={commitment.id}>
                      <CommitmentCard
                        commitment={commitment}
                        loading={commitmentLoading[commitment.id] ?? null}
                        onDone={() => handleStatus(commitment.id, "DONE")}
                        onDismiss={() => handleStatus(commitment.id, "DISMISSED")}
                        onSnooze={() => handleStatus(commitment.id, "SNOOZED")}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            );
          })}
        </div>
      )}
    </div>
  );
}

function FilterTab({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs transition ${
        active ? "bg-stone-800 text-white" : "text-stone-400 hover:text-stone-200"
      }`}
    >
      {label}
    </button>
  );
}

function SearchInput({ value, onChange }: { value: string; onChange: (next: string) => void }) {
  return (
    <div className="relative mb-5">
      <svg
        aria-hidden="true"
        className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-stone-500"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <circle cx="11" cy="11" r="8" />
        <line x1="21" y1="21" x2="16.65" y2="16.65" />
      </svg>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search commitments..."
        className="w-full rounded-lg border border-stone-800 bg-stone-950/80 py-2 pl-10 pr-9 text-sm text-stone-200 placeholder-stone-600 transition focus:border-stone-600 focus:outline-none"
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange("")}
          className="absolute right-2 top-1/2 -translate-y-1/2 px-2 text-xs text-stone-500 hover:text-stone-300"
          aria-label="Clear search"
        >
          ✕
        </button>
      )}
    </div>
  );
}

// ─── Grouping ────────────────────────────────────────────────────────────

/**
 * Bucket commitments by due date relative to the user's current local time
 * and sort each bucket by dueAt ascending. Items without a dueAt fall into
 * `noDue` and sort by `createdAt` so the most-recently-tracked appears first.
 * The search filter is applied first so empty searches return all items.
 */
function groupCommitments(
  commitments: CommitmentItem[],
  search: string,
): Record<Bucket, CommitmentItem[]> {
  const normalized = search.trim().toLowerCase();
  const filtered = normalized
    ? commitments.filter((c) => {
        const title = (c.title ?? "").toLowerCase();
        const description = (c.description ?? "").toLowerCase();
        return title.includes(normalized) || description.includes(normalized);
      })
    : commitments;

  const now = new Date();
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const tomorrowStart = new Date(todayStart.getTime() + 24 * 60 * 60 * 1000);
  // ISO week-ish: "this week" = next 7 days from today. Cheap and close enough.
  const weekEnd = new Date(todayStart.getTime() + 7 * 24 * 60 * 60 * 1000);

  const buckets: Record<Bucket, CommitmentItem[]> = {
    overdue: [],
    today: [],
    week: [],
    later: [],
    noDue: [],
  };

  for (const c of filtered) {
    if (!c.dueAt) {
      buckets.noDue.push(c);
      continue;
    }
    const due = new Date(c.dueAt);
    if (due < todayStart) buckets.overdue.push(c);
    else if (due < tomorrowStart) buckets.today.push(c);
    else if (due < weekEnd) buckets.week.push(c);
    else buckets.later.push(c);
  }

  // Sort each bucket. Dated buckets: due ascending (closest first). For
  // overdue we still sort ascending so the longest-overdue item is at the
  // top, which is usually what the user wants to clear first.
  const sortByDueAsc = (a: CommitmentItem, b: CommitmentItem) =>
    new Date(a.dueAt ?? 0).getTime() - new Date(b.dueAt ?? 0).getTime();
  const sortByCreatedDesc = (a: CommitmentItem, b: CommitmentItem) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();

  buckets.overdue.sort(sortByDueAsc);
  buckets.today.sort(sortByDueAsc);
  buckets.week.sort(sortByDueAsc);
  buckets.later.sort(sortByDueAsc);
  buckets.noDue.sort(sortByCreatedDesc);

  return buckets;
}

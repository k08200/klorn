"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useState } from "react";
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
            추적 중인 약속
          </h1>
          <p className="mt-1 text-xs text-stone-500">
            Klorn이 메일과 결정 스레드에서 자동으로 잡아낸 약속들. Done / Dismiss로 정리하세요.
          </p>
        </div>
        <div className="flex items-center gap-1 rounded-lg border border-stone-800 bg-stone-950/80 p-1 shrink-0">
          <FilterTab active={filter === "OPEN"} label="Open" onClick={() => setFilter("OPEN")} />
          <FilterTab active={filter === "ALL"} label="All" onClick={() => setFilter("ALL")} />
        </div>
      </div>

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
            {filter === "OPEN" ? "추적 중인 약속이 없습니다." : "약속 기록이 없습니다."}
          </p>
          <p className="mx-auto mt-2 max-w-sm text-xs text-stone-500">
            새 메일이나 결정 스레드에서 약속이 발견되면 여기에 표시됩니다.
          </p>
          <Link
            href="/inbox"
            className="mt-5 inline-flex min-h-9 items-center justify-center rounded-md border border-stone-700 px-4 text-xs text-stone-300 transition hover:bg-stone-800"
          >
            Decision queue로 돌아가기
          </Link>
        </div>
      )}

      {commitments.length > 0 && (
        <ul className="space-y-2">
          {commitments.map((commitment) => (
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

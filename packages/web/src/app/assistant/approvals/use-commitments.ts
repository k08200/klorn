"use client";

/**
 * The open Commitment Ledger rows and the three ways to settle one: Confirm
 * (a suggestion is a real promise), Done, Dismiss. All three are the user's
 * own rows (the API checks ownership on every PATCH); Done and Dismiss take
 * the row off the list, Confirm moves it to "Confirmed".
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import type { CommitmentItem } from "../../../components/commitment-card";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";

export type CommitmentAction = "confirm" | "done" | "dismiss";

/** The API's own list cap: every open row, suggestions included. */
const FETCH_LIMIT = 200;
const LIST_KEY = queryKeys.commitments.list("OPEN");

const PATCH_BODY: Record<CommitmentAction, Record<string, unknown>> = {
  confirm: { confirmed: true },
  done: { status: "DONE" },
  dismiss: { status: "DISMISSED" },
};

const DONE_TOAST: Record<CommitmentAction, string> = {
  confirm: "assistantHub.commitments.confirmedToast",
  done: "assistantHub.commitments.doneToast",
  dismiss: "assistantHub.commitments.dismissedToast",
};

function settled(
  rows: readonly CommitmentItem[],
  id: string,
  action: CommitmentAction,
): CommitmentItem[] {
  if (action !== "confirm") return rows.filter((row) => row.id !== id);
  const at = new Date().toISOString();
  return rows.map((row) =>
    row.id === id ? { ...row, confirmed: true, confirmedAt: row.confirmedAt ?? at } : row,
  );
}

export function useCommitmentLedger() {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<Readonly<Record<string, CommitmentAction>>>({});

  const query = useQuery({
    queryKey: LIST_KEY,
    queryFn: async () => {
      try {
        const data = await apiFetch<{ commitments: CommitmentItem[] }>(
          `/api/commitments?status=OPEN&limit=${FETCH_LIMIT}`,
        );
        return Array.isArray(data.commitments) ? data.commitments : [];
      } catch (err) {
        captureClientError(err, { scope: "assistant.commitments.load" });
        throw err;
      }
    },
  });

  const act = useCallback(
    async (id: string, action: CommitmentAction) => {
      setBusy((prev) => ({ ...prev, [id]: action }));
      try {
        await apiFetch(`/api/commitments/${encodeURIComponent(id)}`, {
          method: "PATCH",
          body: JSON.stringify(PATCH_BODY[action]),
        });
        queryClient.setQueryData<CommitmentItem[]>(LIST_KEY, (prev) =>
          settled(prev ?? [], id, action),
        );
        // The legacy queue (/inbox with UNIFIED_HOME off) reads its own entry.
        void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.commitments() });
        toast(t(DONE_TOAST[action]), "success");
      } catch (err) {
        captureClientError(err, { scope: `assistant.commitments.${action}`, commitmentId: id });
        toast(t("assistantHub.commitments.actionFailed"), "error");
        // Usually a row settled elsewhere (Mac, another tab): re-read the list.
        void queryClient.invalidateQueries({ queryKey: LIST_KEY });
      } finally {
        setBusy((prev) => Object.fromEntries(Object.entries(prev).filter(([key]) => key !== id)));
      }
    },
    [queryClient, t, toast],
  );

  return {
    rows: query.data ?? [],
    loading: query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
    busy,
    act,
  };
}

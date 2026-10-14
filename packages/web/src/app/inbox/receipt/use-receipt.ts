"use client";

/**
 * Today's receipt and its one action, "request undo". Shared by the legacy
 * /inbox/receipt page and the Assistant hub's Activity page (productization
 * plan P7): one cache entry, one mutation. The outcome of an undo request is
 * handed to the caller, which words it for its own surface.
 */

// Wire shapes come from @klorn/contract — the same types the server builds
// (routes/receipt.ts), so a response-shape change fails to compile here
// instead of silently desyncing.
import type { DailyReceipt, ReceiptUndoResponse } from "@klorn/contract";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../../../lib/api";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";

interface UseReceiptOptions {
  /** The server answered an undo request (ok or refused). */
  onUndoAnswer: (result: ReceiptUndoResponse) => void;
  /** The undo request itself failed. */
  onUndoError: () => void;
}

export function useReceipt({ onUndoAnswer, onUndoError }: UseReceiptOptions) {
  const queryClient = useQueryClient();
  const [undoLoading, setUndoLoading] = useState<Record<string, boolean>>({});

  const receiptQuery = useQuery({
    queryKey: queryKeys.inbox.receipt(),
    queryFn: async () => {
      try {
        return await apiFetch<DailyReceipt>("/api/inbox/receipt/today");
      } catch (err) {
        captureClientError(err, { scope: "receipt.load" });
        throw err;
      }
    },
  });

  const undoMutation = useMutation({
    mutationFn: (pendingActionId: string) =>
      apiFetch<ReceiptUndoResponse>(`/api/inbox/receipt/undo/${pendingActionId}`, {
        method: "POST",
      }),
    onMutate: (pendingActionId) => {
      setUndoLoading((prev) => ({ ...prev, [pendingActionId]: true }));
    },
    onSuccess: (result) => {
      onUndoAnswer(result);
      if (result.ok) {
        // The undo creates a new proposal server-side; refetch reflects it.
        void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.receipt() });
      }
    },
    onError: (err, pendingActionId) => {
      captureClientError(err, { scope: "receipt.undo", pendingActionId });
      onUndoError();
    },
    onSettled: (_data, _err, pendingActionId) => {
      setUndoLoading((prev) => ({ ...prev, [pendingActionId]: false }));
    },
  });

  const isUndoing = (pendingActionId: string) =>
    Object.hasOwn(undoLoading, pendingActionId) && undoLoading[pendingActionId] === true;

  return {
    receiptQuery,
    isUndoing,
    requestUndo: (pendingActionId: string) => {
      if (isUndoing(pendingActionId)) return;
      undoMutation.mutate(pendingActionId);
    },
  };
}

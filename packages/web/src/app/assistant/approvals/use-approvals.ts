"use client";

/**
 * Data and decisions for the Approvals page (productization plan P7).
 *
 * Same endpoints, same cache entries and the same effects as the legacy
 * decision queue (app/inbox/page.tsx): approving runs the action on the
 * server, rejecting records the rejection and its optional reason. Two things
 * differ, and neither changes what a decision does:
 *
 *  - Approve waits for the server before the card leaves. An approval runs a
 *    real action (a send cannot be taken back), so the card never claims it
 *    happened before it did.
 *  - Reject is held for a few seconds behind an Undo notice before it is sent.
 *    The API has no un-reject, so the only honest undo is not to have sent it
 *    yet. Leaving the page or closing the tab sends it (a keepalive request
 *    on unmount and on pagehide).
 */

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import type { CommitmentItem } from "../../../components/commitment-card";
import { useToast } from "../../../components/toast";
import { apiFetch } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";
import { UNDO_NOTICE_SECONDS } from "../../email/use-lane-move";
import type { PendingActionItem } from "./model";

/** The cache entry the legacy queue reads for its "pending" filter. */
const PENDING_KEY = [...queryKeys.inbox.pending(), "pending"] as const;
/** The sidebar's and Today's count of the same list. */
const COUNT_KEY = ["sidebar", "pending-decisions"] as const;
const POLL_MS = 15_000;
const SYNC_BATCH = 30;

export interface HeldReject {
  id: string;
  /** What the notice names: the card's subject or its action. */
  label: string;
  reason: string | null;
}

export function useApprovals() {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [approving, setApproving] = useState<string | null>(null);
  const [held, setHeld] = useState<HeldReject | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  // Decided here and on its way to, or already accepted by, the server. A list
  // read that started before the server knew (the 15s poll, a focus refetch)
  // can still carry the card; it stays hidden rather than flashing back.
  const [decided, setDecided] = useState<ReadonlySet<string>>(new Set());
  const approvingRef = useRef(false);
  const mountedRef = useRef(true);
  const heldRef = useRef<HeldReject | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const query = useQuery({
    queryKey: PENDING_KEY,
    refetchInterval: POLL_MS,
    refetchOnWindowFocus: true,
    queryFn: async () => {
      try {
        const data = await apiFetch<{ actions: PendingActionItem[] }>("/api/chat/pending-actions");
        return Array.isArray(data.actions) ? data.actions : [];
      } catch (err) {
        captureClientError(err, { scope: "assistant.approvals.load" });
        throw err;
      }
    },
  });

  const invalidate = useCallback(
    () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.inbox.pending() }),
        queryClient.invalidateQueries({ queryKey: COUNT_KEY }),
      ]),
    [queryClient],
  );

  const markDecided = useCallback((id: string, isDecided: boolean) => {
    setDecided((prev) =>
      isDecided ? new Set([...prev, id]) : new Set([...prev].filter((other) => other !== id)),
    );
  }, []);

  const drop = useCallback(
    (id: string) => {
      queryClient.setQueryData<PendingActionItem[]>(PENDING_KEY, (prev) =>
        (prev ?? []).filter((action) => action.id !== id),
      );
      void queryClient.invalidateQueries({ queryKey: COUNT_KEY });
    },
    [queryClient],
  );

  // New mail arrives over the WebSocket (NotificationBell bridges it here).
  useEffect(() => {
    const refresh = () => void invalidate();
    window.addEventListener("conversations-updated", refresh);
    return () => window.removeEventListener("conversations-updated", refresh);
  }, [invalidate]);

  const approve = useCallback(
    async (id: string, sendsMail: boolean): Promise<boolean> => {
      // A ref, not the state: two calls in one tick must not both get through.
      if (approvingRef.current) return false;
      approvingRef.current = true;
      setApproving(id);
      try {
        await apiFetch(`/api/chat/pending-actions/${encodeURIComponent(id)}/approve`, {
          method: "POST",
        });
        markDecided(id, true);
        drop(id);
        toast(
          t(sendsMail ? "assistantHub.approvals.sent" : "assistantHub.approvals.approved"),
          "success",
        );
        return true;
      } catch (err) {
        captureClientError(err, { scope: "assistant.approvals.approve", actionId: id });
        toast(t("assistantHub.approvals.approveFailed"), "error");
        // The usual cause is a card that expired or was handled elsewhere:
        // re-read the list so it leaves instead of inviting another try.
        void invalidate();
        return false;
      } finally {
        approvingRef.current = false;
        setApproving(null);
      }
    },
    [drop, invalidate, markDecided, t, toast],
  );

  const sendReject = useCallback(
    async (reject: HeldReject) => {
      // Hidden from the moment it is sent, not only once the server answers.
      markDecided(reject.id, true);
      try {
        await apiFetch(`/api/chat/pending-actions/${encodeURIComponent(reject.id)}/reject`, {
          method: "POST",
          body: JSON.stringify(reject.reason ? { reason: reject.reason } : {}),
          // Outlives the page: a rejection flushed by leaving or closing the
          // tab is still delivered.
          keepalive: true,
        });
        drop(reject.id);
      } catch (err) {
        captureClientError(err, { scope: "assistant.approvals.reject", actionId: reject.id });
        // Off this page there is nothing to point at: a notice on another
        // screen would name no card. The list is the record — the approval is
        // still pending and is there on the next visit.
        if (!mountedRef.current) return;
        // Not sent: the card comes back, and the notice says why.
        markDecided(reject.id, false);
        toast(t("assistantHub.approvals.rejectFailed"), "error");
      }
    },
    [drop, markDecided, t, toast],
  );

  /** Send the held rejection now (the window ran out, or another one starts). */
  const settle = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    const pending = heldRef.current;
    heldRef.current = null;
    setHeld(null);
    if (pending) void sendReject(pending);
  }, [sendReject]);

  const reject = useCallback(
    (next: HeldReject) => {
      settle();
      heldRef.current = next;
      setHeld(next);
      timerRef.current = setTimeout(settle, UNDO_NOTICE_SECONDS * 1000);
    },
    [settle],
  );

  const undoReject = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    heldRef.current = null;
    setHeld(null);
  }, []);

  // Leaving the page is not an undo: the held rejection is sent.
  const settleRef = useRef(settle);
  useEffect(() => {
    settleRef.current = settle;
  }, [settle]);
  useEffect(() => {
    mountedRef.current = true;
    // Closing or backgrounding the tab is not an undo either.
    const flush = () => settleRef.current();
    window.addEventListener("pagehide", flush);
    return () => {
      window.removeEventListener("pagehide", flush);
      mountedRef.current = false;
      settleRef.current();
    };
  }, []);

  /** Pull new mail, then re-read the list — the manual path when no push arrived. */
  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const result = await apiFetch<{ error?: string }>("/api/email/sync", {
        method: "POST",
        body: JSON.stringify({ maxResults: SYNC_BATCH }),
      });
      // 200 with { error } is the dead-token shape: say so instead of quietly
      // re-reading what the server already had.
      if (result?.error) toast(t("assistantHub.approvals.syncFailed"), "error");
    } catch (err) {
      captureClientError(err, { scope: "assistant.approvals.sync" });
    } finally {
      await invalidate();
      setRefreshing(false);
    }
  }, [invalidate, t, toast]);

  const actions = (query.data ?? []).filter(
    (action) => action.status === "PENDING" && action.id !== held?.id && !decided.has(action.id),
  );

  return {
    actions,
    loading: query.isLoading,
    failed: query.isError && !query.data,
    retry: () => void query.refetch(),
    refreshing,
    refresh,
    approving,
    approve,
    held,
    reject,
    settleReject: settle,
    undoReject,
  };
}

/**
 * Only extractions the judge is confident about — below this the rows read as
 * stray AI fragments (the legacy queue's rule, kept).
 */
const COMMITMENT_MIN_CONFIDENCE = 0.7;
const COMMITMENT_MAX_VISIBLE = 6;
const COMMITMENT_FETCH_LIMIT = 8;

/** Open commitments: the entry and request the legacy queue uses. */
export function useOpenCommitments(): CommitmentItem[] {
  const query = useQuery({
    queryKey: queryKeys.inbox.commitments(),
    queryFn: async () => {
      try {
        const data = await apiFetch<{ commitments: CommitmentItem[] }>(
          `/api/commitments?status=OPEN&limit=${COMMITMENT_FETCH_LIMIT}`,
        );
        return Array.isArray(data.commitments) ? data.commitments : [];
      } catch (err) {
        captureClientError(err, { scope: "assistant.approvals.commitments" });
        throw err;
      }
    },
  });
  return (query.data ?? [])
    .filter((commitment) => commitment.confidence >= COMMITMENT_MIN_CONFIDENCE)
    .slice(0, COMMITMENT_MAX_VISIBLE);
}

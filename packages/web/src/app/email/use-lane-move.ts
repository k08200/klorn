"use client";

/**
 * Optimistic lane move with undo, shared by the mail list and the reader
 * (productization plan §3, P4, KEYBOARD_TRIAGE).
 *
 * A lane move is a reclassification only (`overrideAttentionTier` on the
 * server), never a mailbox action. The UI changes first; the request follows.
 * If the request fails the change is rolled back and the caller is told why
 * (`onError`) — never a silent revert. While the notice is up, `undo` reverses
 * it through POST /api/inbox/firewall/:id/undo, which also restores the
 * learning state the override touched.
 */

import type {
  LaneOverrideByEmailResponse,
  LaneOverrideUndoResponse,
  LiveTier,
} from "@klorn/contract";
import { useCallback, useEffect, useRef, useState } from "react";
import { useToast } from "../../components/toast";
import { apiFetch } from "../../lib/api";
import { useT } from "../../lib/i18n";
import { captureClientError } from "../../lib/sentry";
import { serverErrorMessage } from "../../lib/server-error";

/** How long the undo notice stays up (plan §3: "6s undo toast"). */
export const UNDO_NOTICE_SECONDS = 6;

export interface LaneMoveTarget {
  id: string;
  subject: string | null;
  /** The lane shown before the move; what a rollback or undo puts back. */
  tier: LiveTier | null;
}

export interface LaneMoveNotice {
  emailId: string;
  subject: string | null;
  tier: LiveTier;
  previousTier: LiveTier | null;
}

/**
 * The API's refusal codes map to localized copy; anything else falls back to
 * the server's own sentence, then to a fixed string.
 */
const REFUSAL_KEYS: Record<string, string> = {
  not_found: "undo.lane.notClassified",
  undo_expired: "undo.lane.expired",
  undo_conflict: "undo.lane.conflict",
};

function refusalMessage(err: unknown, t: (key: string) => string, fallbackKey: string): string {
  const code =
    err instanceof Error
      ? /"code":"(not_found|undo_expired|undo_conflict)"/.exec(err.message)
      : null;
  return code ? t(REFUSAL_KEYS[code[1]]) : serverErrorMessage(err, t(fallbackKey));
}

interface UndoHandle {
  itemId: string;
  undoToken: string | null;
}

interface UseLaneMoveOptions {
  /** Show `tier` on the mail `emailId` now (optimistic write, rollback, undo). */
  apply: (emailId: string, tier: LiveTier | null) => void;
  /** A failure the user must see inline. */
  onError: (message: string) => void;
  /** The server state changed; refetch whatever shows lanes. */
  onSettled?: () => void;
}

export function useLaneMove({ apply, onError, onSettled }: UseLaneMoveOptions) {
  const { t } = useT();
  const { toast } = useToast();
  const [notice, setNotice] = useState<LaneMoveNotice | null>(null);
  const [countdown, setCountdown] = useState(0);
  const [busy, setBusy] = useState(false);
  // The in-flight (or settled) request of the current notice. `undo` awaits it,
  // so pressing z before the server answered still undoes the right override.
  const pending = useRef<{ notice: LaneMoveNotice; handle: Promise<UndoHandle | null> } | null>(
    null,
  );

  useEffect(() => {
    if (!notice) return;
    setCountdown(UNDO_NOTICE_SECONDS);
    const timer = setInterval(() => {
      setCountdown((prev) => {
        if (prev > 1) return prev - 1;
        clearInterval(timer);
        setNotice((current) => (current === notice ? null : current));
        return 0;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [notice]);

  const move = useCallback(
    (target: LaneMoveTarget, tier: LiveTier) => {
      const next: LaneMoveNotice = {
        emailId: target.id,
        subject: target.subject,
        tier,
        previousTier: target.tier,
      };
      apply(target.id, tier);
      setNotice(next);
      const handle = apiFetch<LaneOverrideByEmailResponse>(
        `/api/inbox/firewall/email/${encodeURIComponent(target.id)}`,
        { method: "POST", body: JSON.stringify({ tier }) },
      )
        .then((res): UndoHandle => ({ itemId: res.itemId, undoToken: res.undoToken ?? null }))
        .catch((err) => {
          captureClientError(err, { scope: "email.lane.move", emailId: target.id, tier });
          apply(target.id, target.tier);
          setNotice((current) => (current === next ? null : current));
          onError(refusalMessage(err, t, "undo.lane.moveFailed"));
          return null;
        })
        .finally(() => onSettled?.());
      pending.current = { notice: next, handle };
    },
    [apply, onError, onSettled, t],
  );

  const undo = useCallback(async () => {
    const current = pending.current;
    if (!notice || !current || current.notice !== notice || busy) return;
    setBusy(true);
    apply(notice.emailId, notice.previousTier);
    try {
      const handle = await current.handle;
      // The move itself failed: it was already rolled back and reported.
      if (!handle) return;
      if (!handle.undoToken) throw new Error("undo unavailable");
      await apiFetch<LaneOverrideUndoResponse>(
        `/api/inbox/firewall/${encodeURIComponent(handle.itemId)}/undo`,
        { method: "POST", body: JSON.stringify({ undoToken: handle.undoToken }) },
      );
      toast(t("undo.lane.restored"), "success");
    } catch (err) {
      captureClientError(err, { scope: "email.lane.undo", emailId: notice.emailId });
      // The undo did not happen: show the lane the server still holds.
      apply(notice.emailId, notice.tier);
      onError(refusalMessage(err, t, "undo.lane.undoFailed"));
    } finally {
      setNotice((shown) => (shown === notice ? null : shown));
      setBusy(false);
      onSettled?.();
    }
  }, [apply, busy, notice, onError, onSettled, t, toast]);

  const dismiss = useCallback(() => setNotice(null), []);

  return { notice, countdown, busy, move, undo, dismiss };
}

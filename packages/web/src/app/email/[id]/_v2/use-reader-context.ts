"use client";

/**
 * Mail v2 reader context (productization plan §1, P5b, MAIL_V2): what the
 * reader header shows beyond the mail itself — the lane and why, the account,
 * the sender facts that left the list row — and the previous / next mail in
 * the list view the reader was opened from (lane, account, filter, search), so
 * "next" walks the rows the list shows. One request per mail; disabled, and
 * therefore silent, while the flag is off.
 */

import type { EmailReaderContextResponse, InboxesResponse, LiveTier } from "@klorn/contract";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "../../../../lib/api";
import { queryKeys } from "../../../../lib/query-keys";
import { captureClientError } from "../../../../lib/sentry";
import {
  type AccountOption,
  accountOptions,
  type ListView,
  readerContextPath,
  rowAccount,
} from "../../_v2/model";
import { loadListContext, NO_LIST_CONTEXT, saveLastRead } from "../../_v2/reader-handoff";

const INBOXES_STALE_MS = 5 * 60 * 1000;

/** Under `queryKeys.email.all`: a lane move's refresh re-reads the context too. */
const contextKey = (emailId: string, view: ListView) =>
  [...queryKeys.email.all, "v2", "reader-context", emailId, view] as const;

export function useReaderContext(emailId: string | undefined, enabled: boolean) {
  const queryClient = useQueryClient();
  // Read once: the view the reader was opened from stays its view while the
  // user walks through it. Safe in an initializer because the reader renders
  // behind AuthGuard, client-side.
  const [view] = useState<ListView>(() => (enabled ? loadListContext() : NO_LIST_CONTEXT));
  const active = enabled && Boolean(emailId);
  const key = useMemo(() => contextKey(emailId ?? "", view), [emailId, view]);

  const query = useQuery({
    queryKey: key,
    enabled: active,
    queryFn: async () => {
      try {
        return await apiFetch<EmailReaderContextResponse>(readerContextPath(emailId ?? "", view));
      } catch (err) {
        captureClientError(err, { scope: "email.v2.readerContext", id: emailId });
        throw err;
      }
    },
  });

  const inboxes = useQuery({
    queryKey: queryKeys.email.inboxes(),
    queryFn: () => apiFetch<InboxesResponse>("/api/email/inboxes"),
    staleTime: INBOXES_STALE_MS,
    enabled,
  });
  const accounts: AccountOption[] = useMemo(
    () => accountOptions(inboxes.data?.inboxes ?? []),
    [inboxes.data],
  );

  // The list returns to the mail the reader was last on.
  useEffect(() => {
    if (active && emailId) saveLastRead(emailId);
  }, [active, emailId]);

  /** Optimistic lane (move, rollback, undo) for the mail on screen. */
  const applyLane = useCallback(
    (targetId: string, tier: LiveTier | null) => {
      if (targetId !== emailId) return;
      void queryClient.cancelQueries({ queryKey: key }, { revert: false });
      queryClient.setQueryData<EmailReaderContextResponse>(key, (prev) =>
        prev ? { ...prev, tier } : prev,
      );
    },
    [queryClient, key, emailId],
  );

  const context = query.data ?? null;
  return {
    view,
    context,
    /** The context has not answered yet: the lane is unknown, not "unsorted". */
    pending: active && query.isPending,
    account: context ? rowAccount(context, accounts) : null,
    applyLane,
  };
}

export type ReaderContext = ReturnType<typeof useReaderContext>;

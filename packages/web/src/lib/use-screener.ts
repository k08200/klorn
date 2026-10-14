"use client";

/**
 * The first-contact screener's data: who is waiting for a ruling, and the
 * ruling itself. Shared by the legacy ScreenerCard and the Assistant hub's
 * Approvals page, so both read one cache entry and decide through one
 * mutation. The three server properties ScreenerCard documents (nothing is
 * held, the flag is server-side, the write never fails open) live here.
 */

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useToast } from "../components/toast";
import { apiFetch } from "./api";
import { useT } from "./i18n";
import { queryKeys } from "./query-keys";
import { captureClientError } from "./sentry";

export interface PendingSender {
  sender: string;
  messageCount: number;
  lastReceivedAt: string | null;
}

export type ScreenerVerdict = "ALLOW" | "BLOCK";

export function useScreener() {
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  // Per-sender, not a single flag: ruling on one row must not disable the rest.
  const [deciding, setDeciding] = useState<Record<string, ScreenerVerdict>>({});

  // null = the surface is unavailable (flag off server-side) → render nothing.
  // Any other failure resolves to an empty list, which also renders nothing:
  // a first-contact prompt is an optional convenience, and an error box in its
  // place would cost more attention than the feature saves.
  const { data: pending } = useQuery({
    queryKey: queryKeys.screener.pending(),
    queryFn: async (): Promise<PendingSender[] | null> => {
      try {
        const res = await apiFetch<{ pending: PendingSender[] }>("/api/screener/pending");
        return res.pending ?? [];
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("API 404")) return null;
        captureClientError(err, { scope: "screener.pending" });
        return [];
      }
    },
  });

  const decide = useMutation({
    mutationFn: ({ sender, verdict }: { sender: string; verdict: ScreenerVerdict }) =>
      apiFetch<{ ok: true }>("/api/screener/decision", {
        method: "POST",
        body: JSON.stringify({ sender, verdict }),
      }),
    onMutate: ({ sender, verdict }) => {
      setDeciding((prev) => ({ ...prev, [sender]: verdict }));
    },
    onSuccess: (_data, { sender, verdict }) => {
      // Drop just this row rather than refetching: the server list is windowed
      // and re-derived per call, so a refetch here would reshuffle rows the
      // user is still reading through.
      queryClient.setQueryData<PendingSender[] | null>(queryKeys.screener.pending(), (prev) =>
        prev ? prev.filter((p) => p.sender !== sender) : prev,
      );
      toast(
        verdict === "ALLOW" ? t("screener.allowed", { sender }) : t("screener.blocked", { sender }),
        "success",
      );
    },
    onError: (err) => {
      captureClientError(err, { scope: "screener.decision" });
      toast(t("screener.failed"), "error");
    },
    onSettled: (_d, _e, { sender }) => {
      setDeciding((prev) => {
        const next = { ...prev };
        delete next[sender];
        return next;
      });
    },
  });

  return {
    /** null while loading or when the surface is off server-side. */
    pending: pending ?? null,
    deciding,
    decide: (sender: string, verdict: ScreenerVerdict) => decide.mutate({ sender, verdict }),
  };
}

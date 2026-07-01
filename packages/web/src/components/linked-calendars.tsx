"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { apiFetch, startLinkCalendar } from "../lib/api";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";
import { useToast } from "./toast";

interface LinkedAccount {
  id: string;
  email: string;
  createdAt: string;
}

/**
 * "Connected calendars" — link a SECONDARY Google account (e.g. work) so
 * conflict checks cover a calendar that lives on a different account. The
 * primary account still owns mail; the linked account is calendar-only
 * (calendar.readonly). Must render inside a <Suspense> (uses useSearchParams).
 */
export function LinkedCalendars() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  const { data: accounts = [] } = useQuery({
    queryKey: queryKeys.calendar.linkedAccounts(),
    queryFn: async () => {
      try {
        const res = await apiFetch<{ accounts: LinkedAccount[] }>(
          "/api/auth/google/linked-calendars",
        );
        return res.accounts ?? [];
      } catch {
        // 403 (not entitled) or not connected — show the connect prompt, no list.
        return [] as LinkedAccount[];
      }
    },
  });

  // Toast the OAuth redirect result (?linked=success|failed|unverified) once,
  // then strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const linked = searchParams.get("linked");
    if (!linked) return;
    if (linked === "success") {
      toast("Work calendar connected.", "success");
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.linkedAccounts() });
    } else if (linked === "unverified") {
      toast("That Google account's email isn't verified — couldn't link it.", "error");
    } else {
      toast("Couldn't connect that calendar. Try again.", "error");
    }
    router.replace("/calendar");
  }, [searchParams, toast, queryClient, router]);

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/google/linked-calendars/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.linkedAccounts() });
      toast("Calendar disconnected.", "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "calendar.linked.disconnect" });
      toast("Couldn't disconnect. Try again.", "error");
    },
  });

  const connect = async () => {
    try {
      await startLinkCalendar();
    } catch (err) {
      captureClientError(err, { scope: "calendar.linked.connect" });
      toast("Connecting another calendar needs a Pro subscription.", "error");
    }
  };

  return (
    <section className="rounded-lg border border-stone-700/45 bg-stone-950/55 p-4 text-stone-300">
      <h3 className="text-sm font-medium text-stone-100">Connected calendars</h3>
      <p className="mt-1 text-xs text-stone-400">
        Add a work Google account so conflict checks cover a calendar that lives on a different
        account.
      </p>

      {accounts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between rounded-md border border-stone-800 bg-black/20 px-3 py-2 text-sm"
            >
              <span className="truncate text-stone-200">{account.email}</span>
              <button
                type="button"
                onClick={() => disconnect.mutate(account.id)}
                disabled={disconnect.isPending}
                className="ml-3 shrink-0 rounded-md border border-stone-700 px-2 py-1 text-xs text-stone-400 transition hover:bg-stone-800 disabled:opacity-50"
              >
                Disconnect
              </button>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => void connect()}
        className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200"
      >
        Connect work calendar
      </button>
    </section>
  );
}

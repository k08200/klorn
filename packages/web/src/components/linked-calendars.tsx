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
  // true once this calendar's token was found revoked/undecryptable — the user
  // must re-link to resume free/busy (server clears it on a refresh/re-link).
  needsReconnect: boolean;
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

  // useMutation (not a bare async fn) so isPending disables the buttons — a
  // double-click would otherwise start two OAuth flows before the redirect.
  const connect = useMutation({
    mutationFn: () => startLinkCalendar(),
    onError: (err) => {
      captureClientError(err, { scope: "calendar.linked.connect" });
      toast("Connecting another calendar needs a Pro subscription.", "error");
    },
  });

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4 text-slate-600">
      <h3 className="text-sm font-medium text-slate-900">Connected calendars</h3>
      <p className="mt-1 text-xs text-slate-500">
        Add a work Google account so conflict checks cover a calendar that lives on a different
        account.
      </p>

      {accounts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <span className="block truncate text-slate-900">{account.email}</span>
                {account.needsReconnect && (
                  <span className="block truncate text-[11px] text-amber-600">
                    Reconnect needed — access was revoked
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {account.needsReconnect && (
                  <button
                    type="button"
                    onClick={() => connect.mutate()}
                    disabled={connect.isPending}
                    className="rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-xs text-amber-700 transition hover:bg-amber-400/20 disabled:opacity-50"
                  >
                    Reconnect
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => disconnect.mutate(account.id)}
                  disabled={disconnect.isPending}
                  className="rounded-md border border-slate-200 px-2 py-1 text-xs text-slate-500 transition hover:bg-slate-100 disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => connect.mutate()}
        disabled={connect.isPending}
        className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-sky-500 px-4 py-2 text-sm text-white transition hover:bg-sky-500 disabled:opacity-50"
      >
        Connect work calendar
      </button>
    </section>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { apiFetch, startLinkCalendar } from "../lib/api";
import { useT } from "../lib/i18n";
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
  const { t } = useT();
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
      toast(t("linkedCalendars.toast.connected"), "success");
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.linkedAccounts() });
    } else if (linked === "unverified") {
      toast(t("linkedAccounts.toast.unverified"), "error");
    } else {
      toast(t("linkedCalendars.toast.connectFailed"), "error");
    }
    router.replace("/calendar");
  }, [searchParams, toast, queryClient, router, t]);

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/google/linked-calendars/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.calendar.linkedAccounts() });
      toast(t("linkedCalendars.toast.disconnected"), "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "calendar.linked.disconnect" });
      toast(t("linkedAccounts.toast.disconnectFailed"), "error");
    },
  });

  // useMutation (not a bare async fn) so isPending disables the buttons — a
  // double-click would otherwise start two OAuth flows before the redirect.
  const connect = useMutation({
    mutationFn: () => startLinkCalendar(),
    onError: (err) => {
      captureClientError(err, { scope: "calendar.linked.connect" });
      toast(t("linkedCalendars.toast.needsPro"), "error");
    },
  });

  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-4 text-ink-muted">
      <h3 className="text-sm font-medium text-ink">{t("linkedCalendars.title")}</h3>
      <p className="mt-1 text-xs text-ink-mid">{t("linkedCalendars.body")}</p>

      {accounts.length > 0 && (
        <ul className="mt-3 divide-y divide-line-soft rounded-xl border border-line-soft bg-surface-raised/70">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <span className="block truncate text-ink">{account.email}</span>
                {account.needsReconnect && (
                  <span className="block truncate text-[11px] text-state-warn-ink">
                    {t("linkedAccounts.reconnectNeeded")}
                  </span>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {account.needsReconnect && (
                  <button
                    type="button"
                    onClick={() => connect.mutate()}
                    disabled={connect.isPending}
                    className="ease-strong rounded-md border border-state-warn-line bg-state-warn-bg px-2 py-1 text-xs font-medium text-state-warn-ink transition duration-150 hover:bg-amber-100 active:scale-[0.97] disabled:opacity-50"
                  >
                    {t("common.reconnect")}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => disconnect.mutate(account.id)}
                  disabled={disconnect.isPending}
                  className="ease-strong rounded-md border border-state-danger-line bg-state-danger-bg px-2 py-1 text-xs font-medium text-state-danger-ink transition duration-150 hover:bg-state-danger-bg active:scale-[0.97] disabled:opacity-50"
                >
                  {t("settings.disconnect")}
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
        className="glow-primary ease-strong mt-3 inline-flex min-h-10 items-center rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-50"
      >
        {t("linkedCalendars.connect")}
      </button>
    </section>
  );
}

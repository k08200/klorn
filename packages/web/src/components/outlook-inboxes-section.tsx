"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { TIER_COUNT } from "@/lib/tiers";
import { apiFetch, startLinkOutlookInbox } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";
import { isEntitlementRefusal, MailAccountProGate } from "./mail-account-pro-gate";
import { useToast } from "./toast";

interface OutlookAccount {
  id: string;
  email: string;
  createdAt: string;
  lastSyncedAt: string | null;
  needsReconnect: boolean;
}

// Same compact "synced 5m ago" as linked-inboxes-section (kept local — both
// sections stay self-contained by design).
function formatLastSynced(iso: string | null): string {
  if (!iso) return "Not yet synced";
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "Not yet synced";
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return "Synced just now";
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `Synced ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `Synced ${days}d ago`;
}

/**
 * "Outlook inboxes" — link an Outlook / Microsoft account as a full inbox
 * (Phase 3D of the multi-provider plan). Mirrors LinkedInboxesSection.
 *
 * OUTLOOK_INBOX_ENABLED is server-side: while it's off every
 * /api/auth/outlook route answers 404 and this section renders nothing —
 * the same dark pattern as the iCloud section. Must render inside a
 * <Suspense> (uses useSearchParams).
 *
 * The OAuth redirect lands on /settings?inbox=… which the GOOGLE section
 * already toasts and strips (its markers are generic). This section only
 * refreshes its own list on `success` — never toasts or strips, so the two
 * effects can't race.
 */
export function OutlookInboxesSection() {
  const { user } = useAuth();
  // Fallback only, for an API that does not answer canConnect yet.
  const entitled = user?.entitled !== false;
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();

  // null = surface unavailable (flag off server-side) → render nothing.
  // canConnect: may a NEW mail account be connected now (the first one is
  // free whatever the provider, a second one Pro; always true while the
  // paywall is off).
  const { data: listing } = useQuery({
    queryKey: queryKeys.inbox.outlookAccounts(),
    queryFn: async (): Promise<{ accounts: OutlookAccount[]; canConnect: boolean } | null> => {
      try {
        const res = await apiFetch<{ accounts: OutlookAccount[]; canConnect?: boolean }>(
          "/api/auth/outlook/linked-inboxes",
        );
        return { accounts: res.accounts ?? [], canConnect: res.canConnect ?? entitled };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.startsWith("API 404")) return null;
        // Transient failure — show the connect prompt; the server still gates it.
        return { accounts: [], canConnect: entitled };
      }
    },
  });

  useEffect(() => {
    if (searchParams.get("inbox") === "success") {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.outlookAccounts() });
    }
  }, [searchParams, queryClient]);

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/outlook/linked-inboxes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.outlookAccounts() });
      toast(t("linkedInboxes.toast.disconnected"), "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "inbox.outlook.disconnect" });
      toast(t("linkedAccounts.toast.disconnectFailed"), "error");
    },
  });

  // useMutation so isPending disables the button — a double-click would
  // otherwise start two OAuth flows before the redirect.
  const connect = useMutation({
    mutationFn: () => startLinkOutlookInbox(),
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "";
      if (isEntitlementRefusal(msg)) {
        toast(t("mailAccount.proGate.title"), "error");
        return;
      }
      captureClientError(err, { scope: "inbox.outlook.connect" });
      toast(
        msg.startsWith("API 503")
          ? t("outlookInboxes.toast.notConfigured")
          : t("outlookInboxes.toast.signInFailed"),
        "error",
      );
    },
  });

  if (listing === null || listing === undefined) return null;
  const { accounts, canConnect } = listing;

  return (
    <section className="panel-elevated mb-8 rounded-2xl border border-line/70 bg-surface-panel p-5">
      <h2 className="text-base font-semibold text-ink">{t("outlookInboxes.title")}</h2>
      <p className="mt-1 text-xs text-ink-mid">
        {t("outlookInboxes.body", { count: String(TIER_COUNT) })}
      </p>

      {accounts.length > 0 && (
        <ul className="mt-3 divide-y divide-line-soft rounded-xl border border-line-soft bg-surface-raised/70">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-3 px-3 py-2.5 text-sm"
            >
              <div className="min-w-0">
                <span className="block truncate text-ink">{account.email}</span>
                {account.needsReconnect ? (
                  <span className="block truncate text-[11px] text-state-warn-ink">
                    {t("linkedAccounts.reconnectNeeded")}
                  </span>
                ) : (
                  <span className="block truncate text-[11px] text-ink-dim">
                    {formatLastSynced(account.lastSyncedAt)}
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

      {canConnect ? (
        <button
          type="button"
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          className="glow-primary ease-strong mt-3 inline-flex min-h-10 items-center rounded-lg bg-accent-solid px-4 py-2 text-sm font-medium text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:opacity-50"
        >
          {t("outlookInboxes.connect")}
        </button>
      ) : (
        <div className="mt-3">
          <MailAccountProGate />
        </div>
      )}
    </section>
  );
}

"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { TIER_COUNT } from "@/lib/tiers";
import { apiFetch, startLinkInbox } from "../lib/api";
import { useAuth } from "../lib/auth";
import { useT } from "../lib/i18n";
import { pendingConnect } from "../lib/onboarding-return";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";
import { isEntitlementRefusal, MailAccountProGate } from "./mail-account-pro-gate";
import { useToast } from "./toast";

interface LinkedAccount {
  id: string;
  email: string;
  createdAt: string;
  // null until the first sync tick after MULTI_INBOX_SYNC_ENABLED flips.
  lastSyncedAt: string | null;
  // true once this inbox's token was found revoked/undecryptable — the user must
  // re-link to resume syncing (server clears it on a successful refresh/re-link).
  needsReconnect: boolean;
}

// Compact "synced 5m ago" / "Not yet synced" for the connected-inbox rows.
// Self-contained so this section doesn't depend on the firewall board's private
// relativeTime helper.
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
 * "Connected inboxes" — link another Google account (e.g. work Gmail) as a
 * full inbox so the firewall classifies its mail too. The first mail account
 * is free whatever the provider, a second one is Pro: the server's canConnect
 * decides between the connect button and the Pro note. Must render inside a
 * <Suspense> (uses useSearchParams).
 */
export function LinkedInboxesSection() {
  const { user } = useAuth();
  // Fallback only, for an API that does not answer canConnect yet.
  const entitled = user?.entitled !== false;
  const { t } = useT();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  // canConnect: may a NEW mail account be connected now (always true while
  // the paywall is off).
  const { data: listing } = useQuery({
    queryKey: queryKeys.inbox.linkedAccounts(),
    queryFn: async (): Promise<{ accounts: LinkedAccount[]; canConnect: boolean }> => {
      try {
        const res = await apiFetch<{ accounts: LinkedAccount[]; canConnect?: boolean }>(
          "/api/auth/google/linked-inboxes",
        );
        return { accounts: res.accounts ?? [], canConnect: res.canConnect ?? entitled };
      } catch {
        // Transient failure — show the connect prompt; the server still gates it.
        return { accounts: [], canConnect: entitled };
      }
    },
  });
  const accounts = listing?.accounts ?? [];
  const canConnect = listing?.canConnect ?? entitled;

  // Toast the OAuth redirect result (?inbox=success|failed|unverified) once,
  // then strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const linked = searchParams.get("inbox");
    if (!linked) return;
    // The first run started this connect (ONBOARDING_V2): it reports the
    // result itself and OnboardingReturn is taking the visitor back there, so
    // this section must not toast or route to Settings underneath it.
    if (pendingConnect()) return;
    if (linked === "success") {
      toast(t("linkedInboxes.toast.connected"), "success");
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.linkedAccounts() });
    } else if (linked === "unverified") {
      toast(t("linkedAccounts.toast.unverified"), "error");
    } else if (linked === "self") {
      toast(t("linkedInboxes.toast.self"), "error");
    } else if (linked === "pro") {
      toast(t("mailAccount.proGate.title"), "error");
    } else {
      toast(t("linkedInboxes.toast.connectFailed"), "error");
    }
    router.replace("/settings/accounts");
  }, [searchParams, toast, queryClient, router, t]);

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/google/linked-inboxes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.linkedAccounts() });
      toast(t("linkedInboxes.toast.disconnected"), "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "inbox.linked.disconnect" });
      toast(t("linkedAccounts.toast.disconnectFailed"), "error");
    },
  });

  // useMutation (not a bare async fn) so isPending disables the buttons — a
  // double-click would otherwise start two OAuth flows before the redirect.
  const connect = useMutation({
    mutationFn: () => startLinkInbox(),
    onError: (err) => {
      const msg = err instanceof Error ? err.message : "";
      if (isEntitlementRefusal(msg)) {
        toast(t("mailAccount.proGate.title"), "error");
        return;
      }
      captureClientError(err, { scope: "inbox.linked.connect" });
      toast(t("linkedInboxes.toast.signInFailed"), "error");
    },
  });

  return (
    <section className="panel-elevated rounded-2xl border border-line/70 bg-surface-panel p-5">
      <h2 className="text-base font-semibold text-ink">{t("linkedInboxes.title")}</h2>
      <p className="mt-1 text-xs text-ink-mid">
        {t("linkedInboxes.body", { count: String(TIER_COUNT) })}
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
          {t("linkedInboxes.connect")}
        </button>
      ) : (
        <div className="mt-3">
          <MailAccountProGate />
        </div>
      )}
    </section>
  );
}

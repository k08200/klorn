"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import { apiFetch, startLinkInbox } from "../lib/api";
import { useAuth } from "../lib/auth";
import { queryKeys } from "../lib/query-keys";
import { captureClientError } from "../lib/sentry";
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
 * "Connected inboxes" — link a SECONDARY Google account (e.g. work Gmail) as a
 * full inbox so the firewall classifies its mail too. Pro feature: for a
 * non-entitled user we show the upsell instead of the connect button. Must
 * render inside a <Suspense> (uses useSearchParams).
 */
export function LinkedInboxesSection() {
  const { user } = useAuth();
  // `entitled` is server-computed and always true while the paywall is off, so
  // this gate is inert pre-launch.
  const entitled = user?.entitled !== false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const searchParams = useSearchParams();
  const router = useRouter();

  const { data: accounts = [] } = useQuery({
    queryKey: queryKeys.inbox.linkedAccounts(),
    queryFn: async () => {
      try {
        const res = await apiFetch<{ accounts: LinkedAccount[] }>(
          "/api/auth/google/linked-inboxes",
        );
        return res.accounts ?? [];
      } catch {
        // 403 (not entitled) or not connected — show the connect prompt, no list.
        return [] as LinkedAccount[];
      }
    },
  });

  // Toast the OAuth redirect result (?inbox=success|failed|unverified) once,
  // then strip the param so a refresh doesn't re-toast.
  useEffect(() => {
    const linked = searchParams.get("inbox");
    if (!linked) return;
    if (linked === "success") {
      toast("Inbox connected. Klorn will start classifying its mail.", "success");
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.linkedAccounts() });
    } else if (linked === "unverified") {
      toast("That Google account's email isn't verified — couldn't link it.", "error");
    } else {
      toast("Couldn't connect that inbox. Try again.", "error");
    }
    router.replace("/settings");
  }, [searchParams, toast, queryClient, router]);

  const disconnect = useMutation({
    mutationFn: (id: string) =>
      apiFetch(`/api/auth/google/linked-inboxes/${id}`, { method: "DELETE" }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.inbox.linkedAccounts() });
      toast("Inbox disconnected.", "success");
    },
    onError: (err) => {
      captureClientError(err, { scope: "inbox.linked.disconnect" });
      toast("Couldn't disconnect. Try again.", "error");
    },
  });

  // useMutation (not a bare async fn) so isPending disables the buttons — a
  // double-click would otherwise start two OAuth flows before the redirect.
  const connect = useMutation({
    mutationFn: () => startLinkInbox(),
    onError: (err) => {
      captureClientError(err, { scope: "inbox.linked.connect" });
      toast("Connecting another inbox needs a Pro subscription.", "error");
    },
  });

  return (
    <section className="rounded-xl border border-stone-800 bg-stone-950/40 p-5">
      <h2 className="text-base font-semibold text-stone-100">Connected inboxes</h2>
      <p className="mt-1 text-xs text-stone-400">
        Add a second Google account (e.g. work) so Klorn runs the same 4-tier firewall across all
        your mail, not just your primary account.
      </p>

      {accounts.length > 0 && (
        <ul className="mt-3 space-y-2">
          {accounts.map((account) => (
            <li
              key={account.id}
              className="flex items-center justify-between gap-3 rounded-md border border-stone-800 bg-black/20 px-3 py-2 text-sm"
            >
              <div className="min-w-0">
                <span className="block truncate text-stone-200">{account.email}</span>
                {account.needsReconnect ? (
                  <span className="block truncate text-[11px] text-amber-400">
                    Reconnect needed — access was revoked
                  </span>
                ) : (
                  <span className="block truncate text-[11px] text-stone-500">
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
                    className="rounded-md border border-amber-400/50 bg-amber-400/10 px-2 py-1 text-xs text-amber-200 transition hover:bg-amber-400/20 disabled:opacity-50"
                  >
                    Reconnect
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => disconnect.mutate(account.id)}
                  disabled={disconnect.isPending}
                  className="rounded-md border border-stone-700 px-2 py-1 text-xs text-stone-400 transition hover:bg-stone-800 disabled:opacity-50"
                >
                  Disconnect
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {entitled ? (
        <button
          type="button"
          onClick={() => connect.mutate()}
          disabled={connect.isPending}
          className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200 disabled:opacity-50"
        >
          Connect another inbox
        </button>
      ) : (
        <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 p-4">
          <p className="text-sm text-stone-200">
            Multiple inboxes is a <span className="font-semibold text-amber-300">Pro</span> feature.
          </p>
          <p className="mt-1 text-xs text-stone-400">
            Free covers your primary Google account. Upgrade in the Subscription section to run the
            firewall across a second inbox.
          </p>
        </div>
      )}
    </section>
  );
}

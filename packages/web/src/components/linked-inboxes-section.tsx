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

  const connect = async () => {
    try {
      await startLinkInbox();
    } catch (err) {
      captureClientError(err, { scope: "inbox.linked.connect" });
      toast("Connecting another inbox needs a Pro subscription.", "error");
    }
  };

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

      {entitled ? (
        <button
          type="button"
          onClick={() => void connect()}
          className="mt-3 inline-flex min-h-10 items-center rounded-lg bg-amber-300 px-4 py-2 text-sm text-stone-950 transition hover:bg-amber-200"
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

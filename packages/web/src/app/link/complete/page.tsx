"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AuthStatus from "../../../components/auth/auth-status";
import { API_BASE, getStoredAuthToken } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import {
  type LinkCompleteOutcome,
  linkCompleteOutcome,
  readLinkHandle,
} from "../../../lib/link-complete";

/**
 * Where an account-link OAuth flow lands (Google connect/calendar/inbox,
 * Outlook inbox/calendar). The API parked the authorization code and put a
 * single-use handle in the fragment (`#h=…`, never sent to a server). This page
 * redeems it with THIS browser's session: the API finishes the link only when
 * that session belongs to the user who started the flow.
 */

type MessageKey =
  | "linkComplete.signIn"
  | "linkComplete.mismatch"
  | "linkComplete.expired"
  | "linkComplete.failed";

interface Action {
  readonly href: string;
  readonly label: string;
}

type View = { kind: "working" } | { kind: "message"; key: MessageKey; action: Action | null };

const SIGN_IN: Action = { href: "/login", label: "linkComplete.signInAction" };

function message(key: MessageKey, action: Action | null): View {
  return { kind: "message", key, action };
}

/** The message for every outcome that does not navigate. */
function viewFor(outcome: Exclude<LinkCompleteOutcome, { kind: "redirect" }>): View {
  switch (outcome.kind) {
    case "mismatch":
      return message(
        "linkComplete.mismatch",
        outcome.path ? { href: outcome.path, label: "linkComplete.continue" } : null,
      );
    case "signIn":
      return message("linkComplete.signIn", SIGN_IN);
    case "expired":
      return message("linkComplete.expired", null);
    default:
      return message("linkComplete.failed", null);
  }
}

/** Read the handle, then strip the fragment from the address bar and history. */
function takeHandleFromLocation(): string | null {
  const handle = readLinkHandle(window.location.hash);
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
  return handle;
}

async function completeLink(
  handle: string,
  token: string,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(`${API_BASE}/api/auth/link/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ handle }),
  });
  const body: unknown = await res.json().catch(() => null);
  return { status: res.status, body };
}

export default function LinkCompletePage() {
  const router = useRouter();
  const { t } = useT();
  const handled = useRef(false);
  const [view, setView] = useState<View>({ kind: "working" });

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const handle = takeHandleFromLocation();
    if (!handle) {
      setView(message("linkComplete.expired", null));
      return;
    }
    const token = getStoredAuthToken();
    if (!token) {
      setView(message("linkComplete.signIn", SIGN_IN));
      return;
    }
    completeLink(handle, token)
      .then(({ status, body }) => {
        const outcome = linkCompleteOutcome(status, body);
        // Only a relative path that passed safeNextPath ever gets here.
        if (outcome.kind === "redirect") router.replace(outcome.path);
        else setView(viewFor(outcome));
      })
      .catch(() => setView(message("linkComplete.failed", null)));
  }, [router]);

  if (view.kind === "working") return <AuthStatus label={t("linkComplete.working")} />;

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface-panel px-4 text-ink"
    >
      <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
      <p role="status" className="max-w-md text-center text-label text-ink-mid">
        {t(view.key)}
      </p>
      {view.action ? (
        <Link
          href={view.action.href}
          className="inline-flex min-h-11 items-center justify-center rounded-lg bg-accent-solid px-5 text-label font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2"
        >
          {t(view.action.label)}
        </Link>
      ) : null}
    </main>
  );
}

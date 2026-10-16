"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import AuthStatus from "../../../components/auth/auth-status";
import { API_BASE, getStoredAuthToken } from "../../../lib/api";
import { useT } from "../../../lib/i18n";
import {
  browserSessionStorage,
  clearPendingHandle,
  hasPendingHandle,
  LINK_COMPLETE_SIGN_IN_HREF,
  type LinkCompleteOutcome,
  linkCompleteOutcome,
  readLinkHandle,
  storePendingHandle,
  takePendingHandle,
} from "../../../lib/link-complete";

/**
 * Where an account-link OAuth flow lands (Google connect/calendar/inbox,
 * Outlook inbox/calendar). The API parked the authorization code and put a
 * single-use handle in the fragment (`#h=…`, never sent to a server). This page
 * redeems it with THIS browser's session: the API finishes the link only when
 * that session belongs to the user who started the flow.
 *
 * No session here (a native shell opened consent in the system browser): the
 * handle waits in this tab's sessionStorage while the user signs in through the
 * normal web sign-in, which returns here (`/login?next=/link/complete`, or the
 * pending-link check after a social sign-in), and is then redeemed once.
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

const SIGN_IN: Action = {
  href: LINK_COMPLETE_SIGN_IN_HREF,
  label: "linkComplete.signInToContinue",
};

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

/**
 * The handle to redeem now: a fresh one in the fragment wins (and replaces any
 * stored one), else the one kept while this tab signed in. Null when there is
 * no session to redeem it with: the handle is then kept for after sign-in.
 */
function handleToRedeem(token: string | null): { handle: string | null; waiting: boolean } {
  const storage = browserSessionStorage();
  const now = Date.now();
  const fromHash = takeHandleFromLocation();
  if (!token) {
    if (fromHash) storePendingHandle(storage, fromHash, now);
    return { handle: null, waiting: hasPendingHandle(storage, now) };
  }
  if (fromHash) {
    clearPendingHandle(storage);
    return { handle: fromHash, waiting: false };
  }
  return { handle: takePendingHandle(storage, now), waiting: false };
}

export default function LinkCompletePage() {
  const router = useRouter();
  const { t } = useT();
  const handled = useRef(false);
  const [view, setView] = useState<View>({ kind: "working" });

  useEffect(() => {
    if (handled.current) return;
    handled.current = true;

    const token = getStoredAuthToken();
    const { handle, waiting } = handleToRedeem(token);
    if (!handle || !token) {
      setView(
        waiting ? message("linkComplete.signIn", SIGN_IN) : message("linkComplete.expired", null),
      );
      return;
    }
    completeLink(handle, token)
      .then(({ status, body }) => {
        const outcome = linkCompleteOutcome(status, body);
        // Only a relative path that passed safeNextPath ever gets here.
        if (outcome.kind === "redirect") return router.replace(outcome.path);
        // A rejected session never reached the handle: keep it for after sign-in.
        if (outcome.kind === "signIn")
          storePendingHandle(browserSessionStorage(), handle, Date.now());
        setView(viewFor(outcome));
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

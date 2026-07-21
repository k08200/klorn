"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { startGoogleConnect } from "../lib/api";

/**
 * Shows an explicit error card when the OAuth callback came back without a
 * usable refresh_token. Without this, the user previously saw only "Gmail
 * sync failed" with no guidance — a state that's normally caused by Google
 * Workspace policy or an unverified-app + G Suite combination, neither of
 * which the user can self-diagnose from the inbox screen.
 *
 * Must be rendered inside a <Suspense> boundary because it uses useSearchParams.
 */
export function OAuthErrorBanner() {
  const searchParams = useSearchParams();
  const status = searchParams.get("google");
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    setDismissed(false);
  }, [status]);

  if (status !== "offline_access_denied" || dismissed) return null;

  return (
    <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-red-600">
            Gmail offline access wasn't granted
          </h3>
          <p className="mt-1 text-[13px] leading-5 text-slate-500">
            Google returned a short-lived token without the refresh permission Klorn needs to keep
            syncing in the background. This is almost always one of two things:
          </p>
          <ul className="mt-2 space-y-1 text-[13px] leading-5 text-slate-500">
            <li>
              <span className="text-slate-900">Workspace policy</span> — your IT admin restricts
              third-party apps from offline Gmail access. Ask them to allow Klorn's OAuth client ID,
              then reconnect below.
            </li>
            <li>
              <span className="text-slate-900">Missing scope on consent</span> — the Google consent
              screen didn't grant all Gmail permissions. Reconnect and make sure every checkbox is
              selected.
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void startGoogleConnect()}
              className="rounded-lg bg-sky-500 px-3 py-1.5 text-[12px] font-medium text-white transition hover:bg-sky-500"
            >
              Reconnect Google
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-lg border border-slate-200 px-3 py-1.5 text-[12px] text-slate-500 transition hover:text-slate-900"
            >
              Dismiss
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

"use client";

import { useSearchParams } from "next/navigation";
import { useEffect, useState } from "react";
import { startGoogleConnect } from "../lib/api";
import { useT } from "../lib/i18n";
import { MailAccountProGate } from "./mail-account-pro-gate";

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
  const { t } = useT();

  useEffect(() => {
    setDismissed(false);
  }, [status]);

  if (dismissed) return null;
  // ?google=pro: the primary Gmail connect was refused because Gmail would be
  // a second mail account on Free.
  if (status === "pro") {
    return (
      <div className="mb-4">
        <MailAccountProGate />
      </div>
    );
  }
  if (status === "wipe_in_progress") {
    // The data wipe's fence refused the new Google grant; it lifts minutes
    // after the wipe finishes.
    return (
      <div className="mb-4 rounded-xl border border-line-soft bg-surface-raised p-4" role="status">
        <h3 className="text-sm font-semibold text-ink">{t("oauthError.wipeInProgress.title")}</h3>
        <p className="mt-1 text-label font-normal leading-5 text-ink-mid">
          {t("oauthError.wipeInProgress.body")}
        </p>
      </div>
    );
  }
  if (status !== "offline_access_denied") return null;

  return (
    <div className="mb-4 rounded-xl border border-red-500/30 bg-red-500/5 p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-state-danger-ink">{t("oauthError.title")}</h3>
          <p className="mt-1 text-label font-normal leading-5 text-ink-mid">
            {t("oauthError.body")}
          </p>
          <ul className="mt-2 space-y-1 text-label font-normal leading-5 text-ink-mid">
            <li>
              <span className="text-ink">{t("oauthError.policy.title")}</span>{" "}
              {t("oauthError.policy.body")}
            </li>
            <li>
              <span className="text-ink">{t("oauthError.scope.title")}</span>{" "}
              {t("oauthError.scope.body")}
            </li>
          </ul>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => void startGoogleConnect()}
              className="rounded-lg bg-accent-solid px-3 py-1.5 text-caption font-medium text-accent-solid-ink transition hover:bg-accent-solid-hover"
            >
              {t("reconnect.googleAction")}
            </button>
            <button
              type="button"
              onClick={() => setDismissed(true)}
              className="rounded-lg border border-line px-3 py-1.5 text-caption text-ink-mid transition hover:text-ink"
            >
              {t("common.dismiss")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

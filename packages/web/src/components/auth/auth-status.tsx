"use client";

import { useT } from "../../lib/i18n";

/**
 * The in-between state of the sign-in flows (OAuth callback, email-link
 * verification): brand mark, a small spinner, and what is happening. Same
 * canvas as the sign-in shell so the hand-off does not flash a bare page.
 */
export default function AuthStatus({ label }: { label?: string }) {
  const { t } = useT();
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center gap-5 bg-surface-panel px-4 text-ink"
    >
      <img src="/brand/mark.svg?v=matte2" alt="" className="h-9 w-9" />
      <div role="status" aria-live="polite" className="flex items-center gap-2.5">
        <span
          aria-hidden="true"
          className="h-4 w-4 animate-spin rounded-full border-2 border-accent-solid border-t-transparent motion-reduce:animate-none"
        />
        <span className="text-label text-ink-mid">{label ?? t("common.loading")}</span>
      </div>
    </main>
  );
}

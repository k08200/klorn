"use client";

import { PAGE_SHELL } from "../components/page-shell";
import { MailRowSkeleton } from "../components/ui/skeleton";
import { useT } from "../lib/i18n";

/**
 * Route loading state (design detail pass W9): the page's own frame as
 * placeholders, anchored where the loaded page will draw — the same shapes as
 * the session check (auth-guard.tsx), not a centred spinner. The status is
 * spoken once; the shapes are hidden from assistive tech.
 */
export default function Loading() {
  const { t } = useT();
  return (
    <div role="status" aria-live="polite" className={`${PAGE_SHELL} flex flex-col gap-4`}>
      <span className="sr-only">{t("common.loading")}</span>
      <div aria-hidden="true" className="flex flex-col gap-2">
        <div className="h-7 w-40 rounded-control bg-surface-inset motion-safe:animate-pulse" />
        <div className="h-3 w-56 max-w-full rounded-control bg-surface-inset opacity-60 motion-safe:animate-pulse" />
      </div>
      <div
        aria-hidden="true"
        className="mt-10 overflow-hidden rounded-xl bg-surface-panel ring-1 ring-line"
      >
        <MailRowSkeleton />
      </div>
    </div>
  );
}

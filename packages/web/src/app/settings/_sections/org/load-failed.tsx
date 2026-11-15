"use client";

import Button from "../../../../components/ui/button";
import { useT } from "../../../../lib/i18n";

/** A part of the organization page that could not load, with a way to try again. */
export function LoadFailed({ onRetry }: { onRetry: () => void }) {
  const { t } = useT();
  return (
    <p role="alert" className="flex flex-wrap items-center gap-2 text-role-caption text-ink-mid">
      {t("settings.org.loadFailed")}
      <Button variant="link" onClick={onRetry}>
        {t("settings.org.retry")}
      </Button>
    </p>
  );
}

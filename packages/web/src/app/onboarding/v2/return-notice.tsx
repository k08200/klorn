"use client";

/**
 * What happened to the OAuth connect that just came back (productization plan
 * P8). The outcome is one of a fixed set (lib/onboarding-return); each has its
 * own sentence, and only "connected" reads as a success.
 */

import Button from "../../../components/ui/button";
import { useT } from "../../../lib/i18n";
import type { ConnectOutcome, ConnectResult } from "../../../lib/onboarding-return";
import { sourceGlyph } from "../../../lib/source-provider";

const MESSAGE_KEY: ReadonlyMap<ConnectOutcome, string> = new Map([
  ["connected", "onboardingV2.return.connected"],
  ["denied", "onboardingV2.return.denied"],
  ["offline", "onboardingV2.return.offline"],
  ["unverified", "onboardingV2.return.unverified"],
  ["self", "onboardingV2.return.self"],
  ["limit", "onboardingV2.return.limit"],
  ["failed", "onboardingV2.return.failed"],
]);

export function ReturnNotice({
  result,
  onDismiss,
}: {
  result: ConnectResult;
  onDismiss: () => void;
}) {
  const { t } = useT();
  const ok = result.outcome === "connected";
  const provider = sourceGlyph(result.provider).name;
  return (
    <div
      role={ok ? "status" : "alert"}
      data-outcome={result.outcome}
      className={`flex items-start gap-2 rounded-card border py-1 pr-1 pl-4 ${
        ok
          ? "border-state-ok-line bg-state-ok-bg text-state-ok-ink"
          : "border-state-danger-line bg-state-danger-bg text-state-danger-ink"
      }`}
    >
      <p className="min-w-0 flex-1 py-2.5 text-body">
        <span className="font-semibold">
          {t(ok ? "onboardingV2.return.okTitle" : "onboardingV2.return.failTitle", { provider })}
        </span>{" "}
        {t(MESSAGE_KEY.get(result.outcome) ?? "onboardingV2.return.failed")}
      </p>
      <Button
        variant="ghost"
        size="icon"
        aria-label={t("onboardingV2.return.dismiss")}
        onClick={onDismiss}
      >
        <svg
          aria-hidden="true"
          viewBox="0 0 16 16"
          className="size-4"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
        >
          <path d="M4 4l8 8M12 4l-8 8" />
        </svg>
      </Button>
    </div>
  );
}

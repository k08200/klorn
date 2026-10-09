"use client";

/**
 * First run, last step (productization plan P8). Says what is connected and
 * where the user lands, and offers the next account. It starts nothing: no
 * briefing is generated here, so the copy says when one arrives instead of
 * promising one is waiting.
 */

import Button from "../../../components/ui/button";
import { SourceBadge } from "../../../components/ui/source-badge";
import type { ConnectedAccount } from "../../../lib/connected-accounts";
import { useT } from "../../../lib/i18n";
import { sourceGlyph } from "../../../lib/source-provider";

interface FinishStepProps {
  accounts: readonly ConnectedAccount[];
  /** Home is Today (UNIFIED_HOME); otherwise the legacy home. */
  today: boolean;
  onOpen: () => void;
  onAddAccount: () => void;
}

export function FinishStep({ accounts, today, onOpen, onAddAccount }: FinishStepProps) {
  const { t } = useT();
  return (
    <section aria-labelledby="onboarding-finish-title">
      <h1 id="onboarding-finish-title" tabIndex={-1} className="text-display text-ink outline-none">
        {t("onboardingV2.finish.title")}
      </h1>
      <p className="mt-2 max-w-xl text-body text-ink-mid">
        {t(today ? "onboardingV2.finish.bodyToday" : "onboardingV2.finish.bodyLegacy")}
      </p>

      <h2 className="mt-6 text-head text-ink">{t("onboardingV2.finish.accountsTitle")}</h2>
      <ul className="mt-3 divide-y divide-line-soft rounded-card border border-line bg-surface-panel">
        {accounts.map((account) => (
          <li key={account.scope} className="flex items-center gap-2 px-4 py-3">
            <SourceBadge provider={account.provider} />
            <span className="min-w-0 truncate text-label text-ink">
              {account.email ?? sourceGlyph(account.provider).name}
            </span>
          </li>
        ))}
      </ul>

      <p className="mt-4 text-caption text-ink-muted">{t("onboardingV2.finish.briefingNote")}</p>

      <div className="mt-8 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        <Button variant="secondary" size="lg" onClick={onAddAccount}>
          {t("onboardingV2.finish.addAccount")}
        </Button>
        <Button size="lg" onClick={onOpen}>
          {t(today ? "onboardingV2.finish.openToday" : "onboardingV2.finish.openHome")}
        </Button>
      </div>
    </section>
  );
}

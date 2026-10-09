"use client";

/**
 * One provider on the first run's grid (productization plan P8): a neutral
 * monogram (SourceBadge's glyphs, never a brand colour or logo), the provider's
 * name, one honest line of scope, the accounts already connected with their
 * health in words, and at most one button.
 */

import Button from "../../../components/ui/button";
import type { AccountHealth } from "../../../lib/connected-accounts";
import { useT } from "../../../lib/i18n";
import { sourceGlyph } from "../../../lib/source-provider";
import type { ProviderTile, TileAction } from "./model";

const HEALTH_KEY: ReadonlyMap<AccountHealth, string> = new Map([
  ["synced", "onboardingV2.health.connected"],
  ["syncing", "onboardingV2.health.syncing"],
  ["reconnect", "onboardingV2.health.reconnect"],
]);

const HEALTH_INK: ReadonlyMap<AccountHealth, string> = new Map([
  ["synced", "text-state-ok-ink"],
  ["syncing", "text-ink-muted"],
  ["reconnect", "text-state-danger-ink"],
]);

const ACTION_KEY: ReadonlyMap<TileAction, string> = new Map([
  ["connect", "onboardingV2.tile.connect"],
  ["add", "onboardingV2.tile.add"],
  ["reconnect", "onboardingV2.tile.reconnect"],
  ["manage", "onboardingV2.tile.manage"],
]);

interface ProviderTileProps {
  tile: ProviderTile;
  /** This tile's connect is being started (the redirect is on its way). */
  busy: boolean;
  /** Another tile is busy; one connect at a time. */
  disabled: boolean;
  onAction: (tile: ProviderTile) => void;
}

export function ProviderTileCard({ tile, busy, disabled, onAction }: ProviderTileProps) {
  const { t } = useT();
  const { glyph, name } = sourceGlyph(tile.provider);
  const actionKey = ACTION_KEY.get(tile.action);
  const headingId = `onboarding-tile-${tile.provider}`;
  return (
    <li className="flex flex-col gap-3 rounded-card border border-line bg-surface-panel p-4">
      <div className="flex items-start gap-3">
        <span
          aria-hidden="true"
          className="flex size-10 shrink-0 items-center justify-center rounded-control border border-line bg-surface-raised text-label font-semibold tracking-tight text-ink-soft"
        >
          {glyph}
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={headingId} className="text-head text-ink">
            {name}
          </h2>
          <p className="text-body text-ink-mid">{t(tile.scopeKey)}</p>
          {tile.noteKeys.map((key) => (
            <p key={key} className="mt-1 text-caption text-ink-muted">
              {t(key)}
            </p>
          ))}
        </div>
      </div>

      {tile.accounts.length > 0 && (
        <ul
          aria-label={t("onboardingV2.tile.accountsLabel", { provider: name })}
          className="divide-y divide-line-soft rounded-control border border-line-soft bg-surface-raised"
        >
          {tile.accounts.map((account) => (
            <li key={account.scope} className="flex items-center gap-3 px-3 py-2">
              <span className="min-w-0 flex-1 truncate text-label font-normal text-ink">
                {account.email ?? name}
              </span>
              <span
                className={`flex shrink-0 items-center gap-1.5 text-caption ${HEALTH_INK.get(account.health) ?? ""}`}
              >
                <HealthMark health={account.health} />
                {t(HEALTH_KEY.get(account.health) ?? "")}
              </span>
            </li>
          ))}
        </ul>
      )}

      {actionKey && (
        <Button
          variant="secondary"
          className="mt-auto w-full"
          loading={busy}
          disabled={disabled}
          aria-describedby={headingId}
          onClick={() => onAction(tile)}
        >
          {t(actionKey)}
        </Button>
      )}
    </li>
  );
}

/** Shape as well as colour (WCAG 1.4.1): a check, a ring, or a bar. */
function HealthMark({ health }: { health: AccountHealth }) {
  if (health === "synced") {
    return (
      <svg
        aria-hidden="true"
        viewBox="0 0 12 12"
        className="size-3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M2.5 6.5l2.5 2.5 4.5-5.5" />
      </svg>
    );
  }
  if (health === "syncing") {
    return <span aria-hidden="true" className="size-2 rounded-full border-2 border-current" />;
  }
  return <span aria-hidden="true" className="h-0.5 w-2.5 rounded-full bg-current" />;
}

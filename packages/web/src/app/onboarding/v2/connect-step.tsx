"use client";

/**
 * First run, step 1 — "Bring in your accounts" (productization plan P8).
 *
 * The grid shows only what GET /api/providers/available offers. Pressing a
 * tile runs the connect flow Settings already uses, unchanged: the OAuth start
 * helpers for Google and Microsoft, and Settings' own credential forms (in a
 * Sheet) for Naver and iCloud. No credential is handled in this file.
 */

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { ICloudImapSection } from "../../../components/icloud-imap-section";
import { NaverImapSection } from "../../../components/naver-imap-section";
import Button from "../../../components/ui/button";
import { Sheet } from "../../../components/ui/sheet";
import { Skeleton, SkeletonGroup } from "../../../components/ui/skeleton";
import { startGoogleConnect, startLinkInbox, startLinkOutlookInbox } from "../../../lib/api";
import { useAuth } from "../../../lib/auth";
import { useT } from "../../../lib/i18n";
import { isNativeShell } from "../../../lib/native/shell";
import {
  type ConnectResult,
  forgetConnect,
  markConnectStarted,
} from "../../../lib/onboarding-return";
import { queryKeys } from "../../../lib/query-keys";
import { captureClientError } from "../../../lib/sentry";
import type { ConnectedAccountsState } from "../../../lib/use-connected-accounts";
import { hasPrimaryGoogle, type ProviderTile, providerTiles } from "./model";
import { ProviderTileCard } from "./provider-tile";
import { ReturnNotice } from "./return-notice";
import { useProviderAvailability } from "./use-provider-availability";

type FormProvider = "NAVER" | "ICLOUD";

const SHEET_TITLE_KEY: ReadonlyMap<FormProvider, string> = new Map([
  ["NAVER", "onboardingV2.sheet.naver.title"],
  ["ICLOUD", "onboardingV2.sheet.icloud.title"],
]);

const SHEET_BODY_KEY: ReadonlyMap<FormProvider, string> = new Map([
  ["NAVER", "onboardingV2.sheet.naver.body"],
  ["ICLOUD", "onboardingV2.sheet.icloud.body"],
]);

interface ConnectStepProps {
  accounts: ConnectedAccountsState;
  /** The result of an OAuth connect that just came back, if any. */
  returned: ConnectResult | null;
  onDismissReturned: () => void;
  onContinue: () => void;
  onSkip: () => void;
}

export function ConnectStep(props: ConnectStepProps) {
  const { accounts, returned, onDismissReturned, onContinue, onSkip } = props;
  const { t } = useT();
  const { googleNeedsReconnect } = useAuth();
  const queryClient = useQueryClient();
  const availability = useProviderAvailability();
  const [sheet, setSheet] = useState<FormProvider | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  // The start request has answered and the browser is leaving for the
  // provider: the tiles stay inert until this page is shown again (a return
  // through the back/forward cache does not remount it).
  const [leaving, setLeaving] = useState(false);
  useEffect(() => {
    const onShow = () => setLeaving(false);
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const tiles = providerTiles(availability.providers, accounts.accounts);
  const connected = accounts.accounts.length > 0;
  const refreshAccounts = () =>
    void queryClient.invalidateQueries({ queryKey: queryKeys.email.inboxes() });

  // useMutation so a second press cannot start a second OAuth flow before the
  // browser has left for the provider.
  const oauth = useMutation({
    mutationFn: (tile: ProviderTile): Promise<void> => {
      const provider = tile.provider === "OUTLOOK" ? "OUTLOOK" : "GOOGLE";
      // In a native shell the consent screen opens in the system browser and
      // never returns to this view, so there is nothing to come back to.
      if (!isNativeShell()) markConnectStarted(provider);
      if (provider === "OUTLOOK") return startLinkOutlookInbox();
      return hasPrimaryGoogle(accounts.accounts) ? startLinkInbox() : startGoogleConnect();
    },
    onMutate: () => {
      setStartError(null);
      onDismissReturned();
    },
    onSuccess: () => {
      if (!isNativeShell()) setLeaving(true);
    },
    onError: (err, tile) => {
      forgetConnect();
      captureClientError(err, { scope: "onboarding-v2.connect", provider: tile.provider });
      const refused = err instanceof Error && err.message.startsWith("API 403");
      setStartError(t(refused ? "onboardingV2.connect.needsPlan" : "onboardingV2.connect.failed"));
    },
  });

  const onAction = (tile: ProviderTile) => {
    if (tile.kind === "form") {
      setStartError(null);
      setSheet(tile.provider === "ICLOUD" ? "ICLOUD" : "NAVER");
      return;
    }
    oauth.mutate(tile);
  };

  const closeSheet = () => {
    setSheet(null);
    refreshAccounts();
  };

  return (
    <section aria-labelledby="onboarding-connect-title">
      <h1
        id="onboarding-connect-title"
        tabIndex={-1}
        className="text-display text-ink outline-none"
      >
        {t("onboardingV2.connect.title")}
      </h1>
      <p className="mt-2 max-w-xl text-body text-ink-mid">{t("onboardingV2.connect.body")}</p>

      <div className="mt-6 flex flex-col gap-3">
        {googleNeedsReconnect && (
          <p
            role="status"
            className="rounded-card border border-notice-border bg-notice-bg px-4 py-3 text-body text-notice-ink"
          >
            <span className="font-semibold text-notice-ink-strong">
              {t("reconnect.googleExpiredTitle")}
            </span>{" "}
            {t("reconnect.googleExpiredBody")}
          </p>
        )}
        {returned && <ReturnNotice result={returned} onDismiss={onDismissReturned} />}
        {startError && (
          <p
            role="alert"
            className="rounded-card border border-state-danger-line bg-state-danger-bg px-4 py-3 text-body text-state-danger-ink"
          >
            {startError}
          </p>
        )}
      </div>

      <ProviderGrid
        loading={availability.loading || accounts.loading}
        failed={availability.failed || accounts.failed}
        onRetry={() => {
          availability.retry();
          accounts.retry();
        }}
      >
        {tiles.map((tile) => (
          <ProviderTileCard
            key={tile.provider}
            tile={tile}
            busy={(oauth.isPending || leaving) && oauth.variables?.provider === tile.provider}
            disabled={oauth.isPending || leaving}
            onAction={onAction}
          />
        ))}
      </ProviderGrid>

      <p className="mt-4 text-caption text-ink-muted">{t("onboardingV2.connect.lanesNote")}</p>

      <div className="mt-8 flex flex-col-reverse gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Button variant="ghost" onClick={onSkip}>
          {t("onboardingV2.connect.skip")}
        </Button>
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:gap-3">
          {!connected && (
            <p id="onboarding-continue-hint" className="text-caption text-ink-muted">
              {t("onboardingV2.connect.continueHint")}
            </p>
          )}
          <Button
            size="lg"
            disabled={!connected}
            aria-describedby={connected ? undefined : "onboarding-continue-hint"}
            onClick={onContinue}
          >
            {t("onboardingV2.continue")}
          </Button>
        </div>
      </div>

      <Sheet
        open={sheet !== null}
        onClose={closeSheet}
        title={t((sheet && SHEET_TITLE_KEY.get(sheet)) ?? "onboardingV2.sheet.naver.title")}
        description={t((sheet && SHEET_BODY_KEY.get(sheet)) ?? "onboardingV2.sheet.naver.body")}
        closeLabel={t("onboardingV2.sheet.close")}
        footer={
          <Button variant="secondary" onClick={closeSheet}>
            {t("onboardingV2.sheet.done")}
          </Button>
        }
      >
        {sheet === "NAVER" && <NaverImapSection embedded onChanged={refreshAccounts} />}
        {sheet === "ICLOUD" && <ICloudImapSection embedded onChanged={refreshAccounts} />}
      </Sheet>
    </section>
  );
}

interface ProviderGridProps {
  loading: boolean;
  failed: boolean;
  onRetry: () => void;
  children: ReactNode;
}

/** The grid, or what stands in for it: nothing is drawn that the server did not offer. */
function ProviderGrid({ loading, failed, onRetry, children }: ProviderGridProps) {
  const { t } = useT();
  if (loading) {
    return (
      <SkeletonGroup
        label={t("onboardingV2.connect.loading")}
        className="mt-4 grid gap-3 sm:grid-cols-2"
      >
        <Skeleton variant="block" height="h-36" />
        <Skeleton variant="block" height="h-36" />
      </SkeletonGroup>
    );
  }
  if (failed) {
    return (
      <div
        role="alert"
        className="mt-4 flex flex-wrap items-center gap-3 rounded-card border border-line bg-surface-panel px-4 py-3"
      >
        <p className="min-w-0 flex-1 text-body text-ink">{t("onboardingV2.connect.loadError")}</p>
        <Button variant="secondary" size="sm" onClick={onRetry}>
          {t("onboardingV2.retry")}
        </Button>
      </div>
    );
  }
  return <ul className="mt-4 grid gap-3 sm:grid-cols-2">{children}</ul>;
}

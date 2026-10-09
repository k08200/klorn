"use client";

/**
 * First run, step 2 — live sync (productization plan P8). One row per
 * connected account with what the server reports for it, and the lanes filling
 * in as mail is sorted. Nothing here is estimated: there is no progress bar,
 * and where a number is not available the row says "Counting…" or says that
 * there is no count, never a guess.
 */

import type { LiveTier } from "@klorn/contract";
import { useEffect, useState } from "react";
import Button from "../../../components/ui/button";
import { LaneChip } from "../../../components/ui/lane-chip";
import { SourceBadge } from "../../../components/ui/source-badge";
import { useAuth } from "../../../lib/auth";
import type { ConnectedAccount } from "../../../lib/connected-accounts";
import { useT } from "../../../lib/i18n";
import { sourceGlyph } from "../../../lib/source-provider";
import { CORE_TIERS } from "../../../lib/tiers";
import {
  type SyncHeadline,
  type SyncRow,
  type SyncState,
  syncHeadline,
  syncSettled,
} from "./model";
import { type AccountProgress, useSyncProgress } from "./use-sync-progress";

/** After this long the user may go on without waiting (the flow's escape hatch). */
const WAIT_ESCAPE_MS = 15_000;

const TITLE_KEY: ReadonlyMap<SyncHeadline, string> = new Map([
  ["reading", "onboardingV2.sync.title"],
  ["mailIn", "onboardingV2.sync.titleDone"],
  ["status", "onboardingV2.sync.titleStatus"],
]);

const STATE_KEY: ReadonlyMap<SyncState, string> = new Map([
  ["reading", "onboardingV2.sync.state.reading"],
  ["ready", "onboardingV2.sync.state.ready"],
  ["background", "onboardingV2.sync.state.background"],
  ["attention", "onboardingV2.sync.state.attention"],
]);

const STATE_INK: ReadonlyMap<SyncState, string> = new Map([
  ["reading", "text-ink-muted"],
  ["ready", "text-state-ok-ink"],
  ["background", "text-ink-muted"],
  ["attention", "text-state-danger-ink"],
]);

interface SyncStepProps {
  accounts: readonly ConnectedAccount[];
  onContinue: () => void;
  /** An account needs reconnecting: back to the provider grid. */
  onFixAccount: () => void;
}

export function SyncStep({ accounts, onContinue, onFixAccount }: SyncStepProps) {
  const { t, locale } = useT();
  const { retryInitSync } = useAuth();
  const progress = useSyncProgress(accounts);
  const rows = progress.accounts.map((entry) => entry.row);
  const settled = syncSettled(rows);
  const readyCount = rows.filter((row) => row.state !== "reading").length;
  // The body speaks of "the numbers below" only while a number is there or due.
  const counted = rows.some((row) => row.messages !== null || row.state === "reading");

  const [waited, setWaited] = useState(false);
  useEffect(() => {
    if (settled) return;
    const timer = window.setTimeout(() => setWaited(true), WAIT_ESCAPE_MS);
    return () => window.clearTimeout(timer);
  }, [settled]);

  const number = new Intl.NumberFormat(locale);

  return (
    <section aria-labelledby="onboarding-sync-title">
      <h1 id="onboarding-sync-title" tabIndex={-1} className="text-display text-ink outline-none">
        {t(TITLE_KEY.get(syncHeadline(rows)) ?? "onboardingV2.sync.title")}
      </h1>
      <p className="mt-2 max-w-xl text-body text-ink-mid">
        {t(counted ? "onboardingV2.sync.body" : "onboardingV2.sync.bodyNoCounts")}
      </p>

      {/* One spoken summary, updated when a row settles; the numbers
          themselves change too often to announce. */}
      <p role="status" className="sr-only">
        {t("onboardingV2.sync.summary", {
          ready: String(readyCount),
          total: String(rows.length),
        })}
      </p>

      <ul className="mt-6 divide-y divide-line-soft rounded-card border border-line bg-surface-panel">
        {progress.accounts.map((entry) => (
          <AccountRow
            key={entry.account.scope}
            entry={entry}
            format={(value) => number.format(value)}
            onRetry={entry.account.health === "reconnect" ? onFixAccount : retryInitSync}
          />
        ))}
      </ul>

      {progress.lanes && <LaneTotals lanes={progress.lanes} format={(v) => number.format(v)} />}

      <div className="mt-8 flex flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-end sm:gap-3">
        {!settled && !waited && (
          <p className="text-caption text-ink-muted">{t("onboardingV2.sync.waitHint")}</p>
        )}
        {(settled || waited) && (
          <Button size="lg" onClick={onContinue}>
            {t(settled ? "onboardingV2.continue" : "onboardingV2.sync.continueEarly")}
          </Button>
        )}
      </div>
    </section>
  );
}

interface AccountRowProps {
  entry: AccountProgress;
  format: (value: number) => string;
  onRetry: () => void;
}

function AccountRow({ entry, format, onRetry }: AccountRowProps) {
  const { t } = useT();
  const { account, row } = entry;
  const name = account.email ?? sourceGlyph(account.provider).name;
  return (
    <li
      data-state={row.state}
      className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4"
    >
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <SourceBadge provider={account.provider} />
        <span className="min-w-0 truncate text-label text-ink">{name}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 sm:justify-end">
        <Counters row={row} format={format} />
        <span
          className={`flex items-center gap-1.5 text-caption ${STATE_INK.get(row.state) ?? ""}`}
        >
          <StateMark state={row.state} />
          {t(STATE_KEY.get(row.state) ?? "")}
        </span>
        {row.state === "attention" && (
          <Button variant="secondary" size="sm" onClick={onRetry}>
            {t(
              account.health === "reconnect" ? "onboardingV2.sync.reconnect" : "onboardingV2.retry",
            )}
          </Button>
        )}
      </div>
    </li>
  );
}

function Counters({ row, format }: { row: SyncRow; format: (value: number) => string }) {
  const { t } = useT();
  if (row.messages === null && row.state !== "reading") return null;
  return (
    <span className="text-label font-normal tabular-nums text-ink-soft">
      {row.messages === null
        ? t("onboardingV2.sync.counting")
        : t("onboardingV2.sync.messages", { count: format(row.messages) })}
      {row.events !== null && (
        <>
          <span aria-hidden="true"> · </span>
          <span className="sr-only">, </span>
          {t("onboardingV2.sync.events", { count: format(row.events) })}
        </>
      )}
    </span>
  );
}

/** Shape as well as colour: a spinner, a check, a ring or a bar. */
function StateMark({ state }: { state: SyncState }) {
  if (state === "reading") {
    return (
      <span
        aria-hidden="true"
        className="size-3 rounded-full border-2 border-line-strong border-t-accent-solid motion-safe:animate-spin"
      />
    );
  }
  if (state === "ready") {
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
  if (state === "background") {
    return <span aria-hidden="true" className="size-2 rounded-full border-2 border-current" />;
  }
  return <span aria-hidden="true" className="h-0.5 w-2.5 rounded-full bg-current" />;
}

function LaneTotals({
  lanes,
  format,
}: {
  lanes: Record<LiveTier, number>;
  format: (value: number) => string;
}) {
  const { t } = useT();
  const counts = new Map(Object.entries(lanes));
  return (
    <div className="mt-6">
      <h2 className="text-head text-ink">{t("onboardingV2.sync.lanesTitle")}</h2>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-2">
        {CORE_TIERS.map((lane) => (
          <li key={lane} className="flex items-center gap-2">
            <LaneChip tier={lane} />
            <span className="text-label tabular-nums text-ink">
              {format(counts.get(lane) ?? 0)}
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-caption text-ink-muted">{t("onboardingV2.sync.lanesNote")}</p>
    </div>
  );
}

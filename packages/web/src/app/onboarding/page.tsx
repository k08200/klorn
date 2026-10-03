"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { ONBOARDING_ACTIVE_KEY } from "../../components/google-connect-redirect";
import { startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { useT } from "../../lib/i18n";
import { ReviewStep } from "./review-step";

export default function OnboardingPage() {
  return (
    <AuthGuard>
      <Suspense>
        <OnboardingFlow />
      </Suspense>
    </AuthGuard>
  );
}

type Step = 1 | 2 | 3 | 4;

function deriveStep(
  googleConnected: boolean | null,
  hasMailSource: boolean | null,
  syncStatus: string,
): Step {
  // No mail source at all → the connect gate.
  if (!googleConnected && !hasMailSource) return 1;
  // Mail via IMAP only (e.g. Naver connected in Settings): there is no Google
  // init-sync to wait for — land on review; the IMAP poll fills it server-side.
  if (!googleConnected) return 3;
  // Sync done → land on the review step (3); the ready step (4) is reached only
  // after the user finishes (or skips) reviewing their classifications.
  if (syncStatus === "done") return 3;
  return 2;
}

function OnboardingFlow() {
  const { googleConnected, hasMailSource, initSync } = useAuth();
  const router = useRouter();
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const [connecting, setConnecting] = useState(false);

  const derivedStep = deriveStep(googleConnected, hasMailSource, initSync.status);
  const step = manualStep ?? derivedStep;

  // Auto-advance from syncing → review when sync finishes
  useEffect(() => {
    if (step === 2 && initSync.status === "done") {
      setManualStep(3);
    }
  }, [step, initSync.status]);

  const handleDone = () => {
    router.replace("/inbox");
  };

  const handleConnectClick = async () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(ONBOARDING_ACTIVE_KEY, "true");
    }
    setConnecting(true);
    try {
      await startGoogleConnect();
    } catch {
      setConnecting(false);
    }
  };

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand mark */}
        <p className="mb-10 text-[11px] font-semibold uppercase tracking-[0.22em] text-accent-deep">
          Klorn
        </p>

        {step === 1 && <WelcomeStep connecting={connecting} onConnectClick={handleConnectClick} />}
        {step === 2 && <SyncingStep initSync={initSync} onContinue={handleDone} />}
        {step === 3 && <ReviewStep onContinue={() => setManualStep(4)} />}
        {step === 4 && <ReadyStep initSync={initSync} onDone={handleDone} />}

        {/* Progress dots */}
        <div className="mt-12 flex justify-center gap-2">
          {([1, 2, 3, 4] as Step[]).map((s) => (
            <div
              key={s}
              className={`ease-strong h-1.5 rounded-full transition-[width,background-color] duration-150 ${
                s === step
                  ? "w-6 bg-accent"
                  : s < step
                    ? "w-1.5 bg-accent-muted/40"
                    : "w-1.5 bg-surface-inset"
              }`}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Step 1: Welcome ──────────────────────────────────────────────────────

function WelcomeStep({
  connecting,
  onConnectClick,
}: {
  connecting: boolean;
  onConnectClick: () => void;
}) {
  const { t } = useT();
  const { googleNeedsReconnect } = useAuth();
  return (
    <div>
      {/* Same screen, different situation: this person already connected once
          and the grant died on its own. Without saying so, the first-run
          headline reads as though their account was reset. */}
      {googleNeedsReconnect && (
        <div
          data-testid="google-reconnect-notice"
          role="status"
          className="mb-6 rounded-lg border border-notice-border bg-notice-bg px-3.5 py-3 text-xs leading-5 text-notice-ink"
        >
          <span className="font-semibold text-notice-ink-strong">
            {t("reconnect.googleExpiredTitle")}
          </span>{" "}
          {t("reconnect.googleExpiredBody")}
        </div>
      )}
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {t("onboarding.welcome.titleLine1")}
        <br />
        {t("onboarding.welcome.titleLine2")}
      </h1>
      <p className="mt-4 text-sm leading-6 text-ink-mid">{t("onboarding.welcome.desc")}</p>

      <div className="mt-8 space-y-3">
        <button
          type="button"
          onClick={onConnectClick}
          disabled={connecting}
          className="glow-primary ease-strong flex w-full items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3.5 text-sm font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60 focus-ring"
        >
          {connecting ? t("onboarding.welcome.connecting") : t("onboarding.welcome.connectButton")}
          {!connecting && <span aria-hidden>→</span>}
        </button>
        {/* Non-Google escape hatch: a user who signed in with Apple/Naver and
            lives in Naver Mail attaches it via IMAP in Settings instead —
            without this line the Google button reads as the only way in. */}
        <p className="text-center text-xs leading-5 text-ink-dim">
          {t("onboarding.welcome.preferNaver")}{" "}
          <Link
            href="/settings/accounts"
            className="font-medium text-accent-deep underline decoration-sky-200 underline-offset-2 hover:text-accent-deep"
          >
            {t("onboarding.welcome.connectViaImap")}
          </Link>
        </p>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: "✉", label: t("onboarding.welcome.feature.readMail") },
          { icon: "◉", label: t("onboarding.welcome.feature.trackMeetings") },
          { icon: "✦", label: t("onboarding.welcome.feature.surfaceDecisions") },
        ].map((item) => (
          <div
            key={item.label}
            className="panel-elevated rounded-xl border border-line/70 bg-surface-panel p-3 text-center"
          >
            <p className="text-lg text-ink-mid">{item.icon}</p>
            <p className="mt-1 text-[11px] leading-4 text-ink-dim">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Permissions disclosure — Klorn never sends without explicit approval. */}
      <p className="mt-6 text-center text-[11px] leading-5 text-ink-dim">
        {t("onboarding.welcome.permissions.pre")}{" "}
        <span className="text-ink-mid">{t("onboarding.welcome.permissions.emphasis1")}</span>{" "}
        {t("onboarding.welcome.permissions.mid")}{" "}
        <span className="text-ink-mid">{t("onboarding.welcome.permissions.emphasis2")}</span>
        {t("onboarding.welcome.permissions.suffix")}
      </p>
    </div>
  );
}

// ─── Step 2: Syncing ──────────────────────────────────────────────────────

interface SyncState {
  status: string;
  emails: number;
  calendar: number;
  contacts: number;
}

function SyncingStep({ initSync, onContinue }: { initSync: SyncState; onContinue: () => void }) {
  const { t } = useT();
  const isDone = initSync.status === "done";
  const canContinue = isDone || initSync.status === "failed" || initSync.status === "skipped";

  // Allow manual continue after 15 s in case sync hangs
  const [timedOut, setTimedOut] = useState(false);
  useEffect(() => {
    if (canContinue) return;
    const id = setTimeout(() => setTimedOut(true), 15_000);
    return () => clearTimeout(id);
  }, [canContinue]);

  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {isDone ? t("onboarding.syncing.titleDone") : t("onboarding.syncing.title")}
      </h1>
      <p className="mt-4 text-sm leading-6 text-ink-mid">
        {isDone ? t("onboarding.syncing.descDone") : t("onboarding.syncing.desc")}
      </p>

      <div className="panel-elevated mt-8 divide-y divide-line-soft overflow-hidden rounded-2xl border border-line/70 bg-surface-panel">
        <SyncRow
          icon="✉"
          label={
            initSync.emails > 0
              ? t("onboarding.syncing.emailsProcessed", { count: String(initSync.emails) })
              : t("onboarding.syncing.readingEmails")
          }
          done={initSync.emails > 0}
          loading={initSync.status === "syncing" && initSync.emails === 0}
        />
        <SyncRow
          icon="◷"
          label={
            initSync.calendar > 0
              ? t("onboarding.syncing.eventsSynced", { count: String(initSync.calendar) })
              : t("onboarding.syncing.syncingCalendar")
          }
          done={initSync.calendar > 0}
          loading={initSync.status === "syncing" && initSync.calendar === 0}
        />
        <SyncRow
          icon="◉"
          label={
            initSync.contacts > 0
              ? t("onboarding.syncing.contactsSaved", { count: String(initSync.contacts) })
              : t("onboarding.syncing.loadingContacts")
          }
          done={isDone && initSync.contacts > 0}
          loading={initSync.status === "syncing"}
        />
      </div>

      {(canContinue || timedOut) && (
        <button
          type="button"
          onClick={onContinue}
          className="ease-strong mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3.5 text-sm font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] focus-ring"
        >
          {isDone
            ? t("onboarding.syncing.continueSeeFound")
            : t("onboarding.syncing.continueToInbox")}
          <span aria-hidden>→</span>
        </button>
      )}
    </div>
  );
}

function SyncRow({
  icon,
  label,
  done,
  loading,
}: {
  icon: string;
  label: string;
  done: boolean;
  loading: boolean;
}) {
  return (
    <div className="flex items-center gap-3 px-4 py-3">
      <span className="shrink-0 text-base text-ink-mid">{icon}</span>
      <p className="flex-1 text-sm text-ink-mid">{label}</p>
      {done && <span className="shrink-0 text-[11px] font-semibold text-state-ok-ink">✓</span>}
      {loading && (
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-line border-t-accent" />
      )}
    </div>
  );
}

// ─── Step 3: Ready ────────────────────────────────────────────────────────

function ReadyStep({ initSync, onDone }: { initSync: SyncState; onDone: () => void }) {
  const { t } = useT();
  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-ink">
        {t("onboarding.ready.title")}
      </h1>
      <p className="mt-4 text-sm leading-6 text-ink-mid">{t("onboarding.ready.desc")}</p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <StatCard value={initSync.emails} label={t("onboarding.ready.stat.emailsRead")} />
        <StatCard value={initSync.calendar} label={t("onboarding.ready.stat.eventsSynced")} />
        <StatCard value={initSync.contacts} label={t("onboarding.ready.stat.contacts")} />
      </div>

      <div className="panel-elevated mt-4 rounded-2xl border border-state-info-line bg-surface-panel p-4">
        <p className="text-xs font-semibold text-accent-deeper">
          {t("onboarding.ready.whatNext.title")}
        </p>
        <ul className="mt-2 space-y-1.5 text-xs text-ink-mid">
          <li>{t("onboarding.ready.whatNext.item1")}</li>
          <li>{t("onboarding.ready.whatNext.item2")}</li>
          <li>{t("onboarding.ready.whatNext.item3")}</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="ease-strong mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-solid px-5 py-3.5 text-sm font-semibold text-accent-solid-ink transition duration-150 hover:bg-accent-solid-hover active:scale-[0.97] focus-ring"
      >
        {t("onboarding.ready.openQueue")}
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="panel-elevated rounded-xl border border-line/70 bg-surface-panel p-3 text-center">
      <p className="text-2xl font-semibold tabular-nums text-ink">{value > 0 ? value : "—"}</p>
      <p className="mt-1 text-[11px] text-ink-dim">{label}</p>
    </div>
  );
}

"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import AuthGuard from "../../components/auth-guard";
import { API_BASE } from "../../lib/api";
import { useAuth } from "../../lib/auth";
import { ONBOARDING_ACTIVE_KEY } from "../../components/google-connect-redirect";

export default function OnboardingPage() {
  return (
    <AuthGuard>
      <Suspense>
        <OnboardingFlow />
      </Suspense>
    </AuthGuard>
  );
}

type Step = 1 | 2 | 3;

function deriveStep(googleConnected: boolean | null, syncStatus: string): Step {
  if (!googleConnected) return 1;
  if (syncStatus === "done") return 3;
  return 2;
}

function OnboardingFlow() {
  const { googleConnected, initSync, token } = useAuth();
  const router = useRouter();
  const [manualStep, setManualStep] = useState<Step | null>(null);

  const derivedStep = deriveStep(googleConnected, initSync.status);
  const step = manualStep ?? derivedStep;

  // Auto-advance from syncing → ready when sync finishes
  useEffect(() => {
    if (step === 2 && initSync.status === "done") {
      setManualStep(3);
    }
  }, [step, initSync.status]);

  const handleDone = () => {
    router.replace("/inbox");
  };

  const handleConnectClick = () => {
    if (typeof window !== "undefined") {
      localStorage.setItem(ONBOARDING_ACTIVE_KEY, "true");
    }
  };

  const connectUrl = `${API_BASE}/api/auth/google?token=${token ?? ""}`;

  return (
    <div className="flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center px-4 py-10">
      <div className="w-full max-w-md">
        {/* Brand mark */}
        <p className="mb-10 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
          Jigeum
        </p>

        {step === 1 && (
          <WelcomeStep
            connectUrl={connectUrl}
            onConnectClick={handleConnectClick}
            onSkip={handleDone}
          />
        )}
        {step === 2 && <SyncingStep initSync={initSync} onContinue={handleDone} />}
        {step === 3 && <ReadyStep initSync={initSync} onDone={handleDone} />}

        {/* Progress dots */}
        <div className="mt-12 flex justify-center gap-2">
          {([1, 2, 3] as Step[]).map((s) => (
            <div
              key={s}
              className={`h-1.5 rounded-full transition-all duration-300 ${
                s === step
                  ? "w-6 bg-amber-300"
                  : s < step
                    ? "w-1.5 bg-amber-300/40"
                    : "w-1.5 bg-stone-700"
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
  connectUrl,
  onConnectClick,
  onSkip,
}: {
  connectUrl: string;
  onConnectClick: () => void;
  onSkip: () => void;
}) {
  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        Your AI Chief of Staff
        <br />
        is ready to set up.
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        Connect Gmail and Google Calendar. Jigeum reads your inbox, finds what needs your
        attention, and surfaces it — so nothing slips through.
      </p>

      <div className="mt-8 space-y-3">
        <a
          href={connectUrl}
          onClick={onConnectClick}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-5 py-3.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
        >
          Connect Gmail &amp; Calendar
          <span aria-hidden>→</span>
        </a>
        <button
          type="button"
          onClick={onSkip}
          className="w-full rounded-xl border border-stone-700 px-5 py-3 text-sm text-stone-400 transition hover:border-stone-600 hover:text-stone-200"
        >
          Skip for now
        </button>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: "✉", label: "Reads your inbox" },
          { icon: "◉", label: "Tracks commitments" },
          { icon: "✦", label: "Surfaces decisions" },
        ].map((item) => (
          <div
            key={item.label}
            className="rounded-xl border border-stone-800 bg-stone-900/40 p-3 text-center"
          >
            <p className="text-lg text-stone-300">{item.icon}</p>
            <p className="mt-1 text-[11px] leading-4 text-stone-500">{item.label}</p>
          </div>
        ))}
      </div>
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

function SyncingStep({
  initSync,
  onContinue,
}: {
  initSync: SyncState;
  onContinue: () => void;
}) {
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
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        {isDone ? "Sync complete." : "Setting up your workspace..."}
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        {isDone
          ? "Jigeum has read your inbox and mapped your schedule."
          : "Reading your recent emails and calendar. This takes about 30 seconds."}
      </p>

      <div className="mt-8 space-y-3">
        <SyncRow
          icon="✉"
          label={initSync.emails > 0 ? `${initSync.emails} emails processed` : "Reading emails..."}
          done={initSync.emails > 0}
          loading={initSync.status === "syncing" && initSync.emails === 0}
        />
        <SyncRow
          icon="◷"
          label={
            initSync.calendar > 0 ? `${initSync.calendar} events synced` : "Syncing calendar..."
          }
          done={initSync.calendar > 0}
          loading={initSync.status === "syncing" && initSync.calendar === 0}
        />
        <SyncRow
          icon="◉"
          label={
            initSync.contacts > 0 ? `${initSync.contacts} contacts saved` : "Loading contacts..."
          }
          done={isDone && initSync.contacts > 0}
          loading={initSync.status === "syncing"}
        />
      </div>

      {(canContinue || timedOut) && (
        <button
          type="button"
          onClick={onContinue}
          className="mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-5 py-3.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
        >
          {isDone ? "See what Jigeum found" : "Continue to inbox"}
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
    <div className="flex items-center gap-3 rounded-xl border border-stone-800 bg-stone-900/30 px-4 py-3">
      <span className="shrink-0 text-base text-stone-400">{icon}</span>
      <p className="flex-1 text-sm text-stone-300">{label}</p>
      {done && <span className="shrink-0 text-[11px] font-semibold text-emerald-400">✓</span>}
      {loading && (
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-stone-600 border-t-amber-300" />
      )}
    </div>
  );
}

// ─── Step 3: Ready ────────────────────────────────────────────────────────

function ReadyStep({ initSync, onDone }: { initSync: SyncState; onDone: () => void }) {
  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        You&apos;re set up.
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        Jigeum is running. It&apos;ll surface decisions, track commitments, and prepare your
        morning briefing — all before you open your inbox.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <StatCard value={initSync.emails} label="Emails read" />
        <StatCard value={initSync.calendar} label="Events synced" />
        <StatCard value={initSync.contacts} label="Contacts" />
      </div>

      <div className="mt-4 rounded-xl border border-teal-500/20 bg-teal-400/5 p-4">
        <p className="text-xs font-semibold text-teal-300">What happens next</p>
        <ul className="mt-2 space-y-1.5 text-xs text-stone-400">
          <li>Your morning briefing will be ready before you wake up.</li>
          <li>Decision cards appear when Jigeum finds something that needs your approval.</li>
          <li>Commitments are tracked automatically from your emails.</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-5 py-3.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200"
      >
        Open Command Center
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="rounded-xl border border-stone-800 bg-stone-900/40 p-3 text-center">
      <p className="text-2xl font-semibold text-stone-50">{value > 0 ? value : "—"}</p>
      <p className="mt-1 text-[11px] text-stone-500">{label}</p>
    </div>
  );
}

"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { ONBOARDING_ACTIVE_KEY } from "../../components/google-connect-redirect";
import { startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";
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

function deriveStep(googleConnected: boolean | null, syncStatus: string): Step {
  if (!googleConnected) return 1;
  // Sync done → land on the review step (3); the ready step (4) is reached only
  // after the user finishes (or skips) reviewing their classifications.
  if (syncStatus === "done") return 3;
  return 2;
}

function OnboardingFlow() {
  const { googleConnected, initSync } = useAuth();
  const router = useRouter();
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const [connecting, setConnecting] = useState(false);

  const derivedStep = deriveStep(googleConnected, initSync.status);
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
        <p className="mb-10 text-[11px] font-semibold uppercase tracking-[0.22em] text-sky-600">
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
                  ? "w-6 bg-sky-500"
                  : s < step
                    ? "w-1.5 bg-sky-300/40"
                    : "w-1.5 bg-slate-200"
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
  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
        Klorn surfaces only the
        <br />
        decisions worth acting on.
      </h1>
      <p className="mt-4 text-sm leading-6 text-slate-500">
        Connect Gmail and Google Calendar. Klorn pulls the items that need a decision and quiets the
        rest.
      </p>

      <div className="mt-8 space-y-3">
        <button
          type="button"
          onClick={onConnectClick}
          disabled={connecting}
          className="glow-primary ease-strong flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 px-5 py-3.5 text-sm font-semibold text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {connecting ? "Redirecting to Google..." : "Connect Gmail & Calendar"}
          {!connecting && <span aria-hidden>→</span>}
        </button>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: "✉", label: "Read mail" },
          { icon: "◉", label: "Track meetings" },
          { icon: "✦", label: "Surface decisions" },
        ].map((item) => (
          <div
            key={item.label}
            className="panel-elevated rounded-xl border border-slate-200/70 bg-white p-3 text-center"
          >
            <p className="text-lg text-slate-500">{item.icon}</p>
            <p className="mt-1 text-[11px] leading-4 text-slate-400">{item.label}</p>
          </div>
        ))}
      </div>

      {/* Permissions disclosure — Klorn never sends without explicit approval. */}
      <p className="mt-6 text-center text-[11px] leading-5 text-slate-400">
        Klorn <span className="text-slate-500">only reads</span> Gmail and Calendar. Sending mail or
        creating events always waits for <span className="text-slate-500">your approval</span>.
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
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
        {isDone ? "Sync complete." : "Setting up your workspace..."}
      </h1>
      <p className="mt-4 text-sm leading-6 text-slate-500">
        {isDone
          ? "Klorn has read your inbox and mapped your schedule."
          : "Reading your recent emails and calendar. This takes about 30 seconds."}
      </p>

      <div className="panel-elevated mt-8 divide-y divide-slate-100 overflow-hidden rounded-2xl border border-slate-200/70 bg-white">
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
          className="ease-strong mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 px-5 py-3.5 text-sm font-semibold text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97]"
        >
          {isDone ? "See what Klorn found" : "Continue to inbox"}
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
      <span className="shrink-0 text-base text-slate-500">{icon}</span>
      <p className="flex-1 text-sm text-slate-500">{label}</p>
      {done && <span className="shrink-0 text-[11px] font-semibold text-emerald-600">✓</span>}
      {loading && (
        <span className="h-3 w-3 shrink-0 animate-spin rounded-full border-2 border-slate-200 border-t-sky-500" />
      )}
    </div>
  );
}

// ─── Step 3: Ready ────────────────────────────────────────────────────────

function ReadyStep({ initSync, onDone }: { initSync: SyncState; onDone: () => void }) {
  return (
    <div>
      <h1 className="text-[28px] font-semibold leading-tight tracking-[-0.02em] text-slate-900">
        You&apos;re set up.
      </h1>
      <p className="mt-4 text-sm leading-6 text-slate-500">
        Klorn is running. It&apos;ll surface decisions, track commitments, and prepare your morning
        briefing — all before you open your inbox.
      </p>

      <div className="mt-6 grid grid-cols-3 gap-3">
        <StatCard value={initSync.emails} label="Emails read" />
        <StatCard value={initSync.calendar} label="Events synced" />
        <StatCard value={initSync.contacts} label="Contacts" />
      </div>

      <div className="panel-elevated mt-4 rounded-2xl border border-sky-200/70 bg-white p-4">
        <p className="text-xs font-semibold text-sky-700">What happens next</p>
        <ul className="mt-2 space-y-1.5 text-xs text-slate-500">
          <li>Your morning briefing will be ready before you wake up.</li>
          <li>Decision cards appear when Klorn finds something that needs your approval.</li>
          <li>Commitments are tracked automatically from your emails.</li>
        </ul>
      </div>

      <button
        type="button"
        onClick={onDone}
        className="ease-strong mt-8 flex w-full items-center justify-center gap-2 rounded-xl bg-gradient-to-b from-sky-400 to-sky-500 px-5 py-3.5 text-sm font-semibold text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97]"
      >
        Open decision queue
        <span aria-hidden>→</span>
      </button>
    </div>
  );
}

function StatCard({ value, label }: { value: number; label: string }) {
  return (
    <div className="panel-elevated rounded-xl border border-slate-200/70 bg-white p-3 text-center">
      <p className="text-2xl font-semibold tabular-nums text-slate-900">
        {value > 0 ? value : "—"}
      </p>
      <p className="mt-1 text-[11px] text-slate-400">{label}</p>
    </div>
  );
}

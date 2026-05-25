"use client";

import { useRouter } from "next/navigation";
import { Suspense, useEffect, useState } from "react";
import AuthGuard from "../../components/auth-guard";
import { ONBOARDING_ACTIVE_KEY } from "../../components/google-connect-redirect";
import { startGoogleConnect } from "../../lib/api";
import { useAuth } from "../../lib/auth";

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
  const { googleConnected, initSync } = useAuth();
  const router = useRouter();
  const [manualStep, setManualStep] = useState<Step | null>(null);
  const [connecting, setConnecting] = useState(false);

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
        <p className="mb-10 text-[11px] font-semibold uppercase tracking-[0.22em] text-amber-300">
          Klorn
        </p>

        {step === 1 && <WelcomeStep connecting={connecting} onConnectClick={handleConnectClick} />}
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
  connecting,
  onConnectClick,
}: {
  connecting: boolean;
  onConnectClick: () => void;
}) {
  return (
    <div>
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        Klorn은 결정해야 할 것만
        <br />
        골라드립니다.
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        Gmail과 Google Calendar에 연결해주세요. 메일에서 결정이 필요한 안건만 골라내고, 나머지
        소음은 차단합니다.
      </p>

      <div className="mt-8 space-y-3">
        <button
          type="button"
          onClick={onConnectClick}
          disabled={connecting}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-amber-300 px-5 py-3.5 text-sm font-semibold text-stone-950 transition hover:bg-amber-200 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {connecting ? "Google로 이동 중..." : "Gmail & Calendar 연결하기"}
          {!connecting && <span aria-hidden>→</span>}
        </button>
      </div>

      <div className="mt-8 grid grid-cols-3 gap-3">
        {[
          { icon: "✉", label: "메일을 읽고" },
          { icon: "◉", label: "약속을 추적하고" },
          { icon: "✦", label: "결정만 알려줍니다" },
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

      {/* Permissions disclosure — Klorn never sends without explicit approval. */}
      <p className="mt-6 text-center text-[11px] leading-5 text-stone-500">
        Klorn은 Gmail과 Calendar를 <span className="text-stone-300">읽기만</span> 합니다. 메일
        전송이나 일정 생성은 항상 <span className="text-stone-300">본인 승인 후</span> 진행됩니다.
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
      <h1 className="text-3xl font-semibold leading-tight tracking-tight text-stone-50">
        {isDone ? "Sync complete." : "Setting up your workspace..."}
      </h1>
      <p className="mt-4 text-sm leading-6 text-stone-400">
        {isDone
          ? "Klorn has read your inbox and mapped your schedule."
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
        Klorn is running. It&apos;ll surface decisions, track commitments, and prepare your morning
        briefing — all before you open your inbox.
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
          <li>Decision cards appear when Klorn finds something that needs your approval.</li>
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

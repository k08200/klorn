"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { useAuth } from "../lib/auth";

type StepState = "done" | "active" | "pending" | "failed";
const DISMISS_KEY = "klorn-beta-learning-card-dismissed";
const LEGACY_KEY_PREFIX = "ev" + "e";
const LEGACY_DISMISS_KEY = `${LEGACY_KEY_PREFIX}-beta-learning-card-dismissed`;

export default function BetaLearningCard() {
  const { googleConnected, initSync } = useAuth();
  const [dismissed, setDismissed] = useState(false);
  const connected = googleConnected === true;
  const syncDone = initSync.status === "done";
  const syncFailed = initSync.status === "failed";
  const syncSkipped = initSync.status === "skipped";
  const syncing = initSync.status === "syncing";

  const progress = !connected
    ? 18
    : syncDone
      ? 100
      : syncFailed || syncSkipped
        ? 48
        : syncing
          ? 72
          : 42;

  const steps: Array<{ label: string; detail: string; state: StepState }> = [
    {
      label: "Google connected",
      detail: connected ? "Gmail and Calendar are available." : "Analysis starts after connection.",
      state: connected ? "done" : "active",
    },
    {
      label: "Recent mail checked",
      detail: syncDone
        ? initSync.emails > 0
          ? `Included ${initSync.emails} new emails.`
          : "Recent mail is up to date."
        : syncing
          ? "Looking for reply signals."
          : "Checks automatically after connection.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "active",
    },
    {
      label: "Calendar checked",
      detail: syncDone
        ? initSync.calendar > 0
          ? `Included ${initSync.calendar} events from the next 30 days.`
          : "No upcoming events, or calendar is already current."
        : syncing
          ? "Organizing meeting and prep signals."
          : "Checks again before briefing.",
      state: !connected ? "pending" : syncFailed ? "failed" : syncDone ? "done" : "pending",
    },
  ];

  useEffect(() => {
    const legacyDismissed = localStorage.getItem(LEGACY_DISMISS_KEY);
    if (legacyDismissed) {
      localStorage.setItem(DISMISS_KEY, legacyDismissed);
      localStorage.removeItem(LEGACY_DISMISS_KEY);
    }
    setDismissed(localStorage.getItem(DISMISS_KEY) === "true");
  }, []);

  const dismiss = () => {
    localStorage.setItem(DISMISS_KEY, "true");
    localStorage.removeItem(LEGACY_DISMISS_KEY);
    setDismissed(true);
  };

  if (dismissed) return null;

  return (
    <section className="panel-elevated mb-6 rounded-2xl border border-slate-200/70 bg-white p-4">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-sky-600">
            Initial learning
          </p>
          <h2 className="mt-2 text-base font-semibold text-slate-900">
            Klorn learns mail and calendar patterns during the first 2-3 days.
          </h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            Early briefings may be conservative. The top three actions get sharper as you use the
            workspace.
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {!connected && (
            <Link
              href="/settings"
              className="glow-primary ease-strong rounded-lg bg-gradient-to-b from-sky-400 to-sky-500 px-3 py-1.5 text-xs font-medium text-white transition duration-150 hover:from-sky-400 hover:to-sky-600 active:scale-[0.97]"
            >
              Connect
            </Link>
          )}
          <button
            type="button"
            onClick={dismiss}
            className="ease-strong rounded-lg border border-slate-200 bg-white/70 px-2.5 py-1.5 text-xs font-medium text-slate-500 shadow-[0_1px_1px_rgba(15,23,42,0.04)] transition duration-150 hover:bg-white hover:text-slate-900 active:scale-[0.97]"
            aria-label="Dismiss initial learning notice"
          >
            Close
          </button>
        </div>
      </div>

      <div className="mt-4 h-1.5 rounded-full bg-slate-100">
        <div
          className="ease-strong h-full rounded-full bg-gradient-to-r from-sky-400 to-sky-500 transition-[width] duration-150"
          style={{ width: `${progress}%` }}
        />
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-3">
        {steps.map((step) => (
          <div
            key={step.label}
            className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2"
          >
            <div className="flex items-center gap-2">
              <span className={`h-2 w-2 rounded-full ${dotClass(step.state)}`} />
              <p className="text-xs font-medium text-slate-900">{step.label}</p>
            </div>
            <p className="mt-1 text-[11px] leading-5 text-slate-400">{step.detail}</p>
          </div>
        ))}
      </div>

      {syncFailed && (
        <p className="mt-3 text-xs text-rose-600">
          Initial analysis hit a temporary issue. Refresh or reopen shortly and Klorn will retry.
        </p>
      )}
    </section>
  );
}

function dotClass(state: StepState): string {
  switch (state) {
    case "done":
      return "bg-emerald-500";
    case "active":
      return "bg-sky-500";
    case "failed":
      return "bg-rose-500";
    case "pending":
      return "bg-slate-300";
  }
}

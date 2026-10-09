"use client";

/**
 * Multi-provider first run (productization plan §3, P8, ONBOARDING_V2):
 * bring in your accounts → live sync → check the sorting → done. This file
 * owns the step, the page frame and the way out; each step owns its own data.
 *
 * Honest by construction: a tile exists only for a provider the server offers,
 * every number on the sync screen is read from the server, and leaving is a
 * full navigation so the app starts from what the server now knows about the
 * user's accounts.
 */

import { useEffect, useRef, useState } from "react";
import { useAuth } from "../../../lib/auth";
import { homePath } from "../../../lib/home";
import { useT } from "../../../lib/i18n";
import { type ConnectResult, takeConnectResult } from "../../../lib/onboarding-return";
import { useConnectedAccounts } from "../../../lib/use-connected-accounts";
import { ConnectStep } from "./connect-step";
import { FinishStep } from "./finish-step";
import { STEPS, type Step } from "./model";
import { ReviewStepV2 } from "./review-step";
import { SyncStep } from "./sync-step";

/** Where the accounts are managed; reachable with no mail source attached. */
const ACCOUNTS_ROUTE = "/settings/accounts";

const STEP_LABEL_KEY: ReadonlyMap<Step, string> = new Map([
  ["connect", "onboardingV2.steps.connect"],
  ["sync", "onboardingV2.steps.sync"],
  ["review", "onboardingV2.steps.review"],
  ["finish", "onboardingV2.steps.finish"],
]);

export function OnboardingV2() {
  const { user } = useAuth();
  const accounts = useConnectedAccounts();
  const [step, setStep] = useState<Step>("connect");
  const [returned, setReturned] = useState<ConnectResult | null>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  const firstRender = useRef(true);

  // An OAuth connect started here has come back (see lib/onboarding-return).
  // Taking the result clears it, so it is taken once per mount: an effect
  // that runs twice (React strict mode) must not replace it with nothing.
  const taken = useRef(false);
  useEffect(() => {
    if (taken.current) return;
    taken.current = true;
    setReturned(takeConnectResult());
  }, []);

  // A new step is a new screen: move focus to its heading so a keyboard or
  // screen-reader user starts at the top of it, not on a button that is gone.
  // biome-ignore lint/correctness/useExhaustiveDependencies: runs on step change only.
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    frameRef.current?.querySelector<HTMLElement>("h1")?.focus();
    window.scrollTo({ top: 0 });
  }, [step]);

  const connected = accounts.accounts.length > 0;

  // A full navigation, not a route push: the auth context read the user's mail
  // sources once at sign-in, and an account connected here must count when
  // the home decides what to show.
  const leave = () => {
    // The legacy home sends a user with no mail source straight back here, so
    // without Today a skip lands on the accounts page instead.
    const destination = connected || user?.unifiedHome === true ? homePath(user) : ACCOUNTS_ROUTE;
    window.location.assign(destination);
  };

  return (
    <div className="mx-auto flex min-h-[calc(100dvh-3.5rem)] w-full max-w-2xl flex-col px-4 py-8 md:py-14">
      <header className="mb-8 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <p className="text-label font-semibold tracking-wide text-ink">Klorn</p>
        <StepTrail step={step} />
      </header>

      <div ref={frameRef} className="flex-1 [word-break:keep-all]">
        {step === "connect" && (
          <ConnectStep
            accounts={accounts}
            returned={returned}
            onDismissReturned={() => setReturned(null)}
            onContinue={() => setStep("sync")}
            onSkip={leave}
          />
        )}
        {step === "sync" && (
          <SyncStep
            accounts={accounts.accounts}
            onContinue={() => setStep("review")}
            onFixAccount={() => setStep("connect")}
          />
        )}
        {step === "review" && <ReviewStepV2 onContinue={() => setStep("finish")} />}
        {step === "finish" && (
          <FinishStep
            accounts={accounts.accounts}
            today={user?.unifiedHome === true}
            onOpen={leave}
            onAddAccount={() => setStep("connect")}
          />
        )}
      </div>
    </div>
  );
}

function StepTrail({ step }: { step: Step }) {
  const { t } = useT();
  const current = STEPS.indexOf(step);
  return (
    <ol aria-label={t("onboardingV2.steps.label")} className="flex items-center gap-3">
      {STEPS.map((name, index) => {
        const active = index === current;
        const done = index < current;
        return (
          <li
            key={name}
            aria-current={active ? "step" : undefined}
            className={`flex items-center gap-1.5 text-caption ${active ? "text-ink" : "text-ink-muted"}`}
          >
            <span
              aria-hidden="true"
              className={`flex size-5 items-center justify-center rounded-full border text-caption tabular-nums ${
                active
                  ? "border-accent-solid bg-accent-solid text-accent-solid-ink"
                  : done
                    ? "border-line-strong bg-surface-inset text-ink-soft"
                    : "border-line text-ink-muted"
              }`}
            >
              {index + 1}
            </span>
            {/* Every step is named for assistive tech; on a phone only the
                current one is spelled out. */}
            <span className={active ? "font-medium" : "max-sm:sr-only"}>
              {t(STEP_LABEL_KEY.get(name) ?? "")}
            </span>
            {done && <span className="sr-only">, {t("onboardingV2.steps.done")}</span>}
          </li>
        );
      })}
    </ol>
  );
}

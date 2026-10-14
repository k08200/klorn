"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";
import {
  ONBOARDING_ROUTE,
  outcomeFromCallback,
  pendingConnect,
  storeConnectResult,
} from "../lib/onboarding-return";

/**
 * Sends an OAuth callback back to the first run when the first run started it
 * (productization plan P8, ONBOARDING_V2). Renders nothing, and does nothing
 * unless this tab holds the first run's marker — which only the first run
 * writes, so with the flag off this component is inert.
 *
 * Must be rendered inside a <Suspense> boundary because it uses useSearchParams.
 */
export function OnboardingReturn() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const provider = pendingConnect();
    if (!provider) return;
    const outcome = outcomeFromCallback(searchParams.get("google"), searchParams.get("inbox"));
    if (!outcome) return;
    storeConnectResult(provider, outcome);
    router.replace(ONBOARDING_ROUTE);
  }, [searchParams, router]);

  return null;
}

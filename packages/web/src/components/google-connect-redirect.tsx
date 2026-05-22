"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useEffect } from "react";

export const ONBOARDING_ACTIVE_KEY = "klorn_onboarding_active";

/**
 * Detects the `?google=connected` redirect from the OAuth callback and, if
 * the user initiated the connection from the onboarding flow, sends them back
 * there instead of landing on the settings page.
 *
 * Must be rendered inside a <Suspense> boundary because it uses useSearchParams.
 */
export function GoogleConnectRedirect() {
  const searchParams = useSearchParams();
  const router = useRouter();

  useEffect(() => {
    const isGoogleCallback = searchParams.get("google") === "connected";
    const isOnboarding =
      typeof window !== "undefined" && localStorage.getItem(ONBOARDING_ACTIVE_KEY) === "true";

    if (isGoogleCallback && isOnboarding) {
      localStorage.removeItem(ONBOARDING_ACTIVE_KEY);
      router.replace("/onboarding");
    }
  }, [searchParams, router]);

  return null;
}

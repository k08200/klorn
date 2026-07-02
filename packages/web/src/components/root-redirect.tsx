"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { getStoredAuthToken } from "../lib/api";
import { isNativePlatform } from "../lib/native/capacitor";

const MARKETING_URL = "https://klorn.ai";
const HOSTED_APP_HOST = "app.klorn.ai";

/**
 * app.klorn.ai serves the product only — the one landing page lives at
 * https://klorn.ai. Signed-in visitors go to the inbox; signed-out visitors on
 * the hosted app origin are sent to the marketing site. Native shells and
 * self-hosted deployments stay on their own origin and land on /login.
 */
export default function RootRedirect() {
  const router = useRouter();

  useEffect(() => {
    if (getStoredAuthToken()) {
      router.replace("/inbox");
      return;
    }
    if (!isNativePlatform() && window.location.hostname === HOSTED_APP_HOST) {
      window.location.replace(MARKETING_URL);
      return;
    }
    router.replace("/login");
  }, [router]);

  return null;
}

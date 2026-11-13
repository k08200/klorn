"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";
import { settingsIndexTarget } from "./sections";

/**
 * `/settings` has no content of its own: it forwards to the first section with
 * the query string and fragment intact (sections.ts settingsIndexTarget). It
 * is a client redirect so the static export can serve it too; the server
 * redirect it replaces already reached the browser as a client-side
 * navigation (Next streamed it as NEXT_REDIRECT in a 200). It sits outside the
 * `(sections)` group so, as before, the redirect happens before AuthGuard runs
 * on the section it lands on.
 */
export default function SettingsIndexPage() {
  const router = useRouter();
  useEffect(() => {
    router.replace(settingsIndexTarget(window.location.search, window.location.hash));
  }, [router]);
  return null;
}

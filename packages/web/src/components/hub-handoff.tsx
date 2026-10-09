"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { hasLegacyLanding, hubRouteFor } from "../lib/home";

/**
 * Wraps a legacy page that moved into the Assistant hub (productization plan
 * P7): with UNIFIED_HOME on, `/inbox`, `/briefing` and `/inbox/receipt` hand
 * over to their hub page — a fixed internal destination, the query carried
 * along — and render nothing of their own. With the flag off this is a
 * pass-through and the page renders exactly as before.
 *
 * A marked landing (the root redirect sent the visitor to the legacy home
 * before the server had answered) is left to the app shell, which moves it to
 * Today.
 */
export function HubHandoff({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const router = useRouter();
  const pathname = usePathname();
  const unified = user?.unifiedHome === true;
  const moved = unified && hubRouteFor(pathname, "") !== null;

  useEffect(() => {
    if (!moved || hasLegacyLanding()) return;
    const target = hubRouteFor(pathname, window.location.search);
    if (target) router.replace(target);
  }, [moved, pathname, router]);

  return moved ? null : children;
}

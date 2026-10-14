"use client";

import { usePathname, useRouter } from "next/navigation";
import { type ReactNode, useEffect } from "react";
import { useAuth } from "../lib/auth";
import { hasLegacyLanding, hubRouteFor } from "../lib/home";

/**
 * Wraps a legacy page that moved into the Assistant hub (productization plan
 * P7): with UNIFIED_HOME on, `/inbox`, `/briefing` and `/inbox/receipt` hand
 * over to their hub page (and `/inbox/firewall` to Mail, when MAIL_V2 gives
 * Mail the lane view) — a fixed internal destination, the query carried
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
  const flags = { mailV2: user?.mailV2 === true };
  const moved = unified && hubRouteFor(pathname, "", flags) !== null;

  useEffect(() => {
    if (!moved || hasLegacyLanding()) return;
    const target = hubRouteFor(pathname, window.location.search, { mailV2: flags.mailV2 });
    if (target) router.replace(target);
  }, [moved, pathname, router, flags.mailV2]);

  return moved ? null : children;
}

"use client";

import { usePathname, useRouter } from "next/navigation";
import { createContext, type ReactNode, useContext, useEffect, useState } from "react";
import { apiFetch } from "../../../lib/api";
import { captureClientError } from "../../../lib/sentry";
import { legacyAnchorSection, settingsSectionHref } from "../sections";
import { SettingsNav } from "./settings-nav";

/** `null` while the probe is in flight. */
type TeamAvailability = boolean | null;

const TeamAvailabilityContext = createContext<TeamAvailability>(null);

export function useTeamAvailability(): TeamAvailability {
  return useContext(TeamAvailabilityContext);
}

/**
 * Team mode is a paid capability shipped dark: `/api/teams` answers 403 for
 * accounts without it. The same probe the Teams panel uses decides whether the
 * nav offers the section at all.
 */
function useTeamProbe(): TeamAvailability {
  const [available, setAvailable] = useState<TeamAvailability>(null);
  useEffect(() => {
    apiFetch("/api/teams")
      .then(() => setAvailable(true))
      .catch((err) => {
        setAvailable(false);
        if (err instanceof Error && err.message.startsWith("API 403")) return;
        captureClientError(err, { scope: "settings.team-probe" });
      });
  }, []);
  return available;
}

/** Send a pre-split `/settings#anchor` link to the section that now owns it. */
function useLegacyAnchorRedirect(pathname: string) {
  const router = useRouter();
  useEffect(() => {
    const anchor = window.location.hash.slice(1);
    if (!anchor) return;
    const target = legacyAnchorSection(anchor);
    if (!target) return;
    const href = settingsSectionHref(target);
    if (pathname === href) return;
    router.replace(`${href}${window.location.search}#${anchor}`);
  }, [pathname, router]);
}

export function SettingsShell({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const teamAvailable = useTeamProbe();
  useLegacyAnchorRedirect(pathname);

  return (
    <TeamAvailabilityContext.Provider value={teamAvailable}>
      <div className="mx-auto max-w-6xl px-4 pb-28 pt-3 sm:px-6 md:flex md:gap-8 md:py-10">
        <SettingsNav pathname={pathname} showTeam={teamAvailable === true} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </TeamAvailabilityContext.Provider>
  );
}

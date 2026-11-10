"use client";

import { useAuth } from "./auth";
import { resolveDisplayTimeZone } from "./time-zone";
import { useDeviceTimeZone } from "./time-zone-sync";

/**
 * The IANA zone every time in the web app renders in: the zone pinned in
 * Settings, else the device zone (Automatic), else the account's last synced
 * zone, else UTC. See resolveDisplayTimeZone.
 */
export function useDisplayTimeZone(): string {
  const { user } = useAuth();
  const deviceZone = useDeviceTimeZone();
  return resolveDisplayTimeZone({
    mode: user?.timezoneMode,
    savedZone: user?.timezone,
    deviceZone,
  });
}

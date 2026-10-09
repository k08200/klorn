/**
 * DriveProviderActions for a provider with no drive implementation yet, or whose
 * flag is off: in D2 that is every one of them (KLORN waits for D3, GOOGLE for
 * D5, ONEDRIVE for D6).
 *
 * `connect` answers `{ unsupported: true }` so a caller refuses loudly instead of
 * reading it as "not connected".
 */

import type { DriveProviderName } from "../drive-providers.js";
import type { DriveProviderActions, DriveUnsupported } from "./types.js";

function refuse(provider: DriveProviderName): DriveUnsupported {
  return {
    unsupported: true,
    error: `Drive provider ${provider} is not supported from Klorn yet.`,
  };
}

export function unsupportedDriveActions(provider: DriveProviderName): DriveProviderActions {
  return { provider, connect: async () => refuse(provider) };
}

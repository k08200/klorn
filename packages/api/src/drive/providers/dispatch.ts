/**
 * Provider dispatch for drive sources (step D2 of
 * docs/providers/unified-platform-plan.md; mirrors
 * pim/calendar-providers/dispatch.ts).
 *
 * `driveActionsForProvider` answers "which implementation serves this source?".
 * A connector is real only while DRIVE_ENABLED and its own flag are both on
 * (DRIVE_PROVIDER_ENABLED in drive/drive-scope.ts, read per call so a flip needs
 * no restart); otherwise, and for a provider nobody implemented, it is the
 * unsupported stub. D5b implements GOOGLE.
 *
 * A connector plugs in with two entries: its flag in DRIVE_PROVIDER_ENABLED and
 * its actions in IMPLEMENTATIONS below.
 */

import type { DriveProviderName } from "../drive-providers.js";
import {
  DRIVE_PROVIDER_ENABLED,
  type DriveProviderEnabledMap,
  visibleDriveProviders,
} from "../drive-scope.js";
import { googleDriveActions } from "./google.js";
import type { DriveProviderActions } from "./types.js";
import { unsupportedDriveActions } from "./unsupported.js";

export type DriveImplementations = Readonly<
  Partial<Record<DriveProviderName, DriveProviderActions>>
>;

/**
 * The connectors that exist. D5b adds GOOGLE; D6 adds ONEDRIVE. KLORN has none:
 * the Klorn drive's index IS its source (D3 writes the rows itself), so a
 * session that lists it would only read the same table back. KLORN stays the
 * unsupported stub here while its flag lives in DRIVE_PROVIDER_ENABLED.
 */
const IMPLEMENTATIONS: DriveImplementations = { GOOGLE: googleDriveActions };

export function driveActionsForProvider(
  provider: DriveProviderName,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
  implementations: DriveImplementations = IMPLEMENTATIONS,
): DriveProviderActions {
  const enabled = visibleDriveProviders(providerEnabled).includes(provider);
  const actions =
    enabled && Object.hasOwn(implementations, provider) ? implementations[provider] : undefined;
  return actions ?? unsupportedDriveActions(provider);
}

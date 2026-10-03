/**
 * Provider dispatch for drive sources (step D2 of
 * docs/providers/unified-platform-plan.md; mirrors
 * pim/calendar-providers/dispatch.ts).
 *
 * `driveActionsForProvider` answers "which implementation serves this source?".
 * A connector is real only while DRIVE_ENABLED and its own flag are both on
 * (DRIVE_PROVIDER_ENABLED in drive/drive-scope.ts, read per call so a flip needs
 * no restart); otherwise, and for a provider nobody implemented, it is the
 * unsupported stub. D2 implements none.
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
import {
  DRIVE_SUMMARY_MAX_BYTES,
  type DriveProviderActions,
  type DriveProviderSession,
  type DriveSourceRef,
  type DriveUnsupported,
  isDriveUnsupported,
} from "./types.js";
import { unsupportedDriveActions } from "./unsupported.js";

export type DriveImplementations = Readonly<
  Partial<Record<DriveProviderName, DriveProviderActions>>
>;

/** The connectors that exist. D3 adds KLORN, D5 GOOGLE, D6 ONEDRIVE, D7 DEVICE. */
const IMPLEMENTATIONS: DriveImplementations = {};

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

/** What a summary fetch may ask a connector for: the caller's limit, never past the ceiling. */
export function summaryByteCap(requested: number): number {
  if (!Number.isFinite(requested) || requested < 1) return DRIVE_SUMMARY_MAX_BYTES;
  return Math.min(DRIVE_SUMMARY_MAX_BYTES, Math.floor(requested));
}

/**
 * The session with the summary size cap enforced at the seam, whatever the
 * connector does: it is asked for at most the cap, and content longer than it
 * was asked for is answered `too-large`, so the bytes go no further.
 */
export function withSummaryCap(session: DriveProviderSession): DriveProviderSession {
  return {
    provider: session.provider,
    list: (query) => session.list(query),
    search: (query) => session.search(query),
    getMetadata: (externalId) => session.getMetadata(externalId),
    async fetchForSummary(externalId, options) {
      const maxBytes = summaryByteCap(options.maxBytes);
      const result = await session.fetchForSummary(externalId, { maxBytes });
      if (result.kind === "content" && result.bytes.byteLength > maxBytes) {
        return { kind: "too-large", sizeBytes: result.bytes.byteLength };
      }
      return result;
    },
  };
}

/**
 * Open a session on one source: the capped session, `null` when the source is
 * not connected, or the unsupported result (see providers/types.ts).
 */
export async function connectDriveSource(
  provider: DriveProviderName,
  source: DriveSourceRef,
  providerEnabled: DriveProviderEnabledMap = DRIVE_PROVIDER_ENABLED,
  implementations: DriveImplementations = IMPLEMENTATIONS,
): Promise<DriveProviderSession | DriveUnsupported | null> {
  const actions = driveActionsForProvider(provider, providerEnabled, implementations);
  const session = await actions.connect(source);
  return session === null || isDriveUnsupported(session) ? session : withSummaryCap(session);
}

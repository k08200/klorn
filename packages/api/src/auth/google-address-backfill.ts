/**
 * Fills in UserToken.googleEmail where it is missing (auth/google-grant-revoke.ts):
 * primary grants connected before the column existed, and any whose read at
 * connect failed. The revoke's shared-grant check reads missing addresses
 * itself, but only up to MAX_UNKNOWN_ADDRESSES, and an address it cannot read
 * stops the revoke; this keeps that set small.
 */

import { captureError } from "../sentry.js";
import { newWork } from "../work-context.js";
import { backfillPrimaryGoogleAddresses } from "./google-grant-revoke.js";

const BACKFILL_INTERVAL_MS = 6 * 60 * 60_000;
const FIRST_RUN_DELAY_MS = 2 * 60_000;

async function tick(): Promise<void> {
  try {
    const { filled } = await backfillPrimaryGoogleAddresses();
    if (filled > 0) console.log(`[GOOGLE-REVOKE] Stored ${filled} primary grant address(es).`);
  } catch (err) {
    console.error("[GOOGLE-REVOKE] Address backfill failed:", err);
    captureError(err, { tags: { scope: "google.revoke.backfill" } });
  }
}

let intervalId: ReturnType<typeof setInterval> | null = null;
let firstRunTimer: ReturnType<typeof setTimeout> | null = null;

export function startGoogleAddressBackfill(): void {
  if (intervalId || firstRunTimer) return;
  firstRunTimer = setTimeout(
    newWork(() => {
      firstRunTimer = null;
      void tick();
      intervalId = setInterval(newWork(tick), BACKFILL_INTERVAL_MS);
      intervalId.unref?.();
    }),
    FIRST_RUN_DELAY_MS,
  );
  firstRunTimer.unref?.();
}

export function stopGoogleAddressBackfill(): void {
  if (firstRunTimer) clearTimeout(firstRunTimer);
  if (intervalId) clearInterval(intervalId);
  firstRunTimer = null;
  intervalId = null;
}

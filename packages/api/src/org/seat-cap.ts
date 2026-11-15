/**
 * The seat cap for a recorded payer whose verified email is not the Paddle
 * customer's (seat-management.ts requireIncreasePayer; the hint in
 * billing-access.ts). Pure: no database, no Paddle.
 */

import { MAX_SELF_SERVE_SEATS } from "./org-shape.js";

/**
 * A recorded payer whose verified email is not the Paddle customer's is the
 * owner who opened the checkout, not necessarily the card holder (a checkout
 * link forwarded to someone else who paid). Without the paying email, one
 * request adds at most RECORDED_PAYER_MAX_STEP seats over what Paddle bills
 * now, and never goes past RECORDED_PAYER_MAX_MULTIPLE times the seats the
 * subscription attached with: the card holder agreed to that count at
 * checkout, so the most it can grow on the recorded payer alone is doubling
 * it. The owner whose email Paddle bills has no cap beyond 2–150.
 */
export const RECORDED_PAYER_MAX_STEP = 10;
export const RECORDED_PAYER_MAX_MULTIPLE = 2;

/**
 * The most seats a recorded payer whose email Paddle does not bill can set,
 * from Paddle's live count (`current`) and the attach count: never below the
 * live count, and the live count itself (no increase) when the attach count is
 * unknown.
 */
export function recordedPayerSeatCap(current: number, seatsAtAttach: number | null): number {
  if (seatsAtAttach === null) return current;
  const cap = Math.min(
    current + RECORDED_PAYER_MAX_STEP,
    seatsAtAttach * RECORDED_PAYER_MAX_MULTIPLE,
    MAX_SELF_SERVE_SEATS,
  );
  return Math.max(current, cap);
}

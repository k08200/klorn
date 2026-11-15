/**
 * The seat cap for a recorded payer whose verified email is not the Paddle
 * customer's (org/seat-cap.ts): the smaller of Paddle's live count + 10 and
 * twice the attach count, never past 150, never below the live count, and no
 * increase at all when the attach count is unknown.
 */

import { describe, expect, it } from "vitest";
import { MAX_SELF_SERVE_SEATS } from "../org/org-shape.js";
import {
  RECORDED_PAYER_MAX_MULTIPLE,
  RECORDED_PAYER_MAX_STEP,
  recordedPayerSeatCap,
} from "../org/seat-cap.js";

describe("recordedPayerSeatCap", () => {
  it("is +10 over the live count or 2× the attach count, whichever is smaller", () => {
    expect([RECORDED_PAYER_MAX_STEP, RECORDED_PAYER_MAX_MULTIPLE]).toEqual([10, 2]);
    // 2× binds for a small team, +10 for a larger one; they meet at attach 20, live 30.
    expect(recordedPayerSeatCap(3, 3)).toBe(6);
    expect(recordedPayerSeatCap(12, 12)).toBe(22);
    expect(recordedPayerSeatCap(30, 20)).toBe(40);
    expect(recordedPayerSeatCap(29, 20)).toBe(39);
    expect(recordedPayerSeatCap(31, 20)).toBe(40);
  });

  it("measures the step from the live count", () => {
    expect(recordedPayerSeatCap(25, 20)).toBe(35);
    expect(recordedPayerSeatCap(6, 3)).toBe(6);
  });

  it("never adds when the live count is already past 2× the attach count, or the attach count is unknown", () => {
    expect(recordedPayerSeatCap(9, 3)).toBe(9);
    expect(recordedPayerSeatCap(5, null)).toBe(5);
  });

  it("never goes past the self-serve ceiling", () => {
    expect(recordedPayerSeatCap(145, 100)).toBe(MAX_SELF_SERVE_SEATS);
    expect(recordedPayerSeatCap(150, 100)).toBe(MAX_SELF_SERVE_SEATS);
  });
});

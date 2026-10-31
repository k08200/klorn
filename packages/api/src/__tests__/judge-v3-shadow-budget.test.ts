import { describe, expect, it } from "vitest";
import { shadowHeadroomOk } from "../judge/v3/shadow-budget.js";

describe("shadowHeadroomOk", () => {
  it("is false once the ordinary (cap minus reserve) line is reached", () => {
    expect(
      shadowHeadroomOk(
        { allowed: false, remainingCents: 0, capCents: 75 },
        { floorCents: 25, reserveCents: 25 },
      ),
    ).toBe(false);
  });

  it("with the judge reserve covering the floor, any headroom below the line is enough", () => {
    expect(
      shadowHeadroomOk(
        { allowed: true, remainingCents: 1, capCents: 75 },
        { floorCents: 25, reserveCents: 25 },
      ),
    ).toBe(true);
  });

  it("without a reserve, keeps its own floor for the v2 judge", () => {
    expect(
      shadowHeadroomOk(
        { allowed: true, remainingCents: 20, capCents: 100 },
        { floorCents: 25, reserveCents: 0 },
      ),
    ).toBe(false);
    expect(
      shadowHeadroomOk(
        { allowed: true, remainingCents: 30, capCents: 100 },
        { floorCents: 25, reserveCents: 0 },
      ),
    ).toBe(true);
  });

  it("an uncapped user (cap 0) is always allowed", () => {
    expect(
      shadowHeadroomOk(
        { allowed: true, remainingCents: Number.POSITIVE_INFINITY, capCents: 0 },
        { floorCents: 25, reserveCents: 0 },
      ),
    ).toBe(true);
  });
});

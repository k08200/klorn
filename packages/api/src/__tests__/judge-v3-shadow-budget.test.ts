import { afterEach, describe, expect, it } from "vitest";
import {
  callShareOk,
  shadowDailyUsd,
  shadowFloorCents,
  shadowHeadroomOk,
  withShadowSlot,
} from "../judge/v3/shadow-budget.js";

afterEach(() => {
  delete process.env.JUDGE_V3_SHADOW_FLOOR_CENTS;
  delete process.env.JUDGE_V3_SHADOW_DAILY_USD;
});

const usage = (rpmUsed: number, backgroundDailyUsed: number) =>
  ({ rpmUsed, rpmCap: 10, backgroundDailyUsed, backgroundDailyCap: 200 }) as never;

describe("shadow admission", () => {
  it("money: keeps the floor of ordinary budget, uncapped users always pass", () => {
    expect(shadowHeadroomOk({ allowed: false, remainingCents: 0, capCents: 75 }, 25)).toBe(false);
    expect(shadowHeadroomOk({ allowed: true, remainingCents: 20, capCents: 75 }, 25)).toBe(false);
    expect(shadowHeadroomOk({ allowed: true, remainingCents: 30, capCents: 75 }, 25)).toBe(true);
    expect(
      shadowHeadroomOk(
        { allowed: true, remainingCents: Number.POSITIVE_INFINITY, capCents: 0 },
        25,
      ),
    ).toBe(true);
  });

  it("calls: never more than half of the user's RPM or daily background count", () => {
    expect(callShareOk(usage(4, 99))).toBe(true);
    expect(callShareOk(usage(5, 10))).toBe(false);
    expect(callShareOk(usage(1, 100))).toBe(false);
  });

  it("env: an empty value means the default, not zero", () => {
    process.env.JUDGE_V3_SHADOW_FLOOR_CENTS = "";
    process.env.JUDGE_V3_SHADOW_DAILY_USD = " ";
    expect(shadowFloorCents()).toBe(25);
    expect(shadowDailyUsd()).toBe(0.15);
    process.env.JUDGE_V3_SHADOW_DAILY_USD = "0.5";
    expect(shadowDailyUsd()).toBe(0.5);
  });

  it("one extraction in flight: a second concurrent run is skipped, not queued", async () => {
    let release: () => void = () => {};
    const first = withShadowSlot(() => new Promise<string>((r) => (release = () => r("first"))));
    expect(await withShadowSlot(async () => "second")).toBeNull();
    release();
    expect(await first).toBe("first");
    expect(await withShadowSlot(async () => "third")).toBe("third");
  });
});

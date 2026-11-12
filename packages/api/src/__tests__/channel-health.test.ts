// Channel health: can Klorn reach this person outside an open Klorn tab? The
// web Today / Settings banner shows when `working` is false. A channel counts
// as working unless it is absent or proven dead — a web subscription with no
// recent receipt may simply have had nothing to deliver, so only the zombie
// flag (needs_resubscribe) rules it out.
import { describe, expect, it } from "vitest";
import { buildChannelHealth, DESKTOP_RECENT_MS } from "../notify/channel-health.js";

const NOW = Date.parse("2026-11-12T00:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

function web(
  id: string,
  opts: {
    deviceId?: string;
    createdDaysAgo?: number;
    receivedDaysAgo?: number | null;
    flagged?: boolean;
  } = {},
) {
  return {
    row: {
      id,
      deviceId: opts.deviceId ?? null,
      createdAt: new Date(NOW - (opts.createdDaysAgo ?? 30) * DAY),
      needsResubscribeAt: opts.flagged ? new Date(NOW - DAY) : null,
    },
    lastReceivedAt:
      opts.receivedDaysAgo === undefined || opts.receivedDaysAgo === null
        ? null
        : new Date(NOW - opts.receivedDaysAgo * DAY),
  };
}

function build(input: Partial<Parameters<typeof buildChannelHealth>[0]> = {}) {
  return buildChannelHealth({
    web: [],
    nativeTokens: 0,
    telegramLinked: false,
    desktop: [],
    currentDeviceId: undefined,
    now: NOW,
    ...input,
  });
}

describe("buildChannelHealth", () => {
  it("has no working channel when nothing is set up", () => {
    expect(build()).toEqual({
      webPush: { state: "none", currentDevice: null },
      desktop: [],
      telegram: { linked: false },
      mobile: { registered: false },
      working: false,
    });
  });

  it("web push is live with a recent receipt, or a subscription too new to judge", () => {
    expect(build({ web: [web("a", { receivedDaysAgo: 1 })] }).webPush.state).toBe("live");
    expect(build({ web: [web("a", { createdDaysAgo: 1 })] }).webPush.state).toBe("live");
  });

  it("web push is stale without a recent receipt — still counted as working", () => {
    const health = build({ web: [web("a", { receivedDaysAgo: 10 })] });
    expect(health.webPush.state).toBe("stale");
    expect(health.working).toBe(true);
  });

  it("web push needs re-subscribe when every subscription is a flagged zombie", () => {
    const health = build({ web: [web("a", { flagged: true }), web("b", { flagged: true })] });
    expect(health.webPush.state).toBe("needs_resubscribe");
    expect(health.working).toBe(false);
  });

  it("the best subscription wins", () => {
    const health = build({
      web: [web("a", { flagged: true }), web("b", { receivedDaysAgo: 0 })],
    });
    expect(health.webPush.state).toBe("live");
  });

  it("reports this browser's own subscription by device id", () => {
    const health = build({
      web: [web("a", { deviceId: "this", flagged: true }), web("b", { receivedDaysAgo: 0 })],
      currentDeviceId: "this",
    });
    expect(health.webPush.currentDevice).toBe("needs_resubscribe");
    expect(build({ web: [web("b")], currentDeviceId: "this" }).webPush.currentDevice).toBeNull();
  });

  it("counts Telegram and a phone app as working channels", () => {
    expect(build({ telegramLinked: true }).working).toBe(true);
    expect(build({ nativeTokens: 1 })).toMatchObject({
      mobile: { registered: true },
      working: true,
    });
  });

  it("counts a desktop app that is running or was seen recently", () => {
    const running = build({
      desktop: [{ app: "mac", running: true, lastSeenAt: NOW }],
    });
    expect(running.working).toBe(true);
    expect(running.desktop).toEqual([
      { app: "mac", running: true, lastSeenAt: new Date(NOW).toISOString() },
    ]);
    expect(
      build({
        desktop: [{ app: "windows", running: false, lastSeenAt: NOW - DESKTOP_RECENT_MS + 1000 }],
      }).working,
    ).toBe(true);
    expect(
      build({
        desktop: [{ app: "windows", running: false, lastSeenAt: NOW - DESKTOP_RECENT_MS - 1000 }],
      }).working,
    ).toBe(false);
  });
});

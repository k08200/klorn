/**
 * notificationSuppressionReason — what the agent's notify_user calls get
 * dropped before they ever turn into a Notification + push.
 *
 * Anchored to the 2026-05-31 prod incident: founder's mailbox emitted
 * 3 identical "[Klorn] Action complete — mark read finished" pushes
 * within a 1-second window after the paid-LLM-tier flip woke up the
 * autonomous agent. The prompt was patched and a server-side guard
 * landed in the same PR; these tests are the regression net.
 */

import { describe, expect, it } from "vitest";
import { notificationSuppressionReason } from "../notification-policy.js";

describe("notificationSuppressionReason — housekeeping", () => {
  it("drops the exact prod-incident title", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Action complete",
        message: "mark read finished.",
      }),
    ).toBe("housekeeping");
  });

  it("drops legacy EVE-prefixed housekeeping pushes", () => {
    expect(
      notificationSuppressionReason({
        title: "[EVE] Action complete",
        message: "mark read finished.",
      }),
    ).toBe("housekeeping");
  });

  it("drops bare 'Action complete' titles (no prefix)", () => {
    expect(
      notificationSuppressionReason({
        title: "Action complete",
        message: "mark read finished.",
      }),
    ).toBe("housekeeping");
  });

  it("drops classify_emails outcome pushes", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Action complete",
        message: "classify_emails finished — 12 emails classified.",
      }),
    ).toBe("housekeeping");
  });

  it("drops 'N emails classified' phrasing in any title", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Mail prioritized",
        message: "12 emails classified, inbox refreshed.",
      }),
    ).toBe("housekeeping");
  });

  it("drops [Klorn] Mail prioritized — the classify_emails humanizer output (prod 2026-05-31)", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Mail prioritized",
        message: "Inbox priority has been refreshed.",
      }),
    ).toBe("housekeeping");
  });

  it("drops empty Daily Briefing — 'No action needed' (prod 2026-05-31, founder dogfood)", () => {
    expect(
      notificationSuppressionReason({
        title: "Daily Briefing Ready",
        message: "No action needed.",
      }),
    ).toBe("housekeeping");
  });

  it("drops Daily Briefing — 'nothing to surface' phrasing", () => {
    expect(
      notificationSuppressionReason({
        title: "Daily Briefing Ready",
        message: "Nothing to surface today — your calendar is clear.",
      }),
    ).toBe("housekeeping");
  });

  it("PASSES Daily Briefing with real content (the CRAZY8 sale deadline case)", () => {
    expect(
      notificationSuppressionReason({
        title: "Daily Briefing Ready",
        message:
          "The CRAZY8 sale deadline is the only active signal today — everything else is open for focus.",
        notificationType: "briefing",
      }),
    ).toBeNull();
  });
});

describe("notificationSuppressionReason — noise", () => {
  it("drops newsletter pushes", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] New newsletter from Indie Hackers",
        message: "Latest digest is available.",
      }),
    ).toBe("noise");
  });

  it("drops 광고 pushes (Korean marketing)", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] [광고] 무료 체험 마지막 기회",
        message: "수신거부는 본 메일 하단을 클릭하세요.",
      }),
    ).toBe("noise");
  });

  it("drops verify-your-account boilerplate", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Welcome to Acme",
        message: "Verify your email to continue.",
      }),
    ).toBe("noise");
  });
});

describe("notificationSuppressionReason — allowed", () => {
  it("passes through generate_briefing outcome (new information)", () => {
    expect(
      notificationSuppressionReason({
        title: "Daily Briefing Ready",
        message: "Your morning briefing is ready — 3 priorities for today.",
      }),
    ).toBeNull();
  });

  it("passes through urgent security alerts", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Security alert",
        message: "New sign-in from an unrecognized device on your Google account.",
      }),
    ).toBeNull();
  });

  it("passes through time-sensitive meeting reminders", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Meeting in 15 minutes",
        message: "Sarah (Acme) called — Zoom link is ready.",
      }),
    ).toBeNull();
  });

  it("passes through reply-needed pushes for known senders", () => {
    expect(
      notificationSuppressionReason({
        title: "[Klorn] Customer follow-up needed",
        message: "Min Park from Acme asked about your Q3 timeline.",
      }),
    ).toBeNull();
  });

  it("handles empty / null inputs without throwing", () => {
    expect(notificationSuppressionReason({ title: null, message: null })).toBeNull();
    expect(notificationSuppressionReason({ title: undefined, message: undefined })).toBeNull();
    expect(notificationSuppressionReason({ title: "", message: "" })).toBeNull();
  });
});

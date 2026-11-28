/**
 * Capacitor shell (Structure A, PR6b): what a native push tap or action does
 * in the web app. The pure rules in packages/web/src/lib/native/push-intent.ts,
 * ported from apps/mobile/src/push/route.ts to the web's own paths:
 *   - a tap opens the mail (/email/<id>), else the approval queue for a
 *     draft, else the server's web `url` when it is a safe same-origin path,
 *     else home;
 *   - Reply opens the reader with the reply entry focused; "Send draft" and
 *     "Review" NEVER send — they open the draft for confirmation;
 *   - Later / Done / Not urgent map to the API calls the app already uses.
 */
import { describe, expect, it } from "vitest";
import {
  actionFromTap,
  intentOf,
  PUSH_ACTIONS,
  triageRequest,
  webPathFromPush,
} from "../../../web/src/lib/native/push-intent";

const NOW = new Date("2026-11-18T09:00:00.000Z");

describe("webPathFromPush", () => {
  it("opens the mail by its email id", () => {
    expect(webPathFromPush({ emailId: "em_1", route: "/mail/em_1", url: "/email/em_1" })).toBe(
      "/email/em_1",
    );
  });

  it("opens the approval queue for a draft with no mail id", () => {
    expect(webPathFromPush({ pendingActionId: "pa_1" })).toBe("/assistant/approvals");
  });

  it("falls back to the server's web url when it is a safe same-origin path", () => {
    expect(webPathFromPush({ url: "/briefing" })).toBe("/briefing");
    expect(webPathFromPush({ url: "/inbox/firewall?view=push" })).toBe("/inbox/firewall?view=push");
  });

  it("refuses external, protocol-relative or malformed urls and ids", () => {
    expect(webPathFromPush({ url: "https://evil.example/x" })).toBe("/");
    expect(webPathFromPush({ url: "//evil.example/x" })).toBe("/");
    expect(webPathFromPush({ url: "/\\evil.example" })).toBe("/");
    expect(webPathFromPush({ url: "javascript:alert(1)" })).toBe("/");
    expect(webPathFromPush({ url: "/email/../login" })).toBe("/");
    expect(webPathFromPush({ url: "/email/%2e%2e/login" })).toBe("/");
    expect(webPathFromPush({ url: "/email/%2E%2e%2Flogin" })).toBe("/");
    expect(webPathFromPush({ url: "/%2F%2Fevil.example" })).toBe("/");
    expect(webPathFromPush({ url: "/email/%zz" })).toBe("/");
    expect(webPathFromPush({ emailId: "../../etc" })).toBe("/");
    expect(webPathFromPush({ emailId: 42 })).toBe("/");
  });

  it("lands home for an empty or missing payload", () => {
    expect(webPathFromPush(undefined)).toBe("/");
    expect(webPathFromPush(null)).toBe("/");
    expect(webPathFromPush({})).toBe("/");
  });
});

describe("actionFromTap", () => {
  it("reads the Android native service's button from a plain tap", () => {
    expect(actionFromTap("tap", { klornAction: PUSH_ACTIONS.later })).toBe(PUSH_ACTIONS.later);
    expect(actionFromTap("tap", { klornAction: PUSH_ACTIONS.done })).toBe(PUSH_ACTIONS.done);
    expect(actionFromTap("tap", { klornAction: PUSH_ACTIONS.notUrgent })).toBe(
      PUSH_ACTIONS.notUrgent,
    );
  });

  it("never turns a tap into Send, and passes other ids through", () => {
    expect(actionFromTap("tap", { klornAction: PUSH_ACTIONS.send })).toBe("tap");
    expect(actionFromTap(PUSH_ACTIONS.reply, {})).toBe(PUSH_ACTIONS.reply);
  });
});

describe("intentOf", () => {
  const mail = { emailId: "em_1", attentionItemId: "ai_1", url: "/email/em_1" };

  it("a plain tap opens the mail", () => {
    expect(intentOf("tap", mail)).toEqual({ kind: "open", path: "/email/em_1" });
  });

  it("Reply opens the reader with the reply entry focused, sending nothing", () => {
    expect(intentOf(PUSH_ACTIONS.reply, mail)).toEqual({
      kind: "open",
      path: "/email/em_1?focus=reply",
    });
  });

  it("Send draft never sends: it opens the draft's approval card", () => {
    expect(intentOf(PUSH_ACTIONS.send, { ...mail, pendingActionId: "pa_1" })).toEqual({
      kind: "review",
      path: "/assistant/approvals",
    });
  });

  it("Send draft without a draft id opens the mail's reply entry for confirmation", () => {
    expect(intentOf(PUSH_ACTIONS.send, mail)).toEqual({
      kind: "review",
      path: "/email/em_1?focus=reply",
    });
  });

  it("Later / Done / Not urgent become triage intents with the mail as fallback", () => {
    expect(intentOf(PUSH_ACTIONS.later, mail)).toEqual({
      kind: "later",
      target: { emailId: "em_1" },
      fallback: "/email/em_1",
    });
    expect(intentOf(PUSH_ACTIONS.done, mail)).toEqual({
      kind: "done",
      target: { emailId: "em_1" },
      fallback: "/email/em_1",
    });
    // Not urgent moves the attention item first (always on server-side).
    expect(intentOf(PUSH_ACTIONS.notUrgent, mail)).toEqual({
      kind: "notUrgent",
      target: { attentionItemId: "ai_1" },
      fallback: "/email/em_1",
    });
  });

  it("a triage action with no id just opens", () => {
    expect(intentOf(PUSH_ACTIONS.done, { url: "/briefing" })).toEqual({
      kind: "open",
      path: "/briefing",
    });
  });
});

describe("triageRequest", () => {
  it("Later on a mail is the web's reminder (POST /api/email/:id/later)", () => {
    expect(
      triageRequest({ kind: "later", target: { emailId: "em_1" }, fallback: "/" }, NOW),
    ).toEqual({
      path: "/api/email/em_1/later",
      body: { remindAt: expect.any(String) },
    });
  });

  it("Later on an attention item alone snoozes it four hours, as the app did", () => {
    expect(
      triageRequest({ kind: "later", target: { attentionItemId: "ai_1" }, fallback: "/" }, NOW),
    ).toEqual({
      path: "/api/inbox/firewall/ai_1/snooze",
      body: { snoozeUntil: "2026-11-18T13:00:00.000Z" },
    });
  });

  it("Done dismisses by email id, else by attention item", () => {
    expect(
      triageRequest({ kind: "done", target: { emailId: "em_1" }, fallback: "/" }, NOW),
    ).toEqual({ path: "/api/inbox/firewall/email/em_1/dismiss", body: undefined });
    expect(
      triageRequest({ kind: "done", target: { attentionItemId: "ai_1" }, fallback: "/" }, NOW),
    ).toEqual({ path: "/api/inbox/firewall/ai_1/dismiss", body: undefined });
  });

  it("Not urgent moves to QUEUE by item, else by email id", () => {
    expect(
      triageRequest({ kind: "notUrgent", target: { attentionItemId: "ai_1" }, fallback: "/" }, NOW),
    ).toEqual({ path: "/api/inbox/firewall/ai_1", body: { tier: "QUEUE" } });
    expect(
      triageRequest({ kind: "notUrgent", target: { emailId: "em_1" }, fallback: "/" }, NOW),
    ).toEqual({ path: "/api/inbox/firewall/email/em_1", body: { tier: "QUEUE" } });
  });
});

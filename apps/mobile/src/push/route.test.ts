import { describe, expect, it } from "vitest";
import { actionFromTap, intentOf, PUSH_ACTIONS, routeFromPush, routeFromWebPath } from "./route";

describe("push routing", () => {
  it("maps the server's web paths to app routes", () => {
    expect(routeFromWebPath("/email/abc-123")).toEqual({ name: "mail", id: "abc-123" });
    expect(routeFromWebPath("/inbox/firewall")).toEqual({ name: "mail", lane: "PUSH" });
    expect(routeFromWebPath("/briefing")).toEqual({ name: "assistant", section: "briefing" });
    expect(routeFromWebPath("/chat")).toEqual({ name: "assistant", section: "chat" });
    expect(routeFromWebPath("/inbox")).toEqual({ name: "assistant", section: "approvals" });
    expect(routeFromWebPath("/nowhere")).toEqual({ name: "today" });
  });

  it("routes the server's real mail payload to the reader", () => {
    // packages/api notify/push-device.ts buildFcmMessage → data (also the APNs top-level keys).
    expect(
      routeFromPush({
        url: "/inbox/firewall",
        category: "email_urgent",
        emailId: "em_1",
        attentionItemId: "att_1",
        route: "/mail/em_1",
      }),
    ).toEqual({ name: "mail", id: "em_1" });
  });

  it("prefers an app route, then the approval, then the mail, then the web url", () => {
    expect(routeFromPush({ route: "/calendar/evt-1", url: "/chat" })).toEqual({
      name: "calendar",
      id: "evt-1",
    });
    expect(routeFromPush({ pendingActionId: "pa-1", emailId: "e1" })).toEqual({
      name: "assistant",
      section: "approvals",
      id: "pa-1",
    });
    expect(routeFromPush({ emailId: "e1", url: "/inbox/firewall" })).toEqual({
      name: "mail",
      id: "e1",
    });
    expect(routeFromPush({ url: "/email/e2" })).toEqual({ name: "mail", id: "e2" });
  });

  it("refuses malformed or foreign input", () => {
    expect(routeFromPush({ route: "//evil.example/x" })).toEqual({ name: "today" });
    expect(routeFromPush({ route: "https://evil.example" })).toEqual({ name: "today" });
    expect(routeFromPush({ emailId: "../../x" })).toEqual({ name: "today" });
    expect(routeFromPush(null)).toEqual({ name: "today" });
  });

  it("never turns 'Send draft' into a send", () => {
    expect(intentOf(PUSH_ACTIONS.send, { pendingActionId: "pa-1" })).toEqual({
      kind: "review",
      route: { name: "assistant", section: "approvals", id: "pa-1" },
    });
    expect(intentOf(PUSH_ACTIONS.later, { attentionItemId: "att-1", emailId: "e" })).toMatchObject({
      kind: "snooze",
      target: { emailId: "e" },
    });
    // An email id alone is enough: Done goes to the by-email route.
    expect(intentOf(PUSH_ACTIONS.done, { emailId: "e" })).toEqual({
      kind: "done",
      target: { emailId: "e" },
      fallback: { name: "mail", id: "e" },
    });
    // Only an attention item id: the id-keyed route.
    expect(intentOf(PUSH_ACTIONS.done, { attentionItemId: "att-1" })).toMatchObject({
      kind: "done",
      target: { attentionItemId: "att-1" },
    });
    // Nothing to act on: the action just opens the app.
    expect(intentOf(PUSH_ACTIONS.done, { url: "/briefing" })).toEqual({
      kind: "open",
      route: { name: "assistant", section: "briefing" },
    });
    expect(intentOf("tap", { url: "/chat" }).kind).toBe("open");
  });
});

describe("actionFromTap (Android native notifications)", () => {
  it("reads the button from klornAction on a plain tap", () => {
    expect(actionFromTap("tap", { klornAction: "KLORN_LATER" })).toBe(PUSH_ACTIONS.later);
    expect(actionFromTap("tap", { klornAction: "KLORN_DONE" })).toBe(PUSH_ACTIONS.done);
    expect(actionFromTap("tap", { klornAction: "KLORN_REVIEW" })).toBe(PUSH_ACTIONS.review);
  });

  it("a tap without a button, or with an unknown one, stays a tap", () => {
    expect(actionFromTap("tap", {})).toBe("tap");
    expect(actionFromTap("tap", null)).toBe("tap");
    expect(actionFromTap("tap", { klornAction: "DELETE_ALL" })).toBe("tap");
    // There is no Send on Android: the native service never names it.
    expect(actionFromTap("tap", { klornAction: PUSH_ACTIONS.send })).toBe("tap");
  });

  it("an iOS or local-notification action id passes through unchanged", () => {
    expect(actionFromTap(PUSH_ACTIONS.send, { klornAction: "KLORN_DONE" })).toBe(PUSH_ACTIONS.send);
    expect(actionFromTap(PUSH_ACTIONS.later, {})).toBe(PUSH_ACTIONS.later);
  });

  it("Done from the native notification dismisses by email", () => {
    const data = { emailId: "e1", klornAction: "KLORN_DONE", klornNotificationId: "123" };
    expect(intentOf(actionFromTap("tap", data), data)).toMatchObject({
      kind: "done",
      target: { emailId: "e1" },
    });
  });
});

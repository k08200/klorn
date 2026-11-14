// The web notification center (NC1 A): which group a bell row lands in, what
// "why it rang" line it shows, how the bell badge counts, and how a mail row
// is split into who / subject. Pure decisions in
// packages/web/src/lib/notification-center.ts, run from the api suite because
// the web package has no unit-test runner (see web-auth-surfaces.test.ts).
import { describe, expect, it } from "vitest";
import { type AlertEndpointList, alertStripItems } from "../../../web/src/lib/alert-devices";
import {
  bellBadgeCount,
  CENTER_GROUP_ORDER,
  type CenterNotification,
  centerGroupOf,
  deliveredToLabel,
  deliveryPath,
  groupForCenter,
  isMissingRoute,
  mailRowParts,
  monogram,
  parseDeliveryResponse,
  parseNotifBudget,
  reasonLine,
  rowLane,
} from "../../../web/src/lib/notification-center";

function notif(overrides: Partial<CenterNotification> = {}): CenterNotification {
  return {
    id: "n1",
    type: "email",
    title: "Urgent email",
    message: "Dana Whitfield: Contract signature needed [18c3abc]",
    isRead: false,
    createdAt: "2026-11-13T09:00:00.000Z",
    ...overrides,
  };
}

describe("centerGroupOf — server group wins", () => {
  it.each(["now", "today", "reply", "later", "done"] as const)("uses n.group = %s", (group) => {
    expect(centerGroupOf(notif({ group, isRead: true }))).toBe(group);
  });

  it("ignores an unknown server group and falls back", () => {
    expect(centerGroupOf(notif({ group: "urgent" as never }))).toBe("now");
  });
});

describe("centerGroupOf — fallback when n.group is absent", () => {
  it("read → done, whatever the type", () => {
    expect(centerGroupOf(notif({ isRead: true }))).toBe("done");
    expect(centerGroupOf(notif({ isRead: true, type: "meeting" }))).toBe("done");
    expect(centerGroupOf(notif({ isRead: true, type: "reminder" }))).toBe("done");
  });

  it("unread reminder → later", () => {
    expect(centerGroupOf(notif({ type: "reminder" }))).toBe("later");
  });

  it("unread meeting → today", () => {
    expect(centerGroupOf(notif({ type: "meeting" }))).toBe("today");
  });

  it("unread email → now", () => {
    expect(centerGroupOf(notif({ type: "email" }))).toBe("now");
  });

  it("agent_proposal with a PENDING action → now", () => {
    expect(
      centerGroupOf(
        notif({ type: "agent_proposal", pendingActionId: "pa1", pendingActionStatus: "PENDING" }),
      ),
    ).toBe("now");
  });

  it("any other unread row → now", () => {
    expect(centerGroupOf(notif({ type: "briefing" }))).toBe("now");
    expect(centerGroupOf(notif({ type: "calendar" }))).toBe("now");
  });

  it("null group is treated as absent", () => {
    expect(centerGroupOf(notif({ group: null, type: "reminder" }))).toBe("later");
  });
});

describe("groupForCenter", () => {
  it("orders groups now → today → reply → later → done and hides empty ones", () => {
    const rows = [
      notif({ id: "a", isRead: true }),
      notif({ id: "b", type: "reminder" }),
      notif({ id: "c" }),
      notif({ id: "d", type: "meeting" }),
      notif({ id: "e", group: "reply" }),
    ];
    const groups = groupForCenter(rows);
    expect(groups.map((g) => g.key)).toEqual(["now", "today", "reply", "later", "done"]);
    expect(groups.map((g) => g.items.map((n) => n.id))).toEqual([
      ["c"],
      ["d"],
      ["e"],
      ["b"],
      ["a"],
    ]);
    expect(CENTER_GROUP_ORDER).toEqual(["now", "today", "reply", "later", "done"]);
  });

  it("keeps the incoming order inside a group and drops empty groups", () => {
    const groups = groupForCenter([notif({ id: "x" }), notif({ id: "y" })]);
    expect(groups).toEqual([{ key: "now", items: [notif({ id: "x" }), notif({ id: "y" })] }]);
  });

  it("returns nothing for an empty list", () => {
    expect(groupForCenter([])).toEqual([]);
  });
});

describe("reasonLine — why it rang", () => {
  it("a verified quote shows in curly quotes", () => {
    expect(
      reasonLine({ text: "Deadline today", verified: true, quote: "Please sign before 17:00" }),
    ).toEqual({ kind: "quote", text: "“Please sign before 17:00”" });
  });

  it("does not double-wrap a quote that already carries quote marks", () => {
    expect(reasonLine({ verified: true, quote: "“already quoted”" })).toEqual({
      kind: "quote",
      text: "“already quoted”",
    });
    expect(reasonLine({ verified: true, quote: '"straight"' })).toEqual({
      kind: "quote",
      text: "“straight”",
    });
  });

  it("an unverified quote falls through to the judgment text", () => {
    expect(reasonLine({ text: "Payment failure notice", verified: false, quote: "x" })).toEqual({
      kind: "judgment",
      text: "Payment failure notice",
    });
  });

  it("a verified flag without a quote uses the text", () => {
    expect(reasonLine({ text: "Looks urgent", verified: true, quote: "   " })).toEqual({
      kind: "judgment",
      text: "Looks urgent",
    });
  });

  it("nothing at all → no line", () => {
    expect(reasonLine(undefined)).toBeNull();
    expect(reasonLine(null)).toBeNull();
    expect(reasonLine({})).toBeNull();
    expect(reasonLine({ text: "  " })).toBeNull();
  });

  it("keeps markup as literal text and collapses whitespace", () => {
    expect(reasonLine({ text: "<b>bold</b>\n\n**md**" })).toEqual({
      kind: "judgment",
      text: "<b>bold</b> **md**",
    });
  });

  it("ignores non-string fields from a surprising payload", () => {
    expect(reasonLine({ text: 42 as never, verified: true, quote: {} as never })).toBeNull();
  });
});

describe("bellBadgeCount", () => {
  it("counts unread now + today when the server sends groups", () => {
    const rows = [
      notif({ id: "1", group: "now" }),
      notif({ id: "2", group: "today" }),
      notif({ id: "3", group: "reply" }),
      notif({ id: "4", group: "later" }),
      notif({ id: "5", group: "now", isRead: true }),
    ];
    expect(bellBadgeCount(rows)).toBe(2);
  });

  it("falls back to all unread when no row carries a server group", () => {
    const rows = [
      notif({ id: "1" }),
      notif({ id: "2", type: "reminder" }),
      notif({ id: "3", isRead: true }),
    ];
    expect(bellBadgeCount(rows)).toBe(2);
  });

  it("is zero for an empty list", () => {
    expect(bellBadgeCount([])).toBe(0);
  });
});

describe("mailRowParts — who / subject", () => {
  it("splits the urgent-mail message into sender and subject and drops the [gmailId]", () => {
    expect(mailRowParts(notif({ sourceEmailId: "e1" }))).toEqual({
      who: "Dana Whitfield",
      subject: "Contract signature needed",
      person: true,
    });
  });

  it("keeps a colon inside the subject", () => {
    expect(
      mailRowParts(notif({ sourceEmailId: "e1", message: "Ops: Re: invoice #4821 [abc]" })),
    ).toEqual({ who: "Ops", subject: "Re: invoice #4821", person: true });
  });

  it("a non-mail row shows its title (agent prefix stripped) and message", () => {
    expect(
      mailRowParts(
        notif({ type: "meeting", title: "Design review · 15:00", message: "Starts in 10 min" }),
      ),
    ).toEqual({ who: "Design review · 15:00", subject: "Starts in 10 min", person: false });
    expect(
      mailRowParts(notif({ type: "agent_proposal", title: "[Klorn] Draft ready", message: "Re" })),
    ).toEqual({ who: "Draft ready", subject: "Re", person: false });
  });

  it("a mail row whose message does not parse keeps title + message", () => {
    expect(mailRowParts(notif({ sourceEmailId: "e1", message: "no separator here" }))).toEqual({
      who: "Urgent email",
      subject: "no separator here",
      person: false,
    });
  });
});

describe("monogram", () => {
  it("takes the first letters of the first and last word", () => {
    expect(monogram("Dana Whitfield").initials).toBe("DW");
    expect(monogram("ops").initials).toBe("OP");
    expect(monogram("최민지").initials).toBe("최");
  });

  it("hashes the name to a stable hue in 0..359", () => {
    const a = monogram("Dana Whitfield");
    expect(a.hue).toBe(monogram("Dana Whitfield").hue);
    expect(a.hue).toBeGreaterThanOrEqual(0);
    expect(a.hue).toBeLessThan(360);
    expect(monogram("Ops Alerts").hue).not.toBe(a.hue);
  });

  it("handles an empty name", () => {
    expect(monogram("  ").initials).toBe("?");
  });
});

describe("rowLane", () => {
  it("returns a live lane, folds retired values, and nothing when absent", () => {
    expect(rowLane("PUSH")).toBe("PUSH");
    expect(rowLane("MEETING")).toBe("MEETING");
    expect(rowLane("CALL")).toBe("PUSH");
    expect(rowLane("AUTO")).toBe("QUEUE");
    expect(rowLane(undefined)).toBeNull();
    expect(rowLane(null)).toBeNull();
    expect(rowLane("nonsense")).toBeNull();
  });
});

describe("deliveredToLabel", () => {
  it("joins known channel ids with their proper names", () => {
    expect(deliveredToLabel(["mac", "chrome"])).toBe("Mac · Chrome");
    expect(deliveredToLabel(["windows", "telegram", "android", "ios"])).toBe(
      "Windows · Telegram · Android · iPhone",
    );
  });

  it("accepts a string or labelled objects and dedupes", () => {
    expect(deliveredToLabel("Chrome")).toBe("Chrome");
    expect(deliveredToLabel([{ label: "Mac" }, { channel: "mac" }, { name: "Edge" }])).toBe(
      "Mac · Edge",
    );
  });

  it("absent or empty → null", () => {
    expect(deliveredToLabel(undefined)).toBeNull();
    expect(deliveredToLabel([])).toBeNull();
    expect(deliveredToLabel("  ")).toBeNull();
    expect(deliveredToLabel([42 as never])).toBeNull();
  });
});

describe("parseNotifBudget", () => {
  it("reads used/limit only when both are sane numbers", () => {
    expect(parseNotifBudget({ budget: { used: 2, limit: 5 } })).toEqual({ used: 2, limit: 5 });
    expect(parseNotifBudget({ budget: { used: 2 } })).toBeNull();
    expect(parseNotifBudget({ budget: { used: -1, limit: 5 } })).toBeNull();
    expect(parseNotifBudget({})).toBeNull();
    expect(parseNotifBudget(null)).toBeNull();
  });
});

describe("alertStripItems — the footer strip", () => {
  const web = (over: Record<string, unknown>) => ({
    kind: "web" as const,
    id: "w",
    browser: "chrome" as const,
    os: "macos" as const,
    current: false,
    createdAt: "2026-11-01T00:00:00.000Z",
    lastReceivedAt: null,
    health: "ok" as const,
    ...over,
  });

  it("names each desktop app, each browser once (best state), and always the phone", () => {
    const items = alertStripItems({
      phoneConfigured: true,
      endpoints: [
        { kind: "desktop", app: "mac", running: true, lastSeenAt: "2026-11-13T00:00:00Z" },
        { kind: "desktop", app: "windows", running: false, lastSeenAt: "2026-11-10T00:00:00Z" },
        web({ id: "a", health: "stale" }),
        web({ id: "b", health: "ok" }),
        web({ id: "c", browser: "firefox", needsResubscribe: true }),
      ] as AlertEndpointList["endpoints"],
    });
    expect(items.map((i) => [i.id, i.tone, i.statusKey])).toEqual([
      ["mac", "ok", "notifCenter.status.running"],
      ["windows", "off", "notifCenter.status.notRunning"],
      ["web:Chrome", "ok", "notifCenter.status.ok"],
      ["web:Firefox", "warn", "notifCenter.status.check"],
      ["phone", "off", "notifCenter.status.notConnected"],
    ]);
    expect(items[2].name).toEqual({
      key: "alertDevices.name.browserOnly",
      params: { browser: "Chrome" },
    });
  });

  it("a native app or a phone web push counts as the phone", () => {
    expect(
      alertStripItems({
        phoneConfigured: true,
        endpoints: [
          { kind: "native", id: "n", platform: "ios", registeredAt: "2026-11-01T00:00:00Z" },
        ],
      }).map((i) => [i.id, i.tone]),
    ).toEqual([["phone", "ok"]]);
    expect(
      alertStripItems({
        phoneConfigured: false,
        endpoints: [web({ os: "android", health: "new" })] as AlertEndpointList["endpoints"],
      }).map((i) => [i.id, i.tone, i.statusKey]),
    ).toEqual([["phone", "neutral", "notifCenter.status.new"]]);
  });

  it("an empty list still shows the phone as not connected", () => {
    expect(alertStripItems({ phoneConfigured: false, endpoints: [] })).toEqual([
      {
        id: "phone",
        name: { key: "notifCenter.device.phone", params: {} },
        tone: "off",
        statusKey: "notifCenter.status.notConnected",
      },
    ]);
  });
});

describe("lazy delivery lookup — GET /api/notifications/:id/delivery", () => {
  it("builds an encoded path", () => {
    expect(deliveryPath("a/b")).toBe("/api/notifications/a%2Fb/delivery");
  });

  it("reads deliveredTo from the response body, or nothing", () => {
    expect(parseDeliveryResponse({ deliveredTo: ["mac", "chrome"] })).toBe("Mac · Chrome");
    expect(parseDeliveryResponse({ deliveredTo: [] })).toBeNull();
    expect(parseDeliveryResponse({})).toBeNull();
    expect(parseDeliveryResponse(null)).toBeNull();
    expect(parseDeliveryResponse("mac")).toBeNull();
  });

  it("treats a 404 as 'route not there yet' and nothing else", () => {
    expect(isMissingRoute(new Error('API 404: {"error":"Not Found"}'))).toBe(true);
    expect(isMissingRoute(new Error("API 500: boom"))).toBe(false);
    expect(isMissingRoute("API 404")).toBe(false);
  });
});

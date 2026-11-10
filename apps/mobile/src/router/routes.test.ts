import { describe, expect, it } from "vitest";
import { popTab, pushTab, resolveBack } from "./back";
import { formatRoute, hasDetail, parseRoute, type Route, tabOf, withoutDetail } from "./routes";

describe("parseRoute / formatRoute", () => {
  const cases: Array<[string, string, Route]> = [
    ["/", "", { name: "today" }],
    ["/today", "", { name: "today" }],
    ["/mail", "", { name: "mail" }],
    ["/mail", "?lane=push", { name: "mail", lane: "PUSH" }],
    ["/mail/abc_123", "", { name: "mail", id: "abc_123" }],
    ["/mail/abc", "?lane=QUEUE", { name: "mail", lane: "QUEUE", id: "abc" }],
    ["/mail/subscriptions", "", { name: "mail", view: "subscriptions" }],
    ["/calendar", "", { name: "calendar" }],
    ["/calendar/evt-1", "", { name: "calendar", id: "evt-1" }],
    ["/files/f1", "", { name: "files", id: "f1" }],
    ["/assistant", "", { name: "assistant" }],
    ["/assistant/approvals", "", { name: "assistant", section: "approvals" }],
    ["/assistant/approvals/pa-1", "", { name: "assistant", section: "approvals", id: "pa-1" }],
    ["/accounts", "", { name: "accounts" }],
  ];
  it.each(cases)("%s%s", (path, search, route) => {
    expect(parseRoute(path, search)).toEqual(route);
  });

  it("round-trips every canonical route", () => {
    for (const [, , route] of cases) {
      const path = formatRoute(route);
      const [p, q = ""] = path.split("?");
      expect(parseRoute(p ?? "", q ? `?${q}` : "")).toEqual(route);
    }
  });

  it("ignores trailing slashes", () => {
    expect(parseRoute("/mail/abc/")).toEqual({ name: "mail", id: "abc" });
  });

  it("drops an unknown lane instead of inventing one (never AUTO/CALL)", () => {
    expect(parseRoute("/mail", "?lane=AUTO")).toEqual({ name: "mail" });
    expect(parseRoute("/mail", "?lane=CALL")).toEqual({ name: "mail" });
    expect(parseRoute("/mail", "?lane=all")).toEqual({ name: "mail", lane: "ALL" });
  });

  it("rejects malformed ids and unknown paths (deep links are external input)", () => {
    expect(parseRoute("/mail/<script>").name).toBe("notFound");
    expect(parseRoute("/mail/%E0%A4%A").name).toBe("notFound");
    expect(parseRoute(`/mail/${"a".repeat(129)}`).name).toBe("notFound");
    expect(parseRoute("/mail/a/b").name).toBe("notFound");
    expect(parseRoute("/assistant/firewall").name).toBe("notFound");
    expect(parseRoute("/inbox").name).toBe("notFound");
  });

  it("maps routes to tabs and details", () => {
    expect(tabOf({ name: "mail", id: "x" })).toBe("mail");
    expect(tabOf({ name: "accounts" })).toBeNull();
    expect(hasDetail({ name: "mail", id: "x" })).toBe(true);
    expect(hasDetail({ name: "mail", lane: "PUSH" })).toBe(false);
    expect(hasDetail({ name: "mail", view: "subscriptions" })).toBe(true);
    expect(withoutDetail({ name: "mail", view: "subscriptions" })).toEqual({ name: "mail" });
    expect(withoutDetail({ name: "mail", lane: "PUSH", id: "x" })).toEqual({
      name: "mail",
      lane: "PUSH",
    });
  });
});

describe("Android back (sheet → detail → previous tab → exit)", () => {
  it("closes an open sheet first", () => {
    expect(
      resolveBack({
        sheetOpen: true,
        route: { name: "mail", id: "x" },
        tabHistory: ["today", "mail"],
      }),
    ).toEqual({ kind: "closeSheet" });
  });

  it("then closes the detail, keeping the list filter", () => {
    expect(
      resolveBack({
        sheetOpen: false,
        route: { name: "mail", lane: "PUSH", id: "x" },
        tabHistory: ["today", "mail"],
      }),
    ).toEqual({ kind: "navigate", route: { name: "mail", lane: "PUSH" } });
  });

  it("then goes to the previous tab", () => {
    expect(
      resolveBack({
        sheetOpen: false,
        route: { name: "files" },
        tabHistory: ["today", "mail", "files"],
      }),
    ).toEqual({ kind: "navigate", route: { name: "mail" } });
  });

  it("falls back to Today, and exits from Today", () => {
    expect(resolveBack({ sheetOpen: false, route: { name: "settings" }, tabHistory: [] })).toEqual({
      kind: "navigate",
      route: { name: "today" },
    });
    expect(
      resolveBack({ sheetOpen: false, route: { name: "today" }, tabHistory: ["today"] }),
    ).toEqual({
      kind: "exit",
    });
  });

  it("keeps the tab history short and free of repeats", () => {
    expect(pushTab(["today"], "today")).toEqual(["today"]);
    expect(pushTab(["today", "mail"], "files", 2)).toEqual(["mail", "files"]);
    expect(popTab(["today", "mail", "files"], "mail")).toEqual(["today", "mail"]);
    expect(popTab(["files"], "today")).toEqual(["today"]);
  });
});

describe("settings routes", () => {
  it("parses and formats the settings sections", () => {
    expect(parseRoute("/settings")).toEqual({ name: "settings" });
    expect(parseRoute("/settings/plans")).toEqual({ name: "settings", section: "plans" });
    expect(parseRoute("/settings/delete-account")).toEqual({
      name: "settings",
      section: "delete-account",
    });
    expect(parseRoute("/settings/billing").name).toBe("notFound");
    expect(parseRoute("/settings/plans/x").name).toBe("notFound");
    expect(formatRoute({ name: "settings", section: "notifications" })).toBe(
      "/settings/notifications",
    );
    expect(tabOf({ name: "settings" })).toBeNull();
  });
});

describe("back from settings pages", () => {
  it("goes up to Settings before leaving", () => {
    const back = (route: Route) => resolveBack({ sheetOpen: false, route, tabHistory: ["today"] });
    expect(back({ name: "settings", section: "plans" })).toEqual({
      kind: "navigate",
      route: { name: "settings" },
    });
    expect(back({ name: "accounts" })).toEqual({ kind: "navigate", route: { name: "settings" } });
    expect(back({ name: "settings" })).toEqual({ kind: "navigate", route: { name: "today" } });
  });
});

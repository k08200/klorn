/**
 * Mail v2 list model (productization plan P5, MAIL_V2) — the pure rules of the
 * lane-first list in packages/web/src/app/email/_v2/model.ts.
 */

import type { InboxOption } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import {
  accountOptions,
  DEFAULT_LANE,
  formatRowTime,
  isLaneView,
  isNarrowed,
  type ListView,
  laneSegments,
  listRequestPath,
  readerQueue,
  rowAccount,
  senderName,
} from "../../../web/src/app/email/_v2/model";

const view = (overrides: Partial<ListView> = {}): ListView => ({
  lane: "QUEUE",
  account: "all",
  filter: "none",
  search: "",
  ...overrides,
});

function inbox(overrides: Partial<InboxOption>): InboxOption {
  return {
    id: null,
    email: "me@gmail.com",
    kind: "primary",
    needsReconnect: false,
    provider: "GOOGLE",
    purpose: null,
    ...overrides,
  };
}

describe("lane control", () => {
  it("defaults to QUEUE and never offers SILENT as a standing segment", () => {
    expect(DEFAULT_LANE).toBe("QUEUE");
    expect(laneSegments("QUEUE")).toEqual(["PUSH", "MEETING", "QUEUE", "INFO", "ALL"]);
    expect(laneSegments("ALL")).not.toContain("SILENT");
  });

  it("shows SILENT only while it is the current view", () => {
    expect(laneSegments("SILENT")).toEqual(["PUSH", "MEETING", "QUEUE", "INFO", "ALL", "SILENT"]);
  });

  it("accepts the five live lanes and ALL — never a retired value", () => {
    for (const lane of ["PUSH", "MEETING", "QUEUE", "INFO", "SILENT", "ALL"]) {
      expect(isLaneView(lane)).toBe(true);
    }
    for (const value of ["AUTO", "CALL", "queue", "", null, undefined]) {
      expect(isLaneView(value)).toBe(false);
    }
  });
});

describe("listRequestPath", () => {
  it("always sends the lane, and omits what is at its default", () => {
    expect(listRequestPath(view(), 1)).toBe("/api/email?page=1&tier=QUEUE");
    expect(listRequestPath(view({ lane: "ALL" }), 3)).toBe("/api/email?page=3&tier=ALL");
  });

  it("threads the account, filter and search through", () => {
    const path = listRequestPath(
      view({ lane: "PUSH", account: "linked-1", filter: "unread", search: "  invoice " }),
      2,
    );
    const params = new URL(path, "http://x").searchParams;
    expect(Object.fromEntries(params)).toEqual({
      search: "invoice",
      page: "2",
      filter: "unread",
      inbox: "linked-1",
      tier: "PUSH",
    });
  });

  it("threads view uses its own endpoint, which takes no lane or account", () => {
    expect(listRequestPath(view({ filter: "threads", account: "linked-1", search: "q" }), 1)).toBe(
      "/api/email/threads?search=q&page=1",
    );
  });
});

describe("view helpers", () => {
  it("isNarrowed ignores the lane", () => {
    expect(isNarrowed(view({ lane: "PUSH" }))).toBe(false);
    expect(isNarrowed(view({ filter: "unread" }))).toBe(true);
    expect(isNarrowed(view({ account: "primary" }))).toBe(true);
    expect(isNarrowed(view({ search: " " }))).toBe(false);
    expect(isNarrowed(view({ search: "a" }))).toBe(true);
  });

  it("readerQueue maps to a queue the reader knows", () => {
    expect(readerQueue("none")).toBe("all");
    expect(readerQueue("threads")).toBe("all");
    expect(readerQueue("reply-needed")).toBe("reply-needed");
  });
});

describe("accounts", () => {
  const inboxes = [
    inbox({}),
    inbox({ id: "l-1", kind: "linked", provider: "OUTLOOK", email: "me@outlook.com" }),
    inbox({ id: "l-2", kind: "linked", provider: "GOOGLE", email: "work-account-long@corp.com" }),
    inbox({ id: "l-3", kind: "linked", provider: "NAVER", email: null, needsReconnect: true }),
  ];
  const options = accountOptions(inboxes);

  it("maps each inbox to the list API's scope value", () => {
    expect(options.map((o) => o.scope)).toEqual(["primary", "l-1", "l-2", "l-3"]);
    expect(options[3].needsReconnect).toBe(true);
  });

  it("adds a nickname only where the provider alone is ambiguous", () => {
    expect(options.map((o) => o.nickname)).toEqual(["me@", null, "work-account…@", null]);
  });

  it("resolves a row to its own account — never assumes the primary", () => {
    expect(rowAccount({ linkedInboxAccountId: null }, options)?.scope).toBe("primary");
    expect(rowAccount({ linkedInboxAccountId: "l-1" }, options)?.provider).toBe("OUTLOOK");
    expect(rowAccount({ linkedInboxAccountId: "gone" }, options)).toBeNull();
    expect(rowAccount({ linkedInboxAccountId: null }, options.slice(1))).toBeNull();
  });
});

describe("row wording", () => {
  it("senderName drops the address when there is a display name", () => {
    expect(senderName("Ada Lovelace <ada@x.com>")).toBe("Ada Lovelace");
    expect(senderName('"김민수" <minsu@naver.com>')).toBe("김민수");
    expect(senderName("<ada@x.com>")).toBe("ada@x.com");
    expect(senderName("ada@x.com")).toBe("ada@x.com");
  });

  it("formatRowTime: clock today, weekday this week, then the date", () => {
    const now = new Date("2026-10-03T12:00:00Z");
    const at = (iso: string) => formatRowTime(iso, now, "en-US", "Asia/Seoul");
    expect(at("2026-10-03T00:41:00Z")).toBe("9:41 AM");
    expect(at("2026-10-01T03:00:00Z")).toBe("Thu");
    expect(at("2026-09-12T03:00:00Z")).toBe("Sep 12");
    expect(at("2025-12-30T03:00:00Z")).toBe("Dec 30, 25");
    expect(at("not a date")).toBe("");
  });

  it("formatRowTime decides 'today' in the user's zone, not UTC", () => {
    // 2026-10-02 16:30 UTC is already Oct 3 in Seoul.
    const now = new Date("2026-10-03T01:00:00Z");
    expect(formatRowTime("2026-10-02T16:30:00Z", now, "en-US", "Asia/Seoul")).toBe("1:30 AM");
    expect(formatRowTime("2026-10-02T16:30:00Z", now, "en-US", "UTC")).toBe("Fri");
  });
});

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
  rangeIds,
  readerContextPath,
  readerQueue,
  rowAccount,
  rowLane,
  senderName,
  showsLaneChip,
  viewTally,
} from "../../../web/src/app/email/_v2/model";
import { NO_LIST_CONTEXT, parseListContext } from "../../../web/src/app/email/_v2/reader-handoff";
import { REMINDER_KEYS, reminderDate } from "../../../web/src/app/email/_v2/reminders";
import { readerLeaveHref } from "../../../web/src/app/email/[id]/_v2/reader-model";

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

describe("list polish (P5b)", () => {
  it("rows carry a lane chip only where the view mixes lanes", () => {
    for (const lane of ["PUSH", "MEETING", "QUEUE", "INFO"] as const) {
      expect(showsLaneChip(view({ lane }))).toBe(false);
    }
    expect(showsLaneChip(view({ lane: "ALL" }))).toBe(true);
    expect(showsLaneChip(view({ lane: "SILENT" }))).toBe(true);
    expect(showsLaneChip(view({ lane: "QUEUE", search: " invoice " }))).toBe(true);
    expect(showsLaneChip(view({ lane: "QUEUE", search: "   " }))).toBe(false);
  });

  it("a row whose lane differs from the selected one keeps its chip; no lane is never guessed", () => {
    expect(rowLane(view({ lane: "QUEUE" }), "QUEUE")).toBeNull();
    expect(rowLane(view({ lane: "QUEUE" }), "INFO")).toBe("INFO");
    expect(rowLane(view({ lane: "ALL" }), "QUEUE")).toBe("QUEUE");
    expect(rowLane(view({ lane: "ALL" }), null)).toBeNull();
    expect(rowLane(view({ lane: "QUEUE" }), null)).toBeNull();
  });

  const counts = {
    PUSH: { total: 4, unread: 1 },
    MEETING: { total: 2, unread: 0 },
    QUEUE: { total: 132, unread: 12 },
    INFO: { total: 60, unread: 5 },
    SILENT: { total: 9, unread: 9 },
  };

  it("the header tally is the list's own total plus the lane's unread", () => {
    expect(viewTally(view({ lane: "QUEUE" }), counts, 132)).toEqual({ total: 132, unread: 12 });
    expect(viewTally(view({ lane: "ALL" }), counts, 207)).toEqual({ total: 207, unread: 27 });
  });

  it("claims no unread count the lane counts cannot answer for", () => {
    expect(viewTally(view({ filter: "attachments" }), counts, 7).unread).toBeNull();
    expect(viewTally(view({ search: "invoice" }), counts, 3).unread).toBeNull();
    expect(viewTally(view(), null, 132)).toEqual({ total: 132, unread: null });
  });

  it("a Shift-click selects the rows between the anchor and the target, either way round", () => {
    const ids = ["a", "b", "c", "d", "e"];
    expect(rangeIds(ids, "b", "d")).toEqual(["b", "c", "d"]);
    expect(rangeIds(ids, "d", "b")).toEqual(["b", "c", "d"]);
    expect(rangeIds(ids, "c", "c")).toEqual(["c"]);
    // No anchor, or an anchor that left the list: just the clicked row.
    expect(rangeIds(ids, null, "d")).toEqual(["d"]);
    expect(rangeIds(ids, "gone", "d")).toEqual(["d"]);
  });
});

describe("reader context (P5b)", () => {
  it("asks for the neighbours of the view the mail was opened from", () => {
    expect(readerContextPath("e1", view({ lane: "PUSH" }))).toBe(
      "/api/email/e1/reader-context?tier=PUSH",
    );
    expect(
      readerContextPath("e 1", view({ lane: "ALL", account: "linked-1", filter: "unread" })),
    ).toBe("/api/email/e%201/reader-context?tier=ALL&inbox=linked-1&filter=unread");
    expect(readerContextPath("e1", view({ search: " q4 plan " }))).toBe(
      "/api/email/e1/reader-context?tier=QUEUE&search=q4+plan",
    );
  });

  it("threads are not a lane page: the reader walks the lane itself", () => {
    expect(readerContextPath("e1", view({ filter: "threads" }))).toBe(
      "/api/email/e1/reader-context?tier=QUEUE",
    );
  });

  it("a stored list context is validated field by field", () => {
    expect(parseListContext(null)).toEqual(NO_LIST_CONTEXT);
    expect(parseListContext("PUSH")).toEqual(NO_LIST_CONTEXT);
    expect(
      parseListContext({ lane: "INFO", account: "linked-1", filter: "unread", search: "x" }),
    ).toEqual({ lane: "INFO", account: "linked-1", filter: "unread", search: "x" });
    // A retired lane, an unknown filter and a non-string search fall back.
    expect(parseListContext({ lane: "AUTO", account: 7, filter: "candidates", search: 5 })).toEqual(
      NO_LIST_CONTEXT,
    );
    expect(NO_LIST_CONTEXT.lane).toBe("ALL");
  });

  it("leaving the reader: the next mail opens unread-preserving, or the list, with the undo offer", () => {
    expect(readerLeaveHref("e2")).toBe("/email/e2?markRead=false");
    expect(readerLeaveHref(null)).toBe("/email");
    const undo = new URLSearchParams({ undoAction: "archive", undoGmailId: "g1" });
    expect(readerLeaveHref("e2", undo)).toBe(
      "/email/e2?undoAction=archive&undoGmailId=g1&markRead=false",
    );
    expect(readerLeaveHref(null, undo)).toBe("/email?undoAction=archive&undoGmailId=g1");
    // The carried params are not mutated.
    expect(undo.has("markRead")).toBe(false);
  });
});

describe("reminders (P5b)", () => {
  const now = new Date(2026, 9, 8, 15, 30, 0, 0);

  it("offers later today, tomorrow and next week", () => {
    expect(REMINDER_KEYS).toEqual(["later-today", "tomorrow", "next-week"]);
  });

  it("later today is four hours on; the others are 09:00 local", () => {
    expect(reminderDate("later-today", now)).toEqual(new Date(2026, 9, 8, 19, 30, 0, 0));
    expect(reminderDate("tomorrow", now)).toEqual(new Date(2026, 9, 9, 9, 0, 0, 0));
    expect(reminderDate("next-week", now)).toEqual(new Date(2026, 9, 15, 9, 0, 0, 0));
  });

  it("does not mutate the time it was given", () => {
    reminderDate("next-week", now);
    expect(now).toEqual(new Date(2026, 9, 8, 15, 30, 0, 0));
  });
});

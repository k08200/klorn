import type { FirewallResponse, InboxOption } from "@klorn/contract";
import { describe, expect, it } from "vitest";
import { ApiError } from "../../api/client";
import { MOCK_INBOXES, mockFirewall } from "../../api/mock/fixtures";
import { canSubmit, initialLane, SHEET_LANES, senderLabel, submitPlan } from "./lane-sheet-model";
import {
  accountOf,
  addressOf,
  allLanesTotal,
  attentionByEmail,
  avatarTone,
  draftErrorKey,
  flattenPages,
  groupByDay,
  mailWriteBlocked,
  monogram,
  neighbours,
  parseRecipients,
  rarelyRead,
  readPercent,
  readTone,
  replySubject,
  sendAccountId,
  sendableAccounts,
  sendFailure,
  sendPayloadCanonical,
  sendPayloadHash,
  splitSender,
  subscriptionStats,
  visibleRows,
} from "./model";
import { snoozeOptions, snoozeTime } from "./snooze";

const NOW = new Date(2026, 9, 16, 10, 28); // Fri 16 Oct 2026, 10:28 local

describe("lane sheet", () => {
  it("offers exactly the five live lanes, never a retired one", () => {
    expect(SHEET_LANES).toEqual(["PUSH", "MEETING", "QUEUE", "INFO", "SILENT"]);
  });

  it("preselects SILENT from a left swipe, the current lane otherwise", () => {
    expect(initialLane("swipe", "INFO")).toBe("SILENT");
    expect(initialLane("swipe", null)).toBe("SILENT");
    expect(initialLane("swipe", "SILENT")).toBe("QUEUE");
    expect(initialLane("menu", "PUSH")).toBe("PUSH");
    expect(initialLane("menu", null)).toBe("QUEUE");
  });

  it("only submits a real change", () => {
    expect(canSubmit({ selected: "INFO", pin: false }, "INFO")).toBe(false);
    expect(canSubmit({ selected: "INFO", pin: true }, "INFO")).toBe(true);
    expect(canSubmit({ selected: "SILENT", pin: false }, "INFO")).toBe(true);
    expect(submitPlan({ selected: "INFO", pin: true }, "INFO")).toEqual({
      move: false,
      pin: true,
      tier: "INFO",
    });
    expect(submitPlan({ selected: "SILENT", pin: false }, null)).toEqual({
      move: true,
      pin: false,
      tier: "SILENT",
    });
  });

  it("names the sender from a From header", () => {
    expect(senderLabel("한끼배달 <no-reply@hankki.example>")).toBe("한끼배달");
    expect(senderLabel('"Mark Chen" <mark@capital.example>')).toBe("Mark Chen");
    expect(senderLabel("<a@b.example>")).toBe("a@b.example");
    expect(senderLabel("a@b.example")).toBe("a@b.example");
  });
});

describe("day sections", () => {
  it("groups newest-first rows into today / yesterday / dates", () => {
    const at = (d: number, h: number) => new Date(2026, 9, d, h).toISOString();
    const sections = groupByDay(
      [
        { id: "a", date: at(16, 9) },
        { id: "b", date: at(16, 8) },
        { id: "c", date: at(15, 22) },
        { id: "d", date: at(13, 10) },
      ],
      NOW,
    );
    expect(sections.map((s) => [s.key, s.rows.length])).toEqual([
      ["today", 2],
      ["yesterday", 1],
      ["2026-10-13", 1],
    ]);
  });
});

describe("senders and accounts", () => {
  it("splits the artboard's 'name · org' label and picks a monogram", () => {
    expect(splitSender("박서연 · 한빛파트너스")).toEqual({ name: "박서연", org: "한빛파트너스" });
    expect(splitSender("Mark Chen")).toEqual({ name: "Mark Chen", org: null });
    expect(monogram("박서연")).toBe("박");
    expect(monogram('"mark"')).toBe("M");
    expect(monogram("")).toBe("?");
    expect(avatarTone("박서연")).toBe(avatarTone("박서연"));
  });

  it("maps a row to its connected account (null = primary)", () => {
    expect(accountOf(null, MOCK_INBOXES.inboxes)?.kind).toBe("primary");
    expect(accountOf("inbox-work", MOCK_INBOXES.inboxes)?.email).toBe("jisu@hanbit.example");
    expect(accountOf("gone", MOCK_INBOXES.inboxes)).toBeNull();
  });

  it("finds each mail's open attention item for Done / Later", () => {
    const map = attentionByEmail(mockFirewall(NOW.getTime()) as FirewallResponse);
    expect(map.get("email-att-push-1")).toEqual({
      itemId: "att-push-1",
      tierReason: "오늘 18시 마감 · 두 번 언급",
    });
    expect(attentionByEmail(undefined).size).toBe(0);
  });

  it("addresses a reply the way the server's /reply route does", () => {
    expect(addressOf("박서연 <seoyeon@x.example>")).toBe("seoyeon@x.example");
    expect(replySubject("Re: 투자")).toBe("Re: 투자");
    expect(replySubject("계약서")).toBe("Re: 계약서");
  });

  it("validates recipients at the boundary", () => {
    expect(parseRecipients("a@b.example, Kim <k@c.example>")).toEqual([
      "a@b.example",
      "k@c.example",
    ]);
    expect(parseRecipients("not an address")).toBeNull();
    expect(parseRecipients("")).toBeNull();
  });

  it("offers only accounts that can send a new mail, primary first", () => {
    const inbox = (over: Partial<InboxOption>): InboxOption => ({
      id: "x",
      email: "x@example.com",
      kind: "linked",
      needsReconnect: false,
      provider: "GOOGLE",
      purpose: null,
      ...over,
    });
    const work = inbox({ id: "w", provider: "GOOGLE" });
    const naver = inbox({ id: "n", provider: "NAVER" });
    const primary = inbox({ id: null, kind: "primary" });
    const accounts = sendableAccounts([
      work,
      inbox({ id: "i", provider: "ICLOUD", needsReconnect: true }),
      inbox({ id: "g", provider: "IMAP" }),
      naver,
      primary,
    ]);
    expect(accounts.map((a) => a.id)).toEqual([null, "w", "n"]);
    // The send body: null = the primary inbox, else the linked inbox id.
    expect(sendAccountId(primary)).toBeNull();
    expect(sendAccountId(null)).toBeNull();
    expect(sendAccountId(work)).toBe("w");
  });
});

describe("list helpers", () => {
  const row = (id: string) => ({ id, emails: [] }) as never;
  it("keeps cleared rows out until their time, and de-duplicates pages", () => {
    const rows = [{ id: "a" }, { id: "b" }] as never[];
    expect(
      visibleRows(rows, new Map([["a", 2000]]), 1000).map((r: { id: string }) => r.id),
    ).toEqual(["b"]);
    expect(visibleRows(rows, new Map([["a", 500]]), 1000)).toHaveLength(2);
    expect(
      flattenPages([{ emails: rows }, { emails: [{ id: "b" }, { id: "c" }] as never[] }]).map(
        (r) => r.id,
      ),
    ).toEqual(["a", "b", "c"]);
    expect(row).toBeTypeOf("function");
  });

  it("finds the reader's previous / next mail", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }];
    expect(neighbours(rows, "b")).toEqual({ newerId: "a", olderId: "c" });
    expect(neighbours(rows, "a")).toEqual({ newerId: null, olderId: "b" });
    expect(neighbours(rows, "x")).toEqual({ newerId: null, olderId: null });
  });

  it("totals every lane but SILENT for 전체", () => {
    const c = (n: number) => ({ total: n, unread: 0 });
    expect(
      allLanesTotal({ PUSH: c(2), MEETING: c(3), QUEUE: c(14), INFO: c(21), SILENT: c(48) }),
    ).toBe(40);
    expect(allLanesTotal(undefined)).toBeNull();
  });
});

describe("send receipt hash", () => {
  it("canonicalises exactly like the server's sendEmailPayloadHash", () => {
    expect(sendPayloadCanonical({ to: " A@B.example ", subject: "Re: x", body: "hi" })).toBe(
      '{"v":"v1","action":"send_email","to":"a@b.example","subject":"Re: x","body":"hi"}',
    );
  });

  it("is a sha256 hex digest (the server's value for the same bytes)", async () => {
    // node: crypto.createHash("sha256").update(canonical).digest("hex")
    const { createHash } = await import("node:crypto");
    const input = { to: "seoyeon@x.example", subject: "Re: 계약서", body: "서연님, 확인했습니다." };
    expect(await sendPayloadHash(input)).toBe(
      createHash("sha256").update(sendPayloadCanonical(input)).digest("hex"),
    );
  });
});

describe("snooze presets", () => {
  it("computes local times and skips presets that are already past", () => {
    expect(snoozeTime("thisEvening", NOW)).toEqual(new Date(2026, 9, 16, 18));
    expect(snoozeTime("tomorrowMorning", NOW)).toEqual(new Date(2026, 9, 17, 9));
    expect(snoozeTime("weekend", NOW)).toEqual(new Date(2026, 9, 17, 9)); // Sat 17th
    expect(snoozeTime("nextWeek", NOW)).toEqual(new Date(2026, 9, 19, 9)); // Mon 19th
    expect(snoozeTime("laterToday", NOW)).toEqual(new Date(2026, 9, 16, 14));
    const late = new Date(2026, 9, 16, 20, 5);
    expect(snoozeTime("thisEvening", late)).toBeNull();
    expect(snoozeTime("laterToday", late)).toBeNull();
    // Friday evening: "tomorrow morning" is Saturday 09:00 — the weekend preset — shown once.
    expect(snoozeOptions(late).map((o) => o.preset)).toEqual(["tomorrowMorning", "nextWeek"]);
    const wednesday = new Date(2026, 9, 14, 10);
    expect(snoozeOptions(wednesday).map((o) => o.preset)).toEqual([
      "laterToday",
      "thisEvening",
      "tomorrowMorning",
      "weekend",
      "nextWeek",
    ]);
  });

  it("never returns a time in the past", () => {
    const satEarly = new Date(2026, 9, 17, 7);
    expect(snoozeTime("weekend", satEarly)).toEqual(new Date(2026, 9, 17, 9));
    const satLate = new Date(2026, 9, 17, 12);
    expect(snoozeTime("weekend", satLate)).toEqual(new Date(2026, 9, 24, 9));
    // On a Monday, "next week" is the Monday after — never today.
    expect(snoozeTime("nextWeek", new Date(2026, 9, 19, 8))).toEqual(new Date(2026, 9, 26, 9));
  });
});

describe("subscriptions", () => {
  const sub = (count: number, unreadCount: number) => ({
    sender: "n@x.example",
    displayName: null,
    linkedInboxAccountId: null,
    accountLabel: null,
    count,
    unreadCount,
    lastReceivedAt: NOW.toISOString(),
    method: "one-click" as const,
  });

  it("computes read rates, tones and the rarely-read set", () => {
    expect(readPercent(sub(50, 49))).toBe(2);
    expect(readPercent(sub(0, 0))).toBe(0);
    expect(readPercent(sub(10, 20))).toBe(0);
    expect(readTone(2)).toBe("danger");
    expect(readTone(30)).toBe("warn");
    expect(readTone(71)).toBe("ok");
    expect(rarelyRead([sub(10, 10), sub(10, 1)])).toHaveLength(1);
    expect(subscriptionStats([sub(10, 10), sub(10, 0)])).toEqual({
      senders: 2,
      mail: 20,
      readPercent: 50,
    });
  });
});

describe("write refusals: only the entitlement refusal says Pro", () => {
  const http = (status: number, serverCode: string | null = null) =>
    new ApiError("http", status, `HTTP ${status}`, null, serverCode);
  const proRefusal = http(403, "ENTITLEMENT_REQUIRED");
  const offline = new ApiError("network", 0, "offline", null);

  it("a draft refusal that carries ENTITLEMENT_REQUIRED needs Pro", () => {
    expect(draftErrorKey(proRefusal)).toBe("reader.draft.notEntitled");
  });

  it("any other 403 is the generic draft error, not a Pro prompt", () => {
    expect(draftErrorKey(http(403))).toBe("reader.draft.unavailable");
    expect(draftErrorKey(http(403, "OTHER"))).toBe("reader.draft.unavailable");
    expect(draftErrorKey(http(402))).toBe("reader.draft.unavailable");
  });

  it("keeps offline, rate limit and unknown failures apart", () => {
    expect(draftErrorKey(offline)).toBe("reader.draft.offline");
    expect(draftErrorKey(http(429))).toBe("reader.draft.rateLimited");
    expect(draftErrorKey(new Error("boom"))).toBe("reader.draft.unavailable");
  });

  it("a send refused for the plan says Pro; nothing about it is 'unknown'", () => {
    expect(sendFailure(proRefusal, { kind: "reply", accountId: null })).toEqual({
      unknown: false,
      message: "reader.draft.notEntitled",
    });
  });

  it("any other 403 on send is the plain failure", () => {
    expect(sendFailure(http(403), { kind: "new", accountId: null })).toEqual({
      unknown: false,
      message: "reader.send.failed",
    });
  });

  it("keeps the send-specific outcomes", () => {
    expect(sendFailure(http(502), { kind: "reply", accountId: null })).toEqual({
      unknown: true,
      message: "reader.send.unknown",
    });
    expect(sendFailure(offline, { kind: "new", accountId: null }).message).toBe(
      "reader.send.offline",
    );
    expect(sendFailure(http(501), { kind: "new", accountId: null }).message).toBe(
      "reader.send.unsupportedAccount",
    );
    expect(sendFailure(http(501), { kind: "reply", accountId: null }).message).toBe(
      "reader.send.failed",
    );
    expect(sendFailure(http(404), { kind: "new", accountId: "acc1" }).message).toBe(
      "reader.send.accountGone",
    );
    expect(sendFailure(http(404), { kind: "new", accountId: null }).message).toBe(
      "reader.send.failed",
    );
  });
});

describe("mailWriteBlocked (no editor for a mail that could not be sent)", () => {
  it("is true only when the server says this account is not entitled", () => {
    expect(mailWriteBlocked({ entitled: false })).toBe(true);
  });

  it("is false for a paid account, and while the answer is unknown or absent", () => {
    expect(mailWriteBlocked({ entitled: true })).toBe(false);
    expect(mailWriteBlocked({})).toBe(false); // an older server, or the paywall off
    expect(mailWriteBlocked(undefined)).toBe(false); // /me still loading
    expect(mailWriteBlocked(null)).toBe(false);
  });
});

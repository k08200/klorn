/**
 * Notification center reads (NC1): the optional lane / reason / held / group
 * on each GET /api/notifications row, and the lazy per-row delivery read.
 * Real modules over the in-memory database; every read is counted so a page
 * of 50 rows costs the same queries as a page of 1.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationDTO } from "../background.js";
import { createFakeDb, type FakeDb, type Row } from "./helpers/fake-db.js";

const dbHolder = vi.hoisted(() => ({ current: null as unknown }));
const queries = vi.hoisted(() => [] as string[]);

vi.mock("../db.js", async () => {
  const { fakePrismaClient } = await import("./helpers/fake-db.js");
  const { countingClient } = await import("./helpers/counting-client.js");
  const prisma = countingClient(
    fakePrismaClient(() => dbHolder.current as FakeDb),
    queries,
  );
  return { prisma, db: prisma };
});

import { enrichNotifications, notificationDelivery } from "../notify/notification-center.js";

const USER = "user-1";
const OTHER = "user-2";
const HOUR = 3_600_000;
// 2026-11-14 10:00 Seoul.
const NOW = new Date("2026-11-14T01:00:00.000Z");
const en = async () => "en" as const;

let db: FakeDb;

function mail(id: string, overrides: Row = {}): Row {
  return {
    id,
    userId: USER,
    gmailId: `g-${id}`,
    from: "Alice <alice@example.com>",
    to: "me@example.com",
    subject: "Contract",
    body: "Hi, Please sign the contract by 5pm today. Thanks",
    receivedAt: new Date(NOW.getTime() - HOUR),
    needsReply: false,
    ...overrides,
  };
}

function item(id: string, emailId: string, overrides: Row = {}): Row {
  return {
    id,
    userId: USER,
    source: "EMAIL",
    sourceId: emailId,
    type: "REPLY_NEEDED",
    title: "Contract",
    tier: "PUSH",
    tierReason: "Signature needed today",
    status: "OPEN",
    ...overrides,
  };
}

function bell(id: string, overrides: Partial<NotificationDTO> = {}): NotificationDTO {
  return {
    id,
    type: "email",
    title: "Urgent email",
    message: "Alice: Contract [g]",
    isRead: false,
    link: null,
    conversationId: null,
    sourceEmailId: null,
    pendingActionId: null,
    pendingActionStatus: null,
    createdAt: new Date(NOW.getTime() - HOUR).toISOString(),
    ...overrides,
  };
}

function seed(tables: Partial<Record<string, Row[]>> = {}) {
  db = createFakeDb({
    automationConfig: [{ id: "cfg", userId: USER, timezone: "Asia/Seoul" }],
    emailMessage: [],
    attentionItem: [],
    notification: [],
    pushDeliveryLog: [],
    ...tables,
  });
  dbHolder.current = db;
}

beforeEach(() => {
  queries.length = 0;
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  delete process.env.JUDGE_V3_POLICY;
  delete process.env.JUDGE_V3_SHADOW;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("enrichNotifications — fields", () => {
  it("adds lane, reason (unverified tierReason), held and group to a mail row", async () => {
    seed({ emailMessage: [mail("e1")], attentionItem: [item("i1", "e1")] });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e1" })], {
      language: en,
    });
    expect(row).toMatchObject({
      id: "n1",
      lane: "PUSH",
      reason: { text: "Signature needed today", verified: false },
      held: false,
      group: "now",
    });
    expect(row.reason).not.toHaveProperty("quote");
  });

  it("verified quote for a user under policy v3 when the evidence is in the mail", async () => {
    process.env.JUDGE_V3_POLICY = "true";
    process.env.JUDGE_V3_SHADOW = "true";
    seed({
      emailMessage: [mail("e1")],
      attentionItem: [
        item("i1", "e1", {
          v3PolicyVersion: "v3.1",
          v3Decision: {
            basis: "llm",
            reasons: [
              {
                code: "ask_due_soon",
                fact: "asks[0]",
                evidence: "please sign the contract by 5pm today",
                params: {},
              },
            ],
            threadTurn: null,
          },
        }),
      ],
    });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e1" })], {
      language: en,
    });
    expect(row.reason).toEqual({
      text: "Signature needed today",
      verified: true,
      quote: "please sign the contract by 5pm today",
      quoteIn: "body",
    });
  });

  it("the same stored evidence is NOT verified for a user outside policy v3", async () => {
    seed({
      emailMessage: [mail("e1")],
      attentionItem: [
        item("i1", "e1", {
          v3PolicyVersion: "v3.1",
          v3Decision: {
            basis: "llm",
            reasons: [
              { code: "ask", fact: "asks[0]", evidence: "please sign the contract", params: {} },
            ],
            threadTurn: null,
          },
        }),
      ],
    });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e1" })], {
      language: en,
    });
    expect(row.reason).toEqual({ text: "Signature needed today", verified: false });
  });

  it("held while the interrupt budget hold is live", async () => {
    seed({
      emailMessage: [mail("e1")],
      attentionItem: [
        item("i1", "e1", {
          tier: "QUEUE",
          heldAt: new Date(NOW.getTime() - HOUR),
          tierReason: "email.heldByInterruptBudget",
        }),
      ],
    });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e1" })], {
      language: en,
    });
    expect(row.held).toBe(true);
    expect(row.lane).toBe("QUEUE");
    expect(row.reason?.text).toMatch(/^Held: daily interrupt budget reached/);
  });

  it("folds a retired lane value: CALL reads as PUSH", async () => {
    seed({ emailMessage: [mail("e1")], attentionItem: [item("i1", "e1", { tier: "CALL" })] });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e1" })], {
      language: en,
    });
    expect(row.lane).toBe("PUSH");
  });

  it("a row with no mail gets only a group; a mail with no item gets no lane or reason", async () => {
    seed({ emailMessage: [mail("e1")] });
    const [plain, noItem] = await enrichNotifications(
      USER,
      [bell("n1", { type: "briefing" }), bell("n2", { sourceEmailId: "e1" })],
      { language: en },
    );
    expect(plain).toEqual({ ...bell("n1", { type: "briefing" }), group: "later" });
    expect(noItem).not.toHaveProperty("lane");
    expect(noItem).not.toHaveProperty("reason");
    expect(noItem).not.toHaveProperty("held");
    expect(noItem.group).toBe("later");
  });

  it("keeps every existing field unchanged (additive only)", async () => {
    seed({ emailMessage: [mail("e1")], attentionItem: [item("i1", "e1")] });
    const input = bell("n1", { sourceEmailId: "e1", pendingActionStatus: null });
    const [row] = await enrichNotifications(USER, [input], { language: en });
    for (const [key, value] of Object.entries(input)) {
      expect(row[key as keyof typeof row]).toEqual(value);
    }
  });

  it("groups by the rules: read → done, needs reply → reply, MEETING today → today", async () => {
    seed({
      emailMessage: [mail("e-read"), mail("e-reply", { needsReply: true }), mail("e-meet")],
      attentionItem: [
        item("i-read", "e-read"),
        item("i-reply", "e-reply", { tier: "QUEUE" }),
        item("i-meet", "e-meet", { tier: "MEETING" }),
      ],
    });
    const rows = await enrichNotifications(
      USER,
      [
        bell("n-read", { sourceEmailId: "e-read", isRead: true }),
        bell("n-reply", { sourceEmailId: "e-reply" }),
        bell("n-meet", { sourceEmailId: "e-meet" }),
      ],
      { language: en },
    );
    expect(rows.map((r) => r.group)).toEqual(["done", "reply", "today"]);
  });
});

describe("enrichNotifications — tenancy", () => {
  it("never reads another user's mail or item, even when a row names it", async () => {
    seed({
      emailMessage: [mail("e-x", { userId: OTHER })],
      attentionItem: [item("i-x", "e-x", { userId: OTHER })],
    });
    const [row] = await enrichNotifications(USER, [bell("n1", { sourceEmailId: "e-x" })], {
      language: en,
    });
    expect(row).not.toHaveProperty("lane");
    expect(row).not.toHaveProperty("reason");
    expect(row.group).toBe("later");
  });
});

describe("enrichNotifications — query count (no N+1)", () => {
  function page(n: number) {
    const mails: Row[] = [];
    const items: Row[] = [];
    const rows: NotificationDTO[] = [];
    for (let i = 0; i < n; i += 1) {
      mails.push(mail(`e${i}`));
      items.push(item(`i${i}`, `e${i}`, { tier: i % 2 ? "MEETING" : "PUSH" }));
      rows.push(bell(`n${i}`, { sourceEmailId: `e${i}`, type: i % 3 ? "email" : "reminder" }));
    }
    return { mails, items, rows };
  }

  async function countFor(n: number, policy: boolean): Promise<string[]> {
    if (policy) {
      process.env.JUDGE_V3_POLICY = "true";
      process.env.JUDGE_V3_SHADOW = "true";
    }
    const { mails, items, rows } = page(n);
    const v3 = {
      v3PolicyVersion: "v3.1",
      v3Decision: {
        basis: "llm",
        reasons: [
          { code: "ask", fact: "asks[0]", evidence: "please sign the contract", params: {} },
        ],
        threadTurn: null,
      },
    };
    seed({
      emailMessage: mails,
      attentionItem: policy ? items.map((r) => ({ ...r, ...v3 })) : items,
    });
    queries.length = 0;
    const out = await enrichNotifications(USER, rows, { language: en });
    expect(out).toHaveLength(n);
    return [...queries].sort();
  }

  it("a page of 50 makes the same queries as a page of 1", async () => {
    const one = await countFor(1, false);
    const fifty = await countFor(50, false);
    expect(fifty).toEqual(one);
    expect(fifty.length).toBeLessThanOrEqual(3);
  });

  it("under policy v3 the body check adds one batched read, not one per row", async () => {
    const one = await countFor(1, true);
    const fifty = await countFor(50, true);
    expect(fifty).toEqual(one);
    expect(fifty.filter((q) => q === "emailMessage.findMany")).toHaveLength(2);
    expect(fifty.length).toBeLessThanOrEqual(4);
  });

  it("rows with no mail and no day-dependent rule read nothing", async () => {
    seed();
    queries.length = 0;
    await enrichNotifications(USER, [bell("n1", { type: "briefing" })], { language: en });
    expect(queries).toEqual([]);
  });
});

describe("notificationDelivery", () => {
  const T0 = new Date(NOW.getTime() - HOUR);
  const at = (ms: number) => new Date(T0.getTime() + ms);

  function deliveryRow(overrides: Row): Row {
    return {
      userId: USER,
      channel: "web",
      category: "email_urgent",
      title: "Alice",
      status: "ACCEPTED",
      createdAt: at(1_000),
      ...overrides,
    };
  }

  function seedDelivery(rows: Row[], notifications: Row[] = []) {
    seed({
      emailMessage: [mail("e1")],
      attentionItem: [item("i1", "e1")],
      notification: [
        {
          id: "n1",
          userId: USER,
          type: "email",
          title: "Urgent email",
          message: "Alice: Contract [g-e1]",
          sourceEmailId: "e1",
          createdAt: T0,
        },
        ...notifications,
      ],
      pushDeliveryLog: rows,
    });
  }

  it("names the channels that reached at least sent, with their furthest stage", async () => {
    seedDelivery([
      deliveryRow({
        bellNotificationId: "n1",
        channel: "web",
        endpointHost: "fcm.googleapis.com",
        acceptedAt: at(2_000),
        receivedAt: at(3_000),
      }),
      deliveryRow({ bellNotificationId: "n1", channel: "apns", acceptedAt: at(2_000) }),
      deliveryRow({
        bellNotificationId: "n1",
        channel: "telegram",
        status: "FAILED",
        queuedAt: at(1_500),
      }),
      deliveryRow({
        channel: "desktop_mac",
        status: "REPORTED",
        dedupeKey: `desktop:${USER}:mac:attention_item:i1`,
        receivedAt: at(4_000),
        clickedAt: at(5_000),
      }),
    ]);
    const res = await notificationDelivery(USER, "n1");
    expect(res).toEqual({
      deliveredTo: ["mac", "chrome", "ios"],
      channels: [
        { name: "mac", state: "opened" },
        { name: "chrome", state: "device_received" },
        { name: "ios", state: "sent" },
      ],
    });
  });

  it("a row linked by notificationId (a non-mail push, a Windows bell receipt) counts", async () => {
    seedDelivery([
      deliveryRow({ notificationId: "n1", channel: "fcm", acceptedAt: at(2_000) }),
      deliveryRow({
        notificationId: "n1",
        channel: "desktop_windows",
        status: "REPORTED",
        dedupeKey: `desktop:${USER}:windows:notification:n1`,
        receivedAt: at(3_000),
      }),
    ]);
    expect((await notificationDelivery(USER, "n1"))?.deliveredTo).toEqual(["windows", "android"]);
  });

  it("names web push by its push service", async () => {
    seedDelivery(
      [
        ["updates.push.services.mozilla.com", "firefox"],
        ["web.push.apple.com", "safari"],
        ["wns2-par02p.notify.windows.com", "edge"],
        ["push.example.net", "web"],
      ].map(([host]) =>
        deliveryRow({ bellNotificationId: "n1", endpointHost: host, acceptedAt: at(2_000) }),
      ),
    );
    expect((await notificationDelivery(USER, "n1"))?.deliveredTo.sort()).toEqual(
      ["edge", "firefox", "safari", "web"].sort(),
    );
  });

  it("does not count another bell row's delivery, or a send before this row existed", async () => {
    seedDelivery(
      [
        deliveryRow({ bellNotificationId: "n2", channel: "apns", acceptedAt: at(2_000) }),
        deliveryRow({
          bellNotificationId: "n1",
          channel: "telegram",
          acceptedAt: at(-2 * HOUR),
          createdAt: at(-2 * HOUR),
        }),
      ],
      [
        {
          id: "n2",
          userId: USER,
          type: "email",
          title: "Urgent email",
          message: "x",
          createdAt: T0,
        },
      ],
    );
    expect(await notificationDelivery(USER, "n1")).toEqual({ deliveredTo: [], channels: [] });
  });

  it("IDOR: another user's bell row is null (404), and their delivery rows are never read", async () => {
    seedDelivery([
      deliveryRow({
        userId: OTHER,
        bellNotificationId: "n1",
        channel: "apns",
        acceptedAt: at(2_000),
      }),
    ]);
    expect(await notificationDelivery(OTHER, "n1")).toBe(null);
    // The owner does not see the other user's row either.
    expect(await notificationDelivery(USER, "n1")).toEqual({ deliveredTo: [], channels: [] });
  });

  it("a hidden claim row is not a bell entry: null", async () => {
    seedDelivery(
      [],
      [{ id: "n-claim", userId: USER, type: "claim", title: "t", message: "m", createdAt: T0 }],
    );
    expect(await notificationDelivery(USER, "n-claim")).toBe(null);
  });

  it("an unknown id is null", async () => {
    seedDelivery([]);
    expect(await notificationDelivery(USER, "missing")).toBe(null);
  });
});

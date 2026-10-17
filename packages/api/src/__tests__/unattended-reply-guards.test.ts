import { beforeEach, describe, expect, it, vi } from "vitest";

// Guards shared by both unattended send paths (AUTO_REPLY rules and auto-mode):
// no reply to machine or list mail (loops, backscatter), none to the user's own
// addresses (a self-send loop), and at most MAX_UNATTENDED_REPLIES_PER_DAY a
// UTC day, with one visible notice when the cap stops a reply.

const db = vi.hoisted(() => ({
  ledgerRows: [] as Array<{ userId: string; dedupeKey: string; createdAt: Date }>,
  notices: [] as Array<Record<string, unknown>>,
  userEmail: "me@example.com" as string | null,
  linked: [] as Array<{ email: string }>,
}));

vi.mock("../db.js", () => ({
  prisma: {
    notification: {
      count: vi.fn(
        async ({
          where,
        }: {
          where: { userId: string; dedupeKey: { startsWith: string }; createdAt: { gte: Date } };
        }) =>
          db.ledgerRows.filter(
            (r) =>
              r.userId === where.userId &&
              r.dedupeKey.startsWith(where.dedupeKey.startsWith) &&
              r.createdAt >= where.createdAt.gte,
          ).length,
      ),
      create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
        if (db.notices.some((n) => n.dedupeKey === data.dedupeKey && n.userId === data.userId)) {
          throw Object.assign(new Error("unique"), { code: "P2002" });
        }
        db.notices.push(data);
        return data;
      }),
    },
    user: { findUnique: vi.fn(async () => (db.userEmail ? { email: db.userEmail } : null)) },
    linkedInboxAccount: { findMany: vi.fn(async () => db.linked) },
  },
}));

import {
  isMachineOrListMail,
  MAX_UNATTENDED_REPLIES_PER_DAY,
  unattendedReplyBlock,
} from "../agentcore/unattended-reply-guards.js";

const NOW = new Date("2026-10-16T12:00:00Z");

beforeEach(() => {
  vi.clearAllMocks();
  db.ledgerRows = [];
  db.notices = [];
  db.userEmail = "me@example.com";
  db.linked = [];
});

describe("isMachineOrListMail", () => {
  it("catches loop-prone machine senders the judge heuristic misses", () => {
    for (const from of [
      "MAILER-DAEMON@mx.example",
      "postmaster@example.org",
      "Do Not Reply <do-not-reply@shop.example>",
      "do_not_reply@shop.example",
      "bounces+abc@lists.example",
      "autoreply@helpdesk.example",
      "Auto Reply <auto-reply@helpdesk.example>",
      "alerts@monitor.example",
      "notify@app.example",
      "No Reply <no-reply@service.example>",
    ]) {
      expect(isMachineOrListMail({ from }), from).toBe(true);
    }
  });

  it("treats list mail as machine mail even from a person's address", () => {
    expect(
      isMachineOrListMail({ from: "ann@example.com", listUnsubscribeUrl: "https://x/u" }),
    ).toBe(true);
    expect(
      isMachineOrListMail({ from: "ann@example.com", listUnsubscribeMailto: "u@x.example" }),
    ).toBe(true);
  });

  it("lets a person through", () => {
    for (const from of [
      "Ann <ann@example.com>",
      "notifier.bob@example.com",
      "alertson@example.com",
    ]) {
      expect(isMachineOrListMail({ from }), from).toBe(false);
    }
  });
});

describe("unattendedReplyBlock", () => {
  it("blocks a reply to the user's own primary or linked address", async () => {
    db.linked = [{ email: "Me@Linked.example" }];
    expect(await unattendedReplyBlock("u1", { from: "Me <me@example.com>" }, NOW)).toBe(
      "own-address",
    );
    expect(await unattendedReplyBlock("u1", { from: "me@linked.example" }, NOW)).toBe(
      "own-address",
    );
    expect(await unattendedReplyBlock("u1", { from: "ann@example.com" }, NOW)).toBeNull();
  });

  it("counts only today's (UTC) claims of this user against the cap", async () => {
    const today = new Date("2026-10-16T00:30:00Z");
    for (let i = 0; i < MAX_UNATTENDED_REPLIES_PER_DAY - 1; i++) {
      db.ledgerRows.push({ userId: "u1", dedupeKey: `auto-reply:g${i}`, createdAt: today });
    }
    db.ledgerRows.push({
      userId: "u1",
      dedupeKey: "auto-reply:old",
      createdAt: new Date("2026-10-15T23:59:00Z"),
    });
    db.ledgerRows.push({ userId: "u2", dedupeKey: "auto-reply:other", createdAt: today });
    db.ledgerRows.push({ userId: "u1", dedupeKey: "auto-mode-reply:legacy", createdAt: today });

    expect(await unattendedReplyBlock("u1", { from: "ann@example.com" }, NOW)).toBeNull();

    db.ledgerRows.push({ userId: "u1", dedupeKey: "auto-reply:last", createdAt: today });
    expect(await unattendedReplyBlock("u1", { from: "ann@example.com" }, NOW)).toBe("daily-cap");
  });

  it("tells the user once a day that the cap stopped a reply", async () => {
    const today = new Date("2026-10-16T01:00:00Z");
    for (let i = 0; i < MAX_UNATTENDED_REPLIES_PER_DAY; i++) {
      db.ledgerRows.push({ userId: "u1", dedupeKey: `auto-reply:g${i}`, createdAt: today });
    }

    await unattendedReplyBlock("u1", { from: "ann@example.com" }, NOW);
    await unattendedReplyBlock("u1", { from: "bob@example.com" }, NOW);

    expect(db.notices).toHaveLength(1);
    expect(db.notices[0]).toMatchObject({
      userId: "u1",
      dedupeKey: "auto-reply-cap:2026-10-16",
      isRead: false,
    });
    // The notice must never read as a ledger claim, or it would count itself.
    expect(String(db.notices[0]?.dedupeKey).startsWith("auto-reply:")).toBe(false);
  });

  it("checks machine mail before touching the database", async () => {
    const { prisma } = await import("../db.js");
    expect(await unattendedReplyBlock("u1", { from: "no-reply@x.example" }, NOW)).toBe(
      "machine-or-list",
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });
});

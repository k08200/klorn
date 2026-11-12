/**
 * Opening a mail settles its bell rows (notify/email-bell.ts). Before this,
 * nothing but the bell's own click or "mark all read" ever set
 * Notification.isRead, so a mail opened from a push, Today or the mail list
 * left its urgent-mail row unread for good.
 *
 *   - rows that name the mail (sourceEmailId) are marked read;
 *   - a legacy urgent row (written before sourceEmailId) that names exactly
 *     this one mail in its `[gmailId]` marker is marked read too, but only
 *     from the mail's own creation on (an IMAP id can be re-keyed onto a new
 *     message, the same floor the push dedupe uses);
 *   - an urgent-sweep batch row `[a,b]` is left alone: opening one mail does
 *     not mean the others were seen;
 *   - every write is scoped to the caller's own unread rows.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  updateMany: vi.fn(async (_args: unknown) => ({ count: 1 })),
  captureError: vi.fn(),
}));

vi.mock("../db.js", () => ({
  prisma: { notification: { updateMany: mocks.updateMany } },
}));
vi.mock("../sentry.js", () => ({ captureError: mocks.captureError }));

import { markEmailBellRowsRead, noteEmailBellRowsRead } from "../notify/email-bell.js";
import { mailOpenPath } from "../notify/mail-path.js";
import { URGENT_EMAIL_TITLES } from "../notify/notification-strings.js";

const EMAIL = {
  id: "email-db-1",
  gmailId: "18c0ffee",
  createdAt: new Date("2026-11-10T08:00:00Z"),
};

type Where = {
  userId: string;
  isRead: boolean;
  type: { not: string };
  OR: Array<Record<string, unknown>>;
};

function lastWhere(): Where {
  const args = mocks.updateMany.mock.calls.at(-1)?.[0] as { where: Where; data: unknown };
  expect(args.data).toEqual({ isRead: true });
  return args.where;
}

beforeEach(() => {
  mocks.updateMany.mockClear();
  mocks.captureError.mockClear();
});

describe("mailOpenPath", () => {
  it("is the reader route for one mail", () => {
    expect(mailOpenPath("email-db-1")).toBe("/email/email-db-1");
  });

  it("encodes the id, so it can never add a path segment", () => {
    expect(mailOpenPath("a/../b?x")).toBe("/email/a%2F..%2Fb%3Fx");
  });
});

describe("markEmailBellRowsRead", () => {
  it("marks the user's unread rows that name the mail, and only theirs", async () => {
    const count = await markEmailBellRowsRead("user-1", EMAIL);
    expect(count).toBe(1);
    const where = lastWhere();
    expect(where.userId).toBe("user-1");
    expect(where.isRead).toBe(false);
    expect(where.OR).toContainEqual({ sourceEmailId: "email-db-1" });
  });

  it("matches a legacy urgent row by its one-mail marker, from the mail's creation on", async () => {
    await markEmailBellRowsRead("user-1", EMAIL);
    const legacy = lastWhere().OR.find((clause) => "message" in clause);
    expect(legacy).toEqual({
      type: "email",
      title: { in: [...URGENT_EMAIL_TITLES] },
      message: { endsWith: "[18c0ffee]" },
      createdAt: { gte: EMAIL.createdAt },
    });
  });

  it("escapes LIKE wildcards in an IMAP id, so `_` and `%` match only themselves", async () => {
    await markEmailBellRowsRead("user-1", { ...EMAIL, gmailId: "naver_imap:me%x:5" });
    const legacy = lastWhere().OR.find((clause) => "message" in clause);
    expect(legacy?.message).toEqual({ endsWith: "[naver\\_imap:me\\%x:5]" });
  });

  it("never touches hidden claim rows (they are not bell entries)", async () => {
    await markEmailBellRowsRead("user-1", EMAIL);
    expect(lastWhere().type).toEqual({ not: "claim" });
  });

  it("does not match an urgent-sweep batch marker: [id,other] is not [id]", async () => {
    await markEmailBellRowsRead("user-1", EMAIL);
    const legacy = lastWhere().OR.find((clause) => "message" in clause) as {
      message: { endsWith: string };
    };
    const batchMessage = "2 urgent emails [18c0ffee,gm-2]";
    expect(batchMessage.endsWith(legacy.message.endsWith)).toBe(false);
    expect("Kim: Contract [18c0ffee]".endsWith(legacy.message.endsWith)).toBe(true);
  });
});

describe("noteEmailBellRowsRead (fire-and-forget)", () => {
  it("never throws into the request, and reports the failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.updateMany.mockRejectedValueOnce(new Error("db down"));
    expect(() => noteEmailBellRowsRead("user-1", EMAIL)).not.toThrow();
    await vi.waitFor(() => expect(mocks.captureError).toHaveBeenCalledTimes(1));
    expect(mocks.captureError.mock.calls[0][1]).toMatchObject({
      tags: { scope: "notifications.email-open-read" },
    });
  });
});
